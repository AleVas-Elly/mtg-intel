// On-time timer for the GitHub workflows (spec D48). GitHub's own schedule runs hours late or not
// at all; a workflow_dispatch call starts a run within seconds. The workflows keep their own
// schedules as a fallback.

const SCHEDULE = {
  "7,37 * * * *": ["deals.yml"], // deal check every 30 minutes
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
    for (const workflow of SCHEDULE[event.cron] || []) {
      const problem = await dispatch(env, workflow);
      if (problem) problems.push(problem);
    }
    if (problems.length) {
      // Most likely the GitHub token expired: make a new one and run `wrangler secret put GITHUB_TOKEN`.
      await telegram(env, `mtg-intel timer could not start a run\n\n${problems.join("\n")}`);
      throw new Error(problems.join("; "));
    }
  },

  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
