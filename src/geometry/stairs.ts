import { CylinderGeometry, Matrix4, Quaternion, Vector3 } from 'three';
import type { FloorPlan, StairFinish, Vec2 } from '../data/schema';
import type { MaterialKey } from '../materials/keys';
import { add, angleOf, normalize, scale, sub } from '../util/math2d';
import { stairInfos, type FlightInfo } from '../plan/stairs';
import { type BuilderSet, type MeshBuilder, W } from './builder';

const TREAD_T = 0.04;
const NOSING = 0.025;
const RISER_T = 0.018;
const STRINGER_T = 0.025;
const STRINGER_DEPTH = 0.3;
const RAIL_H = 0.9;

const yawQ = (d: Vec2) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angleOf(d));

/** Box aligned with the flight: local x along the climb, z across it. */
function flightBox(b: MeshBuilder, f: FlightInfo, s: number, lat: number, y: number, len: number, h: number, w: number): void {
  const c = add(add(f.flight.start, scale(f.dir, s)), scale(f.side, lat));
  b.box(new Matrix4().compose(W(c, y), yawQ(f.dir), new Vector3(1, 1, 1)), len, h, w);
}

/** Nosing line height at run position s (line through the front edges of the treads). */
const nosingAt = (f: FlightInfo, s: number) => f.base + f.flight.riserHeight * (s / f.flight.going + 1);

/**
 * A vertical side panel following the flight in the (s, h) plane, extruded across [lat0, lat1].
 * `profile` lists (s, h) points counterclockwise in the (s, h) plane (s to the right, h up).
 */
function sidePanel(b: MeshBuilder, f: FlightInfo, profile: [number, number][], lat0: number, lat1: number): void {
  const pt = (s: number, lat: number) => add(add(f.flight.start, scale(f.dir, s)), scale(f.side, lat));
  const n = profile.length;
  // Faces at lat1 (seen from the left) and lat0 (seen from the right), as fans.
  const fan = (lat: number, flip: boolean) => {
    const pts = profile.map(([s, h]) => W(pt(s, lat), h));
    for (let i = 1; i < n - 1; i++) {
      const tri = flip ? [pts[0], pts[i + 1], pts[i]] : [pts[0], pts[i], pts[i + 1]];
      const e1 = new Vector3().subVectors(tri[1], tri[0]);
      const e2 = new Vector3().subVectors(tri[2], tri[0]);
      const nn = new Vector3().crossVectors(e1, e2).normalize();
      const uv = (p: Vector3, k: number): [number, number] => [profile[k][0], p.y];
      const ks = flip ? [0, i + 1, i] : [0, i, i + 1];
      const a = b.vertex(tri[0], nn, ...uv(tri[0], ks[0]));
      const c = b.vertex(tri[1], nn, ...uv(tri[1], ks[1]));
      const d = b.vertex(tri[2], nn, ...uv(tri[2], ks[2]));
      b.tri(a, c, d);
    }
  };
  fan(lat1, true);
  fan(lat0, false);
  // Edge strips around the profile.
  for (let i = 0; i < n; i++) {
    const [s0, h0] = profile[i];
    const [s1, h1] = profile[(i + 1) % n];
    b.quadAuto(W(pt(s1, lat0), h1), W(pt(s0, lat0), h0), W(pt(s0, lat1), h0), W(pt(s1, lat1), h1));
  }
}

/** Materials of a stair finish: oak treads with painted risers and stringers, or black steel. */
function finishKeys(finish: StairFinish): { tread: MaterialKey; body: MaterialKey; rail: MaterialKey; wallRail: MaterialKey } {
  return finish === 'black-steel'
    ? { tread: 'steel-black', body: 'steel-black', rail: 'steel-black', wallRail: 'steel-black' }
    : { tread: 'stair-wood', body: 'stair-paint', rail: 'stair-wood', wallRail: 'metal-brushed' };
}

