import type { Env } from "./types";
import { exceptionId } from "./keys";
import { daysInPeriod, isValidPeriod } from "./time";

/**
 * Reconciliation: recompute the aggregates from the R2 raw archive and diff them against D1.
 *
 * This is the stage that makes the rest of the pipeline believable. Aggregation can be correct in
 * every test and still drift in production — a failed D1 batch, a schema migration applied while
 * events were in flight, someone running an UPDATE by hand. Reconciliation is the answer to
 * "how would you know?".
 *
 * Two deliberate properties:
 *
 *  - It NEVER resolves anything. It opens exceptions and refreshes what it has already seen. A
 *    discrepancy that disappears on its own stays open until a human closes it, because
 *    "it went away" is a finding, not a fix.
 *
 *  - Exception IDs are deterministic — sha256(account|period|meter|hour|kind). Re-running updates
 *    one row instead of accumulating a new near-duplicate on every run.
 *
 * Scope, stated plainly: reconciliation independently recomputes QUANTITIES from the archive. It
 * takes DISPOSITION (bucketed vs adjustment) from D1, because disposition depends on the ordering
 * of close against arrival, which the archive alone cannot replay. An archived event that D1 knows
 * nothing about — neither bucketed nor adjusted — is itself an exception.
 */

export interface ReconcileResult {
  run_id: string;
  account_id: string;
  period: string;
  objects_scanned: number;
  buckets_compared: number;
  exceptions_opened: number;
  exceptions_seen: number;
  findings: Array<{
    exception_id: string;
    kind: string;
    meter: string | null;
    hour_start: number | null;
    expected_quantity: number | null;
    actual_quantity: number | null;
    detail: string;
  }>;
}

interface ArchiveAggregate {
  quantity: number;
  event_ids: Set<string>;
}

