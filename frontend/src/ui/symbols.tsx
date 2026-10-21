// Magic's own symbols: the set symbol in its rarity colour, and the mana cost as printed.

export function SetSymbol({ set, rarity, title }: { set: string | null; rarity?: string | null; title?: string }) {
  if (!set) return null;
  return (
    <span
      class={`set-sym ${rarity ?? "common"}`}
      style={{ "--src": `url(/sym/sets/${set.toLowerCase()}.svg)` }}
      role="img"
      aria-label={title ?? `${set.toUpperCase()}${rarity ? `, ${rarity}` : ""}`}
    />
  );
}

/** "{2}{U/B}{U}" -> symbol pictures from Scryfall; double faces split by " // ". */
export function ManaCost({ cost, large, front }: { cost: string | null | undefined; large?: boolean; front?: boolean }) {
  if (!cost) return null;
  const faces = front ? cost.split(" // ").slice(0, 1).filter(Boolean) : cost.split(" // ");
  return (
    <span class={`mana${large ? " lg" : ""}`} aria-label={`Mana cost ${cost}`}>
      {faces.map((face, i) => (
        <>
          {i > 0 && <span class="sep">//</span>}
          {[...face.matchAll(/\{([^}]+)\}/g)].map((m) => {
            const code = m[1].replace(/\//g, "").toUpperCase();
            return <img src={`https://svgs.scryfall.io/card-symbols/${encodeURIComponent(code)}.svg`} alt={`{${m[1]}}`} loading="lazy" decoding="async" />;
          })}
        </>
      ))}
    </span>
  );
}
