import {
  Box3,
  Timer,
  Color,
  Group,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  type Mesh,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import type { FloorPlan } from '../data/schema';
import { buildExteriorGeometry, buildFloorGeometry, type FloorBuild } from '../geometry';
import { disposeGroup, floorObjects, meshesFor, type FloorObjects } from '../geometry/merge';

/** Resolves in the next idle slot (or soon, where requestIdleCallback is missing). */
const idle = () =>
  new Promise<void>((r) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => r(), { timeout: 120 });
    else setTimeout(r, 16);
  });
import { MaterialLibrary } from '../materials/library';
import { applyTextureSets, disposeTextureSets, loadManifest, loadTextureSets, usedSets, type TextureSet, type TextureSetInfo } from '../materials/textures';
import { loadEnvironment, type Environment } from '../lighting/environment';
import { buildGround } from '../lighting/ground';
import { InteriorLights } from '../lighting/interior';
import {
  assignProbeSlots,
  createProbeUniforms,
  patchMaterialForProbes,
  ProbeCapture,
  probeRooms,
  setProbeSlot,
  type FloorProbeUniforms,
  type ProbeRoom,
} from '../lighting/probes';
import { Sun } from '../lighting/sun';
import { PostPipeline } from '../render/post';
import { DynamicResolution, tierConfig, type Tier, type TierConfig } from '../render/quality';
import { createRenderer } from '../render/renderer';
import { pointInPolygon } from '../util/math2d';

/** Ground level under the apartment, about four storeys down (Q5). */
export const GROUND_DEPTH = 12;
/** Extra lift on the backplate relative to its exposure-1 grade. */
const BACKPLATE_GAIN = 1.0;

export interface LoadProgress {
  (fraction: number, label: string): void;
}

interface FloorRuntime {
  objects: FloorObjects;
  lib: MaterialLibrary;
  probes: FloorProbeUniforms;
  rooms: ProbeRoom[];
  bounds: Box3;
}

/**
 * The 3D side of the app: renderer, scene, post chain, lighting and the built plan.
 * Controllers (first and third person) drive `camera`; the tour renders and keeps itself sized.
 */
export class Tour {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(70, 1, 0.05, 800);
  readonly sun = new Sun();
  post: PostPipeline;
  config: TierConfig;
  readonly dyn: DynamicResolution;

  plan: FloorPlan | null = null;
  floors: FloorRuntime[] = [];
  private exterior: Group | null = null;
  private context: Group | null = null;
  private exteriorLib = new MaterialLibrary();
  private env: Environment | null = null;
  private manifest: TextureSetInfo[] | null = null;
  private textures = new Map<string, TextureSet>();
  private lights: InteriorLights | null = null;
  private capture: ProbeCapture | null = null;
  private currentFloor = -1;
  /** A floor the player reached before it was built; it becomes current once it is. */
  private wantedFloor = -1;
  private heroLoaded = false;
  private pending: number[] = [];
  private building = false;
  private buildingFloor = -1;
  private floorWaiters = new Map<number, (() => void)[]>();
  private loadToken = 0;
  private width = 1;
  private height = 1;
  private timer = new Timer();
  private running = false;
  /** Called every frame before rendering, with the frame delta in seconds. */
  onUpdate: ((dt: number) => void) | null = null;
  /** Objects hidden while probes are captured (the avatar). */
  probeHidden: Object3D[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    tier: Tier,
    mobile: boolean,
  ) {
    this.renderer = createRenderer(canvas);
    // The HDRI is in its own (dim) units with the sun split out into the directional light;
    // expose for the interior, as an architectural photographer would.
    this.renderer.toneMappingExposure = 3.0;
    this.config = tierConfig(tier, mobile);
    this.dyn = new DynamicResolution(this.config.minScale, this.config.maxScale);
    this.scene.background = new Color('#cfd8e2');
    this.scene.add(this.sun.light, this.sun.target);
    this.sun.configure(this.config);
    this.post = new PostPipeline(this.renderer, this.scene, this.camera, this.config);
    this.camera.position.set(5, 1.65, -1);
  }

  get floorIndex(): number {
    return this.currentFloor;
  }

