export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  PRICEBOOK: KVNamespace;
  EVENTS_Q: Queue<QueuedEvent>;
  ASSETS: Fetcher;
  LATENESS_WINDOW_HOURS: string;
  CLOCK_SKEW_TOLERANCE_MINUTES: string;
  MAX_BATCH_EVENTS: string;
  DEMO_MODE: string;
}

/** What a caller POSTs to /v1/events. */
export interface BillableEvent {
  event_id: string;
  account_id: string;
  meter: string;
  quantity: number;
  event_time: string;
}

/** A validated event on its way through the queue. Times are epoch ms from here on. */
export interface QueuedEvent {
  event_id: string;
  account_id: string;
  meter: string;
  quantity: number;
  event_time: number;
  hour_start: number;
  period: string;
}

export type Disposition =
  | { kind: "bucket" }
  | { kind: "adjustment"; reason: "period_closed" | "beyond_lateness_window" };

export interface Bucket {
  account_id: string;
  meter: string;
  hour_start: number;
  period: string;
  quantity: number;
  event_count: number;
}

export interface PriceBookMeter {
  display: string;
  /** Units given away per account per period before anything is billable. */
  free_units: number;
  /** Cents charged per `per_units` billable units. Integer cents only. */
  price_cents: number;
  per_units: number;
}

export interface PriceBook {
  version: string;
  description?: string;
  meters: Record<string, PriceBookMeter>;
}

export interface RatedLine {
  line_id: string;
  account_id: string;
  period: string;
  meter: string;
  quantity: number;
  free_units_applied: number;
  billable_units: number;
  price_cents: number;
  per_units: number;
  amount_cents: number;
  price_book_version: string;
}
