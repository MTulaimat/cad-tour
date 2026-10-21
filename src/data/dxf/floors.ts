import type { Vec2 } from '../schema';
import { floorOfLayer } from './layers';
import type { FloorAssignment } from './types';

/**
 * Multiple floors: by layer prefix (L1_, L2_, ...) or by selection boxes drawn in the 2D preview.
 * Floors are aligned to each other by matching their stair outlines; failing that, by the corners
 * of their bounding boxes (with a warning).
 */

export function floorCount(a: FloorAssignment): number {
  if (a.mode === 'prefix') return Math.max(1, a.prefixes?.length ?? 1);
  if (a.mode === 'boxes') return Math.max(1, a.boxes?.length ?? 1);
  return 1;
}

/** Floor index of a primitive (by its layer and a representative point in drawing units), or -1. */
export function floorOf(a: FloorAssignment, layer: string, p: Vec2): number {
  if (a.mode === 'prefix' && a.prefixes) return floorOfLayer(layer, a.prefixes);
  if (a.mode === 'boxes' && a.boxes) {
    return a.boxes.findIndex((b) => p.x >= Math.min(b.minX, b.maxX) && p.x <= Math.max(b.minX, b.maxX) && p.y >= Math.min(b.minY, b.maxY) && p.y <= Math.max(b.minY, b.maxY));
  }
  return 0;
}

export interface Alignment {
  offsets: Vec2[];
  warnings: string[];
}

/**
 * Offsets that move each floor onto the lowest one. `stairCenters[k]` is the centre of floor k's
 * stair outline (or null), `cornerOf[k]` the minimum corner of its walls' bounding box.
 */
export function alignFloors(stairCenters: (Vec2 | null)[], cornerOf: (Vec2 | null)[], boxes: FloorAssignment['boxes'] | undefined): Alignment {
  const n = stairCenters.length;
  const offsets: Vec2[] = new Array(n).fill(null).map(() => ({ x: 0, y: 0 }));
  const warnings: string[] = [];
  for (let k = 1; k < n; k++) {
    const prev = stairCenters[k - 1];
    const cur = stairCenters[k];
    if (prev && cur) {
      offsets[k] = { x: offsets[k - 1].x + prev.x - cur.x, y: offsets[k - 1].y + prev.y - cur.y };
      continue;
    }
    const pc = boxes?.[k - 1] ? { x: Math.min(boxes[k - 1].minX, boxes[k - 1].maxX), y: Math.min(boxes[k - 1].minY, boxes[k - 1].maxY) } : cornerOf[k - 1];
    const cc = boxes?.[k] ? { x: Math.min(boxes[k].minX, boxes[k].maxX), y: Math.min(boxes[k].minY, boxes[k].maxY) } : cornerOf[k];
    if (pc && cc) offsets[k] = { x: offsets[k - 1].x + pc.x - cc.x, y: offsets[k - 1].y + pc.y - cc.y };
    warnings.push(`Floor ${k + 1} was aligned to floor ${k} by its corner, because there is no stair on both to line them up. Check the result.`);
  }
  return { offsets, warnings };
}
