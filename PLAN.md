# CAD Tour: build plan

A Three.js apartment walkthrough (Vite + TypeScript + three) that runs a built-in demo apartment and can import a real AutoCAD DXF floor plan client-side, with first and third person tours, near-photorealistic look, and first-class support for the Samsung Galaxy Z Fold 7 (unfolded).

This file is the single source of truth for the build. Sections, in order:

1. Original brief (verbatim from Musab, two parts)
2. Planning decisions (Q&A outcome; these override the brief where they differ)
3. Planner decisions (decided by the planner and stated to Musab, not asked)
4. Technical defaults (how to build it; deviate only when blocked, and log why)
5. Milestones (build order and acceptance checks)
6. Working rules
7. Progress log, and Assumptions and deviations (the build session fills these in)

Where the work lives: this folder, `C:\Users\musab\Desktop\Projects\cad-tour`, which becomes the public GitHub repo `MTulaimat/cad-tour`, deployed by GitHub Actions to GitHub Pages at `https://mtulaimat.github.io/cad-tour/`. There is no Bezier issue for this work.

---

## 1. Original brief (verbatim)

### Part 1: walkthrough app

Build a Three.js apartment walkthrough web app (Vite + TypeScript + three). It must look professional and near-photorealistic, work great on mobile (priority: Samsung Galaxy Z Fold 7 unfolded), and be architected so mock data can later be swapped for real AutoCAD DXF data without touching the renderer.

DATA LAYER
- Define a typed FloorPlan schema in src/data/schema.ts: units (meters), floors[] each with elevation, walls[] (start/end or polyline centerline, thickness, height), openings[] (type door|window, wall ref, position along wall, width, height, sill height, swing direction), rooms[] (name, closed polygon, floor material key), stairs[] (outline polygon, direction vector, step count, from/to floor, landing), and furniture[] (type, position, rotation).
- Create src/data/mock.ts exporting a realistic 2-bedroom apartment over 2 floors (about 110 sqm total): entry hall, open living/kitchen, 2 bedrooms, bathroom, balcony, plus a stair connecting floors. Use 2.8 m ceilings, 3 m floor-to-floor, 20 cm walls, 0.9 m doors, 1.2 m windows.
- Create src/data/loader.ts with loadPlan() returning the mock now. Leave a clearly marked stub parseDxf(file) that will later map DXF layers (WALLS, DOORS, WINDOWS, STAIRS) into the same schema.

GEOMETRY
- Walls as extruded geometry with real openings (build wall segments around door/window cut-outs, add frames, sills, glass panes, door leaves).
- Floors and ceilings per room from polygons, with skirting boards and subtle ceiling trim.
- Stairs with proper rise/run, treads, risers, stringers and a handrail. Cut the floor opening on the upper level where the stair passes.
- Simple, tasteful furniture from primitives or small glTF models (sofa, bed, table, kitchen counters, bathroom fixtures). Keep it modest and clean.

LOOK AND TEXTURES
- PBR materials with albedo, normal, roughness and AO maps. Use CC0 textures from Polyhaven or ambientCG (download into public/textures, record sources in CREDITS.md): oak wood floor, ceramic bathroom tile, painted plaster walls, concrete balcony, fabric, stair wood. Set UV scaling in real-world meters so tiling looks correct.
- Lighting: HDRI environment (Polyhaven CC0), one directional sun with soft shadows, interior point/rect area lights, ACES filmic tone mapping, sRGB output.
- Post-processing (High quality tier only): SSAO or GTAO, subtle bloom, SMAA, light vignette. Include a quality toggle (Low / Medium / High).

CONTROLS AND CAMERAS
- First person: eye height 1.65 m, WASD, shift to run, mouse look with pointer lock on desktop.
- Third person: stylized humanoid avatar (capsule-based or a free CC0 glTF) with idle/walk animation and an orbit follow camera with collision so it never clips through walls.
- Press V (or tap the on-screen button) to toggle modes with a smooth camera transition.
- Collision: capsule vs wall segments, wall sliding, no walking through walls. Stair walking must snap smoothly to step heights (floor-height raycast or ramp collider) with no camera jitter.
- Minimap in a corner showing the current floor, player position and facing, with a floor switch.

UI
- Clean minimal HUD: room name label that updates as you enter a room, mode toggle, floor indicator, quality toggle, help overlay (H). Loading screen with progress. Modern neutral font, subtle glass-style panels.

