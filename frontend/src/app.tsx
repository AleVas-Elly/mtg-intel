import { useEffect, useState } from "preact/hooks";
import { whenSignedOut } from "./api";
import { type Perm, useMe } from "./access";
import { useAppData, wishCount } from "./data";
import { link, useRoute } from "./router";
import { IconChart, IconCheck, IconDeals, IconHome, IconSearch, IconSettings, IconStack, IconWants } from "./ui/icons";
import { Gate, useAuth } from "./screens/Gate";
import { Deals } from "./screens/Deals";
import { Home } from "./screens/Home";
import { Wants } from "./screens/Wants";
import { Search } from "./screens/Search";
import { Collection } from "./screens/Collection";
import { Dashboards } from "./screens/Dashboards";
import { Check } from "./screens/Check";
import { Settings } from "./screens/Settings";
import { Detail } from "./screens/Detail";
import { CardPane } from "./screens/CardPane";
import { Lab } from "./ui/Lab";
import { dismissToast, useToast } from "./toast";

import { LOCAL } from "./env";
import { setLabOpen, useLabOpen } from "./labstate";

const TABS: { path: string; label: string; Icon: typeof IconHome; needs?: Perm }[] = [
  { path: "/", label: "Home", Icon: IconHome },
  { path: "/deals", label: "Deals", Icon: IconDeals, needs: "deals" },
  { path: "/wants", label: "Want-list", Icon: IconWants, needs: "wants" },
  { path: "/collection", label: "Collection", Icon: IconStack, needs: "collection" },
  { path: "/search", label: "Search", Icon: IconSearch },
  { path: "/check", label: "Check", Icon: IconCheck, needs: "wants" },
];
/** Screens someone without that switch can't open (D76): they land on Home. */
const NEEDS: Record<string, Perm> = { "/deals": "deals", "/wants": "wants", "/collection": "collection", "/bought": "collection", "/check": "wants" };

export function App() {
  const auth = useAuth();
  const route = useRoute();
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => whenSignedOut(() => setSignedOut(true)), []);
  // the local test copy can show the landing page while signed in: /?landing
  if (route.path === "/setup" || auth.state !== "in" || signedOut || (LOCAL && location.search.includes("landing"))) {
    return <Gate auth={auth} onIn={() => setSignedOut(false)} />;
  }
  return <Signed path={route.path} card={route.card} />;
}

/** Which section's colour the page wears (D62): the Want-list is cyan, the Collection pink,
 *  Deals gold, Check red. */
const SEC: Record<string, string> = { "/wants": "wants", "/collection": "collection", "/bought": "collection", "/deals": "deals", "/check": "check" };
const sectionOf = (path: string) => SEC[path] ?? "";

function Signed({ path: asked, card }: { path: string; card: string | null }) {
  const data = useAppData();
  const me = useMe();
  const may = (p?: Perm) => !p || me.owner || me.perms[p];
  const path = may(NEEDS[asked]) && (asked !== "/dashboards" || may("wants") || may("collection")) ? asked : "/";
  const tabs = TABS.filter((t) => may(t.needs));
  /** The phone's tab bar has room for five; Check is on Home and in the menu. */
  const phoneTabs = tabs.filter((t) => t.path !== "/check");
  // Dashboards sets its own section, by the tab that is open
  useEffect(() => { if (path !== "/dashboards") document.documentElement.dataset.section = sectionOf(path); }, [path]);
  const dealCount = data.live?.deals.filter((d) => data.byKey.has(d.key)).length ?? 0;  // a removed wish's deal drops out
  const flagged = (data.wants?.wishes ?? []).filter((w) => data.flagsOf(w).length).length;
  const screen =
    path === "/wants" ? <Wants data={data} card={card} /> :
    path === "/collection" || path === "/bought" ? <Collection data={data} card={card} /> :
    path === "/dashboards" ? <Dashboards data={data} /> :
    path === "/search" ? <Search data={data} /> :
    path === "/check" ? <Check data={data} /> :
    path === "/settings" ? <Settings data={data} /> :
    path === "/deals" ? <Deals data={data} card={card} /> :
    <Home data={data} card={card} />;
  const counts: Record<string, number | undefined> = { "/deals": dealCount || undefined, "/check": flagged || undefined, "/wants": data.wants ? wishCount(data.wants.wishes) : undefined };
  return (
    <div class={`shell${card ? " has-detail" : ""}`}>
      <nav class="rail" aria-label="Main">
        <a class="brand" href="/" onClick={link("/")}><img src="/icon-64.png" alt="" />mtg-intel</a>
        {tabs.map(({ path: p, label, Icon }) => (
          <a href={p} onClick={link(p)} class={SEC[p] ? `sec-${SEC[p]}` : undefined} aria-current={path === p || (p === "/collection" && path === "/bought") ? "page" : undefined}>
            <Icon />{label}{counts[p] != null && <span class="count">{counts[p]}</span>}
          </a>
        ))}
        <div class="grow" />
        {(may("wants") || may("collection")) && <a href="/dashboards" onClick={link("/dashboards")} aria-current={path === "/dashboards" ? "page" : undefined}><IconChart />Dashboards</a>}
        <a href="/settings" onClick={link("/settings")} aria-current={path === "/settings" ? "page" : undefined}><IconSettings />Settings</a>
      </nav>
      <main class="main">
        {LOCAL && <div class="local-copy">Local test copy on Claude's machine: made-up prices, not your real deals.</div>}
        {screen}
      </main>
      {card && (card.startsWith("sf:") ? <CardPane data={data} id={card.slice(3)} /> : <Detail data={data} wishKey={card} />)}
      {useLabOpen() && <Lab onClose={() => setLabOpen(false)} />}
      <ToastView />
      <nav class="tabbar" aria-label="Main">
        {phoneTabs.map(({ path: p, label, Icon }) => (
          <a class={`tab${SEC[p] ? ` sec-${SEC[p]}` : ""}`} href={p} onClick={link(p)} aria-current={path === p || (p === "/collection" && path === "/bought") ? "page" : undefined}><Icon />{label}</a>
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
