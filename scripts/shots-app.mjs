// Dev helper: screenshots of the full app (HUD included) in the tour at several viewports.
// Usage: node scripts/shots-app.mjs [baseUrl] [outDir] [quality] [prefix] [views,comma] [sizes,comma]
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5173/cad-tour/';
const outDir = process.argv[3] ?? 'qa-output';
const quality = process.argv[4] ?? 'medium';
const prefix = process.argv[5] ?? 'app';
const onlyViews = process.argv[6] && process.argv[6] !== 'all' ? process.argv[6].split(',') : null;
const onlySizes = process.argv[7] && process.argv[7] !== 'all' ? process.argv[7].split(',') : null;
const deg = Math.PI / 180;
const sizes = [
  ['desktop', 1280, 800, false, 1],
  ['fold', 900, 800, true, 2.4],
  ['cover', 360, 840, true, 3],
  ['phone', 412, 915, true, 2.6],
  ['tablet', 1024, 768, true, 1],
];
// [name, x, y, feet, yaw (deg), pitch (deg), mode, frames]
const views = [
  // 'start' keeps the spawn the tour chose (take it first).
  ['start', null, null, null, null, null, null, 6],
  ['corner', 1.0, 4.9, 3, 45, 0, 'first', 8],
  // Room walk (M7): one view per room on both floors.
  ['r-entry', 0.84, 1.2, 0, -55, -4, 'first', 6],
  ['r-living', 8.9, 1.0, 0, 70, -6, 'first', 6],
  ['r-kitchen', 5.4, 3.2, 0, 60, -10, 'first', 6],
  ['r-dining', 9.0, 4.6, 0, 95, -8, 'first', 6],
  ['r-stair', 7.6, 2.3, 0, 105, 8, 'first', 6],
  ['r-balcony', 10.6, 1.9, 0, 30, -6, 'first', 6],
  ['r-landing', 0.9, 1.7, 3, -95, -18, 'first', 6],
  ['r-bedroom1', 6.6, 0.7, 3, -40, -8, 'first', 6],
  ['r-bedroom2', 3.0, 2.8, 3, 40, -8, 'first', 6],
  ['r-bathroom', 4.5, 2.8, 3, 0, -12, 'first', 6],
  ['living', 8.9, 1.0, 0, 70, -6, 'first', 4],
  ['third', 7.8, 3.9, 0, 120, -10, 'third', 12],
  ['bedroom', 6.6, 0.7, 3, -40, -8, 'first', 4],
  ['door', 2.9, 2.0, 0, -90, -4, 'first', 18],
  ['third-hall', 2.3, 1.9, 0, -90, -8, 'third', 14],
  ['third-stair', 4.0, 0.6, 1.6, 90, -5, 'third', 14],
];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const [sname, w, h, touch, dpr] of sizes) {
  if (onlySizes && !onlySizes.includes(sname)) continue;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: dpr });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('[error]', m.text().slice(0, 300)));
  await page.goto(`${base}?demo&autostart&quality=${quality}`);
  await page.waitForFunction(() => window.__tour?.session && !document.querySelector('[data-testid=hud]').hidden, null, { timeout: 300_000 });
  // The upper floors build in the background after the first one; wait so every view has them.
  await page.waitForFunction(() => !window.__tour.tour.loadingFloors, null, { timeout: 300_000 });
  for (const [name, x, y, feet, yaw, pitch, mode, frames] of views) {
    if (onlyViews && !onlyViews.includes(name)) continue;
    if (x !== null) await page.evaluate(([x, y, feet, yaw, pitch, mode]) => window.__tour.setState({ x, y, feet, yaw, pitch, mode }), [x, y, feet, yaw * deg, pitch * deg, mode]);
    await page.evaluate((n) => window.__tour.still(n), frames);
    await page.screenshot({ path: `${outDir}/${prefix}-${sname}-${name}.png`, timeout: 120_000 });
    console.log('saved', sname, name, await page.evaluate(() => window.__tour.room()));
    if (process.env.SHOT_DEBUG) {
      const d = await page.evaluate(() => {
        const s = window.__tour.session;
        const c = window.__tour.tour.camera.position;
        return { state: window.__tour.getState(), cam: [c.x, c.y, c.z].map((v) => +v.toFixed(2)), blend: s.transition.blend, acc: s.acc, floors: window.__tour.tour.floors.length, tourFloor: window.__tour.tour.floorIndex };
      });
      console.log('  debug', JSON.stringify(d));
    }
  }
  await ctx.close();
}
await browser.close();
