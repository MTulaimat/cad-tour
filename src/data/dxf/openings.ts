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
}

export interface OpeningResult {
  walls: WallPiece[];
  openings: PlacedOpening[];
  warnings: string[];
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

export function placeOpenings(wallsIn: WallPiece[], doors: DoorCandidate[], windows: WindowCandidate[], opts: OpeningOptions): OpeningResult {
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
        if (!best || host.perpDist < best.score) best = { host, closed, open, score: host.perpDist };
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

  // Remaining gaps between collinear pieces: door-sized ones become open passages.
  for (let guard = 0; guard < 200; guard++) {
    const gap = findGap(walls, opts);
    if (!gap) break;
    if (gap.width <= opts.maxPassage) {
      commit(gap.host, gap.width, 'door', { style: 'passage' });
      warnings.push(`A ${gap.width.toFixed(2)} m gap in a wall near ${fmt(gap.center)} has no door or window; it was treated as an open doorway.`);
    } else {
      warnings.push(`A ${gap.width.toFixed(2)} m gap in a wall near ${fmt(gap.center)} was left open.`);
      gap.skip.add(gap.key);
    }
  }
  return { walls, openings: placed.map((p) => p.open), warnings };
}

const skipped = new Set<string>();

function findGap(walls: WallPiece[], opts: OpeningOptions): { host: Host; width: number; center: Vec2; key: string; skip: Set<string> } | null {
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
      if (g <= opts.minGap || g > 2.6) continue;
      const center = add(A.a, scale(dA, aHi + g / 2));
      const key = `${center.x.toFixed(2)},${center.y.toFixed(2)}`;
      if (skipped.has(key)) continue;
      // Something else (a perpendicular wall) crossing the gap means it is a junction, not a gap.
      const crossing = walls.some((w) => w !== A && w !== B && segCross(w, center, dA, g));
      if (crossing) {
        skipped.add(key);
        continue;
      }
      return { host: { wall: A, dir: dA, nrm: nA, u: aHi + g / 2, perpDist: 0 }, width: g, center, key, skip: skipped };
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
