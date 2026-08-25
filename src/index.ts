// ============================================================================
//  REST API  (Express)
//  The HTTP layer the frontend talks to. Endpoints:
//    GET  /api/health                 - liveness check
//    GET  /api/workflows              - list workflows
//    GET  /api/workflows/:id          - one workflow with its nodes + edges
//    POST /api/workflows/:id/runs     - start a run (executes the pipeline)
//    GET  /api/runs/:id               - a run's status, steps, and messages
//    GET  /api/leads?qualified=true   - leads (optionally only scored ones)
//
//  This is the "API development" the feedback asked me to strengthen: clean
//  resource-based routes, correct status codes, JSON in/out, errors handled.
// ============================================================================
import express from 'express';
import cors from 'cors';
import { query } from './db';
import { runWorkflow } from './engine/runWorkflow';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve the frontend

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// List workflows.
app.get('/api/workflows', async (_req, res, next) => {
  try {
    res.json(await query(`SELECT * FROM workflow ORDER BY created_at DESC`));
  } catch (e) { next(e); }
});

// One workflow, with its nodes and edges (so the UI can draw the graph).
app.get('/api/workflows/:id', async (req, res, next) => {
  try {
    const [wf] = await query(`SELECT * FROM workflow WHERE id = $1`, [req.params.id]);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const nodes = await query(`SELECT * FROM node WHERE workflow_id = $1`, [req.params.id]);
    const edges = await query(`SELECT * FROM edge WHERE workflow_id = $1`, [req.params.id]);
    res.json({ ...wf, nodes, edges });
  } catch (e) { next(e); }
});

// Start a run. Executes the pipeline, then returns the finished run id.
// (For a demo we await the run so the client immediately gets results; at
//  scale you'd return 202 + a run id and process it on a queue/worker.)
app.post('/api/workflows/:id/runs', async (req, res, next) => {
  try {
    const runId = await runWorkflow(req.params.id);
    res.status(201).json({ runId });
  } catch (e) { next(e); }
});

// A run's full detail: status, every step (with output), and the messages.
app.get('/api/runs/:id', async (req, res, next) => {
  try {
    const [run] = await query(`SELECT * FROM run WHERE id = $1`, [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const steps = await query(
      `SELECT rs.*, n.name AS node_name, n.type AS node_type
       FROM run_step rs JOIN node n ON n.id = rs.node_id
       WHERE rs.run_id = $1 ORDER BY rs.started_at ASC`,
      [req.params.id]
    );
    const messages = await query(
      `SELECT m.*, l.company_name FROM message m JOIN lead l ON l.id = m.lead_id
       WHERE m.run_id = $1`,
      [req.params.id]
    );
    res.json({ ...run, steps, messages });
  } catch (e) { next(e); }
});

// Leads, optionally only the ones that scored (for the "Enriched Data" tab).
app.get('/api/leads', async (req, res, next) => {
  try {
    const qualified = req.query.qualified === 'true';
    const rows = qualified
      ? await query(`SELECT * FROM lead WHERE icp_score IS NOT NULL ORDER BY icp_score DESC LIMIT 25`)
      : await query(`SELECT * FROM lead ORDER BY company_name LIMIT 25`);
    res.json(rows);
  } catch (e) { next(e); }
});

// Central error handler — every route funnels failures here.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message ?? 'Internal error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ API running on http://localhost:${PORT}`));
