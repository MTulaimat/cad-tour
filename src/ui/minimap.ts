import type { Floor, FloorPlan, Vec2 } from '../data/schema';
import { bounds, interiorPoint, polygonArea, type Bounds } from '../util/math2d';
import { segmentPoint, wallSegments } from '../plan/walls';
import { stairInfos } from '../plan/stairs';
import { el, hasArabic } from './dom';

/**
 * Minimap: the current floor drawn from the FloorPlan (walls, doors, stairs, room names) with the
 * player's position and facing, plus floor buttons that teleport (Q7). The static drawing is cached
 * per floor and size; each frame only the arrow is redrawn.
 */
export class Minimap {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buttons: HTMLButtonElement[] = [];
  private floorBar: HTMLElement;
  private plan: FloorPlan | null = null;
  private floor = 0;
  private cache = new Map<string, HTMLCanvasElement>();
  private view: { b: Bounds; s: number; ox: number; oy: number } | null = null;
  private player: { p: Vec2; yaw: number } | null = null;
  private cssW = 0;
  private cssH = 0;
  collapsed = false;

  constructor(private onFloor: (index: number) => void) {
    this.canvas = el('canvas', { class: 'minimap-canvas', 'aria-label': 'Floor plan with your position' });
    this.ctx = this.canvas.getContext('2d')!;
    this.floorBar = el('div', { class: 'minimap-floors', role: 'group', 'aria-label': 'Floor' });
    const toggle = el('button', { class: 'minimap-toggle', type: 'button', 'aria-label': 'Hide or show the map', title: 'Map (M)' }, [
      el('span', { class: 'icon icon-map', 'aria-hidden': 'true' }),
    ]);
    toggle.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.root = el('div', { class: 'minimap glass', 'data-testid': 'minimap' }, [el('div', { class: 'minimap-head' }, [this.floorBar, toggle]), this.canvas]);
    new ResizeObserver(() => this.resize()).observe(this.canvas);
  }

  setPlan(plan: FloorPlan): void {
    this.plan = plan;
    this.cache.clear();
    this.floorBar.replaceChildren();
    // Floors listed top to bottom, so the upper floor sits above.
    const order = plan.floors.map((f, i) => ({ f, i })).sort((a, b) => b.f.elevation - a.f.elevation);
    this.buttons = [];
    for (const { f, i } of order) {
      const label = shortFloorName(f, i, plan);
      const b = el('button', { class: 'floor-btn', type: 'button', title: `Go to ${f.name}`, 'aria-label': `Go to ${f.name}`, 'data-floor': String(i) }, [label]);
      b.addEventListener('click', () => {
        if (i !== this.floor) this.onFloor(i);
      });
      this.buttons[i] = b;
      this.floorBar.appendChild(b);
    }
    this.setFloor(this.floor < plan.floors.length ? this.floor : 0);
  }

  setFloor(i: number): void {
    this.floor = i;
    this.buttons.forEach((b, k) => {
      b.classList.toggle('active', k === i);
      b.setAttribute('aria-pressed', String(k === i));
    });
    this.view = null;
    this.draw();
  }

  setCollapsed(c: boolean): void {
    this.collapsed = c;
    this.root.classList.toggle('collapsed', c);
    this.resize();
  }

  setPlayer(p: Vec2, yaw: number): void {
    this.player = { p, yaw };
    this.draw();
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    if (Math.abs(r.width - this.cssW) < 0.5 && Math.abs(r.height - this.cssH) < 0.5) return;
    this.cssW = r.width;
    this.cssH = r.height;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.cache.clear();
    this.view = null;
    this.draw();
  }

  private fit(): { b: Bounds; s: number; ox: number; oy: number } | null {
    if (!this.plan) return null;
    const f = this.plan.floors[this.floor];
    const pts = [...f.rooms.flatMap((r) => r.polygon), ...f.walls.flatMap((w) => w.centerline)];
    if (pts.length === 0) return null;
    const b = bounds(pts);
    const pad = 10 * (this.canvas.width / Math.max(1, this.cssW));
    const w = this.canvas.width - pad * 2;
    const h = this.canvas.height - pad * 2;
    const s = Math.min(w / Math.max(0.1, b.maxX - b.minX), h / Math.max(0.1, b.maxY - b.minY));
    const ox = pad + (w - (b.maxX - b.minX) * s) / 2;
    const oy = pad + (h - (b.maxY - b.minY) * s) / 2;
    return { b, s, ox, oy };
  }

