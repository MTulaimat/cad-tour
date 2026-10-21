import type { Vec2 } from '../schema';
import { add, cross, dist, dot, len, lineIntersection, normalize, perp, scale, sub } from '../../util/math2d';

/**
 * Wall extraction from wall-layer line work (meters).
 * 1. Clean-up: drop zero-length pieces, snap endpoints within the tolerance, remove duplicates,
 *    merge collinear overlapping or touching pieces.
 * 2. Pairing: parallel lines 5 to 40 cm apart that overlap become one wall (centerline midway,
 *    thickness = distance). Closed polylines and hatch outlines join in as their edges.
 * 3. What is left and long enough becomes a single-line (centerline) wall at the default thickness.
 * 4. Gap closing: wall ends that stop short of another wall (L and T corners) are extended to meet
 *    it, but only across gaps smaller than the smallest plausible opening, so door gaps stay open.
 */

export interface Seg {
  a: Vec2;
  b: Vec2;
}

export interface WallPiece {
  a: Vec2;
  b: Vec2;
  thickness: number;
  source: 'pair' | 'single';
}

export interface WallOptions {
  tolerance: number;
  defaultThickness: number;
  minPair: number;
  maxPair: number;
  /** Shortest unpaired line that still counts as a single-line wall. */
  minSingle: number;
  /** Largest gap closed automatically (below the smallest door). */
  maxGap: number;
}

export const WALL_DEFAULTS: WallOptions = {
  tolerance: 0.02,
  defaultThickness: 0.2,
  minPair: 0.05,
  maxPair: 0.4,
  minSingle: 0.5,
  maxGap: 0.45,
};

const ANGLE_TOL = Math.sin((2.5 * Math.PI) / 180);

// ---- 1. clean-up -----------------------------------------------------------------------

/** Snaps endpoints within `tol` onto a shared point (grid-hashed clustering). */
export function snapEndpoints(segs: Seg[], tol: number): Seg[] {
  const cell = Math.max(tol, 1e-6);
  const grid = new Map<string, Vec2[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const snap = (p: Vec2): Vec2 => {
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    let best: Vec2 | null = null;
    let bestD = tol;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const q of grid.get(`${cx + i},${cy + j}`) ?? []) {
          const d = dist(p, q);
          if (d <= bestD) {
            bestD = d;
            best = q;
          }
        }
    if (best) return best;
    const k = key(p.x, p.y);
    const list = grid.get(k) ?? [];
    list.push(p);
    grid.set(k, list);
    return p;
  };
  return segs.map((s) => ({ a: snap(s.a), b: snap(s.b) }));
}

/** Groups segments that lie on the same infinite line and merges overlapping or touching ones. */
export function mergeCollinear(segs: Seg[], tol: number): Seg[] {
  const items = segs
    .map((s) => {
      let d = normalize(sub(s.b, s.a));
      // Canonical direction so opposite-drawn segments group together.
      if (d.x < -1e-9 || (Math.abs(d.x) <= 1e-9 && d.y < 0)) d = scale(d, -1);
      const n = perp(d);
      const offset = dot(s.a, n);
      const u0 = dot(s.a, d);
      const u1 = dot(s.b, d);
      return { d, n, offset, lo: Math.min(u0, u1), hi: Math.max(u0, u1), angle: Math.atan2(d.y, d.x) };
    })
    .filter((it) => it.hi - it.lo > 1e-4)
    .sort((x, y) => x.angle - y.angle || x.offset - y.offset);
  const out: Seg[] = [];
  const used = new Array(items.length).fill(false);
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue;
    const group = [items[i]];
    used[i] = true;
    for (let j = i + 1; j < items.length; j++) {
      if (used[j]) continue;
      const dAng = Math.abs(cross(items[i].d, items[j].d));
      if (items[j].angle - items[i].angle > 0.05 && dAng > ANGLE_TOL) break;
      if (dAng <= ANGLE_TOL && Math.abs(items[j].offset - items[i].offset) <= tol) {
        group.push(items[j]);
        used[j] = true;
      }
    }
    const base = group[0];
    const ivs = group.map((g) => [g.lo, g.hi] as [number, number]).sort((x, y) => x[0] - y[0]);
    let [cl, ch] = ivs[0];
    const flush = () => {
      const a = add(scale(base.d, cl), scale(base.n, base.offset));
      const b = add(scale(base.d, ch), scale(base.n, base.offset));
      out.push({ a, b });
    };
    for (let k = 1; k < ivs.length; k++) {
      if (ivs[k][0] <= ch + tol) ch = Math.max(ch, ivs[k][1]);
      else {
        flush();
        [cl, ch] = ivs[k];
      }
    }
    flush();
  }
  return out;
}

