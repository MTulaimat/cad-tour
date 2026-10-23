import type { DoorStyle, DoorSwing, OpeningType, Vec2 } from '../schema';
import { add, cross, dist, dot, normalize, perp, scale, sub } from '../../util/math2d';
import type { WallPiece } from './walls';

/**
 * Openings from DXF: door swing arcs, door and window blocks, and window line work. Each opening is
 * snapped to the nearest wall; when it sits in a gap between two collinear wall pieces, the wall is
 * bridged across the gap (so the wall graph stays closed for room detection) and the opening is cut
 * from it.
 */

export interface DoorCandidate {
  kind: 'arc' | 'block';
  /** Arc swing: hinge, radius and the two arc end points. */
  hinge?: Vec2;
  radius?: number;
  ends?: [Vec2, Vec2];
  /** Block footprint corners (meters). */
  corners?: Vec2[];
  label: string;
}

export interface WindowCandidate {
  corners: Vec2[];
  label: string;
}

export interface PlacedOpening {
  wall: WallPiece;
  type: OpeningType;
  /** Distance from wall.a to the opening center. */
  offset: number;
  width: number;
  height: number;
  sill: number;
  swing?: DoorSwing;
  style?: DoorStyle;
  /** Glazing from the floor to the top of the wall (its height is set once wall heights are known). */
  fullHeight?: boolean;
}

export interface OpeningOptions {
  doorHeight: number;
  windowSill: number;
  windowHeight: number;
  tolerance: number;
  /** Gaps up to this wide with no opening become open passages. */
  maxPassage: number;
  /** Gaps narrower than this were already closed as drawing gaps. */
  minGap: number;
  /**
   * Wider gaps inside the plan, up to this wide, are left open from floor to ceiling (open plan);
   * a line across them still separates the rooms. Gaps in outside walls up to this wide are glazed.
   */
  maxOpen?: number;
}

export interface OpeningResult {
  walls: WallPiece[];
  openings: PlacedOpening[];
  warnings: string[];
  /** Lines across open gaps, which split rooms without building a wall. */
  boundaries: { a: Vec2; b: Vec2 }[];
}

const PAR = Math.sin((4 * Math.PI) / 180);
const fmt = (p: Vec2) => `(${p.x.toFixed(2)}, ${p.y.toFixed(2)})`;

interface Host {
  wall: WallPiece;
  dir: Vec2;
  nrm: Vec2;
  /** Opening center parameter along the wall from wall.a. */
  u: number;
  perpDist: number;
}

function findHost(walls: WallPiece[], c: Vec2, width: number, hint: Vec2 | null): Host | null {
  let best: Host | null = null;
  for (const w of walls) {
    const l = dist(w.a, w.b);
    if (l < 1e-6) continue;
    const dir = normalize(sub(w.b, w.a));
    if (hint && Math.abs(cross(dir, hint)) > 0.25) continue;
    const u = dot(sub(c, w.a), dir);
    if (u < -width / 2 - 0.35 || u > l + width / 2 + 0.35) continue;
    const pd = Math.abs(cross(dir, sub(c, w.a)));
    if (pd > w.thickness / 2 + 0.35) continue;
    const score = pd + Math.max(0, -u, u - l) * 0.5;
    if (!best || score < best.perpDist) best = { wall: w, dir, nrm: perp(dir), u, perpDist: score };
  }
  return best;
}

/**
 * Bridges collinear wall pieces around [u - w/2, u + w/2] into one wall. Returns the wall that now
 * carries the opening and the opening's offset along it.
 */
