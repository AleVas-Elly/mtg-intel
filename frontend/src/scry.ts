// Scryfall's card objects, as the site reads them from its search API (D45).
import type { Wish } from "./types";

/** Cards seen in search results this session, so their pane opens without asking Scryfall again. */
export const known = new Map<string, ScryCard>();

export async function fetchCard(id: string): Promise<ScryCard> {
  const hit = known.get(id);
  if (hit) return hit;
  const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Scryfall doesn't know this card.");
  const card = (await response.json()) as ScryCard;
  known.set(id, card);
  return card;
}

export interface ScryCard {
  id: string; name: string; set: string; collector_number: string; rarity: string; finishes: string[];
  image_uris?: { small: string; normal: string };
  card_faces?: { mana_cost?: string; image_uris?: { small: string; normal: string } }[];
  scryfall_uri: string; set_name: string; mana_cost?: string; type_line?: string; artist?: string; released_at?: string;
  border_color?: string; full_art?: boolean; frame?: string; frame_effects?: string[]; promo_types?: string[];
  prints_search_uri?: string; lang?: string; cardmarket_id?: number; set_type?: string;
}

// The same special-version tags as backend reference.build_cards.
const FRAME_TAGS = ["showcase", "extendedart", "etched"];
const FOIL_TAGS = ["serialized", "textured", "galaxyfoil", "surgefoil", "halofoil", "confettifoil", "ripplefoil", "raisedfoil",
  "doublerainbow", "neonink", "oilslick", "gilded", "stepandcompleat", "rainbowfoil", "fracturefoil", "manafoil"];

/** A Scryfall card as a wish preview, shown until the want-list file has it (D50). */
export function preview(c: ScryCard): Wish {
  const tags = [
    ...(c.border_color === "borderless" ? ["borderless"] : []), ...(c.full_art ? ["fullart"] : []),
    ...((c.frame === "1993" || c.frame === "1997") && (c.released_at ?? "") >= "2020-01-01" ? ["retroframe"] : []),
    ...(c.frame_effects ?? []).filter((t) => FRAME_TAGS.includes(t)), ...(c.promo_types ?? []).filter((t) => FOIL_TAGS.includes(t)),
  ];
  return {
    key: `${c.id}|en|any`, line: 0, name: c.name, set: c.set, set_name: c.set_name, number: c.collector_number, tags,
    finishes: c.finishes, rarity: c.rarity, mana_cost: c.mana_cost ?? c.card_faces?.map((f) => f.mana_cost).filter(Boolean).join(" // ") ?? null,
    type_line: c.type_line ?? null, artist: c.artist ?? null, released: c.released_at ?? null, scryfall_id: c.id,
    blueprint_id: null, cardmarket_id: c.cardmarket_id ?? null, image: c.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal ?? null,
    thumb: c.image_uris?.small ?? c.card_faces?.[0]?.image_uris?.small ?? null, lists: [], one_of: null, note: null,
    quantity: 1, language: "en", foil: "any", condition: "NM", zero: true, max_price: null, deal_pct: null, cm: {}, ct: null,
    links: { cardmarket: null, cardtrader: null, scryfall: c.scryfall_uri }, flags: [], prints: c.prints_search_uri,
  };
}

/** Every paper printing of a card, newest first (Scryfall's prints search). */
export async function printings(uri: string): Promise<ScryCard[]> {
  const out: ScryCard[] = [];
  let next: string | undefined = uri.replace("unique=prints", "unique=prints&order=released&dir=desc");
  for (let page = 0; next && page < 4; page++) {
    const response: Response = await fetch(next, { headers: { Accept: "application/json" } });
    if (!response.ok) break;
    const body = (await response.json()) as { data: (ScryCard & { games?: string[] })[]; has_more: boolean; next_page?: string };
    const paper = body.data.filter((c) => !c.games || c.games.includes("paper"));
    paper.forEach((c) => known.set(c.id, c));
    out.push(...paper);
    next = body.has_more ? body.next_page : undefined;
  }
  return out;
}
