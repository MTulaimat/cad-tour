import { describe, expect, it } from 'vitest';
import { DxfWriter, type EntityWriter, type P } from '../../scripts/lib/dxf-writer';
import { readDrawing, resetParseCaches } from '../../src/data/dxf/parse';
import { prepareImport } from '../../src/data/dxf/prepare';
import { buildPlan } from '../../src/data/dxf/build';
import { DEFAULT_SETTINGS, type BuildRequest } from '../../src/data/dxf/types';
import { decideUnits, unitsFromContent } from '../../src/data/dxf/units';
import { findTreadRuns, stairFromRun, stairRailings } from '../../src/data/dxf/treads';
import { alignFloors, snapOffset } from '../../src/data/dxf/floors';
import { detectCounters } from '../../src/data/dxf/counters';
import { findBedRects, pieceRects, placePiece, strokeGroups } from '../../src/data/dxf/furniture';
import { placeOpenings, resetOpeningState } from '../../src/data/dxf/openings';
import { nameRooms, wallEndLinks } from '../../src/data/dxf/rooms';
import { extractWalls, type WallPiece } from '../../src/data/dxf/walls';
import { validatePlan } from '../../src/data/validate';
import { wallSegments } from '../../src/plan/walls';
import { buildingTop, risingRooms } from '../../src/plan/levels';
import { buildFloorGeometry } from '../../src/geometry';
import { CollisionWorld } from '../../src/collision/world';
import { stairInfos } from '../../src/plan/stairs';
import type { FloorPlan } from '../../src/data/schema';

const p = (x: number, y: number) => ({ x, y });

// ---- a synthetic drawing: a flat and its mezzanine drawn side by side ---------------------------

/** Double-line wall box: outer and inner rectangles. */
function box(w: EntityWriter, at: (x: number, y: number) => P, x0: number, y0: number, x1: number, y1: number, t: number) {
  for (const [a, b, c, d] of [
    [x0, y0, x1, y1],
    [x0 + t, y0 + t, x1 - t, y1 - t],
  ]) {
    w.line('0', at(a, b), at(c, b));
    w.line('0', at(c, b), at(c, d));
    w.line('0', at(c, d), at(a, d));
    w.line('0', at(a, d), at(a, b));
  }
}

/** A stair drawn as plain lines on layer 0: treads from x 5.4 to 9.0 and a rail running on to 5.1. */
function stair(w: EntityWriter, at: (x: number, y: number) => P) {
  for (let k = 0; k <= 12; k++) w.line('0', at(5.4 + k * 0.3, 0.2), at(5.4 + k * 0.3, 1.2));
  w.line('0', at(5.1, 1.2), at(9.0, 1.2));
}

/**
 * Header says millimeters, drawing is in meters. Lower plan: 10 x 8 m, a wall at x = 5 with a door,
 * a bed block drawn turned inside its definition, a sofa, the stair along the south wall. Upper
 * plan, 20 m to the right: the left half only (a mezzanine) with exploded twin beds and the stair.
 */
