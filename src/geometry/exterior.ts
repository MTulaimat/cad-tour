import type { FloorPlan, Vec2 } from '../data/schema';
import { add, dist, ensureCCW, lerp2, normalize, perp, scale, sub } from '../util/math2d';
import { exteriorOutline } from '../plan/walls';
import { type BuilderSet, W } from './builder';

const STOREY = 3.0;

/**
 * The building continues below the apartment: a facade mass down to the ground, with slab bands
 * and dark window panes per storey, so the balcony never looks out over a void.
 */
export function buildExterior(plan: FloorPlan, sets: BuilderSet, groundDepth: number): void {
  const lowest = plan.floors.reduce((a, f) => (f.elevation < a.elevation ? f : a), plan.floors[0]);
  const outline = exteriorOutline(plan, lowest);
  if (!outline) return;
  const poly = ensureCCW(outline);
  const top = lowest.elevation - lowest.slabThickness;
  const bottom = lowest.elevation - groundDepth;
  const wall = sets.get('wall-exterior');
  const band = sets.get('slab-edge');
  const glass = sets.get('facade-glass');
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = dist(a, b);
    if (len < 0.05) continue;
    // Outward is to the right of travel on a counterclockwise outline.
    wall.quadAuto(W(a, bottom), W(b, bottom), W(b, top), W(a, top));
    const d = normalize(sub(b, a));
    const out = scale(perp(d), -1);
    // Slab bands at every storey line.
    for (let y = top; y > bottom + 0.5; y -= STOREY) {
      const a2 = add(a, scale(out, 0.025));
      const b2 = add(b, scale(out, 0.025));
      band.quadAuto(W(a2, y - 0.22), W(b2, y - 0.22), W(b2, y), W(a2, y));
      band.quadAuto(W(a2, y), W(b2, y), W(b, y), W(a, y));
      band.quadAuto(W(a, y - 0.22), W(b, y - 0.22), W(b2, y - 0.22), W(a2, y - 0.22));
    }
    // Window panes, one row per storey below, spaced along the face.
    const count = Math.floor((len - 0.8) / 2.2);
    for (let s = 0; s < count; s++) {
      const c = lerp2(a, b, (s + 0.5) / count);
      const half = Math.min(0.65, len / count / 2 - 0.3);
      if (half < 0.3) continue;
      const p0 = add(add(c, scale(d, -half)), scale(out, 0.01));
      const p1 = add(add(c, scale(d, half)), scale(out, 0.01));
      for (let y = top - STOREY; y > bottom + 1; y -= STOREY) {
        glass.quadAuto(W(p0, y + 0.9), W(p1, y + 0.9), W(p1, y + 2.1), W(p0, y + 2.1));
      }
    }
  }
}

/** Footprint polygon of the lowest floor, for shadow and ground framing. */
export function footprint(plan: FloorPlan): Vec2[] | null {
  const lowest = plan.floors.reduce((a, f) => (f.elevation < a.elevation ? f : a), plan.floors[0]);
  return exteriorOutline(plan, lowest);
}
