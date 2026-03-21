import * as dotenv from 'dotenv';
import { TestTrend } from '../analyzer/trendAnalyzer';
dotenv.config();

export interface AIPrediction {
  testName      : string;
  riskScore     : number;
  riskLevel     : 'critical' | 'high' | 'medium' | 'low';
  reason        : string;
  recommendation: 'run-first' | 'run-early' | 'run-normal' | 'deprioritize';
}

// ── Helpers ───────────────────────────────────────────────────────

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
    score >= 80 ? 'critical' : score >= 60 ? 'high' :
    score >= 40 ? 'medium'   : 'low';

  const recommendation: AIPrediction['recommendation'] =
    score >= 80 ? 'run-first'  : score >= 60 ? 'run-early' :
    score >= 40 ? 'run-normal' : 'deprioritize';

  return {
    testName      : trend.testName,
    riskScore     : score,
    riskLevel,
    reason        : `Rule-based: ${(trend.failureRate * 100).toFixed(0)}% failure rate, trend: ${trend.recentTrend}`,
    recommendation,
  };
}

function extractJSONArray(text: string): string | null {
  const match = text.match(/\[[\s\S]*\]/);
  return match ? match[0] : null;
}

function repairJSON(json: string): string {
  return json
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/,\s*}/g, '}')
    .replace(/,\s*\]/g, ']');
}

/**
 * Splits array into chunks of given size
 */
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// ── Single chunk API call ─────────────────────────────────────────

