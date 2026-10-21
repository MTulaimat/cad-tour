import type { StairFlight, StairLanding, Vec2 } from '../schema';
import { add, bounds, dist, dot, ensureCCW, normalize, perp, pointInPolygon, polygonArea, scale, sub } from '../../util/math2d';

/**
 * Stairs from a stair layer (P2): the outline (largest closed polyline, else the line work's
 * oriented bounding box), riser or tread lines inside it grouped by orientation, and the direction
 * arrow (or an UP / DN label). One orientation gives a straight flight; two give an L or U stair
 * with a landing. Anything else falls back to a straight flight along the outline's long axis.
 */

export interface StairInput {
  segs: { a: Vec2; b: Vec2 }[];
  polys: Vec2[][];
  texts: { p: Vec2; text: string }[];
}

export interface DetectedStair {
  outline: Vec2[];
  flights: Omit<StairFlight, 'riserHeight'>[];
  landings: { polygon: Vec2[]; risersBefore: number }[];
  totalRisers: number;
  warnings: string[];
}

const UP = /^(up|u\.?p\.?|صعود|طلوع|up\s*\d*)$/i;
const DOWN = /^(dn|down|نزول)$/i;

/** Oriented bounding box from the dominant direction of the segments. */
function orientedBox(pts: Vec2[], dir: Vec2): Vec2[] {
  const n = perp(dir);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of pts) {
    const u = dot(p, dir);
    const v = dot(p, n);
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const P = (u: number, v: number) => add(scale(dir, u), scale(n, v));
  return ensureCCW([P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)]);
}

function dominantDirection(segs: { a: Vec2; b: Vec2 }[]): Vec2 {
  // Length-weighted histogram of angles mod 180 degrees.
  const bins = new Array(36).fill(0);
  for (const s of segs) {
    const d = sub(s.b, s.a);
    let a = Math.atan2(d.y, d.x);
    if (a < 0) a += Math.PI;
    bins[Math.floor((a / Math.PI) * 36) % 36] += Math.hypot(d.x, d.y);
  }
  const k = bins.indexOf(Math.max(...bins));
  const a = ((k + 0.5) / 36) * Math.PI;
  return { x: Math.cos(a), y: Math.sin(a) };
}

interface Group {
  dir: Vec2;
  lines: { a: Vec2; b: Vec2 }[];
}

function groupByOrientation(lines: { a: Vec2; b: Vec2 }[]): Group[] {
  const groups: Group[] = [];
  for (const l of lines) {
    const d = normalize(sub(l.b, l.a));
    const g = groups.find((x) => Math.abs(dot(x.dir, d)) > Math.cos((8 * Math.PI) / 180));
    if (g) g.lines.push(l);
    else groups.push({ dir: d, lines: [l] });
  }
  return groups.sort((a, b) => b.lines.length - a.lines.length);
}

/** Distinct riser positions of a group along its normal, plus extents. */
function riserPositions(g: Group): { n: Vec2; positions: number[]; lo: number; hi: number } {
  const n = perp(g.dir);
  const pos = g.lines.map((l) => dot(scale(add(l.a, l.b), 0.5), n)).sort((x, y) => x - y);
  const out: number[] = [];
  for (const p of pos) if (out.length === 0 || p - out[out.length - 1] > 0.05) out.push(p);
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of g.lines) {
    for (const p of [l.a, l.b]) {
      const u = dot(p, g.dir);
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
    }
  }
  return { n, positions: out, lo, hi };
}

