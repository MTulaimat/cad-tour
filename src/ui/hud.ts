import type { FloorPlan } from '../data/schema';
import type { TierSetting } from '../render/quality';
import { el, setLabel } from './dom';
import { Minimap } from './minimap';

export interface HudHandlers {
  toggleMode(): void;
  toggleRun(): void;
  openMenu(): void;
  openHelp(): void;
  toggleFullscreen(): void;
  cycleQuality(): void;
  goToFloor(index: number): void;
}

const QUALITY_LABEL: Record<TierSetting, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' };

/**
 * The in-tour HUD: room label with floor name (top center), minimap (top left), menu, help,
 * fullscreen and quality (top right), and the thumb clusters in the bottom corners: mode and run
 * on one side, floor switch on the other. Every control is at least 48 px.
 */
export class Hud {
  readonly root: HTMLElement;
  readonly minimap: Minimap;
  private roomEl: HTMLElement;
  private floorEl: HTMLElement;
  private label: HTMLElement;
  private modeBtn: HTMLButtonElement;
  private runBtn: HTMLButtonElement;
  private fullBtn: HTMLButtonElement;
  private qualityChip: HTMLButtonElement;
  private floorSeg: HTMLElement;
  private floorButtons: HTMLButtonElement[] = [];
  private hints: HTMLElement[];
  private plan: FloorPlan | null = null;

  constructor(private h: HudHandlers) {
    this.minimap = new Minimap((i) => h.goToFloor(i));
    // dir=auto: imported Arabic room names read right to left.
    this.roomEl = el('span', { class: 'room', 'data-testid': 'room-name', dir: 'auto' });
    this.floorEl = el('span', { class: 'floor', 'data-testid': 'floor-name' });
    this.label = el('div', { class: 'room-label glass', role: 'status', 'aria-live': 'polite' }, [this.roomEl, this.floorEl]);

    const iconBtn = (icon: string, label: string, testid: string, extra = '') => {
      const b = el('button', { class: `icon-btn ${extra}`, type: 'button', 'aria-label': label, title: label, 'data-testid': testid }, [el('span', { class: `icon ${icon}`, 'aria-hidden': 'true' })]);
      return b;
    };
    const menuBtn = iconBtn('icon-menu', 'Menu', 'menu-btn');
    menuBtn.addEventListener('click', () => h.openMenu());
    const helpBtn = iconBtn('icon-help', 'Help (H)', 'help-btn');
    helpBtn.addEventListener('click', () => h.openHelp());
    this.fullBtn = iconBtn('icon-full', 'Fullscreen', 'fullscreen-btn');
    this.fullBtn.addEventListener('click', () => h.toggleFullscreen());
    this.qualityChip = el('button', { class: 'chip glass quality desktop-only', type: 'button', title: 'Quality', 'data-testid': 'quality-chip' }, ['Auto']);
    this.qualityChip.addEventListener('click', () => h.cycleQuality());

    this.modeBtn = iconBtn('icon-person', 'Switch to third person (V)', 'mode-btn', 'big');
    this.modeBtn.addEventListener('click', () => h.toggleMode());
    this.runBtn = iconBtn('icon-run', 'Run', 'run-btn', 'touch-only');
    this.runBtn.setAttribute('aria-pressed', 'false');
    this.runBtn.addEventListener('click', () => h.toggleRun());

    this.floorSeg = el('div', { class: 'seg glass touch-only', role: 'group', 'aria-label': 'Floor', 'data-testid': 'floor-switch' });

    const left = el('div', { class: 'touch-hint left touch-only', 'aria-hidden': 'true' }, ['Drag here to move']);
    const right = el('div', { class: 'touch-hint right touch-only', 'aria-hidden': 'true' }, ['Drag here to look']);
    this.hints = [left, right];

    this.root = el('div', { class: 'hud', 'data-testid': 'hud', hidden: true }, [
      this.label,
      this.minimap.root,
      el('div', { class: 'corner tr' }, [this.qualityChip, helpBtn, this.fullBtn, menuBtn]),
      el('div', { class: 'corner br', 'data-testid': 'cluster-primary' }, [this.modeBtn, this.runBtn]),
      el('div', { class: 'corner bl', 'data-testid': 'cluster-secondary' }, [this.floorSeg]),
      left,
      right,
    ]);
  }

  setPlan(plan: FloorPlan): void {
    this.plan = plan;
    this.minimap.setPlan(plan);
    this.floorSeg.replaceChildren();
    this.floorButtons = [];
    const order = plan.floors.map((f, i) => ({ f, i })).sort((a, b) => a.f.elevation - b.f.elevation);
    order.forEach(({ f, i }, rank) => {
      const b = el('button', { type: 'button', 'aria-label': `Go to ${f.name}`, title: f.name }, [`L${rank + 1}`]);
      b.addEventListener('click', () => this.h.goToFloor(i));
      this.floorButtons[i] = b;
      this.floorSeg.appendChild(b);
    });
    this.floorSeg.hidden = plan.floors.length < 2;
  }

  setRoom(name: string): void {
    setLabel(this.roomEl, name || 'Exploring');
    this.label.classList.remove('flash');
    void this.label.offsetWidth;
    this.label.classList.add('flash');
  }

  setFloor(index: number): void {
    if (!this.plan) return;
    const f = this.plan.floors[index];
    setLabel(this.floorEl, f ? f.name : '');
    this.minimap.setFloor(index);
    this.floorButtons.forEach((b, i) => {
      b.classList.toggle('active', i === index);
      b.setAttribute('aria-pressed', String(i === index));
    });
  }

  setMode(mode: 'first' | 'third'): void {
    const icon = this.modeBtn.querySelector('.icon')!;
    icon.className = `icon ${mode === 'first' ? 'icon-person' : 'icon-eye'}`;
    const label = mode === 'first' ? 'Switch to third person (V)' : 'Switch to first person (V)';
    this.modeBtn.setAttribute('aria-label', label);
    this.modeBtn.title = label;
  }

  setRun(on: boolean): void {
    this.runBtn.classList.toggle('on', on);
    this.runBtn.setAttribute('aria-pressed', String(on));
  }

  setFullscreen(on: boolean, supported: boolean): void {
    this.fullBtn.hidden = !supported;
    const icon = this.fullBtn.querySelector('.icon')!;
    icon.className = `icon ${on ? 'icon-full-exit' : 'icon-full'}`;
    this.fullBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
  }

  setQuality(setting: TierSetting, active: string): void {
    this.qualityChip.textContent = setting === 'auto' ? `Auto (${active})` : QUALITY_LABEL[setting];
  }

  hideHints(): void {
    for (const h of this.hints) h.style.opacity = '0';
  }

  setLeftHanded(on: boolean): void {
    this.hints[0].textContent = on ? 'Drag here to look' : 'Drag here to move';
    this.hints[1].textContent = on ? 'Drag here to move' : 'Drag here to look';
  }

  show(on: boolean): void {
    this.root.hidden = !on;
  }
}
