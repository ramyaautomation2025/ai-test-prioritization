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
  testName: string;
  module: string;
  totalRuns: number;
  totalFailures: number;
  failureRate: number;
  recentTrend: 'worsening' | 'stable' | 'improving';
  isFlaky: boolean;
  recoveryPattern: boolean;
  lastStatus: 'passed' | 'failed';
  failureHistory: string[];
  avgDuration: number;
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
function detectFlakiness(history: string[]): boolean {
  let switches = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i] !== history[i - 1]) switches++;
  }
  // Flaky if it switches more than 40% of the time
  return switches / (history.length - 1) >= 0.4;
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

  // Collect all unique test names
  const testMap: Map<string, {
    module: string;
    history: string[];
    durations: number[];
  }> = new Map();

  // Loop through every build and every result
  for (const build of builds) {
    for (const result of build.results) {
      if (!testMap.has(result.testName)) {
        testMap.set(result.testName, {
          module: result.module,
          history: [],
          durations: [],
        });
      }
      const entry = testMap.get(result.testName)!;
      entry.history.push(result.status);
      entry.durations.push(result.duration);
    }
  }

  const trends: TestTrend[] = [];

  // Analyze each test
  for (const [testName, data] of testMap.entries()) {
    const totalRuns = data.history.length;
    const totalFailures = data.history.filter((s) => s === 'failed').length;
    const failureRate = totalFailures / totalRuns;
    const lastStatus = data.history[data.history.length - 1] as 'passed' | 'failed';
    const avgDuration = Math.round(
      data.durations.reduce((a, b) => a + b, 0) / data.durations.length
    );

    const trend: TestTrend = {
      testName,
      module: data.module,
      totalRuns,
      totalFailures,
      failureRate: parseFloat(failureRate.toFixed(2)),
      recentTrend: analyzeRecentTrend(data.history),
      isFlaky: detectFlakiness(data.history),
      recoveryPattern: detectRecoveryPattern(data.history),
      lastStatus,
      failureHistory: data.history,
      avgDuration,
    };

    trends.push(trend);
  }

  // Sort by failure rate descending
  trends.sort((a, b) => b.failureRate - a.failureRate);

  console.log(`[${new Date().toISOString()}] ✅ Analyzed ${trends.length} tests across ${builds.length} builds`);

  // Print summary to console
  console.log('\n📋 TREND SUMMARY:');
  console.log('─'.repeat(80));
  for (const t of trends) {
    const icon = t.failureRate >= 0.6 ? '🔴' : t.failureRate >= 0.4 ? '🟠' : t.failureRate >= 0.2 ? '🟡' : '🟢';
    console.log(
      `${icon} ${t.testName.padEnd(50)} | FailRate: ${(t.failureRate * 100).toFixed(0)}% | Trend: ${t.recentTrend}`
    );
  }
  console.log('─'.repeat(80));

  return trends;
}

// Run directly if called as script
if (require.main === module) {
  analyzeTrends();
}