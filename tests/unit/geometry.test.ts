import { describe, expect, it } from 'vitest';
import { Vector3, type BufferGeometry } from 'three';
import { createDemoPlan } from '../../src/data/mock';
import { normalizePlan } from '../../src/data/validate';
import { buildExteriorGeometry, buildFloorGeometry } from '../../src/geometry';
import { exteriorOutline, wallSegments } from '../../src/plan/walls';
import { flightHeightAt, stairInfos } from '../../src/plan/stairs';
import { polygonArea } from '../../src/util/math2d';
import { subtractConvex } from '../../src/util/clip';
import { matchFurnitureType } from '../../src/geometry/furniture/registry';

const plan = normalizePlan(createDemoPlan());

/** Share of triangles whose winding normal disagrees with their vertex normals. */
function windingErrors(g: BufferGeometry): { bad: number; total: number } {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const idx = g.getIndex()!;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const fn = new Vector3();
  let bad = 0;
  let total = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const ia = idx.getX(i);
    const ib = idx.getX(i + 1);
    const ic = idx.getX(i + 2);
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    fn.subVectors(b, a).cross(new Vector3().subVectors(c, a));
    if (fn.lengthSq() < 1e-14) continue;
    n.set(0, 0, 0);
    for (const k of [ia, ib, ic]) n.add(new Vector3().fromBufferAttribute(nor, k));
    total++;
    if (fn.dot(n) <= 0) bad++;
  }
  return { bad, total };
}

describe('wall analysis', () => {
  it('splits walls at T junctions', () => {
    const segs = wallSegments(plan, plan.floors[0]);
    const west = segs.filter((s) => s.wallId === 'L1-w-west');
    // The hall/kitchen wall ends on the west wall at y = 2.8.
    expect(west.length).toBe(2);
    const south = segs.filter((s) => s.wallId === 'L1-w-south');
    expect(south.length).toBe(2); // the under-stair wall ends on it at x = 1.68
  });

  it('classifies exterior and interior faces', () => {
    const segs = wallSegments(plan, plan.floors[0]);
    for (const s of segs.filter((s) => s.wallId === 'L1-w-south')) {
      // Wall runs east, so its left face looks north into the flat.
      expect(s.leftExterior).toBe(false);
      expect(s.rightExterior).toBe(true);
    }
    const inner = segs.find((s) => s.wallId === 'L1-w-hall-living')!;
    expect(inner.leftExterior || inner.rightExterior).toBe(false);
  });

  it('miters corners so the outline closes around the building', () => {
    for (const f of plan.floors) {
      const outline = exteriorOutline(plan, f);
      expect(outline).not.toBeNull();
      expect(polygonArea(outline!)).toBeCloseTo(9.8 * 6.0, 1);
    }
  });

  it('assigns openings to the right wall pieces', () => {
    const segs = wallSegments(plan, plan.floors[0]);
    const all = segs.flatMap((s) => s.openings.map((o) => o.opening.id));
    expect(new Set(all).size).toBe(plan.floors[0].openings.length);
  });
});

describe('stair analysis', () => {
  const info = stairInfos(plan)[0];
  const f = info.flights[0];

  it('ramps smoothly from floor to floor', () => {
    const at = (s: number) => flightHeightAt(f, { x: f.flight.start.x + f.dir.x * s, y: f.flight.start.y }, 0)!;
    expect(at(-f.flight.going / 2)).toBeCloseTo(0, 6);
    expect(at(f.run + f.flight.going / 2)).toBeCloseTo(3, 6);
    let prev = -1;
    for (let s = -0.13; s <= f.run + 0.13; s += 0.05) {
      const h = at(s);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });

  it('finds the open side and the guard edge around the stairwell', () => {
    // Climbing west, the right side faces north into the living room for its lower half.
    expect(f.openRight.length).toBe(1);
    expect(f.openRight[0][0]).toBeCloseTo(0, 2);
    expect(f.openRight[0][1]).toBeGreaterThan(1.9);
    expect(f.openLeft.length).toBe(0);
    expect(info.guardEdges.length).toBe(1);
    expect(info.arrivalEdge).toBeGreaterThanOrEqual(0);
  });
});

describe('built geometry', () => {
  const builds = plan.floors.map((_, i) => buildFloorGeometry(plan, i));

  it('has front faces that agree with their normals', () => {
    for (const b of builds) {
      for (const [key, g] of [...b.shell, ...b.furniture]) {
        const { bad, total } = windingErrors(g);
        expect(bad / Math.max(1, total), `${b.floorId} ${key}: ${bad}/${total}`).toBeLessThan(0.02);
      }
      for (const d of b.doors) for (const p of d.parts) expect(windingErrors(p.geometry).bad).toBe(0);
    }
    for (const [key, g] of buildExteriorGeometry(plan, 12)) expect(windingErrors(g).bad, key).toBe(0);
  });

  it('has no NaN positions and stays under the draw call budget', () => {
    let calls = 0;
    for (const b of builds) {
      calls += b.shell.size + b.furniture.size + b.doors.reduce((n, d) => n + d.parts.length, 0);
      for (const g of [...b.shell.values(), ...b.furniture.values()]) {
        const arr = g.getAttribute('position').array as Float32Array;
        for (let i = 0; i < arr.length; i++) expect(Number.isFinite(arr[i])).toBe(true);
      }
    }
    expect(calls).toBeLessThan(110);
  });

  it('builds one door leaf per hinged or sliding door', () => {
    const doors = builds.flatMap((b) => b.doors);
    const expected = plan.floors.flatMap((f) => f.openings.filter((o) => o.type === 'door' && o.style !== 'passage'));
    expect(doors.length).toBe(expected.length);
  });
});

describe('clipping', () => {
  const sq = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  it('returns a hole when the opening is inside', () => {
    const r = subtractConvex(sq(0, 0, 10, 10), sq(2, 2, 4, 4));
    expect(r.hole).not.toBeNull();
  });
  it('splits into pieces when the opening crosses the edge', () => {
    const r = subtractConvex(sq(0, 0, 10, 10), sq(8, 2, 12, 4));
    expect(r.hole).toBeNull();
    const area = r.pieces.reduce((a, p) => a + polygonArea(p), 0);
    expect(area).toBeCloseTo(100 - 4, 6);
  });
});

describe('furniture registry', () => {
  it('matches English and Arabic block names', () => {
    expect(matchFurnitureType(['BED_DOUBLE'], 1.6, 2)).toBe('bed-double');
    expect(matchFurnitureType(['سرير'], 0.9, 2)).toBe('bed-single');
    expect(matchFurnitureType(['A-FURN-SOFA-3S'])).toBe('sofa');
    expect(matchFurnitureType(['كنبة'])).toBe('sofa');
    expect(matchFurnitureType(['WC-01'])).toBe('wc');
    expect(matchFurnitureType(['مغسلة'])).toBe('vanity');
    expect(matchFurnitureType(['DINING TABLE 6'])).toBe('dining-table');
    expect(matchFurnitureType(['chair'])).toBe('chair');
    expect(matchFurnitureType(['خزانة'])).toBe('wardrobe');
    expect(matchFurnitureType(['XYZ-123'])).toBeNull();
  });
});
