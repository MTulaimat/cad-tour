import { expect, test, type Page } from '@playwright/test';

/*
 * Layout checks at every device profile (Z Fold 7 unfolded and cover, phone, tablet, desktop):
 * no page overflow, every control inside the viewport and at least 48 px, no overlapping
 * controls, readable text, live resize that keeps the player's state, and two-thumb touch.
 */

type Box = { x: number; y: number; width: number; height: number; name: string };

async function startDemo(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('cad-tour:settings', JSON.stringify({ quality: 'auto', renderScale: 0.5 })));
  await page.goto('./?demo&autostart&quality=low');
  await page.waitForFunction(() => !!(window as unknown as { __tour?: { session?: unknown } }).__tour?.session && !document.querySelector<HTMLElement>('[data-testid=hud]')!.hidden, null, {
    timeout: 240_000,
  });
}

/** Visible, interactive controls in the HUD (or a given root). */
async function controls(page: Page, root = '[data-testid=hud]'): Promise<Box[]> {
  return page.evaluate((root) => {
    const out: Box[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(`${root} button, ${root} input, ${root} select`)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      out.push({ x: r.x, y: r.y, width: r.width, height: r.height, name: el.getAttribute('aria-label') || el.textContent?.trim() || el.className });
    }
    return out;
  }, root);
}

async function noOverflow(page: Page): Promise<void> {
  const o = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    sh: document.documentElement.scrollHeight,
    bw: document.body.scrollWidth,
    bh: document.body.scrollHeight,
    w: innerWidth,
    h: innerHeight,
  }));
  expect(o.sw).toBeLessThanOrEqual(o.w);
  expect(o.sh).toBeLessThanOrEqual(o.h);
  expect(o.bw).toBeLessThanOrEqual(o.w);
  expect(o.bh).toBeLessThanOrEqual(o.h);
}

function overlaps(a: Box, b: Box): boolean {
  const pad = 1;
  return a.x + pad < b.x + b.width && b.x + pad < a.x + a.width && a.y + pad < b.y + b.height && b.y + pad < a.y + a.height;
}

async function checkControls(page: Page, boxes: Box[], min = 4): Promise<void> {
  const vp = page.viewportSize()!;
  expect(boxes.length).toBeGreaterThanOrEqual(min);
  for (const b of boxes) {
    expect(b.x, `${b.name} left edge`).toBeGreaterThanOrEqual(0);
    expect(b.y, `${b.name} top edge`).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, `${b.name} right edge`).toBeLessThanOrEqual(vp.width + 0.5);
    expect(b.y + b.height, `${b.name} bottom edge`).toBeLessThanOrEqual(vp.height + 0.5);
    expect(Math.min(b.width, b.height), `${b.name} hit target`).toBeGreaterThanOrEqual(47.5);
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j]), `${boxes[i].name} overlaps ${boxes[j].name}`).toBe(false);
}

async function minFontSize(page: Page, root: string): Promise<number> {
  return page.evaluate((root) => {
    let min = Infinity;
    const walker = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement!;
      if (!n.textContent?.trim()) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
      min = Math.min(min, parseFloat(cs.fontSize));
    }
    return min;
  }, root);
}

