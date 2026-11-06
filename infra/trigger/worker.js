// On-time timer for the GitHub workflows (spec D48). GitHub's own schedule runs hours late or not
// at all; a workflow_dispatch call starts a run within seconds. The workflows keep their own
// schedules as a fallback.

import { telegramUpdate } from "./telegram.ts";
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

// Want-list edits made on the website (D50) wait in the site's KV; a run that missed them (KV is
// only eventually consistent across places) is caught up on the next 10-minute tick.
const EDITS_LATE_MS = 3 * 60 * 1000;

async function editsWaiting(env) {
  if (!env.DATA) return false;
  try {
    const listed = await env.DATA.list({ prefix: "edit:" });
    // A purchase from the Telegram button is held until `hold_until` so its Undo works (D53).
    return listed.keys.some((k) => Date.now() - Date.parse(k.name.slice(5, 29)) > EDITS_LATE_MS
      && !(k.metadata?.hold_until && Date.parse(k.metadata.hold_until) > Date.now()));
  } catch {
    return false; // never let the edit queue stop the deal check
  }
}

// Watchdog (D48): the deal check writes `live` to the site's KV after every run. If that is old,
// something upstream broke (a crashing job, an expired token, GitHub not starting runs) even though
// every dispatch here succeeded. Checked once an hour; one message when it breaks, one when it is
// back, remembered under WATCHDOG_KEY (the only key this Worker writes).
const STALE_MS = 45 * 60 * 1000;
const WATCHDOG_KEY = "watchdog";

async function watchdog(env) {
  if (!env.DATA) return;
  const live = await env.DATA.get("live", "json");
  const at = live && Date.parse(live.checked_at);
  const stale = !at || Date.now() - at > STALE_MS;
  const known = await env.DATA.get(WATCHDOG_KEY, "json");
  if (stale && !known) {
    const since = at ? `${Math.round((Date.now() - at) / 60000)} minutes ago (${live.checked_at})` : "never";
    await telegram(env, `mtg-intel deal checks have stopped\n\nLast finished check: ${since}.\nhttps://github.com/${env.GITHUB_REPO}/actions/workflows/deals.yml`);
    await env.DATA.put(WATCHDOG_KEY, JSON.stringify({ since: new Date().toISOString() }));
  } else if (!stale && known) {
    await telegram(env, `mtg-intel deal checks are running again (last check ${live.checked_at}).`);
    await env.DATA.delete(WATCHDOG_KEY);
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
    if (request.method !== "POST" || new URL(request.url).pathname !== "/wantlist" || !env.GITHUB_TOKEN) {
      return new Response("Not found", { status: 404 });
    }
    const problem = await dispatch(env, "wantlist.yml");
    return new Response(problem || "started", { status: problem ? 502 : 202 });
  },
};
