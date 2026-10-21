// Single source of truth for the CC0 texture and HDRI assets used by CAD Tour.
// Used by fetch-textures.mjs, encode-textures.mjs and process-hdri.mjs.
// All assets come from Poly Haven (https://polyhaven.com), licence CC0.

/**
 * Material key -> Poly Haven texture id. `resolutions` are the KTX2 sets produced;
 * 4k is only built for the hero materials (floor, walls, fabric) that stream in on desktop High.
 */
export const TEXTURES = [
  {
    key: 'oak',
    id: 'laminate_floor_02',
    resolutions: ['1k', '2k', '4k'],
    use: 'Light oak plank floor: living, bedrooms, hall, landing and the stair',
  },
  {
    key: 'plaster',
    id: 'white_stucco',
    resolutions: ['1k', '2k', '4k'],
    use: 'Warm white painted plaster: interior walls and ceilings',
  },
  {
    key: 'tile',
    id: 'interior_tiles',
    resolutions: ['1k', '2k'],
    use: 'Light glazed ceramic floor tile: bathroom and kitchen floor',
  },
  {
    key: 'concrete',
    id: 'brushed_concrete',
    resolutions: ['1k', '2k'],
    use: 'Brushed concrete: balcony floor',
  },
  {
    key: 'fabric',
    id: 'jogging_melange',
    resolutions: ['1k', '2k', '4k'],
    use: 'Pale grey melange fabric: sofa, bed, armchair',
  },
  {
    key: 'exterior',
    id: 'white_stucco_02',
    resolutions: ['1k', '2k'],
    use: 'Rough off-white exterior render: facade',
  },
  {
    key: 'wood-light',
    id: 'silver_oak_veneer_01',
    resolutions: ['1k', '2k'],
    use: 'Light white-oak veneer: furniture tops and fronts',
  },
];

/** Sky / lighting environment. */
export const HDRI = {
  id: 'rhodes_memorial',
  envResolution: '1k', // Radiance .hdr used for PMREM lighting
  backplateSource: '4k', // HDR resolution the LDR backplates are made from
  backplates: [2048, 4096], // output widths (equirect, height = width / 2)
};

export const POLYHAVEN_API = 'https://api.polyhaven.com';
export const USER_AGENT = 'cad-tour-asset-scripts (https://github.com/MTulaimat/cad-tour)';
