import type { FloorPlan } from '../schema';
import { polygonArea } from '../../util/math2d';
import type { ImportReport, ReportWarning } from './types';

/** The validation report shown before "Build scene": counts, total area and every warning. */
export function buildReport(plan: FloorPlan, warnings: ReportWarning[], counts: { doors: number; windows: number; furniture: number }): ImportReport {
  const roomList = plan.floors.flatMap((f) =>
    f.rooms.map((r) => ({
      id: r.id,
      floor: f.name,
      name: r.name,
      area: polygonArea(r.polygon),
      floorMaterial: r.floorMaterial,
      named: !/^Room \d+$/.test(r.name),
    })),
  );
  // De-duplicate repeated messages.
  const seen = new Set<string>();
  const uniq = warnings.filter((w) => (seen.has(w.message) ? false : (seen.add(w.message), true)));
  return {
    floors: plan.floors.length,
    rooms: roomList.length,
    walls: plan.floors.reduce((n, f) => n + f.walls.length, 0),
    doors: counts.doors,
    windows: counts.windows,
    stairs: plan.stairs.length,
    furniture: counts.furniture,
    totalArea: roomList.reduce((a, r) => a + r.area, 0),
    warnings: uniq,
    roomList,
  };
}
