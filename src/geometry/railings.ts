import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Floor, FloorPlan, Vec2 } from '../data/schema';
import { add, angleOf, dist, lerp2, normalize, perp, scale, sub } from '../util/math2d';
import { stairInfos } from '../plan/stairs';
import { type BuilderSet, W } from './builder';

export interface RailRun {
  points: Vec2[];
  height: number;
  style: 'glass' | 'metal';
}

const POST = 0.04;
const MAX_PANEL = 1.4;

/** Every railing on a floor: explicit ones plus guards around stairwells arriving here. */
export function railRuns(plan: FloorPlan, floor: Floor): RailRun[] {
  const runs: RailRun[] = floor.railings.map((r) => ({ points: r.points, height: r.height, style: r.style }));
  for (const s of stairInfos(plan)) {
    if (s.to.id !== floor.id) continue;
    for (const [a, b] of s.guardEdges) {
      // Pull the guard 3 cm back from the opening edge so it stands on the slab.
      const d = normalize(sub(b, a));
      const n = perp(d);
      // Outline is counterclockwise; the slab side is to the right of travel.
      const back = scale(n, -0.03);
      runs.push({ points: [add(a, back), add(b, back)], height: 1.0, style: 'glass' });
    }
  }
  return runs;
}

export function buildRailings(plan: FloorPlan, floor: Floor, sets: BuilderSet): void {
  const E = floor.elevation;
  const metal = sets.get('metal-brushed');
  const glass = sets.get('glass');
  const q = (d: Vec2) => new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angleOf(d));
  for (const run of railRuns(plan, floor)) {
    const H = run.height;
    for (let i = 1; i < run.points.length; i++) {
      const a = run.points[i - 1];
      const b = run.points[i];
      const len = dist(a, b);
      if (len < 0.05) continue;
      const d = normalize(sub(b, a));
      const n = Math.max(1, Math.ceil(len / MAX_PANEL));
      // Posts at the ends of every panel.
      for (let k = 0; k <= n; k++) {
        if (k === 0 && i > 1) continue;
        const p = lerp2(a, b, k / n);
        metal.box(new Matrix4().compose(W(p, E + H / 2), q(d), new Vector3(1, 1, 1)), POST, H, POST);
      }
      // Top rail.
      const mid = lerp2(a, b, 0.5);
      metal.box(new Matrix4().compose(W(mid, E + H + 0.02), q(d), new Vector3(1, 1, 1)), len + POST, 0.04, 0.06);
      if (run.style === 'glass') {
        for (let k = 0; k < n; k++) {
          const p0 = add(lerp2(a, b, k / n), scale(d, POST / 2 + 0.01));
          const p1 = add(lerp2(a, b, (k + 1) / n), scale(d, -POST / 2 - 0.01));
          glass.quadAuto(W(p0, E + 0.06), W(p1, E + 0.06), W(p1, E + H - 0.02), W(p0, E + H - 0.02));
        }
        // Bottom shoe rail.
        metal.box(new Matrix4().compose(W(mid, E + 0.03), q(d), new Vector3(1, 1, 1)), len + POST, 0.06, 0.05);
      } else {
        // Metal rail: slim vertical bars.
        const bars = Math.max(2, Math.round(len / 0.11));
        for (let k = 1; k < bars; k++) {
          const p = lerp2(a, b, k / bars);
          metal.box(new Matrix4().compose(W(p, E + H / 2), q(d), new Vector3(1, 1, 1)), 0.014, H, 0.014);
        }
      }
    }
  }
}
