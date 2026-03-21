import * as fs from 'fs';
import * as path from 'path';

/**
 * Represents a single test result from a build
 */
export interface TestResult {
  testName: string;
  status: 'passed' | 'failed' | 'flaky';
  duration: number;
  module: string;
  errorMessage: string;
}

/**
 * Represents a single build with all its test results
 */
export interface Build {
  buildId: string;
  timestamp: string;
  results: TestResult[];
}

/**
 * Represents the analyzed trend for a single test
 */
export interface TestTrend {
  testName        : string;
  module          : string;
  totalRuns       : number;
  totalFailures   : number;
  failureRate     : number;
  recentTrend     : 'worsening' | 'stable' | 'improving';
  isFlaky         : boolean;
  flakinesReason  : string;   // ← NEW: explains WHY it is flaky
  retryRate       : number;   // ← NEW: % of runs that needed retries
  recoveryPattern : boolean;
  lastStatus      : 'passed' | 'failed';
  failureHistory  : string[];
  avgDuration     : number;
}

/**
 * Reads and parses the history.json file
 */
function loadHistory(): Build[] {
  const historyPath = path.join(process.cwd(), 'test-history', 'history.json');
  const raw = fs.readFileSync(historyPath, 'utf-8');
  const data = JSON.parse(raw);
  return data.builds;
}

/**
 * Detects if a test is flaky — alternates between pass and fail
 */
/**
 * Enhanced flakiness detection — checks BOTH patterns:
 *
 * Pattern 1 (existing): Alternating pass/fail across builds
 *   build1=pass, build2=fail, build3=pass, build4=fail → flaky
 *
 * Pattern 2 (NEW): Test passes but needed retries
 *   build1=passed(retries:0), build2=passed(retries:1) → flaky!
 *   The retry is a hidden failure that gets masked as "passed"
 */
function detectFlakinessEnhanced(
  history   : string[],
  retryCounts: number[]
): { isFlaky: boolean; reason: string; retryRate: number } {

  // ── Pattern 1: Alternating pass/fail ──────────────────────────
  let switches = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i] !== history[i - 1]) switches++;
  }
  const switchRate = history.length > 1
    ? switches / (history.length - 1)
    : 0;
  const isAlternatingFlaky = switchRate >= 0.4;

  // ── Pattern 2: Retry-based flakiness ──────────────────────────
  // A test that needed retries to pass is flaky even if final=passed
  const runsWithRetries = retryCounts.filter((r) => r > 0).length;
  const retryRate       = retryCounts.length > 0
    ? runsWithRetries / retryCounts.length
    : 0;
  const isRetryFlaky = retryRate >= 0.2;  // flaky if 20%+ runs need retry

  // ── Combined result ────────────────────────────────────────────
  const isFlaky = isAlternatingFlaky || isRetryFlaky;

  let reason = '';
  if (isAlternatingFlaky && isRetryFlaky) {
    reason = `Alternating pass/fail (${(switchRate * 100).toFixed(0)}% switches) AND needed retries in ${(retryRate * 100).toFixed(0)}% of runs`;
  } else if (isAlternatingFlaky) {
    reason = `Alternating pass/fail pattern — switches ${(switchRate * 100).toFixed(0)}% of runs`;
  } else if (isRetryFlaky) {
    reason = `Passed only after retries in ${(retryRate * 100).toFixed(0)}% of runs — hidden flakiness`;
  }

  return { isFlaky, reason, retryRate };
}

/**
 * Detects recovery pattern — test was fixed but broke again
 * Pattern: failed → passed → failed again
 */
function detectRecoveryPattern(history: string[]): boolean {
  for (let i = 2; i < history.length; i++) {
    if (
      history[i] === 'failed' &&
      history[i - 1] === 'passed' &&
      history[i - 2] === 'failed'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Analyzes the trend of the last 3 builds
 * Worsening = more failures recently
 * Improving = fewer failures recently
 */
function analyzeRecentTrend(
  history: string[]
): 'worsening' | 'stable' | 'improving' {
  if (history.length < 4) return 'stable';

  const recent = history.slice(-3);
  const older = history.slice(-6, -3);

  const recentFailures = recent.filter((s) => s === 'failed').length;
  const olderFailures = older.filter((s) => s === 'failed').length;

  if (recentFailures > olderFailures) return 'worsening';
  if (recentFailures < olderFailures) return 'improving';
  return 'stable';
}

/**
 * Main analyzer — reads history and computes trends for all tests
 */
export function analyzeTrends(): TestTrend[] {
  console.log(`[${new Date().toISOString()}] 📊 Starting trend analysis...`);

  const builds = loadHistory();

  const testMap = new Map<string, {
    module     : string;
    history    : string[];
    durations  : number[];
    retryCounts: number[];   // ← NEW
  }>();

  for (const build of builds) {
    for (const result of build.results) {
      if (!testMap.has(result.testName)) {
        testMap.set(result.testName, {
          module     : result.module,
          history    : [],
          durations  : [],
          retryCounts: [],
        });
      }
      const entry = testMap.get(result.testName)!;
      entry.history.push(result.status);
      entry.durations.push(result.duration);
      // ← NEW: read retryCount from history, default 0 if not present
      entry.retryCounts.push((result as any).retryCount || 0);
    }
  }

  const trends: TestTrend[] = [];

  for (const [testName, data] of testMap.entries()) {
    const totalRuns     = data.history.length;
    const totalFailures = data.history.filter((s) => s === 'failed').length;
    const failureRate   = totalFailures / totalRuns;
    const lastStatus    = data.history[data.history.length - 1] as 'passed' | 'failed';
    const avgDuration   = Math.round(
      data.durations.reduce((a, b) => a + b, 0) / data.durations.length
    );

    // ── Enhanced flakiness using retry data ───────────────────────
    const { isFlaky, reason, retryRate } = detectFlakinessEnhanced(
      data.history,
      data.retryCounts
    );

    trends.push({
      testName,
      module         : data.module,
      totalRuns,
      totalFailures,
      failureRate    : parseFloat(failureRate.toFixed(2)),
      recentTrend    : analyzeRecentTrend(data.history),
      isFlaky,
      flakinesReason : reason,   // ← NEW
      retryRate      : parseFloat(retryRate.toFixed(2)),   // ← NEW
      recoveryPattern: detectRecoveryPattern(data.history),
      lastStatus,
      failureHistory : data.history,
      avgDuration,
    });
  }

  trends.sort((a, b) => b.failureRate - a.failureRate);

  // ── Print enhanced summary ─────────────────────────────────────
  console.log(
    `[${new Date().toISOString()}] ✅ Analyzed ${trends.length} tests across ${builds.length} builds`
  );

  console.log('\n📋 TREND SUMMARY:');
  console.log('─'.repeat(90));
  for (const t of trends) {
    const icon =
      t.failureRate >= 0.6 ? '🔴' :
      t.failureRate >= 0.4 ? '🟠' :
      t.failureRate >= 0.2 ? '🟡' : '🟢';

    const retryIcon = t.retryRate > 0 ? ` 🔄 retry:${(t.retryRate * 100).toFixed(0)}%` : '';
    const flakyIcon = t.isFlaky ? ' ⚡flaky' : '';

    console.log(
      `${icon} ${t.testName.padEnd(55)} | Fail:${(t.failureRate * 100).toFixed(0)}% | ${t.recentTrend}${retryIcon}${flakyIcon}`
    );
  }
  console.log('─'.repeat(90));

  return trends;
}
// Run directly if called as script
if (require.main === module) {
  analyzeTrends();
}