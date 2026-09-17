import type { BillableEvent, QueuedEvent } from "./types";
import { hourStart, periodOf } from "./time";

/**
 * Ingest validation. Pure, so the rules are testable without a Worker, and strict, because the
 * cheapest place to reject a malformed billable event is before it reaches the ledger.
 */

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_QUANTITY = 1_000_000_000_000;

export interface RejectedEvent {
  event_id: string | null;
  code: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; event: QueuedEvent }
  | { ok: false; error: RejectedEvent };

export interface ValidationContext {
  now: number;
  skewToleranceMs: number;
  /** Meters that exist in the current price book. Usage we have no rate for is refused up front. */
  knownMeters: Set<string>;
}

export function validateEvent(raw: unknown, ctx: ValidationContext): ValidationResult {
  const e = raw as Partial<BillableEvent>;
  const reject = (code: string, message: string): ValidationResult => ({
    ok: false,
    error: { event_id: typeof e?.event_id === "string" ? e.event_id : null, code, message },
  });

  if (!e || typeof e !== "object") return reject("invalid_body", "event must be an object");
  if (typeof e.event_id !== "string" || !ID_RE.test(e.event_id)) {
    return reject("invalid_event_id", "event_id must be 1-128 chars of [A-Za-z0-9._:-]");
  }
  if (typeof e.account_id !== "string" || !ID_RE.test(e.account_id)) {
    return reject("invalid_account_id", "account_id must be 1-128 chars of [A-Za-z0-9._:-]");
  }
  if (typeof e.meter !== "string" || !ID_RE.test(e.meter)) {
    return reject("invalid_meter", "meter must be 1-128 chars of [A-Za-z0-9._:-]");
  }
  if (!ctx.knownMeters.has(e.meter)) {
    return reject("unknown_meter", `meter '${e.meter}' is not in the current price book`);
  }
  if (typeof e.quantity !== "number" || !Number.isInteger(e.quantity) || e.quantity < 0 || e.quantity > MAX_QUANTITY) {
    return reject("invalid_quantity", `quantity must be an integer between 0 and ${MAX_QUANTITY}`);
  }
  if (typeof e.event_time !== "string") {
    return reject("invalid_event_time", "event_time must be an ISO-8601 string");
  }
  const eventTime = Date.parse(e.event_time);
  if (Number.isNaN(eventTime)) {
    return reject("invalid_event_time", "event_time must be an ISO-8601 string");
  }
  // Future-dated usage is not "late", it is wrong — and it would land in a period that cannot be
  // closed yet. A small tolerance absorbs honest clock skew on the caller's side.
  if (eventTime > ctx.now + ctx.skewToleranceMs) {
    return reject("event_time_in_future", "event_time is further in the future than the clock skew tolerance");
  }

  return {
    ok: true,
    event: {
      event_id: e.event_id,
      account_id: e.account_id,
      meter: e.meter,
      quantity: e.quantity,
      event_time: eventTime,
      hour_start: hourStart(eventTime),
      period: periodOf(eventTime),
    },
  };
}

/** Accepts a single event, a bare array, or {events:[...]}. */
export function parseEventPayload(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const maybe = (body as { events?: unknown }).events;
    if (Array.isArray(maybe)) return maybe;
    return [body];
  }
  return null;
}
