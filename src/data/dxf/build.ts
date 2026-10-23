import type { Column, Floor, FloorPlan, Furniture, Opening, Railing, Room, Stair, Vec2, Wall } from '../schema';
import { SCHEMA_VERSION } from '../schema';
import { normalizePlan, validatePlan } from '../validate';
import { matchFurnitureType } from '../../geometry/furniture/registry';
import { add, bounds, dist, distanceToPolygonEdges, dot, minAreaRect, normalize, perp, pointInPolygon, polygonArea, polygonCentroid, scale, sub } from '../../util/math2d';
import { UNIT_LABEL, UNIT_SCALE, kindList, unitsFromContent, unitsFromInsunits } from './units';
import { extractWalls, type WallPiece } from './walls';
import { placeOpenings, resetOpeningState, type DoorCandidate, type PlacedOpening, type WindowCandidate } from './openings';
import { detectRooms, LEVEL_TEXT, materialFor, outerOutline, wallEndLinks, type DetectedRoom, type Label } from './rooms';
import { detectStair, finishStair, type DetectedStair } from './stairs';
import { findTreadRuns, stairFromRun, stairRailings, type TreadRun } from './treads';
import { furnitureFromBlock, lSofa, pieceRects, placePiece, strokeGroups, typeBySize, type PieceRect, type PlaceContext, type Stroke } from './furniture';
import { detectCounters, type Fixture } from './counters';
import { alignFloors, floorCount, floorOf } from './floors';
import { DOOR_NAME, sizeSamples } from './sizes';
import type { BuildRequest, DArc, DInsert, DrawingModel, ImportReport, LayerRole, ReportWarning, RoomKind } from './types';
import { buildReport } from './report';

type InsertKind = 'door' | 'window' | 'furniture' | 'stair' | 'explode';

const WINDOW_NAME = /(^|[^a-z])(win|window|wdw|w\d{2,4}|glaz|نافذة|نوافذ|شباك|شبابيك)([^a-z]|$)/i;
const STAIR_NAME = /(stair|درج|سلم)/i;

/** What a top-level block is: by its layer's role, by a door or window name, then by its name. */
export function classifyInsert(ins: DInsert, roles: Record<string, LayerRole>): InsertKind {
  const role = roles[ins.layer] ?? 'ignore';
  if (role === 'doors') return 'door';
  if (role === 'windows') return 'window';
  if (role === 'stairs') return 'stair';
  // A door block on a furniture layer is still a door.
  if (DOOR_NAME.test(ins.name)) return 'door';
  if (WINDOW_NAME.test(ins.name)) return 'window';
  if (role === 'furniture') return 'furniture';
  if (STAIR_NAME.test(ins.name)) return 'stair';
  if (matchFurnitureType([ins.name], ins.size.w, ins.size.d)) return 'furniture';
  return 'explode';
}

interface Seg {
  a: Vec2;
  b: Vec2;
}

interface FurnitureBlock {
  ins: DInsert;
  /** Index into model.inserts. */
  index: number;
}

interface FloorBucket {
  wallSegs: Seg[];
  /** Dashed lines on wall layers: things above the cut (cabinets, the edge of a floor above). */
  dashedSegs: Seg[];
  boundarySegs: Seg[];
  doorArcs: DArc[];
  wallArcs: DArc[];
  doorBlocks: { ins: DInsert; arcs: DArc[] }[];
  windowBlocks: DInsert[];
  windowSegs: Seg[];
  doorLineSegs: Seg[];
  furnitureBlocks: FurnitureBlock[];
  furnitureStrokes: Stroke[];
  stairSegs: Seg[];
  stairPolys: Vec2[][];
  stairTexts: { p: Vec2; text: string }[];
  labels: Label[];
  levelTexts: { p: Vec2; text: string }[];
  /** Pattern hatches: floor finishes (a tiled balcony). */
  floorHatches: Vec2[][];
  roundColumns: { c: Vec2; r: number }[];
  /** Small closed outlines standing free on wall layers: furniture, not walls. */
  looseOutlines: Vec2[][];
}

const newBucket = (): FloorBucket => ({
  wallSegs: [],
  dashedSegs: [],
  boundarySegs: [],
  doorArcs: [],
  wallArcs: [],
  doorBlocks: [],
  windowBlocks: [],
  windowSegs: [],
  doorLineSegs: [],
  furnitureBlocks: [],
  furnitureStrokes: [],
  stairSegs: [],
  stairPolys: [],
  stairTexts: [],
  labels: [],
  levelTexts: [],
  floorHatches: [],
  roundColumns: [],
  looseOutlines: [],
});

const arcEnds = (a: DArc): [Vec2, Vec2] => [
  { x: a.c.x + Math.cos(a.a0) * a.r, y: a.c.y + Math.sin(a.a0) * a.r },
  { x: a.c.x + Math.cos(a.a1) * a.r, y: a.c.y + Math.sin(a.a1) * a.r },
];

function sweep(a: DArc): number {
  let s = a.a1 - a.a0;
  while (s < 0) s += Math.PI * 2;
  return s;
}

const isCircle = (a: DArc) => a.a1 - a.a0 >= Math.PI * 2 - 1e-6;
const isSwing = (a: DArc, minR = 0.5, maxR = 1.5) => a.r >= minR && a.r <= maxR && sweep(a) > (55 * Math.PI) / 180 && sweep(a) < (125 * Math.PI) / 180;

/** Approximates an arc as line pieces (curved walls on wall layers, furniture line work). */
function arcSegments(a: DArc, step = Math.PI / 16): Seg[] {
  const s = isCircle(a) ? Math.PI * 2 : sweep(a);
  const n = Math.max(2, Math.ceil(s / step));
  const out: Seg[] = [];
  let prev = { x: a.c.x + Math.cos(a.a0) * a.r, y: a.c.y + Math.sin(a.a0) * a.r };
  for (let i = 1; i <= n; i++) {
    const t = a.a0 + (s * i) / n;
    const p = { x: a.c.x + Math.cos(t) * a.r, y: a.c.y + Math.sin(t) * a.r };
    out.push({ a: prev, b: p });
    prev = p;
  }
  return out;
}

/** Line clusters (window or glazing line work): nearby lines, each cluster one opening. */
function clusterLines(segs: Seg[]): Vec2[][] {
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = (s: Seg, t: Seg) => {
    const bs = bounds([s.a, s.b]);
    const bt = bounds([t.a, t.b]);
    return bs.minX <= bt.maxX + 0.12 && bt.minX <= bs.maxX + 0.12 && bs.minY <= bt.maxY + 0.12 && bt.minY <= bs.maxY + 0.12;
  };
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (near(segs[i], segs[j])) parent[find(i)] = find(j);
  const groups = new Map<number, Vec2[]>();
  segs.forEach((s, i) => {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(s.a, s.b);
    groups.set(r, g);
  });
  return [...groups.values()].map((pts) => {
    const b = bounds(pts);
    return [
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY },
      { x: b.minX, y: b.maxY },
    ];
  });
}

