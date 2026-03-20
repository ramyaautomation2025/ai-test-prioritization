import { analyzeTrends }  from '../analyzer/trendAnalyzer';
import { predictWithGemini } from '../ai/geminiPredictor';
import { computeFinalScores } from '../analyzer/riskScorer';
import { buildExecutionPlan } from '../prioritizer/reorderSuite';
import { generateDashboard }  from '../reporter/dashboardGenerator';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';

dotenv.config();

/**
 * Master smart runner — full pipeline:
 * Analyze → Predict → Score → Prioritize → Dashboard → Run
 */
async function smartRun(): Promise<void> {
  const startTime = Date.now();
  const buildNumber = process.env.BUILD_NUMBER || '011';

  console.log('\n');
  console.log('═'.repeat(70));
  console.log('  🤖 AI-DRIVEN SMART TEST RUNNER');
  console.log(`  Build #${buildNumber} — ${new Date().toLocaleString()}`);
  console.log('═'.repeat(70));

  // ── STEP 1: Analyze trends ──────────────────────────────────────────────
  console.log('\n📊 STEP 1: Analyzing CI failure trends...\n');
  const trends = analyzeTrends();

  // ── STEP 2: AI Prediction ───────────────────────────────────────────────
  console.log('\n🤖 STEP 2: Running Gemini AI prediction...\n');
  const predictions = await predictWithGemini(trends);

  // ── STEP 3: Compute final scores ────────────────────────────────────────
  console.log('\n⚖️  STEP 3: Computing final risk scores...\n');
  const scores = computeFinalScores(trends, predictions);

  // ── STEP 4: Build execution plan ────────────────────────────────────────
  console.log('\n📋 STEP 4: Building execution plan...\n');
  const plan = buildExecutionPlan(scores);

  // ── STEP 5: Generate dashboard ──────────────────────────────────────────
  console.log('\n🎨 STEP 5: Generating risk dashboard...\n');
  generateDashboard(scores, plan, buildNumber);

  // ── STEP 6: Run Group A ─────────────────────────────────────────────────
  console.log('\n🚨 STEP 6: Running GROUP A — Critical & High Risk Tests...\n');
  console.log('─'.repeat(70));

  let groupAFailed = false;
  try {
    execSync('npx playwright test --grep @critical --reporter=list', {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    console.log('\n✅ Group A: All critical tests PASSED');
  } catch {
    groupAFailed = true;
    console.log('\n⚠️  Group A: Some critical tests FAILED — continuing pipeline...');
  }

  // ── STEP 7: Run Group B ─────────────────────────────────────────────────
  console.log('\n⚡ STEP 7: Running GROUP B — Medium Risk Tests...\n');
  console.log('─'.repeat(70));

  try {
    execSync('npx playwright test --grep @regression --reporter=list', {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    console.log('\n✅ Group B: All medium risk tests PASSED');
  } catch {
    console.log('\n⚠️  Group B: Some medium risk tests FAILED');
  }

  // ── STEP 8: Run Group C ─────────────────────────────────────────────────
  console.log('\n🟢 STEP 8: Running GROUP C — Low Risk Tests...\n');
  console.log('─'.repeat(70));

  try {
    execSync('npx playwright test --grep @smoke --reporter=list', {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    console.log('\n✅ Group C: All low risk tests PASSED');
  } catch {
    console.log('\n⚠️  Group C: Some low risk tests FAILED');
  }

  // ── FINAL SUMMARY ───────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n');
  console.log('═'.repeat(70));
  console.log('  📊 SMART RUN COMPLETE');
  console.log('═'.repeat(70));
  console.log(`  ⏱️  Total time    : ${elapsed}s`);
  console.log(`  🔴 Critical/High  : ${plan.groupA.length} tests (Group A)`);
  console.log(`  🟡 Medium         : ${plan.groupB.length} tests (Group B)`);
  console.log(`  🟢 Low            : ${plan.groupC.length} tests (Group C)`);
  console.log(`  📄 Dashboard      : reports/priority-dashboard.html`);
  console.log(`  📋 Execution Plan : test-history/test-execution-order.json`);
  console.log(
    `  🚦 Deploy Status  : ${groupAFailed ? '❌ BLOCKED — Critical failures detected' : '✅ CLEAR — No critical failures'}`
  );
  console.log('═'.repeat(70));
  console.log('\n');
}

smartRun().catch((err) => {
  console.error(`[FATAL] Smart runner failed: ${err}`);
  process.exit(1);
});