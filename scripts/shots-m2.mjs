// Dev helper: a set of eye-level views of the demo apartment for geometry review.
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5173/cad-tour/';
const outDir = process.argv[3] ?? 'qa-output';
const only = process.argv[4];
// [name, plan camera x, y, height, plan target x, y, height, fov]
const views = [
  ['living-west', 8.9, 1.0, 1.65, 3.0, 3.6, 1.1, 70],
  ['stair-foot', 7.8, 2.4, 1.65, 3.2, 0.6, 1.8, 70],
  ['kitchen', 5.2, 3.3, 1.65, 0.6, 5.2, 0.9, 70],
  ['hall', 0.9, 0.55, 1.65, 3.8, 2.0, 1.3, 75],
  ['landing-down', 0.75, 1.7, 4.65, 5.0, 0.6, 3.2, 75],
  ['bedroom1', 6.6, 0.6, 4.65, 9.0, 4.6, 3.6, 75],
  ['bathroom', 4.5, 2.7, 4.65, 4.6, 5.4, 3.5, 80],
  ['balcony', 10.7, 2.0, 1.65, 9.0, 4.0, 1.2, 75],
];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(base);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 90_000 });
for (const [name, cx, cy, ch, tx, ty, th, fov] of views) {
  if (only && !only.split(',').includes(name)) continue;
  await page.evaluate(([cx, cy, ch, tx, ty, th, fov]) => window.__view.setView(cx, ch, -cy, tx, th, -ty, fov), [cx, cy, ch, tx, ty, th, fov]);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${outDir}/m2-${name}.png` });
  console.log('saved', name);
}
await browser.close();
