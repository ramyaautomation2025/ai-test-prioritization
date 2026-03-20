# 🤖 AI-Driven Defect Prediction & Smart Test Prioritization

> Analyzes CI/CD test failure trends using Gemini AI to predict which tests
> are most likely to fail — then automatically reprioritizes the entire
> test suite before every build.

![Tech Stack](https://img.shields.io/badge/Playwright-TypeScript-blue)
![AI](https://img.shields.io/badge/AI-Gemini%201.5%20Flash-orange)
![CI](https://img.shields.io/badge/CI-GitHub%20Actions-green)
![License](https://img.shields.io/badge/License-MIT-purple)

---

## 🎯 Problem Statement

Most CI pipelines run ALL tests blindly in the same order every build.
This means:
- Critical bugs get found late (after low-risk tests run first)
- Teams wait 40+ minutes for full suite results
- Flaky and high-risk tests get no special attention

## 💡 Solution

This framework uses **AI + historical failure data** to:
1. Detect which tests have been failing frequently
2. Identify worsening trends, flaky tests, recovery patterns
3. Assign a risk score (0–100) to every test
4. Run **high-risk tests first** — catch critical bugs in minutes

---

## 🏗️ Architecture
```
history.json (10 builds)
       ↓
trendAnalyzer.ts     → failureRate, trend, flakiness
       ↓
geminiPredictor.ts   → AI risk score per test (Gemini API)
       ↓
riskScorer.ts        → Final score (70% AI + 30% rules)
       ↓
reorderSuite.ts      → Group A / B / C execution plan
       ↓
dashboardGenerator   → HTML risk dashboard
       ↓
GitHub Actions       → Smart pipeline runs groups in order
```

---

## 🚀 Setup

### 1. Clone & Install
```bash
git clone https://github.com/yourusername/ai-test-prioritization
cd ai-test-prioritization
npm install
npx playwright install chromium
```

### 2. Get Free Gemini API Key
- Go to **aistudio.google.com**
- Sign in with Google → Get API Key → Copy

### 3. Add to .env
```
GEMINI_API_KEY=your_key_here
BUILD_NUMBER=001
```

### 4. Run Smart Pipeline
```bash
npm run smart-run
```

---

## 📊 Risk Dashboard

Open `reports/priority-dashboard.html` in your browser after running.

| Color | Risk Level | Score | Action |
|-------|-----------|-------|--------|
| 🔴 | Critical | 80–100 | Run first, blocks deploy |
| 🟠 | High | 60–79 | Run early |
| 🟡 | Medium | 40–59 | Run normal order |
| 🟢 | Low | 0–39 | Run last, non-blocking |

---

## 🧪 Available Commands

| Command | Description |
|---------|-------------|
| `npm run smart-run` | Full AI pipeline — analyze, predict, prioritize, run |
| `npm run analyze` | Trend analysis only |
| `npm run predict` | Gemini AI prediction only |
| `npm run dashboard` | Generate HTML dashboard only |
| `npm test` | Run full Playwright suite |
| `npm run test:smoke` | Run smoke tests only |
| `npm run test:critical` | Run critical tests only |

---

## 🛠️ Tech Stack
- **Playwright** — Test automation
- **TypeScript** — Type-safe code
- **Gemini 1.5 Flash** — Free AI prediction engine
- **GitHub Actions** — CI/CD pipeline
- **Node.js** — Runtime

---

## 👤 Author
Built by a QA Engineer with 12+ years experience
to demonstrate AI-augmented test automation.
```

---

## 🎉 Project Complete! Final Structure
```
ai-test-prioritization/
├── .github/workflows/
│   └── smart-pipeline.yml        ✅
├── src/
│   ├── analyzer/
│   │   ├── trendAnalyzer.ts      ✅
│   │   └── riskScorer.ts         ✅
│   ├── ai/
│   │   └── geminiPredictor.ts    ✅
│   ├── prioritizer/
│   │   └── reorderSuite.ts       ✅
│   ├── reporter/
│   │   └── dashboardGenerator.ts ✅
│   └── runner/
│       └── smartRunner.ts        ✅
├── tests/
│   ├── login.spec.ts             ✅
│   ├── homepage.spec.ts          ✅
│   ├── search.spec.ts            ✅
│   ├── cart.spec.ts              ✅
│   ├── checkout.spec.ts          ✅
│   ├── payment.spec.ts           ✅
│   └── profile.spec.ts           ✅
├── test-history/
│   └── history.json              ✅
├── playwright.config.ts          ✅
├── package.json                  ✅
├── tsconfig.json                 ✅
├── .env                          ✅
├── .gitignore                    ✅
└── README.md                     ✅