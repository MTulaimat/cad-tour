import type { Vec2 } from '../schema';
import { add, cross, dist, dot, ensureCCW, normalize, perp, scale, sub } from '../../util/math2d';
import type { DetectedStair } from './stairs';

/**
 * Stairs drawn on any layer (often on the walls layer with everything else): a run of at least five
 * parallel lines of equal length (0.6 to 1.6 m) spaced 0.22 to 0.35 m apart, whose ends sit on two
 * rails (lines along the run, such as a wall face and a handrail). A gap of up to three treads
 * inside the run is a landing. The stair's lines are reported so they stay out of the walls.
 */

export interface TreadRun {
  /** Rectangle around the treads, counterclockwise. */
  outline: Vec2[];
  /** Riser positions along `along`, ascending, including a last riser where the rails end. */
  positions: number[];
  /** Unit vector of the run (positions grow along it), and along the tread lines. */
  along: Vec2;
  across: Vec2;
  /** Extent across the run, in the `across` coordinate. */
  t0: number;
  t1: number;
  /** Input segments that belong to the stair: treads, rails, the arrow, tick marks. */
  used: number[];
  /** Rails among them (lines along the run). */
  rails: number[];
  /** Drawn arrow: +1 climbing towards higher positions, -1 towards lower ones, 0 when none. */
  arrow: number;
}

const DEG = Math.PI / 180;

interface LineInfo {
  i: number;
  l: number;
  d: Vec2;
  ang: number;
}

export function findTreadRuns(segs: { a: Vec2; b: Vec2 }[]): TreadRun[] {
  const info: LineInfo[] = segs.map((s, i) => {
    const l = dist(s.a, s.b);
    let d = l > 1e-9 ? normalize(sub(s.b, s.a)) : { x: 1, y: 0 };
    if (d.x < -1e-9 || (Math.abs(d.x) <= 1e-9 && d.y < 0)) d = scale(d, -1);
    return { i, l, d, ang: Math.atan2(d.y, d.x) };
  });
  const cands = info.filter((x) => x.l >= 0.6 && x.l <= 1.6).sort((a, b) => a.ang - b.ang);
  const groups: LineInfo[][] = [];
  for (const c of cands) {
    const g = groups[groups.length - 1];
    if (g && c.ang - g[0].ang <= 2 * DEG) g.push(c);
    else groups.push([c]);
  }
  const runs: TreadRun[] = [];
  const taken = new Set<number>();
  for (const g of groups) {
    if (g.length < 5) continue;
    const across = g[0].d;
    const along = perp(across);
    const keyed = g
      .map((c) => {
        const s = segs[c.i];
        const ta = dot(s.a, across);
        const tb = dot(s.b, across);
        return { i: c.i, t0: Math.min(ta, tb), t1: Math.max(ta, tb), s: dot(scale(add(s.a, s.b), 0.5), along) };
      })
      .sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
    // Lines that share both end positions form one candidate stair.
    const ends: (typeof keyed)[] = [];
    for (const k of keyed) {
      const e = ends.find((x) => Math.abs(x[0].t0 - k.t0) < 0.03 && Math.abs(x[0].t1 - k.t1) < 0.03);
      if (e) e.push(k);
      else ends.push([k]);
    }
    for (const e of ends) {
      if (e.length < 5) continue;
      e.sort((a, b) => a.s - b.s);
      const pos: { s: number; ids: number[] }[] = [];
      for (const k of e) {
        const last = pos[pos.length - 1];
        if (last && k.s - last.s < 0.02) last.ids.push(k.i);
        else pos.push({ s: k.s, ids: [k.i] });
      }
      let start = 0;
      for (let j = 1; j <= pos.length; j++) {
        if (j < pos.length && pos[j].s - pos[j - 1].s >= 0.2 && pos[j].s - pos[j - 1].s <= 1.1) continue;
        const part = pos.slice(start, j);
        start = j;
        const run = tryRun(part, e, segs, info, along, across, taken);
        if (run) runs.push(run);
      }
    }
  }
  return runs;
}

