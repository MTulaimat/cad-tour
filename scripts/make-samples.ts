// Generates the three sample DXF files in samples/ from the demo apartment.
//   clean-layered.dxf      the demo apartment, both floors side by side (L1_ / L2_ layers), double-line
//                          walls, door and window blocks, room labels, room boundaries, stair with
//                          riser lines and an arrow, furniture blocks; millimeters, AC1027.
//   single-line-walls.dxf  the upper floor as centerline walls, labels and arc-swing doors; centimeters.
//   messy-layer0.dxf       the upper floor with everything on layer 0, duplicate lines, tiny gaps,
//                          no units in the header, and an Arabic label in code page 1256 (AC1018).
// Run: npx tsx scripts/make-samples.ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { createDemoPlan } from '../src/data/mock';
import { normalizePlan } from '../src/data/validate';
import type { Floor, FloorPlan, Furniture, Opening, Vec2 } from '../src/data/schema';
import { faceRange, segmentPoint, wallSegments, type WallSegment } from '../src/plan/walls';
import { stairInfos } from '../src/plan/stairs';
import { furnitureSize } from '../src/geometry/furniture';
import { interiorPoint, polygonArea } from '../src/util/math2d';
import { DxfWriter, encodeCodepage, type EntityWriter, type P } from './lib/dxf-writer';

const plan = normalizePlan(createDemoPlan());
mkdirSync('samples', { recursive: true });

type Xf = (p: Vec2) => P;

const deg = (r: number) => (r * 180) / Math.PI;

// ---- shared drawing helpers -----------------------------------------------------------------

/** Double-line wall faces broken at openings, with jamb caps and free-end caps. */
function drawWallFaces(w: EntityWriter, s: WallSegment, layer: string, X: Xf, opts: { gapAt?: (side: number, u: number) => number } = {}) {
  const t = s.thickness;
  for (const left of [true, false]) {
    const side = left ? t / 2 : -t / 2;
    const [f0, f1] = faceRange(s, left);
    const u0 = Math.min(f0, f1);
    const u1 = Math.max(f0, f1);
    let cur = u0;
    for (const o of s.openings) {
      if (o.u0 > cur) w.line(layer, X(segmentPoint(s, cur, side)), X(segmentPoint(s, o.u0 - (opts.gapAt?.(side, o.u0) ?? 0), side)));
      cur = Math.max(cur, o.u1);
    }
    if (cur < u1) w.line(layer, X(segmentPoint(s, cur, side)), X(segmentPoint(s, u1 - (opts.gapAt?.(side, u1) ?? 0), side)));
  }
  for (const o of s.openings) for (const u of [o.u0, o.u1]) w.line(layer, X(segmentPoint(s, u, -t / 2)), X(segmentPoint(s, u, t / 2)));
  if (!s.startJoined) w.line(layer, X(s.startLeft), X(s.startRight));
  if (!s.endJoined) w.line(layer, X(s.endLeft), X(s.endRight));
}

interface DoorGeom {
  hinge: Vec2;
  closed: Vec2;
  open: Vec2;
  width: number;
}

function doorGeom(s: WallSegment, o: { opening: Opening; u0: number; u1: number }): DoorGeom {
  const sw = o.opening.swing ?? { hinge: 'start', side: 'left' };
  const hingeU = sw.hinge === 'start' ? o.u0 : o.u1;
  const closed = sw.hinge === 'start' ? s.dir : { x: -s.dir.x, y: -s.dir.y };
  const open = sw.side === 'left' ? s.nrm : { x: -s.nrm.x, y: -s.nrm.y };
  return { hinge: segmentPoint(s, hingeU, 0), closed, open, width: o.u1 - o.u0 };
}

const mirrored = (g: DoorGeom) => g.closed.x * g.open.y - g.closed.y * g.open.x < 0;

function furnitureBlockName(f: Furniture): string {
  const s = furnitureSize(f);
  const base = { 'bed-double': 'BED-DOUBLE', 'bed-single': 'BED-SINGLE', 'kitchen-counter': 'KITCHEN-COUNTER', 'kitchen-sink': 'KITCHEN-SINK', 'kitchen-hob': 'HOB', 'wall-cabinet': 'WALL-CABINET', 'coffee-table': 'COFFEE-TABLE', 'dining-table': 'DINING-TABLE', 'floor-lamp': 'FLOOR-LAMP', 'pendant-lamp': 'PENDANT-LAMP', 'bistro-table': 'BISTRO-TABLE', 'bistro-chair': 'BISTRO-CHAIR', 'tv-unit': 'TV-UNIT' }[f.type] ?? f.type.toUpperCase();
  return `${base}-${Math.round(s.x * 1000)}x${Math.round(s.y * 1000)}`;
}