function twoPlans(): Uint8Array {
  const w = new DxfWriter({ version: 'AC1027', insunits: 4, codepage: 'ANSI_1252' });
  w.layer('A-EQUP');
  w.layer('A-DOOR');
  w.block('door 1', (b) => {
    b.arc('A-DOOR', p(0, 0), 0.9, 0, 90);
    b.line('A-DOOR', p(0, 0), p(0, 0.9));
  });
  // A 2.0 x 0.9 bed drawn turned 30 degrees inside its block.
  w.block('bed', (b) => {
    const r = (x: number, y: number) => p(x * Math.cos(Math.PI / 6) - y * Math.sin(Math.PI / 6), x * Math.sin(Math.PI / 6) + y * Math.cos(Math.PI / 6));
    b.polyline('0', [r(-1, -0.45), r(1, -0.45), r(1, 0.45), r(-1, 0.45)], true);
  });
  w.block('sofa', (b) => b.polyline('0', [p(-1.1, -0.45), p(1.1, -0.45), p(1.1, 0.45), p(-1.1, 0.45)], true));
  const L = (x: number, y: number) => p(1000 + x, 500 + y);
  box(w, L, 0, 0, 10, 8, 0.2);
  w.line('0', L(4.9, 0.2), L(4.9, 3.0));
  w.line('0', L(5.1, 0.2), L(5.1, 3.0));
  w.line('0', L(4.9, 3.9), L(4.9, 7.8));
  w.line('0', L(5.1, 3.9), L(5.1, 7.8));
  w.line('0', L(4.9, 3.0), L(5.1, 3.0));
  w.line('0', L(4.9, 3.9), L(5.1, 3.9));
  w.insert('0', 'door 1', L(5.0, 3.0), 90);
  w.insert('0', 'bed', L(2.5, 7.0), -30);
  w.insert('0', 'sofa', L(7.5, 5.0));
  stair(w, L);
  w.text('0', L(2.0, 1.0), 0.1, '+2.60');
  const U = (x: number, y: number) => p(1020 + x, 503 + y);
  // Mezzanine over the left half; its east side is open where the stair arrives.
  w.line('0', U(0, 0), U(9.0, 0));
  w.line('0', U(0.2, 0.2), U(9.0, 0.2));
  w.line('0', U(0, 0), U(0, 8));
  w.line('0', U(0.2, 0.2), U(0.2, 7.8));
  w.line('0', U(0, 8), U(5.1, 8));
  w.line('0', U(0.2, 7.8), U(4.9, 7.8));
  w.line('0', U(5.1, 1.2), U(5.1, 8));
  w.line('0', U(4.9, 1.2), U(4.9, 7.8));
  w.line('0', U(4.9, 1.2), U(5.1, 1.2));
  stair(w, U);
  // Twin beds exploded into lines, sharing their head line.
  for (const y0 of [4.0, 5.45]) {
    w.line('A-EQUP', U(0.3, y0), U(2.3, y0));
    w.line('A-EQUP', U(2.3, y0), U(2.3, y0 + 0.95));
    w.line('A-EQUP', U(2.3, y0 + 0.95), U(0.3, y0 + 0.95));
  }
  w.line('A-EQUP', U(0.3, 4.0), U(0.3, 6.4));
  w.text('0', U(2.0, 1.0), 0.1, '+2.60');
  return new TextEncoder().encode(w.toString());
}

function importTwoPlans(overrides: Partial<BuildRequest['settings']> = {}) {
  resetParseCaches();
  const model = readDrawing(twoPlans());
  const prep = prepareImport(model);
  const settings = { ...DEFAULT_SETTINGS, units: prep.units.units, ceilingHeight: 2.4, floorToFloor: 2.6, upperCeilingHeight: 2.2, ...overrides };
  return { model, prep, ...buildPlan(model, { roles: prep.roles, hidden: [], floors: prep.floors, settings, fileName: 'two-plans.dxf' }) };
}

