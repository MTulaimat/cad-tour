import type { FloorPlan } from '../schema';
import { polygonArea } from '../../util/math2d';
import type { ImportReport, ReportWarning, RoomKind } from './types';

/** The validation report shown before "Build scene": counts, total area, notes and every warning. */
export function buildReport(plan: FloorPlan, warnings: ReportWarning[], counts: { doors: number; windows: number; furniture: number }, notes: string[] = []): ImportReport {
  const roomList = plan.floors.flatMap((f) =>
    f.rooms.map((r) => ({
      id: r.id,
      floor: f.name,
      name: r.name,
      area: polygonArea(r.polygon),
      floorMaterial: r.floorMaterial,
      named: !/^Room \d+$/.test(r.name),
      kind: (r.glazed ? 'glass-balcony' : r.outdoor ? 'open-balcony' : 'room') as RoomKind,
      ceilingHeight: r.ceilingHeight ?? f.ceilingHeight,
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
    notes,
    roomList,
  };
}
