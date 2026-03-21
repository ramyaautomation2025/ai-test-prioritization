-- ============================================================
-- AI Test Prioritization — Database Schema
-- ============================================================

-- Table 1: Stores every build run
CREATE TABLE IF NOT EXISTS build_runs (
  id            SERIAL PRIMARY KEY,
  build_id      VARCHAR(50)  NOT NULL UNIQUE,
  build_number  INTEGER      NOT NULL,
  branch        VARCHAR(100) DEFAULT 'main',
  triggered_at  TIMESTAMP    DEFAULT NOW(),
  total_tests   INTEGER      DEFAULT 0,
  total_passed  INTEGER      DEFAULT 0,
  total_failed  INTEGER      DEFAULT 0,
  duration_ms   INTEGER      DEFAULT 0
);

-- Table 2: Stores individual test results per build
CREATE TABLE IF NOT EXISTS test_results (
  id            SERIAL PRIMARY KEY,
  build_id      VARCHAR(50)  NOT NULL REFERENCES build_runs(build_id),
  test_name     VARCHAR(255) NOT NULL,
  module        VARCHAR(100) NOT NULL,
  status        VARCHAR(20)  NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
  duration_ms   INTEGER      DEFAULT 0,
  error_message TEXT         DEFAULT '',
  recorded_at   TIMESTAMP    DEFAULT NOW()
);

-- Table 3: Stores AI risk predictions per build
CREATE TABLE IF NOT EXISTS risk_predictions (
  id              SERIAL PRIMARY KEY,
  build_id        VARCHAR(50)  NOT NULL REFERENCES build_runs(build_id),
  test_name       VARCHAR(255) NOT NULL,
  module          VARCHAR(100) NOT NULL,
  risk_score      INTEGER      NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  risk_level      VARCHAR(20)  NOT NULL CHECK (risk_level IN ('critical', 'high', 'medium', 'low')),
  ai_score        INTEGER      DEFAULT 0,
  rule_score      INTEGER      DEFAULT 0,
  reason          TEXT         DEFAULT '',
  recommendation  VARCHAR(50)  NOT NULL,
  failure_rate    DECIMAL(5,2) DEFAULT 0,
  recent_trend    VARCHAR(20)  DEFAULT 'stable',
  predicted_at    TIMESTAMP    DEFAULT NOW()
);

-- Indexes for fast querying
CREATE INDEX IF NOT EXISTS idx_test_results_build_id  ON test_results(build_id);
CREATE INDEX IF NOT EXISTS idx_test_results_test_name ON test_results(test_name);
CREATE INDEX IF NOT EXISTS idx_test_results_status    ON test_results(status);
CREATE INDEX IF NOT EXISTS idx_risk_predictions_build ON risk_predictions(build_id);
CREATE INDEX IF NOT EXISTS idx_build_runs_number      ON build_runs(build_number);