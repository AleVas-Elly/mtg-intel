// Any card from Search that isn't on my want-list (3c): a summary first, then the add form in the
// same pane. Its key in the URL is "sf:<Scryfall ID>".
import { useEffect, useState } from "preact/hooks";
import { useDoc } from "../api";
import { allLists, type AppData } from "../data";
import { eur, versionText } from "../format";
import { closeCard, openCard } from "../router";
import { fetchCard, known, preview, type ScryCard } from "../scry";
import { BigCard, CardImage } from "../ui/CardImage";
import { IconBack, IconClose, IconOut, IconPlus, IconWarn } from "../ui/icons";
import { ManaCost, SetSymbol } from "../ui/symbols";
import { Versions, WishForm } from "../ui/WishSheet";
import type { Wish } from "../types";

// The + in Search opens the pane straight on the form.
let startAdding = false;
export function openScryCard(id: string, add = false) {
  startAdding = add;
  openCard(`sf:${id}`);
}

const shardOf = (id: string) => parseInt(id.slice(0, 2), 16) % 32;
type Shard = Record<string, [number | null, number | null]>;

const cardmarketLink = (id: number) => `https://www.cardmarket.com/en/Magic/Products?idProduct=${id}&sellerCountry=23&minCondition=2`;

export function CardPane({ data, id }: { data: AppData; id: string }) {
  const [card, setCard] = useState<ScryCard | null>(() => known.get(id) ?? null);  // known: no flash on open
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(() => { const a = startAdding; startAdding = false; return a; });
  const [quiet] = useState(() => document.documentElement.classList.contains("vt"));
  useEffect(() => { fetchCard(id).then(setCard, (e) => setError(String(e.message ?? e))); }, [id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (adding ? setAdding(false) : closeCard());
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [adding]);
  const shard = useDoc<Shard>(card ? `prices-${shardOf(card.id)}` : null).doc;
  const q = quiet ? " quiet" : "";

  const w: Wish | null = card && { ...preview(card), prints: card.prints_search_uri };
  const mine = w && (data.wants?.wishes ?? []).find((x) => x.scryfall_id === w.scryfall_id);
  const [trend, trendFoil] = (card && shard?.[card.id]) || [null, null];
  const pick = (v: Wish) => { fetchCard(v.scryfall_id!).then(setCard); };

  return (
    <>
      <div class={`detail-backdrop${q}`} onClick={closeCard} />
      <aside class={`detail${q}`} aria-label={card?.name ?? "Card"}>
        <div class="d-top">
          {adding
            ? <button class="icon-btn" onClick={() => setAdding(false)} aria-label="Back to the card"><IconBack /></button>
            : <button class="icon-btn" onClick={closeCard} aria-label="Close"><IconClose /></button>}
          {adding && <span class="d-top-title">Add to want-list</span>}
          {card && <a class="icon-btn" href={card.scryfall_uri} target="_blank" rel="noopener" aria-label="Open on Scryfall"><IconOut /></a>}
        </div>
        {error && <div class="empty"><h2>Card not found</h2><p>{error}</p></div>}
        {!w && !error && <div class="card-big"><div class="thumb skeleton" /></div>}
        {w && !adding && (
          <div class="pane-mode" key="info">
            <BigCard src={w.image} alt={w.name} foil={!w.finishes.includes("nonfoil")} placeholder={w.thumb} />
            <h2 class="d-name">{w.name}<ManaCost cost={w.mana_cost} large /></h2>
            {w.type_line && <p class="d-type">{w.type_line}</p>}
            <div class="d-version">
              <SetSymbol set={w.set} rarity={w.rarity} />
              <span>{w.set_name}{w.number ? ` · #${w.number}` : ""}</span>
              <span class="chip">{versionText(w)}</span>
              {w.rarity && <span class="chip">{w.rarity}</span>}
            </div>
            {w.artist && <p class="hint" style={{ textAlign: "center" }}>Illustrated by {w.artist}{w.released ? ` · ${w.released.slice(0, 4)}` : ""}</p>}

            {mine ? (
              <div class="notice saving" style={{ marginTop: "18px" }}>
                <span>This printing is on your want-list.</span>
                <button class="btn sm" type="button" onClick={() => openCard(mine.key)}>Open</button>
              </div>
            ) : (
              <button class="btn primary wide" type="button" onClick={() => setAdding(true)}><IconPlus />Add to want-list</button>
            )}

            <div class="group-title">Prices</div>
            <div class="group markets">
              <div class="market cm">
                <span class="label">Cardmarket</span>
                <span class="big">{eur(trend ?? trendFoil)}</span>
                <span class="note">{trend != null ? "Trend" : trendFoil != null ? "Trend foil" : "No Cardmarket price yet"}{trend != null && trendFoil != null ? ` · foil ${eur(trendFoil)}` : ""}</span>
                <span class="note">All sellers, latest day</span>
                {card?.cardmarket_id && <a class="btn" href={cardmarketLink(card.cardmarket_id)} target="_blank" rel="noopener">Dutch NM<IconOut /></a>}
              </div>
              <div class="market">
                <span class="label">CardTrader</span>
                <span class="big">–</span>
                <span class="note">Checked every 10 minutes once it's on the want-list</span>
              </div>
            </div>

            <div class="group-title">Other printings</div>
            <div class="group form"><Versions bare wish={w} data={data} onPick={pick} /></div>
          </div>
        )}
        {w && adding && (
          <div class="pane-mode" key="add">
            <div class="pane-card">
              <CardImage src={w.thumb} alt="" foil={false} />
              <div><b>{w.name}</b><span><SetSymbol set={w.set} rarity={w.rarity} />{w.set?.toUpperCase()} {w.number} · {versionText(w)}</span></div>
            </div>
            {mine && <div class="notice"><IconWarn />This printing is already on your want-list; pick another one.</div>}
            <WishForm wish={w} adding inPane lists={allLists(data)} data={data}
              onClose={() => setAdding(false)} onPick={(v) => fetchCard(v.scryfall_id!).then(setCard)}
              onSaved={(key) => openCard(key)} />
          </div>
        )}
      </aside>
    </>
  );
}