function tryRun(
  part: { s: number; ids: number[] }[],
  lines: { t0: number; t1: number }[],
  segs: { a: Vec2; b: Vec2 }[],
  info: LineInfo[],
  along: Vec2,
  across: Vec2,
  taken: Set<number>,
): TreadRun | null {
  const steps = part.slice(1).map((p, k) => p.s - part[k].s);
  const regular = steps.filter((st) => st >= 0.22 && st <= 0.35);
  if (regular.length < 4) return null;
  const going = regular.slice().sort((a, b) => a - b)[Math.floor(regular.length / 2)];
  if (steps.some((st) => Math.abs(st - going) > 0.04 && (st < 1.5 * going || st > 3.5 * going))) return null;
  if (part.some((p) => p.ids.some((id) => taken.has(id)))) return null;
  const t0 = lines.reduce((m, k) => m + k.t0, 0) / lines.length;
  const t1 = lines.reduce((m, k) => m + k.t1, 0) / lines.length;
  const s0 = part[0].s;
  const s1 = part[part.length - 1].s;
  const parallel = info.filter((x) => Math.abs(cross(x.d, along)) < Math.sin(2 * DEG) && x.l > 0.005);
  const sideLines = (t: number) =>
    parallel.filter((x) => {
      const s = segs[x.i];
      return Math.abs(dot(s.a, across) - t) < 0.03 && Math.abs(dot(s.b, across) - t) < 0.03;
    });
  const coverage = (list: LineInfo[]) => {
    const iv = list
      .map((x) => {
        const s = segs[x.i];
        const u0 = dot(s.a, along);
        const u1 = dot(s.b, along);
        return [Math.max(s0, Math.min(u0, u1)), Math.min(s1, Math.max(u0, u1))] as [number, number];
      })
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let cur = s0;
    for (const [a, b] of iv) {
      if (b <= cur) continue;
      covered += b - Math.max(a, cur);
      cur = b;
    }
    return covered / Math.max(1e-6, s1 - s0);
  };
  if (coverage(sideLines(t0)) < 0.7 || coverage(sideLines(t1)) < 0.7) return null;

  // Lines along the run that stay within it belong to the stair (rails, the arrow); a wall face
  // that carries on past the stair stays a wall.
  const used = new Set<number>(part.flatMap((p) => p.ids));
  const rails: number[] = [];
  let lo = s0;
  let hi = s1;
  let arrowLine: { tail: Vec2; head: Vec2; l: number } | null = null;
  for (const x of parallel) {
    const s = segs[x.i];
    const ta = dot(s.a, across);
    const tb = dot(s.b, across);
    if (Math.min(ta, tb) < t0 - 0.02 || Math.max(ta, tb) > t1 + 0.02) continue;
    const u0 = Math.min(dot(s.a, along), dot(s.b, along));
    const u1 = Math.max(dot(s.a, along), dot(s.b, along));
    if (u0 < s0 - 2.2 * going || u1 > s1 + 2.2 * going) continue;
    if (x.l < 0.45) continue;
    used.add(x.i);
    if (Math.abs(ta - t0) < 0.15 || Math.abs(ta - t1) < 0.15) {
      rails.push(x.i);
      lo = Math.min(lo, u0);
      hi = Math.max(hi, u1);
    } else if (x.l > (s1 - s0) * 0.35 && (!arrowLine || x.l > arrowLine.l)) arrowLine = { tail: s.a, head: s.b, l: x.l };
  }
  // Short pieces wholly inside the stair: arrow heads and tick marks.
  info.forEach((x) => {
    if (x.l > 0.45 || used.has(x.i)) return;
    const s = segs[x.i];
    for (const p of [s.a, s.b]) {
      const u = dot(p, along);
      const t = dot(p, across);
      if (u < lo - 0.02 || u > hi + 0.02 || t < t0 - 0.02 || t > t1 + 0.02) return;
    }
    used.add(x.i);
  });
  // The rails usually run one tread past the last drawn riser, to the edge of the floor above.
  const positions = part.map((p) => p.s);
  const near = (beyond: number) => beyond > 0.5 * going && beyond < 1.5 * going;
  const railEnds = rails.map((id) => {
    const u0 = dot(segs[id].a, along);
    const u1 = dot(segs[id].b, along);
    return [Math.min(u0, u1), Math.max(u0, u1)];
  });
  const best = (list: number[]) => list.filter(near).sort((a, b) => Math.abs(a - going) - Math.abs(b - going))[0];
  const lowExt = best(railEnds.map(([u]) => s0 - u));
  const highExt = best(railEnds.map(([, u]) => u - s1));
  if (lowExt !== undefined) positions.unshift(s0 - lowExt);
  if (highExt !== undefined) positions.push(s1 + highExt);
  let arrow = 0;
  if (arrowLine) {
    const short = info.filter((x) => x.l < 0.45 && used.has(x.i)).map((x) => segs[x.i]);
    const count = (p: Vec2) => short.filter((s) => Math.min(dist(s.a, p), dist(s.b, p)) < 0.12).length;
    const head = count(arrowLine.tail) > count(arrowLine.head) ? arrowLine.tail : arrowLine.head;
    const tail = head === arrowLine.head ? arrowLine.tail : arrowLine.head;
    arrow = Math.sign(dot(sub(head, tail), along));
  }
  for (const id of used) taken.add(id);
  const P = (u: number, t: number) => add(scale(along, u), scale(across, t));
  const a = positions[0];
  const b = positions[positions.length - 1];
  return { outline: ensureCCW([P(a, t0), P(b, t0), P(b, t1), P(a, t1)]), positions, along, across, t0, t1, used: [...used], rails, arrow };
}

