import type { Vec2 } from '../data/schema';
import type { DoorLeafDef } from '../geometry/openings';
import { leafTip } from '../geometry/openings';
import { add, dist, scale } from '../util/math2d';
import type { CollisionWorld, Segment } from './world';

/** How close (meters from the opening center) the player must be for a door to open. */
export const OPEN_RADIUS = 1.2;
/** How long a door stays open after the player leaves. */
export const CLOSE_DELAY = 2.0;
const OPEN_TIME = 0.9;

interface DoorState {
  def: DoorLeafDef;
  /** 0 closed, 1 open. */
  t: number;
  target: number;
  clearTime: number;
  amount: number;
}

const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * Auto-opening doors (Q6). Leaves swing (or slide) open as the player approaches and close a
 * couple of seconds after they leave. Each leaf is a solid segment while it moves; if moving it
 * would trap the player against a wall, the leaf waits instead.
 */
export class DoorController {
  readonly doors: DoorState[];
  private fixed: Segment[] = [];

  constructor(defs: DoorLeafDef[], elevationOf: (floorId: string) => number) {
    this.doors = defs.map((def) => ({ def, t: 0, target: 0, clearTime: 0, amount: 0 }));
    // Sliding doors: the fixed glass half is a permanent barrier.
    for (const def of defs) {
      if (def.kind !== 'sliding') continue;
      const e = elevationOf(def.floorId);
      const a = add(def.pivot, scale(def.closedDir, def.width - 0.04));
      const b = add(def.pivot, scale(def.closedDir, def.width * 2 - 0.06));
      this.fixed.push({ a, b, y0: e, y1: e + def.height, kind: 'door' });
    }
  }

  private leafSegment(d: DoorState, amount: number): Segment {
    const e = d.def.elevation;
    const a = d.def.kind === 'sliding' ? add(d.def.pivot, scale(d.def.openDir, amount)) : d.def.pivot;
    return { a, b: leafTip(d.def, amount), y0: e, y1: e + d.def.height, kind: 'door' };
  }

  /** Current door segments (leaves at their present angle plus fixed panels). */
  segments(): Segment[] {
    return [...this.fixed, ...this.doors.map((d) => this.leafSegment(d, d.amount))];
  }

  /**
   * Advances the doors. `player` is the plan position and `feet` its height.
   * Returns true when any door moved.
   */
  update(dt: number, player: Vec2, feet: number, world: CollisionWorld, radius: number): boolean {
    let moved = false;
    for (const d of this.doors) {
      const onFloor = Math.abs(feet - d.def.elevation) < 1.6;
      const near = onFloor && dist(player, d.def.center) < OPEN_RADIUS;
      if (near) {
        d.target = 1;
        d.clearTime = 0;
      } else if (d.target === 1) {
        d.clearTime += dt;
        if (d.clearTime > CLOSE_DELAY) d.target = 0;
      }
      if (d.t === d.target) continue;
      const step = dt / OPEN_TIME;
      const nt = d.target > d.t ? Math.min(d.target, d.t + step) : Math.max(d.target, d.t - step);
      const amount = ease(nt) * d.def.maxOpen;
      // Never trap: if the leaf at its next position would overlap the player and the player
      // cannot be pushed clear of everything else, hold the leaf where it is.
      const seg = this.leafSegment(d, amount);
      if (world.overlaps(player, feet, [seg], radius)) {
        const pushed = world.resolve(player, feet, [seg], radius);
        const others = this.segments().filter((_, i) => i !== this.fixed.length + this.doors.indexOf(d));
        if (world.overlaps(pushed, feet, [seg], radius) || world.overlaps(pushed, feet, others, radius)) continue;
      }
      d.t = nt;
      d.amount = amount;
      moved = true;
    }
    return moved;
  }
}
