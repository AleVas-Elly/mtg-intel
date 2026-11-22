// CardTrader calls from the timer Worker (D58, D83) and the health of its token (D85). The token
// lives only here.

export interface TimerEnv {
  DATA: KVNamespace;
  DB: D1Database; // the site's edit queue (D67) and the fast-lane list
  CARDTRADER_TOKEN?: string; // the fast lane (D58) and Check CardTrader (D83)
  SITE?: { alert(a: { section: string; title: string; body?: string; ping?: boolean }): Promise<unknown> }; // the site's Notify entrypoint (D88)
}

// --- CardTrader, for the fast lane (D58) ------------------------------------------------------------

const CT_API = "https://api.cardtrader.com/api/v2";
export async function cardtrader(env: TimerEnv, method: string, path: string, body?: unknown): Promise<any> {
  try {
    const r = await fetch(`${CT_API}${path}`, {
      method, headers: { Authorization: `Bearer ${env.CARDTRADER_TOKEN}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await ctTokenAnswer(env, r.status);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// --- the CardTrader token's health (D85) -------------------------------------------------------------
// An expired token failed silently for days (2026-11-07: the fast lane and Check CardTrader got 401s).
// Now a refusal sends one warning to the Alerts page, repeated at most once a day while it lasts, and the first
// answer accepted after it says the token works again. The state is one row in D1 `meta`.

const TOKEN_WARN_MS = 24 * 3600e3;
let tokenRefused: boolean | null = null; // what this isolate last saw, so a healthy minute costs no D1 read

/** Tell the token's health from a CardTrader answer's status. */
export async function ctTokenAnswer(env: TimerEnv, status: number): Promise<void> {
  const refused = status === 401 || status === 403;
  if (!refused && tokenRefused === false) return;
  try {
    const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'ct_token_refused'").first<{ value: string }>();
    if (refused) {
      tokenRefused = true;
      if (row && Date.now() - Date.parse(row.value) < TOKEN_WARN_MS) return;
      await notifyMe(env, `⚠️ CardTrader refuses the timer's token (${status}). The fast lane and Check CardTrader on the site are off until it's replaced:\n\ncd infra/trigger && npx --prefix ../../frontend wrangler secret put CARDTRADER_TOKEN\n\n(The deal checks on GitHub use their own copy of the token.)`);
      await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ct_token_refused', ?)").bind(new Date().toISOString()).run();
    } else if (status >= 200 && status < 300) {
      tokenRefused = false;
      if (!row) return;
      await env.DB.prepare("DELETE FROM meta WHERE key = 'ct_token_refused'").run();
      await notifyMe(env, "✅ CardTrader accepts the timer's token again: the fast lane and Check CardTrader work.");
    }
  } catch {
    // D1 or the site down: the next answer tries again
  }
}

async function notifyMe(env: TimerEnv, text: string): Promise<void> {
  const [title, ...rest] = text.split(". "); // a system alert on the Alerts page, with a ping (D88)
  await env.SITE?.alert({ section: "system", title, body: rest.join(". "), ping: true }).catch((e) => console.log(`alert to the site failed: ${e}`));
}
