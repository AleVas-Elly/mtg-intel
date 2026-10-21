import { renderSVG } from "uqr";
import { useEffect, useState } from "preact/hooks";
import { post } from "../api";
import type { AppData } from "../data";
import { ago, day } from "../format";
import { go } from "../router";

type Theme = "auto" | "light" | "dark";

function applyTheme(t: Theme) {
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { t === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", t); } catch { /* fine */ }
}

export function Settings({ data }: { data: AppData }) {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) || "auto");
  const [devices, setDevices] = useState<{ id: string; device: string; created: string }[]>([]);
  const [invite, setInvite] = useState<{ url: string; expires: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetch("/api/auth/devices", { credentials: "same-origin" }).then((r) => r.ok ? r.json() : []).then(setDevices).catch(() => {}); }, []);
  const pick = (t: Theme) => {
    const doc = document as unknown as { startViewTransition?: (f: () => void) => void };
    doc.startViewTransition ? doc.startViewTransition(() => applyTheme(t)) : applyTheme(t);
    setTheme(t);
  };
  const add = async () => {
    setError(null);
    try { setInvite(await post("/api/auth/invite")); } catch (e) { setError((e as Error).message); }
  };
  const signOut = async () => {
    await post("/api/auth/logout").catch(() => {});
    try { localStorage.clear(); } catch { /* fine */ }
    go("/", null, true);
    location.reload();
  };
  return (
    <div class="page">
      <header class="head"><div><h1 class="title">Settings</h1></div></header>
      <div class="group-title">Appearance</div>
      <div class="group" style={{ padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <span>Theme</span>
        <div class="seg" role="group" aria-label="Theme">
          {(["auto", "light", "dark"] as Theme[]).map((t) => (
            <button type="button" aria-pressed={theme === t} onClick={() => pick(t)}>{t === "auto" ? "Automatic" : t === "light" ? "Light" : "Dark"}</button>
          ))}
        </div>
      </div>

      <div class="group-title">Devices with a passkey</div>
      <div class="group">
        {devices.map((d) => <div class="kv"><dt>{d.device}</dt><dd>added {day(d.created)}</dd></div>)}
        <div class="kv"><dt>Add another device</dt><dd><button class="btn" type="button" style={{ height: "32px", fontSize: "13.5px" }} onClick={add}>Show QR code</button></dd></div>
      </div>
      {invite && (
        <div class="group" style={{ padding: "16px", textAlign: "center" }}>
          <div class="qr" dangerouslySetInnerHTML={{ __html: renderSVG(invite.url, { border: 1 }) }} />
          <p style={{ fontSize: "14px" }}>Scan with the other device's camera, then create its passkey.</p>
          <p class="hint">Works once, for 15 minutes.</p>
        </div>
      )}
      {error && <p class="err">{error}</p>}

      <div class="group-title">Data</div>
      <dl class="group">
        <div class="kv"><dt>CardTrader check</dt><dd>{data.live ? ago(data.live.checked_at) : "–"}</dd></div>
        <div class="kv"><dt>Want-list and Cardmarket</dt><dd>{data.wants ? `built ${ago(data.wants.built_at)}` : "–"}</dd></div>
        <div class="kv"><dt>Cardmarket price day</dt><dd>{data.wants?.price_date ? day(data.wants.price_date) : "–"}</dd></div>
      </dl>
      <p class="hint">Card pictures and symbols: Scryfall. Prices: Cardmarket's public price guide, MTGJSON and CardTrader. Not affiliated with Wizards of the Coast.</p>
      <div style={{ marginTop: "24px" }}><button class="btn" type="button" onClick={signOut}>Sign out on this device</button></div>
    </div>
  );
}