/** Separate stairs on one floor: clusters of stair-layer geometry. */
function clusterStairs(b: FloorBucket): { segs: Seg[]; polys: Vec2[][]; texts: { p: Vec2; text: string }[] }[] {
  const items = [...b.stairSegs.map((s) => ({ kind: 's' as const, s, box: bounds([s.a, s.b]) })), ...b.stairPolys.map((p) => ({ kind: 'p' as const, p, box: bounds(p) }))];
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const m = 0.4;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i].box;
      const B = items[j].box;
      if (A.minX <= B.maxX + m && B.minX <= A.maxX + m && A.minY <= B.maxY + m && B.minY <= A.maxY + m) parent[find(i)] = find(j);
    }
  const groups = new Map<number, { segs: Seg[]; polys: Vec2[][]; texts: { p: Vec2; text: string }[] }>();
  items.forEach((it, i) => {
    const r = find(i);
    const g = groups.get(r) ?? { segs: [], polys: [], texts: [] };
    if (it.kind === 's') g.segs.push(it.s);
    else g.polys.push(it.p);
    groups.set(r, g);
  });
  const out = [...groups.values()].filter((g) => g.segs.length + g.polys.length >= 3);
  for (const t of b.stairTexts) {
    const g = out.find((g) => {
      const bb = bounds([...g.segs.flatMap((s) => [s.a, s.b]), ...g.polys.flat()]);
      return t.p.x >= bb.minX - 0.3 && t.p.x <= bb.maxX + 0.3 && t.p.y >= bb.minY - 0.3 && t.p.y <= bb.maxY + 0.3;
    });
    g?.texts.push(t);
  }
  return out;
}

/** Railings for outdoor rooms along the edges that are not walls. */
function outdoorRailings(room: Room, walls: WallPiece[], id: string): Railing | null {
  const pts = room.polygon;
  const runs: Vec2[][] = [];
  let cur: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const mid = scale(add(a, b), 0.5);
    const d = normalize(sub(b, a));
    const onWall = walls.some((w) => {
      const wd = normalize(sub(w.b, w.a));
      if (Math.abs(d.x * wd.y - d.y * wd.x) > 0.05) return false;
      const t = Math.max(0, Math.min(1, dot(sub(mid, w.a), sub(w.b, w.a)) / Math.max(1e-9, dot(sub(w.b, w.a), sub(w.b, w.a)))));
      return dist(mid, add(w.a, scale(sub(w.b, w.a), t))) < w.thickness / 2 + 0.05;
    });
    if (onWall) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
      continue;
    }
    // Pull the rail 3 cm inside the room.
    const n = perp(d);
    const ia = add(a, scale(n, 0.03));
    const ib = add(b, scale(n, 0.03));
    if (cur.length === 0) cur.push(ia);
    cur.push(ib);
  }
  if (cur.length >= 2) runs.push(cur);
  const longest = runs.sort((x, y) => y.length - x.length)[0];
  return longest ? { id, points: longest, height: 1.05, style: 'glass' } : null;
}

/** Fraction of a polygon's area that lies inside any of `cover` (sampled on a grid). */
function coveredFraction(poly: Vec2[], cover: Vec2[][]): number {
  if (cover.length === 0) return 0;
  const b = bounds(poly);
  const n = 24;
  let inside = 0;
  let hit = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const p = { x: b.minX + ((b.maxX - b.minX) * (i + 0.5)) / n, y: b.minY + ((b.maxY - b.minY) * (j + 0.5)) / n };
      if (!pointInPolygon(p, poly)) continue;
      inside++;
      if (cover.some((c) => pointInPolygon(p, c))) hit++;
    }
  return inside ? hit / inside : 0;
}

const shiftRun = (run: TreadRun, o: Vec2): TreadRun => {
  const du = dot(o, run.along);
  const dt = dot(o, run.across);
  return { ...run, outline: run.outline.map((p) => add(p, o)), positions: run.positions.map((u) => u + du), t0: run.t0 + dt, t1: run.t1 + dt };
};

const shiftStair = (ds: DetectedStair, T: (p: Vec2) => Vec2): DetectedStair => ({
  ...ds,
  outline: ds.outline.map(T),
  flights: ds.flights.map((f) => ({ ...f, start: T(f.start) })),
  landings: ds.landings.map((l) => ({ ...l, polygon: l.polygon.map(T) })),
});

/** Wall faces (both sides of every wall piece), for turning furniture to the walls. */
const wallFaces = (walls: WallPiece[]): Stroke[] =>
  walls.flatMap((w) => {
    const d = normalize(sub(w.b, w.a));
    const n = scale(perp(d), w.thickness / 2);
    return [
      { a: add(w.a, n), b: add(w.b, n) },
      { a: sub(w.a, n), b: sub(w.b, n) },
    ];
  });

/** Room names from what is in a room. */
function nameFromContents(types: string[]): string | null {
  const has = (...t: string[]) => types.some((x) => t.includes(x));
  if (has('bed-single', 'bed-double')) return 'Bedroom';
  if (has('wc', 'bathtub', 'shower')) return 'Bathroom';
  const kitchen = has('kitchen-sink', 'kitchen-hob', 'kitchen-counter', 'fridge');
  const dining = has('dining-table');
  const living = has('sofa');
  if (kitchen && dining) return 'Kitchen and dining';
  if (kitchen) return 'Kitchen';
  if (living && dining) return 'Living and dining';
  if (living) return 'Living room';
  if (dining) return 'Dining';
  if (has('vanity')) return 'Bathroom';
  return null;
}

export interface BuildResult {
  plan: FloorPlan;
  report: ImportReport;
}

interface FloorWork {
  id: string;
  o: Vec2;
  walls: WallPiece[];
  opened: PlacedOpening[];
  detected: DetectedRoom[];
  rooms: Room[];
  outline: Vec2[] | null;
  runs: TreadRun[];
  layerStairs: DetectedStair[];
  railings: Vec2[][];
  counterFurniture: Omit<Furniture, 'id'>[];
  usedFixtures: Set<number>;
  addedDoorways: Room[];
}

