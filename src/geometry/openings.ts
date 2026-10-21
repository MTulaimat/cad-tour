import { BufferGeometry, CylinderGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import type { Floor, FloorPlan, Opening, Vec2 } from '../data/schema';
import type { MaterialKey } from '../materials/keys';
import { add, angleOf, scale } from '../util/math2d';
import { segmentPoint, wallSegments, type WallSegment } from '../plan/walls';
import { BuilderSet, MeshBuilder, W } from './builder';

/** A moving door part, built in its own local frame so it can be animated. */
export interface DoorLeafDef {
  id: string;
  openingId: string;
  floorId: string;
  kind: 'hinged' | 'sliding';
  /** Hinge point (hinged) or panel origin (sliding), in plan. */
  pivot: Vec2;
  /** Direction of the leaf from the pivot when closed. */
  closedDir: Vec2;
  /** Direction the leaf turns towards (hinged) or slides along (sliding). */
  openDir: Vec2;
  width: number;
  height: number;
  thickness: number;
  /** World height of the leaf bottom. */
  elevation: number;
  /** Radians for hinged leaves, meters for sliding panels. */
  maxOpen: number;
  /** Opening center, for proximity checks. */
  center: Vec2;
  /** Local geometry: x along the leaf, y up, z across it. */
  parts: { key: MaterialKey; geometry: BufferGeometry }[];
}

const ARCH_W = 0.07;
const ARCH_D = 0.015;
const FRAME_W = 0.06;
const FRAME_D = 0.07;

const m4 = () => new Matrix4();
const yawOf = (d: Vec2) => angleOf(d);

/** Matrix for a box centered at plan point c, height y, aligned with plan direction d. */
function boxMatrix(c: Vec2, y: number, d: Vec2): Matrix4 {
  return m4().compose(W(c, y), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yawOf(d)), new Vector3(1, 1, 1));
}

function architraves(b: MeshBuilder, s: WallSegment, u0: number, u1: number, top: number, E: number, side: number): void {
  const lat = side * (s.thickness / 2 + ARCH_D / 2);
  const h = top - E + ARCH_W;
  // Jamb casings.
  for (const u of [u0 - ARCH_W / 2, u1 + ARCH_W / 2]) {
    b.box(boxMatrix(segmentPoint(s, u, lat), E + h / 2, s.dir), ARCH_W, h, ARCH_D);
  }
  // Head casing.
  b.box(boxMatrix(segmentPoint(s, (u0 + u1) / 2, lat), top + ARCH_W / 2, s.dir), u1 - u0 + 2 * ARCH_W, ARCH_W, ARCH_D);
}

/** Rectangular frame of members around an opening, in the wall's middle plane. */
function frameMembers(b: MeshBuilder, s: WallSegment, u0: number, u1: number, y0: number, y1: number, lat: number, fw: number, fd: number): void {
  const w = u1 - u0;
  const h = y1 - y0;
  b.box(boxMatrix(segmentPoint(s, u0 + fw / 2, lat), (y0 + y1) / 2, s.dir), fw, h, fd);
  b.box(boxMatrix(segmentPoint(s, u1 - fw / 2, lat), (y0 + y1) / 2, s.dir), fw, h, fd);
  b.box(boxMatrix(segmentPoint(s, (u0 + u1) / 2, lat), y1 - fw / 2, s.dir), w - 2 * fw, fw, fd);
  b.box(boxMatrix(segmentPoint(s, (u0 + u1) / 2, lat), y0 + fw / 2, s.dir), w - 2 * fw, fw, fd);
}

function glassPane(b: MeshBuilder, s: WallSegment, u0: number, u1: number, y0: number, y1: number, lat: number): void {
  const pa = segmentPoint(s, u0, lat);
  const pb = segmentPoint(s, u1, lat);
  b.quadAuto(W(pa, y0), W(pb, y0), W(pb, y1), W(pa, y1));
}

