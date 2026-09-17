# Prompt history

Built with Claude Code (Opus 5). Every human prompt is recorded here verbatim, in order, with a
short note on what it produced. Model output is summarised, never pasted.

## Session 1 — 2026-09-17

**1.**

```
Build three small, deployable projects on Cloudflare's developer platform, in
one public repo (via gh cli) with a workspace per project. Priority order below.
Ask clarifying questions before writing code, and record every prompt verbatim
in PROMPTS.md as you go.

PROJECT 1 — "meter": a usage metering and rating pipeline (build this first)

The point is to exercise collection → aggregation → rating → invoicing as four
distinct stages, the way a real consumption-billing platform does.

- Ingest Worker accepts billable events: {account_id, meter, quantity,
  event_time, event_id}. event_id is the idempotency key.
- Events go to a Queue. The consumer writes the raw event to R2 (append-only
  archive, partitioned by date) and updates aggregates in D1.
- Aggregation buckets by EVENT TIME, not arrival time, per account per meter
  per hour. Aggregation must be idempotent and order-independent: replaying the
  same event_id changes nothing. Prove it with a test that replays a batch.
- Late events: accept anything within a configurable lateness window and fold it
  into its event-time bucket. Events arriving after a period is closed go to an
  adjustments table instead of mutating the closed period.
- Price book lives in KV, versioned. Rating applies the rate card to aggregated
  quantities, honors per-meter free tiers, and stamps the price book version on
  every rated line.
- A reconciliation job recomputes aggregates from the R2 raw archive and
  compares them to D1. Any discrepancy is written to an exceptions table and
  surfaced in the UI. It must not auto-resolve.
- Small UI on Pages/Workers Assets: emit test events, watch buckets fill, close
  a period, see the invoice preview and any exceptions.
- Money in integer cents. Unit tests on rating, free-tier consumption,
  idempotent replay, late-event handling, and reconciliation.

PROJECT 2 — "ratecard": semantic search over Cloudflare's own billing docs

- Crawl the public pricing and billing docs, chunk them, embed with Workers AI,
  store in Vectorize.
- Query Worker does retrieval + answer generation, routed through AI Gateway so
  caching, spend and latency are observable. Show the gateway metrics in the UI.
- Cache frequent answers in KV. Cap daily spend the same way quote-to-cash does.

PROJECT 3 — "gate": put Cloudflare Access in front of project 1's admin surface

- Zero Trust Access policy protecting the period-close and exception-resolution
  routes, with the read-only views left public.
- Validate the Access JWT in the Worker rather than trusting the edge alone.
- Log who closed a period and who resolved an exception — a real audit trail,
  append-only.

CONSTRAINTS FOR ALL THREE
- Production-shaped but demo-ready. Deployed and reachable.
- Guardrails enforced in code, not in prompts or model instructions.
- Every state-changing operation is idempotent and keyed.
- Out of scope: real payments, tax, multi-tenancy beyond account_id.
- README per project: one-line thesis, architecture diagram, and the design
  decisions with their tradeoffs stated.
```

Claude oriented first (node/wrangler/gh versions, `wrangler whoami`, existing `~/projects/metered`,
account bindings) without writing code, then asked three clarifying questions.

**2.**

```
let's do one project at a time
```

Scope narrowed to PROJECT 1 (`meter`). Projects 2 and 3 stay in this repo's plan but are not
started; the workspace layout leaves room for them.

**3.** Clarifying questions (asked by Claude, answered by the user):

- *Repo name and relationship to the existing `sivori/metered` submission?* → **New repo
  `cf-billing-lab`**, npm workspaces, `metered` left untouched.
- *Workers Paid or Free?* → **"Not sure — detect it."** Claude detected it: the account has a live
  queue consumer (`bookmark-funnel` on `bookmark-ingest`), and Queues is Workers-Paid-only, so the
  account is Paid. Reconciliation is still written the Free-safe way (`R2 list()` +
  `customMetadata`) because it is also far cheaper in subrequests on Paid.
- *Hostname?* → **`meter.sivori.xyz`**, a custom domain on the existing zone, so PROJECT 3's
  Cloudflare Access policy is possible later without re-plumbing URLs (workers.dev subdomains
  cannot sit behind an Access app).

**4.**

```
btw, explain what we are building
```

Claude answered inline (the four-stage table, plus the three load-bearing ideas: derived buckets,
queue-timestamp arrival, and event time vs arrival time) and carried on building.

**5.**

```
walk me through the code when done
```

Queued for the end of the build — a file-by-file walkthrough after the deploy and smoke test.
