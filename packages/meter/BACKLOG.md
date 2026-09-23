# meter — backlog

## Now
- [ ] Nothing blocking. PROJECT 1 is deployed and green.

## Next
- [ ] **Drain barrier before close.** A close that commits between an event being bucketed and the
      rating query reading buckets would rate without that event, and reconciliation would not flag
      it (archive and `buckets` agree; only `rated_lines` is out of step). Refuse to close until the
      queue backlog for the account is empty, or re-rate and compare before persisting.
- [ ] **Adjustments should carry into the next open period** instead of only being reported.
      Today `carry_forward_cents` is shown next to the invoice; a real system folds it into the
      following period's lines with a provenance link back to the closed period.
- [ ] **Reconciliation over all accounts**, not one at a time — a period-level sweep with a summary.
- [ ] **DLQ policy.** Messages that exhaust retries land in `meter-events-dlq` and nothing reads it.
      Decide whether a DLQ replay keeps its original arrival time (it currently would) or is
      re-stamped, and write the answer down.
- [ ] **Sampled body verification in reconciliation.** Quantities are compared from R2
      `customMetadata`; a paranoid pass would re-parse a sample of object bodies to catch metadata
      that disagrees with the archived event itself.
- [ ] **`events` table growth.** Deriving buckets means keeping every event forever. Needs a
      partition-and-roll-forward story before this shape survives real volume.

## Someday
- [ ] Tiered and graduated pricing (today: one rate plus a free tier per meter) @idea
- [ ] Commitment/minimum-spend handling at close @idea
- [ ] Per-account lateness windows, rather than one account-wide env var @idea
- [ ] Invoice PDF / stable invoice numbers @idea
- [ ] Reconciliation is manual (`POST /admin/reconcile`), partly because of the old 5-cron account cap. The account went Workers Paid on 2026-09-22 (cap 1,000), so a scheduled reconcile is now possible — the audit-trail reason for keeping it manual still stands; decide deliberately @idea

## Done
- [x] 2026-09-17 Four-stage pipeline: ingest → queue → R2 archive + D1 buckets → rating → close
- [x] 2026-09-17 Idempotent, order-independent aggregation via derived buckets
- [x] 2026-09-17 Late-event window + adjustments for closed periods
- [x] 2026-09-17 Versioned immutable price book in KV, version stamped on every rated line
- [x] 2026-09-17 Reconciliation from the R2 archive with keyed, never-auto-resolved exceptions
- [x] 2026-09-17 Fixed: redelivery across a close could bucket AND adjust the same event (double bill)
- [x] 2026-09-17 Deployed to meter.sivori.xyz, live smoke test passed
