import type { Floor, FloorPlan, Opening, Vec2 } from '../data/schema';
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

/** Point sets that count as indoor space on a floor, for classifying wall faces. */
function indoorTester(plan: FloorPlan, floor: Floor): (p: Vec2) => boolean {
  const rooms = floor.rooms.filter((r) => !r.outdoor).map((r) => r.polygon);
  const stairs = plan.stairs.filter((s) => s.fromFloorId === floor.id || s.toFloorId === floor.id).map((s) => s.outline);
  return (p) => rooms.some((poly) => pointInPolygon(p, poly)) || stairs.some((poly) => pointInPolygon(p, poly));
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

  const indoor = indoorTester(plan, floor);
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
      openings: [],
    };
    // Classify each face by sampling just beyond it.
    const off = s.thickness / 2 + 0.12;
    let leftIn = 0;
    let rightIn = 0;
    const samples = Math.max(3, Math.min(9, Math.round(length / 0.8)));
    for (let k = 0; k < samples; k++) {
      const p = lerp2(s.a, s.b, (k + 0.5) / samples);
      if (indoor(add(p, scale(nrm, off)))) leftIn++;
      if (indoor(add(p, scale(nrm, -off)))) rightIn++;
    }
    seg.leftExterior = leftIn * 2 < samples;
    seg.rightExterior = rightIn * 2 < samples;
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