  /** Plan to canvas pixels, north up. */
  private px(p: Vec2): [number, number] {
    const v = this.view!;
    return [v.ox + (p.x - v.b.minX) * v.s, v.oy + (v.b.maxY - p.y) * v.s];
  }

  private staticLayer(): HTMLCanvasElement | null {
    if (!this.plan || this.canvas.width < 2) return null;
    const key = `${this.floor}:${this.canvas.width}x${this.canvas.height}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d')!;
    drawFloor(g, this.plan, this.plan.floors[this.floor], (p) => this.px(p), this.view!.s, this.canvas.width / Math.max(1, this.cssW));
    this.cache.set(key, c);
    return c;
  }

  draw(): void {
    if (!this.plan || this.collapsed || this.canvas.width < 2) return;
    this.view ??= this.fit();
    if (!this.view) return;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const layer = this.staticLayer();
    if (layer) g.drawImage(layer, 0, 0);
    if (!this.player) return;
    const [x, y] = this.px(this.player.p);
    const k = this.canvas.width / Math.max(1, this.cssW);
    // Facing: yaw 0 looks north, which is up on the map.
    const a = -this.player.yaw;
    g.save();
    g.translate(x, y);
    g.rotate(a);
    // View cone.
    const cone = g.createRadialGradient(0, 0, 0, 0, 0, 34 * k);
    cone.addColorStop(0, 'rgba(255, 214, 140, 0.45)');
    cone.addColorStop(1, 'rgba(255, 214, 140, 0)');
    g.fillStyle = cone;
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, 34 * k, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    g.closePath();
    g.fill();
    // Arrow.
    g.fillStyle = '#ffb547';
    g.strokeStyle = '#1b1d21';
    g.lineWidth = 1.5 * k;
    g.beginPath();
    g.moveTo(0, -8 * k);
    g.lineTo(6 * k, 6 * k);
    g.lineTo(0, 3 * k);
    g.lineTo(-6 * k, 6 * k);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}

function shortFloorName(f: Floor, i: number, plan: FloorPlan): string {
  const m = /(\d+)/.exec(f.name);
  if (m) return `L${m[1]}`;
  const rank = plan.floors.map((x) => x.elevation).sort((a, b) => a - b).indexOf(f.elevation);
  return `L${rank >= 0 ? rank + 1 : i + 1}`;
}

function drawFloor(g: CanvasRenderingContext2D, plan: FloorPlan, floor: Floor, px: (p: Vec2) => [number, number], scale: number, k: number): void {
  const path = (poly: Vec2[]) => {
    g.beginPath();
    poly.forEach((p, i) => {
      const [x, y] = px(p);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.closePath();
  };
  // Rooms.
  for (const r of floor.rooms) {
    path(r.polygon);
    g.fillStyle = r.outdoor ? 'rgba(180, 190, 200, 0.28)' : r.floorMaterial === 'tile' ? 'rgba(225, 228, 232, 0.5)' : 'rgba(236, 214, 178, 0.5)';
    g.fill();
  }
  // Stairs: treads and an arrow pointing up the flight.
  for (const s of stairInfos(plan)) {
    if (s.from.id !== floor.id && s.to.id !== floor.id) continue;
    for (const f of s.flights) {
      path(f.polygon);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fill();
      g.strokeStyle = 'rgba(40, 42, 46, 0.55)';
      g.lineWidth = 1 * k;
      for (let i = 0; i < f.flight.risers; i++) {
        const sAt = i * f.flight.going;
        const a = { x: f.flight.start.x + f.dir.x * sAt + f.side.x * (f.flight.width / 2), y: f.flight.start.y + f.dir.y * sAt + f.side.y * (f.flight.width / 2) };
        const b = { x: a.x - f.side.x * f.flight.width, y: a.y - f.side.y * f.flight.width };
        const [x0, y0] = px(a);
        const [x1, y1] = px(b);
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
      }
      const a = f.flight.start;
      const b = { x: a.x + f.dir.x * f.run, y: a.y + f.dir.y * f.run };
      const [x0, y0] = px(a);
      const [x1, y1] = px(b);
      g.strokeStyle = '#3a6ea5';
      g.lineWidth = 2 * k;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      g.lineTo(x1 - Math.cos(ang - 0.5) * 8 * k, y1 - Math.sin(ang - 0.5) * 8 * k);
      g.moveTo(x1, y1);
      g.lineTo(x1 - Math.cos(ang + 0.5) * 8 * k, y1 - Math.sin(ang + 0.5) * 8 * k);
      g.stroke();
    }
  }
  // Walls as thick strokes broken at openings.
  g.strokeStyle = '#2b2d31';
  g.lineCap = 'butt';
  for (const s of wallSegments(plan, floor)) {
    g.lineWidth = Math.max(2 * k, s.thickness * scale);
    let cur = 0;
    const pieces: [number, number][] = [];
    for (const o of s.openings) {
      if (o.u0 > cur) pieces.push([cur, o.u0]);
      cur = Math.max(cur, o.u1);
    }
    if (cur < s.length) pieces.push([cur, s.length]);
    for (const [u0, u1] of pieces) {
      const [x0, y0] = px(segmentPoint(s, u0));
      const [x1, y1] = px(segmentPoint(s, u1));
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
    }
    // Windows: thin double line; doors: a swing arc.
    for (const o of s.openings) {
      const op = o.opening;
      if (op.type === 'window') {
        g.strokeStyle = '#6f9fd0';
        g.lineWidth = 2 * k;
        const [x0, y0] = px(segmentPoint(s, o.u0));
        const [x1, y1] = px(segmentPoint(s, o.u1));
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
        g.strokeStyle = '#2b2d31';
        continue;
      }
      if ((op.style ?? 'hinged') !== 'hinged') continue;
      const swing = op.swing ?? { hinge: 'start', side: 'left' };
      const hingeU = swing.hinge === 'start' ? o.u0 : o.u1;
      const sideSign = swing.side === 'left' ? 1 : -1;
      const w = o.u1 - o.u0;
      const hinge = segmentPoint(s, hingeU);
      const closedTip = segmentPoint(s, swing.hinge === 'start' ? o.u1 : o.u0);
      const openTip = { x: hinge.x + s.nrm.x * sideSign * w, y: hinge.y + s.nrm.y * sideSign * w };
      const [hx, hy] = px(hinge);
      const [cx, cy] = px(closedTip);
      const [ox, oy] = px(openTip);
      const r = Math.hypot(cx - hx, cy - hy);
      const a0 = Math.atan2(cy - hy, cx - hx);
      const a1 = Math.atan2(oy - hy, ox - hx);
      let d = a1 - a0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      g.strokeStyle = 'rgba(43, 45, 49, 0.6)';
      g.lineWidth = 1 * k;
      g.beginPath();
      g.moveTo(hx, hy);
      g.lineTo(ox, oy);
      g.arc(hx, hy, r, a1, a0, d > 0);
      g.stroke();
      g.strokeStyle = '#2b2d31';
    }
  }
  // Railings.
  g.strokeStyle = 'rgba(60, 64, 70, 0.8)';
  g.lineWidth = 1.5 * k;
  for (const r of floor.railings) {
    g.beginPath();
    r.points.forEach((p, i) => {
      const [x, y] = px(p);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
  }
  // Room names, sized to fit.
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#1f2125';
  for (const r of floor.rooms) {
    if (!r.name) continue;
    const c = interiorPoint(r.polygon);
    const [x, y] = px(c);
    const area = polygonArea(r.polygon);
    const size = Math.max(10.5 * k, Math.min(14 * k, Math.sqrt(area) * scale * 0.16));
    g.font = `600 ${size}px Inter, "Noto Sans Arabic", system-ui, sans-serif`;
    g.direction = hasArabic(r.name) ? 'rtl' : 'ltr';
    const words = r.name.split(' ');
    const maxW = Math.sqrt(area) * scale * 0.9;
    let lines = [r.name];
    if (g.measureText(r.name).width > maxW && words.length > 1) {
      const mid = Math.ceil(words.length / 2);
      lines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
    }
    lines.forEach((line, i) => g.fillText(line, x, y + (i - (lines.length - 1) / 2) * size * 1.15));
  }
  g.direction = 'ltr';
}
