import { registerSW } from 'virtual:pwa-register';

/**
 * Registers the service worker and applies new versions without interrupting a tour: a version
 * that arrives while the start screen is showing is loaded at once (one reload); one that
 * arrives during a tour waits until the start screen shows again.
 */
export class AppUpdates {
  private pending: ((reload?: boolean) => Promise<void>) | null = null;

  constructor(private canApplyNow: () => boolean) {
    if (!('serviceWorker' in navigator)) return;
    const update = registerSW({
      immediate: true,
      onNeedRefresh: () => {
        this.pending = update;
        this.applyIfPending();
      },
    });
  }

  /** Call when the start screen shows. */
  applyIfPending(): void {
    if (this.pending && this.canApplyNow()) {
      const apply = this.pending;
      this.pending = null;
      void apply(true);
    }
  }
}
