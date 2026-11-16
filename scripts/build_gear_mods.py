#!/usr/bin/env python3
"""Build public/data/craft/gear-poe1.json: the rare-item affixes the Build maker's gear solver (public/buildgear.js)
fills a build's slots with.

    node scripts/run_python.mjs scripts/build_gear_mods.py      (after npm run craft:build)

Source: the Crafting tab's modifier data (public/data/craft/, made by scripts/fetch_craft_data.py from Craft of Exile's
public data files). Like that data, the output is generated locally and not committed; without it the generator
plans with its fixed gear figures instead.

For each slot and defence type (a strength body armour, a dexterity/intelligence helmet, a ring...), every prefix and
suffix that rolls on it (src "base": no influence, essence, veiled or bench mods), with each tier's item level, spawn
weight and effects as scripts/mechanics_vocabulary.py reads the tier's text at the middle of its rolls. Defence lines
on armour pieces are local to the item and marked so; the solver applies them to the item's base.
"""
import json
import re
import sys
from pathlib import Path

from mechanics_vocabulary import read_line_effects
from text_files import read_utf8, use_utf8_console, write_utf8

ROOT = Path(__file__).resolve().parent.parent
CRAFT = ROOT / "public" / "data" / "craft"
OUT = CRAFT / "gear-poe1.json"

# Craft of Exile base ids (public/data/craft/index-poe1.json) for each slot and defence type.
ARMOUR_BASES = {
    "body": {"str": 45, "dex": 46, "int": 47, "str_dex": 48, "str_int": 49, "dex_int": 50},
    "helmet": {"str": 52, "dex": 53, "int": 54, "str_dex": 55, "str_int": 56, "dex_int": 57},
    "gloves": {"str": 33, "dex": 34, "int": 35, "str_dex": 36, "str_int": 37, "dex_int": 38},
    "boots": {"str": 39, "dex": 40, "int": 41, "str_dex": 42, "str_int": 43, "dex_int": 44},
    "offhand": {"str": 5, "dex": 6, "int": 7, "str_dex": 8, "str_int": 9, "dex_int": 10},
}
OTHER_BASES = {"ring": 1, "amulet": 2, "belt": 3, "quiver": 4}

# On an armour piece these stats are the item's own (local): "+# to Armour", "#% increased Energy Shield".
LOCAL_DEFENCE_STATS = {"armour", "evasion", "energyShield", "defences"}
VALUE_MARK = "#"


def middle(value):
    if isinstance(value, list):
        return (value[0] + value[1]) / 2
    return value


def tier_lines(text, values):
    """The mod's text as lines with this tier's values filled in, each "#" by the next value's middle. Hybrid mods
    join their lines with ", " ("+# to Armour, +# to maximum Life")."""
    filled = []
    position = 0
    for part in text.split(", "):
        line = part
        while VALUE_MARK in line and position < len(values):
            number = middle(values[position])
            # Whole numbers as the game shows them; a middle of 10 or more rounds, smaller ones (leech 0.3) stay.
            if float(number).is_integer() or abs(number) >= 10:
                shown = str(int(round(number)))
            else:
                shown = f"{number:g}"
            line = line.replace(VALUE_MARK, shown, 1)
            position += 1
        filled.append(line)
    return filled


def read_tier(text, values, local_slot):
    effects = []
    understood = True
    for line in tier_lines(text, values):
        for found in read_line_effects(line, "roll"):
            if not found.get("understood"):
                understood = False
                continue
            if found["kind"] == "minor":
                continue
            effect = {"kind": found["kind"], "stat": found["stat"]}
            for key in ("tags", "condition", "requires"):
                if found.get(key):
                    effect[key] = found[key]
            if found.get("value") is not None:
                effect["value"] = round(found["value"], 2)
            if found.get("subject") and found["subject"] != "self":
                effect["subject"] = found["subject"]
            is_global = "global" in line.lower()
            if local_slot and found["stat"] in LOCAL_DEFENCE_STATS and found["kind"] in ("flat", "increased") and not is_global:
                effect["local"] = True
            effects.append(effect)
    return effects, understood


def read_base(base_id, local_slot):
    raw = json.loads(read_utf8(CRAFT / f"base-{base_id}.json"))
    mods = []
    unread = 0
    for row in raw["mods"]:
        mod_id, text, affix, source, groups, tags, tiers = row[:7]
        if source != "base" or affix not in ("p", "s"):
            continue
        read_tiers = []
        for tier_index, (item_level, weight, values) in enumerate(tiers):
            effects, understood = read_tier(text, values, local_slot)
            if not understood:
                unread += 1
            if effects:
                # The tier's index in the crafting data, which the Crafting tab's item links name, and its text with
                # the middle of its rolls, for the build cards.
                shown = ", ".join(tier_lines(text, values))
                read_tiers.append([item_level, weight, effects, tier_index, shown])
        if read_tiers:
            mods.append({"id": mod_id, "text": text, "affix": affix, "groups": groups, "tiers": read_tiers})
    return mods, unread


def main():
    use_utf8_console()
    if not (CRAFT / "index-poe1.json").exists():
        # Optional: the generator plans with its fixed gear figures without it, so builds:build carries on.
        print("no crafting data (npm run craft:build): rare gear stays the fixed figures")
        return 0
    bases = {}
    unread_total = 0
    for slot, by_type in ARMOUR_BASES.items():
        for defence_type, base_id in by_type.items():
            mods, unread = read_base(base_id, True)
            bases[f"{slot}:{defence_type}"] = {"slot": slot, "type": defence_type, "craftBase": base_id, "mods": mods}
            unread_total += unread
    for slot, base_id in OTHER_BASES.items():
        mods, unread = read_base(base_id, False)
        bases[slot] = {"slot": slot, "type": None, "craftBase": base_id, "mods": mods}
        unread_total += unread
    write_utf8(OUT, json.dumps({"source": "public/data/craft (Craft of Exile's public data)", "bases": bases},
                               ensure_ascii=False, separators=(",", ":")))
    count = sum(len(base["mods"]) for base in bases.values())
    print(f"gear: {len(bases)} slot bases, {count} affixes ({unread_total} tiers with a line left unread) -> "
          f"{OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
