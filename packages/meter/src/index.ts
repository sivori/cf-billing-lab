import type { Env, QueuedEvent } from "./types";
import { fail, json, readJson } from "./http";
import { actorFor } from "./identity";
import { parseEventPayload, validateEvent, type RejectedEvent } from "./ingest";
import { applyEvents, type PendingEvent } from "./aggregate";
import { closePeriod, getInvoice, loadBuckets, InvoiceError } from "./invoice";
import { reconcile, resolveException } from "./reconcile";
import * as pricebook from "./pricebook";
import { PriceBookError } from "./pricebook";
import type { PriceBook } from "./types";
import { isValidPeriod } from "./time";

/**
 * Router and queue consumer.
 *
 * Read routes are public. Everything under /admin/* changes state, is keyed and audited, and is
 * what PROJECT 3 puts Cloudflare Access in front of. The split is in the path on purpose: a Zero
 * Trust policy is a prefix match, and a route layout that requires a regex to protect is a route
 * layout that will eventually be protected wrong.
 */

const latenessWindowMs = (env: Env) => Number(env.LATENESS_WINDOW_HOURS) * 3_600_000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const actor = actorFor(request);
    const now = Date.now();

    try {
      if (path === "/health") {
        return json({ ok: true, service: "meter", now, lateness_window_hours: Number(env.LATENESS_WINDOW_HOURS) });
      }

      // ---- Stage 1: collection ------------------------------------------------------------
      if (path === "/v1/events" && method === "POST") {
        const book = await pricebook.getCurrent(env);
        if (!book) return fail(409, "no_price_book", "no current price book is published; POST /admin/pricebook/seed");

        const payload = parseEventPayload(await readJson(request));
        if (!payload) return fail(422, "invalid_body", "expected an event, an array of events, or {events:[...]}");
        const max = Number(env.MAX_BATCH_EVENTS);
        if (payload.length > max) return fail(413, "batch_too_large", `at most ${max} events per request`);

        const ctxV = {
          now,
          skewToleranceMs: Number(env.CLOCK_SKEW_TOLERANCE_MINUTES) * 60_000,
          knownMeters: new Set(Object.keys(book.meters)),
        };

        const accepted: QueuedEvent[] = [];
        const rejected: RejectedEvent[] = [];
        for (const raw of payload) {
          const result = validateEvent(raw, ctxV);
          if (result.ok) accepted.push(result.event);
          else rejected.push(result.error);
        }

        if (accepted.length > 0) {
          await env.EVENTS_Q.sendBatch(accepted.map((body) => ({ body })));
        }
        // Partial acceptance is explicit: the caller is told exactly which event_ids were refused
        // and why, rather than having a 400 imply the whole batch was dropped.
        return json(
          { accepted: accepted.map((e) => e.event_id), rejected },
          accepted.length === 0 && rejected.length > 0 ? 422 : 202,
        );
      }

      // ---- Read surface (public) ----------------------------------------------------------
      const bucketsMatch = path.match(/^\/v1\/accounts\/([^/]+)\/buckets$/);
      if (bucketsMatch && method === "GET") {
        const period = url.searchParams.get("period");
        if (!period || !isValidPeriod(period)) return fail(422, "invalid_period", "?period=YYYY-MM is required");
        return json({ buckets: await loadBuckets(env, decodeURIComponent(bucketsMatch[1]), period) });
      }

      const invoiceMatch = path.match(/^\/v1\/accounts\/([^/]+)\/invoice$/);
      if (invoiceMatch && method === "GET") {
        const period = url.searchParams.get("period");
        if (!period || !isValidPeriod(period)) return fail(422, "invalid_period", "?period=YYYY-MM is required");
        return json(await getInvoice(env, decodeURIComponent(invoiceMatch[1]), period));
      }

      const periodsMatch = path.match(/^\/v1\/accounts\/([^/]+)\/periods$/);
      if (periodsMatch && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT period, status, closed_at, closed_by, price_book_version, subtotal_cents
             FROM periods WHERE account_id = ? ORDER BY period DESC`,
        )
          .bind(decodeURIComponent(periodsMatch[1]))
          .all();
        return json({ periods: results ?? [] });
      }

      const adjustmentsMatch = path.match(/^\/v1\/accounts\/([^/]+)\/adjustments$/);
      if (adjustmentsMatch && method === "GET") {
        const period = url.searchParams.get("period");
        if (!period || !isValidPeriod(period)) return fail(422, "invalid_period", "?period=YYYY-MM is required");
        const { results } = await env.DB.prepare(
          `SELECT event_id, meter, quantity, event_time, arrival_time, reason, recorded_at
             FROM adjustments WHERE account_id = ? AND period = ? ORDER BY recorded_at DESC LIMIT 200`,
        )
          .bind(decodeURIComponent(adjustmentsMatch[1]), period)
          .all();
        return json({ adjustments: results ?? [] });
      }

      const exceptionsMatch = path.match(/^\/v1\/accounts\/([^/]+)\/exceptions$/);
      if (exceptionsMatch && method === "GET") {
        const period = url.searchParams.get("period");
        const account = decodeURIComponent(exceptionsMatch[1]);
        const { results } = period
          ? await env.DB.prepare(
              `SELECT * FROM exceptions WHERE account_id = ? AND period = ? ORDER BY status, detected_at DESC LIMIT 200`,
            ).bind(account, period).all()
          : await env.DB.prepare(
              `SELECT * FROM exceptions WHERE account_id = ? ORDER BY status, detected_at DESC LIMIT 200`,
            ).bind(account).all();
        return json({ exceptions: results ?? [] });
      }

      const runsMatch = path.match(/^\/v1\/accounts\/([^/]+)\/reconciliation-runs$/);
      if (runsMatch && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT * FROM reconciliation_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT 20`,
        )
          .bind(decodeURIComponent(runsMatch[1]))
          .all();
        return json({ runs: results ?? [] });
      }

      if (path === "/v1/pricebook" && method === "GET") {
        const book = await pricebook.getCurrent(env);
        return book ? json(book) : fail(404, "no_price_book", "no current price book is published");
      }

      const pricebookVersionMatch = path.match(/^\/v1\/pricebook\/(v\d+)$/);
      if (pricebookVersionMatch && method === "GET") {
        const book = await pricebook.getVersion(env, pricebookVersionMatch[1]);
        return book ? json(book) : fail(404, "unknown_version", "no such price book version");
      }

      if (path === "/v1/audit" && method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT seq, ts, actor, action, target, detail FROM audit_log ORDER BY seq DESC LIMIT 100`,
        ).all();
        return json({ audit: results ?? [] });
      }

      // ---- Admin surface (state-changing; PROJECT 3 gates this prefix) ---------------------
      const closeMatch = path.match(/^\/admin\/periods\/([^/]+)\/([^/]+)\/close$/);
      if (closeMatch && method === "POST") {
        const result = await closePeriod(env, decodeURIComponent(closeMatch[1]), closeMatch[2], actor, now);
        return json({ already_closed: result.already_closed, invoice: result.invoice });
      }

      if (path === "/admin/reconcile" && method === "POST") {
        const body = (await readJson(request)) as { account_id?: string; period?: string; run_id?: string } | null;
        if (!body?.account_id || !body?.period || !isValidPeriod(body.period)) {
          return fail(422, "invalid_body", "expected {account_id, period: 'YYYY-MM'}");
        }
        // Keyed: pass the same run_id to retry a run without forking the history.
        const runId = body.run_id ?? crypto.randomUUID();
        return json(await reconcile(env, body.account_id, body.period, actor, now, runId));
      }

      const resolveMatch = path.match(/^\/admin\/exceptions\/([0-9a-f]{64})\/resolve$/);
      if (resolveMatch && method === "POST") {
        const body = (await readJson(request)) as { note?: string } | null;
        if (!body?.note || body.note.trim().length < 3) {
          return fail(422, "note_required", "a resolution note is required — an exception closed without one explains nothing");
        }
        const result = await resolveException(env, resolveMatch[1], actor, body.note.trim(), now);
        if (!result.resolved) return fail(404, "unknown_exception", "no such exception");
        return json({ exception_id: resolveMatch[1], resolved: true, already_resolved: result.already_resolved, resolved_by: actor });
      }

      if (path === "/admin/pricebook" && method === "PUT") {
        const body = (await readJson(request)) as { book?: PriceBook; make_current?: boolean } | null;
        if (!body?.book) return fail(422, "invalid_body", "expected {book: {...}, make_current?: boolean}");
        const published = await pricebook.publish(env, body.book, body.make_current !== false);
        return json({ published: published.version, current: body.make_current !== false });
      }

      if (path === "/admin/pricebook/current" && method === "POST") {
        const body = (await readJson(request)) as { version?: string } | null;
        if (!body?.version) return fail(422, "invalid_body", "expected {version: 'v2'}");
        return json({ current: await pricebook.setCurrent(env, body.version) });
      }

      if (path === "/admin/pricebook/seed" && method === "POST") {
        return json(await pricebook.seedIfEmpty(env));
      }

      // Demo-only: corrupt a bucket so reconciliation has something true to find. Gated by an env
      // var rather than by a comment asking people not to call it.
      if (path === "/admin/demo/drift" && method === "POST") {
        if (env.DEMO_MODE !== "true") return fail(404, "not_found", "not found");
        const body = (await readJson(request)) as { account_id?: string; period?: string; delta?: number } | null;
        if (!body?.account_id || !body?.period) return fail(422, "invalid_body", "expected {account_id, period, delta?}");
        const delta = Number.isInteger(body.delta) ? body.delta! : 5000;
        const target = await env.DB.prepare(
          `SELECT meter, hour_start, quantity FROM buckets WHERE account_id = ? AND period = ? ORDER BY hour_start DESC LIMIT 1`,
        )
          .bind(body.account_id, body.period)
          .first<{ meter: string; hour_start: number; quantity: number }>();
        if (!target) return fail(404, "no_buckets", "no buckets to drift for that account and period");
        await env.DB.prepare(
          `UPDATE buckets SET quantity = quantity + ? WHERE account_id = ? AND meter = ? AND hour_start = ?`,
        )
          .bind(delta, body.account_id, target.meter, target.hour_start)
          .run();
        return json({ drifted: { ...target, delta, new_quantity: target.quantity + delta } });
      }

      if (path.startsWith("/admin/") || path.startsWith("/v1/")) return fail(404, "not_found", "no such route");

      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof InvoiceError) return fail(err.status, err.code, err.message, err.detail);
      if (err instanceof PriceBookError) return fail(err.status, err.code, err.message);
      console.error("unhandled", err);
      return fail(500, "internal_error", err instanceof Error ? err.message : "unknown error");
    }
  },

  /**
   * Stage 2, the consumer. `message.timestamp` is the queue's own record of when the message was
   * written — stable across retries — so lateness is judged against a fact about the event, not
   * against whenever this retry happens to run.
   */
  async queue(batch: MessageBatch<QueuedEvent>, env: Env): Promise<void> {
    const pending: PendingEvent[] = batch.messages.map((m) => ({
      event: m.body,
      arrival_time: m.timestamp.getTime(),
    }));

    try {
      await applyEvents(env, pending, latenessWindowMs(env), Date.now());
      batch.ackAll();
    } catch (err) {
      // Retry the whole batch. Every write in it is keyed, so redelivery is a no-op where it
      // already landed — that is the entire reason the aggregate is derived rather than summed up.
      console.error("queue batch failed, retrying", err);
      batch.retryAll();
    }
  },
};
