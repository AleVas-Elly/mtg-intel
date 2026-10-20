import httpx

from mtg_intel.archive.cardtrader import Session
from mtg_intel.tables import wishlists
from mtg_intel.tables.wishlists import Wishlist

EXPANSIONS = [
    {"id": 3358, "game_id": 1, "code": "cwoe", "name": "Wilds of Eldraine Collectors"},
    {"id": 3202, "game_id": 5, "code": "sld", "name": "a Pokémon set with a Magic-looking code"},
]
BLUEPRINTS = {
    3358: [
        {"id": 1, "name": "Talion, the Kindly Lord", "expansion_id": 3358,
         "fixed_properties": {"collector_number": "301"}, "scryfall_id": "sf-talion-borderless"},
        {"id": 2, "name": "Ashiok's Reaper", "expansion_id": 3358,
         "fixed_properties": {"collector_number": "310"}, "scryfall_id": "sf-reaper-a"},
        {"id": 3, "name": "Ashiok's Reaper", "expansion_id": 3358,
         "fixed_properties": {"collector_number": "311"}, "scryfall_id": None},
    ]
}


def item(**overrides):
    return {"quantity": 1, "meta_name": "", "expansion_code": "", "collector_number": "", "language": "en",
            "condition": "Near Mint", "foil": "", **overrides}


def test_slug_matches_cardtrader_meta_names():
    assert wishlists.slug("Ashling's Command") == "ashling-s-command"
    assert wishlists.slug("Virtue of Loyalty // Ardenvale Fealty") == "virtue-of-loyalty-ardenvale-fealty"
    assert wishlists.slug("Lim-Dûl the Necromancer") == "lim-dul-the-necromancer"


def test_wantlist_rows_resolve_number_name_and_group_alternatives():
    lists = [
        Wishlist(1, "Showcase", [
            item(meta_name="talion-the-kindly-lord", expansion_code="cwoe", collector_number="301", foil="false"),
            item(meta_name="ashiok-s-reaper", expansion_code="cwoe", collector_number=None),
            item(meta_name="balance", expansion_code=None, collector_number=None, condition=None, language=None),
            item(meta_name="ghost-card", expansion_code="cwoe", collector_number="999"),
        ]),
        Wishlist(2, "buy", [
            item(meta_name="talion-the-kindly-lord", expansion_code="cwoe", collector_number="301", foil="false"),
        ]),
    ]

    rows = wishlists.wantlist_rows(lists, {"cwoe": 3358}, BLUEPRINTS, {"balance": "Balance"})

    assert [(r["name"], r["scryfall_id"], r["cardtrader_blueprint_id"], r["list"], r["one_of"]) for r in rows] == [
        ("Talion, the Kindly Lord", "sf-talion-borderless", "1", "Showcase; buy", ""),  # same wish, two lists
        ("Ashiok's Reaper", "sf-reaper-a", "2", "Showcase", "Ashiok's Reaper (cwoe)"),  # no number: alternatives
        ("Ashiok's Reaper", "", "3", "Showcase", "Ashiok's Reaper (cwoe)"),
        ("Balance", "", "", "Showcase", ""),
        ("ghost-card", "", "", "Showcase", ""),
    ]
    talion, reaper, _, balance, ghost = rows
    assert (talion["foil"], talion["min_condition"], talion["language"], talion["via_zero"]) == ("no", "NM", "en", "yes")
    assert reaper["note"] == "version not chosen on CardTrader: keep the ones you want"
    assert (balance["foil"], balance["min_condition"], balance["language"]) == ("any", "PO", "any")
    assert balance["note"] == "no version on CardTrader: pick one"
    assert ghost["note"] == "CardTrader cwoe 999 not found"


def test_non_foil_wish_skips_foil_only_versions():
    blueprints = {3358: [
        {"id": 1, "name": "Time Warp", "version": None, "fixed_properties": {"collector_number": "085"},
         "scryfall_id": "sf-tw"},
        {"id": 2, "name": "Time Warp", "version": "Etched Foil", "fixed_properties": {"collector_number": "85e"}},
    ]}
    lists = [Wishlist(1, "JP", [item(meta_name="time-warp", expansion_code="cwoe", language="jp", foil="false")])]

    [row] = wishlists.wantlist_rows(lists, {"cwoe": 3358}, blueprints, {})

    assert (row["scryfall_id"], row["language"], row["one_of"], row["note"]) == ("sf-tw", "ja", "", "")


def test_fetch_blueprints_only_for_used_magic_expansions():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v2")
        seen.append(f"{path}?{request.url.query.decode()}".rstrip("?"))
        if path == "/expansions":
            return httpx.Response(200, json=EXPANSIONS)
        return httpx.Response(200, json=BLUEPRINTS[int(request.url.params["expansion_id"])])

    session = Session(httpx.Client(transport=httpx.MockTransport(handler)), "t", None, interval=0)
    lists = [Wishlist(1, "x", [item(expansion_code="cwoe", collector_number="301"), item(expansion_code="sld")])]

    codes, blueprints = wishlists.fetch_blueprints(session, lists)

    assert codes == {"cwoe": 3358}  # sld belongs to another game
    assert list(blueprints) == [3358]
    assert seen == ["/expansions", "/blueprints/export?expansion_id=3358"]


def test_blueprint_without_scryfall_id_is_found_by_set_and_number():
    blueprints = {4310: [
        {"id": 1, "name": "Ephemerate", "fixed_properties": {"collector_number": "044"}, "scryfall_id": "sf-eph"},
        {"id": 2, "name": "Roaming Throne", "fixed_properties": {"collector_number": "099"}, "scryfall_id": None},
    ]}
    printings = {"sf-eph": ("mar", "44"), "sf-throne": ("mar", "99"), "sf-throne-lci": ("lci", "99")}
    lists = [Wishlist(1, "Marvel", [item(meta_name="roaming-throne", expansion_code="mar", collector_number="099")])]

    [row] = wishlists.wantlist_rows(lists, {"mar": 4310}, blueprints, {}, printings)

    assert (row["scryfall_id"], row["cardtrader_blueprint_id"]) == ("sf-throne", "2")

