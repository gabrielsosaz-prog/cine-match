import type { InterestAnswer, RecommendationItem, TitleMeta } from '../types';
import { INTEREST_ANSWERS } from '../services/taste';
import { publicScore } from './components';
import { num } from './format';

/**
 * v4.0 · Tres datos separados: compatibilidad con tus gustos (relativa, no probabilidad), satisfacción estimada (con
 * aviso de fiabilidad) y nota pública de TMDB (dato, no influye en el orden más que dentro de la satisfacción).
 */
export function AttractionScores({ a, meta }: { a: NonNullable<RecommendationItem['attraction']>; meta: TitleMeta }) {
  const pub = publicScore(meta);
  const tone = a.level === 'muy alta' ? 'bg-emerald-500/20 text-emerald-200' : a.level === 'alta' ? 'bg-emerald-500/10 text-emerald-300' : a.level === 'media' ? 'bg-sky-500/10 text-sky-200' : 'bg-slate-500/15 text-slate-300';
  return (
    <div className="grid grid-cols-3 gap-1 text-center" data-testid="v4-scores">
      <div className={`rounded-lg px-1 py-1 ${tone}`} data-testid="v4-compat" title="Compatibilidad con tus gustos: posición relativa entre los candidatos de esta tanda. No es una probabilidad.">
        <div className="text-[9px] leading-tight opacity-80">Compatibilidad</div>
        <div className="text-xs font-bold">{a.level}</div>
      </div>
      <div className="rounded-lg bg-accent-soft px-1 py-1 text-accent" data-testid="v4-satisfaction" data-reliable={a.satisfactionReliable}
        title="Satisfacción estimada: nota que podrías ponerle después de verla. Fiabilidad baja hasta tener notas tuyas de títulos recomendados por v4.0.">
        <div className="text-[9px] leading-tight opacity-80">Satisfacción</div>
        <div className="text-xs font-bold">{num(a.satisfaction)}{a.satisfactionReliable ? '' : ' ·'} <span className="text-[9px] font-normal">{a.satisfactionReliable ? '' : 'poco fiable'}</span></div>
      </div>
      <div className="rounded-lg bg-sky-500/10 px-1 py-1 text-sky-200" data-testid="v4-public" title="Puntuación pública: promedio de votos de TMDB (0-10)">
        <div className="text-[9px] leading-tight opacity-80">TMDB</div>
        <div className="text-xs font-bold">{pub !== undefined ? num(pub) : '–'}</div>
      </div>
    </div>
  );
}

/** Explicación: por qué (perfil y parecidos) y qué podría no gustarte. Sin sinopsis, sin spoilers. */
export function AttractionWhy({ a }: { a: NonNullable<RecommendationItem['attraction']> }) {
  return (
    <div className="mt-1.5 space-y-0.5 text-[11px] text-slate-300" data-testid="v4-why">
      {a.pros.length > 0 && <p><span className="text-emerald-300">Por tu perfil:</span> {a.pros.join(', ').toLowerCase()}.</p>}
      {a.similar.length > 0 && <p><span className="text-emerald-300">Parecida a:</span> {a.similar.join(' y ')}.</p>}
      {a.cons.length > 0 && <p data-testid="v4-cons"><span className="text-amber-300">Podría no gustarte:</span> {a.cons.join(', ').toLowerCase()}.</p>}
      {!a.pros.length && !a.similar.length && <p>Se parece por argumento y rasgos a títulos que te atrajeron.</p>}
    </div>
  );
}

/** Respuesta de interés ANTES de ver (no es una nota). La elegida queda marcada; se puede cambiar. */
export function InterestButtons({ value, onPick, title }: { value?: InterestAnswer; onPick: (a: InterestAnswer) => void; title: string }) {
  return (
    <div className="mt-2" data-testid="interest-row">
      <p className="mb-1 text-[10px] text-slate-500">¿Te interesa? (antes de verla; no es una nota)</p>
      <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label={`Interés en ${title}`}>
        {INTEREST_ANSWERS.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={value === o.id} aria-label={o.label} data-testid={`interest-${o.id}`} onClick={() => onPick(o.id)}
            className={`rounded-md px-0.5 py-1.5 text-[10px] font-semibold leading-tight ring-1 ${value === o.id ? (o.id === 'no' ? 'bg-red-500/25 text-red-100 ring-red-400/50' : 'bg-accent text-ink-950 ring-accent') : 'bg-ink-800 text-slate-300 ring-white/10'}`}>
            {o.short}
          </button>
        ))}
      </div>
    </div>
  );
}
