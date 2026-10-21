import type { FloorPlan, Vec2 } from '../data/schema';
import { add, dist, len, lerp2, normalize, orientedRect, perp, pointInPolygon, scale, sub, closestT } from '../util/math2d';
import { faceRange, segmentPoint, wallSegments } from '../plan/walls';
import { flightHeightAt, stairInfos, type FlightInfo } from '../plan/stairs';
import { railRuns } from '../geometry/railings';
import { furnitureSize, pieceFor } from '../geometry/furniture';

/**
 * 2D collision: the player is a vertical capsule (a circle in plan with a height span) pushed out
 * of line segments. Each segment has its own height span, so a 1 m balcony rail blocks you while a
 * rug or the wall of the floor above does not.
 */

export interface Segment {
  a: Vec2;
  b: Vec2;
  /** World heights the segment occupies. */
  y0: number;
  y1: number;
  kind: 'wall' | 'rail' | 'furniture' | 'stair' | 'door';
}

export const PLAYER_RADIUS = 0.25;
/** The capsule starts this far above the feet, so low thresholds and rugs never block. */
export const STEP_CLEARANCE = 0.32;
export const PLAYER_HEIGHT = 1.8;

const CELL = 1;

export class CollisionWorld {
  readonly segments: Segment[] = [];
  private grid = new Map<string, number[]>();
  readonly flights: FlightInfo[] = [];
  private floorAreas: { elevation: number; polys: Vec2[][]; holes: Vec2[][] }[] = [];
  private landings: { polygon: Vec2[]; elevation: number }[] = [];

  constructor(readonly plan: FloorPlan) {
    this.build();
  }

