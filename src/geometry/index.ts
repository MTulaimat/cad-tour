import type { BufferGeometry } from 'three';
import type { FloorPlan } from '../data/schema';
import type { MaterialKey } from '../materials/keys';
import { BuilderSet } from './builder';
import { buildWalls } from './walls';
import { buildOpenings, type DoorLeafDef } from './openings';
import { buildCeilings, buildFloors } from './floors';
import { buildTrim } from './trim';
import { buildStairs } from './stairs';
import { buildRailings } from './railings';
import { buildFurniture, disposePrimitiveCache } from './furniture';
import { buildExterior } from './exterior';
import { buildColumns } from './columns';

export type { DoorLeafDef } from './openings';

/** Everything built for one floor, as merged geometry per material plus moving door parts. */
export interface FloorBuild {
  floorId: string;
  index: number;
  elevation: number;
  /** Architecture: walls, slabs, ceilings, trim, openings, stairs from this floor, railings. */
  shell: Map<MaterialKey, BufferGeometry>;
  furniture: Map<MaterialKey, BufferGeometry>;
  doors: DoorLeafDef[];
}

const collect = (sets: BuilderSet) => new Map(sets.entries().map(([k, b]) => [k, b.toGeometry()] as const));

export function buildFloorGeometry(plan: FloorPlan, index: number): FloorBuild {
  const floor = plan.floors[index];
  const shell = new BuilderSet();
  buildWalls(plan, floor, shell);
  const { doors } = buildOpenings(plan, floor, shell);
  buildFloors(plan, floor, shell);
  buildCeilings(plan, floor, shell);
  buildTrim(plan, floor, shell);
  buildStairs(plan, floor.id, shell);
  buildRailings(plan, floor, shell);
  buildColumns(plan, floor, shell);
  const furniture = new BuilderSet();
  buildFurniture(floor, furniture);
  disposePrimitiveCache();
  return { floorId: floor.id, index, elevation: floor.elevation, shell: collect(shell), furniture: collect(furniture), doors };
}

/** Building mass below the apartment and facade context, built once per plan. */
export function buildExteriorGeometry(plan: FloorPlan, groundDepth: number): Map<MaterialKey, BufferGeometry> {
  const sets = new BuilderSet();
  buildExterior(plan, sets, groundDepth);
  return collect(sets);
}
