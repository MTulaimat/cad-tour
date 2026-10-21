import { BufferGeometry, CylinderGeometry, Euler, IcosahedronGeometry, Matrix4, Quaternion, SphereGeometry, TorusGeometry, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Size3 } from '../../data/schema';
import type { MaterialKey } from '../../materials/keys';
import type { BuilderSet } from '../builder';

/**
 * Procedural furniture in a Scandinavian light style, built from rounded primitives.
 *
 * Local frame of every piece: x is its width (centered), y is up from the floor,
 * z is its depth (centered) with the front at +z. At yaw 0 the front faces plan south,
 * which matches the schema's furniture rotation.
 */

export interface PieceContext {
  /** Clear height from the floor to the ceiling, for ceiling-hung pieces. */
  ceiling: number;
}

type Builder = (p: Parts, s: Size3, ctx: PieceContext) => void;

const geoCache = new Map<string, BufferGeometry>();
function cached(key: string, make: () => BufferGeometry): BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

/** Frees the primitive cache after a build pass. */
export function disposePrimitiveCache(): void {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
}

const r3 = (v: number) => Math.round(v * 1000);

export class Parts {
  constructor(
    private sets: BuilderSet,
    private base: Matrix4,
  ) {}

  private put(key: MaterialKey, g: BufferGeometry, pos: Vector3, rot?: Euler, scale?: Vector3, boxUV = true): void {
    const local = new Matrix4().compose(pos, new Quaternion().setFromEuler(rot ?? new Euler()), scale ?? new Vector3(1, 1, 1));
    this.sets.get(key).append(g, new Matrix4().multiplyMatrices(this.base, local), boxUV);
  }

  box(key: MaterialKey, x: number, y: number, z: number, sx: number, sy: number, sz: number, rot?: Euler): void {
    const m = new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(rot ?? new Euler()), new Vector3(1, 1, 1));
    this.sets.get(key).box(new Matrix4().multiplyMatrices(this.base, m), sx, sy, sz);
  }

  rbox(key: MaterialKey, x: number, y: number, z: number, sx: number, sy: number, sz: number, radius: number, rot?: Euler, seg = 2): void {
    const r = Math.max(0.001, Math.min(radius, sx / 2 - 1e-4, sy / 2 - 1e-4, sz / 2 - 1e-4));
    const g = cached(`rb${r3(sx)},${r3(sy)},${r3(sz)},${r3(r)},${seg}`, () => new RoundedBoxGeometry(sx, sy, sz, seg, r));
    this.put(key, g, new Vector3(x, y, z), rot);
  }

  cyl(key: MaterialKey, x: number, y: number, z: number, rTop: number, rBottom: number, h: number, seg = 16, rot?: Euler, open = false): void {
    const g = cached(`cy${r3(rTop)},${r3(rBottom)},${r3(h)},${seg},${open}`, () => new CylinderGeometry(rTop, rBottom, h, seg, 1, open));
    this.put(key, g, new Vector3(x, y, z), rot);
  }

  sphere(key: MaterialKey, x: number, y: number, z: number, r: number, scale?: Vector3, detail = 1): void {
    const g = cached(`ic${r3(r)},${detail}`, () => new IcosahedronGeometry(r, detail));
    this.put(key, g, new Vector3(x, y, z), undefined, scale);
  }

  ball(key: MaterialKey, x: number, y: number, z: number, r: number, scale?: Vector3): void {
    const g = cached(`sp${r3(r)}`, () => new SphereGeometry(r, 18, 12));
    this.put(key, g, new Vector3(x, y, z), undefined, scale);
  }

  torus(key: MaterialKey, x: number, y: number, z: number, r: number, tube: number, arc: number, rot?: Euler): void {
    const g = cached(`to${r3(r)},${r3(tube)},${r3(arc * 100)}`, () => new TorusGeometry(r, tube, 8, 24, arc));
    this.put(key, g, new Vector3(x, y, z), rot, undefined, false);
  }
}

// --- helpers -------------------------------------------------------------

function taperedLegs(p: Parts, key: MaterialKey, w: number, d: number, h: number, inset: number, r = 0.022): void {
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) p.cyl(key, sx * (w / 2 - inset), h / 2, sz * (d / 2 - inset), r * 0.75, r, h, 10);
}

