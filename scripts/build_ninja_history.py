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

from text_files import read_utf8, use_utf8_console, write_utf8

REPO_ROOT = Path(__file__).resolve().parent.parent
FARMING_FILE = REPO_ROOT / "public" / "farming.js"
OUTPUT_DIR = REPO_ROOT / "public" / "data" / "ninja-history"

# Beasts renamed since an older league: the name the dump uses -> the name the cards use.
OLD_NAME_TO_CARD_NAME = {
    "Craicic Chimeral": "Craicic Croaker",  # renamed in 3.29
}

# How a dump labels links. A plain drop is what a farm sells, so the plain copy is kept, unless
# it's more than PLAIN_PRICE_SUSPECT_RATIO times the cheapest linked copy: links never make an
# item worth less, so that plain price is a few absurd listings (the same rule the tab applies
# to live poe.ninja prices, see plainOrLinkedCopy in public/farming.js).
LINK_RANK = {"": 0, "1-4 links": 0, "5 links": 5, "6 links": 6}
FORBIDDEN_JEWEL_TYPE = "ForbiddenJewel"
PLAIN_PRICE_SUSPECT_RATIO = 10


def card_items_priced_by_ninja():
    """{item name: poe.ninja type} for every card line with a `ninja:` type in farming.js."""
    source = read_utf8(FARMING_FILE)
    pattern = r"\{ (?:name|item): '((?:[^'\\]|\\.)*)', ninja: '(\w+)'"
    items = {}
    for match in re.finditer(pattern, source):
        name = match.group(1).replace("\\'", "'")
        items[name] = match.group(2)
    return items


def mean_without_dearest_tenth(values):
    """The average, leaving out the dearest tenth. public/farming.js does the same.

    A Forbidden jewel's price depends on its random ascendancy notable, from 10 Chaos to 10
    Divines and beyond, and a few thin listings at the top would otherwise swamp the average.
    """
    ascending = sorted(values)
    kept_count = max(1, int(len(ascending) * 0.9))
    total = 0.0
    for value in ascending[:kept_count]:
        total += value
    return total / kept_count


def plain_or_linked_copy(copies):
    """(link rank, chaos) for one item on one day, from {link rank: chaos}.

    The plain copy, unless it's more than PLAIN_PRICE_SUSPECT_RATIO times the cheapest linked copy.
    """
    plain_rank = min(copies)
    plain_chaos = copies[plain_rank]
    cheapest_linked = None
    for rank, chaos in copies.items():
        if rank == plain_rank:
            continue
        if cheapest_linked is None or chaos < cheapest_linked[1]:
            cheapest_linked = (rank, chaos)
    if cheapest_linked is not None and plain_chaos > PLAIN_PRICE_SUSPECT_RATIO * cheapest_linked[1]:
        return cheapest_linked
    return (plain_rank, plain_chaos)


def read_prices(archive, league, wanted):
    """{date: {card name: (link rank, chaos)}}, skipping rows poe.ninja rates Low confidence.

    Where a name has several rows at one link rank the cheapest wins; across link ranks, see
    plain_or_linked_copy. For Wombgifts, one row per item level with no level or listing count
    in the dump, that's the same line the tab's "most listings" rule picks today. A card line the dump has no rows for, like corpse items, is
    reported as never priced, and the tab falls back to the line's estimate.
    """
    prices = {}
    copies_by_day = {}  # {date: {card name: {link rank: chaos}}}
    forbidden_values = {}  # {(date, jewel name): [chaos per notable]}
    with archive.open(f"{league}.items.csv") as raw:
        rows = csv.DictReader(io.TextIOWrapper(raw, encoding="utf8", errors="replace"), delimiter=";", quoting=csv.QUOTE_NONE)
        for row in rows:
            # These rows name the notable and give the jewel as the variant.
            if row["Type"] == FORBIDDEN_JEWEL_TYPE:
                if wanted.get(row["Variant"]) == FORBIDDEN_JEWEL_TYPE and row["Confidence"] != "Low":
                    forbidden_values.setdefault((row["Date"], row["Variant"]), []).append(float(row["Value"]))
                continue
            card_name = OLD_NAME_TO_CARD_NAME.get(row["Name"], row["Name"])
            if wanted.get(card_name) != row["Type"]:
                continue
            if row["Confidence"] == "Low":
                continue
            rank = LINK_RANK.get(row["Links"], 0)
            chaos = float(row["Value"])
            copies = copies_by_day.setdefault(row["Date"], {}).setdefault(card_name, {})
            # Several rows at one link rank (Wombgifts by item level): the cheapest.
            if rank not in copies or chaos < copies[rank]:
                copies[rank] = chaos
    for date, copies_by_name in copies_by_day.items():
        day = prices.setdefault(date, {})
        for card_name, copies in copies_by_name.items():
            day[card_name] = plain_or_linked_copy(copies)
    for (date, jewel_name), values in forbidden_values.items():
        prices.setdefault(date, {})[jewel_name] = (0, mean_without_dearest_tenth(values))
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
                   "the plainest linked copy kept unless it's over 10 times a linked one's price, "
                   "the cheapest where a name has several at one link rank (such as Wombgifts), "
                   "values rounded, renamed beasts given their current name, "
                   "Forbidden jewels averaged across their notables without the dearest tenth.",
        "days": days,
    }
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / f"{league.lower()}.json"
    write_utf8(out_path, json.dumps(output, ensure_ascii=False, separators=(",", ":")))

    missing = sorted(set(wanted) - found)
    print(f"{out_path.relative_to(REPO_ROOT)}: {len(days)} days, {len(found)} of {len(wanted)} items, {out_path.stat().st_size // 1024} KB")
    if missing:
        print("Never priced:", ", ".join(missing))


if __name__ == "__main__":
    use_utf8_console()
    main()
