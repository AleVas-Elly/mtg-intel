// Settings › Notifications (spec D88): turn app notifications on for this device, send a test,
// and when they can't work, the one fix that applies (add to home screen, or allow them again).

import { useEffect, useState } from "preact/hooks";
import { currentEndpoint, isApple, type PushDevice, pushDevices, pushState, type PushState, type RingSettings, saveRings, sendTest, turnOff, turnOn } from "../notify";
import { toast } from "../toast";

export function HomeScreenGuide() {
  return (
    <ol class="steps">
      <li>Tap <b>Share</b> (the square with an arrow) in Safari's toolbar.</li>
      <li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
      <li>Open <b>mtg-intel</b> from your home screen and come back to Settings.</li>
    </ol>
  );
}

export function AllowAgainGuide() {
  return isApple() ? (
    <ol class="steps">
      <li>Open the iPhone's <b>Settings</b> app.</li>
      <li>Tap <b>Notifications</b>, then <b>mtg-intel</b>.</li>
      <li>Turn on <b>Allow Notifications</b>, then come back here and send a test.</li>
    </ol>
  ) : (
    <ol class="steps">
      <li>Open this site's settings in the browser (the icon left of the address).</li>
      <li>Set <b>Notifications</b> to <b>Allow</b>, then reload this page.</li>
    </ol>
  );
}

const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
const RING_CHOICES: { rank: RingSettings["ring"]; label: string }[] = [
  { rank: 3, label: "Steal" }, { rank: 2, label: "Great" }, { rank: 1, label: "Good" }, { rank: 0, label: "Target" },
];

/** What rings on this device (D88). Everything still lands on the Alerts page; this only decides the ping. */
function RingSettingsView({ value, onChange, busy }: { value: RingSettings; onChange: (r: RingSettings) => void; busy: boolean }) {
  const set = (patch: Partial<RingSettings>) => onChange({ ...value, ...patch });
  const kind = (k: keyof RingSettings["kinds"], label: string) => (
    <button type="button" class="chip toggle" aria-pressed={value.kinds[k]} disabled={busy} onClick={() => set({ kinds: { ...value.kinds, [k]: !value.kinds[k] } })}>{label}</button>
  );
  const hours = (field: "from" | "to") => (
    <select class="hour" aria-label={field === "from" ? "Quiet from" : "Quiet until"} value={value.quiet[field]} disabled={busy || !value.quiet.on}
      onChange={(e) => set({ quiet: { ...value.quiet, [field]: Number((e.target as HTMLSelectElement).value) } })}>
      {Array.from({ length: 24 }, (_, h) => <option value={h}>{hourLabel(h)}</option>)}
    </select>
  );
  return (
    <div class="rings">
      <div class="ring-row"><span>Rings for</span><div class="ring-opts">{kind("deals", "Deals")}{kind("digest", "Digest")}{kind("system", "Problems")}</div></div>
      {value.kinds.deals && (
        <div class="ring-row"><span>Smallest deal that rings</span>
          <div class="seg" role="group" aria-label="Smallest deal that rings">
            {RING_CHOICES.map((c) => <button type="button" aria-pressed={value.ring === c.rank} disabled={busy} onClick={() => set({ ring: c.rank })}>{c.label}</button>)}
          </div>
        </div>
      )}
      <div class="ring-row"><span>Quiet hours</span>
        <div class="ring-opts">
          <button type="button" class="chip toggle" aria-pressed={value.quiet.on} disabled={busy} onClick={() => set({ quiet: { ...value.quiet, on: !value.quiet.on } })}>{value.quiet.on ? "On" : "Off"}</button>
          {hours("from")}<span class="ring-to">to</span>{hours("to")}
        </div>
      </div>
      {value.quiet.on && value.kinds.deals && (
        <div class="ring-row"><span>Steals ring in quiet hours</span>
          <button type="button" class="chip toggle" aria-pressed={value.quiet.steals} disabled={busy} onClick={() => set({ quiet: { ...value.quiet, steals: !value.quiet.steals } })}>{value.quiet.steals ? "Yes" : "No"}</button>
        </div>
      )}
      <p class="hint ring-hint">Everything still lands on the Alerts page. In quiet hours alerts wait there without a ping: an iPhone can't receive a notification silently.</p>
    </div>
  );
}

export function NotificationsSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [here, setHere] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setState(await pushState());
    setHere(await currentEndpoint());
    pushDevices().then(setDevices).catch(() => {});
  };
  useEffect(() => {
    load();
    const again = () => document.visibilityState === "visible" && load(); // back from the phone's Settings
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);
  const act = async (job: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try { await job(); if (done) toast(done); } catch (e) { const m = (e as Error).message; if (m !== "denied") setError(m); }
    await load();
    setBusy(false);
  };
  const others = devices.filter((d) => d.endpoint !== here);
  const mine = devices.find((d) => d.endpoint === here);
  const changeRings = (r: RingSettings) => {
    setDevices((list) => list.map((d) => (d.endpoint === here ? { ...d, rings: r } : d))); // at once; the server confirms
    act(() => saveRings(r).then(setDevices));
  };
  return (
    <>
      <div class="group-title" id="notifications">Notifications</div>
      <div class="group">
        {state === "on" && (
          <div class="kv"><dt>This device</dt><dd style={{ display: "flex", gap: "8px", justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button class="btn sm" type="button" disabled={busy} onClick={() => act(sendTest, "Test sent. It should arrive in a few seconds.")}>Send a test</button>
            <button class="btn sm" type="button" disabled={busy} onClick={() => act(turnOff, "Notifications are off on this device.")}>Turn off</button>
          </dd></div>
        )}
        {state === "on" && mine && <RingSettingsView value={mine.rings} onChange={changeRings} busy={false} />}
        {state === "off" && (
          <div class="kv"><dt>This device<br /><small class="hint" style={{ margin: 0 }}>Deals, the digest and problems with the bot</small></dt><dd>
            <button class="btn sm" type="button" disabled={busy} onClick={() => act(turnOn, "Notifications are on. Send a test to check.")}>Turn on</button>
          </dd></div>
        )}
        {state === "install" && (
          <div style={{ padding: "12px 16px" }}>
            <p style={{ margin: "0 0 4px" }}>On iPhone, notifications work once mtg-intel is on your home screen:</p>
            <HomeScreenGuide />
          </div>
        )}
        {state === "denied" && (
          <div style={{ padding: "12px 16px" }}>
            <p style={{ margin: "0 0 4px" }}>Notifications are blocked on this device. To allow them again:</p>
            <AllowAgainGuide />
          </div>
        )}
        {state === "unsupported" && <div class="kv"><dt>This device</dt><dd>This browser can't get notifications</dd></div>}
        {others.map((d) => <div class="kv"><dt>{d.device}</dt><dd>On · {d.browser}</dd></div>)}
      </div>
      {error && <p class="err">{error}</p>}
    </>
  );
}
