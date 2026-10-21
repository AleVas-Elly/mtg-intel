// On-time timer for the GitHub workflows (spec D48). GitHub's own schedule runs hours late or not
// at all; a workflow_dispatch call starts a run within seconds. The workflows keep their own
// schedules as a fallback.

const SCHEDULE = {
  "7,17,27,37,47,57 * * * *": ["deals.yml"], // deal check every 10 minutes
  "17 2,8,14 * * *": ["grab.yml"], // data grab 3 times a day
};

async function dispatch(env, workflow) {
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
  return response.status === 204 ? null : `${workflow}: GitHub answered ${response.status} ${await response.text()}`;
}

// Want-list edits made on the website (D50) wait in the site's KV; a run that missed them (KV is
// only eventually consistent across places) is caught up on the next 10-minute tick.
const EDITS_LATE_MS = 3 * 60 * 1000;

async function editsWaiting(env) {
  if (!env.DATA) return false;
  const listed = await env.DATA.list({ prefix: "edit:" });
  return listed.keys.some((k) => Date.now() - Date.parse(k.name.slice(5, 29)) > EDITS_LATE_MS);
}

async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  });
}

export default {
  async scheduled(event, env) {
    if (!env.GITHUB_TOKEN) return; // not set up yet
    const problems = [];
    const workflows = [...(SCHEDULE[event.cron] || [])];
    if (workflows.includes("deals.yml") && (await editsWaiting(env))) workflows.push("wantlist.yml");
    for (const workflow of workflows) {
      const problem = await dispatch(env, workflow);
      if (problem) problems.push(problem);
    }
    if (problems.length) {
      // Most likely the GitHub token expired: make a new one and run `wrangler secret put GITHUB_TOKEN`.
      await telegram(env, `mtg-intel timer could not start a run\n\n${problems.join("\n")}`);
      throw new Error(problems.join("; "));
    }
  },

  // No public URL: only the website Worker reaches this, through its service binding, right after
  // I edit the want-list there.
  async fetch(request, env) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/wantlist" || !env.GITHUB_TOKEN) {
      return new Response("Not found", { status: 404 });
    }
    const problem = await dispatch(env, "wantlist.yml");
    return new Response(problem || "started", { status: problem ? 502 : 202 });
  },
};
