/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const BASE = '/cad-tour/';

// GitHub Pages serves the app from https://mtulaimat.github.io/cad-tour/
export default defineConfig(({ mode }) => ({
  base: BASE,
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
  },
  plugins: [
    VitePWA({
      // The e2e suite runs a test build; a service worker there would cache between runs.
      disable: mode === 'test',
      // Registered from src/app/pwa.ts, which applies updates when no tour is open.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      manifest: {
        name: 'CAD Tour',
        short_name: 'CAD Tour',
        description: 'Walk through an apartment in 3D, or open your own DXF floor plan.',
        lang: 'en',
        dir: 'ltr',
        start_url: BASE,
        scope: BASE,
        id: BASE,
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'any',
        background_color: '#15171b',
        theme_color: '#15171b',
        categories: ['productivity', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        // App shell only; textures and the sky are cached on first use (the 4K sets alone are 26 MB).
        globPatterns: ['**/*.{js,css,html,wasm,webmanifest,svg,png}', 'assets/*latin*.woff2', 'assets/*arabic*.woff2'],
        globIgnores: ['textures/**', 'hdri/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        navigateFallback: `${BASE}index.html`,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith(`${BASE}textures/`) || url.pathname.startsWith(`${BASE}hdri/`),
            handler: 'CacheFirst',
            options: {
              cacheName: 'cad-tour-assets',
              expiration: { maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
}));