function arrowDirection(input: StairInput, axis: Vec2, outline: Vec2[]): { dir: Vec2 | null; how: string } {
  // A long line or polyline roughly along the run axis, inside the outline; its last point is the head.
  let best: { len: number; tail: Vec2; head: Vec2 } | null = null;
  const candidates: { pts: Vec2[] }[] = [...input.polys.map((p) => ({ pts: p })), ...input.segs.map((s) => ({ pts: [s.a, s.b] }))];
  const extent = bounds(outline);
  const span = Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY);
  for (const c of candidates) {
    if (c.pts.length < 2) continue;
    const tail = c.pts[0];
    const head = c.pts[c.pts.length - 1];
    const d = sub(head, tail);
    const l = Math.hypot(d.x, d.y);
    if (l < span * 0.35) continue;
    if (Math.abs(dot(normalize(d), axis)) < 0.85) continue;
    if (!pointInPolygon(scale(add(tail, head), 0.5), outline)) continue;
    if (!best || l > best.len) best = { len: l, tail, head };
  }
  if (best) {
    // Arrowhead strokes (short segments) cluster at the head; if they sit at the tail, flip.
    const short = input.segs.filter((s) => dist(s.a, s.b) < 0.45);
    const near = (p: Vec2) => short.filter((s) => Math.min(dist(s.a, p), dist(s.b, p)) < 0.12).length;
    const head = near(best.tail) > near(best.head) ? best.tail : best.head;
    const tail = head === best.head ? best.tail : best.head;
    return { dir: normalize(sub(head, tail)), how: 'arrow' };
  }
  for (const t of input.texts) {
    if (!pointInPolygon(t.p, outline)) continue;
    const c = scale(outline.reduce((a, p) => add(a, p), { x: 0, y: 0 }), 1 / outline.length);
    const along = dot(sub(t.p, c), axis);
    if (UP.test(t.text.trim())) return { dir: along <= 0 ? axis : scale(axis, -1), how: 'label' };
    if (DOWN.test(t.text.trim())) return { dir: along <= 0 ? scale(axis, -1) : axis, how: 'label' };
  }
  return { dir: null, how: 'none' };
}

export function detectStair(input: StairInput): DetectedStair | null {
  const warnings: string[] = [];
  const allPts = [...input.segs.flatMap((s) => [s.a, s.b]), ...input.polys.flat()];
  if (allPts.length < 4) return null;
  const closed = input.polys.filter((p) => p.length >= 3).sort((a, b) => polygonArea(b) - polygonArea(a));
  const dir0 = dominantDirection(input.segs.length ? input.segs : closed.flatMap((p) => p.map((q, i) => ({ a: q, b: p[(i + 1) % p.length] }))));
  const outline = closed[0] && polygonArea(closed[0]) > 0.8 ? ensureCCW(closed[0].slice()) : orientedBox(allPts, dir0);
  const ob = bounds(outline);
  const shrink = (p: Vec2) => pointInPolygon(p, outline) || outline.some((q, i) => {
    const r = outline[(i + 1) % outline.length];
    const t = Math.max(0, Math.min(1, dot(sub(p, q), sub(r, q)) / Math.max(1e-9, dot(sub(r, q), sub(r, q)))));
    return dist(p, add(q, scale(sub(r, q), t))) < 0.03;
  });
  // Riser lines: inside (or on) the outline, not the outline's own edges, not the arrow.
  const lines = input.segs.filter((s) => {
    const l = dist(s.a, s.b);
    return l > 0.3 && shrink(s.a) && shrink(s.b);
  });
  // Step lines run across the stair: shorter than most of the outline's long side, similar lengths.
  const longSide = Math.max(ob.maxX - ob.minX, ob.maxY - ob.minY);
  const groups = groupByOrientation(lines.filter((l) => dist(l.a, l.b) < longSide * 0.7))
    .map((g) => {
      const lens = g.lines.map((l) => dist(l.a, l.b)).sort((a, b) => a - b);
      const med = lens[Math.floor(lens.length / 2)];
      return { ...g, lines: g.lines.filter((l) => Math.abs(dist(l.a, l.b) - med) < med * 0.35) };
    })
    .filter((g) => g.lines.length >= 3);
  if (groups.length === 0) {
    warnings.push('A stair has no step lines; it was built as a straight flight along its long side.');
    return straightFallback(outline, warnings);
  }
  const flights: Omit<StairFlight, 'riserHeight'>[] = [];
  const landings: DetectedStair['landings'] = [];
  const usable = groups.slice(0, 2);
  // Run axis of each group: perpendicular to its riser lines.
  let risersSoFar = 0;
  const flightInfo = usable.map((g) => {
    const r = riserPositions(g);
    return { g, ...r, risers: r.positions.length };
  });
  for (const f of flightInfo) {
    if (f.risers < 3) continue;
    const runAxis = f.n;
    const width = f.hi - f.lo;
    const going = (f.positions[f.positions.length - 1] - f.positions[0]) / Math.max(1, f.risers - 1);
    const mid = (f.lo + f.hi) / 2;
    const arrow = arrowDirection(input, runAxis, outline);
    let climb = runAxis;
    if (arrow.dir) climb = dot(arrow.dir, runAxis) >= 0 ? runAxis : scale(runAxis, -1);
    else warnings.push('A stair has no direction arrow or UP label; it is assumed to climb along its drawing direction.');
    const firstPos = dot(climb, runAxis) > 0 ? f.positions[0] : f.positions[f.positions.length - 1];
    const start = add(scale(f.g.dir, mid), scale(runAxis, firstPos));
    flights.push({ start, direction: climb, width, risers: f.risers, going, baseElevation: 0 });
    risersSoFar += f.risers;
  }
  if (flights.length === 0) return straightFallback(outline, warnings);
  if (flights.length === 2) {
    // Order the flights: the one whose top is nearer the other's start goes first.
    const top = (fl: (typeof flights)[number]) => add(fl.start, scale(fl.direction, (fl.risers - 1) * fl.going));
    const [f1, f2] = dist(top(flights[0]), flights[1].start) <= dist(top(flights[1]), flights[0].start) ? [flights[0], flights[1]] : [flights[1], flights[0]];
    flights.splice(0, 2, f1, f2);
    // Landing: the outline's corner region between the two flights (bounding box approximation).
    const end1 = top(f1);
    const lw = Math.max(f1.width, f2.width);
    const lc = add(end1, scale(f1.direction, lw / 2));
    const lx = Math.max(0.6, lw);
    const n1 = perp(f1.direction);
    const P = (a: number, b: number) => add(add(lc, scale(f1.direction, a)), scale(n1, b));
    landings.push({ polygon: ensureCCW([P(-lx / 2, -lx), P(lx / 2, -lx), P(lx / 2, lx), P(-lx / 2, lx)]).map((p) => clampTo(p, ob)), risersBefore: f1.risers });
    warnings.push('An L or U shaped stair was detected; check its landing in the preview.');
  } else if (groups.length > 2) {
    warnings.push('A stair has step lines in more than two directions; only the main flights were used.');
  }
  return { outline, flights, landings, totalRisers: risersSoFar, warnings };
}

