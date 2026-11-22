import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  use: { baseURL: 'http://localhost:4173', serviceWorkers: 'block', trace: 'off' },
  webServer: { command: 'npx vite preview --port 4173 --strictPort', port: 4173, reuseExistingServer: true },
  projects: [
    { name: 'android-pixel7', use: { ...devices['Pixel 7'] } },
    { name: 'android-chico', use: { ...devices['Galaxy S5'] } },
  ],
});
