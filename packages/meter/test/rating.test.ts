import { describe, it, expect } from "vitest";
import { amountCents, allocateFreeUnits, rateBuckets } from "../src/rating";
import { DEFAULT_PRICE_BOOK } from "../src/pricebook";
import type { Bucket, PriceBook } from "../src/types";

const HOUR = 3_600_000;
const bucket = (meter: string, hour: number, quantity: number): Bucket => ({
  account_id: "acct_demo",
  meter,
  hour_start: hour * HOUR,
  period: "2026-09",
  quantity,
  event_count: 1,
});

describe("amountCents", () => {
  it("prices per-unit and per-block rates in integer cents", () => {
    expect(amountCents(10, 9, 1)).toBe(90);
    expect(amountCents(2_000_000, 30, 1_000_000)).toBe(60);
  });

  it("rounds half up, and never produces a fraction of a cent", () => {
    // 1.5 blocks at 30c = 45c exactly
    expect(amountCents(1_500_000, 30, 1_000_000)).toBe(45);
    // 0.5 of a 1c block rounds up to 1c, not down to 0 and not to 0.5
    expect(amountCents(500_000, 1, 1_000_000)).toBe(1);
    expect(amountCents(499_999, 1, 1_000_000)).toBe(0);
  });

  it("stays exact past the point where doubles stop being integers", () => {
    // 10^12 units at 300c per 1c block overflows Number.MAX_SAFE_INTEGER mid-multiply.
    expect(amountCents(1_000_000_000_000, 300, 1_000_000)).toBe(300_000_000);
  });

  it("refuses inputs that could only produce nonsense", () => {
    expect(() => amountCents(-1, 10, 1)).toThrow(RangeError);
    expect(() => amountCents(1.5, 10, 1)).toThrow(RangeError);
    expect(() => amountCents(10, 10, 0)).toThrow(RangeError);
  });
});

describe("free tier", () => {
  it("consumes the allowance in event-time order, then bills the remainder", () => {
    const steps = allocateFreeUnits(
      [bucket("gb_egress", 2, 4), bucket("gb_egress", 0, 6), bucket("gb_egress", 1, 3)],
      10,
    );
    expect(steps.map((s) => s.hour_start / HOUR)).toEqual([0, 1, 2]);
    expect(steps.map((s) => s.free_applied)).toEqual([6, 3, 1]);
    expect(steps.map((s) => s.billable)).toEqual([0, 0, 3]);
    expect(steps.at(-1)!.free_remaining_after).toBe(0);
  });

  it("applies the allowance once per meter per period, not once per bucket", () => {
    const buckets = Array.from({ length: 4 }, (_, i) => bucket("gb_egress", i, 5));
    const { lines } = rateBuckets(buckets, DEFAULT_PRICE_BOOK);
    expect(lines[0].quantity).toBe(20);
    expect(lines[0].free_units_applied).toBe(10); // not 4 x 10
    expect(lines[0].billable_units).toBe(10);
    expect(lines[0].amount_cents).toBe(90);
  });

  it("charges nothing when usage never exceeds the allowance", () => {
    const { lines, subtotal_cents } = rateBuckets([bucket("gb_egress", 0, 3)], DEFAULT_PRICE_BOOK);
    expect(lines[0].billable_units).toBe(0);
    expect(subtotal_cents).toBe(0);
  });
});

describe("rateBuckets", () => {
  it("stamps the price book version on every line", () => {
    const { lines, price_book_version } = rateBuckets(
      [bucket("gb_egress", 0, 100), bucket("requests", 0, 3_000_000)],
      DEFAULT_PRICE_BOOK,
    );
    expect(price_book_version).toBe("v1");
    expect(lines.every((l) => l.price_book_version === "v1")).toBe(true);
  });

  it("rates the same usage differently under a different version, without mutating the first", () => {
    const v2: PriceBook = {
      version: "v2",
      meters: { gb_egress: { display: "Egress (GB)", free_units: 0, price_cents: 12, per_units: 1 } },
    };
    const usage = [bucket("gb_egress", 0, 100)];
    expect(rateBuckets(usage, DEFAULT_PRICE_BOOK).subtotal_cents).toBe(810); // (100-10) * 9c
    expect(rateBuckets(usage, v2).subtotal_cents).toBe(1200); // 100 * 12c, no free tier
  });

  it("reports a meter with no rate instead of quietly billing it as zero", () => {
    const { lines, unpriced_meters } = rateBuckets([bucket("mystery_meter", 0, 500)], DEFAULT_PRICE_BOOK);
    expect(lines).toHaveLength(0);
    expect(unpriced_meters).toEqual(["mystery_meter"]);
  });

  it("is order-independent: shuffled buckets rate identically", () => {
    const buckets = Array.from({ length: 12 }, (_, i) => bucket("requests", i, 250_000 + i));
    const forwards = rateBuckets(buckets, DEFAULT_PRICE_BOOK);
    const backwards = rateBuckets([...buckets].reverse(), DEFAULT_PRICE_BOOK);
    expect(backwards).toEqual(forwards);
  });
});
