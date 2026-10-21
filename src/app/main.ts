import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadPlan } from '../data/loader';
import { buildExteriorGeometry, buildFloorGeometry } from '../geometry';
import { floorObjects, meshesFor } from '../geometry/merge';
import { MaterialLibrary } from '../materials/library';

// Milestone M2 geometry viewer. The full app shell replaces this in later milestones.

const app = document.getElementById('app')!;
document.body.style.margin = '0';
document.body.style.background = '#1b1d21';
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;
app.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color('#b8c7d6');
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
scene.add(new HemisphereLight('#dfe9f5', '#8a7d6c', 0.6));
const sun = new DirectionalLight('#fff4e6', 2.6);
sun.position.set(14, 12, 9);
sun.target.position.set(5, 0, -3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.5, far: 60 });
sun.shadow.bias = -0.0004;
sun.shadow.radius = 3;
scene.add(sun, sun.target);

const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 500);
camera.position.set(4.8, 16, 8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(4.8, 0, -2.9);

const materials = new MaterialLibrary();
const params = new URLSearchParams(location.search);

const plan = await loadPlan();
const floors = plan.floors.map((_, i) => floorObjects(buildFloorGeometry(plan, i), materials.get));
for (const f of floors) scene.add(f.root);
scene.add(meshesFor(buildExteriorGeometry(plan, 12), materials.get, 'exterior'));

/** Dollhouse view: hide ceilings and the floors above `level`. */
function cutaway(level: number) {
  floors.forEach((f, i) => {
    f.root.visible = i <= level;
    f.shell.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.userData.materialKey === 'ceiling') m.visible = false;
    });
  });
}

const api = {
  plan,
  floors,
  camera,
  controls,
  cutaway,
  setView(px: number, py: number, pz: number, tx: number, ty: number, tz: number, fov = 60) {
    camera.position.set(px, py, pz);
    controls.target.set(tx, ty, tz);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    controls.update();
  },
  openDoors(amount: number) {
    for (const f of floors) for (const d of f.doors) d.set(d.def.kind === 'hinged' ? amount * d.def.maxOpen : amount * d.def.maxOpen);
  },
  info() {
    let calls = 0;
    scene.traverse((o) => {
      if ((o as Mesh).isMesh && o.visible) calls++;
    });
    return { meshes: calls, render: renderer.info.render };
  },
};
(window as unknown as { __view: typeof api }).__view = api;

const level = params.get('level');
if (level !== null) cutaway(Number(level));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
document.body.dataset.ready = '1';