describe('a flat and its mezzanine drawn side by side', () => {
  const r = importTwoPlans({ stairFinish: 'black-steel' });
  const [lower, upper] = r.plan.floors;

  it('fixes the unit from the doors, furniture and walls, without asking', () => {
    expect(r.prep.units).toMatchObject({ units: 'm', ask: false, detected: 'mm' });
    expect(r.prep.units.note).toMatch(/says millimeters, but its .* are drawn in meters/);
    expect(r.report.notes.join(' ')).toMatch(/millimeters/);
  });

  it('finds the two plans and stacks them, the bigger one below', () => {
    expect(r.prep.floors.mode).toBe('boxes');
    expect(r.prep.floors.auto).toBe(true);
    expect(r.prep.floors.boxes).toHaveLength(2);
    expect(r.prep.floors.boxes![0].minX).toBeLessThan(1001);
    expect(r.plan.floors).toHaveLength(2);
    expect(upper.name).toBe('Mezzanine');
    expect(upper.elevation).toBeCloseTo(2.6, 6);
    expect(r.report.notes.join(' ')).toMatch(/side by side/);
  });

  it('lines the mezzanine up exactly on the floor below', () => {
    const westLower = lower.walls.find((w) => Math.abs(w.centerline[0].x - w.centerline[1].x) < 1e-6 && w.centerline[0].x < 0.5)!;
    const westUpper = upper.walls.find((w) => Math.abs(w.centerline[0].x - w.centerline[1].x) < 1e-6 && w.centerline[0].x < 0.5)!;
    expect(westUpper.centerline[0].x).toBeCloseTo(westLower.centerline[0].x, 6);
    const southUpper = upper.walls.find((w) => Math.abs(w.centerline[0].y - w.centerline[1].y) < 1e-6 && Math.max(w.centerline[0].y, w.centerline[1].y) < 0.5)!;
    const southLower = lower.walls.find((w) => Math.abs(w.centerline[0].y - w.centerline[1].y) < 1e-6 && Math.max(w.centerline[0].y, w.centerline[1].y) < 0.5)!;
    expect(southUpper.centerline[0].y).toBeCloseTo(southLower.centerline[0].y, 6);
  });

  it('reads the stair drawn on the walls layer and climbs it towards the mezzanine', () => {
    expect(r.plan.stairs).toHaveLength(1);
    const s = r.plan.stairs[0];
    expect(s.fromFloorId).toBe(lower.id);
    expect(s.toFloorId).toBe(upper.id);
    const risers = s.flights.reduce((n, f) => n + f.risers, 0);
    // 13 drawn risers plus the last one where the rail ends at the floor above.
    expect(risers).toBe(14);
    expect(s.flights[0].direction.x).toBeLessThan(-0.99);
    expect(s.finish).toBe('black-steel');
    // No wall stubs left where the treads were.
    expect(lower.walls.every((w) => Math.hypot(w.centerline[1].x - w.centerline[0].x, w.centerline[1].y - w.centerline[0].y) > 0.5)).toBe(true);
  });

  it('names rooms from their furniture and splits the exploded twin beds', () => {
    const names = lower.rooms.map((x) => x.name).sort();
    expect(names).toEqual(['Bedroom', 'Living room']);
    expect(upper.rooms.some((x) => x.name === 'Bedroom')).toBe(true);
    expect(upper.furniture.filter((f) => f.type === 'bed-single')).toHaveLength(2);
    // The bed block drawn turned in its definition comes out square to the walls, at its size.
    const bed = lower.furniture.find((f) => f.type === 'bed-single')!;
    // (The writer rounds coordinates to 0.1 mm, so square means within a thousandth of a radian.)
    expect(Math.abs(Math.sin(2 * bed.rotation))).toBeLessThan(1e-3);
    expect(Math.max(bed.size!.x, bed.size!.y)).toBeCloseTo(2.0, 2);
    expect(Math.min(bed.size!.x, bed.size!.y)).toBeCloseTo(0.9, 2);
  });

  it('gives the room beside the mezzanine the full height and stops walls at the lower ceiling', () => {
    const living = lower.rooms.find((x) => x.name === 'Living room')!;
    const bedroom = lower.rooms.find((x) => x.name === 'Bedroom')!;
    expect(living.ceilingHeight).toBeCloseTo(2.6 + 2.2, 6);
    expect(bedroom.ceilingHeight).toBeUndefined();
    expect(lower.ceilingHeight).toBe(2.4);
    expect(upper.ceilingHeight).toBe(2.2);
    expect(buildingTop(r.plan)).toBeCloseTo(4.8, 6);
    // The wall between them at x = 5 takes the bedroom's height; the outside wall of the living room the full height.
    const mid = lower.walls.find((w) => Math.abs(w.centerline[0].x - 5) < 0.05 && Math.abs(w.centerline[1].x - 5) < 0.05)!;
    expect(mid.height).toBeCloseTo(2.4, 6);
    const east = lower.walls.find((w) => w.centerline.every((q) => q.x > 9.5))!;
    expect(east.height).toBeCloseTo(4.8, 6);
  });

  it('builds the mezzanine faces down over the double-height space and validates', () => {
    expect(validatePlan(r.plan).ok).toBe(true);
    expect(risingRooms(r.plan, upper).map((x) => x.room.name)).toContain('Living room');
    const east = wallSegments(r.plan, upper).find((s) => s.a.x > 4.5 && s.b.x > 4.5 && Math.abs(s.dir.y) > 0.99)!;
    expect(east.leftDown || east.rightDown).toBe(true);
    for (let i = 0; i < 2; i++) {
      const b = buildFloorGeometry(r.plan, i);
      for (const g of b.shell.values()) {
        const pos = g.getAttribute('position');
        for (let k = 0; k < pos.count; k++) expect(Number.isFinite(pos.getY(k))).toBe(true);
      }
    }
  });

  it('walks up the stair onto the mezzanine', () => {
    const world = new CollisionWorld(r.plan);
    const s = stairInfos(r.plan)[0];
    let h = 0;
    const steps = 80;
    const a = s.departure.point;
    const b = s.arrival.point;
    for (let i = 0; i <= steps; i++) {
      const q = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps };
      h = world.heightAt(q, h);
    }
    h = world.heightAt({ x: b.x - 0.6, y: b.y }, h);
    expect(h).toBeCloseTo(2.6, 3);
  });
});

