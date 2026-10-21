# CAD Tour

Walk through an apartment in 3D, in first or third person, in the browser. Try the built-in demo
apartment, or open your own AutoCAD floor plan as a DXF file: it is read on your device and turned
into a 3D scene. Built with Vite, TypeScript and three.js, and made to work well on the Samsung
Galaxy Z Fold 7 (inner and cover screens) as well as phones, tablets and desktops.

**Live:** https://mtulaimat.github.io/cad-tour/

## Quick start

```
npm install
npm run dev
```

Open http://localhost:5173/cad-tour/ and pick **Use demo apartment**.

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Type check and production build into `dist/` |
| `npm run preview` | Serve the production build at http://localhost:4173/cad-tour/ |
| `npm test` | Unit tests (Vitest): data, geometry, collision, DXF import |
| `npm run test:e2e` | Browser tests (Playwright) at the Fold 7, phone, tablet and desktop sizes |
| `npm run budget` | Checks the initial download per quality tier stays under 25 MB (run after a build) |

The textures and the sky are committed, so a fresh clone runs without any network access beyond
`npm install`. To regenerate them, see [Assets](#assets).

## Controls

**Keyboard and mouse**

| Key | Action |
| --- | --- |
| W A S D or arrow keys | Move |
| Mouse | Look around. Click the view to capture the mouse |
| Shift | Run |
| V | Switch between first and third person |
| M | Show or hide the map |
| H | Help |
| Esc | Release the mouse; press it again for the menu |

**Touch**

- Left half of the screen: drag to move. The joystick appears where your thumb lands.
- Right half: drag to look around. Both thumbs work at the same time.
- Runner button: run (or push the joystick all the way). Eye or figure button: switch camera.
- L1 and L2 (bottom corner or on the map): jump to the stair landing on that floor.
- Menu: quality, render scale, look sensitivity, invert look, and a left-handed layout that swaps
  the two halves and the corner buttons.

Doors open by themselves as you walk up to them and close a moment after you leave.

## Opening your own DXF plan

Pick **Open plan** on the start screen or in the menu, or drop a file on the page on a desktop. On
Android the file picker reaches Google Drive and Samsung My Files too. Nothing is uploaded: the file
is parsed in a Web Worker in your browser.

### Preparing the file

- **Format:** ASCII DXF. In AutoCAD use SAVEAS and choose *AutoCAD 2013 DXF* (ASCII). DWG files and
  binary DXF are refused with a message; the free ODA File Converter can also turn DWG into DXF.
- **Units:** set `INSUNITS` in the drawing (millimeters, centimeters, meters, inches or feet). If it is
  missing, or the plan comes out smaller than 3 m or larger than 100 m, you are asked to pick the
  unit with a live size preview.
- **Layers:** walls, doors, windows, stairs and furniture on their own layers help a lot. Names are
  recognized automatically, in English and Arabic, for example `A-WALL`, `WALL`, `MUR`, `جدران`;
  `A-DOOR`, `DOOR`, `أبواب`; `A-GLAZ`, `WINDOW`, `شبابيك`; `A-STRS`, `STAIR`, `سلالم`; `A-FURN`,
  `أثاث`. Every layer is listed with its contents and you can change any role or switch a layer off.
  There is also a *Rooms* role for room names and for lines that split open-plan
  rooms (for example between a kitchen and a living room) or outline a balcony.
- **Walls:** double lines (5 to 40 cm apart), closed outlines or hatches, or single centerlines (built
  at a default thickness you can change). Small gaps where walls almost meet are closed; door-sized
  gaps never are.
- **Doors and windows:** door and window blocks, or doors drawn as a swing arc (plus leaf) in a wall
  gap. Windows can be blocks or lines on a window layer. Each is snapped to its wall.
- **Room names:** a TEXT or MTEXT label inside each room. Rooms are named from it (Arabic is shown
  right to left) and get a floor finish from keywords: bath, WC, kitchen get tile; balcony and terrace
  get concrete and become outdoor rooms with a glass railing.
- **Stairs:** the stair outline, a line at each riser, and an arrow (or an UP label) pointing up.
  You set the floor to floor height (3 m by default).
- **Several floors:** either prefix the layers per floor (`L1_`, `L2_`, ...) or draw a box around each
  floor in the preview. Floors are lined up on their stair.
- **Furniture:** blocks are matched by name (bed, sofa, table, chair, wc, sink, bath, shower,
  counter, wardrobe and so on, English and Arabic) to the same 3D pieces the demo uses, scaled to the
  block. Unknown blocks become plain volumes.

### The report

Before building you see the floors, rooms, walls, doors, windows, stairs and total area, and a list
of warnings: gaps that were closed or left open, openings that are not on a wall, rooms without a
label or with several labels, unusual sizes and stair rises. You can rename rooms, change their
floor finish, and adjust units, wall thickness, ceiling height, floor to floor height, snapping
tolerance and door and window heights, then rebuild. If something fails you get the reason and the
demo apartment as a fallback.

The mapping is remembered per file on your device. The last imported plan is kept too, and the start
screen offers **Continue**.

Sample files are in [`samples/`](samples/): `clean-layered.dxf` (the demo apartment itself),
`single-line-walls.dxf` and `messy-layer0.dxf` (everything on layer 0, duplicates, tiny gaps, no
units, an Arabic label in code page 1256). `npx tsx scripts/make-samples.ts` regenerates them.

## Plan JSON

**Menu > Export plan JSON** saves the current plan (the demo or an imported one) as a `.cadtour.json`
file. **Import plan JSON** (or opening a `.json` file) loads it again without re-parsing a DXF. The
file holds the same typed `FloorPlan` the renderer uses (`src/data/schema.ts`), so it can also be
written by other tools.

## Testing on a phone

Open https://mtulaimat.github.io/cad-tour/ on the phone. Every push to `main` deploys there through
GitHub Actions. For a Fold 7, try it unfolded and folded: the layout follows the screen while the
tour keeps your position.

## Installing as an app

CAD Tour is a Progressive Web App. In Chrome on Android open the menu and pick **Install app** (or
use **Install as an app** in the CAD Tour menu when it is offered). It then opens full screen, keeps
the screen awake during a tour, and works offline once the textures have been cached.

## Assets

Textures and the sky are CC0 from [Poly Haven](https://polyhaven.com); every asset, author and link is
in [CREDITS.md](CREDITS.md). The encoded KTX2 files live in `public/textures`, the HDRI and the sky
backplates in `public/hdri`. To rebuild them: `node scripts/fetch-textures.mjs`, then
`node scripts/encode-textures.mjs` (downloads KTX-Software into `tools/` if needed), then
`node scripts/process-hdri.mjs`.

## How it is built

| Folder | Contents |
| --- | --- |
| `src/data` | `FloorPlan` schema, demo apartment, plan JSON, validation, and `dxf/` (the importer) |
| `src/plan` | Derived plan facts shared by everything else: wall junctions, stairs, spawn points |
| `src/geometry` | Walls with openings, floors, ceilings, trim, stairs, railings, procedural furniture |
| `src/materials`, `src/lighting`, `src/render` | PBR materials, environment, sun, room probes, post-processing, quality tiers |
| `src/controls`, `src/collision` | Keyboard, mouse and touch, cameras, mannequin, capsule collision, doors |
| `src/ui`, `src/app` | Screens, HUD, minimap, import flow, app shell and page lifecycle |

The renderer only ever reads a `FloorPlan`, whether it came from the demo, a DXF or a JSON file.
`PLAN.md` holds the build plan, the decisions behind it and the progress log.
