# 🤖 AI-Driven Defect Prediction & Smart Test Prioritization

![Playwright](https://img.shields.io/badge/Playwright-TypeScript-blue?logo=playwright)
![AI](https://img.shields.io/badge/AI-Gemini%202.5%20Flash%20Lite-orange?logo=google)
![Database](https://img.shields.io/badge/Database-PostgreSQL%20%28Neon%29-336791?logo=postgresql)
![CI](https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?logo=githubactions)
![License](https://img.shields.io/badge/License-MIT-purple)

> Analyzes CI/CD test failure history using **Gemini AI** to predict which tests are most likely to fail next — then automatically reprioritizes the entire test suite so **high-risk tests run first** on every build.

---

## 🎯 Problem Statement

Most CI pipelines run all tests blindly in the same order every build:

- Critical bugs get discovered **late** — after low-risk tests run first
- Teams wait **40+ minutes** for full suite results
- Flaky and high-risk tests receive no special attention
- No intelligence — same execution order on every single build

## 💡 Solution

This framework uses **AI + historical failure data** to:

1. Analyze which tests have been failing most frequently across recent builds
2. Detect worsening trends, flaky behaviour, and recovery patterns
3. Assign an AI-driven **risk score (0–100)** to every test
4. Run **high-risk tests first** — surface critical bugs within minutes
5. Store results in **PostgreSQL** so the AI gets smarter every build
6. Fall back to `history.json` automatically if the database is unavailable

---

## 🏗️ Architecture

```
test-history/history.json  (or PostgreSQL DB)
           ↓
   trendAnalyzer.ts         → failureRate, recentTrend, isFlaky, recoveryPattern
           ↓
   geminiPredictor.ts       → Gemini AI assigns riskScore 0–100 per test
           ↓
   riskScorer.ts            → Final score = AI (70%) + Rule-based (30%)
           ↓
   reorderSuite.ts          → Groups tests: A (critical) / B (medium) / C (low)
           ↓
   dashboardGenerator.ts    → Generates HTML risk dashboard
           ↓
   smartRunner.ts           → Runs groups in order, saves results to DB
           ↓
   updateHistory.ts         → Keeps history.json in sync as fallback
```

---

## 🚦 Test Execution Groups

| Group | Risk Score | Risk Level | Pipeline Behaviour |
|-------|-----------|------------|--------------------|
| 🔴 **Group A** | 80 – 100 | Critical / High | Runs **first** — blocks deployment on failure |
| 🟡 **Group B** | 60 – 79  | Medium | Runs after Group A |
| 🟢 **Group C** | 0 – 59   | Low | Runs last — non-blocking |

---

## 📁 Project Structure

```
ai-test-prioritization/
├── .github/
│   └── workflows/
│       └── smart-pipeline.yml        ← GitHub Actions CI pipeline
├── src/
│   ├── analyzer/
│   │   ├── trendAnalyzer.ts          ← Reads history, computes failure trends
│   │   ├── riskScorer.ts             ← Blends AI + rule-based scores
│   │   └── updateHistory.ts          ← Keeps history.json in sync with DB
│   ├── ai/
│   │   └── geminiPredictor.ts        ← Calls Gemini AI for risk prediction
│   ├── prioritizer/
│   │   └── reorderSuite.ts           ← Groups tests into A / B / C
│   ├── reporter/
│   │   └── dashboardGenerator.ts     ← Generates HTML risk dashboard
│   ├── runner/
│   │   └── smartRunner.ts            ← Master orchestrator — runs everything
│   └── database/
│       ├── dbClient.ts               ← PostgreSQL connection pool
│       ├── historyWriter.ts          ← Saves build results + AI predictions
│       ├── historyReader.ts          ← Reads last N builds for trend analysis
│       └── schema.sql                ← DB table definitions
├── tests/
│   ├── cart.spec.ts
│   ├── checkout.spec.ts
│   ├── homepage.spec.ts
│   ├── login.spec.ts
│   ├── payment.spec.ts
│   ├── profile.spec.ts
│   └── search.spec.ts
├── test-history/
│   └── history.json                  ← Rolling window of last 10 builds (fallback)
├── reports/
│   └── priority-dashboard.html       ← Generated HTML risk dashboard
├── playwright.config.ts
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 🚀 Setup

### Prerequisites

- Node.js 20+
- npm
- A free [Neon PostgreSQL](https://neon.tech) account
- A free [Google AI Studio](https://aistudio.google.com) Gemini API key

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/ai-test-prioritization
cd ai-test-prioritization
npm install
npx playwright install chromium
```

### 2. Get Your Free Gemini API Key

1. Go to **aistudio.google.com**
2. Sign in with your Google account — no credit card needed
3. Click **Get API Key** → **Create API key**
4. Copy the key

### 3. Get Your Free PostgreSQL Database

1. Go to **neon.tech**
2. Sign up with GitHub — no credit card needed
3. Click **Create Project** → name it `ai-test-prioritization`
4. Copy the **connection string**

### 4. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
GEMINI_API_KEY=your_gemini_api_key_here
DATABASE_URL=postgresql://username:password@ep-xxx.neon.tech/neondb?sslmode=require
BUILD_NUMBER=001
BASE_URL=https://www.saucedemo.com
```

### 5. Run the Full Smart Pipeline

```bash
npm run smart-run
```

---

## 🧪 Available Commands

| Command | Description |
|---------|-------------|
| `npm run smart-run` | **Full AI pipeline** — analyze → predict → prioritize → run → save |
| `npm test` | Run full Playwright suite (all tests, no AI prioritization) |
| `npm run test:smoke` | Run `@smoke` tagged tests only |
| `npm run test:critical` | Run `@critical` tagged tests only |
| `npm run analyze` | Trend analysis only — see failure rates in terminal |
| `npm run predict` | Gemini AI prediction only — see risk scores |
| `npm run prioritize` | Build execution plan only |
| `npm run dashboard` | Generate HTML risk dashboard only |

---

## 🤖 How AI Scoring Works

### Step 1 — Rule-Based Analysis

The `trendAnalyzer` reads the last 10 builds and computes for every test:

| Metric | Description | Score Impact |
|--------|-------------|--------------|
| `failureRate` | Percentage of builds where test failed | High rate = +40 pts |
| `recentTrend` | Getting worse / stable / improving | Worsening = +25 pts |
| `isFlaky` | Alternates pass/fail | Flaky = +15 pts |
| `recoveryPattern` | Fixed then broke again | Pattern = +20 pts |
| `lastStatus` | Did it fail last build? | Failed = +10 pts |

### Step 2 — Gemini AI Prediction

The aggregated trend data is sent to **Gemini 2.5 Flash Lite** (free tier) with a prompt asking it to assign a risk score and reason for each test. Gemini understands context — for example recognising that a test failing 3 builds in a row after being fixed is more concerning than one with a steady low failure rate.

Tests are sent in **chunks of 16** to stay within the free tier token limits. A 1-second delay between chunks avoids rate limiting.

### Step 3 — Blended Final Score

```
Final Score = (Gemini AI Score × 70%) + (Rule-based Score × 30%)
```

The 70/30 weighting gives AI the primary say while rule-based scoring provides a reliable safety net if the API is unavailable.

### Graceful Fallback Chain

```
Gemini API available?
  ├── YES → AI 70% + Rules 30% blended score
  └── NO  → 100% rule-based score (pipeline never breaks)

Database has ≥ 3 builds?
  ├── YES → AI reads real execution history from PostgreSQL
  └── NO  → Falls back to history.json (mock + real data)
```

---

## 📊 Risk Dashboard

After every `smart-run`, open the generated dashboard:

```bash
# Windows
start reports\priority-dashboard.html

# Mac / Linux
open reports/priority-dashboard.html
```

The dashboard shows:

- **Summary cards** — total tests, critical count, high/medium/low breakdown
- **Full risk table** — every test with score bar, last 10 run history (✅❌), trend, AI recommendation
- **Colour-coded groups** — Group A / B / C clearly separated
- **AI reasoning** — one-sentence explanation from Gemini for each score

---

## 🗄️ Database Schema

Three tables store the complete execution and prediction history:

```
build_runs          → One row per CI build (build_id, timestamp, pass/fail counts)
test_results        → One row per test per build (test_name, status, duration, error)
risk_predictions    → AI scores per test per build (risk_score, risk_level, reason)
```

### Retention Policy

- **Hot window**: Last 10 builds — used by AI for risk scoring
- **Cold window**: Last 90 builds — kept for reports and long-term trend analysis
- Anything older than 90 builds is automatically deleted to keep the free tier storage healthy

### history.json Fallback

`history.json` is always kept in sync with the DB after every run. If the database becomes unavailable, the AI automatically falls back to this file so prioritization still works with real data rather than mock data.

---

## 🔁 CI/CD Pipeline — GitHub Actions

The pipeline triggers on every push to `main` and runs in 11 sequential steps:

```
Step 1  → Connect to PostgreSQL
Step 2  → Load test history (DB with ≥ 3 builds, or history.json fallback)
Step 3  → Gemini AI risk prediction
Step 4  → Compute blended risk scores (AI 70% + Rules 30%)
Step 5  → Build execution plan (Group A / B / C)
Step 6  → Generate HTML risk dashboard
Step 7  → Run Group A — critical/high risk tests FIRST 🚨
Step 8  → Run Group B — medium risk tests
Step 9  → Run Group C — low risk tests
Step 10 → Merge results from memory and save to PostgreSQL
Step 11 → Apply retention policy and show DB stats
```

### GitHub Secrets Required

| Secret | Description |
|--------|-------------|
| `GEMINI_API_KEY` | Google AI Studio API key (free from aistudio.google.com) |
| `DATABASE_URL` | Neon PostgreSQL connection string (free from neon.tech) |

### Artifacts Uploaded After Every Run

| Artifact | Contents | Retention |
|----------|----------|-----------|
| `ai-risk-dashboard-build-N` | HTML risk dashboard | 30 days |
| `playwright-report-build-N` | Full Playwright HTML report | 30 days |
| `failure-screenshots-build-N` | Screenshots of failed tests | 15 days |
| `execution-plan-build-N` | JSON test execution order | 30 days |

---

## 🌐 Test Application

All tests run against **[saucedemo.com](https://www.saucedemo.com)** — a free demo e-commerce site built specifically for QA automation practice.

| Username | Password | Behaviour |
|----------|----------|-----------|
| `standard_user` | `secret_sauce` | Normal login — used in all happy path tests |
| `locked_out_user` | `secret_sauce` | Returns locked-out error message |

### Test Coverage — 19 Tests Across 7 Modules

| Module | Test Scenarios | Tags |
|--------|----------------|------|
| Login | Valid login, invalid login, locked out user | `@smoke @critical @regression` |
| Cart | Add single item, add multiple items, remove item | `@smoke @critical @regression` |
| Checkout | Verify order summary, complete flow, cancel checkout | `@critical @smoke @regression` |
| Payment | Item count, item total, total calculation | `@critical @smoke` |
| Profile | View menu items, logout, navigate to all items | `@smoke @regression` |
| Search | Sort by price low-to-high, sort by price high-to-low | `@regression` |
| Homepage | All product names visible, product listing shows prices | `@smoke @regression` |

---

## 🛠️ Tech Stack

| Layer | Technology | Cost |
|-------|-----------|------|
| Test Automation | Playwright + TypeScript | Free |
| AI Prediction | Google Gemini 2.5 Flash Lite | Free tier |
| Database | PostgreSQL via Neon.tech | Free tier (3GB) |
| CI/CD | GitHub Actions | Free for public repos |
| Runtime | Node.js 20 | Free |

**Total running cost: $0** — the entire stack runs on free tiers.

---

## 💡 Key Design Decisions

**Why `history.json` AND a database?**
The database is the primary source of truth for real execution history. `history.json` is kept in sync after every run as a reliable fallback — if the DB goes down, the AI still has meaningful real data rather than reverting to mock data.

**Why 70% AI + 30% rules?**
Pure AI scoring occasionally misses straightforward patterns that rules catch reliably. Pure rule-based scoring misses contextual patterns that AI understands. The blend gives the best of both — AI provides the primary intelligence while rules provide the safety net.

**Why read results into memory immediately after each group?**
Playwright cleans the output directory before each new run. If Group C runs after Groups A and B, it deletes their JSON output files. Reading results into memory immediately after each group completes — before the next group starts — prevents this data loss without needing to re-run any tests.

**Why per-group temp config files?**
Playwright's JSON reporter on Windows cannot write to paths containing spaces when the path is passed via environment variables. Writing a temporary `.js` config file to the project root with the output path hardcoded as a JavaScript string literal bypasses this limitation reliably on both Windows and Linux.

**Why chunk Gemini API calls?**
With 19+ tests, the combined response can exceed the free tier's token limit, causing truncated JSON responses. Sending 16 tests per API call keeps each request well within limits while a 1-second delay between chunks avoids rate limiting.

---

## 🗺️ Production Roadmap

For teams wanting to take this beyond a demo project:

1. **Replace seed data** — swap `history.json` mock data with real CI failure history from your test suite
2. **Connect to your real application** — update `BASE_URL` in `.env` to point at your system under test
3. **Scale the database** — Neon free tier handles up to 3GB; upgrade when your build volume grows
4. **Add notifications** — post the risk dashboard summary to Slack or Teams after each run
5. **Integrate with Jira** — auto-create tickets for tests that enter the critical risk level
6. **Extend the AI prompt** — include code ownership data to help Gemini weight risk by recent commit activity
7. **Add parallel execution** — run Group A tests across multiple workers for even faster critical feedback

---

## 👤 Author

Built by a QA Engineer with 12+ years of experience in test automation and quality engineering — demonstrating how AI can make CI/CD pipelines not just faster, but genuinely smarter.

---

## 📄 License

MIT — free to use, modify, and share.