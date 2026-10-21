import { describe, expect, it } from 'vitest';
import { createDemoPlan } from '../../src/data/mock';
import { loadPlan } from '../../src/data/loader';
import { validatePlan } from '../../src/data/validate';
import { exportPlanJson, importPlanJson, PlanJsonError } from '../../src/data/planJson';
import type { Vec2 } from '../../src/data/schema';
import {
  dist,
  orientedRect,
  pointAlongPolyline,
  pointInPolygon,
  polygonArea,
  polylineLength,
  segmentIntersection,
  signedArea,
} from '../../src/util/math2d';

const plan = createDemoPlan();

/** Deep equality with a tolerance for numbers (exports round to micrometers). */
function expectClose(a: unknown, b: unknown, path = 'plan'): void {
  if (typeof a === 'number' && typeof b === 'number') {
    expect(Math.abs(a - b), path).toBeLessThan(1e-5);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    expect(a.length, path).toBe(b.length);
    a.forEach((v, i) => expectClose(v, b[i], `${path}[${i}]`));
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    expect(Object.keys(a as object).sort(), path).toEqual(Object.keys(b as object).sort());
    for (const k of Object.keys(a as object)) expectClose((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    return;
  }
  expect(a, path).toEqual(b);
}

function selfIntersects(poly: Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      const hit = segmentIntersection(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n], 1e-9);
      if (hit && hit.t > 1e-6 && hit.t < 1 - 1e-6) return true;
    }
  }
  return false;
}

