# Floqer-style GTM Workflow Engine — backend demo

A working backend that models Floqer's core product: a **workflow** is a graph of
**nodes**; running it executes a GTM pipeline — detect a buying **signal**,
**enrich** the company, **score** it against an ICP, write **outreach** (real
Claude call), and **push** to CRM. Every step is persisted to **PostgreSQL** and
served through a **REST API**. A small frontend drives it.

This exists to address specific interview feedback: strengthen **backend design,
schema selection, API development, and system architecture**. So the interesting
part is the backend, not the UI.

## What's real vs. mocked
- **Real:** PostgreSQL schema, the REST API, the workflow engine (graph ordering,
  per-step persistence, retries), database-level dedup/caching, idempotent
  messages, and a live Claude API call for outreach.
- **Mocked:** the *values* of enrichment data (no paid data provider is wired up)
  and the final CRM push (recorded, not sent). The flow and storage are real.

## Architecture

```
 Browser (public/index.html)
        │  fetch()
        ▼
 REST API  (Express, src/index.ts)
        │
        ▼
 Workflow Engine  (src/engine/runWorkflow.ts)
   1. load nodes + edges from DB
   2. topological sort  (src/engine/topoSort.ts)
   3. create run, execute each node in order (src/engine/nodes.ts)
   4. write a run_step row per node (RUNNING → DONE/FAILED), retry once
   5. MESSAGE node calls Claude (src/claude.ts), template fallback on failure
        │
        ▼
 PostgreSQL   (schema in db/schema.sql)
```

## Data model (8 tables)

```
workflow ──< node >── edge          (a workflow is a graph of nodes + edges)
   │
   └──< run ──< run_step             (each run logs one step per node)
                   │
lead ──< enrichment                  (dedup: UNIQUE(lead_id, source))
   └──< message  >── run             (idempotent: UNIQUE(run_id, lead_id))
```

Full DDL with commentary is in **`db/schema.sql`** — read that first.

## Run it locally

Prereqs: Node 18+ and a PostgreSQL database (local, or a free
[Neon](https://neon.tech) database).

```bash
npm install
cp .env.example .env         # then paste your DATABASE_URL (and optional ANTHROPIC_API_KEY)
npm run db:reset             # creates tables + seeds 120 leads and a default workflow
npm run dev                  # starts the API + serves the frontend at http://localhost:3000
```

Open http://localhost:3000 and press **Run workflow**. Run it twice to see the
cache/dedup kick in.

### Environment
```
DATABASE_URL=postgresql://user:pass@host/db      # required
ANTHROPIC_API_KEY=sk-ant-...                      # optional; without it, outreach uses a template
```

## API

| Method | Route | Purpose |
|--------|-------|---------|
| GET  | `/api/health` | liveness |
| GET  | `/api/workflows` | list workflows |
| GET  | `/api/workflows/:id` | one workflow + its nodes and edges |
| POST | `/api/workflows/:id/runs` | execute the pipeline, returns `runId` |
| GET  | `/api/runs/:id` | run status, every step (with output), messages |
| GET  | `/api/leads?qualified=true` | scored leads |

## Deploying (optional, for the shared link)
- **Database:** create a free Neon Postgres, copy its connection string into `DATABASE_URL`.
- **Backend:** deploy this repo to [Railway](https://railway.app) or Render; set the
  env vars; run `npm run db:reset` once against the Neon DB.
- **Frontend:** it's served by the same Express app, so the deployed backend URL is the demo.

## How this scales (the 700M → 10B question)
The demo shows the *primitives* you'd build on:
- **Dedup/caching** at the DB layer (`UNIQUE(lead_id, source)`) so repeated
  enrichment is never re-fetched — the biggest cost lever.
- **Idempotency** (`UNIQUE(run_id, lead_id)`) so retries are safe.
- **Retries** per node in the engine.
The next steps for real scale: move run execution onto a **queue + stateless
workers** (instead of running inline in the request), **batch** external calls,
add a **per-provider rate limiter**, and **shard** the data by tenant.
