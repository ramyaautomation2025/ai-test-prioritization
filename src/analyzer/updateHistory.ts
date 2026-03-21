import * as fs   from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

interface HistoryTestResult {
  testName    : string;
  status      : 'passed' | 'failed';
  duration    : number;
  module      : string;
  errorMessage: string;
}

interface HistoryBuild {
  buildId  : string;
  timestamp: string;
  results  : HistoryTestResult[];
}

/**
 * Appends the latest build results to history.json
 * keeping a rolling window of last 10 builds.
 *
 * Called after every smart run so history.json always
 * reflects real execution data — not just mock data.
 * Acts as a reliable fallback when DB is unavailable.
 */
export function updateHistoryJson(
  buildId    : string,
  testResults: HistoryTestResult[]
): void {

  const historyPath = path.join(
    process.cwd(),
    'test-history',
    'history.json'
  );

  console.log(`[${new Date().toISOString()}] 📝 Updating history.json...`);

  // Read existing history
  let history: { builds: HistoryBuild[] } = { builds: [] };

  try {
    if (fs.existsSync(historyPath)) {
      const raw = fs.readFileSync(historyPath, 'utf-8');
      history   = JSON.parse(raw);
    }
  } catch (error) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️  Could not read history.json — starting fresh`
    );
    history = { builds: [] };
  }

  // Build new entry from this run
  const newBuild: HistoryBuild = {
    buildId,
    timestamp: new Date().toISOString(),
    results  : testResults.map((r) => ({
      testName    : r.testName,
      status      : r.status,
      duration    : r.duration,
      module      : r.module,
      errorMessage: r.errorMessage || '',
    })),
  };

  // Check if this buildId already exists — avoid duplicates
  const alreadyExists = history.builds.some(
    (b) => b.buildId === buildId
  );

  if (alreadyExists) {
    console.log(
      `[${new Date().toISOString()}] ⏭️  Build ${buildId} already in history.json — skipping`
    );
    return;
  }

  // Append new build
  history.builds.push(newBuild);

  // Keep rolling window of last 10 builds
  if (history.builds.length > 10) {
    const removed = history.builds.shift();
    console.log(
      `[${new Date().toISOString()}] 🗑️  Removed oldest build: ${removed?.buildId}`
    );
  }

  // Write back to file
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

  // Confirm
  const passed = testResults.filter((r) => r.status === 'passed').length;
  const failed = testResults.filter((r) => r.status === 'failed').length;

  console.log(
    `[${new Date().toISOString()}] ✅ history.json updated`
  );
  console.log(
    `[${new Date().toISOString()}]    Build    : ${buildId}`
  );
  console.log(
    `[${new Date().toISOString()}]    Tests    : ${testResults.length} (✅ ${passed} passed | ❌ ${failed} failed)`
  );
  console.log(
    `[${new Date().toISOString()}]    Total    : ${history.builds.length}/10 builds in history`
  );
}