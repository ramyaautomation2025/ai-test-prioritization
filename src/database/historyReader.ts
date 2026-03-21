import pool from './dbClient';
import { TestTrend } from '../analyzer/trendAnalyzer';
import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Reads last N builds from database and returns
 * trend data in the same format as history.json
 * So rest of the pipeline works without any changes!
 */
export async function readHistoryFromDB(
  lastNBuilds: number = 10
): Promise<TestTrend[]> {

  console.log(`[${new Date().toISOString()}] 📊 Reading last ${lastNBuilds} builds from database...`);

  // Get last N build IDs ordered by date
  const buildsResult = await pool.query(
    `SELECT build_id, build_number, triggered_at
     FROM build_runs
     ORDER BY triggered_at DESC
     LIMIT $1`,
    [lastNBuilds]
  );

  const builds = buildsResult.rows;

  if (builds.length === 0) {
    console.warn(`[${new Date().toISOString()}] ⚠️  No builds found in database. Using history.json fallback.`);
    return [];
  }

  console.log(`[${new Date().toISOString()}] 📋 Found ${builds.length} builds in database`);

  const buildIds = builds.map((b) => b.build_id);

  // Get all test results for these builds
  const resultsQuery = await pool.query(
    `SELECT
       tr.test_name,
       tr.module,
       tr.status,
       tr.duration_ms,
       tr.error_message,
       tr.recorded_at,
       br.build_number
     FROM test_results tr
     JOIN build_runs br ON tr.build_id = br.build_id
     WHERE tr.build_id = ANY($1)
     ORDER BY br.triggered_at ASC, tr.test_name`,
    [buildIds]
  );

  // Group results by test name
  const testMap = new Map<string, {
    module: string;
    history: string[];
    durations: number[];
  }>();

  for (const row of resultsQuery.rows) {
    if (!testMap.has(row.test_name)) {
      testMap.set(row.test_name, {
        module: row.module,
        history: [],
        durations: [],
      });
    }
    const entry = testMap.get(row.test_name)!;
    entry.history.push(row.status);
    entry.durations.push(row.duration_ms);
  }

  // Convert to TestTrend format — same as trendAnalyzer output
  const trends: TestTrend[] = [];

  for (const [testName, data] of testMap.entries()) {
    const totalRuns     = data.history.length;
    const totalFailures = data.history.filter((s) => s === 'failed').length;
    const failureRate   = totalFailures / totalRuns;
    const lastStatus    = data.history[data.history.length - 1] as 'passed' | 'failed';
    const avgDuration   = Math.round(
      data.durations.reduce((a, b) => a + b, 0) / data.durations.length
    );

    // Calculate recent trend
    const recent = data.history.slice(-3);
    const older  = data.history.slice(-6, -3);
    const recentFails = recent.filter((s) => s === 'failed').length;
    const olderFails  = older.filter((s) => s === 'failed').length;
    const recentTrend =
      recentFails > olderFails ? 'worsening' :
      recentFails < olderFails ? 'improving' : 'stable';

    // Detect flakiness
    let switches = 0;
    for (let i = 1; i < data.history.length; i++) {
      if (data.history[i] !== data.history[i - 1]) switches++;
    }
    const isFlaky = switches / (data.history.length - 1) >= 0.4;

    // Detect recovery pattern
    let recoveryPattern = false;
    for (let i = 2; i < data.history.length; i++) {
      if (
        data.history[i] === 'failed' &&
        data.history[i - 1] === 'passed' &&
        data.history[i - 2] === 'failed'
      ) {
        recoveryPattern = true;
        break;
      }
    }

    trends.push({
      testName,
      module: data.module,
      totalRuns,
      totalFailures,
      failureRate: parseFloat(failureRate.toFixed(2)),
      recentTrend: recentTrend as 'worsening' | 'stable' | 'improving',
      isFlaky,
      recoveryPattern,
      lastStatus,
      failureHistory: data.history,
      avgDuration,
    });
  }

  trends.sort((a, b) => b.failureRate - a.failureRate);

  console.log(`[${new Date().toISOString()}] ✅ Loaded trends for ${trends.length} tests from database`);
  return trends;
}

/**
 * Gets useful statistics from the database
 * for the dashboard
 */
export async function getDatabaseStats(): Promise<object> {
  const stats = await pool.query(`
    SELECT
      COUNT(DISTINCT build_id)  AS total_builds,
      COUNT(*)                  AS total_test_runs,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS total_failures,
      SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS total_passes,
      MIN(recorded_at)          AS first_build_date,
      MAX(recorded_at)          AS latest_build_date
    FROM test_results
  `);

  return stats.rows[0];
}