import type { Vec2 } from '../data/schema';
import { closestT, dist, lerp2, segmentIntersection } from './math2d';

/**
 * Planar arrangements of line segments: split at every crossing and T touch, then traced into
 * faces. Used for room detection and for splitting ceilings where a floor above covers part of a
 * room.
 */

export interface Seg {
  a: Vec2;
  b: Vec2;
}

/** Splits segments at their mutual intersections and T touches. */
export function splitSegments(segs: Seg[], tol: number): Seg[] {
  const cuts: number[][] = segs.map(() => [0, 1]);
  for (let i = 0; i < segs.length; i++) {
    const A = segs[i];
    const la = dist(A.a, A.b);
    for (let j = i + 1; j < segs.length; j++) {
      const B = segs[j];
      // Quick reject on bounding boxes.
      if (
        Math.max(A.a.x, A.b.x) + tol < Math.min(B.a.x, B.b.x) ||
        Math.max(B.a.x, B.b.x) + tol < Math.min(A.a.x, A.b.x) ||
        Math.max(A.a.y, A.b.y) + tol < Math.min(B.a.y, B.b.y) ||
        Math.max(B.a.y, B.b.y) + tol < Math.min(A.a.y, A.b.y)
      )
        continue;
      const lb = dist(B.a, B.b);
      const x = segmentIntersection(A.a, A.b, B.a, B.b, 1e-9);
      if (x) {
        cuts[i].push(x.t);
        cuts[j].push(x.u);
        continue;
      }
      // T touches: an endpoint within tol of the other segment.
      for (const [p, k, other, lo] of [
        [B.a, i, A, la],
        [B.b, i, A, la],
        [A.a, j, B, lb],
        [A.b, j, B, lb],
      ] as [Vec2, number, Seg, number][]) {
        const t = closestT(p, other.a, other.b);
        if (dist(p, lerp2(other.a, other.b, t)) <= tol && t * lo > tol && (1 - t) * lo > tol) cuts[k].push(t);
      }
    }
  }
  const out: Seg[] = [];
  segs.forEach((s, i) => {
    const ts = [...new Set(cuts[i].map((t) => Math.round(Math.max(0, Math.min(1, t)) * 1e7) / 1e7))].sort((x, y) => x - y);
    for (let k = 1; k < ts.length; k++) {
      const a = lerp2(s.a, s.b, ts[k - 1]);
      const b = lerp2(s.a, s.b, ts[k]);
      if (dist(a, b) > tol) out.push({ a, b });
    }
  });
  return out;
}

/**
 * Every face of the arrangement (dangling ends pruned): bounded faces counterclockwise, the outer
 * boundary of each connected part clockwise.
 */
export function traceFaces(segsIn: Seg[], tol: number): Vec2[][] {
  const segs = splitSegments(segsIn, tol);
  // Nodes by snapping.
  const nodes: Vec2[] = [];
  const nodeId = (p: Vec2) => {
    for (let i = 0; i < nodes.length; i++) if (dist(nodes[i], p) <= tol * 1.5) return i;
    nodes.push(p);
    return nodes.length - 1;
  };
  const adj = new Map<number, Set<number>>();
  const link = (u: number, v: number) => {
    if (u === v) return;
    if (!adj.has(u)) adj.set(u, new Set());
    if (!adj.has(v)) adj.set(v, new Set());
    adj.get(u)!.add(v);
    adj.get(v)!.add(u);
  };
  for (const s of segs) link(nodeId(s.a), nodeId(s.b));
  // Prune dangling chains.
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const [u, set] of adj) {
      if (set.size <= 1) {
        for (const v of set) adj.get(v)?.delete(u);
        adj.delete(u);
        pruned = true;
      }
    }
  }
  // Neighbours sorted counterclockwise by angle.
  const order = new Map<number, number[]>();
  for (const [u, set] of adj) {
    const p = nodes[u];
    order.set(
      u,
      [...set].sort((a, b) => Math.atan2(nodes[a].y - p.y, nodes[a].x - p.x) - Math.atan2(nodes[b].y - p.y, nodes[b].x - p.x)),
    );
  }
  const visited = new Set<string>();
  const faces: Vec2[][] = [];
  for (const [u, nbrs] of order) {
    for (const v of nbrs) {
      if (visited.has(`${u}>${v}`)) continue;
      const poly: Vec2[] = [];
      let a = u;
      let b = v;
      for (let guard = 0; guard < 10000; guard++) {
        visited.add(`${a}>${b}`);
        poly.push(nodes[a]);
        const around = order.get(b)!;
        const i = around.indexOf(a);
        // The next edge clockwise from the one we came in on keeps the face on our left.
        const c = around[(i - 1 + around.length) % around.length];
        a = b;
        b = c;
        if (a === u && b === v) break;
      }
      if (poly.length >= 3) faces.push(poly);
    }
  }
  return faces;
}
