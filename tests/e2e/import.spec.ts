import { expect, test, type Page } from '@playwright/test';
import { twoPlans } from '../fixtures/two-plans';

/* DXF import end to end: file picker, units, layer mapping, report, build, tour. */

const shots = process.env.IMPORT_SHOTS;

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/import-${name}.png` });
}

type TourHook = {
  __tour: {
    session: { plan: { floors: { walls: { thickness: number }[]; rooms: { name: string; polygon: { x: number; y: number }[] }[] }[] } };
    setState(s: Record<string, unknown>): void;
    room(): string;
    still(frames: number): Promise<void>;
  };
};

async function buildAndStart(page: Page) {
  await page.getByTestId('build-scene').click();
  await expect(page.getByTestId('tap-to-start')).toBeVisible({ timeout: 240_000 });
  await page.getByTestId('start-btn').click();
  await expect(page.getByTestId('hud')).toBeVisible();
}

/** Puts the player in the middle of a room by name and checks the HUD says so. */
async function walkInto(page: Page, name: string) {
  await page.evaluate((name) => {
    const t = (window as unknown as TourHook).__tour;
    const room = t.session.plan.floors[0].rooms.find((r) => r.name === name)!;
    const c = room.polygon.reduce((a, p) => ({ x: a.x + p.x / room.polygon.length, y: a.y + p.y / room.polygon.length }), { x: 0, y: 0 });
    t.setState({ x: c.x, y: c.y, yaw: 0, pitch: -0.1 });
  }, name);
  await expect(page.getByTestId('room-name')).toHaveText(name, { timeout: 30_000 });
  await page.evaluate(() => (window as unknown as TourHook).__tour.still(4));
}

async function open(page: Page, file: string) {
  await page.addInitScript(() => localStorage.setItem('cad-tour:settings', JSON.stringify({ quality: 'low', renderScale: 0.5 })));
  await page.goto('./');
  await page.getByTestId('file-input').setInputFiles(file);
}

test.describe('dxf import', () => {
  test.describe.configure({ timeout: 360_000 });
  test.skip(({ hasTouch, viewport }) => hasTouch || viewport!.width < 1200, 'import flow runs on the desktop profile');

  test('clean layered sample: map, review and build the apartment', async ({ page }) => {
    await open(page, 'samples/clean-layered.dxf');
    await expect(page.getByTestId('plan-preview')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('select[data-layer="L1_A-WALL"]')).toHaveValue('walls');
    await expect(page.locator('select[data-layer="L2_A-DOOR"]')).toHaveValue('doors');
    await expect(page.locator('select[data-layer="DIM"]')).toHaveValue('ignore');
    await expect(page.locator('[data-mode="prefix"]')).toHaveClass(/active/);
    await page.waitForTimeout(300);
    await shot(page, 'mapping');
    await page.getByTestId('layers-continue').click();
    await expect(page.getByTestId('stat-rooms')).toHaveText('8', { timeout: 60_000 });
    await expect(page.getByTestId('stat-floors')).toHaveText('2');
    await expect(page.getByTestId('stat-stairs')).toHaveText('1');
    await expect(page.getByTestId('stat-doors')).toHaveText('6');
    await expect(page.getByTestId('stat-windows')).toHaveText('10');
    await shot(page, 'report');
    // Rename a room before building (Q12).
    const kitchen = page.getByLabel('Name of Kitchen');
    await kitchen.fill('Kitchen and pantry');
    await kitchen.blur();
    await page.getByTestId('build-scene').click();
    await expect(page.getByTestId('tap-to-start')).toBeVisible({ timeout: 240_000 });
    await page.getByTestId('start-btn').click();
    await expect(page.getByTestId('hud')).toBeVisible();
    const plan = await page.evaluate(() => (window as unknown as { __tour: { session: { plan: { floors: { rooms: { name: string }[] }[] } } } }).__tour.session.plan.floors[0].rooms.map((r) => r.name));
    expect(plan).toContain('Kitchen and pantry');
    await page.waitForTimeout(1500);
    await shot(page, 'tour');
  });

  test('messy layer 0 sample asks for units and decodes the Arabic label', async ({ page }) => {
    await open(page, 'samples/messy-layer0.dxf');
    // No $INSUNITS: the guess is millimeters, with the size the plan would have.
    await expect(page.getByTestId('unit-preview')).toContainText('In millimeters the plan is 10.2 m by 6.00 m', { timeout: 60_000 });
    await shot(page, 'units');
    await page.getByTestId('units-continue').click();
    await page.getByTestId('layers-continue').click();
    await expect(page.getByTestId('stat-rooms')).toHaveText('4', { timeout: 60_000 });
    // The label is in code page 1256 in the file; room names are editable inputs.
    await expect(page.getByLabel('Name of غرفة نوم 2')).toHaveValue('غرفة نوم 2');
    await shot(page, 'messy-report');
    await expect(page.getByTestId('import-warnings')).toContainText('gaps');
    await buildAndStart(page);
    await walkInto(page, 'غرفة نوم 2');
    await shot(page, 'messy-tour');
  });

  test('single-line sample builds walls at the default thickness and tours', async ({ page }) => {
    await open(page, 'samples/single-line-walls.dxf');
    await expect(page.getByTestId('plan-preview')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('layers-continue').click();
    await expect(page.getByTestId('stat-rooms')).toHaveText('4', { timeout: 60_000 });
    await buildAndStart(page);
    const thick = await page.evaluate(() => (window as unknown as TourHook).__tour.session.plan.floors[0].walls.map((w) => w.thickness));
    expect(new Set(thick)).toEqual(new Set([0.2]));
    await walkInto(page, 'Bedroom 1');
    await shot(page, 'single-tour');
  });

  test('plans side by side: units fixed, stacked as a mezzanine, steel stair, walk up', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cad-tour:settings', JSON.stringify({ quality: 'low', renderScale: 0.5 })));
    await page.goto('./');
    await page.getByTestId('file-input').setInputFiles({ name: 'two-plans.dxf', mimeType: 'application/dxf', buffer: Buffer.from(twoPlans()) });
    // The header says millimeters but the drawing is in meters: no units question.
    await expect(page.getByTestId('plan-preview')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('layers-note')).toContainText('Found 2 plans drawn side by side');
    await expect(page.locator('[data-mode="boxes"]')).toHaveClass(/active/);
    await shot(page, 'two-plans-mapping');
    await page.getByTestId('layers-continue').click();
    await expect(page.getByTestId('stat-floors')).toHaveText('2', { timeout: 60_000 });
    await expect(page.getByTestId('import-notes')).toContainText('drawn in meters, so meters are used');
    await expect(page.getByTestId('import-notes')).toContainText('stacked them as floors');
    await expect(page.getByTestId('import-notes')).toContainText('The upper one is a mezzanine.');
    await page.locator('#set-upperCeilingHeight').fill('2.2');
    await page.locator('#set-upperCeilingHeight').dispatchEvent('change');
    await page.locator('#set-stairFinish').selectOption('black-steel');
    await page.getByTestId('rebuild').click();
    await expect(page.getByTestId('import-notes')).toContainText('mezzanine', { timeout: 60_000 });
    await shot(page, 'two-plans-report');
    await buildAndStart(page);
    const stair = await page.evaluate(() => (window as unknown as { __tour: { session: { plan: { stairs: { finish?: string }[] } } } }).__tour.session.plan.stairs.map((s) => s.finish));
    expect(stair).toEqual(['black-steel']);
    // Stand at the foot of the stair and walk up it with the keyboard onto the mezzanine.
    type Hook = { __tour: { setState(s: Record<string, unknown>): void; getState(): { x: number; feet: number; floor: number } | null } };
    await page.evaluate(() => (window as unknown as Hook).__tour.setState({ x: 9.4, y: 0.7, feet: 0, yaw: Math.PI / 2, pitch: 0 }));
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => ((window as unknown as Hook).__tour.getState()?.x ?? 9) < 4.6, null, { timeout: 120_000 });
    await page.keyboard.up('KeyW');
    const s = await page.evaluate(() => (window as unknown as Hook).__tour.getState()!);
    expect(s.floor).toBe(1);
    expect(s.feet).toBeCloseTo(3, 3);
    await expect(page.getByTestId('floor-name')).toHaveText('Mezzanine');
    await shot(page, 'two-plans-tour');
  });

  test('a DWG file is refused with the exact message', async ({ page }) => {
    await page.goto('./');
    await page.getByTestId('file-input').setInputFiles({ name: 'plan.dwg', mimeType: 'application/acad', buffer: Buffer.from('AC1032\u0000\u0000\u0000') });
    await expect(page.getByTestId('dialog-body')).toHaveText(
      "DWG isn't supported. Export as DXF (SAVEAS, DXF 2013 ASCII, or use ODA File Converter) and try again.",
    );
  });

  test('a broken DXF shows the reason and offers the demo', async ({ page }) => {
    await page.goto('./');
    await page.getByTestId('file-input').setInputFiles({ name: 'broken.dxf', mimeType: 'application/dxf', buffer: Buffer.from('0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n') });
    await expect(page.getByTestId('dialog')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('dialog')).toContainText('Use demo apartment');
  });
});

test.describe('dxf import layout', () => {
  test.describe.configure({ timeout: 240_000 });

  /** No sideways scroll, every control fully on screen horizontally and big enough to tap. */
  async function checkFits(page: Page, step: string) {
    const r = await page.evaluate(() => {
      const vw = window.innerWidth;
      const bad: string[] = [];
      for (const e of document.querySelectorAll<HTMLElement>('.import button, .import select, .import input:not([type=file])')) {
        const b = e.getBoundingClientRect();
        if (b.width === 0 || getComputedStyle(e).visibility === 'hidden') continue;
        const name = e.getAttribute('aria-label') || e.textContent?.trim() || e.id || e.tagName;
        if (b.left < -0.5 || b.right > vw + 0.5) bad.push(`${name} off screen (${Math.round(b.left)}..${Math.round(b.right)})`);
        if (b.height < 44) bad.push(`${name} only ${Math.round(b.height)} px tall`);
      }
      return { overflow: document.documentElement.scrollWidth - vw, bad };
    });
    expect(r.overflow, `${step}: page scrolls sideways`).toBeLessThanOrEqual(0);
    expect(r.bad, step).toEqual([]);
  }

  test('mapping and report screens fit every screen', async ({ page }, info) => {
    await open(page, 'samples/clean-layered.dxf');
    await expect(page.getByTestId('plan-preview')).toBeVisible({ timeout: 60_000 });
    await checkFits(page, 'mapping');
    if (shots) await page.screenshot({ path: `${shots}/import-mapping-${info.project.name.replace(/\W+/g, '-')}.png` });
    await page.getByTestId('layers-continue').click();
    await expect(page.getByTestId('stat-rooms')).toHaveText('8', { timeout: 60_000 });
    await checkFits(page, 'report');
    if (shots) await page.screenshot({ path: `${shots}/import-report-${info.project.name.replace(/\W+/g, '-')}.png` });
  });
});
