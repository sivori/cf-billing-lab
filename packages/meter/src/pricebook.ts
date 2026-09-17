import type { Env, PriceBook } from "./types";

/**
 * The price book lives in KV, versioned and immutable.
 *
 * `pricebook:v<N>` is written once and never updated — publishing a change means publishing a new
 * version and moving the `pricebook:current` pointer. A closed period stamps the version it was
 * rated at, so a price change next week cannot silently restate last month's invoice.
 */

const CURRENT_KEY = "pricebook:current";
const versionKey = (version: string) => `pricebook:${version}`;

export const DEFAULT_PRICE_BOOK: PriceBook = {
  version: "v1",
  description: "Seed rate card",
  meters: {
    requests: { display: "API requests", free_units: 1_000_000, price_cents: 30, per_units: 1_000_000 },
    gb_egress: { display: "Egress (GB)", free_units: 10, price_cents: 9, per_units: 1 },
    cpu_ms: { display: "Compute (CPU ms)", free_units: 5_000_000, price_cents: 2, per_units: 1_000_000 },
  },
};

export class PriceBookError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export async function getVersion(env: Env, version: string): Promise<PriceBook | null> {
  return env.PRICEBOOK.get<PriceBook>(versionKey(version), "json");
}

export async function currentVersion(env: Env): Promise<string | null> {
  return env.PRICEBOOK.get(CURRENT_KEY, "text");
}

export async function getCurrent(env: Env): Promise<PriceBook | null> {
  const version = await currentVersion(env);
  if (!version) return null;
  return getVersion(env, version);
}

function validate(book: PriceBook): void {
  if (!book || typeof book.version !== "string" || !/^v\d+$/.test(book.version)) {
    throw new PriceBookError("version must look like v1, v2, ...", 422, "invalid_version");
  }
  if (!book.meters || typeof book.meters !== "object" || Object.keys(book.meters).length === 0) {
    throw new PriceBookError("price book must define at least one meter", 422, "empty_price_book");
  }
  for (const [name, rate] of Object.entries(book.meters)) {
    const ints = [rate?.free_units, rate?.price_cents, rate?.per_units];
    if (!ints.every((n) => Number.isInteger(n) && (n as number) >= 0)) {
      throw new PriceBookError(`meter ${name}: free_units, price_cents, per_units must be non-negative integers`, 422, "invalid_rate");
    }
    if (rate.per_units <= 0) {
      throw new PriceBookError(`meter ${name}: per_units must be > 0`, 422, "invalid_rate");
    }
  }
}

/**
 * Publish a new version. Refuses to overwrite an existing one — the immutability guarantee is
 * enforced here, in code, not by asking people nicely to bump the number.
 */
export async function publish(env: Env, book: PriceBook, makeCurrent: boolean): Promise<PriceBook> {
  validate(book);
  const existing = await getVersion(env, book.version);
  if (existing) {
    throw new PriceBookError(`price book ${book.version} already exists and is immutable`, 409, "version_exists");
  }
  await env.PRICEBOOK.put(versionKey(book.version), JSON.stringify(book));
  if (makeCurrent) await env.PRICEBOOK.put(CURRENT_KEY, book.version);
  return book;
}

export async function setCurrent(env: Env, version: string): Promise<string> {
  const book = await getVersion(env, version);
  if (!book) throw new PriceBookError(`price book ${version} does not exist`, 404, "unknown_version");
  await env.PRICEBOOK.put(CURRENT_KEY, version);
  return version;
}

/** Idempotent seed so a fresh deployment has a rate card without a manual step. */
export async function seedIfEmpty(env: Env): Promise<{ seeded: boolean; version: string }> {
  const version = await currentVersion(env);
  if (version) return { seeded: false, version };
  await publish(env, DEFAULT_PRICE_BOOK, true);
  return { seeded: true, version: DEFAULT_PRICE_BOOK.version };
}
