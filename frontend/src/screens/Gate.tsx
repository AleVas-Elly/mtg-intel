// Sign-in with a passkey (spec D49). A new device joins through a one-time setup link: made by
// Claude for the first device, or shown as a QR code in Settings on a device already signed in.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { LOCAL, SITE } from "../env";
import { useEffect, useState } from "preact/hooks";
import { post } from "../api";
import { go } from "../router";
import { IconKey } from "../ui/icons";

export interface Auth { state: "checking" | "in" | "out"; passkeys: number; recheck: () => void }

export function useAuth(): Auth {
  const [state, setState] = useState<Auth["state"]>(() => (localStorage.getItem("signed-in") === "1" ? "in" : "checking"));
  const [passkeys, setPasskeys] = useState(1);
  const check = () =>
    fetch("/api/auth/status", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((s: { signedIn: boolean; passkeys: number }) => {
        setPasskeys(s.passkeys);
        setState(s.signedIn ? "in" : "out");
        try { localStorage.setItem("signed-in", s.signedIn ? "1" : "0"); } catch { /* fine */ }
      })
      .catch(() => setState((s) => (s === "checking" ? "out" : s)));  // offline: keep a known sign-in
  useEffect(() => { check(); }, []);
  return { state, passkeys, recheck: check };
}

function friendly(e: unknown): string {
  const name = (e as Error)?.name;
  if (name === "NotAllowedError") return "Cancelled, or the passkey wasn't available. Try again.";
  if (name === "InvalidStateError") return "This device already has a passkey for mtg-intel. Sign in instead.";
  return (e as Error)?.message || "Something went wrong.";
}

export function Gate({ auth, onIn }: { auth: Auth; onIn: () => void }) {
  const invite = location.pathname === "/setup" ? location.hash.slice(1) : "";
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
    try {
      const options = await post<any>("/api/auth/login/options");
      const response = await startAuthentication({ optionsJSON: options });
      await post("/api/auth/login/verify", { response });
      done();
    } catch (e) { setError(friendly(e)); } finally { setBusy(false); }
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
  if (auth.state === "checking" && !invite) return <div class="gate" />;
  return (
    <div class="gate">
      <div class="gate-in">
        <img class="logo" src="/icon.svg" alt="" />
        {invite ? (
          <>
            <h1>Set up this device</h1>
            <p>Create a passkey for mtg-intel. Your phone or Mac keeps it, and Face ID or Touch ID unlocks it. Nothing to remember.</p>
            <button class="btn primary" type="button" onClick={register} disabled={busy}><IconKey />{busy ? "Waiting…" : "Create passkey"}</button>
          </>
        ) : (
          <>
            <h1>mtg-intel</h1>
            {LOCAL ? (
              <>
                <p>This is Claude's local test copy, not your site.</p>
                <a class="btn primary" href={SITE}>Open my mtg-intel</a>
              </>
            ) : <p>{auth.passkeys ? "Your cards, deals and prices." : "Not set up yet: ask Claude for a setup link."}</p>}
            {!LOCAL && auth.passkeys > 0 && <button class="btn primary" type="button" onClick={signIn} disabled={busy}><IconKey />{busy ? "Waiting…" : "Sign in with passkey"}</button>}
          </>
        )}
        {error && <p class="err" role="alert">{error}</p>}
      </div>
    </div>
  );
}