function buildFlight(sets: BuilderSet, f: FlightInfo, ceilingAbove: number, finish: StairFinish): void {
  const { going: g, riserHeight: r, risers: N, width: w } = f.flight;
  const keys = finishKeys(finish);
  const treads = sets.get(keys.tread);
  const paint = sets.get(keys.body);

  // Treads with a small nosing, risers set back under them.
  for (let k = 1; k < N; k++) {
    const s0 = (k - 1) * g - NOSING;
    const s1 = k * g;
    flightBox(treads, f, (s0 + s1) / 2, 0, f.base + k * r - TREAD_T / 2, s1 - s0, TREAD_T, w);
  }
  for (let k = 1; k <= N; k++) {
    const s = (k - 1) * g + RISER_T / 2;
    const y0 = f.base + (k - 1) * r;
    const y1 = f.base + k * r - (k < N ? TREAD_T : 0);
    flightBox(paint, f, s, 0, (y0 + y1) / 2, RISER_T, y1 - y0, w - 0.004);
  }

  // Stringers on both sides: top edge just above the nosing line, clipped to the floors.
  const topEdge = (s: number) => nosingAt(f, s) + 0.05;
  const sFloor = g * ((STRINGER_DEPTH - 0.05) / r - 1);
  const profile: [number, number][] = [
    [0, f.base],
    [Math.max(0.02, sFloor), f.base],
    [f.run, topEdge(f.run) - STRINGER_DEPTH],
    [f.run, f.top + 0.02],
    [0, topEdge(0)],
  ];
  for (const sideSign of [1, -1]) {
    const lat0 = sideSign > 0 ? w / 2 : -w / 2 - STRINGER_T;
    const lat1 = sideSign > 0 ? w / 2 + STRINGER_T : -w / 2;
    sidePanel(paint, f, profile, lat0, lat1);
  }

  const handrail = sets.get(keys.rail);
  const metal = sets.get(keys.wallRail);
  for (const sideSign of [1, -1]) {
    const open = sideSign > 0 ? f.openLeft : f.openRight;
    const lat = sideSign * (w / 2 + STRINGER_T / 2);
    for (const [a, b] of open) {
      // Spandrel panel closing the space under the open side (only below the floor above). A steel
      // stair stays open underneath.
      const bottomEdge = (s: number) => Math.min(ceilingAbove, topEdge(s) - STRINGER_DEPTH);
      const sa = Math.max(a, sFloor);
      if (finish !== 'black-steel' && b > sa + 0.05) {
        const panel: [number, number][] = [
          [sa, f.base],
          [b, f.base],
          [b, bottomEdge(b)],
          [sa, bottomEdge(sa)],
        ];
        sidePanel(paint, f, panel, lat - 0.01, lat + 0.01);
      }
      // Spindles, one per tread, and a handrail along the nosing line.
      const sStart = Math.max(a, g * 0.5);
      const sEnd = Math.min(b, f.run);
      for (let s = sStart; s <= sEnd + 1e-6; s += g) {
        const yb = nosingAt(f, s) + 0.04;
        const yt = nosingAt(f, s) + RAIL_H - 0.03;
        flightBox(paint, f, s, lat, (yb + yt) / 2, 0.022, yt - yb, 0.022);
      }
      railAlong(handrail, f, a, b, lat, RAIL_H, 0.055, 0.045);
    }
    // Wall rail on a side that is mostly against a wall.
    const openLen = open.reduce((acc, [a, b]) => acc + (b - a), 0);
    if (openLen < f.run * 0.5) {
      const wallLat = sideSign * (w / 2 - 0.05);
      roundRail(metal, f, 0.3, f.run - 0.15, wallLat, RAIL_H);
    }
  }
}

/** A straight rail following the nosing line from s0 to s1. */
function railAlong(b: MeshBuilder, f: FlightInfo, s0: number, s1: number, lat: number, height: number, w: number, h: number): void {
  const p0 = add(add(f.flight.start, scale(f.dir, s0)), scale(f.side, lat));
  const p1 = add(add(f.flight.start, scale(f.dir, s1)), scale(f.side, lat));
  const a = W(p0, nosingAt(f, s0) + height);
  const c = W(p1, nosingAt(f, s1) + height);
  const len = a.distanceTo(c);
  const mid = a.clone().add(c).multiplyScalar(0.5);
  const pitch = Math.atan2(c.y - a.y, Math.hypot(c.x - a.x, c.z - a.z));
  const q = yawQ(f.dir).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), pitch));
  b.box(new Matrix4().compose(mid, q, new Vector3(1, 1, 1)), len, h, w);
}