export function buildPlan(model: DrawingModel, req: BuildRequest): BuildResult {
  resetOpeningState();
  const s = UNIT_SCALE[req.settings.units];
  const S = (p: Vec2): Vec2 => ({ x: p.x * s, y: p.y * s });
  const roles = req.roles;
  const hidden = new Set(req.hidden);
  const roleOf = (layer: string): LayerRole => (hidden.has(layer) ? 'ignore' : (roles[layer] ?? 'ignore'));
  const nFloors = floorCount(req.floors);
  const buckets: FloorBucket[] = Array.from({ length: nFloors }, newBucket);
  const warnings: ReportWarning[] = model.warnings.map((m) => ({ kind: 'general' as const, message: m }));
  const notes: string[] = [];
  const fl = (layer: string, p: Vec2) => floorOf(req.floors, layer, p);
  const st = req.settings;
  const centerOf = (pts: Vec2[]) => scale(pts.reduce((a, p) => add(a, p), { x: 0, y: 0 }), 1 / Math.max(1, pts.length));

  const kinds = model.inserts.map((ins) => (hidden.has(ins.layer) || roleOf(ins.layer) === 'ignore' ? ('ignore' as const) : classifyInsert(ins, roles)));
  const claimed = (insert: number) => insert >= 0 && (kinds[insert] === 'door' || kinds[insert] === 'window' || kinds[insert] === 'furniture' || kinds[insert] === 'ignore');
  // A block belongs to the floor its drawn footprint is on (its insertion point can be anywhere).
  const insertPoint = (ins: DInsert) => centerOf(ins.footprint ?? ins.corners);

  // Closed shapes on wall layers: pattern hatches are floor finishes, small free-standing outlines
  // are furniture, everything else (solid hatches, wall outlines) stays wall line work.
  const skipPoly = new Set<number>();
  const roundColumnsRaw: { k: number; c: Vec2; r: number }[] = [];
  for (const a of model.arcs) {
    if (a.insert >= 0 || roleOf(a.layer) !== 'walls' || !isCircle(a)) continue;
    const r = a.r * s;
    if (r < 0.1 || r > 0.6) continue;
    const k = fl(a.layer, a.c);
    if (k >= 0 && k < nFloors) roundColumnsRaw.push({ k, c: S(a.c), r });
  }
  model.polys.forEach((p, pi) => {
    if (p.insert >= 0 || !p.closed || roleOf(p.layer) !== 'walls') return;
    const k = fl(p.layer, p.points[0]);
    if (k < 0 || k >= nFloors) return;
    const pts = p.points.map(S);
    if (p.source === 'hatch' && !p.solid) {
      buckets[k].floorHatches.push(pts);
      skipPoly.add(pi);
      return;
    }
    // A hatch filling a round column is part of the column.
    const c = centerOf(pts);
    if (roundColumnsRaw.some((rc) => rc.k === k && dist(rc.c, c) < rc.r * 0.6)) {
      skipPoly.add(pi);
      return;
    }
    if (p.source === 'polyline') {
      const b = bounds(pts);
      if (b.maxX - b.minX <= 1 && b.maxY - b.minY <= 1) buckets[k].looseOutlines.push(pts);
    }
  });
  for (const rc of roundColumnsRaw) buckets[rc.k].roundColumns.push({ c: rc.c, r: rc.r });

  for (const seg of model.segs) {
    if (claimed(seg.insert)) continue;
    if (seg.poly >= 0 && skipPoly.has(seg.poly)) continue;
    const role = seg.insert >= 0 && kinds[seg.insert] === 'stair' ? 'stairs' : roleOf(seg.layer);
    const k = fl(seg.layer, scale(add(seg.a, seg.b), 0.5));
    if (k < 0 || k >= nFloors) continue;
    const b = buckets[k];
    const ms = { a: S(seg.a), b: S(seg.b) };
    if (role === 'walls') (seg.dashed ? b.dashedSegs : b.wallSegs).push(ms);
    else if (role === 'rooms') b.boundarySegs.push(ms);
    else if (role === 'windows') b.windowSegs.push(ms);
    else if (role === 'doors' && seg.insert < 0) b.doorLineSegs.push(ms);
    else if (role === 'furniture' && seg.insert < 0) b.furnitureStrokes.push(ms);
    // Stair outlines arrive as polygons; keep only loose stair lines (risers, arrows) as segments.
    else if (role === 'stairs' && (seg.poly < 0 || !model.polys[seg.poly]?.closed)) b.stairSegs.push(ms);
  }
  for (const p of model.polys) {
    if (claimed(p.insert)) continue;
    const role = p.insert >= 0 && kinds[p.insert] === 'stair' ? 'stairs' : roleOf(p.layer);
    const k = fl(p.layer, p.points[0]);
    if (k < 0 || k >= nFloors) continue;
    if (role === 'stairs') buckets[k].stairPolys.push(p.points.map(S));
  }
  for (const a of model.arcs) {
    const k = fl(a.layer, a.c);
    if (k < 0 || k >= nFloors) continue;
    const ma: DArc = { ...a, c: S(a.c), r: a.r * s };
    if (a.insert >= 0 && kinds[a.insert] === 'door') continue; // handled with its block
    if (claimed(a.insert)) continue;
    const role = roleOf(a.layer);
    if (role === 'doors') buckets[k].doorArcs.push(ma);
    else if (role === 'walls') {
      if (isCircle(a)) continue;
      if (isSwing(ma, 0.55, 1.3)) buckets[k].doorArcs.push(ma);
      else buckets[k].wallArcs.push(ma);
    } else if (role === 'furniture' && a.insert < 0) buckets[k].furnitureStrokes.push(...arcSegments(ma, Math.PI / 24));
  }
  model.inserts.forEach((ins, i) => {
    const kind = kinds[i];
    const k = fl(ins.layer, insertPoint(ins));
    if (k < 0 || k >= nFloors) return;
    const mi: DInsert = {
      ...ins,
      position: S(ins.position),
      corners: ins.corners.map(S),
      size: { w: ins.size.w * s, d: ins.size.d * s },
      ...(ins.footprint ? { footprint: ins.footprint.map(S) } : {}),
    };
    if (kind === 'door') {
      const arcs = model.arcs.filter((a) => a.insert === i).map((a) => ({ ...a, c: S(a.c), r: a.r * s }));
      buckets[k].doorBlocks.push({ ins: mi, arcs });
    } else if (kind === 'window') buckets[k].windowBlocks.push(mi);
    else if (kind === 'furniture') buckets[k].furnitureBlocks.push({ ins: mi, index: i });
  });
  for (const t of model.texts) {
    if (t.insert >= 0) continue;
    const role = roleOf(t.layer);
    const k = fl(t.layer, t.p);
    if (k < 0 || k >= nFloors) continue;
    if (LEVEL_TEXT.test(t.text.trim()) && role !== 'ignore') buckets[k].levelTexts.push({ p: S(t.p), text: t.text.trim() });
    if (role === 'stairs') buckets[k].stairTexts.push({ p: S(t.p), text: t.text });
    else if (role === 'walls' || role === 'rooms') buckets[k].labels.push({ p: S(t.p), text: t.text, height: t.height * s });
  }

  // Small closed outlines on wall layers that touch no wall are furniture (a side table), not walls.
  for (const b of buckets) {
    b.looseOutlines = b.looseOutlines.filter((pts) => {
      const own = (q: Seg) => pts.some((p) => dist(p, q.a) < 1e-6) && pts.some((p) => dist(p, q.b) < 1e-6);
      const touches = b.wallSegs.some((q) => {
        if (own(q)) return false;
        return pts.some((p) => distanceToPolygonEdges(p, [q.a, q.b]) < 0.03) || [q.a, q.b].some((p) => distanceToPolygonEdges(p, pts) < 0.03);
      });
      if (touches) return false;
      b.wallSegs = b.wallSegs.filter((q) => !own(q));
      return true;
    });
  }

  // Stairs first, per floor, for alignment: stair-layer clusters and tread runs drawn on wall layers.
  const runsPerFloor: TreadRun[][] = [];
  const railsPerFloor: { railings: Vec2[][]; boundaries: Seg[] }[] = [];
  const stairsPerFloor: DetectedStair[][] = buckets.map((b) => {
    const out: DetectedStair[] = [];
    for (const c of clusterStairs(b)) {
      const ds = detectStair(c);
      if (ds) out.push(ds);
    }
    const runs = findTreadRuns(b.wallSegs);
    const used = new Set<number>();
    for (const r of runs) for (const i of r.used) used.add(i);
    const rails = stairRailings(b.wallSegs, runs, used);
    for (const i of rails.used) used.add(i);
    b.wallSegs = b.wallSegs.filter((_, i) => !used.has(i));
    runsPerFloor.push(runs);
    railsPerFloor.push({ railings: rails.railings, boundaries: rails.boundaries });
    return out;
  });
  const stairCenter = (k: number) => {
    const ds = stairsPerFloor[k][0];
    if (ds) return polygonCentroid(ds.outline);
    const run = runsPerFloor[k][0];
    return run ? polygonCentroid(run.outline) : null;
  };
  const wallCorner = (k: number) => {
    const pts = buckets[k].wallSegs.flatMap((x) => [x.a, x.b]);
    if (pts.length === 0) return null;
    const b = bounds(pts);
    return { x: b.minX, y: b.minY };
  };
  const align = alignFloors({
    stairCenters: buckets.map((_, k) => stairCenter(k)),
    cornerOf: buckets.map((_, k) => wallCorner(k)),
    boxes: req.floors.mode === 'boxes' ? req.floors.boxes?.map((b) => ({ minX: b.minX * s, minY: b.minY * s, maxX: b.maxX * s, maxY: b.maxY * s })) : undefined,
    labels: buckets.map((b) => b.levelTexts),
    vertices: buckets.map((b) => b.wallSegs.flatMap((x) => [x.a, x.b])),
  });
  if (nFloors > 1) for (const m of align.warnings) warnings.push({ kind: 'floor', message: m });

  // Shift everything so the lowest floor's walls start near the origin (nicer numbers, same shape).
  const base = wallCorner(0) ?? { x: 0, y: 0 };
  const shift = (k: number) => ({ x: align.offsets[k].x - base.x, y: align.offsets[k].y - base.y });

  // ---- pass 1: walls, openings and rooms per floor ------------------------------------------------
  const work: FloorWork[] = [];
  for (let k = 0; k < nFloors; k++) {
    const b = buckets[k];
    const o = shift(k);
    const T = (p: Vec2): Vec2 => ({ x: p.x + o.x, y: p.y + o.y });
    const id = `F${k + 1}`;
    // Door leaves drawn as plain lines next to their swing arcs are not walls.
    const swings = b.doorArcs;
    const isLeaf = (x: Seg) =>
      swings.some((arc) => {
        const l = dist(x.a, x.b);
        if (Math.abs(l - arc.r) > arc.r * 0.08 + st.tolerance) return false;
        const [e0, e1] = arcEnds(arc);
        const tip = dist(x.a, arc.c) < Math.max(0.03, st.tolerance * 1.5) ? x.b : dist(x.b, arc.c) < Math.max(0.03, st.tolerance * 1.5) ? x.a : null;
        return !!tip && Math.min(dist(tip, e0), dist(tip, e1)) < arc.r * 0.08 + st.tolerance;
      });
    const wallInput = [...b.wallSegs.filter((x) => !isLeaf(x)), ...b.wallArcs.flatMap((a) => arcSegments(a))].map((x) => ({ a: T(x.a), b: T(x.b) }));
    if (wallInput.length === 0) {
      warnings.push({ kind: 'general', message: `Floor ${k + 1} has no walls on the layers mapped to Walls.` });
    }
    const wr = extractWalls(wallInput, { tolerance: st.tolerance, defaultThickness: st.wallThickness });
    if (wr.stats.gapsClosed > 0) warnings.push({ kind: 'gap', message: `Closed ${wr.stats.gapsClosed} small gaps where walls almost met on floor ${k + 1}.` });

    // Kitchen runs drawn as lines in front of a wall.
    const fixtures: (Fixture & { index: number })[] = [];
    b.furnitureBlocks.forEach((fb, i) => {
      const type = matchFurnitureType([fb.ins.name, fb.ins.layer], fb.ins.size.w, fb.ins.size.d);
      if (type === 'kitchen-sink' || type === 'kitchen-hob') fixtures.push({ type, corners: (fb.ins.footprint ?? fb.ins.corners).map(T), label: fb.ins.name, index: i });
    });
    const counters = detectCounters(
      wr.walls,
      fixtures,
      b.dashedSegs.map((x) => ({ a: T(x.a), b: T(x.b) })),
    );

    const doors: DoorCandidate[] = [
      ...b.doorArcs.map((a) => ({ kind: 'arc' as const, hinge: T(a.c), radius: a.r, ends: arcEnds({ ...a, c: T(a.c) }) as [Vec2, Vec2], label: `swing on ${a.layer}` })),
      ...b.doorBlocks.map(({ ins, arcs }) => {
        const swing = arcs.filter((a) => isSwing(a)).sort((x, y) => y.r - x.r)[0];
        return swing
          ? { kind: 'arc' as const, hinge: T(swing.c), radius: swing.r, ends: arcEnds({ ...swing, c: T(swing.c) }) as [Vec2, Vec2], label: ins.name }
          : { kind: 'block' as const, corners: ins.corners.map(T), label: ins.name };
      }),
    ];
    const windows: WindowCandidate[] = [
      ...b.windowBlocks.map((w) => ({ corners: w.corners.map(T), label: w.name })),
      ...clusterLines(b.windowSegs.map((x) => ({ a: T(x.a), b: T(x.b) }))).map((c) => ({ corners: c, label: 'window lines' })),
    ];
    // Door-layer lines that are not part of a swing door (leaf, jambs): glazed doors.
    const swingPoints = b.doorArcs.flatMap((a) => [a.c, ...arcEnds(a)]);
    const glazing = b.doorLineSegs.filter((x) => !swingPoints.some((p) => dist(p, x.a) < 0.05 || dist(p, x.b) < 0.05));
    const doorLines: WindowCandidate[] = clusterLines(glazing.map((x) => ({ a: T(x.a), b: T(x.b) })))
      .filter((c) => !swingPoints.some((p) => pointInPolygon(T(p), c)))
      .map((c) => ({ corners: c, label: 'door lines' }));
    const op = placeOpenings(
      counters.walls,
      doors,
      windows,
      {
        doorHeight: st.doorHeight,
        windowSill: st.windowSill,
        windowHeight: st.windowHeight,
        tolerance: st.tolerance,
        maxPassage: 1.6,
        minGap: 0.45,
        maxOpen: 3.0,
      },
      doorLines,
    );
    for (const m of op.warnings) warnings.push({ kind: m.includes('gap') ? 'gap' : 'opening', message: m });

    // Rooms from the closed wall graph plus room boundary lines, open-plan gaps and railings. On an
    // upper floor a stair's outline bounds the rooms around it (the landing it arrives on).
    const runs = runsPerFloor[k].map((r) => shiftRun(r, o));
    const layerStairs = stairsPerFloor[k].map((ds) => shiftStair(ds, T));
    const stairOutlines = [...runs.map((r) => r.outline), ...layerStairs.map((d) => d.outline)];
    const edges = (poly: Vec2[]) => poly.map((p, i) => ({ a: p, b: poly[(i + 1) % poly.length] }));
    const tol = Math.max(st.tolerance, 0.01);
    const boundaries = [
      ...b.boundarySegs.map((x) => ({ a: T(x.a), b: T(x.b) })),
      ...op.boundaries,
      ...railsPerFloor[k].boundaries.map((x) => ({ a: T(x.a), b: T(x.b) })),
      ...(k > 0 ? runs.flatMap((r) => edges(r.outline)) : []),
    ];
    const roomSegs = [...op.walls.map((w) => ({ a: w.a, b: w.b })), ...wallEndLinks(op.walls, tol, boundaries), ...boundaries];
    (globalThis as { __roomSegs?: (k: number, s: Seg[]) => void }).__roomSegs?.(k, roomSegs);
    const detected = detectRooms(roomSegs, b.labels.map((l) => ({ ...l, p: T(l.p) })), tol).filter(
      (r) => !(k > 0 && stairOutlines.some((so) => pointInPolygon(polygonCentroid(r.polygon), so) && polygonArea(r.polygon) <= polygonArea(so) * 1.05)),
    );
    const rooms: Room[] = detected.map((r, i) => ({ id: `${id}-r${i + 1}`, name: r.name, polygon: r.polygon, floorMaterial: r.floorMaterial, ...(r.outdoor ? { outdoor: true } : {}) }));
    if (rooms.length === 0) warnings.push({ kind: 'room', message: `No closed rooms were found on floor ${k + 1}. Check for gaps in the walls.` });
    const added = addMissingDoorways(rooms, op.walls, op.openings, boundaries, [...runs.map((r) => r.outline), ...layerStairs.map((d) => d.outline)], st.doorHeight);
    work.push({
      id,
      o,
      walls: op.walls,
      opened: op.openings,
      detected,
      rooms,
      outline: outerOutline(roomSegs, tol),
      runs,
      layerStairs,
      railings: railsPerFloor[k].railings.map((pts) => pts.map(T)),
      counterFurniture: counters.furniture,
      usedFixtures: new Set(fixtures.filter((f) => counters.used.includes(f)).map((f) => f.index)),
      addedDoorways: added,
    });
  }

  // ---- pass 2: stairs, which end is up, and their railings -------------------------------------------
  const stairs: Stair[] = [];
  const finish = st.stairFinish === 'black-steel' ? 'black-steel' : undefined;
  const nearRoom = (p: Vec2, rooms: Room[]) => rooms.some((r) => pointInPolygon(p, r.polygon) || distanceToPolygonEdges(p, r.polygon) < 0.2);
  for (let k = 0; k < nFloors; k++) {
    const w = work[k];
    const candidates: DetectedStair[] = [...w.layerStairs];
    for (const run of w.runs) {
      const above = work[k + 1];
      const mid = (run.t0 + run.t1) / 2;
      const endPoint = (u: number, out: number) => add(scale(run.along, u + out), scale(run.across, mid));
      const lo = run.positions[0];
      const hi = run.positions[run.positions.length - 1];
      let upHigh: boolean | null = null;
      if (above) {
        const atHigh = nearRoom(endPoint(hi, 0.3), above.rooms);
        const atLow = nearRoom(endPoint(lo, -0.3), above.rooms);
        if (atHigh !== atLow) upHigh = atHigh;
      }
      if (upHigh === null && run.arrow !== 0) upHigh = run.arrow > 0;
      const ds = stairFromRun(run, upHigh ?? true);
      if (upHigh === null && above) ds.warnings.push('A stair has no direction arrow and does not reach a room on the floor above; it is assumed to climb along its drawing direction.');
      candidates.push(ds);
    }
    for (const ds of candidates) {
      if (k > 0) {
        const below = stairs.find((x) => x.fromFloorId === `F${k}` && pointInPolygon(polygonCentroid(ds.outline), x.outline));
        if (below) continue;
      }
      if (k === nFloors - 1) {
        warnings.push({ kind: 'stair', message: 'A stair on the top floor has no floor above it and was left out.' });
        continue;
      }
      const fin = finishStair(ds, st.floorToFloor);
      for (const m of ds.warnings) warnings.push({ kind: 'stair', message: m });
      const rh = fin.flights[0].riserHeight;
      if (rh > 0.22 || rh < 0.13) warnings.push({ kind: 'stair', message: `A stair's risers come out at ${(rh * 1000).toFixed(0)} mm, which is unusual. Check the floor to floor height.` });
      stairs.push({ id: `S${stairs.length + 1}`, fromFloorId: w.id, toFloorId: `F${k + 2}`, outline: ds.outline, flights: fin.flights, landings: fin.landings, ...(finish ? { finish } : {}) });
    }
  }

  // ---- pass 3: furniture, room names, balconies -------------------------------------------------------
  const floors: Floor[] = [];
  let doorCount = 0;
  let windowCount = 0;
  let furnitureCount = 0;
  let unmatchedFurniture = 0;
  for (let k = 0; k < nFloors; k++) {
    const w = work[k];
    const b = buckets[k];
    const T = (p: Vec2): Vec2 => ({ x: p.x + w.o.x, y: p.y + w.o.y });
    const id = w.id;
    const rooms = w.rooms;
    const insideFloor = (p: Vec2) => (w.outline ? pointInPolygon(p, w.outline) : false) || rooms.some((r) => pointInPolygon(p, r.polygon));
    const faces = wallFaces(w.walls);
    const furniture: (Furniture & { order: number })[] = [];
    const ctx: PlaceContext = { faces, tables: [] };
    const roomOf = (p: Vec2) => rooms.find((r) => pointInPolygon(p, r.polygon));

    w.counterFurniture.forEach((c, i) => furniture.push({ id: `${id}-k${i + 1}`, ...c, order: 1e6 + i }));

    // Blocks: whole pieces, or split when they hold several (a table with chairs, two beds).
    interface Pending {
      id: string;
      order: number;
      type: string;
      rect: PieceRect;
      label: string;
      asBlock?: Furniture;
    }
    const pending: Pending[] = [];
    const sofaZones: Vec2[][] = [];
    b.furnitureBlocks.forEach((fb, i) => {
      const nextId = (j?: number) => `${id}-f${i + 1}${j === undefined ? '' : `-${j + 1}`}`;
      if (w.usedFixtures.has(i)) return;
      const ins = fb.ins;
      const fp = (ins.footprint ?? ins.corners).map(T);
      if (!insideFloor(centerOf(fp))) return;
      const strokes: Stroke[] = [
        ...model.segs.filter((x) => x.insert === fb.index).map((x) => ({ a: T(S(x.a)), b: T(S(x.b)) })),
        ...model.arcs.filter((a) => a.insert === fb.index).flatMap((a) => arcSegments({ ...a, c: T(S(a.c)), r: a.r * s }, Math.PI / 24)),
      ];
      const rects = pieceRects(strokeGroups(strokes));
      const whole = minAreaRect(fp);
      if (!whole) return;
      const wholeRect: PieceRect = { center: whole.center, dir: whole.dir, w: whole.w, d: whole.d, corners: whole.corners, ink: strokes.flatMap((x) => [x.a, x.b]) };
      const long = Math.max(whole.w, whole.d);
      const short = Math.min(whole.w, whole.d);
      const type = matchFurnitureType([ins.name, ins.layer], long, short) ?? null;
      if (type === 'sofa' && short >= 1.5) {
        sofaZones.push(whole.corners);
        lSofa(wholeRect, nextId(), ins.name).forEach((it, j) => furniture.push({ ...it, order: i + j / 100 }));
        return;
      }
      if (type === 'sofa') sofaZones.push(whole.corners);
      const biggest = rects[0];
      if (rects.length >= 2 && biggest && biggest.w * biggest.d < whole.w * whole.d * 0.8) {
        const bed = type === 'bed-single' || type === 'bed-double';
        rects.forEach((r, j) => {
          const rl = Math.max(r.w, r.d);
          const rs = Math.min(r.w, r.d);
          if (rl < 0.2) return;
          let t: string;
          if (j === 0 && type) t = matchFurnitureType([ins.name], rl, rs) ?? type;
          else if (rl <= 0.75 && rs >= 0.25) t = bed ? 'nightstand' : 'chair';
          else t = typeBySize(rl, rs, false);
          pending.push({ id: nextId(j), order: i + j / 100, type: t, rect: r, label: ins.name });
        });
        return;
      }
      // One piece. Keep the block's own axes when they fit the drawing (its local box is its
      // footprint); a block drawn turned inside its definition is placed from its footprint.
      const item = furnitureFromBlock({ name: ins.name, layer: ins.layer, corners: ins.corners.map(T) }, nextId());
      const axesFit = !ins.footprint || ins.corners.every((p) => fp.some((q) => dist(T(p), q) < 0.05));
      if (item && axesFit) {
        if (!item.matched) unmatchedFurniture++;
        pending.push({ id: nextId(), order: i, type: item.item.type, rect: wholeRect, label: ins.name, asBlock: item.item });
      } else {
        if (!type) unmatchedFurniture++;
        pending.push({ id: nextId(), order: i, type: type ?? 'box', rect: wholeRect, label: ins.name });
      }
    });
    // Loose line work on furniture layers (an exploded bed, a wardrobe outline), and small outlines.
    pieceRects(strokeGroups(b.furnitureStrokes.map((x) => ({ a: T(x.a), b: T(x.b) }))), faces).forEach((r, j) => {
      const rl = Math.max(r.w, r.d);
      if (rl < 0.25 || rl > 8 || !insideFloor(r.center)) return;
      pending.push({ id: `${id}-g${j + 1}`, order: 2e6 + j, type: '', rect: r, label: 'line work' });
    });
    b.looseOutlines.forEach((pts, j) => {
      const r = minAreaRect(pts.map(T));
      if (!r || !insideFloor(r.center)) return;
      pending.push({ id: `${id}-fo${j + 1}`, order: 3e6 + j, type: 'box', rect: { center: r.center, dir: r.dir, w: r.w, d: r.d, corners: r.corners, ink: [] }, label: 'outline' });
    });
    // Coffee tables: a plain "table" within a sofa's reach.
    for (const p of pending) {
      if (p.type !== 'dining-table' || /dining|سفرة/i.test(p.label)) continue;
      if (sofaZones.some((z) => pointInPolygon(p.rect.center, z) || distanceToPolygonEdges(p.rect.center, z) < 1.0)) p.type = 'coffee-table';
    }
    // Wet rooms (a toilet or basin in them) tell trays from wardrobes.
    const wetRooms = new Set<Room>();
    for (const p of pending) if (p.type === 'wc' || p.type === 'vanity') {
      const r = roomOf(p.rect.center);
      if (r) wetRooms.add(r);
    }
    for (const p of pending) {
      if (p.type) continue;
      const room = roomOf(p.rect.center);
      p.type = typeBySize(Math.max(p.rect.w, p.rect.d), Math.min(p.rect.w, p.rect.d), !!room && wetRooms.has(room));
    }
    // Tables first, so chairs can turn to them.
    const order = (t: string) => (t.includes('table') ? 0 : t === 'chair' || t === 'armchair' ? 2 : 1);
    pending.sort((x, y) => order(x.type) - order(y.type));
    for (const p of pending) {
      const fits = p.asBlock && p.asBlock.type === p.type && blockPlacementFits(p.asBlock, faces, ctx);
      const placed: Furniture = fits ? p.asBlock! : placePiece(p.type, p.rect, ctx, p.id, p.label);
      if (p.type === 'coffee-table' && placed.size) placed.size = { ...placed.size, z: 0.4 };
      furniture.push({ ...placed, order: p.order });
      if (p.type.includes('table')) ctx.tables.push({ center: placed.position });
    }
    furniture.sort((x, y) => x.order - y.order);
    furnitureCount += furniture.length;

    // Openings, ids and walls (heights come in pass 4).
    const walls: Wall[] = w.walls.map((wp, i) => ({ id: `${id}-w${i + 1}`, centerline: [wp.a, wp.b], thickness: Math.max(0.05, wp.thickness), height: st.ceilingHeight }));
    const wallId = new Map(w.walls.map((wp, i) => [wp, walls[i].id]));
    const openings: (Opening & { fullHeight?: boolean })[] = w.opened.map((o, i) => ({
      id: `${id}-${o.type === 'door' ? 'd' : 'win'}${i + 1}`,
      type: o.type,
      wallId: wallId.get(o.wall)!,
      offset: Math.max(o.width / 2, Math.min(dist(o.wall.a, o.wall.b) - o.width / 2, o.offset)),
      width: Math.min(o.width, dist(o.wall.a, o.wall.b)),
      height: o.height,
      sill: o.sill,
      ...(o.swing ? { swing: o.swing } : {}),
      ...(o.style ? { style: o.style } : {}),
      ...(o.fullHeight ? { fullHeight: true } : {}),
    }));
    doorCount += openings.filter((x) => x.type === 'door').length;
    windowCount += openings.filter((x) => x.type === 'window').length;

    // Room names: a label in the drawing, else what is in the room, else its role on the stair.
    const contents = (r: Room) => furniture.filter((f) => pointInPolygon(f.position, r.polygon)).map((f) => f.type);
    const fromFurniture = new Set<Room>();
    rooms.forEach((r, i) => {
      if (w.detected[i].named) return;
      const name = nameFromContents(contents(r));
      if (name) {
        r.name = name;
        fromFurniture.add(r);
        const m = materialFor(name);
        r.floorMaterial = m.floorMaterial;
      }
    });
    // Glass balconies: a hatched floor on the outside of the plan, with nothing in it.
    rooms.forEach((r, i) => {
      if (r.outdoor) return;
      if (coveredFraction(r.polygon, b.floorHatches.map((h) => h.map(T))) < 0.5) return;
      if (contents(r).length > 0) return;
      const exterior = r.polygon.some((p, j) => {
        const q = r.polygon[(j + 1) % r.polygon.length];
        const m = scale(add(p, q), 0.5);
        const out = add(m, scale(perp(normalize(sub(q, p))), -0.4));
        return !rooms.some((o) => pointInPolygon(out, o.polygon)) && !(w.outline && pointInPolygon(out, w.outline) && !rooms.some((o) => o !== r && distanceToPolygonEdges(out, o.polygon) < 0.5));
      });
      if (!exterior) return;
      r.glazed = true;
      r.floorMaterial = 'tile';
      if (!w.detected[i].named) r.name = 'Balcony';
      fromFurniture.add(r);
    });
    // The stair's rooms: where it starts and where it arrives.
    const starts = stairs.filter((x) => x.fromFloorId === id).map((x) => x.flights[0].start);
    const arrivals = stairs
      .filter((x) => x.toFloorId === id)
      .map((x) => {
        const f = x.flights[x.flights.length - 1];
        return add(f.start, scale(normalize(f.direction), (f.risers - 1) * f.going + 0.35));
      });
    rooms.forEach((r, i) => {
      if (w.detected[i].named || fromFurniture.has(r)) return;
      if (arrivals.some((p) => pointInPolygon(p, r.polygon))) r.name = 'Landing';
      else if (starts.some((p) => pointInPolygon(p, r.polygon) || distanceToPolygonEdges(p, r.polygon) < 0.3)) r.name = 'Hall';
    });
    // Number repeated names and the rest.
    let unnamed = 0;
    const count = new Map<string, number>();
    rooms.forEach((r, i) => {
      if (/^Room \d+$/.test(r.name)) r.name = `Room ${++unnamed}`;
      if (!w.detected[i].named) count.set(r.name, (count.get(r.name) ?? 0) + 1);
    });
    const seen = new Map<string, number>();
    rooms.forEach((r, i) => {
      if (w.detected[i].named || (count.get(r.name) ?? 0) < 2) return;
      const n2 = (seen.get(r.name) ?? 0) + 1;
      seen.set(r.name, n2);
      r.name = `${r.name} ${n2}`;
    });
    rooms.forEach((r, i) => {
      const d = w.detected[i];
      if (!d.named && /^Room \d+$/.test(r.name)) warnings.push({ kind: 'unnamed', message: `${r.name} on floor ${k + 1} has no label in the drawing.` });
      if (d.labels.length > 1)
        warnings.push({ kind: 'room', message: `One room on floor ${k + 1} holds several labels (${d.labels.join(', ')}). Add a line on a room boundary layer to split it.` });
    });

    for (const r of w.addedDoorways) warnings.push({ kind: 'opening', message: `${r.name} on floor ${k + 1} has no door in the drawing; an open doorway was added so it can be walked into.` });

    // Edits from the report: name, finish, and what kind of room it is.
    for (const r of rooms) {
      const edit = req.roomEdits?.[r.id];
      if (!edit) continue;
      if (edit.kind) applyKind(r, edit.kind);
      if (edit.name) r.name = edit.name;
      if (edit.floorMaterial) r.floorMaterial = edit.floorMaterial;
    }

    const railings: Railing[] = [];
    rooms.forEach((r, i) => {
      if (!r.outdoor) return;
      const rail = outdoorRailings(r, w.walls, `${id}-rail${i + 1}`);
      if (rail) railings.push(rail);
    });
    w.railings.forEach((pts, i) => railings.push({ id: `${id}-guard${i + 1}`, points: pts, height: 1.0, style: 'metal', ...(finish ? { finish } : {}) }));

    const columns: Column[] = b.roundColumns.map((c, i) => ({ id: `${id}-c${i + 1}`, center: T(c.c), radius: c.r }));

    floors.push({
      id,
      name: nFloors === 1 ? 'Ground floor' : k === 0 ? 'Lower level' : `Level ${k + 1}`,
      elevation: k * st.floorToFloor,
      ceilingHeight: st.ceilingHeight,
      slabThickness: Math.max(0.1, Math.min(0.5, st.floorToFloor - st.ceilingHeight)),
      walls,
      openings,
      rooms,
      furniture: furniture.map(({ order, ...f }) => f),
      railings,
      ...(columns.length ? { columns } : {}),
    });
  }
  if (unmatchedFurniture > 0) warnings.push({ kind: 'furniture', message: `${unmatchedFurniture} furniture blocks didn't match a known piece and are shown as plain volumes.` });

  // ---- pass 4: heights ------------------------------------------------------------------------------
  // The top floor takes the upper ceiling height. A room with no rooms of the floor above over it is
  // open to the top of that floor (double height beside a mezzanine). Each wall is as tall as the
  // taller room beside it.
  const topCeiling = st.upperCeilingHeight ?? st.ceilingHeight;
  if (nFloors > 1) floors[nFloors - 1].ceilingHeight = topCeiling;
  for (let k = 0; k < nFloors - 1; k++) {
    const above = floors[k + 1];
    const cover = above.rooms.map((r) => r.polygon);
    if (cover.length === 0) continue;
    const full = above.elevation - floors[k].elevation + above.ceilingHeight;
    for (const r of floors[k].rooms) {
      if (r.outdoor) continue;
      if (coveredFraction(r.polygon, cover) < 0.5) r.ceilingHeight = Math.round(full * 1000) / 1000;
    }
  }
  for (const f of floors) {
    const indoor = f.rooms.filter((r) => !r.outdoor);
    for (const wall of f.walls) {
      const [a, c] = wall.centerline;
      const d = normalize(sub(c, a));
      const nrm = perp(d);
      const len = dist(a, c);
      let h = 0;
      for (let i = 0; i < 5; i++) {
        const p = add(a, scale(d, (len * (i + 0.5)) / 5));
        for (const side of [1, -1]) {
          const q = add(p, scale(nrm, side * (wall.thickness / 2 + 0.15)));
          for (const r of indoor) if (pointInPolygon(q, r.polygon)) h = Math.max(h, r.ceilingHeight ?? f.ceilingHeight);
        }
      }
      wall.height = h > 0 ? h : f.ceilingHeight;
    }
    const wallById = new Map(f.walls.map((x) => [x.id, x]));
    for (const o of f.openings as (Opening & { fullHeight?: boolean })[]) {
      const wall = wallById.get(o.wallId)!;
      if (o.fullHeight) o.height = wall.height;
      else o.height = Math.min(o.height, wall.height - 0.05);
      delete o.fullHeight;
    }
  }
  // A clearly smaller upper floor is a mezzanine.
  if (nFloors === 2) {
    const area = (f: Floor) => f.rooms.reduce((a, r) => a + polygonArea(r.polygon), 0);
    if (area(floors[1]) < area(floors[0]) * 0.75) floors[1].name = 'Mezzanine';
  }

  // Size sanity.
  const all = floors.flatMap((f) => f.walls.flatMap((w) => w.centerline));
  if (all.length) {
    const bb = bounds(all);
    const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
    if (span > 100) warnings.push({ kind: 'size', message: `The plan is ${span.toFixed(0)} m across. Check the units.` });
    if (span < 3) warnings.push({ kind: 'size', message: `The plan is only ${span.toFixed(1)} m across. Check the units.` });
  }
  for (const f of floors) {
    for (const w of f.walls) if (w.thickness > 0.6) warnings.push({ kind: 'size', message: `A wall on ${f.name} is ${w.thickness.toFixed(2)} m thick.` });
    for (const r of f.rooms) if (polygonArea(r.polygon) > 250) warnings.push({ kind: 'size', message: `${r.name} on ${f.name} is ${polygonArea(r.polygon).toFixed(0)} m2, which is unusually large.` });
  }

  // Notes: what the importer decided on its own.
  const header = unitsFromInsunits(model.insunits);
  if (header && header !== st.units) {
    const content = unitsFromContent(sizeSamples(model, roles));
    const to = UNIT_LABEL[st.units].toLowerCase();
    notes.push(
      content?.confident && content.units === st.units
        ? `The file says ${UNIT_LABEL[header].toLowerCase()}, but its ${kindList(content.kinds)} are drawn in ${to}, so ${to} are used.`
        : `The file says ${UNIT_LABEL[header].toLowerCase()}; ${to} are used, as set below.`,
    );
  }
  if (req.floors.auto && nFloors > 1) {
    const how = align.methods.slice(1).every((m) => m === 'stair') ? 'lined up on their stair' : align.methods.slice(1).every((m) => m === 'labels') ? 'lined up on their matching level marks' : 'lined up by their corners';
    const mezz = floors[nFloors - 1].name === 'Mezzanine' ? ' The upper one is a mezzanine.' : '';
    notes.push(`Found ${nFloors} plans drawn side by side and stacked them as floors, the bigger one below, ${how}.${mezz}`);
  }

  const name = req.fileName.replace(/\.[^.]+$/, '') || 'Imported plan';
  const plan: FloorPlan = { schemaVersion: SCHEMA_VERSION, name, units: 'm', floors, stairs, source: { kind: 'dxf', fileName: req.fileName, importedAt: new Date().toISOString() } };
  const v = validatePlan(plan);
  if (!v.ok) {
    const err = new Error('The plan built from this DXF is not valid.') as Error & { details?: string[] };
    err.details = v.errors;
    throw err;
  }
  normalizePlan(plan);
  return { plan, report: buildReport(plan, warnings, { doors: doorCount, windows: windowCount, furniture: furnitureCount }, notes) };
}

