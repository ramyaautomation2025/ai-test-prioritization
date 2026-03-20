import * as dotenv from 'dotenv';
import { TestTrend } from '../analyzer/trendAnalyzer';
dotenv.config();

/**
 * AI prediction result for a single test
 */
export interface AIPrediction {
  testName: string;
  riskScore: number;
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  reason: string;
  recommendation: 'run-first' | 'run-early' | 'run-normal' | 'deprioritize';
}

/**
 * Rule-based fallback scorer when AI API is unavailable
 */
function ruleBasedScore(trend: TestTrend): AIPrediction {
  let score = 0;

  if (trend.failureRate >= 0.6) score += 40;
  else if (trend.failureRate >= 0.4) score += 25;
  else if (trend.failureRate >= 0.2) score += 10;

  if (trend.recentTrend === 'worsening') score += 25;
  if (trend.isFlaky) score += 15;
  if (trend.recoveryPattern) score += 20;
  if (trend.lastStatus === 'failed') score += 10;

  score = Math.min(score, 100);

  const riskLevel: AIPrediction['riskLevel'] =
    score >= 80 ? 'critical' :
    score >= 60 ? 'high' :
    score >= 40 ? 'medium' : 'low';

  const recommendation: AIPrediction['recommendation'] =
    score >= 80 ? 'run-first' :
    score >= 60 ? 'run-early' :
    score >= 40 ? 'run-normal' : 'deprioritize';

  return {
    testName: trend.testName,
    riskScore: score,
    riskLevel,
    reason: `Rule-based: ${(trend.failureRate * 100).toFixed(0)}% failure rate, trend: ${trend.recentTrend}`,
    recommendation,
  };
}

/**
 * Calls Gemini API to predict risk for all tests based on trend data
 */
export async function predictWithGemini(
  trends: TestTrend[]
): Promise<AIPrediction[]> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn(
      `[${new Date().toISOString()}] ⚠️  GEMINI_API_KEY not found. Using rule-based fallback.`
    );
    return trends.map(ruleBasedScore);
  }

  console.log(`[${new Date().toISOString()}] 🤖 Calling Gemini AI for risk prediction...`);

  // Prepare a clean summary for the prompt (avoid sending too much data)
  const trendSummary = trends.map((t) => ({
    testName: t.testName,
    module: t.module,
    failureRate: t.failureRate,
    recentTrend: t.recentTrend,
    isFlaky: t.isFlaky,
    recoveryPattern: t.recoveryPattern,
    lastStatus: t.lastStatus,
    failureHistory: t.failureHistory.join(','),
  }));

  const prompt = `
You are a QA intelligence engine analyzing CI/CD test failure trends.
Based on the following test trend data from the last 10 builds,
predict the risk of each test failing in the NEXT build.

Trend Data:
${JSON.stringify(trendSummary, null, 2)}

Rules for scoring:
- High failureRate (>0.6) = high risk
- Worsening recent trend = higher risk
- Flaky tests = medium-high risk
- Recovery pattern (fixed then broke again) = high risk
- Last status failed = higher risk
- Stable passing tests = low risk

For each test assign:
- riskScore: 0 to 100 (100 = almost certain to fail)
- riskLevel: exactly one of: critical, high, medium, low
- reason: one clear sentence explaining the score
- recommendation: exactly one of: run-first, run-early, run-normal, deprioritize

Return ONLY a valid JSON array. 
No explanation. No markdown. No code blocks. No extra text.
Start your response with [ and end with ]

Format:
[
  {
    "testName": "exact test name from input",
    "riskScore": 85,
    "riskLevel": "critical",
    "reason": "Failed 8 of last 10 builds with worsening trend",
    "recommendation": "run-first"
  }
]`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 2000,
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    console.log(`[${new Date().toISOString()}] ✅ Gemini responded successfully`);

    // Clean response — remove any accidental markdown
    const cleaned = rawText
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    const predictions: AIPrediction[] = JSON.parse(cleaned);

    // Validate we got predictions for all tests
    if (predictions.length !== trends.length) {
      console.warn(`[${new Date().toISOString()}] ⚠️  Gemini returned ${predictions.length} predictions for ${trends.length} tests. Filling gaps with rule-based.`);

      // Fill any missing tests with rule-based scores
      const predictedNames = predictions.map((p) => p.testName);
      for (const trend of trends) {
        if (!predictedNames.includes(trend.testName)) {
          predictions.push(ruleBasedScore(trend));
        }
      }
    }

    return predictions;

  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] ❌ Gemini API failed: ${error}. Falling back to rule-based scoring.`
    );
    return trends.map(ruleBasedScore);
  }
}

// Run directly if called as script
if (require.main === module) {
  (async () => {
    const { analyzeTrends } = await import('../analyzer/trendAnalyzer');
    const trends = analyzeTrends();
    const predictions = await predictWithGemini(trends);

    console.log('\n🤖 AI PREDICTIONS:');
    console.log('─'.repeat(80));
    for (const p of predictions) {
      const icon =
        p.riskLevel === 'critical' ? '🔴' :
        p.riskLevel === 'high' ? '🟠' :
        p.riskLevel === 'medium' ? '🟡' : '🟢';
      console.log(`${icon} [${p.riskScore}] ${p.testName}`);
      console.log(`   → ${p.reason}`);
      console.log(`   → Recommendation: ${p.recommendation}\n`);
    }
  })();
}