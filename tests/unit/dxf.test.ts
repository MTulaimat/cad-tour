import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDemoPlan } from '../../src/data/mock';
import { normalizePlan } from '../../src/data/validate';
import { cleanMText, cleanText, decodeDxf } from '../../src/data/dxf/encoding';
import { decideUnits, guessUnits } from '../../src/data/dxf/units';
import { closeGaps, extractWalls, pairWalls, cleanSegments, WALL_DEFAULTS } from '../../src/data/dxf/walls';
import { placeOpenings, resetOpeningState } from '../../src/data/dxf/openings';
import { detectRooms, findFaces, materialFor } from '../../src/data/dxf/rooms';
import { readDrawing, resetParseCaches } from '../../src/data/dxf/parse';
import { buildPlan } from '../../src/data/dxf/build';
import { detectFloors, detectRole, detectRoles } from '../../src/data/dxf/layers';
import { DEFAULT_SETTINGS, type BuildRequest } from '../../src/data/dxf/types';
import { classifyFile } from '../../src/app/files';
import { polygonArea, polygonCentroid } from '../../src/util/math2d';
import type { FloorPlan } from '../../src/data/schema';
import { unreachableRooms } from './reach';

const p = (x: number, y: number) => ({ x, y });

function importSample(file: string, overrides: Partial<BuildRequest> = {}) {
  resetParseCaches();
  const bytes = new Uint8Array(readFileSync(`samples/${file}`));
  const model = readDrawing(bytes);
  const w = model.bounds.maxX - model.bounds.minX;
  const h = model.bounds.maxY - model.bounds.minY;
  const units = decideUnits(model.insunits, w, h);
  const req: BuildRequest = {
    roles: detectRoles(model),
    hidden: [],
    floors: detectFloors(model),
    settings: { ...DEFAULT_SETTINGS, units: units.units },
    fileName: file,
    ...overrides,
  };
  return { model, units, ...buildPlan(model, req) };
}

describe('encoding', () => {
  it('decodes legacy code pages declared in the header', () => {
    const head = '0\r\nSECTION\r\n2\r\nHEADER\r\n9\r\n$ACADVER\r\n1\r\nAC1018\r\n9\r\n$DWGCODEPAGE\r\n3\r\nANSI_1256\r\n0\r\nENDSEC\r\n';
    // "نوم" in Windows-1256 is E4 E6 E3.
    const bytes = new Uint8Array([...new TextEncoder().encode(head), 0xe4, 0xe6, 0xe3]);
    const d = decodeDxf(bytes);
    expect(d.encoding).toBe('windows-1256');
    expect(d.text.endsWith('نوم')).toBe(true);
  });

  it('uses UTF-8 for AutoCAD 2007 and later', () => {
    const head = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1027\n9\n$DWGCODEPAGE\n3\nANSI_1256\n0\nENDSEC\n';
    const d = decodeDxf(new TextEncoder().encode(head + 'مطبخ'));
    expect(d.encoding).toBe('utf-8');
    expect(d.text.endsWith('مطبخ')).toBe(true);
  });

  it('cleans MTEXT formatting and unicode escapes', () => {
    expect(cleanMText('{\\fArial|b1|i0;Living\\Proom}')).toBe('Living room');
    expect(cleanMText('\\H2.5x;\\C1;Kitchen')).toBe('Kitchen');
    expect(cleanText('\\U+0645\\U+0637\\U+0628\\U+062E')).toBe('مطبخ');
    expect(cleanText('%%c600')).toBe('⌀600');
  });
});

describe('units', () => {
  it('trusts $INSUNITS when the size is plausible', () => {
    expect(decideUnits(4, 9600, 5800)).toMatchObject({ units: 'mm', ask: false });
    expect(decideUnits(6, 9.6, 5.8)).toMatchObject({ units: 'm', ask: false });
  });
  it('asks when units are missing or implausible, with a sensible guess', () => {
    expect(decideUnits(0, 9600, 5800)).toMatchObject({ units: 'mm', ask: true });
    expect(decideUnits(null, 960, 580)).toMatchObject({ units: 'cm', ask: true });
    const huge = decideUnits(6, 9600, 5800);
    expect(huge.ask).toBe(true);
    expect(huge.units).toBe('mm');
    expect(guessUnits(32, 20)).toBe('ft');
  });
});

