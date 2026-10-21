// Dev helper: imports a sample DXF headlessly and prints what the importer found.
// Usage: npx tsx scripts/dxf-debug.ts samples/clean-layered.dxf
import { readFileSync } from 'node:fs';
import { readDrawing } from '../src/data/dxf/parse';
import { buildPlan } from '../src/data/dxf/build';
import { detectFloors, detectRoles } from '../src/data/dxf/layers';
import { decideUnits } from '../src/data/dxf/units';
import { DEFAULT_SETTINGS } from '../src/data/dxf/types';
import { polygonArea } from '../src/util/math2d';

const file = process.argv[2];
const model = readDrawing(new Uint8Array(readFileSync(file)));
const units = decideUnits(model.insunits, model.bounds.maxX - model.bounds.minX, model.bounds.maxY - model.bounds.minY);
const roles = detectRoles(model);
const floors = detectFloors(model);
console.log('encoding', model.encoding, 'units', units, 'floors', JSON.stringify(floors));
console.log('roles', JSON.stringify(roles));
console.log('counts', model.segs.length, 'segs', model.arcs.length, 'arcs', model.texts.length, 'texts', model.inserts.length, 'inserts');
const r = buildPlan(model, { roles, hidden: [], floors, settings: { ...DEFAULT_SETTINGS, units: units.units }, fileName: file });
for (const f of r.plan.floors) {
  console.log(`\n${f.id} walls=${f.walls.length} openings=${f.openings.length} (doors ${f.openings.filter((o) => o.type === 'door').length})`);
  for (const room of f.rooms) console.log(`  room ${room.name.padEnd(20)} ${polygonArea(room.polygon).toFixed(2)} m2 ${room.floorMaterial}${room.outdoor ? ' outdoor' : ''} pts=${room.polygon.length}`);
  if (process.argv.includes('--walls')) for (const w of f.walls) console.log(`  wall ${w.id} ${w.centerline.map((p) => `(${p.x.toFixed(2)},${p.y.toFixed(2)})`).join(' ')} t=${w.thickness}`);
}
console.log('\nstairs', r.plan.stairs.map((s) => `${s.fromFloorId}->${s.toFloorId} risers ${s.flights[0].risers} going ${s.flights[0].going.toFixed(3)}`));
console.log('warnings:\n ' + r.report.warnings.map((w) => `[${w.kind}] ${w.message}`).join('\n '));
