/** Drawing units and plausibility (brief: detect from $INSUNITS, else ask with a size preview). */

export type UnitKey = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const UNIT_SCALE: Record<UnitKey, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

export const UNIT_LABEL: Record<UnitKey, string> = {
  mm: 'Millimeters',
  cm: 'Centimeters',
  m: 'Meters',
  in: 'Inches',
  ft: 'Feet',
};

/** $INSUNITS: 1 inches, 2 feet, 4 mm, 5 cm, 6 m. Anything else is unknown. */
export function unitsFromInsunits(code: number | undefined | null): UnitKey | null {
  switch (code) {
    case 1:
      return 'in';
    case 2:
      return 'ft';
    case 4:
      return 'mm';
    case 5:
      return 'cm';
    case 6:
      return 'm';
    default:
      return null;
  }
}

/** A plan is plausible between 3 m and 100 m across (brief). */
export const MIN_SPAN = 3;
export const MAX_SPAN = 100;

export function plausible(widthMeters: number, depthMeters: number): boolean {
  const span = Math.max(widthMeters, depthMeters);
  return span >= MIN_SPAN && span <= MAX_SPAN;
}

/**
 * Best guess for an unknown unit: the unit whose plan size is closest to a typical home
 * (about 15 m across, on a log scale), among the plausible ones.
 */
export function guessUnits(width: number, depth: number): UnitKey {
  const span = Math.max(width, depth);
  let best: UnitKey = 'mm';
  let bestScore = Infinity;
  for (const u of Object.keys(UNIT_SCALE) as UnitKey[]) {
    const s = span * UNIT_SCALE[u];
    const score = Math.abs(Math.log(s / 15)) + (s >= MIN_SPAN && s <= MAX_SPAN ? 0 : 10);
    if (score < bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return best;
}

/**
 * A size measured in the drawing (in drawing units) and the range it must fall in, in meters,
 * for the unit to be right: door widths, furniture sizes, wall thicknesses.
 */
export interface SizeSample {
  kind: 'doors' | 'furniture' | 'walls';
  value: number;
  min: number;
  max: number;
  /** How many votes the sample is worth (default 1). */
  weight?: number;
}

export interface ContentUnits {
  units: UnitKey;
  /** Enough samples agree, and clearly more than for any other unit. */
  confident: boolean;
  /** Kinds of objects that agree with the unit, for the message. */
  kinds: SizeSample['kind'][];
  votes: number;
  total: number;
}

/** The unit in which the most door, furniture and wall sizes come out at real-world sizes. */
export function unitsFromContent(samples: SizeSample[]): ContentUnits | null {
  if (samples.length === 0) return null;
  const total = samples.reduce((n, s) => n + (s.weight ?? 1), 0);
  const scored = (Object.keys(UNIT_SCALE) as UnitKey[])
    .map((u) => {
      const ok = samples.filter((s) => {
        const m = s.value * UNIT_SCALE[u];
        return m >= s.min && m <= s.max;
      });
      return { u, votes: ok.reduce((n, s) => n + (s.weight ?? 1), 0), kinds: [...new Set(ok.map((s) => s.kind))] };
    })
    .sort((a, b) => b.votes - a.votes);
  const [best, next] = scored;
  if (best.votes === 0) return null;
  const confident = best.votes >= 3 && best.votes >= 2 * next.votes && best.votes >= total * 0.5;
  return { units: best.u, confident, kinds: best.kinds, votes: best.votes, total };
}

const KIND_ORDER: SizeSample['kind'][] = ['doors', 'furniture', 'walls'];

/** "doors and furniture", "doors, furniture and walls". */
export function kindList(kinds: SizeSample['kind'][]): string {
  const k = KIND_ORDER.filter((x) => kinds.includes(x)).map((x) => (x === 'walls' ? 'wall thicknesses' : x));
  return k.length <= 1 ? (k[0] ?? 'drawing') : `${k.slice(0, -1).join(', ')} and ${k[k.length - 1]}`;
}

export interface UnitDecision {
  units: UnitKey;
  /** True when the user must confirm (missing $INSUNITS, or an implausible size the content can't settle). */
  ask: boolean;
  detected: UnitKey | null;
  reason: string | null;
  /** Set when the content overrode the file's own unit, for the report. */
  note?: string;
}

/**
 * The drawing's unit: $INSUNITS when the plan comes out at a plausible size. When the file's unit
 * makes the plan implausible and the doors, furniture and walls clearly point to another unit,
 * that unit is used without asking (with a note). Otherwise the user is asked, with the content's
 * unit (or the size-based guess) preselected.
 */
export function decideUnits(insunits: number | undefined | null, width: number, depth: number, content: ContentUnits | null = null): UnitDecision {
  const detected = unitsFromInsunits(insunits);
  const fromContent = content?.confident ? content.units : null;
  if (detected) {
    const s = UNIT_SCALE[detected];
    if (plausible(width * s, depth * s)) return { units: detected, ask: false, detected, reason: null };
    if (fromContent && fromContent !== detected && plausible(width * UNIT_SCALE[fromContent], depth * UNIT_SCALE[fromContent])) {
      const from = UNIT_LABEL[detected].toLowerCase();
      const to = UNIT_LABEL[fromContent].toLowerCase();
      return {
        units: fromContent,
        ask: false,
        detected,
        reason: null,
        note: `The file says ${from}, but its ${kindList(content!.kinds)} are drawn in ${to}, so ${to} are used.`,
      };
    }
    return {
      units: fromContent ?? guessUnits(width, depth),
      ask: true,
      detected,
      reason: `The file says ${UNIT_LABEL[detected].toLowerCase()}, but that makes the plan ${formatSpan(Math.max(width, depth) * s)} across.`,
    };
  }
  const hint = fromContent ? ` Its ${kindList(content!.kinds)} point to ${UNIT_LABEL[fromContent].toLowerCase()}.` : '';
  return { units: fromContent ?? guessUnits(width, depth), ask: true, detected: null, reason: `The file doesn't say which units it uses.${hint}` };
}

export function formatSpan(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 1) return `${m.toFixed(m < 10 ? 2 : 1)} m`;
  return `${Math.round(m * 100)} cm`;
}
