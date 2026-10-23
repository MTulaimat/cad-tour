import { detectFloors, detectRoles } from './layers';
import { findSideBySidePlans } from './floors';
import { sizeSamples } from './sizes';
import { decideUnits, unitsFromContent, UNIT_SCALE, type UnitDecision } from './units';
import type { DrawingModel, FloorAssignment, LayerRole } from './types';

export interface PreparedImport {
  roles: Record<string, LayerRole>;
  units: UnitDecision;
  floors: FloorAssignment;
}

/**
 * First guesses for a freshly read drawing: layer roles from names, the unit (from $INSUNITS,
 * checked against the sizes of its doors, furniture and walls), and the floors (layer prefixes,
 * else plans drawn side by side, else one floor).
 */
export function prepareImport(model: DrawingModel): PreparedImport {
  const roles = detectRoles(model);
  const w = model.bounds.maxX - model.bounds.minX;
  const h = model.bounds.maxY - model.bounds.minY;
  const units = decideUnits(model.insunits, w, h, unitsFromContent(sizeSamples(model, roles)));
  let floors = detectFloors(model);
  if (floors.mode === 'single') {
    const boxes = findSideBySidePlans(model, roles, UNIT_SCALE[units.units]);
    if (boxes) floors = { mode: 'boxes', boxes, auto: true };
  }
  return { roles, units, floors };
}
