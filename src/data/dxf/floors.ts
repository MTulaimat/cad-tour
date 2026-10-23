import type { Vec2 } from '../schema';
import { dist } from '../../util/math2d';
import { floorOfLayer } from './layers';
import type { DrawingModel, FloorAssignment, FloorBox, LayerRole } from './types';

/**
 * Multiple floors: by layer prefix (L1_, L2_, ...), by selection boxes drawn in the 2D preview, or
 * by plans drawn side by side in one model space (found automatically and turned into boxes).
 * Floors are aligned to each other by matching their stair outlines or identical level labels,
 * then snapped exactly onto shared wall corners; failing that, by the corners of their bounding
 * boxes (with a warning).
 */

export function floorCount(a: FloorAssignment): number {
  if (a.mode === 'prefix') return Math.max(1, a.prefixes?.length ?? 1);
  if (a.mode === 'boxes') return Math.max(1, a.boxes?.length ?? 1);
  return 1;
}

/** Floor index of a primitive (by its layer and a representative point in drawing units), or -1. */
export function floorOf(a: FloorAssignment, layer: string, p: Vec2): number {
  if (a.mode === 'prefix' && a.prefixes) return floorOfLayer(layer, a.prefixes);
  if (a.mode === 'boxes' && a.boxes) {
    return a.boxes.findIndex((b) => p.x >= Math.min(b.minX, b.maxX) && p.x <= Math.max(b.minX, b.maxX) && p.y >= Math.min(b.minY, b.maxY) && p.y <= Math.max(b.minY, b.maxY));
  }
  return 0;
}

interface PlanCluster {
  box: FloorBox;
  length: number;
}

/**
 * Separate drawings in one model space: wall line work clustered by proximity. Returns one box per
 * plan big enough to be a floor (at least 3 m across and 20 m of wall lines), lowest floor first:
 * a clearly smaller plan goes above a bigger one (a mezzanine or a partial upper floor), plans of
 * similar size go in reading order (left to right, then top to bottom). Null when there is only one.
 */
export function findSideBySidePlans(model: DrawingModel, roles: Record<string, LayerRole>, metersPerUnit: number): FloorBox[] | null {
  const segs = model.segs.filter((s) => s.insert < 0 && !s.dashed && roles[s.layer] === 'walls');
  if (segs.length < 8) return null;
  const gap = 1.5 / metersPerUnit;
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const grid = new Map<string, number>();
  segs.forEach((s, i) => {
    const x0 = Math.floor((Math.min(s.a.x, s.b.x) - gap / 2) / gap);
    const x1 = Math.floor((Math.max(s.a.x, s.b.x) + gap / 2) / gap);
    const y0 = Math.floor((Math.min(s.a.y, s.b.y) - gap / 2) / gap);
    const y1 = Math.floor((Math.max(s.a.y, s.b.y) + gap / 2) / gap);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 40000) return;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        const other = grid.get(k);
        if (other === undefined) grid.set(k, i);
        else parent[find(i)] = find(other);
      }
  });
  const clusters = new Map<number, PlanCluster>();
  segs.forEach((s, i) => {
    const r = find(i);
    const c = clusters.get(r) ?? { box: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, length: 0 };
    for (const p of [s.a, s.b]) {
      c.box.minX = Math.min(c.box.minX, p.x);
      c.box.minY = Math.min(c.box.minY, p.y);
      c.box.maxX = Math.max(c.box.maxX, p.x);
      c.box.maxY = Math.max(c.box.maxY, p.y);
    }
    c.length += dist(s.a, s.b);
    clusters.set(r, c);
  });
  const plans = [...clusters.values()].filter((c) => {
    const span = Math.max(c.box.maxX - c.box.minX, c.box.maxY - c.box.minY) * metersPerUnit;
    return span >= 3 && c.length * metersPerUnit >= 20;
  });
  if (plans.length < 2 || plans.length > 6) return null;
  const area = (c: PlanCluster) => (c.box.maxX - c.box.minX) * (c.box.maxY - c.box.minY);
  plans.sort((a, b) => {
    const big = Math.max(area(a), area(b));
    if (Math.min(area(a), area(b)) < big * 0.75) return area(b) - area(a);
    const dx = a.box.minX - b.box.minX;
    if (Math.abs(dx) > gap) return dx;
    return b.box.maxY - a.box.maxY;
  });
  // Grow each box by up to 1 m, but never past half the gap to another plan.
  return plans.map((c, i) => {
    let margin = 1 / metersPerUnit;
    plans.forEach((o, j) => {
      if (i === j) return;
      const gx = Math.max(o.box.minX - c.box.maxX, c.box.minX - o.box.maxX);
      const gy = Math.max(o.box.minY - c.box.maxY, c.box.minY - o.box.maxY);
      margin = Math.min(margin, Math.max(gx, gy) / 2);
    });
    margin = Math.max(0, margin);
    return { minX: c.box.minX - margin, minY: c.box.minY - margin, maxX: c.box.maxX + margin, maxY: c.box.maxY + margin };
  });
}

export interface AlignInput {
  /** Centre of each floor's stair outline (meters), or null. */
  stairCenters: (Vec2 | null)[];
  /** Minimum corner of each floor's walls, or null. */
  cornerOf: (Vec2 | null)[];
  boxes?: FloorBox[];
  /** Short texts per floor (level marks such as +2.75), for matching drawings of the same spot. */
  labels?: { p: Vec2; text: string }[][];
  /** Wall end points per floor, to snap the alignment exactly. */
  vertices?: Vec2[][];
}