  /**
   * Builds a plan: the lowest floor first (with lighting and probes), so the tour can start;
   * the other floors follow in idle time through `buildRemaining`.
   */
  async load(plan: FloorPlan, onProgress: LoadProgress = () => {}): Promise<void> {
    this.unload();
    const token = ++this.loadToken;
    this.plan = plan;
    const cfg = this.config;
    onProgress(0.02, 'Loading environment');
    const base = import.meta.env.BASE_URL;
    const envP = this.env
      ? Promise.resolve(this.env)
      : loadEnvironment(
          this.renderer,
          { hdr: `${base}hdri/env-1k.hdr`, backplate: `${base}hdri/backplate-${cfg.backplate}.jpg`, sun: `${base}hdri/sun.json` },
          (_part, f) => onProgress(0.02 + f * 0.2, 'Loading environment'),
        );
    const texP = (async () => {
      this.manifest ??= await loadManifest().catch(() => []);
      if (this.textures.size === 0) {
        this.textures = await loadTextureSets(this.renderer, this.manifest, usedSets(), cfg.textureRes, cfg.anisotropy, (f) =>
          onProgress(0.25 + f * 0.45, 'Loading materials'),
        );
      }
    })();

    // The lowest floor's geometry builds while the downloads run.
    const order = plan.floors.map((f, i) => ({ i, e: f.elevation })).sort((a, b) => a.e - b.e);
    const first = order[0].i;
    const firstBuild = buildFloorGeometry(plan, first);

    const [env] = await Promise.all([envP, texP]);
    if (token !== this.loadToken) return;
    this.env = env;
    this.scene.environment = env.envMap;
    this.scene.environmentIntensity = 1.0;
    this.scene.environmentRotation.set(0, env.rotation, 0);
    this.scene.background = env.backplate;
    this.scene.backgroundRotation.set(0, env.rotation, 0);
    // The backplate is graded for exposure 1 through ACES; undo the interior exposure for it.
    this.scene.backgroundIntensity = BACKPLATE_GAIN / this.renderer.toneMappingExposure;
    this.sun.setDirection(env.sun.direction);
    this.sun.light.intensity = env.sun.intensity;
    this.sun.light.color.set(env.sun.color);
    onProgress(0.75, 'Building rooms');

    this.addFloor(plan, first, firstBuild);

    this.exterior = meshesFor(buildExteriorGeometry(plan, GROUND_DEPTH), this.exteriorLib.get, 'exterior');
    applyTextureSets(this.exteriorLib, this.textures);
    this.scene.add(this.exterior);
    const fb = this.floors[first].bounds;
    const center = fb.getCenter(new Vector3());
    const size = fb.getSize(new Vector3());
    this.context = buildGround(
      {
        groundY: plan.floors.reduce((m, f) => Math.min(m, f.elevation), 0) - GROUND_DEPTH,
        backplate: env.backplate,
        rotation: env.rotation,
        intensity: this.scene.backgroundIntensity,
        center,
        clearRadius: Math.hypot(size.x, size.z) / 2,
      },
      this.exteriorLib.get('wall-exterior') as MeshStandardMaterial,
      this.exteriorLib.get('facade-glass') as MeshStandardMaterial,
    );
    this.scene.add(this.context);

    this.lights?.dispose();
    this.lights = new InteriorLights(cfg.pointLights, cfg.rectLights);
    this.scene.add(this.lights.group);
    this.setFloor(first, true);

    onProgress(0.9, 'Lighting rooms');
    await new Promise((r) => setTimeout(r, 0));
    this.captureProbes();
    this.pending = order.slice(1).map((o) => o.i);
    onProgress(1, 'Ready');
  }

  /** Builds the floors that `load` deferred, one per idle slot, then relights every room. */
  async buildRemaining(onAdded: (objects: FloorObjects) => void = () => {}): Promise<void> {
    const token = this.loadToken;
    const plan = this.plan;
    if (!plan) return;
    this.building = true;
    try {
      while (this.pending.length > 0) {
        await idle();
        if (token !== this.loadToken) return;
        const i = this.pending.shift()!;
        this.buildingFloor = i;
        const build = buildFloorGeometry(plan, i);
        await idle();
        if (token !== this.loadToken) return;
        onAdded(this.addFloor(plan, i, build));
        if (this.wantedFloor === i) this.setFloor(i, true);
        for (const done of this.floorWaiters.get(i) ?? []) done();
        this.floorWaiters.delete(i);
      }
      // Probes again, now that stairwells see the floors above and below.
      this.setFloor(this.currentFloor, true);
      this.captureProbes();
    } finally {
      if (token === this.loadToken) {
        this.building = false;
        this.buildingFloor = -1;
        // Nothing else is coming (also after a failed build): never leave a floor switch waiting.
        for (const list of this.floorWaiters.values()) for (const done of list) done();
        this.floorWaiters.clear();
      }
    }
  }

