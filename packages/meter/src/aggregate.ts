import type { Disposition, Env, QueuedEvent } from "./types";
import { archiveKey } from "./keys";
import { dayOf } from "./time";

/**
 * Aggregation: the second stage. Archive the raw event, then fold it into its EVENT-TIME bucket.
 *
 * Two properties are load-bearing and both are structural rather than defensive:
 *
 *  1. `buckets` is derived, never incremented. Each write recomputes the bucket as
 *     `SUM(quantity) FROM events WHERE (account, meter, hour)`. A replayed event_id inserts
 *     nothing (`ON CONFLICT DO NOTHING`), so the SUM is unchanged; a batch delivered in a
 *     different order produces the same SUM. Idempotence and order-independence therefore do not
 *     depend on anyone remembering to write the careful version of an increment.
 *
 *  2. `arrival_time` is the QUEUE message timestamp, not `Date.now()` at processing time. Queue
 *     retries reprocess the same message minutes later; using the clock would mean a redelivered
 *     event could cross the lateness boundary and land in a different table on retry — the exact
 *     non-determinism this pipeline is supposed to rule out.
 */

export interface PendingEvent {
  event: QueuedEvent;
  /** Epoch ms the message entered the queue. Stable across retries. */
  arrival_time: number;
}

export interface PeriodState {
  status: string;
  closed_at: number | null;
}

/** The disposition rule, in one pure function so the tests can hit it directly. */
export function classify(
  pending: PendingEvent,
  period: PeriodState | null,
  latenessWindowMs: number,
): Disposition {
  if (period?.status === "closed") {
    return { kind: "adjustment", reason: "period_closed" };
  }
  if (pending.arrival_time - pending.event.event_time > latenessWindowMs) {
    return { kind: "adjustment", reason: "beyond_lateness_window" };
  }
  return { kind: "bucket" };
}

export interface ApplyResult {
  bucketed: number;
  adjusted: number;
  dispositions: Array<{ event_id: string; disposition: Disposition }>;
}

export async function loadPeriodStates(
  env: Env,
  pairs: Array<{ account_id: string; period: string }>,
): Promise<Map<string, PeriodState>> {
  const states = new Map<string, PeriodState>();
  const unique = [...new Set(pairs.map((p) => `${p.account_id}|${p.period}`))];
  if (unique.length === 0) return states;

  const placeholders = unique.map(() => "(? , ?)").join(",");
  const binds = unique.flatMap((k) => k.split("|"));
  const { results } = await env.DB.prepare(
    `SELECT account_id, period, status, closed_at FROM periods WHERE (account_id, period) IN (${placeholders})`,
  )
    .bind(...binds)
    .all<{ account_id: string; period: string; status: string; closed_at: number | null }>();

  for (const row of results ?? []) {
    states.set(`${row.account_id}|${row.period}`, { status: row.status, closed_at: row.closed_at });
  }
  return states;
}

/**
 * Archive every event to R2, then apply the batch to D1 in one transaction.
 *
 * Order matters on failure: the archive is written first, so a D1 failure leaves the archive a
 * strict superset of the ledger. That direction is recoverable — reconciliation reports the event
 * as `missing_from_d1` and an operator can replay it. The other direction (ledger without
 * archive) would be a number nobody can ever prove.
 */
export async function applyEvents(
  env: Env,
  pending: PendingEvent[],
  latenessWindowMs: number,
  now: number,
): Promise<ApplyResult> {
  if (pending.length === 0) return { bucketed: 0, adjusted: 0, dispositions: [] };

  const states = await loadPeriodStates(
    env,
    pending.map((p) => ({ account_id: p.event.account_id, period: p.event.period })),
  );

  const decided = pending.map((p) => ({
    ...p,
    disposition: classify(p, states.get(`${p.event.account_id}|${p.event.period}`) ?? null, latenessWindowMs),
  }));

  // R2 first. The key is the event_id, so a retry overwrites itself byte-for-byte.
  await Promise.all(
    decided.map(({ event, arrival_time }) =>
      env.ARCHIVE.put(
        archiveKey(dayOf(event.event_time), event.account_id, event.event_id),
        JSON.stringify({ ...event, event_time_iso: new Date(event.event_time).toISOString(), arrival_time }),
        {
          httpMetadata: { contentType: "application/json" },
          // Reconciliation aggregates from list() + customMetadata: 1000 objects per subrequest
          // instead of 1000 GETs. Same numbers, ~1000x fewer subrequests.
          customMetadata: {
            a: event.account_id,
            m: event.meter,
            h: String(event.hour_start),
            q: String(event.quantity),
            t: String(arrival_time),
          },
        },
      ),
    ),
  );

  const statements: D1PreparedStatement[] = [];
  const touchedBuckets = new Map<string, QueuedEvent>();

  for (const { event, arrival_time, disposition } of decided) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO periods (account_id, period, status) VALUES (?, ?, 'open')`,
      ).bind(event.account_id, event.period),
    );

    if (disposition.kind === "bucket") {
      statements.push(
        env.DB.prepare(
          `INSERT INTO events (event_id, account_id, meter, quantity, event_time, hour_start, period, arrival_time, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id) DO NOTHING`,
        ).bind(
          event.event_id, event.account_id, event.meter, event.quantity,
          event.event_time, event.hour_start, event.period, arrival_time, now,
        ),
      );
      touchedBuckets.set(`${event.account_id}|${event.meter}|${event.hour_start}`, event);
    } else {
      statements.push(
        env.DB.prepare(
          `INSERT INTO adjustments (event_id, account_id, meter, quantity, event_time, hour_start, period, arrival_time, reason, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (event_id) DO NOTHING`,
        ).bind(
          event.event_id, event.account_id, event.meter, event.quantity,
          event.event_time, event.hour_start, event.period, arrival_time, disposition.reason, now,
        ),
      );
    }
  }

  // Recompute each touched bucket from the deduplicated events. This is the idempotence.
  for (const event of touchedBuckets.values()) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO buckets (account_id, meter, hour_start, period, quantity, event_count, updated_at)
           SELECT account_id, meter, hour_start, period, SUM(quantity), COUNT(*), ?
             FROM events
            WHERE account_id = ? AND meter = ? AND hour_start = ?
         GROUP BY account_id, meter, hour_start, period
         ON CONFLICT (account_id, meter, hour_start) DO UPDATE SET
           quantity = excluded.quantity,
           event_count = excluded.event_count,
           updated_at = excluded.updated_at`,
      ).bind(now, event.account_id, event.meter, event.hour_start),
    );
  }

  await env.DB.batch(statements);

  return {
    bucketed: decided.filter((d) => d.disposition.kind === "bucket").length,
    adjusted: decided.filter((d) => d.disposition.kind === "adjustment").length,
    dispositions: decided.map((d) => ({ event_id: d.event.event_id, disposition: d.disposition })),
  };
}