/**
 * Railings that carry on from a stair's rails, such as the guard along a landing: thin double lines
 * (3 to 12 cm apart) of which one touches the end of a rail. They are railings, not walls; both
 * lines also bound rooms (the landing on one side, the open space on the other).
 */
export function stairRailings(segs: { a: Vec2; b: Vec2 }[], runs: TreadRun[], skip: Set<number>): { railings: Vec2[][]; used: number[]; boundaries: { a: Vec2; b: Vec2 }[] } {
  const railEnds = runs.flatMap((r) => r.rails.flatMap((i) => [segs[i].a, segs[i].b]));
  const touches = (s: { a: Vec2; b: Vec2 }) =>
    railEnds.some((p) => {
      const ab = sub(s.b, s.a);
      const l2 = dot(ab, ab);
      const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, s.a), ab) / l2));
      return dist(p, add(s.a, scale(ab, t))) < 0.03;
    });
  const free = segs.map((s, i) => ({ s, i })).filter(({ s, i }) => !skip.has(i) && dist(s.a, s.b) > 0.3);
  const starts = free.filter(({ s }) => touches(s));
  const used = new Set<number>();
  const railings: Vec2[][] = [];
  const boundaries: { a: Vec2; b: Vec2 }[] = [];
  for (const { s: A, i } of starts) {
    if (used.has(i)) continue;
    const d = normalize(sub(A.b, A.a));
    const n = perp(d);
    const la = dist(A.a, A.b);
    for (const { s: B, i: j } of free) {
      if (j === i || used.has(j)) continue;
      if (Math.abs(cross(d, normalize(sub(B.b, B.a)))) > 0.02) continue;
      const off = dot(sub(B.a, A.a), n);
      if (Math.abs(off) < 0.03 || Math.abs(off) > 0.12) continue;
      const u0 = Math.max(0, Math.min(dot(sub(B.a, A.a), d), dot(sub(B.b, A.a), d)));
      const u1 = Math.min(la, Math.max(dot(sub(B.a, A.a), d), dot(sub(B.b, A.a), d)));
      if (u1 - u0 < 0.3) continue;
      const mid = scale(n, off / 2);
      railings.push([add(add(A.a, scale(d, u0)), mid), add(add(A.a, scale(d, u1)), mid)]);
      used.add(i);
      used.add(j);
      boundaries.push({ a: A.a, b: A.b }, { a: B.a, b: B.b });
      break;
    }
  }
  return { railings, used: [...used], boundaries };
}

/**
 * Flights and landings of a tread run, climbing towards higher positions (`upHigh`) or lower ones.
 * Every position is a riser; a gap longer than one and a half treads is a landing.
 */
export function stairFromRun(run: TreadRun, upHigh: boolean): DetectedStair {
  const ps = upHigh ? run.positions.slice() : run.positions.slice().reverse();
  const dir = upHigh ? run.along : scale(run.along, -1);
  const steps = ps.slice(1).map((p, k) => Math.abs(p - ps[k]));
  const regular = steps.filter((s) => s >= 0.2 && s <= 0.4).sort((a, b) => a - b);
  const going = regular[Math.floor(regular.length / 2)] ?? 0.28;
  const width = run.t1 - run.t0;
  const mid = (run.t0 + run.t1) / 2;
  const P = (u: number, t: number) => add(scale(run.along, u), scale(run.across, t));
  const flights: DetectedStair['flights'] = [];
  const landings: DetectedStair['landings'] = [];
  let first = 0;
  let before = 0;
  for (let k = 1; k <= ps.length; k++) {
    if (k < ps.length && steps[k - 1] <= 1.5 * going) continue;
    const risers = k - first;
    flights.push({ start: P(ps[first], mid), direction: dir, width, risers, going, baseElevation: 0 });
    before += risers;
    if (k < ps.length) {
      const a = ps[k - 1];
      const b = ps[k];
      landings.push({ polygon: ensureCCW([P(a, run.t0), P(b, run.t0), P(b, run.t1), P(a, run.t1)]), risersBefore: before });
    }
    first = k;
  }
  return { outline: run.outline, flights, landings, totalRisers: before, warnings: [] };
}