function doorFronts(p: Parts, key: MaterialKey, x0: number, x1: number, y0: number, y1: number, zFront: number, count: number, handles = true): void {
  const gap = 0.004;
  const w = (x1 - x0) / count;
  for (let i = 0; i < count; i++) {
    const cx = x0 + w * (i + 0.5);
    p.box(key, cx, (y0 + y1) / 2, zFront + 0.009, w - gap, y1 - y0 - gap, 0.018);
    if (handles) {
      // Slim brushed bar near the meeting edge.
      const hx = i % 2 === 0 ? cx + w / 2 - 0.04 : cx - w / 2 + 0.04;
      const hy = y1 - y0 > 1.0 ? (y0 + y1) / 2 : y1 - 0.06;
      const vertical = y1 - y0 > 0.5;
      p.box('metal-brushed', hx, hy, zFront + 0.03, vertical ? 0.012 : 0.12, vertical ? 0.16 : 0.012, 0.012);
    }
  }
}

// --- pieces --------------------------------------------------------------

const sofa: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  const legH = 0.12;
  const arm = 0.15;
  const backT = 0.2;
  taperedLegs(p, 'wood-light', w - 0.04, d - 0.06, legH, 0.06, 0.02);
  p.rbox('fabric', 0, legH + 0.12, 0, w, 0.24, d, 0.04);
  // Arms.
  for (const sx of [-1, 1]) p.rbox('fabric', sx * (w / 2 - arm / 2), legH + 0.28, 0, arm, 0.56 - legH + 0.12, d, 0.05);
  // Back.
  p.rbox('fabric', 0, legH + 0.24 + (h - legH - 0.24) / 2, -d / 2 + backT / 2, w - 2 * arm + 0.02, h - legH - 0.24, backT, 0.05);
  // Seat and back cushions.
  const inner = w - 2 * arm;
  const n = inner > 1.6 ? 2 : 1;
  const cw = inner / n;
  for (let i = 0; i < n; i++) {
    const cx = -inner / 2 + cw * (i + 0.5);
    p.rbox('fabric', cx, legH + 0.24 + 0.065, backT / 2 - 0.01, cw - 0.01, 0.13, d - backT + 0.02, 0.05, undefined, 3);
    p.rbox('fabric', cx, legH + 0.24 + 0.13 + 0.2, -d / 2 + backT + 0.08, cw - 0.02, 0.4, 0.16, 0.06, new Euler(-0.18, 0, 0), 3);
  }
  // Two accent pillows.
  for (const sx of [-1, 1]) p.rbox('fabric-accent', sx * (inner / 2 - 0.25), legH + 0.24 + 0.13 + 0.2, -d / 2 + backT + 0.2, 0.42, 0.38, 0.12, 0.06, new Euler(-0.25, sx * 0.25, sx * 0.05), 3);
};

const armchair: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  const legH = 0.14;
  taperedLegs(p, 'wood-light', w - 0.06, d - 0.06, legH, 0.06, 0.02);
  p.rbox('fabric', 0, legH + 0.11, 0, w, 0.22, d, 0.04);
  for (const sx of [-1, 1]) p.rbox('fabric', sx * (w / 2 - 0.07), legH + 0.27, 0.02, 0.14, 0.32, d - 0.04, 0.05);
  p.rbox('fabric', 0, legH + 0.22 + (h - legH - 0.22) / 2, -d / 2 + 0.09, w - 0.04, h - legH - 0.22, 0.18, 0.06, new Euler(-0.08, 0, 0));
  p.rbox('fabric', 0, legH + 0.28, 0.08, w - 0.28, 0.12, d - 0.26, 0.05, undefined, 3);
};

const coffeeTable: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  p.rbox('wood-light', 0, h - 0.018, 0, w, 0.036, d, 0.012);
  taperedLegs(p, 'wood-light', w, d, h - 0.036, 0.09, 0.02);
  p.rbox('wood-light', 0, 0.14, 0, w - 0.16, 0.02, d - 0.16, 0.006);
};

const diningTable: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  p.rbox('wood-light', 0, h - 0.019, 0, w, 0.038, d, 0.012);
  p.box('wood-light', 0, h - 0.08, 0, w - 0.18, 0.08, d - 0.18);
  taperedLegs(p, 'wood-light', w, d, h - 0.038, 0.07, 0.026);
};