function drawFurniture(w: DxfWriter, f: Furniture, layer: string, X: Xf, unit: number) {
  if (f.type === 'pendant-lamp') return;
  const s = furnitureSize(f);
  const name = furnitureBlockName(f);
  w.block(name, (b) => {
    const hx = (s.x * unit) / 2;
    const hy = (s.y * unit) / 2;
    b.polyline('0', [
      { x: -hx, y: -hy },
      { x: hx, y: -hy },
      { x: hx, y: hy },
      { x: -hx, y: hy },
    ], true);
    // A front line, as furniture blocks usually show.
    b.line('0', { x: -hx * 0.8, y: -hy * 0.6 }, { x: hx * 0.8, y: -hy * 0.6 });
  });
  w.insert(layer, name, X(f.position), deg(f.rotation));
}

function labelRooms(w: EntityWriter, floor: Floor, layer: string, X: Xf, unit: number, areaLayer?: string, rename?: (name: string) => string) {
  for (const r of floor.rooms) {
    const p = interiorPoint(r.polygon);
    w.text(layer, X(p), 0.25 * unit, rename ? rename(r.name) : r.name);
    if (areaLayer) w.text(areaLayer, X({ x: p.x, y: p.y - 0.4 }), 0.15 * unit, `${polygonArea(r.polygon).toFixed(1)} m2`);
  }
}

// ---- clean layered: the demo apartment, both floors side by side -----------------------------

