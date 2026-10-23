import { matchFurnitureType } from '../../geometry/furniture/registry';
import { cross, dist, dot, normalize, sub } from '../../util/math2d';
import type { SizeSample } from './units';
import type { DArc, DInsert, DrawingModel, LayerRole } from './types';

/**
 * Sizes of familiar objects in the drawing, in drawing units, with the real-world range each one
 * should fall in. They tell which unit the drawing is really in when its header is wrong.
 */

export const DOOR_NAME = /(^|[^a-z])(doors?|door[a-z]{1,2}|dr\d*|d\d{2,4}|dwg?-?door|باب|ابواب|أبواب)([^a-z]|$)/i;

/** Long side of a piece of furniture, in meters. */
const FURNITURE_RANGE: Record<string, [number, number]> = {
  'bed-single': [1.8, 2.8],
  'bed-double': [1.8, 2.8],
  sofa: [1.2, 3.6],
  armchair: [0.5, 1.1],
  chair: [0.35, 0.9],
  'dining-table': [0.5, 3.2],
  'coffee-table': [0.4, 1.8],
  desk: [0.6, 2.2],
  nightstand: [0.3, 0.7],
  wardrobe: [0.6, 3.6],
  wc: [0.3, 0.85],
  vanity: [0.3, 1.3],
  bathtub: [1.2, 2.0],
  shower: [0.7, 1.8],
  'kitchen-sink': [0.4, 1.6],
  'kitchen-hob': [0.3, 1.0],
  fridge: [0.5, 1.0],
  'tv-unit': [0.6, 2.5],
};

function sweep(a: DArc): number {
  let s = a.a1 - a.a0;
  while (s <= 0) s += Math.PI * 2;
  return s;
}

const isQuarter = (a: DArc) => Math.abs(sweep(a) - Math.PI / 2) < (15 * Math.PI) / 180;

function sides(ins: DInsert): [number, number] {
  const c = ins.footprint ?? ins.corners;
  if (c.length < 4) return [ins.size.w, ins.size.d];
  const a = dist(c[0], c[1]);
  const b = dist(c[1], c[2]);
  return a >= b ? [a, b] : [b, a];
}

/** The most common distance between parallel, overlapping lines on wall layers. */
function wallSpacing(model: DrawingModel, roles: Record<string, LayerRole>): number | null {
  const lines = model.segs.filter((s) => s.insert < 0 && !s.dashed && roles[s.layer] === 'walls').slice(0, 3000);
  const found: { d: number; w: number }[] = [];
  const items = lines.map((s) => ({ a: s.a, d: normalize(sub(s.b, s.a)), l: dist(s.a, s.b), b: s.b }));
  for (let i = 0; i < items.length; i++) {
    const A = items[i];
    let best = Infinity;
    let bestOverlap = 0;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const B = items[j];
      if (Math.abs(cross(A.d, B.d)) > 0.02) continue;
      const d = Math.abs(cross(A.d, sub(B.a, A.a)));
      if (d < 1e-9 || d >= best) continue;
      const u0 = dot(sub(B.a, A.a), A.d);
      const u1 = dot(sub(B.b, A.a), A.d);
      const overlap = Math.min(A.l, Math.max(u0, u1)) - Math.max(0, Math.min(u0, u1));
      if (overlap < 3 * d) continue;
      best = d;
      bestOverlap = overlap;
    }
    if (Number.isFinite(best)) found.push({ d: best, w: bestOverlap });
  }
  if (found.length < 4) return null;
  // Log-binned histogram weighted by overlap length.
  const bins = new Map<number, { w: number; sum: number }>();
  for (const f of found) {
    const k = Math.round(Math.log(f.d) / 0.05);
    const b = bins.get(k) ?? { w: 0, sum: 0 };
    b.w += f.w;
    b.sum += f.d * f.w;
    bins.set(k, b);
  }
  const top = [...bins.values()].sort((x, y) => y.w - x.w)[0];
  return top.sum / top.w;
}

export function sizeSamples(model: DrawingModel, roles: Record<string, LayerRole>): SizeSample[] {
  const out: SizeSample[] = [];
  model.inserts.forEach((ins, i) => {
    const role = roles[ins.layer];
    if (role === 'ignore' && !DOOR_NAME.test(ins.name)) return;
    if (DOOR_NAME.test(ins.name) || role === 'doors') {
      const swing = model.arcs.filter((a) => a.insert === i && isQuarter(a)).sort((x, y) => y.r - x.r)[0];
      if (swing) out.push({ kind: 'doors', value: swing.r, min: 0.55, max: 1.3 });
      else out.push({ kind: 'doors', value: sides(ins)[0], min: 0.55, max: 1.6 });
      return;
    }
    const [long, short] = sides(ins);
    const type = matchFurnitureType([ins.name], long, short);
    const range = type ? FURNITURE_RANGE[type] : undefined;
    if (range) out.push({ kind: 'furniture', value: long, min: range[0], max: range[1] });
  });
  for (const a of model.arcs) {
    if (a.insert >= 0 || roles[a.layer] !== 'doors' || !isQuarter(a)) continue;
    out.push({ kind: 'doors', value: a.r, min: 0.55, max: 1.3 });
  }
  const spacing = wallSpacing(model, roles);
  if (spacing) out.push({ kind: 'walls', value: spacing, min: 0.07, max: 0.45, weight: 2 });
  return out;
}
