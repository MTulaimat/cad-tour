import type { FloorPlan } from '../schema';
import type { UnitDecision } from './units';
import type { BuildRequest, DrawingModel, FloorAssignment, ImportReport, LayerInfo, LayerRole } from './types';

/** Messages between the import UI and the DXF worker. */

export type WorkerIn = { type: 'parse'; bytes: ArrayBuffer } | { type: 'build'; request: BuildRequest };

export interface DxfSummary {
  layers: LayerInfo[];
  roles: Record<string, LayerRole>;
  floors: FloorAssignment;
  units: UnitDecision;
  bounds: DrawingModel['bounds'];
  version: string | null;
  codepage: string | null;
  encoding: string;
  warnings: string[];
  counts: { segs: number; arcs: number; texts: number; inserts: number };
}

/** Line work for the 2D preview, in drawing units: x1, y1, x2, y2 per segment and a layer index. */
export interface PreviewData {
  segs: Float32Array;
  layer: Uint16Array;
  layerNames: string[];
}

export type WorkerOut =
  | { type: 'progress'; fraction: number; label: string }
  | { type: 'parsed'; summary: DxfSummary; preview: PreviewData }
  | { type: 'built'; plan: FloorPlan; report: ImportReport }
  | { type: 'error'; message: string; details: string[] };

const MAX_PREVIEW = 250_000;

export function summarize(model: DrawingModel, roles: Record<string, LayerRole>, floors: FloorAssignment, units: UnitDecision): { summary: DxfSummary; preview: PreviewData } {
  const layerNames = model.layers.map((l) => l.name);
  const index = new Map(layerNames.map((n, i) => [n, i]));
  const pieces: [number, number, number, number, number][] = [];
  for (const s of model.segs) {
    if (pieces.length >= MAX_PREVIEW) break;
    pieces.push([s.a.x, s.a.y, s.b.x, s.b.y, index.get(s.layer) ?? 0]);
  }
  for (const a of model.arcs) {
    let sweep = a.a1 - a.a0;
    while (sweep <= 0) sweep += Math.PI * 2;
    const n = Math.max(4, Math.ceil(sweep / (Math.PI / 12)));
    for (let i = 0; i < n && pieces.length < MAX_PREVIEW; i++) {
      const t0 = a.a0 + (sweep * i) / n;
      const t1 = a.a0 + (sweep * (i + 1)) / n;
      pieces.push([a.c.x + Math.cos(t0) * a.r, a.c.y + Math.sin(t0) * a.r, a.c.x + Math.cos(t1) * a.r, a.c.y + Math.sin(t1) * a.r, index.get(a.layer) ?? 0]);
    }
  }
  const segs = new Float32Array(pieces.length * 4);
  const layer = new Uint16Array(pieces.length);
  pieces.forEach((p, i) => {
    segs.set(p.slice(0, 4), i * 4);
    layer[i] = p[4];
  });
  return {
    summary: {
      layers: model.layers,
      roles,
      floors,
      units,
      bounds: model.bounds,
      version: model.version,
      codepage: model.codepage,
      encoding: model.encoding,
      warnings: model.warnings,
      counts: { segs: model.segs.length, arcs: model.arcs.length, texts: model.texts.length, inserts: model.inserts.length },
    },
    preview: { segs, layer, layerNames },
  };
}
