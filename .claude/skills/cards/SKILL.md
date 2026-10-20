---
name: cards
description: Answer plain-language questions about Magic cards in mtg-intel (my want-list, my collection, or all cards) and add or remove want-list cards. Use when the user asks things like "which of my wants have a cat in the art", "Marvel characters under 10 euros", "blue instants by this artist", "add all the showcases from the new set", or "stop watching this card".
---

# Card search and want-list edits

The user asks in plain words; you turn the question into a Scryfall search, run it with the project
CLI, and answer from the result. Scryfall does the matching (text, types, costs, artists, frames and
the community art and function tags); our tables add Cardmarket prices, the want-list and the
collection. All commands run from `backend/`.

## 1. Make sure the tables are local

If `data/tables/reference/cards.parquet` is missing or older than a day, run
`uv run mtg-intel sync-tables` first.

## 2. Write the Scryfall query

Translate the question into Scryfall syntax (https://scryfall.com/docs/syntax). The parts used most:

| Ask | Syntax |
|---|---|
| words in the rules text | `o:"draw a card"`, `o:flying`, `kw:flying` (keyword) |
| card type / subtype | `t:creature`, `t:legendary`, `t:dragon`, `t:instant` |
| colours / commander colours | `c:u`, `c>=wr`, `c:colorless`, `id<=bg` |
| mana cost / value | `m:{2}{U}{U}`, `mv<=2`, `mv=3` |
| power, toughness, loyalty | `pow>=4`, `tou<2`, `loy=3` |
| artist | `a:"Rebecca Guay"` |
| what the art shows | `art:cat`, `art:dragon`, `art:spider-man`, `art:superhero` (tag names are lowercase, hyphenated) |
| what the card does | `function:removal`, `function:ramp`, `function:tutor`, `function:board-wipe` |
| set, number, rarity | `s:msh`, `cn:401`, `r:mythic` |
| special versions | `is:showcase`, `border:borderless`, `is:extendedart`, `is:fullart`, `is:etched`, `is:serialized`, `frame:1997`, `is:retro` |
| finishes | `is:foil`, `is:nonfoil` |
| legality | `f:commander`, `f:modern`, `banned:legacy` |
| release date | `year=2025`, `date>=2025-01-01` |
| combine | spaces mean AND, `or`, `-` to negate, parentheses to group |

Notes:
- Universes Beyond franchises have no `is:` keyword. Use their sets, found with
  `uv run mtg-intel query "select distinct set_code, set_name from cards where set_name ilike '%marvel%'"`
  (e.g. `s:msh or s:msc or s:mar or s:spm or s:spe or s:pspm`), or art tags (`art:superhero`, `art:spider-man`).
- Art and function tags are made by Scryfall's community and are not complete. If a tag finds
  nothing, the tag name is probably wrong: try a broader or differently spelled tag before saying
  no card matches.
- Leave prices out of the query: Scryfall's `eur:` is not our Cardmarket trend. Filter on the
  `trend` / `trend_foil` values in the result instead.

## 3. Run the search

```
uv run mtg-intel search "<query>" --in mine --json
```

- `--in`: `mine` (want-list and collection, the default), `wantlist`, `collection`, or `all`.
  Questions about "my cards" stay in `mine`; "is there a card that…" or "add all … from the new set"
  need `all`.
- With `--in all`, Scryfall returns one row per card; add `--prints` to get every printing (needed
  when the user cares about versions, e.g. before adding to the want-list).
- A Scryfall error means the query is wrong: fix it and run again.

The JSON lists `cards` with `scryfall_id`, `name`, `set_code`, `collector_number`, `special_tags`,
`mana_cost`, `type_line`, `artist`, `trend`, `trend_foil` (Cardmarket EUR), `wanted_in` (want-lists)
and `owned` (collection quantity). For text or flavour questions on known cards, SQL works too:
`uv run mtg-intel query "select name, oracle_text from cards where …"`.

## 4. Answer

Lead with the answer, then a compact table (name, set + number, version, trend, wanted/owned).
Always show the Scryfall query you ran, so the user can correct the interpretation. Say when the
result was cut short or when the answer leans on community tags.

## Adding and removing want-list cards

Every wish names an exact printing (a Scryfall ID), never just a card name.

1. Search with `--prints` and show the exact printings you would add, with the settings you will use.
   Defaults: English, NM or better, foil or not, CardTrader Zero only, no target price. Ask for a
   list name if the user did not give one.
2. Add only after the user confirms:
   `uv run mtg-intel want add <scryfall_id> … --list "<name>" [--lang en] [--foil any|yes|no] [--cond NM] [--zero yes] [--max-price 12.50] [--one-of "<group>"] [--note "…"]`
   `--one-of` groups alternatives: buying any one fulfils the wish.
3. Remove: `uv run mtg-intel want remove <scryfall_id> … [--list "<name>"]`.

Both commands upload the want-list and rebuild the tables (about a minute), so the change is live
when they finish.
