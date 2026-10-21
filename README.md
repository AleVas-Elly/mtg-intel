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
uv run mtg-intel search "art:cat is:showcase"       # Scryfall search over my cards (--in all for every card)
uv run mtg-intel want add <scryfall-id> --list Showcase  # add a printing to the want-list (want remove to drop it)
```

In Claude Code, ask in plain words instead ("which of my wants have a dragon in the art?"): the
`cards` skill in `.claude/skills/cards` turns questions into Scryfall searches and runs these commands.

## On-time timer

GitHub starts scheduled workflows late or skips them, so a Cloudflare Worker (`infra/trigger`) starts
`deals` every 10 minutes and `grab` three times a day through `workflow_dispatch`. Deploy with
`npx wrangler deploy` from `infra/trigger`; its secrets are listed in `wrangler.toml`.

## Website

`frontend/` is a private web app (Preact + Vite + TypeScript) served by one Cloudflare Worker,
which also does passkey sign-in and serves the data from Cloudflare KV. The GitHub jobs send small
JSON documents to it after every table build and deal check (`backend/src/mtg_intel/site.py`,
`SITE_URL` and `SITE_INGEST_TOKEN` secrets).

```
cd frontend
npm install
npm run check    # type-check app and Worker
npm run deploy   # build and deploy
```

The Worker's secrets (`SESSION_SECRET`, `INGEST_TOKEN`) are listed in `wrangler.toml`.
