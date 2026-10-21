import { expect, test, type Page } from '@playwright/test';

/* DXF import end to end: file picker, units, layer mapping, report, build, tour. */

const shots = process.env.IMPORT_SHOTS;

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/import-${name}.png` });
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
