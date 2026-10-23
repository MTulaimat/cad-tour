import DxfParser from 'dxf-parser';
import Hatch, { type HatchEntity } from './hatch';
import { cleanMText, cleanText, decodeDxf } from './encoding';
import type { DArc, DInsert, DPoint, DPoly, DrawingModel, DSeg, DText, LayerInfo } from './types';
import { minAreaRect } from '../../util/math2d';

/**
 * Reads a DXF file into a flat drawing model: every LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE, TEXT,
 * MTEXT and HATCH boundary in model space, with INSERTs exploded through their (nested)
 * transforms. Paper space, dimensions and viewports are ignored. OCS extrusion (0, 0, -1), the
 * common mirrored case, is handled.
 */

type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];

const apply = (m: Mat, p: DPoint): DPoint => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const det = (m: Mat) => m[0] * m[3] - m[1] * m[2];
const MIRROR_X: Mat = [-1, 0, 0, 1, 0, 0];

interface AnyEntity {
  type: string;
  layer?: string;
  inPaperSpace?: boolean;
  [k: string]: unknown;
}

interface Block {
  name: string;
  position?: { x: number; y: number };
  entities?: AnyEntity[];
}

const MAX_DEPTH = 8;

/** Points along a polyline edge with a bulge (arc), excluding the start point. */
function bulgePoints(p0: DPoint, p1: DPoint, bulge: number): DPoint[] {
  if (!bulge || Math.abs(bulge) < 1e-9) return [p1];
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const c = Math.hypot(dx, dy);
  if (c < 1e-12) return [p1];
  const s = Math.sign(bulge);
  const theta = 4 * Math.atan(Math.abs(bulge));
  const r = c / (2 * Math.sin(theta / 2));
  const h = r * Math.cos(theta / 2);
  const mx = (p0.x + p1.x) / 2;
  const my = (p0.y + p1.y) / 2;
  const cx = mx + (-dy / c) * h * s;
  const cy = my + (dx / c) * h * s;
  const a0 = Math.atan2(p0.y - cy, p0.x - cx);
  const n = Math.max(2, Math.ceil(theta / (Math.PI / 12)));
  const out: DPoint[] = [];
  for (let i = 1; i <= n; i++) {
    const a = a0 + s * theta * (i / n);
    out.push(i === n ? p1 : { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

const ocsMirror = (e: AnyEntity): boolean => {
  const z = (e.extrusionDirectionZ as number | undefined) ?? (e.extrusionDirection as { z?: number } | undefined)?.z;
  return typeof z === 'number' && z < 0;
};

type Parsed = NonNullable<ReturnType<DxfParser['parseSync']>>;

/** Linetype names whose pattern has gaps (dashed, hidden, center lines), lower case. */
function brokenLinetypes(dxf: Parsed): Set<string> {
  const out = new Set<string>();
  const table = (dxf.tables as unknown as { lineType?: { lineTypes?: Record<string, { name?: string; pattern?: number[] }> } })?.lineType?.lineTypes ?? {};
  for (const [name, lt] of Object.entries(table)) {
    if ((lt.pattern ?? []).some((v) => v < 0)) out.add(name.toLowerCase());
  }
  return out;
}

const BROKEN_NAME = /dash|hidden|dot|center|centre|phantom|divide/i;

/** Linetype per layer from the LAYER table (dxf-parser skips group 6 there). */
function layerLinetypes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r\n|\r|\n/);
  let inLayers = false;
  let name: string | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();
    if (code === '0' && value === 'ENDTAB') {
      if (inLayers) break;
      continue;
    }
    if (code === '2' && !inLayers && lines[i - 2]?.trim() === '0' && lines[i - 1]?.trim() === 'TABLE' && value === 'LAYER') {
      inLayers = true;
      continue;
    }
    if (!inLayers) continue;
    if (code === '0') name = null;
    else if (code === '2') name = value;
    else if (code === '6' && name !== null) out.set(name, value);
  }
  return out;
}

export function parseDxfText(text: string): { dxf: Parsed } {
  const parser = new DxfParser();
  parser.registerEntityHandler(Hatch as never);
  const dxf = parser.parseSync(text);
  if (!dxf) throw new Error('This file could not be read as a DXF drawing.');
  return { dxf };
}

export function readDrawing(bytes: Uint8Array, onProgress: (f: number) => void = () => {}): DrawingModel {
  const decoded = decodeDxf(bytes);
  onProgress(0.15);
  let dxf: Parsed;
  try {
    dxf = parseDxfText(decoded.text).dxf;
  } catch (e) {
    throw new Error(`This DXF couldn't be read (${(e as Error).message}). Save it as ASCII DXF (DXF 2013 ASCII) and try again.`);
  }
  onProgress(0.55);
  const warnings: string[] = [];
  const blocks = (dxf.blocks ?? {}) as unknown as Record<string, Block>;
  const segs: DSeg[] = [];
  const arcs: DArc[] = [];
  const polys: DPoly[] = [];
  const texts: DText[] = [];
  const inserts: DInsert[] = [];
  const layerMap = new Map<string, LayerInfo>();
  const tableLayers = ((dxf.tables as unknown as { layer?: { layers?: Record<string, { name: string; frozen?: boolean }> } })?.layer?.layers ?? {}) as Record<string, { name: string; frozen?: boolean }>;
  for (const l of Object.values(tableLayers)) layerMap.set(l.name, { name: l.name, counts: {}, total: 0, frozen: !!l.frozen, samples: [] });
  const layerOf = (name: string) => {
    let l = layerMap.get(name);
    if (!l) {
      l = { name, counts: {}, total: 0, frozen: false, samples: [] };
      layerMap.set(name, l);
    }
    return l;
  };
  const count = (layer: string, type: string) => {
    const l = layerOf(layer);
    l.counts[type] = (l.counts[type] ?? 0) + 1;
    l.total++;
  };
  let skippedPaper = 0;
  let skippedOther = 0;
  const broken = brokenLinetypes(dxf);
  const layerLt = layerLinetypes(decoded.text);
  const isBroken = (lt: string | undefined) => !!lt && (broken.has(lt.toLowerCase()) || BROKEN_NAME.test(lt));
  // Drawn points of each top-level insert, for its footprint.
  const itemPoints: DPoint[][] = [];
  const track = (insert: number, ...pts: DPoint[]) => {
    if (insert < 0) return;
    (itemPoints[insert] ??= []).push(...pts);
  };

  const pushPoly = (pts: DPoint[], closed: boolean, layer: string, insert: number, source: DPoly['source'], extra: { dashed?: boolean; solid?: boolean; pattern?: string } = {}) => {
    if (pts.length < 2) return;
    track(insert, ...pts);
    const pi = closed && pts.length >= 3 ? polys.length : -1;
    const fill = source === 'hatch' ? { solid: !!extra.solid, ...(extra.pattern ? { pattern: extra.pattern } : {}) } : {};
    if (pi >= 0) polys.push({ points: pts, closed: true, layer, insert, source, ...fill });
    else if (source === 'polyline' && pts.length > 2) polys.push({ points: pts, closed: false, layer, insert, source });
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) segs.push({ a, b, layer, insert, poly: pi, ...(extra.dashed ? { dashed: true } : {}) });
    }
  };

  const emit = (e: AnyEntity, m: Mat, inheritLayer: string | null, insert: number, depth: number, blockDashed = false) => {
    if (e.inPaperSpace) {
      skippedPaper++;
      return;
    }
    const own = (e.layer as string) ?? '0';
    const layer = inheritLayer && own === '0' ? inheritLayer : own;
    const mm = ocsMirror(e) && e.type !== 'LINE' ? mul(m, MIRROR_X) : m;
    const lt = typeof e.lineType === 'string' ? e.lineType.trim() : '';
    const dashed = /^byblock$/i.test(lt) ? blockDashed : !lt || /^bylayer$/i.test(lt) ? isBroken(layerLt.get(layer)) : isBroken(lt);
    switch (e.type) {
      case 'LINE': {
        const v = e.vertices as { x: number; y: number }[] | undefined;
        if (v && v.length >= 2) {
          const a = apply(m, v[0]);
          const b = apply(m, v[1]);
          if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) {
            segs.push({ a, b, layer, insert, poly: -1, ...(dashed ? { dashed: true } : {}) });
            track(insert, a, b);
          }
        }
        break;
      }
      case 'ELLIPSE': {
        const c = e.center as { x: number; y: number } | undefined;
        const maj = e.majorAxisEndPoint as { x: number; y: number } | undefined;
        const ratio = (e.axisRatio as number) ?? 1;
        if (!c || !maj) break;
        let t0 = (e.startAngle as number) ?? 0;
        let t1 = (e.endAngle as number) ?? Math.PI * 2;
        while (t1 <= t0) t1 += Math.PI * 2;
        const full = t1 - t0 > Math.PI * 2 - 1e-6;
        const n = Math.max(8, Math.ceil(((t1 - t0) / (Math.PI * 2)) * 32));
        const minor = { x: -maj.y * ratio, y: maj.x * ratio };
        const pts: DPoint[] = [];
        for (let i = 0; i <= (full ? n - 1 : n); i++) {
          const t = t0 + ((t1 - t0) * i) / n;
          pts.push(apply(mm, { x: c.x + maj.x * Math.cos(t) + minor.x * Math.sin(t), y: c.y + maj.y * Math.cos(t) + minor.y * Math.sin(t) }));
        }
        pushPoly(pts, full, layer, insert, 'polyline', { dashed });
        break;
      }
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const v = (e.vertices as { x: number; y: number; bulge?: number }[] | undefined) ?? [];
        if (v.length < 2) break;
        const closed = !!e.shape;
        const pts: DPoint[] = [apply(mm, v[0])];
        const n = closed ? v.length : v.length - 1;
        for (let i = 0; i < n; i++) {
          const p0 = v[i];
          const p1 = v[(i + 1) % v.length];
          for (const q of bulgePoints(p0, p1, p0.bulge ?? 0)) pts.push(apply(mm, q));
        }
        if (closed) pts.pop();
        pushPoly(pts, closed, layer, insert, 'polyline', { dashed });
        break;
      }
      case 'ARC':
      case 'CIRCLE': {
        const c = e.center as { x: number; y: number };
        const r = e.radius as number;
        if (!c || !r) break;
        let a0 = e.type === 'CIRCLE' ? 0 : (e.startAngle as number);
        let a1 = e.type === 'CIRCLE' ? Math.PI * 2 : (e.endAngle as number);
        // Transform the arc through the matrix: map its end points and keep the sweep.
        const sx = Math.hypot(mm[0], mm[1]);
        const mirrored = det(mm) < 0;
        const rot = Math.atan2(mm[1], mm[0]);
        if (mirrored) {
          // A mirror reverses the sweep; mirror angles about the x axis first.
          [a0, a1] = [-a1, -a0];
        }
        const arc: DArc = { c: apply(mm, c), r: r * sx, a0: a0 + rot, a1: a1 + rot, layer, insert };
        arcs.push(arc);
        if (insert >= 0) {
          let sweep = arc.a1 - arc.a0;
          while (sweep <= 0) sweep += Math.PI * 2;
          const n = Math.max(2, Math.ceil(sweep / (Math.PI / 8)));
          for (let i = 0; i <= n; i++) {
            const t = arc.a0 + (sweep * i) / n;
            track(insert, { x: arc.c.x + Math.cos(t) * arc.r, y: arc.c.y + Math.sin(t) * arc.r });
          }
        }
        break;
      }
      case 'TEXT':
      case 'MTEXT': {
        const raw = String(e.text ?? '');
        const clean = e.type === 'MTEXT' ? cleanMText(raw) : cleanText(raw);
        if (!clean) break;
        const align = e.type === 'TEXT' && ((e.halign as number) || (e.valign as number)) && e.endPoint;
        const p = (e.type === 'MTEXT' ? e.position : align ? e.endPoint : e.startPoint) as { x: number; y: number } | undefined;
        if (!p) break;
        texts.push({ p: apply(mm, p), text: clean, height: ((e.textHeight ?? e.height ?? 0) as number) * Math.hypot(mm[0], mm[1]), layer, insert });
        const l = layerOf(layer);
        if (l.samples.length < 4 && !l.samples.includes(clean)) l.samples.push(clean.slice(0, 40));
        break;
      }
      case 'HATCH': {
        const h = e as unknown as HatchEntity;
        for (const loop of h.loops) {
          const pts: DPoint[] = [];
          for (let i = 0; i < loop.points.length; i++) {
            const p = loop.points[i];
            if (i === 0) pts.push(apply(mm, p));
            const q = loop.points[(i + 1) % loop.points.length];
            if (i < loop.points.length - 1 || loop.closed) for (const r of bulgePoints(p, q, p.bulge ?? 0)) pts.push(apply(mm, r));
          }
          if (loop.closed && pts.length > 3) pts.pop();
          // A hatch without the fill flag or pattern name (older writers) counts as solid.
          pushPoly(pts, true, layer, insert, 'hatch', { solid: h.solid ?? (!h.pattern || /^solid$/i.test(h.pattern)), pattern: h.pattern });
        }
        break;
      }
      case 'INSERT': {
        if (depth >= MAX_DEPTH) break;
        const block = blocks[e.name as string];
        if (!block) break;
        const pos = (e.position as { x: number; y: number }) ?? { x: 0, y: 0 };
        const rot = (((e.rotation as number) ?? 0) * Math.PI) / 180;
        const sx = (e.xScale as number) ?? 1;
        const sy = (e.yScale as number) ?? 1;
        const base = block.position ?? { x: 0, y: 0 };
        const c = Math.cos(rot);
        const s = Math.sin(rot);
        // T(pos) R(rot) S(sx, sy) T(-base)
        const local: Mat = [c * sx, s * sx, -s * sy, c * sy, 0, 0];
        local[4] = pos.x - (local[0] * base.x + local[2] * base.y);
        local[5] = pos.y - (local[1] * base.x + local[3] * base.y);
        const mi = mul(mm, local);
        let idx = insert;
        if (insert < 0) {
          // Top-level insert: an object the importer can classify (door, window, furniture).
          idx = inserts.length;
          const lb = blockBounds(block, blocks);
          const corners = lb
            ? [
                { x: lb.minX, y: lb.minY },
                { x: lb.maxX, y: lb.minY },
                { x: lb.maxX, y: lb.maxY },
                { x: lb.minX, y: lb.maxY },
              ].map((p) => apply(mi, p))
            : [apply(mi, base)];
          inserts.push({
            name: String(e.name),
            layer,
            position: apply(mm, pos),
            // A mirrored insert keeps the direction of its local x axis.
            rotation: Math.atan2(mi[1], mi[0]),
            sx,
            sy,
            corners,
            size: lb ? { w: (lb.maxX - lb.minX) * Math.abs(sx), d: (lb.maxY - lb.minY) * Math.abs(sy) } : { w: 0, d: 0 },
          });
        }
        for (const child of block.entities ?? []) emit(child, mi, layer, idx, depth + 1, dashed);
        break;
      }
      case 'DIMENSION':
      case 'VIEWPORT':
      case 'POINT':
      case 'ATTDEF':
        skippedOther++;
        break;
      default:
        skippedOther++;
        break;
    }
  };

  const entities = (dxf.entities ?? []) as unknown as AnyEntity[];
  entities.forEach((e, i) => {
    if (!e.inPaperSpace) count((e.layer as string) ?? '0', e.type);
    emit(e, IDENT, null, -1, 0);
    if (i % 2000 === 0) onProgress(0.55 + (0.4 * i) / Math.max(1, entities.length));
  });
  if (skippedPaper > 0) warnings.push(`${skippedPaper} paper space entities were ignored.`);
  inserts.forEach((ins, i) => {
    const pts = itemPoints[i];
    const r = pts && pts.length >= 3 ? minAreaRect(pts) : null;
    if (r && r.w > 1e-6 && r.d > 1e-6) ins.footprint = r.corners;
  });

  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (p: DPoint) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (p.x < b.minX) b.minX = p.x;
    if (p.y < b.minY) b.minY = p.y;
    if (p.x > b.maxX) b.maxX = p.x;
    if (p.y > b.maxY) b.maxY = p.y;
  };
  for (const s of segs) {
    grow(s.a);
    grow(s.b);
  }
  for (const a of arcs) {
    grow({ x: a.c.x - a.r, y: a.c.y - a.r });
    grow({ x: a.c.x + a.r, y: a.c.y + a.r });
  }
  for (const t of texts) grow(t.p);
  if (!Number.isFinite(b.minX)) throw new Error("This DXF has no drawing in model space. Check that the plan isn't only in a layout (paper space).");

  const header = (dxf.header ?? {}) as Record<string, unknown>;
  const insunits = typeof header.$INSUNITS === 'number' ? (header.$INSUNITS as number) : null;
  onProgress(1);
  return {
    layers: [...layerMap.values()].sort((x, y) => y.total - x.total || x.name.localeCompare(y.name)),
    segs,
    arcs,
    polys,
    texts,
    inserts,
    insunits,
    bounds: b,
    version: decoded.version,
    codepage: decoded.codepage,
    encoding: decoded.encoding,
    warnings,
  };
}