// ---- the rules one by one ----------------------------------------------------------------------

describe('units from content', () => {
  const doors = [0.8, 0.9, 0.75].map((value) => ({ kind: 'doors' as const, value, min: 0.55, max: 1.3 }));
  it('picks the unit most sizes agree with', () => {
    expect(unitsFromContent(doors)).toMatchObject({ units: 'm', confident: true, kinds: ['doors'] });
    expect(unitsFromContent(doors.map((d) => ({ ...d, value: d.value * 1000 })))).toMatchObject({ units: 'mm', confident: true });
    expect(unitsFromContent([])).toBeNull();
  });
  it('overrides an implausible header only with confident evidence, and asks for a missing one', () => {
    const content = unitsFromContent(doors);
    expect(decideUnits(4, 29.4, 18.4, content)).toMatchObject({ units: 'm', ask: false });
    expect(decideUnits(4, 29.4, 18.4, null)).toMatchObject({ ask: true });
    const missing = decideUnits(0, 29.4, 18.4, content);
    expect(missing).toMatchObject({ units: 'm', ask: true });
    expect(missing.reason).toMatch(/point to meters/);
    // A plausible header is kept even when the content disagrees.
    expect(decideUnits(6, 12, 9, unitsFromContent(doors.map((d) => ({ ...d, value: d.value * 100 }))))).toMatchObject({ units: 'm', ask: false });
  });
});

describe('stairs from tread lines', () => {
  const segs = [
    // 8 treads 0.3 apart, a landing gap, two more, rails on both sides running one tread further.
    ...[0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.7, 3.0].map((x) => ({ a: p(x, 0), b: p(x, 1) })),
    { a: p(-0.5, 0), b: p(3.3, 0) },
    { a: p(0, 1), b: p(3.3, 1) },
    // A wall that carries on past the stair stays a wall.
    { a: p(-3, -0.2), b: p(6, -0.2) },
  ];
  it('finds the run, its landing and the last riser where the rails end', () => {
    const runs = findTreadRuns(segs);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.positions).toHaveLength(11);
    expect(run.used).not.toContain(segs.length - 1);
    const up = stairFromRun(run, run.along.x > 0);
    expect(up.flights).toHaveLength(2);
    expect(up.landings).toHaveLength(1);
    expect(up.totalRisers).toBe(11);
    expect(up.flights[0].risers).toBe(8);
  });
  it('turns a thin double line off a rail end into a railing', () => {
    const run = findTreadRuns(segs)[0];
    const extra = [...segs, { a: p(3.3, 1), b: p(3.3, 3) }, { a: p(3.4, 1), b: p(3.4, 3) }];
    const rails = stairRailings(extra, [run], new Set(run.used));
    expect(rails.railings).toHaveLength(1);
    expect(rails.railings[0][0].x).toBeCloseTo(3.35, 6);
    expect(rails.used.sort()).toEqual([segs.length, segs.length + 1]);
  });
});

