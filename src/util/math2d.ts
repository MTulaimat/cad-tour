import type { Vec2 } from '../data/schema';

export const EPS = 1e-9;

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
/** Left-hand normal (counterclockwise rotation by 90 degrees). */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });
export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);
export const fromAngle = (t: number): Vec2 => ({ x: Math.cos(t), y: Math.sin(t) });

export function normalize(a: Vec2): Vec2 {
  const l = len(a);
  return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

export function rotate(a: Vec2, t: number): Vec2 {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** Signed area, positive for counterclockwise polygons. */
export function signedArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export const polygonArea = (poly: readonly Vec2[]): number => Math.abs(signedArea(poly));

export function ensureCCW(poly: Vec2[]): Vec2[] {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

export function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const c = p.x * q.y - q.x * p.y;
    a += c;
    cx += (p.x + q.x) * c;
    cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < EPS) {
    const s = poly.reduce((acc, p) => add(acc, p), v2(0, 0));
    return scale(s, 1 / Math.max(1, poly.length));
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * A point inside the polygon that is well away from its edges, found by scanning
 * horizontal lines. Good for label placement and probes in concave rooms.
 */
export function interiorPoint(poly: readonly Vec2[]): Vec2 {
  const c = polygonCentroid(poly);
  if (pointInPolygon(c, poly) && distanceToPolygonEdges(c, poly) > 0.3) return c;
  const b = bounds(poly);
  let best = c;
  let bestD = -1;
  const steps = 24;
  for (let i = 1; i < steps; i++) {
    const y = b.minY + ((b.maxY - b.minY) * i) / steps;
    for (let j = 1; j < steps; j++) {
      const x = b.minX + ((b.maxX - b.minX) * j) / steps;
      const p = v2(x, y);
      if (!pointInPolygon(p, poly)) continue;
      const d = distanceToPolygonEdges(p, poly) - 0.02 * dist(p, c);
      if (d > bestD) {
        bestD = d;
        best = p;
      }
    }
  }
  return best;
}

export function distanceToPolygonEdges(p: Vec2, poly: readonly Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, pointSegmentDistance(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bounds(points: readonly Vec2[]): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of points) {
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
  }
  return b;
}

export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Parameter t in [0, 1] of the point on segment ab closest to p. */
export function closestT(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < EPS) return 0;
  return Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
}

export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  return lerp2(a, b, closestT(p, a, b));
}

export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  return dist(p, closestPointOnSegment(p, a, b));
}

/** Intersection of segments ab and cd, with parameters along each, or null. */
export function segmentIntersection(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
  eps = 1e-9,
): { p: Vec2; t: number; u: number } | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < eps) return null;
  const ac = sub(c, a);
  const t = cross(ac, s) / den;
  const u = cross(ac, r) / den;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { p: add(a, scale(r, t)), t, u };
}

/** Intersection of two infinite lines given by point and direction, or null if parallel. */
export function lineIntersection(p: Vec2, r: Vec2, q: Vec2, s: Vec2): Vec2 | null {
  const den = cross(r, s);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(q, p), s) / den;
  return add(p, scale(r, t));
}

export function polylineLength(points: readonly Vec2[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += dist(points[i - 1], points[i]);
  return l;
}

/** Point and unit direction at arc length s along a polyline (clamped). */
export function pointAlongPolyline(points: readonly Vec2[], s: number): { p: Vec2; dir: Vec2; segment: number; local: number } {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const l = dist(a, b);
    if (s <= acc + l || i === points.length - 1) {
      const local = Math.max(0, Math.min(l, s - acc));
      const dir = normalize(sub(b, a));
      return { p: add(a, scale(dir, local)), dir, segment: i - 1, local };
    }
    acc += l;
  }
  const p = points[0] ?? v2(0, 0);
  return { p, dir: v2(1, 0), segment: 0, local: 0 };
}

/** Arc length of the projection of p onto a polyline, and the distance to it. */
export function projectOntoPolyline(points: readonly Vec2[], p: Vec2): { s: number; distance: number; segment: number } {
  let best = { s: 0, distance: Infinity, segment: 0 };
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const l = dist(a, b);
    const t = closestT(p, a, b);
    const d = dist(p, lerp2(a, b, t));
    if (d < best.distance) best = { s: acc + t * l, distance: d, segment: i - 1 };
    acc += l;
  }
  return best;
}

export const almostEqual = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;
export const samePoint = (a: Vec2, b: Vec2, eps = 1e-6): boolean => dist(a, b) <= eps;

export function wrapAngle(t: number): number {
  let a = t % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Rectangle polygon (CCW) centered at c with size w x d, rotated by yaw. */
export function orientedRect(c: Vec2, w: number, d: number, yaw: number): Vec2[] {
  const hw = w / 2;
  const hd = d / 2;
  return [v2(-hw, -hd), v2(hw, -hd), v2(hw, hd), v2(-hw, hd)].map((p) => add(c, rotate(p, yaw)));
}
