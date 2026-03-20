import * as fs from 'fs';
import * as path from 'path';
import { FinalRiskScore } from '../analyzer/riskScorer';
import { ExecutionPlan } from '../prioritizer/reorderSuite';

/**
 * Returns a color hex code based on risk level
 */
function getRiskColor(riskLevel: string): string {
  switch (riskLevel) {
    case 'critical': return '#e53e3e';
    case 'high':     return '#dd6b20';
    case 'medium':   return '#d69e2e';
    case 'low':      return '#38a169';
    default:         return '#718096';
  }
}

/**
 * Returns a background color for risk badge
 */
function getRiskBadgeBg(riskLevel: string): string {
  switch (riskLevel) {
    case 'critical': return '#fff5f5';
    case 'high':     return '#fffaf0';
    case 'medium':   return '#fffff0';
    case 'low':      return '#f0fff4';
    default:         return '#f7fafc';
  }
}

/**
 * Converts failure history array into visual icons
 */
function renderHistory(history: string[]): string {
  return history
    .map((s) =>
      s === 'passed'
        ? `<span style="color:#38a169;font-size:16px" title="Passed">✅</span>`
        : `<span style="color:#e53e3e;font-size:16px" title="Failed">❌</span>`
    )
    .join(' ');
}

/**
 * Renders a risk score bar
 */
function renderScoreBar(score: number, riskLevel: string): string {
  const color = getRiskColor(riskLevel);
  return `
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="
        width:120px;height:10px;background:#e2e8f0;
        border-radius:999px;overflow:hidden;">
        <div style="
          width:${score}%;height:100%;
          background:${color};border-radius:999px;
          transition:width 0.3s ease;">
        </div>
      </div>
      <span style="font-weight:700;color:${color}">${score}</span>
    </div>`;
}

/**
 * Renders a single test row in the dashboard table
 */
function renderTestRow(score: FinalRiskScore, priority: number): string {
  const color = getRiskColor(score.riskLevel);
  const badgeBg = getRiskBadgeBg(score.riskLevel);
  const trendIcon =
    score.recentTrend === 'worsening' ? '📈 Worsening' :
    score.recentTrend === 'improving' ? '📉 Improving' : '➡️ Stable';

  const recIcon =
    score.recommendation === 'run-first'    ? '🚨 Run First' :
    score.recommendation === 'run-early'    ? '⚡ Run Early' :
    score.recommendation === 'run-normal'   ? '🔵 Normal'    : '⬇️ Deprioritize';

  const group =
    score.riskLevel === 'critical' || score.riskLevel === 'high'
      ? '<span style="background:#fed7d7;color:#c53030;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">GROUP A</span>'
      : score.riskLevel === 'medium'
      ? '<span style="background:#fefcbf;color:#744210;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">GROUP B</span>'
      : '<span style="background:#c6f6d5;color:#22543d;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700">GROUP C</span>';

  // Short test name for display
  const shortName = score.testName.includes('>')
    ? score.testName.split('>')[1].trim()
    : score.testName;
  const module = score.module.toUpperCase();

  return `
    <tr style="border-bottom:1px solid #e2e8f0;transition:background 0.2s"
        onmouseover="this.style.background='#f7fafc'"
        onmouseout="this.style.background='white'">
      <td style="padding:14px 12px;text-align:center;font-weight:700;color:#4a5568">${priority}</td>
      <td style="padding:14px 12px">
        <div style="font-weight:600;color:#2d3748;font-size:13px">${shortName}</div>
        <div style="color:#718096;font-size:11px;margin-top:2px">${score.testName.split('>')[0].trim()}</div>
      </td>
      <td style="padding:14px 12px">
        <span style="
          background:#edf2f7;color:#4a5568;
          padding:3px 10px;border-radius:20px;
          font-size:11px;font-weight:600">
          ${module}
        </span>
      </td>
      <td style="padding:14px 12px">${renderScoreBar(score.riskScore, score.riskLevel)}</td>
      <td style="padding:14px 12px">
        <span style="
          background:${badgeBg};color:${color};
          border:1px solid ${color};
          padding:3px 10px;border-radius:20px;
          font-size:12px;font-weight:700;
          text-transform:uppercase">
          ${score.riskLevel}
        </span>
      </td>
      <td style="padding:14px 12px;font-size:13px">${renderHistory(score.failureHistory)}</td>
      <td style="padding:14px 12px;font-size:12px;color:#4a5568">${trendIcon}</td>
      <td style="padding:14px 12px;font-size:12px">${recIcon}</td>
      <td style="padding:14px 12px">${group}</td>
    </tr>`;
}