MOBILE AND FOLDABLE SUPPORT (priority: Samsung Galaxy Z Fold 7, unfolded)
The Fold 7 inner screen is nearly square (about 8", roughly 1.1:1, around 900x800 CSS px; do not hardcode this). The app must be fully usable there, on the cover screen (tall and narrow, about 21:9), and on regular phones and tablets.

Layout and responsiveness
- Never assume landscape or portrait. Drive all layout from the actual viewport size and aspect ratio using CSS container/media queries and a resize handler. Test at 900x800, 360x840 (cover screen), 412x915, 1024x768 and 1280x800.
- Handle live folding and unfolding while the app runs: on resize/orientationchange, update renderer size, camera aspect and projection, post-processing buffers and HUD layout without reloading or losing player position. Use ResizeObserver, debounced.
- Use dvh/svh units and env(safe-area-inset-*) so nothing hides behind browser bars or the gesture bar. Set viewport meta with viewport-fit=cover, and disable page zoom and pull-to-refresh (touch-action: none and overscroll-behavior: none on the canvas).
- Optionally use the Device Posture API and viewport-segments media features where supported, as progressive enhancement only. Never depend on them.

Touch controls for a near-square, two-thumb screen
- Left thumb: floating virtual joystick (appears where the thumb lands in the left half). Right thumb: drag-to-look anywhere in the right half, with adjustable sensitivity and optional invert-Y.
- Multi-touch must work with both thumbs at once (track pointers by pointerId, never confuse them).
- Large hit targets (min 48px): mode toggle, floor switch, run button, menu. Place them in the corners within thumb reach, and add a left-handed layout setting.
- Prevent browser gestures from stealing input: preventDefault on touch events, user-select none, -webkit-touch-callout none.
- Show a tap-to-start overlay (no pointer lock on touch) and a fullscreen button. Provide PWA install (manifest + service worker, display: fullscreen, portrait and landscape allowed). Use Screen Wake Lock so the screen does not sleep during a tour.

Performance on mobile (Snapdragon 8 Elite class, but assume throttling)
- Auto quality tiers: detect GPU/device memory/frame time at startup and adapt. Mobile default = Medium: cap devicePixelRatio at 2 (render scale slider 0.5 to 1), shadow map 1024, SSAO and bloom off or lightweight, SMAA or FXAA only, no heavy transmission glass (use a cheap transparent material).
- Target 60 fps with dynamic resolution scaling: lower render scale when frame time exceeds 20 ms, raise it when stable. Support 120 Hz displays by running physics on a fixed timestep.
- Textures: ship KTX2 (Basis Universal) compressed textures with mipmaps, max 1024 to 2048 px on mobile, 4K only on desktop High. Use Draco/meshopt for any glTF. Lazy-load furniture and the upper floor. Keep total download under about 25 MB with a progress bar.
- Merge static geometry and use instancing to keep draw calls under about 150. Dispose resources properly and handle WebGL context loss and restore. Pause rendering when the tab is hidden.

HUD adaptation
- Minimap smaller and collapsible on the cover screen. On the square inner screen, dock it top-left as a translucent glass panel, away from both thumb zones.
- Text in rem/clamp(), minimum 14px, high contrast over the 3D view.

DELIVERABLES
- Runs with npm install && npm run dev, builds with npm run build.
- README covering controls, how to plug in real DXF data later, texture credits, testing on a real device over LAN (vite --host with HTTPS), and installing as a PWA.
- Modular code: data, geometry builders, materials, controls, collision, ui in separate folders.

TESTING
- Add Playwright device-emulation tests at the viewports listed above, including a custom "Z Fold 7 unfolded" profile. Verify no overflow, no clipped controls, and that resizing mid-session keeps player state.
- When done, run the build, open it in a browser, walk through every room on both floors on desktop and in mobile emulation, and fix any clipping, z-fighting, texture stretching, stair jitter or touch-control conflicts you find.

### Part 2: DXF import (added during planning; replaces the "stub parseDxf" idea with a real feature)

DXF IMPORT (select a file and build the scene from it)

UI
- Add an "Open plan" button on the start screen and in the menu: file picker (accept .dxf) plus drag-and-drop on desktop. Also a "Use demo apartment" button that loads the mock. Works on mobile (Android file picker, including Google Drive and Samsung My Files).
- If the user picks a .dwg, do not try to parse it. Show a clear message: "DWG isn't supported. Export as DXF (SAVEAS, DXF 2013 ASCII, or use ODA File Converter) and try again."
- Parsing runs fully client-side in a Web Worker so the UI stays responsive, with a progress indicator. Nothing is uploaded to a server.

Parsing (src/data/dxf/)
- Use the dxf-parser npm package (or equivalent). Read LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE, INSERT (blocks, with nested transforms and scale), TEXT/MTEXT, and HATCH boundaries if present.
- Detect units from $INSUNITS (mm, cm, m, inches, feet) and convert to meters. If missing or implausible (e.g. an apartment wider than 100 m or smaller than 3 m), ask the user to pick the unit with a live bounding-box size preview.
- Layer mapping step: auto-detect layers by name (WALL*, A-WALL, DOOR*, WIN*, STAIR*, FURN*, plus Arabic/English variants), then show a mapping screen listing every layer with entity counts and a dropdown (Walls / Doors / Windows / Stairs / Furniture / Ignore). Remember the mapping per file in localStorage. Let the user toggle layers and preview them in a 2D top-down view before building.
- Walls: support closed polylines (use as wall outlines), paired parallel lines (derive centerline and thickness by pairing lines within 5 to 40 cm), and single centerlines (apply a default thickness setting, 20 cm). Clean up first: snap endpoints within a tolerance, merge collinear segments, remove duplicates and zero-length lines, and close small gaps.
- Doors/windows: from blocks (position, rotation, width from block extents) or from swing arcs plus gap in the wall. Snap each opening to the nearest wall and cut it out. Defaults: door 2.1 m high, window sill 0.9 m and 1.2 m high, all overridable.
- Rooms: detect closed regions from the wall graph (polygon-from-segments), name them from the nearest TEXT/MTEXT label, otherwise "Room 1, 2...". Assign default floor materials by keyword (bath, kitchen, balcony, bedroom).
- Stairs: read the outline, tread lines (count steps) and the direction arrow. Ask for floor-to-floor height (default 3 m).
- Multiple floors: if the file has several plan views, let the user draw a selection box around each one in the 2D preview and assign it to a floor, or map by layer prefix (e.g. L1_, L2_).
- Output must be the same FloorPlan schema the mock uses, so the renderer is untouched.

Validation report
- After parsing, show a summary screen: floors, rooms found, walls, doors, windows, stairs, total area, plus warnings (gaps in walls, openings not on a wall, unnamed rooms, huge/odd dimensions). Offer "Build scene" and "Adjust settings" (wall thickness, ceiling height, units, tolerance). Never fail silently: if parsing fails, show the reason and fall back to the demo.
- Allow exporting the parsed plan as JSON (and importing that JSON) so a cleaned plan can be reused without re-parsing.

Testing
- Include 3 sample DXF files in /samples (clean layered plan, single-line walls plan, messy plan with everything on layer 0) and unit tests for unit detection, wall pairing, gap closing, opening snapping and room detection.

---

## 2. Planning decisions (settled; do not reopen)

Every question asked in planning, the answer chosen, and the options declined. Where a decision contradicts the brief, the decision wins.

Note: round 1 was first answered "No preference" on every question because Musab interrupted to add Part 2 (DXF import). It was asked again and the answers below are the real ones.

### Round 1: the apartment

**Q1. How should the demo apartment's rooms be split across the two floors?**
- Chosen: **Living below, beds above.** Lower level: entry hall, open kitchen + living/dining, balcony off the living room, stair. Upper level: landing, bedroom 1 (main), bedroom 2, bathroom.
- Declined: "Beds above, balcony upstairs" (balcony off the main bedroom instead); "Reverse, living above" (bedrooms below, living + balcony upstairs for the view).
- Indicative sketch shown (final dimensions are the build session's call, about 55 m2 per level, about 110 m2 total plus a balcony of about 6 m2):
```
LOWER LEVEL  ~55 m2
+-----------+-----------------------+
| KITCHEN   :  LIVING / DINING      |
| (open)    :                       |====
|           :                       |BALC
+------+----+                       |~6m2
| ENTRY| STAIR ^                    |====
| HALL |       |                    |
+-door-+-------+--------------------+

UPPER LEVEL  ~55 m2
+------------+----------+-----------+
| BEDROOM 1  | BATHROOM | BEDROOM 2 |
| (main)     |          |           |
+----[ ]-----+---[ ]----+---[ ]-----+
|   LANDING    | STAIR v |          |
+--------------+---------+----------+
```

**Q2. What shape should the demo apartment's stair be?** (The schema supports straight, L and U either way; see planner decision P1.)
- Chosen: **Straight flight.** One straight run along a wall, 17 risers of about 176 mm (3.0 m floor-to-floor), going about 4.3 m, with a top landing.
- Declined: "L-shaped, quarter landing" (more compact, exercises flights/landings in the demo); "U-shaped, half landing" (most compact, wider stairwell opening).

**Q3. Which interior style should the materials and furniture follow?**
- Chosen: **Scandinavian light.** Light oak floor and stair, warm white plaster, pale grey fabric, white kitchen fronts, brushed steel.
- Declined: "Japandi warm" (natural oak, beige lime plaster, oatmeal linen, walnut/black accents); "Modern contrast" (smoked dark oak, off-white walls, charcoal fabric, black frames).

**Q4. What light should the tour be set in?**
- Chosen: **Sunny afternoon.** Sun at about 35 to 40 degrees elevation, neutral to slightly warm, crisp sun patches through the windows.
- Declined: "Golden hour" (dramatic, warm cast, deep shadows); "Overcast daylight" (soft, flat, cheap); "Switchable time of day" (day/golden/night toggle, three HDRIs and a night rig: out of scope).

### Round 2: tour behaviour

**Q5. What should you see through the windows and from the balcony?**
- Chosen: **Upper-storey city view.** The apartment sits a few storeys up. An HDRI shot from an elevated or rooftop vantage is the backdrop, with a far ground plane below the balcony so looking down never shows a void.
- Declined: "Garden level" (ground-level nature HDRI, lawn, trees); "Abstract sky only" (no ground context, feels like floating).

**Q6. How should doors behave?**
- Chosen: **Auto-open on approach.** Door leaves swing open smoothly in their schema swing direction when the player is near, and close after the player leaves. The leaf is solid collision while it moves (the player gets pushed, never trapped).
- Declined: "Always open" (static leaves at 90 degrees); "Tap or press E to open" (extra control, more friction).

**Q7. What should the floor switch do?**
- Chosen: **Teleport to that floor.** Tapping the other floor fades out, moves the player to the stair landing on that floor facing into the plan, and fades back in. The minimap follows the player's floor.
- Declined: "Minimap preview only" (must walk stairs); "Both" (tap previews, a "Go there" button teleports).

**Q8. Which third-person avatar?**
- Chosen: **Arch-viz mannequin.** A neutral matte grey figure built from capsules (like scale figures in architectural renders), with a procedural idle sway and walk cycle (and a faster run cycle). No download, no licence questions.
- Declined: "CC0 glTF character" (e.g. Quaternius; lifelike clips but cartoony low-poly look); "Mannequin + glTF swap later" (avatar interface for a future glTF).

### Round 3: DXF import

**Q9. How should furniture on a DXF furniture layer turn into 3D?**
- Chosen: **Match to 3D pieces, else box.** Block names and layer names are matched by keyword, English and Arabic (bed, sofa, table, chair, wc, sink, bath, shower, counter, wardrobe, and so on), to the same procedural furniture pieces the demo uses, scaled to the block's extents and rotated to match. Unknown blocks become a neutral low volume in their footprint.
- Declined: "Neutral footprint volumes" (massing-model look); "Ignore DXF furniture" (rooms come in empty).

**Q10. What language should the interface be in?**
- Chosen: **English UI, Arabic-aware.** All UI strings in English. Arabic layer names and Arabic room labels from DXF files are detected, decoded and displayed correctly (Arabic-capable font fallback, right-to-left text inside labels).
- Declined: "English + Arabic toggle" (i18n table, full RTL HUD mirroring); "Arabic first, English toggle".

**Q11. Real DXF drawings to test against?**
- Chosen: **No, generated samples only.** The session generates the 3 required samples with a script. The clean layered sample is the demo apartment itself, so tests can round-trip DXF to schema and compare against the mock.
- Declined: "Yes, I'll add them first" (samples/real/, gitignored).

**Q12. How much editing should the validation screen allow before "Build scene"?**
- Chosen: **Settings + rooms.** The settings from the brief (wall thickness, ceiling height, units, tolerance), plus a room list where each room can be renamed and given a different floor material.
- Declined: "Settings only" (exactly the brief); "Settings + rooms + openings" (per door/window edits and deletion; more mobile UI).

### Round 4: assets, scope, repo

**Q13. Where should the demo apartment's furniture come from?**
- Chosen: **Procedural only.** Every piece (sofa, beds, dining table, chairs, kitchen run, bathroom fixtures, wardrobe, and so on) is built in code from rounded primitives with the PBR materials. It is the same library DXF furniture blocks map to (Q9).
- Declined: "Procedural + a few CC0 accents" (3 to 5 lazy-loaded Poly Haven models); "Mostly CC0 glTF models" (heavy, separate library).

**Q14. Rooms beyond the ones listed?** (multi-select)
- Chosen: **None, keep to the spec.** Exactly: entry hall, open living/kitchen, 2 bedrooms, bathroom, balcony, stair (plus the upper landing that the stair needs).
- Declined: "Guest WC on lower level", "Storage / utility closet", "Study nook on landing".

**Q15. How should the code be versioned?**
- Answered: "Private GitHub repo" (git init, MTulaimat/cad-tour, commit per milestone). **Superseded by Q17**, which made the repo public. Final: public GitHub repo `MTulaimat/cad-tour`.
- Declined: "Local git only", "No git".

**Q16. How should it be served for phone testing and sharing?**
- Answered: "just cloudflare pages" (free text). Follow-up below changed this.
- Options offered: "LAN HTTPS + Cloudflare Pages", "LAN HTTPS only", "LAN + Cloudflare quick tunnel".

### Round 5: hosting and process

**Q17a. "Who deploys?" (Cloudflare Pages follow-up)**
- Musab's answer (free text): "i dont understand the question, i just want this to be a simple web experience just like my other repo (gizmo) the 3d mode viewer". The planner checked gizmo: a public repo `MTulaimat/gizmo` served on GitHub Pages at `https://mtulaimat.github.io/gizmo/` from `main`, with a web manifest and icons (installable). Cloudflare is therefore dropped.

**Q17b. Host it like gizmo, on GitHub Pages?**
- Chosen: **GitHub Pages, public repo.** The repo `MTulaimat/cad-tour` is public. A GitHub Actions workflow builds the Vite app and publishes it to `https://mtulaimat.github.io/cad-tour/` on every push to `main`. No Cloudflare, no wrangler, no LAN HTTPS tooling.
- Declined: "GitHub Pages, private repo" (needs a paid GitHub plan); "Cloudflare Pages after all".
- **This overrides the brief's README item "testing on a real device over LAN (vite --host with HTTPS)".** The README's real-device section instead says: open the GitHub Pages URL on the phone, then install it as a PWA. Do not add basic-ssl, mkcert or any LAN HTTPS setup. Plain `npm run dev` and `npm run preview` stay as they are.

**Q18. When should changes go live?**
- Chosen: **Live as it goes.** After the initial scaffold, the build session pushes each finished milestone straight to `main`, so the site updates after every milestone. No PR. **Musab explicitly authorized pushing to main for this project.**
- Declined: "When I merge the PR" (build branch plus draft PR).

**Q19. How should the build be run?**
- Chosen: **One session, milestones.** One Opus session works through the milestones in section 5 in order, commits and pushes after each, and logs progress in section 7 so a fresh session can resume from the last finished milestone.
- Declined: "Two sessions: tour, then DXF"; "Bezier issues per milestone" (run through /worker).

**Q20. Besides Playwright, which real-browser checks?** (multi-select)
- Answered: no preference. Planner decided (stated to Musab): **Playwright viewport tests, plus real Android Chrome on the existing `Pixel_10_Pro` emulator via argent**, pointed at the local preview build through `adb reverse` (localhost is a secure context, so the service worker and wake lock work). No foldable emulator download, no phone over USB.
- Options that were offered: "Pixel 10 Pro emulator", "New foldable emulator" (multi-GB system image, live fold/unfold), "My Fold 7 over USB".

---

## 3. Planner decisions (stated to Musab, not asked; treat as settled)

- **P1. Stair schema holds flights and landings.** Real DXF stairs can be L or U shaped, so `stairs[]` stores an ordered list of straight flights (start point, direction vector, width, riser count, rise, going) and landings (polygons with elevation), plus the overall outline polygon, from/to floor ids. A straight stair is one flight plus a top landing. This extends the brief's "direction vector, step count, landing" without losing it.
- **P2. DXF stair detection** handles straight, L and U flights by grouping tread lines by orientation inside the stair outline. Anything else gets a warning in the validation report and a straight-flight fallback fitted to the outline's long axis.
- **P3. Binary DXF** is rejected with a clear message, the same way DWG is (dxf-parser reads ASCII DXF only). Suggested copy: "This DXF is saved in binary format. Save it as ASCII DXF (DXF 2013 ASCII) and try again."
- **P4. Text encoding.** Legacy code pages are decoded properly: read the file as bytes, sniff `$ACADVER` and `$DWGCODEPAGE`; for files older than AutoCAD 2007 (`AC1021`) decode with the declared code page (for example `ANSI_1256` as `windows-1256` for Arabic) using `TextDecoder`, otherwise UTF-8. Unescape MTEXT `\U+XXXX` sequences and strip MTEXT formatting codes.
- **P5. Start position.** The tour starts just inside the entrance door (a door on the outer boundary of the lowest floor), facing into the plan. If no entrance door is found, it starts at the centroid of the largest room on the lowest floor.
- **P6. Last plan.** The last built plan (as schema JSON) is kept on the device in IndexedDB, and the start screen offers "Continue" for it. Wrap storage access in try/catch; the app must work without it.
- **P7. Textures and download budget.** The initial download stays under 25 MB at whatever quality tier the device starts on (JS, fonts, HDRI, backplate and all textures for that tier). On desktop High only, 4K versions of the floor, wall and fabric textures stream in after the tour starts and do not count toward the 25 MB.
- **P8. Hosting copy.** No LAN HTTPS script. Device testing in the README goes through the GitHub Pages URL (see Q17b).
- **P9. Repo visibility.** Public (Q17b overrides Q15's "private").

---

## 4. Technical defaults (build to these; deviate only if blocked, and log the reason in section 7)

### Stack
- Vite + TypeScript (strict) + `three` (pin the latest stable release exactly). No UI framework: vanilla TS modules and CSS.
- `WebGLRenderer` (WebGL2), not WebGPU: the brief requires WebGL context loss/restore handling, and KTX2 and post-processing are mature there.
- Post-processing: `postprocessing` (pmndrs) for SMAA, bloom (mipmap blur), vignette and tone mapping in one merged pass; `n8ao` for ambient occlusion on High. Make sure tone mapping is applied exactly once (renderer tone mapping off when the composer applies ACES).
- `three-mesh-bvh` for fast raycasts (third-person camera collision, floor height checks).
- `vite-plugin-pwa` (Workbox) for the manifest and service worker.
- `dxf-parser` for DXF. Verify which entities it actually covers (HATCH in particular); add small custom handlers or a second library for whatever is missing, rather than dropping the requirement.
- Validation of imported plan JSON: a small schema validator (valibot or a hand-written guard). Keep bundle size in mind.
- Tests: Vitest for unit tests, Playwright for device emulation and walkthrough QA.
- App name: **CAD Tour** (page title, manifest name). Font: self-hosted Inter (OFL) variable woff2, with an Arabic-capable fallback (self-hosted Noto Sans Arabic subset, loaded only when Arabic text is present).

### Folder layout (modular, per the brief)
```
src/
  data/        schema.ts, mock.ts, loader.ts, planJson.ts (import/export + validation)
  data/dxf/    worker.ts, parse.ts, units.ts, layers.ts, walls.ts, openings.ts, rooms.ts,
               stairs.ts, furniture.ts, floors.ts, encoding.ts, report.ts
  geometry/    walls.ts, openings.ts, floors.ts, ceilings.ts, trim.ts, stairs.ts,
               furniture/ (procedural library + keyword registry), merge.ts
  materials/   library.ts (material keys -> PBR), textures.ts (KTX2 loading, tiers)
  lighting/    environment.ts, sun.ts, interior.ts, probes.ts
  render/      renderer.ts, post.ts, quality.ts (tiers, auto-detect, dynamic resolution)
  controls/    keyboard-mouse.ts, touch.ts (joystick + look), firstPerson.ts, thirdPerson.ts,
               avatar.ts (mannequin), transition.ts
  collision/   world.ts, capsule.ts, stairs.ts, doors.ts
  ui/          hud, minimap, start screen, loading, help, menu/settings, import flow screens
  app/         main.ts, state.ts, lifecycle.ts (resize, visibility, context loss, wake lock)
scripts/       fetch-textures, encode-textures, make-samples
samples/       clean-layered.dxf, single-line-walls.dxf, messy-layer0.dxf
public/        textures/, hdri/, icons/
tests/         unit (vitest) and e2e (playwright)
```
The renderer and geometry builders consume only `FloorPlan`. Nothing under `geometry/`, `render/`, `lighting/`, `controls/` or `collision/` may import from `data/mock.ts` or `data/dxf/`.

### Schema notes
- `schemaVersion: 1`, units always meters, a stable string `id` on every floor, wall, opening, room and stair (openings reference walls by id).
- Walls: centerline as `start`/`end` or a polyline, plus thickness and height. Openings: type `door | window`, wall id, offset along the wall (center), width, height, sill height, swing (`left | right`, `in | out`, or none for windows).
- Rooms: name, closed polygon, floor material key, optional ceiling height. Stairs as in P1. Furniture: type key, position, rotation (yaw), optional size (needed for DXF blocks scaled to extents).
- Floors: id, name, elevation, default ceiling height.

### Demo apartment (mock.ts)
- Layout per Q1, stair per Q2, rooms per Q14. 2.8 m ceilings, 3.0 m floor-to-floor, 0.20 m walls, 0.9 m doors (2.1 m high), 1.2 m windows (sill 0.9 m), balcony door can be a wider glazed door. About 110 m2 total.
- Open plan: model the kitchen and living/dining as two room polygons with no wall between them, so the room label still changes as you cross.
- Floor materials: oak in living, bedrooms, hall and landing; ceramic tile in the bathroom (and kitchen floor tile is acceptable); concrete on the balcony; oak stair.
- The balcony gets a glass or slim metal railing with collision.
- The stairwell opening on the upper floor gets a guard rail (or glass balustrade) with collision so the player cannot fall in.

### Look
- Textures: CC0 from Poly Haven or ambientCG matching the Scandinavian light palette (light oak plank floor, warm white painted plaster, light ceramic bathroom tile, concrete for the balcony, pale grey fabric, oak for the stair). Scripts in `scripts/` download them and encode KTX2; the encoded files are committed to `public/textures` so `npm install && npm run dev` needs no network or extra tools. Record every asset, author, licence and URL in `CREDITS.md`.
- Encoding: ETC1S for albedo and packed ORM (AO, roughness, metalness in one texture), UASTC + zstd for normal maps, mipmaps on, albedo flagged sRGB. Prefer a pure-npm encoder; if none works on Windows, download the official KTX-Software `toktx` release into a gitignored `tools/` folder from the script.
- Resolution sets: 1K (mobile Low/Medium), 2K (desktop Medium/High, mobile High), 4K hero upgrades (desktop High only, streamed after start, see P7).
- UVs in real-world meters everywhere (walls, floors, ceilings, stair, furniture), with a per-material texel scale, so tiling is correct and nothing stretches.
- Environment: a Poly Haven CC0 HDRI shot from an elevated or rooftop spot, clear to partly cloudy afternoon sky. Use a small HDR (1K) through PMREM for lighting and a separate tone-mapped background image (2K mobile, 4K desktop) for the view through the windows, so the view is sharp without a huge HDR download. Align the directional sun with the HDRI's sun (find the brightest region of the HDR) at about 35 to 40 degrees elevation.
- Exterior context per Q5: exterior wall faces in an exterior render material, slab edges, and a large far ground plane well below the apartment (about 4 storeys) blended into the backdrop so the balcony never looks over a void.
- Interior realism: outdoor HDRI light alone makes interiors look flat and over-bright. Capture a per-room environment probe once after the scene builds (CubeCamera at each room's centroid at about 1.4 m, then PMREM) and use it for that room's materials, with a lower environment intensity indoors. Combine with AO on High.
- Interior lights by tier: Low has none beyond environment and sun; Medium has a few unshadowed point lights; High adds ceiling `RectAreaLight`s per room. Cap the light count.
- Sun shadows: one shadow-casting directional light with its shadow camera fitted tightly to the current floor's bounds; map size 1024 on mobile, 2048 on desktop Medium, 4096 on desktop High; PCF soft.
- Glass: cheap transparent physical material (no transmission) on mobile; transmission allowed on desktop High only.
- Tone mapping ACES Filmic, sRGB output.

### Quality tiers
- Low: render scale cap 0.75, no post except FXAA, shadows 1024 or off, 1K textures.
- Medium (mobile default): DPR cap 2, render scale slider 0.5 to 1, shadow 1024, SMAA or FXAA only, no AO or bloom (or a very light bloom), 1K textures on mobile and 2K on desktop.
- High: AO (n8ao), subtle bloom, SMAA, light vignette, larger shadow maps, rect area lights, 2K textures, 4K hero upgrades on desktop.
- Auto: pick the tier from `navigator.deviceMemory`, `hardwareConcurrency`, coarse pointer, the unmasked GPU renderer string where available, and a short frame-time probe right after the first frames. Manual toggle Low / Medium / High / Auto, saved in localStorage.
- Dynamic resolution: an exponential moving average of frame time with hysteresis; lower the render scale when it exceeds 20 ms, raise it after a stable period under target. Resize post-processing buffers when the scale changes.

### Controls, collision, cameras
- Fixed physics timestep (1/120 s) with an accumulator, and render interpolation, so 60 Hz and 120 Hz displays move identically.
- Player: capsule radius about 0.25 m. 2D capsule vs wall segments (built from every wall's thickened outline, split around openings, plus door leaves, railings, balusters and furniture footprints), iterative push-out with wall sliding.
- Stairs: floor height comes from the schema analytically (height as a function of position along each flight, landings flat), not from noisy raycasts. Smooth the eye height with a critically damped spring so stair walking has no jitter. The upper-floor stair opening is cut from the upper slab and ceiling below.
- Doors per Q6: swing open with easing when the player is within about 1.2 m, close after about 2 s clear; the leaf collides while moving.
- First person: eye height 1.65 m, WASD, Shift to run, pointer lock mouse look on desktop.
- Third person: the mannequin (Q8) with procedural idle, walk and run; orbit follow camera that spherecasts (BVH) from the head to the desired position and pulls in on hit, and stays below the ceiling.
- V or the on-screen button toggles modes with a smooth camera transition (about 0.6 s, eased, collision-checked).
- Minimap: 2D canvas drawn from the `FloorPlan` (walls, openings, room names, stairs), player arrow with facing, and floor buttons that teleport per Q7 (fade out, move to the stair landing on that floor facing into the plan, fade in).

### Mobile, layout, lifecycle
- Layout classes from the real viewport size and aspect ratio (container and media queries plus a debounced ResizeObserver): cover screen (narrow and tall), near-square (Fold inner), phone portrait, landscape, tablet, desktop. Never hardcode 900x800.
- On resize or fold/unfold: update the renderer size, camera aspect and projection, composer buffers and HUD layout in place; player position, facing, floor, mode and settings are kept.
- Touch: floating joystick where the thumb lands in the left half, drag-to-look in the right half, pointers tracked by `pointerId`, sensitivity slider and invert-Y, left-handed setting that mirrors the zones and the corner buttons. Hit targets at least 48 px: mode toggle, floor switch, run, menu, fullscreen.
- `viewport-fit=cover`, `dvh`/`svh`, `env(safe-area-inset-*)`, `touch-action: none`, `overscroll-behavior: none`, `user-select: none`, `-webkit-touch-callout: none`, preventDefault on touch events on the canvas.
- Tap-to-start overlay (pointer lock on desktop only), Fullscreen button (hidden where unsupported), Screen Wake Lock requested on start and re-requested on `visibilitychange`.
- PWA: manifest (name "CAD Tour", display fullscreen, orientation any, icons), Workbox precache of the app shell, cache-first runtime caching for textures and HDRI. Vite `base` and the manifest `scope`/`start_url` set for `/cad-tour/` on GitHub Pages.
- Device Posture API and `viewport-segments` media features only as progressive enhancement (for example keeping HUD elements off a hinge segment).
- Draw calls under about 150: merge static geometry per material per floor, instance repeated pieces (treads, balusters, chairs). Build the lower floor first, start the tour, then build the upper floor and furniture in idle chunks and load upper-only textures after.
- Dispose geometry, materials, textures and render targets on plan switch. Handle `webglcontextlost` (preventDefault, overlay) and `webglcontextrestored` (rebuild render targets, PMREM and probes). Stop the render loop when the tab is hidden.
- A debug overlay behind `?debug` (fps, frame time, render scale, draw calls, tier) and a test hook (`window.__tour`) exposed only in dev and test builds, for Playwright to read and set player state.

### DXF import pipeline
- Flow: start screen ("Use demo apartment", "Open plan", "Continue" when a last plan exists) -> file pick or drop -> DWG/binary check -> worker parse with progress -> unit prompt if needed (live bounding-box size preview per unit) -> layer mapping screen (every layer, entity counts, role dropdown, toggles, 2D preview, floor assignment by drawn box or layer prefix) -> validation report (counts, total area, warnings, settings, room rename and material per Q12, Build scene) -> build -> tap to start. The menu during the tour has Open plan, Use demo apartment, Export plan JSON, Import plan JSON.
- Mapping memory: key by a SHA-256 of the file content, stored in localStorage (try/catch).
- Units: `$INSUNITS` 1 inches, 2 feet, 4 mm, 5 cm, 6 m; 0 or missing, or a plausibility failure (wider than 100 m or smaller than 3 m), triggers the unit prompt.
- Entities: compose INSERT transforms recursively (position, rotation, scale, nested blocks); handle OCS extrusion for 2D entities (at least the mirrored `0,0,-1` case, which is common in real files); ignore DIMENSION, viewports and paper space.
- Layer auto-detect keywords (case-insensitive), English: WALL, A-WALL, MUR; DOOR, A-DOOR; WIN, WINDOW, A-GLAZ; STAIR, A-STRS; FURN, A-FURN. Arabic: walls جدار جدران حوائط; doors باب أبواب; windows نافذة نوافذ شباك شبابيك; stairs درج سلم سلالم; furniture أثاث فرش.
- Walls: closed polylines and HATCH boundaries on wall layers are outlines (pair their opposite edges); parallel line pairs 5 to 40 cm apart with overlap give centerline and thickness; single lines get the default thickness (20 cm). Clean-up first: snap endpoints within the tolerance setting, remove duplicates and zero-length segments, merge collinear segments, close small gaps (below the smallest plausible opening, so door gaps are never closed by accident).
- Openings: from blocks (insertion point, rotation, width from block extents) or from swing arcs plus the gap they sit in; windows from window-layer lines or blocks in a wall gap. Snap each to the nearest wall within a tolerance, bridge the wall across the gap so the wall graph stays closed, then cut the opening. Defaults door 2.1 m, window sill 0.9 m and height 1.2 m, all overridable.
- Rooms: split wall centerlines at intersections into a planar graph, extract minimal faces (half-edge traversal), drop the outer face and slivers. Name from a TEXT/MTEXT label whose insertion point is inside the polygon (then nearest), else "Room 1, 2...". Default floor material by keyword, English and Arabic: bath/wc/toilet/حمام/دورة مياه -> tile; kitchen/مطبخ -> tile; balcony/terrace/شرفة/بلكونة/تراس -> concrete; bedroom/bed/غرفة نوم/نوم -> oak; everything else -> oak.
- Stairs per P2. Floor-to-floor height prompt, default 3 m. Cut the stair opening on the floor above.
- Multiple floors: assign by drawn selection boxes or layer prefix (L1_, L2_, ...). Align floors to each other by matching their stair outlines; if that fails, align bounding-box corners and add a warning.
- Furniture per Q9: keyword registry (English and Arabic: bed سرير, sofa كنبة/كنب, table طاولة, chair كرسي, wc/toilet مرحاض, sink/basin مغسلة, bath/tub بانيو, shower دش, counter/kitchen مطبخ, wardrobe خزانة/دولاب), scaled to block extents, unknown blocks become neutral footprint volumes.
- Never fail silently: any failure shows the reason and offers the demo apartment.
- Copy for the DWG case is exactly: "DWG isn't supported. Export as DXF (SAVEAS, DXF 2013 ASCII, or use ODA File Converter) and try again."

### Samples and tests
- `scripts/make-samples` writes three ASCII DXF (AC1027) files into `samples/`: `clean-layered.dxf` (the demo apartment, both floors side by side with `L1_` / `L2_` layer prefixes, door and window blocks, room labels, stair with tread lines and arrow), `single-line-walls.dxf` (centerline walls only, labels, arc-swing doors), `messy-layer0.dxf` (everything on layer 0, duplicates, tiny gaps, unitless header, an Arabic room label in a legacy code page).
- Vitest: unit detection, wall pairing, gap closing, opening snapping, room detection, plus a round-trip test (clean sample -> schema compares to the mock: same room count, areas within 2 percent, same opening count) and JSON export/import round trip.
- Playwright projects: "Z Fold 7 unfolded" (900x800, touch, mobile, Android Chrome UA, DPR about 2.4), "Z Fold 7 cover" (360x840), 412x915, 1024x768, 1280x800. Checks: no horizontal or vertical page overflow, every control fully inside the viewport and the safe area and at least 48 px, no overlapping controls, resizing mid-session (including 900x800 <-> 360x840 fold/unfold) keeps position, facing, floor and mode, two simultaneous touch pointers (joystick + look) both act. Run Chromium with a software GL flag if headless WebGL needs it.

---

## 5. Milestones (in order; after each: build, tests, commit, push to main, update section 7)

- **M0 Scaffold and hosting.** `git init`, `.gitignore`, Vite + TS strict + three, folder layout, Vitest and Playwright wired, `npm run dev | build | preview | test | test:e2e`. Create the public repo `MTulaimat/cad-tour` with `gh`, set Pages source to GitHub Actions, add the Pages workflow, set Vite `base` for `/cad-tour/`. Push to main and confirm `https://mtulaimat.github.io/cad-tour/` serves a placeholder.
- **M1 Data layer.** `schema.ts` (with P1), `mock.ts` (Q1, Q2, Q14), `loader.ts` (`loadPlan()` returns the mock; `parseDxf(file)` delegates to `data/dxf`, a stub until M6), plan JSON import/export with validation, unit tests for the mock's integrity (closed rooms, openings on walls, area about 110 m2).
- **M2 Geometry.** Walls with openings, frames, sills, glass, door leaves; floors and ceilings per room, skirting, ceiling trim; straight stair with treads, risers, stringers, handrail, upper-floor opening and guard rail; balcony railing; procedural furniture library with the keyword registry; merging and instancing. Placeholder materials are fine at this point.
- **M3 Look.** Texture fetch and encode scripts, KTX2 assets committed, `CREDITS.md`, material library with meter UVs, HDRI lighting and backplate, sun aligned to the HDRI, per-room probes, interior lights by tier, exterior context, tone mapping, post-processing and quality tiers.
- **M4 Controls, collision, cameras.** Fixed timestep, first person, third-person mannequin and follow camera with collision, V transition, wall collision with sliding, stair height smoothing, auto doors, minimap with floor teleport, room label updates.
- **M5 UI, mobile and PWA.** Start, loading, help (H), menu and settings, HUD, glass panels; touch controls and left-handed layout; responsive layout classes and live resize; fullscreen, wake lock, PWA; auto quality and dynamic resolution; lazy loading of the upper floor and furniture; context loss; pause when hidden; download budget check (P7).
- **M6 DXF import.** Worker pipeline, encoding (P4), units, layer mapping and 2D preview, walls, openings, rooms, stairs, floors, furniture, validation report with Q12 editing, JSON export/import, DWG and binary messages, last-plan Continue (P6), the three samples, and the unit tests.
- **M7 Tests and QA.** Playwright suite at all viewports. Walk every room on both floors on desktop and in mobile emulation (Playwright scripted walks with screenshots per room, a stair log of camera height per frame to prove no jitter), plus real Android Chrome on the `Pixel_10_Pro` emulator through argent (`adb reverse` to the preview server; touch, both thumbs, fullscreen, wake lock, PWA install). Fix clipping, z-fighting, texture stretching, stair jitter and touch conflicts. Import all three samples end to end. Final README.

README must cover: controls (desktop and touch), DXF import (how to prepare a DXF: ASCII DXF 2013, layers, units, labels, floors, what the report warns about), JSON export/import, texture credits (pointing to CREDITS.md), phone testing through the GitHub Pages URL, installing as a PWA, and the npm scripts.

---

## 6. Working rules

- Musab cannot answer questions mid-task. State assumptions, keep going, and record each one in section 7 "Assumptions and deviations".
- Do not reopen anything in sections 2 and 3. Section 4 is the default design; deviate only when blocked, and log why.
- Push every finished milestone straight to `main` (authorized by Musab, Q18); the site redeploys automatically. Commit in small, meaningful steps inside a milestone too. Never force-push.
- No em dashes in any UI copy (labels, toasts, messages, README UI strings, manifest). Rephrase instead.
- Text in rem/clamp(), minimum 14 px, high contrast over the 3D view.
- Everything must still run from a fresh clone with `npm install && npm run dev`, with no network fetches at runtime except the app's own files.
- When finished, report: the live URL, what was verified and how, known issues, and the assumptions list.

---

## 7. Progress log (build session fills this in)

| Milestone | Status | Commit | Notes |
|---|---|---|---|
| M0 Scaffold and hosting | done | 71ab5a8 | Public repo MTulaimat/cad-tour created, Pages source set to GitHub Actions, workflow runs unit tests then builds and deploys. Placeholder confirmed live at https://mtulaimat.github.io/cad-tour/ |
| M1 Data layer | done | see git log "M1" | `schema.ts` (P1 flights and landings), `mock.ts` (9.6 x 5.8 m footprint, two levels, 112 m2 of rooms including the 6 m2 balcony, straight 17-riser stair rising west along the south wall), `loader.ts`, `validate.ts` + `planJson.ts` (wrapped export, bare import, path-tagged errors). 14 unit tests: validation, rooms, areas, openings fit their walls, stair rise, furniture clear of walls, door swings clear of furniture, JSON round trip. |
| M2 Geometry | done | see git log "M2" | `src/plan/` (wall segments split at T junctions, mitered joins, interior/exterior face classification, exterior outline; stair flights, open sides, guard edges, ramp height). `src/geometry/`: walls with real opening cut-outs and reveals, window frames, glass, sills, architraves, hinged leaves and a sliding glass balcony door as animatable parts; floors and ceilings with the stairwell cut, stairwell slab edges, skirting and cornice; straight stair with treads, risers, stringers, spandrel, spindles, handrails; glass balcony and stairwell guards; 32-piece procedural furniture library plus the English/Arabic keyword registry; building mass below with slab bands and windows. 26 unit tests incl. face winding over every mesh, draw-call budget, clipping, registry. Screenshots reviewed at aerial and eye level. |
| M3 Look | done | see git log "M3" | 7 Poly Haven CC0 texture sets as KTX2 (ETC1S albedo/ORM, UASTC+zstd 1K normals, ETC1S 2K/4K normals), `CREDITS.md`, fetch/encode/HDRI scripts. Material library with meter UVs and palette tints. Rhodes Memorial HDRI: 1K HDR through PMREM for light (sun energy moved into the directional light), 2K/4K backplate as the sky. Sun aligned to the HDRI sun, shadow frustum fitted per floor with the whole building as depth range. Per-room cube probes with box-projected reflections. Interior point lights (Medium) and RectAreaLights (High) as fixed pools moved per floor. Exterior: facade mass below, ground 12 m down with low neighbouring blocks, streets and trees fading into the backplate. ACES once in post, sRGB out, exposure 3.0. Tiers: Low (FXAA, no probes), Medium (SMAA or FXAA, probes, light bloom on desktop), High (n8ao, bloom, SMAA, vignette, transmission glass and 4K hero textures on desktop). Download: 1K set + HDR + 2K backplate about 10 MB, 2K set + HDR + 4K backplate about 17 MB. Reviewed with headless screenshots of every room at Medium and High. Also contains the early M4 core (collision, session, cameras) because the interim app shell uses it. |
| M4 Controls, collision, cameras | done | see git log "M4" | Fixed 120 Hz physics with render interpolation; capsule (0.25 m) vs wall, rail, stair-side, furniture and door-leaf segments with height spans, iterative push-out with sliding; analytic stair height with a critically damped spring; auto doors (1.2 m, close after 2 s, never trap); first person 1.65 m with WASD, Shift, pointer lock; arch-viz mannequin with procedural idle/walk/run; orbit follow camera with a BVH ray-bundle sphere cast and ceiling-safe pull-in; 0.6 s eased V transition; minimap (cached floor drawing, player arrow and view cone, floor buttons) with fade teleport to the stair landing (Q7); room label with floor name. 8 collision unit tests plus 4 Playwright walkthrough tests in Chromium (door, stair with per-frame camera log, teleport, mode switch). Also contains most of the M5 app shell, which the walkthrough runs in. |
| M5 UI, mobile and PWA | not started | | |
| M6 DXF import | not started | | |
| M7 Tests and QA | not started | | |

### Assumptions and deviations

- **A1. Git worktree.** The build session runs as a background job whose edit guard requires an isolated git worktree. The project folder got `git init` and a first commit (this file), and the code is built in the linked worktree `.claude/worktrees/build` on branch `build` (gitignored). Every milestone is pushed with `git push origin build:main`, so `main` on GitHub (and the Pages site) is exactly as planned; the project folder's own `main` checkout is fast-forwarded to `origin/main` at the end.
- **A2. Toolchain versions.** Latest stable at build time, pinned exactly: three 0.186.1, postprocessing 6.39.5, n8ao 2.0.1, three-mesh-bvh 0.9.16, Vite 8.3.5, vite-plugin-pwa 2.0.0, Vitest 5.0.5, Playwright 1.64.1, TypeScript 7.0.2 (the native compiler), dxf-parser 1.1.2.
- **A3. Pages workflow runs the unit tests** before building, so a red test never deploys.
- **A4. Schema shape.** Walls, openings, rooms, furniture and railings are nested per floor; stairs sit at plan level because they join two floors. A wall's centerline is a point list (two points for start/end, more for a polyline), and openings give their center as an offset along it.
- **A5. Door swing encoding.** `swing = { hinge: 'start' | 'end', side: 'left' | 'right' }`, relative to the wall direction at the opening. This states the brief's "left/right, in/out" without needing to decide which room is "inside" for interior doors. Doors also carry `style: 'hinged' | 'sliding-glass' | 'passage'`; the balcony door is a 2.0 m sliding glass door.
- **A6. Room polygons follow wall centerlines** (as DXF room detection produces them), so room areas are gross areas. Rooms have `outdoor: true` for the balcony (no ceiling, exterior wall finish).
- **A7. Explicit railings.** `Floor.railings` holds balcony railings (and any other guard); stairwell guards are derived from the stair outline at build time so DXF imports get them for free.
- **A8. Demo layout specifics.** The stair climbs west along the south wall from the living room to the upper landing; the space under its high end is closed off (no storage room, per Q14). Entrance door on the south wall of the hall, hall to living through a door, kitchen open to the living room (two room polygons, no wall). Upstairs: landing with the stairwell, bedroom 2 and bathroom off the landing, bedroom 1 (main, about 20 m2) across the east side.
- **A9. Shared plan analysis lives in `src/plan/`** (walls, stairs), a folder not in the section 4 layout. Geometry, collision and the minimap all read the same derived data, and it depends only on the schema.
- **A10. Merged rather than instanced.** Static pieces (treads, spindles, chairs) are merged per material per floor instead of using `InstancedMesh`. The draw call count is the same or lower (about 60 for the whole flat) and merged meshes feed the BVH for camera collision directly.
- **A11. The living room polygon runs under the stair** (it is the region the walls enclose, which is what DXF room detection produces). The stair outline is cut from the ceiling, and walking height inside the stair footprint comes from the flight, so the overlap is harmless.
- **A12. Shadows use `PCFShadowMap` with `shadow.radius`.** three r186 removed `PCFSoftShadowMap`; its PCF path now does soft Vogel-disk filtering controlled by the radius.
- **A13. HDRI: Poly Haven `rhodes_memorial`.** An elevated terrace over Cape Town with a crisp, partly cloudy sky. Its sun sits at 29.8 degrees, a little under the 35 to 40 asked for in Q4: the sun was measured in every sunny urban and hilltop HDRI on Poly Haven and none combines an elevated city view with a sun at 35 to 50 degrees (`homecoming_center_rooftop` has the best skyline but a 69 degree midday sun). The sun disc's energy was clamped out of the 1K HDR and moved into the directional light, so shadowed areas are not washed out. The sky is turned 100 degrees (sun turned with it) so the city is out of the balcony and the sun comes through the north windows.
- **A14. No grounded skybox.** The HDRI's lower half is the memorial terrace with lion statues, which reads as standing on a terrace, not four storeys up. The backplate is the plain sky and distant city; the near ground is our own geometry 12 m down (streets, lawns, trees, 2 to 4 storey neighbouring blocks below eye level) whose far edge fades into the backplate in the same view direction. This keeps Q5's "upper-storey city view, never a void".
- **A15. Per-room probes without extra draw calls.** Merged floor meshes mix rooms, so each triangle carries a `probeSlot` attribute (the room it faces) and the standard material's environment lookup is patched to pick that room's probe, box projected for reflections. Up to 6 probes per floor, one material set per floor. Low has no probes (sky environment only).
- **A16. Texture encoding.** 2K and 4K normal maps are ETC1S rather than UASTC: UASTC with RDO was up to 3.8 MB per 2K map and broke the download budget; ETC1S measured close in quality. The app raises normal strength by 1.3 on those sets. The Basis transcoder is the one three r186's KTX2Loader bundles itself (hashed assets), not a copy in `public/`.
- **A17. Palette tints.** The scans are tinted in the material library to reach Q3's Scandinavian light look: oak (scan sRGB 155,128,99) lifted to about 195,170,140, the beige tile moved to a light warm grey and turned 45 degrees into a straight grid, furniture veneer and linen brightened.
- **A18. Exposure.** The HDRI is in its own dim units with the sun split out, so the interior is exposed at 3.0 (ACES applied once in post, renderer tone mapping off); the backplate gets `backgroundIntensity = 1 / exposure` because it was graded for exposure 1.
- **A19. Two library pitfalls fixed.** postprocessing's composer turns `renderer.autoClear` off, so probe captures force it on (otherwise only the first cube face had valid depth). n8ao must only be resized by the composer (drawing-buffer pixels); resizing it with CSS pixels caused ghosting.
- **A20. Stair walking height is a ramp through the tread centres**, not a per-step snap: it starts half a tread before the first riser and ends half a tread past the last, so the camera glides with no jitter (the walkthrough test logs every frame and sees no drops). The mannequin's feet can be up to half a riser (9 cm) off a tread.
- **A21. Desktop mouse.** Clicking Start captures the mouse (pointer lock). Esc releases it without pausing: the HUD stays clickable, keys still move you, a click on the view captures the mouse again, and a second Esc opens the menu. (A blocking "click to continue" screen would make the HUD unreachable by mouse.)
- **A22. Doors never trap.** A leaf that would push the player into a wall waits where it is until the player moves; it is solid at every angle.
- **A23. Third-person camera collision** casts a five-ray bundle (centre plus four offsets at 0.2 m), a cheap stand-in for a sphere cast on the three-mesh-bvh accelerated meshes; it pulls in instantly and eases back out. Glass and rugs are not colliders.
