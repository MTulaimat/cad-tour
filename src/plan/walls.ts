import type { Floor, FloorPlan, Opening, Room, Vec2 } from '../data/schema';
import { floorAbove, risingRooms } from './levels';
import {
  add,
  angleOf,
  closestT,
  cross,
  dist,
  dot,
  lerp2,
  lineIntersection,
  normalize,
  perp,
  pointInPolygon,
  scale,
  sub,
} from '../util/math2d';

/**
 * Wall analysis shared by geometry, collision and the minimap.
 *
 * Every wall centerline is cut into straight segments, split again where another wall ends on it
 * (T junctions), and joined at nodes so the thickened outlines meet cleanly (mitered L corners,
 * T and X junctions, square free ends).
 */

export interface SegmentOpening {
  opening: Opening;
  /** Local coordinates along the segment, from its start point. */
  u0: number;
  u1: number;
}

export interface WallSegment {
  key: string;
  wallId: string;
  a: Vec2;
  b: Vec2;
  /** Unit direction a to b. */
  dir: Vec2;
  /** Left unit normal. */
  nrm: Vec2;
  length: number;
  /** Arc length along the wall's centerline at `a`. */
  arcStart: number;
  thickness: number;
  height: number;
  startLeft: Vec2;
  startRight: Vec2;
  endLeft: Vec2;
  endRight: Vec2;
  startJoined: boolean;
  endJoined: boolean;
  leftExterior: boolean;
  rightExterior: boolean;
  /**
   * The face looks into a space that rises from a floor below (a double-height room beside a
   * mezzanine): it carries on down over the slab edge.
   */
  leftDown: boolean;
  rightDown: boolean;
  /**
   * World height of the wall top along the segment, as intervals of u. A wall stops under the
   * floor above where that floor's slab or walls sit on it, and under a stair landing.
   */
  tops: { u0: number; u1: number; y: number }[];
  /** The room on each side (this floor's, or a room rising from below), for trims and finishes. */
  leftRoom: Room | null;
  rightRoom: Room | null;
  /** The room on each side is a glass enclosure and the other side is outside: built as glazing. */
  glazed: boolean;
  openings: SegmentOpening[];
}

const NODE_TOL = 0.015;

interface RawSeg {
  wallId: string;
  a: Vec2;
  b: Vec2;
  arcStart: number;
  thickness: number;
  height: number;
}

function rawSegments(floor: Floor): RawSeg[] {
  const out: RawSeg[] = [];
  for (const w of floor.walls) {
    let arc = 0;
    for (let i = 1; i < w.centerline.length; i++) {
      const a = w.centerline[i - 1];
      const b = w.centerline[i];
      const l = dist(a, b);
      if (l > 1e-4) out.push({ wallId: w.id, a, b, arcStart: arc, thickness: w.thickness, height: w.height });
      arc += l;
    }
  }
  return out;
}

/** Split segments where another segment's endpoint lies on their interior. */
function splitAtTJunctions(segs: RawSeg[]): RawSeg[] {
  const cuts: number[][] = segs.map(() => []);
  segs.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      segs.forEach((o, j) => {
        if (i === j) return;
        const t = closestT(p, o.a, o.b);
        const l = dist(o.a, o.b);
        if (t * l < NODE_TOL || (1 - t) * l < NODE_TOL) return;
        if (dist(p, lerp2(o.a, o.b, t)) < NODE_TOL) cuts[j].push(t);
      });
    }
  });
  const out: RawSeg[] = [];
  segs.forEach((s, i) => {
    const ts = [...new Set(cuts[i].map((t) => Math.round(t * 1e6) / 1e6))].sort((x, y) => x - y);
    if (ts.length === 0) return out.push(s);
    const l = dist(s.a, s.b);
    let prevT = 0;
    let prevP = s.a;
    for (const t of [...ts, 1]) {
      const p = t === 1 ? s.b : lerp2(s.a, s.b, t);
      if ((t - prevT) * l > 1e-4) out.push({ ...s, a: prevP, b: p, arcStart: s.arcStart + prevT * l });
      prevT = t;
      prevP = p;
    }
  });
  return out;
}

interface EndRef {
  seg: number;
  atStart: boolean;
  /** Direction pointing away from the node along the segment. */
  d: Vec2;
  angle: number;
  half: number;
}

