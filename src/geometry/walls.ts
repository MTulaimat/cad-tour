import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Floor, FloorPlan } from '../data/schema';
import type { MaterialKey } from '../materials/keys';
import { angleOf } from '../util/math2d';
import { clipHalfPlane } from '../util/clip';
import { faceRange, segmentPoint, wallSegments, type WallSegment } from '../plan/walls';
import { buildingTop } from '../plan/levels';
import { type BuilderSet, W } from './builder';

interface Hole {
  u0: number;
  u1: number;
  y0: number;
  y1: number;
}

/**
 * Emits a vertical face on one side of a wall segment as rectangles around the openings.
 * `side` is +t/2 for the left face and -t/2 for the right face.
 */
function emitFace(
  b: ReturnType<BuilderSet['get']>,
  s: WallSegment,
  side: number,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  holes: Hole[],
): void {
  if (u1 - u0 < 1e-4 || y1 - y0 < 1e-4) return;
  const left = side > 0;
  const cuts = [u0, u1];
  for (const h of holes) cuts.push(Math.max(u0, Math.min(u1, h.u0)), Math.max(u0, Math.min(u1, h.u1)));
  const us = [...new Set(cuts.map((u) => Math.round(u * 1e5) / 1e5))].sort((x, y) => x - y);
  const rect = (ua: number, ub: number, ya: number, yb: number) => {
    if (ub - ua < 1e-4 || yb - ya < 1e-4) return;
    const pa = segmentPoint(s, ua, side);
    const pb = segmentPoint(s, ub, side);
    // Counterclockwise seen from outside the face.
    const [p0, p1] = left ? [pb, pa] : [pa, pb];
    const [q0, q1] = left ? [ub, ua] : [ua, ub];
    const n = new Vector3(s.nrm.x * Math.sign(side), 0, -s.nrm.y * Math.sign(side));
    const uo = s.arcStart;
    b.quad(W(p0, ya), W(p1, ya), W(p1, yb), W(p0, yb), n, [
      [uo + q0, ya],
      [uo + q1, ya],
      [uo + q1, yb],
      [uo + q0, yb],
    ]);
  };
  for (let i = 0; i < us.length - 1; i++) {
    const ua = us[i];
    const ub = us[i + 1];
    const mid = (ua + ub) / 2;
    const covering = holes.filter((h) => h.u0 <= mid && h.u1 >= mid).sort((x, y) => x.y0 - y.y0);
    let y = y0;
    for (const h of covering) {
      rect(ua, ub, y, Math.max(y, Math.min(y1, h.y0)));
      y = Math.max(y, h.y1);
    }
    rect(ua, ub, y, y1);
  }
}

const GLAZING_FRAME = 0.06;
const GLAZING_DEPTH = 0.09;
const MAX_PANE = 1.25;

/**
 * Full-height glazing in place of a wall (the outside walls of a glass balcony): a frame with
 * mullions and panes in the wall's middle plane, from the floor to the top of the wall.
 */
function buildGlazing(sets: BuilderSet, s: WallSegment, u0: number, u1: number, y0: number, y1: number): void {
  const frame = sets.get('window-frame');
  const glass = sets.get('glass');
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angleOf(s.dir));
  const box = (u: number, y: number, lu: number, h: number) => frame.box(new Matrix4().compose(W(segmentPoint(s, u, 0), y), q, new Vector3(1, 1, 1)), lu, h, GLAZING_DEPTH);
  const w = u1 - u0;
  if (w < 0.05 || y1 - y0 < 0.05) return;
  const panes = Math.max(1, Math.ceil(w / MAX_PANE));
  const step = w / panes;
  // Sill and head rails, posts at every pane joint.
  box((u0 + u1) / 2, y0 + GLAZING_FRAME / 2, w, GLAZING_FRAME);
  box((u0 + u1) / 2, y1 - GLAZING_FRAME / 2, w, GLAZING_FRAME);
  for (let i = 0; i <= panes; i++) {
    const u = Math.min(u1 - GLAZING_FRAME / 2, Math.max(u0 + GLAZING_FRAME / 2, u0 + i * step));
    box(u, (y0 + y1) / 2, GLAZING_FRAME, y1 - y0 - 2 * GLAZING_FRAME);
  }
  // A transom at door height on tall glazing.
  const transom = y1 - y0 > 2.9 ? y0 + 2.2 : null;
  if (transom !== null) box((u0 + u1) / 2, transom, w, GLAZING_FRAME * 0.8);
  for (let i = 0; i < panes; i++) {
    const a = u0 + i * step + GLAZING_FRAME / 2;
    const b = u0 + (i + 1) * step - GLAZING_FRAME / 2;
    const pa = segmentPoint(s, a, 0);
    const pb = segmentPoint(s, b, 0);
    const bands = transom !== null ? [[y0 + GLAZING_FRAME, transom - GLAZING_FRAME * 0.4], [transom + GLAZING_FRAME * 0.4, y1 - GLAZING_FRAME]] : [[y0 + GLAZING_FRAME, y1 - GLAZING_FRAME]];
    for (const [ya, yb] of bands) glass.quadAuto(W(pa, ya), W(pb, ya), W(pb, yb), W(pa, yb));
  }
}

