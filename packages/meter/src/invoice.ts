import type { Bucket, Env, PriceBook } from "./types";
import { rateBuckets, allocateFreeUnits, amountCents, type RatedLineDraft, type FreeTierStep } from "./rating";
import { ratedLineId } from "./keys";
import * as pricebook from "./pricebook";
import { isValidPeriod, periodOf } from "./time";

/**
 * Rating and invoicing: stages three and four.
 *
 * A preview rates live buckets against the CURRENT price book and touches nothing. A close rates
 * once, persists the lines with the price book version stamped on each, and flips the period to
 * `closed`. There is no reopen path in this codebase — late usage becomes an adjustment instead,
 * which is the only honest way to keep an issued invoice meaningful.
 */

export class InvoiceError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly detail?: unknown) {
    super(message);
  }
}

export interface AdjustmentRow {
  event_id: string;
  meter: string;
  quantity: number;
  event_time: number;
  reason: string;
  arrival_time: number;
}

export interface Invoice {
  account_id: string;
  period: string;
  status: "open" | "closed";
  price_book_version: string;
  lines: Array<RatedLineDraft & { line_id?: string }>;
  subtotal_cents: number;
  unpriced_meters: string[];
  free_tier: Record<string, FreeTierStep[]>;
  adjustments: {
    events: AdjustmentRow[];
    total_quantity_by_meter: Record<string, number>;
    carry_forward_cents: number;
  };
  closed_at?: number | null;
  closed_by?: string | null;
  source: "preview" | "stored";
}

export async function loadBuckets(env: Env, account: string, period: string): Promise<Bucket[]> {
  const { results } = await env.DB.prepare(
    `SELECT account_id, meter, hour_start, period, quantity, event_count
       FROM buckets WHERE account_id = ? AND period = ? ORDER BY meter, hour_start`,
  )
    .bind(account, period)
    .all<Bucket>();
  return results ?? [];
}