  get loadingFloors(): boolean {
    return this.building || this.pending.length > 0;
  }

  /** Resolves once floor `index` is built (at once when it already is). */
  whenFloorBuilt(index: number): Promise<void> {
    const coming = this.pending.includes(index) || this.buildingFloor === index;
    if (this.floors[index] || !this.plan || !coming) return Promise.resolve();
    return new Promise((resolve) => this.floorWaiters.set(index, [...(this.floorWaiters.get(index) ?? []), resolve]));
  }

  private addFloor(plan: FloorPlan, i: number, build: FloorBuild): FloorObjects {
    const floor = plan.floors[i];
    const lib = new MaterialLibrary();
    const probes = createProbeUniforms();
    const objects = floorObjects(build, lib.get);
    const rooms = this.config.probes ? probeRooms(floor) : [];
    // Tag every triangle with the room it faces, then patch the floor's materials.
    objects.root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      if (m.parent === objects.shell || m.parent === objects.furniture) assignProbeSlots(m.geometry, rooms, floor);
    });
    for (const d of objects.doors) {
      const room = rooms.find((r) => pointInPolygon(d.def.center, r.polygon)) ?? rooms[0];
      for (const c of d.group.children) setProbeSlot((c as Mesh).geometry, room ? room.slot : 0);
    }
    applyTextureSets(lib, this.textures);
    this.tuneGlass(lib);
    for (const [, mat] of lib.all()) patchMaterialForProbes(mat, probes);
    this.scene.add(objects.root);
    const bounds = new Box3().setFromObject(objects.shell);
    this.floors[i] = { objects, lib, probes, rooms, bounds };
    return objects;
  }

  /**
   * P7: on desktop High, 4K floor, wall and fabric maps stream in after the tour starts
   * (outside the initial download budget) and replace the 2K ones in place.
   */
  async upgradeHeroTextures(): Promise<number> {
    if (!this.config.heroTextures || !this.manifest || this.heroLoaded) return 0;
    this.heroLoaded = true;
    const hero = ['oak', 'plaster', 'fabric'].filter((k) => this.manifest!.some((m) => m.key === k && m.resolutions.includes('4k')));
    const sets = await loadTextureSets(this.renderer, this.manifest, hero, '4k', this.config.anisotropy);
    const old = new Map<string, TextureSet>();
    for (const [k, set] of sets) {
      const prev = this.textures.get(k);
      if (prev) old.set(k, prev);
      this.textures.set(k, set);
    }
    for (const f of this.floors) if (f) applyTextureSets(f.lib, sets);
    applyTextureSets(this.exteriorLib, sets);
    disposeTextureSets(old);
    return sets.size;
  }

  private tuneGlass(lib: MaterialLibrary): void {
    const glass = lib.get('glass') as MeshPhysicalMaterial;
    if (this.config.transmissionGlass) {
      glass.transmission = 1;
      glass.thickness = 0.01;
      glass.ior = 1.5;
      glass.roughness = 0.02;
      glass.opacity = 1;
      glass.transparent = false;
      glass.depthWrite = true;
    } else {
      glass.transmission = 0;
      glass.opacity = 0.14;
      glass.transparent = true;
      glass.depthWrite = false;
    }
    glass.needsUpdate = true;
  }

  /** After a WebGL context restore: rebuild the environment, post buffers and probes. */
  async restoreContext(): Promise<void> {
    if (this.env) {
      this.scene.environment = this.env.regenerate(this.renderer);
      this.env.backplate.needsUpdate = true;
    }
    this.post.rebuild(this.config);
    this.applySize();
    this.captureProbes();
  }

  /** Re-captures every floor's probes (after loading, a tier change or a context restore). */
  captureProbes(): void {
    if (!this.env || !this.config.probes) {
      for (const f of this.floors) if (f) f.probes.probesOn.value = 0;
      return;
    }
    this.capture?.dispose();
    this.capture = new ProbeCapture(this.renderer, this.env.cubeSize);
    // Light every floor's rooms while capturing so stairwells see lit neighbours.
    const saved = this.currentFloor;
    const wanted = this.wantedFloor;
    for (let i = 0; i < this.floors.length; i++) {
      const f = this.floors[i];
      if (!f) continue;
      this.setFloor(i, true);
      this.capture.capture(this.scene, f.rooms, f.probes, this.probeHidden);
    }
    this.setFloor(saved, true);
    this.wantedFloor = wanted;
  }

  /** The player's floor drives the shadow fit and where the interior light pools go. */
  setFloor(index: number, force = false): void {
    if (!this.plan || (!force && index === this.currentFloor)) return;
    const f = this.floors[index];
    this.wantedFloor = f ? -1 : index;
    if (!f) return;
    this.currentFloor = index;
    const all = new Box3();
    for (const fl of this.floors) if (fl) all.union(fl.bounds);
    const fitted = f.bounds.clone();
    this.sun.fitTo(fitted, all);
    this.lights?.placeFor(this.plan.floors[index]);
  }

  /** Which floor a world height belongs to (nearest floor surface at or below, with slack). */
  floorAtHeight(y: number): number {
    if (!this.plan) return 0;
    let best = 0;
    let bestE = -Infinity;
    this.plan.floors.forEach((f, i) => {
      if (f.elevation <= y + 0.6 && f.elevation > bestE) {
        best = i;
        bestE = f.elevation;
      }
    });
    return best;
  }

  setTier(tier: Tier, mobile: boolean): void {
    const prev = this.config;
    this.config = tierConfig(tier, mobile);
    this.dyn.setBounds(this.config.minScale, this.config.maxScale);
    this.sun.configure(this.config);
    this.post.rebuild(this.config);
    for (const f of this.floors) if (f) this.tuneGlass(f.lib);
    if (prev.pointLights !== this.config.pointLights || prev.rectLights !== this.config.rectLights) {
      this.lights?.dispose();
      this.lights = new InteriorLights(this.config.pointLights, this.config.rectLights);
      this.scene.add(this.lights.group);
      if (this.plan && this.currentFloor >= 0) this.lights.placeFor(this.plan.floors[this.currentFloor]);
    }
    if (prev.probes !== this.config.probes) this.captureProbes();
    this.applySize();
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.applySize();
  }

  get pixelRatio(): number {
    return Math.min(devicePixelRatio || 1, this.config.dprCap) * this.dyn.scale;
  }

  private applySize(): void {
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.post.setSize(this.width, this.height);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  get isRunning(): boolean {
    return this.running;
  }

  private frame(): void {
    // performance.now() throughout, like reset(): the rAF timestamp is the frame's start time and
    // can be earlier than a reset made during the previous frame, which gave negative deltas.
    this.timer.update();
    const dt = Math.min(0.1, Math.max(0, this.timer.getDelta()));
    this.onUpdate?.(dt);
    if (this.dyn.update(dt * 1000)) this.applySize();
    this.post.render(dt);
  }

  /** One frame on demand (tests, screenshots). */
  renderOnce(): void {
    this.post.render(0.016);
  }

  stats(): { calls: number; triangles: number; textures: number; geometries: number; scale: number; frameMs: number } {
    const i = this.renderer.info;
    return {
      calls: i.render.calls,
      triangles: i.render.triangles,
      textures: i.memory.textures,
      geometries: i.memory.geometries,
      scale: this.dyn.scale,
      frameMs: this.dyn.frameTime,
    };
  }

  /** Drops the current plan's objects (keeps environment and textures for the next plan). */
  unload(): void {
    for (const f of this.floors) {
      if (!f) continue;
      this.scene.remove(f.objects.root);
      disposeGroup(f.objects.root);
      for (const d of f.objects.doors) d.dispose();
      f.lib.dispose();
    }
    this.floors = [];
    if (this.exterior) {
      this.scene.remove(this.exterior);
      disposeGroup(this.exterior);
      this.exterior = null;
    }
    if (this.context) {
      this.scene.remove(this.context);
      (this.context.userData.dispose as () => void)?.();
      this.context = null;
    }
    this.exteriorLib.dispose();
    this.exteriorLib = new MaterialLibrary();
    this.capture?.dispose();
    this.capture = null;
    this.currentFloor = -1;
    this.wantedFloor = -1;
    this.pending = [];
    this.building = false;
    this.buildingFloor = -1;
    for (const list of this.floorWaiters.values()) for (const done of list) done();
    this.floorWaiters.clear();
    this.loadToken++;
    this.plan = null;
  }

  dispose(): void {
    this.stop();
    this.unload();
    this.lights?.dispose();
    disposeTextureSets(this.textures);
    this.env?.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }

  /** World position helper for plan points. */
  static world(x: number, y: number, h: number): Vector3 {
    return new Vector3(x, h, -y);
  }
}
