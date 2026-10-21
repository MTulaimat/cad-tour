// Dev helper: renders what a room probe's cube camera sees (six faces) into a PNG strip.
// Usage: node scripts/probe-dump.mjs <floorIndex> <slot> <out.png>
import { chromium } from '@playwright/test';

const [fi = '1', slot = '4', out = 'qa-output/probe.png', px, py, pz] = process.argv.slice(2);
const at = px !== undefined ? [Number(px), Number(py), Number(pz)] : null;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => console.log(`[${m.type()}]`, m.text().slice(0, 200)));
await page.goto('http://localhost:5173/cad-tour/?quality=medium');
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240000 });
const dataUrl = await page.evaluate(
  async ([fi, slot, at, useTourCam]) => {
    const { tour } = window.__tour;
    tour.stop();
    tour.renderer.autoClear = true;
    const three = await import('/cad-tour/node_modules/.vite/deps/three.js');
    const f = tour.floors[fi];
    const room = f.rooms.find((r) => r.slot === slot);
    const size = 128;
    const rt = new three.WebGLRenderTarget(size, size, { type: three.UnsignedByteType });
    const cam = useTourCam ? tour.camera : new three.PerspectiveCamera(90, 1, 0.05, 200);
    if (useTourCam) {
      cam.fov = 90;
      cam.aspect = 1;
      cam.updateProjectionMatrix();
    }
    if (at) cam.position.set(at[0], at[1], at[2]);
    else cam.position.copy(room.position);
    const dirs = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const canvas = document.createElement('canvas');
    canvas.width = size * 6;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const buf = new Uint8Array(size * size * 4);
    for (let k = 0; k < 6; k++) {
      const d = dirs[k];
      cam.up.set(0, Math.abs(d[1]) > 0.5 ? 0 : 1, Math.abs(d[1]) > 0.5 ? -1 : 0);
      cam.lookAt(cam.position.x + d[0], cam.position.y + d[1], cam.position.z + d[2]);
      cam.updateMatrixWorld();
      tour.renderer.setRenderTarget(rt);
      tour.renderer.render(tour.scene, cam);
      tour.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const s = ((size - 1 - y) * size + x) * 4;
          const t = (y * size + x) * 4;
          for (let c = 0; c < 3; c++) img.data[t + c] = Math.min(255, Math.pow(buf[s + c] / 255, 1 / 2.2) * 255 * 1.8);
          img.data[t + 3] = 255;
        }
      ctx.putImageData(img, k * size, 0);
    }
    tour.renderer.setRenderTarget(null);
    return { url: canvas.toDataURL('image/png'), pos: room.position.toArray(), room: room.roomId };
  },
  [Number(fi), Number(slot), at, !!process.env.USE_TOUR_CAM],
);
console.log(dataUrl.room, dataUrl.pos);
const fs = await import('node:fs');
fs.writeFileSync(out, Buffer.from(dataUrl.url.split(',')[1], 'base64'));
await browser.close();