/** The wall's footprint (mitered at its joints) between u0 and u1, for its top face. */
function footprint(s: WallSegment, u0: number, u1: number, withNodes: { start: boolean; end: boolean }): { x: number; y: number }[] {
  const poly: { x: number; y: number }[] = [s.startRight, s.endRight];
  if (withNodes.end && s.endJoined) poly.push(s.b);
  poly.push(s.endLeft, s.startLeft);
  if (withNodes.start && s.startJoined) poly.push(s.a);
  const at = (u: number, side: number) => segmentPoint(s, u, side);
  let out = clipHalfPlane(poly, at(u0, -1), at(u0, 1), false);
  out = clipHalfPlane(out, at(u1, -1), at(u1, 1), true);
  return out;
}

export function buildWalls(plan: FloorPlan, floor: Floor, sets: BuilderSet): void {
  const E = floor.elevation;
  const roofAt = buildingTop(plan);
  const topFloor = plan.floors.reduce((a, f) => (f.elevation > a.elevation ? f : a), plan.floors[0]);
  for (const s of wallSegments(plan, floor)) {
    const t = s.thickness;
    const holes: Hole[] = s.openings.map((o) => ({
      u0: o.u0,
      u1: o.u1,
      y0: E + o.opening.sill,
      y1: E + o.opening.sill + o.opening.height,
    }));
    const mat = (exterior: boolean): MaterialKey => (exterior ? 'wall-exterior' : 'wall-interior');
    // Outside faces cover the slab edge below and, at the top of the building, the roof slab.
    const faceY = (exterior: boolean, down: boolean, top: number): [number, number] =>
      exterior ? [E - floor.slabThickness, top + (top >= roofAt - 0.01 ? topFloor.slabThickness : 0)] : down ? [E - floor.slabThickness, top] : [E, top];

    const [lu0, lu1] = faceRange(s, true);
    const [ru0, ru1] = faceRange(s, false);
    const first = s.tops[0];
    const last = s.tops[s.tops.length - 1];
    if (s.glazed) {
      // Only the outside's slab edge and roof band remain solid.
      const outLeft = s.leftExterior;
      const [fu0, fu1] = outLeft ? [lu0, lu1] : [ru0, ru1];
      const side = outLeft ? t / 2 : -t / 2;
      for (const iv of s.tops) {
        const a = Math.max(fu0, iv.u0);
        const b = Math.min(fu1, iv.u1);
        emitFace(sets.get('wall-exterior'), s, side, a, b, E - floor.slabThickness, E, []);
        if (iv.y >= roofAt - 0.01) emitFace(sets.get('wall-exterior'), s, side, a, b, iv.y, iv.y + topFloor.slabThickness, []);
        buildGlazing(sets, s, Math.max(Math.min(lu0, ru0), iv.u0), Math.min(Math.max(lu1, ru1), iv.u1), E, iv.y);
        sets.get('wall-interior').polygon(footprint(s, iv.u0, iv.u1, { start: iv === first, end: iv === last }), iv.y, true);
      }
      continue;
    }

    for (const iv of s.tops) {
      const [ly0, ly1] = faceY(s.leftExterior, s.leftDown, iv.y);
      emitFace(sets.get(mat(s.leftExterior)), s, t / 2, Math.max(lu0, iv.u0), Math.min(lu1, iv.u1), ly0, ly1, holes);
      const [ry0, ry1] = faceY(s.rightExterior, s.rightDown, iv.y);
      emitFace(sets.get(mat(s.rightExterior)), s, -t / 2, Math.max(ru0, iv.u0), Math.min(ru1, iv.u1), ry0, ry1, holes);
      // Top face, including the node centers at joined ends so junctions are closed.
      const top = footprint(s, iv.u0, iv.u1, { start: iv === first, end: iv === last });
      if (top.length >= 3) sets.get('wall-interior').polygon(top, iv.y, true);
    }
    // Steps where the top changes: a face across the wall, looking towards the lower part.
    for (let i = 1; i < s.tops.length; i++) {
      const a = s.tops[i - 1];
      const c = s.tops[i];
      const u = a.u1;
      const lo = Math.min(a.y, c.y);
      const hi = Math.max(a.y, c.y);
      const pl = segmentPoint(s, u, t / 2);
      const pr = segmentPoint(s, u, -t / 2);
      const b = sets.get('wall-interior');
      // Looking towards +u when the next part is lower, else towards -u.
      if (c.y < a.y) b.quadAuto(W(pr, lo), W(pl, lo), W(pl, hi), W(pr, hi));
      else b.quadAuto(W(pl, lo), W(pr, lo), W(pr, hi), W(pl, hi));
    }

    // Reveals: the faces inside each opening, through the wall thickness.
    for (const o of s.openings) {
      const op = o.opening;
      const wallTop = s.tops.find((iv) => iv.u0 <= (o.u0 + o.u1) / 2 && iv.u1 >= (o.u0 + o.u1) / 2)?.y ?? E + s.height;
      const y0 = E + op.sill;
      const y1 = Math.min(E + op.sill + op.height, wallTop);
      const isDoor = op.type === 'door';
      const lined = isDoor && (op.style ?? 'hinged') === 'hinged';
      // Windows and glazed doors sit in the middle of the wall; each half takes its face's finish.
      const halves: { from: number; to: number; key: MaterialKey }[] = lined
        ? [{ from: -t / 2, to: t / 2, key: 'door-frame' }]
        : [
            { from: -t / 2, to: 0, key: mat(s.rightExterior) },
            { from: 0, to: t / 2, key: mat(s.leftExterior) },
          ];
      for (const hv of halves) {
        const b = sets.get(hv.key);
        // Jamb at u0 faces +dir, jamb at u1 faces -dir.
        const a0 = segmentPoint(s, o.u0, hv.from);
        const a1 = segmentPoint(s, o.u0, hv.to);
        b.quadAuto(W(a0, y0), W(a1, y0), W(a1, y1), W(a0, y1));
        const c0 = segmentPoint(s, o.u1, hv.from);
        const c1 = segmentPoint(s, o.u1, hv.to);
        b.quadAuto(W(c1, y0), W(c0, y0), W(c0, y1), W(c1, y1));
        // Head (soffit), facing down, unless the opening runs to the top of the wall.
        if (y1 < wallTop - 0.005) b.quadAuto(W(a0, y1), W(a1, y1), W(c1, y1), W(c0, y1));
        // Sill bottom, facing up (windows only; doors meet the floor).
        if (op.sill > 0.01) b.quadAuto(W(a0, y0), W(c0, y0), W(c1, y0), W(a1, y0));
      }
    }

    // Free end caps.
    const both = s.leftExterior && s.rightExterior;
    const capKey = both ? 'wall-exterior' : 'wall-interior';
    const cap = sets.get(capKey);
    const capRange = (top: number): [number, number] => (both ? faceY(true, false, top) : [E, top]);
    if (!s.startJoined) {
      const [cy0, cy1] = capRange(first.y);
      cap.quadAuto(W(s.startLeft, cy0), W(s.startRight, cy0), W(s.startRight, cy1), W(s.startLeft, cy1));
    }
    if (!s.endJoined) {
      const [cy0, cy1] = capRange(last.y);
      cap.quadAuto(W(s.endRight, cy0), W(s.endLeft, cy0), W(s.endLeft, cy1), W(s.endRight, cy1));
    }
  }
}

