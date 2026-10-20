# mtg-intel

Personal Magic: The Gathering price archive and buy-timing assistant, built on Cardmarket (EUR) data.


## Backend

```bash
cd backend
uv sync
uv run pytest
```

## Using the tables

```bash
cd backend
uv run mtg-intel sync-tables                       # download the tables to data/tables
uv run mtg-intel price "Elvish Archdruid" --set fdn  # Cardmarket price history of a card
uv run mtg-intel query "select * from wantlist"    # any SQL (DuckDB) over the tables
uv run mtg-intel my-cards --wantlist my-wants.csv  # upload my want-list (template: backend/templates/wantlist.csv)
uv run mtg-intel import-wishlists                  # list my CardTrader wishlists; pass IDs to turn them into a want-list CSV
```
