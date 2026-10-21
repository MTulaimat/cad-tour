import type { Settings } from '../app/settings';
import type { TierSetting } from '../render/quality';
import { el, setLabel } from './dom';

const logo = () =>
  el('div', { class: 'brand-mark', 'aria-hidden': 'true' }, [el('span', { class: 'icon icon-home', style: 'width:24px;height:24px' })]);

export interface StartHandlers {
  demo(): void;
  open(file: File): void;
  resume(): void;
}

/** Start screen: demo apartment, open a DXF (picker or drop), or continue the last plan. */
export class StartScreen {
  readonly root: HTMLElement;
  private continueBtn: HTMLButtonElement;
  private continueName: HTMLElement;
  private message: HTMLElement;
  readonly fileInput: HTMLInputElement;

  constructor(h: StartHandlers) {
    this.fileInput = el('input', { type: 'file', accept: '.dxf,.dwg,.json,application/dxf,image/vnd.dxf,application/json', hidden: true, 'data-testid': 'file-input' });
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (f) h.open(f);
    });
    const demo = el('button', { class: 'btn primary', type: 'button', 'data-testid': 'demo-btn' }, [el('span', { class: 'icon icon-home', 'aria-hidden': 'true' }), 'Use demo apartment']);
    demo.addEventListener('click', () => h.demo());
    const open = el('button', { class: 'btn', type: 'button', 'data-testid': 'open-btn' }, [el('span', { class: 'icon icon-file', 'aria-hidden': 'true' }), 'Open plan']);
    open.addEventListener('click', () => this.fileInput.click());
    this.continueName = el('span', { class: 'continue-name' });
    this.continueBtn = el('button', { class: 'btn', type: 'button', hidden: true, 'data-testid': 'continue-btn' }, ['Continue', this.continueName]);
    this.continueBtn.addEventListener('click', () => h.resume());
    this.message = el('div', { class: 'message', hidden: true, role: 'alert', 'data-testid': 'start-message' });
    const drop = el('div', { class: 'dropzone desktop-only' }, ['Or drop a DXF file anywhere on this page.']);
    this.root = el('section', { class: 'screen', 'data-testid': 'start-screen' }, [
      el('div', { class: 'card glass start-card' }, [
        el('div', { class: 'brand' }, [logo(), el('h1', {}, ['CAD Tour'])]),
        el('p', {}, ['Walk through an apartment in 3D, in first or third person. Try the demo, or open your own floor plan as a DXF file.']),
        el('div', { class: 'actions stack' }, [demo, open, this.continueBtn]),
        drop,
        this.message,
        el('p', { class: 'small' }, ['Your plan is read on this device. Nothing is uploaded.']),
        this.fileInput,
      ]),
    ]);
  }

  setContinue(name: string | null): void {
    this.continueBtn.hidden = !name;
    if (name) setLabel(this.continueName, `: ${name}`);
  }

  showMessage(text: string | null, kind: 'error' | 'info' = 'error'): void {
    this.message.hidden = !text;
    this.message.className = `message${kind === 'info' ? ' info' : ''}`;
    this.message.textContent = text ?? '';
  }

  show(on: boolean): void {
    this.root.hidden = !on;
  }
}

/** Loading screen with a progress bar. */
export class LoadingScreen {
  readonly root: HTMLElement;
  private bar: HTMLElement;
  private label: HTMLElement;
  private pct: HTMLElement;

  constructor() {
    this.bar = el('div');
    this.label = el('span', {}, ['Loading']);
    this.pct = el('span', { class: 'small' }, ['0%']);
    this.root = el('section', { class: 'screen', hidden: true, 'data-testid': 'loading-screen', 'aria-busy': 'true' }, [
      el('div', { class: 'card glass' }, [
        el('div', { class: 'brand' }, [logo(), el('h2', {}, ['Preparing your tour'])]),
        el('div', { class: 'row' }, [this.label, this.pct]),
        el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, [this.bar]),
      ]),
    ]);
  }

  set(fraction: number, label: string): void {
    const p = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    this.bar.style.width = `${p}%`;
    this.bar.parentElement!.setAttribute('aria-valuenow', String(p));
    this.label.textContent = label;
    this.pct.textContent = `${p}%`;
  }

  show(on: boolean): void {
    this.root.hidden = !on;
  }
}

