import type { Vec2 } from '../data/schema';
import { cross, ensureCCW, pointInPolygon, signedArea, sub } from './math2d';

/** Clip a (possibly concave) polygon by the half-plane left of the directed line a to b. */
export function clipHalfPlane(poly: Vec2[], a: Vec2, b: Vec2, keepLeft = true): Vec2[] {
  const out: Vec2[] = [];
  const d = sub(b, a);
  const side = (p: Vec2) => (keepLeft ? 1 : -1) * cross(d, sub(p, a));
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const sp = side(p);
    const sq = side(q);
    if (sp >= 0) out.push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return out;
}

/** Intersection of a polygon with a convex polygon (counterclockwise). */
export function clipToConvex(poly: Vec2[], convex: Vec2[]): Vec2[] {
  const c = ensureCCW(convex);
  let out = poly;
  for (let i = 0; i < c.length && out.length >= 3; i++) out = clipHalfPlane(out, c[i], c[(i + 1) % c.length], true);
  return out.length >= 3 && Math.abs(signedArea(out)) > 1e-6 ? out : [];
}

/**
 * A polygon minus a convex polygon, as disjoint pieces with no holes, or as the polygon
 * plus a hole when the convex one lies fully inside it.
 */
export function subtractConvex(poly: Vec2[], convex: Vec2[]): { pieces: Vec2[][]; hole: Vec2[] | null } {
  const c = ensureCCW(convex);
  const inter = clipToConvex(poly, c);
  if (inter.length === 0) return { pieces: [poly], hole: null };
  const fullyInside = c.every((p) => pointInPolygon(p, poly)) && Math.abs(Math.abs(signedArea(inter)) - Math.abs(signedArea(c))) < 1e-6;
  if (fullyInside) return { pieces: [poly], hole: c };
  const pieces: Vec2[][] = [];
  for (let i = 0; i < c.length; i++) {
    let piece = clipHalfPlane(poly, c[i], c[(i + 1) % c.length], false);
    for (let j = 0; j < i && piece.length >= 3; j++) piece = clipHalfPlane(piece, c[j], c[(j + 1) % c.length], true);
    if (piece.length >= 3 && Math.abs(signedArea(piece)) > 1e-6) pieces.push(piece);
  }
  return { pieces, hole: null };
}
