import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readDrawing, resetParseCaches } from '../../src/data/dxf/parse';
import { prepareImport } from '../../src/data/dxf/prepare';
import { buildPlan } from '../../src/data/dxf/build';
import { DEFAULT_SETTINGS } from '../../src/data/dxf/types';
import { validatePlan } from '../../src/data/validate';
import { stairInfos } from '../../src/plan/stairs';
import { CollisionWorld } from '../../src/collision/world';

/*
 * A real drawing that stays on the developer's machine (it is private and never committed): a flat
 * with a mezzanine, both plans side by side in one model space, with a wrong unit in its header.
 * Looked for in $CAD_TOUR_PRIVATE, else in a `cad-tour-private` folder next to the main checkout.
 * Skipped when it is not there, as in CI.
 */
function privateFolder(): string | null {
  const candidates = [process.env.CAD_TOUR_PRIVATE, resolve(process.cwd(), '..', 'cad-tour-private')];
  // In a linked git worktree, `.git` is a file pointing into the main checkout's .git folder.
  const dotGit = resolve(process.cwd(), '.git');
  if (existsSync(dotGit) && statSync(dotGit).isFile()) {
    const m = /gitdir:\s*(.+)/.exec(readFileSync(dotGit, 'utf8'));
    // <main checkout>/.git/worktrees/<name>: the main checkout is three levels up.
    if (m) candidates.push(resolve(dirname(resolve(m[1].trim(), '..', '..')), '..', 'cad-tour-private'));
  }
  return candidates.find((c): c is string => !!c && existsSync(resolve(c, 'mezzanine.dxf'))) ?? null;
}

const folder = privateFolder();

function load(dir: string) {
  resetParseCaches();
  const model = readDrawing(new Uint8Array(readFileSync(resolve(dir, 'mezzanine.dxf'))));
  const prep = prepareImport(model);
  // The engineer's heights: 2.20 m below, a 0.12 m slab, 1.98 m on the mezzanine; a black steel stair.
  const settings = { ...DEFAULT_SETTINGS, units: prep.units.units, ceilingHeight: 2.2, floorToFloor: 2.32, upperCeilingHeight: 1.98, stairFinish: 'black-steel' as const };
  return { prep, r: buildPlan(model, { roles: prep.roles, hidden: [], floors: prep.floors, settings, fileName: 'mezzanine.dxf' }) };
}