/** Tap (or click) to start: needed for pointer lock, fullscreen, audio-free wake lock. */
export class StartOverlay {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private hint: HTMLElement;

  constructor(onStart: () => void) {
    this.title = el('h2', {}, ['Tap to start']);
    this.hint = el('p', {}, ['Left thumb moves, right thumb looks.']);
    const btn = el('button', { class: 'btn primary', type: 'button', 'data-testid': 'start-btn' }, ['Start the tour']);
    this.root = el('section', { class: 'screen over-scene', hidden: true, 'data-testid': 'tap-to-start' }, [
      el('div', { class: 'card glass' }, [this.title, this.hint, el('div', { class: 'actions' }, [btn])]),
    ]);
    this.root.addEventListener('click', () => onStart());
  }

  configure(touch: boolean, leftHanded: boolean, resume = false): void {
    this.title.textContent = resume ? (touch ? 'Tap to continue' : 'Click to continue') : touch ? 'Tap to start' : 'Click to start';
    this.hint.textContent = touch
      ? leftHanded
        ? 'Right thumb moves, left thumb looks.'
        : 'Left thumb moves, right thumb looks.'
      : 'Move with W A S D, look with the mouse, hold Shift to run. Press V for third person, H for help.';
  }

  show(on: boolean): void {
    this.root.hidden = !on;
  }
}

/** Help overlay (H). */
export class HelpOverlay {
  readonly root: HTMLElement;

  constructor(onClose: () => void) {
    const close = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close help', 'data-testid': 'help-close' }, [el('span', { class: 'icon icon-close', 'aria-hidden': 'true' })]);
    close.addEventListener('click', onClose);
    const row = (k: string, v: string) => [el('kbd', {}, [k]), el('span', {}, [v])];
    this.root = el('div', { class: 'overlay', hidden: true, 'data-testid': 'help', role: 'dialog', 'aria-label': 'Help' }, [
      el('div', { class: 'sheet glass' }, [
        el('div', { class: 'sheet-head' }, [el('h2', {}, ['Controls']), close]),
        el('h3', { class: 'desktop-only' }, ['Keyboard and mouse']),
        el('div', { class: 'help-grid desktop-only' }, [
          ...row('W A S D', 'Move (arrow keys work too)'),
          ...row('Mouse', 'Look around (click the view to capture the mouse)'),
          ...row('Shift', 'Run'),
          ...row('V', 'Switch between first and third person'),
          ...row('M', 'Show or hide the map'),
          ...row('H', 'Show or hide this help'),
          ...row('Esc', 'Release the mouse, then open the menu'),
        ]),
        el('h3', {}, ['Touch']),
        el('div', { class: 'help-grid' }, [
          ...row('Left half', 'Drag to move. The joystick appears under your thumb.'),
          ...row('Right half', 'Drag to look around.'),
          ...row('Run', 'Tap the runner button, or push the joystick all the way.'),
          ...row('Eye or figure', 'Switch between first and third person.'),
          ...row('L1 L2', 'Jump to the stair landing on that floor.'),
        ]),
        el('p', { class: 'small' }, ['Doors open as you walk up to them. Use the menu to open your own DXF plan, change quality, or switch to a left-handed layout.']),
      ]),
    ]);
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) onClose();
    });
  }

  show(on: boolean): void {
    this.root.hidden = !on;
  }

  get open(): boolean {
    return !this.root.hidden;
  }
}

