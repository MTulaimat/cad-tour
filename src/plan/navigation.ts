import type { Floor, FloorPlan, Room, Vec2 } from '../data/schema';
import { add, angleOf, interiorPoint, normalize, pointInPolygon, polygonArea, polygonCentroid, scale, sub } from '../util/math2d';
import { wallSegments, segmentPoint } from './walls';
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

/** Faces into the plan: towards the floor's centroid if it is ahead, else along `inward`. */
function faceInto(floor: Floor, p: Vec2, inward: Vec2): number {
  const c = floorCentroid(floor);
  const toC = normalize(sub(c, p));
  const d = toC.x * inward.x + toC.y * inward.y > 0.2 ? normalize(add(scale(inward, 0.25), scale(toC, 0.75))) : inward;
  return yawFor(d);
}

/**
 * P5: start just inside the entrance door (a door on the outer boundary of the lowest floor,
 * not opening to a balcony), facing into the plan. Without one, start at the centroid of the
 * largest room on the lowest floor.
 */
export function startSpawn(plan: FloorPlan): Spawn {
  const fi = lowestFloorIndex(plan);
  const floor = plan.floors[fi];
  const indoor = floor.rooms.filter((r) => !r.outdoor);
  const outdoor = floor.rooms.filter((r) => r.outdoor);
  const inRoom = (p: Vec2, rooms: Room[]) => rooms.some((r) => pointInPolygon(p, r.polygon));
  for (const s of wallSegments(plan, floor)) {
    if (!(s.leftExterior || s.rightExterior)) continue;
    for (const o of s.openings) {
      if (o.opening.type !== 'door') continue;
      const c = (o.u0 + o.u1) / 2;
      const probe = s.thickness / 2 + 0.6;
      const left = segmentPoint(s, c, probe);
      const right = segmentPoint(s, c, -probe);
      // An entrance has indoor space on one side and nothing (not a balcony) on the other.
      const leftIn = inRoom(left, indoor);
      const rightIn = inRoom(right, indoor);
      if (leftIn === rightIn) continue;
      const outside = leftIn ? right : left;
      if (inRoom(outside, outdoor)) continue;
      const inward = leftIn ? s.nrm : scale(s.nrm, -1);
      const position = add(segmentPoint(s, c, 0), scale(inward, s.thickness / 2 + 0.75));
      return { floorIndex: fi, position, yaw: faceInto(floor, position, inward) };
    }
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
  for (const s of stairInfos(plan)) {
    if (s.to.id === floor.id) {
      const p = add(s.arrival.point, scale(s.arrival.dir, 0.55));
      return { floorIndex, position: p, yaw: faceInto(floor, p, s.arrival.dir) };
    }
  }
  for (const s of stairInfos(plan)) {
    if (s.from.id === floor.id) {
      const back = scale(s.departure.dir, -1);
      const p = add(s.departure.point, scale(back, 0.75));
      return { floorIndex, position: p, yaw: faceInto(floor, p, back) };
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
