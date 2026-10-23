import type { FloorPlan, Vec2 } from '../../src/data/schema';
import { CollisionWorld, PLAYER_RADIUS } from '../../src/collision/world';
import { DoorController } from '../../src/collision/doors';
import { buildFloorGeometry } from '../../src/geometry';
import { entrances, startSpawn } from '../../src/plan/navigation';
import { dist, pointInPolygon } from '../../src/util/math2d';

const MOVES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Rooms the player can walk into from the start point, found by flooding a 5 cm grid with the
 * real collision world: inside doors stand open, doors to the outside stay shut, and a move is
 * allowed only where the capsule fits and the floor rises less than a stair step. Returns the
 * ids of the rooms that were never reached.
 */
export function unreachableRooms(plan: FloorPlan): string[] {
  const world = new CollisionWorld(plan);
  const defs = plan.floors.flatMap((_, i) => buildFloorGeometry(plan, i).doors);
  const doors = new DoorController(defs, (id) => plan.floors.find((f) => f.id === id)?.elevation ?? 0);
  for (const f of plan.floors) for (const e of entrances(plan, f)) doors.locked.add(e.openingId);
  for (const d of doors.doors) d.amount = doors.locked.has(d.def.openingId) ? 0 : 1;
  const leaves = doors.segments();

  const pts = plan.floors.flatMap((f) => f.walls.flatMap((w) => w.centerline));
  const minX = Math.min(...pts.map((p) => p.x)) - 0.5;
  const maxX = Math.max(...pts.map((p) => p.x)) + 0.5;
  const minY = Math.min(...pts.map((p) => p.y)) - 0.5;
  const maxY = Math.max(...pts.map((p) => p.y)) + 0.5;
  const step = 0.05;
  const spawn = startSpawn(plan);
  const start = { p: spawn.position, h: world.heightAt(spawn.position, plan.floors[spawn.floorIndex].elevation) };
  const seen = new Set<string>();
  // Cells counted from the start point, so points half a cell off the grid never share a key.
  const key = (p: Vec2, h: number) => `${Math.round((p.x - start.p.x) / step)},${Math.round((p.y - start.p.y) / step)},${Math.round(h / 0.05)}`;
  const reached: { p: Vec2; h: number }[] = [];
  const queue = [start];
  seen.add(key(start.p, start.h));
  while (queue.length) {
    const s = queue.pop()!;
    reached.push(s);
    for (const [dx, dy] of MOVES) {
      const q = { x: s.p.x + dx * step, y: s.p.y + dy * step };
      if (q.x < minX || q.x > maxX || q.y < minY || q.y > maxY) continue;
      const h = world.heightAt(q, s.h);
      if (Math.abs(h - s.h) > 0.3) continue;
      const k = key(q, h);
      if (seen.has(k)) continue;
      if (dist(world.resolve(q, h, leaves, PLAYER_RADIUS), q) > 0.01) continue;
      seen.add(k);
      queue.push({ p: q, h });
    }
  }
  const missing: string[] = [];
  for (const f of plan.floors) {
    for (const room of f.rooms) {
      const ok = reached.some((s) => Math.abs(s.h - f.elevation) < 0.3 && pointInPolygon(s.p, room.polygon));
      if (!ok) missing.push(room.id);
    }
  }
  return missing;
}
