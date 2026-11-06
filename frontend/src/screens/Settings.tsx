import { renderSVG } from "uqr";
import { useEffect, useState } from "preact/hooks";
import { post, send } from "../api";
import type { AppData } from "../data";
import { ago, countryName, day } from "../format";
import { go } from "../router";
import { setLabOpen } from "../labstate";
import { Confirm } from "../ui/Confirm";
import { IconBack } from "../ui/icons";
import { toast } from "../toast";

interface Place { city?: string; country?: string }
interface Device {
  id: string; device: string; created: string; current: boolean;
  browser: string | null; app: string | null; place: Place | null;
  seen: { at: string; browser: string; place: Place } | null;
}

const where = (p: Place | null | undefined) => [p?.city, p?.country && countryName(p.country)].filter(Boolean).join(", ");
const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");

type Theme = "auto" | "light" | "dark";

function applyTheme(t: Theme) {
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try { t === "auto" ? localStorage.removeItem("theme") : localStorage.setItem("theme", t); } catch { /* fine */ }
}

export function Settings({ data }: { data: AppData }) {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) || "auto");
  const [devices, setDevices] = useState<Device[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Device | null>(null);
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
  const leave = () => {
    try { localStorage.clear(); } catch { /* fine */ }
    go("/", null, true);
    location.reload();
  };
  const signOut = async () => {
    await post("/api/auth/logout").catch(() => {});
    leave();
  };
  const remove = async (d: Device) => {
    setRemoving(null);
    try {
      const r = await send<{ devices: Device[]; signedOut: boolean }>("DELETE", `/api/auth/devices/${d.id}`);
      if (r.signedOut) return leave();
      setDevices(r.devices);
      setOpen(null);
      toast(`Removed ${d.device}. It can't sign in any more.`);
    } catch (e) { setError((e as Error).message); }
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

      <div class="group" style={{ padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginTop: "10px" }}>
        <span>Motion and layout<br /><small style={{ color: "var(--ink-2)", fontSize: "12.5px" }}>How lively the site moves, and rows or big pictures</small></span>
        <button class="btn sm" type="button" onClick={() => setLabOpen(true)}>Open</button>
      </div>

      <div class="group-title">Devices with a passkey</div>
      <div class="group">
        {devices.map((d) => {
          const shown = open === d.id;
          const last = d.current ? "This device" : d.seen ? `used ${ago(d.seen.at)}` : `added ${day(d.created)}`;
          return (
            <div class="dev">
              <button class="dev-row" type="button" aria-expanded={shown} onClick={() => setOpen(shown ? null : d.id)}>
                <span class="dev-name">{d.device}<small>{join(d.seen?.browser ?? d.browser, where(d.seen?.place ?? d.place))}</small></span>
                <span class="dev-last">{last}<IconBack class="dev-chev" /></span>
              </button>
              {shown && (
                <div class="dev-info">
                  <dl>
                    <div class="kv"><dt>Browser</dt><dd>{d.seen?.browser ?? d.browser ?? "Not known"}</dd></div>
                    {d.app && <div class="kv"><dt>Passkey kept in</dt><dd>{d.app}</dd></div>}
                    <div class="kv"><dt>Added</dt><dd>{join(day(d.created), where(d.place))}</dd></div>
                    <div class="kv"><dt>Last here</dt><dd>{d.seen ? join(ago(d.seen.at), where(d.seen.place)) : "Not recorded yet"}</dd></div>
                  </dl>
                  {devices.length > 1
                    ? <button class="dev-remove" type="button" onClick={() => setRemoving(d)}>{d.current ? "Remove this device" : `Remove ${d.device}`}</button>
                    : <p class="hint">Your only device with a passkey can't be removed. Add another one first.</p>}
                </div>
              )}
            </div>
          );
        })}
        <div class="kv"><dt>Add another device</dt><dd><button class="btn sm" type="button"  onClick={add}>Show QR code</button></dd></div>
      </div>
      {invite && (
        <div class="group" style={{ padding: "16px", textAlign: "center" }}>
          <div class="qr" dangerouslySetInnerHTML={{ __html: renderSVG(invite.url, { border: 1 }) }} />
          <p style={{ fontSize: "14px" }}>Scan with the other device's camera, then create its passkey.</p>
          <p class="hint">Works once, for 15 minutes.</p>
        </div>
      )}
      {error && <p class="err">{error}</p>}
      {removing && (
        <Confirm title={`Remove ${removing.device}?`} action="Remove" onCancel={() => setRemoving(null)} onConfirm={() => remove(removing)}
          text={removing.current
            ? "You'll be signed out here, and this device's passkey won't open mtg-intel again until you add it with a new QR code."
            : `It's signed out right away and its passkey won't open mtg-intel any more. To bring it back, add it again with a new QR code.`} />
      )}

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