function joinCorners(node: Vec2, ends: EndRef[]): Map<EndRef, { left: Vec2; right: Vec2 }> {
  const res = new Map<EndRef, { left: Vec2; right: Vec2 }>();
  if (ends.length === 1) {
    const e = ends[0];
    res.set(e, { left: add(node, scale(perp(e.d), e.half)), right: add(node, scale(perp(e.d), -e.half)) });
    return res;
  }
  const sorted = ends.slice().sort((x, y) => x.angle - y.angle);
  const lefts = new Map<EndRef, Vec2>();
  const rights = new Map<EndRef, Vec2>();
  for (let i = 0; i < sorted.length; i++) {
    const ei = sorted[i];
    const ej = sorted[(i + 1) % sorted.length];
    let wedge = ej.angle - ei.angle;
    if (wedge <= 0) wedge += Math.PI * 2;
    const li = add(node, scale(perp(ei.d), ei.half));
    const rj = add(node, scale(perp(ej.d), -ej.half));
    let corner: Vec2 | null = null;
    // Nearly straight continuation, or a sliver wedge: no miter.
    if (Math.abs(wedge - Math.PI) > 0.02 && wedge > 0.15 && wedge < Math.PI * 2 - 0.15) {
      corner = lineIntersection(li, ei.d, rj, ej.d);
      if (corner && dist(corner, node) > 4 * Math.max(ei.half, ej.half)) corner = null;
    }
    if (corner) {
      lefts.set(ei, corner);
      rights.set(ej, corner);
    } else {
      lefts.set(ei, li);
      rights.set(ej, rj);
    }
  }
  for (const e of ends) res.set(e, { left: lefts.get(e)!, right: rights.get(e)! });
  return res;
}

/**
 * What is beside a wall face on a floor: one of its indoor rooms, a stair, or a room of a lower
 * floor that rises past this floor's level (open space over a double-height room).
 */
function spaceTester(plan: FloorPlan, floor: Floor) {
  const rooms = floor.rooms.filter((r) => !r.outdoor);
  const stairs = plan.stairs.filter((s) => s.fromFloorId === floor.id || s.toFloorId === floor.id).map((s) => s.outline);
  const rising = risingRooms(plan, floor).map((x) => x.room);
  return {
    room: (p: Vec2) => rooms.find((r) => pointInPolygon(p, r.polygon)) ?? null,
    stair: (p: Vec2) => stairs.some((poly) => pointInPolygon(p, poly)),
    rising: (p: Vec2) => rising.find((r) => pointInPolygon(p, r.polygon)) ?? null,
  };
}

/** Runs of u in [u0, u1] where `keep` holds, sampled every 5 cm. */
function runsWhere(u0: number, u1: number, keep: (u: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  const n = Math.max(1, Math.ceil((u1 - u0) / 0.05));
  let start: number | null = null;
  for (let i = 0; i <= n; i++) {
    const a = u0 + ((u1 - u0) * i) / n;
    const ok = i < n && keep(a + (u1 - u0) / n / 2);
    if (ok && start === null) start = a;
    if (!ok && start !== null) {
      out.push([start, a]);
      start = null;
    }
  }
  return out;
}

const LANDING_T = 0.2;
const STRINGER = 0.35;

/**
 * Where a wall stops below its own height: under the floor above (its walls standing on this one,
 * or its slab over it) and under a stair landing or flight passing over it. Intervals of u, each
 * with its top height; the rest of the wall reaches `base`.
 */
function wallTops(plan: FloorPlan, floor: Floor, a: Vec2, dir: Vec2, nrm: Vec2, thickness: number, uMin: number, uMax: number, base: number): { u0: number; u1: number; y: number }[] {
  const caps: { u0: number; u1: number; y: number }[] = [];
  const at = (u: number) => add(a, scale(dir, u));
  const up = floorAbove(plan, floor);
  if (up) {
    const capY = up.elevation - up.slabThickness;
    if (capY < base - 0.005) {
      for (const w of up.walls) {
        for (let i = 1; i < w.centerline.length; i++) {
          const p = w.centerline[i - 1];
          const q = w.centerline[i];
          if (Math.abs(cross(normalize(sub(q, p)), dir)) > 0.02) continue;
          if (Math.abs(dot(sub(p, a), nrm)) > (thickness + w.thickness) / 2 - 0.02) continue;
          const u0 = Math.max(uMin, Math.min(dot(sub(p, a), dir), dot(sub(q, a), dir)) - w.thickness / 2);
          const u1 = Math.min(uMax, Math.max(dot(sub(p, a), dir), dot(sub(q, a), dir)) + w.thickness / 2);
          if (u1 - u0 > 0.01) caps.push({ u0, u1, y: capY });
        }
      }
      const upRooms = up.rooms.filter((r) => !r.outdoor);
      for (const [u0, u1] of runsWhere(uMin, uMax, (u) => upRooms.some((r) => pointInPolygon(at(u), r.polygon)))) caps.push({ u0, u1, y: capY });
    }
  }
  for (const st of plan.stairs) {
    if (st.fromFloorId !== floor.id) continue;
    const total = st.flights.reduce((n, f) => n + f.risers * f.riserHeight, 0);
    for (const l of st.landings) {
      if (l.elevation >= total - 0.01) continue;
      const y = floor.elevation + l.elevation - LANDING_T;
      for (const [u0, u1] of runsWhere(uMin, uMax, (u) => pointInPolygon(at(u), l.polygon))) caps.push({ u0, u1, y });
    }
    for (const f of st.flights) {
      const d = normalize(f.direction);
      const run = (f.risers - 1) * f.going;
      const under = (u: number) => {
        const rel = sub(at(u), f.start);
        const s = dot(rel, d);
        if (Math.abs(dot(rel, perp(d))) > f.width / 2 || s < 0 || s > run) return null;
        return floor.elevation + f.baseElevation + f.riserHeight * (s / f.going + 1) - STRINGER;
      };
      const n = Math.max(1, Math.ceil((uMax - uMin) / 0.05));
      for (let i = 0; i < n; i++) {
        const u0 = uMin + ((uMax - uMin) * i) / n;
        const u1 = uMin + ((uMax - uMin) * (i + 1)) / n;
        const y = under((u0 + u1) / 2);
        if (y !== null) caps.push({ u0, u1, y: Math.max(floor.elevation + 0.3, y) });
      }
    }
  }
  if (caps.length === 0) return [{ u0: uMin, u1: uMax, y: base }];
  const cuts = [...new Set([uMin, uMax, ...caps.flatMap((c) => [c.u0, c.u1]).filter((u) => u > uMin && u < uMax)].map((u) => Math.round(u * 1e5) / 1e5))].sort((x, y) => x - y);
  const out: { u0: number; u1: number; y: number }[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const mid = (cuts[i - 1] + cuts[i]) / 2;
    const y = caps.filter((c) => c.u0 <= mid && c.u1 >= mid).reduce((m, c) => Math.min(m, c.y), base);
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - y) < 1e-4) last.u1 = cuts[i];
    else out.push({ u0: cuts[i - 1], u1: cuts[i], y });
  }
  return out;
}

