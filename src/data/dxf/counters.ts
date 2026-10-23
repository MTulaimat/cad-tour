import type { Furniture, Vec2 } from '../schema';
import { add, cross, dist, dot, normalize, perp, scale, sub } from '../../util/math2d';
import type { WallPiece } from './walls';

/**
 * Kitchen runs drawn as plain lines on the walls layer: a single line in front of a wall, 0.4 to
 * 0.8 m from its face, with a sink or a hob between them, is the counter front, not a wall. The
 * strip becomes counter pieces with the sink and hob set into it; short lines closing its ends are
 * dropped too. A dashed line along the strip (cabinets drawn above the cut) adds wall cabinets.
 */

export interface Fixture {
  type: 'kitchen-sink' | 'kitchen-hob';
  /** Footprint corners in meters. */
  corners: Vec2[];
  label: string;
}

export interface CounterResult {
  walls: WallPiece[];
  furniture: Omit<Furniture, 'id'>[];
  /** Fixtures that were set into a counter (not added again as separate pieces). */
  used: Fixture[];
}

const center = (pts: Vec2[]) => scale(pts.reduce((a, p) => add(a, p), { x: 0, y: 0 }), 1 / pts.length);

export function detectCounters(wallsIn: WallPiece[], fixtures: Fixture[], dashed: { a: Vec2; b: Vec2 }[]): CounterResult {
  let walls = wallsIn.slice();
  const furniture: Omit<Furniture, 'id'>[] = [];
  const used: Fixture[] = [];
  for (const line of wallsIn) {
    if (line.source !== 'single' || !walls.includes(line)) continue;
    const len = dist(line.a, line.b);
    if (len < 1) continue;
    const d = normalize(sub(line.b, line.a));
    const n = perp(d);
    // The wall behind: parallel, paired, overlapping, with its near face 0.4 to 0.8 m away.
    let best: { w: WallPiece; depth: number; side: number } | null = null;
    for (const w of walls) {
      if (w === line || w.source !== 'pair') continue;
      const wd = normalize(sub(w.b, w.a));
      if (Math.abs(cross(d, wd)) > 0.03) continue;
      const off = dot(sub(w.a, line.a), n);
      const depth = Math.abs(off) - w.thickness / 2;
      if (depth < 0.4 || depth > 0.8) continue;
      const u0 = dot(sub(w.a, line.a), d);
      const u1 = dot(sub(w.b, line.a), d);
      if (Math.max(u0, u1) < len * 0.5 || Math.min(u0, u1) > len * 0.5) continue;
      if (!best || depth < best.depth) best = { w, depth, side: Math.sign(off) };
    }
    if (!best) continue;
    const { depth, side } = best;
    const inStrip = (p: Vec2) => {
      const u = dot(sub(p, line.a), d);
      const v = dot(sub(p, line.a), n) * side;
      return u > -0.05 && u < len + 0.05 && v > 0 && v < depth;
    };
    const own = fixtures.filter((f) => !used.includes(f) && inStrip(center(f.corners)));
    if (own.length === 0) continue;
    // Drop the front line and the short lines that close the strip's ends.
    walls = walls.filter((w) => {
      if (w === line) return false;
      if (w.source !== 'single') return true;
      const wl = dist(w.a, w.b);
      if (wl > depth + 0.3) return true;
      const wd = normalize(sub(w.b, w.a));
      if (Math.abs(dot(wd, d)) > 0.1) return true;
      const near = (p: Vec2) => {
        const u = dot(sub(p, line.a), d);
        return Math.abs(u) < 0.05 || Math.abs(u - len) < 0.05;
      };
      return !(near(w.a) && near(w.b));
    });
    // Pieces along the run: the fixtures where they are, plain counter in between.
    const front = scale(n, -side);
    const yaw = Math.atan2(front.y, front.x) + Math.PI / 2;
    const at = (u0: number, u1: number, type: string, label: string) => {
      if (u1 - u0 < 0.15) return;
      const c = add(add(line.a, scale(d, (u0 + u1) / 2)), scale(n, (side * depth) / 2));
      furniture.push({ type, position: c, rotation: yaw, size: { x: u1 - u0, y: depth, z: 0.9 }, label });
    };
    const spans = own
      .map((f) => {
        const us = f.corners.map((p) => dot(sub(p, line.a), d));
        return { f, u0: Math.max(0, Math.min(...us)), u1: Math.min(len, Math.max(...us)) };
      })
      .sort((a, b) => a.u0 - b.u0);
    let cur = 0;
    for (const s of spans) {
      const u0 = Math.max(cur, s.u0);
      at(cur, u0, 'kitchen-counter', 'counter');
      at(u0, s.u1, s.f.type, s.f.label);
      cur = Math.max(cur, s.u1);
      used.push(s.f);
    }
    at(cur, len, 'kitchen-counter', 'counter');
    // Wall cabinets where a dashed line runs along the strip.
    for (const ds of dashed) {
      const dd = normalize(sub(ds.b, ds.a));
      if (Math.abs(cross(dd, d)) > 0.03) continue;
      const v = dot(sub(ds.a, line.a), n) * side;
      if (v <= 0.05 || v >= depth) continue;
      const u0 = Math.max(0, Math.min(dot(sub(ds.a, line.a), d), dot(sub(ds.b, line.a), d)));
      const u1 = Math.min(len, Math.max(dot(sub(ds.a, line.a), d), dot(sub(ds.b, line.a), d)));
      if (u1 - u0 < 0.4) continue;
      const cabDepth = Math.min(0.4, depth - v + 0.02);
      const c = add(add(line.a, scale(d, (u0 + u1) / 2)), scale(n, side * (depth - cabDepth / 2)));
      furniture.push({ type: 'wall-cabinet', position: c, rotation: yaw, size: { x: u1 - u0, y: cabDepth, z: 0.7 }, label: 'wall cabinets' });
      break;
    }
  }
  return { walls, furniture, used };
}
