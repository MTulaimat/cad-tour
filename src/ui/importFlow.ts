import type { FloorMaterialKey, FloorPlan, StairFinish } from '../data/schema';
import { FLOOR_MATERIALS } from '../data/schema';
import { DxfImportSession, DEFAULT_SETTINGS, ROLES, ROOM_KINDS, type BuildRequest, type FloorAssignment, type FloorBox, type ImportReport, type ImportSettings, type LayerRole, type RoomKind } from '../data/dxf';
import { loadMapping, saveMapping } from '../data/dxf/layers';
import { UNIT_LABEL, UNIT_SCALE, formatSpan, type UnitKey } from '../data/dxf/units';
import { el, hasArabic, setLabel } from './dom';

export interface ImportHandlers {
  build(plan: FloorPlan): void;
  demo(): void;
  cancel(): void;
  message(title: string, body: string, details?: string[]): void;
}

const ROLE_COLOR: Record<LayerRole, string> = {
  walls: '#20242a',
  doors: '#2f9e57',
  windows: '#2f7fd6',
  stairs: '#e08a1e',
  furniture: '#8a8f96',
  rooms: '#9b59b6',
  ignore: 'rgba(120, 125, 130, 0.25)',
};

const MATERIAL_LABEL: Record<FloorMaterialKey, string> = { oak: 'Oak', tile: 'Tile', concrete: 'Concrete' };

const countText = (c: Record<string, number>) => {
  const parts: string[] = [];
  const name: Record<string, string> = { LINE: 'lines', LWPOLYLINE: 'polylines', POLYLINE: 'polylines', ARC: 'arcs', CIRCLE: 'circles', INSERT: 'blocks', TEXT: 'texts', MTEXT: 'texts', HATCH: 'hatches' };
  const merged = new Map<string, number>();
  for (const [k, v] of Object.entries(c)) merged.set(name[k] ?? k.toLowerCase(), (merged.get(name[k] ?? k.toLowerCase()) ?? 0) + v);
  for (const [k, v] of merged) parts.push(`${v} ${k}`);
  return parts.join(', ') || 'empty';
};

/**
 * DXF import flow, all on the device: reading (in a worker), units if needed, layer mapping with a
 * 2D preview and floor assignment, then the validation report with settings and room edits.
 * Any failure shows the reason and offers the demo apartment.
 */
export class ImportFlow {
  readonly root: HTMLElement;
  private card: HTMLElement;
  private session: DxfImportSession | null = null;
  private roles: Record<string, LayerRole> = {};
  private hidden = new Set<string>();
  private floors: FloorAssignment = { mode: 'single' };
  private settings: ImportSettings = { ...DEFAULT_SETTINGS, units: 'mm' };
  private roomEdits: Record<string, { name?: string; floorMaterial?: FloorMaterialKey; kind?: RoomKind }> = {};
  private lastPlan: FloorPlan | null = null;
  private fileName = '';

  constructor(private h: ImportHandlers) {
    this.card = el('div', { class: 'card glass wide import-card' });
    this.root = el('section', { class: 'screen import', hidden: true, 'data-testid': 'import-flow' }, [this.card]);
  }

  hide(): void {
    this.root.hidden = true;
  }

  private show(...children: (Node | string)[]): void {
    this.card.replaceChildren(...children);
    this.root.hidden = false;
    this.root.scrollTop = 0;
  }

  private fail(title: string, e: unknown): void {
    const err = e as Error & { details?: string[] };
    this.hide();
    this.h.message(title, err.message || String(e), err.details ?? []);
  }

  async open(file: File): Promise<void> {
    this.session?.dispose();
    this.session = null;
    this.fileName = file.name;
    this.roomEdits = {};
    const bar = el('div');
    const label = el('span', {}, ['Reading the drawing']);
    this.show(
      el('h2', {}, ['Opening ', file.name]),
      el('p', {}, ['The file is read on this device. Nothing is uploaded.']),
      el('div', { class: 'row' }, [label]),
      el('div', { class: 'progress', role: 'progressbar' }, [bar]),
    );
    try {
      this.session = await DxfImportSession.open(file, {
        onProgress: (f, l) => {
          bar.style.width = `${Math.round(f * 100)}%`;
          label.textContent = l;
        },
      });
    } catch (e) {
      this.fail("Can't read this DXF", e);
      return;
    }
    const s = this.session.summary;
    this.roles = { ...s.roles };
    this.floors = s.floors;
    this.hidden = new Set(s.layers.filter((l) => l.frozen).map((l) => l.name));
    this.settings = { ...DEFAULT_SETTINGS, units: s.units.units };
    const saved = loadMapping(this.session.hash);
    if (saved) {
      Object.assign(this.roles, saved.roles);
      this.hidden = new Set(saved.hidden);
      this.floors = saved.floors;
      if (saved.units && saved.units in UNIT_SCALE) this.settings.units = saved.units as UnitKey;
      if (saved.settings) Object.assign(this.settings, saved.settings);
    }
    if (s.units.ask && !saved) this.unitsStep();
    else this.layersStep();
  }