function buildWindow(sets: BuilderSet, s: WallSegment, o: Opening, u0: number, u1: number, E: number): void {
  const y0 = E + o.sill;
  const y1 = y0 + o.height;
  const frame = sets.get('window-frame');
  frameMembers(frame, s, u0, u1, y0, y1, 0, FRAME_W, FRAME_D);
  const w = u1 - u0;
  const mullion = w >= 1.0;
  if (mullion) frame.box(boxMatrix(segmentPoint(s, (u0 + u1) / 2, 0), (y0 + y1) / 2, s.dir), 0.05, o.height - 2 * FRAME_W, FRAME_D * 0.9);
  // Inner sash rebate, a thin second frame that reads as an opening casement.
  frameMembers(frame, s, u0 + FRAME_W, mullion ? (u0 + u1) / 2 - 0.025 : u1 - FRAME_W, y0 + FRAME_W, y1 - FRAME_W, 0, 0.035, FRAME_D * 0.7);
  if (mullion) frameMembers(frame, s, (u0 + u1) / 2 + 0.025, u1 - FRAME_W, y0 + FRAME_W, y1 - FRAME_W, 0, 0.035, FRAME_D * 0.7);
  glassPane(sets.get('glass'), s, u0 + FRAME_W, u1 - FRAME_W, y0 + FRAME_W, y1 - FRAME_W, 0);

  // Sills: a board on interior sides, a thin metal sill on exterior sides.
  for (const side of [1, -1]) {
    const exterior = side > 0 ? s.leftExterior : s.rightExterior;
    const from = FRAME_D / 2;
    const to = s.thickness / 2 + (exterior ? 0.045 : 0.03);
    const depth = to - from;
    const lat = side * (from + depth / 2);
    const th = exterior ? 0.02 : 0.025;
    const key: MaterialKey = exterior ? 'sill-exterior' : 'sill';
    const extra = exterior ? 0.03 : 0.04;
    const c = segmentPoint(s, (u0 + u1) / 2, lat);
    sets.get(key).box(boxMatrix(c, y0 + (exterior ? -th / 2 : th / 2) - (exterior ? 0.005 : 0), s.dir), w + 2 * extra, th, depth);
  }
}

function doorHandleParts(width: number, thickness: number): { key: MaterialKey; geometry: BufferGeometry }[] {
  const b = new MeshBuilder();
  const rose = new CylinderGeometry(0.026, 0.026, 0.012, 20);
  const bar = new CylinderGeometry(0.009, 0.009, 0.13, 12);
  const x = width - 0.065;
  for (const zs of [1, -1]) {
    const z = zs * (thickness / 2 + 0.006);
    b.append(rose, m4().compose(new Vector3(x, 1.0, z), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2), new Vector3(1, 1, 1)), false);
    // Lever pointing towards the hinge, standing off the leaf.
    b.append(bar, m4().compose(new Vector3(x - 0.055, 1.0, zs * (thickness / 2 + 0.05)), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2), new Vector3(1, 1, 1)), false);
    const neck = new CylinderGeometry(0.009, 0.009, 0.045, 10);
    b.append(neck, m4().compose(new Vector3(x, 1.0, zs * (thickness / 2 + 0.03)), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2), new Vector3(1, 1, 1)), false);
  }
  return [{ key: 'metal-brushed', geometry: b.toGeometry() }];
}

function buildHingedDoor(floor: Floor, s: WallSegment, o: Opening, u0: number, u1: number, E: number): DoorLeafDef {
  const swing = o.swing ?? { hinge: 'start', side: 'left' };
  const t = s.thickness;
  const thickness = 0.04;
  const sideSign = swing.side === 'left' ? 1 : -1;
  const lat = sideSign * (t / 2 - thickness / 2 - 0.012);
  const hingeU = swing.hinge === 'start' ? u0 + 0.004 : u1 - 0.004;
  const closedDir = swing.hinge === 'start' ? s.dir : scale(s.dir, -1);
  const openDir = scale(s.nrm, sideSign);
  const width = u1 - u0 - 0.008;
  const height = o.height - 0.008;
  const leaf = new MeshBuilder();
  leaf.box(m4().makeTranslation(width / 2, height / 2 + 0.004, 0), width, height, thickness);
  // Subtle recessed panel lines are left to the material; keep the leaf a clean slab.
  return {
    id: `${o.id}-leaf`,
    openingId: o.id,
    floorId: floor.id,
    kind: 'hinged',
    pivot: segmentPoint(s, hingeU, lat),
    closedDir,
    openDir,
    width,
    height,
    thickness,
    elevation: E,
    maxOpen: (88 * Math.PI) / 180,
    center: segmentPoint(s, (u0 + u1) / 2, 0),
    parts: [{ key: 'door-leaf', geometry: leaf.toGeometry() }, ...doorHandleParts(width, thickness)],
  };
}