function bridge(walls: WallPiece[], host: Host, width: number, tol: number): { wall: WallPiece; offset: number } {
  const { wall, dir, nrm } = host;
  const o = wall.a;
  const lo0 = host.u - width / 2;
  const hi0 = host.u + width / 2;
  const members: { w: WallPiece; lo: number; hi: number }[] = [];
  for (const w of walls) {
    const d = normalize(sub(w.b, w.a));
    if (Math.abs(cross(d, dir)) > PAR) continue;
    if (Math.abs(dot(sub(w.a, o), nrm)) > Math.max(w.thickness, wall.thickness) / 2 + tol) continue;
    // A column or a thicker wall next to the opening stays its own piece.
    if (w !== wall && Math.abs(w.thickness - wall.thickness) > 0.06) continue;
    const u0 = dot(sub(w.a, o), dir);
    const u1 = dot(sub(w.b, o), dir);
    members.push({ w, lo: Math.min(u0, u1), hi: Math.max(u0, u1) });
  }
  // Grow an interval from the opening out through abutting pieces.
  let lo = lo0;
  let hi = hi0;
  const used = new Set<WallPiece>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of members) {
      if (used.has(m.w)) continue;
      if (m.hi >= lo - 0.3 - tol && m.lo <= hi + 0.3 + tol) {
        lo = Math.min(lo, m.lo);
        hi = Math.max(hi, m.hi);
        used.add(m.w);
        grew = true;
      }
    }
  }
  if (used.size <= 1 && lo >= 0 && hi <= dist(wall.a, wall.b) + tol) return { wall, offset: host.u };
  const thickness = Math.max(...[...used].map((w) => w.thickness), wall.thickness);
  const merged: WallPiece = { a: add(o, scale(dir, lo)), b: add(o, scale(dir, hi)), thickness, source: wall.source };
  for (const w of used) {
    const i = walls.indexOf(w);
    if (i >= 0) walls.splice(i, 1);
  }
  walls.push(merged);
  return { wall: merged, offset: host.u - lo };
}

/** Longest side of a footprint, as the width hint when looking for the host wall. */
function footprintSpan(corners: Vec2[]): number {
  let m = 0;
  for (let i = 0; i < corners.length; i++) m = Math.max(m, dist(corners[i], corners[(i + 1) % corners.length]));
  return Math.max(0.5, m);
}

function projectCorners(host: Host, corners: Vec2[]): [number, number] {
  const us = corners.map((p) => dot(sub(p, host.wall.a), host.dir));
  return [Math.min(...us), Math.max(...us)];
}