describe('layers', () => {
  it('detects roles from English and Arabic names', () => {
    expect(detectRole('A-WALL')).toBe('walls');
    expect(detectRole('L2_A-DOOR')).toBe('doors');
    expect(detectRole('A-GLAZ')).toBe('windows');
    expect(detectRole('S-STRS')).toBe('stairs');
    expect(detectRole('A-FURN-LOOSE')).toBe('furniture');
    expect(detectRole('جدران')).toBe('walls');
    expect(detectRole('أبواب')).toBe('doors');
    expect(detectRole('شبابيك')).toBe('windows');
    expect(detectRole('سلالم')).toBe('stairs');
    expect(detectRole('أثاث')).toBe('furniture');
    expect(detectRole('A-ANNO-DIMS')).toBe('ignore');
  });
});

describe('wall pairing', () => {
  it('turns two parallel lines into one wall with their distance as thickness', () => {
    const { pieces } = pairWalls(
      [
        { a: p(0, 0), b: p(5, 0) },
        { a: p(0, 0.2), b: p(5, 0.2) },
      ],
      WALL_DEFAULTS,
    );
    expect(pieces).toHaveLength(1);
    expect(pieces[0].thickness).toBeCloseTo(0.2, 3);
    expect(pieces[0].a.y).toBeCloseTo(0.1, 6);
  });

  it('pairs only the overlapping part and leaves a door gap open', () => {
    const r = extractWalls([
      { a: p(0, 0), b: p(2, 0) },
      { a: p(2.9, 0), b: p(5, 0) },
      { a: p(0, 0.2), b: p(2, 0.2) },
      { a: p(2.9, 0.2), b: p(5, 0.2) },
      // jamb caps
      { a: p(2, 0), b: p(2, 0.2) },
      { a: p(2.9, 0), b: p(2.9, 0.2) },
    ]);
    expect(r.walls).toHaveLength(2);
    const xs = r.walls.flatMap((w) => [w.a.x, w.b.x]).sort((a, b) => a - b);
    expect(xs[1]).toBeCloseTo(2, 3);
    expect(xs[2]).toBeCloseTo(2.9, 3);
  });

  it('removes duplicates and zero-length lines before pairing', () => {
    const { segs } = cleanSegments(
      [
        { a: p(0, 0), b: p(3, 0) },
        { a: p(3, 0), b: p(0, 0) },
        { a: p(1, 0), b: p(2, 0) },
        { a: p(4, 4), b: p(4, 4) },
      ],
      0.02,
    );
    expect(segs).toHaveLength(1);
  });

  it('keeps unpaired long lines as single-line walls at the default thickness', () => {
    const r = extractWalls([{ a: p(0, 0), b: p(4, 0) }], { defaultThickness: 0.15 });
    expect(r.walls).toHaveLength(1);
    expect(r.walls[0].thickness).toBe(0.15);
  });
});

describe('gap closing', () => {
  it('meets an L corner where both walls stop short', () => {
    const { pieces, closed } = closeGaps(
      [
        { a: p(0.1, 0), b: p(5, 0), thickness: 0.2, source: 'pair' },
        { a: p(0, 0.1), b: p(0, 4), thickness: 0.2, source: 'pair' },
      ],
      0.45,
      0.02,
    );
    expect(closed).toBeGreaterThan(0);
    expect(pieces[0].a.x).toBeCloseTo(0, 6);
    expect(pieces[1].a.y).toBeCloseTo(0, 6);
  });

  it('reports only real gaps, not double-line walls that end at a face', () => {
    const wall = (ax: number, ay: number, bx: number, by: number) => ({ a: p(ax, ay), b: p(bx, by), thickness: 0.2, source: 'pair' as const });
    // Ends exactly at the other wall's face: a normal junction.
    expect(closeGaps([wall(0.1, 0, 5, 0), wall(0, 0.1, 0, 4)], 0.45, 0.02).gaps).toBe(0);
    // One wall stops 5 cm short of the face.
    expect(closeGaps([wall(0.15, 0, 5, 0), wall(0, 0.1, 0, 4)], 0.45, 0.02).gaps).toBe(1);
  });

  it('runs a T end into the wall it stops short of', () => {
    const { pieces } = closeGaps(
      [
        { a: p(0, 0), b: p(6, 0), thickness: 0.2, source: 'pair' },
        { a: p(3, 0.1), b: p(3, 3), thickness: 0.2, source: 'pair' },
      ],
      0.45,
      0.02,
    );
    expect(pieces[1].a.y).toBeCloseTo(0, 6);
  });

  it('never closes a door-sized gap', () => {
    const { pieces } = closeGaps(
      [
        { a: p(0, 0), b: p(2, 0), thickness: 0.2, source: 'pair' },
        { a: p(2.9, 0), b: p(5, 0), thickness: 0.2, source: 'pair' },
      ],
      0.45,
      0.02,
    );
    expect(pieces[0].b.x).toBeCloseTo(2, 6);
    expect(pieces[1].a.x).toBeCloseTo(2.9, 6);
  });
});