const chair: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  const seatH = 0.45;
  taperedLegs(p, 'wood-light', w, d, seatH - 0.03, 0.035, 0.016);
  p.rbox('wood-light', 0, seatH - 0.015, 0.01, w, 0.03, d - 0.02, 0.01);
  p.rbox('fabric', 0, seatH + 0.012, 0.02, w - 0.05, 0.025, d - 0.08, 0.01);
  // Back posts and a curved rail.
  for (const sx of [-1, 1]) p.cyl('wood-light', sx * (w / 2 - 0.035), (seatH + h) / 2, -d / 2 + 0.035, 0.014, 0.016, h - seatH, 8, new Euler(-0.1, 0, 0));
  p.rbox('wood-light', 0, h - 0.07, -d / 2 + 0.02, w - 0.02, 0.1, 0.022, 0.01, new Euler(-0.1, 0, 0));
};

const bed: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  const frameH = 0.32;
  // Frame on low legs, upholstered headboard at the head (-z).
  taperedLegs(p, 'wood-light', w - 0.02, d - 0.02, 0.1, 0.05, 0.022);
  p.rbox('wood-light', 0, 0.1 + (frameH - 0.1) / 2, 0.02, w, frameH - 0.1, d - 0.04, 0.02);
  p.rbox('fabric', 0, h / 2, -d / 2 + 0.05, w + 0.04, h, 0.1, 0.04);
  // Mattress, duvet, pillows, throw.
  const top = frameH + 0.2;
  p.rbox('linen', 0, frameH + 0.1, 0.04, w - 0.06, 0.2, d - 0.16, 0.05, undefined, 3);
  p.rbox('linen', 0, top + 0.035, 0.16, w - 0.02, 0.08, d - 0.42, 0.04, undefined, 3);
  const pillows = w > 1.2 ? 2 : 1;
  const pw = (w - 0.16) / pillows;
  for (let i = 0; i < pillows; i++) p.rbox('linen', -w / 2 + 0.08 + pw * (i + 0.5), top + 0.07, -d / 2 + 0.3, pw - 0.06, 0.14, 0.36, 0.06, new Euler(-0.15, 0, 0), 3);
  p.rbox('fabric-accent', 0, top + 0.085, d / 2 - 0.34, w + 0.02, 0.03, 0.46, 0.012, undefined, 2);
};

const nightstand: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  taperedLegs(p, 'wood-light', w, d, 0.12, 0.04, 0.012);
  p.rbox('lacquer-white', 0, 0.12 + (h - 0.12) / 2, 0, w, h - 0.12, d, 0.01);
  p.box('wood-light', 0, h + 0.008, 0, w, 0.016, d);
  p.box('metal-brushed', 0, h - 0.09, d / 2 + 0.008, 0.1, 0.01, 0.01);
  // Table lamp.
  p.cyl('ceramic', -w / 4, h + 0.016 + 0.09, -0.02, 0.05, 0.065, 0.18, 18);
  p.cyl('lamp-shade', -w / 4, h + 0.016 + 0.27, -0.02, 0.09, 0.12, 0.16, 24, undefined, true);
};

const wardrobe: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  p.box('lacquer-grey', 0, 0.04, -0.03, w - 0.04, 0.08, d - 0.08);
  p.box('lacquer-white', 0, (h + 0.08) / 2, -0.01, w, h - 0.08, d - 0.02);
  doorFronts(p, 'lacquer-white', -w / 2, w / 2, 0.08, h, d / 2 - 0.02, Math.max(2, Math.round(w / 0.5)));
};

const desk: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  p.rbox('wood-light', 0, h - 0.015, 0, w, 0.03, d, 0.008);
  for (const sx of [-1, 1]) {
    p.box('metal-dark', sx * (w / 2 - 0.04), (h - 0.03) / 2, -d / 2 + 0.04, 0.025, h - 0.03, 0.025);
    p.box('metal-dark', sx * (w / 2 - 0.04), (h - 0.03) / 2, d / 2 - 0.04, 0.025, h - 0.03, 0.025);
    p.box('metal-dark', sx * (w / 2 - 0.04), 0.05, 0, 0.025, 0.025, d - 0.08);
  }
  // A closed laptop and a small plant keep the desk from looking empty.
  p.rbox('metal-brushed', 0.1, h + 0.008, 0.02, 0.32, 0.016, 0.22, 0.006);
  p.cyl('pot', -w / 2 + 0.14, h + 0.06, -d / 2 + 0.12, 0.05, 0.04, 0.12, 14);
  p.sphere('plant', -w / 2 + 0.14, h + 0.17, -d / 2 + 0.12, 0.08, new Vector3(1, 0.9, 1));
};