async function predictChunk(
  trends: TestTrend[],
  apiKey: string
): Promise<AIPrediction[]> {

 const trendSummary = trends.map((t) => ({
  n  : t.testName,
  fr : t.failureRate,
  rt : t.recentTrend,
  fl : t.isFlaky,
  rp : t.recoveryPattern,
  ls : t.lastStatus,
  fh : t.failureHistory.join(','),
  rr : t.retryRate,
  flr: t.flakinesReason,   // ← renamed from fr2 to flr (flakiness reason)
}));

  const prompt = `
You are a QA intelligence engine that predicts test failure risk in CI/CD pipelines.

=== TASK ===
Analyze the test trend data below and assign a risk score to each test.
Predict which tests are most likely to fail in the NEXT build.

=== INPUT DATA ===
${JSON.stringify(trendSummary, null, 2)}

=== FIELD DEFINITIONS ===
n   = testName (use this exact value in your response)
fr  = failureRate (0.0 to 1.0 — proportion of builds where test failed)
rt  = recentTrend (worsening | stable | improving — based on last 3 builds vs previous 3)
fl  = isFlaky (true if test alternates pass/fail unpredictably)
rp  = recoveryPattern (true if test was fixed then broke again — high instability signal)
ls  = lastStatus (passed | failed — result of most recent build)
fh  = failureHistory (comma-separated pass/failed per build, oldest to newest)
rr  = retryRate (0.0 to 1.0 — proportion of builds where test needed retries to pass)
flr = flakinessReason (explanation of why test is considered flaky, empty if not flaky)

=== SCORING RULES (apply in priority order) ===

CRITICAL signals (any one → score 80-100):
  - fr >= 0.7 AND rt = worsening → almost certain to fail next build
  - rp = true AND ls = failed    → broke again after fix, very high risk
  - fh ends with 3+ consecutive "failed" → active regression

HIGH signals (any one → score 60-79):
  - fr >= 0.5 OR (fr >= 0.4 AND rt = worsening)
  - fl = true AND fr >= 0.4      → consistently flaky with high failure rate
  - rr >= 0.5                    → needed retries in half or more of builds

MEDIUM signals (score 40-59):
  - fr >= 0.2 AND fr < 0.5       → occasional failures
  - fl = true AND fr < 0.4       → flaky but mostly passes
  - rr >= 0.2 AND rr < 0.5       → sometimes needs retries to pass
  - rt = worsening AND fr < 0.4  → trending bad but not yet frequent

LOW signals (score 0-39):
  - fr = 0 AND rr = 0 AND ls = passed → perfectly stable, no retries needed
  - fr < 0.1 AND rt = stable          → rarely fails, not getting worse
  - rt = improving AND fr < 0.3       → was failing but getting better

IMPORTANT OVERRIDES:
  - rr > 0 AND ls = passed → test is hiding instability via retries
    → add +15 to score even if fr looks low
  - rt = improving AND ls = passed → reduce score by 10 (recovering)
  - rt = worsening → always increase score by at least 15

=== OUTPUT FORMAT ===
Return ONLY a valid JSON array. No markdown. No explanation. No extra text.
First character must be [ and last character must be ]

For each test return exactly these fields:
[
  {
    "testName": "exact value from n field",
    "riskScore": 0-100,
    "riskLevel": "critical OR high OR medium OR low",
    "reason": "one sentence citing the specific signals that drove this score",
    "recommendation": "run-first OR run-early OR run-normal OR deprioritize"
  }
]

riskLevel must match riskScore:
  critical = 80-100
  high     = 60-79
  medium   = 40-59
  low      = 0-39

recommendation must match riskLevel:
  critical → run-first
  high     → run-early
  medium   → run-normal
  low      → deprioritize`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent`,
    {
      method : 'POST',
      headers: {
        'Content-Type'  : 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents        : [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature    : 0.1,
          maxOutputTokens: 8192,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorBody = await response.json();
    console.error(`Gemini error:`, JSON.stringify(errorBody, null, 2));
    throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
  }

  const data    = await response.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

  const cleaned = rawText
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  const jsonArray = extractJSONArray(cleaned);
  if (!jsonArray) {
    console.error(`Raw response:\n`, rawText);
    throw new Error('No JSON array found in Gemini response');
  }

  const repaired    = repairJSON(jsonArray);
  const predictions = JSON.parse(repaired) as AIPrediction[];

  console.log(
    `[${new Date().toISOString()}] ✅ Chunk returned ${predictions.length} predictions`
  );

  // Fill any missing tests with rule-based fallback
  const predictedNames = new Set(predictions.map((p) => p.testName));
  for (const trend of trends) {
    if (!predictedNames.has(trend.testName)) {
      predictions.push(ruleBasedScore(trend));
    }
  }

  return predictions;
}

// ── Main exported function ────────────────────────────────────────

export async function predictWithGemini(
  trends: TestTrend[]
): Promise<AIPrediction[]> {

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn(`[${new Date().toISOString()}] ⚠️  No API key — rule-based fallback`);
    return trends.map(ruleBasedScore);
  }

  console.log(
    `[${new Date().toISOString()}] 🤖 Calling Gemini AI for ${trends.length} tests...`
  );

  // Process in chunks of 16 to avoid token limits
  const CHUNK_SIZE = 16;
  const chunks     = chunkArray(trends, CHUNK_SIZE);

  console.log(
    `[${new Date().toISOString()}] 📦 Processing ${chunks.length} chunk(s) of max ${CHUNK_SIZE} tests`
  );

  const allPredictions: AIPrediction[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(
      `[${new Date().toISOString()}] 🔄 Chunk ${i + 1}/${chunks.length} — ${chunk.length} tests`
    );

    try {
      const chunkPredictions = await predictChunk(chunk, apiKey);
      allPredictions.push(...chunkPredictions);

      // Small delay between chunks to avoid rate limiting
      if (i < chunks.length - 1) {
        console.log(`[${new Date().toISOString()}] ⏳ Waiting 1s before next chunk...`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] ❌ Chunk ${i + 1} failed: ${error} — using rule-based`
      );
      allPredictions.push(...chunk.map(ruleBasedScore));
    }
  }

  console.log(
    `[${new Date().toISOString()}] ✅ Gemini complete — ${allPredictions.length} total predictions`
  );

  return allPredictions;
}

// ── Run directly if called as script ─────────────────────────────
if (require.main === module) {
  (async () => {
    const { analyzeTrends } = await import('../analyzer/trendAnalyzer');
    const trends            = analyzeTrends();
    const predictions       = await predictWithGemini(trends);

    console.log('\n🤖 AI PREDICTIONS:');
    console.log('─'.repeat(80));
    for (const p of predictions) {
      const icon =
        p.riskLevel === 'critical' ? '🔴' :
        p.riskLevel === 'high'     ? '🟠' :
        p.riskLevel === 'medium'   ? '🟡' : '🟢';
      console.log(`${icon} [${p.riskScore}] ${p.testName}`);
      console.log(`   → ${p.reason}`);
      console.log(`   → Recommendation: ${p.recommendation}\n`);
    }
  })();
}