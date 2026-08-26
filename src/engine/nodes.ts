import { query, id } from '../db';
import { writeOutreach } from '../claude';

export interface Ctx {
  leadIds: string[];
  runId: string;
  [key: string]: any;
}

// SIGNAL: pick the leads that match the trigger criteria.
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

// ENRICH: batched inserts + one cache-check query (fast over the network).
export async function runEnrich(config: any, ctx: Ctx) {
  const sources = config.sources as string[];
  if (ctx.leadIds.length === 0) return { enriched: 0, skipped: 0 };

  const existing = await query<{ lead_id: string; source: string }>(
    `SELECT lead_id, source FROM enrichment WHERE lead_id = ANY($1::text[])`,
    [ctx.leadIds]
  );
  const have = new Set(existing.map((e) => `${e.lead_id}:${e.source}`));

  const values: string[] = [];
  const params: any[] = [];
  let i = 1;
  let enriched = 0;
  for (const leadId of ctx.leadIds) {
    for (const source of sources) {
      if (have.has(`${leadId}:${source}`)) continue;
      const data = { verifiedEmail: true, source, fetchedAt: new Date().toISOString() };
      values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
      params.push(id('enr'), leadId, source, JSON.stringify(data));
      enriched++;
    }
  }

  if (values.length > 0) {
    await query(
      `INSERT INTO enrichment (id, lead_id, source, data) VALUES ${values.join(',')}
       ON CONFLICT (lead_id, source) DO NOTHING`,
      params
    );
  }
  const skipped = ctx.leadIds.length * sources.length - enriched;
  return { enriched, skipped, note: 'skipped = served from cache (dedup)' };
}

// SCORE: compute an ICP score per lead, keep only those above threshold.
export async function runScore(config: any, ctx: Ctx) {
  const kept: string[] = [];
  for (const leadId of ctx.leadIds) {
    const [lead] = await query<any>(`SELECT * FROM lead WHERE id = $1`, [leadId]);
    if (!lead) continue;
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
  ctx.leadIds = kept;
  return { qualified: kept.length, discarded, threshold: config.threshold };
}

// MESSAGE: write outreach per qualified lead (real Claude call, template fallback).
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

// CRM: final delivery step (mock push + sequence enrolment).
export async function runCrm(config: any, ctx: Ctx) {
  return {
    pushedToCrm: ctx.leadIds.length,
    crm: config.crm,
    sequence: config.sequence,
    dedup: true,
  };
}

export const NODE_RUNNERS: Record<string, (config: any, ctx: Ctx) => Promise<any>> = {
  SIGNAL: runSignal,
  ENRICH: runEnrich,
  SCORE: runScore,
  MESSAGE: runMessage,
  CRM: runCrm,
};
