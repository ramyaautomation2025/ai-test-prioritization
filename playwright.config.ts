import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

export default defineConfig({

    // ── Test Directory ────────────────────────────────────────────────────
    testDir: './tests',

    // ── Run tests in parallel ─────────────────────────────────────────────
    fullyParallel: false,

    // ── Fail the build on CI if test.only is accidentally left in ─────────
    forbidOnly: !!process.env.CI,

    // ── Retry failed tests once on CI, no retries locally ─────────────────
    retries: process.env.CI ? 1 : 0,

    // ── Number of parallel workers ────────────────────────────────────────
    workers: process.env.CI ? 2 : 2,

    // ── Global test timeout ───────────────────────────────────────────────
    timeout: 30000,

    // ── Expect timeout for assertions ─────────────────────────────────────
    expect: {
        timeout: 10000,
    },

    // ── Reporters ─────────────────────────────────────────────────────────
    reporter: [
        // HTML report — open with: npx playwright show-report
        ['html', {
            outputFolder: 'playwright-report',
            open: 'never',
        }],

        // JSON report — used by updateHistory.ts to feed back into AI
        ['json', {
            outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME
                || 'test-results/results.json',
        }],

        // List reporter — shows live results in terminal during run
        ['list'],
    ],

    // ── Shared settings for all tests ─────────────────────────────────────
    use: {
        // Base URL — all page.goto('/') calls resolve to this
        baseURL: process.env.BASE_URL || 'https://www.saucedemo.com',

        // Take screenshot only when test fails
        screenshot: 'only-on-failure',

        // Record video only when test fails
        video: 'retain-on-failure',

        // Collect trace on first retry — helps debug flaky tests
        trace: 'on-first-retry',

        // Browser viewport size
        viewport: { width: 1280, height: 720 },

        // Slow down actions by 0ms (increase to 500 for demo recording)
        actionTimeout: 10000,

        // Navigation timeout
        navigationTimeout: 15000,

        // Ignore HTTPS errors
        ignoreHTTPSErrors: true,
    },

    // ── Output folder for test artifacts ──────────────────────────────────
    outputDir: 'test-results/',

    // ── Projects — different ways to run the suite ────────────────────────
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
            },

        },

        // ── Firefox — optional cross-browser check ───────────────────────────
        // Uncomment below to enable Firefox runs
        // {
        //   name: 'firefox',
        //   use: { ...devices['Desktop Firefox'] },
        // },
    ],
});