export interface MenuHandlers {
  close(): void;
  openPlan(): void;
  demo(): void;
  exportJson(): void;
  importJson(file: File): void;
  setQuality(q: TierSetting): void;
  setRenderScale(v: number | null): void;
  setSensitivity(v: number): void;
  setInvertY(v: boolean): void;
  setLeftHanded(v: boolean): void;
  setMinimap(v: boolean): void;
  install(): void;
}

function switchCtl(label: string, testid: string, onChange: (v: boolean) => void): { row: HTMLElement; set(v: boolean): void } {
  const id = `sw-${testid}`;
  const b = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', id, 'data-testid': testid, 'aria-label': label });
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(v));
    onChange(v);
  });
  return {
    row: el('div', { class: 'row' }, [el('label', { for: id }, [label]), el('div', { class: 'switch-wrap' }, [b])]),
    set: (v) => b.setAttribute('aria-checked', String(v)),
  };
}

/** Menu and settings sheet. */
export class MenuSheet {
  readonly root: HTMLElement;
  private qualityButtons = new Map<TierSetting, HTMLButtonElement>();
  private scale: HTMLInputElement;
  private scaleAuto: { row: HTMLElement; set(v: boolean): void };
  private sens: HTMLInputElement;
  private invert: { row: HTMLElement; set(v: boolean): void };
  private lefty: { row: HTMLElement; set(v: boolean): void };
  private map: { row: HTMLElement; set(v: boolean): void };
  private installBtn: HTMLButtonElement;
  private planName: HTMLElement;
  readonly jsonInput: HTMLInputElement;

  constructor(h: MenuHandlers) {
    const close = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close menu', 'data-testid': 'menu-close' }, [el('span', { class: 'icon icon-close', 'aria-hidden': 'true' })]);
    close.addEventListener('click', () => h.close());
    this.planName = el('p', { class: 'small', 'data-testid': 'menu-plan-name' });
    this.jsonInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    this.jsonInput.addEventListener('change', () => {
      const f = this.jsonInput.files?.[0];
      this.jsonInput.value = '';
      if (f) h.importJson(f);
    });
    const btn = (label: string, testid: string, fn: () => void, icon?: string) => {
      const b = el('button', { class: 'btn', type: 'button', 'data-testid': testid }, [...(icon ? [el('span', { class: `icon ${icon}`, 'aria-hidden': 'true' })] : []), label]);
      b.addEventListener('click', fn);
      return b;
    };
    const quality = el('div', { class: 'seg glass', role: 'group', 'aria-label': 'Quality' });
    for (const [q, label] of [
      ['auto', 'Auto'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ] as [TierSetting, string][]) {
      const b = el('button', { type: 'button', 'data-testid': `quality-${q}` }, [label]);
      b.addEventListener('click', () => h.setQuality(q));
      this.qualityButtons.set(q, b);
      quality.appendChild(b);
    }
    this.scale = el('input', { type: 'range', min: 0.5, max: 1, step: 0.05, value: 1, 'aria-label': 'Render scale', id: 'render-scale' });
    this.scale.addEventListener('input', () => h.setRenderScale(Number(this.scale.value)));
    this.scaleAuto = switchCtl('Adjust resolution automatically', 'scale-auto', (v) => h.setRenderScale(v ? null : Number(this.scale.value)));
    this.sens = el('input', { type: 'range', min: 0.0008, max: 0.0055, step: 0.0001, 'aria-label': 'Look sensitivity', id: 'look-sens' });
    this.sens.addEventListener('input', () => h.setSensitivity(Number(this.sens.value)));
    this.invert = switchCtl('Invert look up and down', 'invert-y', (v) => h.setInvertY(v));
    this.lefty = switchCtl('Left-handed layout', 'left-handed', (v) => h.setLeftHanded(v));
    this.map = switchCtl('Show the map', 'show-map', (v) => h.setMinimap(v));
    this.installBtn = btn('Install as an app', 'install-btn', () => h.install());
    this.installBtn.hidden = true;

    this.root = el('div', { class: 'overlay', hidden: true, 'data-testid': 'menu', role: 'dialog', 'aria-label': 'Menu' }, [
      el('div', { class: 'sheet glass' }, [
        el('div', { class: 'sheet-head' }, [el('h2', {}, ['Menu']), close]),
        el('h3', {}, ['Plan']),
        this.planName,
        el('div', { class: 'actions' }, [
          btn('Open plan', 'menu-open', () => h.openPlan(), 'icon-file'),
          btn('Use demo apartment', 'menu-demo', () => h.demo(), 'icon-home'),
          btn('Export plan JSON', 'menu-export', () => h.exportJson()),
          btn('Import plan JSON', 'menu-import', () => this.jsonInput.click()),
        ]),
        el('h3', {}, ['Display']),
        el('div', { class: 'row' }, [el('span', {}, ['Quality']), quality]),
        this.scaleAuto.row,
        el('div', { class: 'row' }, [el('label', { for: 'render-scale' }, ['Render scale']), this.scale]),
        this.map.row,
        el('h3', {}, ['Controls']),
        el('div', { class: 'row' }, [el('label', { for: 'look-sens' }, ['Look sensitivity']), this.sens]),
        this.invert.row,
        this.lefty.row,
        this.installBtn,
        el('p', { class: 'small' }, ['Textures and the sky are CC0 from Poly Haven. See CREDITS.md in the project repository.']),
        this.jsonInput,
      ]),
    ]);
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) h.close();
    });
  }

  sync(s: Settings, planName: string, canInstall: boolean): void {
    for (const [q, b] of this.qualityButtons) {
      b.classList.toggle('active', q === s.quality);
      b.setAttribute('aria-pressed', String(q === s.quality));
    }
    this.scaleAuto.set(s.renderScale === null);
    this.scale.disabled = s.renderScale === null;
    if (s.renderScale !== null) this.scale.value = String(s.renderScale);
    this.sens.value = String(s.sensitivity);
    this.invert.set(s.invertY);
    this.lefty.set(s.leftHanded);
    this.map.set(s.minimap);
    setLabel(this.planName, `Current plan: ${planName}`);
    this.installBtn.hidden = !canInstall;
  }

  show(on: boolean): void {
    this.root.hidden = !on;
  }

  get open(): boolean {
    return !this.root.hidden;
  }
}