function buildSlidingDoor(sets: BuilderSet, floor: Floor, s: WallSegment, o: Opening, u0: number, u1: number, E: number): DoorLeafDef {
  const y0 = E;
  const y1 = E + o.height;
  const frame = sets.get('window-frame');
  // Outer frame in the wall's middle plane.
  frameMembers(frame, s, u0, u1, y0, y1, 0, 0.05, 0.11);
  const inner0 = u0 + 0.05;
  const inner1 = u1 - 0.05;
  const half = (inner1 - inner0) / 2;
  const panelH = o.height - 0.1;
  const pt = 0.035;
  // Fixed panel on the outer track (the half nearer the wall end).
  const fixedLat = -0.025;
  const fixedU0 = inner0 + half - 0.02;
  const fixedU1 = inner1;
  frameMembers(frame, s, fixedU0, fixedU1, y0 + 0.05, y0 + 0.05 + panelH, fixedLat, 0.055, pt);
  glassPane(sets.get('glass'), s, fixedU0 + 0.055, fixedU1 - 0.055, y0 + 0.105, y0 + panelH - 0.005, fixedLat);

  // Sliding panel on the inner track, local frame: x along the wall from the panel's start.
  const width = half + 0.02;
  const b = new MeshBuilder();
  const g = new MeshBuilder();
  const fw = 0.055;
  b.box(m4().makeTranslation(fw / 2, panelH / 2, 0), fw, panelH, pt);
  b.box(m4().makeTranslation(width - fw / 2, panelH / 2, 0), fw, panelH, pt);
  b.box(m4().makeTranslation(width / 2, panelH - fw / 2, 0), width - 2 * fw, fw, pt);
  b.box(m4().makeTranslation(width / 2, fw / 2, 0), width - 2 * fw, fw, pt);
  // Pull handle.
  b.box(m4().makeTranslation(width - fw - 0.03, 1.0, pt / 2 + 0.015), 0.02, 0.35, 0.02);
  b.box(m4().makeTranslation(width - fw - 0.03, 1.0, -pt / 2 - 0.015), 0.02, 0.35, 0.02);
  g.quadAuto(new Vector3(fw, fw, 0), new Vector3(width - fw, fw, 0), new Vector3(width - fw, panelH - fw, 0), new Vector3(fw, panelH - fw, 0));
  const slideLat = 0.025;
  return {
    id: `${o.id}-panel`,
    openingId: o.id,
    floorId: floor.id,
    kind: 'sliding',
    pivot: segmentPoint(s, inner0, slideLat),
    closedDir: s.dir,
    openDir: s.dir,
    width,
    height: panelH,
    thickness: pt,
    elevation: y0 + 0.05,
    maxOpen: half - 0.04,
    center: segmentPoint(s, (u0 + u1) / 2, 0),
    parts: [
      { key: 'window-frame', geometry: b.toGeometry() },
      { key: 'glass', geometry: g.toGeometry() },
    ],
  };
}

export interface OpeningsBuild {
  doors: DoorLeafDef[];
}

export function buildOpenings(plan: FloorPlan, floor: Floor, sets: BuilderSet): OpeningsBuild {
  const E = floor.elevation;
  const doors: DoorLeafDef[] = [];
  for (const s of wallSegments(plan, floor)) {
    for (const so of s.openings) {
      const o = so.opening;
      if (o.type === 'window') {
        buildWindow(sets, s, o, so.u0, so.u1, E);
        continue;
      }
      const style = o.style ?? 'hinged';
      const top = E + o.sill + o.height;
      if (style === 'sliding-glass') {
        doors.push(buildSlidingDoor(sets, floor, s, o, so.u0, so.u1, E));
        continue;
      }
      // Hinged doors and plain passages get casings on both faces.
      for (const side of [1, -1]) architraves(sets.get('trim'), s, so.u0, so.u1, top, E, side);
      if (style === 'hinged') doors.push(buildHingedDoor(floor, s, o, so.u0, so.u1, E));
    }
  }
  return { doors };
}

/** Plan point where a door leaf's far edge is, for a given opening amount. */
export function leafTip(d: DoorLeafDef, amount: number): Vec2 {
  if (d.kind === 'sliding') return add(add(d.pivot, scale(d.openDir, amount)), scale(d.closedDir, d.width));
  const a = angleOf(d.closedDir);
  const sign = Math.sign(d.closedDir.x * d.openDir.y - d.closedDir.y * d.openDir.x) || 1;
  const ang = a + sign * amount;
  return add(d.pivot, { x: Math.cos(ang) * d.width, y: Math.sin(ang) * d.width });
}
