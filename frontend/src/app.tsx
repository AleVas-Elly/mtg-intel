import { useEffect, useState } from "preact/hooks";
import { whenSignedOut } from "./api";
import { useAppData, wishCount } from "./data";
import { link, useRoute } from "./router";
import { IconCheck, IconDeals, IconSearch, IconSettings, IconWants } from "./ui/icons";
import { Gate, useAuth } from "./screens/Gate";
import { Deals } from "./screens/Deals";
import { Wants } from "./screens/Wants";
import { Search } from "./screens/Search";
import { Check } from "./screens/Check";
import { Settings } from "./screens/Settings";
import { Detail } from "./screens/Detail";
import { Lab } from "./ui/Lab";
import { dismissToast, useToast } from "./toast";

// The development copy runs on test data; say so, so it is never mistaken for the real site.
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
import { setLabOpen, useLabOpen } from "./labstate";

const TABS = [
  { path: "/", label: "Deals", Icon: IconDeals },
  { path: "/wants", label: "Want-list", Icon: IconWants },
  { path: "/search", label: "Search", Icon: IconSearch },
  { path: "/check", label: "Check", Icon: IconCheck },
];

export function App() {
  const auth = useAuth();
  const route = useRoute();
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => whenSignedOut(() => setSignedOut(true)), []);
  if (route.path === "/setup" || auth.state !== "in" || signedOut) {
    return <Gate auth={auth} onIn={() => setSignedOut(false)} />;
  }
  return <Signed path={route.path} card={route.card} />;
}

function Signed({ path, card }: { path: string; card: string | null }) {
  const data = useAppData();
  const dealCount = data.live?.deals.filter((d) => data.byKey.has(d.key)).length ?? 0;  // a removed wish's deal drops out
  const flagged = (data.wants?.wishes ?? []).filter((w) => data.flagsOf(w).length).length;
  const screen =
    path === "/wants" ? <Wants data={data} card={card} /> :
    path === "/search" ? <Search data={data} /> :
    path === "/check" ? <Check data={data} /> :
    path === "/settings" ? <Settings data={data} /> :
    <Deals data={data} card={card} />;
  const counts: Record<string, number | undefined> = { "/": dealCount || undefined, "/check": flagged || undefined, "/wants": data.wants ? wishCount(data.wants.wishes) : undefined };
  return (
    <div class={`shell${card ? " has-detail" : ""}`}>
      <nav class="rail" aria-label="Main">
        <div class="brand"><img src="/icon.svg" alt="" />mtg-intel</div>
        {TABS.map(({ path: p, label, Icon }) => (
          <a href={p} onClick={link(p)} aria-current={path === p ? "page" : undefined}>
            <Icon />{label}{counts[p] != null && <span class="count">{counts[p]}</span>}
          </a>
        ))}
        <div class="grow" />
        <a href="/settings" onClick={link("/settings")} aria-current={path === "/settings" ? "page" : undefined}><IconSettings />Settings</a>
      </nav>
      <main class="main">
        {LOCAL && <div class="local-copy">Local test copy on Claude's machine: made-up prices, not your real deals.</div>}
        {screen}
      </main>
      {card && <Detail data={data} wishKey={card} />}
      {useLabOpen() && <Lab onClose={() => setLabOpen(false)} />}
      <ToastView />
      <nav class="tabbar" aria-label="Main">
        {TABS.map(({ path: p, label, Icon }) => (
          <a class="tab" href={p} onClick={link(p)} aria-current={path === p ? "page" : undefined}><Icon />{label}</a>
        ))}
      </nav>
    </div>
  );
}


function ToastView() {
  const t = useToast();
  if (!t) return null;
  return (
    <div class="toast" role="status" key={t.id}>
      <span>{t.text}</span>
      {t.action && <button type="button" onClick={() => { t.action!.run(); dismissToast(); }}>{t.action.label}</button>}
    </div>
  );
}
