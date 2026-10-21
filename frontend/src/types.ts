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
