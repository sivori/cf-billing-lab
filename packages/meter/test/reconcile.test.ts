import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { applyEvents } from "../src/aggregate";
import { closePeriod } from "../src/invoice";
import { reconcile, resolveException } from "../src/reconcile";
import { ACCOUNT, HOUR, makeEvent, pending, seedPriceBook } from "./helpers";

const WINDOW = 72 * HOUR;
const T0 = Date.UTC(2026, 8, 3, 10, 0, 0);
const PERIOD = "2026-09";

beforeEach(seedPriceBook);

const seedUsage = () =>
  applyEvents(
    env,
    [
      pending(makeEvent("evt_1", "requests", 1000, T0)),
      pending(makeEvent("evt_2", "requests", 2000, T0 + HOUR)),
      pending(makeEvent("evt_3", "gb_egress", 30, T0 + 2 * HOUR)),
    ],
    WINDOW,
    Date.now(),
  );

const openExceptions = async () => {
  const { results } = await env.DB.prepare(
    `SELECT exception_id, kind, status, expected_quantity, actual_quantity FROM exceptions ORDER BY kind`,
  ).all<{ exception_id: string; kind: string; status: string; expected_quantity: number; actual_quantity: number }>();
  return results ?? [];
};

describe("reconciliation", () => {
  it("finds nothing when D1 agrees with the archive", async () => {
    await seedUsage();
    const result = await reconcile(env, ACCOUNT, PERIOD, "ops@example.com", Date.now(), "run_1");

    expect(result.objects_scanned).toBe(3);
    expect(result.buckets_compared).toBe(3);
    expect(result.findings).toHaveLength(0);
    expect(await openExceptions()).toHaveLength(0);
  });

  it("detects a bucket that drifted away from the archive", async () => {
    await seedUsage();
    // Whatever the cause — a hand-run UPDATE, a half-applied migration — the archive is the
    // evidence and D1 is the claim.
    await env.DB.prepare(
      `UPDATE buckets SET quantity = quantity + 500 WHERE account_id = ? AND meter = 'requests' AND hour_start = ?`,
    ).bind(ACCOUNT, T0).run();

    const result = await reconcile(env, ACCOUNT, PERIOD, "ops@example.com", Date.now(), "run_1");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: "bucket_mismatch",
      meter: "requests",
      expected_quantity: 1000,
      actual_quantity: 1500,
    });
    expect(result.exceptions_opened).toBe(1);
  });

  it("re-running updates the same exception instead of opening a second one", async () => {
    await seedUsage();
    await env.DB.prepare(`UPDATE buckets SET quantity = quantity + 500 WHERE account_id = ? AND hour_start = ?`)
      .bind(ACCOUNT, T0).run();

    const first = await reconcile(env, ACCOUNT, PERIOD, "ops", Date.now(), "run_1");
    const second = await reconcile(env, ACCOUNT, PERIOD, "ops", Date.now() + 60_000, "run_2");

    expect(second.exceptions_opened).toBe(0);
    expect(second.findings[0].exception_id).toBe(first.findings[0].exception_id);
    expect(await openExceptions()).toHaveLength(1);
  });

  it("never resolves anything by itself, even when the discrepancy disappears", async () => {
    await seedUsage();
    await env.DB.prepare(`UPDATE buckets SET quantity = quantity + 500 WHERE account_id = ? AND hour_start = ?`)
      .bind(ACCOUNT, T0).run();
    await reconcile(env, ACCOUNT, PERIOD, "ops", Date.now(), "run_1");

    // Someone "fixes" the data without explaining it.
    await env.DB.prepare(`UPDATE buckets SET quantity = quantity - 500 WHERE account_id = ? AND hour_start = ?`)
      .bind(ACCOUNT, T0).run();
    const after = await reconcile(env, ACCOUNT, PERIOD, "ops", Date.now() + 60_000, "run_2");

    expect(after.findings).toHaveLength(0);       // nothing to report this run
    const exceptions = await openExceptions();
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].status).toBe("open");     // and the finding still stands
  });

  it("flags an archived event that D1 never recorded", async () => {
    await seedUsage();
    // A D1 batch that failed after the R2 write: the recoverable direction, but still a gap.
    await env.DB.prepare(`DELETE FROM events WHERE event_id = 'evt_2'`).run();
    await env.DB.prepare(`UPDATE buckets SET quantity = 0, event_count = 0 WHERE meter = 'requests' AND hour_start = ?`)
      .bind(T0 + HOUR).run();

    const result = await reconcile(env, ACCOUNT, PERIOD, "ops", Date.now(), "run_1");
    const kinds = result.findings.map((f) => f.kind).sort();
    expect(kinds).toContain("missing_from_d1");
    expect(kinds).toContain("bucket_mismatch");
  });

  it("flags a ledger row with no archive object", async () => {
    await seedUsage();
    await env.ARCHIVE.delete(`raw/dt=2026-09-03/${ACCOUNT}/evt_3.json`);

    const result = await reconcile(env, ACCOUNT, PERIOD, "ops", Date.now(), "run_1");
    expect(result.findings.map((f) => f.kind)).toContain("missing_from_archive");
  });

  it("does not mistake an adjustment for a missing bucket", async () => {
    await seedUsage();
    await closePeriod(env, ACCOUNT, PERIOD, "ops", Date.now());
    // Arrives after the close: archived, recorded as an adjustment, deliberately not in a bucket.
    await applyEvents(env, [pending(makeEvent("evt_late", "requests", 5000, T0))], WINDOW, Date.now());

    const result = await reconcile(env, ACCOUNT, PERIOD, "ops", Date.now(), "run_1");
    expect(result.objects_scanned).toBe(4);
    expect(result.findings).toHaveLength(0);
  });

  it("records the run either way, so 'when did we last check?' has an answer", async () => {
    await seedUsage();
    await reconcile(env, ACCOUNT, PERIOD, "ops@example.com", Date.now(), "run_1");
    const run = await env.DB.prepare(`SELECT * FROM reconciliation_runs WHERE run_id = 'run_1'`)
      .first<{ objects_scanned: number; finished_at: number; actor: string }>();
    expect(run).toMatchObject({ objects_scanned: 3, actor: "ops@example.com" });
    expect(run!.finished_at).toBeGreaterThan(0);
  });

  it("re-running with the same run_id does not fork the history", async () => {
    await seedUsage();
    await reconcile(env, ACCOUNT, PERIOD, "ops", Date.now(), "run_1");
    await reconcile(env, ACCOUNT, PERIOD, "ops", Date.now() + 1000, "run_1");
    const { n } = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM reconciliation_runs`).first<{ n: number }>())!;
    expect(n).toBe(1);
  });
});

describe("resolving an exception", () => {
  const drift = async () => {
    await seedUsage();
    await env.DB.prepare(`UPDATE buckets SET quantity = quantity + 500 WHERE account_id = ? AND hour_start = ?`)
      .bind(ACCOUNT, T0).run();
    const result = await reconcile(env, ACCOUNT, PERIOD, "ops", Date.now(), "run_1");
    return result.findings[0].exception_id;
  };

  it("takes a human, a note, and an audit row", async () => {
    const id = await drift();
    const result = await resolveException(env, id, "ops@example.com", "replayed the lost batch", Date.now());
    expect(result).toEqual({ resolved: true, already_resolved: false });

    const row = await env.DB.prepare(`SELECT status, resolved_by, resolution_note FROM exceptions WHERE exception_id = ?`)
      .bind(id).first<{ status: string; resolved_by: string; resolution_note: string }>();
    expect(row).toMatchObject({ status: "resolved", resolved_by: "ops@example.com", resolution_note: "replayed the lost batch" });

    const audit = await env.DB.prepare(`SELECT actor, action, target FROM audit_log WHERE action = 'exception.resolve'`)
      .first<{ actor: string; target: string }>();
    expect(audit).toMatchObject({ actor: "ops@example.com", target: id });
  });

  it("is idempotent, and a second resolver cannot overwrite the first", async () => {
    const id = await drift();
    await resolveException(env, id, "first@example.com", "explained", Date.now());
    const again = await resolveException(env, id, "second@example.com", "also explained", Date.now() + 1000);

    expect(again).toEqual({ resolved: true, already_resolved: true });
    const row = await env.DB.prepare(`SELECT resolved_by, resolution_note FROM exceptions WHERE exception_id = ?`)
      .bind(id).first<{ resolved_by: string; resolution_note: string }>();
    expect(row).toMatchObject({ resolved_by: "first@example.com", resolution_note: "explained" });

    const { n } = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'exception.resolve'`).first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("unblocks the close once every exception is resolved", async () => {
    const id = await drift();
    await expect(closePeriod(env, ACCOUNT, PERIOD, "ops", Date.now())).rejects.toMatchObject({ code: "unresolved_exceptions" });
    await resolveException(env, id, "ops@example.com", "confirmed drift, corrected", Date.now());
    const { invoice } = await closePeriod(env, ACCOUNT, PERIOD, "ops", Date.now());
    expect(invoice.status).toBe("closed");
  });
});
