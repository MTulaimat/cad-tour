import { describe, expect, it } from 'vitest';
import { createDemoPlan } from '../../src/data/mock';
import { normalizePlan } from '../../src/data/validate';
import { CollisionWorld } from '../../src/collision/world';
import { PlayerBody, FIXED_DT } from '../../src/collision/capsule';
import { DoorController } from '../../src/collision/doors';
import { buildFloorGeometry } from '../../src/geometry';
import type { Vec2 } from '../../src/data/schema';
import { entrances, roomAt, startSpawn } from '../../src/plan/navigation';

const plan = normalizePlan(createDemoPlan());
const world = new CollisionWorld(plan);
const doorDefs = plan.floors.flatMap((_, i) => buildFloorGeometry(plan, i).doors);
const elev = (id: string) => plan.floors.find((f) => f.id === id)!.elevation;

/** Walks the player toward each waypoint with forward input, steering by yaw, for up to `secs`. */
function walk(body: PlayerBody, doors: DoorController, path: Vec2[], secs = 30, run = false, log?: { h: number; x: number }[]) {
  let i = 0;
  for (let t = 0; t < secs && i < path.length; t += FIXED_DT) {
    const target = path[i];
    const dx = target.x - body.position.x;
    const dy = target.y - body.position.y;
    if (Math.hypot(dx, dy) < 0.12) {
      i++;
      continue;
    }
    body.yaw = Math.atan2(-dx, dy);
    doors.update(FIXED_DT, body.position, body.feet, world, 0.25);
    body.step({ x: 0, y: 1, run }, world, doors.segments());
    log?.push({ h: body.body.value, x: body.position.x });
  }
  return i >= path.length;
}