export function cleanSegments(segs: Seg[], tol: number): { segs: Seg[]; removed: number } {
  const nonzero = segs.filter((s) => dist(s.a, s.b) > Math.max(1e-3, tol / 4));
  const snapped = snapEndpoints(nonzero, tol);
  const merged = mergeCollinear(snapped, tol);
  return { segs: merged, removed: segs.length - merged.length };
}

// ---- 2. pairing --------------------------------------------------------------------------

interface Line {
  a: Vec2;
  d: Vec2;
  n: Vec2;
  len: number;
  /** Free intervals [u0, u1] along the line not yet used by a pair. */
  free: [number, number][];
}

function subtract(free: [number, number][], u0: number, u1: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of free) {
    if (u1 <= a || u0 >= b) out.push([a, b]);
    else {
      if (u0 > a) out.push([a, u0]);
      if (u1 < b) out.push([u1, b]);
    }
  }
  return out.filter(([a, b]) => b - a > 1e-4);
}

export function pairWalls(segs: Seg[], opts: WallOptions): { pieces: WallPiece[]; leftovers: Seg[] } {
  const lines: Line[] = segs.map((s) => {
    const l = dist(s.a, s.b);
    const d = normalize(sub(s.b, s.a));
    return { a: s.a, d, n: perp(d), len: l, free: [[0, l]] };
  });
  // Candidate pairs: parallel, facing within the thickness range, overlapping.
  const cands: { i: number; j: number; d: number }[] = [];
  const cell = Math.max(1, opts.maxPair * 4);
  const grid = new Map<string, number[]>();
  lines.forEach((l, i) => {
    const x0 = Math.floor(Math.min(l.a.x, l.a.x + l.d.x * l.len) / cell) - 1;
    const x1 = Math.floor(Math.max(l.a.x, l.a.x + l.d.x * l.len) / cell) + 1;
    const y0 = Math.floor(Math.min(l.a.y, l.a.y + l.d.y * l.len) / cell) - 1;
    const y1 = Math.floor(Math.max(l.a.y, l.a.y + l.d.y * l.len) / cell) + 1;
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        const g = grid.get(k) ?? [];
        g.push(i);
        grid.set(k, g);
      }
  });
  const seen = new Set<string>();
  for (const ids of grid.values()) {
    for (let p = 0; p < ids.length; p++)
      for (let q = p + 1; q < ids.length; q++) {
        const i = Math.min(ids[p], ids[q]);
        const j = Math.max(ids[p], ids[q]);
        const k = `${i}:${j}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const A = lines[i];
        const B = lines[j];
        if (Math.abs(cross(A.d, B.d)) > ANGLE_TOL) continue;
        const d = Math.abs(dot(sub(B.a, A.a), A.n));
        if (d < opts.minPair || d > opts.maxPair) continue;
        const b0 = dot(sub(B.a, A.a), A.d);
        const b1 = dot(sub(add(B.a, scale(B.d, B.len)), A.a), A.d);
        const lo = Math.max(0, Math.min(b0, b1));
        const hi = Math.min(A.len, Math.max(b0, b1));
        if (hi - lo < Math.min(0.1, Math.min(A.len, B.len) * 0.5)) continue;
        cands.push({ i, j, d });
      }
  }
  cands.sort((x, y) => x.d - y.d);
  const pieces: WallPiece[] = [];
  for (const { i, j, d } of cands) {
    const A = lines[i];
    const B = lines[j];
    const side = Math.sign(dot(sub(B.a, A.a), A.n)) || 1;
    // B's free intervals in A's parameter.
    const bFree = B.free.map(([u0, u1]) => {
      const p0 = dot(sub(add(B.a, scale(B.d, u0)), A.a), A.d);
      const p1 = dot(sub(add(B.a, scale(B.d, u1)), A.a), A.d);
      return [Math.min(p0, p1), Math.max(p0, p1)] as [number, number];
    });
    for (const [a0, a1] of A.free.slice()) {
      for (const [b0, b1] of bFree) {
        const lo = Math.max(a0, b0);
        const hi = Math.min(a1, b1);
        if (hi - lo < 0.08) continue;
        const off = scale(A.n, (side * d) / 2);
        pieces.push({
          a: add(add(A.a, scale(A.d, lo)), off),
          b: add(add(A.a, scale(A.d, hi)), off),
          thickness: Math.round(d * 200) / 200,
          source: 'pair',
        });
        A.free = subtract(A.free, lo, hi);
        // Back to B's parameter.
        const q0 = dot(sub(add(A.a, scale(A.d, lo)), B.a), B.d);
        const q1 = dot(sub(add(A.a, scale(A.d, hi)), B.a), B.d);
        B.free = subtract(B.free, Math.min(q0, q1), Math.max(q0, q1));
      }
    }
  }
  const leftovers: Seg[] = [];
  for (const l of lines) for (const [u0, u1] of l.free) leftovers.push({ a: add(l.a, scale(l.d, u0)), b: add(l.a, scale(l.d, u1)) });
  return { pieces, leftovers };
}

// ---- 3 and 4. singles, merging and gap closing ----------------------------------------------

/** Merges collinear wall pieces of similar thickness that touch or overlap. */
export function mergePieces(pieces: WallPiece[], tol: number): WallPiece[] {
  const out: WallPiece[] = [];
  const groups = new Map<string, WallPiece[]>();
  const used = new Array(pieces.length).fill(false);
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    const pi = pieces[i];
    const d = normalize(sub(pi.b, pi.a));
    const n = perp(d);
    const group = [pi];
    used[i] = true;
    for (let j = i + 1; j < pieces.length; j++) {
      if (used[j]) continue;
      const pj = pieces[j];
      const dj = normalize(sub(pj.b, pj.a));
      if (Math.abs(cross(d, dj)) > ANGLE_TOL) continue;
      if (Math.abs(dot(sub(pj.a, pi.a), n)) > Math.max(tol, 0.25 * Math.min(pi.thickness, pj.thickness))) continue;
      if (Math.abs(pi.thickness - pj.thickness) > 0.06) continue;
      group.push(pj);
      used[j] = true;
    }
    groups.set(String(i), group);
    const ivs = group
      .map((g) => {
        const u0 = dot(sub(g.a, pi.a), d);
        const u1 = dot(sub(g.b, pi.a), d);
        return { lo: Math.min(u0, u1), hi: Math.max(u0, u1), t: g.thickness, s: g.source, off: dot(sub(g.a, pi.a), n) };
      })
      .sort((x, y) => x.lo - y.lo);
    let cur = { ...ivs[0] };
    const flush = () => {
      out.push({ a: add(add(pi.a, scale(d, cur.lo)), scale(n, cur.off)), b: add(add(pi.a, scale(d, cur.hi)), scale(n, cur.off)), thickness: cur.t, source: cur.s });
    };
    for (let k = 1; k < ivs.length; k++) {
      if (ivs[k].lo <= cur.hi + tol) {
        cur.hi = Math.max(cur.hi, ivs[k].hi);
        cur.t = Math.max(cur.t, ivs[k].t);
      } else {
        flush();
        cur = { ...ivs[k] };
      }
    }
    flush();
  }
  return out;
}

/**
 * Extends wall ends that stop short of another wall: to the other wall's centerline (T) or to the
 * intersection of both lines (L), when the gap is at most `maxGap` beyond the other wall's face.
 * `closed` counts every join; `gaps` only the ones where a wall stopped short of the other wall's
 * face (a centerline from a double-line wall normally ends at that face, which is not a gap).
 */
export function closeGaps(pieces: WallPiece[], maxGap: number, tol: number): { pieces: WallPiece[]; closed: number; gaps: number } {
  const ws = pieces.map((p) => ({ ...p }));
  let closed = 0;
  let gaps = 0;
  const shortBy = (w: WallPiece, o: WallPiece, reach: number) => reach - (w.source === 'pair' ? o.thickness / 2 : 0);
  const near = (p: Vec2, q: Vec2) => dist(p, q) <= tol * 2;
  const isJoined = (w: WallPiece, end: 'a' | 'b') => {
    const p = w[end];
    return ws.some((o) => o !== w && (near(p, o.a) || near(p, o.b) || distToSeg(p, o.a, o.b) <= tol * 2));
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const w of ws) {
      for (const end of ['a', 'b'] as const) {
        if (isJoined(w, end)) continue;
        const p = w[end];
        const other = end === 'a' ? w.b : w.a;
        const dir = normalize(sub(p, other));
        let best: { t: number; q: Vec2; short: number; extendOther?: { o: WallPiece; end: 'a' | 'b' } } | null = null;
        for (const o of ws) {
          if (o === w) continue;
          const od = normalize(sub(o.b, o.a));
          if (Math.abs(cross(dir, od)) < 0.2) continue;
          const x = lineIntersection(p, dir, o.a, od);
          if (!x) continue;
          const t = dot(sub(x, p), dir);
          if (t < -tol || t > maxGap + o.thickness / 2) continue;
          // Where the intersection falls on the other wall.
          const ol = dist(o.a, o.b);
          const s = dot(sub(x, o.a), od);
          let extendOther: { o: WallPiece; end: 'a' | 'b' } | undefined;
          let short = shortBy(w, o, t);
          if (s < -tol) {
            if (-s > maxGap + w.thickness / 2 || isJoined(o, 'a')) continue;
            extendOther = { o, end: 'a' };
            short = Math.max(short, shortBy(o, w, -s));
          } else if (s > ol + tol) {
            if (s - ol > maxGap + w.thickness / 2 || isJoined(o, 'b')) continue;
            extendOther = { o, end: 'b' };
            short = Math.max(short, shortBy(o, w, s - ol));
          }
          if (!best || t < best.t) best = { t, q: x, short, extendOther };
        }
        if (best) {
          w[end] = best.q;
          if (best.extendOther) best.extendOther.o[best.extendOther.end] = best.q;
          closed++;
          if (best.short > 0.001) gaps++;
        }
      }
    }
  }
  return { pieces: ws.filter((w) => dist(w.a, w.b) > tol), closed, gaps };
}

function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return len(sub(p, add(a, scale(ab, t))));
}

export interface WallResult {
  walls: WallPiece[];
  stats: { input: number; cleaned: number; paired: number; single: number; gapsClosed: number };
}

export function extractWalls(segs: Seg[], options: Partial<WallOptions> = {}): WallResult {
  const opts = { ...WALL_DEFAULTS, ...options };
  const { segs: clean } = cleanSegments(segs, opts.tolerance);
  const { pieces, leftovers } = pairWalls(clean, opts);
  // Leftovers become single-line walls, unless they lie inside a paired wall's mass: end caps, jamb
  // lines and corner overhangs of double-line walls (checked against centerlines extended by their
  // thickness, which covers the corners).
  const inside = (s: Seg) => {
    const mid = scale(add(s.a, s.b), 0.5);
    return pieces.some((p) => {
      const d = normalize(sub(p.b, p.a));
      const a = add(p.a, scale(d, -p.thickness));
      const b = add(p.b, scale(d, p.thickness));
      return distToSeg(mid, a, b) <= p.thickness / 2 + opts.tolerance * 1.5;
    });
  };
  const singles: WallPiece[] = leftovers
    .filter((s) => dist(s.a, s.b) >= Math.min(opts.minSingle, 0.1))
    .filter((s) => !inside(s))
    .map((s) => ({ a: s.a, b: s.b, thickness: opts.defaultThickness, source: 'single' as const }));
  const merged = mergePieces([...pieces, ...singles], opts.tolerance);
  const { pieces: walls, gaps } = closeGaps(merged, opts.maxGap, opts.tolerance);
  return {
    walls,
    stats: { input: segs.length, cleaned: clean.length, paired: pieces.length, single: singles.length, gapsClosed: gaps },
  };
}
