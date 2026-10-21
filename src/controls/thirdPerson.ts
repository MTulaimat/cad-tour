import { BufferGeometry, Mesh, Raycaster, Vector3, type Object3D } from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { Vec2 } from '../data/schema';
import { lookQuaternion, type CameraPose } from './firstPerson';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

export const PIVOT_HEIGHT = 1.55;
const DISTANCE = 2.5;
const SHOULDER = 0.28;
const CAM_RADIUS = 0.2;
const MIN_DIST = 0.35;

/**
 * Third person orbit camera. It sits behind and slightly right of the mannequin's head, casts a
 * small bundle of rays (a cheap sphere cast) from the head towards where it wants to be, and pulls
 * in in front of anything it would clip through, walls and ceilings included.
 */
export class ThirdPersonCamera {
  private raycaster = new Raycaster();
  private colliders: Object3D[] = [];
  distance = DISTANCE;
  /** Current pulled-in distance (eases back out, snaps in). */
  private current = DISTANCE;

  constructor() {
    (this.raycaster as Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  }

  /** Meshes the camera must not pass through. Builds their BVH once. */
  setColliders(meshes: Mesh[]): void {
    for (const m of meshes) {
      const g = m.geometry as BufferGeometry & { boundsTree?: unknown };
      if (!g.boundsTree) g.computeBoundsTree();
    }
    this.colliders = meshes;
  }

  /** Free distance along `dir` from `origin`, up to `max`. */
  private freeDistance(origin: Vector3, dir: Vector3, max: number): number {
    // Ray bundle: center plus four offsets around it, approximating a sphere of CAM_RADIUS.
    const up = Math.abs(dir.y) > 0.95 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
    const side = new Vector3().crossVectors(dir, up).normalize();
    const up2 = new Vector3().crossVectors(side, dir).normalize();
    const offsets = [new Vector3(), side.clone().multiplyScalar(CAM_RADIUS), side.clone().multiplyScalar(-CAM_RADIUS), up2.clone().multiplyScalar(CAM_RADIUS), up2.clone().multiplyScalar(-CAM_RADIUS)];
    let best = max;
    for (const o of offsets) {
      this.raycaster.set(origin.clone().add(o), dir);
      this.raycaster.far = max + CAM_RADIUS;
      const hit = this.raycaster.intersectObjects(this.colliders, false)[0];
      if (hit) best = Math.min(best, hit.distance - CAM_RADIUS);
    }
    return Math.max(MIN_DIST, best);
  }

  pose(p: Vec2, body: number, yaw: number, pitch: number, dt: number): CameraPose & { pivot: Vector3; distance: number } {
    const q = lookQuaternion(yaw, Math.max(-0.75, Math.min(0.9, pitch)));
    const pivot = new Vector3(p.x, body + PIVOT_HEIGHT, -p.y);
    const back = new Vector3(0, 0, 1).applyQuaternion(q);
    const right = new Vector3(1, 0, 0).applyQuaternion(q);
    // Shoulder offset first (checked), then pull back from there.
    const shoulderFree = this.freeDistance(pivot, right, SHOULDER);
    const shoulder = pivot.clone().addScaledVector(right, Math.min(SHOULDER, shoulderFree));
    const free = this.freeDistance(shoulder, back, this.distance);
    if (free < this.current) this.current = free;
    else this.current += (free - this.current) * Math.min(1, dt * 3);
    const position = shoulder.clone().addScaledVector(back, this.current);
    return { position, quaternion: q, pivot, distance: this.current };
  }

  /** Resets the eased distance (after teleports and mode switches). */
  reset(): void {
    this.current = MIN_DIST;
  }
}
