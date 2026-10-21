import type { FloorMaterialKey } from '../schema';
import type { UnitKey } from './units';

/** Geometry flattened out of a DXF file, still in drawing units, before any interpretation. */

export interface DPoint {
  x: number;
  y: number;
}

/** Straight piece of a LINE, a polyline edge, a hatch boundary edge or exploded block geometry. */
export interface DSeg {
  a: DPoint;
  b: DPoint;
  layer: string;
  /** Index into `inserts` when it came from a block. */
  insert: number;
  /** Index into `polys` when it is an edge of a closed shape. */
  poly: number;
}

export interface DArc {
  c: DPoint;
  r: number;
  /** Counterclockwise from a0 to a1, radians. */
  a0: number;
  a1: number;
  layer: string;
  insert: number;
}

export interface DPoly {
  points: DPoint[];
  closed: boolean;
  layer: string;
  insert: number;
  source: 'polyline' | 'hatch';
}

export interface DText {
  p: DPoint;
  text: string;
  height: number;
  layer: string;
  insert: number;
}

export interface DInsert {
  name: string;
  layer: string;
  position: DPoint;
  /** Radians, counterclockwise, after any mirroring. */
  rotation: number;
  sx: number;
  sy: number;
  /** World corners of the block's local bounding box (counterclockwise in local space). */
  corners: DPoint[];
  /** Size of the block's local bounding box, scaled. */
  size: { w: number; d: number };
}

export interface LayerInfo {
  name: string;
  counts: Record<string, number>;
  total: number;
  frozen: boolean;
  /** Text strings on this layer (a few), to help the user identify it. */
  samples: string[];
}

export interface DrawingModel {
  layers: LayerInfo[];
  segs: DSeg[];
  arcs: DArc[];
  polys: DPoly[];
  texts: DText[];
  inserts: DInsert[];
  insunits: number | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  version: string | null;
  codepage: string | null;
  encoding: string;
  warnings: string[];
}

export type LayerRole = 'walls' | 'doors' | 'windows' | 'stairs' | 'furniture' | 'rooms' | 'ignore';

export const ROLES: { key: LayerRole; label: string }[] = [
  { key: 'walls', label: 'Walls' },
  { key: 'doors', label: 'Doors' },
  { key: 'windows', label: 'Windows' },
  { key: 'stairs', label: 'Stairs' },
  { key: 'furniture', label: 'Furniture' },
  { key: 'rooms', label: 'Rooms' },
  { key: 'ignore', label: 'Ignore' },
];

export interface FloorBox {
  /** Drawing units. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FloorAssignment {
  mode: 'single' | 'prefix' | 'boxes';
  /** Ordered from the lowest floor up. Prefixes like 'L1_' or boxes drawn in the preview. */
  prefixes?: string[];
  boxes?: FloorBox[];
}

export interface ImportSettings {
  units: UnitKey;
  /** Default thickness for single-line walls, meters. */
  wallThickness: number;
  ceilingHeight: number;
  floorToFloor: number;
  /** Endpoint snapping tolerance, meters. */
  tolerance: number;
  doorHeight: number;
  windowSill: number;
  windowHeight: number;
}

export const DEFAULT_SETTINGS: Omit<ImportSettings, 'units'> = {
  wallThickness: 0.2,
  ceilingHeight: 2.8,
  floorToFloor: 3.0,
  tolerance: 0.02,
  doorHeight: 2.1,
  windowSill: 0.9,
  windowHeight: 1.2,
};

export interface BuildRequest {
  roles: Record<string, LayerRole>;
  /** Layers switched off in the mapping screen. */
  hidden: string[];
  floors: FloorAssignment;
  settings: ImportSettings;
  /** Room edits from the report screen, by room id. */
  roomEdits?: Record<string, { name?: string; floorMaterial?: FloorMaterialKey }>;
  fileName: string;
}

export interface ReportWarning {
  kind: 'gap' | 'opening' | 'unnamed' | 'size' | 'stair' | 'floor' | 'room' | 'furniture' | 'general';
  message: string;
}

export interface ImportReport {
  floors: number;
  rooms: number;
  walls: number;
  doors: number;
  windows: number;
  stairs: number;
  furniture: number;
  totalArea: number;
  warnings: ReportWarning[];
  roomList: { id: string; floor: string; name: string; area: number; floorMaterial: FloorMaterialKey; named: boolean }[];
}
