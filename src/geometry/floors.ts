import type { Floor, FloorPlan, Vec2 } from '../data/schema';
import { floorMaterialKey } from '../materials/keys';
import { subtractConvex } from '../util/clip';
import { dist } from '../util/math2d';
import { stairInfos } from '../plan/stairs';
import { type BuilderSet, W } from './builder';

/** Subtracts every (convex) opening from a polygon; returns pieces and holes to triangulate. */
export function cutOpenings(poly: Vec2[], openings: Vec2[][]): { outer: Vec2[]; holes: Vec2[][] }[] {
  let parts: { outer: Vec2[]; holes: Vec2[][] }[] = [{ outer: poly, holes: [] }];
  for (const o of openings) {
    const next: { outer: Vec2[]; holes: Vec2[][] }[] = [];
    for (const part of parts) {
      const r = subtractConvex(part.outer, o);
      if (r.hole) next.push({ outer: part.outer, holes: [...part.holes, r.hole] });
      else for (const p of r.pieces) next.push({ outer: p, holes: part.holes });
    }
    parts = next;
  }
  return parts;
}

/** Floor surfaces per room, with stair openings cut where a stair arrives from below. */
export function buildFloors(plan: FloorPlan, floor: Floor, sets: BuilderSet): void {
  const E = floor.elevation;
  const openings = stairInfos(plan)
    .filter((s) => s.to.id === floor.id)
    .map((s) => s.stair.outline);
  for (const room of floor.rooms) {
    const b = sets.get(floorMaterialKey(room.floorMaterial));
    for (const part of cutOpenings(room.polygon, openings)) b.polygon(part.outer, E, true, part.holes);
    if (room.outdoor) {
      // Balcony slab: soffit and edge faces so it reads as a cantilevered slab from outside.
      const t = floor.slabThickness;
      const edge = sets.get('slab-edge');
      edge.polygon(room.polygon, E - t, false);
      const poly = room.polygon;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const c = poly[(i + 1) % poly.length];
        if (dist(a, c) < 1e-3) continue;
        // Counterclockwise polygon: the outward face of edge a to c faces right of travel.
        edge.quadAuto(W(a, E - t), W(c, E - t), W(c, E), W(a, E));
      }
    }
  }
}

/** Ceilings per indoor room, with openings where a stair climbs to the floor above. */
export function buildCeilings(plan: FloorPlan, floor: Floor, sets: BuilderSet): void {
  const E = floor.elevation;
  const infos = stairInfos(plan).filter((s) => s.from.id === floor.id);
  const openings = infos.map((s) => s.stair.outline);
  const b = sets.get('ceiling');
  for (const room of floor.rooms) {
    if (room.outdoor) continue;
    const h = E + (room.ceilingHeight ?? floor.ceilingHeight);
    for (const part of cutOpenings(room.polygon, openings)) b.polygon(part.outer, h, false, part.holes);
  }
  // Stairwell edges: the slab thickness around the opening, facing into it.
  const edge = sets.get('wall-interior');
  for (const s of infos) {
    const y0 = E + floor.ceilingHeight;
    const y1 = s.to.elevation;
    if (y1 - y0 < 0.005) continue;
    const o = s.stair.outline;
    for (let i = 0; i < o.length; i++) {
      if (i === s.arrivalEdge) continue;
      const a = o[i];
      const c = o[(i + 1) % o.length];
      if (dist(a, c) < 1e-3) continue;
      // Outline is counterclockwise, so the inward face is to the left of travel.
      edge.quadAuto(W(c, y0), W(a, y0), W(a, y1), W(c, y1));
    }
  }
}