function counterBody(p: Parts, s: Size3, doors: number, top: MaterialKey = 'stone-white'): void {
  const { x: w, y: d, z: h } = s;
  const plinth = 0.1;
  p.box('lacquer-grey', 0, plinth / 2, -0.04, w, plinth, d - 0.1);
  p.box('lacquer-white', 0, plinth + (h - plinth - 0.03) / 2, -0.02, w, h - plinth - 0.03, d - 0.06);
  doorFronts(p, 'lacquer-white', -w / 2, w / 2, plinth + 0.004, h - 0.034, d / 2 - 0.05, doors);
  p.box(top, 0, h - 0.015, 0, w, 0.03, d);
}

const kitchenCounter: Builder = (p, s) => counterBody(p, s, Math.max(1, Math.round(s.x / 0.6)));

const kitchenSink: Builder = (p, s) => {
  counterBody(p, s, 2);
  const { y: d, z: h } = s;
  // Inset steel basin: rim plus a darker sunken floor read as a bowl.
  p.box('metal-brushed', 0, h + 0.001, 0.02, 0.56, 0.004, 0.42);
  p.box('metal-dark', 0, h + 0.003, 0.02, 0.5, 0.002, 0.36);
  // Gooseneck tap.
  const tz = -d / 2 + 0.07;
  p.cyl('chrome', 0, h + 0.13, tz, 0.014, 0.016, 0.26, 14);
  p.torus('chrome', 0, h + 0.26, tz + 0.08, 0.08, 0.011, Math.PI, new Euler(0, Math.PI / 2, 0));
  p.cyl('chrome', 0.05, h + 0.06, tz, 0.01, 0.01, 0.06, 10);
};

const kitchenHob: Builder = (p, s) => {
  counterBody(p, s, 2);
  const { z: h } = s;
  p.box('black-glass', 0, h + 0.003, 0.02, 0.58, 0.006, 0.5);
  for (const [x, z, r] of [
    [-0.15, -0.1, 0.1],
    [0.15, -0.1, 0.08],
    [-0.15, 0.14, 0.08],
    [0.15, 0.14, 0.1],
  ])
    p.torus('metal-brushed', x, h + 0.0065, z, r, 0.003, Math.PI * 2, new Euler(Math.PI / 2, 0, 0));
};

const fridge: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  p.box('lacquer-white', 0, h / 2, -0.01, w, h, d - 0.02);
  const split = h * 0.62;
  p.box('lacquer-white', 0, split + (h - split) / 2, d / 2 - 0.01, w - 0.006, h - split - 0.006, 0.02);
  p.box('lacquer-white', 0, split / 2 + 0.05, d / 2 - 0.01, w - 0.006, split - 0.1, 0.02);
  p.box('lacquer-grey', 0, 0.025, -0.02, w - 0.02, 0.05, d - 0.06);
  for (const y of [split + 0.25, split - 0.25]) p.box('metal-brushed', w / 2 - 0.05, y, d / 2 + 0.025, 0.014, 0.3, 0.014);
};

const wallCabinet: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  const y0 = 1.45;
  p.box('lacquer-white', 0, y0 + h / 2, -0.01, w, h, d - 0.02);
  doorFronts(p, 'lacquer-white', -w / 2, w / 2, y0, y0 + h, d / 2 - 0.02, Math.max(1, Math.round(w / 0.5)), false);
  // Under-cabinet trim.
  p.box('wood-light', 0, y0 - 0.008, 0, w, 0.016, d);
};

const sideboard: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  const legH = Math.min(0.16, h * 0.25);
  taperedLegs(p, 'wood-light', w - 0.04, d - 0.02, legH, 0.06, 0.016);
  p.rbox('wood-light', 0, legH + (h - legH) / 2, 0, w, h - legH, d, 0.01);
  doorFronts(p, 'lacquer-white', -w / 2 + 0.02, w / 2 - 0.02, legH + 0.02, h - 0.02, d / 2 - 0.016, Math.max(2, Math.round(w / 0.45)), false);
  // A vase and two books on top.
  p.cyl('ceramic', w / 4, h + 0.12, 0, 0.05, 0.07, 0.24, 16);
  p.box('fabric-accent', -w / 4, h + 0.02, 0, 0.24, 0.04, 0.17);
  p.box('linen', -w / 4 + 0.01, h + 0.055, 0, 0.21, 0.03, 0.15);
};

