// Self-check for rings.ts (spec D88). Run: npm run check:rings
import { cleanRings, DEFAULT_RINGS as D, rings, snoozed } from "./rings";

const at = (h: number) => new Date(Date.UTC(2026, 10, 16, h - 1)); // Amsterdam is UTC+1 in November
const eq = (got: unknown, want: unknown, what: string) => { if (got !== want) throw new Error(`${what}: got ${got}, want ${want}`); };

// the old Telegram rules, by default
eq(rings(D, "deals", 3, at(3)), true, "a Steal rings at night");
eq(rings(D, "deals", 2, at(3)), false, "a Great deal waits at night");
eq(rings(D, "deals", 2, at(14)), true, "a Great deal rings by day");
eq(rings(D, "deals", 1, at(14)), false, "a Good deal waits");
eq(rings(D, "digest", 0, at(14)), false, "the digest waits");
eq(rings(D, "system", 0, at(14)), true, "a problem rings by day");
eq(rings(D, "system", 0, at(23)), false, "a problem waits for the morning");
eq(rings(D, "deals", 2, at(8)), true, "quiet hours end at 8");
// a device's own choices
const all = cleanRings({ ...D, ring: 0, quiet: { on: false, from: 23, to: 8, steals: true } });
eq(rings(all, "deals", 0, at(3)), true, "everything, any time");
const day = cleanRings({ ...D, quiet: { on: true, from: 9, to: 17, steals: false } });
eq(rings(day, "deals", 3, at(10)), false, "daytime quiet hours hold even Steals");
eq(rings(day, "deals", 3, at(18)), true, "after the quiet hours");
// bad input falls back to the defaults
const odd = cleanRings({ ring: 7, tz: "Mars/Olympus", quiet: { from: 30 }, kinds: { digest: true } });
eq(odd.ring, 2, "ring"); eq(odd.tz, "Europe/Amsterdam", "tz"); eq(odd.quiet.from, 23, "from"); eq(odd.kinds.digest, true, "kinds");
// snoozes
const t0 = Date.parse("2026-11-16T12:00:00Z");
const week = { card: "c", name: "x", until: "2026-11-23T12:00:00Z", below: null };
eq(snoozed(week, 10, t0), true, "quiet for a week"); eq(snoozed(week, 10, Date.parse("2026-11-24T00:00:00Z")), false, "the week is over");
const under = { card: "c", name: "x", until: null, below: 15 };
eq(snoozed(under, 16, t0), true, "not under the price"); eq(snoozed(under, 14.99, t0), false, "under the price rings");
eq(snoozed(null, 1, t0), false, "no snooze");
console.log("rings self-check ok");
