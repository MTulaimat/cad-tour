import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Floor, Furniture, Size3 } from '../../data/schema';
import { type BuilderSet, W } from '../builder';
import { Parts, pieceFor } from './library';

export { PIECES, pieceFor, disposePrimitiveCache } from './library';
export { matchFurnitureType } from './registry';

export const furnitureSize = (item: Furniture): Size3 => item.size ?? pieceFor(item.type).size;

export function buildFurniture(floor: Floor, sets: BuilderSet): void {
  const E = floor.elevation;
  for (const item of floor.furniture) {
    const def = pieceFor(item.type);
    const size = furnitureSize(item);
    const base = new Matrix4().compose(W(item.position, E), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), item.rotation), new Vector3(1, 1, 1));
    def.build(new Parts(sets, base), size, { ceiling: floor.ceilingHeight });
  }
}