test.describe('layout', () => {
  test.describe.configure({ timeout: 360_000 });

  test('start screen fits and its buttons are large enough', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByTestId('start-screen')).toBeVisible();
    await noOverflow(page);
    await checkControls(
      page,
      (await controls(page, '[data-testid=start-screen]')).filter((b) => b.name !== 'file-input'),
      2,
    );
    expect(await minFontSize(page, '[data-testid=start-screen]')).toBeGreaterThanOrEqual(14);
  });

  test('HUD controls fit, do not overlap and are at least 48 px', async ({ page }) => {
    await startDemo(page);
    await noOverflow(page);
    await checkControls(page, await controls(page));
    expect(await minFontSize(page, '[data-testid=hud]')).toBeGreaterThanOrEqual(14);
  });

  test('menu and help fit the screen', async ({ page }) => {
    await startDemo(page);
    await page.evaluate(() => document.exitPointerLock());
    await page.getByTestId('menu-btn').click();
    await expect(page.getByTestId('menu')).toBeVisible();
    await noOverflow(page);
    for (const b of await controls(page, '[data-testid=menu]')) expect(Math.min(b.width, b.height), b.name).toBeGreaterThanOrEqual(47.5);
    expect(await minFontSize(page, '[data-testid=menu]')).toBeGreaterThanOrEqual(14);
    await page.getByTestId('menu-close').click();
    await page.getByTestId('help-btn').click();
    await expect(page.getByTestId('help')).toBeVisible();
    await noOverflow(page);
    expect(await minFontSize(page, '[data-testid=help]')).toBeGreaterThanOrEqual(14);
  });

  test('folding and unfolding mid-session keeps the player state', async ({ page }) => {
    await startDemo(page);
    const set = { x: 7.6, y: 2.2, feet: 0, yaw: 1.1, pitch: -0.1, mode: 'third' };
    await page.evaluate((s) => (window as unknown as { __tour: { setState(s: object): void } }).__tour.setState(s), set);
    await page.waitForTimeout(500);
    const before = await page.evaluate(() => (window as unknown as { __tour: { getState(): object } }).__tour.getState());
    for (const size of [
      { width: 360, height: 840 },
      { width: 900, height: 800 },
      { width: 412, height: 915 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForFunction(
        (a) => Math.abs((window as unknown as { __tour: { tour: { camera: { aspect: number } } } }).__tour.tour.camera.aspect - a) < 0.004,
        size.width / size.height,
        { timeout: 20_000 },
      );
      const after = (await page.evaluate(() => (window as unknown as { __tour: { getState(): Record<string, number | string> } }).__tour.getState())) as Record<string, number | string>;
      const b = before as Record<string, number | string>;
      expect(after.x as number).toBeCloseTo(b.x as number, 3);
      expect(after.y as number).toBeCloseTo(b.y as number, 3);
      expect(after.yaw as number).toBeCloseTo(b.yaw as number, 3);
      expect(after.floor).toBe(b.floor);
      expect(after.mode).toBe(b.mode);
      // Renderer, camera and layout followed the new size.
      const r = await page.evaluate(() => {
        const t = (window as unknown as { __tour: { tour: { camera: { aspect: number }; canvas: HTMLCanvasElement }; layout(): { layout: string } } }).__tour;
        return { aspect: t.tour.camera.aspect, cw: t.tour.canvas.clientWidth, ch: t.tour.canvas.clientHeight, layout: t.layout().layout };
      });
      expect(r.cw).toBe(size.width);
      expect(r.ch).toBe(size.height);
      expect(r.aspect).toBeCloseTo(size.width / size.height, 2);
      await noOverflow(page);
    }
  });
});

test.describe('touch', () => {
  test.describe.configure({ timeout: 360_000 });
  test.skip(({ hasTouch }) => !hasTouch, 'touch projects only');

  test('two thumbs at once: joystick moves while the other thumb looks', async ({ page }) => {
    await startDemo(page);
    await page.evaluate(() => (window as unknown as { __tour: { setState(s: object): void } }).__tour.setState({ x: 7.5, y: 3.0, feet: 0, yaw: 0, pitch: 0, mode: 'first' }));
    const before = (await page.evaluate(() => (window as unknown as { __tour: { getState(): object } }).__tour.getState())) as { x: number; y: number; yaw: number };
    const vp = page.viewportSize()!;
    const cdp = await page.context().newCDPSession(page);
    const left = { x: vp.width * 0.25, y: vp.height * 0.7 };
    const right = { x: vp.width * 0.75, y: vp.height * 0.6 };
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: left.x, y: left.y, id: 1 },
        { x: right.x, y: right.y, id: 2 },
      ],
    });
    // Push the stick up (forward) and drag the look thumb sideways, together, over many frames.
    for (let i = 1; i <= 20; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: left.x, y: left.y - Math.min(50, i * 5), id: 1 },
          { x: right.x - i * 4, y: right.y, id: 2 },
        ],
      });
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(1500);
    const mid = (await page.evaluate(() => (window as unknown as { __tour: { getState(): object; app: { touch: { activePointers: number } } } }).__tour.getState())) as { x: number; y: number; yaw: number };
    const pointers = await page.evaluate(() => (window as unknown as { __tour: { app: { touch: { activePointers: number } } } }).__tour.app.touch.activePointers);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(pointers).toBe(2);
    const moved = Math.hypot(mid.x - before.x, mid.y - before.y);
    expect(moved, 'the joystick moved the player').toBeGreaterThan(0.2);
    expect(Math.abs(mid.yaw - before.yaw), 'the look thumb turned the view').toBeGreaterThan(0.05);
  });

  test('left-handed layout swaps the thumb zones', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cad-tour:settings', JSON.stringify({ quality: 'auto', renderScale: 0.5, leftHanded: true })));
    await page.goto('./?demo&autostart&quality=low');
    await page.waitForFunction(() => !!(window as unknown as { __tour?: { session?: unknown } }).__tour?.session, null, { timeout: 240_000 });
    await expect(page.locator('html')).toHaveClass(/left-handed/);
    const primary = await page.getByTestId('cluster-primary').boundingBox();
    const vp = page.viewportSize()!;
    // The mode/run cluster moves to the left edge.
    expect(primary!.x).toBeLessThan(vp.width / 2);
  });
});
