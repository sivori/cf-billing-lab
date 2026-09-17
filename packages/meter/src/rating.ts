import type { Bucket, PriceBook } from "./types";

/**
 * Rating. Pure, synchronous, integer-only — no I/O, no clock, no floats.
 *
 * This is the money. It is deliberately the smallest, most boring file in the repo, and the
 * only one that decides what a customer owes. Everything else in `meter` exists to hand this
 * function a correct set of quantities.
 */

export interface RatedLineDraft {
  meter: string;
  quantity: number;
  free_units_applied: number;
  billable_units: number;
  price_cents: number;
  per_units: number;
  amount_cents: number;
  price_book_version: string;
}

export interface FreeTierStep {
  hour_start: number;
  quantity: number;
  free_applied: number;
  billable: number;
  free_remaining_after: number;
}

export interface RatingResult {
  lines: RatedLineDraft[];
  subtotal_cents: number;
  /** Meters present in the usage but absent from the price book. Never billed as zero. */
  unpriced_meters: string[];
  price_book_version: string;
}

/**
 * Cents for `billable` units at `price_cents` per `per_units`, rounded half-up.
 *
 * BigInt because a large enough bucket (say 10^12 units at 300 cents) overflows the exact range
 * of an IEEE double before the division happens, and a silently inexact multiply is the kind of
 * bug that shows up as a $0.01 discrepancy on 0.001% of invoices and takes a quarter to find.
 */
export function amountCents(billable: number, price_cents: number, per_units: number): number {
  if (!Number.isInteger(billable) || billable < 0) throw new RangeError("billable must be a non-negative integer");
  if (!Number.isInteger(price_cents) || price_cents < 0) throw new RangeError("price_cents must be a non-negative integer");
  if (!Number.isInteger(per_units) || per_units <= 0) throw new RangeError("per_units must be a positive integer");
  const numerator = BigInt(billable) * BigInt(price_cents) * 2n + BigInt(per_units);
  const cents = numerator / (BigInt(per_units) * 2n);
  return Number(cents);
}

/**
 * Walk buckets in event-time order and burn the free allowance down.
 *
 * The per-period total would be enough to compute the invoice, but the step-by-step view is what
 * a support engineer actually wants when a customer asks "when did I start being charged?" — so
 * the allocation is exposed rather than collapsed.
 */
export function allocateFreeUnits(buckets: Bucket[], free_units: number): FreeTierStep[] {
  let remaining = Math.max(0, free_units);
  return [...buckets]
    .sort((a, b) => a.hour_start - b.hour_start)
    .map((b) => {
      const free_applied = Math.min(remaining, b.quantity);
      remaining -= free_applied;
      return {
        hour_start: b.hour_start,
        quantity: b.quantity,
        free_applied,
        billable: b.quantity - free_applied,
        free_remaining_after: remaining,
      };
    });
}

/** Rate one account's buckets for one period against one price book version. */
export function rateBuckets(buckets: Bucket[], book: PriceBook): RatingResult {
  const byMeter = new Map<string, Bucket[]>();
  for (const b of buckets) {
    if (!Number.isInteger(b.quantity) || b.quantity < 0) {
      throw new RangeError(`bucket quantity must be a non-negative integer (meter=${b.meter})`);
    }
    const list = byMeter.get(b.meter) ?? [];
    list.push(b);
    byMeter.set(b.meter, list);
  }

  const lines: RatedLineDraft[] = [];
  const unpriced_meters: string[] = [];

  for (const meter of [...byMeter.keys()].sort()) {
    const rate = book.meters[meter];
    const meterBuckets = byMeter.get(meter)!;
    const quantity = meterBuckets.reduce((sum, b) => sum + b.quantity, 0);

    // A meter with usage but no rate is an error, not a free lunch. Billing $0 for it would be a
    // silent revenue leak that nobody notices; surfacing it blocks the close until a human acts.
    if (!rate) {
      unpriced_meters.push(meter);
      continue;
    }

    const free_units_applied = Math.min(rate.free_units, quantity);
    const billable_units = quantity - free_units_applied;
    lines.push({
      meter,
      quantity,
      free_units_applied,
      billable_units,
      price_cents: rate.price_cents,
      per_units: rate.per_units,
      amount_cents: amountCents(billable_units, rate.price_cents, rate.per_units),
      price_book_version: book.version,
    });
  }

  return {
    lines,
    subtotal_cents: lines.reduce((sum, l) => sum + l.amount_cents, 0),
    unpriced_meters,
    price_book_version: book.version,
  };
}
