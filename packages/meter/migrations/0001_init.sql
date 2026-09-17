-- meter: usage metering and rating pipeline.
--
-- Shape of the thing: `events` is the deduplicated record of every event that was folded into
-- an aggregate. `buckets` is DERIVED from it — never incremented, always recomputed as a SUM.
-- That is what makes aggregation idempotent and order-independent for free: replaying an
-- event_id inserts nothing, so the SUM is unchanged, and a reordered batch produces the same SUM.

-- Deduplicated events that were accepted into an event-time bucket.
CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,           -- caller-supplied idempotency key
  account_id    TEXT NOT NULL,
  meter         TEXT NOT NULL,
  quantity      INTEGER NOT NULL,           -- whole units, >= 0
  event_time    INTEGER NOT NULL,           -- epoch ms, as reported by the caller
  hour_start    INTEGER NOT NULL,           -- event_time floored to the UTC hour
  period        TEXT NOT NULL,              -- YYYY-MM of event_time (UTC)
  arrival_time  INTEGER NOT NULL,           -- epoch ms the event entered the queue (stable across retries)
  recorded_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_bucket ON events (account_id, meter, hour_start);
CREATE INDEX IF NOT EXISTS idx_events_period ON events (account_id, period);

-- Derived aggregates: one row per account per meter per UTC hour of EVENT time.
CREATE TABLE IF NOT EXISTS buckets (
  account_id  TEXT NOT NULL,
  meter       TEXT NOT NULL,
  hour_start  INTEGER NOT NULL,
  period      TEXT NOT NULL,
  quantity    INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, meter, hour_start)
);
CREATE INDEX IF NOT EXISTS idx_buckets_period ON buckets (account_id, period);

-- Billing periods. A period is a calendar month (UTC) per account. Closing is a one-way door:
-- there is no reopen path anywhere in the code. Corrections flow through `adjustments`.
CREATE TABLE IF NOT EXISTS periods (
  account_id          TEXT NOT NULL,
  period              TEXT NOT NULL,        -- YYYY-MM
  status              TEXT NOT NULL,        -- 'open' | 'closed'
  closed_at           INTEGER,
  closed_by           TEXT,
  price_book_version  TEXT,                 -- stamped at close; later price book edits cannot restate it
  lateness_window_ms  INTEGER,              -- the window in force when the period closed
  subtotal_cents      INTEGER,
  PRIMARY KEY (account_id, period)
);

-- Rated lines, persisted at close. One line per (account, period, meter).
CREATE TABLE IF NOT EXISTS rated_lines (
  line_id            TEXT PRIMARY KEY,      -- sha256(account|period|meter|price_book_version)
  account_id         TEXT NOT NULL,
  period             TEXT NOT NULL,
  meter              TEXT NOT NULL,
  quantity           INTEGER NOT NULL,
  free_units_applied INTEGER NOT NULL,
  billable_units     INTEGER NOT NULL,
  price_cents        INTEGER NOT NULL,      -- cents per `per_units` units
  per_units          INTEGER NOT NULL,
  amount_cents       INTEGER NOT NULL,
  price_book_version TEXT NOT NULL,
  rated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rated_period ON rated_lines (account_id, period);

-- Events that could not be folded into their event-time bucket: the period was already closed,
-- or they arrived outside the lateness window. They are recorded, never dropped, and never
-- mutate a closed period.
CREATE TABLE IF NOT EXISTS adjustments (
  event_id     TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  meter        TEXT NOT NULL,
  quantity     INTEGER NOT NULL,
  event_time   INTEGER NOT NULL,
  hour_start   INTEGER NOT NULL,
  period       TEXT NOT NULL,               -- the period the event BELONGS to, by event time
  arrival_time INTEGER NOT NULL,
  reason       TEXT NOT NULL,               -- 'period_closed' | 'beyond_lateness_window'
  recorded_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_adjustments_period ON adjustments (account_id, period);

-- Reconciliation findings. Keyed deterministically so re-running reconciliation updates the
-- same row instead of producing a new one. Nothing in this codebase sets status='resolved'
-- except an explicit human action on POST /admin/exceptions/:id/resolve.
CREATE TABLE IF NOT EXISTS exceptions (
  exception_id      TEXT PRIMARY KEY,       -- sha256(account|period|meter|hour_start|kind)
  account_id        TEXT NOT NULL,
  period            TEXT NOT NULL,
  meter             TEXT,
  hour_start        INTEGER,
  kind              TEXT NOT NULL,          -- 'bucket_mismatch' | 'missing_from_d1' | 'missing_from_archive'
  expected_quantity INTEGER,                -- recomputed from the R2 archive
  actual_quantity   INTEGER,                -- what D1 holds
  detail            TEXT,
  status            TEXT NOT NULL DEFAULT 'open',
  detected_at       INTEGER NOT NULL,
  last_seen_at      INTEGER NOT NULL,
  resolved_at       INTEGER,
  resolved_by       TEXT,
  resolution_note   TEXT
);
CREATE INDEX IF NOT EXISTS idx_exceptions_period ON exceptions (account_id, period, status);

-- History of reconciliation runs, for the UI and for "when did we last check?".
CREATE TABLE IF NOT EXISTS reconciliation_runs (
  run_id            TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  period            TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  objects_scanned   INTEGER,
  buckets_compared  INTEGER,
  exceptions_opened INTEGER,
  exceptions_seen   INTEGER,
  actor             TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_period ON reconciliation_runs (account_id, period, started_at);

-- Append-only audit trail. PROJECT 3 replaces the actor with the identity from the Access JWT;
-- the table is here from day one so the close and resolve paths never have to grow one later.
-- Append-only is enforced by there being no UPDATE or DELETE against this table in the codebase.
CREATE TABLE IF NOT EXISTS audit_log (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,            -- 'period.close' | 'exception.resolve' | 'pricebook.publish' | ...
  target          TEXT NOT NULL,
  detail          TEXT,
  idempotency_key TEXT UNIQUE               -- same key = same audited action, recorded once
);
