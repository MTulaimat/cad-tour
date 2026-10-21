import { CapsuleGeometry, Group, Mesh, MeshStandardMaterial, SphereGeometry, type Material } from 'three';

/**
 * Arch-viz mannequin (Q8): a neutral matte grey figure made of capsules, like the scale figures in
 * architectural renders. Idle sway, walk and run cycles are procedural, driven by speed.
 */

interface Limb {
  pivot: Group;
  lower?: Group;
}

function capsule(mat: Material, radius: number, length: number): Mesh {
  const m = new Mesh(new CapsuleGeometry(radius, Math.max(0.001, length), 6, 14), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export class Mannequin {
  readonly root = new Group();
  private hips = new Group();
  private torso = new Group();
  private head = new Group();
  private legs: Limb[] = [];
  private arms: Limb[] = [];
  private phase = 0;
  private stride = 0;
  private time = 0;
  readonly material: MeshStandardMaterial;

  constructor(material?: MeshStandardMaterial) {
    this.material = material ?? new MeshStandardMaterial({ color: '#a3a3a1', roughness: 0.72, metalness: 0 });
    this.material.transparent = false;
    const mat = this.material;
    this.root.name = 'avatar';
    // Proportions for a 1.78 m figure; the root sits at the feet.
    this.hips.position.y = 0.94;
    this.root.add(this.hips);

    const pelvis = capsule(mat, 0.13, 0.1);
    pelvis.rotation.z = Math.PI / 2;
    pelvis.scale.set(1, 1, 0.75);
    this.hips.add(pelvis);

    this.torso.position.y = 0.06;
    this.hips.add(this.torso);
    const chest = capsule(mat, 0.155, 0.3);
    chest.position.y = 0.27;
    chest.scale.set(1.05, 1, 0.68);
    this.torso.add(chest);
    const neck = capsule(mat, 0.045, 0.06);
    neck.position.y = 0.53;
    this.torso.add(neck);
    this.head.position.y = 0.62;
    this.torso.add(this.head);
    const skull = new Mesh(new SphereGeometry(0.1, 20, 14), mat);
    skull.scale.set(0.9, 1.15, 1);
    skull.position.y = 0.07;
    skull.castShadow = true;
    this.head.add(skull);

    for (const side of [-1, 1]) {
      // Leg: thigh pivot at the hip, shin pivot at the knee.
      const thigh = new Group();
      thigh.position.set(side * 0.095, -0.02, 0);
      this.hips.add(thigh);
      const upper = capsule(mat, 0.072, 0.3);
      upper.position.y = -0.22;
      thigh.add(upper);
      const knee = new Group();
      knee.position.y = -0.45;
      thigh.add(knee);
      const shin = capsule(mat, 0.058, 0.32);
      shin.position.y = -0.22;
      knee.add(shin);
      const foot = capsule(mat, 0.045, 0.14);
      foot.rotation.x = Math.PI / 2;
      foot.position.set(0, -0.44, 0.06);
      knee.add(foot);
      this.legs.push({ pivot: thigh, lower: knee });

      // Arm: shoulder pivot, elbow pivot.
      const shoulder = new Group();
      shoulder.position.set(side * 0.2, 0.43, 0);
      this.torso.add(shoulder);
      const upperArm = capsule(mat, 0.045, 0.22);
      upperArm.position.y = -0.15;
      shoulder.add(upperArm);
      const elbow = new Group();
      elbow.position.y = -0.3;
      shoulder.add(elbow);
      const fore = capsule(mat, 0.038, 0.22);
      fore.position.y = -0.14;
      elbow.add(fore);
      const hand = new Mesh(new SphereGeometry(0.045, 12, 8), mat);
      hand.position.y = -0.31;
      hand.scale.set(0.8, 1.2, 0.6);
      elbow.add(hand);
      shoulder.rotation.z = side * 0.08;
      this.arms.push({ pivot: shoulder, lower: elbow });
    }
  }

  /**
   * Advances the animation. `speed` is horizontal m/s; `run` picks the faster cycle.
   * Root placement and yaw are set by the caller.
   */
  update(dt: number, speed: number, run: boolean): void {
    this.time += dt;
    const moving = Math.min(1, speed / 1.2);
    const runBlend = Math.min(1, Math.max(0, (speed - 1.8) / 1.0)) * (run ? 1 : 0.6);
    // Stride length grows with speed; phase advances with distance covered.
    const strideLen = 0.75 + runBlend * 0.55;
    this.phase += (speed * dt * Math.PI) / strideLen;
    this.stride += (moving - this.stride) * Math.min(1, dt * 8);
    const s = this.stride;
    const swing = (0.5 + runBlend * 0.35) * s;
    const sinP = Math.sin(this.phase);
    const cosP = Math.cos(this.phase);

    // Idle: slow breathing and weight shift, fading out as the figure walks.
    const idle = 1 - s;
    const breathe = Math.sin(this.time * 1.6) * 0.008 * idle;
    const sway = Math.sin(this.time * 0.7) * 0.02 * idle;

    this.hips.position.y = 0.94 - Math.abs(sinP) * 0.03 * s - runBlend * 0.03 * s + breathe;
    this.hips.position.x = sway;
    this.hips.rotation.y = sinP * 0.12 * s;
    this.torso.rotation.y = -sinP * 0.18 * s;
    this.torso.rotation.x = 0.04 * s + runBlend * 0.18 * s;
    this.torso.rotation.z = -sway * 0.8;
    this.head.rotation.x = -this.torso.rotation.x * 0.6;
    this.head.rotation.y = Math.sin(this.time * 0.4) * 0.15 * idle;

    this.legs.forEach((leg, i) => {
      const side = i === 0 ? 1 : -1;
      const ph = side * sinP;
      leg.pivot.rotation.x = -ph * swing;
      // Knee bends on the back swing and as the leg passes under the body.
      const bend = Math.max(0, side * cosP) * (0.9 + runBlend * 0.7) * s + 0.06;
      if (leg.lower) leg.lower.rotation.x = bend;
    });
    this.arms.forEach((arm, i) => {
      const side = i === 0 ? -1 : 1;
      arm.pivot.rotation.x = side * sinP * swing * 0.75;
      if (arm.lower) arm.lower.rotation.x = -(0.15 + runBlend * 0.9) * s - 0.08;
    });
  }

  /** Fades the figure when the camera gets very close, so it never fills the view. */
  setOpacity(o: number): void {
    const t = o < 0.999;
    if (this.material.transparent !== t) {
      this.material.transparent = t;
      this.material.needsUpdate = true;
    }
    this.material.opacity = o;
    this.material.depthWrite = !t;
    this.root.visible = o > 0.02;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.material.dispose();
  }
}