const boundsCache = new Map<string, { minX: number; minY: number; maxX: number; maxY: number } | null>();

/** Local bounding box of a block's geometry (nested inserts included), in block units. */
function blockBounds(block: Block, blocks: Record<string, Block>, depth = 0): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const key = `${block.name}`;
  if (boundsCache.has(key)) return boundsCache.get(key)!;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  };
  const base = block.position ?? { x: 0, y: 0 };
  for (const e of block.entities ?? []) {
    const v = e.vertices as { x: number; y: number }[] | undefined;
    if (v) for (const p of v) grow(p.x - base.x, p.y - base.y);
    const c = e.center as { x: number; y: number } | undefined;
    const r = e.radius as number | undefined;
    if (c && r) {
      // Arcs: their end points and any axis extremes they sweep through.
      if (e.type === 'CIRCLE') {
        grow(c.x - r - base.x, c.y - r - base.y);
        grow(c.x + r - base.x, c.y + r - base.y);
      } else {
        const a0 = e.startAngle as number;
        let a1 = e.endAngle as number;
        while (a1 < a0) a1 += Math.PI * 2;
        grow(c.x + Math.cos(a0) * r - base.x, c.y + Math.sin(a0) * r - base.y);
        grow(c.x + Math.cos(a1) * r - base.x, c.y + Math.sin(a1) * r - base.y);
        for (let k = Math.ceil(a0 / (Math.PI / 2)); k * (Math.PI / 2) <= a1; k++) grow(c.x + Math.cos((k * Math.PI) / 2) * r - base.x, c.y + Math.sin((k * Math.PI) / 2) * r - base.y);
      }
    }
    if (e.type === 'INSERT' && depth < MAX_DEPTH) {
      const child = blocks[e.name as string];
      const cb = child ? blockBounds(child, blocks, depth + 1) : null;
      const pos = (e.position as { x: number; y: number }) ?? { x: 0, y: 0 };
      if (cb) {
        const rot = (((e.rotation as number) ?? 0) * Math.PI) / 180;
        const sx = (e.xScale as number) ?? 1;
        const sy = (e.yScale as number) ?? 1;
        for (const [x, y] of [
          [cb.minX, cb.minY],
          [cb.maxX, cb.minY],
          [cb.maxX, cb.maxY],
          [cb.minX, cb.maxY],
        ]) {
          const lx = x * sx;
          const ly = y * sy;
          grow(pos.x + lx * Math.cos(rot) - ly * Math.sin(rot) - base.x, pos.y + lx * Math.sin(rot) + ly * Math.cos(rot) - base.y);
        }
      }
    }
  }
  const out = Number.isFinite(b.minX) ? b : null;
  boundsCache.set(key, out);
  return out;
}

/** Clears per-file caches (block names repeat across files). */
export function resetParseCaches(): void {
  boundsCache.clear();
}
