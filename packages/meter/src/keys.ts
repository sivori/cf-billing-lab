/**
 * Deterministic keys for every state-changing operation.
 *
 * The rule the whole system leans on: if an operation can be retried, its identity must be a
 * function of its inputs, never of the clock or a random source. Re-running then updates one
 * row instead of accumulating near-duplicates that a human has to tell apart later.
 */

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function ratedLineId(
  account: string,
  period: string,
  meter: string,
  version: string,
): Promise<string> {
  return sha256Hex(`line|${account}|${period}|${meter}|${version}`);
}

export function exceptionId(
  account: string,
  period: string,
  meter: string | null,
  hourStart: number | null,
  kind: string,
): Promise<string> {
  return sha256Hex(`exc|${account}|${period}|${meter ?? "-"}|${hourStart ?? "-"}|${kind}`);
}

/** R2 archive key. Partitioned by EVENT date, so reconciling a period is a list of day prefixes. */
export function archiveKey(day: string, account: string, eventId: string): string {
  return `raw/dt=${day}/${account}/${eventId}.json`;
}

export { sha256Hex };