export interface Alignment {
  offsets: Vec2[];
  warnings: string[];
  /** How each floor was lined up, for the report. */
  methods: ('stair' | 'labels' | 'corner' | 'none')[];
}

/** Offset from the texts that appear exactly once on both floors, if they agree. */
function labelOffset(a: { p: Vec2; text: string }[], b: { p: Vec2; text: string }[]): Vec2 | null {
  const once = (list: { p: Vec2; text: string }[]) => {
    const m = new Map<string, Vec2 | null>();
    for (const t of list) m.set(t.text, m.has(t.text) ? null : t.p);
    return m;
  };
  const ma = once(a);
  const mb = once(b);
  const offs: Vec2[] = [];
  for (const [text, pa] of ma) {
    const pb = mb.get(text);
    if (pa && pb) offs.push({ x: pa.x - pb.x, y: pa.y - pb.y });
  }
  if (offs.length < 2) return null;
  const mean = { x: offs.reduce((s, o) => s + o.x, 0) / offs.length, y: offs.reduce((s, o) => s + o.y, 0) / offs.length };
  return offs.every((o) => dist(o, mean) < 0.05) ? mean : null;
}

/**
 * Refines an offset so the upper floor's wall corners land exactly on the lower floor's: among the
 * shifts within `window` of the estimate that map a corner onto a corner, the one that makes the
 * most corners coincide (within 5 mm) wins.
 */
export function snapOffset(lower: Vec2[], upper: Vec2[], estimate: Vec2, window = 0.12): Vec2 {
  if (lower.length === 0 || upper.length === 0) return estimate;
  const cell = 0.01;
  const grid = new Map<string, Vec2[]>();
  for (const p of lower) {
    const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
    const g = grid.get(k);
    if (g) g.push(p);
    else grid.set(k, [p]);
  }
  // How many corners land on a corner (within 5 mm), and how far off they are in total.
  const hits = (o: Vec2) => {
    let n = 0;
    let err = 0;
    for (const q of upper) {
      const x = q.x + o.x;
      const y = q.y + o.y;
      const cx = Math.floor(x / cell);
      const cy = Math.floor(y / cell);
      let d = Infinity;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const p of grid.get(`${cx + i},${cy + j}`) ?? []) d = Math.min(d, Math.hypot(p.x - x, p.y - y));
      if (d < 0.005) {
        n++;
        err += d;
      }
    }
    return { n, err };
  };
  let best = estimate;
  let bestHits = hits(estimate);
  const tried = new Set<string>();
  for (const q of upper) {
    for (const p of lower) {
      const o = { x: p.x - q.x, y: p.y - q.y };
      if (Math.abs(o.x - estimate.x) > window || Math.abs(o.y - estimate.y) > window) continue;
      const key = `${Math.round(o.x / 0.0001)},${Math.round(o.y / 0.0001)}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const h = hits(o);
      if (h.n > bestHits.n || (h.n === bestHits.n && h.err < bestHits.err - 1e-9)) {
        best = o;
        bestHits = h;
      }
    }
  }
  return bestHits.n >= 3 ? best : estimate;
}

/** Offsets that move each floor onto the lowest one. */
export function alignFloors(input: AlignInput): Alignment {
  const { stairCenters, cornerOf, boxes, labels, vertices } = input;
  const n = stairCenters.length;
  const offsets: Vec2[] = new Array(n).fill(null).map(() => ({ x: 0, y: 0 }));
  const warnings: string[] = [];
  const methods: Alignment['methods'] = new Array(n).fill('none');
  for (let k = 1; k < n; k++) {
    const prev = stairCenters[k - 1];
    const cur = stairCenters[k];
    let rel: Vec2 | null = null;
    if (prev && cur) {
      rel = { x: prev.x - cur.x, y: prev.y - cur.y };
      methods[k] = 'stair';
    } else if (labels) {
      rel = labelOffset(labels[k - 1] ?? [], labels[k] ?? []);
      if (rel) methods[k] = 'labels';
    }
    if (!rel) {
      const pc = boxes?.[k - 1] ? { x: Math.min(boxes[k - 1].minX, boxes[k - 1].maxX), y: Math.min(boxes[k - 1].minY, boxes[k - 1].maxY) } : cornerOf[k - 1];
      const cc = boxes?.[k] ? { x: Math.min(boxes[k].minX, boxes[k].maxX), y: Math.min(boxes[k].minY, boxes[k].maxY) } : cornerOf[k];
      rel = pc && cc ? { x: pc.x - cc.x, y: pc.y - cc.y } : { x: 0, y: 0 };
      methods[k] = 'corner';
      warnings.push(`Floor ${k + 1} was aligned to floor ${k} by its corner, because there is no stair or matching level mark on both to line them up. Check the result.`);
    } else if (vertices) {
      rel = snapOffset(vertices[k - 1] ?? [], vertices[k] ?? [], rel);
    }
    offsets[k] = { x: offsets[k - 1].x + rel.x, y: offsets[k - 1].y + rel.y };
  }
  return { offsets, warnings, methods };
}
