import type { CameraPose } from './firstPerson';

const DURATION = 0.6;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Smooth switch between first and third person (V or the mode button). Both poses are computed
 * live and already collision-checked, and the blend runs along the head-to-camera ray, so the
 * camera never cuts through a wall on the way.
 */
export class ModeTransition {
  /** 0 is first person, 1 is third person. */
  private t = 0;
  private target = 0;

  get mode(): 'first' | 'third' {
    return this.target === 1 ? 'third' : 'first';
  }

  get active(): boolean {
    return this.t !== this.target;
  }

  /** Blend factor towards third person, eased. */
  get blend(): number {
    return easeInOutCubic(this.t);
  }

  set(mode: 'first' | 'third', instant = false): void {
    this.target = mode === 'third' ? 1 : 0;
    if (instant) this.t = this.target;
  }

  toggle(): void {
    this.set(this.mode === 'third' ? 'first' : 'third');
  }

  update(dt: number): void {
    const step = Math.max(0, dt) / DURATION;
    this.t = this.target > this.t ? Math.min(this.target, this.t + step) : Math.max(this.target, this.t - step);
  }

  apply(first: CameraPose, third: CameraPose, out: CameraPose): void {
    const b = this.blend;
    out.position.copy(first.position).lerp(third.position, b);
    out.quaternion.copy(first.quaternion).slerp(third.quaternion, b);
  }
}
