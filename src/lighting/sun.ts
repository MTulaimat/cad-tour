import { Box3, Color, DirectionalLight, Matrix4, Object3D, Vector3 } from 'three';
import type { TierConfig } from '../render/quality';

/**
 * The sun: one shadow-casting directional light aligned with the HDRI's sun. The shadow camera is
 * fitted tightly around the floor the player is on, so a 1024 map still gives crisp patches.
 */
export class Sun {
  readonly light: DirectionalLight;
  readonly target = new Object3D();
  /** Unit vector pointing from the scene towards the sun. */
  readonly dir = new Vector3(0.5, 0.62, 0.6).normalize();

  constructor(intensity = 3.2, color = '#fff3e3') {
    this.light = new DirectionalLight(new Color(color), intensity);
    this.light.name = 'sun';
    this.light.castShadow = true;
    this.light.target = this.target;
    this.light.shadow.bias = -0.0003;
    this.light.shadow.normalBias = 0.025;
  }

  setDirection(d: Vector3): void {
    this.dir.copy(d).normalize();
  }

  configure(cfg: TierConfig): void {
    this.light.castShadow = cfg.shadows;
    const s = cfg.shadowMapSize;
    if (this.light.shadow.mapSize.x !== s) {
      this.light.shadow.mapSize.set(s, s);
      this.light.shadow.map?.dispose();
      this.light.shadow.map = null;
    }
    this.light.shadow.radius = cfg.shadowRadius;
  }

  /**
   * Fit the orthographic shadow frustum to a world-space box, seen from the sun. `depthBox` (the
   * whole building) sets near and far so floors above still cast shadows into the fitted floor.
   */
  fitTo(box: Box3, depthBox: Box3 = box): void {
    const center = box.getCenter(new Vector3());
    const radius = depthBox.getSize(new Vector3()).length() / 2;
    this.target.position.copy(center);
    this.light.position.copy(center).addScaledVector(this.dir, radius + 20);
    this.target.updateMatrixWorld();
    this.light.updateMatrixWorld();
    // Same placement three uses when it updates the shadow camera.
    const cam = this.light.shadow.camera;
    cam.position.copy(this.light.position);
    cam.lookAt(center);
    cam.updateMatrixWorld();
    const toLight = new Matrix4().copy(cam.matrixWorld).invert();
    const corners = (b: Box3) =>
      [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => new Vector3(x ? b.max.x : b.min.x, y ? b.max.y : b.min.y, z ? b.max.z : b.min.z))));
    const lb = new Box3();
    for (const c of corners(box)) lb.expandByPoint(c.applyMatrix4(toLight));
    const db = new Box3();
    for (const c of corners(depthBox)) db.expandByPoint(c.applyMatrix4(toLight));
    const pad = 0.4;
    cam.left = lb.min.x - pad;
    cam.right = lb.max.x + pad;
    cam.bottom = lb.min.y - pad;
    cam.top = lb.max.y + pad;
    cam.near = Math.max(0.1, -db.max.z - 2);
    cam.far = -db.min.z + 2;
    cam.updateProjectionMatrix();
  }
}
