import type { Furniture, Vec2 } from '../schema';
import { matchFurnitureType } from '../../geometry/furniture/registry';
import { pieceFor } from '../../geometry/furniture/library';
import { add, angleOf, closestT, dist, dot, lerp2, minAreaRect, normalize, perp, pointInPolygon, scale, sub } from '../../util/math2d';

/**
 * Q9: furniture blocks are matched by block and layer name (English and Arabic) to the procedural
 * pieces, scaled to the block's footprint and turned to match. Unknown blocks become a neutral
 * low volume in their footprint.
 *
 * Imported drawings also hold furniture as loose line work (an exploded bed on an equipment
 * layer) and blocks that hold several pieces (a dining table with its chairs, two beds). Line work
 * is split into connected pieces; each piece is typed by its block name or its size, and turned so
 * its back is against the nearest wall (beds: the head; chairs: facing their table).
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

// ---- pieces from line work ----------------------------------------------------------------------

export interface Stroke {
  a: Vec2;
  b: Vec2;
}

export interface PieceRect {
  center: Vec2;
  /** Unit direction of the `w` side. */
  dir: Vec2;
  w: number;
  d: number;
  corners: Vec2[];
  /** Total drawn length, for telling an L shape from a full rectangle. */
  ink: Vec2[];
}

const segDist = (p: Stroke, q: Stroke): number => {
  const d = (x: Vec2, s: Stroke) => dist(x, lerp2(s.a, s.b, closestT(x, s.a, s.b)));
  // Crossing segments are at distance zero.
  const o = (a: Vec2, b: Vec2, c: Vec2) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  if (o(p.a, p.b, q.a) * o(p.a, p.b, q.b) < 0 && o(q.a, q.b, p.a) * o(q.a, q.b, p.b) < 0) return 0;
  return Math.min(d(p.a, q), d(p.b, q), d(q.a, p), d(q.b, p));
};

/** Connected groups of strokes (touching within `tol`). */
export function strokeGroups(strokes: Stroke[], tol = 0.015): Stroke[][] {
  const parent = strokes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cell = 0.25;
  const grid = new Map<string, number[]>();
  strokes.forEach((s, i) => {
    const x0 = Math.floor((Math.min(s.a.x, s.b.x) - tol) / cell);
    const x1 = Math.floor((Math.max(s.a.x, s.b.x) + tol) / cell);
    const y0 = Math.floor((Math.min(s.a.y, s.b.y) - tol) / cell);
    const y1 = Math.floor((Math.max(s.a.y, s.b.y) + tol) / cell);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        const list = grid.get(k) ?? [];
        for (const j of list) if (find(i) !== find(j) && segDist(s, strokes[j]) <= tol) parent[find(i)] = find(j);
        list.push(i);
        grid.set(k, list);
      }
  });
  const out = new Map<number, Stroke[]>();
  strokes.forEach((s, i) => {
    const r = find(i);
    const g = out.get(r) ?? [];
    g.push(s);
    out.set(r, g);
  });
  return [...out.values()];
}

/** The direction most of the strokes run along (or across), when there is one. */
function dominantDirection(strokes: Stroke[]): Vec2 | null {
  const bins = new Array(90).fill(0);
  let total = 0;
  for (const s of strokes) {
    const l = dist(s.a, s.b);
    let a = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
    a = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    bins[Math.floor((a / (Math.PI / 2)) * 90) % 90] += l;
    total += l;
  }
  let best = 0;
  for (let i = 1; i < 90; i++) if (bins[i] + bins[(i + 89) % 90] > bins[best] + bins[(best + 89) % 90]) best = i;
  const share = (bins[best] + bins[(best + 89) % 90] + bins[(best + 1) % 90]) / Math.max(1e-9, total);
  if (share < 0.5) return null;
  // Length-weighted mean angle within the winning bins.
  let sx = 0;
  let sy = 0;
  for (const s of strokes) {
    let a = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
    a = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    const k = Math.floor((a / (Math.PI / 2)) * 90) % 90;
    if (Math.abs(((k - best + 135) % 90) - 45) > 1) continue;
    const l = dist(s.a, s.b);
    sx += Math.cos(a * 4) * l;
    sy += Math.sin(a * 4) * l;
  }
  const a = Math.atan2(sy, sx) / 4;
  return { x: Math.cos(a), y: Math.sin(a) };
}

