import { useState } from "preact/hooks";
import { peek } from "../api";
import { TIERS } from "../format";
import { DEFAULT, describe, OPTIONS, setLook, useLook, type Look } from "../lab";
import type { WantsDoc } from "../types";
import { CardImage } from "./CardImage";
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
  const [plays, setPlays] = useState(0);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
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
                  <button type="button" role="radio" aria-checked={look[key] === o.id}
                    onClick={() => { setLook({ [key]: o.id }); if (key === "motion") setPlays((n) => n + 1); }}
                    class={key === "palette" ? `swatch p-${o.id}` : ""} title={o.hint}>
                    {o.mana && <img src={`https://svgs.scryfall.io/card-symbols/${o.mana}.svg`} alt="" />}
                    <span>{o.label}</span>
                  </button>
                ))}
              </div>
              {key === "tiers" && (
                <div class="lab-tiers">
                  {[20, 30, 40].map((pct) => <span class={`tier ${TIERS[pct].cls}`}>{TIERS[pct].label}<small>{pct}% under</small></span>)}
                </div>
              )}
              {key === "motion" && (reduced
                ? <p class="lab-note">Your device is set to reduce motion, so the site keeps still whatever you pick here.</p>
                : <MotionDemo play={plays} onReplay={() => setPlays((n) => n + 1)} />)}
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

/** A few of my cards doing what lists and an opened card do under the chosen motion. */
function MotionDemo({ play, onReplay }: { play: number; onReplay: () => void }) {
  const wishes = peek<WantsDoc>("wants")?.wishes ?? [];
  const thumbs = wishes.filter((w) => w.thumb).slice(0, 5);
  if (!thumbs.length) return null;
  return (
    <button type="button" class="lab-demo" key={play} onClick={onReplay} aria-label="Play the motion preview again">
      {thumbs.map((w, i) => (
        <span class={`demo-card${i === 2 ? " lift" : ""}`} style={{ "--i": i }}>
          <CardImage src={w.thumb} alt="" foil={i === 2} eager />
        </span>
      ))}
      <small>Tap to play again</small>
    </button>
  );
}
