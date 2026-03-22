import * as dotenv from 'dotenv';
import { execSync }           from 'child_process';
import * as fs                from 'fs';
import * as path              from 'path';
import { analyzeTrends }      from '../analyzer/trendAnalyzer';
import { predictWithGemini }  from '../ai/geminiPredictor';
import { computeFinalScores } from '../analyzer/riskScorer';
import { buildExecutionPlan, PrioritizedTest } from '../prioritizer/reorderSuite';
import { generateDashboard }  from '../reporter/dashboardGenerator';
import { testConnection, initializeSchema }                                          from '../database/dbClient';
import { saveBuildRun, saveRiskPredictions, applyRetentionPolicy, showStorageStats } from '../database/historyWriter';
import { readHistoryFromDB, getDatabaseStats }                                       from '../database/historyReader';
import { updateHistoryJson } from '../analyzer/updateHistory';

dotenv.config();

// ── Interfaces ────────────────────────────────────────────────────────────────

interface PlaywrightTestResult {
  testName    : string;
  module      : string;
  status      : 'passed' | 'failed';
  duration    : number;
  errorMessage: string;
   retryCount  : number;
}

interface SmartRunSummary {
  buildId      : string;
  buildNumber  : string;
  startTime    : Date;
  endTime?     : Date;
  totalTests   : number;
  passed       : number;
  failed       : number;
  groupAFailed : boolean;
  dbConnected  : boolean;
  aiUsed       : boolean;
  dashboardPath: string;
}

// ── Helper: Print banner ──────────────────────────────────────────────────────

function printBanner(title: string, buildNumber: string): void {
  console.log('\n');
  console.log('═'.repeat(70));
  console.log(`  🤖 ${title}`);
  console.log(`  Build #${buildNumber} — ${new Date().toLocaleString()}`);
  console.log('═'.repeat(70));
}

// ── Helper: Print step header ─────────────────────────────────────────────────