export function placeOpenings(wallsIn: WallPiece[], doors: DoorCandidate[], windows: WindowCandidate[], opts: OpeningOptions, doorLines: WindowCandidate[] = []): OpeningResult {
  const walls = wallsIn.slice();
  const placed: { open: PlacedOpening; center: Vec2 }[] = [];
  const warnings: string[] = [];

  const commit = (host: Host, width: number, type: OpeningType, extra: Partial<PlacedOpening>) => {
    const { wall, offset } = bridge(walls, host, width, opts.tolerance);
    // Openings already placed on walls that were merged move to the merged wall.
    for (const p of placed) {
      if (!walls.includes(p.open.wall)) {
        const d = normalize(sub(wall.b, wall.a));
        p.open.wall = wall;
        p.open.offset = dot(sub(p.center, wall.a), d);
      }
    }
    const d = normalize(sub(wall.b, wall.a));
    const center = add(wall.a, scale(d, offset));
    placed.push({
      center,
      open: {
        wall,
        type,
        offset,
        width,
        height: type === 'door' ? opts.doorHeight : opts.windowHeight,
        sill: type === 'door' ? 0 : opts.windowSill,
        ...extra,
      },
    });
    return wall;
  };

  for (const dc of doors) {
    let done = false;
    if (dc.kind === 'arc' && dc.hinge && dc.radius && dc.ends) {
      let best: { host: Host; closed: Vec2; open: Vec2; score: number } | null = null;
      for (let k = 0; k < 2; k++) {
        const closed = normalize(sub(dc.ends[k], dc.hinge));
        const open = normalize(sub(dc.ends[1 - k], dc.hinge));
        const c = add(dc.hinge, scale(closed, dc.radius / 2));
        const host = findHost(walls, c, dc.radius, closed);
        if (!host) continue;
        if (Math.abs(dot(open, host.dir)) > 0.45) continue;
        // The closed leaf spans a gap: a leaf lying along solid wall is the open position, and a
        // leaf whose tip reaches the end of a wall on the same line (the far jamb) is closed.
        const l = dist(host.wall.a, host.wall.b);
        const covered = Math.max(0, Math.min(l, host.u + dc.radius / 2) - Math.max(0, host.u - dc.radius / 2)) / dc.radius;
        const tip = dc.ends[k];
        const jamb = walls.some((w) => {
          if (Math.abs(cross(normalize(sub(w.b, w.a)), host.dir)) > PAR) return false;
          return Math.min(dist(tip, w.a), dist(tip, w.b)) < w.thickness / 2 + 0.1;
        });
        const score = host.perpDist + covered * 0.5 - (jamb ? 0.3 : 0);
        if (!best || score < best.score) best = { host, closed, open, score };
      }
      if (best) {
        const width = Math.min(2.4, Math.max(0.6, dc.radius));
        const wall = commit(best.host, width, 'door', {});
        const d = normalize(sub(wall.b, wall.a));
        const last = placed[placed.length - 1].open;
        last.swing = { hinge: dot(best.closed, d) > 0 ? 'start' : 'end', side: dot(best.open, perp(d)) > 0 ? 'left' : 'right' };
        last.style = 'hinged';
        done = true;
      }
    } else if (dc.corners && dc.corners.length >= 2) {
      const c = scale(dc.corners.reduce((acc, p) => add(acc, p), { x: 0, y: 0 }), 1 / dc.corners.length);
      const host = findHost(walls, c, footprintSpan(dc.corners), null);
      if (host) {
        const [u0, u1] = projectCorners(host, dc.corners);
        const width = Math.min(2.4, Math.max(0.6, u1 - u0));
        const h2: Host = { ...host, u: (u0 + u1) / 2 };
        commit(h2, width, 'door', { style: width > 1.6 ? 'sliding-glass' : 'hinged', swing: width > 1.6 ? undefined : { hinge: 'start', side: 'left' } });
        done = true;
      }
    }
    if (!done) warnings.push(`A door (${dc.label}) is not on a wall and was left out.`);
  }

  for (const wc of windows) {
    const c = scale(wc.corners.reduce((acc, p) => add(acc, p), { x: 0, y: 0 }), 1 / wc.corners.length);
    const host = findHost(walls, c, footprintSpan(wc.corners), null);
    if (!host) {
      warnings.push(`A window (${wc.label}) near ${fmt(c)} is not on a wall and was left out.`);
      continue;
    }
    const [u0, u1] = projectCorners(host, wc.corners);
    const width = Math.min(6, Math.max(0.3, u1 - u0));
    commit({ ...host, u: (u0 + u1) / 2 }, width, 'window', {});
  }

  // Glazing drawn as lines on a door layer across a wall gap: glass doors.
  for (const gd of doorLines) {
    const c = scale(gd.corners.reduce((acc, p) => add(acc, p), { x: 0, y: 0 }), 1 / gd.corners.length);
    const host = findHost(walls, c, footprintSpan(gd.corners), null);
    if (!host) {
      warnings.push(`Door lines near ${fmt(c)} are not on a wall and were left out.`);
      continue;
    }
    const [u0, u1] = projectCorners(host, gd.corners);
    const width = Math.min(6, Math.max(0.6, u1 - u0));
    commit({ ...host, u: (u0 + u1) / 2 }, width, 'door', width >= 1.2 ? { style: 'sliding-glass' } : { style: 'hinged', swing: { hinge: 'start', side: 'left' } });
  }

  // Remaining gaps between collinear pieces: in an outside wall they are glazed; inside the plan,
  // door-sized ones become open doorways and wider ones are left open from floor to ceiling.
  const boundaries: { a: Vec2; b: Vec2 }[] = [];
  const maxOpen = opts.maxOpen ?? opts.maxPassage;
  for (let guard = 0; guard < 200; guard++) {
    const gap = findGap(walls, opts, Math.max(2.6, maxOpen));
    if (!gap) break;
    const outside = maxOpen > opts.maxPassage && gapIsOutside(walls, gap);
    if (outside && gap.width <= maxOpen) {
      commit(gap.host, gap.width, 'window', { sill: 0, fullHeight: true });
      warnings.push(`A ${gap.width.toFixed(2)} m gap in an outside wall near ${fmt(gap.center)} has no door or window; it was glazed.`);
    } else if (gap.width <= opts.maxPassage) {
      commit(gap.host, gap.width, 'door', { style: 'passage' });
      warnings.push(`A ${gap.width.toFixed(2)} m gap in a wall near ${fmt(gap.center)} has no door or window; it was treated as an open doorway.`);
    } else if (gap.width <= maxOpen) {
      boundaries.push({ a: gap.ends[0], b: gap.ends[1] });
      warnings.push(`A ${gap.width.toFixed(2)} m gap in a wall near ${fmt(gap.center)} was left open as part of an open plan.`);
      gap.skip.add(gap.key);
    } else {
      warnings.push(`A ${gap.width.toFixed(2)} m gap in a wall near ${fmt(gap.center)} was left open.`);
      gap.skip.add(gap.key);
    }
  }
  return { walls, openings: placed.map((p) => p.open), warnings, boundaries };
}