const rug: Builder = (p, s) => {
  p.rbox('rug', 0, s.z / 2, 0, s.x, s.z, s.y, Math.min(0.004, s.z / 2 - 1e-4));
};

const plant: Builder = (p, s) => {
  const h = s.z;
  const potH = Math.min(0.36, h * 0.35);
  const potR = Math.min(s.x, s.y) * 0.4;
  p.cyl('pot', 0, potH / 2, 0, potR, potR * 0.78, potH, 20);
  p.cyl('rug', 0, potH - 0.01, 0, potR * 0.92, potR * 0.92, 0.01, 18);
  // Stems and a loose crown of leaf clusters.
  p.cyl('wood-light', 0, potH + (h - potH) * 0.35, 0, 0.012, 0.016, (h - potH) * 0.7, 6);
  const clusters = 9;
  for (let i = 0; i < clusters; i++) {
    const a = (i / clusters) * Math.PI * 2 + i * 0.7;
    const rr = (0.08 + (i % 3) * 0.06) * (s.x / 0.5);
    const y = potH + (h - potH) * (0.45 + ((i * 37) % 50) / 100);
    p.sphere('plant', Math.cos(a) * rr, y, Math.sin(a) * rr, 0.12 * (s.x / 0.5), new Vector3(1.1, 0.75, 0.9), 1);
  }
};

const floorLamp: Builder = (p, s) => {
  const h = s.z;
  p.cyl('metal-dark', 0, 0.012, 0, 0.14, 0.15, 0.024, 24);
  p.cyl('metal-dark', 0, h / 2, 0, 0.011, 0.011, h - 0.3, 8);
  p.cyl('lamp-shade', 0, h - 0.15, 0, 0.17, 0.2, 0.3, 28, undefined, true);
};

const pendantLamp: Builder = (p, _s, ctx) => {
  const bottom = 1.62;
  p.cyl('metal-dark', 0, (ctx.ceiling + bottom + 0.2) / 2, 0, 0.003, 0.003, ctx.ceiling - bottom - 0.2, 6);
  p.cyl('metal-dark', 0, ctx.ceiling - 0.01, 0, 0.05, 0.05, 0.02, 16);
  p.ball('lamp-shade', 0, bottom + 0.12, 0, 0.2, new Vector3(1, 0.62, 1));
};

const wc: Builder = (p, s) => {
  const { y: d } = s;
  // Wall-hung bowl with a slim cistern box against the wall (-z).
  p.rbox('ceramic', 0, 0.62, -d / 2 + 0.09, 0.38, 0.5, 0.18, 0.04);
  p.rbox('ceramic', 0, 0.3, 0.02, 0.36, 0.3, d - 0.18, 0.12, undefined, 4);
  p.rbox('lacquer-white', 0, 0.465, 0.03, 0.37, 0.03, d - 0.2, 0.014, undefined, 3);
  p.box('chrome', 0, 0.82, -d / 2 + 0.181, 0.16, 0.08, 0.006);
};

const vanity: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  p.box('wood-light', 0, (0.3 + h - 0.06) / 2, -0.01, w, h - 0.36, d - 0.02);
  doorFronts(p, 'wood-light', -w / 2, w / 2, 0.3, h - 0.06, d / 2 - 0.02, w > 0.7 ? 2 : 1, false);
  p.rbox('ceramic', 0, h - 0.03, 0.005, w + 0.02, 0.06, d + 0.01, 0.012);
  p.box('lacquer-grey', 0, h + 0.0005, 0.03, w * 0.6, 0.002, d * 0.55);
  // Tap and a mirror above.
  p.cyl('chrome', 0, h + 0.09, -d / 2 + 0.06, 0.012, 0.014, 0.18, 12);
  p.box('chrome', 0, h + 0.17, -d / 2 + 0.11, 0.024, 0.02, 0.12);
  p.rbox('mirror', 0, h + 0.62, -d / 2 + 0.012, w, 0.7, 0.02, 0.008);
};