/** Aggregate the archive with list() + customMetadata: 1000 objects per subrequest, no GETs. */
async function aggregateArchive(env: Env, account: string, period: string) {
  const byBucket = new Map<string, ArchiveAggregate>();
  const archivedIds = new Set<string>();
  let objects_scanned = 0;

  for (const day of daysInPeriod(period)) {
    let cursor: string | undefined;
    do {
      const listing = await env.ARCHIVE.list({
        prefix: `raw/dt=${day}/${account}/`,
        include: ["customMetadata"],
        cursor,
        limit: 1000,
      });
      for (const obj of listing.objects) {
        const md = obj.customMetadata ?? {};
        const meter = md.m;
        const hour = Number(md.h);
        const quantity = Number(md.q);
        const eventId = obj.key.slice(obj.key.lastIndexOf("/") + 1, -".json".length);
        if (!meter || !Number.isFinite(hour) || !Number.isFinite(quantity)) continue;
        objects_scanned++;
        archivedIds.add(eventId);
        const key = `${meter}|${hour}`;
        const agg = byBucket.get(key) ?? { quantity: 0, event_ids: new Set<string>() };
        // Keyed by event_id: an object listed twice (or rewritten by a retry) is counted once.
        if (!agg.event_ids.has(eventId)) {
          agg.event_ids.add(eventId);
          agg.quantity += quantity;
        }
        byBucket.set(key, agg);
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }

  return { byBucket, archivedIds, objects_scanned };
}

export async function reconcile(
  env: Env,
  account: string,
  period: string,
  actor: string,
  now: number,
  runId: string,
): Promise<ReconcileResult> {
  if (!isValidPeriod(period)) throw new Error("period must be YYYY-MM");

  await env.DB.prepare(
    `INSERT OR IGNORE INTO reconciliation_runs (run_id, account_id, period, started_at, actor) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(runId, account, period, now, actor)
    .run();

  const { byBucket, archivedIds, objects_scanned } = await aggregateArchive(env, account, period);

  const { results: d1Buckets } = await env.DB.prepare(
    `SELECT meter, hour_start, quantity FROM buckets WHERE account_id = ? AND period = ?`,
  )
    .bind(account, period)
    .all<{ meter: string; hour_start: number; quantity: number }>();

  const { results: adjusted } = await env.DB.prepare(
    `SELECT event_id, meter, hour_start, quantity FROM adjustments WHERE account_id = ? AND period = ?`,
  )
    .bind(account, period)
    .all<{ event_id: string; meter: string; hour_start: number; quantity: number }>();

  const { results: knownEvents } = await env.DB.prepare(
    `SELECT event_id FROM events WHERE account_id = ? AND period = ?`,
  )
    .bind(account, period)
    .all<{ event_id: string }>();

  // Events D1 routed to adjustments are not expected in any bucket — remove their quantity from
  // the archive-derived expectation before comparing.
  const expected = new Map<string, number>();
  for (const [key, agg] of byBucket) expected.set(key, agg.quantity);
  for (const adj of adjusted ?? []) {
    const key = `${adj.meter}|${adj.hour_start}`;
    if (byBucket.get(key)?.event_ids.has(adj.event_id)) {
      expected.set(key, (expected.get(key) ?? 0) - adj.quantity);
    }
  }

  const actual = new Map<string, number>();
  for (const b of d1Buckets ?? []) actual.set(`${b.meter}|${b.hour_start}`, b.quantity);

  const findings: ReconcileResult["findings"] = [];

  for (const key of new Set([...expected.keys(), ...actual.keys()])) {
    const [meter, hourText] = key.split("|");
    const hour_start = Number(hourText);
    const exp = expected.get(key) ?? 0;
    const act = actual.get(key) ?? 0;
    if (exp === act) continue;
    findings.push({
      exception_id: await exceptionId(account, period, meter, hour_start, "bucket_mismatch"),
      kind: "bucket_mismatch",
      meter,
      hour_start,
      expected_quantity: exp,
      actual_quantity: act,
      detail: `archive says ${exp}, D1 says ${act} (difference ${act - exp})`,
    });
  }

  // Archived but unknown to D1: the recoverable failure direction (R2 write succeeded, D1 batch
  // did not). Reported per period rather than per event so one bad batch is one finding.
  const known = new Set([...(knownEvents ?? []).map((r) => r.event_id), ...(adjusted ?? []).map((r) => r.event_id)]);
  const orphans = [...archivedIds].filter((id) => !known.has(id));
  if (orphans.length > 0) {
    findings.push({
      exception_id: await exceptionId(account, period, null, null, "missing_from_d1"),
      kind: "missing_from_d1",
      meter: null,
      hour_start: null,
      expected_quantity: orphans.length,
      actual_quantity: 0,
      detail: `${orphans.length} archived event(s) are in neither events nor adjustments: ${orphans.slice(0, 10).join(", ")}${orphans.length > 10 ? ", ..." : ""}`,
    });
  }

  // Ledger without archive: the unprovable direction. A number we could never substantiate.
  const missingFromArchive = [...(knownEvents ?? []).map((r) => r.event_id)].filter((id) => !archivedIds.has(id));
  if (missingFromArchive.length > 0) {
    findings.push({
      exception_id: await exceptionId(account, period, null, null, "missing_from_archive"),
      kind: "missing_from_archive",
      meter: null,
      hour_start: null,
      expected_quantity: 0,
      actual_quantity: missingFromArchive.length,
      detail: `${missingFromArchive.length} event(s) in D1 have no archive object: ${missingFromArchive.slice(0, 10).join(", ")}${missingFromArchive.length > 10 ? ", ..." : ""}`,
    });
  }

  let exceptions_opened = 0;
  for (const f of findings) {
    const existing = await env.DB.prepare(`SELECT exception_id FROM exceptions WHERE exception_id = ?`)
      .bind(f.exception_id)
      .first<{ exception_id: string }>();
    if (!existing) exceptions_opened++;
    await env.DB.prepare(
      `INSERT INTO exceptions (exception_id, account_id, period, meter, hour_start, kind,
                               expected_quantity, actual_quantity, detail, status, detected_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
       ON CONFLICT (exception_id) DO UPDATE SET
         expected_quantity = excluded.expected_quantity,
         actual_quantity   = excluded.actual_quantity,
         detail            = excluded.detail,
         last_seen_at      = excluded.last_seen_at`,
      // Note what this UPDATE does not touch: `status`. Re-running reconciliation refreshes the
      // numbers on a finding, and can never flip a resolved exception back open or an open one shut.
    )
      .bind(
        f.exception_id, account, period, f.meter, f.hour_start, f.kind,
        f.expected_quantity, f.actual_quantity, f.detail, now, now,
      )
      .run();
  }

  await env.DB.prepare(
    `UPDATE reconciliation_runs SET finished_at = ?, objects_scanned = ?, buckets_compared = ?,
            exceptions_opened = ?, exceptions_seen = ? WHERE run_id = ?`,
  )
    .bind(now, objects_scanned, new Set([...expected.keys(), ...actual.keys()]).size, exceptions_opened, findings.length, runId)
    .run();

  return {
    run_id: runId,
    account_id: account,
    period,
    objects_scanned,
    buckets_compared: new Set([...expected.keys(), ...actual.keys()]).size,
    exceptions_opened,
    exceptions_seen: findings.length,
    findings,
  };
}

/** The only path that can close an exception. Keyed, audited, and never called by a machine. */
export async function resolveException(
  env: Env,
  exceptionId_: string,
  actor: string,
  note: string,
  now: number,
): Promise<{ resolved: boolean; already_resolved: boolean }> {
  const row = await env.DB.prepare(`SELECT status FROM exceptions WHERE exception_id = ?`)
    .bind(exceptionId_)
    .first<{ status: string }>();
  if (!row) return { resolved: false, already_resolved: false };
  if (row.status === "resolved") return { resolved: true, already_resolved: true };

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE exceptions SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution_note = ?
        WHERE exception_id = ? AND status = 'open'`,
    ).bind(now, actor, note, exceptionId_),
    env.DB.prepare(
      `INSERT OR IGNORE INTO audit_log (ts, actor, action, target, detail, idempotency_key)
       VALUES (?, ?, 'exception.resolve', ?, ?, ?)`,
    ).bind(now, actor, exceptionId_, JSON.stringify({ note }), `exception.resolve|${exceptionId_}`),
  ]);

  return { resolved: true, already_resolved: false };
}