/**
 * Generates the full HTML risk dashboard
 */
export function generateDashboard(
  scores: FinalRiskScore[],
  plan: ExecutionPlan,
  buildNumber: string = '011'
): void {

  console.log(`[${new Date().toISOString()}] 🎨 Generating HTML risk dashboard...`);

  const critical = scores.filter((s) => s.riskLevel === 'critical').length;
  const high     = scores.filter((s) => s.riskLevel === 'high').length;
  const medium   = scores.filter((s) => s.riskLevel === 'medium').length;
  const low      = scores.filter((s) => s.riskLevel === 'low').length;
  const totalFailures = scores.reduce((sum, s) => sum + Math.round(s.failureRate * s.failureHistory.length), 0);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>AI Test Risk Dashboard — Build #${buildNumber}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f0f4f8;
      color: #2d3748;
    }
    .header {
      background: linear-gradient(135deg, #1a202c 0%, #2d3748 50%, #4a5568 100%);
      color: white;
      padding: 32px 40px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header-left h1 { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
    .header-left p  { font-size: 13px; color: #a0aec0; margin-top: 4px; }
    .ai-badge {
      background: linear-gradient(135deg, #667eea, #764ba2);
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 16px;
      padding: 24px 40px;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      text-align: center;
      border-top: 4px solid transparent;
    }
    .card-total    { border-top-color: #667eea; }
    .card-critical { border-top-color: #e53e3e; }
    .card-high     { border-top-color: #dd6b20; }
    .card-medium   { border-top-color: #d69e2e; }
    .card-low      { border-top-color: #38a169; }
    .card-failures { border-top-color: #805ad5; }
    .card-number { font-size: 36px; font-weight: 800; margin-bottom: 4px; }
    .card-label  { font-size: 12px; color: #718096; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .section { padding: 0 40px 32px; }
    .section-title {
      font-size: 16px; font-weight: 700;
      color: #2d3748; margin-bottom: 16px;
      display: flex; align-items: center; gap: 8px;
    }
    .table-wrapper {
      background: white;
      border-radius: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    thead tr { background: #2d3748; color: white; }
    thead th {
      padding: 14px 12px;
      text-align: left;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .group-banner {
      background: #2d3748;
      color: white;
      padding: 10px 16px;
      font-size: 13px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .footer {
      background: #2d3748;
      color: #a0aec0;
      padding: 20px 40px;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
    }
  </style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="header-left">
    <h1>🤖 AI Test Risk Dashboard</h1>
    <p>Build #${buildNumber} &nbsp;•&nbsp; Generated: ${new Date().toLocaleString()} &nbsp;•&nbsp; Powered by Gemini AI</p>
  </div>
  <div class="ai-badge">✨ AI-Driven Prioritization</div>
</div>

<!-- SUMMARY CARDS -->
<div class="summary-grid">
  <div class="card card-total">
    <div class="card-number" style="color:#667eea">${scores.length}</div>
    <div class="card-label">Total Tests</div>
  </div>
  <div class="card card-critical">
    <div class="card-number" style="color:#e53e3e">${critical}</div>
    <div class="card-label">🔴 Critical</div>
  </div>
  <div class="card card-high">
    <div class="card-number" style="color:#dd6b20">${high}</div>
    <div class="card-label">🟠 High Risk</div>
  </div>
  <div class="card card-medium">
    <div class="card-number" style="color:#d69e2e">${medium}</div>
    <div class="card-label">🟡 Medium</div>
  </div>
  <div class="card card-low">
    <div class="card-number" style="color:#38a169">${low}</div>
    <div class="card-label">🟢 Low Risk</div>
  </div>
  <div class="card card-failures">
    <div class="card-number" style="color:#805ad5">${totalFailures}</div>
    <div class="card-label">Total Failures</div>
  </div>
</div>

<!-- MAIN TABLE -->
<div class="section">
  <div class="section-title">📊 Full Risk Analysis — All Tests</div>
  <div class="table-wrapper">

    <!-- GROUP A BANNER -->
    <div class="group-banner" style="background:#c53030">
      🚨 GROUP A — Critical &amp; High Risk | Run First | Blocks Deployment
      (${plan.groupA.length} tests)
    </div>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Test Name</th>
          <th>Module</th>
          <th>Risk Score</th>
          <th>Risk Level</th>
          <th>Last 10 Runs</th>
          <th>Trend</th>
          <th>AI Recommendation</th>
          <th>Group</th>
        </tr>
      </thead>
      <tbody>
        ${scores
          .filter((s) => s.riskLevel === 'critical' || s.riskLevel === 'high')
          .map((s, i) => renderTestRow(s, i + 1))
          .join('')}
      </tbody>
    </table>

    <!-- GROUP B BANNER -->
    <div class="group-banner" style="background:#b7791f;margin-top:2px">
      ⚡ GROUP B — Medium Risk | Run After Group A
      (${plan.groupB.length} tests)
    </div>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Test Name</th>
          <th>Module</th>
          <th>Risk Score</th>
          <th>Risk Level</th>
          <th>Last 10 Runs</th>
          <th>Trend</th>
          <th>AI Recommendation</th>
          <th>Group</th>
        </tr>
      </thead>
      <tbody>
        ${scores
          .filter((s) => s.riskLevel === 'medium')
          .map((s, i) => renderTestRow(s, plan.groupA.length + i + 1))
          .join('')}
      </tbody>
    </table>

    <!-- GROUP C BANNER -->
    <div class="group-banner" style="background:#276749;margin-top:2px">
      🟢 GROUP C — Low Risk | Run Last | Non-Blocking
      (${plan.groupC.length} tests)
    </div>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Test Name</th>
          <th>Module</th>
          <th>Risk Score</th>
          <th>Risk Level</th>
          <th>Last 10 Runs</th>
          <th>Trend</th>
          <th>AI Recommendation</th>
          <th>Group</th>
        </tr>
      </thead>
      <tbody>
        ${scores
          .filter((s) => s.riskLevel === 'low')
          .map((s, i) =>
            renderTestRow(s, plan.groupA.length + plan.groupB.length + i + 1)
          )
          .join('')}
      </tbody>
    </table>

  </div>
</div>

<!-- FOOTER -->
<div class="footer">
  <span>🤖 AI Model: Gemini 1.5 Flash &nbsp;|&nbsp; Scoring: 70% AI + 30% Rule-Based</span>
  <span>Generated: ${new Date().toISOString()}</span>
  <span>Build #${buildNumber} &nbsp;|&nbsp; ${scores.length} tests analyzed</span>
</div>

</body>
</html>`;

  // Ensure reports directory exists
  const reportsDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);

  const outputPath = path.join(reportsDir, 'priority-dashboard.html');
  fs.writeFileSync(outputPath, html);

  console.log(`[${new Date().toISOString()}] ✅ Dashboard saved to reports/priority-dashboard.html`);
  console.log(`[${new Date().toISOString()}] 🌐 Open in browser: file://${outputPath}`);
}

// Run directly if called as script
if (require.main === module) {
  (async () => {
    const { analyzeTrends }    = await import('../analyzer/trendAnalyzer');
    const { predictWithGemini } = await import('../ai/geminiPredictor');
    const { computeFinalScores } = await import('../analyzer/riskScorer');
    const { buildExecutionPlan } = await import('../prioritizer/reorderSuite');

    const trends      = analyzeTrends();
    const predictions = await predictWithGemini(trends);
    const scores      = computeFinalScores(trends, predictions);
    const plan        = buildExecutionPlan(scores);
    generateDashboard(scores, plan, process.env.BUILD_NUMBER || '011');
  })();
}