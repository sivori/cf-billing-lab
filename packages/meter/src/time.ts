/** Time helpers. Everything internal is epoch ms in UTC; periods are UTC calendar months. */

export const HOUR_MS = 3_600_000;

export function hourStart(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS) * HOUR_MS;
}

/** YYYY-MM in UTC. The billing period a timestamp belongs to. */
export function periodOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 7);
}

/** YYYY-MM-DD in UTC. The R2 archive partition a timestamp belongs to. */
export function dayOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** Every UTC date inside a YYYY-MM period, as YYYY-MM-DD. */
export function daysInPeriod(period: string): string[] {
  const [y, m] = period.split("-").map(Number);
  const days: string[] = [];
  const cursor = new Date(Date.UTC(y, m - 1, 1));
  while (cursor.getUTCMonth() === m - 1) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function isValidPeriod(period: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return false;
  return true;
}
