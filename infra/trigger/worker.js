// On-time timer for the GitHub workflows (spec D48). GitHub's own schedule runs hours late or not
// at all; a workflow_dispatch call starts a run within seconds. The workflows keep their own
// schedules as a fallback.

import { cardtrader, telegramUpdate } from "./telegram.ts";
import { fastLane } from "./fastlane.ts";

const SCHEDULE = {
  "2,7,12,17,22,27,32,37,42,47,52,57 * * * *": ["deals.yml"], // deal check every 5 minutes (D55)
  "17 2,8,14 * * *": ["grab.yml"], // data grab 3 times a day
  "* * * * *": [], // the fast lane: the cards closest to a deal, every minute (D58)
};

// GitHub's API answers 5xx now and then (a 502 on 2026-11-04): try again before calling it a problem.
const RETRY_WAITS_MS = [5000, 20000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function dispatch(env, workflow) {
  let problem = null;
  for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
    if (attempt) await sleep(RETRY_WAITS_MS[attempt - 1]);
    try {
      const response = await fetch(
        `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "mtg-intel-trigger",
          },
          body: JSON.stringify({ ref: "main" }),
        },
      );
      if (response.status === 204) return null;
      const text = (await response.text()).slice(0, 200);
      problem = `${workflow}: GitHub answered ${response.status} ${text}`;
      if (response.status < 500 && response.status !== 429) return problem; // e.g. 401: retrying won't help
    } catch (e) {
      problem = `${workflow}: could not reach GitHub (${e})`;
    }
  }
  return problem;
}

// Want-list edits made on the website (D50) wait in the site's D1 (D67). The site starts the
// `wantlist` run at once; a run that missed them is caught up on a deal-check tick once they are
// 3 minutes old. While the same edits stay waiting (a run failing, as on 2026-11-06, when one run
// every 5 minutes failed and mailed), the catch-up is tried at most every 30 minutes; a newer edit
// is caught up at once.
const EDITS_LATE_MS = 3 * 60 * 1000;
const CATCHUP_MS = 30 * 60 * 1000;

async function editsWaiting(env) {
  if (!env.DB) return false;
  try {
    const now = new Date();
    // A purchase from the Telegram button is held until `hold_until` so its Undo works (D53).
    const row = await env.DB.prepare(
      "SELECT MAX(name) AS newest FROM edits WHERE at < ? AND (hold_until IS NULL OR hold_until < ?)",
    ).bind(new Date(now.getTime() - EDITS_LATE_MS).toISOString(), now.toISOString()).first();
    if (!row?.newest) return false;
    const last = await env.DB.prepare("SELECT value FROM meta WHERE key = 'catchup'").first();
    const prev = last ? JSON.parse(last.value) : null;
    if (prev && prev.newest >= row.newest && now.getTime() - Date.parse(prev.at) < CATCHUP_MS) return false;
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('catchup', ?)")
      .bind(JSON.stringify({ at: now.toISOString(), newest: row.newest })).run();
    return true;
  } catch {
    return false; // never let the edit queue stop the deal check
  }
}

// Watchdog (D48): the deal check uploads `live` to the site after every run, and the site notes the
// time in D1. If that is old, something upstream broke (a crashing job, an expired token, GitHub not
// starting runs) even though every dispatch here succeeded. Checked once an hour; one message when
// it breaks, one when it is back, remembered in D1's `meta` (`watchdog`).
const STALE_MS = 45 * 60 * 1000;

async function watchdog(env) {
  if (!env.DB) return;
  const live = await env.DB.prepare("SELECT at FROM docs WHERE key = 'live'").first();
  const at = live && Date.parse(live.at);
  const stale = !at || Date.now() - at > STALE_MS;
  const known = await env.DB.prepare("SELECT value FROM meta WHERE key = 'watchdog'").first();
  if (stale && !known) {
    const since = at ? `${Math.round((Date.now() - at) / 60000)} minutes ago (${live.at})` : "never";
    await telegram(env, `mtg-intel deal checks have stopped\n\nLast finished check: ${since}.\nhttps://github.com/${env.GITHUB_REPO}/actions/workflows/deals.yml`);
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('watchdog', ?)").bind(new Date().toISOString()).run();
  } else if (!stale && known) {
    await telegram(env, `mtg-intel deal checks are running again (last check ${live.at}).`);
    await env.DB.prepare("DELETE FROM meta WHERE key = 'watchdog'").run();
  }
}

async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
  } catch {
    // nothing else to tell
  }
}

