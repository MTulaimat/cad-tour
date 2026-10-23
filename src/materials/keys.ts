import type { FloorMaterialKey } from '../data/schema';

/**
 * Every surface the geometry builders emit is tagged with one of these keys.
 * The material library maps keys to PBR materials; geometry never touches three materials.
 */
export type MaterialKey =
  | 'wall-interior'
  | 'wall-exterior'
  | 'ceiling'
  | 'floor-oak'
  | 'floor-tile'
  | 'floor-concrete'
  | 'slab-edge'
  | 'skirting'
  | 'trim'
  | 'door-frame'
  | 'door-leaf'
  | 'window-frame'
  | 'glass'
  | 'sill'
  | 'sill-exterior'
  | 'stair-wood'
  | 'stair-paint'
  | 'metal-brushed'
  | 'metal-dark'
  | 'steel-black'
  | 'chrome'
  | 'fabric'
  | 'fabric-accent'
  | 'linen'
  | 'mirror'
  | 'wood-light'
  | 'lacquer-white'
  | 'lacquer-grey'
  | 'stone-white'
  | 'ceramic'
  | 'rug'
  | 'plant'
  | 'pot'
  | 'lamp-shade'
  | 'black-glass'
  | 'facade-glass'
  | 'mannequin';

export const floorMaterialKey = (k: FloorMaterialKey): MaterialKey =>
  k === 'tile' ? 'floor-tile' : k === 'concrete' ? 'floor-concrete' : 'floor-oak';
