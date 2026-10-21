import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE = `http://localhost:${PORT}/cad-tour/`;

// Headless Chromium needs a software GL path for WebGL2.
const chromiumArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const androidUA =
  'Mozilla/5.0 (Linux; Android 16; SM-F966B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    launchOptions: { args: chromiumArgs },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: BASE,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'Z Fold 7 unfolded',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 900, height: 800 },
        screen: { width: 900, height: 800 },
        deviceScaleFactor: 2.4,
        isMobile: true,
        hasTouch: true,
        userAgent: androidUA,
      },
    },
    {
      name: 'Z Fold 7 cover',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 360, height: 840 },
        screen: { width: 360, height: 840 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: androidUA,
      },
    },
    {
      name: 'Phone 412x915',
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 412, height: 915 },
        screen: { width: 412, height: 915 },
        deviceScaleFactor: 2.625,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'Tablet 1024x768',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
      },
    },
    {
      name: 'Desktop 1280x800',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