function roundRail(b: MeshBuilder, f: FlightInfo, s0: number, s1: number, lat: number, height: number): void {
  const p0 = add(add(f.flight.start, scale(f.dir, s0)), scale(f.side, lat));
  const p1 = add(add(f.flight.start, scale(f.dir, s1)), scale(f.side, lat));
  const a = W(p0, nosingAt(f, s0) + height);
  const c = W(p1, nosingAt(f, s1) + height);
  const len = a.distanceTo(c);
  const mid = a.clone().add(c).multiplyScalar(0.5);
  const dirV = new Vector3().subVectors(c, a).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dirV);
  b.append(new CylinderGeometry(0.02, 0.02, len, 14, 1), new Matrix4().compose(mid, q, new Vector3(1, 1, 1)), false);
  // Brackets back to the wall.
  const n = Math.max(2, Math.ceil(len / 1.2) + 1);
  const toWall = scale(f.side, Math.sign(lat) * 0.06);
  for (let i = 0; i < n; i++) {
    const s = s0 + ((s1 - s0) * (i + 0.5)) / n;
    const p = add(add(f.flight.start, scale(f.dir, s)), scale(f.side, lat));
    const y = nosingAt(f, s) + height - 0.04;
    const m = new Matrix4().compose(W(add(p, scale(toWall, 0.5)), y), yawQ(f.side), new Vector3(1, 1, 1));
    b.box(m, 0.07, 0.015, 0.015);
  }
}

export function buildStairs(plan: FloorPlan, floorId: string, sets: BuilderSet): void {
  for (const s of stairInfos(plan)) {
    if (s.from.id !== floorId) continue;
    const finish = s.stair.finish ?? 'oak';
    const keys = finishKeys(finish);
    const ceilingAbove = s.from.elevation + s.from.ceilingHeight;
    for (const f of s.flights) buildFlight(sets, f, ceilingAbove, finish);
    // Intermediate landings: a slab at the landing height, with its edges.
    for (const l of s.landings) {
      if (Math.abs(l.elevation - s.to.elevation) < 0.01) continue;
      const t = finish === 'black-steel' ? 0.08 : 0.2;
      sets.get(keys.tread).polygon(l.polygon, l.elevation, true);
      const body = sets.get(keys.body);
      body.polygon(l.polygon, l.elevation - t, false);
      for (let i = 0; i < l.polygon.length; i++) {
        const a = l.polygon[i];
        const c = l.polygon[(i + 1) % l.polygon.length];
        body.quadAuto(W(a, l.elevation - t), W(c, l.elevation - t), W(c, l.elevation), W(a, l.elevation));
      }
    }
    // Guards along the open sides of landings: balusters and a handrail.
    for (const rail of s.landingRails) {
      const d = normalize(sub(rail.b, rail.a));
      const len = Math.hypot(rail.b.x - rail.a.x, rail.b.y - rail.a.y);
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angleOf(d));
      const at = (u: number, y: number) => new Matrix4().compose(W(add(rail.a, scale(d, u)), y), q, new Vector3(1, 1, 1));
      const posts = Math.max(1, Math.round(len / s.flights[0].flight.going));
      for (let k = 0; k <= posts; k++) {
        const u = Math.min(len - 0.011, Math.max(0.011, (len * k) / posts));
        sets.get(keys.body).box(at(u, rail.elevation + (RAIL_H - 0.03) / 2), 0.022, RAIL_H - 0.03, 0.022);
      }
      sets.get(keys.rail).box(at(len / 2, rail.elevation + RAIL_H), len, 0.045, 0.055);
    }
  }
}
