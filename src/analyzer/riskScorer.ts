import { TestTrend } from './trendAnalyzer';
import { AIPrediction } from '../ai/geminiPredictor';

/**
 * Final risk score combining AI + rule-based scoring
 */
export interface FinalRiskScore {
  testName: string;
  module: string;
  riskScore: number;
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  reason: string;
  recommendation: 'run-first' | 'run-early' | 'run-normal' | 'deprioritize';
  failureRate: number;
  recentTrend: 'worsening' | 'stable' | 'improving';
  isFlaky: boolean;
  lastStatus: 'passed' | 'failed';
  failureHistory: string[];
  aiScore: number;
  ruleScore: number;
}

/**
 * Computes a pure rule-based score for a test trend
 */
function computeRuleScore(trend: TestTrend): number {
  let score = 0;

  // Failure rate
  if (trend.failureRate >= 0.6) score += 40;
  else if (trend.failureRate >= 0.4) score += 25;
  else if (trend.failureRate >= 0.2) score += 10;

  // Recent trend
  if (trend.recentTrend === 'worsening') score += 25;
  else if (trend.recentTrend === 'improving') score -= 10;

  // Flakiness (existing)
  if (trend.isFlaky) score += 15;

  // Recovery pattern
  if (trend.recoveryPattern) score += 20;

  // Last status
  if (trend.lastStatus === 'failed') score += 10;

  // ── NEW: Retry-based scoring ───────────────────────────────────
  // Tests that consistently need retries deserve higher risk scores
  // even if they eventually pass — they are hiding real instability
  if (trend.retryRate >= 0.5) score += 20;       // retried in 50%+ of runs
  else if (trend.retryRate >= 0.3) score += 12;  // retried in 30%+ of runs
  else if (trend.retryRate >= 0.2) score += 6;   // retried in 20%+ of runs

  return Math.max(0, Math.min(score, 100));
}

/**
 * Determines risk level from a numeric score
 */
function getRiskLevel(score: number): FinalRiskScore['riskLevel'] {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

/**
 * Determines recommendation from risk level
 */
function getRecommendation(riskLevel: FinalRiskScore['riskLevel']): FinalRiskScore['recommendation'] {
  switch (riskLevel) {
    case 'critical': return 'run-first';
    case 'high':     return 'run-early';
    case 'medium':   return 'run-normal';
    case 'low':      return 'deprioritize';
  }
}

/**
 * Combines AI prediction (70%) and rule-based score (30%)
 * into a single final risk score
 */
export function computeFinalScores(
  trends: TestTrend[],
  aiPredictions: AIPrediction[]
): FinalRiskScore[] {

  console.log(`[${new Date().toISOString()}] ⚖️  Computing final risk scores (AI 70% + Rules 30%)...`);

  const finalScores: FinalRiskScore[] = [];

  for (const trend of trends) {
    // Find matching AI prediction
    const aiPrediction = aiPredictions.find(
      (p) => p.testName === trend.testName
    );

    const aiScore = aiPrediction ? aiPrediction.riskScore : 0;
    const ruleScore = computeRuleScore(trend);

    // Weighted combination: 70% AI + 30% rule-based
    const combinedScore = Math.round(aiScore * 0.7 + ruleScore * 0.3);
    const finalScore = Math.min(combinedScore, 100);

    const riskLevel = getRiskLevel(finalScore);
    const recommendation = getRecommendation(riskLevel);

    finalScores.push({
      testName: trend.testName,
      module: trend.module,
      riskScore: finalScore,
      riskLevel,
      reason: aiPrediction?.reason || `Rule-based: ${(trend.failureRate * 100).toFixed(0)}% failure rate`,
      recommendation,
      failureRate: trend.failureRate,
      recentTrend: trend.recentTrend,
      isFlaky: trend.isFlaky,
      lastStatus: trend.lastStatus,
      failureHistory: trend.failureHistory,
      aiScore,
      ruleScore,
    });
  }

  // Sort: critical → high → medium → low, then by score descending
  finalScores.sort((a, b) => {
    const levelOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const levelDiff = levelOrder[a.riskLevel] - levelOrder[b.riskLevel];
    if (levelDiff !== 0) return levelDiff;
    return b.riskScore - a.riskScore;
  });

  console.log(`[${new Date().toISOString()}] ✅ Final scores computed for ${finalScores.length} tests`);

  // Print final risk table
  console.log('\n🎯 FINAL RISK SCORES:');
  console.log('─'.repeat(90));
  console.log('Icon | Score | Level    | Recommendation | Test');
  console.log('─'.repeat(90));

  for (const s of finalScores) {
    const icon =
      s.riskLevel === 'critical' ? '🔴' :
      s.riskLevel === 'high'     ? '🟠' :
      s.riskLevel === 'medium'   ? '🟡' : '🟢';
    console.log(
      `${icon}   | ${String(s.riskScore).padEnd(5)} | ${s.riskLevel.padEnd(8)} | ${s.recommendation.padEnd(14)} | ${s.testName}`
    );
  }
  console.log('─'.repeat(90));

  return finalScores;
}