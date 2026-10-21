/**
 * Critically damped spring for the body height. Walking heights come analytically from the plan
 * (ramps on flights, flat floors), and this spring smooths the corners where a ramp meets a floor,
 * so the camera never jitters on stairs and never overshoots.
 */
export class HeightSpring {
  value: number;
  velocity = 0;

  constructor(
    value: number,
    /** Angular frequency (rad/s); higher follows tighter. */
    public omega = 16,
  ) {
    this.value = value;
  }

  step(target: number, dt: number): number {
    // Exact integration of x'' = -2w x' - w^2 (x - target).
    const w = this.omega;
    const x = this.value - target;
    const e = Math.exp(-w * dt);
    const nx = (x + (this.velocity + w * x) * dt) * e;
    const nv = (this.velocity - w * (this.velocity + w * x) * dt) * e;
    this.value = target + nx;
    this.velocity = nv;
    return this.value;
  }

  snap(v: number): void {
    this.value = v;
    this.velocity = 0;
  }
}