function clampTo(p: Vec2, b: { minX: number; minY: number; maxX: number; maxY: number }): Vec2 {
  return { x: Math.max(b.minX, Math.min(b.maxX, p.x)), y: Math.max(b.minY, Math.min(b.maxY, p.y)) };
}

function straightFallback(outline: Vec2[], warnings: string[]): DetectedStair {
  // Long axis of the outline.
  let best = { l: 0, d: { x: 1, y: 0 } as Vec2 };
  for (let i = 0; i < outline.length; i++) {
    const d = sub(outline[(i + 1) % outline.length], outline[i]);
    const l = Math.hypot(d.x, d.y);
    if (l > best.l) best = { l, d: normalize(d) };
  }
  const box = orientedBox(outline, best.d);
  const run = dist(box[0], box[1]);
  const width = dist(box[1], box[2]);
  const risers = Math.max(3, Math.round(run / 0.27) + 1);
  const start = scale(add(box[0], box[3]), 0.5);
  return {
    outline,
    flights: [{ start, direction: normalize(sub(box[1], box[0])), width, risers, going: run / (risers - 1), baseElevation: 0 }],
    landings: [],
    totalRisers: risers,
    warnings,
  };
}

/** Final flights and landings once the floor-to-floor height is known. */
export function finishStair(s: DetectedStair, floorToFloor: number): { flights: StairFlight[]; landings: StairLanding[] } {
  const rh = floorToFloor / Math.max(1, s.totalRisers);
  let before = 0;
  const flights = s.flights.map((f) => {
    const out: StairFlight = { ...f, riserHeight: rh, baseElevation: before * rh };
    before += f.risers;
    return out;
  });
  const last = flights[flights.length - 1];
  const top = add(last.start, scale(last.direction, (last.risers - 1) * last.going));
  const n = perp(last.direction);
  const hw = last.width / 2;
  const arrival = ensureCCW([add(top, scale(n, -hw)), add(add(top, scale(last.direction, 0.6)), scale(n, -hw)), add(add(top, scale(last.direction, 0.6)), scale(n, hw)), add(top, scale(n, hw))]);
  const landings: StairLanding[] = [
    ...s.landings.map((l) => ({ polygon: l.polygon, elevation: l.risersBefore * rh })),
    { polygon: arrival, elevation: floorToFloor },
  ];
  return { flights, landings };
}
