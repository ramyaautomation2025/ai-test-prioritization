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
  retryCount  : number;   // ← NEW: how many retries were needed
}

interface HistoryBuild {
  buildId  : string;
  timestamp: string;
  results  : HistoryTestResult[];
}

/**
 * Reads Playwright results.json and extracts retry count per test.
 *
 * Playwright stores ALL attempts (initial + retries) in results array:
 * results[0] = first attempt  (may have failed)
 * results[1] = first retry    (may have failed)
 * results[2] = second retry   (final result)
 *
 * retryCount = results.length - 1
 * If retryCount > 0 AND final status = passed → FLAKY test!
 */
function readPlaywrightResultsWithRetries(
  resultsPath: string
): HistoryTestResult[] {

  if (!fs.existsSync(resultsPath)) {
    console.warn(`[${new Date().toISOString()}] ⚠️  No results.json at ${resultsPath}`);
    return [];
  }

  try {
    const raw  = fs.readFileSync(resultsPath, 'utf-8');
    const data = JSON.parse(raw);
    const testResults: HistoryTestResult[] = [];

    function extractFromSuites(suites: any[], parentFile: string = '') {
      for (const suite of suites || []) {
        const fileName   = suite.file || parentFile;
        const moduleName = fileName
          .replace('tests/', '')
          .replace('.spec.ts', '');

        for (const spec of suite.specs || []) {
          for (const test of spec.tests || []) {

            // ── KEY: results array contains ALL attempts ──────────
            const allAttempts = test.results || [];
            const totalAttempts = allAttempts.length;

            // Final result is the last attempt
            const finalAttempt = allAttempts[totalAttempts - 1];
            if (!finalAttempt) continue;

            // retryCount = attempts beyond the first one
            const retryCount = Math.max(0, totalAttempts - 1);

            // Final status
            const finalStatus = finalAttempt.status === 'passed'
              ? 'passed'
              : 'failed';

            // Error from first failure (most informative)
            const firstFailure = allAttempts.find(
              (r: any) => r.status !== 'passed'
            );
            const errorMessage = firstFailure?.error?.message
              ?.slice(0, 150) || '';

            // Log retry detection
            if (retryCount > 0) {
              console.log(
                `[${new Date().toISOString()}] 🔄 Retry detected: ${spec.title}`
              );
              console.log(
                `   Attempts: ${totalAttempts} | Final: ${finalStatus} | Retries: ${retryCount}`
              );
            }

            testResults.push({
              testName    : `${fileName.replace('tests/', '')} > ${spec.title}`,
              module      : moduleName,
              status      : finalStatus,
              duration    : finalAttempt.duration || 0,
              errorMessage,
              retryCount,
            });
          }
        }

        if (suite.suites?.length) {
          extractFromSuites(suite.suites, fileName);
        }
      }
    }

    extractFromSuites(data.suites || []);

    // Summary of retries found
    const retriedTests = testResults.filter((r) => r.retryCount > 0);
    if (retriedTests.length > 0) {
      console.log(
        `\n[${new Date().toISOString()}] ⚠️  ${retriedTests.length} tests needed retries:`
      );
      retriedTests.forEach((t) =>
        console.log(
          `   → ${t.testName} (${t.retryCount} retry, final: ${t.status})`
        )
      );
    }

    return testResults;

  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Failed to read results.json: ${error}`
    );
    return [];
  }
}

/**
 * Updates history.json with latest build results including retry counts.
 * Only runs when DB is not the primary source.
 */
export function updateHistoryJson(
  buildId    : string,
  testResults: HistoryTestResult[],
  isDBActive : boolean = false
): void {

  if (isDBActive) {
    console.log(
      `[${new Date().toISOString()}] ⏭️  DB active — skipping history.json update`
    );
    return;
  }

  const historyPath = path.join(
    process.cwd(),
    'test-history',
    'history.json'
  );

  console.log(`[${new Date().toISOString()}] 📝 Updating history.json...`);

  let history: { builds: HistoryBuild[] } = { builds: [] };

  try {
    if (fs.existsSync(historyPath)) {
      const raw = fs.readFileSync(historyPath, 'utf-8');
      history   = JSON.parse(raw);
    }
  } catch {
    history = { builds: [] };
  }

  // Avoid duplicates
  if (history.builds.some((b) => b.buildId === buildId)) {
    console.log(
      `[${new Date().toISOString()}] ⏭️  Build ${buildId} already exists`
    );
    return;
  }

  history.builds.push({
    buildId,
    timestamp: new Date().toISOString(),
    results  : testResults,
  });

  // Rolling window of last 10 builds
  if (history.builds.length > 10) {
    const removed = history.builds.shift();
    console.log(
      `[${new Date().toISOString()}] 🗑️  Removed oldest: ${removed?.buildId}`
    );
  }

  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

  const passed  = testResults.filter((r) => r.status === 'passed').length;
  const failed  = testResults.filter((r) => r.status === 'failed').length;
  const retried = testResults.filter((r) => r.retryCount > 0).length;

  console.log(`[${new Date().toISOString()}] ✅ history.json updated`);
  console.log(`[${new Date().toISOString()}]    Tests  : ${testResults.length}`);
  console.log(`[${new Date().toISOString()}]    Passed : ${passed}`);
  console.log(`[${new Date().toISOString()}]    Failed : ${failed}`);
  console.log(`[${new Date().toISOString()}]    Retried: ${retried} ← flaky candidates`);
}