-- 0061_cad_test_runs.sql — the CAD change-order test agent's run log
-- ============================================================================
-- docs/TEST_AGENT.md. One row per run of the robot button: "change a part in
-- Fusion → save → stamp → send → the portal registers the file on the right
-- letter → the supplier still sees what they saw before". The path crosses
-- three systems and every defect found so far lived in a seam none of them
-- could see on its own, so the run writes down what each side saw (before /
-- after registry snapshots, what registerCadRevision answered, one row per
-- step) and a regression shows up as a red step in the portal.
--
-- The table is a log, not a controlled object: nothing in the registry points
-- at it, and a row may be deleted with its part. It is org-scoped like every
-- other tenant table (organization_id NOT NULL, TENANT_TABLES, RLS deny-all).
--
-- Statuses:   requested → running → passed | failed
--             requested → cancelled            (by hand, before the add-in claims it)
--             requested → timed_out            (no add-in claimed it within 120 s)
--             running   → failed               (no report for 10 min: "add-in stopped reporting")
--
-- Re-runnable: IF NOT EXISTS everywhere.

CREATE TABLE IF NOT EXISTS cad_test_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  -- The part under test. A deleted part takes its test log with it: the log
  -- has no meaning without the part, unlike bom_component_history.
  component_id     UUID NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  -- Resolved at request time; kept for the UI, not for logic.
  cad_model_id     UUID REFERENCES cad_models(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'requested'
                   CHECK (status IN ('requested', 'running', 'passed', 'failed', 'timed_out', 'cancelled')),
  requested_by     UUID REFERENCES users(id),
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at       TIMESTAMPTZ,
  -- "Mathias · Fusion 2.0.x · MacBook" — whatever the add-in says about itself.
  claimed_by       TEXT,
  finished_at      TIMESTAMPTZ,
  -- Registry snapshots (shape in docs/TEST_AGENT.md): what the portal knew
  -- about the part at request time and at finish.
  before           JSONB,
  after            JSONB,
  -- What the portal predicted before the run: { mode, letter, fusion_version }.
  expected         JSONB,
  -- What registerCadRevision answered the add-in, as the add-in reported it.
  send             JSONB,
  -- [{ key, label, status, detail, at }] in the contract's fixed order.
  steps            JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The one-line reason when status is failed / timed_out.
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE cad_test_runs ENABLE ROW LEVEL SECURITY;

-- The poll: "oldest requested run in this org" — and the one-at-a-time check.
CREATE INDEX IF NOT EXISTS idx_cad_test_runs_poll
  ON cad_test_runs (organization_id, status, requested_at);
-- The panel's "last runs" list and a part's own history of runs.
CREATE INDEX IF NOT EXISTS idx_cad_test_runs_component
  ON cad_test_runs (organization_id, component_id, requested_at DESC);
-- One run at a time per organization, held by the database and not only by
-- the read-then-insert in requestCadTestRun: two clicks in the same second
-- would otherwise both queue, and the second run's before snapshot would
-- predate the first run's send.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cad_test_runs_one_open
  ON cad_test_runs (organization_id) WHERE status IN ('requested', 'running');
