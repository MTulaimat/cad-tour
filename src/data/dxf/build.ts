import type { Floor, FloorPlan, Furniture, Opening, Railing, Room, Stair, Vec2, Wall } from '../schema';
import { SCHEMA_VERSION } from '../schema';
import { normalizePlan, validatePlan } from '../validate';
import { matchFurnitureType } from '../../geometry/furniture/registry';
import { add, bounds, dist, dot, normalize, perp, pointInPolygon, polygonArea, polygonCentroid, scale, sub } from '../../util/math2d';
import { UNIT_SCALE } from './units';
import { extractWalls, type WallPiece } from './walls';
import { placeOpenings, resetOpeningState, type DoorCandidate, type WindowCandidate } from './openings';
import { detectRooms, type Label } from './rooms';
import { detectStair, finishStair, type DetectedStair } from './stairs';
import { furnitureFromBlock, furnitureFromOutline } from './furniture';
import { alignFloors, floorCount, floorOf } from './floors';
import type { BuildRequest, DArc, DInsert, DrawingModel, ImportReport, LayerRole, ReportWarning } from './types';
import { buildReport } from './report';

type InsertKind = 'door' | 'window' | 'furniture' | 'stair' | 'explode';

const DOOR_NAME = /(^|[^a-z])(door|dr\d*|d\d{2,4}|dwg?-?door|باب|ابواب|أبواب)([^a-z]|$)/i;
const WINDOW_NAME = /(^|[^a-z])(win|window|wdw|w\d{2,4}|glaz|نافذة|نوافذ|شباك|شبابيك)([^a-z]|$)/i;
const STAIR_NAME = /(stair|درج|سلم)/i;

/** What a top-level block is: by its layer's role first, then by its name. */
export function classifyInsert(ins: DInsert, roles: Record<string, LayerRole>): InsertKind {
  const role = roles[ins.layer] ?? 'ignore';
  if (role === 'doors') return 'door';
  if (role === 'windows') return 'window';
  if (role === 'furniture') return 'furniture';
  if (role === 'stairs') return 'stair';
  if (DOOR_NAME.test(ins.name)) return 'door';
  if (WINDOW_NAME.test(ins.name)) return 'window';
  if (STAIR_NAME.test(ins.name)) return 'stair';
  if (matchFurnitureType([ins.name], ins.size.w, ins.size.d)) return 'furniture';
  return 'explode';
}

interface FloorBucket {
  wallSegs: { a: Vec2; b: Vec2 }[];
  boundarySegs: { a: Vec2; b: Vec2 }[];
  doorArcs: DArc[];
  wallArcs: DArc[];
  doorBlocks: { ins: DInsert; arcs: DArc[] }[];
  windowBlocks: DInsert[];
  windowSegs: { a: Vec2; b: Vec2 }[];
  furnitureBlocks: DInsert[];
  furnitureOutlines: { points: Vec2[]; layer: string }[];
  stairSegs: { a: Vec2; b: Vec2 }[];
  stairPolys: Vec2[][];
  stairTexts: { p: Vec2; text: string }[];
  labels: Label[];
}

