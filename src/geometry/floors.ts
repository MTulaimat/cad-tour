import type { Floor, FloorPlan, Room, Vec2 } from '../data/schema';
import { floorMaterialKey } from '../materials/keys';
import { subtractConvex } from '../util/clip';
import { traceFaces } from '../util/arrangement';
import { add, bounds, dist, interiorPoint, normalize, perp, pointInPolygon, scale, signedArea, sub } from '../util/math2d';
import { stairInfos } from '../plan/stairs';
import { buildingTop, floorAbove, roomTop } from '../plan/levels';
import { wallSegments } from '../plan/walls';
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

/** True when a point is on the floor of some room of `floor`, or covered by a wall of it. */
function onFloor(plan: FloorPlan, floor: Floor, p: Vec2): boolean {
  if (floor.rooms.some((r) => pointInPolygon(p, r.polygon))) return true;
  return wallSegments(plan, floor).some((s) => {
    const rel = sub(p, s.a);
    const u = rel.x * s.dir.x + rel.y * s.dir.y;
    const v = rel.x * s.nrm.x + rel.y * s.nrm.y;
    return u >= -s.thickness / 2 && u <= s.length + s.thickness / 2 && Math.abs(v) <= s.thickness / 2 + 0.02;
  });
}

/** Floor surfaces per room, with stair openings cut where a stair arrives from below. */
export function buildFloors(plan: FloorPlan, floor: Floor, sets: BuilderSet): void {
  const E = floor.elevation;
  const openings = stairInfos(plan)
    .filter((s) => s.to.id === floor.id)
    .map((s) => s.stair.outline);
  const lowest = plan.floors.every((f) => f.elevation >= E - 0.01);
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
    } else if (!lowest) {
      // An upper floor that stops short of the walls (a mezzanine over a double-height space):
      // the slab's edge shows where nothing of this floor continues past the room's edge.
      const t = floor.slabThickness;
      const edge = sets.get('wall-interior');
      const poly = room.polygon;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const c = poly[(i + 1) % poly.length];
        const l = dist(a, c);
        if (l < 1e-3) continue;
        const out = scale(perp(normalize(sub(c, a))), -1);
        const n = Math.max(1, Math.ceil(l / 0.1));
        let run: [number, number] | null = null;
        const flush = (end: number) => {
          if (!run) return;
          const p = add(a, scale(sub(c, a), run[0] / l));
          const q = add(a, scale(sub(c, a), end / l));
          edge.quadAuto(W(p, E - t), W(q, E - t), W(q, E), W(p, E));
          run = null;
        };
        for (let k = 0; k < n; k++) {
          const s0 = (l * k) / n;
          const s1 = (l * (k + 1)) / n;
          const m = add(a, scale(sub(c, a), (s0 + s1) / 2 / l));
          const open = !onFloor(plan, floor, add(m, scale(out, 0.06))) && !openings.some((o) => pointInPolygon(add(m, scale(out, 0.06)), o));
          if (open) run = run ? [run[0], s1] : [s0, s1];
          else flush(s0);
        }
        flush(l);
      }
    }
  }
}

/**
 * A room's ceiling split by the floor above: under that floor's rooms it is the slab's underside;
 * elsewhere (a double-height space beside a mezzanine) it is the room's own ceiling. Returns
 * pieces with the height of each.
 */
function ceilingParts(room: Room, roomCeiling: number, cover: Vec2[][], slab: number): { poly: Vec2[]; y: number; underSlab: boolean }[] {
  const b = bounds(room.polygon);
  const near = cover.filter((c) => {
    const cb = bounds(c);
    return cb.minX < b.maxX && cb.maxX > b.minX && cb.minY < b.maxY && cb.maxY > b.minY;
  });
  if (near.length === 0) return [{ poly: room.polygon, y: roomCeiling, underSlab: false }];
  const edges = (p: Vec2[]) => p.map((q, i) => ({ a: q, b: p[(i + 1) % p.length] }));
  const faces = traceFaces([...edges(room.polygon), ...near.flatMap(edges)], 1e-4).filter((f) => signedArea(f) > 1e-4);
  const out: { poly: Vec2[]; y: number; underSlab: boolean }[] = [];
  for (const f of faces) {
    const p = interiorPoint(f);
    if (!pointInPolygon(p, room.polygon)) continue;
    const under = near.some((c) => pointInPolygon(p, c));
    out.push({ poly: f, y: under ? Math.min(slab, roomCeiling) : roomCeiling, underSlab: under });
  }
  return out;
}

/** Ceilings per indoor room, with openings where a stair climbs through the floor above. */
export function buildCeilings(plan: FloorPlan, floor: Floor, sets: BuilderSet): void {
  const E = floor.elevation;
  const infos = stairInfos(plan).filter((s) => s.from.id === floor.id);
  const openings = infos.map((s) => s.stair.outline);
  const b = sets.get('ceiling');
  const above = floorAbove(plan, floor);
  const cover = above ? above.rooms.filter((r) => !r.outdoor).map((r) => r.polygon) : [];
  const slab = above ? above.elevation - above.slabThickness : Infinity;
  // A plain stack of floors: every ceiling is the slab above, cut where stairs go up.
  const split = !!above && floor.rooms.some((r) => !r.outdoor && roomTop(floor, r) > slab + 0.01);
  const roof = buildingTop(plan);
  const top = sets.get('wall-interior');
  for (const room of floor.rooms) {
    if (room.outdoor) continue;
    const h = E + (room.ceilingHeight ?? floor.ceilingHeight);
    if (!split) {
      for (const part of cutOpenings(room.polygon, openings)) b.polygon(part.outer, h, false, part.holes);
      continue;
    }
    for (const part of ceilingParts(room, h, cover, slab)) {
      if (part.underSlab || part.y >= roof - 0.01) {
        // Stairs pass through the slab; a double-height space's ceiling is the roof.
        for (const piece of cutOpenings(part.poly, part.underSlab ? openings : [])) b.polygon(piece.outer, part.y, false, piece.holes);
        continue;
      }
      // A lower ceiling with nothing of the floor above over it stands inside the double-height
      // space: a slab with a top and edges, cut where a stair climbs through it, under the roof.
      const t = above.slabThickness;
      for (const piece of cutOpenings(part.poly, openings)) {
        b.polygon(piece.outer, part.y, false, piece.holes);
        top.polygon(piece.outer, part.y + t, true, piece.holes);
        for (const ring of [piece.outer, ...piece.holes]) {
          const ccw = signedArea(ring) > 0 === (ring === piece.outer);
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const c = ring[(i + 1) % ring.length];
            if (dist(a, c) < 1e-3) continue;
            if (ccw) top.quadAuto(W(a, part.y), W(c, part.y), W(c, part.y + t), W(a, part.y + t));
            else top.quadAuto(W(c, part.y), W(a, part.y), W(a, part.y + t), W(c, part.y + t));
          }
        }
      }
      b.polygon(part.poly, roof, false);
    }
  }
  // Stairwell edges: the slab thickness around the opening, facing into it, where there is slab.
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
      // Outline is counterclockwise, so the slab beyond the edge is to its right.
      if (split) {
        const mid = scale(add(a, c), 0.5);
        const beyond = add(mid, scale(perp(normalize(sub(c, a))), -0.1));
        if (!cover.some((p) => pointInPolygon(beyond, p))) continue;
      }
      edge.quadAuto(W(c, y0), W(a, y0), W(a, y1), W(c, y1));
    }
  }
}
