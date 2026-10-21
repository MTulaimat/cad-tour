import type { Floor, FloorPlan, Furniture, Opening, Room, Stair, Vec2, Wall } from './schema';
import { SCHEMA_VERSION } from './schema';

/**
 * The demo apartment: a two-level, two-bedroom flat of about 110 m2.
 *
 * Lower level (living): entry hall, open kitchen and living/dining, balcony off the living room,
 * and the foot of a straight stair that climbs west along the south wall.
 * Upper level (beds): landing, main bedroom, second bedroom and bathroom.
 *
 * Grid (wall centerlines, meters): the footprint is 9.6 x 5.8, walls are 0.2 thick,
 * ceilings 2.8, floor to floor 3.0, doors 0.9 x 2.1, windows 1.2 wide with a 0.9 sill.
 *
 *  y=5.8 +--------------+---------------------------+
 *        | KITCHEN      :  DINING      LIVING        |
 *  y=2.8 +--------------+                           |== BALCONY (x 9.6..11.1)
 *        | HALL         d                           |==
 *  y=1.2 |  +-----------+-- stair (rises west) <----|
 *  y=0   +-d+-----------------------------------------+
 *        x=0  1.68      3.8         6.0             9.6
 */

const WALL_T = 0.2;
const CEILING = 2.8;
const FLOOR_TO_FLOOR = 3.0;
const SLAB = 0.2;
const DOOR_W = 0.9;
const DOOR_H = 2.1;
const WIN_W = 1.2;
const WIN_H = 1.2;
const WIN_SILL = 0.9;

const p = (x: number, y: number): Vec2 => ({ x, y });

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)];

const wall = (id: string, a: Vec2, b: Vec2, thickness = WALL_T): Wall => ({
  id,
  centerline: [a, b],
  thickness,
  height: CEILING,
});

const door = (id: string, wallId: string, offset: number, swing: Opening['swing'], width = DOOR_W): Opening => ({
  id,
  type: 'door',
  wallId,
  offset,
  width,
  height: DOOR_H,
  sill: 0,
  swing,
  style: 'hinged',
});

const win = (id: string, wallId: string, offset: number, width = WIN_W, height = WIN_H, sill = WIN_SILL): Opening => ({
  id,
  type: 'window',
  wallId,
  offset,
  width,
  height,
  sill,
});

const item = (id: string, type: string, x: number, y: number, rotation = 0, size?: Furniture['size']): Furniture => ({
  id,
  type,
  position: p(x, y),
  rotation,
  ...(size ? { size } : {}),
});

const FACE_S = 0; // item front faces south
const FACE_N = Math.PI;
const FACE_E = Math.PI / 2;
const FACE_W = -Math.PI / 2;