const bathtub: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  const t = 0.07;
  p.rbox('ceramic', 0, 0.04, 0, w, 0.08, d, 0.03);
  p.rbox('ceramic', 0, h / 2, d / 2 - t / 2, w, h, t, 0.03);
  p.rbox('ceramic', 0, h / 2, -d / 2 + t / 2, w, h, t, 0.03);
  p.rbox('ceramic', w / 2 - t / 2, h / 2, 0, t, h, d, 0.03);
  p.rbox('ceramic', -w / 2 + t / 2, h / 2, 0, t, h, d, 0.03);
  p.box('ceramic', 0, 0.09, 0, w - 2 * t, 0.02, d - 2 * t);
  p.cyl('chrome', w / 2 - 0.2, h + 0.05, -d / 2 + 0.035, 0.012, 0.012, 0.1, 10);
  p.torus('chrome', w / 2 - 0.2, h + 0.1, -d / 2 + 0.1, 0.065, 0.01, Math.PI, new Euler(0, Math.PI / 2, 0));
};

const shower: Builder = (p, s) => {
  const { x: w, y: d } = s;
  p.rbox('ceramic', 0, 0.03, 0, w, 0.06, d, 0.02);
  p.box('glass', w / 2 - 0.01, 1.05, 0.1, 0.01, 1.9, d - 0.2);
  p.cyl('chrome', -w / 2 + 0.12, 1.25, -d / 2 + 0.03, 0.011, 0.011, 2.0, 10);
  p.cyl('chrome', -w / 2 + 0.12, 2.15, -d / 2 + 0.16, 0.12, 0.12, 0.012, 24);
};

const bench: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  for (let i = 0; i < 4; i++) p.rbox('wood-light', 0, h - 0.015, -d / 2 + (d / 4) * (i + 0.5), w, 0.03, d / 4 - 0.012, 0.006);
  for (const sx of [-1, 1]) {
    p.box('wood-light', sx * (w / 2 - 0.06), (h - 0.03) / 2, 0, 0.04, h - 0.03, d - 0.04);
  }
  p.box('wood-light', 0, 0.12, 0, w - 0.16, 0.02, d - 0.08);
};

const bistroTable: Builder = (p, s) => {
  const r = Math.min(s.x, s.y) / 2;
  p.cyl('metal-dark', 0, s.z - 0.012, 0, r, r, 0.024, 32);
  p.cyl('metal-dark', 0, s.z / 2, 0, 0.02, 0.02, s.z - 0.02, 10);
  p.cyl('metal-dark', 0, 0.01, 0, r * 0.6, r * 0.65, 0.02, 24);
};

const bistroChair: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  const seat = 0.45;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) p.cyl('metal-dark', sx * (w / 2 - 0.03), seat / 2, sz * (d / 2 - 0.03), 0.009, 0.009, seat, 8);
  p.rbox('metal-dark', 0, seat, 0.01, w, 0.02, d - 0.02, 0.008);
  for (const sx of [-1, 1]) p.cyl('metal-dark', sx * (w / 2 - 0.03), (seat + h) / 2, -d / 2 + 0.03, 0.009, 0.009, h - seat, 8);
  for (const y of [h - 0.04, h - 0.16]) p.box('metal-dark', 0, y, -d / 2 + 0.03, w - 0.06, 0.018, 0.012);
};

const bookshelf: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  for (const sx of [-1, 1]) p.box('wood-light', sx * (w / 2 - 0.01), h / 2, 0, 0.02, h, d);
  const shelves = Math.max(2, Math.round(h / 0.36));
  for (let i = 0; i <= shelves; i++) p.box('wood-light', 0, 0.02 + ((h - 0.04) * i) / shelves, 0, w - 0.04, 0.02, d);
  for (let i = 0; i < shelves; i++) {
    const y = 0.03 + ((h - 0.04) * i) / shelves;
    for (let k = 0; k < 5; k++) {
      const bw = 0.03 + (k % 3) * 0.008;
      p.box(k % 2 ? 'fabric-accent' : 'linen', -w / 2 + 0.08 + k * 0.05, y + 0.12, 0, bw, 0.22 - (k % 2) * 0.03, d - 0.06);
    }
  }
};

const cabinet: Builder = (p, s) => {
  const { x: w, y: d, z: h } = s;
  p.box('lacquer-white', 0, h / 2, 0, w, h, d);
  doorFronts(p, 'lacquer-white', -w / 2, w / 2, 0.02, h - 0.02, d / 2, Math.max(1, Math.round(w / 0.5)));
};

const tv: Builder = (p, s) => {
  p.rbox('black-glass', 0, s.z / 2 + 0.5, 0, s.x, s.z, 0.04, 0.008);
};

