import { Color, Group, PointLight, RectAreaLight, Vector3 } from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import type { Floor } from '../data/schema';
import { bounds, interiorPoint, polygonArea } from '../util/math2d';

/**
 * Interior lights by tier. Low: none. Medium: a few unshadowed warm point lights. High: adds soft
 * ceiling panels (RectAreaLight). The pools have a fixed size and are moved to the player's floor,
 * so switching floors never changes the light count (no shader recompiles).
 */
export class InteriorLights {
  readonly group = new Group();
  private points: PointLight[] = [];
  private rects: RectAreaLight[] = [];
  private static ltcReady = false;

  constructor(pointCount: number, rectCount: number) {
    this.group.name = 'interior-lights';
    if (rectCount > 0 && !InteriorLights.ltcReady) {
      RectAreaLightUniformsLib.init();
      InteriorLights.ltcReady = true;
    }
    for (let i = 0; i < pointCount; i++) {
      const l = new PointLight(new Color('#ffd7ad'), 0, 7, 2);
      l.castShadow = false;
      this.points.push(l);
      this.group.add(l);
    }
    for (let i = 0; i < rectCount; i++) {
      const l = new RectAreaLight(new Color('#fff1de'), 0, 0.9, 0.9);
      this.rects.push(l);
      this.group.add(l);
    }
  }

  get count(): { points: number; rects: number } {
    return { points: this.points.length, rects: this.rects.length };
  }

  /** Places the pools in the largest indoor rooms of a floor. */
  placeFor(floor: Floor): void {
    const rooms = floor.rooms
      .filter((r) => !r.outdoor)
      .map((r) => ({ r, area: polygonArea(r.polygon) }))
      .sort((a, b) => b.area - a.area);
    this.points.forEach((l, i) => {
      const room = rooms[i];
      if (!room) {
        l.intensity = 0;
        l.visible = false;
        return;
      }
      const p = interiorPoint(room.r.polygon);
      const ceil = room.r.ceilingHeight ?? floor.ceilingHeight;
      l.position.set(p.x, floor.elevation + ceil - 0.9, -p.y);
      // Daytime: a faint warm fill, not a visible lamp.
      l.intensity = 0.25 + Math.min(0.35, room.area / 60);
      l.distance = Math.max(5, Math.sqrt(room.area) * 1.8);
      l.visible = true;
    });
    this.rects.forEach((l, i) => {
      const room = rooms[i];
      if (!room) {
        l.intensity = 0;
        l.visible = false;
        return;
      }
      const b = bounds(room.r.polygon);
      const p = interiorPoint(room.r.polygon);
      const ceil = room.r.ceilingHeight ?? floor.ceilingHeight;
      l.width = Math.min(1.2, (b.maxX - b.minX) * 0.35);
      l.height = Math.min(1.2, (b.maxY - b.minY) * 0.35);
      l.position.set(p.x, floor.elevation + ceil - 0.02, -p.y);
      l.lookAt(new Vector3(p.x, floor.elevation, -p.y));
      l.intensity = 0.6;
      l.visible = true;
    });
  }

  dispose(): void {
    for (const l of [...this.points, ...this.rects]) l.dispose();
    this.group.clear();
  }
}
