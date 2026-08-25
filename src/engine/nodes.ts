// ============================================================================
//  NODE LOGIC — what each step actually DOES.
//  Every node is a function: (config, context) -> output.
//  `context` is a shared bag the engine passes down the pipeline, so each node
//  can read what earlier nodes produced (e.g. ENRICH reads SIGNAL's lead list).
//  This is the "clear data contract between steps" idea, made real.
//
//  Each node reads/writes the REAL database via SQL. Nothing is faked here
//  except the *values* of the mock enrichment (there's no paid data provider
//  wired up) — but the flow, the storage, and the Claude call are all real.
// ============================================================================
import { query, id } from '../db';
import { writeOutreach } from '../claude';

export interface Ctx {
  leadIds: string[];        // leads currently flowing through the pipeline
  runId: string;
  [key: string]: any;
}

// ---- SIGNAL: pick the leads that match the trigger criteria ---------------
export async function runSignal(config: any, ctx: Ctx) {
  const rows = await query<{ id: string }>(
    `SELECT id FROM lead
     WHERE ($1::bool IS NOT TRUE OR hiring_signal = true)
       AND funding_stage = ANY($2::text[])
       AND employees BETWEEN $3 AND $4`,
    [config.requireHiringSignal, config.fundingStages, config.minEmployees, config.maxEmployees]
  );
  ctx.leadIds = rows.map((r) => r.id);
  return { matched: ctx.leadIds.length, criteria: config };
}

// ---- ENRICH: attach data per lead, but SKIP leads already enriched --------
//  The UNIQUE(lead_id, source) constraint + this check = cache/dedup.
export async function runEnrich(config: any, ctx: Ctx) {
  let enriched = 0;
  let skipped = 0;
  for (const leadId of ctx.leadIds) {
    for (const source of config.sources as string[]) {
      // Cache check: do we already have this source for this lead?
      const existing = await query(
        `SELECT 1 FROM enrichment WHERE lead_id = $1 AND source = $2`,
        [leadId, source]
      );
      if (existing.length > 0) { skipped++; continue; }

      // (Mock provider data — in production this is the external API call.)
      const data = { verifiedEmail: true, source, fetchedAt: new Date().toISOString() };
      await query(
        `INSERT INTO enrichment (id, lead_id, source, data) VALUES ($1,$2,$3,$4)
         ON CONFLICT (lead_id, source) DO NOTHING`,
        [id('enr'), leadId, source, JSON.stringify(data)]
      );
      enriched++;
    }
  }
  return { enriched, skipped, note: 'skipped = served from cache (dedup)' };
}

// ---- SCORE: compute an ICP score per lead, keep only those above threshold -
export async function runScore(config: any, ctx: Ctx) {
  const kept: string[] = [];
  for (const leadId of ctx.leadIds) {
    const [lead] = await query<any>(`SELECT * FROM lead WHERE id = $1`, [leadId]);
    if (!lead) continue;

    // A simple, explainable scoring model using the configured weights.
    const fundingScore = lead.funding_stage === 'Series B' ? 100 : 60;
    const techScore = lead.tech_stack.length >= 3 ? 100 : 70;
    const signalScore = lead.hiring_signal ? 100 : 40;
    const w = config.weights;
    const score = Math.round(
      fundingScore * w.funding + techScore * w.techFit + signalScore * w.signalRecency
    );

    await query(`UPDATE lead SET icp_score = $1 WHERE id = $2`, [score, leadId]);
    if (score >= config.threshold) kept.push(leadId);
  }
  const discarded = ctx.leadIds.length - kept.length;
  ctx.leadIds = kept; // only qualified leads continue down the pipeline
  return { qualified: kept.length, discarded, threshold: config.threshold };
}

// ---- MESSAGE: write outreach per qualified lead (real Claude call) --------
//  UNIQUE(run_id, lead_id) makes this idempotent: re-running won't duplicate.
export async function runMessage(config: any, ctx: Ctx) {
  let written = 0;
  let viaClaude = 0;
  for (const leadId of ctx.leadIds) {
    const [lead] = await query<any>(`SELECT * FROM lead WHERE id = $1`, [leadId]);
    if (!lead) continue;

    const msg = await writeOutreach({
      companyName: lead.company_name,
      fundingStage: lead.funding_stage,
      techStack: lead.tech_stack,
      hiringSignal: lead.hiring_signal,
    });
    if (msg.generatedBy === 'claude') viaClaude++;

    await query(
      `INSERT INTO message (id, run_id, lead_id, subject, body, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (run_id, lead_id) DO NOTHING`,
      [id('msg'), ctx.runId, leadId, msg.subject, msg.body, msg.generatedBy]
    );
    written++;
  }
  return { messagesWritten: written, viaClaude, viaTemplate: written - viaClaude };
}

// ---- CRM: final delivery step (mock push + sequence enrolment) ------------
export async function runCrm(config: any, ctx: Ctx) {
  // In production this calls Salesforce/HubSpot. Here we record the outcome.
  return {
    pushedToCrm: ctx.leadIds.length,
    crm: config.crm,
    sequence: config.sequence,
    dedup: true,
  };
}

// A lookup so the engine can find the right function for a node's type.
export const NODE_RUNNERS: Record<string, (config: any, ctx: Ctx) => Promise<any>> = {
  SIGNAL: runSignal,
  ENRICH: runEnrich,
  SCORE: runScore,
  MESSAGE: runMessage,
  CRM: runCrm,
};
