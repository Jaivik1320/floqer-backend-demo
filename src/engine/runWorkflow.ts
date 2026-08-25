// ============================================================================
//  THE WORKFLOW ENGINE
//  This is the core "system architecture" piece. It:
//    1. Loads a workflow's nodes + edges from the database.
//    2. Computes a safe execution order (topological sort of the graph).
//    3. Creates a `run` row, then executes each node in order.
//    4. For every node it writes a `run_step` row (RUNNING -> DONE/FAILED)
//       with the node's output as JSONB — a full, replayable audit trail.
//    5. Retries a failed node once; if it still fails, the run is marked FAILED
//       and stops. Otherwise the run is COMPLETED.
//
//  A shared `ctx` object flows through the nodes so each step can read what the
//  previous ones produced (e.g. the qualified lead list). That's the data
//  contract between steps.
// ============================================================================
import { query, id } from '../db';
import { topoSort } from './topoSort';
import { NODE_RUNNERS, Ctx } from './nodes';

export async function runWorkflow(workflowId: string): Promise<string> {
  // 1. Load the graph.
  const nodes = await query<any>(`SELECT * FROM node WHERE workflow_id = $1`, [workflowId]);
  const edges = await query<any>(`SELECT * FROM edge WHERE workflow_id = $1`, [workflowId]);
  if (nodes.length === 0) throw new Error('Workflow has no nodes.');

  // 2. Order the nodes so each runs only after its inputs are ready.
  const order = topoSort(nodes, edges);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // 3. Create the run row.
  const runId = id('run');
  await query(`INSERT INTO run (id, workflow_id, status) VALUES ($1,$2,'RUNNING')`, [runId, workflowId]);

  const ctx: Ctx = { leadIds: [], runId };
  let failed = false;

  // 4. Execute each node in order.
  for (const nodeId of order) {
    const node = nodeById.get(nodeId)!;
    const stepId = id('step');
    await query(
      `INSERT INTO run_step (id, run_id, node_id, status, started_at)
       VALUES ($1,$2,$3,'RUNNING', now())`,
      [stepId, runId, nodeId]
    );

    const runner = NODE_RUNNERS[node.type];
    let output: any = null;
    let ok = false;

    // Retry once on failure (a real-world resilience pattern).
    for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
      try {
        output = await runner(node.config, ctx);
        ok = true;
      } catch (err) {
        output = { error: (err as Error).message, attempt };
        if (attempt === 2) console.error(`Node ${node.name} failed twice:`, err);
      }
    }

    await query(
      `UPDATE run_step SET status = $1, output = $2, finished_at = now() WHERE id = $3`,
      [ok ? 'DONE' : 'FAILED', JSON.stringify(output), stepId]
    );

    if (!ok) { failed = true; break; }
  }

  // 5. Finalise the run.
  await query(
    `UPDATE run SET status = $1, finished_at = now() WHERE id = $2`,
    [failed ? 'FAILED' : 'COMPLETED', runId]
  );

  return runId;
}
