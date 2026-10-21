// Dev helper: eye-level screenshots through the real tour (session camera, post, lighting).
// Usage: node scripts/shots-tour.mjs [baseUrl] [outDir] [names,comma] [quality] [prefix]
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5173/cad-tour/';
const outDir = process.argv[3] ?? 'qa-output';
const only = process.argv[4] && process.argv[4] !== 'all' ? process.argv[4].split(',') : null;
const quality = process.argv[5] ?? 'high';
const prefix = process.argv[6] ?? 'm3';
const deg = Math.PI / 180;
// [name, x, y, feet, yaw (deg, 0 looks north, counterclockwise), pitch (deg), mode]
const views = [
  ['entry', 0.84, 0.95, 0, -30, -4, 'first'],
  ['living', 8.9, 1.0, 0, 70, -6, 'first'],
  ['kitchen', 5.4, 3.2, 0, 60, -10, 'first'],
  ['dining', 9.0, 4.6, 0, 95, -8, 'first'],
  ['stair', 7.6, 2.3, 0, 105, 8, 'first'],
  ['balcony', 10.6, 1.9, 0, 30, -6, 'first'],
  ['balcony-view', 10.4, 3.5, 0, -90, -12, 'first'],
  ['landing', 0.9, 1.7, 3, -95, -18, 'first'],
  ['bedroom1', 6.6, 0.7, 3, -40, -8, 'first'],
  ['bedroom2', 3.0, 2.8, 3, 40, -8, 'first'],
  ['bathroom', 4.5, 2.8, 3, 0, -12, 'first'],
  ['third-living', 7.2, 3.6, 0, 120, -10, 'third'],
];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text().slice(0, 300));
});
await page.goto(`${base}?quality=${quality}`);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 240_000 });
if (process.env.SHOT_SETUP) await page.evaluate(process.env.SHOT_SETUP);
for (const [name, x, y, feet, yaw, pitch, mode] of views) {
  if (only && !only.includes(name)) continue;
  await page.evaluate(([x, y, feet, yaw, pitch, mode]) => window.__tour.setState({ x, y, feet, yaw, pitch, mode }), [x, y, feet, yaw * deg, pitch * deg, mode]);
  await page.evaluate((n) => window.__tour.still(n), mode === 'third' ? 12 : 4);
  await page.screenshot({ path: `${outDir}/${prefix}-${name}.png` });
  console.log('saved', name, JSON.stringify(await page.evaluate(() => window.__tour.stats())));
}
await browser.close();