  private add(a: Vec2, b: Vec2, y0: number, y1: number, kind: Segment['kind']): void {
    if (dist(a, b) < 1e-4) return;
    const i = this.segments.length;
    this.segments.push({ a, b, y0, y1, kind });
    const x0 = Math.floor(Math.min(a.x, b.x) / CELL - 0.5);
    const x1 = Math.floor(Math.max(a.x, b.x) / CELL + 0.5);
    const z0 = Math.floor(Math.min(a.y, b.y) / CELL - 0.5);
    const z1 = Math.floor(Math.max(a.y, b.y) / CELL + 0.5);
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`;
        const list = this.grid.get(k);
        if (list) list.push(i);
        else this.grid.set(k, [i]);
      }
  }

  private build(): void {
    const plan = this.plan;
    for (const floor of plan.floors) {
      const E = floor.elevation;
      for (const s of wallSegments(plan, floor)) {
        const y0 = E - floor.slabThickness;
        const y1 = E + s.height + 0.05;
        const doors = s.openings.filter((o) => o.opening.type === 'door');
        for (const left of [true, false]) {
          const side = left ? s.thickness / 2 : -s.thickness / 2;
          const [fu0, fu1] = faceRange(s, left);
          const u0 = Math.min(fu0, fu1);
          const u1 = Math.max(fu0, fu1);
          let cur = u0;
          for (const d of doors) {
            if (d.u0 > cur) this.add(segmentPoint(s, cur, side), segmentPoint(s, d.u0, side), y0, y1, 'wall');
            cur = Math.max(cur, d.u1);
          }
          if (cur < u1) this.add(segmentPoint(s, cur, side), segmentPoint(s, u1, side), y0, y1, 'wall');
        }
        // Jambs across the wall thickness at doors, and free-end caps.
        for (const d of doors) {
          for (const u of [d.u0, d.u1]) this.add(segmentPoint(s, u, -s.thickness / 2), segmentPoint(s, u, s.thickness / 2), y0, y1, 'wall');
        }
        if (!s.startJoined) this.add(s.startLeft, s.startRight, y0, y1, 'wall');
        if (!s.endJoined) this.add(s.endLeft, s.endRight, y0, y1, 'wall');
      }
      // Railings: balconies and stairwell guards.
      for (const run of railRuns(plan, floor)) {
        for (let i = 1; i < run.points.length; i++) this.add(run.points[i - 1], run.points[i], E - 0.2, E + run.height, 'rail');
      }
      // Furniture footprints.
      for (const item of floor.furniture) {
        const def = pieceFor(item.type);
        if (!def.solid) continue;
        const size = furnitureSize(item);
        if (size.z < STEP_CLEARANCE) continue;
        const r = orientedRect(item.position, size.x, size.y, item.rotation);
        for (let i = 0; i < 4; i++) this.add(r[i], r[(i + 1) % 4], E, E + size.z, 'furniture');
      }
      this.floorAreas.push({
        elevation: E,
        polys: floor.rooms.map((r) => r.polygon),
        holes: stairInfos(plan)
          .filter((st) => st.to.id === floor.id)
          .map((st) => st.stair.outline),
      });
    }
    // Stairs: open sides get a barrier along the full height of the flight (balustrade above,
    // spandrel below), and the flights provide walking height.
    for (const st of stairInfos(plan)) {
      for (const f of st.flights) {
        this.flights.push(f);
        for (const [open, sign] of [
          [f.openLeft, 1],
          [f.openRight, -1],
        ] as const) {
          for (const [s0, s1] of open) {
            const off = scale(f.side, sign * (f.flight.width / 2 + 0.0125));
            const a = add(add(f.flight.start, scale(f.dir, s0)), off);
            const b = add(add(f.flight.start, scale(f.dir, s1)), off);
            this.add(a, b, f.base - 0.1, f.top + 1.0, 'stair');
          }
        }
      }
      for (const l of st.landings) this.landings.push(l);
    }
  }

  /** Segments near a point (within one grid cell ring). */
  private near(p: Vec2): number[] {
    const cx = Math.floor(p.x / CELL);
    const cz = Math.floor(p.y / CELL);
    const out = new Set<number>();
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let z = cz - 1; z <= cz + 1; z++) for (const i of this.grid.get(`${x},${z}`) ?? []) out.add(i);
    return [...out];
  }

  /**
   * Pushes a circle at `p` (feet at height `h`) out of every overlapping segment, a few passes so
   * corners resolve. Extra dynamic segments (door leaves) join in. Returns the corrected point.
   */
  resolve(p: Vec2, h: number, extra: Segment[] = [], radius = PLAYER_RADIUS): Vec2 {
    let q = { x: p.x, y: p.y };
    const lo = h + STEP_CLEARANCE;
    const hi = h + PLAYER_HEIGHT;
    const candidates = this.near(q);
    for (let pass = 0; pass < 4; pass++) {
      let moved = false;
      const test = (s: Segment) => {
        if (s.y1 < lo || s.y0 > hi) return;
        const t = closestT(q, s.a, s.b);
        const c = lerp2(s.a, s.b, t);
        const d = sub(q, c);
        const dl = len(d);
        if (dl >= radius) return;
        const n = dl > 1e-6 ? scale(d, 1 / dl) : normalize(perp(sub(s.b, s.a)));
        q = add(q, scale(n, radius - dl + 1e-4));
        moved = true;
      };
      for (const i of candidates) test(this.segments[i]);
      for (const s of extra) test(s);
      if (!moved) break;
    }
    return q;
  }

  /** True if a circle at p overlaps any segment (used to keep doors from trapping the player). */
  overlaps(p: Vec2, h: number, segs: Segment[], radius = PLAYER_RADIUS): boolean {
    const lo = h + STEP_CLEARANCE;
    const hi = h + PLAYER_HEIGHT;
    return segs.some((s) => s.y1 >= lo && s.y0 <= hi && dist(p, lerp2(s.a, s.b, closestT(p, s.a, s.b))) < radius - 1e-3);
  }

  /**
   * Walking height at p given the current height: flights win over the floor beneath them
   * (they ramp through the tread centers), then landings, then the floor surfaces, choosing the
   * highest floor not more than a step above the current height.
   */
  heightAt(p: Vec2, current: number): number {
    let best: number | null = null;
    for (const f of this.flights) {
      const h = flightHeightAt(f, p);
      if (h === null || Math.abs(h - current) > 0.6) continue;
      if (best === null || Math.abs(h - current) < Math.abs(best - current)) best = h;
    }
    if (best !== null) return best;
    for (const l of this.landings) {
      if (Math.abs(l.elevation - current) < 0.6 && pointInPolygon(p, l.polygon)) return l.elevation;
    }
    let floorH: number | null = null;
    for (const f of this.floorAreas) {
      if (f.elevation > current + 0.45) continue;
      if (!f.polys.some((poly) => pointInPolygon(p, poly))) continue;
      if (f.holes.some((poly) => pointInPolygon(p, poly))) continue;
      if (floorH === null || f.elevation > floorH) floorH = f.elevation;
    }
    return floorH ?? current;
  }

  /** True when p is over a stair flight at roughly this height. */
  onStair(p: Vec2, current: number): boolean {
    return this.flights.some((f) => {
      const h = flightHeightAt(f, p);
      return h !== null && Math.abs(h - current) < 0.6;
    });
  }
}

/** Distance from a point to a segment, for door logic. */
export const segDistance = (p: Vec2, s: Segment): number => dist(p, lerp2(s.a, s.b, closestT(p, s.a, s.b)));
