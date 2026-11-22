import { defineConfig, devices } from '@playwright/test';

/** Flujos reales contra la app publicada (TMDB real). Se ejecuta a mano desde GitHub Actions. */
export default defineConfig({
  testDir: 'tests/prod',
  timeout: 240000,
  expect: { timeout: 30000 },
  use: { baseURL: process.env.PROD_URL ?? 'https://cine-match-pied-tau.vercel.app', serviceWorkers: 'block', trace: 'off' },
  projects: [
    { name: 'android-pixel7', use: { ...devices['Pixel 7'] } },
    { name: 'android-chico', use: { ...devices['Galaxy S5'] } },
  ],
});
