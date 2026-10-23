import type { FloorMaterialKey, Vec2 } from '../schema';
import { closestT, dist, distanceToPolygonEdges, ensureCCW, lerp2, pointInPolygon, polygonArea, polygonCentroid, segmentIntersection, signedArea } from '../../util/math2d';

/**
 * Room detection: wall centerlines (and room boundary lines) are split at every intersection into a
 * planar graph; dangling ends are pruned; minimal faces are traced with a half-edge walk (the face
 * stays on the left, so rooms come out counterclockwise and the outer boundary clockwise). The outer
 * face and slivers are dropped. Rooms are named from a label inside them, else "Room N".
 */

export interface Seg {
  a: Vec2;
  b: Vec2;
}

export interface Label {
  p: Vec2;
  text: string;
  height: number;
}

export interface DetectedRoom {
  polygon: Vec2[];
  name: string;
  named: boolean;
  floorMaterial: FloorMaterialKey;
  outdoor: boolean;
  labels: string[];
}

/**
 * Short links from wall ends that stop against a thicker wall or a column (so their centerlines
 * don't meet) to that wall's centerline, so the rooms on both sides close there.
 */
export function wallEndLinks(walls: { a: Vec2; b: Vec2; thickness: number }[], tol: number, boundaries: Seg[] = []): Seg[] {
  const out: Seg[] = [];
  const closest = (p: Vec2, o: Seg) => lerp2(o.a, o.b, closestT(p, o.a, o.b));
  // Room boundary lines (railings, open-plan lines) often stop at a wall's face too.
  const all = [...walls, ...boundaries.map((b) => ({ ...b, thickness: 0 }))];
  for (const w of all) {
    // A wall end touching anything is joined; a boundary line must reach a wall itself.
    const joinedTo = w.thickness > 0 ? all : walls;
    for (const p of [w.a, w.b]) {
      if (joinedTo.some((o) => o !== w && dist(p, closest(p, o)) <= tol)) continue;
      let best: { q: Vec2; d: number } | null = null;
      for (const o of walls) {
        if (o === w) continue;
        const q = closest(p, o);
        const d = dist(p, q);
        if (d <= o.thickness / 2 + w.thickness / 2 + 0.1 && (!best || d < best.d)) best = { q, d };
      }
      if (best) out.push({ a: p, b: best.q });
    }
  }
  return out;
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

/** Bounded faces of the segment arrangement, counterclockwise. */
export function findFaces(segsIn: Seg[], tol: number, minArea = 1.0): Vec2[][] {
  return traceFaces(segsIn, tol)
    .filter((f) => signedArea(f) > minArea)
    .map((f) => simplify(f, tol));
}

/** Outer boundary of the segment arrangement (its largest clockwise face), counterclockwise. */
export function outerOutline(segsIn: Seg[], tol: number): Vec2[] | null {
  const faces = traceFaces(segsIn, tol).filter((f) => signedArea(f) < -1);
  if (faces.length === 0) return null;
  faces.sort((a, b) => signedArea(a) - signedArea(b));
  return simplify(faces[0].slice().reverse(), tol);
}

function traceFaces(segsIn: Seg[], tol: number): Vec2[][] {
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

/** Drops collinear points and spikes. */
function simplify(poly: Vec2[], tol: number): Vec2[] {
  let pts = poly.slice();
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i - 1 + pts.length) % pts.length];
      const q = pts[i];
      const r = pts[(i + 1) % pts.length];
      const area2 = Math.abs((q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y));
      if (area2 <= tol * Math.max(dist(p, r), 1e-6) || dist(p, r) < tol) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  pts = ensureCCW(pts);
  return pts;
}

// ---- naming and materials -------------------------------------------------------------------

const AREA_TEXT = /^[\d\s.,]+(m²|m2|sqm|sq\.?\s?m|m\^2|م²|م2|م\.م)?$/i;
/** Level marks and dimensions (+2.75, -0.15, 510): never room names. */
export const LEVEL_TEXT = /^[+\-±]?\s*\d+([.,]\d+)?$/;

/** Texts that can name a room. */
export const isNameText = (t: string): boolean => !!t && !AREA_TEXT.test(t) && !LEVEL_TEXT.test(t.trim()) && t.length <= 48;

const MATERIAL_RULES: { key: FloorMaterialKey; outdoor?: boolean; words: RegExp[] }[] = [
  { key: 'concrete', outdoor: true, words: [/balcon/i, /terrace/i, /\bdeck\b/i, /loggia/i, /patio/i, /شرفة/, /بلكون/, /بلكونة/, /تراس/, /شرفه/] },
  { key: 'tile', words: [/bath/i, /\bwc\b/i, /toilet/i, /shower/i, /powder/i, /laund/i, /utility/i, /حمام/, /دورة مياه/, /مرحاض/, /غسيل/] },
  { key: 'tile', words: [/kitchen/i, /kitch/i, /pantry/i, /مطبخ/] },
  { key: 'oak', words: [/bed/i, /master/i, /غرفة نوم/, /نوم/] },
];

export function materialFor(name: string): { floorMaterial: FloorMaterialKey; outdoor: boolean } {
  for (const r of MATERIAL_RULES) if (r.words.some((w) => w.test(name))) return { floorMaterial: r.key, outdoor: !!r.outdoor };
  return { floorMaterial: 'oak', outdoor: false };
}

/** Assigns names from labels: inside the room first (largest text, then nearest the centre). */
export function nameRooms(polys: Vec2[][], labels: Label[]): DetectedRoom[] {
  const usable = labels.filter((l) => isNameText(l.text));
  let n = 0;
  return polys.map((polygon) => {
    const inside = usable.filter((l) => pointInPolygon(l.p, polygon));
    let label: Label | null = null;
    if (inside.length > 0) {
      const c = polygonCentroid(polygon);
      label = inside.slice().sort((a, b) => b.height - a.height || dist(a.p, c) - dist(b.p, c))[0];
    } else {
      // Nearest label within half a metre of the outline that doesn't name another room.
      let best = 0.5;
      for (const l of usable) {
        const d = distanceToPolygonEdges(l.p, polygon);
        if (d < best && !pointInPolygon(l.p, polygon) && !polys.some((o) => o !== polygon && pointInPolygon(l.p, o))) {
          best = d;
          label = l;
        }
      }
    }
    const named = !!label;
    const name = label ? label.text : `Room ${++n}`;
    const m = materialFor(name);
    return { polygon, name, named, floorMaterial: m.floorMaterial, outdoor: m.outdoor, labels: [...new Set(inside.map((l) => l.text))] };
  });
}

export function detectRooms(segs: Seg[], labels: Label[], tol: number): DetectedRoom[] {
  const faces = findFaces(segs, tol).filter((f) => {
    const a = polygonArea(f);
    // Slivers: very thin faces (wall gaps, doubled lines).
    let per = 0;
    for (let i = 0; i < f.length; i++) per += dist(f[i], f[(i + 1) % f.length]);
    return a >= 1.0 && a / per > 0.2;
  });
  return nameRooms(faces, labels);
}