const newBucket = (): FloorBucket => ({
  wallSegs: [],
  boundarySegs: [],
  doorArcs: [],
  wallArcs: [],
  doorBlocks: [],
  windowBlocks: [],
  windowSegs: [],
  furnitureBlocks: [],
  furnitureOutlines: [],
  stairSegs: [],
  stairPolys: [],
  stairTexts: [],
  labels: [],
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

const isSwing = (a: DArc, minR = 0.5, maxR = 1.5) => a.r >= minR && a.r <= maxR && sweep(a) > (55 * Math.PI) / 180 && sweep(a) < (125 * Math.PI) / 180;

/** Approximates an arc as line pieces (curved walls on wall layers). */
function arcSegments(a: DArc): { a: Vec2; b: Vec2 }[] {
  const s = sweep(a);
  const n = Math.max(2, Math.ceil(s / (Math.PI / 16)));
  const out: { a: Vec2; b: Vec2 }[] = [];
  let prev = { x: a.c.x + Math.cos(a.a0) * a.r, y: a.c.y + Math.sin(a.a0) * a.r };
  for (let i = 1; i <= n; i++) {
    const t = a.a0 + (s * i) / n;
    const p = { x: a.c.x + Math.cos(t) * a.r, y: a.c.y + Math.sin(t) * a.r };
    out.push({ a: prev, b: p });
    prev = p;
  }
  return out;
}

/** Window line work on window layers: clusters of nearby lines, each one window. */
function clusterWindows(segs: { a: Vec2; b: Vec2 }[]): Vec2[][] {
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const near = (s: { a: Vec2; b: Vec2 }, t: { a: Vec2; b: Vec2 }) => {
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
function clusterStairs(b: FloorBucket): { segs: { a: Vec2; b: Vec2 }[]; polys: Vec2[][]; texts: { p: Vec2; text: string }[] }[] {
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
  const groups = new Map<number, { segs: { a: Vec2; b: Vec2 }[]; polys: Vec2[][]; texts: { p: Vec2; text: string }[] }>();
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

export interface BuildResult {
  plan: FloorPlan;
  report: ImportReport;
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
  const fl = (layer: string, p: Vec2) => floorOf(req.floors, layer, p);

  const kinds = model.inserts.map((ins) => (hidden.has(ins.layer) || roleOf(ins.layer) === 'ignore' ? ('ignore' as const) : classifyInsert(ins, roles)));
  const claimed = (insert: number) => insert >= 0 && (kinds[insert] === 'door' || kinds[insert] === 'window' || kinds[insert] === 'furniture' || kinds[insert] === 'ignore');

  for (const seg of model.segs) {
    if (claimed(seg.insert)) continue;
    const role = seg.insert >= 0 && kinds[seg.insert] === 'stair' ? 'stairs' : roleOf(seg.layer);
    const k = fl(seg.layer, scale(add(seg.a, seg.b), 0.5));
    if (k < 0 || k >= nFloors) continue;
    const b = buckets[k];
    const ms = { a: S(seg.a), b: S(seg.b) };
    if (role === 'walls') b.wallSegs.push(ms);
    else if (role === 'rooms') b.boundarySegs.push(ms);
    else if (role === 'windows') b.windowSegs.push(ms);
    // Stair outlines arrive as polygons; keep only loose stair lines (risers, arrows) as segments.
    else if (role === 'stairs' && (seg.poly < 0 || !model.polys[seg.poly]?.closed)) b.stairSegs.push(ms);
  }
  for (const p of model.polys) {
    if (claimed(p.insert)) continue;
    const role = p.insert >= 0 && kinds[p.insert] === 'stair' ? 'stairs' : roleOf(p.layer);
    const k = fl(p.layer, p.points[0]);
    if (k < 0 || k >= nFloors) continue;
    const pts = p.points.map(S);
    if (role === 'stairs') buckets[k].stairPolys.push(pts);
    else if (role === 'furniture' && p.closed) buckets[k].furnitureOutlines.push({ points: pts, layer: p.layer });
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
      if (isSwing(ma, 0.55, 1.3)) buckets[k].doorArcs.push(ma);
      else buckets[k].wallArcs.push(ma);
    }
  }
  model.inserts.forEach((ins, i) => {
    const kind = kinds[i];
    const k = fl(ins.layer, ins.position);
    if (k < 0 || k >= nFloors) return;
    const mi: DInsert = { ...ins, position: S(ins.position), corners: ins.corners.map(S), size: { w: ins.size.w * s, d: ins.size.d * s } };
    if (kind === 'door') {
      const arcs = model.arcs.filter((a) => a.insert === i).map((a) => ({ ...a, c: S(a.c), r: a.r * s }));
      buckets[k].doorBlocks.push({ ins: mi, arcs });
    } else if (kind === 'window') buckets[k].windowBlocks.push(mi);
    else if (kind === 'furniture') buckets[k].furnitureBlocks.push(mi);
  });
  for (const t of model.texts) {
    if (t.insert >= 0) continue;
    const role = roleOf(t.layer);
    const k = fl(t.layer, t.p);
    if (k < 0 || k >= nFloors) continue;
    if (role === 'stairs') buckets[k].stairTexts.push({ p: S(t.p), text: t.text });
    else if (role === 'walls' || role === 'rooms') buckets[k].labels.push({ p: S(t.p), text: t.text, height: t.height * s });
  }

  // Stairs first, per floor, for alignment.
  const stairsPerFloor: DetectedStair[][] = buckets.map((b) => {
    const out: DetectedStair[] = [];
    for (const c of clusterStairs(b)) {
      const st = detectStair(c);
      if (st) out.push(st);
    }
    return out;
  });
  const stairCenter = (k: number) => (stairsPerFloor[k][0] ? polygonCentroid(stairsPerFloor[k][0].outline) : null);
  const wallCorner = (k: number) => {
    const pts = buckets[k].wallSegs.flatMap((x) => [x.a, x.b]);
    if (pts.length === 0) return null;
    const b = bounds(pts);
    return { x: b.minX, y: b.minY };
  };
  const align = alignFloors(
    buckets.map((_, k) => stairCenter(k)),
    buckets.map((_, k) => wallCorner(k)),
    req.floors.mode === 'boxes' ? req.floors.boxes?.map((b) => ({ minX: b.minX * s, minY: b.minY * s, maxX: b.maxX * s, maxY: b.maxY * s })) : undefined,
  );
  if (nFloors > 1) for (const m of align.warnings) warnings.push({ kind: 'floor', message: m });

  // Shift everything so the lowest floor's walls start near the origin (nicer numbers, same shape).
  const base = wallCorner(0) ?? { x: 0, y: 0 };
  const shift = (k: number) => ({ x: align.offsets[k].x - base.x, y: align.offsets[k].y - base.y });

  const st = req.settings;
  const floors: Floor[] = [];
  const stairs: Stair[] = [];
  let doorCount = 0;
  let windowCount = 0;
  let furnitureCount = 0;
  let unmatchedFurniture = 0;
  for (let k = 0; k < nFloors; k++) {
    const b = buckets[k];
    const o = shift(k);
    const T = (p: Vec2): Vec2 => ({ x: p.x + o.x, y: p.y + o.y });
    const id = `F${k + 1}`;
    const elevation = k * st.floorToFloor;
    // Door leaves drawn as plain lines next to their swing arcs are not walls.
    const swings = b.doorArcs;
    const isLeaf = (x: { a: Vec2; b: Vec2 }) =>
      swings.some((arc) => {
        const l = dist(x.a, x.b);
        if (Math.abs(l - arc.r) > arc.r * 0.08 + st.tolerance) return false;
        const [e0, e1] = arcEnds(arc);
        const tip = dist(x.a, arc.c) < Math.max(0.03, st.tolerance * 1.5) ? x.b : dist(x.b, arc.c) < Math.max(0.03, st.tolerance * 1.5) ? x.a : null;
        return !!tip && Math.min(dist(tip, e0), dist(tip, e1)) < arc.r * 0.08 + st.tolerance;
      });
    const wallInput = [...b.wallSegs.filter((x) => !isLeaf(x)), ...b.wallArcs.flatMap(arcSegments)].map((x) => ({ a: T(x.a), b: T(x.b) }));
    if (wallInput.length === 0) {
      warnings.push({ kind: 'general', message: `Floor ${k + 1} has no walls on the layers mapped to Walls.` });
    }
    const wr = extractWalls(wallInput, { tolerance: st.tolerance, defaultThickness: st.wallThickness });
    if (wr.stats.gapsClosed > 0) warnings.push({ kind: 'gap', message: `Closed ${wr.stats.gapsClosed} small gaps where walls almost met on floor ${k + 1}.` });

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
      ...clusterWindows(b.windowSegs.map((x) => ({ a: T(x.a), b: T(x.b) }))).map((c) => ({ corners: c, label: 'window lines' })),
    ];
    const op = placeOpenings(wr.walls, doors, windows, {
      doorHeight: st.doorHeight,
      windowSill: st.windowSill,
      windowHeight: st.windowHeight,
      tolerance: st.tolerance,
      maxPassage: 1.6,
      minGap: 0.45,
    });
    for (const m of op.warnings) warnings.push({ kind: m.includes('gap') ? 'gap' : 'opening', message: m });

    const walls: Wall[] = op.walls.map((w, i) => ({ id: `${id}-w${i + 1}`, centerline: [w.a, w.b], thickness: Math.max(0.05, w.thickness), height: st.ceilingHeight }));
    const wallId = new Map(op.walls.map((w, i) => [w, walls[i].id]));
    const openings: Opening[] = op.openings.map((o, i) => ({
      id: `${id}-${o.type === 'door' ? 'd' : 'win'}${i + 1}`,
      type: o.type,
      wallId: wallId.get(o.wall)!,
      offset: Math.max(o.width / 2, Math.min(dist(o.wall.a, o.wall.b) - o.width / 2, o.offset)),
      width: Math.min(o.width, dist(o.wall.a, o.wall.b)),
      height: Math.min(o.height, st.ceilingHeight - 0.05),
      sill: o.sill,
      ...(o.swing ? { swing: o.swing } : {}),
      ...(o.style ? { style: o.style } : {}),
    }));
    doorCount += openings.filter((x) => x.type === 'door').length;
    windowCount += openings.filter((x) => x.type === 'window').length;

    // Rooms from the closed wall graph plus room boundary lines.
    const roomSegs = [...op.walls.map((w) => ({ a: w.a, b: w.b })), ...b.boundarySegs.map((x) => ({ a: T(x.a), b: T(x.b) }))];
    const detected = detectRooms(roomSegs, b.labels.map((l) => ({ ...l, p: T(l.p) })), Math.max(st.tolerance, 0.01));
    const rooms: Room[] = detected.map((r, i) => {
      const rid = `${id}-r${i + 1}`;
      const edit = req.roomEdits?.[rid];
      return {
        id: rid,
        name: edit?.name ?? r.name,
        polygon: r.polygon,
        floorMaterial: edit?.floorMaterial ?? r.floorMaterial,
        ...(r.outdoor ? { outdoor: true } : {}),
      };
    });
    detected.forEach((r, i) => {
      if (!r.named) warnings.push({ kind: 'unnamed', message: `${rooms[i].name} on floor ${k + 1} has no label in the drawing.` });
      if (r.labels.length > 1)
        warnings.push({ kind: 'room', message: `One room on floor ${k + 1} holds several labels (${r.labels.join(', ')}). Add a line on a room boundary layer to split it.` });
    });
    if (rooms.length === 0) warnings.push({ kind: 'room', message: `No closed rooms were found on floor ${k + 1}. Check for gaps in the walls.` });

    const railings: Railing[] = [];
    rooms.forEach((r, i) => {
      if (!r.outdoor) return;
      const rail = outdoorRailings(r, op.walls, `${id}-rail${i + 1}`);
      if (rail) railings.push(rail);
    });

    const furniture: Furniture[] = [];
    b.furnitureBlocks.forEach((ins, i) => {
      const f = furnitureFromBlock({ name: ins.name, layer: ins.layer, corners: ins.corners.map(T) }, `${id}-f${i + 1}`);
      if (!f) return;
      if (!rooms.some((r) => pointInPolygon(f.item.position, r.polygon))) return;
      furniture.push(f.item);
      if (!f.matched) unmatchedFurniture++;
    });
    b.furnitureOutlines.forEach((p, i) => {
      const f = furnitureFromOutline(p.points.map(T), p.layer, `${id}-fo${i + 1}`);
      if (f && rooms.some((r) => pointInPolygon(f.position, r.polygon))) furniture.push(f);
    });
    furnitureCount += furniture.length;

    floors.push({
      id,
      name: nFloors === 1 ? 'Ground floor' : k === 0 ? 'Lower level' : `Level ${k + 1}`,
      elevation,
      ceilingHeight: st.ceilingHeight,
      slabThickness: Math.max(0.1, Math.min(0.5, st.floorToFloor - st.ceilingHeight)),
      walls,
      openings,
      rooms,
      furniture,
      railings,
    });

    // Stairs from this floor up to the next one; the upper floor's drawing of the same stair is skipped.
    for (const ds of stairsPerFloor[k]) {
      const outline = ds.outline.map(T);
      if (k > 0) {
        const below = stairs.find((x) => x.fromFloorId === `F${k}` && pointInPolygon(polygonCentroid(outline), x.outline));
        if (below) continue;
      }
      if (k === nFloors - 1) {
        warnings.push({ kind: 'stair', message: 'A stair on the top floor has no floor above it and was left out.' });
        continue;
      }
      const fin = finishStair(
        { ...ds, outline, flights: ds.flights.map((f) => ({ ...f, start: T(f.start) })), landings: ds.landings.map((l) => ({ ...l, polygon: l.polygon.map(T) })) },
        st.floorToFloor,
      );
      for (const w of ds.warnings) warnings.push({ kind: 'stair', message: w });
      const rh = fin.flights[0].riserHeight;
      if (rh > 0.22 || rh < 0.13) warnings.push({ kind: 'stair', message: `A stair's risers come out at ${(rh * 1000).toFixed(0)} mm, which is unusual. Check the floor to floor height.` });
      stairs.push({ id: `S${stairs.length + 1}`, fromFloorId: id, toFloorId: `F${k + 2}`, outline, flights: fin.flights, landings: fin.landings });
    }
  }
  if (unmatchedFurniture > 0) warnings.push({ kind: 'furniture', message: `${unmatchedFurniture} furniture blocks didn't match a known piece and are shown as plain volumes.` });

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

  const name = req.fileName.replace(/\.[^.]+$/, '') || 'Imported plan';
  const plan: FloorPlan = { schemaVersion: SCHEMA_VERSION, name, units: 'm', floors, stairs, source: { kind: 'dxf', fileName: req.fileName, importedAt: new Date().toISOString() } };
  const v = validatePlan(plan);
  if (!v.ok) {
    const err = new Error('The plan built from this DXF is not valid.') as Error & { details?: string[] };
    err.details = v.errors;
    throw err;
  }
  normalizePlan(plan);
  return { plan, report: buildReport(plan, warnings, { doors: doorCount, windows: windowCount, furniture: furnitureCount }) };
}