describe('opening snapping', () => {
  const opts = { doorHeight: 2.1, windowSill: 0.9, windowHeight: 1.2, tolerance: 0.02, maxPassage: 1.6, minGap: 0.45 };

  it('places a swing arc in the wall gap, bridges the wall and reads the swing', () => {
    resetOpeningState();
    const walls = [
      { a: p(0, 0), b: p(2, 0), thickness: 0.2, source: 'pair' as const },
      { a: p(2.9, 0), b: p(5, 0), thickness: 0.2, source: 'pair' as const },
    ];
    // Hinge at x = 2, closed leaf along +x, swinging into +y.
    const r = placeOpenings(walls, [{ kind: 'arc', hinge: p(2, 0), radius: 0.9, ends: [p(2.9, 0), p(2, 0.9)], label: 'test' }], [], opts);
    expect(r.walls).toHaveLength(1);
    expect(r.openings).toHaveLength(1);
    const o = r.openings[0];
    expect(o.offset).toBeCloseTo(2.45, 3);
    expect(o.width).toBeCloseTo(0.9, 3);
    expect(o.swing).toEqual({ hinge: 'start', side: 'left' });
  });

  it('snaps a window block onto the nearest wall', () => {
    resetOpeningState();
    const walls = [{ a: p(0, 0), b: p(5, 0), thickness: 0.2, source: 'pair' as const }];
    const r = placeOpenings(walls, [], [{ corners: [p(1.4, -0.05), p(2.6, -0.05), p(2.6, 0.12), p(1.4, 0.12)], label: 'WIN' }], opts);
    expect(r.openings).toHaveLength(1);
    expect(r.openings[0].type).toBe('window');
    expect(r.openings[0].offset).toBeCloseTo(2, 3);
    expect(r.openings[0].width).toBeCloseTo(1.2, 3);
  });

  it('reports openings that are not on any wall', () => {
    resetOpeningState();
    const r = placeOpenings([{ a: p(0, 0), b: p(5, 0), thickness: 0.2, source: 'pair' }], [], [{ corners: [p(1, 3), p(2, 3), p(2, 3.2), p(1, 3.2)], label: 'WIN' }], opts);
    expect(r.openings).toHaveLength(0);
    expect(r.warnings.join(' ')).toContain('not on a wall');
  });
});

describe('room detection', () => {
  it('finds the faces of a wall graph and drops the outer one', () => {
    // Two rooms side by side: 4 x 3 and 3 x 3.
    const segs = [
      { a: p(0, 0), b: p(7, 0) },
      { a: p(7, 0), b: p(7, 3) },
      { a: p(7, 3), b: p(0, 3) },
      { a: p(0, 3), b: p(0, 0) },
      { a: p(4, 0), b: p(4, 3) },
    ];
    const faces = findFaces(segs, 0.01);
    expect(faces).toHaveLength(2);
    const areas = faces.map((f) => polygonArea(f)).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(9, 4);
    expect(areas[1]).toBeCloseTo(12, 4);
  });

  it('names rooms from labels inside them and falls back to Room N', () => {
    const segs = [
      { a: p(0, 0), b: p(7, 0) },
      { a: p(7, 0), b: p(7, 3) },
      { a: p(7, 3), b: p(0, 3) },
      { a: p(0, 3), b: p(0, 0) },
      { a: p(4, 0), b: p(4, 3) },
      // A dangling stub must not break the faces.
      { a: p(2, 0), b: p(2, 1) },
    ];
    const rooms = detectRooms(segs, [{ p: p(2, 1.5), text: 'Kitchen', height: 0.25 }, { p: p(2, 1), text: '12.0 m2', height: 0.15 }], 0.01);
    expect(rooms).toHaveLength(2);
    const k = rooms.find((r) => r.name === 'Kitchen')!;
    expect(k.floorMaterial).toBe('tile');
    expect(rooms.find((r) => r !== k)!.name).toBe('Room 1');
  });

  it('assigns materials by keyword in English and Arabic', () => {
    expect(materialFor('Master Bedroom').floorMaterial).toBe('oak');
    expect(materialFor('حمام').floorMaterial).toBe('tile');
    expect(materialFor('مطبخ').floorMaterial).toBe('tile');
    expect(materialFor('شرفة')).toEqual({ floorMaterial: 'concrete', outdoor: true });
  });
});