function cleanLayered(p: FloorPlan): string {
  const unit = 1000;
  const w = new DxfWriter({ version: 'AC1027', insunits: 4, codepage: 'ANSI_1252' });
  w.block('DOOR-900', (b) => {
    b.line('0', { x: 0, y: 0 }, { x: 0, y: 900 });
    b.arc('0', { x: 0, y: 0 }, 900, 0, 90);
  });
  w.block('SLIDING-DOOR-2000', (b) => {
    b.polyline('0', [{ x: -1000, y: -60 }, { x: 20, y: -60 }, { x: 20, y: -10 }, { x: -1000, y: -10 }], true);
    b.polyline('0', [{ x: -20, y: 10 }, { x: 1000, y: 10 }, { x: 1000, y: 60 }, { x: -20, y: 60 }], true);
  });
  for (const ww of [1200, 900]) {
    w.block(`WIN-${ww}`, (b) => {
      b.polyline('0', [{ x: -ww / 2, y: -100 }, { x: ww / 2, y: -100 }, { x: ww / 2, y: 100 }, { x: -ww / 2, y: 100 }], true);
      b.line('0', { x: -ww / 2, y: 0 }, { x: ww / 2, y: 0 });
      b.line('0', { x: -ww / 2, y: 20 }, { x: ww / 2, y: 20 });
    });
  }
  p.floors.forEach((floor, k) => {
    const pre = `L${k + 1}_`;
    const off = k * 20;
    const X: Xf = (q) => ({ x: (q.x + off) * unit, y: q.y * unit });
    for (const [name, color] of [
      ['A-WALL', 7],
      ['A-DOOR', 3],
      ['A-GLAZ', 5],
      ['A-STRS', 2],
      ['A-FURN', 8],
      ['A-AREA-IDEN', 1],
      ['A-AREA', 6],
    ] as [string, number][])
      w.layer(pre + name, color);
    w.layer('DIM', 4);
    for (const s of wallSegments(p, floor)) {
      drawWallFaces(w, s, `${pre}A-WALL`, X);
      for (const o of s.openings) {
        const op = o.opening;
        const mid = segmentPoint(s, (o.u0 + o.u1) / 2, 0);
        const rot = deg(Math.atan2(s.dir.y, s.dir.x));
        if (op.type === 'window') w.insert(`${pre}A-GLAZ`, `WIN-${Math.round(op.width * 1000)}`, X(mid), rot);
        else if (op.style === 'sliding-glass') w.insert(`${pre}A-DOOR`, 'SLIDING-DOOR-2000', X(mid), rot);
        else {
          const g = doorGeom(s, o);
          w.insert(`${pre}A-DOOR`, 'DOOR-900', X(g.hinge), deg(Math.atan2(g.closed.y, g.closed.x)), 1, mirrored(g) ? -1 : 1);
        }
      }
    }
    labelRooms(w, floor, `${pre}A-AREA-IDEN`, X, unit, `${pre}A-AREA-IDEN`);
    // Room boundaries that are not walls: the kitchen/living split and the balcony edge.
    if (k === 0) {
      w.line(`${pre}A-AREA`, X({ x: 3.8, y: 2.8 }), X({ x: 3.8, y: 5.8 }));
      w.polyline(`${pre}A-AREA`, [X({ x: 9.6, y: 1.5 }), X({ x: 11.1, y: 1.5 }), X({ x: 11.1, y: 5.5 }), X({ x: 9.6, y: 5.5 })]);
    }
    for (const f of floor.furniture) drawFurniture(w, f, `${pre}A-FURN`, X, unit);
    // Dimensions drawn as plain lines and text on an annotation layer (to be ignored).
    w.line('DIM', X({ x: 0, y: -1 }), X({ x: 9.6, y: -1 }));
    w.text('DIM', X({ x: 4.8, y: -1.3 }), 180, '9600');
  });
  // Stair: drawn on both floors; the lower drawing has riser lines and the UP arrow.
  for (const info of stairInfos(p)) {
    const f = info.flights[0];
    const fl = f.flight;
    for (const k of [0, 1]) {
      const pre = `L${k + 1}_`;
      const off = k * 20;
      const X: Xf = (q) => ({ x: (q.x + off) * unit, y: q.y * unit });
      w.polyline(`${pre}A-STRS`, info.stair.outline.map(X), true);
      const n = k === 0 ? fl.risers : 5;
      for (let i = 0; i < n; i++) {
        const s = k === 0 ? i * fl.going : (i + 1) * fl.going * 2;
        const c = { x: fl.start.x + f.dir.x * s, y: fl.start.y + f.dir.y * s };
        const hw = fl.width / 2;
        w.line(`${pre}A-STRS`, X({ x: c.x + f.side.x * hw, y: c.y + f.side.y * hw }), X({ x: c.x - f.side.x * hw, y: c.y - f.side.y * hw }));
      }
      if (k === 0) {
        const a = { x: fl.start.x + f.dir.x * 0.15, y: fl.start.y + f.dir.y * 0.15 };
        const b = { x: fl.start.x + f.dir.x * (f.run - 0.15), y: fl.start.y + f.dir.y * (f.run - 0.15) };
        w.polyline(`${pre}A-STRS`, [X(a), X(b)]);
        const back = { x: -f.dir.x * 0.25, y: -f.dir.y * 0.25 };
        for (const sgn of [1, -1]) w.line(`${pre}A-STRS`, X(b), X({ x: b.x + back.x + f.side.x * 0.15 * sgn, y: b.y + back.y + f.side.y * 0.15 * sgn }));
        w.text(`${pre}A-STRS`, X({ x: a.x + f.dir.x * 0.3, y: a.y }), 150, 'UP');
      } else w.text(`${pre}A-STRS`, X({ x: fl.start.x + f.dir.x * f.run * 0.5, y: fl.start.y }), 150, 'DN');
    }
  }
  return w.toString();
}

// ---- single-line walls: the upper floor as centerlines ----------------------------------------