describe('demo apartment', () => {
  it('passes schema validation', () => {
    const r = validatePlan(plan);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('has two floors 3 m apart with 2.8 m ceilings', () => {
    expect(plan.floors.map((f) => f.elevation)).toEqual([0, 3]);
    for (const f of plan.floors) expect(f.ceilingHeight).toBe(2.8);
  });

  it('has the agreed rooms on each floor', () => {
    const names = (i: number) => plan.floors[i].rooms.map((r) => r.name);
    expect(names(0)).toEqual(['Entry hall', 'Kitchen', 'Living and dining', 'Balcony']);
    expect(names(1)).toEqual(['Landing', 'Bedroom 2', 'Bathroom', 'Bedroom 1']);
  });

  it('has closed, counterclockwise, simple room polygons', () => {
    for (const f of plan.floors) {
      for (const r of f.rooms) {
        expect(r.polygon.length).toBeGreaterThanOrEqual(3);
        expect(signedArea(r.polygon)).toBeGreaterThan(0.5);
        expect(selfIntersects(r.polygon), r.name).toBe(false);
      }
    }
  });

  it('is about 110 m2 in total', () => {
    let indoor = 0;
    let outdoor = 0;
    for (const f of plan.floors) for (const r of f.rooms) (r.outdoor ? (outdoor += polygonArea(r.polygon)) : (indoor += polygonArea(r.polygon)));
    expect(indoor + outdoor).toBeGreaterThan(100);
    expect(indoor + outdoor).toBeLessThan(120);
    expect(outdoor).toBeCloseTo(6, 1);
  });

  it('uses 20 cm walls, 0.9 m doors and 1.2 m windows', () => {
    for (const f of plan.floors) {
      for (const w of f.walls) expect(w.thickness).toBe(0.2);
      for (const o of f.openings) {
        if (o.type === 'door' && o.style !== 'sliding-glass') expect(o.width).toBe(0.9);
        if (o.type === 'window' && !o.id.includes('bath')) expect(o.width).toBe(1.2);
      }
    }
  });

  it('places every opening fully inside its wall, clear of the wall ends and of each other', () => {
    for (const f of plan.floors) {
      const walls = new Map(f.walls.map((w) => [w.id, w]));
      for (const o of f.openings) {
        const w = walls.get(o.wallId);
        expect(w, o.id).toBeDefined();
        const l = polylineLength(w!.centerline);
        expect(o.offset - o.width / 2, o.id).toBeGreaterThanOrEqual(0.25);
        expect(o.offset + o.width / 2, o.id).toBeLessThanOrEqual(l - 0.25);
        expect(o.sill + o.height, o.id).toBeLessThanOrEqual(w!.height - 0.2);
      }
      for (const a of f.openings) {
        for (const b of f.openings) {
          if (a === b || a.wallId !== b.wallId) continue;
          const gap = Math.abs(a.offset - b.offset) - (a.width + b.width) / 2;
          expect(gap, `${a.id} vs ${b.id}`).toBeGreaterThan(0.2);
        }
      }
    }
  });

  it('has a stair that climbs exactly one floor', () => {
    expect(plan.stairs).toHaveLength(1);
    const s = plan.stairs[0];
    const fl = s.flights[0];
    expect(fl.risers * fl.riserHeight).toBeCloseTo(3, 6);
    expect(fl.riserHeight).toBeCloseTo(0.176, 3);
    expect((fl.risers - 1) * fl.going).toBeCloseTo(4.32, 2);
    // The flight footprint sits inside the outline.
    const end = { x: fl.start.x + fl.direction.x * (fl.risers - 1) * fl.going, y: fl.start.y + fl.direction.y * (fl.risers - 1) * fl.going };
    const inset = (q: Vec2) => ({ x: q.x + fl.direction.x * 0.01, y: q.y + fl.direction.y * 0.01 });
    expect(pointInPolygon(inset(fl.start), s.outline)).toBe(true);
    expect(pointInPolygon({ x: end.x + fl.direction.x * -0.01, y: end.y }, s.outline)).toBe(true);
  });

  it('keeps furniture inside its room and clear of walls', () => {
    for (const f of plan.floors) {
      for (const item of f.furniture) {
        const size = item.size ?? { x: 0.45, y: 0.45, z: 0.8 };
        const rect = orientedRect(item.position, size.x, size.y, item.rotation);
        const room = f.rooms.find((r) => pointInPolygon(item.position, r.polygon));
        expect(room, item.id).toBeDefined();
        if (item.type === 'rug' || item.type === 'pendant-lamp') continue;
        for (const w of f.walls) {
          const [a, b] = w.centerline;
          for (const c of rect) {
            // Distance from each corner to the wall centerline must be at least half the thickness.
            const t = Math.max(0, Math.min(1, ((c.x - a.x) * (b.x - a.x) + (c.y - a.y) * (b.y - a.y)) / dist(a, b) ** 2));
            const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
            expect(dist(c, q), `${item.id} vs ${w.id}`).toBeGreaterThanOrEqual(w.thickness / 2 - 0.011);
          }
        }
      }
    }
  });

  it('keeps door swings clear of furniture', () => {
    for (const f of plan.floors) {
      const walls = new Map(f.walls.map((w) => [w.id, w]));
      for (const o of f.openings) {
        if (o.type !== 'door' || o.style === 'sliding-glass' || !o.swing) continue;
        const w = walls.get(o.wallId)!;
        const { p, dir } = pointAlongPolyline(w.centerline, o.offset);
        const hingeSign = o.swing.hinge === 'start' ? -1 : 1;
        const hinge = { x: p.x + dir.x * hingeSign * (o.width / 2), y: p.y + dir.y * hingeSign * (o.width / 2) };
        const sideSign = o.swing.side === 'left' ? 1 : -1;
        const nrm = { x: -dir.y * sideSign, y: dir.x * sideSign };
        // Sample the swept quarter disc.
        for (let k = 0; k <= 8; k++) {
          const ang = (k / 8) * (Math.PI / 2);
          for (const r of [0.3, 0.6, o.width - 0.02]) {
            const along = -hingeSign * Math.cos(ang) * r;
            const out = Math.sin(ang) * r + w.thickness / 2;
            const q = { x: hinge.x + dir.x * along + nrm.x * out, y: hinge.y + dir.y * along + nrm.y * out };
            for (const item of f.furniture) {
              if (item.type === 'rug' || item.type === 'pendant-lamp') continue;
              const size = item.size ?? { x: 0.45, y: 0.45, z: 0.8 };
              expect(pointInPolygon(q, orientedRect(item.position, size.x, size.y, item.rotation)), `${o.id} hits ${item.id}`).toBe(false);
            }
          }
        }
      }
    }
  });
});

describe('plan JSON', () => {
  it('round-trips through export and import', async () => {
    const original = await loadPlan();
    const back = importPlanJson(exportPlanJson(original));
    expectClose(back, JSON.parse(JSON.stringify(original)));
  });

  it('accepts a bare FloorPlan object', () => {
    const back = importPlanJson(JSON.stringify(plan));
    expect(back.floors).toHaveLength(2);
  });

  it('rejects broken JSON and wrong shapes with reasons', () => {
    expect(() => importPlanJson('{nope')).toThrow(PlanJsonError);
    try {
      importPlanJson(JSON.stringify({ schemaVersion: 1, units: 'm', name: 'x', floors: [{ id: 'a' }], stairs: [] }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PlanJsonError);
      expect((e as PlanJsonError).details.length).toBeGreaterThan(0);
    }
  });

  it('flags openings that reference missing walls', () => {
    const bad = structuredClone(plan);
    bad.floors[0].openings[0].wallId = 'nope';
    const r = validatePlan(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain('no wall nope');
  });
});
