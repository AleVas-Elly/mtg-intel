// Settings › Notifications (spec D88): turn app notifications on for this device, send a test,
// and when they can't work, the one fix that applies (add to home screen, or allow them again).

import { useEffect, useState } from "preact/hooks";
import { currentEndpoint, isApple, type PushDevice, pushDevices, pushState, type PushState, sendTest, turnOff, turnOn } from "../notify";
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
