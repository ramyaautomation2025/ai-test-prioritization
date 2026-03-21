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
    n : t.testName,
    fr: t.failureRate,
    rt: t.recentTrend,
    fl: t.isFlaky,
    rp: t.recoveryPattern,
    ls: t.lastStatus,
    fh: t.failureHistory.join(','),
  }));

  const prompt = `
You are a QA intelligence engine. Analyze these test failure trends and predict risk.

Data fields: n=testName, fr=failureRate(0-1), rt=recentTrend, fl=isFlaky, rp=recoveryPattern, ls=lastStatus, fh=failureHistory(passed/failed per build)

Trend Data:
${JSON.stringify(trendSummary)}

Scoring rules:
- fr>0.6 = high risk | fr>0.4 = medium | fr>0.2 = low-medium
- rt=worsening = higher risk | rt=improving = lower risk
- fl=true = flaky = medium-high risk
- rp=true = recovered then broke again = high risk
- ls=failed = higher risk
- Stable passing tests = low risk

For each test return:
- testName: use exact value from n field
- riskScore: 0-100
- riskLevel: critical|high|medium|low
- reason: one sentence
- recommendation: run-first|run-early|run-normal|deprioritize

Return ONLY a JSON array starting with [ and ending with ].
No markdown. No explanation. No extra text.`;

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