/** A gap is in an outside wall when, on one side, rays fanning out from it reach no other wall. */
function gapIsOutside(walls: WallPiece[], gap: { center: Vec2; host: Host; width: number; pieces: [WallPiece, WallPiece] }): boolean {
  const n = gap.host.nrm;
  const t = Math.max(gap.pieces[0].thickness, gap.pieces[1].thickness);
  for (const side of [1, -1]) {
    const origin = add(gap.center, scale(n, side * (t / 2 + 0.05)));
    const free = [-25, 0, 25].every((deg) => {
      const a = (deg * Math.PI) / 180;
      const r0 = scale(n, side);
      const r = { x: r0.x * Math.cos(a) - r0.y * Math.sin(a), y: r0.x * Math.sin(a) + r0.y * Math.cos(a) };
      return !walls.some((w) => {
        if (w === gap.pieces[0] || w === gap.pieces[1]) return false;
        const s = sub(w.b, w.a);
        const den = cross(r, s);
        if (Math.abs(den) < 1e-12) return false;
        const qp = sub(w.a, origin);
        const tt = cross(qp, s) / den;
        const u = cross(qp, r) / den;
        return tt > 0 && u >= -0.01 && u <= 1.01;
      });
    });
    if (free) return true;
  }
  return false;
}

const skipped = new Set<string>();

function findGap(
  walls: WallPiece[],
  opts: OpeningOptions,
  maxWidth: number,
): { host: Host; width: number; center: Vec2; key: string; skip: Set<string>; pieces: [WallPiece, WallPiece]; ends: [Vec2, Vec2] } | null {
  for (let i = 0; i < walls.length; i++) {
    const A = walls[i];
    const dA = normalize(sub(A.b, A.a));
    const nA = perp(dA);
    for (let j = 0; j < walls.length; j++) {
      if (i === j) continue;
      const B = walls[j];
      const dB = normalize(sub(B.b, B.a));
      if (Math.abs(cross(dA, dB)) > PAR) continue;
      if (Math.abs(dot(sub(B.a, A.a), nA)) > Math.max(A.thickness, B.thickness) / 2) continue;
      const aHi = Math.max(dot(sub(A.a, A.a), dA), dot(sub(A.b, A.a), dA));
      const bLo = Math.min(dot(sub(B.a, A.a), dA), dot(sub(B.b, A.a), dA));
      const g = bLo - aHi;
      if (g <= opts.minGap || g > maxWidth) continue;
      const center = add(A.a, scale(dA, aHi + g / 2));
      const key = `${center.x.toFixed(2)},${center.y.toFixed(2)}`;
      if (skipped.has(key)) continue;
      // Something else crossing the gap (a perpendicular wall) or filling it (a column on the same
      // line) means it is a junction, not a gap.
      const filled = (w: WallPiece) => {
        if (Math.abs(cross(normalize(sub(w.b, w.a)), dA)) > PAR) return false;
        if (Math.abs(dot(sub(w.a, A.a), nA)) > (w.thickness + A.thickness) / 2) return false;
        const u0 = Math.min(dot(sub(w.a, A.a), dA), dot(sub(w.b, A.a), dA));
        const u1 = Math.max(dot(sub(w.a, A.a), dA), dot(sub(w.b, A.a), dA));
        return u0 <= aHi + 0.05 && u1 >= bLo - 0.05;
      };
      const crossing = walls.some((w) => w !== A && w !== B && (segCross(w, center, dA, g) || filled(w)));
      if (crossing) {
        skipped.add(key);
        continue;
      }
      const aEnd = dot(sub(A.b, A.a), dA) > dot(sub(A.a, A.a), dA) ? A.b : A.a;
      const bEnd = dot(sub(B.a, A.a), dA) < dot(sub(B.b, A.a), dA) ? B.a : B.b;
      return { host: { wall: A, dir: dA, nrm: nA, u: aHi + g / 2, perpDist: 0 }, width: g, center, key, skip: skipped, pieces: [A, B], ends: [aEnd, bEnd] };
    }
  }
  return null;
}

function segCross(w: WallPiece, c: Vec2, d: Vec2, g: number): boolean {
  const wd = normalize(sub(w.b, w.a));
  if (Math.abs(cross(wd, d)) < 0.5) return false;
  const a = add(c, scale(d, -g / 2));
  const b = add(c, scale(d, g / 2));
  const s1 = cross(sub(w.b, w.a), sub(a, w.a));
  const s2 = cross(sub(w.b, w.a), sub(b, w.a));
  const s3 = cross(sub(b, a), sub(w.a, a));
  const s4 = cross(sub(b, a), sub(w.b, a));
  return s1 * s2 <= 0 && s3 * s4 <= 0;
}

/** Clears state kept between gap searches (one import at a time). */
export function resetOpeningState(): void {
  skipped.clear();
}
