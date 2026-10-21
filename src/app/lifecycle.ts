/**
 * Page lifecycle: pause rendering when hidden, keep the screen awake during a tour, fullscreen,
 * WebGL context loss and restore, and the Device Posture API as an optional hint.
 */

type WakeLockSentinel = { release(): Promise<void>; addEventListener(t: 'release', f: () => void): void };

export class WakeLock {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  get supported(): boolean {
    return 'wakeLock' in navigator;
  }

  get active(): boolean {
    return this.sentinel !== null;
  }

  async request(): Promise<boolean> {
    this.wanted = true;
    if (!this.supported || this.sentinel || document.visibilityState !== 'visible') return this.active;
    try {
      const wl = (navigator as Navigator & { wakeLock: { request(t: 'screen'): Promise<WakeLockSentinel> } }).wakeLock;
      this.sentinel = await wl.request('screen');
      this.sentinel.addEventListener('release', () => (this.sentinel = null));
    } catch {
      this.sentinel = null;
    }
    return this.active;
  }

  /** Wake locks drop when the tab is hidden; ask again when it comes back. */
  async reacquire(): Promise<void> {
    if (this.wanted && document.visibilityState === 'visible') await this.request();
  }

  async release(): Promise<void> {
    this.wanted = false;
    try {
      await this.sentinel?.release();
    } catch {
      // Already released.
    }
    this.sentinel = null;
  }
}

export const fullscreenSupported = (): boolean => !!(document.fullscreenEnabled || (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled);

export const isFullscreen = (): boolean => !!(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement);

export async function toggleFullscreen(): Promise<void> {
  try {
    if (isFullscreen()) {
      await (document.exitFullscreen?.() ?? (document as Document & { webkitExitFullscreen?: () => void }).webkitExitFullscreen?.());
    } else {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      await (el.requestFullscreen?.({ navigationUI: 'hide' }) ?? el.webkitRequestFullscreen?.());
    }
  } catch {
    // Some browsers refuse without a user gesture; the button stays usable.
  }
}

export interface ContextHandlers {
  lost(): void;
  restored(): void;
}

export function watchContext(canvas: HTMLCanvasElement, h: ContextHandlers): void {
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    h.lost();
  });
  canvas.addEventListener('webglcontextrestored', () => h.restored());
}

export function watchVisibility(onChange: (visible: boolean) => void): void {
  document.addEventListener('visibilitychange', () => onChange(document.visibilityState === 'visible'));
}

/** Device Posture API (progressive enhancement): 'folded' or 'continuous', when available. */
export function watchPosture(onChange: (posture: string) => void): void {
  const dp = (navigator as Navigator & { devicePosture?: { type: string; addEventListener(t: 'change', f: () => void): void } }).devicePosture;
  if (!dp) return;
  onChange(dp.type);
  dp.addEventListener('change', () => onChange(dp.type));
}
