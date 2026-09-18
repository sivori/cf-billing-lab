# cf-billing-lab

Three small, deployable projects on Cloudflare's developer platform, built around the mechanics of
consumption billing. One repo, one workspace per project.

| | Project | Thesis | Status |
|---|---|---|---|
| **1** | [**meter**](packages/meter) | A usage-billing pipeline that can prove its own invoice — collection → aggregation → rating → invoicing, with a reconciliation loop against the raw archive. | **Live** at [meter.sivori.xyz](https://meter.sivori.xyz) · 47 tests |
| **2** | ratecard | Semantic search over Cloudflare's own pricing and billing docs: Workers AI embeddings in Vectorize, retrieval and generation through AI Gateway, with a daily spend cap enforced the way quote-to-cash does it. | Not started |
| **3** | gate | Cloudflare Access in front of meter's admin surface, with the Access JWT validated *in the Worker* rather than trusted at the edge, and an append-only record of who closed a period and who resolved an exception. | Not started |

## Principles the three share

- **Guardrails in code, not in prose.** Immutability, refusals and idempotency are enforced by
  `WHERE NOT EXISTS`, `ON CONFLICT`, unique keys and 409s — not by instructions asking anyone,
  human or model, to behave.
- **Every state-changing operation is idempotent and keyed**, on a key derived from its inputs
  rather than from a clock or a random source. Retrying updates one row; it never forks history.
- **Production-shaped, demo-ready.** Real queues, real object storage, real SQL, deployed and
  reachable — at a size you can read in an afternoon.

Out of scope throughout: real payments, tax, and multi-tenancy beyond `account_id`.

## Layout

```
packages/meter/      Worker + Queue consumer, D1, R2, KV, static UI
  src/               ingest · aggregate · rating · invoice · reconcile · pricebook
  migrations/        D1 schema
  test/              47 tests, run inside workerd against real bindings
  public/            single-page control surface
```

`PROMPTS.md` holds the verbatim prompt history for the whole build.

```bash
npm install
npm test -w meter
```
