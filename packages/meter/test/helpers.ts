import { env } from "cloudflare:test";
import type { PendingEvent } from "../src/aggregate";
import type { QueuedEvent } from "../src/types";
import { hourStart, periodOf } from "../src/time";
import * as pricebook from "../src/pricebook";

export const ACCOUNT = "acct_demo";
export const HOUR = 3_600_000;

export async function seedPriceBook() {
  await pricebook.seedIfEmpty(env);
}

export function makeEvent(
  event_id: string,
  meter: string,
  quantity: number,
  event_time: number,
): QueuedEvent {
  return {
    event_id,
    account_id: ACCOUNT,
    meter,
    quantity,
    event_time,
    hour_start: hourStart(event_time),
    period: periodOf(event_time),
  };
}

export function pending(event: QueuedEvent, arrival_time = event.event_time + 1000): PendingEvent {
  return { event, arrival_time };
}

export async function bucketsOf(account = ACCOUNT) {
  const { results } = await env.DB.prepare(
    `SELECT meter, hour_start, quantity, event_count FROM buckets WHERE account_id = ? ORDER BY meter, hour_start`,
  )
    .bind(account)
    .all();
  return results ?? [];
}

/** Deterministic shuffle so a failure is reproducible rather than "flaky on Tuesdays". */
export function shuffle<T>(items: T[], seed = 7): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
