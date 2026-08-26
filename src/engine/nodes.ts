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

// SCORE: one SELECT for all leads, compute in memory, one batched UPDATE.
export async function runScore(config: any, ctx: Ctx) {
  if (ctx.leadIds.length === 0) return { qualified: 0, discarded: 0, threshold: config.threshold };
  const leads = await query<any>(`SELECT * FROM lead WHERE id = ANY($1::text[])`, [ctx.leadIds]);
  const w = config.weights;

  const ids: string[] = [];
  const scores: number[] = [];
  const kept: string[] = [];
  for (const lead of leads) {
    const fundingScore = lead.funding_stage === 'Series B' ? 100 : 60;
    const techScore = lead.tech_stack.length >= 3 ? 100 : 70;
    const signalScore = lead.hiring_signal ? 100 : 40;
    const score = Math.round(fundingScore * w.funding + techScore * w.techFit + signalScore * w.signalRecency);
    ids.push(lead.id);
    scores.push(score);
    if (score >= config.threshold) kept.push(lead.id);
  }

  // One UPDATE for every lead using unnest, instead of N updates.
  if (ids.length > 0) {
    await query(
      `UPDATE lead AS l SET icp_score = d.score
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::int[]) AS score) AS d
       WHERE l.id = d.id`,
      [ids, scores]
    );
  }
  const discarded = ctx.leadIds.length - kept.length;
  ctx.leadIds = kept;
  return { qualified: kept.length, discarded, threshold: config.threshold };
}

// MESSAGE: fetch all qualified leads once, build messages, one batched insert.
export async function runMessage(config: any, ctx: Ctx) {
  if (ctx.leadIds.length === 0) return { messagesWritten: 0, viaClaude: 0, viaTemplate: 0 };
  const leads = await query<any>(`SELECT * FROM lead WHERE id = ANY($1::text[])`, [ctx.leadIds]);

  const values: string[] = [];
  const params: any[] = [];
  let i = 1;
  let viaClaude = 0;
  for (const lead of leads) {
    const msg = await writeOutreach({
      companyName: lead.company_name,
      fundingStage: lead.funding_stage,
      techStack: lead.tech_stack,
      hiringSignal: lead.hiring_signal,
    });
    if (msg.generatedBy === 'claude') viaClaude++;
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(id('msg'), ctx.runId, lead.id, msg.subject, msg.body, msg.generatedBy);
  }
  if (values.length > 0) {
    await query(
      `INSERT INTO message (id, run_id, lead_id, subject, body, generated_by) VALUES ${values.join(',')}
       ON CONFLICT (run_id, lead_id) DO NOTHING`,
      params
    );
  }
  const written = values.length;
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
