import type { Furniture, Vec2 } from '../schema';
import { matchFurnitureType } from '../../geometry/furniture/registry';
import { pieceFor } from '../../geometry/furniture/library';
import { add, angleOf, dist, normalize, scale, sub } from '../../util/math2d';

/**
 * Q9: furniture blocks are matched by block and layer name (English and Arabic) to the procedural
 * pieces, scaled to the block's footprint and turned to match. Unknown blocks become a neutral
 * low volume in their footprint.
 */

export interface FurnitureCandidate {
  name: string;
  layer: string;
  /** Footprint corners in meters, counterclockwise in the block's local frame. */
  corners: Vec2[];
}

export function furnitureFromBlock(c: FurnitureCandidate, id: string): { item: Furniture; matched: boolean } | null {
  if (c.corners.length < 4) return null;
  const [p0, p1, , p3] = c.corners;
  const w = dist(p0, p1);
  const d = dist(p0, p3);
  if (w < 0.08 || d < 0.08 || w > 8 || d > 8) return null;
  const center = scale(c.corners.reduce((a, p) => add(a, p), { x: 0, y: 0 }), 1 / c.corners.length);
  const type = matchFurnitureType([c.name, c.layer], w, d);
  const def = pieceFor(type ?? 'box');
  // Block local x is the piece's width axis; schema yaw is the rotation of that axis.
  const rotation = angleOf(normalize(sub(p1, p0)));
  const height = type ? def.size.z : 0.4;
  return {
    item: { id, type: type ?? 'box', position: center, rotation, size: { x: w, y: d, z: height }, label: c.name },
    matched: !!type,
  };
}

/** Closed outlines on furniture layers that are not blocks: neutral volumes, turned to their longest edge. */
export function furnitureFromOutline(points: Vec2[], layer: string, id: string): Furniture | null {
  if (points.length < 3) return null;
  let best = { l: 0, d: { x: 1, y: 0 } as Vec2 };
  for (let i = 0; i < points.length; i++) {
    const d = sub(points[(i + 1) % points.length], points[i]);
    const l = Math.hypot(d.x, d.y);
    if (l > best.l) best = { l, d: normalize(d) };
  }
  const n = { x: -best.d.y, y: best.d.x };
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of points) {
    const u = p.x * best.d.x + p.y * best.d.y;
    const v = p.x * n.x + p.y * n.y;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const w = u1 - u0;
  const d = v1 - v0;
  if (w < 0.15 || d < 0.15 || w > 8 || d > 8) return null;
  const c = add(scale(best.d, (u0 + u1) / 2), scale(n, (v0 + v1) / 2));
  const type = matchFurnitureType([layer], w, d);
  const def = pieceFor(type ?? 'box');
  return { id, type: type ?? 'box', position: c, rotation: angleOf(best.d), size: { x: w, y: d, z: type ? def.size.z : 0.4 }, label: layer };
}