/**
 * Every room needs a way in. A room with no door, no open-plan side and no stair gets an open
 * doorway (0.8 m) in a wall it shares with a room that has one, preferring a partition drawn as a
 * single line, in the middle of the longest shared stretch. Returns the rooms that got one.
 */
function addMissingDoorways(rooms: Room[], walls: WallPiece[], openings: PlacedOpening[], boundaries: Seg[], stairOutlines: Vec2[][], doorHeight: number): Room[] {
  const sideRooms = (c: Vec2, n: Vec2, t: number) => [1, -1].map((s) => rooms.find((r) => pointInPolygon(add(c, scale(n, s * (t / 2 + 0.15))), r.polygon)));
  const reachable = new Set<Room>();
  for (const o of openings) {
    if (o.type !== 'door') continue;
    const d = normalize(sub(o.wall.b, o.wall.a));
    for (const r of sideRooms(add(o.wall.a, scale(d, o.offset)), perp(d), o.wall.thickness)) if (r) reachable.add(r);
  }
  for (const b of boundaries) {
    const d = normalize(sub(b.b, b.a));
    for (const r of sideRooms(scale(add(b.a, b.b), 0.5), perp(d), 0)) if (r) reachable.add(r);
  }
  for (const r of rooms) if (stairOutlines.some((o) => o.some((p) => pointInPolygon(p, r.polygon) || distanceToPolygonEdges(p, r.polygon) < 0.2))) reachable.add(r);
  const out: Room[] = [];
  for (const r of rooms) {
    if (reachable.has(r) || r.outdoor) continue;
    let best: { w: WallPiece; u0: number; u1: number; score: number } | null = null;
    for (const w of walls) {
      const len = dist(w.a, w.b);
      const d = normalize(sub(w.b, w.a));
      const n = perp(d);
      // The stretch of this wall with this room on one side and a reachable room on the other.
      let run: [number, number] | null = null;
      let longest: [number, number] | null = null;
      for (let u = 0.05; u <= len - 0.05; u += 0.05) {
        const [x, y] = sideRooms(add(w.a, scale(d, u)), n, w.thickness);
        const ok = (x === r && !!y && reachable.has(y)) || (y === r && !!x && reachable.has(x));
        if (ok) run = run ? [run[0], u] : [u, u];
        if (!ok || u + 0.05 > len - 0.05) {
          if (run && (!longest || run[1] - run[0] > longest[1] - longest[0])) longest = run;
          if (!ok) run = null;
        }
      }
      if (!longest || longest[1] - longest[0] < 1.0) continue;
      const score = longest[1] - longest[0] + (w.source === 'single' ? 10 : 0);
      if (!best || score > best.score) best = { w, u0: longest[0], u1: longest[1], score };
    }
    if (!best) continue;
    openings.push({ wall: best.w, type: 'door', offset: (best.u0 + best.u1) / 2, width: 0.8, height: doorHeight, sill: 0, style: 'passage' });
    reachable.add(r);
    out.push(r);
  }
  return out;
}

