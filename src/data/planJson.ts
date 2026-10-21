import type { FloorPlan } from './schema';
import { normalizePlan, validatePlan } from './validate';

/** File format wrapper so exported files are recognizable and versioned. */
interface PlanFile {
  format: 'cad-tour-plan';
  version: 1;
  exportedAt: string;
  plan: FloorPlan;
}

export class PlanJsonError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'PlanJsonError';
  }
}

export function exportPlanJson(plan: FloorPlan): string {
  const file: PlanFile = {
    format: 'cad-tour-plan',
    version: 1,
    exportedAt: new Date().toISOString(),
    plan,
  };
  return JSON.stringify(file, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v), 1);
}

/** Parses a plan JSON file (the wrapped export or a bare FloorPlan) and validates it. */
export function importPlanJson(text: string): FloorPlan {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new PlanJsonError(`This file isn't valid JSON (${(e as Error).message}).`);
  }
  const candidate =
    typeof data === 'object' && data !== null && (data as { format?: unknown }).format === 'cad-tour-plan'
      ? (data as { plan?: unknown }).plan
      : data;
  const result = validatePlan(candidate);
  if (!result.ok) {
    throw new PlanJsonError("This JSON file isn't a CAD Tour plan, or it is damaged.", result.errors);
  }
  return normalizePlan(structuredClone(candidate) as FloorPlan);
}

export function planFileName(plan: FloorPlan): string {
  const base = plan.name.trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'plan';
  return `${base.toLowerCase()}.cadtour.json`;
}
