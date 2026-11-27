import { describe, expect, it } from 'vitest';
import { b64url, encryptPayload, generateVapidKeys, unb64url, vapidJwt } from '../../supabase/functions/notify/webpush';

// v4.2 · Web Push propio (función «notify»): el mensaje cifrado se descifra con las claves del navegador receptor
// siguiendo RFC 8291 y la firma VAPID se verifica con la clave pública.
const enc = new TextEncoder();
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

async function receiver() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, pub, auth, target: { p256dh: b64url(pub), auth: b64url(auth) } };
}
async function decrypt(body: Uint8Array, r: Awaited<ReturnType<typeof receiver>>) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, r.kp.privateKey, 256));
  const prkKey = await hmac(r.auth, ecdh);
  const ikm = await hmac(prkKey, cat(enc.encode('WebPush: info\0'), r.pub, asPub, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  return { rs, idlen, delimiter: pt[pt.length - 1], text: new TextDecoder().decode(pt.slice(0, -1)) };
}

describe('v4.2 · Web Push', () => {
  it('cifra con aes128gcm y el receptor lo descifra', async () => {
    const r = await receiver();
    const msg = { title: 'Ana te recomendó una película', body: 'Matrix', url: './#/recibidas?r=1' };
    const body = await encryptPayload(r.target, enc.encode(JSON.stringify(msg)));
    const d = await decrypt(body, r);
    expect(d.rs).toBe(4096);
    expect(d.idlen).toBe(65);
    expect(d.delimiter).toBe(2);
    expect(JSON.parse(d.text)).toEqual(msg);
  });
  it('cada envío usa sal y claves efímeras nuevas', async () => {
    const r = await receiver();
    const a = await encryptPayload(r.target, enc.encode('x'));
    const b = await encryptPayload(r.target, enc.encode('x'));
    expect(b64url(a)).not.toBe(b64url(b));
  });
  it('firma VAPID ES256 verificable con la clave pública', async () => {
    const k = await generateVapidKeys();
    expect(unb64url(k.publicKey).length).toBe(65);
    const jwt = await vapidJwt('https://fcm.googleapis.com', { ...k, subject: 'https://cine-match.example' }, 1_800_000_000);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(new TextDecoder().decode(unb64url(h)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(new TextDecoder().decode(unb64url(c)))).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43200, sub: 'https://cine-match.example' });
    const pub = await crypto.subtle.importKey('raw', unb64url(k.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(s), enc.encode(`${h}.${c}`))).toBe(true);
  });
});
