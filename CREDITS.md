# Credits

CAD Tour uses the third-party assets below. All textures and the HDRI come from
[Poly Haven](https://polyhaven.com) and are released under CC0 1.0 Universal (public domain
dedication), so no attribution is legally required. They are credited here anyway, with thanks.

The encoded files in `public/` are derived from these sources by the scripts in `scripts/`
(`fetch-textures.mjs`, `encode-textures.mjs`, `process-hdri.mjs`). In the app, the tile texture is
turned 45 degrees into a straight grid and the oak, tile and furniture wood are tinted lighter to
fit the Scandinavian light palette.

## Textures

| Material key | Used for | Asset | Author(s) | License | Source |
| --- | --- | --- | --- | --- | --- |
| `oak` | Light oak plank floor (living, bedrooms, hall, landing, stair) | Laminate Floor 02 | Charlotte Baglioni (photography), Dario Barresi (processing) | CC0 1.0 | https://polyhaven.com/a/laminate_floor_02 |
| `plaster` | Interior walls and ceilings | White Stucco | Amal Kumar | CC0 1.0 | https://polyhaven.com/a/white_stucco |
| `tile` | Bathroom and kitchen floor | Interior Tiles | Charlotte Baglioni | CC0 1.0 | https://polyhaven.com/a/interior_tiles |
| `concrete` | Balcony floor | Brushed Concrete | Dimitrios Savva (photography), Dario Barresi (processing) | CC0 1.0 | https://polyhaven.com/a/brushed_concrete |
| `fabric` | Sofa, bed, armchair | Jogging Melange | colormass (photography), Rico Cilliers (processing) | CC0 1.0 | https://polyhaven.com/a/jogging_melange |
| `exterior` | Facade render | White Stucco 02 | Dimitrios Savva | CC0 1.0 | https://polyhaven.com/a/white_stucco_02 |
| `wood-light` | Furniture tops and fronts | Silver Oak Veneer 01 | Jenelle van Heerden | CC0 1.0 | https://polyhaven.com/a/silver_oak_veneer_01 |

Files: `public/textures/<material key>/<1k|2k|4k>/{albedo,normal,orm}.ktx2`, listed with sizes in
`public/textures/manifest.json`.

## HDRI

| Used for | Asset | Author(s) | License | Source |
| --- | --- | --- | --- | --- |
| Sky, lighting and the view through the windows | Rhodes Memorial | Greg Zaal, Rico Cilliers (backplates) | CC0 1.0 | https://polyhaven.com/a/rhodes_memorial |

Files: `public/hdri/env-1k.hdr` (the 1K HDR with the sun disc clamped to the surrounding sky, so the
sun light carries that energy instead), `public/hdri/backplate-2k.jpg` and
`public/hdri/backplate-4k.jpg` (tone-mapped from the 4K HDR), `public/hdri/sun.json`.

## Software bundled into the app

| What | License | Source |
| --- | --- | --- |
| three.js (with its addons) | MIT | https://threejs.org |
| Basis Universal transcoder (Binomial LLC), bundled by three.js r186's KTX2Loader | Apache License 2.0 | https://github.com/BinomialLLC/basis_universal |
| postprocessing (pmndrs) | Zlib | https://github.com/pmndrs/postprocessing |
| N8AO | ISC | https://github.com/N8python/n8ao |
| three-mesh-bvh | MIT | https://github.com/gkjohnson/three-mesh-bvh |
| dxf-parser | MIT | https://github.com/gdsestimating/dxf-parser |

## Build tools (used offline, not shipped)

| Tool | Used for | License | Source |
| --- | --- | --- | --- |
| KTX-Software 4.4.2 (`ktx create`, Khronos Group) | KTX2 encoding (ETC1S/BasisLZ, UASTC, Zstandard) | Apache License 2.0 | https://github.com/KhronosGroup/KTX-Software |
| sharp | Image resizing, packing and JPEG output | Apache License 2.0 | https://sharp.pixelplumbing.com |

## Fonts
