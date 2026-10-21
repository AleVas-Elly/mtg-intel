// Data validation by eye (spec 3b): random spot checks with pictures, and every row the
// automatic checks flagged, grouped by what they found.
import { useMemo, useState } from "preact/hooks";
import type { AppData } from "../data";
import { cmTrend, collectorLine, eur, showsFoil } from "../format";
import { openCard } from "../router";
import { CardImage } from "../ui/CardImage";
import { IconCopy, IconShuffle } from "../ui/icons";
import { WishRow } from "../ui/Row";
import { SetSymbol } from "../ui/symbols";
import type { Wish } from "../types";

const REASONS: Record<string, string> = {
  no_version: "No exact version", no_cardtrader: "Not on CardTrader", ct_number: "Collector number differs",
  ct_name: "Name differs on CardTrader", ct_printing: "CardTrader points elsewhere", ct_label: "CardTrader's label disagrees",
  cm_product: "Different Cardmarket product", foil: "Finish doesn't exist", no_cardmarket: "No Cardmarket product",
  no_cm_price: "No Cardmarket price", cm_zero: "Cardmarket price is €0", cm_jump: "Sudden Cardmarket jump",
  markets_apart: "Markets far apart",
};

function shuffled<T>(xs: T[], n: number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

export function Check({ data }: { data: AppData }) {
  const wishes = data.wants?.wishes ?? [];
  const [seed, setSeed] = useState(0);
  const [copied, setCopied] = useState(false);
  const spot = useMemo(() => shuffled(wishes, 12), [wishes.length, seed]);
  const groups = useMemo(() => {
    const out = new Map<string, Wish[]>();
    for (const w of wishes) for (const f of data.flagsOf(w)) out.set(f.code, [...(out.get(f.code) ?? []), w]);
    return [...out.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [wishes, data.live]);
  const flagged = new Set(groups.flatMap(([, ws]) => ws.map((w) => w.key)));

  const copy = async () => {
    const text = groups.map(([code, ws]) => `${REASONS[code] ?? code}:\n` + ws.map((w) =>
      `  ${w.name} ${w.set?.toUpperCase() ?? ""} #${w.number ?? ""} — ${data.flagsOf(w).filter((f) => f.code === code).map((f) => f.text).join(" ")}`).join("\n")).join("\n\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* no clipboard */ }
  };

  return (
    <div class="page">
      <header class="head">
        <div>
          <h1 class="title">Check</h1>
          <p class="sub">{data.wants ? `${flagged.size} of ${wishes.length} versions flagged` : "Loading…"}</p>
        </div>
      </header>
      <p class="hint" style={{ marginTop: 0 }}>Look at a few cards at random and at everything the automatic checks flagged. Something wrong? Tap the card, use “Copy details for Claude”, and paste it to Claude: it gets fixed where the data comes from.</p>

      <div class="list-head">Spot check<span>
        <button class="btn sm" type="button" onClick={() => setSeed((s) => s + 1)} ><IconShuffle />Shuffle</button>
      </span></div>
      <div class="cards">
        {spot.map((w) => {
          const live = data.liveOf(w.key);
          return (
            <button class="tile" type="button" data-key={w.key} onClick={() => openCard(w.key)}>
              <CardImage src={w.image} alt={w.name} foil={showsFoil(w)} placeholder={w.thumb} />
              <b>{w.name}{data.flagsOf(w).length > 0 && <span class="flag-dot" title="Flagged" />}</b>
              <span class="ours"><SetSymbol set={w.set} rarity={w.rarity} />{collectorLine(w)}</span>
              <span class="theirs">CardTrader: {w.ct ? `${w.ct.version || "no version label"} · ${w.ct.expansion} #${w.ct.number}` : "none"}</span>
              <span>{live ? `CT ${eur(live.price)}` : "CT –"} · CM {eur(cmTrend(w, live?.foil))}</span>
            </button>
          );
        })}
      </div>

      {groups.length > 0 ? (
        <>
          <div class="list-head" style={{ marginTop: "18px" }}>Needs a look<span>
            <button class="btn sm" type="button" onClick={copy} ><IconCopy />{copied ? "Copied" : "Copy all"}</button>
          </span></div>
          {groups.map(([code, ws]) => (
            <>
              <div class="list-head">{REASONS[code] ?? code}<span>{ws.length}</span></div>
              <div class="list">
                {ws.map((w) => (
                  <WishRow w={w} data={data} extra={<div class="r-wish" style={{ whiteSpace: "normal", color: "var(--warn)" }}>
                    {data.flagsOf(w).filter((f) => f.code === code).map((f) => f.text).join(" ")}
                  </div>} />
                ))}
              </div>
            </>
          ))}
        </>
      ) : data.wants && (
        <div class="empty"><h2>Nothing flagged</h2><p>The automatic checks found nothing doubtful. The spot check above is still worth a look.</p></div>
      )}
      <p class="hint">Checks: our version against CardTrader's own name, number and label; the Cardmarket product both sides link; foil wishes on printings without foil; missing or €0 Cardmarket prices; sudden one-day jumps; CardTrader and Cardmarket more than 2.5× apart. “Regular” means no special treatment.</p>
    </div>
  );
}
