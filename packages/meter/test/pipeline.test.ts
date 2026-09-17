import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { applyEvents } from "../src/aggregate";
import { ACCOUNT, HOUR, bucketsOf, makeEvent, pending, seedPriceBook, shuffle } from "./helpers";

const WINDOW = 72 * HOUR;
const T0 = Date.UTC(2026, 8, 3, 10, 17, 0); // 2026-09-03T10:17:00Z

beforeEach(seedPriceBook);

describe("aggregation", () => {
  it("buckets by event time, not arrival time", async () => {
    // Happened at 10:17, arrived four hours later. It belongs to the 10:00 hour regardless.
    const event = makeEvent("evt_1", "requests", 500, T0);
    await applyEvents(env, [pending(event, T0 + 4 * HOUR)], WINDOW, Date.now());

    const buckets = await bucketsOf();
    expect(buckets).toHaveLength(1);
    expect(buckets[0].hour_start).toBe(Date.UTC(2026, 8, 3, 10, 0, 0));
    expect(buckets[0].quantity).toBe(500);
  });

  it("replaying the same batch changes nothing", async () => {
    const batch = Array.from({ length: 20 }, (_, i) =>
      pending(makeEvent(`evt_${i}`, i % 2 ? "requests" : "gb_egress", 100 + i, T0 + (i % 5) * HOUR)),
    );

    await applyEvents(env, batch, WINDOW, Date.now());
    const first = await bucketsOf();

    // Replay twice more — a queue redelivery, and an operator re-running a backfill.
    await applyEvents(env, batch, WINDOW, Date.now() + 1000);
    await applyEvents(env, batch, WINDOW, Date.now() + 2000);
    const afterReplay = await bucketsOf();

    expect(afterReplay.map((b) => [b.meter, b.hour_start, b.quantity, b.event_count]))
      .toEqual(first.map((b) => [b.meter, b.hour_start, b.quantity, b.event_count]));

    const { count } = (await env.DB.prepare(`SELECT COUNT(*) AS count FROM events`).first<{ count: number }>())!;
    expect(count).toBe(20);

    // The archive is keyed by event_id too: 20 events, 20 objects, however many times replayed.
    const listing = await env.ARCHIVE.list({ prefix: "raw/", limit: 1000 });
    expect(listing.objects).toHaveLength(20);
  });

  it("is order-independent: the same events in any order give the same buckets", async () => {
    const spec = Array.from({ length: 24 }, (_, i) => ({
      meter: i % 3 === 0 ? "cpu_ms" : "requests",
      quantity: 1000 + i * 7,
      time: T0 + (i % 6) * HOUR,
    }));

    // Account A: shuffled, one event per batch (worst case for an incremental aggregator).
    for (const s of shuffle(spec.map((s, i) => ({ ...s, id: `a_${i}` })))) {
      await applyEvents(env, [pending(makeEvent(s.id, s.meter, s.quantity, s.time))], WINDOW, Date.now());
    }
    // Account B: reverse order, all at once.
    const reversed = [...spec].reverse().map((s, i) => ({ ...s, id: `b_${i}` }));
    await applyEvents(
      env,
      reversed.map((s) => {
        const e = makeEvent(s.id, s.meter, s.quantity, s.time);
        return pending({ ...e, account_id: "acct_other" });
      }),
      WINDOW,
      Date.now(),
    );

    const a = (await bucketsOf(ACCOUNT)).map((b) => [b.meter, b.hour_start, b.quantity]);
    const b = (await bucketsOf("acct_other")).map((x) => [x.meter, x.hour_start, x.quantity]);
    expect(b).toEqual(a);
  });

  it("archives every event under its event date, whatever the disposition", async () => {
    await applyEvents(
      env,
      [pending(makeEvent("evt_archived", "requests", 42, T0))],
      WINDOW,
      Date.now(),
    );
    const object = await env.ARCHIVE.get(`raw/dt=2026-09-03/${ACCOUNT}/evt_archived.json`);
    expect(object).not.toBeNull();
    const body = await object!.json<{ quantity: number; arrival_time: number }>();
    expect(body.quantity).toBe(42);
    expect(object!.customMetadata).toMatchObject({ a: ACCOUNT, m: "requests", q: "42" });
  });
});

describe("ingest validation", () => {
  const post = (body: unknown) =>
    SELF.fetch("https://meter.test/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("accepts a well-formed event", async () => {
    const res = await post({
      event_id: "evt_ok",
      account_id: ACCOUNT,
      meter: "requests",
      quantity: 10,
      event_time: new Date(Date.now() - HOUR).toISOString(),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: ["evt_ok"], rejected: [] });
  });

  it("refuses usage for a meter that has no rate", async () => {
    const res = await post({
      event_id: "evt_bad_meter",
      account_id: ACCOUNT,
      meter: "not_in_price_book",
      quantity: 10,
      event_time: new Date().toISOString(),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ rejected: [{ code: "unknown_meter" }] });
  });

  it("refuses future-dated usage beyond the clock-skew tolerance", async () => {
    const res = await post({
      event_id: "evt_future",
      account_id: ACCOUNT,
      meter: "requests",
      quantity: 10,
      event_time: new Date(Date.now() + 25 * HOUR).toISOString(),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ rejected: [{ code: "event_time_in_future" }] });
  });

  it("accepts the good events in a mixed batch and names the bad ones", async () => {
    const res = await post({
      events: [
        { event_id: "evt_m1", account_id: ACCOUNT, meter: "requests", quantity: 5, event_time: new Date().toISOString() },
        { event_id: "evt_m2", account_id: ACCOUNT, meter: "requests", quantity: -5, event_time: new Date().toISOString() },
      ],
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      accepted: ["evt_m1"],
      rejected: [{ event_id: "evt_m2", code: "invalid_quantity" }],
    });
  });
});
