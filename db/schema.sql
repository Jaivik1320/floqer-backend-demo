-- ============================================================================
--  FLOQER-STYLE GTM WORKFLOW ENGINE — DATABASE SCHEMA (PostgreSQL)
-- ----------------------------------------------------------------------------
--  This file IS the "schema design" the interview asked me to strengthen.
--  It reads as the story of the whole system:
--    A workflow is a GRAPH of nodes connected by edges.
--    Running a workflow creates a run, which produces one run_step per node.
--    The pipeline operates on leads, attaches enrichments, and writes messages.
--
--  Decisions I can defend out loud:
--   * PostgreSQL: clear relations (a run belongs to a workflow, a message to a
--     lead) via FOREIGN KEYS, plus JSONB columns for the flexible parts
--     (node config, step output). Relational backbone + schemaless where useful.
--   * nodes + edges as separate tables = a real DIRECTED GRAPH, not a fixed
--     5-step line. Re-wire the pipeline by inserting rows, no code change.
--   * run_step stores each step's output as JSONB => every run is auditable
--     and replayable. That's what a real automation product needs.
--   * UNIQUE(lead_id, source) on enrichment = dedup/caching enforced BY THE
--     DATABASE, so we never pay for the same external lookup twice. Ties to
--     the 700M -> 10B scaling question.
--   * UNIQUE(run_id, lead_id) on message = idempotency: re-running can't
--     double-send to the same lead.
--
--  Running this file is idempotent (safe to run repeatedly): it drops and
--  recreates everything, so `npm run db:reset` always gives a clean slate.
-- ============================================================================

-- Drop in dependency order (children first) so re-running is clean.
DROP TABLE IF EXISTS message     CASCADE;
DROP TABLE IF EXISTS enrichment  CASCADE;
DROP TABLE IF EXISTS run_step    CASCADE;
DROP TABLE IF EXISTS run         CASCADE;
DROP TABLE IF EXISTS edge        CASCADE;
DROP TABLE IF EXISTS node        CASCADE;
DROP TABLE IF EXISTS workflow    CASCADE;
DROP TABLE IF EXISTS lead        CASCADE;

DROP TYPE IF EXISTS workflow_status CASCADE;
DROP TYPE IF EXISTS run_status      CASCADE;
DROP TYPE IF EXISTS step_status     CASCADE;
DROP TYPE IF EXISTS node_type       CASCADE;

-- Enums: constrained value sets, enforced by the database itself.
CREATE TYPE workflow_status AS ENUM ('DRAFT', 'LIVE');
CREATE TYPE run_status      AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE step_status     AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');
CREATE TYPE node_type       AS ENUM ('SIGNAL', 'ENRICH', 'SCORE', 'MESSAGE', 'CRM');

-- A workflow = the pipeline definition (the recipe).
CREATE TABLE workflow (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     workflow_status NOT NULL DEFAULT 'DRAFT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A node = one step in the pipeline. `config` (JSONB) holds per-type settings
-- (e.g. the SCORE node keeps its weights + threshold here) so we don't need a
-- separate table per node type.
CREATE TABLE node (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  type        node_type NOT NULL,
  name        TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}'
);

-- An edge = a directed connection from one node to another (from -> to).
-- The engine reads these to compute execution order.
CREATE TABLE edge (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  from_node_id TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  to_node_id   TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE
);

-- A run = one execution of a workflow.
CREATE TABLE run (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
  status      run_status NOT NULL DEFAULT 'RUNNING',
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- A run_step = one node's execution within one run. This is the live "Run Log"
-- in the UI and the permanent audit trail. `output` (JSONB) = what it produced.
CREATE TABLE run_step (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL REFERENCES node(id),
  status      step_status NOT NULL DEFAULT 'PENDING',
  output      JSONB,
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

-- A lead = a company the pipeline works on.
CREATE TABLE lead (
  id            TEXT PRIMARY KEY,
  company_name  TEXT NOT NULL,
  domain        TEXT NOT NULL UNIQUE,
  employees     INT NOT NULL,
  funding_stage TEXT NOT NULL,
  hiring_signal BOOLEAN NOT NULL DEFAULT false,
  tech_stack    TEXT[] NOT NULL DEFAULT '{}',   -- Postgres native array
  icp_score     INT                             -- filled in by the SCORE node
);

-- An enrichment = extra data pulled for a lead from one source.
-- UNIQUE(lead_id, source) means the ENRICH node can skip work it already did:
-- database-level dedup / caching.
CREATE TABLE enrichment (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL REFERENCES lead(id) ON DELETE CASCADE,
  source     TEXT NOT NULL,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id, source)
);

-- A message = the AI-written outreach for a lead. `generated_by` records
-- whether it came from a live Claude call or the templated fallback.
-- UNIQUE(run_id, lead_id) = idempotency (one message per lead per run).
CREATE TABLE message (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  lead_id      TEXT NOT NULL REFERENCES lead(id),
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, lead_id)
);

-- Indexes on the foreign keys we filter/join on most (read performance).
CREATE INDEX idx_node_workflow      ON node(workflow_id);
CREATE INDEX idx_edge_workflow      ON edge(workflow_id);
CREATE INDEX idx_run_workflow       ON run(workflow_id);
CREATE INDEX idx_runstep_run        ON run_step(run_id);
CREATE INDEX idx_enrichment_lead    ON enrichment(lead_id);
CREATE INDEX idx_message_run        ON message(run_id);
CREATE INDEX idx_lead_signal        ON lead(hiring_signal);
