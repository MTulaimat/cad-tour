import { expect, test, type Page } from '@playwright/test';

/* Walkthrough behaviour in a real browser: doors, stairs, floor switch, camera modes. */

type Tour = {
  getState(): { x: number; y: number; feet: number; yaw: number; floor: number; mode: string } | null;
  setState(s: Record<string, unknown>): void;
  room(): string;
  session: { doors: { doors: { def: { openingId: string }; t: number }[] }; avatar: { root: { visible: boolean } } } | null;
  tour: { camera: { position: { y: number } } };
};

declare global {
  interface Window {
    __tour: Tour;
    __camLog: number[];
  }
}

/** Headless Chromium grants pointer lock; release it so HUD buttons can be clicked. */
async function releaseMouse(page: Page): Promise<void> {
  await page.evaluate(() => document.exitPointerLock());
  await page.waitForFunction(() => !document.pointerLockElement);
}

async function startDemo(page: Page): Promise<void> {
  // Software GL is slow: render at half scale so the simulation gets enough frames.
  await page.addInitScript(() => localStorage.setItem('cad-tour:settings', JSON.stringify({ quality: 'auto', renderScale: 0.5 })));
  await page.goto('./?demo&autostart&quality=low');
  await page.waitForFunction(() => !!window.__tour?.session && !document.querySelector<HTMLElement>('[data-testid=hud]')!.hidden, null, { timeout: 240_000 });
}

test.describe('walkthrough', () => {
  test.describe.configure({ timeout: 360_000 });
  test.skip(({ hasTouch }) => hasTouch, 'keyboard walkthrough runs on the desktop projects');

  test('starts inside the entrance, walks through an auto door into the living room', async ({ page }) => {
    await startDemo(page);
    expect(await page.evaluate(() => window.__tour.room())).toBe('Entry hall');
    // Face the hall to living door (east along the corridor) and walk.
    await page.evaluate(() => window.__tour.setState({ x: 2.4, y: 2.0, feet: 0, yaw: -Math.PI / 2, pitch: 0 }));
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => window.__tour.room() === 'Living and dining', null, { timeout: 60_000 });
    await page.keyboard.up('KeyW');
    const door = await page.evaluate(() => window.__tour.session!.doors.doors.find((d) => d.def.openingId === 'L1-d-hall-living')!.t);
    expect(door).toBeGreaterThan(0.3);
    await expect(page.getByTestId('room-name')).toHaveText('Living and dining');
  });

  test('climbs the stair to the upper floor with a smooth camera', async ({ page }) => {
    await startDemo(page);
    await page.evaluate(() => {
      window.__tour.setState({ x: 7.0, y: 0.6, feet: 0, yaw: Math.PI / 2, pitch: 0 });
      window.__camLog = [];
      const tick = () => {
        window.__camLog.push(window.__tour.tour.camera.position.y);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => (window.__tour.getState()?.x ?? 9) < 1.4, null, { timeout: 120_000 });
    await page.keyboard.up('KeyW');
    const s = await page.evaluate(() => window.__tour.getState()!);
    expect(s.feet).toBeCloseTo(3, 4);
    expect(s.floor).toBe(1);
    await expect(page.getByTestId('floor-name')).toHaveText('Upper level');
    // No jitter: the eye never drops while climbing, and never jumps more than a few cm a frame.
    const log = await page.evaluate(() => window.__camLog);
    let drops = 0;
    let maxStep = 0;
    for (let i = 1; i < log.length; i++) {
      const d = log[i] - log[i - 1];
      if (d < -0.002) drops++;
      maxStep = Math.max(maxStep, d);
    }
    expect(drops).toBe(0);
    expect(maxStep).toBeLessThan(0.25);
  });

  test('floor switch teleports to the landing and back', async ({ page }) => {
    await startDemo(page);
    await releaseMouse(page);
    await page.locator('.minimap [data-floor="1"]').click();
    await page.waitForFunction(() => window.__tour.getState()?.floor === 1, null, { timeout: 30_000 });
    let s = await page.evaluate(() => window.__tour.getState()!);
    expect(s.feet).toBeCloseTo(3, 4);
    await page.locator('.minimap [data-floor="0"]').click();
    await page.waitForFunction(() => window.__tour.getState()?.floor === 0, null, { timeout: 30_000 });
    s = await page.evaluate(() => window.__tour.getState()!);
    expect(s.feet).toBeCloseTo(0, 4);
  });

  test('V toggles third person with the mannequin, and back', async ({ page }) => {
    await startDemo(page);
    await page.keyboard.press('KeyV');
    await page.waitForFunction(() => window.__tour.getState()?.mode === 'third', null, { timeout: 10_000 });
    await page.waitForFunction(() => window.__tour.session!.avatar.root.visible, null, { timeout: 30_000 });
    await releaseMouse(page);
    await page.getByTestId('mode-btn').click();
    await page.waitForFunction(() => window.__tour.getState()?.mode === 'first', null, { timeout: 10_000 });
  });
});
