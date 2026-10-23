import type { FloorMaterialKey, Vec2 } from '../schema';
import { closestT, dist, distanceToPolygonEdges, ensureCCW, lerp2, pointInPolygon, polygonArea, polygonCentroid, signedArea } from '../../util/math2d';
import { traceFaces } from '../../util/arrangement';

export { splitSegments } from '../../util/arrangement';

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