async function loadAdjustments(env: Env, account: string, period: string): Promise<AdjustmentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT event_id, meter, quantity, event_time, reason, arrival_time
       FROM adjustments WHERE account_id = ? AND period = ? ORDER BY event_time`,
  )
    .bind(account, period)
    .all<AdjustmentRow>();
  return results ?? [];
}

/**
 * Adjustments are priced at the marginal rate — no free tier, because the period's free units
 * were already consumed (or forfeited) when the invoice was issued. They are reported next to
 * the invoice, never folded into its subtotal: a closed period's total is a fact.
 */
function priceAdjustments(rows: AdjustmentRow[], book: PriceBook) {
  const byMeter: Record<string, number> = {};
  for (const r of rows) byMeter[r.meter] = (byMeter[r.meter] ?? 0) + r.quantity;
  let carry = 0;
  for (const [meter, qty] of Object.entries(byMeter)) {
    const rate = book.meters[meter];
    if (rate) carry += amountCents(qty, rate.price_cents, rate.per_units);
  }
  return { total_quantity_by_meter: byMeter, carry_forward_cents: carry };
}

function freeTierDetail(buckets: Bucket[], book: PriceBook): Record<string, FreeTierStep[]> {
  const out: Record<string, FreeTierStep[]> = {};
  for (const meter of new Set(buckets.map((b) => b.meter))) {
    const rate = book.meters[meter];
    if (!rate) continue;
    out[meter] = allocateFreeUnits(buckets.filter((b) => b.meter === meter), rate.free_units);
  }
  return out;
}

async function storedInvoice(env: Env, account: string, period: string, row: {
  status: string; closed_at: number | null; closed_by: string | null; price_book_version: string | null; subtotal_cents: number | null;
}): Promise<Invoice> {
  const { results } = await env.DB.prepare(
    `SELECT line_id, meter, quantity, free_units_applied, billable_units, price_cents, per_units, amount_cents, price_book_version
       FROM rated_lines WHERE account_id = ? AND period = ? ORDER BY meter`,
  )
    .bind(account, period)
    .all<RatedLineDraft & { line_id: string }>();

  const version = row.price_book_version ?? "unknown";
  const book = (await pricebook.getVersion(env, version)) ?? { version, meters: {} };
  const adjustments = await loadAdjustments(env, account, period);
  const buckets = await loadBuckets(env, account, period);

  return {
    account_id: account,
    period,
    status: "closed",
    price_book_version: version,
    lines: results ?? [],
    subtotal_cents: row.subtotal_cents ?? (results ?? []).reduce((s, l) => s + l.amount_cents, 0),
    unpriced_meters: [],
    free_tier: freeTierDetail(buckets, book),
    adjustments: { events: adjustments, ...priceAdjustments(adjustments, book) },
    closed_at: row.closed_at,
    closed_by: row.closed_by,
    source: "stored",
  };
}

export async function getInvoice(env: Env, account: string, period: string): Promise<Invoice> {
  if (!isValidPeriod(period)) throw new InvoiceError("period must be YYYY-MM", 422, "invalid_period");

  const row = await env.DB.prepare(
    `SELECT status, closed_at, closed_by, price_book_version, subtotal_cents FROM periods WHERE account_id = ? AND period = ?`,
  )
    .bind(account, period)
    .first<{ status: string; closed_at: number | null; closed_by: string | null; price_book_version: string | null; subtotal_cents: number | null }>();

  if (row?.status === "closed") return storedInvoice(env, account, period, row);

  const book = await pricebook.getCurrent(env);
  if (!book) throw new InvoiceError("no current price book is published", 409, "no_price_book");

  const buckets = await loadBuckets(env, account, period);
  const rated = rateBuckets(buckets, book);
  const adjustments = await loadAdjustments(env, account, period);

  return {
    account_id: account,
    period,
    status: "open",
    price_book_version: book.version,
    lines: rated.lines,
    subtotal_cents: rated.subtotal_cents,
    unpriced_meters: rated.unpriced_meters,
    free_tier: freeTierDetail(buckets, book),
    adjustments: { events: adjustments, ...priceAdjustments(adjustments, book) },
    source: "preview",
  };
}

export interface CloseResult {
  invoice: Invoice;
  already_closed: boolean;
}

/**
 * Close a period. Keyed on (account, period): closing twice returns the first invoice rather
 * than rating again, so a retried request — or a double-clicked button — cannot produce a second
 * set of lines.
 */
export async function closePeriod(env: Env, account: string, period: string, actor: string, now: number): Promise<CloseResult> {
  if (!isValidPeriod(period)) throw new InvoiceError("period must be YYYY-MM", 422, "invalid_period");
  if (period > periodOf(now)) throw new InvoiceError("cannot close a period that has not started", 422, "future_period");

  const existing = await env.DB.prepare(
    `SELECT status, closed_at, closed_by, price_book_version, subtotal_cents FROM periods WHERE account_id = ? AND period = ?`,
  )
    .bind(account, period)
    .first<{ status: string; closed_at: number | null; closed_by: string | null; price_book_version: string | null; subtotal_cents: number | null }>();

  if (existing?.status === "closed") {
    return { invoice: await storedInvoice(env, account, period, existing), already_closed: true };
  }

  // Closing over an unexplained discrepancy would bake it into an issued invoice. Refuse, and
  // make someone look at it. This is why reconciliation never auto-resolves.
  const open = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM exceptions WHERE account_id = ? AND period = ? AND status = 'open'`,
  )
    .bind(account, period)
    .first<{ n: number }>();
  if ((open?.n ?? 0) > 0) {
    throw new InvoiceError(
      `period has ${open!.n} unresolved reconciliation exception(s)`,
      409,
      "unresolved_exceptions",
      { open_exceptions: open!.n },
    );
  }

  const book = await pricebook.getCurrent(env);
  if (!book) throw new InvoiceError("no current price book is published", 409, "no_price_book");

  const buckets = await loadBuckets(env, account, period);
  const rated = rateBuckets(buckets, book);
  if (rated.unpriced_meters.length > 0) {
    throw new InvoiceError(
      `price book ${book.version} has no rate for: ${rated.unpriced_meters.join(", ")}`,
      409,
      "unpriced_meters",
      { unpriced_meters: rated.unpriced_meters },
    );
  }

  const latenessWindowMs = Number(env.LATENESS_WINDOW_HOURS) * 3_600_000;
  const statements: D1PreparedStatement[] = [];

  for (const line of rated.lines) {
    const line_id = await ratedLineId(account, period, line.meter, book.version);
    statements.push(
      env.DB.prepare(
        `INSERT INTO rated_lines (line_id, account_id, period, meter, quantity, free_units_applied, billable_units,
                                  price_cents, per_units, amount_cents, price_book_version, rated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (line_id) DO NOTHING`,
      ).bind(
        line_id, account, period, line.meter, line.quantity, line.free_units_applied, line.billable_units,
        line.price_cents, line.per_units, line.amount_cents, book.version, now,
      ),
    );
  }

  statements.push(
    env.DB.prepare(
      `INSERT INTO periods (account_id, period, status, closed_at, closed_by, price_book_version, lateness_window_ms, subtotal_cents)
       VALUES (?, ?, 'closed', ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, period) DO UPDATE SET
         status = 'closed', closed_at = excluded.closed_at, closed_by = excluded.closed_by,
         price_book_version = excluded.price_book_version, lateness_window_ms = excluded.lateness_window_ms,
         subtotal_cents = excluded.subtotal_cents
       WHERE periods.status = 'open'`,
    ).bind(account, period, now, actor, book.version, latenessWindowMs, rated.subtotal_cents),
  );

  statements.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO audit_log (ts, actor, action, target, detail, idempotency_key)
       VALUES (?, ?, 'period.close', ?, ?, ?)`,
    ).bind(
      now, actor, `${account}/${period}`,
      JSON.stringify({ subtotal_cents: rated.subtotal_cents, price_book_version: book.version, lines: rated.lines.length }),
      `period.close|${account}|${period}`,
    ),
  );

  await env.DB.batch(statements);

  const row = await env.DB.prepare(
    `SELECT status, closed_at, closed_by, price_book_version, subtotal_cents FROM periods WHERE account_id = ? AND period = ?`,
  )
    .bind(account, period)
    .first<{ status: string; closed_at: number | null; closed_by: string | null; price_book_version: string | null; subtotal_cents: number | null }>();

  return { invoice: await storedInvoice(env, account, period, row!), already_closed: false };
}
