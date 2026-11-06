// The filter groups, used both as the Want-list sidebar and as the phone's Filters sheet.
import { useEffect, useState } from "preact/hooks";
import { activeCount, type FilterState, type Group, type Icon } from "../filters";
import { IconClose } from "./icons";
import { SetSymbol } from "./symbols";

const OPEN_KEY = "wants-filter-open";

function readOpen(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) || "{}"); } catch { return {}; }
}

function OptionIcon({ icon }: { icon: Icon }) {
  if ("mana" in icon) {
    return <img class="f-mana" src={`https://svgs.scryfall.io/card-symbols/${icon.mana}.svg`} alt="" decoding="async" />;
  }
  if ("set" in icon) return <SetSymbol set={icon.set} rarity={icon.rarity} title="" />;
  return <span class={`f-rarity ${icon.rarity}`} aria-hidden="true" />;
}

export function FilterPanel({ groups, state, onChange, counts }: {
  groups: Group[]; state: FilterState; onChange: (s: FilterState) => void; counts: Map<string, number>;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const [all, setAll] = useState<Record<string, boolean>>({});
  useEffect(() => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* fine */ } }, [open]);

  const toggle = (g: Group, id: string) => {
    const picked = state.sel[g.id] ?? [];
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    // a quick price range and a custom one would fight: picking one clears the other
    onChange({ ...state, sel: { ...state.sel, [g.id]: next }, ...(g.id === "price" ? { min: "", max: "" } : {}) });
  };
  const setPrice = (k: "min" | "max", v: string) => onChange({ ...state, [k]: v, sel: { ...state.sel, price: [] } });

  return (
    <div class="filters">
      {groups.map((g) => {
        if (!g.options.length) return null;
        const isOpen = open[g.id] ?? g.open;
        const picked = state.sel[g.id] ?? [];
        const on = picked.length + (g.id === "price" && (state.min || state.max) ? 1 : 0);
        const limit = g.show && !all[g.id] ? g.show : Infinity;
        // picked options always stay visible, even past the "show all" cut
        const options = g.options.filter((o, i) => i < limit || picked.includes(o.id));
        return (
          <section class="f-group">
            <button type="button" class="f-head" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [g.id]: !(o[g.id] ?? g.open) }))}>
              <span class="f-caret" aria-hidden="true" />{g.label}{on > 0 && <span class="f-on">{on}</span>}
            </button>
            {isOpen && (
              <div class="f-options">
                {options.map((o) => {
                  const checked = picked.includes(o.id);
                  const n = counts.get(`${g.id}:${o.id}`) ?? 0;
                  return (
                    <button type="button" role="checkbox" aria-checked={checked} class="f-opt" disabled={!checked && n === 0} onClick={() => toggle(g, o.id)}>
                      <span class="f-box" aria-hidden="true" />
                      {o.icon && <OptionIcon icon={o.icon} />}
                      <span class="f-label">{o.label}</span>
                      <span class="f-n">{n}</span>
                    </button>
                  );
                })}
                {g.show != null && g.options.length > g.show && (
                  <button type="button" class="f-more" onClick={() => setAll((a) => ({ ...a, [g.id]: !a[g.id] }))}>
                    {all[g.id] ? "Show fewer" : `Show all ${g.options.length}`}
                  </button>
                )}
                {g.id === "price" && (
                  <div class="f-range">
                    <label class="money"><span>€</span><input inputMode="decimal" placeholder="min" aria-label="Lowest price" value={state.min}
                      onInput={(e) => setPrice("min", (e.target as HTMLInputElement).value)} /></label>
                    <span aria-hidden="true">to</span>
                    <label class="money"><span>€</span><input inputMode="decimal" placeholder="max" aria-label="Highest price" value={state.max}
                      onInput={(e) => setPrice("max", (e.target as HTMLInputElement).value)} /></label>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Phone: the same filters in a sheet, with the number of cards they'd show on the button. */
export function FilterSheet({ groups, state, onChange, counts, shown, onClose }: {
  groups: Group[]; state: FilterState; onChange: (s: FilterState) => void; counts: Map<string, number>; shown: number; onClose: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div class="sheet-wrap" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Filters">
        <header class="sheet-head no-thumb">
          <div><h2>Filters</h2>{activeCount(state) > 0 && <p>{activeCount(state)} on</p>}</div>
          <button class="icon-btn" type="button" onClick={onClose} aria-label="Close"><IconClose /></button>
        </header>
        <div class="sheet-body"><FilterPanel groups={groups} state={state} onChange={onChange} counts={counts} /></div>
        <footer class="sheet-foot">
          <button class="btn" type="button" disabled={!activeCount(state)} onClick={() => onChange({ sel: {}, min: "", max: "" })}>Clear all</button>
          <button class="btn primary" type="button" onClick={onClose}>Show {shown} {shown === 1 ? "card" : "cards"}</button>
        </footer>
      </div>
    </div>
  );
}
