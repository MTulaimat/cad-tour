import type { FloorPlan } from '../data/schema';
import { loadPlan } from '../data/loader';
import { exportPlanJson, importPlanJson, PlanJsonError, planFileName } from '../data/planJson';
import { InputState } from '../controls/input';
import { KeyboardMouse } from '../controls/keyboard-mouse';
import { TouchControls } from '../controls/touch';
import { detectTier, isMobileDevice, lowerTier, type Tier, type TierSetting } from '../render/quality';
import { el } from '../ui/dom';
import { Hud } from '../ui/hud';
import { LayoutWatcher, type LayoutInfo } from '../ui/layout';
import { HelpOverlay, LoadingScreen, MenuSheet, MessageDialog, StartOverlay, StartScreen, Toast } from '../ui/screens';
import { fullscreenSupported, isFullscreen, toggleFullscreen, WakeLock, watchContext, watchPosture, watchVisibility } from './lifecycle';
import { TourSession, type PlayerState } from './session';
import { loadSettings, saveSettings, type Settings } from './settings';
import { loadLastPlan, saveLastPlan } from './storage';
import { Tour } from './tour';
import { classifyFile, DWG_MESSAGE, BINARY_DXF_MESSAGE } from './files';
import { ImportFlow } from '../ui/importFlow';

type BeforeInstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

const TIERS: Tier[] = ['low', 'medium', 'high'];

/**
 * The app shell: start screen, loading, tap to start, HUD, menu and settings, help, imports,
 * and the page lifecycle around the 3D tour.
 */
export class App {
  private settings: Settings = loadSettings();
  private input = new InputState();
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private tour: Tour;
  private session: TourSession | null = null;
  private plan: FloorPlan | null = null;
  private lastPlan: FloorPlan | null = null;
  private layout: LayoutWatcher;
  private hud: Hud;
  private start: StartScreen;
  private loading: LoadingScreen;
  private overlay: StartOverlay;
  private help: HelpOverlay;
  private menu: MenuSheet;
  private dialog = new MessageDialog();
  private toast = new Toast();
  private fade = el('div', { class: 'fade', 'aria-hidden': 'true' });
  private debugEl: HTMLElement | null = null;
  private importFlow: ImportFlow;
  private km: KeyboardMouse;
  private touch: TouchControls;
  private wake = new WakeLock();
  private mobile = isMobileDevice();
  private autoTier: Tier;
  private started = false;
  private running = false;
  private contextLost = false;
  private installEvent: BeforeInstallPrompt | null = null;
  private probeFrames: number[] = [];
  private probeDone = false;
  private savedState: PlayerState | null = null;
  private pointerLocked = false;

