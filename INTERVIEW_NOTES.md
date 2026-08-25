# How to defend this demo — talking points

The last round said the gap was explaining the backend. So the win condition
this time isn't the code existing — it's you explaining **why** every piece is
the way it is. Read this until you can say each answer in your own words without
looking. If you can't explain a file, open it and change something until you can.

## The 30-second overview (say this first)
"I rebuilt it with a real backend. It's a Postgres database, a REST API, and a
workflow engine. A workflow is a graph of nodes and edges. When you run it, the
engine orders the nodes, executes each one, and writes every step to the
database, so every run is fully auditable. The outreach step is a real Claude
call. I also built in the pieces that matter for scale — caching, idempotency,
retries."

## Why Postgres (schema selection)
"The data is relational — a run belongs to a workflow, a message belongs to a
lead — so foreign keys and joins fit naturally. But some parts are flexible, like
each node's config and each step's output, so I used JSONB columns for those.
Relational backbone, schemaless where it helps."

## Why nodes + edges as separate tables (architecture)
"That makes the workflow a real directed graph, not a hard-coded five-step line.
You can add a node or re-wire the pipeline by inserting rows — no code change.
It's also why the engine needs a topological sort to find the run order."

## The engine (the core)
"It loads the nodes and edges, topologically sorts them so every node runs only
after the ones feeding it, creates a run row, then executes each node. For each
node it writes a run_step row — RUNNING, then DONE or FAILED — with the node's
output as JSON. If a node fails it retries once; if it still fails the run is
marked FAILED and stops."

## Topological sort (CS fundamentals)
"Kahn's algorithm. Count each node's incoming edges, start with the ones that
have none, and every time you place a node you decrement its neighbours. If you
can't place them all, there's a cycle, which I reject. It's O(nodes + edges)."

## Caching / dedup (scale lever #1)
"The enrichment table has a unique constraint on (lead_id, source). The enrich
node checks for an existing row before doing work, so we never re-fetch data we
already have. External enrichment calls are the expensive part, so this is the
biggest cost lever. You can see it in the demo — run it twice and the second run
skips everything as cache hits."

## Idempotency (scale lever #2)
"The message table is unique on (run_id, lead_id), so re-running can't double-send
to the same lead. At scale, retries are constant, so operations have to be safe
to repeat."

## The Claude call
"The message node calls Claude with the lead's data and asks for a subject and
body. If there's no API key or the call fails, it falls back to a template, and I
store which path was used in generated_by. Graceful degradation — the pipeline
stays up even if the model call fails."

## The API
"Resource-based REST. Workflows and runs are resources; starting a run is a POST
to /workflows/:id/runs that returns a run id; you read results from
/runs/:id. Central error handler, proper status codes, parameterised SQL so
there's no injection."

## When he pushes: "how would you take this to 10B runs a week?"
"Right now a run executes inline in the request, which is fine for a demo but
wouldn't hold. I'd put runs on a queue and process them with stateless workers
that autoscale on queue depth. I'd batch external calls, add a per-provider rate
limiter, and shard the data by tenant. The caching and idempotency I already have
are the foundation for that."

## The honest lines (use them — they build trust)
- "The enrichment values are mocked — there's no paid data provider wired up —
  but the flow, the storage, and the Claude call are real."
- "I ran execution inline so the demo is simple to follow; the queue-based version
  is the real-scale design."
- If you don't know something: "I haven't done that exact thing, but here's how
  I'd reason about it." That's what they hire for.

## Things to actually do before you send it
1. Run it yourself 3–4 times until the flow is muscle memory.
2. Open every file and make sure you can explain it. Change a weight in the SCORE
   node config and watch the qualified count change — that proves you understand it.
3. Add your own real ANTHROPIC_API_KEY locally and run it once so you've SEEN the
   real Claude messages (generated_by: claude), not just the template.
4. Deploy it so Vansh gets a live link, and skim the README so you can walk the
   architecture diagram.
