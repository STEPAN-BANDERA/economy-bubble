#!/usr/bin/env python3
"""Turn one of poe.ninja's past-league data dumps into the price file the Farming tab reads.

    python3 scripts/build_ninja_history.py path/to/Mirage.zip Mirage

poe.ninja publishes the dumps at https://poe.ninja/poe1/data under cc-by-sa. Download a
league's zip by hand, run this, and add the league to PAST_LEAGUES in public/farming.js.
The output is small enough to ship with the site (about 17 KB compressed for a league):
it keeps only the items the Farming cards price from poe.ninja, so run it again for every
league in PAST_LEAGUES after adding a `ninja:` line to a card.

The result is a derived work of poe.ninja's data, so it stays cc-by-sa, not the repo's MIT
licence, and it says so inside the file. What changes from the source is listed in `changes`.
"""
import csv
import io
import json
import re
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FARMING_FILE = REPO_ROOT / "public" / "farming.js"
OUTPUT_DIR = REPO_ROOT / "public" / "data" / "ninja-history"

# Beasts renamed since an older league: the name the dump uses -> the name the cards use.
OLD_NAME_TO_CARD_NAME = {
    "Craicic Chimeral": "Craicic Croaker",  # renamed in 3.29
}

# How a dump labels links. A plain drop is what a farm sells, so linked copies are ignored
# unless there's nothing else (the same rule the tab applies to live poe.ninja prices).
LINK_RANK = {"": 0, "1-4 links": 0, "5 links": 5, "6 links": 6}


def card_items_priced_by_ninja():
    """{item name: poe.ninja type} for every card line with a `ninja:` type in farming.js."""
    source = FARMING_FILE.read_text(encoding="utf8")
    pattern = r"\{ (?:name|item): '((?:[^'\\]|\\.)*)', ninja: '(\w+)'"
    items = {}
    for match in re.finditer(pattern, source):
        name = match.group(1).replace("\\'", "'")
        items[name] = match.group(2)
    return items


def read_prices(archive, league, wanted):
    """{date: {card name: (link rank, chaos)}}, skipping rows poe.ninja rates Low confidence."""
    prices = {}
    with archive.open(f"{league}.items.csv") as raw:
        rows = csv.DictReader(io.TextIOWrapper(raw, encoding="utf8", errors="replace"), delimiter=";", quoting=csv.QUOTE_NONE)
        for row in rows:
            card_name = OLD_NAME_TO_CARD_NAME.get(row["Name"], row["Name"])
            if wanted.get(card_name) != row["Type"]:
                continue
            if row["Confidence"] == "Low":
                continue
            rank = LINK_RANK.get(row["Links"], 0)
            chaos = float(row["Value"])
            day = prices.setdefault(row["Date"], {})
            current = day.get(card_name)
            if current is None or (rank, chaos) < current:
                day[card_name] = (rank, chaos)
    return prices


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    zip_path, league = sys.argv[1], sys.argv[2]
    wanted = card_items_priced_by_ninja()
    with zipfile.ZipFile(zip_path) as archive:
        prices = read_prices(archive, league, wanted)
    if not prices:
        sys.exit(f"No rows for {league} in {zip_path}")

    dates = sorted(prices)
    days = {}
    for date in dates:
        days[date] = {name: round(rank_and_chaos[1], 2) for name, rank_and_chaos in sorted(prices[date].items())}
    found = {name for day in days.values() for name in day}

    output = {
        "league": league,
        "firstDay": dates[0],
        "lastDay": dates[-1],
        "unit": "Chaos Orbs per item, as listed that day",
        "source": "poe.ninja raw economy data dumps, https://poe.ninja/poe1/data",
        "license": "cc-by-sa, as published by poe.ninja; not covered by this repository's MIT licence",
        "changes": "Filtered to the items the Farming tab prices, rows rated Low confidence removed, "
                   "the plainest linked copy kept, values rounded, renamed beasts given their current name.",
        "days": days,
    }
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / f"{league.lower()}.json"
    out_path.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")), encoding="utf8")

    missing = sorted(set(wanted) - found)
    print(f"{out_path.relative_to(REPO_ROOT)}: {len(days)} days, {len(found)} of {len(wanted)} items, {out_path.stat().st_size // 1024} KB")
    if missing:
        print("Never priced:", ", ".join(missing))


if __name__ == "__main__":
    main()