function rectInFrame(pts: Vec2[], dir: Vec2): PieceRect {
  const n = perp(dir);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const p of pts) {
    const u = dot(p, dir);
    const v = dot(p, n);
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const P = (u: number, v: number) => add(scale(dir, u), scale(n, v));
  return { center: P((u0 + u1) / 2, (v0 + v1) / 2), dir, w: u1 - u0, d: v1 - v0, corners: [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], ink: pts };
}

/** Rectangle around line work: squared to its main direction, else the tightest one. */
function strokeRect(g: Stroke[]): PieceRect | null {
  const pts = g.flatMap((s) => [s.a, s.b]);
  const dir = dominantDirection(g);
  if (dir) return rectInFrame(pts, dir);
  const r = minAreaRect(pts);
  return r ? { center: r.center, dir: r.dir, w: r.w, d: r.d, corners: r.corners, ink: pts } : null;
}

/** Covered share of the segment p to q by strokes lying along it (within 2 cm). */
function coverage(p: Vec2, q: Vec2, strokes: Stroke[]): number {
  const l = dist(p, q);
  if (l < 1e-6) return 0;
  const d = scale(sub(q, p), 1 / l);
  const n = perp(d);
  const iv: [number, number][] = [];
  for (const s of strokes) {
    if (Math.abs(dot(sub(s.a, p), n)) > 0.02 || Math.abs(dot(sub(s.b, p), n)) > 0.02) continue;
    const a = dot(sub(s.a, p), d);
    const b = dot(sub(s.b, p), d);
    iv.push([Math.max(0, Math.min(a, b)), Math.min(l, Math.max(a, b))]);
  }
  iv.sort((x, y) => x[0] - y[0]);
  let cov = 0;
  let cur = 0;
  for (const [a, b] of iv) {
    if (b <= cur) continue;
    cov += b - Math.max(a, cur);
    cur = b;
  }
  return cov / l;
}

/**
 * Bed-sized rectangles (0.8 to 2.1 m by 1.8 to 2.4 m) whose four sides are drawn, in line work that
 * holds several pieces joined by shared lines (beds side by side with a common head line).
 */
export function findBedRects(strokes: Stroke[], dir: Vec2): PieceRect[] {
  const n = perp(dir);
  const along = strokes.filter((s) => dist(s.a, s.b) > 0.3 && Math.abs(dot(normalize(sub(s.b, s.a)), dir)) > 0.999);
  const across = strokes.filter((s) => dist(s.a, s.b) > 0.3 && Math.abs(dot(normalize(sub(s.b, s.a)), n)) > 0.999);
  const uniq = (vals: number[]) => vals.sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > 0.02);
  const us = uniq(across.map((s) => dot(s.a, dir)));
  const vs = uniq(along.map((s) => dot(s.a, n)));
  const P = (u: number, v: number) => add(scale(dir, u), scale(n, v));
  const found: { r: PieceRect; score: number }[] = [];
  for (let i = 0; i < us.length; i++)
    for (let j = i + 1; j < us.length; j++) {
      const w = us[j] - us[i];
      if (w < 0.8 || w > 2.4) continue;
      for (let k = 0; k < vs.length; k++)
        for (let m = k + 1; m < vs.length; m++) {
          const d = vs[m] - vs[k];
          const bed = (w >= 0.8 && w <= 2.1 && d >= 1.8 && d <= 2.4) || (d >= 0.8 && d <= 2.1 && w >= 1.8 && w <= 2.4);
          if (!bed) continue;
          const c = [P(us[i], vs[k]), P(us[j], vs[k]), P(us[j], vs[m]), P(us[i], vs[m])];
          const all = [...along, ...across];
          const cov = Math.min(coverage(c[0], c[1], all), coverage(c[1], c[2], all), coverage(c[2], c[3], all), coverage(c[3], c[0], all));
          if (cov < 0.85) continue;
          found.push({ r: { center: P((us[i] + us[j]) / 2, (vs[k] + vs[m]) / 2), dir, w, d, corners: c, ink: [] }, score: cov * 10 - w * d * 0.01 });
        }
    }
  found.sort((a, b) => b.score - a.score);
  const out: PieceRect[] = [];
  const overlaps = (a: PieceRect, b: PieceRect) => {
    const ua = a.corners.map((p) => dot(p, dir));
    const va = a.corners.map((p) => dot(p, n));
    const ub = b.corners.map((p) => dot(p, dir));
    const vb = b.corners.map((p) => dot(p, n));
    const ou = Math.min(Math.max(...ua), Math.max(...ub)) - Math.max(Math.min(...ua), Math.min(...ub));
    const ov = Math.min(Math.max(...va), Math.max(...vb)) - Math.max(Math.min(...va), Math.min(...vb));
    return ou > 0.05 && ov > 0.05;
  };
  for (const f of found) if (!out.some((o) => overlaps(o, f.r))) out.push(f.r);
  return out;
}