  // ---- units ------------------------------------------------------------------------------------

  private unitsStep(): void {
    const s = this.session!.summary;
    const w = s.bounds.maxX - s.bounds.minX;
    const d = s.bounds.maxY - s.bounds.minY;
    const preview = el('p', { class: 'unit-preview', 'data-testid': 'unit-preview' });
    const seg = el('div', { class: 'seg glass unit-seg', role: 'radiogroup', 'aria-label': 'Units' });
    const update = () => {
      const k = UNIT_SCALE[this.settings.units];
      preview.textContent = `In ${UNIT_LABEL[this.settings.units].toLowerCase()} the plan is ${formatSpan(w * k)} by ${formatSpan(d * k)}.`;
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.unit === this.settings.units);
    };
    for (const u of Object.keys(UNIT_SCALE) as UnitKey[]) {
      const k = UNIT_SCALE[u];
      const b = el('button', { type: 'button', 'data-unit': u, role: 'radio', title: `${formatSpan(w * k)} by ${formatSpan(d * k)}` }, [UNIT_LABEL[u]]);
      b.addEventListener('click', () => {
        this.settings.units = u;
        update();
      });
      seg.appendChild(b);
    }
    const sizes = el(
      'ul',
      { class: 'unit-sizes small' },
      (Object.keys(UNIT_SCALE) as UnitKey[]).map((u) => el('li', {}, [`${UNIT_LABEL[u]}: ${formatSpan(w * UNIT_SCALE[u])} by ${formatSpan(d * UNIT_SCALE[u])}`])),
    );
    const next = el('button', { class: 'btn primary', type: 'button', 'data-testid': 'units-continue' }, ['Continue']);
    next.addEventListener('click', () => this.layersStep());
    const cancel = el('button', { class: 'btn', type: 'button' }, ['Cancel']);
    cancel.addEventListener('click', () => this.cancel());
    this.show(
      el('h2', {}, ['Which units is this drawing in?']),
      el('p', {}, [s.units.reason ?? '', ' Pick the unit that gives the right size.']),
      seg,
      preview,
      sizes,
      el('div', { class: 'actions' }, [next, cancel]),
    );
    update();
  }

  // ---- layers -------------------------------------------------------------------------------------

  private layersStep(): void {
    const s = this.session!.summary;
    const canvas = el('canvas', { class: 'plan-preview', 'aria-label': 'Preview of the drawing, coloured by layer role', 'data-testid': 'plan-preview' });
    const redraw = () => this.drawPreview(canvas);
    const list = el('div', { class: 'layer-list', role: 'list' });
    for (const layer of s.layers) {
      if (layer.total === 0 && !s.roles[layer.name]) continue;
      const id = `layer-${btoa(unescape(encodeURIComponent(layer.name))).replace(/=/g, '')}`;
      const toggle = el('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(!this.hidden.has(layer.name)), 'aria-label': `Show ${layer.name}` });
      toggle.addEventListener('click', () => {
        const on = this.hidden.has(layer.name);
        if (on) this.hidden.delete(layer.name);
        else this.hidden.add(layer.name);
        toggle.setAttribute('aria-checked', String(on));
        redraw();
      });
      const select = el('select', { id, 'aria-label': `Role of layer ${layer.name}`, 'data-layer': layer.name });
      for (const r of ROLES) select.appendChild(el('option', { value: r.key, selected: this.roles[layer.name] === r.key }, [r.label]));
      select.value = this.roles[layer.name] ?? 'ignore';
      select.addEventListener('change', () => {
        this.roles[layer.name] = select.value as LayerRole;
        swatch.style.background = ROLE_COLOR[this.roles[layer.name]];
        redraw();
      });
      const swatch = el('span', { class: 'swatch', 'aria-hidden': 'true' });
      swatch.style.background = ROLE_COLOR[this.roles[layer.name] ?? 'ignore'];
      const name = el('span', { class: 'layer-name' });
      setLabel(name, layer.name);
      const sample = layer.samples.length ? el('span', { class: 'small layer-sample' }, [`Text: ${layer.samples.slice(0, 2).join(', ')}`]) : null;
      if (sample && hasArabic(sample.textContent ?? '')) sample.dir = 'auto';
      list.appendChild(
        el('div', { class: 'layer-row', role: 'listitem' }, [
          el('div', { class: 'switch-wrap' }, [toggle]),
          el('div', { class: 'layer-info' }, [el('div', { class: 'layer-title' }, [swatch, name]), el('span', { class: 'small' }, [countText(layer.counts)]), ...(sample ? [sample] : [])]),
          select,
        ]),
      );
    }

    // Floor assignment.
    const modeSeg = el('div', { class: 'seg glass', role: 'radiogroup', 'aria-label': 'Floors' });
    const prefixInput = el('input', { type: 'text', class: 'text-input', 'aria-label': 'Layer prefixes, lowest floor first', placeholder: 'L1_, L2_' });
    prefixInput.value = (this.floors.prefixes ?? []).join(', ');
    prefixInput.addEventListener('input', () => {
      this.floors = { mode: 'prefix', prefixes: prefixInput.value.split(/[,\s]+/).filter(Boolean) };
    });
    const boxHint = el('p', { class: 'small' }, ['Drag on the preview to draw a box around each floor, lowest floor first.']);
    const clearBoxes = el('button', { class: 'btn', type: 'button' }, ['Clear boxes']);
    clearBoxes.addEventListener('click', () => {
      this.floors = { mode: 'boxes', boxes: [] };
      redraw();
    });
    const modeExtra = el('div', { class: 'floor-extra' });
    const setMode = (m: FloorAssignment['mode']) => {
      // Showing the mode already chosen keeps it as it is (boxes found automatically stay marked so).
      if (m !== this.floors.mode) {
        if (m === 'single') this.floors = { mode: 'single' };
        if (m === 'prefix') this.floors = { mode: 'prefix', prefixes: this.floors.prefixes ?? s.floors.prefixes ?? ['L1_', 'L2_'] };
        if (m === 'boxes') this.floors = { mode: 'boxes', boxes: this.floors.boxes ?? [] };
      }
      prefixInput.value = (this.floors.prefixes ?? []).join(', ');
      modeExtra.replaceChildren(...(m === 'prefix' ? [prefixInput] : m === 'boxes' ? [boxHint, clearBoxes] : []));
      for (const b of modeSeg.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === m);
      canvas.classList.toggle('drawing', m === 'boxes');
      redraw();
    };
    for (const [m, label] of [
      ['single', 'One floor'],
      ['prefix', 'By layer prefix'],
      ['boxes', 'Draw boxes'],
    ] as [FloorAssignment['mode'], string][]) {
      const b = el('button', { type: 'button', 'data-mode': m }, [label]);
      b.addEventListener('click', () => setMode(m));
      modeSeg.appendChild(b);
    }
    this.enableBoxDrawing(canvas, redraw);

    const next = el('button', { class: 'btn primary', type: 'button', 'data-testid': 'layers-continue' }, ['Continue']);
    next.addEventListener('click', () => void this.buildAndReport());
    const back = el('button', { class: 'btn', type: 'button' }, ['Units']);
    back.addEventListener('click', () => this.unitsStep());
    const cancel = el('button', { class: 'btn ghost', type: 'button' }, ['Cancel']);
    cancel.addEventListener('click', () => this.cancel());
    const found = this.floors.mode === 'boxes' && this.floors.auto ? `Found ${(this.floors.boxes ?? []).length} plans drawn side by side. Each is a floor with its own box, lowest floor first; draw the boxes again if that is wrong.` : '';
    const notes = [...s.warnings, found].filter(Boolean);
    const info = notes.length ? el('div', { class: 'message info', 'data-testid': 'layers-note' }, [notes.join(' ')]) : null;
    this.show(
      el('h2', {}, ['Map the layers']),
      el('p', {}, ['Each layer was given a role from its name. Change any that are wrong, and switch off layers to leave them out.']),
      ...(info ? [info] : []),
      el('div', { class: 'map-grid' }, [list, el('div', { class: 'preview-col' }, [canvas, el('h3', {}, ['Floors']), modeSeg, modeExtra])]),
      el('div', { class: 'actions' }, [next, back, cancel]),
    );
    setMode(this.floors.mode);
    new ResizeObserver(redraw).observe(canvas);
  }

  private view: { minX: number; maxY: number; s: number; ox: number; oy: number } | null = null;

  private drawPreview(canvas: HTMLCanvasElement): void {
    const s = this.session!;
    const r = canvas.getBoundingClientRect();
    if (r.width < 2) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#f3f1ec';
    g.fillRect(0, 0, canvas.width, canvas.height);
    const b = s.summary.bounds;
    const pad = 12 * dpr;
    const sc = Math.min((canvas.width - pad * 2) / Math.max(1e-9, b.maxX - b.minX), (canvas.height - pad * 2) / Math.max(1e-9, b.maxY - b.minY));
    const ox = pad + (canvas.width - pad * 2 - (b.maxX - b.minX) * sc) / 2;
    const oy = pad + (canvas.height - pad * 2 - (b.maxY - b.minY) * sc) / 2;
    this.view = { minX: b.minX, maxY: b.maxY, s: sc / dpr, ox: ox / dpr, oy: oy / dpr };
    const { segs, layer, layerNames } = s.preview;
    const byRole = new Map<string, Path2D>();
    for (let i = 0; i < layer.length; i++) {
      const name = layerNames[layer[i]];
      const role: LayerRole = this.hidden.has(name) ? 'ignore' : (this.roles[name] ?? 'ignore');
      let path = byRole.get(role);
      if (!path) {
        path = new Path2D();
        byRole.set(role, path);
      }
      path.moveTo(ox + (segs[i * 4] - b.minX) * sc, oy + (b.maxY - segs[i * 4 + 1]) * sc);
      path.lineTo(ox + (segs[i * 4 + 2] - b.minX) * sc, oy + (b.maxY - segs[i * 4 + 3]) * sc);
    }
    g.lineWidth = Math.max(1, dpr);
    for (const role of ['ignore', 'rooms', 'furniture', 'stairs', 'windows', 'doors', 'walls'] as LayerRole[]) {
      const p = byRole.get(role);
      if (!p) continue;
      g.strokeStyle = ROLE_COLOR[role];
      g.stroke(p);
    }
    // Floor boxes.
    if (this.floors.mode === 'boxes') {
      (this.floors.boxes ?? []).forEach((bx, i) => {
        const x0 = ox + (Math.min(bx.minX, bx.maxX) - b.minX) * sc;
        const y0 = oy + (b.maxY - Math.max(bx.minY, bx.maxY)) * sc;
        const w = Math.abs(bx.maxX - bx.minX) * sc;
        const h = Math.abs(bx.maxY - bx.minY) * sc;
        g.strokeStyle = '#ffb547';
        g.lineWidth = 2 * dpr;
        g.setLineDash([6 * dpr, 4 * dpr]);
        g.strokeRect(x0, y0, w, h);
        g.setLineDash([]);
        g.fillStyle = '#1b1d21';
        g.font = `700 ${14 * dpr}px Inter, system-ui, sans-serif`;
        g.fillText(`Floor ${i + 1}`, x0 + 6 * dpr, y0 + 18 * dpr);
      });
    }
  }

  private enableBoxDrawing(canvas: HTMLCanvasElement, redraw: () => void): void {
    let start: { x: number; y: number } | null = null;
    const toDrawing = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const v = this.view!;
      return { x: v.minX + (e.clientX - r.left - v.ox) / v.s, y: v.maxY - (e.clientY - r.top - v.oy) / v.s };
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (this.floors.mode !== 'boxes' || !this.view) return;
      start = toDrawing(e);
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!start || this.floors.mode !== 'boxes') return;
      const p = toDrawing(e);
      const boxes = (this.floors.boxes ?? []).slice();
      const live: FloorBox = { minX: start.x, minY: start.y, maxX: p.x, maxY: p.y };
      this.floors = { mode: 'boxes', boxes: [...boxes.filter((b) => !(b as FloorBox & { live?: boolean }).live), Object.assign(live, { live: true })] };
      redraw();
    });
    const end = () => {
      if (!start) return;
      start = null;
      this.floors = { mode: 'boxes', boxes: (this.floors.boxes ?? []).map((b) => ({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY })).filter((b) => Math.abs(b.maxX - b.minX) > 0 && Math.abs(b.maxY - b.minY) > 0) };
      redraw();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  // ---- build and report ---------------------------------------------------------------------------

  private request(): BuildRequest {
    return {
      roles: this.roles,
      hidden: [...this.hidden],
      floors: this.floors,
      settings: this.settings,
      roomEdits: this.roomEdits,
      fileName: this.fileName,
    };
  }

  private async buildAndReport(): Promise<void> {
    const s = this.session!;
    if (this.floors.mode === 'boxes' && (this.floors.boxes ?? []).length === 0) this.floors = { mode: 'single' };
    saveMapping(s.hash, { roles: this.roles, hidden: [...this.hidden], floors: this.floors, units: this.settings.units, settings: { ...this.settings, units: undefined } as unknown as Record<string, number> });
    this.show(el('h2', {}, ['Building the plan']), el('p', {}, ['Finding walls, openings, rooms and stairs.']), el('div', { class: 'progress' }, [el('div', { style: 'width:60%' })]));
    try {
      const { plan, report } = await s.build(this.request());
      this.lastPlan = plan;
      this.reportStep(plan, report);
    } catch (e) {
      this.fail("Couldn't build a plan from this DXF", e);
    }
  }

  private reportStep(plan: FloorPlan, report: ImportReport): void {
    const stat = (label: string, value: string, testid: string) => el('div', { class: 'stat' }, [el('div', { class: 'stat-value', 'data-testid': testid }, [value]), el('div', { class: 'small' }, [label])]);
    const stats = el('div', { class: 'stats' }, [
      stat('Floors', String(report.floors), 'stat-floors'),
      stat('Rooms', String(report.rooms), 'stat-rooms'),
      stat('Walls', String(report.walls), 'stat-walls'),
      stat('Doors', String(report.doors), 'stat-doors'),
      stat('Windows', String(report.windows), 'stat-windows'),
      stat('Stairs', String(report.stairs), 'stat-stairs'),
      stat('Total area', `${report.totalArea.toFixed(1)} m2`, 'stat-area'),
    ]);
    const warnings = report.warnings.length
      ? el(
          'ul',
          { class: 'warnings', 'data-testid': 'import-warnings' },
          report.warnings.map((w) => {
            const li = el('li', {}, [w.message]);
            if (hasArabic(w.message)) li.dir = 'auto';
            return li;
          }),
        )
      : el('p', { class: 'small' }, ['No warnings.']);

    // Settings (Q12): wall thickness, ceiling height, units, tolerance, plus floor height and openings.
    const num = (label: string, key: keyof ImportSettings, step: number, min: number, max: number) => {
      const id = `set-${key}`;
      // The upper floor's ceiling follows the ceiling height until it is set on its own.
      const value = () => String(this.settings[key] ?? this.settings.ceilingHeight);
      const input = el('input', { type: 'number', id, step, min, max, class: 'text-input num', value: value() });
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v >= min && v <= max) (this.settings as unknown as Record<string, number>)[key] = v;
        else input.value = value();
      });
      return el('div', { class: 'row' }, [el('label', { for: id }, [label]), input]);
    };
    const units = el('select', { id: 'set-units', 'aria-label': 'Drawing units' });
    for (const u of Object.keys(UNIT_SCALE) as UnitKey[]) units.appendChild(el('option', { value: u, selected: u === this.settings.units }, [UNIT_LABEL[u]]));
    units.value = this.settings.units;
    units.addEventListener('change', () => (this.settings.units = units.value as UnitKey));
    const finish = el('select', { id: 'set-stairFinish', 'aria-label': 'Stair finish' });
    for (const [k, label] of [
      ['oak', 'Oak'],
      ['black-steel', 'Black steel'],
    ] as [StairFinish, string][])
      finish.appendChild(el('option', { value: k, selected: k === (this.settings.stairFinish ?? 'oak') }, [label]));
    finish.value = this.settings.stairFinish ?? 'oak';
    finish.addEventListener('change', () => (this.settings.stairFinish = finish.value as StairFinish));
    const finishRow = el('div', { class: 'row' }, [el('label', { for: 'set-stairFinish' }, ['Stair and railings']), finish]);
    const settings = el('div', { class: 'settings-grid' }, [
      el('div', { class: 'row' }, [el('label', { for: 'set-units' }, ['Units']), units]),
      num('Default wall thickness (m)', 'wallThickness', 0.01, 0.05, 0.6),
      num('Ceiling height (m)', 'ceilingHeight', 0.05, 2.1, 6),
      num('Floor to floor (m)', 'floorToFloor', 0.05, 1.8, 8),
      num('Upper floor ceiling height (m)', 'upperCeilingHeight', 0.05, 1.8, 6),
      finishRow,
      num('Snap tolerance (m)', 'tolerance', 0.005, 0.001, 0.2),
      num('Door height (m)', 'doorHeight', 0.05, 1.8, 3),
      num('Window sill (m)', 'windowSill', 0.05, 0, 2),
      num('Window height (m)', 'windowHeight', 0.05, 0.3, 3),
    ]);

    // Rooms: rename and pick a floor material.
    const rooms = el(
      'div',
      { class: 'room-list', 'data-testid': 'room-list' },
      report.roomList.map((r) => {
        const name = el('input', { type: 'text', class: 'text-input', value: r.name, 'aria-label': `Name of ${r.name}`, dir: 'auto' });
        name.addEventListener('change', () => {
          this.roomEdits[r.id] = { ...this.roomEdits[r.id], name: name.value.trim() || r.name };
          this.applyEdits();
        });
        const mat = el('select', { 'aria-label': `Floor of ${r.name}` });
        for (const m of FLOOR_MATERIALS) mat.appendChild(el('option', { value: m, selected: m === r.floorMaterial }, [MATERIAL_LABEL[m]]));
        mat.value = r.floorMaterial;
        mat.addEventListener('change', () => {
          this.roomEdits[r.id] = { ...this.roomEdits[r.id], floorMaterial: mat.value as FloorMaterialKey };
          this.applyEdits();
        });
        // What the room is: changing it rebuilds (a balcony gets glazing or a railing).
        const kind = el('select', { 'aria-label': `Type of ${r.name}` });
        for (const k of ROOM_KINDS) kind.appendChild(el('option', { value: k.key, selected: k.key === r.kind }, [k.label]));
        kind.value = r.kind;
        kind.addEventListener('change', () => {
          this.roomEdits[r.id] = { ...this.roomEdits[r.id], kind: kind.value as RoomKind };
          void this.buildAndReport();
        });
        const height = r.kind === 'open-balcony' ? '' : `, ${r.ceilingHeight.toFixed(2)} m high`;
        return el('div', { class: 'room-row' }, [name, el('span', { class: 'small' }, [`${r.floor}, ${r.area.toFixed(1)} m2${height}`]), kind, mat]);
      }),
    );

    const buildBtn = el('button', { class: 'btn primary', type: 'button', 'data-testid': 'build-scene' }, ['Build scene']);
    buildBtn.addEventListener('click', () => {
      this.applyEdits();
      if (this.lastPlan) {
        this.hide();
        this.h.build(this.lastPlan);
      }
    });
    const rebuild = el('button', { class: 'btn', type: 'button', 'data-testid': 'rebuild' }, ['Adjust settings and rebuild']);
    rebuild.addEventListener('click', () => void this.buildAndReport());
    const layers = el('button', { class: 'btn', type: 'button' }, ['Back to layers']);
    layers.addEventListener('click', () => this.layersStep());
    const demo = el('button', { class: 'btn ghost', type: 'button' }, ['Use demo apartment']);
    demo.addEventListener('click', () => {
      this.hide();
      this.h.demo();
    });
    void plan;
    this.show(
      el('h2', {}, ['Check the plan']),
      stats,
      ...(report.notes.length ? [el('div', { class: 'message info', 'data-testid': 'import-notes' }, report.notes.map((n) => el('p', {}, [n])))] : []),
      el('h3', {}, ['Warnings']),
      warnings,
      el('h3', {}, ['Rooms']),
      rooms,
      el('h3', {}, ['Settings']),
      settings,
      el('div', { class: 'actions' }, [buildBtn, rebuild, layers, demo]),
    );
  }

  /** Room renames and materials apply to the built plan directly (no rebuild needed). */
  private applyEdits(): void {
    const plan = this.lastPlan;
    if (!plan) return;
    for (const f of plan.floors)
      for (const r of f.rooms) {
        const e = this.roomEdits[r.id];
        if (!e) continue;
        if (e.name) r.name = e.name;
        if (e.floorMaterial) r.floorMaterial = e.floorMaterial;
      }
  }

  private cancel(): void {
    this.session?.dispose();
    this.session = null;
    this.hide();
    this.h.cancel();
  }
}