function lowerFloor(): Floor {
  const walls: Wall[] = [
    wall('L1-w-south', p(0, 0), p(9.6, 0)),
    wall('L1-w-east', p(9.6, 0), p(9.6, 5.8)),
    wall('L1-w-north', p(9.6, 5.8), p(0, 5.8)),
    wall('L1-w-west', p(0, 5.8), p(0, 0)),
    wall('L1-w-hall-kitchen', p(0, 2.8), p(3.8, 2.8)),
    wall('L1-w-hall-living', p(3.8, 1.2), p(3.8, 2.8)),
    wall('L1-w-hall-stair', p(1.68, 1.2), p(3.8, 1.2)),
    wall('L1-w-understair', p(1.68, 0), p(1.68, 1.2)),
  ];

  const openings: Opening[] = [
    door('L1-d-entrance', 'L1-w-south', 0.84, { hinge: 'start', side: 'left' }),
    door('L1-d-hall-living', 'L1-w-hall-living', 0.8, { hinge: 'end', side: 'right' }),
    {
      id: 'L1-d-balcony',
      type: 'door',
      wallId: 'L1-w-east',
      offset: 3.5,
      width: 2.0,
      height: 2.2,
      sill: 0,
      style: 'sliding-glass',
    },
    win('L1-win-living-south', 'L1-w-south', 7.8),
    win('L1-win-living-north', 'L1-w-north', 1.2),
    win('L1-win-dining-north', 'L1-w-north', 4.7),
    win('L1-win-kitchen', 'L1-w-north', 7.7, WIN_W, 1.05, 1.05),
  ];

  const rooms: Room[] = [
    {
      id: 'L1-hall',
      name: 'Entry hall',
      polygon: [p(0, 0), p(1.68, 0), p(1.68, 1.2), p(3.8, 1.2), p(3.8, 2.8), p(0, 2.8)],
      floorMaterial: 'oak',
    },
    { id: 'L1-kitchen', name: 'Kitchen', polygon: rect(0, 2.8, 3.8, 5.8), floorMaterial: 'tile' },
    {
      id: 'L1-living',
      name: 'Living and dining',
      // Wall-bounded region, as room detection finds it: it runs under the stair too.
      polygon: [p(1.68, 0), p(9.6, 0), p(9.6, 5.8), p(3.8, 5.8), p(3.8, 1.2), p(1.68, 1.2)],
      floorMaterial: 'oak',
    },
    { id: 'L1-balcony', name: 'Balcony', polygon: rect(9.6, 1.5, 11.1, 5.5), floorMaterial: 'concrete', outdoor: true },
  ];

  const furniture: Furniture[] = [
    // Kitchen: L-shaped run along the north and west walls.
    item('L1-f-counter-a', 'kitchen-counter', 0.7, 5.39, FACE_S, { x: 1.2, y: 0.62, z: 0.9 }),
    item('L1-f-sink', 'kitchen-sink', 1.9, 5.39, FACE_S, { x: 1.2, y: 0.62, z: 0.9 }),
    item('L1-f-counter-b', 'kitchen-counter', 2.8, 5.39, FACE_S, { x: 0.6, y: 0.62, z: 0.9 }),
    item('L1-f-hob', 'kitchen-hob', 0.41, 4.58, FACE_E, { x: 1.0, y: 0.62, z: 0.9 }),
    item('L1-f-counter-c', 'kitchen-counter', 0.41, 3.84, FACE_E, { x: 0.48, y: 0.62, z: 0.9 }),
    item('L1-f-fridge', 'fridge', 0.43, 3.28, FACE_E, { x: 0.65, y: 0.65, z: 2.1 }),
    item('L1-f-wall-cab', 'wall-cabinet', 0.27, 4.34, FACE_E, { x: 1.48, y: 0.34, z: 0.7 }),
    // Dining.
    item('L1-f-dining', 'dining-table', 4.9, 4.3, FACE_S, { x: 1.6, y: 0.9, z: 0.75 }),
    item('L1-f-chair-1', 'chair', 4.5, 5.15, FACE_S),
    item('L1-f-chair-2', 'chair', 5.3, 5.15, FACE_S),
    item('L1-f-chair-3', 'chair', 4.5, 3.45, FACE_N),
    item('L1-f-chair-4', 'chair', 5.3, 3.45, FACE_N),
    item('L1-f-pendant', 'pendant-lamp', 4.9, 4.3, FACE_S),
    // Living.
    item('L1-f-sofa', 'sofa', 7.9, 2.3, FACE_N, { x: 2.2, y: 0.92, z: 0.8 }),
    item('L1-f-coffee', 'coffee-table', 7.9, 3.4, FACE_S, { x: 1.1, y: 0.6, z: 0.4 }),
    item('L1-f-armchair', 'armchair', 6.85, 3.55, FACE_E),
    item('L1-f-rug', 'rug', 7.8, 3.35, FACE_S, { x: 2.6, y: 1.8, z: 0.012 }),
    item('L1-f-sideboard', 'sideboard', 7.9, 5.48, FACE_S, { x: 1.8, y: 0.42, z: 0.55 }),
    item('L1-f-lamp', 'floor-lamp', 9.25, 1.55, FACE_S),
    item('L1-f-plant', 'plant', 9.25, 0.45, FACE_S),
    // Hall.
    item('L1-f-bench', 'bench', 0.3, 1.95, FACE_E, { x: 1.0, y: 0.38, z: 0.45 }),
    item('L1-f-console', 'sideboard', 2.75, 2.52, FACE_S, { x: 1.0, y: 0.34, z: 0.8 }),
    // Balcony.
    item('L1-f-bistro', 'bistro-table', 10.45, 4.6, FACE_S),
    item('L1-f-bistro-chair-1', 'bistro-chair', 10.45, 5.12, FACE_S),
    item('L1-f-bistro-chair-2', 'bistro-chair', 10.45, 4.08, FACE_N),
    item('L1-f-balcony-plant', 'plant', 10.8, 1.85, FACE_S),
  ];

  return {
    id: 'L1',
    name: 'Lower level',
    elevation: 0,
    ceilingHeight: CEILING,
    slabThickness: SLAB,
    walls,
    openings,
    rooms,
    furniture,
    railings: [
      {
        id: 'L1-r-balcony',
        points: [p(9.7, 1.53), p(11.07, 1.53), p(11.07, 5.47), p(9.7, 5.47)],
        height: 1.05,
        style: 'glass',
      },
    ],
  };
}