function singleLine(p: FloorPlan): string {
  const unit = 100;
  const floor = p.floors[1];
  const w = new DxfWriter({ version: 'AC1027', insunits: 5, codepage: 'ANSI_1252' });
  for (const l of ['WALLS', 'DOORS', 'WINDOWS', 'TEXT']) w.layer(l);
  const X: Xf = (q) => ({ x: q.x * unit, y: q.y * unit });
  for (const s of wallSegments(p, floor)) {
    // Centerline, broken at doors only (windows sit on the line).
    let cur = 0;
    for (const o of s.openings) {
      if (o.opening.type !== 'door') continue;
      if (o.u0 > cur) w.line('WALLS', X(segmentPoint(s, cur)), X(segmentPoint(s, o.u0)));
      cur = o.u1;
      const g = doorGeom(s, o);
      const r = g.width;
      const tip = { x: g.hinge.x + g.open.x * r, y: g.hinge.y + g.open.y * r };
      const other = { x: g.hinge.x + g.closed.x * r, y: g.hinge.y + g.closed.y * r };
      w.line('DOORS', X(g.hinge), X(tip));
      let a0 = Math.atan2(g.closed.y, g.closed.x);
      let a1 = Math.atan2(g.open.y, g.open.x);
      if (mirrored(g)) [a0, a1] = [a1, a0];
      w.arc('DOORS', X(g.hinge), r * unit, deg(a0), deg(a1));
      void other;
    }
    if (cur < s.length) w.line('WALLS', X(segmentPoint(s, cur)), X(s.b));
    for (const o of s.openings) {
      if (o.opening.type !== 'window') continue;
      const a = segmentPoint(s, o.u0, -0.08);
      const b = segmentPoint(s, o.u1, -0.08);
      const c = segmentPoint(s, o.u1, 0.08);
      const d = segmentPoint(s, o.u0, 0.08);
      w.polyline('WINDOWS', [X(a), X(b), X(c), X(d)], true);
    }
  }
  labelRooms(w, floor, 'TEXT', X, unit);
  return w.toString();
}

// ---- messy: everything on layer 0, duplicates, gaps, no units, Arabic label ---------------------

function messy(p: FloorPlan): Uint8Array {
  const unit = 1000;
  const floor = p.floors[1];
  const w = new DxfWriter({ version: 'AC1018', insunits: 0, codepage: 'ANSI_1256' });
  const X: Xf = (q) => ({ x: q.x * unit + 50000, y: q.y * unit + 20000 });
  w.block('WIN', (b) => {
    b.polyline('0', [{ x: -600, y: -100 }, { x: 600, y: -100 }, { x: 600, y: 100 }, { x: -600, y: 100 }], true);
    b.line('0', { x: -600, y: 0 }, { x: 600, y: 0 });
  });
  let k = 0;
  for (const s of wallSegments(p, floor)) {
    k++;
    // Every third wall's faces stop 3 mm short (tiny gaps); every fourth is drawn twice.
    drawWallFaces(w, s, '0', X, { gapAt: () => (k % 3 === 0 ? 0.003 : 0) });
    if (k % 4 === 0) drawWallFaces(w, s, '0', X);
    for (const o of s.openings) {
      if (o.opening.type === 'window') {
        const mid = segmentPoint(s, (o.u0 + o.u1) / 2, 0);
        const sc = (o.u1 - o.u0) / 1.2;
        w.insert('0', 'WIN', X(mid), deg(Math.atan2(s.dir.y, s.dir.x)), sc, 1);
        continue;
      }
      const g = doorGeom(s, o);
      const r = g.width;
      const tip = { x: g.hinge.x + g.open.x * r, y: g.hinge.y + g.open.y * r };
      w.line('0', X(g.hinge), X(tip));
      let a0 = Math.atan2(g.closed.y, g.closed.x);
      let a1 = Math.atan2(g.open.y, g.open.x);
      if (mirrored(g)) [a0, a1] = [a1, a0];
      w.arc('0', X(g.hinge), r * unit, deg(a0), deg(a1));
    }
  }
  for (const f of floor.furniture) drawFurniture(w, f, '0', X, unit);
  for (const r of floor.rooms) {
    const pt = interiorPoint(r.polygon);
    if (r.name === 'Bedroom 2') w.text('0', X(pt), 250, 'غرفة نوم 2');
    else if (r.name === 'Bedroom 1') w.mtext('0', X(pt), 250, '{\\fArial|b1|i0|c0;Bedroom 1}');
    else w.text('0', X(pt), 250, r.name);
  }
  const text = w.toString();
  // Encode in Windows-1256 (the header declares ANSI_1256 for a pre-2007 file).
  const parts = text.split(/(غرفة نوم 2)/);
  const chunks = parts.map((part) => (part === 'غرفة نوم 2' ? encodeCodepage(part, 'windows-1256') : new TextEncoder().encode(part)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

writeFileSync('samples/clean-layered.dxf', cleanLayered(plan));
writeFileSync('samples/single-line-walls.dxf', singleLine(plan));
writeFileSync('samples/messy-layer0.dxf', messy(plan));
console.log('wrote samples/clean-layered.dxf, samples/single-line-walls.dxf, samples/messy-layer0.dxf');