describe('floor alignment', () => {
  it('lines floors up on matching level marks and snaps onto shared corners', () => {
    const a = alignFloors({
      stairCenters: [null, null],
      cornerOf: [p(0, 0), p(0, 0)],
      labels: [
        [{ p: p(1, 1), text: '+2.60' }, { p: p(4, 2), text: '+3.00' }],
        [{ p: p(21.001, 4), text: '+2.60' }, { p: p(24.001, 5), text: '+3.00' }],
      ],
      vertices: [
        [p(0, 0), p(5, 0), p(5, 8), p(0, 8)],
        [p(20, 3), p(25, 3), p(25, 11), p(20, 11)],
      ],
    });
    expect(a.methods[1]).toBe('labels');
    expect(a.offsets[1].x).toBeCloseTo(-20, 9);
    expect(a.offsets[1].y).toBeCloseTo(-3, 9);
    expect(snapOffset([p(0, 0), p(1, 0), p(1, 1)], [p(10, 0), p(11, 0), p(11, 1)], p(-10.03, 0.02))).toEqual(p(-10, 0));
  });
});

describe('openings and room closure', () => {
  const wall = (ax: number, ay: number, bx: number, by: number, t = 0.2): WallPiece => ({ a: p(ax, ay), b: p(bx, by), thickness: t, source: 'pair' });
  const opts = { doorHeight: 2.1, windowSill: 0.9, windowHeight: 1.2, tolerance: 0.02, maxPassage: 1.6, minGap: 0.45, maxOpen: 3 };
  it('makes glazing lines on a door layer a glass door', () => {
    resetOpeningState();
    const r = placeOpenings([wall(0, 0, 2, 0), wall(4.1, 0, 6, 0)], [], [], opts, [{ corners: [p(2, -0.1), p(4.1, -0.1), p(4.1, 0.1), p(2, 0.1)], label: 'door lines' }]);
    expect(r.openings).toHaveLength(1);
    expect(r.openings[0]).toMatchObject({ type: 'door', style: 'sliding-glass' });
    expect(r.openings[0].width).toBeCloseTo(2.1, 6);
  });
  it('leaves a wide inside gap open with a line between the rooms, and glazes one in an outside wall', () => {
    resetOpeningState();
    // A box with a 2.6 m gap in its middle wall and a 1.2 m gap in its outside wall.
    const walls = [wall(0, 0, 2, 0), wall(3.2, 0, 10, 0), wall(10, 0, 10, 6), wall(10, 6, 0, 6), wall(0, 6, 0, 0), wall(5, 0, 5, 1.7), wall(5, 4.3, 5, 6)];
    const r = placeOpenings(walls, [], [], opts);
    expect(r.boundaries).toHaveLength(1);
    expect(r.boundaries[0].a.x).toBeCloseTo(5, 6);
    const glazed = r.openings.find((o) => o.type === 'window')!;
    expect(glazed.fullHeight).toBe(true);
    expect(glazed.width).toBeCloseTo(1.2, 6);
  });
  it('does not take the gap a column fills for a doorway', () => {
    resetOpeningState();
    const r = placeOpenings([wall(0, 0, 2, 0, 0.15), wall(2.6, 0, 5, 0, 0.15), wall(1.9, 0, 2.7, 0, 0.3)], [], [], opts);
    expect(r.openings).toHaveLength(0);
  });
  it('hangs a swing door in the gap its closed leaf spans, not along the wall beside it', () => {
    resetOpeningState();
    // Hinge at the end of a wall running up; the arc's other end lies along that wall.
    const walls = [wall(0, 0, 3, 0, 0.15), wall(3.7, 0, 6, 0, 0.15), wall(3.7, 0, 3.7, 3, 0.15)];
    const r = placeOpenings(walls, [{ kind: 'arc', hinge: p(3.7, 0.075), radius: 0.7, ends: [p(3.0, 0.075), p(3.7, 0.775)], label: 'door' }], [], opts);
    const d = r.openings[0];
    expect(Math.abs(d.wall.b.y - d.wall.a.y)).toBeLessThan(1e-6);
  });
  it('links wall ends that stop against a thicker wall', () => {
    const links = wallEndLinks([wall(0, 0, 4.85, 0, 0.15), wall(5, -0.3, 5, 0.3, 0.3)], 0.02);
    expect(links).toHaveLength(1);
    expect(links[0].b).toEqual(p(5, 0));
  });
  it('never names a room after a level mark', () => {
    const [room] = nameRooms([[p(0, 0), p(4, 0), p(4, 4), p(0, 4)]], [{ p: p(2, 2), text: '+2.75', height: 0.2 }]);
    expect(room.named).toBe(false);
  });
  it('extends a wall whose partner line stops short, instead of a thin extra wall', () => {
    const r = extractWalls([
      { a: p(0, 0), b: p(4, 0) },
      { a: p(0, 0.15), b: p(2, 0.15) },
      { a: p(2, 0.15), b: p(4, 0.15) },
      { a: p(0, 0.15), b: p(0, 0) },
    ].slice(0, 2).concat([{ a: p(2.0, 0.0), b: p(4.0, 0.0) }]));
    expect(r.walls.every((w) => Math.abs(w.thickness - 0.15) < 1e-6)).toBe(true);
  });
});

