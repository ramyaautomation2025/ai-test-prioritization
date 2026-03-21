import pool from './dbClient';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { FinalRiskScore } from '../analyzer/riskScorer';
dotenv.config();

/**
 * Saves a new build run to the database
 */
export async function saveBuildRun(
  buildId: string,
  buildNumber: number,
  results: any[]
): Promise<void> {

  const totalTests  = results.length;
  const totalPassed = results.filter((r) => r.status === 'passed').length;
  const totalFailed = results.filter((r) => r.status === 'failed').length;

  console.log(`[${new Date().toISOString()}] 💾 Saving build ${buildId} to database...`);

  // Insert build run record
  await pool.query(
    `INSERT INTO build_runs
       (build_id, build_number, total_tests, total_passed, total_failed)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (build_id) DO NOTHING`,
    [buildId, buildNumber, totalTests, totalPassed, totalFailed]
  );

  // Insert all test results
  for (const result of results) {
    await pool.query(
      `INSERT INTO test_results
         (build_id, test_name, module, status, duration_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        buildId,
        result.testName,
        result.module,
        result.status,
        result.duration || 0,
        result.errorMessage || '',
      ]
    );
  }

  console.log(`[${new Date().toISOString()}] ✅ Saved ${results.length} test results to database`);
}

/**
 * Saves AI risk predictions for a build
 */
export async function saveRiskPredictions(
  buildId: string,
  scores: FinalRiskScore[]
): Promise<void> {

  console.log(`[${new Date().toISOString()}] 💾 Saving ${scores.length} risk predictions...`);

  for (const score of scores) {
    await pool.query(
      `INSERT INTO risk_predictions
         (build_id, test_name, module, risk_score, risk_level,
          ai_score, rule_score, reason, recommendation,
          failure_rate, recent_trend)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        buildId,
        score.testName,
        score.module,
        score.riskScore,
        score.riskLevel,
        score.aiScore,
        score.ruleScore,
        score.reason,
        score.recommendation,
        score.failureRate,
        score.recentTrend,
      ]
    );
  }

  console.log(`[${new Date().toISOString()}] ✅ Risk predictions saved to database`);
}

/**
 * Retention policy — keeps database clean
 * Hot data:  last 10 builds  → used by AI
 * Cold data: last 90 builds  → used for reports
 * Anything older than 90 builds → deleted
 */
export async function applyRetentionPolicy(
  hotWindow: number  = 10,
  coldWindow: number = 90
): Promise<void> {

  console.log(`[${new Date().toISOString()}] 🧹 Applying retention policy...`);
  console.log(`   Hot window  : last ${hotWindow} builds (AI analysis)`);
  console.log(`   Cold window : last ${coldWindow} builds (archive)`);

  // Find builds older than coldWindow
  const oldBuilds = await pool.query(
    `SELECT build_id FROM build_runs
     ORDER BY triggered_at DESC
     OFFSET $1`,
    [coldWindow]
  );

  if (oldBuilds.rows.length === 0) {
    console.log(`[${new Date().toISOString()}] ✅ No old builds to clean up`);
    return;
  }

  const oldBuildIds = oldBuilds.rows.map((r) => r.build_id);

  // Delete old risk predictions first (foreign key order)
  await pool.query(
    `DELETE FROM risk_predictions
     WHERE build_id = ANY($1)`,
    [oldBuildIds]
  );

  // Delete old test results
  await pool.query(
    `DELETE FROM test_results
     WHERE build_id = ANY($1)`,
    [oldBuildIds]
  );

  // Delete old build runs
  await pool.query(
    `DELETE FROM build_runs
     WHERE build_id = ANY($1)`,
    [oldBuildIds]
  );

  console.log(
    `[${new Date().toISOString()}] ✅ Cleaned up ${oldBuildIds.length} old builds`
  );
}

/**
 * Shows current database storage stats
 */
export async function showStorageStats(): Promise<void> {
  const stats = await pool.query(`
    SELECT
      COUNT(DISTINCT br.build_id)    AS total_builds,
      COUNT(tr.id)                   AS total_test_records,
      COUNT(rp.id)                   AS total_predictions,
      MIN(br.triggered_at)           AS oldest_build,
      MAX(br.triggered_at)           AS newest_build
    FROM build_runs br
    LEFT JOIN test_results    tr ON br.build_id = tr.build_id
    LEFT JOIN risk_predictions rp ON br.build_id = rp.build_id
  `);

  const row = stats.rows[0];

  console.log('\n📊 DATABASE STORAGE STATS:');
  console.log('─'.repeat(50));
  console.log(`   Total builds stored    : ${row.total_builds}`);
  console.log(`   Total test records     : ${row.total_test_records}`);
  console.log(`   Total AI predictions   : ${row.total_predictions}`);
  console.log(`   Oldest build           : ${row.oldest_build}`);
  console.log(`   Newest build           : ${row.newest_build}`);
  console.log('─'.repeat(50));
}