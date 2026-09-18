# meter

**A usage-billing pipeline that can prove its own invoice — by recomputing it from an independent archive and refusing to close over a discrepancy it cannot explain.**

Live: **[meter.sivori.xyz](https://meter.sivori.xyz)** · 49 tests in `workerd` against real D1, R2 and KV.

## Why it is shaped this way

Consumption billing is not CRUD with multiplication at the end. The hard parts are all in the
seams: an event that happened yesterday and arrived today, a queue that delivers the same message
twice, a price change that must not restate an issued invoice, an aggregate that quietly drifts
from the events it claims to summarise. So the four stages are four modules with real boundaries,
and the interesting code is at the joins.

The thing it refuses to do is as important as what it does: it will not close a period while a
reconciliation exception is open, it will not bill a meter it has no rate for, and it will not
resolve a discrepancy on its own.

## Architecture

```
  POST /v1/events                    ┌──────────────── Cloudflare Queue ────────────────┐
  {account_id, meter, quantity,      │  at-least-once · message.timestamp = arrival     │
   event_time, event_id}             └──────────────────────┬───────────────────────────┘
          │                                                 │
          ▼                                                 ▼
  ┌───────────────┐                                 ┌────────────────────┐
  │ ① COLLECTION  │  validate: known meter,         │ ② AGGREGATION      │
  │   ingest.ts   │  integer qty, no future         │   aggregate.ts     │
  └───────────────┘  dates. Enqueue. Never          └─────────┬──────────┘
                     blocks on D1.                            │
                                            ┌─────────────────┴─────────────────┐
                                            ▼                                   ▼
                              ┌──────────────────────────┐        ┌──────────────────────────┐
                              │ R2  meter-archive        │        │ D1  events → buckets     │
                              │ raw/dt=<EVENT date>/     │        │ bucket = SUM(events)     │
                              │     <account>/<id>.json  │        │ per account/meter/HOUR   │
                              │ append-only, key = id    │        │ derived, never summed up │
                              └────────────┬─────────────┘        └───────────┬──────────────┘
                                           │                                  │
                                           │      ┌───────────────────────────┤
                                           │      ▼                           ▼
                                           │  ┌────────────────┐     ┌──────────────────┐
                                           │  │ ③ RATING       │◀────│ KV  price book   │
                                           │  │   rating.ts    │     │ pricebook:vN     │
                                           │  │ pure · integer │     │ immutable        │
                                           │  └───────┬────────┘     └──────────────────┘
                                           │          ▼
                                           │  ┌────────────────────────────────────────┐
                                           │  │ ④ INVOICING  invoice.ts                │
                                           │  │ close = rate once, persist rated_lines,│
                                           │  │ stamp version, one-way door            │
                                           │  └────────────────────────────────────────┘
                                           │          │
                                           ▼          ▼
                              ┌──────────────────────────────────────────┐
                              │ RECONCILIATION  reconcile.ts             │
                              │ recompute from R2, diff against D1,      │
                              │ open keyed exceptions — never resolve    │
                              │ them. An open exception blocks the close.│
                              └──────────────────────────────────────────┘
```

## The five-minute tour

0. Open [meter.sivori.xyz](https://meter.sivori.xyz). The page gives you your own `account_id`,
   because closing a period is a one-way door and a shared account would let the first visitor end
   the demo for everyone else. **Worked example** loads `acct_demo`: a period already closed, with
   a resolved exception on it.
1. Click **Burst: 24 events across 24h** and watch the buckets fill — one per event hour, a second
   or two behind, because the queue is real.
2. Click **Emit one 100h late**. It lands in *adjustments*, not a bucket: it arrived outside the
   72-hour lateness window.
3. Click **Inject drift**, then **Run reconciliation**. The archive and the ledger disagree, and
   the exception says by exactly how much.
4. Click **Close period**. It refuses — `409 unresolved_exceptions`.
5. **Resolve** the exception with a note, then close. The invoice is now `source: stored`, with the
   price book version stamped on every line.
6. Emit one more event. The issued total does not move; it appears as carry-forward under
   adjustments.

## Design decisions, and what each one costs

**Buckets are derived, not incremented.** Every write recomputes
`SUM(quantity) FROM events WHERE (account, meter, hour)`. A replayed `event_id` inserts nothing, so
the SUM does not move; a reordered batch produces the same SUM. Idempotency and order-independence
therefore fall out of the data model rather than depending on anyone writing the careful version of
an increment. *Cost:* a recompute per touched bucket instead of a single `UPDATE … SET q = q + ?`,
and an `events` table that grows with every event. At real volume the `events` table becomes the
scaling problem, and the answer is partition-and-roll-forward, not a cleverer increment.

**Lateness is judged against the queue's message timestamp, never `Date.now()`.** Queues are
at-least-once, and a retry can run minutes later. Judged against the wall clock, a redelivered
event could cross the lateness boundary and land in a *different table* on retry. `message.timestamp`
is fixed at enqueue, so the verdict is a property of the event, not of when the retry happened to
run. *Cost:* an event that sat in a dead-letter queue for a week keeps its original arrival time —
which is the honest answer, but it means DLQ replays need their own policy.

**Disposition is decided inside the D1 transaction; `classify()` is advisory.** The consumer reads
period status and then writes, and a close can land in that gap. So the bucket insert and the
adjustment insert are a mutually-exclusive pair evaluated inside one batch: the bucket insert
applies only `WHERE NOT EXISTS (… period … status='closed')`, and the adjustment only
`WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_id = ?)`. This is also what makes a redelivery
*across* a close a no-op — otherwise an event could be bucketed into a closed invoice **and**
recorded as a billable adjustment, i.e. charged twice. *Cost:* two statements per event and SQL
that has to be read carefully. Worth it: this was a real bug, and the two regression tests in
`test/late.test.ts` fail against the previous version.

**The R2 write happens before the D1 write, deliberately.** On failure the archive is a strict
superset of the ledger. That direction is recoverable — reconciliation reports `missing_from_d1`
and the event can be replayed. The opposite direction would be a number nobody could ever
substantiate. *Cost:* orphaned archive objects after a failed batch, which is why
`missing_from_d1` is a first-class finding rather than an assertion.

**Reconciliation aggregates via `list()` + `customMetadata`, not per-object `GET`s.** Each list page
returns 1000 objects with their metadata in one subrequest; reading 1000 objects individually would
be 1000 subrequests and would hit the per-request cap on a busy month. *Cost:* the quantities being
compared come from object metadata written at archive time rather than from re-parsing each body.
It is still an independent recomputation of the aggregate, but it trusts the archived metadata; a
paranoid version would sample bodies and verify. *Stated plainly:* reconciliation independently
recomputes **quantities**. It takes **disposition** (bucketed vs adjusted) from D1, because
disposition depends on the ordering of close against arrival, which the archive alone cannot
replay. An archived event D1 knows nothing about is itself a finding.

**Reconciliation never resolves — and re-opens only when the numbers change.** Re-running
refreshes `expected`, `actual` and `last_seen_at` on a deterministically-keyed row. There is no
path in that statement to `'resolved'`: only a human, with a note, in an audited request. A
discrepancy that disappears on its own leaves the exception open, because "it went away" is a
finding, not a fix. But a *different* discrepancy on the same bucket flips it back to open, because
a different number is a different finding and the note written about the old one does not explain
it — otherwise one resolution would turn that bucket into a permanent blind spot. *Cost:*
exceptions accumulate and need triage. That is the point. Note also that **resolving does not
correct data** — it records a judgment. The live `acct_demo` invoice shows this honestly: it closed
with the injected drift still in the bucket, because someone said they understood it.

**Money is integer cents, computed in `BigInt`.** `amount = round_half_up(billable × price_cents /
per_units)`. At 10¹² units the intermediate product exceeds the exact integer range of a double, and
a silently inexact multiply is the kind of bug that surfaces as a one-cent discrepancy on 0.001% of
invoices and takes a quarter to find. *Cost:* `BigInt` conversion on every line, which is free at
this scale.

**The price book is immutable per version.** `pricebook:vN` refuses to be overwritten, in code.
Closed periods stamp the version they were rated at, so publishing v2 cannot restate last month.
*Cost:* every price change is a new version and a pointer move; there is no "fix a typo in v1".

**A meter with usage but no rate blocks the close.** Billing it as $0 would be a silent revenue
leak nobody notices. *Cost:* dropping a meter from the price book while usage is still arriving
will stop a close until someone deals with it.

**No cron trigger.** Reconciliation is `POST /admin/reconcile`, an operator action with an audit
trail, rather than a background job whose last run nobody can name. (It also avoids this account's
cron cap, where an over-limit deploy reports success while the schedule silently stays stale.)
*Cost:* nothing runs it automatically. In production this belongs on a schedule *and* on demand.

**Known gap, not yet closed:** a close that commits between the consumer's read and its write is
handled, but a close that commits between an event being bucketed and the rating query reading
buckets would rate without that event and reconciliation would not flag it — archive and `buckets`
would agree, and only `rated_lines` would be the odd one out. The fix is a drain barrier: refuse to
close until the queue backlog for that account is empty. Out of scope here; listed in `BACKLOG.md`.

## API

| Method | Route | Notes |
|---|---|---|
| `POST` | `/v1/events` | One event, an array, or `{events:[…]}`. Partial acceptance is explicit. |
| `GET` | `/v1/accounts/:id/buckets?period=` | Aggregates by event hour. |
| `GET` | `/v1/accounts/:id/invoice?period=` | Preview while open, stored lines once closed. |
| `GET` | `/v1/accounts/:id/adjustments?period=` | Usage that could not move the number. |
| `GET` | `/v1/accounts/:id/exceptions?period=` | Reconciliation findings. |
| `GET` | `/v1/accounts/:id/reconciliation-runs` | When did we last check? |
| `GET` | `/v1/pricebook`, `/v1/pricebook/:version` | Current and historical rate cards. |
| `GET` | `/v1/audit` | Append-only trail. |
| `POST` | `/admin/periods/:id/:period/close` | Keyed on (account, period). Idempotent. |
| `POST` | `/admin/reconcile` | `{account_id, period, run_id?}`. Pass `run_id` to retry a run. |
| `POST` | `/admin/exceptions/:id/resolve` | `{note}` required. |
| `PUT` | `/admin/pricebook` | Refuses to overwrite a published version. |
| `POST` | `/admin/pricebook/current` · `/admin/pricebook/seed` | Pointer move · idempotent seed. |
| `POST` | `/admin/demo/drift` | Demo only, gated by `DEMO_MODE`. |

Read routes are public; `/admin/*` is the surface PROJECT 3 puts Cloudflare Access in front of.
The split is a path prefix on purpose — a Zero Trust policy is a prefix match, and a route layout
that needs a regex to protect is one that eventually gets protected wrong.

## Running it

```bash
npm install
npm run migrate:local && npm test          # 49 tests in workerd, real D1/R2/KV
npm run dev                                 # http://localhost:8787

npm run migrate:remote && npm run deploy    # then POST /admin/pricebook/seed
```

## Where the money is

`src/rating.ts` — 120 lines, pure, no I/O, no clock, no floats — and `test/rating.test.ts`.
Everything else in this Worker exists to hand that function a correct set of quantities.