describe('furniture from line work', () => {
  it('splits beds that share a head line', () => {
    const lines = [];
    for (const y0 of [0, 1.5, 3]) lines.push({ a: p(0, y0), b: p(2.1, y0) }, { a: p(2.1, y0), b: p(2.1, y0 + 1) }, { a: p(2.1, y0 + 1), b: p(0, y0 + 1) });
    lines.push({ a: p(0, 0), b: p(0, 4) });
    expect(findBedRects(lines, p(1, 0))).toHaveLength(3);
    expect(pieceRects(strokeGroups(lines))).toHaveLength(3);
  });
  it('reaches a front-and-sides outline back to the wall behind it', () => {
    const faces = [{ a: p(0, 0.6), b: p(4, 0.6) }];
    const lines = [
      { a: p(0.2, 0), b: p(3.8, 0) },
      { a: p(0.2, 0), b: p(0.2, 0.15) },
      { a: p(3.8, 0), b: p(3.8, 0.15) },
    ];
    const [r] = pieceRects(strokeGroups(lines), faces);
    expect(Math.min(r.w, r.d)).toBeCloseTo(0.6, 6);
  });
  it('puts a bed head against the wall and a wardrobe back against it', () => {
    const faces = [{ a: p(-5, 0), b: p(5, 0) }];
    const bed = placePiece('bed-single', { center: p(0, -1.05), dir: p(1, 0), w: 1, d: 2.1, corners: [p(-0.5, -2.1), p(0.5, -2.1), p(0.5, 0), p(-0.5, 0)], ink: [] }, { faces, tables: [] }, 'b', 'bed');
    // Front faces south, away from the wall to the north.
    expect(Math.cos(bed.rotation)).toBeCloseTo(1, 6);
    expect(bed.size).toMatchObject({ x: 1, y: 2.1 });
    const wardrobe = placePiece('wardrobe', { center: p(0, -0.3), dir: p(1, 0), w: 3, d: 0.6, corners: [p(-1.5, -0.6), p(1.5, -0.6), p(1.5, 0), p(-1.5, 0)], ink: [] }, { faces, tables: [] }, 'w', 'w');
    expect(wardrobe.size).toMatchObject({ x: 3, y: 0.6 });
  });
  it('sets a sink and a hob into the counter drawn in front of a wall', () => {
    const walls: WallPiece[] = [
      { a: p(0, 0.075), b: p(6, 0.075), thickness: 0.15, source: 'pair' },
      { a: p(0, -0.6), b: p(6, -0.6), thickness: 0.2, source: 'single' },
      { a: p(0, -0.6), b: p(0, 0), thickness: 0.2, source: 'single' },
    ];
    const sink = { type: 'kitchen-sink' as const, corners: [p(1, -0.55), p(1.8, -0.55), p(1.8, 0), p(1, 0)], label: 'sink' };
    const r = detectCounters(walls, [sink], [{ a: p(0, -0.45), b: p(6, -0.45) }]);
    expect(r.walls).toHaveLength(1);
    expect(r.used).toEqual([sink]);
    expect(r.furniture.map((f) => f.type)).toEqual(['kitchen-counter', 'kitchen-sink', 'kitchen-counter', 'wall-cabinet']);
  });
});

