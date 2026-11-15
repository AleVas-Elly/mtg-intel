// Which pings ring on a device (spec D88): its own settings, chosen in Settings › Notifications.
// The defaults are the rules the Telegram bot had: Steals always ring, Great deals by day, Good
// deals and target prices wait on the Alerts page, the digest never rings, problems do.

export type Kind = "deals" | "digest" | "system";
/** 3 Steal, 2 Great deal, 1 Good deal, 0 target price. */
export type Rank = 0 | 1 | 2 | 3;

export interface RingSettings {
  kinds: Record<Kind, boolean>;
  ring: Rank; // the smallest deal that rings
  quiet: { on: boolean; from: number; to: number; steals: boolean }; // hours in `tz`; Steals may still ring
  tz: string;
}

export const DEFAULT_RINGS: RingSettings = {
  kinds: { deals: true, digest: false, system: true },
  ring: 2,
  quiet: { on: true, from: 23, to: 8, steals: true },
  tz: "Europe/Amsterdam",
};

/** Settings from the app, checked field by field (anything odd falls back to the default). */
export function cleanRings(x: unknown): RingSettings {
  const v = (x ?? {}) as Partial<RingSettings>;
  const d = DEFAULT_RINGS;
  const hour = (n: unknown, def: number) => (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 23 ? (n as number) : def);
  let tz = d.tz;
  try { if (typeof v.tz === "string" && v.tz.length < 60) { new Intl.DateTimeFormat("en", { timeZone: v.tz }); tz = v.tz; } } catch { /* default */ }
  return {
    kinds: { deals: v.kinds?.deals ?? d.kinds.deals, digest: v.kinds?.digest ?? d.kinds.digest, system: v.kinds?.system ?? d.kinds.system },
    ring: ([0, 1, 2, 3] as const).includes(v.ring as Rank) ? (v.ring as Rank) : d.ring,
    quiet: { on: typeof v.quiet?.on === "boolean" ? v.quiet.on : d.quiet.on, from: hour(v.quiet?.from, d.quiet.from),
      to: hour(v.quiet?.to, d.quiet.to), steals: typeof v.quiet?.steals === "boolean" ? v.quiet.steals : d.quiet.steals },
    tz,
  };
}

export function quietNow(s: RingSettings, now: Date): boolean {
  if (!s.quiet.on || s.quiet.from === s.quiet.to) return false;
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: s.tz, hour: "numeric", hourCycle: "h23" }).format(now));
  return s.quiet.from < s.quiet.to ? h >= s.quiet.from && h < s.quiet.to : h >= s.quiet.from || h < s.quiet.to;
}

/** Whether this alert rings on a device with these settings. A silent "no" still leaves it on the page. */
export function rings(s: RingSettings, kind: Kind, rank: Rank, now: Date): boolean {
  if (!s.kinds[kind]) return false;
  if (kind === "deals" && rank < s.ring) return false;
  if (quietNow(s, now)) return kind === "deals" && rank === 3 && s.quiet.steals;
  return true;
}

/** A snoozed card (D88): its deal alerts don't ring until `until`, or ring only below `below` (EUR). */
export interface Snooze { card: string; name: string; until: string | null; below: number | null }

/** Whether a snooze keeps this deal quiet: within its days, and (if it has a price) not under it. */
export function snoozed(z: Snooze | null, price: number | undefined, now = Date.now()): boolean {
  if (!z || (z.until && Date.parse(z.until) <= now)) return false;
  return z.below == null || price == null || price >= z.below;
}
