/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// GitHub Pages serves the app from https://mtulaimat.github.io/cad-tour/
export default defineConfig({
  base: '/cad-tour/',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
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
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
