import type { Floor, FloorPlan, Room, Vec2 } from '../data/schema';
import {
  add,
  angleOf,
  cross,
  distanceToPolygonEdges,
  dot,
  interiorPoint,
  normalize,
  orientedRect,
  pointInPolygon,
  pointSegmentDistance,
  polygonArea,
  polygonCentroid,
  scale,
  sub,
  wrapAngle,
} from '../util/math2d';
import { wallSegments, segmentPoint, type WallSegment } from './walls';
import { stairInfos } from './stairs';

export interface Spawn {
  floorIndex: number;
  position: Vec2;
  /** Yaw: 0 looks north (plan +y), counterclockwise. */
  yaw: number;
}

/** Yaw that looks along a plan direction. */
export const yawFor = (d: Vec2): number => angleOf(d) - Math.PI / 2;

function lowestFloorIndex(plan: FloorPlan): number {
  return plan.floors.reduce((best, f, i) => (f.elevation < plan.floors[best].elevation ? i : best), 0);
}

function floorCentroid(floor: Floor): Vec2 {
  let ax = 0;
  let ay = 0;
  let a = 0;
  for (const r of floor.rooms) {
    if (r.outdoor) continue;
    const area = polygonArea(r.polygon);
    const c = polygonCentroid(r.polygon);
    ax += c.x * area;
    ay += c.y * area;
    a += area;
  }
  return a > 0 ? { x: ax / a, y: ay / a } : { x: 0, y: 0 };
}

/** The direction into the plan: towards the floor's centroid if it is ahead, else along `inward`. */
function intoPlan(floor: Floor, p: Vec2, inward: Vec2): Vec2 {
  const c = floorCentroid(floor);
  const toC = normalize(sub(c, p));
  return dot(toC, inward) > 0.2 ? normalize(add(scale(inward, 0.25), scale(toC, 0.75))) : inward;
}

const VIEW_MAX = 6;

/** Free distance from `p` along `d` to the nearest wall face. Open passages let the ray through. */
function clearance(segs: WallSegment[], p: Vec2, d: Vec2): number {
  let best = VIEW_MAX;
  for (const s of segs) {
    const e = sub(s.b, s.a);
    const den = cross(d, e);
    if (Math.abs(den) < 1e-9) continue;
    const ap = sub(s.a, p);
    const t = cross(ap, e) / den;
    const u = cross(ap, d) / den;
    if (t <= 0 || u < 0 || u > 1) continue;
    const along = u * s.length;
    if (s.openings.some((o) => o.opening.style === 'passage' && along > o.u0 && along < o.u1)) continue;
    const face = t - s.thickness / 2 / Math.max(0.2, Math.abs(dot(d, s.nrm)));
    best = Math.min(best, Math.max(0, face));
  }
  return best;
}

/**
 * How good the first view from `p` along `yaw` is: the depth straight ahead, marked down when a
 * wall comes closer than 1.5 m anywhere across the frame (about 70 degrees wide).
 */
function viewScore(segs: WallSegment[], p: Vec2, yaw: number): number {
  const ray = (deg: number) => {
    const a = yaw + (deg * Math.PI) / 180;
    return clearance(segs, p, { x: -Math.sin(a), y: Math.cos(a) });
  };
  const ahead = (ray(-5) + ray(0) + ray(5)) / 3;
  let near = Infinity;
  for (let deg = -35; deg <= 35; deg += 7) near = Math.min(near, ray(deg));
  return ahead * (0.5 + 0.5 * Math.min(1, near / 1.5));
}

/**
 * Faces into the plan along the longest clear sight line within 100 degrees of `inward`,
 * favouring the direction of the floor's centroid, so the first view is never a wall up close.
 */
function bestView(floor: Floor, segs: WallSegment[], p: Vec2, inward: Vec2): { yaw: number; score: number } {
  const base = yawFor(inward);
  const preferred = yawFor(intoPlan(floor, p, inward));
  let best = { yaw: preferred, score: -1 };
  for (let deg = -100; deg <= 100; deg += 5) {
    const yaw = base + (deg * Math.PI) / 180;
    const dev = Math.abs(wrapAngle(yaw - preferred)) / (Math.PI / 2);
    const score = viewScore(segs, p, yaw) * (1 - 0.3 * Math.min(1, dev) ** 2);
    if (score > best.score + 1e-6) best = { yaw, score };
  }
  return best;
}

/** True when a player can stand at `p`: inside an indoor room, clear of walls and furniture. */
function standable(floor: Floor, segs: WallSegment[], p: Vec2): boolean {
  if (!floor.rooms.some((r) => !r.outdoor && pointInPolygon(p, r.polygon))) return false;
  if (segs.some((s) => pointSegmentDistance(p, s.a, s.b) - s.thickness / 2 < 0.35)) return false;
  return !floor.furniture.some((f) => {
    const sx = f.size?.x ?? 0.6;
    const sy = f.size?.y ?? 0.6;
    return distanceToRect(p, orientedRect(f.position, sx, sy, f.rotation)) < 0.3;
  });
}