function upperFloor(): Floor {
  const walls: Wall[] = [
    wall('L2-w-south', p(0, 0), p(9.6, 0)),
    wall('L2-w-east', p(9.6, 0), p(9.6, 5.8)),
    wall('L2-w-north', p(9.6, 5.8), p(0, 5.8)),
    wall('L2-w-west', p(0, 5.8), p(0, 0)),
    wall('L2-w-landing', p(0, 2.4), p(6.1, 2.4)),
    wall('L2-w-bed2-bath', p(3.4, 2.4), p(3.4, 5.8)),
    wall('L2-w-bed1', p(6.1, 0), p(6.1, 5.8)),
  ];

  const openings: Opening[] = [
    door('L2-d-bed2', 'L2-w-landing', 0.85, { hinge: 'start', side: 'left' }),
    door('L2-d-bath', 'L2-w-landing', 4.5, { hinge: 'end', side: 'left' }),
    door('L2-d-bed1', 'L2-w-bed1', 1.8, { hinge: 'start', side: 'right' }),
    win('L2-win-landing', 'L2-w-south', 3.8),
    win('L2-win-bed1-south', 'L2-w-south', 7.85),
    win('L2-win-bed1-east', 'L2-w-east', 2.0),
    win('L2-win-bed1-north', 'L2-w-north', 2.2),
    win('L2-win-bath', 'L2-w-north', 5.25, 0.9, 0.7, 1.4),
    win('L2-win-bed2', 'L2-w-north', 7.9),
  ];

  const rooms: Room[] = [
    { id: 'L2-landing', name: 'Landing', polygon: rect(0, 0, 6.1, 2.4), floorMaterial: 'oak' },
    { id: 'L2-bed2', name: 'Bedroom 2', polygon: rect(0, 2.4, 3.4, 5.8), floorMaterial: 'oak' },
    { id: 'L2-bath', name: 'Bathroom', polygon: rect(3.4, 2.4, 6.1, 5.8), floorMaterial: 'tile' },
    { id: 'L2-bed1', name: 'Bedroom 1', polygon: rect(6.1, 0, 9.6, 5.8), floorMaterial: 'oak' },
  ];

  const furniture: Furniture[] = [
    // Bedroom 1 (main).
    item('L2-f-bed1', 'bed-double', 8.475, 4.3, FACE_W, { x: 1.6, y: 2.05, z: 1.0 }),
    item('L2-f-ns-1', 'nightstand', 9.28, 3.2, FACE_W),
    item('L2-f-ns-2', 'nightstand', 9.28, 5.38, FACE_W),
    item('L2-f-wardrobe-1', 'wardrobe', 6.5, 4.6, FACE_E, { x: 2.0, y: 0.6, z: 2.2 }),
    item('L2-f-desk', 'desk', 7.85, 0.42, FACE_N, { x: 1.2, y: 0.6, z: 0.75 }),
    item('L2-f-desk-chair', 'chair', 7.85, 0.98, FACE_S),
    item('L2-f-rug-1', 'rug', 8.0, 4.3, FACE_W, { x: 2.2, y: 3.0, z: 0.012 }),
    // Bedroom 2.
    item('L2-f-bed2', 'bed-double', 1.1, 4.2, FACE_E, { x: 1.4, y: 2.0, z: 0.95 }),
    item('L2-f-ns-3', 'nightstand', 0.33, 5.13, FACE_E),
    item('L2-f-wardrobe-2', 'wardrobe', 3.0, 3.6, FACE_W, { x: 1.2, y: 0.6, z: 2.2 }),
    item('L2-f-rug-2', 'rug', 1.4, 4.2, FACE_E, { x: 1.8, y: 2.4, z: 0.012 }),
    // Bathroom.
    item('L2-f-tub', 'bathtub', 4.35, 5.325, FACE_S, { x: 1.7, y: 0.75, z: 0.58 }),
    item('L2-f-wc', 'wc', 5.72, 4.2, FACE_W),
    item('L2-f-vanity', 'vanity', 3.75, 3.8, FACE_E, { x: 0.8, y: 0.5, z: 0.85 }),
    // Landing.
    item('L2-f-plant', 'plant', 0.38, 0.38, FACE_S),
  ];

  return {
    id: 'L2',
    name: 'Upper level',
    elevation: FLOOR_TO_FLOOR,
    ceilingHeight: CEILING,
    slabThickness: SLAB,
    walls,
    openings,
    rooms,
    furniture,
    railings: [],
  };
}

function stair(): Stair {
  const risers = 17;
  const going = 0.27;
  const width = 0.95;
  const footX = 6.0;
  const topX = footX - (risers - 1) * going; // 1.68
  const cy = 0.6;
  return {
    id: 'S1',
    fromFloorId: 'L1',
    toFloorId: 'L2',
    outline: rect(topX, 0.1, footX, 1.1),
    flights: [
      {
        start: p(footX, cy),
        direction: p(-1, 0),
        width,
        risers,
        riserHeight: FLOOR_TO_FLOOR / risers,
        going,
        baseElevation: 0,
      },
    ],
    landings: [{ polygon: rect(topX - 0.6, cy - width / 2, topX, cy + width / 2), elevation: FLOOR_TO_FLOOR }],
  };
}

export function createDemoPlan(): FloorPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: 'Demo apartment',
    units: 'm',
    floors: [lowerFloor(), upperFloor()],
    stairs: [stair()],
    source: { kind: 'demo' },
  };
}
