import type { FloorPlan } from './schema';
import { createDemoPlan } from './mock';
import { normalizePlan } from './validate';

/** The demo apartment. Kept async so callers do not change when plans come from elsewhere. */
export async function loadPlan(): Promise<FloorPlan> {
  return normalizePlan(createDemoPlan());
}

export type { DxfImportOptions, DxfImportSession } from './dxf';

/**
 * Starts importing a DXF file. Parsing runs in a Web Worker and maps DXF layers
 * (walls, doors, windows, stairs, furniture) onto the same FloorPlan schema the demo uses.
 */
export async function parseDxf(file: File, options: import('./dxf').DxfImportOptions = {}) {
  const { startDxfImport } = await import('./dxf');
  return startDxfImport(file, options);
}
