import { useState } from "preact/hooks";
import { DEFAULT, describe, OPTIONS, setLook, useLook, type Look } from "../lab";
import { IconClose, IconCopy } from "./icons";

const GROUPS: { key: keyof Look; label: string }[] = [
  { key: "palette", label: "Colours" },
  { key: "type", label: "Typeface" },
  { key: "motion", label: "Motion" },
  { key: "density", label: "Layout" },
  { key: "tiers", label: "Deal tiers" },
];

/** Floating panel: switch the look live over the real screens. */
export function Lab({ onClose }: { onClose: () => void }) {
  const look = useLook();
  const [copied, setCopied] = useState(false);
  return (
    <section class="lab" aria-label="Design lab">
      <header class="lab-head">
        <h2>Design lab</h2>
        <button class="icon-btn" type="button" onClick={onClose} aria-label="Close the lab"><IconClose /></button>
      </header>
      <div class="lab-body">
        {GROUPS.map(({ key, label }) => {
          const current = OPTIONS[key].find((o) => o.id === look[key]);
          return (
            <div class="lab-group">
              <div class="lab-label"><span>{label}</span><small>{current?.hint}</small></div>
              <div class={`lab-options${key === "palette" ? " swatches" : ""}`} role="radiogroup" aria-label={label}>
                {OPTIONS[key].map((o) => (
                  <button type="button" role="radio" aria-checked={look[key] === o.id} onClick={() => setLook({ [key]: o.id })}
                    class={key === "palette" ? `swatch p-${o.id}` : ""} title={o.hint}>
                    {o.mana && <img src={`https://svgs.scryfall.io/card-symbols/${o.mana}.svg`} alt="" />}
                    <span>{o.label}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <footer class="lab-foot">
        <button class="btn sm" type="button" onClick={() => setLook(DEFAULT)}>Reset</button>
        <button class="btn sm primary" type="button" onClick={async () => {
          try { await navigator.clipboard.writeText(describe(look)); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* no clipboard */ }
        }}><IconCopy />{copied ? "Copied" : "Copy my choices"}</button>
      </footer>
    </section>
  );
}
