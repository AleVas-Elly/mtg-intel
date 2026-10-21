// Card search like the `cards` skill (spec D45): Scryfall does the matching, my lists and
// Cardmarket prices are joined in here. "My cards" names my exact printings in the query.
import { useEffect, useRef, useState } from "preact/hooks";
import { peek, refresh } from "../api";
import type { AppData } from "../data";
import { eur } from "../format";
import { openCard } from "../router";
import { CardImage } from "../ui/CardImage";
import { IconSearch, IconWarn } from "../ui/icons";
import { SetSymbol } from "../ui/symbols";
import type { Wish } from "../types";

interface ScryCard {
  id: string; name: string; set: string; collector_number: string; rarity: string; finishes: string[];
  image_uris?: { small: string; normal: string }; card_faces?: { image_uris?: { small: string } }[];
  scryfall_uri: string; set_name: string;
}

const API = "https://api.scryfall.com/cards/search";
const MAX_NESTED = 20;
const BUDGET = 800;
let last = 0;
async function paced(url: string): Promise<Response> {
  const wait = last + 110 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  return fetch(url, { headers: { Accept: "application/json" } });
}

/** Same as backend search.printing_filters: (s:msh (cn:"1" or cn:"2")) groups within budget. */
export function printingFilters(printings: [string, string][], maxSets: number, budget = BUDGET): string[] {
  const bySet = new Map<string, string[]>();
  for (const [s, n] of printings) bySet.set(s, [...(bySet.get(s) ?? []), n]);
  const terms: string[] = [];
  for (const [s, numbers] of bySet) {
    let chunk: string[] = [];
    for (const n of numbers) {
      chunk.push(`cn:"${n}"`);
      if (chunk.join(" or ").length > budget / 2) { terms.push(`(s:${s} (${chunk.join(" or ")}))`); chunk = []; }
    }
    if (chunk.length) terms.push(`(s:${s} (${chunk.join(" or ")}))`);
  }
  const out: string[] = [];
  let cur: string[] = [];
  for (const t of terms) {
    if (cur.length && (cur.length === maxSets || [...cur, t].join(" or ").length > budget)) { out.push(cur.join(" or ")); cur = []; }
    cur.push(t);
  }
  if (cur.length) out.push(cur.join(" or "));
  return out;
}

async function run(query: string, unique: string, onPage: (cards: ScryCard[], total: number) => void, max = 4) {
  let url: string | null = `${API}?${new URLSearchParams({ q: query, unique, include_variations: "true", order: "released", dir: "desc" })}`;
  for (let page = 0; url && page < max; page++) {
    const r: Response = await paced(url);
    if (r.status === 404) return false;
    const body = await r.json();
    if (!r.ok) throw new Error(body.details || "Scryfall couldn't run that search.");
    const invalid = (body.warnings ?? []).filter((w: string) => w.startsWith("Invalid expression"));
    if (invalid.length) throw new Error(invalid.join(" "));
    onPage(body.data, body.total_cards);
    url = body.has_more ? body.next_page : null;
  }
  return !!url;
}

const EXAMPLES = ["art:cat", "t:legendary c:u", "is:showcase mv<=3", "o:\"draw a card\"", "a:\"Rebecca Guay\""];

