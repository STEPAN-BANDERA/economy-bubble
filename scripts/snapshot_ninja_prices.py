#!/usr/bin/env python3
"""Save poe.ninja's current prices for the Farming cards' items, for the running league.

    python3 scripts/snapshot_ninja_prices.py --output path/to/snapshots-checkout

poe.ninja's API has no daily history, and its data dumps only appear once a league is over,
so the Farming tab can't show a running league's real item prices at earlier stages unless
someone saves them along the way. .github/workflows/ninja-snapshots.yml runs this every six
hours and commits the result to the `snapshots` branch.

Each snapshot is <output>/snapshots/<league>/<YYYY-MM-DD>T<HH>.json. Only the items the cards
name are kept: this is a record for the tab, not a copy of poe.ninja. Items listed many times
over (Wombgifts, Forbidden jewels, corpses) get one price each, by the tab's rules. When a league's dump
is published, it replaces that league's snapshots (see scripts/build_ninja_history.py).

Exit codes: 0 when a snapshot was saved or there was nothing to do yet; 1 on any failure,
without saving a partial snapshot, so GitHub emails the owner instead of hiding a gap.
"""
import argparse
import datetime
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from build_ninja_history import FORBIDDEN_JEWEL_TYPE, card_items_priced_by_ninja, mean_without_dearest_tenth

API_ROOT = "https://poe.ninja/poe1/api/economy"
# poe.ninja's API docs ask for a User-Agent that names the app and a contact.
USER_AGENT = "faustus-ledger snapshots (+https://github.com/STEPAN-BANDERA/economy-bubble)"
REQUEST_TIMEOUT_SECONDS = 30
SECONDS_BETWEEN_REQUESTS = 1  # the docs ask for reasonable concurrency: one at a time, spaced out
RETRY_WAIT_SECONDS = 20
TYPES_PRICED_BY_BUSIEST_LINE = {"Wombgift"}
CORPSE_TYPE = "Corpse"

# The early league moves fastest (the top players reach endgame by the end of day one, and the
# wider crowd over the next days), so every run counts for this long. After that, one a day.
DAYS_OF_FREQUENT_SNAPSHOTS = 14

# The league name becomes a folder name, so it's checked rather than trusted.
SAFE_LEAGUE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 '_-]{0,59}$")


class SnapshotFailed(Exception):
    """Anything that should fail the run rather than save a doubtful snapshot."""


