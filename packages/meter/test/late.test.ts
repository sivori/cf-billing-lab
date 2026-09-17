import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { applyEvents, buildStatements, classify } from "../src/aggregate";
import { closePeriod, getInvoice } from "../src/invoice";
import { ACCOUNT, HOUR, bucketsOf, makeEvent, pending, seedPriceBook } from "./helpers";

const WINDOW = 72 * HOUR;
const T0 = Date.UTC(2026, 8, 3, 10, 0, 0);

beforeEach(seedPriceBook);

const adjustments = async () => {
  const { results } = await env.DB.prepare(`SELECT * FROM adjustments ORDER BY event_id`).all<{
    event_id: string; reason: string; quantity: number; period: string;
  }>();
  return results ?? [];
};

describe("late events", () => {
  it("folds a late-but-in-window event into its event-time bucket", async () => {
    const event = makeEvent("evt_late", "requests", 900, T0);
    await applyEvents(env, [pending(event, T0 + 40 * HOUR)], WINDOW, Date.now());

    const buckets = await bucketsOf();
    expect(buckets).toHaveLength(1);
    expect(buckets[0].hour_start).toBe(T0);   // its own hour, two days ago
    expect(buckets[0].quantity).toBe(900);
    expect(await adjustments()).toHaveLength(0);
  });

  it("routes an event that arrives past the lateness window to adjustments", async () => {
    const event = makeEvent("evt_stale", "requests", 900, T0);
    await applyEvents(env, [pending(event, T0 + 100 * HOUR)], WINDOW, Date.now());

    expect(await bucketsOf()).toHaveLength(0);
    const rows = await adjustments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: "evt_stale", reason: "beyond_lateness_window", period: "2026-09" });
  });

  it("judges lateness by queue arrival time, not by when the retry happens to run", async () => {
    // Same message, reprocessed ten days later after three retries. `now` moves; the verdict
    // must not, or a redelivery would silently land in a different table.
    const event = makeEvent("evt_retry", "requests", 100, T0);
    const arrival = T0 + HOUR;
    await applyEvents(env, [pending(event, arrival)], WINDOW, T0 + 240 * HOUR);
    expect(await bucketsOf()).toHaveLength(1);
    expect(await adjustments()).toHaveLength(0);
  });

  it("is a pure decision, testable without touching storage", () => {
    const p = pending(makeEvent("e", "requests", 1, T0), T0 + 10 * HOUR);
    expect(classify(p, null, WINDOW)).toEqual({ kind: "bucket" });
    expect(classify(p, { status: "open", closed_at: null }, WINDOW)).toEqual({ kind: "bucket" });
    expect(classify(p, { status: "closed", closed_at: T0 }, WINDOW)).toEqual({
      kind: "adjustment", reason: "period_closed",
    });
    expect(classify(p, null, 1 * HOUR)).toEqual({ kind: "adjustment", reason: "beyond_lateness_window" });
  });
});

describe("events arriving after a period is closed", () => {
  it("records an adjustment and leaves the closed invoice alone", async () => {
    await applyEvents(env, [pending(makeEvent("evt_a", "gb_egress", 100, T0))], WINDOW, Date.now());
    const { invoice } = await closePeriod(env, ACCOUNT, "2026-09", "tester", Date.now());
    expect(invoice.status).toBe("closed");
    expect(invoice.subtotal_cents).toBe(810); // (100 - 10 free) * 9c

    // A perfectly timely event that lost a race with the close.
    await applyEvents(env, [pending(makeEvent("evt_b", "gb_egress", 50, T0 + HOUR))], WINDOW, Date.now());

    const rows = await adjustments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: "evt_b", reason: "period_closed", quantity: 50 });

    const after = await getInvoice(env, ACCOUNT, "2026-09");
    expect(after.subtotal_cents).toBe(810);           // the issued number did not move
    expect(after.adjustments.events).toHaveLength(1);
    expect(after.adjustments.carry_forward_cents).toBe(450); // 50 GB at 9c, no free tier left
  });

  it("does not duplicate an adjustment when the message is redelivered", async () => {
    await applyEvents(env, [pending(makeEvent("evt_a", "gb_egress", 10, T0))], WINDOW, Date.now());
    await closePeriod(env, ACCOUNT, "2026-09", "tester", Date.now());

    const late = pending(makeEvent("evt_late_dup", "gb_egress", 7, T0));
    await applyEvents(env, [late], WINDOW, Date.now());
    await applyEvents(env, [late], WINDOW, Date.now());
    await applyEvents(env, [late], WINDOW, Date.now());

    expect(await adjustments()).toHaveLength(1);
  });
});

describe("redelivery across a close", () => {
  it("does not turn an already-bucketed event into a second, billable copy", async () => {
    // Queues are at-least-once, so this sequence is not hypothetical: the event is bucketed, the
    // period closes, and then the same message is redelivered.
    const event = pending(makeEvent("evt_redeliver", "gb_egress", 100, T0));
    await applyEvents(env, [event], WINDOW, Date.now());
    const { invoice } = await closePeriod(env, ACCOUNT, "2026-09", "tester", Date.now());
    expect(invoice.subtotal_cents).toBe(810);

    await applyEvents(env, [event], WINDOW, Date.now() + 60_000);
    await applyEvents(env, [event], WINDOW, Date.now() + 120_000);

    expect(await adjustments()).toHaveLength(0);          // not re-dispositioned
    const buckets = await bucketsOf();
    expect(buckets[0].quantity).toBe(100);                 // not re-counted
    const after = await getInvoice(env, ACCOUNT, "2026-09");
    expect(after.subtotal_cents).toBe(810);
    expect(after.adjustments.carry_forward_cents).toBe(0); // and not billed a second time
  });

  it("re-decides inside the transaction when a close lands between the read and the write", async () => {
    // Force the stale verdict the racing consumer would hold: classified as 'bucket' against a
    // period status read a moment before the close committed.
    await applyEvents(env, [pending(makeEvent("evt_seed", "gb_egress", 10, T0))], WINDOW, Date.now());
    await closePeriod(env, ACCOUNT, "2026-09", "tester", Date.now());

    const raced = pending(makeEvent("evt_raced", "gb_egress", 25, T0));
    await env.DB.batch(buildStatements(env, [{ ...raced, disposition: { kind: "bucket" } }], Date.now()));

    const inEvents = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_id = 'evt_raced'`).first<{ n: number }>();
    expect(inEvents!.n).toBe(0);                          // the stale verdict did not win
    const rows = await adjustments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: "evt_raced", reason: "period_closed" });
  });
});