export function Search({ data }: { data: AppData }) {
  const [q, setQ] = useState(() => sessionStorage.getItem("search-q") || "");
  const [scope, setScope] = useState<"mine" | "all">(() => (sessionStorage.getItem("search-scope") as "mine" | "all") || "mine");
  const [cards, setCards] = useState<ScryCard[]>([]);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [, setShardsLoaded] = useState(0);
  const run_id = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const wantsById = new Map<string, Wish>();
  for (const w of data.wants?.wishes ?? []) if (w.scryfall_id) wantsById.set(w.scryfall_id, w);

  const search = async (e?: Event) => {
    e?.preventDefault();
    const query = q.trim();
    if (!query) return;
    try { sessionStorage.setItem("search-q", query); sessionStorage.setItem("search-scope", scope); } catch { /* fine */ }
    const id = ++run_id.current;
    setCards([]); setError(null); setState("busy"); setMore(false);
    const seen = new Set<string>();
    const add = (page: ScryCard[]) => {
      if (id !== run_id.current) return;
      const fresh = page.filter((c) => !seen.has(c.id) && (scope === "all" || wantsById.has(c.id)));
      fresh.forEach((c) => seen.add(c.id));
      setCards((prev) => [...prev, ...fresh]);
    };
    try {
      if (scope === "all") {
        setMore(await run(query, "cards", add));
      } else {
        const printings = [...wantsById.values()].filter((w) => w.set && w.number).map((w) => [w.set!, w.number!] as [string, string]);
        const groups = Math.max(1, Math.floor((MAX_NESTED - 2 - (query.match(/\(/g) ?? []).length) / 2));
        for (const f of printingFilters(printings, groups)) {
          if (id !== run_id.current) return;
          await run(`(${query}) (${f})`, "prints", add, 2);
        }
      }
    } catch (err) {
      if (id === run_id.current) setError((err as Error).message);
    }
    if (id === run_id.current) setState("done");
  };

  // Cardmarket trend for cards that aren't on my lists: fetch the price shards the hits need.
  const missing = cards.filter((c) => !wantsById.has(c.id)).map((c) => parseInt(c.id.slice(0, 2), 16) % 32);
  const needShards = [...new Set(missing)].sort().join(",");
  const shardDocs = useRef(new Map<number, Record<string, [number | null, number | null]>>());
  useEffect(() => {
    const todo = needShards ? needShards.split(",").map(Number).filter((n) => !shardDocs.current.has(n)) : [];
    if (!todo.length) return;
    Promise.all(todo.map(async (n) => {
      await refresh(`prices-${n}`, false);
      shardDocs.current.set(n, peek(`prices-${n}`) ?? {});
    })).then(() => setShardsLoaded((k) => k + 1)).catch(() => {});
  }, [needShards]);

  useEffect(() => { if (q && cards.length === 0 && state === "idle") search(); }, []);

  return (
    <div class="page">
      <header class="head"><div><h1 class="title">Search</h1><p class="sub">Scryfall search syntax, joined with my lists and Cardmarket prices</p></div></header>
      <form class="toolbar" onSubmit={search} role="search">
        <label class="field" style={{ flexBasis: "100%" }}><IconSearch /><span class="sr">Search</span>
          <input ref={input} type="search" enterKeyHint="search" autoCapitalize="off" autoCorrect="off" spellcheck={false}
            placeholder="e.g. art:cat t:creature" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </label>
        <div class="seg" role="group" aria-label="Where to search">
          <button type="button" aria-pressed={scope === "mine"} onClick={() => setScope("mine")}>My cards</button>
          <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>All cards</button>
        </div>
        <button class="btn primary" type="submit" disabled={!q.trim() || state === "busy"} style={{ height: "36px", borderRadius: "10px" }}>Search</button>
      </form>
      {error && <div class="notice"><IconWarn />{error}</div>}
      {state === "idle" && (
        <div class="hint">
          Try {EXAMPLES.map((ex, i) => <>{i > 0 && ", "}<a href="#" class="link" onClick={(e) => { e.preventDefault(); setQ(ex); setTimeout(() => input.current?.form?.requestSubmit(), 0); }}><code>{ex}</code></a></>)}.
          Art and function tags (<code>art:</code>, <code>function:</code>) come from Scryfall's community and aren't complete. For plain-language questions, ask Claude.
        </div>
      )}
      {state !== "idle" && (
        <div class="list-head">{state === "busy" ? "Searching…" : `${cards.length} ${cards.length === 1 ? "card" : "cards"}${more ? " (first pages)" : ""}`}<span>{scope === "mine" ? "in my want-list" : "every card, newest printing"}</span></div>
      )}
      {state === "done" && !cards.length && !error && (
        <div class="empty"><h2>No cards found</h2><p>{scope === "mine" ? "None of my cards match. Try All cards." : "Scryfall found nothing for that search."}</p></div>
      )}
      <div class="cards">
        {cards.map((c) => {
          const mine = wantsById.get(c.id);
          const shard = shardDocs.current.get(parseInt(c.id.slice(0, 2), 16) % 32);
          const price = mine ? (mine.cm.trend ?? mine.cm.trend_foil) : shard?.[c.id]?.[0] ?? shard?.[c.id]?.[1];
          const img = c.image_uris?.small ?? c.card_faces?.[0]?.image_uris?.small ?? null;
          const open = () => (mine ? openCard(mine.key) : window.open(c.scryfall_uri, "_blank", "noopener"));
          return (
            <button class="tile" type="button" onClick={open}>
              <CardImage src={img} alt={c.name} foil={!c.finishes.includes("nonfoil")} />
              <b>{c.name}</b>
              <span><SetSymbol set={c.set} rarity={c.rarity} />{c.set.toUpperCase()} · {c.collector_number}</span>
              <span>{price != null ? `Cardmarket ${eur(price)}` : "No Cardmarket price"}{mine ? " · on my list" : ""}</span>
            </button>
          );
        })}
      </div>
      {state === "busy" && <div class="cards" style={{ marginTop: "18px" }}>{Array.from({ length: 6 }, () => <div class="thumb skeleton" />)}</div>}
    </div>
  );
}