function distanceToRect(p: Vec2, rect: Vec2[]): number {
  return pointInPolygon(p, rect) ? 0 : distanceToPolygonEdges(p, rect);
}

export interface Entrance {
  openingId: string;
  segment: WallSegment;
  /** Distance along the segment to the door's center. */
  u: number;
  /** Unit normal pointing into the plan. */
  inward: Vec2;
}

/**
 * Doors on a floor's outer boundary that lead out of the plan: indoor space on one side and
 * nothing (not a balcony) on the other. The building's corridor is not modelled, so these stay
 * shut during the tour.
 */
export function entrances(plan: FloorPlan, floor: Floor, segs: WallSegment[] = wallSegments(plan, floor)): Entrance[] {
  const indoor = floor.rooms.filter((r) => !r.outdoor);
  const outdoor = floor.rooms.filter((r) => r.outdoor);
  const inRoom = (p: Vec2, rooms: Room[]) => rooms.some((r) => pointInPolygon(p, r.polygon));
  const out: Entrance[] = [];
  for (const s of segs) {
    if (!(s.leftExterior || s.rightExterior)) continue;
    for (const o of s.openings) {
      if (o.opening.type !== 'door') continue;
      const u = (o.u0 + o.u1) / 2;
      const probe = s.thickness / 2 + 0.6;
      const leftIn = inRoom(segmentPoint(s, u, probe), indoor);
      const rightIn = inRoom(segmentPoint(s, u, -probe), indoor);
      if (leftIn === rightIn) continue;
      if (inRoom(segmentPoint(s, u, leftIn ? -probe : probe), outdoor)) continue;
      out.push({ openingId: o.opening.id, segment: s, u, inward: leftIn ? s.nrm : scale(s.nrm, -1) });
    }
  }
  return out;
}

/**
 * P5: start just inside the entrance door (see `entrances`) of the lowest floor, facing into the
 * plan. Without one, start at the centroid of the largest room on the lowest floor.
 */
export function startSpawn(plan: FloorPlan): Spawn {
  const fi = lowestFloorIndex(plan);
  const floor = plan.floors[fi];
  const indoor = floor.rooms.filter((r) => !r.outdoor);
  const segs = wallSegments(plan, floor);
  const entrance = entrances(plan, floor, segs)[0];
  if (entrance) {
    const { segment: s, u, inward } = entrance;
    // Just inside the door; a step further in when that opens up a better first view.
    let pick: { position: Vec2; yaw: number; score: number } | null = null;
    for (const depth of [0.75, 1.1, 1.5]) {
      const position = add(segmentPoint(s, u, 0), scale(inward, s.thickness / 2 + depth));
      if (depth > 0.75 && !standable(floor, segs, position)) continue;
      const view = bestView(floor, segs, position, inward);
      if (!pick || view.score > pick.score * 1.05) pick = { position, ...view };
    }
    return { floorIndex: fi, position: pick!.position, yaw: pick!.yaw };
  }
  const largest = indoor.slice().sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0] ?? floor.rooms[0];
  const position = largest ? interiorPoint(largest.polygon) : { x: 0, y: 0 };
  return { floorIndex: fi, position, yaw: 0 };
}

/**
 * Q7: where the floor switch teleports to: the stair landing on that floor (top of the flight
 * arriving there, or the foot of the flight leaving it), facing into the plan.
 */
export function floorSpawn(plan: FloorPlan, floorIndex: number): Spawn {
  const floor = plan.floors[floorIndex];
  const segs = wallSegments(plan, floor);
  for (const s of stairInfos(plan)) {
    if (s.to.id === floor.id) {
      const p = add(s.arrival.point, scale(s.arrival.dir, 0.55));
      return { floorIndex, position: p, yaw: bestView(floor, segs, p, s.arrival.dir).yaw };
    }
  }
  for (const s of stairInfos(plan)) {
    if (s.from.id === floor.id) {
      const back = scale(s.departure.dir, -1);
      const p = add(s.departure.point, scale(back, 0.75));
      return { floorIndex, position: p, yaw: bestView(floor, segs, p, back).yaw };
    }
  }
  const sp = startSpawn(plan);
  if (sp.floorIndex === floorIndex) return sp;
  const largest = floor.rooms.slice().sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon))[0];
  return { floorIndex, position: largest ? interiorPoint(largest.polygon) : { x: 0, y: 0 }, yaw: 0 };
}

/** The room the player is in on a floor, or null. */
export function roomAt(floor: Floor, p: Vec2): Room | null {
  let best: Room | null = null;
  let bestArea = Infinity;
  for (const r of floor.rooms) {
    if (!pointInPolygon(p, r.polygon)) continue;
    // Prefer the smallest containing room when polygons overlap.
    const a = polygonArea(r.polygon);
    if (a < bestArea) {
      best = r;
      bestArea = a;
    }
  }
  return best;
}