/** Splits a group into the beds drawn in it and whatever line work is left around them. */
function splitBeds(g: Stroke[]): { beds: PieceRect[]; rest: Stroke[] } | null {
  const dir = dominantDirection(g);
  if (!dir) return null;
  const whole = rectInFrame(g.flatMap((s) => [s.a, s.b]), dir);
  // Only line work bigger than one bed is worth splitting.
  if (whole.w * whole.d < 1.15 * 2.4 || Math.min(whole.w, whole.d) < 1.8) return null;
  const beds = findBedRects(g, dir);
  if (beds.length < 2) return null;
  const inside = (p: Vec2) => beds.some((b) => pointInPolygon(p, grow(b.corners, 0.03)));
  for (const b of beds) b.ink = g.flatMap((s) => [s.a, s.b]).filter((p) => pointInPolygon(p, grow(b.corners, 0.03)));
  return { beds, rest: g.filter((s) => !(inside(s.a) && inside(s.b))) };
}

/**
 * Rectangles of stroke groups (furniture line work); groups lying inside a bigger rectangle join it.
 * Beds drawn side by side in one group are split apart, and pieces drawn open against a wall (a
 * wardrobe as a front and two short sides) reach back to that wall when `faces` are given.
 */
export function pieceRects(groups: Stroke[][], faces: Stroke[] = []): PieceRect[] {
  const rects: PieceRect[] = [];
  const queue = groups.slice();
  while (queue.length) {
    const g = queue.shift()!;
    const split = splitBeds(g);
    if (split) {
      rects.push(...split.beds);
      if (split.rest.length) queue.push(...strokeGroups(split.rest));
      continue;
    }
    const r = strokeRect(g);
    if (r && r.w > 0.05 && r.d > 0.05) rects.push(faces.length ? toWall(r, g, faces) : r);
  }
  rects.sort((a, b) => b.w * b.d - a.w * a.d);
  const out: PieceRect[] = [];
  for (const r of rects) {
    const host = out.find((o) => r.corners.every((p) => pointInPolygon(p, grow(o.corners, 0.03))));
    if (host) host.ink.push(...r.ink);
    else out.push(r);
  }
  return out;
}

/** An outline left open on one side (its free line ends all on that side) reaches to a wall there. */
function toWall(r: PieceRect, g: Stroke[], faces: Stroke[]): PieceRect {
  const ends = g.flatMap((s) => [s.a, s.b]);
  const free = ends.filter((p) => ends.filter((q) => dist(p, q) < 0.01).length === 1);
  if (free.length < 2) return r;
  const u = r.dir;
  const v = perp(u);
  const uc = dot(r.center, u);
  const vc = dot(r.center, v);
  const sides = [
    { n: v, at: vc + r.d / 2, coord: (p: Vec2) => dot(p, v) },
    { n: scale(v, -1), at: -(vc - r.d / 2), coord: (p: Vec2) => -dot(p, v) },
    { n: u, at: uc + r.w / 2, coord: (p: Vec2) => dot(p, u) },
    { n: scale(u, -1), at: -(uc - r.w / 2), coord: (p: Vec2) => -dot(p, u) },
  ];
  const side = sides.find((s) => free.every((p) => Math.abs(s.coord(p) - s.at) < 0.03));
  if (!side) return r;
  // Nearest wall face beyond that side, parallel to it and overlapping the piece.
  let reach = Infinity;
  const tangent = perp(side.n);
  const t0 = Math.min(...r.corners.map((p) => dot(p, tangent)));
  const t1 = Math.max(...r.corners.map((p) => dot(p, tangent)));
  for (const f of faces) {
    if (Math.abs(dot(normalize(sub(f.b, f.a)), side.n)) > 0.03) continue;
    const off = dot(f.a, side.n) - side.at;
    if (off < 0.02 || off > 0.8) continue;
    const fa = dot(f.a, tangent);
    const fb = dot(f.b, tangent);
    if (Math.min(t1, Math.max(fa, fb)) - Math.max(t0, Math.min(fa, fb)) < (t1 - t0) * 0.6) continue;
    reach = Math.min(reach, off);
  }
  if (!Number.isFinite(reach)) return r;
  const pts = [...r.corners, ...r.corners.map((p) => add(p, scale(side.n, reach)))];
  const out = rectInFrame(pts, r.dir);
  out.ink = r.ink;
  return out;
}

