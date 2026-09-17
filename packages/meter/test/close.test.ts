import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { applyEvents } from "../src/aggregate";
import { closePeriod, getInvoice, InvoiceError } from "../src/invoice";
import * as pricebook from "../src/pricebook";
import { ACCOUNT, HOUR, makeEvent, pending, seedPriceBook } from "./helpers";

const WINDOW = 72 * HOUR;
const T0 = Date.UTC(2026, 8, 3, 10, 0, 0);

beforeEach(seedPriceBook);

const usage = () =>
  applyEvents(
    env,
    [
      pending(makeEvent("evt_1", "gb_egress", 60, T0)),
      pending(makeEvent("evt_2", "gb_egress", 60, T0 + HOUR)),
      pending(makeEvent("evt_3", "requests", 2_500_000, T0)),
    ],
    WINDOW,
    Date.now(),
  );

describe("closing a period", () => {
  it("rates, persists the lines, and stamps the price book version on each", async () => {
    await usage();
    const { invoice, already_closed } = await closePeriod(env, ACCOUNT, "2026-09", "ops@example.com", Date.now());

    expect(already_closed).toBe(false);
    expect(invoice.status).toBe("closed");
    expect(invoice.price_book_version).toBe("v1");
    expect(invoice.lines.every((l) => l.price_book_version === "v1")).toBe(true);
    // egress: (120 - 10) * 9c = 990. requests: (2.5M - 1M free) = 1.5M at 30c/M = 45c.
    expect(Object.fromEntries(invoice.lines.map((l) => [l.meter, l.amount_cents]))).toEqual({
      gb_egress: 990,
      requests: 45,
    });
    expect(invoice.subtotal_cents).toBe(1035);
    expect(invoice.closed_by).toBe("ops@example.com");
  });

  it("is idempotent: closing twice returns the first invoice and writes nothing new", async () => {
    await usage();
    const now = Date.now();
    const first = await closePeriod(env, ACCOUNT, "2026-09", "ops@example.com", now);
    const second = await closePeriod(env, ACCOUNT, "2026-09", "someone.else@example.com", now + 60_000);

    expect(second.already_closed).toBe(true);
    expect(second.invoice.subtotal_cents).toBe(first.invoice.subtotal_cents);
    expect(second.invoice.closed_by).toBe("ops@example.com"); // the first closer keeps the record
    expect(second.invoice.closed_at).toBe(first.invoice.closed_at);

    const lines = await env.DB.prepare(`SELECT COUNT(*) AS n FROM rated_lines`).first<{ n: number }>();
    expect(lines!.n).toBe(2);
    const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'period.close'`).first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });

  it("a later price book cannot restate a closed invoice", async () => {
    await usage();
    const { invoice } = await closePeriod(env, ACCOUNT, "2026-09", "ops@example.com", Date.now());
    expect(invoice.subtotal_cents).toBe(1035);

    await pricebook.publish(
      env,
      { version: "v2", meters: { gb_egress: { display: "Egress (GB)", free_units: 0, price_cents: 99, per_units: 1 },
                                 requests: { display: "API requests", free_units: 0, price_cents: 300, per_units: 1_000_000 },
                                 cpu_ms: { display: "Compute (CPU ms)", free_units: 0, price_cents: 2, per_units: 1_000_000 } } },
      true,
    );

    const after = await getInvoice(env, ACCOUNT, "2026-09");
    expect(after.price_book_version).toBe("v1");
    expect(after.subtotal_cents).toBe(1035);
  });

  it("refuses to close over usage the price book has no rate for", async () => {
    await usage();
    // Arrives by a path that bypasses ingest validation — a backfill, say, or a meter that was
    // dropped from the price book after the usage was collected.
    await applyEvents(env, [pending(makeEvent("evt_x", "gpu_seconds", 10, T0))], WINDOW, Date.now());

    await expect(closePeriod(env, ACCOUNT, "2026-09", "ops@example.com", Date.now())).rejects.toMatchObject({
      code: "unpriced_meters",
      status: 409,
    });
    const period = await env.DB.prepare(`SELECT status FROM periods WHERE account_id = ? AND period = '2026-09'`)
      .bind(ACCOUNT).first<{ status: string }>();
    expect(period!.status).toBe("open");
  });

  it("refuses to close a period that has unresolved exceptions", async () => {
    await usage();
    await env.DB.prepare(
      `INSERT INTO exceptions (exception_id, account_id, period, kind, detail, status, detected_at, last_seen_at)
       VALUES ('deadbeef', ?, '2026-09', 'bucket_mismatch', 'injected', 'open', ?, ?)`,
    ).bind(ACCOUNT, Date.now(), Date.now()).run();

    await expect(closePeriod(env, ACCOUNT, "2026-09", "ops@example.com", Date.now())).rejects.toMatchObject({
      code: "unresolved_exceptions",
    });
  });

  it("refuses to close a period that has not started", async () => {
    await expect(closePeriod(env, ACCOUNT, "2099-01", "ops@example.com", Date.now())).rejects.toBeInstanceOf(InvoiceError);
  });
});

describe("price book", () => {
  it("refuses to overwrite a published version", async () => {
    await expect(
      pricebook.publish(env, { version: "v1", meters: { requests: { display: "x", free_units: 0, price_cents: 1, per_units: 1 } } }, false),
    ).rejects.toMatchObject({ code: "version_exists", status: 409 });
  });

  it("refuses rates that are not non-negative integers", async () => {
    await expect(
      pricebook.publish(env, { version: "v9", meters: { requests: { display: "x", free_units: 0, price_cents: 0.5, per_units: 1 } } }, false),
    ).rejects.toMatchObject({ code: "invalid_rate" });
  });
});
