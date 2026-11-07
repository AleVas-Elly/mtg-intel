// The Drop's pieces: the countdown ring, rolling figures, and a deal as a drop in its own colour.
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { AppData } from "../data";
import { artUrl, checkState, clock, fieldStyle, useNow } from "../drop";
import { ago, collectorLine, eur, langShort, time, TIERS } from "../format";
import { openCard } from "../router";
import type { Deal, Wish } from "../types";
import { preloadImage } from "./CardImage";
import { ManaCost, SetSymbol } from "./symbols";

/** The ring that fills toward the next CardTrader check; dashed when checks are late. */
export function Ring({ at, size = 44, stroke = 4 }: { at: string | null | undefined; size?: number; stroke?: number }) {
  const now = useNow(1000);
  const s = checkState(at, now);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg class={`ring${s?.stale ? " stale" : ""}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle class="track" cx={size / 2} cy={size / 2} r={r} fill="none" stroke-width={stroke} />
      <circle class="arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke-width={stroke}
        stroke-dasharray={c} stroke-dashoffset={c * (1 - (s?.fraction ?? 0))} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

/** "Next check in 2:41 · Last checked 17:52", with the ring. */
export function Pulse({ data }: { data: AppData }) {
  const now = useNow(1000);
  const at = data.live?.checked_at;
  const s = checkState(at, now);
  if (!at || !s) return <div class="pulse"><Ring at={null} />Waiting for the first check</div>;
  return (
    <div class="pulse" role="status" aria-live="off">
      <Ring at={at} />
      {s.stale
        ? <div>Checks are late<b>{ago(at, now)}</b></div>
        : <div>{s.due ? "Checking now" : "Next check in"}<b>{s.due ? "…" : clock(s.left)}</b></div>}
      <span class="gap" />
      <div class="last">Last checked<b>{time(at)}</b></div>
    </div>
  );
}

/** A price whose digits roll to their value: on arrival, and again whenever it changes. */
export function Roll({ value, class: cls }: { value: number; class?: string }) {
  const text = eur(value);
  const [shown, setShown] = useState<string>(() => text.replace(/\d/g, "0"));
  useEffect(() => {
    // a timer, not an animation frame: a page in the background still gets its real price
    const t = setTimeout(() => setShown(text), 40);
    return () => clearTimeout(t);
  }, [text]);
  // align the old and new strings from the right so units stay in their columns
  const chars = text.split("");
  const pad = shown.padStart(chars.length, " ").slice(-chars.length);
  return (
    <span class={`roll fig ${cls ?? ""}`} role="img" aria-label={text}>
      {chars.map((ch, i) => /\d/.test(ch) ? (
        <span class="col" aria-hidden="true" style={{ transform: `translateY(-${(/\d/.test(pad[i]) ? +pad[i] : 0)}em)`, "--d": chars.length - i }}>
        </span>
      ) : <span class="sym" aria-hidden="true">{ch}</span>)}
    </span>
  );
}

/** The art crop of a card, fading in; tinted grey when the deal is gone. */
export function Art({ w, eager }: { w: Wish; eager?: boolean }) {
  const src = artUrl(w.image) ?? w.image;
  const [ready, setReady] = useState(false);
  return src ? (
    <img src={src} alt="" loading={eager ? "eager" : "lazy"} decoding="async" class={ready ? "ready" : ""}
      onLoad={() => setReady(true)} ref={(el) => { if (el?.complete && el.naturalWidth && !ready) setReady(true); }} />
  ) : null;
}

export function TierPill({ d }: { d: Deal }) {
  const tier = d.tier ? TIERS[d.tier] : null;
  if (!tier) return <span class="tier target">Target price</span>;
  return <span class={`tier ${tier.cls}`}>{tier.label}<small>{Math.round(d.below_pct ?? 0)}% under</small></span>;
}

/** The usual price a deal is judged against (D52) and what it saves. */
export function usualOf(d: Deal, data: AppData): number | null {
  const ref = data.liveOf(d.key)?.ref;
  if (ref) return ref;
  const refs = [d.cardmarket, d.cardtrader].filter((v): v is number => !!v);
  return refs.length ? Math.max(...refs) : null;
}

const open = (key: string) => (e: Event) => { e.preventDefault(); openCard(key); };
const warm = (w: Wish) => () => preloadImage(w.image, 0);

/** A drop: the deal in its art's colour. `line` in the Deals list, `small` in Home's row. */
export function DropCard({ d, w, data, kind, n, current, extra }: {
  d: Deal; w: Wish; data: AppData; kind: "line" | "small"; n?: number; current?: boolean; extra?: ComponentChildren;
}) {
  const gone = !!d.gone_at;
  const usual = usualOf(d, data);
  const style = { ...(gone ? {} : fieldStyle(w.mana_cost)), "--n": n ?? 0 };
  const href = `?card=${encodeURIComponent(w.key)}`;
  if (kind === "small") {
    return (
      <a class={`drop small${gone ? " gone" : ""}`} data-key={w.key} href={href} style={style}
        onClick={open(w.key)} onPointerEnter={warm(w)} onPointerDown={warm(w)} aria-current={current ? "true" : undefined}>
        <div class="art"><Art w={w} /></div>
        <div class="body">
          <h3>{w.name}</h3>
          <div class="meta">
            <small class="d-ink"><SetSymbol set={w.set} rarity={w.rarity} />{w.set ? `${w.set.toUpperCase()} ${w.number} · ${langShort(w.language)}` : "CardTrader only"}</small>
            <div class="price"><Roll value={d.listing.price} class="p" />{d.tier ? <i>{Math.round(d.below_pct ?? 0)}% under</i> : <i>target price</i>}</div>
          </div>
        </div>
      </a>
    );
  }
  return (
    <a class={`drop line${gone ? " gone" : ""}`} data-key={w.key} href={href} style={style}
      onClick={open(w.key)} onPointerEnter={warm(w)} onPointerDown={warm(w)} aria-current={current ? "true" : undefined}>
      <div class="art"><Art w={w} /></div>
      <div class="body">
        {!gone && <TierPill d={d} />}
        <h3><span>{w.name}</span><ManaCost cost={w.mana_cost} front /></h3>
        <div class="ver d-ink"><SetSymbol set={w.set} rarity={w.rarity} /><span>{collectorLine(w)}</span></div>
        {extra}
      </div>
      <div class="price">
        {gone ? <b class="fig">{eur(d.listing.price)}</b> : <Roll value={d.listing.price} class="p" />}
        <span class="d-ink">{gone ? `gone at ${time(d.gone_at!)}` : usual ? `usual ${eur(usual)}` : d.listing.zero ? "via Zero" : ""}</span>
      </div>
      {gone && <span class="stamp" style={{ "--n": n ?? 0 }}>Gone</span>}
    </a>
  );
}

/** A deal that is gone today: greyed, struck, stamped. */
export function GoneItem({ d, w, n }: { d: Deal; w: Wish; n: number }) {
  return (
    <a class="gone-item" data-key={w.key} href={`?card=${encodeURIComponent(w.key)}`} onClick={open(w.key)} style={{ "--n": n }}>
      <div class="art"><Art w={w} /></div>
      <p>{w.name}<small>{eur(d.listing.price)} · gone at {time(d.gone_at!)}</small></p>
      <span class="stamp" style={{ "--n": n }}>Gone</span>
    </a>
  );
}