export default {
  async scheduled(event, env) {
    if (!env.GITHUB_TOKEN) return; // not set up yet
    if (event.cron === "* * * * *") {
      const found = await fastLane(env).catch(() => []);
      if (found.length) await dispatch(env, "deals.yml"); // a full check alerts it, the usual way
      return;
    }
    const problems = [];
    const workflows = [...(SCHEDULE[event.cron] || [])];
    if (workflows.includes("deals.yml") && (await editsWaiting(env))) workflows.push("wantlist.yml");
    for (const workflow of workflows) {
      const problem = await dispatch(env, workflow);
      if (problem) problems.push(problem);
    }
    if (workflows.includes("deals.yml") && new Date(event.scheduledTime).getUTCMinutes() === 7) {
      try {
        await watchdog(env);
      } catch (e) {
        problems.push(`watchdog: ${e}`);
      }
    }
    if (problems.length) {
      // A 401 means the GitHub token expired: make a new one and run `wrangler secret put GITHUB_TOKEN`.
      await telegram(env, `mtg-intel timer could not start a run (after ${RETRY_WAITS_MS.length + 1} tries)\n\n${problems.join("\n")}`);
      throw new Error(problems.join("; "));
    }
  },

  // No public URL: only the website Worker reaches this, through its service binding, right after
  // I edit the want-list there, and to pass on the bot's button taps (telegram.ts).
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/telegram") {
      return telegramUpdate(request, env, () => dispatch(env, "wantlist.yml"), () => dispatch(env, "deals.yml"));
    }
    // "Check CardTrader" on a card's pane (D83): the live copies of one card, asked for by hand.
    // The token stays here; the website only sees prices, conditions, languages and countries.
    if (request.method === "GET" && new URL(request.url).pathname === "/ct") {
      const bp = Number(new URL(request.url).searchParams.get("bp"));
      if (!Number.isInteger(bp) || bp <= 0) return new Response("Not valid", { status: 400 });
      if (!env.CARDTRADER_TOKEN) return new Response("No CardTrader token", { status: 503 });
      const answer = await cardtrader(env, "GET", `/marketplace/products?blueprint_id=${bp}`);
      if (!answer) return new Response("CardTrader didn't answer", { status: 502 });
      const copies = (answer[String(bp)] || []).filter((p) => {
        const props = p.properties_hash || {};
        return !p.graded && !p.on_vacation && !props.signed && !props.altered && p.price_currency === "EUR";
      }).map((p) => ({
        price: p.price_cents / 100, condition: p.properties_hash?.condition || "", language: p.properties_hash?.mtg_language || "",
        foil: !!p.properties_hash?.mtg_foil, zero: !!p.user?.can_sell_via_hub, country: p.user?.country_code || "", quantity: p.quantity || 1,
      })).sort((a, b) => a.price - b.price);
      return new Response(JSON.stringify({ checked_at: new Date().toISOString(), copies }), { headers: { "Content-Type": "application/json" } });
    }
    // A quiet note from the website (D78): someone joined, or suggested a card.
    if (request.method === "POST" && new URL(request.url).pathname === "/notify") {
      const { text } = await request.json().catch(() => ({}));
      if (typeof text !== "string" || !text || text.length > 600) return new Response("Not valid", { status: 400 });
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return new Response("No bot", { status: 503 });
      const sent = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_notification: true }),
      }).catch(() => null);
      return new Response(sent?.ok ? "sent" : "failed", { status: sent?.ok ? 200 : 502 });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/wantlist" || !env.GITHUB_TOKEN) {
      return new Response("Not found", { status: 404 });
    }
    const problem = await dispatch(env, "wantlist.yml");
    return new Response(problem || "started", { status: problem ? 502 : 202 });
  },
};
