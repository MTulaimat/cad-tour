import type { Floor, FloorPlan, Stair, StairFlight, Vec2 } from '../data/schema';
import { add, closestT, cross, dist, dot, lerp2, normalize, perp, scale, sub } from '../util/math2d';
import { wallSegments } from './walls';

export interface FlightInfo {
  stair: Stair;
  flight: StairFlight;
  index: number;
  dir: Vec2;
  /** Left unit normal of the climbing direction. */
  side: Vec2;
  /** Horizontal length from the first riser to the last riser. */
  run: number;
  /** Absolute elevation of the flight bottom and top. */
  base: number;
  top: number;
  /** Footprint, counterclockwise: start right, end right, end left, start left. */
  polygon: Vec2[];
  /** Intervals of run (s) where each side has no wall next to it, so it needs a balustrade. */
  openLeft: [number, number][];
  openRight: [number, number][];
}

export interface StairInfo {
  stair: Stair;
  from: Floor;
  to: Floor;
  flights: FlightInfo[];
  /** Absolute elevation of the landings. */
  landings: { polygon: Vec2[]; elevation: number }[];
  /** Outline edges on the upper floor that need a guard rail (not walls, not the arrival edge). */
  guardEdges: [Vec2, Vec2][];
  /** Index of the outline edge where the top flight arrives (i to i + 1), or -1. */
  arrivalEdge: number;
  /** Arrival point at the top and climbing direction there. */
  arrival: { point: Vec2; dir: Vec2 };
  /** Departure point at the bottom (in front of the first riser) and climbing direction. */
  departure: { point: Vec2; dir: Vec2 };
}

/** Intervals [0, len] minus covered intervals. */
function subtractIntervals(len: number, covered: [number, number][]): [number, number][] {
  const c = covered
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(len, Math.max(a, b))] as [number, number])
    .filter(([a, b]) => b - a > 1e-3)
    .sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let cur = 0;
  for (const [a, b] of c) {
    if (a > cur + 0.02) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (len > cur + 0.02) out.push([cur, len]);
  return out;
}

/**
 * Intervals of a line (origin p, unit dir d, length len) that run along a wall face of the floor,
 * within `gap` of the face.
 */
function coveredByWalls(plan: FloorPlan, floor: Floor, p: Vec2, d: Vec2, len: number, gap: number): [number, number][] {
  const out: [number, number][] = [];
  for (const s of wallSegments(plan, floor)) {
    if (Math.abs(cross(d, s.dir)) > 0.06) continue;
    const mid = lerp2(p, add(p, scale(d, len)), 0.5);
    const t = closestT(mid, s.a, s.b);
    const off = dist(mid, lerp2(s.a, s.b, t));
    // Distance between the parallel lines.
    const lineDist = Math.abs(cross(sub(mid, s.a), s.dir));
    if (lineDist > s.thickness / 2 + gap || off > len + s.length) continue;
    const u0 = dot(sub(s.a, p), d);
    const u1 = dot(sub(s.b, p), d);
    out.push([Math.min(u0, u1) - s.thickness / 2, Math.max(u0, u1) + s.thickness / 2]);
  }
  return out;
}

const infoCache = new WeakMap<FloorPlan, StairInfo[]>();

export function stairInfos(plan: FloorPlan): StairInfo[] {
  const hit = infoCache.get(plan);
  if (hit) return hit;
  const out: StairInfo[] = [];
  for (const stair of plan.stairs) {
    const from = plan.floors.find((f) => f.id === stair.fromFloorId);
    const to = plan.floors.find((f) => f.id === stair.toFloorId);
    if (!from || !to || stair.flights.length === 0) continue;
    const flights: FlightInfo[] = stair.flights.map((flight, index) => {
      const dir = normalize(flight.direction);
      const side = perp(dir);
      const run = (flight.risers - 1) * flight.going;
      const hw = flight.width / 2;
      const end = add(flight.start, scale(dir, run));
      const polygon = [
        add(flight.start, scale(side, -hw)),
        add(end, scale(side, -hw)),
        add(end, scale(side, hw)),
        add(flight.start, scale(side, hw)),
      ];
      const base = from.elevation + flight.baseElevation;
      const top = base + flight.risers * flight.riserHeight;
      const gap = 0.12;
      const leftStart = add(flight.start, scale(side, hw));
      const rightStart = add(flight.start, scale(side, -hw));
      const coverL = coveredByWalls(plan, from, leftStart, dir, run, gap);
      const coverR = coveredByWalls(plan, from, rightStart, dir, run, gap);
      return {
        stair,
        flight,
        index,
        dir,
        side,
        run,
        base,
        top,
        polygon,
        openLeft: subtractIntervals(run, coverL),
        openRight: subtractIntervals(run, coverR),
      };
    });

    const last = flights[flights.length - 1];
    const arrivalPoint = add(last.flight.start, scale(last.dir, last.run));
    const first = flights[0];

    // Guard edges around the opening on the upper floor.
    const guardEdges: [Vec2, Vec2][] = [];
    let arrivalEdge = -1;
    const o = stair.outline;
    for (let i = 0; i < o.length; i++) {
      const a = o[i];
      const b = o[(i + 1) % o.length];
      const len = dist(a, b);
      if (len < 0.05) continue;
      const d = normalize(sub(b, a));
      // Arrival edge: perpendicular to the last flight and passing near its top.
      const isArrival =
        Math.abs(dot(d, last.dir)) < 0.2 && Math.abs(cross(d, sub(arrivalPoint, a))) < 0.15 && closestT(arrivalPoint, a, b) > 0 && closestT(arrivalPoint, a, b) < 1;
      if (isArrival) {
        arrivalEdge = i;
        continue;
      }
      const free = subtractIntervals(len, coveredByWalls(plan, to, a, d, len, 0.06));
      for (const [s0, s1] of free) guardEdges.push([add(a, scale(d, s0)), add(a, scale(d, s1))]);
    }

    out.push({
      stair,
      from,
      to,
      flights,
      landings: stair.landings.map((l) => ({ polygon: l.polygon, elevation: from.elevation + l.elevation })),
      guardEdges,
      arrivalEdge,
      arrival: { point: arrivalPoint, dir: last.dir },
      departure: { point: first.flight.start, dir: first.dir },
    });
  }
  infoCache.set(plan, out);
  return out;
}

/**
 * Walking height on a flight: a ramp through the tread centers, so the camera glides instead of
 * stepping. It starts half a tread before the first riser and ends half a tread past the last.
 * Returns null when p is not over the flight.
 */
export function flightHeightAt(f: FlightInfo, p: Vec2, lateralMargin = 0): number | null {
  const rel = sub(p, f.flight.start);
  const s = dot(rel, f.dir);
  const lat = dot(rel, f.side);
  const g = f.flight.going;
  if (Math.abs(lat) > f.flight.width / 2 + lateralMargin) return null;
  if (s < -g / 2 || s > f.run + g / 2) return null;
  const rise = f.flight.riserHeight;
  const h = rise * (s / g + 0.5);
  return f.base + Math.max(0, Math.min(f.flight.risers * rise, h));
}
