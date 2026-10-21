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

export interface UnitDecision {
  units: UnitKey;
  /** True when the user must confirm (missing $INSUNITS or an implausible size). */
  ask: boolean;
  detected: UnitKey | null;
  reason: string | null;
}

export function decideUnits(insunits: number | undefined | null, width: number, depth: number): UnitDecision {
  const detected = unitsFromInsunits(insunits);
  if (detected) {
    const s = UNIT_SCALE[detected];
    if (plausible(width * s, depth * s)) return { units: detected, ask: false, detected, reason: null };
    return {
      units: guessUnits(width, depth),
      ask: true,
      detected,
      reason: `The file says ${UNIT_LABEL[detected].toLowerCase()}, but that makes the plan ${formatSpan(Math.max(width, depth) * s)} across.`,
    };
  }
  return { units: guessUnits(width, depth), ask: true, detected: null, reason: "The file doesn't say which units it uses." };
}

export function formatSpan(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 1) return `${m.toFixed(m < 10 ? 2 : 1)} m`;
  return `${Math.round(m * 100)} cm`;
}
