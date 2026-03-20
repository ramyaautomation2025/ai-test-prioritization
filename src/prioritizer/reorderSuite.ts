import * as fs from 'fs';
import * as path from 'path';
import { FinalRiskScore } from '../analyzer/riskScorer';

/**
 * Represents a single prioritized test entry
 */
export interface PrioritizedTest {
  priority: number;
  testFile: string;
  testName: string;
  riskScore: number;
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  recommendation: string;
  runGroup: 'A' | 'B' | 'C';
  module: string;
}

/**
 * Represents the full execution plan
 */
export interface ExecutionPlan {
  generatedAt: string;
  totalTests: number;
  groupA: PrioritizedTest[];  // critical + high  → run first, blocks deploy
  groupB: PrioritizedTest[];  // medium           → run after A
  groupC: PrioritizedTest[];  // low              → run last, non-blocking
  orderedList: PrioritizedTest[];
}

/**
 * Extracts the test file name from a full test name
 * e.g. "login.spec.ts > valid login" → "tests/login.spec.ts"
 */
function extractTestFile(testName: string): string {
  const parts = testName.split('>')[0].trim();
  return `tests/${parts}`;
}

/**
 * Assigns a test to a run group based on risk level
 */
function assignRunGroup(
  riskLevel: FinalRiskScore['riskLevel']
): 'A' | 'B' | 'C' {
  switch (riskLevel) {
    case 'critical': return 'A';
    case 'high':     return 'A';
    case 'medium':   return 'B';
    case 'low':      return 'C';
  }
}

/**
 * Builds the full prioritized execution plan from final risk scores
 */
export function buildExecutionPlan(
  scores: FinalRiskScore[]
): ExecutionPlan {

  console.log(`[${new Date().toISOString()}] 📋 Building test execution plan...`);

  const orderedList: PrioritizedTest[] = scores.map((score, index) => ({
    priority: index + 1,
    testFile: extractTestFile(score.testName),
    testName: score.testName,
    riskScore: score.riskScore,
    riskLevel: score.riskLevel,
    recommendation: score.recommendation,
    runGroup: assignRunGroup(score.riskLevel),
    module: score.module,
  }));

  const groupA = orderedList.filter((t) => t.runGroup === 'A');
  const groupB = orderedList.filter((t) => t.runGroup === 'B');
  const groupC = orderedList.filter((t) => t.runGroup === 'C');

  const plan: ExecutionPlan = {
    generatedAt: new Date().toISOString(),
    totalTests: orderedList.length,
    groupA,
    groupB,
    groupC,
    orderedList,
  };

  // Save execution order to file
  const outputPath = path.join(
    process.cwd(),
    'test-history',
    'test-execution-order.json'
  );
  fs.writeFileSync(outputPath, JSON.stringify(plan, null, 2));

  console.log(`[${new Date().toISOString()}] ✅ Execution plan saved to test-history/test-execution-order.json`);

  // Print group summary
  console.log('\n🚦 EXECUTION GROUPS:');
  console.log('─'.repeat(70));

  console.log(`\n🔴 GROUP A — Run First (Blocks Deployment) [${groupA.length} tests]`);
  groupA.forEach((t) =>
    console.log(`   P${t.priority} | Score: ${t.riskScore} | ${t.testName}`)
  );

  console.log(`\n🟡 GROUP B — Run After A [${groupB.length} tests]`);
  groupB.forEach((t) =>
    console.log(`   P${t.priority} | Score: ${t.riskScore} | ${t.testName}`)
  );

  console.log(`\n🟢 GROUP C — Run Last (Non-Blocking) [${groupC.length} tests]`);
  groupC.forEach((t) =>
    console.log(`   P${t.priority} | Score: ${t.riskScore} | ${t.testName}`)
  );

  console.log('─'.repeat(70));
  console.log(
    `\n✅ Total: ${groupA.length} critical/high | ${groupB.length} medium | ${groupC.length} low\n`
  );

  return plan;
}

// Run directly if called as script
if (require.main === module) {
  (async () => {
    const { analyzeTrends } = await import('../analyzer/trend-analyzer');
    const { predictWithGemini } = await import('../ai/geminiPredictor');
    const { computeFinalScores } = await import('../analyzer/riskScorer');

    const trends = analyzeTrends();
    const predictions = await predictWithGemini(trends);
    const scores = computeFinalScores(trends, predictions);
    buildExecutionPlan(scores);
  })();
}