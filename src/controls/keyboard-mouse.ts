import type { InputState, LookSettings } from './input';

export interface KeyboardMouseHandlers {
  toggleMode(): void;
  toggleHelp(): void;
  toggleMinimap(): void;
  toggleMenu(): void;
  /** Whether the mouse is currently captured (Esc first releases it, then opens the menu). */
  isLocked(): boolean;
  /** Called when pointer lock is lost (Esc), so the UI can show a resume prompt. */
  pointerLockChanged(locked: boolean): void;
}

const MOVE_KEYS: Record<string, keyof InputState['keys']> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

/**
 * Desktop controls: WASD or arrows to move, Shift to run, mouse look with pointer lock,
 * V to switch first and third person, H for help, M for the minimap.
 */
export class KeyboardMouse {
  enabled = false;
  private disposers: (() => void)[] = [];

  constructor(
    private target: HTMLElement,
    private input: InputState,
    private settings: () => LookSettings,
    private handlers: KeyboardMouseHandlers,
  ) {
    const on = <K extends keyof DocumentEventMap>(el: Window | Document | HTMLElement, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
    };
    on(window, 'keydown', (e) => this.key(e, true));
    on(window, 'keyup', (e) => this.key(e, false));
    on(window, 'blur', () => this.input.clear());
    on(document, 'mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.target) return;
      const s = this.settings();
      this.input.look(e.movementX * s.sensitivity, (s.invertY ? 1 : -1) * e.movementY * s.sensitivity);
    });
    on(document, 'pointerlockchange', () => this.handlers.pointerLockChanged(document.pointerLockElement === this.target));
  }

  private key(e: KeyboardEvent, down: boolean): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!this.enabled) {
      if (down && e.code === 'Escape') this.handlers.toggleMenu();
      return;
    }
    const mk = MOVE_KEYS[e.code];
    if (mk) {
      this.input.keys[mk] = down;
      e.preventDefault();
      return;
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      this.input.runKey = down;
      return;
    }
    if (!down || e.repeat) return;
    if (e.code === 'Escape' && !this.handlers.isLocked()) this.handlers.toggleMenu();
    else if (e.code === 'KeyV') this.handlers.toggleMode();
    else if (e.code === 'KeyH') this.handlers.toggleHelp();
    else if (e.code === 'KeyM') this.handlers.toggleMinimap();
  }

  requestLock(): void {
    if (document.pointerLockElement === this.target) return;
    try {
      const r = this.target.requestPointerLock?.() as unknown as Promise<void> | undefined;
      r?.catch?.(() => {});
    } catch {
      // Pointer lock can be refused (iframes, embedded browsers); mouse drag still works.
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  dispose(): void {
    this.disposers.forEach((d) => d());
    this.disposers = [];
  }
}
