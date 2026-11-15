// Data validation (spec 3b): every row the automatic checks flagged, grouped by what they found.
// (The random spot check was dropped: the user didn't find it useful, 2026-11-15.)
import { useMemo, useState } from "preact/hooks";
import type { AppData } from "../data";
import { IconCopy } from "../ui/icons";
import { CardList } from "../ui/Row";
import type { Wish } from "../types";

const REASONS: Record<string, string> = {
  no_version: "No exact version", no_cardtrader: "Not on CardTrader", ct_number: "Collector number differs",
  ct_name: "Name differs on CardTrader", ct_printing: "CardTrader points elsewhere", ct_label: "CardTrader's label disagrees",
  cm_product: "Different Cardmarket product", foil: "Finish doesn't exist", no_cardmarket: "No Cardmarket product",
  no_cm_price: "No Cardmarket price", cm_zero: "Cardmarket price is €0", cm_jump: "Sudden Cardmarket jump",
  markets_apart: "Markets far apart",
};

export function Check({ data }: { data: AppData }) {
  const wishes = data.wants?.wishes ?? [];
  const [copied, setCopied] = useState(false);
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
      <header class="head sec-band">
        <div>
          <h1 class="title">Check</h1>
          <p class="sub">{data.wants ? `${flagged.size} of ${wishes.length} versions flagged` : "Loading…"}</p>
        </div>
      </header>
      <p class="hint" style={{ marginTop: 0 }}>Everything the automatic checks flagged. Something wrong? Tap the card, use “Copy details for Claude”, and paste it to Claude: it gets fixed where the data comes from.</p>

      {groups.length > 0 ? (
        <>
          <div class="list-head" style={{ marginTop: "18px" }}>Needs a look<span>
            <button class="btn sm" type="button" onClick={copy} ><IconCopy />{copied ? "Copied" : "Copy all"}</button>
          </span></div>
          {groups.map(([code, ws]) => (
            <>
              <div class="list-head">{REASONS[code] ?? code}<span>{ws.length}</span></div>
              <CardList data={data} items={ws.map((w) => ({
                w, extra: <div class="r-wish" style={{ whiteSpace: "normal", color: "var(--warn)" }}>
                  {data.flagsOf(w).filter((f) => f.code === code).map((f) => f.text).join(" ")}
                </div>,
              }))} />
            </>
          ))}
        </>
      ) : data.wants && (
        <div class="empty"><h2>Nothing flagged</h2><p>The automatic checks found nothing doubtful.</p></div>
      )}
      <p class="hint">Checks: our version against CardTrader's own name, number and label; the Cardmarket product both sides link; foil wishes on printings without foil; missing or €0 Cardmarket prices; sudden one-day jumps; CardTrader and Cardmarket more than 2.5× apart. “Regular” means no special treatment.</p>
    </div>
  );
}
