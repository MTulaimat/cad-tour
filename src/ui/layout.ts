export type LayoutClass = 'cover' | 'square' | 'phone-portrait' | 'landscape' | 'tablet' | 'desktop';

export interface LayoutInfo {
  width: number;
  height: number;
  aspect: number;
  touch: boolean;
  layout: LayoutClass;
  short: boolean;
}

/**
 * Classifies the viewport from its real size and aspect ratio (never a hardcoded device size):
 * - cover: narrow and tall, like a foldable's cover screen (about 21:9),
 * - square: near-square and large, like a foldable's inner screen,
 * - phone-portrait, landscape, tablet, desktop for everything else.
 */
export function classify(width: number, height: number, touch: boolean): LayoutInfo {
  const aspect = width / Math.max(1, height);
  const short = Math.min(width, height) < 520;
  let layout: LayoutClass;
  if (aspect < 0.5 && width < 520) layout = 'cover';
  else if (aspect >= 0.78 && aspect <= 1.3 && Math.min(width, height) >= 560) layout = touch ? 'square' : 'desktop';
  else if (aspect < 0.78) layout = width < 700 ? 'phone-portrait' : 'tablet';
  else if (touch && Math.min(width, height) < 600) layout = 'landscape';
  else if (touch) layout = 'tablet';
  else layout = width < 900 ? 'landscape' : 'desktop';
  return { width, height, aspect, touch, layout, short };
}

export function hasTouch(): boolean {
  return (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 0;
}

/**
 * Watches the viewport (ResizeObserver on the app root, plus orientation and visual viewport
 * events, debounced) and applies layout classes to <html>. `onResize` gets every settled size,
 * so the renderer, camera, post buffers and HUD update in place when a foldable folds or unfolds.
 */
export class LayoutWatcher {
  info: LayoutInfo;
  private timer = 0;
  private ro: ResizeObserver;

  constructor(
    private root: HTMLElement,
    private onResize: (info: LayoutInfo) => void,
  ) {
    this.info = this.measure();
    this.apply();
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(root);
    addEventListener('orientationchange', () => this.schedule());
    addEventListener('resize', () => this.schedule());
    visualViewport?.addEventListener('resize', () => this.schedule());
  }

  private measure(): LayoutInfo {
    const r = this.root.getBoundingClientRect();
    return classify(Math.round(r.width) || innerWidth, Math.round(r.height) || innerHeight, hasTouch());
  }

  private schedule(): void {
    clearTimeout(this.timer);
    // Resize the canvas right away (no stretched frames), then settle the layout.
    this.info = this.measure();
    this.onResize(this.info);
    this.timer = window.setTimeout(() => {
      this.info = this.measure();
      this.apply();
      this.onResize(this.info);
    }, 120);
  }

  private apply(): void {
    const h = document.documentElement;
    for (const c of [...h.classList]) if (c.startsWith('layout-')) h.classList.remove(c);
    h.classList.add(`layout-${this.info.layout}`);
    h.classList.toggle('touch', this.info.touch);
    h.classList.toggle('short', this.info.short);
    h.dataset.layout = this.info.layout;
  }

  dispose(): void {
    this.ro.disconnect();
  }
}
