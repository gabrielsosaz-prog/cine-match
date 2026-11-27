// Supabase Edge Function «notify» · envía la notificación push de UNA recomendación recién enviada.
// La llama el remitente (con su sesión) cuando vence el plazo para deshacer. Reglas:
//  * Sólo el remitente puede pedirla, sólo una vez por recomendación (notified_at) y dentro de la hora del envío.
//  * Si el destinatario bloqueó o eliminó al remitente, no se notifica.
//  * La clave privada VAPID y la clave de servicio viven sólo en los secretos de Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.119.2';
import { sendWebPush, type VapidKeys } from './webpush.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method' });
  const url = Deno.env.get('SUPABASE_URL')!;
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: u } = await userClient.auth.getUser(authHeader.replace(/^Bearer /, ''));
  if (!u?.user) return json(401, { error: 'not_authenticated' });
  let recId = '';
  try { recId = String((await req.json()).rec_id ?? ''); } catch { /* cuerpo inválido */ }
  if (!UUID.test(recId)) return json(400, { error: 'invalid_rec' });

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const since = new Date(Date.now() - 3600_000).toISOString();
  // Reclamo atómico: una sola notificación por recomendación
  const { data: rec } = await admin.from('recommendations').update({ notified_at: new Date().toISOString() })
    .eq('id', recId).eq('sender', u.user.id).is('notified_at', null).gt('created_at', since)
    .select('id, sender, recipient, sender_name, media_type, title').maybeSingle();
  if (!rec) return json(200, { sent: 0, reason: 'not_applicable' });
  const { data: link } = await admin.from('contacts').select('alias, blocked').eq('owner', rec.recipient).eq('contact', rec.sender).maybeSingle();
  if (!link || link.blocked) return json(200, { sent: 0, reason: 'not_linked' });
  const { data: subs } = await admin.from('push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', rec.recipient);
  if (!subs?.length) return json(200, { sent: 0, reason: 'no_subscriptions' });

  const jwk = Deno.env.get('VAPID_PRIVATE_JWK');
  const pub = Deno.env.get('VAPID_PUBLIC_KEY');
  if (!jwk || !pub) return json(500, { error: 'vapid_not_configured' });
  const keys: VapidKeys = { publicKey: pub, privateJwk: JSON.parse(jwk), subject: Deno.env.get('VAPID_SUBJECT') ?? 'https://cine-match-pied-tau.vercel.app' };
  const who = link.alias || rec.sender_name;
  const payload = { title: `${who} te recomendó ${rec.media_type === 'movie' ? 'una película' : 'una serie'}`, body: rec.title, url: `./#/recibidas?r=${rec.id}`, tag: `rec-${rec.id}` };
  let sent = 0;
  for (const s of subs) {
    try {
      const r = await sendWebPush(s, payload, keys, { topic: rec.id.replace(/-/g, '') });
      if (r.gone) await admin.from('push_subscriptions').delete().eq('id', s.id);
      else if (r.status < 300) sent++;
    } catch { /* un dispositivo caído no impide los demás */ }
  }
  return json(200, { sent });
});