/** Top of the wall at u (the interval containing it). */
export function topAt(s: WallSegment, u: number): number {
  for (const t of s.tops) if (u >= t.u0 - 1e-6 && u <= t.u1 + 1e-6) return t.y;
  return s.tops.length ? s.tops[u < s.tops[0].u0 ? 0 : s.tops.length - 1].y : s.height;
}

const cache = new WeakMap<Floor, WallSegment[]>();

export function wallSegments(plan: FloorPlan, floor: Floor): WallSegment[] {
  const hit = cache.get(floor);
  if (hit) return hit;

  const raw = splitAtTJunctions(rawSegments(floor));

  // Cluster endpoints into nodes.
  const nodes: { p: Vec2; ends: EndRef[] }[] = [];
  const nodeOf = (p: Vec2) => {
    for (const n of nodes) if (dist(n.p, p) < NODE_TOL) return n;
    const n = { p, ends: [] as EndRef[] };
    nodes.push(n);
    return n;
  };
  const startNode: { p: Vec2; ends: EndRef[] }[] = [];
  const endNode: { p: Vec2; ends: EndRef[] }[] = [];
  raw.forEach((s, i) => {
    const d = normalize(sub(s.b, s.a));
    const ns = nodeOf(s.a);
    const ne = nodeOf(s.b);
    ns.ends.push({ seg: i, atStart: true, d, angle: angleOf(d), half: s.thickness / 2 });
    const back = scale(d, -1);
    ne.ends.push({ seg: i, atStart: false, d: back, angle: angleOf(back), half: s.thickness / 2 });
    startNode[i] = ns;
    endNode[i] = ne;
  });

  const corners = new Map<string, { left: Vec2; right: Vec2; joined: boolean }>();
  for (const n of nodes) {
    const res = joinCorners(n.p, n.ends);
    for (const [e, c] of res) corners.set(`${e.seg}:${e.atStart ? 's' : 'e'}`, { ...c, joined: n.ends.length > 1 });
  }

  const space = spaceTester(plan, floor);
  const openingsByWall = new Map<string, Opening[]>();
  for (const o of floor.openings) {
    const list = openingsByWall.get(o.wallId) ?? [];
    list.push(o);
    openingsByWall.set(o.wallId, list);
  }

  const segs: WallSegment[] = raw.map((s, i) => {
    const dir = normalize(sub(s.b, s.a));
    const nrm = perp(dir);
    const length = dist(s.a, s.b);
    const cs = corners.get(`${i}:s`)!;
    const ce = corners.get(`${i}:e`)!;
    // At the end node the away-direction is reversed, so its left is the segment's right.
    const seg: WallSegment = {
      key: `${s.wallId}#${i}`,
      wallId: s.wallId,
      a: s.a,
      b: s.b,
      dir,
      nrm,
      length,
      arcStart: s.arcStart,
      thickness: s.thickness,
      height: s.height,
      startLeft: cs.left,
      startRight: cs.right,
      endLeft: ce.right,
      endRight: ce.left,
      startJoined: cs.joined,
      endJoined: ce.joined,
      leftExterior: false,
      rightExterior: false,
      leftDown: false,
      rightDown: false,
      tops: [],
      leftRoom: null,
      rightRoom: null,
      glazed: false,
      openings: [],
    };
    // Classify each face by sampling just beyond it.
    const off = s.thickness / 2 + 0.12;
    const samples = Math.max(3, Math.min(9, Math.round(length / 0.8)));
    const side = (sign: number) => {
      let indoor = 0;
      let below = 0;
      const seen = new Map<Room, number>();
      for (let k = 0; k < samples; k++) {
        const p = add(lerp2(s.a, s.b, (k + 0.5) / samples), scale(nrm, sign * off));
        const room = space.room(p);
        const rising = room ? null : space.rising(p);
        if (room || rising || space.stair(p)) indoor++;
        if (rising) below++;
        const r = room ?? rising;
        if (r) seen.set(r, (seen.get(r) ?? 0) + 1);
      }
      const room = [...seen.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
      return { exterior: indoor * 2 < samples, down: below * 2 >= samples, room };
    };
    const L = side(1);
    const R = side(-1);
    seg.leftExterior = L.exterior;
    seg.rightExterior = R.exterior;
    seg.leftDown = !L.exterior && L.down;
    seg.rightDown = !R.exterior && R.down;
    seg.leftRoom = L.room;
    seg.rightRoom = R.room;
    seg.glazed = (L.exterior && !!R.room?.glazed && floor.rooms.includes(R.room)) || (R.exterior && !!L.room?.glazed && floor.rooms.includes(L.room));
    const ends = [segmentU(seg, seg.startLeft), segmentU(seg, seg.startRight), segmentU(seg, seg.endLeft), segmentU(seg, seg.endRight)];
    seg.tops = wallTops(plan, floor, s.a, dir, nrm, s.thickness, Math.min(0, ...ends), Math.max(length, ...ends), floor.elevation + s.height);
    // Openings that fall on this piece of the wall.
    for (const o of openingsByWall.get(s.wallId) ?? []) {
      const c = o.offset - s.arcStart;
      if (c < -1e-6 || c > length + 1e-6) continue;
      seg.openings.push({ opening: o, u0: Math.max(0, c - o.width / 2), u1: Math.min(length, c + o.width / 2) });
    }
    seg.openings.sort((x, y) => x.u0 - y.u0);
    return seg;
  });

  cache.set(floor, segs);
  return segs;
}

/** Local u of a plan point projected onto a segment. */
export const segmentU = (s: WallSegment, p: Vec2): number => dot(sub(p, s.a), s.dir);

/** Plan point on a segment at local u, offset sideways by `side` (positive is left). */
export const segmentPoint = (s: WallSegment, u: number, side = 0): Vec2 => add(add(s.a, scale(s.dir, u)), scale(s.nrm, side));

/** Side face extents along u for the left and right faces (they differ at miters). */
export function faceRange(s: WallSegment, left: boolean): [number, number] {
  return left ? [segmentU(s, s.startLeft), segmentU(s, s.endLeft)] : [segmentU(s, s.startRight), segmentU(s, s.endRight)];
}

/**
 * Closed loops formed by exterior wall faces, largest first: the building outline used for
 * the facade below the apartment and for shadow fitting.
 */
export function exteriorOutline(plan: FloorPlan, floor: Floor): Vec2[] | null {
  const edges: [Vec2, Vec2][] = [];
  for (const s of wallSegments(plan, floor)) {
    if (s.rightExterior) edges.push([s.startRight, s.endRight]);
    if (s.leftExterior) edges.push([s.endLeft, s.startLeft]);
  }
  if (edges.length < 3) return null;
  const used = new Array(edges.length).fill(false);
  const loops: Vec2[][] = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    const loop: Vec2[] = [edges[i][0]];
    let cur = edges[i][1];
    used[i] = true;
    for (let guard = 0; guard < edges.length; guard++) {
      if (dist(cur, loop[0]) < 0.02) break;
      let next = -1;
      let bestD = 0.05;
      for (let j = 0; j < edges.length; j++) {
        if (used[j]) continue;
        const d = dist(edges[j][0], cur);
        if (d < bestD) {
          bestD = d;
          next = j;
        }
      }
      if (next < 0) break;
      loop.push(cur);
      used[next] = true;
      cur = edges[next][1];
    }
    if (loop.length >= 3 && dist(cur, loop[0]) < 0.05) loops.push(loop);
  }
  if (loops.length === 0) return null;
  const area = (poly: Vec2[]) => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) a += cross(poly[i], poly[(i + 1) % poly.length]);
    return Math.abs(a / 2);
  };
  loops.sort((x, y) => area(y) - area(x));
  return loops[0];
}
