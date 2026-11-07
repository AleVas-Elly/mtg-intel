// Any card from Search that isn't on my want-list (3c): a summary first, then the add form in the
// same pane. Its key in the URL is "sf:<Scryfall ID>".
import { can } from "../access";
import { useEffect, useState } from "preact/hooks";
import { useDoc } from "../api";
import { allLists, type AppData } from "../data";
import { cmShipping, condName, eur, langName, versionText, withShipping } from "../format";
import { saveEdit, undoEdit } from "../edits";
import { toast } from "../toast";
import { closeCard, openCard } from "../router";
import { fetchCard, known, preview, type ScryCard } from "../scry";
import { BigCard, CardImage } from "../ui/CardImage";
import { fieldStyle } from "../drop";
import { IconBack, IconClose, IconOut, IconPlus } from "../ui/icons";
import { ManaCost, SetSymbol } from "../ui/symbols";
import { Versions, WishForm } from "../ui/WishSheet";
import { OwnedHere } from "../ui/RemoveSheet";
import { CtCheck } from "../ui/CtCheck";
import type { Wish } from "../types";

// The + in Search opens the pane straight on the form.
let startAdding = false;
export function openScryCard(id: string, add = false) {
  startAdding = add;
  openCard(`sf:${id}`);
}

const shardOf = (id: string) => parseInt(id.slice(0, 2), 16) % 32;
/** Per printing: Cardmarket's trend, foil trend and, when known, its CardTrader card (D83). */
type Shard = Record<string, [number | null, number | null, number?]>;

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
  const wishes = w ? (data.wants?.wishes ?? []).filter((x) => x.scryfall_id === w.scryfall_id) : [];
  const mine = wishes[0];
  // a printing already on the list is never added twice: picking one shows it with Add a copy
  useEffect(() => { if (adding && mine) setAdding(false); }, [mine?.key]);
  const [trend, trendFoil, blueprint] = (card && shard?.[card.id]) || [null, null];
  const pick = (v: Wish) => { fetchCard(v.scryfall_id!).then(setCard); };
  const field = w ? fieldStyle(w.mana_cost) : undefined;

  return (
    <>
      <div class={`detail-backdrop${q}`} onClick={closeCard} />
      <aside class={`detail${q}`} aria-label={card?.name ?? "Card"} style={field}>
        <div class="d-top">
          {adding
            ? <button class="icon-btn" onClick={() => setAdding(false)} aria-label="Back to the card"><IconBack /></button>
            : <button class="icon-btn" onClick={closeCard} aria-label="Close"><IconClose /></button>}
          {adding && <span class="d-top-title">{can("edit") ? "Add to want-list" : "Suggest a card"}</span>}
          {card && <a class="icon-btn" href={card.scryfall_uri} target="_blank" rel="noopener" aria-label="Open on Scryfall"><IconOut /></a>}
        </div>
        {error && <div class="empty"><h2>Card not found</h2><p>{error}</p></div>}
        {!w && !error && <div class="card-big"><div class="thumb skeleton" /></div>}
        {w && !adding && (
          <div class="pane-mode" key="info">
            <div class="d-stage">
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
            </div>

            {wishes.length ? (
              <OnTheList wishes={wishes} />
            ) : can("edit") ? (
              <button class="btn primary wide" type="button" onClick={() => setAdding(true)}><IconPlus />Add to want-list</button>
            ) : can("suggest") ? (
              <button class="btn primary wide" type="button" onClick={() => setAdding(true)}><IconPlus />Suggest for the want-list</button>
            ) : null}

            <OwnedHere data={data} id={w.scryfall_id} />

            <div class="group-title">Prices</div>
            <div class="group markets">
              <div class="market cm">
                <span class="label">Cardmarket{(trend ?? trendFoil) != null && <small class="incl"> (incl. shipping {eur(cmShipping((trend ?? trendFoil)!))})</small>}</span>
                <span class="big">{(trend ?? trendFoil) != null ? eur(withShipping((trend ?? trendFoil)!)) : "–"}</span>
                <span class="note">{trend != null ? `Trend ${eur(trend)}` : trendFoil != null ? `Trend foil ${eur(trendFoil)}` : "No Cardmarket price yet"}{trend != null && trendFoil != null ? ` · foil ${eur(trendFoil)}` : ""}</span>
                <span class="note">All sellers, latest day</span>
                {card?.cardmarket_id && <a class="btn" href={cardmarketLink(card.cardmarket_id)} target="_blank" rel="noopener">Dutch NM<IconOut /></a>}
              </div>
              <CtCheck key={card?.id} blueprint={blueprint ?? null} foilOnly={!!w && !w.finishes.includes("nonfoil") && w.finishes.length > 0} />
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
            <WishForm wish={w} adding inPane lists={allLists(data)} data={data}
              onClose={() => setAdding(false)} onPick={(v) => fetchCard(v.scryfall_id!).then(setCard)}
              onSaved={(key) => openCard(key)} />
          </div>
        )}
      </aside>
    </>
  );
}

/** This printing is already on my want-list: what each wish of it asks for, Open, and Add a copy
 *  (one more copy on that wish, saved like any edit, with Undo). */
function OnTheList({ wishes }: { wishes: Wish[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const more = async (x: Wish) => {
    setBusy(x.key);
    const n = (x.quantity || 1) + 1;
    try {
      const doc = await saveEdit({ op: "update", key: x.key, settings: { quantity: String(n) } });
      const op = [...doc.ops].reverse().find((o) => o.op === "update" && o.key === x.key);
      toast(`${n} copies of ${x.name} on your want-list now.`, op && { label: "Undo", run: () => { undoEdit(op.id).catch(() => toast("Too late to undo: it's already saved.")); } });
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div class="group-title">On your want-list</div>
      <div class="group on-list">
        {wishes.map((x) => (
          <div class="kv owned-line">
            <dt><b>{x.quantity || 1} ×</b> {langName(x.language)} · {x.foil === "yes" ? "foil" : x.foil === "no" ? "non-foil" : "any finish"}
              <small>{x.pending ? "Saving" : `${condName(x.condition)} or better${x.lists.length ? ` · ${x.lists.join(", ")}` : ""}`}</small></dt>
            <dd>
              <button class="btn sm" type="button" onClick={() => openCard(x.key)}>Open</button>
              {can("edit") && <button class="btn sm primary" type="button" disabled={busy === x.key || x.pending === "add"}
                title={x.pending === "add" ? "Wait until it's saved to the want-list" : undefined}
                onClick={() => more(x)}><IconPlus />Add a copy</button>}
            </dd>
          </div>
        ))}
      </div>
    </>
  );
}
