import { DxfWriter, type EntityWriter, type P } from '../../scripts/lib/dxf-writer';

/* A synthetic drawing for the unit and browser tests: a flat and its mezzanine drawn side by side. */

const p = (x: number, y: number) => ({ x, y });

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
export function twoPlans(): Uint8Array {
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