function grow(corners: Vec2[], m: number): Vec2[] {
  const c = scale(corners.reduce((a, p) => add(a, p), { x: 0, y: 0 }), 1 / corners.length);
  return corners.map((p) => add(p, scale(normalize(sub(p, c)), m * Math.SQRT2)));
}

export interface PlaceContext {
  /** Wall faces (both sides of every wall), meters. */
  faces: Stroke[];
  /** Tables placed so far, for turning chairs to them. */
  tables: { center: Vec2 }[];
  /** True when the piece sits in a room with a toilet or basin. */
  wet?: boolean;
}

const BACK_TO_WALL = new Set(['sofa', 'armchair', 'wardrobe', 'wc', 'vanity', 'bathtub', 'shower', 'tv-unit', 'sideboard', 'desk', 'bookshelf', 'kitchen-counter', 'kitchen-sink', 'kitchen-hob', 'fridge', 'nightstand', 'cabinet', 'wall-cabinet', 'bench']);

/** A type for an unnamed piece of line work, from its size (and whether the room is wet). */
export function typeBySize(long: number, short: number, wet: boolean): string {
  if (long >= 1.8 && long <= 2.4 && short >= 0.8 && short <= 1.25) return 'bed-single';
  if (long >= 1.8 && long <= 2.4 && short > 1.25 && short <= 2.1) return 'bed-double';
  if (wet) {
    if (long >= 1.4 && long <= 1.95 && short >= 0.68 && short <= 0.95) return 'bathtub';
    if (long >= 0.7 && long <= 1.95 && short >= 0.5 && short <= 1.2) return 'shower';
  }
  if (short >= 0.45 && short <= 0.75 && long >= 0.9 && long <= 6) return 'wardrobe';
  return 'box';
}

/** Distance from a side of the rectangle (its midpoint) to the nearest wall face that runs along it. */
function sideToWall(mid: Vec2, along: Vec2, faces: Stroke[]): number {
  let best = Infinity;
  for (const f of faces) {
    const fd = normalize(sub(f.b, f.a));
    if (Math.abs(dot(fd, along)) < 0.97) continue;
    const t = closestT(mid, f.a, f.b);
    const q = lerp2(f.a, f.b, t);
    // The face must reach past the side's midpoint (or nearly).
    if (dist(mid, q) - Math.abs(dot(sub(mid, q), perp(fd))) > 0.25) continue;
    best = Math.min(best, dist(mid, q));
  }
  return best;
}

/**
 * Places a typed piece on a rectangle: picks which side is the front and sizes it so the library's
 * width runs along the front. Beds put their head to the wall; pieces that stand against a wall
 * put their back to it; chairs face the nearest table.
 */