describe('drawing details', () => {
  /** A minimal DXF: a dashed line, a solid hatch and a patterned one. */
  const raw = [
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LTYPE', '70', '1',
    '0', 'LTYPE', '2', 'DASHED', '70', '0', '3', 'Dashed', '72', '65', '73', '2', '40', '0.75', '49', '0.5', '74', '0', '49', '-0.25', '74', '0',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', '0', '6', 'DASHED', '10', '0', '20', '0', '30', '0', '11', '3', '21', '0', '31', '0',
    '0', 'LINE', '8', '0', '10', '0', '20', '1', '30', '0', '11', '3', '21', '1', '31', '0',
    '0', 'HATCH', '8', '0', '10', '0', '20', '0', '30', '0', '2', 'SOLID', '70', '1', '71', '0', '91', '1', '92', '7', '72', '0', '73', '1', '93', '4',
    '10', '0', '20', '2', '10', '0.3', '20', '2', '10', '0.3', '20', '2.6', '10', '0', '20', '2.6', '97', '0', '75', '1', '76', '1', '98', '0',
    '0', 'HATCH', '8', '0', '10', '0', '20', '0', '30', '0', '2', 'ANSI37', '70', '0', '71', '0', '91', '1', '92', '7', '72', '0', '73', '1', '93', '4',
    '10', '1', '20', '2', '10', '3', '20', '2', '10', '3', '20', '4', '10', '1', '20', '4', '97', '0', '75', '1', '76', '1', '98', '0',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n');
  it('reads dashed linetypes and hatch fill types', () => {
    resetParseCaches();
    const m = readDrawing(new TextEncoder().encode(raw));
    const lines = m.segs.filter((s) => s.poly < 0);
    expect(lines.find((s) => s.a.y === 0)?.dashed).toBe(true);
    expect(lines.find((s) => s.a.y === 1)?.dashed).toBeFalsy();
    const hatches = m.polys.filter((q) => q.source === 'hatch');
    expect(hatches.map((h) => h.solid)).toEqual([true, false]);
    expect(hatches[1].pattern).toBe('ANSI37');
  });
});

describe('plan geometry with a mezzanine', () => {
  it('stops lower walls under the mezzanine and puts the roof over the double height', () => {
    const r = importTwoPlans();
    const plan: FloorPlan = r.plan;
    const lower = plan.floors[0];
    // The outside west wall under the mezzanine stops at the mezzanine slab (2.6 - slab).
    const west = wallSegments(plan, lower).find((s) => Math.abs(s.dir.x) < 0.01 && s.a.x < 0.5)!;
    for (const t of west.tops) expect(t.y).toBeCloseTo(2.4, 6);
    // The living room's outside wall runs up to the roof.
    const east = wallSegments(plan, lower).find((s) => Math.abs(s.dir.x) < 0.01 && s.a.x > 9.5)!;
    expect(Math.max(...east.tops.map((t) => t.y))).toBeCloseTo(4.8, 6);
  });
});