def fetch_json(url):
    """GET a JSON document, trying once more if poe.ninja has a bad moment."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    last_error = None
    for attempt in range(2):
        if attempt > 0:
            time.sleep(RETRY_WAIT_SECONDS)
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            last_error = error
    raise SnapshotFailed(f"{url}: {last_error}")


def current_league():
    """The challenge league's name. poe.ninja's docs say it's always the first entry.

    Between leagues the first entry can be a permanent one, which needs no snapshots, since
    its prices aren't what the league stages are about. Returns None then.
    """
    leagues = fetch_json(f"{API_ROOT}/leagues")
    if not isinstance(leagues, list) or not leagues:
        raise SnapshotFailed(f"Unexpected answer from the leagues endpoint: {leagues!r:.200}")
    league = leagues[0].get("id")
    if not isinstance(league, str) or not SAFE_LEAGUE_NAME.match(league):
        raise SnapshotFailed(f"Unexpected league name: {league!r:.100}")
    if league in ("Standard", "Hardcore"):
        return None
    return league


def plainest_price(lines, wanted_names):
    """{name: {chaos, listings}} for wanted items, keeping the plainest linked copy of each.

    A 6-link and an unlinked copy of a unique are separate lines; a drop is usually plain.
    """
    plainest = {}
    for line in lines:
        name = line.get("name")
        chaos = line.get("chaosValue")
        if name not in wanted_names or not isinstance(chaos, (int, float)) or chaos <= 0:
            continue
        links = line.get("links") or 0
        current = plainest.get(name)
        if current is None or links < current[0]:
            plainest[name] = (links, chaos, line.get("listingCount"))
    prices = {}
    for name, (_, chaos, listings) in plainest.items():
        prices[name] = {"chaos": round(chaos, 2), "listings": listings}
    return prices


def busiest_price(lines, wanted_names):
    """{name: {chaos, listings}} for wanted items, keeping the line with the most listings of each.

    Wombgifts have one line per item level, with prices apart by up to six times. The busiest
    is what most players farm and sell. The tab applies the same rule to live prices.
    """
    busiest = {}
    for line in lines:
        name = line.get("name")
        chaos = line.get("chaosValue")
        if name not in wanted_names or not isinstance(chaos, (int, float)) or chaos <= 0:
            continue
        listings = line.get("listingCount") or 0
        current = busiest.get(name)
        if current is None or listings > current["listings"]:
            busiest[name] = {"chaos": round(chaos, 2), "listings": listings}
    return busiest


def forbidden_jewel_price(lines, wanted_names):
    """{jewel: {chaos, listings}}, one price across all of each Forbidden jewel's notables.

    Each line names a notable and gives the jewel as its variant. The tab applies the same rule.
    """
    values_by_jewel = {}
    listings_by_jewel = {}
    for line in lines:
        jewel = line.get("variant")
        chaos = line.get("chaosValue")
        if jewel not in wanted_names or not isinstance(chaos, (int, float)) or chaos <= 0:
            continue
        values_by_jewel.setdefault(jewel, []).append(chaos)
        listings_by_jewel[jewel] = listings_by_jewel.get(jewel, 0) + (line.get("listingCount") or 0)
    prices = {}
    for jewel, values in values_by_jewel.items():
        prices[jewel] = {"chaos": round(mean_without_dearest_tenth(values), 2), "listings": listings_by_jewel[jewel]}
    return prices


def corpse_price(lines, wanted_names):
    """{card's corpse line: {chaos, listings}}, one price across every corpse monster.

    A card can't say which corpses drop, so its line stands for them all. The tab applies the same rule.
    """
    values = []
    total_listings = 0
    for line in lines:
        chaos = line.get("chaosValue")
        if not isinstance(chaos, (int, float)) or chaos <= 0:
            continue
        values.append(chaos)
        total_listings += line.get("listingCount") or 0
    prices = {}
    if values:
        for name in wanted_names:
            prices[name] = {"chaos": round(mean_without_dearest_tenth(values), 2), "listings": total_listings}
    return prices


def fetch_card_prices(league, wanted):
    """Every wanted item poe.ninja has a price for, one item type per request."""
    names_by_type = {}
    for name, item_type in wanted.items():
        names_by_type.setdefault(item_type, set()).add(name)

    prices = {}
    for item_type in sorted(names_by_type):
        query = urllib.parse.urlencode({"league": league, "type": item_type})
        body = fetch_json(f"{API_ROOT}/stash/current/item/overview?{query}")
        if not isinstance(body, dict) or not isinstance(body.get("lines"), list):
            raise SnapshotFailed(f"Unexpected answer for {item_type}: {body!r:.200}")
        if item_type == FORBIDDEN_JEWEL_TYPE:
            prices.update(forbidden_jewel_price(body["lines"], names_by_type[item_type]))
        elif item_type == CORPSE_TYPE:
            prices.update(corpse_price(body["lines"], names_by_type[item_type]))
        elif item_type in TYPES_PRICED_BY_BUSIEST_LINE:
            prices.update(busiest_price(body["lines"], names_by_type[item_type]))
        else:
            prices.update(plainest_price(body["lines"], names_by_type[item_type]))
        time.sleep(SECONDS_BETWEEN_REQUESTS)
    return prices


def should_snapshot(league_folder, now):
    """Every run early in the league, then the first run of each day."""
    existing = sorted(league_folder.glob("*.json"))
    if not existing:
        return True
    first_date = datetime.date.fromisoformat(existing[0].stem[:10])
    league_age_days = (now.date() - first_date).days
    if league_age_days < DAYS_OF_FREQUENT_SNAPSHOTS:
        return True
    today = now.date().isoformat()
    for path in existing:
        if path.stem.startswith(today):
            return False
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", required=True, help="Where the snapshots branch is checked out")
    args = parser.parse_args()

    # An empty list means the card file is out of date, not that there's nothing to save:
    # on a checkout without the Farming cards' poe.ninja lines this must fail, not go quiet.
    wanted = card_items_priced_by_ninja()
    if not wanted:
        raise SnapshotFailed("No poe.ninja items found in public/farming.js")

    league = current_league()
    if league is None:
        print("No challenge league on poe.ninja right now; nothing to do.")
        return

    now = datetime.datetime.now(datetime.timezone.utc)
    league_folder = Path(args.output) / "snapshots" / league
    if not should_snapshot(league_folder, now):
        print(f"{league}: already have today's snapshot, and the early league is over.")
        return

    prices = fetch_card_prices(league, wanted)
    if not prices:
        # A new league can be listed before it has any prices. That isn't a failure.
        print(f"{league}: poe.ninja has no prices for these items yet; nothing saved.")
        return

    snapshot = {
        "league": league,
        "takenAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "unit": "Chaos Orbs per item, as listed on poe.ninja at that time",
        "source": "poe.ninja economy API, https://poe.ninja/economy",
        "items": dict(sorted(prices.items())),
    }
    league_folder.mkdir(parents=True, exist_ok=True)
    out_path = league_folder / f"{now.strftime('%Y-%m-%dT%H')}.json"
    out_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=0) + "\n", encoding="utf8")
    print(f"{out_path}: {len(prices)} of {len(wanted)} items")


if __name__ == "__main__":
    try:
        main()
    except SnapshotFailed as failure:
        sys.exit(f"Snapshot failed: {failure}")
