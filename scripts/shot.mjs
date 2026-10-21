// Dev helper: open a page in headless Chromium, run setup code, save a screenshot.
// Usage: node scripts/shot.mjs <url> <out.png> [width] [height] [setupJs]
import { chromium } from '@playwright/test';

const [url, out, w = '1280', h = '800', setup = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 90_000 }).catch(() => logs.push('[timeout] ready flag not set'));
if (setup) await page.evaluate(setup);
await page.waitForTimeout(Number(process.env.SHOT_WAIT ?? 1500));
await page.screenshot({ path: out });
if (process.env.SHOT_EVAL) console.log(JSON.stringify(await page.evaluate(process.env.SHOT_EVAL)));
for (const l of logs) console.log(l);
await browser.close();
