import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Group-specific config — used by smartRunner for per-group JSON output
 * Reads GROUP_OUTPUT_FILE env var to write results to correct location
 */
export default defineConfig({
  testDir : './tests',
  timeout : 30000,
  retries : 0,
  workers : 2,

  // Write JSON to whatever path smartRunner sets
  reporter: [
    ['list'],
    ['json', {
      outputFile: process.env.GROUP_OUTPUT_FILE || 'test-results/results-group.json',
    }],
  ],

  use: {
    baseURL   : process.env.BASE_URL || 'https://www.saucedemo.com',
    screenshot: 'only-on-failure',
    viewport  : { width: 1280, height: 720 },
  },

  projects: [
    {
      name: 'chromium',
      use : { ...devices['Desktop Chrome'] },
    },
  ],
});