/** Sets a room's kind from the report. */
function applyKind(r: Room, kind: RoomKind): void {
  delete r.outdoor;
  delete r.glazed;
  if (kind === 'glass-balcony') {
    r.glazed = true;
    r.floorMaterial = 'tile';
  } else if (kind === 'open-balcony') {
    r.outdoor = true;
    r.floorMaterial = 'concrete';
  }
}

/**
 * Whether a block's own placement (its local -y as the front) makes sense: wall pieces have their
 * back to a wall when any side is against one, beds their head, and dining chairs face their table.
 */
function blockPlacementFits(item: Furniture, faces: Stroke[], ctx: PlaceContext): boolean {
  const size = item.size;
  if (!size) return true;
  const yaw = item.rotation;
  const front = { x: Math.sin(yaw), y: -Math.cos(yaw) };
  const right = { x: Math.cos(yaw), y: Math.sin(yaw) };
  const side = (n: Vec2, half: number, along: Vec2) => ({ mid: add(item.position, scale(n, half)), along });
  const back = side(scale(front, -1), size.y / 2, right);
  const others = [side(front, size.y / 2, right), side(right, size.x / 2, front), side(scale(right, -1), size.x / 2, front)];
  const near = (sd: { mid: Vec2; along: Vec2 }) =>
    faces.some((f) => {
      const fd = normalize(sub(f.b, f.a));
      if (Math.abs(dot(fd, sd.along)) < 0.97) return false;
      const t = Math.max(0, Math.min(1, dot(sub(sd.mid, f.a), sub(f.b, f.a)) / Math.max(1e-9, dot(sub(f.b, f.a), sub(f.b, f.a)))));
      return dist(sd.mid, add(f.a, scale(sub(f.b, f.a), t))) < 0.35;
    });
  if (item.type === 'chair' && ctx.tables.length) {
    const t = ctx.tables.slice().sort((a, b) => dist(a.center, item.position) - dist(b.center, item.position))[0];
    if (dist(t.center, item.position) < 1.6) return dot(normalize(sub(t.center, item.position)), front) > 0.7;
  }
  const wallBacked = ['sofa', 'armchair', 'chair', 'wardrobe', 'wc', 'vanity', 'bathtub', 'tv-unit', 'sideboard', 'desk', 'bookshelf', 'bed-single', 'bed-double', 'nightstand', 'fridge'].includes(item.type) || item.type.startsWith('kitchen');
  if (!wallBacked) return true;
  if (near(back)) return true;
  return !others.some(near);
}