/** A message with actions, for failures and confirmations ("never fail silently"). */
export class MessageDialog {
  readonly root: HTMLElement;
  private title: HTMLElement;
  private body: HTMLElement;
  private details: HTMLElement;
  private actions: HTMLElement;

  constructor() {
    this.title = el('h2');
    this.body = el('p', { 'data-testid': 'dialog-body' });
    this.details = el('pre', { class: 'small', style: 'white-space:pre-wrap;margin:0;max-height:10rem;overflow:auto;user-select:text' });
    this.actions = el('div', { class: 'actions' });
    this.root = el('div', { class: 'overlay', hidden: true, role: 'alertdialog', 'data-testid': 'dialog' }, [el('div', { class: 'sheet glass' }, [this.title, this.body, this.details, this.actions])]);
  }

  show(title: string, body: string, actions: { label: string; primary?: boolean; run: () => void }[], details: string[] = []): void {
    this.title.textContent = title;
    this.body.textContent = body;
    this.details.textContent = details.slice(0, 12).join('\n');
    this.details.hidden = details.length === 0;
    this.actions.replaceChildren(
      ...actions.map((a) => {
        const b = el('button', { class: `btn${a.primary ? ' primary' : ''}`, type: 'button' }, [a.label]);
        b.addEventListener('click', () => {
          this.hide();
          a.run();
        });
        return b;
      }),
    );
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }
}

export class Toast {
  readonly root = el('div', { class: 'toast glass', role: 'status', 'aria-live': 'polite', 'data-testid': 'toast' });
  private timer = 0;

  show(text: string, ms = 2600): void {
    this.root.textContent = text;
    this.root.classList.add('on');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.root.classList.remove('on'), ms);
  }
}