function printStep(stepNumber: number, title: string): void {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  STEP ${stepNumber}: ${title}`);
  console.log('─'.repeat(70));
}

// ── Helper: Ensure output folders exist ──────────────────────────────────────

function ensureOutputFolders(): void {
  const folders = [
    'test-results',
    'test-results/screenshots',
    'test-results/configs',
    'reports',
    'test-history',
  ];
  for (const folder of folders) {
    const fullPath = path.join(process.cwd(), folder);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      console.log(`[${new Date().toISOString()}] 📁 Created: ${folder}`);
    }
  }
}

/**
 * Clears all group report folders at the start of every run.
 * Prevents stale results from previous builds appearing
 * in groups that had no tests in the current run.
 *
 * Only clears group subfolders (groupa, groupb, groupc)
 * NOT the priority-dashboard.html which is regenerated separately.
 */
function clearReportsFolder(): void {
  console.log(
    `[${new Date().toISOString()}] 🧹 Clearing stale group reports...`
  );

  const groupFolders = [
    path.join(process.cwd(), 'reports', 'groupa'),
    path.join(process.cwd(), 'reports', 'groupb'),
    path.join(process.cwd(), 'reports', 'groupc'),
  ];

  for (const folder of groupFolders) {
    if (fs.existsSync(folder)) {
      fs.rmSync(folder, { recursive: true, force: true });
      console.log(
        `[${new Date().toISOString()}] 🗑️  Cleared: ${path.basename(folder)}/`
      );
    }
  }

  // Also clear the combined index so it regenerates fresh
  const combinedIndex = path.join(process.cwd(), 'reports', 'index.html');
  if (fs.existsSync(combinedIndex)) {
    fs.rmSync(combinedIndex);
    console.log(
      `[${new Date().toISOString()}] 🗑️  Cleared: reports/index.html`
    );
  }

  console.log(
    `[${new Date().toISOString()}] ✅ Reports folder ready for fresh run`
  );
}

// ── Helper: Write dynamic Playwright config for each group ────────────────────

/**
 * Creates a temporary playwright config file for a specific group run.
 *
 * WHY THIS APPROACH:
 * - env variable approach (PLAYWRIGHT_JSON_OUTPUT_NAME) is unreliable on Windows
 * - stdout piping mixes list reporter + JSON reporter output
 * - Hardcoding the path INSIDE the config is the only 100% reliable method
 * - Playwright reads the config file directly — no env var passing needed
 *
 * @param absoluteOutputPath - Full path where JSON results will be written
 * @returns Path to the generated temp config file
 */function writeTempPlaywrightConfig(
  absoluteOutputPath: string,
  groupName         : string
): string {
  const normalizedOutputPath = absoluteOutputPath.replace(/\\/g, '/');
  const safeGroupName        = groupName.toLowerCase().replace(/\s+/g, '');

  // ── KEY FIX: Use reports/ NOT playwright-report/ ──────────────
  // Each group gets completely isolated folder under reports/
  // No shared assets — Group B cannot touch Group A's files
  const htmlFolder = path.join(
    process.cwd(), 'reports', safeGroupName
  ).replace(/\\/g, '/');

  // Ensure folder exists before Playwright runs
  if (!fs.existsSync(htmlFolder)) {
    fs.mkdirSync(htmlFolder, { recursive: true });
  }

  const configContent = [
    `const { defineConfig, devices } = require('@playwright/test');`,
    `require('dotenv').config();`,
    `module.exports = defineConfig({`,
    `  testDir       : './tests',`,
    `  timeout       : 30000,`,
    `  retries       : 0,`,
    `  workers       : 2,`,
    `  preserveOutput: 'always',`,
    `  reporter: [`,
    `    ['list'],`,
    `    ['json', { outputFile  : ${JSON.stringify(normalizedOutputPath)} }],`,
    `    ['html', { outputFolder: ${JSON.stringify(htmlFolder)}, open: 'never' }],`,
    `  ],`,
    `  use: {`,
    `    baseURL   : process.env.BASE_URL || 'https://www.saucedemo.com',`,
    `    screenshot: 'only-on-failure',`,
    `    video     : 'retain-on-failure',`,
    `    viewport  : { width: 1280, height: 720 },`,
    `  },`,
    `  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],`,
    `});`,
  ].join('\n');

  const buildNum   = process.env.BUILD_NUMBER || Date.now();
const configPath = path.join(
  process.cwd(),
  `playwright.${safeGroupName}.${buildNum}.config.js`
);

  fs.writeFileSync(configPath, configContent);

  console.log(`[${new Date().toISOString()}] ⚙️  Config : ${path.basename(configPath)}`);
  console.log(`[${new Date().toISOString()}] 📄 HTML   : reports/${safeGroupName}/`);

  return configPath;
}
/**
 * Generates HTML report from existing JSON results file
 * using Playwright's built-in show-report capability.
 * This avoids all issues with HTML reporter during test run.
 */
function generateHtmlFromJson(
  groupName  : string,
  jsonFile   : string,
  outputFolder: string
): void {

  const fullJsonPath   = path.join(process.cwd(), jsonFile);
  const fullOutputPath = path.join(process.cwd(), outputFolder);

  if (!fs.existsSync(fullJsonPath)) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️  ${groupName}: JSON not found at ${jsonFile}`
    );
    return;
  }

  // Ensure output folder exists
  if (!fs.existsSync(fullOutputPath)) {
    fs.mkdirSync(fullOutputPath, { recursive: true });
  }

  try {
    // Use Playwright JSON reporter output to generate HTML
    // by creating a minimal standalone HTML from the JSON data
    const raw     = fs.readFileSync(fullJsonPath, 'utf-8');
    const data    = JSON.parse(raw);
    const results = extractFromSuites(data.suites || []);

    if (results.length === 0) {
      console.warn(
        `[${new Date().toISOString()}] ⚠️  ${groupName}: No test results in JSON`
      );
      return;
    }

    const passed  = results.filter((r) => r.status === 'passed').length;
    const failed  = results.filter((r) => r.status === 'failed').length;
    const retried = results.filter((r) => r.retryCount > 0).length;

    // Generate standalone HTML report from JSON data
    const groupIcon  =
      groupName.includes('A') ? '🔴' :
      groupName.includes('B') ? '🟡' : '🟢';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${groupName} — Playwright Results</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f7fafc;
      padding: 32px;
      color: #2d3748;
    }
    .header {
      background: white;
      border-radius: 12px;
      padding: 24px 32px;
      margin-bottom: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h1 { font-size: 22px; font-weight: 800; }
    .header p  { color: #718096; font-size: 13px; margin-top: 4px; }
    .stats {
      display: flex;
      gap: 12px;
    }
    .stat {
      text-align: center;
      padding: 12px 20px;
      border-radius: 8px;
      min-width: 80px;
    }
    .stat.total  { background: #edf2f7; }
    .stat.passed { background: #f0fff4; color: #276749; }
    .stat.failed { background: #fff5f5; color: #c53030; }
    .stat.retry  { background: #fffff0; color: #744210; }
    .stat-num  { font-size: 28px; font-weight: 800; }
    .stat-label{ font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .back-link {
      display: inline-block;
      margin-bottom: 20px;
      color: #4a5568;
      text-decoration: none;
      font-size: 14px;
    }
    .back-link:hover { color: #2d3748; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    thead { background: #2d3748; color: white; }
    th {
      padding: 14px 16px;
      text-align: left;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    td { padding: 14px 16px; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f7fafc; }
    .status-pass {
      background: #c6f6d5; color: #22543d;
      padding: 3px 10px; border-radius: 20px;
      font-size: 11px; font-weight: 700;
    }
    .status-fail {
      background: #fed7d7; color: #c53030;
      padding: 3px 10px; border-radius: 20px;
      font-size: 11px; font-weight: 700;
    }
    .retry-badge {
      background: #fefcbf; color: #744210;
      padding: 2px 8px; border-radius: 20px;
      font-size: 10px; font-weight: 600;
      margin-left: 6px;
    }
    .error-msg {
      color: #c53030;
      font-size: 11px;
      margin-top: 4px;
      font-style: italic;
    }
    .module-badge {
      background: #edf2f7; color: #4a5568;
      padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 600;
      text-transform: uppercase;
    }
    .duration { color: #718096; font-size: 12px; }
  </style>
</head>
<body>

  <a class="back-link" href="../index.html">← Back to All Groups</a>

  <div class="header">
    <div>
      <h1>${groupIcon} ${groupName}</h1>
      <p>Generated: ${new Date().toLocaleString()} &nbsp;|&nbsp; Playwright + TypeScript + Gemini AI</p>
    </div>
    <div class="stats">
      <div class="stat total">
        <div class="stat-num">${results.length}</div>
        <div class="stat-label">Total</div>
      </div>
      <div class="stat passed">
        <div class="stat-num">${passed}</div>
        <div class="stat-label">Passed</div>
      </div>
      <div class="stat failed">
        <div class="stat-num">${failed}</div>
        <div class="stat-label">Failed</div>
      </div>
      <div class="stat retry">
        <div class="stat-num">${retried}</div>
        <div class="stat-label">Retried</div>
      </div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Test Name</th>
        <th>Module</th>
        <th>Status</th>
        <th>Duration</th>
      </tr>
    </thead>
    <tbody>
      ${results.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>
          <div>
            ${r.testName.includes('>') ? r.testName.split('>')[1].trim() : r.testName}
            ${r.retryCount > 0 ? `<span class="retry-badge">🔄 ${r.retryCount} retry</span>` : ''}
          </div>
          ${r.errorMessage ? `<div class="error-msg">❌ ${r.errorMessage}</div>` : ''}
        </td>
        <td><span class="module-badge">${r.module}</span></td>
        <td>
          <span class="${r.status === 'passed' ? 'status-pass' : 'status-fail'}">
            ${r.status === 'passed' ? '✅ PASSED' : '❌ FAILED'}
          </span>
        </td>
        <td class="duration">${(r.duration / 1000).toFixed(1)}s</td>
      </tr>`).join('')}
    </tbody>
  </table>

</body>
</html>`;

    fs.writeFileSync(path.join(fullOutputPath, 'index.html'), html);

    console.log(
      `[${new Date().toISOString()}] ✅ ${groupName} HTML report → ${outputFolder}/index.html (${results.length} tests)`
    );

  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Failed to generate HTML for ${groupName}: ${error}`
    );
  }
}
/**
 * Creates a combined index.html that links to all three group reports.
 * Simple and reliable — no merging needed.
 */
function generateCombinedIndex(): void {
  console.log(
    `[${new Date().toISOString()}] 📊 Generating combined report index...`
  );

  const groups = [
    { name: 'Group A — Critical / High Risk', folder: 'groupa', icon: '🔴' },
    { name: 'Group B — Medium Risk',          folder: 'groupb', icon: '🟡' },
    { name: 'Group C — Low Risk',             folder: 'groupc', icon: '🟢' },
  ];

  // Check which group reports actually exist and have content
  const groupStats = groups.map((g) => {
    const reportPath = path.join(process.cwd(), 'reports', g.folder, 'index.html');
    const exists     = fs.existsSync(reportPath);

    // Check file size — Playwright writes ~50KB+ for a real report
    // A "no tests" report is much smaller (~5KB)
    const size = exists ? fs.statSync(reportPath).size : 0;
    const hasTests = size > 10;   // real report > 10KB

    console.log(
      `[${new Date().toISOString()}] 📋 ${g.folder}: exists=${exists} size=${size} bytes hasTests=${hasTests}`
    );

    return { ...g, exists, hasTests };
  });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>AI Smart Test Run — Combined Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f0f4f8;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container { max-width: 620px; width: 100%; padding: 40px 20px; }
    .header { text-align: center; margin-bottom: 40px; }
    .header h1 { font-size: 28px; font-weight: 800; color: #1a202c; margin-bottom: 8px; }
    .header p  { color: #718096; font-size: 14px; margin-top: 4px; }
    .card {
      background: white;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      display: flex;
      align-items: center;
      justify-content: space-between;
      text-decoration: none;
      color: inherit;
      transition: transform 0.15s, box-shadow 0.15s;
      border-left: 5px solid transparent;
    }
    .card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .card.groupa { border-left-color: #e53e3e; }
    .card.groupb { border-left-color: #d69e2e; }
    .card.groupc { border-left-color: #38a169; }
    .card.disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
    .card-left { display: flex; align-items: center; gap: 16px; }
    .icon      { font-size: 36px; }
    .card-title { font-size: 16px; font-weight: 700; color: #2d3748; }
    .card-sub   { font-size: 12px; color: #718096; margin-top: 4px; }
    .badge {
      background: #edf2f7; color: #4a5568;
      padding: 4px 12px; border-radius: 20px;
      font-size: 12px; font-weight: 600;
    }
    .arrow { font-size: 20px; color: #718096; }
    .footer {
      text-align: center; margin-top: 32px;
      color: #a0aec0; font-size: 12px; line-height: 1.8;
    }
  </style>
</head>
<body>
  <div class="container">

    <div class="header">
      <h1>🤖 AI Smart Test Run</h1>
      <p>Generated: ${new Date().toLocaleString()}</p>
      <p>Tests prioritized by Gemini AI risk scoring</p>
    </div>

    ${groupStats.map((g) => `
    <a href="${g.folder}/index.html"
       class="card ${g.folder}${g.hasTests ? '' : ' disabled'}">
      <div class="card-left">
        <div class="icon">${g.icon}</div>
        <div>
          <div class="card-title">${g.name}</div>
          <div class="card-sub">
            ${g.hasTests
              ? 'Click to view full Playwright HTML report'
              : 'No tests assigned to this group in this run'}
          </div>
        </div>
      </div>
      ${g.hasTests
        ? '<div class="arrow">→</div>'
        : '<span class="badge">Empty</span>'}
    </a>`).join('')}

    <div class="footer">
      <p>AI Engine: Gemini 2.5 Flash Lite &nbsp;|&nbsp; Playwright + TypeScript</p>
      <p>Score ranges: 🔴 Critical 80-100 &nbsp;|&nbsp; 🟡 Medium 40-79 &nbsp;|&nbsp; 🟢 Low 0-39</p>
    </div>

  </div>
</body>
</html>`;

  // Write combined index to reports/ root
  const indexPath = path.join(process.cwd(), 'reports', 'index.html');
  fs.writeFileSync(indexPath, html);

  console.log(
    `[${new Date().toISOString()}] ✅ Combined index → reports/index.html`
  );
  console.log(
    `[${new Date().toISOString()}] 📁 Report structure:`
  );
  console.log(`   reports/index.html       ← combined index`);
  console.log(`   reports/groupa/index.html ← Group A report`);
  console.log(`   reports/groupb/index.html ← Group B report`);
  console.log(`   reports/groupc/index.html ← Group C report`);
}
// ── Helper: Extract tests from Playwright JSON suite structure ────────────────

function extractFromSuites(
  suites    : any[],
  parentFile: string = ''
): PlaywrightTestResult[] {

  const results: PlaywrightTestResult[] = [];

  for (const suite of suites || []) {
    const fileName   = suite.file || parentFile;
    const moduleName = fileName
      .replace('tests/', '')
      .replace('.spec.ts', '');

    for (const spec of suite.specs || []) {
      const test = spec.tests?.[0];
      if (!test) continue;

      // All attempts including retries
      const allAttempts  = test.results || [];
      const totalAttempts = allAttempts.length;

      // Final result is the last attempt
      const finalAttempt = allAttempts[totalAttempts - 1];
      if (!finalAttempt) continue;

      // retryCount = attempts beyond the first
      const retryCount = Math.max(0, totalAttempts - 1);

      results.push({
        testName    : `${fileName.replace('tests/', '')} > ${spec.title}`,
        module      : moduleName,
        status      : finalAttempt.status === 'passed' ? 'passed' : 'failed',
        duration    : finalAttempt.duration || 0,
        errorMessage: finalAttempt.error?.message?.slice(0, 150) || '',
        retryCount,   // ← ADD THIS
      });
    }

    if (suite.suites?.length) {
      results.push(...extractFromSuites(suite.suites, fileName));
    }
  }

  return results;
}

/**
 * Reads and parses a group result JSON file immediately after run.
 * Called right after each group finishes — before next group
 * can overwrite the test-results directory.
 */
function readGroupResultsFromFile(
  outputFile: string
): PlaywrightTestResult[] {

  const fullPath = path.join(process.cwd(), outputFile);

  if (!fs.existsSync(fullPath)) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️  Cannot read ${outputFile} — file missing`
    );
    return [];
  }

  try {
    const raw  = fs.readFileSync(fullPath, 'utf-8');
    const data = JSON.parse(raw);

    if (!data.suites || data.suites.length === 0) {
      return [];
    }

    const results = extractFromSuites(data.suites || []);

    // Log any retried tests found
    const retried = results.filter((r) => r.retryCount > 0);
    if (retried.length > 0) {
      console.log(
        `[${new Date().toISOString()}] 🔄 ${retried.length} retried test(s) in ${outputFile}:`
      );
      retried.forEach((r) =>
        console.log(
          `   → ${r.testName} (retries: ${r.retryCount}, final: ${r.status})`
        )
      );
    }

    console.log(
      `[${new Date().toISOString()}] 📖 Read ${results.length} results from ${outputFile}`
    );
    return results;

  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Failed to read ${outputFile}: ${error}`
    );
    return [];
  }
}
// ── Helper: Run specific AI-selected tests ────────────────────────────────────

/**
 * Runs ONLY the AI-selected tests using exact grep patterns.
 *
 * FLOW:
 * 1. Build grep pattern from AI-selected test titles
 * 2. Write a temp Playwright config with output path hardcoded
 * 3. Run Playwright using that temp config
 * 4. Playwright writes JSON directly to the hardcoded path
 * 5. Verify file exists and has content
 * 6. Clean up temp config
 *
 * This is reliable on BOTH Windows and Linux/Mac.
 */
/**
 * Runs ONLY the AI-selected tests using exact grep patterns.
 * Uses a temp config file written to project root (no spaces issue).
 * Full logging on every operation to trace exactly what happens.
 */
function runTestsByAIPriority(
  groupName : string,
  tests     : PrioritizedTest[],
  blocking  : boolean,
  outputFile: string
): boolean {

  console.log(`\n[${new Date().toISOString()}] ════════ ${groupName} START ════════`);

  const fullOutputPath = path.join(process.cwd(), outputFile);
  const outputDir      = path.dirname(fullOutputPath);

  console.log(`[${new Date().toISOString()}] 📂 Output path : ${fullOutputPath}`);
  console.log(`[${new Date().toISOString()}] 📂 Output dir  : ${outputDir}`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`[${new Date().toISOString()}] 📁 Created output dir`);
  }

  // Write empty JSON upfront as safety net
  fs.writeFileSync(fullOutputPath, JSON.stringify({ suites: [] }));
  console.log(`[${new Date().toISOString()}] 📝 Wrote empty JSON placeholder: ${fullOutputPath}`);
  console.log(`[${new Date().toISOString()}] 📊 Placeholder size: ${fs.statSync(fullOutputPath).size} bytes`);

  // Handle empty group
  if (tests.length === 0) {
    console.log(`[${new Date().toISOString()}] ⏭️  ${groupName}: No tests assigned — skipping`);
    return true;
  }

  // ── Build grep pattern ─────────────────────────────────────────
  // Keep @tags intact — Playwright needs them for matching
  // Only escape true regex special characters
  const grepPatterns = tests.map((t) => {
    const title = t.testName.includes('>')
      ? t.testName.split('>')[1].trim()
      : t.testName.trim();
    return title
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // escape regex specials
      .replace(/—/g, '.');                      // em dash → wildcard
  });

  const grepPattern = grepPatterns.join('|');

  console.log(`\n[${new Date().toISOString()}] 🎭 Running ${groupName} — ${tests.length} AI-selected tests`);
  tests.forEach((t, i) =>
    console.log(`   ${i + 1}. [Score: ${t.riskScore}] ${t.testName}`)
  );
  console.log(`[${new Date().toISOString()}] 🔍 Grep pattern: ${grepPattern}`);

  // ── Write temp config to project root ─────────────────────────
  const safeGroupName    = groupName.toLowerCase().replace(/\s+/g, '');
  const normalizedOutput = fullOutputPath.replace(/\\/g, '/');

  const configContent = [
    `const { defineConfig, devices } = require('@playwright/test');`,
    `require('dotenv').config();`,
    `module.exports = defineConfig({`,
    `  testDir       : './tests',`,
    `  timeout       : 30000,`,
    `  retries       : 0,`,
    `  workers       : 2,`,
    `  preserveOutput: 'always',`,
    `  reporter: [`,
    `    ['list'],`,
    `    ['json', { outputFile: ${JSON.stringify(normalizedOutput)} }],`,
    `  ],`,
    `  use: {`,
    `    baseURL   : process.env.BASE_URL || 'https://www.saucedemo.com',`,
    `    screenshot: 'only-on-failure',`,
    `    viewport  : { width: 1280, height: 720 },`,
    `  },`,
    `  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],`,
    `});`,
  ].join('\n');

  const configPath = path.join(
    process.cwd(),
    `playwright.${safeGroupName}.config.js`
  );

  // Print full config to confirm HTML path
console.log(`[${new Date().toISOString()}] 📝 Full temp config:\n${configContent}`);

  fs.writeFileSync(configPath, configContent);
  console.log(`[${new Date().toISOString()}] ⚙️  Config written : ${configPath}`);
  console.log(`[${new Date().toISOString()}] ⚙️  Config size    : ${fs.statSync(configPath).size} bytes`);
  console.log(`[${new Date().toISOString()}] ⚙️  Output in config: ${normalizedOutput}`);

  // ── Verify output file exists BEFORE running ───────────────────
  console.log(`[${new Date().toISOString()}] 🔍 PRE-RUN check:`);
  console.log(`[${new Date().toISOString()}]    Config exists  : ${fs.existsSync(configPath)}`);
  console.log(`[${new Date().toISOString()}]    Output exists  : ${fs.existsSync(fullOutputPath)} (${fs.existsSync(fullOutputPath) ? fs.statSync(fullOutputPath).size : 0} bytes)`);

  let passed = true;

  try {
    console.log(`[${new Date().toISOString()}] 🚀 Executing Playwright...`);

    execSync(
      `npx playwright test --grep "${grepPattern}" --config="${configPath}"`,
      {
        stdio: 'inherit',
        cwd  : process.cwd(),
        env  : { ...process.env },
      }
    );

    console.log(`\n[${new Date().toISOString()}] ✅ ${groupName}: All tests PASSED`);

  } catch {
    passed = false;
    console.log(`\n[${new Date().toISOString()}] ${blocking ? '🚨' : '⚠️ '} ${groupName}: Some tests FAILED`);
  }

  // ── Check output file IMMEDIATELY after Playwright exits ───────
  console.log(`[${new Date().toISOString()}] 🔍 POST-RUN check (BEFORE config delete):`);
  console.log(`[${new Date().toISOString()}]    Config exists  : ${fs.existsSync(configPath)} — ${configPath}`);
  console.log(`[${new Date().toISOString()}]    Output exists  : ${fs.existsSync(fullOutputPath)} — ${fullOutputPath}`);
  if (fs.existsSync(fullOutputPath)) {
    console.log(`[${new Date().toISOString()}]    Output size    : ${fs.statSync(fullOutputPath).size} bytes`);
  }

  // ── Delete ONLY the config file ────────────────────────────────
  console.log(`[${new Date().toISOString()}] 🗑️  Deleting config: ${configPath}`);
  try {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      console.log(`[${new Date().toISOString()}] ✅ Config deleted successfully`);
    } else {
      console.log(`[${new Date().toISOString()}] ⚠️  Config was already gone before delete`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ❌ Config delete failed: ${e}`);
  }

  // ── Check output file AFTER config delete ──────────────────────
  console.log(`[${new Date().toISOString()}] 🔍 POST-DELETE check:`);
  console.log(`[${new Date().toISOString()}]    Output exists  : ${fs.existsSync(fullOutputPath)}`);
  if (fs.existsSync(fullOutputPath)) {
    const size = fs.statSync(fullOutputPath).size;
    console.log(`[${new Date().toISOString()}]    Output size    : ${size} bytes`);

    if (size > 20) {
      console.log(`[${new Date().toISOString()}] 📄 ${groupName} results saved → ${outputFile} (${size} bytes) ✅`);
    } else {
      console.warn(`[${new Date().toISOString()}] ⚠️  Output file is empty — Playwright did not write JSON`);
    }
  } else {
    console.error(`[${new Date().toISOString()}] ❌ Output file DISAPPEARED after config delete!`);
    console.error(`[${new Date().toISOString()}] ❌ Something deleted: ${fullOutputPath}`);
    // Write empty fallback so merge step does not crash
    fs.writeFileSync(fullOutputPath, JSON.stringify({ suites: [] }));
    console.log(`[${new Date().toISOString()}] 📝 Wrote empty fallback`);
  }

  console.log(`[${new Date().toISOString()}] ════════ ${groupName} END ════════\n`);

  return passed;
}
// ── Helper: Merge all group results ──────────────────────────────────────────

function mergeGroupResults(): PlaywrightTestResult[] {

  console.log(
    `[${new Date().toISOString()}] 🔀 Merging results from all groups...`
  );

  const groupFiles = [
    { label: 'Group A', file: 'test-results/results-groupA.json' },
    { label: 'Group B', file: 'test-results/results-groupB.json' },
    { label: 'Group C', file: 'test-results/results-groupC.json' },
  ];

  const allResults: PlaywrightTestResult[] = [];
  const seenTests : Set<string>            = new Set();

  for (const { label, file } of groupFiles) {
    const fullPath = path.join(process.cwd(), file);

    if (!fs.existsSync(fullPath)) {
      console.warn(`[${new Date().toISOString()}] ⚠️  ${label}: file missing`);
      continue;
    }

    try {
      const raw  = fs.readFileSync(fullPath, 'utf-8');
      const data = JSON.parse(raw);

      if (!data.suites || data.suites.length === 0) {
        console.log(`[${new Date().toISOString()}] ⏭️  ${label}: empty — no tests in this group`);
        continue;
      }

      const results  = extractFromSuites(data.suites || []);
      let addedCount = 0;

      for (const result of results) {
        if (!seenTests.has(result.testName)) {
          seenTests.add(result.testName);
          allResults.push(result);
          addedCount++;
        }
      }

      console.log(
        `[${new Date().toISOString()}] 📋 ${label}: ${addedCount} tests merged ✅`
      );

    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Failed to read ${file}: ${error}`);
    }
  }

  const passed = allResults.filter((r) => r.status === 'passed').length;
  const failed = allResults.filter((r) => r.status === 'failed').length;

  console.log(
    `[${new Date().toISOString()}] ✅ Merged total: ${allResults.length} tests | ✅ ${passed} passed | ❌ ${failed} failed`
  );

  return allResults;
}

// ── MAIN SMART RUNNER ─────────────────────────────────────────────────────────

async function smartRun(): Promise<void> {

  const buildNumber = process.env.BUILD_NUMBER || '001';
  const buildId     = `build-${buildNumber}-${Date.now()}`;
  const startTime   = Date.now();

  const summary: SmartRunSummary = {
    buildId,
    buildNumber,
    startTime    : new Date(),
    totalTests   : 0,
    passed       : 0,
    failed       : 0,
    groupAFailed : false,
    dbConnected  : false,
    aiUsed       : false,
    dashboardPath: path.join(process.cwd(), 'reports', 'priority-dashboard.html'),
  };

  printBanner('AI-DRIVEN SMART TEST RUNNER', buildNumber);
  ensureOutputFolders();
  clearReportsFolder();

  // ── STEP 1: Database Connection ───────────────────────────────────
  printStep(1, '🔌 Connecting to PostgreSQL Database');

  if (process.env.DATABASE_URL) {
    try {
      summary.dbConnected = await testConnection();
      if (summary.dbConnected) {
        await initializeSchema();
        console.log(`[${new Date().toISOString()}] ✅ Database ready`);
        const dbStats = await getDatabaseStats() as any;
        console.log(
          `[${new Date().toISOString()}] 📊 DB: ${dbStats.total_builds || 0} builds, ${dbStats.total_test_runs || 0} records`
        );
      }
    } catch (error) {
      console.warn(`[${new Date().toISOString()}] ⚠️  DB failed: ${error}`);
      summary.dbConnected = false;
    }
  } else {
    console.warn(`[${new Date().toISOString()}] ⚠️  DATABASE_URL not set`);
  }

  // ── STEP 2: Load History & Analyze Trends ────────────────────────
  printStep(2, '📊 Loading Test History & Analyzing Trends');

  let trends;

  if (summary.dbConnected) {
    console.log(`[${new Date().toISOString()}] 🗄️  Reading from PostgreSQL...`);
    trends = await readHistoryFromDB(10);
    if (trends.length === 0) {
      console.log(`[${new Date().toISOString()}] 📄 DB empty — using history.json`);
      trends = analyzeTrends();
    } else {
      console.log(`[${new Date().toISOString()}] ✅ Loaded ${trends.length} trends from DB`);
    }
  } else {
    trends = analyzeTrends();
  }

  // ── STEP 3: Gemini AI Prediction ──────────────────────────────────
  printStep(3, '🤖 Running Gemini AI Risk Prediction');
  const predictions = await predictWithGemini(trends);
  summary.aiUsed    = predictions.some((p) => !p.reason.startsWith('Rule-based'));
  console.log(
    `[${new Date().toISOString()}] ${summary.aiUsed ? '🤖 Gemini AI used' : '📏 Rule-based fallback'}`
  );

  // ── STEP 4: Compute Final Risk Scores ─────────────────────────────
  printStep(4, '⚖️  Computing Final Risk Scores (AI 70% + Rules 30%)');
  const scores = computeFinalScores(trends, predictions);

  // ── STEP 5: Build Execution Plan ──────────────────────────────────
  printStep(5, '📋 Building Smart Execution Plan');
  const plan = buildExecutionPlan(scores);

  console.log(`\n📊 AI-Driven Execution Plan:`);
  console.log(`   🔴 Group A: ${plan.groupA.length} tests (score 80-100) → runs FIRST, blocks deploy`);
  console.log(`   🟡 Group B: ${plan.groupB.length} tests (score 60-79)  → runs SECOND`);
  console.log(`   🟢 Group C: ${plan.groupC.length} tests (score 0-59)   → runs LAST`);

  // ── STEP 6: Generate Dashboard ────────────────────────────────────
  printStep(6, '🎨 Generating HTML Risk Dashboard');
  generateDashboard(scores, plan, buildNumber);

  // ── Store results in memory as each group completes ───────────────
let groupAResults: PlaywrightTestResult[] = [];
let groupBResults: PlaywrightTestResult[] = [];
let groupCResults: PlaywrightTestResult[] = [];

// ── STEP 7: Run GROUP A ───────────────────────────────────────────
printStep(7, '🚨 GROUP A — AI Selected Critical/High Risk Tests');
console.log('   Failure here BLOCKS deployment!\n');

summary.groupAFailed = !runTestsByAIPriority(
  'Group A',
  plan.groupA,
  true,
  'test-results/results-groupA.json'
);

// ── READ + GENERATE HTML immediately before Group B deletes file ──
groupAResults = readGroupResultsFromFile('test-results/results-groupA.json');
generateHtmlFromJson(                              // ← ADD THIS HERE
  'Group A — Critical / High Risk',
  'test-results/results-groupA.json',
  'reports/groupa'
);
console.log(`[${new Date().toISOString()}] 💾 Group A captured: ${groupAResults.length} tests`);


// ── STEP 8: Run GROUP B ───────────────────────────────────────────
printStep(8, '⚡ GROUP B — AI Selected Medium Risk Tests');

runTestsByAIPriority(
  'Group B',
  plan.groupB,
  false,
  'test-results/results-groupB.json'
);

// ── READ + GENERATE HTML immediately before Group C deletes file ──
groupBResults = readGroupResultsFromFile('test-results/results-groupB.json');
generateHtmlFromJson(                              // ← ADD THIS HERE
  'Group B — Medium Risk',
  'test-results/results-groupB.json',
  'reports/groupb'
);
console.log(`[${new Date().toISOString()}] 💾 Group B captured: ${groupBResults.length} tests`);

// ── STEP 9: Run GROUP C ───────────────────────────────────────────
printStep(9, '🟢 GROUP C — AI Selected Low Risk Tests');

runTestsByAIPriority(
  'Group C',
  plan.groupC,
  false,
  'test-results/results-groupC.json'
);

// ── READ + GENERATE HTML for Group C ──────────────────────────────
groupCResults = readGroupResultsFromFile('test-results/results-groupC.json');
generateHtmlFromJson(                              // ← ADD THIS HERE
  'Group C — Low Risk',
  'test-results/results-groupC.json',
  'reports/groupc'
);
console.log(`[${new Date().toISOString()}] 💾 Group C captured: ${groupCResults.length} tests`);


// ── Generate combined HTML report ─────────────────────────────
generateCombinedIndex();
 
 // ── STEP 10: Merge from memory & Save to DB ───────────────────────
printStep(10, '💾 Merging Group Results & Saving to PostgreSQL');

console.log(`[${new Date().toISOString()}] 🔀 Merging results from memory (Group A + B + C)...`);
console.log(`[${new Date().toISOString()}] ℹ️  Results captured in memory immediately after each group`);

// ── Merge all in-memory results — deduplicate by test name ────────
const seenTests  = new Set<string>();
const testResults: PlaywrightTestResult[] = [];

for (const [label, results] of [
  ['Group A', groupAResults],
  ['Group B', groupBResults],
  ['Group C', groupCResults],
] as [string, PlaywrightTestResult[]][]) {

  let added = 0;
  for (const r of results) {
    if (!seenTests.has(r.testName)) {
      seenTests.add(r.testName);
      testResults.push(r);
      added++;
    }
  }
  console.log(`[${new Date().toISOString()}] 📋 ${label}: ${added} tests merged`);
}

summary.totalTests = testResults.length;
summary.passed     = testResults.filter((r) => r.status === 'passed').length;
summary.failed     = testResults.filter((r) => r.status === 'failed').length;

console.log(
  `[${new Date().toISOString()}] ✅ Merged total: ${summary.totalTests} tests | ✅ ${summary.passed} passed | ❌ ${summary.failed} failed`
);

// ── Save to PostgreSQL ─────────────────────────────────────────────
if (summary.dbConnected && testResults.length > 0) {
  try {
    console.log(`[${new Date().toISOString()}] 💾 Saving build ${buildId} to database...`);
    await saveBuildRun(buildId, parseInt(buildNumber), testResults);

    console.log(`[${new Date().toISOString()}] 💾 Saving ${scores.length} risk predictions...`);
    await saveRiskPredictions(buildId, scores);

    console.log(`[${new Date().toISOString()}] ✅ Saved build ${buildId} to PostgreSQL`);
    console.log(`[${new Date().toISOString()}]    ✅ Passed: ${summary.passed} | ❌ Failed: ${summary.failed}`);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ DB save failed: ${error}`);
  }

} else if (testResults.length === 0) {
  console.warn(`[${new Date().toISOString()}] ⚠️  No test results to save`);

} else if (!summary.dbConnected) {
  console.warn(`[${new Date().toISOString()}] ⚠️  DB not connected — results not saved`);
}

if (testResults.length > 0) {
  updateHistoryJson(buildId, testResults, summary.dbConnected);
}
  // ── STEP 11: Retention Policy ─────────────────────────────────────
  printStep(11, '🧹 Applying Database Retention Policy');
  if (summary.dbConnected) {
    try {
      await applyRetentionPolicy(10, 90);
      await showStorageStats();
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ❌ Retention failed: ${error}`);
    }
  } else {
    console.log(`[${new Date().toISOString()}] ⏭️  Skipped — no DB`);
  }

  // ── FINAL SUMMARY ─────────────────────────────────────────────────
  summary.endTime = new Date();
  const elapsed   = ((Date.now() - startTime) / 1000).toFixed(1);
  const passRate  = summary.totalTests > 0
    ? ((summary.passed / summary.totalTests) * 100).toFixed(1) : '0';

  console.log('\n');
  console.log('═'.repeat(70));
  console.log('  📊 SMART RUN COMPLETE — FINAL SUMMARY');
  console.log('═'.repeat(70));
  console.log(`  🏗️  Build ID       : ${summary.buildId}`);
  console.log(`  ⏱️  Total time      : ${elapsed}s`);
  console.log(`  🧪 Total tests     : ${summary.totalTests}`);
  console.log(`  ✅ Passed          : ${summary.passed}`);
  console.log(`  ❌ Failed          : ${summary.failed}`);
  console.log(`  📈 Pass rate       : ${passRate}%`);
  console.log(`  🔴 Group A         : ${plan.groupA.length} tests (Critical/High)`);
  console.log(`  🟡 Group B         : ${plan.groupB.length} tests (Medium)`);
  console.log(`  🟢 Group C         : ${plan.groupC.length} tests (Low)`);
  console.log(`  🤖 AI engine       : ${summary.aiUsed ? 'Gemini 2.5 Flash Lite ✅' : 'Rule-based fallback ⚠️'}`);
  console.log(`  🗄️  Database        : ${summary.dbConnected ? 'Connected ✅' : 'Not connected ⚠️'}`);
  console.log(`  📄 Dashboard       : reports/priority-dashboard.html`);
  console.log(`  📋 Execution plan  : test-history/test-execution-order.json`);
  console.log('─'.repeat(70));
  console.log(
    `  🚦 Deploy Status   : ${summary.groupAFailed ? '❌ BLOCKED — Critical failures!' : '✅ CLEAR — Safe to deploy'}`
  );
  console.log('═'.repeat(70));
  console.log('\n');

  if (summary.groupAFailed) process.exit(1);
}

// ── Entry point ───────────────────────────────────────────────────────────────
smartRun().catch((error) => {
  console.error(`[${new Date().toISOString()}] [FATAL] Smart runner crashed: ${error}`);
  process.exit(1);
});