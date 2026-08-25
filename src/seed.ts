// ============================================================================
//  SEED — fills the database with realistic data so the demo has something to
//  run against. Inserts ~120 companies (leads) and ONE default workflow whose
//  nodes + edges form the classic GTM pipeline:
//
//      SIGNAL ──> ENRICH ──> SCORE ──> MESSAGE ──> CRM
//
//  Run with:  npm run db:seed   (migrate first)
// ============================================================================
import { pool, id } from './db';

const FUNDING = ['Seed', 'Series A', 'Series B', 'Series C'];
const TECH = [
  ['HubSpot', 'Apollo', 'Gong'],
  ['Salesforce', 'Outreach', 'ZoomInfo'],
  ['HubSpot', 'Clay', 'Apollo'],
  ['Pipedrive', 'Lemlist'],
  ['Salesforce', 'Salesloft', 'Clearbit'],
];
const NAMES = [
  'Acme Analytics', 'DataPlex', 'CloudScale', 'Nimbus Labs', 'Vertex AI',
  'Quantum Metrics', 'Northwind', 'BluePeak', 'Solaris', 'Meridian',
  'Cobalt', 'Driftwood', 'Evergreen', 'Foundry', 'Granite',
  'Harbor', 'Ionic', 'Junction', 'Keystone', 'Lattice',
];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

async function main() {
  // ---- Leads: ~120 companies with varied attributes -----------------------
  let leadCount = 0;
  for (let i = 0; i < 120; i++) {
    const base = pick(NAMES);
    const company = `${base} ${['Inc', 'Labs', 'Systems', 'Group', 'HQ'][i % 5]} ${i}`;
    const domain = `${base.toLowerCase().replace(/\s/g, '')}${i}.com`;
    const employees = 20 + Math.floor(Math.random() * 900);
    const funding = pick(FUNDING);
    // ~45% of companies show a hiring signal (the trigger the pipeline reacts to)
    const hiring = Math.random() < 0.45;
    const tech = pick(TECH);
    await pool.query(
      `INSERT INTO lead (id, company_name, domain, employees, funding_stage, hiring_signal, tech_stack)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (domain) DO NOTHING`,
      [id('lead'), company, domain, employees, funding, hiring, tech]
    );
    leadCount++;
  }
  console.log(`✓ Seeded ${leadCount} leads.`);

  // ---- One default workflow: 5 nodes + 4 edges ----------------------------
  const wfId = id('wf');
  await pool.query(
    `INSERT INTO workflow (id, name, status) VALUES ($1,$2,'LIVE')`,
    [wfId, 'Series B GTM Outreach']
  );

  // Node configs carry the per-step settings the engine reads.
  const nodes = [
    { key: 'signal',  type: 'SIGNAL',  name: 'Signal Detector',
      config: { requireHiringSignal: true, fundingStages: ['Series B'], minEmployees: 50, maxEmployees: 500 } },
    { key: 'enrich',  type: 'ENRICH',  name: 'Flo AI Agent',
      config: { sources: ['apollo', 'clearbit', 'crunchbase'] } },
    { key: 'score',   type: 'SCORE',   name: 'ICP Scorer',
      config: { weights: { funding: 0.3, techFit: 0.4, signalRecency: 0.3 }, threshold: 70 } },
    { key: 'message', type: 'MESSAGE', name: 'Message Writer',
      config: { tone: 'direct, concise' } },
    { key: 'crm',     type: 'CRM',     name: 'Push to CRM',
      config: { crm: 'Salesforce', sequence: 'GTM-Hiring-Cold' } },
  ];

  const nodeIds: Record<string, string> = {};
  for (const n of nodes) {
    const nid = id('node');
    nodeIds[n.key] = nid;
    await pool.query(
      `INSERT INTO node (id, workflow_id, type, name, config) VALUES ($1,$2,$3,$4,$5)`,
      [nid, wfId, n.type, n.name, JSON.stringify(n.config)]
    );
  }

  // Edges wire the nodes into a line: signal -> enrich -> score -> message -> crm
  const edges: [string, string][] = [
    ['signal', 'enrich'], ['enrich', 'score'], ['score', 'message'], ['message', 'crm'],
  ];
  for (const [from, to] of edges) {
    await pool.query(
      `INSERT INTO edge (id, workflow_id, from_node_id, to_node_id) VALUES ($1,$2,$3,$4)`,
      [id('edge'), wfId, nodeIds[from], nodeIds[to]]
    );
  }
  console.log(`✓ Seeded default workflow (${wfId}) with 5 nodes + 4 edges.`);

  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
