// Sign-in with a passkey (spec D49). A new device joins through a one-time setup link: made by
// Claude for the first device, or shown as a QR code in Settings on a device already signed in.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { LOCAL } from "../env";
import { Landing } from "./Landing";
import { useEffect, useState } from "preact/hooks";
import { post } from "../api";
import { go } from "../router";
import { IconKey } from "../ui/icons";
import { type Me, setMe } from "../access";

export interface Auth { state: "checking" | "in" | "out"; passkeys: number; ended: string | null; recheck: () => void }

export function useAuth(): Auth {
  const [state, setState] = useState<Auth["state"]>(() => (localStorage.getItem("signed-in") === "1" ? "in" : "checking"));
  const [passkeys, setPasskeys] = useState(1);
  const [ended, setEnded] = useState<string | null>(null);
  const check = () =>
    fetch("/api/auth/status", { credentials: "same-origin" })
      // A server error is not "no passkeys": it used to show "Not set up yet" (2026-11-06).
      .then((r) => { if (!r.ok) throw new Error(`status ${r.status}`); return r.json(); })
      .then((s: { signedIn: boolean; passkeys: number; me?: Me | null; ended?: string }) => {
        setPasskeys(s.passkeys);
        setEnded(s.ended ?? null);
        if (s.signedIn && s.me) setMe(s.me);
        if (!s.signedIn) setMe(null);
        setState(s.signedIn ? "in" : "out");
        try { localStorage.setItem("signed-in", s.signedIn ? "1" : "0"); } catch { /* fine */ }
      })
      .catch(() => setState((s) => (s === "checking" ? "out" : s)));  // offline: keep a known sign-in
  useEffect(() => { check(); }, []);
  return { state, passkeys, ended, recheck: check };
}

function friendly(e: unknown): string {
  const name = (e as Error)?.name;
  if (name === "NotAllowedError") return "Cancelled, or the passkey wasn't available. Try again.";
  if (name === "InvalidStateError") return "This device already has a passkey for mtg-intel. Sign in instead.";
  return (e as Error)?.message || "Something went wrong.";
}

export function Gate({ auth, onIn }: { auth: Auth; onIn: () => void }) {
  const invite = location.pathname === "/setup" ? location.hash.slice(1) : "";
  const guest = invitedName(invite);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = () => {
    try { localStorage.setItem("signed-in", "1"); } catch { /* fine */ }
    onIn();
    auth.recheck();
    go("/", null, true);
  };
  const signIn = async () => {
    setBusy(true); setError(null);
    let id: string | undefined;
    try {
      const options = await post<any>("/api/auth/login/options");
      const response = await startAuthentication({ optionsJSON: options });
      id = response.id;
      await post("/api/auth/login/verify", { response });
      done();
    } catch (e) {
      setError(friendly(e));
      // A passkey removed in Settings: ask the browser to drop it from its password manager too.
      if (id && /isn't registered/.test((e as Error)?.message || "")) {
        const pk = PublicKeyCredential as unknown as { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> };
        pk.signalUnknownCredential?.({ rpId: location.hostname, credentialId: id }).catch(() => {});
      }
    } finally { setBusy(false); }
  };
  const register = async () => {
    setBusy(true); setError(null);
    try {
      const options = await post<any>("/api/auth/register/options", { invite });
      const response = await startRegistration({ optionsJSON: options });
      await post("/api/auth/register/verify", { response });
      done();
    } catch (e) { setError(friendly(e)); } finally { setBusy(false); }
  };
  if (auth.state === "checking" && !invite) return <div class="landing" />;
  if (!invite) {
    const ended = auth.ended && !error ? `Your access to mtg-intel ended on ${auth.ended.slice(0, 10)}. Ask for a new end date to come back.` : error;
    return <Landing busy={busy} error={ended} onSignIn={signIn} local={LOCAL} setupMissing={!auth.passkeys} />;
  }
  return (
    <div class="landing">
      <header class="l-bar"><a class="l-mark" href="/"><img src="/icon-64.png" alt="" />mtg-intel</a></header>
      <section class="l-hero setup">
        <div class="l-hero-copy">
          <h1>{guest ? `Welcome, ${guest}` : "Set up this device"}</h1>
          <p class="l-lead">{guest ? "You've been invited to mtg-intel. " : ""}Create a passkey for mtg-intel. Your phone or computer keeps it, and Face ID, Touch ID or your PIN unlocks it. Nothing to remember.</p>
          <div class="l-acts"><button class="btn primary lg" type="button" onClick={register} disabled={busy}><IconKey />{busy ? "Waiting…" : "Create passkey"}</button></div>
          {error && <p class="err" role="alert">{error}</p>}
        </div>
      </section>
    </div>
  );
}

/** The invited person's name, carried in the setup link (signed by the Worker, readable here). */
function invitedName(token: string): string {
  try {
    const body = token.split(".")[0];
    const json = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const name = (JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0)))) as { name?: string }).name;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}
