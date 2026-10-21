/**
 * FloorPlan schema, version 1.
 *
 * Everything the renderer, collision and UI need comes from this one typed structure,
 * whether the plan was built from the demo data, a DXF file or an imported JSON file.
 *
 * Conventions
 * - Units are always meters.
 * - Plan coordinates: x points east, y points north, looking down on the plan.
 *   The 3D world maps plan (x, y) at height h to world (x, h, -y), so plans are never mirrored.
 * - Angles are radians, counterclockwise in plan, measured from +x.
 * - Every floor, wall, opening, room, stair and furniture item has a stable string id.
 */

export const SCHEMA_VERSION = 1 as const;

export interface Vec2 {
  x: number;
  y: number;
}

export type Id = string;

export interface FloorPlan {
  schemaVersion: typeof SCHEMA_VERSION;
  name: string;
  units: 'm';
  floors: Floor[];
  /** Stairs connect two floors, so they live at plan level. */
  stairs: Stair[];
  source?: PlanSource;
}

export interface PlanSource {
  kind: 'demo' | 'dxf' | 'json';
  fileName?: string;
  /** ISO timestamp of the import. */
  importedAt?: string;
}

export interface Floor {
  id: Id;
  name: string;
  /** Height of the finished floor surface above the plan origin. */
  elevation: number;
  /** Default clear height from the floor surface to the ceiling. */
  ceilingHeight: number;
  /** Structural slab under this floor (also the slab above the floor below). */
  slabThickness: number;
  walls: Wall[];
  openings: Opening[];
  rooms: Room[];
  furniture: Furniture[];
  /** Explicit railings: balcony edges, guards. Stairwell guards are derived from stairs. */
  railings: Railing[];
}

export interface Wall {
  id: Id;
  /** Centerline, two points for a straight wall, more for a polyline wall. */
  centerline: Vec2[];
  thickness: number;
  /** Height above the floor surface. */
  height: number;
}

export type OpeningType = 'door' | 'window';

/**
 * Door swing, stated against the wall direction at the opening
 * (the direction from the wall's centerline start towards its end).
 * - hinge: which jamb carries the hinges, the one nearer the wall start or the wall end.
 * - side: which side of the wall the leaf swings into, left or right of the wall direction.
 * Together these cover the usual "left or right hand, opening in or out" description
 * without depending on which room counts as inside.
 */
export interface DoorSwing {
  hinge: 'start' | 'end';
  side: 'left' | 'right';
}

export type DoorStyle = 'hinged' | 'sliding-glass' | 'passage';

export interface Opening {
  id: Id;
  type: OpeningType;
  wallId: Id;
  /** Distance along the wall centerline, from its first point to the opening center. */
  offset: number;
  width: number;
  height: number;
  /** Height of the opening bottom above the floor. Zero for doors. */
  sill: number;
  /** Doors only. Missing on a hinged door means hinge start, swing left. */
  swing?: DoorSwing;
  /** Doors only. Defaults to 'hinged'. */
  style?: DoorStyle;
}

export type FloorMaterialKey = 'oak' | 'tile' | 'concrete';

export const FLOOR_MATERIALS: readonly FloorMaterialKey[] = ['oak', 'tile', 'concrete'];

export interface Room {
  id: Id;
  name: string;
  /** Closed polygon (first point is not repeated), counterclockwise. */
  polygon: Vec2[];
  floorMaterial: FloorMaterialKey;
  /** Overrides the floor's ceiling height. */
  ceilingHeight?: number;
  /** Open-air rooms (balconies, terraces) get no ceiling and exterior wall faces. */
  outdoor?: boolean;
}

/**
 * One straight run of steps.
 * `start` is the midpoint of the first riser's bottom edge. The flight climbs along `direction`
 * with `risers` risers of `riserHeight` and `risers - 1` treads of `going`; the last riser
 * steps up onto the next landing or the floor above.
 */
export interface StairFlight {
  start: Vec2;
  /** Unit vector pointing up the flight. */
  direction: Vec2;
  width: number;
  risers: number;
  riserHeight: number;
  going: number;
  /** Height of the flight's bottom above the `fromFloor` surface. */
  baseElevation: number;
}

export interface StairLanding {
  polygon: Vec2[];
  /** Height above the `fromFloor` surface. */
  elevation: number;
}

/**
 * A stair is an ordered list of flights and landings. A straight stair is one flight
 * plus a top landing; L and U stairs add intermediate landings.
 */
export interface Stair {
  id: Id;
  fromFloorId: Id;
  toFloorId: Id;
  /** Overall footprint; the floor above gets an opening of this shape. */
  outline: Vec2[];
  flights: StairFlight[];
  landings: StairLanding[];
}

export interface Size3 {
  /** Width along the item's local x axis. */
  x: number;
  /** Depth along the item's local y axis (its front faces local -y). */
  y: number;
  /** Height. */
  z: number;
}

export interface Furniture {
  id: Id;
  /** Key into the procedural furniture library, for example 'sofa' or 'bed-double'. */
  type: string;
  /** Footprint center on the floor. */
  position: Vec2;
  /** Yaw, radians counterclockwise. At 0 the item's front faces south (-y). */
  rotation: number;
  /** Optional overall size; library defaults apply when missing. */
  size?: Size3;
  /** Original block or layer name, for imported items. */
  label?: string;
}

export interface Railing {
  id: Id;
  points: Vec2[];
  height: number;
  style: 'glass' | 'metal';
}
