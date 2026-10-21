/**
 * Input shared by every control scheme. Keyboard, mouse and touch all write into one state;
 * the simulation reads it each fixed step. Look deltas accumulate until consumed.
 */
export class InputState {
  /** Movement from keys (digital) and from the joystick (analog), combined on read. */
  keys = { forward: false, back: false, left: false, right: false };
  stick = { x: 0, y: 0 };
  runKey = false;
  runToggle = false;
  private lookX = 0;
  private lookY = 0;

  get move(): { x: number; y: number } {
    const kx = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
    const ky = (this.keys.forward ? 1 : 0) - (this.keys.back ? 1 : 0);
    const x = Math.max(-1, Math.min(1, kx + this.stick.x));
    const y = Math.max(-1, Math.min(1, ky + this.stick.y));
    return { x, y };
  }

  get run(): boolean {
    return this.runKey || this.runToggle || Math.hypot(this.stick.x, this.stick.y) > 0.98;
  }

  /** Adds a look delta in radians (positive x turns right, positive y looks up). */
  look(dx: number, dy: number): void {
    this.lookX += dx;
    this.lookY += dy;
  }

  consumeLook(): { x: number; y: number } {
    const out = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  clear(): void {
    this.keys = { forward: false, back: false, left: false, right: false };
    this.stick = { x: 0, y: 0 };
    this.runKey = false;
    this.lookX = 0;
    this.lookY = 0;
  }
}

export interface LookSettings {
  /** Radians per pixel for mouse, scaled for touch. */
  sensitivity: number;
  invertY: boolean;
}