describe('sample files', () => {
  it('rejects DWG and binary DXF by content', async () => {
    const dwg = new File([new TextEncoder().encode('AC1032\u0000\u0000binary')], 'plan.dxf');
    expect(await classifyFile(dwg)).toBe('dwg');
    const bin = new File([new TextEncoder().encode('AutoCAD Binary DXF\r\n\u001a\u0000')], 'plan.dxf');
    expect(await classifyFile(bin)).toBe('binary-dxf');
    const ok = new File([readFileSync('samples/clean-layered.dxf')], 'clean-layered.dxf');
    expect(await classifyFile(ok)).toBe('dxf');
  });

  it('clean layered sample round-trips to the demo apartment', () => {
    const r = importSample('clean-layered.dxf');
    const mock = normalizePlan(createDemoPlan());
    expect(r.units.ask).toBe(false);
    expect(r.plan.floors).toHaveLength(2);
    const rooms = (pl: FloorPlan) => pl.floors.flatMap((f) => f.rooms);
    expect(rooms(r.plan)).toHaveLength(rooms(mock).length);
    // Every mock room has an imported room at the same place with an area within 2 percent.
    for (const [fi, f] of mock.floors.entries()) {
      for (const room of f.rooms) {
        const c = polygonCentroid(room.polygon);
        const match = r.plan.floors[fi].rooms.find((x) => x.name === room.name);
        expect(match, `${room.name} found`).toBeDefined();
        const area = polygonArea(match!.polygon);
        expect(Math.abs(area - polygonArea(room.polygon)) / polygonArea(room.polygon), room.name).toBeLessThan(0.02);
        const mc = polygonCentroid(match!.polygon);
        expect(Math.hypot(mc.x - c.x, mc.y - c.y), room.name).toBeLessThan(0.15);
        expect(match!.floorMaterial).toBe(room.floorMaterial);
      }
    }
    const openings = (pl: FloorPlan) => pl.floors.flatMap((f) => f.openings);
    expect(openings(r.plan).filter((o) => o.type === 'door')).toHaveLength(openings(mock).filter((o) => o.type === 'door').length);
    expect(openings(r.plan).filter((o) => o.type === 'window')).toHaveLength(openings(mock).filter((o) => o.type === 'window').length);
    expect(r.plan.stairs).toHaveLength(1);
    const fl = r.plan.stairs[0].flights[0];
    expect(fl.risers).toBe(17);
    expect(fl.going).toBeCloseTo(0.27, 2);
    expect(fl.direction.x).toBeCloseTo(-1, 3);
    expect(r.plan.floors[0].railings.length).toBeGreaterThan(0);
    expect(r.plan.floors.flatMap((f) => f.furniture).length).toBeGreaterThan(20);
  });

  it('single-line walls sample builds rooms with arc-swing doors', () => {
    const r = importSample('single-line-walls.dxf');
    expect(r.units).toMatchObject({ units: 'cm', ask: false });
    const f = r.plan.floors[0];
    expect(f.rooms.map((x) => x.name).sort()).toEqual(['Bathroom', 'Bedroom 1', 'Bedroom 2', 'Landing']);
    expect(f.openings.filter((o) => o.type === 'door')).toHaveLength(3);
    expect(f.openings.filter((o) => o.type === 'window').length).toBeGreaterThanOrEqual(5);
    for (const d of f.openings.filter((o) => o.type === 'door')) expect(d.swing).toBeDefined();
  });

  it('messy layer 0 sample asks for units and still finds the rooms', () => {
    const r = importSample('messy-layer0.dxf');
    expect(r.units).toMatchObject({ units: 'mm', ask: true });
    expect(r.model.encoding).toBe('windows-1256');
    const names = r.plan.floors[0].rooms.map((x) => x.name);
    expect(names).toContain('غرفة نوم 2');
    expect(names).toContain('Bedroom 1');
    expect(names).toHaveLength(4);
    expect(r.plan.floors[0].openings.filter((o) => o.type === 'door')).toHaveLength(3);
    expect(r.report.warnings.some((w) => w.kind === 'gap')).toBe(true);
  });

  it('lets every room of every sample be walked into', () => {
    for (const file of ['clean-layered.dxf', 'single-line-walls.dxf', 'messy-layer0.dxf']) {
      expect(unreachableRooms(importSample(file).plan), file).toEqual([]);
    }
  });
});