describe('collision world', () => {
  it('stops the player at walls and slides along them', () => {
    // Main bedroom, heading south-east into the south wall (inner face y = 0.1).
    const body = new PlayerBody({ x: 8.7, y: 1.6 }, 3, Math.PI + 0.4);
    const doors = new DoorController(doorDefs, elev);
    for (let k = 0; k < 600; k++) body.step({ x: 0, y: 1, run: true }, world, doors.segments());
    expect(body.position.y).toBeGreaterThanOrEqual(0.1 + 0.25 - 0.01);
    expect(body.position.y).toBeLessThan(0.5);
    // It slid east along the wall into the corner instead of sticking where it hit.
    expect(body.position.x).toBeGreaterThan(9.2);
    expect(body.position.x).toBeLessThanOrEqual(9.5 - 0.25 + 0.01);
  });

  it('never tunnels through a wall at running speed', () => {
    const body = new PlayerBody({ x: 2.0, y: 4.3 }, 0, Math.PI / 2);
    const doors = new DoorController(doorDefs, elev);
    for (let k = 0; k < 1200; k++) body.step({ x: 0, y: 1, run: true }, world, doors.segments());
    // Heading west in the kitchen: stopped by the west wall's inner face (x = 0.1) or the counters.
    expect(body.position.x).toBeGreaterThan(0.1 + 0.24);
  });

  it('walks from the living room up the stair to the landing without jitter', () => {
    const body = new PlayerBody({ x: 7.4, y: 0.62 }, 0, Math.PI / 2);
    const doors = new DoorController(doorDefs, elev);
    const log: { h: number; x: number }[] = [];
    const ok = walk(body, doors, [{ x: 6.4, y: 0.6 }, { x: 1.2, y: 0.6 }, { x: 0.9, y: 1.4 }], 30, false, log);
    expect(ok).toBe(true);
    expect(body.feet).toBeCloseTo(3, 5);
    // Height is monotonic and smooth: no frame-to-frame drops, bounded climb rate.
    let maxRise = 0;
    for (let k = 1; k < log.length; k++) {
      const d = log[k].h - log[k - 1].h;
      expect(d).toBeGreaterThan(-1e-4);
      maxRise = Math.max(maxRise, d);
    }
    expect(maxRise).toBeLessThan(0.02);
  });

  it('walks back down the stair', () => {
    const body = new PlayerBody({ x: 0.9, y: 1.4 }, 3, -Math.PI / 2);
    const doors = new DoorController(doorDefs, elev);
    const ok = walk(body, doors, [{ x: 1.2, y: 0.6 }, { x: 6.6, y: 0.6 }, { x: 7.5, y: 1.5 }]);
    expect(ok).toBe(true);
    expect(body.feet).toBeCloseTo(0, 5);
  });

  it('cannot step off the side of the stair or fall into the stairwell', () => {
    const body = new PlayerBody({ x: 3.0, y: 1.8 }, 3, 0);
    const doors = new DoorController(doorDefs, elev);
    // On the upper landing, walk south into the stairwell guard.
    walk(body, doors, [{ x: 3.0, y: 0.3 }], 5);
    expect(body.feet).toBeCloseTo(3, 5);
    expect(body.position.y).toBeGreaterThan(1.1);
  });

  it('opens doors on approach and walks through them', () => {
    const body = new PlayerBody({ x: 2.6, y: 2.0 }, 0, -Math.PI / 2);
    const doors = new DoorController(doorDefs, elev);
    // Hall to living room through the door at x = 3.8.
    const ok = walk(body, doors, [{ x: 5.0, y: 2.0 }], 10);
    expect(ok).toBe(true);
    const hallDoor = doors.doors.find((d) => d.def.openingId === 'L1-d-hall-living')!;
    expect(hallDoor.t).toBeGreaterThan(0.5);
  });

  it('closes doors a while after the player leaves', () => {
    const body = new PlayerBody({ x: 2.6, y: 2.0 }, 0, -Math.PI / 2);
    const doors = new DoorController(doorDefs, elev);
    walk(body, doors, [{ x: 5.0, y: 2.0 }, { x: 7.5, y: 3.5 }], 10);
    for (let t = 0; t < 4; t += FIXED_DT) doors.update(FIXED_DT, body.position, body.feet, world, 0.25);
    const hallDoor = doors.doors.find((d) => d.def.openingId === 'L1-d-hall-living')!;
    expect(hallDoor.t).toBe(0);
  });

  it('keeps the balcony railing solid', () => {
    const body = new PlayerBody({ x: 10.3, y: 3.5 }, 0, -Math.PI / 2);
    const doors = new DoorController(doorDefs, elev);
    for (let k = 0; k < 800; k++) body.step({ x: 0, y: 1, run: true }, world, doors.segments());
    expect(body.position.x).toBeLessThan(11.07 - 0.24);
  });
});

describe('start and entrance', () => {
  it('keeps only the front door shut, not the balcony door', () => {
    expect(entrances(plan, plan.floors[0]).map((e) => e.openingId)).toEqual(['L1-d-entrance']);
    const doors = new DoorController(doorDefs, elev);
    doors.locked.add('L1-d-entrance');
    const front = doors.doors.find((d) => d.def.openingId === 'L1-d-entrance')!;
    for (let k = 0; k < 240; k++) doors.update(FIXED_DT, front.def.center, 0, world, 0.25);
    expect(front.t).toBe(0);
  });

  it('starts inside the hall, facing into the plan and clear of furniture', () => {
    const s = startSpawn(plan);
    const floor = plan.floors[s.floorIndex];
    expect(roomAt(floor, s.position)?.name).toBe('Entry hall');
    // Looks east-ish down the hall (yaw 0 is north, -90 east), not back at the door (south).
    expect(s.yaw).toBeLessThan(-0.5);
    expect(s.yaw).toBeGreaterThan(-2);
    const body = new PlayerBody(s.position, floor.elevation, s.yaw);
    body.step({ x: 0, y: 0, run: false }, world, []);
    expect(Math.hypot(body.position.x - s.position.x, body.position.y - s.position.y)).toBeLessThan(0.01);
  });
});