/** Neutral low volume in the item's footprint, for imported blocks that match nothing. */
const box: Builder = (p, s) => {
  p.rbox('lacquer-grey', 0, s.z / 2, 0, s.x, s.z, s.y, Math.min(0.03, s.z / 2 - 0.001));
};

export interface PieceDef {
  build: Builder;
  size: Size3;
  /** Height used for collision; zero means the player walks over it. */
  solid: boolean;
}

export const PIECES: Record<string, PieceDef> = {
  sofa: { build: sofa, size: { x: 2.2, y: 0.92, z: 0.8 }, solid: true },
  armchair: { build: armchair, size: { x: 0.78, y: 0.8, z: 0.8 }, solid: true },
  'coffee-table': { build: coffeeTable, size: { x: 1.1, y: 0.6, z: 0.4 }, solid: true },
  'dining-table': { build: diningTable, size: { x: 1.6, y: 0.9, z: 0.75 }, solid: true },
  chair: { build: chair, size: { x: 0.44, y: 0.5, z: 0.84 }, solid: true },
  'bed-double': { build: bed, size: { x: 1.6, y: 2.05, z: 1.0 }, solid: true },
  'bed-single': { build: bed, size: { x: 0.9, y: 2.0, z: 0.9 }, solid: true },
  nightstand: { build: nightstand, size: { x: 0.45, y: 0.4, z: 0.5 }, solid: true },
  wardrobe: { build: wardrobe, size: { x: 1.2, y: 0.6, z: 2.2 }, solid: true },
  desk: { build: desk, size: { x: 1.2, y: 0.6, z: 0.75 }, solid: true },
  'kitchen-counter': { build: kitchenCounter, size: { x: 0.6, y: 0.62, z: 0.9 }, solid: true },
  'kitchen-sink': { build: kitchenSink, size: { x: 1.2, y: 0.62, z: 0.9 }, solid: true },
  'kitchen-hob': { build: kitchenHob, size: { x: 0.9, y: 0.62, z: 0.9 }, solid: true },
  fridge: { build: fridge, size: { x: 0.65, y: 0.65, z: 2.1 }, solid: true },
  'wall-cabinet': { build: wallCabinet, size: { x: 1.2, y: 0.34, z: 0.7 }, solid: false },
  sideboard: { build: sideboard, size: { x: 1.6, y: 0.42, z: 0.6 }, solid: true },
  'tv-unit': { build: sideboard, size: { x: 1.8, y: 0.42, z: 0.5 }, solid: true },
  rug: { build: rug, size: { x: 2.0, y: 1.4, z: 0.012 }, solid: false },
  plant: { build: plant, size: { x: 0.5, y: 0.5, z: 1.1 }, solid: true },
  'floor-lamp': { build: floorLamp, size: { x: 0.34, y: 0.34, z: 1.55 }, solid: true },
  'pendant-lamp': { build: pendantLamp, size: { x: 0.4, y: 0.4, z: 0.3 }, solid: false },
  wc: { build: wc, size: { x: 0.38, y: 0.6, z: 0.8 }, solid: true },
  vanity: { build: vanity, size: { x: 0.8, y: 0.5, z: 0.85 }, solid: true },
  bathtub: { build: bathtub, size: { x: 1.7, y: 0.75, z: 0.58 }, solid: true },
  shower: { build: shower, size: { x: 0.9, y: 0.9, z: 2.1 }, solid: true },
  bench: { build: bench, size: { x: 1.0, y: 0.38, z: 0.45 }, solid: true },
  'bistro-table': { build: bistroTable, size: { x: 0.6, y: 0.6, z: 0.74 }, solid: true },
  'bistro-chair': { build: bistroChair, size: { x: 0.42, y: 0.46, z: 0.8 }, solid: true },
  bookshelf: { build: bookshelf, size: { x: 0.8, y: 0.32, z: 1.8 }, solid: true },
  cabinet: { build: cabinet, size: { x: 0.8, y: 0.45, z: 0.8 }, solid: true },
  tv: { build: tv, size: { x: 1.2, y: 0.06, z: 0.7 }, solid: false },
  box: { build: box, size: { x: 0.8, y: 0.8, z: 0.4 }, solid: true },
};

export const pieceFor = (type: string): PieceDef => PIECES[type] ?? PIECES.box;
