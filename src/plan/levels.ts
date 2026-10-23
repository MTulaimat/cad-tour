import type { Floor, FloorPlan, Room } from '../data/schema';

/**
 * Heights across floors: where each room's ceiling is, which floor is directly above, and which
 * rooms of a lower floor rise past a floor's level (a double-height space beside a mezzanine).
 */

/** World height of a room's ceiling. */
export const roomTop = (floor: Floor, room: Room): number => floor.elevation + (room.ceilingHeight ?? floor.ceilingHeight);

/** The next floor up, or null on the top floor. */
export function floorAbove(plan: FloorPlan, floor: Floor): Floor | null {
  let best: Floor | null = null;
  for (const f of plan.floors) if (f.elevation > floor.elevation + 0.01 && (!best || f.elevation < best.elevation)) best = f;
  return best;
}

/** The underside of the floor above (its slab), or null on the top floor. */
export function slabAbove(plan: FloorPlan, floor: Floor): number | null {
  const up = floorAbove(plan, floor);
  return up ? up.elevation - up.slabThickness : null;
}

/** Highest ceiling in the building: where the roof slab sits. */
export function buildingTop(plan: FloorPlan): number {
  let top = -Infinity;
  for (const f of plan.floors) {
    top = Math.max(top, f.elevation + f.ceilingHeight);
    for (const r of f.rooms) if (!r.outdoor) top = Math.max(top, roomTop(f, r));
  }
  return top;
}

/** Indoor rooms of lower floors whose space rises past this floor's level. */
export function risingRooms(plan: FloorPlan, floor: Floor): { floor: Floor; room: Room }[] {
  const out: { floor: Floor; room: Room }[] = [];
  for (const f of plan.floors) {
    if (f.elevation >= floor.elevation - 0.01) continue;
    for (const r of f.rooms) if (!r.outdoor && roomTop(f, r) > floor.elevation + 0.05) out.push({ floor: f, room: r });
  }
  return out;
}

/** True when some room of the floor is not mostly under the floor above (a split level). */
export function hasDoubleHeight(plan: FloorPlan, floor: Floor): boolean {
  const slab = slabAbove(plan, floor);
  return slab !== null && floor.rooms.some((r) => !r.outdoor && roomTop(floor, r) > slab + 0.01);
}
