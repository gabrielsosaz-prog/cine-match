import { defineConfig } from '@playwright/test';

/**
 * v4.2 · Flujo social entre dos sesiones (tests/social). Local: FAKE_SOCIAL=1 levanta el servidor social simulado.
 * En CI apunta al Supabase de producción (config pública en src/social/config.ts).
 */
const FAKE = process.env.FAKE_SOCIAL === '1';
export default defineConfig({
  testDir: 'tests/social',
  timeout: 600000,
  expect: { timeout: 20000 },
  use: { baseURL: process.env.SOCIAL_BASE ?? 'http://localhost:4173', serviceWorkers: 'block', trace: 'off' },
  webServer: [
    ...(process.env.SOCIAL_BASE ? [] : [{ command: 'npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true }]),
    ...(FAKE ? [{ command: 'node tests/fixtures/fakeSocialServer.mjs', port: 4174, reuseExistingServer: true }] : []),
  ],
});
