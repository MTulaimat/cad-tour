import { el } from '../ui/dom';
import type { InputState, LookSettings } from './input';

const STICK_RADIUS = 58;
const DEAD_ZONE = 0.08;
/** Touch look is in pixels; scale relative to the mouse setting. */
const TOUCH_LOOK_SCALE = 2.3;

/**
 * Two-thumb touch controls for a near-square screen (and any other):
 * - one half: a floating joystick that appears where the thumb lands,
 * - the other half: drag to look.
 * Pointers are tracked by pointerId so both thumbs act at once. Left-handed mode swaps halves.
 */
export class TouchControls {
  readonly layer: HTMLElement;
  private stick: HTMLElement;
  private knob: HTMLElement;
  private roles = new Map<number, { role: 'stick' | 'look'; x: number; y: number; ox: number; oy: number }>();
  enabled = false;
  leftHanded = false;
  /** Called on the first touch so the UI can hide the hints. */
  onFirstUse: (() => void) | null = null;

  constructor(
    private input: InputState,
    private settings: () => LookSettings,
  ) {
    this.knob = el('div', { class: 'knob' });
    this.stick = el('div', { class: 'joystick', 'aria-hidden': 'true' }, [this.knob]);
    this.layer = el('div', { class: 'touch-layer', 'data-testid': 'touch-layer' }, [this.stick]);
    const opts = { passive: false } as AddEventListenerOptions;
    this.layer.addEventListener('pointerdown', (e) => this.down(e), opts);
    this.layer.addEventListener('pointermove', (e) => this.move(e), opts);
    this.layer.addEventListener('pointerup', (e) => this.up(e), opts);
    this.layer.addEventListener('pointercancel', (e) => this.up(e), opts);
    this.layer.addEventListener('lostpointercapture', (e) => this.up(e), opts);
    // Stop the browser from scrolling, zooming or long-press menus.
    for (const t of ['touchstart', 'touchmove', 'touchend', 'gesturestart'] as const) {
      this.layer.addEventListener(t, (e) => e.preventDefault(), opts);
    }
    this.layer.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private isStickSide(x: number): boolean {
    const r = this.layer.getBoundingClientRect();
    const mid = r.left + r.width / 2;
    return this.leftHanded ? x >= mid : x < mid;
  }

  private down(e: PointerEvent): void {
    if (!this.enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    this.onFirstUse?.();
    const hasStick = [...this.roles.values()].some((r) => r.role === 'stick');
    const role = this.isStickSide(e.clientX) && !hasStick ? 'stick' : 'look';
    this.roles.set(e.pointerId, { role, x: e.clientX, y: e.clientY, ox: e.clientX, oy: e.clientY });
    try {
      this.layer.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers in tests may not support capture.
    }
    if (role === 'stick') {
      const r = this.layer.getBoundingClientRect();
      this.stick.style.left = `${e.clientX - r.left}px`;
      this.stick.style.top = `${e.clientY - r.top}px`;
      this.knob.style.transform = 'translate(0px, 0px)';
      this.stick.classList.add('on');
    }
  }

  private move(e: PointerEvent): void {
    const st = this.roles.get(e.pointerId);
    if (!st) return;
    e.preventDefault();
    if (st.role === 'look') {
      const s = this.settings();
      const k = s.sensitivity * TOUCH_LOOK_SCALE;
      this.input.look((e.clientX - st.x) * k, (s.invertY ? 1 : -1) * (e.clientY - st.y) * k);
      st.x = e.clientX;
      st.y = e.clientY;
      return;
    }
    let dx = e.clientX - st.ox;
    let dy = e.clientY - st.oy;
    const d = Math.hypot(dx, dy);
    if (d > STICK_RADIUS) {
      dx *= STICK_RADIUS / d;
      dy *= STICK_RADIUS / d;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    let nx = dx / STICK_RADIUS;
    let ny = -dy / STICK_RADIUS;
    const m = Math.hypot(nx, ny);
    if (m < DEAD_ZONE) {
      nx = 0;
      ny = 0;
    } else {
      const k = (m - DEAD_ZONE) / (1 - DEAD_ZONE) / m;
      nx *= k;
      ny *= k;
    }
    this.input.stick = { x: nx, y: ny };
    st.x = e.clientX;
    st.y = e.clientY;
  }

  private up(e: PointerEvent): void {
    const st = this.roles.get(e.pointerId);
    if (!st) return;
    this.roles.delete(e.pointerId);
    if (st.role === 'stick') {
      this.input.stick = { x: 0, y: 0 };
      this.stick.classList.remove('on');
    }
  }

  /** Drops all active touches (menus opening, visibility changes). */
  reset(): void {
    this.roles.clear();
    this.input.stick = { x: 0, y: 0 };
    this.stick.classList.remove('on');
  }

  get activePointers(): number {
    return this.roles.size;
  }
}
