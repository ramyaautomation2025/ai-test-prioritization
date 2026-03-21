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
): { configPath: string; tempJsonPath: string } {

  const safeGroupName = groupName.toLowerCase().replace(/\s+/g, '');

  // ── KEY FIX: Write JSON to a NO-SPACE path first ───────────────
  // Playwright JSON reporter on Windows fails silently when
  // the output path contains spaces (e.g. "E:/AI Project/...")
  // Solution: write to a short path in TEMP folder (no spaces!)
  // then copy to final destination after Playwright finishes
  const tempJsonPath = path.join(
    process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp',
    `pw-results-${safeGroupName}-${Date.now()}.json`
  );

  // Normalize to forward slashes for config file
  const normalizedTempJsonPath = tempJsonPath.replace(/\\/g, '/');

  const configContent = [
    `const { defineConfig, devices } = require('@playwright/test');`,
    `require('dotenv').config();`,
    `module.exports = defineConfig({`,
    `  testDir : './tests',`,
    `  timeout : 30000,`,
    `  retries : 0,`,
    `  workers : 2,`,
    `  reporter: [`,
    `    ['list'],`,
    // Write to TEMP path — NO spaces, guaranteed writable
    `    ['json', { outputFile: ${JSON.stringify(normalizedTempJsonPath)} }],`,
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

  fs.writeFileSync(configPath, configContent);

  console.log(`[${new Date().toISOString()}] 📝 Config  : ${path.basename(configPath)}`);
  console.log(`[${new Date().toISOString()}] 📝 Temp JSON: ${tempJsonPath}`);

  return { configPath, tempJsonPath };
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
      const test   = spec.tests?.[0];
      const runRes = test?.results?.[0];
      if (!runRes) continue;

      results.push({
        testName    : `${fileName.replace('tests/', '')} > ${spec.title}`,
        module      : moduleName,
        status      : runRes.status === 'passed' ? 'passed' : 'failed',
        duration    : runRes.duration || 0,
        errorMessage: runRes.error?.message?.slice(0, 150) || '',
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
    console.warn(`[${new Date().toISOString()}] ⚠️  Cannot read ${outputFile} — file missing`);
    return [];
  }

  try {
    const raw  = fs.readFileSync(fullPath, 'utf-8');
    const data = JSON.parse(raw);

    if (!data.suites || data.suites.length === 0) {
      return [];
    }

    const results = extractFromSuites(data.suites || []);
    console.log(`[${new Date().toISOString()}] 📖 Read ${results.length} results from ${outputFile}`);
    return results;

  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Failed to read ${outputFile}: ${error}`);
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

// ── READ Group A results IMMEDIATELY before Group B can delete ────
groupAResults = readGroupResultsFromFile('test-results/results-groupA.json');
console.log(`[${new Date().toISOString()}] 💾 Group A results captured in memory: ${groupAResults.length} tests`);

// ── STEP 8: Run GROUP B ───────────────────────────────────────────
printStep(8, '⚡ GROUP B — AI Selected Medium Risk Tests');

runTestsByAIPriority(
  'Group B',
  plan.groupB,
  false,
  'test-results/results-groupB.json'
);

// ── READ Group B results IMMEDIATELY before Group C can delete ────
groupBResults = readGroupResultsFromFile('test-results/results-groupB.json');
console.log(`[${new Date().toISOString()}] 💾 Group B results captured in memory: ${groupBResults.length} tests`);

// ── STEP 9: Run GROUP C ───────────────────────────────────────────
printStep(9, '🟢 GROUP C — AI Selected Low Risk Tests');

runTestsByAIPriority(
  'Group C',
  plan.groupC,
  false,
  'test-results/results-groupC.json'
);

// ── READ Group C results ──────────────────────────────────────────
groupCResults = readGroupResultsFromFile('test-results/results-groupC.json');
console.log(`[${new Date().toISOString()}] 💾 Group C results captured in memory: ${groupCResults.length} tests`);
 
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
  updateHistoryJson(buildId, testResults);
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