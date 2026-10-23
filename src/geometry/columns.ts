import { CylinderGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import type { Column, Floor, FloorPlan, Vec2 } from '../data/schema';
import { orientedRect, pointInPolygon } from '../util/math2d';
import { roomTop } from '../plan/levels';
import { type BuilderSet, W } from './builder';

/** Where a column stands to: the ceiling of the room it is in (the floor's ceiling elsewhere). */
export function columnTop(floor: Floor, c: Column): number {
  const room = floor.rooms.find((r) => pointInPolygon(c.center, r.polygon));
  return room ? roomTop(floor, room) : floor.elevation + floor.ceilingHeight;
}

/** Plan outline of a column, counterclockwise (round ones as a 24-sided polygon). */
export function columnOutline(c: Column): Vec2[] {
  if (c.radius !== undefined) {
    const n = 24;
    return Array.from({ length: n }, (_, i) => ({ x: c.center.x + Math.cos((i / n) * Math.PI * 2) * c.radius!, y: c.center.y + Math.sin((i / n) * Math.PI * 2) * c.radius! }));
  }
  return orientedRect(c.center, c.width ?? 0.3, c.depth ?? 0.3, c.rotation ?? 0);
}

/** Free-standing columns, full height, in the wall finish. */
export function buildColumns(plan: FloorPlan, floor: Floor, sets: BuilderSet): void {
  void plan;
  const b = sets.get('wall-interior');
  const E = floor.elevation;
  for (const c of floor.columns ?? []) {
    const top = columnTop(floor, c);
    const h = top - E;
    if (h <= 0.05) continue;
    if (c.radius !== undefined) {
      b.append(new CylinderGeometry(c.radius, c.radius, h, 32, 1, true), new Matrix4().makeTranslation(W(c.center, E + h / 2)), false);
    } else {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), c.rotation ?? 0);
      b.box(new Matrix4().compose(W(c.center, E + h / 2), q, new Vector3(1, 1, 1)), c.width ?? 0.3, h, c.depth ?? 0.3, [true, true, false, false, true, true]);
    }
  }
}
