// Shapes of the documents the backend sends (backend/src/mtg_intel/site.py).

export interface Flag { code: string; text: string }

export interface CardmarketPrices {
  trend?: number; trend_foil?: number; low?: number; low_foil?: number; avg7?: number; avg7_foil?: number; date?: string;
}

export interface Wish {
  key: string; line: number; name: string; set: string | null; set_name: string | null; number: string | null;
  tags: string[]; finishes: string[]; rarity: string | null; mana_cost: string | null; type_line: string | null;
  artist: string | null; released: string | null; scryfall_id: string | null; blueprint_id: number | null;
  cardmarket_id: number | null; image: string | null; thumb: string | null; lists: string[]; one_of: string | null;
  note: string | null; quantity: number; language: string; foil: "yes" | "no" | "any"; condition: string;
  zero: boolean; max_price: number | null; deal_pct: number | null; cm: CardmarketPrices;
  ct: { name: string; version: string | null; code: string | null; expansion: string | null; number: string | null } | null;
  links: { cardmarket: string | null; cardtrader: string | null; scryfall: string | null };
  flags: Flag[];
  pending?: "add" | "update" | "remove";
  prints?: string;  // a card being added: where Scryfall lists its other printings  // a change made on the site, not yet in the want-list file
}

export interface WantsDoc { built_at: string; price_date: string | null; languages: Record<string, string>; wishes: Wish[] }

export interface Listing { id: number; price: number; condition: string; language: string; foil: boolean; zero: boolean; country: string }

export interface LiveWish extends Listing { count: number; usual: number | null; usual_kind: string }

export interface Deal {
  key: string; listing: Listing; cardmarket: number | null; cardtrader: number | null; cardtrader_kind: string;
  below_pct: number | null; tier: number | null; target: boolean; reasons: string[]; since: string; gone_at?: string;
}

export interface LiveDoc {
  checked_at: string; cards_checked: number; failed: number; wishes: Record<string, LiveWish>;
  empty: string[]; deals: Deal[]; gone: Deal[];
}

export interface HistoryDoc { base: string | null; cards: Record<string, Record<string, Record<string, number[]>>> }

export interface RecentDoc { t: string[]; p: Record<string, (number | null)[]> }

export type CtHistoryDoc = Record<string, [string, number][]>;

/** Wish settings as the want-list CSV spells them (backend mycards.EDITABLE). */
export interface Settings {
  language?: string; foil?: string; min_condition?: string; via_zero?: string; max_price_eur?: string;
  deal_pct?: string; quantity?: string; list?: string; note?: string;
}

/** A purchase as the site sends it (backend mycards.PURCHASE_COLUMNS, as strings). */
export interface PurchaseInput {
  price_eur: string; market: "cardtrader" | "cardmarket" | "other"; condition: string; foil: "yes" | "no";
  language: string; date: string; cardmarket_trend_eur: string;
}

export interface Edit {
  id: string; at: string; op: "add" | "update" | "remove" | "bought"; key?: string; scryfall_id?: string;
  settings?: Settings; card?: Partial<Wish>; purchase?: PurchaseInput; message?: string;
}

export interface Purchase {
  n: number; date: string; name: string; set: string | null; number: string | null; scryfall_id: string | null;
  language: string | null; foil: boolean; condition: string; price: number; market: string; cardmarket: number | null;
  saved: number | null; thumb: string | null; rarity: string | null; tags: string[]; set_name: string | null; lists: string[];
  pending?: boolean;
}

export interface PurchasesDoc { built_at: string; purchases: Purchase[] }

export interface EditsDoc { ops: Edit[]; failed: Edit[] }