describe.skipIf(!folder)('the private mezzanine drawing', () => {
  if (!folder) return;
  const { prep, r } = load(folder);
  const [main, mezz] = r.plan.floors;
  const count = (f: typeof main, type: string) => f.furniture.filter((x) => x.type === type).length;

  it('uses meters without asking, and says why', () => {
    expect(prep.units).toMatchObject({ units: 'm', ask: false, detected: 'mm' });
    expect(r.report.notes[0]).toMatch(/says millimeters.*drawn in meters/);
  });

  it('finds the two plans and lines the mezzanine up on the main level', () => {
    expect(prep.floors).toMatchObject({ mode: 'boxes', auto: true });
    expect(r.plan.floors).toHaveLength(2);
    expect(mezz.name).toBe('Mezzanine');
    expect(mezz.elevation).toBeCloseTo(2.32, 6);
    // The mezzanine plan is the main level's frame moved by (+15.328, +3.778), to the millimeter.
    expect(Math.abs(r.alignment[1].x + 15.328)).toBeLessThan(0.001);
    expect(Math.abs(r.alignment[1].y + 3.778)).toBeLessThan(0.001);
    // Exactly: the outside west walls of both levels share their centerline.
    const west = (f: typeof main) => Math.min(...f.walls.filter((w) => Math.abs(w.centerline[0].x - w.centerline[1].x) < 1e-6).map((w) => w.centerline[0].x));
    expect(west(mezz)).toBeCloseTo(west(main), 6);
    expect(validatePlan(r.plan).ok).toBe(true);
  });

  it('finds the rooms on both levels', () => {
    expect(main.rooms.length).toBeGreaterThanOrEqual(6);
    expect(main.rooms.length).toBeLessThanOrEqual(7);
    expect(mezz.rooms).toHaveLength(3);
    const names = main.rooms.map((x) => x.name);
    for (const n of ['Bedroom', 'Bathroom', 'Living room', 'Balcony']) expect(names).toContain(n);
    expect(mezz.rooms.map((x) => x.name).sort()).toEqual(['Bathroom', 'Bedroom', 'Landing']);
    expect(main.rooms.filter((x) => x.glazed)).toHaveLength(1);
  });

  it('builds the steel stair with its landing up to the mezzanine', () => {
    expect(r.plan.stairs).toHaveLength(1);
    const s = r.plan.stairs[0];
    expect(s.finish).toBe('black-steel');
    expect(s.flights.reduce((n, f) => n + f.risers, 0)).toBe(13);
    const mid = s.landings.find((l) => l.elevation < 2.3)!;
    expect(mid.elevation).toBeGreaterThan(1.85);
    expect(mid.elevation).toBeLessThan(2.05);
    // Walking up arrives at the mezzanine floor.
    const info = stairInfos(r.plan)[0];
    const world = new CollisionWorld(r.plan);
    let h = 0;
    const a = info.departure.point;
    const b = info.arrival.point;
    for (let i = 0; i <= 100; i++) h = world.heightAt({ x: a.x + ((b.x - a.x) * i) / 100, y: a.y + ((b.y - a.y) * i) / 100 }, h);
    // One step past the top riser, onto the landing.
    h = world.heightAt({ x: b.x + info.arrival.dir.x * 0.6, y: b.y + info.arrival.dir.y * 0.6 }, h);
    expect(h).toBeCloseTo(2.32, 3);
  });

  it('has the heights: 2.20 under the mezzanine, 1.98 on it, 4.30 beside it', () => {
    expect(main.ceilingHeight).toBeCloseTo(2.2, 6);
    expect(mezz.ceilingHeight).toBeCloseTo(1.98, 6);
    expect(main.slabThickness).toBeCloseTo(0.12, 6);
    const top = (name: string) => main.rooms.find((x) => x.name === name)!.ceilingHeight ?? main.ceilingHeight;
    expect(top('Bedroom')).toBeCloseTo(2.2, 6);
    expect(top('Living room')).toBeCloseTo(4.3, 6);
    expect(top('Balcony')).toBeCloseTo(4.3, 6);
  });

  it('brings in the furniture, columns, doors and glazing', () => {
    expect(count(main, 'bed-single')).toBe(3);
    expect(count(mezz, 'bed-single')).toBe(2);
    expect(count(main, 'sofa')).toBeGreaterThanOrEqual(1);
    expect(count(main, 'coffee-table')).toBe(1);
    expect(count(main, 'armchair')).toBe(2);
    expect(count(main, 'dining-table')).toBe(1);
    expect(count(main, 'chair')).toBe(6);
    expect(count(main, 'kitchen-sink')).toBe(1);
    expect(count(main, 'kitchen-hob')).toBe(1);
    expect(count(main, 'kitchen-counter')).toBeGreaterThanOrEqual(1);
    for (const f of [main, mezz]) {
      expect(count(f, 'wc')).toBe(1);
      expect(count(f, 'vanity')).toBe(1);
      expect(count(f, 'shower')).toBe(1);
      expect(count(f, 'wardrobe')).toBe(1);
    }
    expect(main.columns ?? []).toHaveLength(1);
    const doors = main.openings.filter((o) => o.type === 'door');
    expect(doors.filter((o) => (o.style ?? 'hinged') === 'hinged')).toHaveLength(4);
    expect(doors.filter((o) => o.style === 'sliding-glass')).toHaveLength(1);
    expect(mezz.railings.length).toBeGreaterThanOrEqual(1);
  });
});
