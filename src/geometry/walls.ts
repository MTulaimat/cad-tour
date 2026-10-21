import { Vector3 } from 'three';
import type { Floor, FloorPlan } from '../data/schema';
import type { MaterialKey } from '../materials/keys';
import { faceRange, segmentPoint, wallSegments, type WallSegment } from '../plan/walls';
import { type BuilderSet, W } from './builder';

export interface WallBuildOptions {
  /** True for the highest floor: exterior faces rise past the ceiling to cover the roof slab. */
  isTopFloor: boolean;
}

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

export function buildWalls(plan: FloorPlan, floor: Floor, sets: BuilderSet, opts: WallBuildOptions): void {
  const E = floor.elevation;
  for (const s of wallSegments(plan, floor)) {
    const t = s.thickness;
    const H = s.height;
    const holes: Hole[] = s.openings.map((o) => ({
      u0: o.u0,
      u1: o.u1,
      y0: E + o.opening.sill,
      y1: E + o.opening.sill + o.opening.height,
    }));

    const faceRangeY = (exterior: boolean): [number, number] =>
      exterior ? [E - floor.slabThickness, E + H + (opts.isTopFloor ? floor.slabThickness : 0)] : [E, E + H];
    const mat = (exterior: boolean): MaterialKey => (exterior ? 'wall-exterior' : 'wall-interior');

    const [lu0, lu1] = faceRange(s, true);
    const [ly0, ly1] = faceRangeY(s.leftExterior);
    emitFace(sets.get(mat(s.leftExterior)), s, t / 2, lu0, lu1, ly0, ly1, holes);
    const [ru0, ru1] = faceRange(s, false);
    const [ry0, ry1] = faceRangeY(s.rightExterior);
    emitFace(sets.get(mat(s.rightExterior)), s, -t / 2, ru0, ru1, ry0, ry1, holes);

    // Reveals: the faces inside each opening, through the wall thickness.
    for (const o of s.openings) {
      const op = o.opening;
      const y0 = E + op.sill;
      const y1 = E + op.sill + op.height;
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
        // Head (soffit), facing down.
        b.quadAuto(W(a0, y1), W(a1, y1), W(c1, y1), W(c0, y1));
        // Sill bottom, facing up (windows only; doors meet the floor).
        if (op.sill > 0.01) b.quadAuto(W(a0, y0), W(c0, y0), W(c1, y0), W(a1, y0));
      }
    }

    // Free end caps.
    const capKey = s.leftExterior && s.rightExterior ? 'wall-exterior' : 'wall-interior';
    const [cy0, cy1] = s.leftExterior && s.rightExterior ? faceRangeY(true) : [E, E + H];
    const cap = sets.get(capKey);
    if (!s.startJoined) cap.quadAuto(W(s.startLeft, cy0), W(s.startRight, cy0), W(s.startRight, cy1), W(s.startLeft, cy1));
    if (!s.endJoined) cap.quadAuto(W(s.endRight, cy0), W(s.endLeft, cy0), W(s.endLeft, cy1), W(s.endRight, cy1));

    // Top face, including the node centers at joined ends so junctions are closed.
    const top: { x: number; y: number }[] = [s.startRight, s.endRight];
    if (s.endJoined) top.push(s.b);
    top.push(s.endLeft, s.startLeft);
    if (s.startJoined) top.push(s.a);
    sets.get('wall-interior').polygon(top, E + H, true);
  }
}