  constructor(root: HTMLElement) {
    this.canvas = el('canvas', { 'aria-label': '3D view of the apartment', tabindex: '0', 'data-testid': 'canvas' });
    this.stage = el('div', { class: 'stage' }, [this.canvas]);
    this.tour = new Tour(this.canvas, 'low', this.mobile);
    this.autoTier = detectTier(this.tour.renderer).tier;
    this.applyTier();

    this.touch = new TouchControls(this.input, () => this.lookSettings());
    this.touch.leftHanded = this.settings.leftHanded;
    this.touch.onFirstUse = () => this.hud.hideHints();
    this.stage.appendChild(this.touch.layer);

    this.hud = new Hud({
      toggleMode: () => this.session?.toggleMode(),
      toggleRun: () => {
        this.input.runToggle = !this.input.runToggle;
        this.hud.setRun(this.input.runToggle);
      },
      openMenu: () => this.openMenu(),
      openHelp: () => this.setHelp(true),
      toggleFullscreen: () => void toggleFullscreen(),
      cycleQuality: () => {
        const order: TierSetting[] = ['auto', 'low', 'medium', 'high'];
        this.setQuality(order[(order.indexOf(this.settings.quality) + 1) % order.length]);
      },
      goToFloor: (i) => this.goToFloor(i),
    });
    this.hud.setLeftHanded(this.settings.leftHanded);
    this.hud.minimap.setCollapsed(!this.settings.minimap);
    this.hud.setQuality(this.settings.quality, this.tier);

    this.start = new StartScreen({
      demo: () => void this.loadDemo(),
      open: (f) => void this.openFile(f),
      resume: () => this.lastPlan && void this.build(this.lastPlan),
    });
    this.loading = new LoadingScreen();
    this.overlay = new StartOverlay(() => this.beginTour());
    this.help = new HelpOverlay(() => this.setHelp(false));
    this.menu = new MenuSheet({
      close: () => this.closeMenu(),
      openPlan: () => {
        this.closeMenu();
        this.start.fileInput.click();
      },
      demo: () => {
        this.closeMenu();
        void this.loadDemo();
      },
      exportJson: () => this.exportJson(),
      importJson: (f) => {
        this.closeMenu();
        void this.openFile(f);
      },
      setQuality: (q) => this.setQuality(q),
      setRenderScale: (v) => {
        this.settings.renderScale = v;
        this.persist();
        this.applyScale();
      },
      setSensitivity: (v) => {
        this.settings.sensitivity = v;
        this.persist();
      },
      setInvertY: (v) => {
        this.settings.invertY = v;
        this.persist();
      },
      setLeftHanded: (v) => {
        this.settings.leftHanded = v;
        this.touch.leftHanded = v;
        document.documentElement.classList.toggle('left-handed', v);
        this.hud.setLeftHanded(v);
        this.persist();
      },
      setMinimap: (v) => {
        this.settings.minimap = v;
        this.hud.minimap.setCollapsed(!v);
        this.persist();
      },
      install: () => void this.install(),
    });
    this.importFlow = new ImportFlow({
      build: (plan) => void this.build(plan),
      demo: () => void this.loadDemo(),
      cancel: () => this.showStart(),
      message: (title, body, details) => this.fail(title, body, details),
    });

    root.append(this.stage, this.hud.root, this.start.root, this.loading.root, this.overlay.root, this.importFlow.root, this.help.root, this.menu.root, this.dialog.root, this.fade, this.toast.root);
    document.documentElement.classList.toggle('left-handed', this.settings.leftHanded);

    this.km = new KeyboardMouse(this.canvas, this.input, () => this.lookSettings(), {
      toggleMode: () => this.session?.toggleMode(),
      toggleHelp: () => this.setHelp(!this.help.open),
      toggleMinimap: () => {
        this.settings.minimap = !this.settings.minimap;
        this.hud.minimap.setCollapsed(!this.settings.minimap);
        this.persist();
      },
      toggleMenu: () => (this.menu.open ? this.closeMenu() : this.started && this.openMenu()),
      isLocked: () => this.pointerLocked,
      pointerLockChanged: (locked) => this.onPointerLock(locked),
    });

    // Desktop: clicking the view captures the mouse again after Esc.
    this.canvas.addEventListener('click', () => {
      if (this.started && !this.layout.info.touch && !this.pointerLocked && !this.menu.open && !this.help.open) this.km.requestLock();
    });

    this.layout = new LayoutWatcher(root, (info) => this.onResize(info));
    this.onResize(this.layout.info);
    this.tour.onUpdate = (dt) => this.frame(dt);

    watchVisibility((visible) => this.onVisibility(visible));
    watchContext(this.canvas, {
      lost: () => this.onContextLost(),
      restored: () => void this.onContextRestored(),
    });
    watchPosture((p) => document.documentElement.setAttribute('data-posture', p));
    addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installEvent = e as BeforeInstallPrompt;
    });
    this.setupDragAndDrop();
    this.hud.setFullscreen(isFullscreen(), fullscreenSupported());
    document.addEventListener('fullscreenchange', () => this.hud.setFullscreen(isFullscreen(), fullscreenSupported()));

    if (new URLSearchParams(location.search).has('debug')) {
      this.debugEl = el('div', { class: 'debug glass', 'data-testid': 'debug' });
      root.appendChild(this.debugEl);
    }
    this.exposeTestHook();
  }

  async init(): Promise<void> {
    this.lastPlan = await loadLastPlan();
    this.start.setContinue(this.lastPlan ? this.lastPlan.name : null);
    const params = new URLSearchParams(location.search);
    if (params.has('demo')) await this.loadDemo(params.has('autostart'));
    else this.showStart();
    document.body.dataset.ready = '1';
  }

  // ---- settings and quality -------------------------------------------------

  private lookSettings() {
    return { sensitivity: this.settings.sensitivity, invertY: this.settings.invertY };
  }

  private persist(): void {
    saveSettings(this.settings);
    this.menu.sync(this.settings, this.plan?.name ?? 'none', !!this.installEvent);
  }

  private get tier(): Tier {
    const q = new URLSearchParams(location.search).get('quality') as Tier | null;
    if (q && TIERS.includes(q)) return q;
    return this.settings.quality === 'auto' ? this.autoTier : this.settings.quality;
  }

  private applyTier(): void {
    const t = this.tier;
    if (t !== this.tour.config.tier) this.tour.setTier(t, this.mobile);
    this.applyScale();
    this.hud?.setQuality(this.settings.quality, t);
  }

  private applyScale(): void {
    const s = this.settings.renderScale;
    this.tour.dyn.enabled = s === null;
    if (s !== null) this.tour.dyn.scale = Math.max(0.5, Math.min(1, s));
    this.tour.resize(this.layout?.info.width ?? innerWidth, this.layout?.info.height ?? innerHeight);
  }

  private setQuality(q: TierSetting): void {
    this.settings.quality = q;
    this.persist();
    this.applyTier();
    this.toast.show(q === 'auto' ? `Quality: Auto (${this.tier})` : `Quality: ${q[0].toUpperCase()}${q.slice(1)}`);
  }

  /** Frame-time probe right after the tour starts: in Auto, step down a tier if it struggles. */
  private probeFrame(dt: number): void {
    if (this.probeDone || !this.running) return;
    this.probeFrames.push(dt * 1000);
    if (this.probeFrames.length < 90) return;
    this.probeDone = true;
    const sorted = this.probeFrames.slice(30).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (this.settings.quality === 'auto' && median > 28 && this.autoTier !== 'low') {
      this.autoTier = lowerTier(this.autoTier);
      this.applyTier();
      this.toast.show(`Quality lowered to ${this.autoTier} for smoother movement`);
    }
  }

  // ---- screens ----------------------------------------------------------------

  private showStart(message?: string): void {
    this.stopTour();
    this.start.showMessage(message ?? null);
    this.start.show(true);
    this.loading.show(false);
    this.overlay.show(false);
    this.hud.show(false);
    this.importFlow.hide();
  }

  private fail(title: string, body: string, details: string[] = []): void {
    this.loading.show(false);
    this.dialog.show(
      title,
      body,
      [
        { label: 'Use demo apartment', primary: true, run: () => void this.loadDemo() },
        { label: 'Back to start', run: () => this.showStart() },
      ],
      details,
    );
  }

  private async loadDemo(autostart = false): Promise<void> {
    await this.build(await loadPlan(), autostart);
  }

  async openFile(file: File): Promise<void> {
    const kind = await classifyFile(file);
    if (kind === 'dwg') return this.fail("Can't open this file", DWG_MESSAGE);
    if (kind === 'binary-dxf') return this.fail("Can't open this file", BINARY_DXF_MESSAGE);
    if (kind === 'json') {
      try {
        const plan = importPlanJson(await file.text());
        plan.source = { kind: 'json', fileName: file.name, importedAt: new Date().toISOString() };
        await this.build(plan);
      } catch (e) {
        const err = e as PlanJsonError;
        this.fail("Can't open this plan", err.message, err.details ?? []);
      }
      return;
    }
    if (kind === 'dxf') {
      this.stopTour();
      this.start.show(false);
      this.hud.show(false);
      await this.importFlow.open(file);
      return;
    }
    this.fail("Can't open this file", 'Pick a DXF floor plan (or a CAD Tour plan JSON file).');
  }

  /** Builds a plan into the scene, then shows tap to start. Never fails silently. */
  async build(plan: FloorPlan, autostart = false): Promise<void> {
    this.stopTour();
    this.importFlow.hide();
    this.start.show(false);
    this.hud.show(false);
    this.overlay.show(false);
    this.loading.set(0, 'Loading');
    this.loading.show(true);
    try {
      this.session?.dispose();
      this.session = null;
      await this.tour.load(plan, (f, label) => this.loading.set(f, label));
      this.plan = plan;
      this.session = new TourSession(this.tour, plan, this.input, {
        room: (n) => this.hud.setRoom(n),
        floor: (i) => this.hud.setFloor(i),
        mode: (m) => this.hud.setMode(m),
      });
      this.session.paused = true;
      const session = this.session;
      void this.tour.buildRemaining((objects) => session.addFloor(objects));
      this.hud.setPlan(plan);
      this.hud.setFloor(this.session.getState().floor);
      this.hud.setRoom(this.session.roomName);
      if (plan.source?.kind !== 'demo') {
        void saveLastPlan(plan);
        this.lastPlan = plan;
        this.start.setContinue(plan.name);
      }
      this.loading.show(false);
      this.tour.start();
      this.running = true;
      this.overlay.configure(this.layout.info.touch, this.settings.leftHanded);
      if (autostart) this.beginTour();
      else this.overlay.show(true);
    } catch (e) {
      console.error(e);
      this.fail("Couldn't build this plan", (e as Error).message || 'Something went wrong while building the scene.');
    }
  }

  /** Tap or click to start: pointer lock on desktop, wake lock, controls on. */
  private beginTour(): void {
    if (!this.session) return;
    this.overlay.show(false);
    this.hud.show(true);
    this.started = true;
    this.session.paused = false;
    this.km.enabled = true;
    this.touch.enabled = this.layout.info.touch;
    if (!this.layout.info.touch) this.km.requestLock();
    void this.wake.request();
    void this.tour.upgradeHeroTextures();
    this.probeFrames = [];
    this.probeDone = false;
    this.canvas.focus({ preventScroll: true });
  }

  private stopTour(): void {
    this.started = false;
    this.km.enabled = false;
    this.touch.enabled = false;
    this.touch.reset();
    this.input.clear();
    if (this.session) this.session.paused = true;
    this.km.releaseLock();
  }

  private onPointerLock(locked: boolean): void {
    this.pointerLocked = locked;
    if (this.layout.info.touch || !this.started) return;
    if (!locked && !this.menu.open && !this.help.open && this.dialog.root.hidden) {
      // Esc released the mouse. Keep walking with the keys and keep the HUD clickable;
      // a click on the view captures the mouse again.
      this.toast.show('Mouse released. Click the view to look around, press Esc again for the menu.', 3500);
    }
  }

  private setHelp(on: boolean): void {
    this.help.show(on);
    if (this.session) this.session.paused = on || this.menu.open || !this.started;
    if (on) {
      this.input.clear();
      this.touch.reset();
      this.km.releaseLock();
    } else if (this.started && !this.layout.info.touch && !this.menu.open) this.km.requestLock();
  }

  private openMenu(): void {
    this.menu.sync(this.settings, this.plan?.name ?? 'none', !!this.installEvent);
    this.menu.show(true);
    if (this.session) this.session.paused = true;
    this.input.clear();
    this.touch.reset();
    this.km.releaseLock();
  }

  private closeMenu(): void {
    this.menu.show(false);
    if (this.session && this.started) this.session.paused = this.help.open;
    if (this.started && !this.layout.info.touch && !this.help.open) this.km.requestLock();
  }

  private exportJson(): void {
    if (!this.plan) return;
    const blob = new Blob([exportPlanJson(this.plan)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: planFileName(this.plan) });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    this.toast.show('Plan exported as JSON');
  }

  private async install(): Promise<void> {
    if (!this.installEvent) return;
    await this.installEvent.prompt();
    this.installEvent = null;
    this.menu.sync(this.settings, this.plan?.name ?? 'none', false);
  }

  /** Q7: fade out, move to the stair landing on that floor, fade in. */
  private goToFloor(index: number): void {
    if (!this.session) return;
    this.fade.classList.add('on');
    setTimeout(() => {
      this.session?.teleportToFloor(index);
      setTimeout(() => this.fade.classList.remove('on'), 60);
    }, 300);
  }

  // ---- lifecycle --------------------------------------------------------------

  private onResize(info: LayoutInfo): void {
    // Size changes (rotation, fold and unfold) update renderer, camera, post buffers and HUD in
    // place; the player keeps position, facing, floor and mode.
    this.tour.resize(info.width, info.height);
    this.touch.enabled = this.started && info.touch;
  }

  private onVisibility(visible: boolean): void {
    if (!visible) {
      this.tour.stop();
      this.input.clear();
      this.touch.reset();
      return;
    }
    if (this.running && !this.contextLost) this.tour.start();
    void this.wake.reacquire();
  }

  private onContextLost(): void {
    this.contextLost = true;
    this.tour.stop();
    this.savedState = this.session?.getState() ?? null;
    this.toast.show('Graphics were reset by the system. Restoring the view.', 6000);
  }

  private async onContextRestored(): Promise<void> {
    this.contextLost = false;
    await this.tour.restoreContext();
    if (this.savedState && this.session) this.session.setState(this.savedState);
    if (this.running && document.visibilityState === 'visible') this.tour.start();
    this.toast.show('View restored');
  }

  private setupDragAndDrop(): void {
    let depth = 0;
    const html = document.documentElement;
    addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      html.classList.add('drag-active');
      e.preventDefault();
    });
    addEventListener('dragover', (e) => e.preventDefault());
    addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) html.classList.remove('drag-active');
    });
    addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      html.classList.remove('drag-active');
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.openFile(f);
    });
  }

  private frame(dt: number): void {
    this.session?.update(dt);
    if (this.session) {
      const s = this.session.body;
      this.hud.minimap.setPlayer(s.position, s.yaw);
    }
    this.probeFrame(dt);
    if (this.debugEl) {
      const st = this.tour.stats();
      this.debugEl.textContent = `${Math.round(1000 / Math.max(1, st.frameMs))} fps  ${st.frameMs.toFixed(1)} ms\nscale ${st.scale.toFixed(2)}  dpr ${this.tour.pixelRatio.toFixed(2)}\ncalls ${st.calls}  tris ${(st.triangles / 1000).toFixed(0)}k\ntier ${this.tour.config.tier}${this.settings.quality === 'auto' ? ' (auto)' : ''}`;
    }
  }

  /** Test hook for Playwright; only in dev and test builds. */
  private exposeTestHook(): void {
    if (!(import.meta.env.DEV || import.meta.env.MODE === 'test')) return;
    Object.assign(window, {
      __tour: {
        app: this,
        get tour() {
          return (this.app as App).tour;
        },
        get session() {
          return (this.app as App).session;
        },
        getState: () => this.session?.getState() ?? null,
        setState: (s: Partial<PlayerState>) => this.session?.setState(s),
        stats: () => this.tour.stats(),
        layout: () => this.layout.info,
        room: () => this.session?.roomName ?? '',
        tier: () => this.tour.config.tier,
        input: this.input,
        still: (frames = 3) => {
          this.tour.stop();
          for (let i = 0; i < frames; i++) {
            this.session?.update(1 / 30);
            this.tour.renderOnce();
          }
        },
        resume: () => this.tour.start(),
        begin: () => this.beginTour(),
      },
    });
  }
}
