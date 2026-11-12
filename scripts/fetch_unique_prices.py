#!/usr/bin/env python3
"""Save poe.ninja's unique item prices for the running league, for the build generator's price weighing.

    python3 scripts/fetch_unique_prices.py [--refresh]

Writes .cache/ninja/unique-prices-<league url>.json: {league, fetched, divineChaos, prices: {unique name: chaos}}.
It is a cache, not shipped data: scripts/generate_builds.mjs reads it when it is there and plans price-blind when it
isn't. Six requests, one a second apart (five unique types and the exchange rates); an answer under a day old is
reused unless --refresh is given.

A unique listed several times (by links, or by variant) is priced as its unlinked line with the most listings, the
copy most players buy: the same rule as the build maker's budget (public/buildmaker.js), so both agree.

Between leagues poe.ninja's economy can drop a league its build data still lists (Allflame, 2026-11-11). The prices
then come from Standard, which ranks uniques from cheap to chase much as a league does, and the file says so
("pricesFrom").
"""
import json
import sys
import time
import urllib.parse
from pathlib import Path

from snapshot_ninja_prices import API_ROOT, SECONDS_BETWEEN_REQUESTS, fetch_json
from text_files import read_utf8, use_utf8_console, write_utf8

ROOT = Path(__file__).resolve().parent.parent
LEAGUES_FILE = ROOT / "public" / "data" / "builds" / "leagues-poe1.json"
CACHE = ROOT / ".cache" / "ninja"
UNIQUE_TYPES = ["UniqueWeapon", "UniqueArmour", "UniqueAccessory", "UniqueFlask", "UniqueJewel"]
SECONDS_KEPT = 24 * 3600
FALLBACK_LEAGUE = "Standard"


def current_league():
    leagues = json.loads(read_utf8(LEAGUES_FILE))["leagues"]
    for league in leagues:
        if league["current"]:
            return league
    raise SystemExit(f"no current league in {LEAGUES_FILE.relative_to(ROOT)}; run scripts/fetch_build_meta.py first")


def output_path(league):
    return CACHE / f"unique-prices-{league['url']}.json"


def is_recent(path):
    if not path.exists():
        return False
    return time.time() - path.stat().st_mtime < SECONDS_KEPT


def remember_most_common_line(prices, listings, linked, line):
    """Keeps, per name, the unlinked line with the most listings (a linked line only until a plain one shows up)."""
    chaos = line.get("chaosValue")
    if chaos is None or chaos <= 0:
        return
    name = line.get("name")
    is_linked = bool(line.get("links"))
    count = line.get("listingCount") or 0
    if name not in prices:
        prices[name] = chaos
        listings[name] = count
        linked[name] = is_linked
        return
    replaces_linked_with_plain = linked[name] and not is_linked
    busier_of_same_kind = linked[name] == is_linked and count > listings[name]
    if replaces_linked_with_plain or busier_of_same_kind:
        prices[name] = chaos
        listings[name] = count
        linked[name] = is_linked


def fetch_unique_prices(league_name):
    prices = {}
    listings = {}
    linked = {}
    for item_type in UNIQUE_TYPES:
        query = urllib.parse.urlencode({"league": league_name, "type": item_type})
        body = fetch_json(f"{API_ROOT}/stash/current/item/overview?{query}")
        for line in body.get("lines", []):
            remember_most_common_line(prices, listings, linked, line)
        time.sleep(SECONDS_BETWEEN_REQUESTS)
    return prices


def fetch_divine_chaos(league_name):
    query = urllib.parse.urlencode({"league": league_name, "type": "Currency"})
    body = fetch_json(f"{API_ROOT}/exchange/current/overview?{query}")
    divines_per_chaos = body["core"]["rates"]["divine"]
    if not divines_per_chaos or divines_per_chaos <= 0:
        raise SystemExit("poe.ninja gave no Divine Orb rate")
    return 1 / divines_per_chaos


def main():
    league = current_league()
    path = output_path(league)
    if is_recent(path) and "--refresh" not in sys.argv[1:]:
        print(f"unique prices for {league['league']} are under a day old: {path.relative_to(ROOT)}")
        return
    prices_from = league["league"]
    prices = fetch_unique_prices(prices_from)
    if not prices:
        print(f"poe.ninja has no unique prices for {prices_from} now; using {FALLBACK_LEAGUE}")
        prices_from = FALLBACK_LEAGUE
        prices = fetch_unique_prices(prices_from)
    if not prices:
        raise SystemExit("poe.ninja gave no unique prices")
    divine_chaos = fetch_divine_chaos(prices_from)
    CACHE.mkdir(parents=True, exist_ok=True)
    data = {"league": league["league"], "pricesFrom": prices_from, "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "divineChaos": round(divine_chaos, 1), "prices": prices}
    write_utf8(path, json.dumps(data, ensure_ascii=False, indent=0))
    print(f"{len(prices)} unique prices from {prices_from} for {league['league']} (1 Divine = {divine_chaos:.0f} chaos) -> {path.relative_to(ROOT)}")


if __name__ == "__main__":
    use_utf8_console()
    main()