export function placePiece(type: string, r: PieceRect, ctx: PlaceContext, id: string, label: string): Furniture {
  const u = r.dir;
  const v = perp(u);
  const sides = [
    { n: v, len: r.w, mid: add(r.center, scale(v, r.d / 2)), along: u },
    { n: scale(v, -1), len: r.w, mid: add(r.center, scale(v, -r.d / 2)), along: u },
    { n: u, len: r.d, mid: add(r.center, scale(u, r.w / 2)), along: v },
    { n: scale(u, -1), len: r.d, mid: add(r.center, scale(u, -r.w / 2)), along: v },
  ];
  let back = sides[0];
  if (type === 'bed-single' || type === 'bed-double') {
    // The head is a short side; the one against a wall.
    const ends = r.w >= r.d ? [sides[2], sides[3]] : [sides[0], sides[1]];
    back = sideToWall(ends[0].mid, ends[0].along, ctx.faces) <= sideToWall(ends[1].mid, ends[1].along, ctx.faces) ? ends[0] : ends[1];
  } else if ((type === 'chair' || type === 'armchair') && ctx.tables.length) {
    const t = ctx.tables.slice().sort((a, b) => dist(a.center, r.center) - dist(b.center, r.center))[0];
    if (dist(t.center, r.center) < 1.6 && type === 'chair') {
      const to = normalize(sub(t.center, r.center));
      back = sides.slice().sort((a, b) => dot(a.n, to) - dot(b.n, to))[0];
    } else back = nearestWallSide(sides, ctx.faces) ?? back;
  } else if (BACK_TO_WALL.has(type) || type === 'chair' || type === 'armchair') {
    // Long pieces (counters, wardrobes) back onto a long side.
    const cands = type === 'wardrobe' || type.startsWith('kitchen') || type === 'sideboard' || type === 'tv-unit' || type === 'bathtub' ? sides.filter((s) => s.len >= Math.max(r.w, r.d) - 1e-6) : sides;
    back = nearestWallSide(cands, ctx.faces) ?? cands[0];
  } else {
    // Tables and the like: width along the long side.
    back = r.w >= r.d ? sides[0] : sides[2];
  }
  const front = scale(back.n, -1);
  const width = back.len;
  const depth = back === sides[0] || back === sides[1] ? r.d : r.w;
  const def = pieceFor(type);
  return {
    id,
    type,
    position: r.center,
    rotation: Math.atan2(front.y, front.x) + Math.PI / 2,
    size: { x: width, y: depth, z: type === 'box' ? 0.4 : def.size.z },
    label,
  };
}

function nearestWallSide<T extends { mid: Vec2; along: Vec2 }>(sides: T[], faces: Stroke[]): T | null {
  let best: T | null = null;
  let bestD = 0.35;
  for (const s of sides) {
    const d = sideToWall(s.mid, s.along, faces);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/**
 * An L-shaped sofa (a sofa block whose footprint is deep on both sides): two straight sofas along
 * the two sides the drawing fills, backs on the outside. The outer corner is the one nearest the
 * middle of the drawn lines.
 */
export function lSofa(r: PieceRect, idBase: string, label: string): Furniture[] {
  const u = r.dir;
  const v = perp(u);
  const ink = r.ink.reduce((a, p) => add(a, p), { x: 0, y: 0 });
  const centroid = scale(ink, 1 / Math.max(1, r.ink.length));
  const corner = r.corners.slice().sort((a, b) => dist(a, centroid) - dist(b, centroid))[0];
  const toCenter = sub(r.center, corner);
  const su = Math.sign(dot(toCenter, u)) || 1;
  const sv = Math.sign(dot(toCenter, v)) || 1;
  const depth = Math.min(0.95, Math.min(r.w, r.d) * 0.45);
  // Arm along u (full length), back on the corner's v side.
  const backA = scale(v, -sv);
  const cA = add(corner, add(scale(u, (su * r.w) / 2), scale(v, (sv * depth) / 2)));
  const frontA = scale(backA, -1);
  // Arm along v, from the end of arm A to the far end.
  const lenB = r.d - depth;
  const backB = scale(u, -su);
  const cB = add(corner, add(scale(v, sv * (depth + lenB / 2)), scale(u, (su * depth) / 2)));
  const frontB = scale(backB, -1);
  const z = pieceFor('sofa').size.z;
  return [
    { id: `${idBase}a`, type: 'sofa', position: cA, rotation: Math.atan2(frontA.y, frontA.x) + Math.PI / 2, size: { x: r.w, y: depth, z }, label },
    { id: `${idBase}b`, type: 'sofa', position: cB, rotation: Math.atan2(frontB.y, frontB.x) + Math.PI / 2, size: { x: lenB, y: depth, z }, label },
  ];
}
