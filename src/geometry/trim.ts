import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Floor, FloorPlan, Room, Vec2 } from '../data/schema';
import { angleOf, pointInPolygon } from '../util/math2d';
import { floorAbove, roomTop } from '../plan/levels';
import { faceRange, segmentPoint, wallSegments, type WallSegment } from '../plan/walls';
import { stairInfos } from '../plan/stairs';
import { type BuilderSet, W } from './builder';

const SKIRT_H = 0.08;
const SKIRT_D = 0.012;
const TRIM_H = 0.035;
const TRIM_D = 0.03;
const ARCH_W = 0.07;
const STEP = 0.1;

/** Splits [u0, u1] into the runs where `keep(u)` holds, sampled every STEP. */
function runs(u0: number, u1: number, keep: (u: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  const n = Math.max(1, Math.ceil((u1 - u0) / STEP));
  for (let i = 0; i <= n; i++) {
    const u = u0 + ((u1 - u0) * i) / n;
    const ok = i < n && keep(Math.min(u1, u + (u1 - u0) / n / 2));
    if (ok && start === null) start = u;
    if (!ok && start !== null) {
      out.push([start, u]);
      start = null;
    }
  }
  return out;
}

function strip(b: ReturnType<BuilderSet['get']>, s: WallSegment, ua: number, ub: number, side: number, y: number, h: number, d: number): void {
  if (ub - ua < 0.02) return;
  const lat = side * (s.thickness / 2 + d / 2);
  const c = segmentPoint(s, (ua + ub) / 2, lat);
  const m = new Matrix4().compose(W(c, y + h / 2), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angleOf(s.dir)), new Vector3(1, 1, 1));
  b.box(m, ub - ua, h, d);
}

/** Skirting boards along interior wall faces, and a slim cornice where they meet the ceiling. */
export function buildTrim(plan: FloorPlan, floor: Floor, sets: BuilderSet): void {
  const E = floor.elevation;
  const stairs = stairInfos(plan).filter((s) => s.from.id === floor.id || s.to.id === floor.id);
  const overStair = (p: { x: number; y: number }) => stairs.some((s) => pointInPolygon(p, s.stair.outline));
  const skirting = sets.get('skirting');
  const cornice = sets.get('trim');
  // The ceiling over a point beside a wall: its room's ceiling, or the slab of the floor above
  // where that floor's rooms are over it.
  const floorOf = new Map<Room, Floor>(plan.floors.flatMap((f) => f.rooms.map((r) => [r, f] as const)));
  const ceilingAt = (room: Room | null, p: Vec2): number | null => {
    if (!room) return null;
    const f = floorOf.get(room) ?? floor;
    const top = roomTop(f, room);
    const up = floorAbove(plan, f);
    if (up && up.elevation - up.slabThickness < top - 0.01 && up.rooms.some((r) => !r.outdoor && pointInPolygon(p, r.polygon))) return up.elevation - up.slabThickness;
    return top;
  };
  for (const s of wallSegments(plan, floor)) {
    for (const side of [1, -1]) {
      const exterior = side > 0 ? s.leftExterior : s.rightExterior;
      if (exterior || s.glazed) continue;
      const down = side > 0 ? s.leftDown : s.rightDown;
      const room = side > 0 ? s.leftRoom : s.rightRoom;
      const [fu0, fu1] = faceRange(s, side > 0);
      const u0 = Math.min(fu0, fu1);
      const u1 = Math.max(fu0, fu1);
      const probe = (u: number) => segmentPoint(s, u, side * (s.thickness / 2 + 0.15));
      // Exact gaps at doors (to the outside of the casings), then sampled gaps over stairs.
      const gaps = s.openings
        .filter((o) => o.opening.type === 'door')
        .map((o) => [o.u0 - ((o.opening.style ?? 'hinged') === 'sliding-glass' ? 0 : ARCH_W), o.u1 + ((o.opening.style ?? 'hinged') === 'sliding-glass' ? 0 : ARCH_W)] as [number, number])
        .sort((x, y) => x[0] - y[0]);
      const pieces: [number, number][] = [];
      let cur = u0;
      for (const [g0, g1] of gaps) {
        if (g0 > cur) pieces.push([cur, Math.min(g0, u1)]);
        cur = Math.max(cur, g1);
      }
      if (cur < u1) pieces.push([cur, u1]);
      // A face that runs down into a double-height space below has no floor beside it.
      if (!down) for (const [pa, pb] of pieces) for (const [a, b] of runs(pa, pb, (u) => !overStair(probe(u)))) strip(skirting, s, a, b, side, E, SKIRT_H, SKIRT_D);
      for (const iv of s.tops) {
        const a0 = Math.max(u0, iv.u0);
        const b0 = Math.min(u1, iv.u1);
        if (b0 - a0 < 0.02) continue;
        const meets = (u: number) => {
          const c = ceilingAt(room, probe(u));
          return c === null ? iv.y <= E + floor.ceilingHeight + 0.01 : Math.abs(c - iv.y) < 0.02;
        };
        for (const [a, b] of runs(a0, b0, (u) => !overStair(probe(u)) && meets(u))) strip(cornice, s, a, b, side, iv.y - TRIM_H, TRIM_H, TRIM_D);
      }
    }
  }
}
