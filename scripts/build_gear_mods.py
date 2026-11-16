#!/usr/bin/env python3
"""Build public/data/craft/gear-poe1.json: the rare-item affixes the Build maker's gear solver (public/buildgear.js)
fills a build's slots with.

    node scripts/run_python.mjs scripts/build_gear_mods.py      (after npm run craft:build)

Source: the Crafting tab's modifier data (public/data/craft/, made by scripts/fetch_craft_data.py from Craft of Exile's
public data files), and for the caster weapons their bases' implicit and requirements from poewiki.net (cached like the
Build maker's other wiki data). Like the crafting data, the output is generated locally and not committed; without it
the generator plans with its fixed gear figures instead.

For each slot and defence type (a strength body armour, a dexterity/intelligence helmet, a ring...), every prefix and
suffix that rolls on it (src "base": no influence, essence, veiled or bench mods), with each tier's item level, spawn
weight and effects as scripts/mechanics_vocabulary.py reads the tier's text at the middle of its rolls. Defence lines
on armour pieces are local to the item and marked so; the solver applies them to the item's base.

Caster weapons (a spell build's main hand: wand, rune dagger, sceptre, staff) are solved too. A weapon's local lines
(physical damage, attack speed, its own crit chance, flat damage without "to Spells") only change the weapon's attacks,
which a spell build doesn't use, so they are left out.

Attack weapons (2026-11-25): for each weapon type the engine plans (sword, axe, mace, claw, dagger, wand, staff, bow),
the base an endgame crafter picks for physical attacks, the one with the most physical DPS (the same pick as the
engine's weapon model, scripts/build_sources.py), with its damage, speed and crit from poewiki. Here the local lines
are the point: they become weapon stats ("weaponPhysical", "weaponAttackSpeed", "weaponCrit", marked local) that the
engine compares with its reference rare weapon (public/buildgen.js, solvedWeaponFactors), and flat elemental and chaos
damage becomes added attack damage.
"""
import json
import re
import sys
from pathlib import Path

from build_mechanics import LOCAL_WEAPON_LINE, attack_weapon_local_effects, compact_effect
from build_sources import WEAPON_CLASS_TAGS, fetch_weapon_bases, flag, number, whole_number, wiki_text
from mechanics_vocabulary import read_line_effects, split_lines
from poewiki import cargo_rows
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
# A spell build's main hand, by the weapon it is planned with (build.weapon; "shield" holds one of the one-handed
# ones, the solver picks which): Craft of Exile base id and the endgame base a caster crafts on, the highest-level one
# with a spell implicit (Prophecy Wand's spell damage, Void Sceptre's elemental damage, the Skean and Eclipse Staff's
# critical strike chance).
CASTER_WEAPONS = {
    "wand": {"craftBase": 18, "base": "Prophecy Wand"},
    "dagger": {"craftBase": 19, "base": "Imperial Skean"},
    "mace": {"craftBase": 17, "base": "Void Sceptre"},
    "staff": {"craftBase": 21, "base": "Eclipse Staff"},
}

# An attack build's weapon, by weapon type: the Craft of Exile base id of each item class the endgame base may be.
ATTACK_WEAPON_CRAFT_BASES = {
    "One Hand Sword": 13, "Thrusting One Hand Sword": 14, "One Hand Axe": 15, "One Hand Mace": 16, "Claw": 11,
    "Dagger": 12, "Staff": 21, "Bow": 20, "Wand": 18, "Two Hand Sword": 22, "Two Hand Axe": 24, "Two Hand Mace": 23,
}
TWO_HANDED_TYPES = {"staff", "bow", "twoHandSword", "twoHandAxe", "twoHandMace"}

# On an armour piece these stats are the item's own (local): "+# to Armour", "#% increased Energy Shield".
LOCAL_DEFENCE_STATS = {"armour", "evasion", "energyShield", "defences"}
VALUE_MARK = "#"


# On a weapon these are its own attacks' too (on a ring they are global): life gained per hit with it, and its
# accuracy rating.
WEAPON_ATTACK_LINE = re.compile(r"^(?:Grants [\d.]+ Life per Enemy Hit|\+[\d.]+ to Accuracy Rating)$")


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


def read_tier(text, values, local_slot, weapon=False, attack_weapon=False):
    effects = []
    understood = True
    for line in tier_lines(text, values):
        if attack_weapon and LOCAL_WEAPON_LINE.match(line):
            local = attack_weapon_local_effects(line)
            if local is None:
                understood = False
            else:
                effects.extend(local)
            continue
        if weapon and (LOCAL_WEAPON_LINE.match(line) or WEAPON_ATTACK_LINE.match(line)):
            continue  # the weapon's own attacks: nothing for a spell build
        for found in read_line_effects(line, "roll"):
            if not found.get("understood"):
                understood = False
                continue
            if found["kind"] == "minor":
                continue
            # Every field the mechanics keep (a skill named by "+1 to Level of all Raise Spectre Gems" was dropped
            # before 2026-11-27, so the line counted for every gem).
            effect = compact_effect(found)
            is_global = "global" in line.lower()
            # A defence line with a condition ("+3600 to Armour during Soul Gain Prevention") isn't the item's own.
            if (local_slot and found["stat"] in LOCAL_DEFENCE_STATS and found["kind"] in ("flat", "increased")
                    and not is_global and not found.get("condition")):
                effect["local"] = True
            effects.append(effect)
    return effects, understood


def read_base(base_id, local_slot, weapon=False, attack_weapon=False, eldritch=False):
    """Every affix the base rolls, from every source the crafting data knows: the base pool, the six influences,
    essences, veiled mods, bench crafts, beast crafts and fossil-only mods, each with its source and tags (the solver
    limits how many of a source an item holds). With eldritch, the Searing Exarch ("r") and Eater of Worlds ("b")
    implicits too (body armour, helmets, gloves and boots)."""
    raw = json.loads(read_utf8(CRAFT / f"base-{base_id}.json"))
    mods = []
    unread = 0
    sides = ("p", "s", "r", "b") if eldritch else ("p", "s")
    for row in raw["mods"]:
        mod_id, text, affix, source, groups, tags, tiers = row[:7]
        if affix not in sides:
            continue
        read_tiers = []
        for tier_index, (item_level, weight, values) in enumerate(tiers):
            effects, understood = read_tier(text, values, local_slot, weapon, attack_weapon)
            if not understood:
                unread += 1
            if effects:
                # The tier's index in the crafting data, which the Crafting tab's item links name, and its text with
                # the middle of its rolls, for the build cards.
                shown = ", ".join(tier_lines(text, values))
                read_tiers.append([item_level, weight, effects, tier_index, shown])
        if read_tiers:
            mods.append({"id": mod_id, "text": text, "affix": affix, "source": source, "tags": tags, "groups": groups,
                         "tiers": read_tiers})
    return mods, unread


def fetch_caster_bases():
    """The caster weapon bases' implicit text and requirements: {base name: row}."""
    return fetch_base_rows("caster-weapon-bases", [weapon["base"] for weapon in CASTER_WEAPONS.values()])


def fetch_base_rows(cache_name, base_names):
    """Named item bases' implicit text and requirements from poewiki: {base name: row}."""
    names = ", ".join('"' + name + '"' for name in base_names)
    rows = cargo_rows(
        cache_name, tables="items",
        fields=["items.name", "items.implicit_stat_text", "items.required_level", "items.required_strength",
                "items.required_dexterity", "items.required_intelligence"],
        where=f'items.rarity_id="normal" AND items.name IN ({names})', order_by="items.name")
    found = {}
    for row in rows:
        found[wiki_text(row.get("name"))] = row
    return found


def implicit_effects(row):
    """The base's implicit lines as effects, read at the middle of their rolls like the affixes."""
    effects = []
    for line in split_lines(wiki_text(row.get("implicit_stat_text") or "")):
        for found in read_line_effects(line, "roll"):
            if not found.get("understood") or found["kind"] == "minor":
                continue
            effects.append(compact_effect(found))
    return effects


def caster_weapon_bases():
    """gear-poe1.json's weapon entries: "weapon:<type>" with the base's implicit, requirements and spell-relevant mods."""
    rows = fetch_caster_bases()
    entries = {}
    unread_total = 0
    for weapon_type, weapon in CASTER_WEAPONS.items():
        row = rows.get(weapon["base"])
        if row is None:
            print(f"  {weapon['base']} isn't on poewiki: no {weapon_type} for spell builds")
            continue
        mods, unread = read_base(weapon["craftBase"], False, weapon=True)
        requirements = {"str": whole_number(row.get("required_strength")) or 0,
                        "dex": whole_number(row.get("required_dexterity")) or 0,
                        "int": whole_number(row.get("required_intelligence")) or 0}
        entries[f"weapon:{weapon_type}"] = {
            "slot": "weapon", "type": weapon_type, "craftBase": weapon["craftBase"], "baseName": weapon["base"],
            "implicit": implicit_effects(row), "implicitText": "\n".join(split_lines(wiki_text(row.get("implicit_stat_text") or ""))),
            "requirements": requirements, "mods": mods}
        unread_total += unread
    return entries, unread_total


def endgame_attack_bases():
    """Per weapon type, the base with the most physical DPS (as scripts/build_sources.py picks for the engine), with
    its item class: {type: {"name", "class", "physicalMin", "physicalMax", "attackSpeed", "crit"}}."""
    best = {}
    for row in fetch_weapon_bases(False):
        weapon_type = WEAPON_CLASS_TAGS.get(row.get("class_id"))
        if weapon_type is None or not flag(row.get("is_in_game")):
            continue
        low = number(row.get("physical_damage_min")) or 0
        high = number(row.get("physical_damage_max")) or 0
        speed = number(row.get("attack_speed")) or 0
        if speed <= 0 or high <= 0:
            continue
        base = {"name": wiki_text(row.get("name")), "class": row.get("class_id"), "physicalMin": low,
                "physicalMax": high, "attackSpeed": speed, "crit": number(row.get("critical_strike_chance")) or 5}
        held = best.get(weapon_type)
        if held is None or (low + high) * speed > (held["physicalMin"] + held["physicalMax"]) * held["attackSpeed"]:
            best[weapon_type] = base
    return best


def attack_weapon_bases(items_by_craft_base):
    """gear-poe1.json's attack weapon entries: "weapon:attack-<type>" with the endgame base's damage, speed, crit,
    implicit and requirements (the engine's reference for the type), every mod with its local lines as weapon stats,
    and the other bases of the type worth holding (baseItems: within ATTACK_BASE_DPS_SHARE of its physical DPS)."""
    bases = endgame_attack_bases()
    rows = fetch_base_rows("attack-weapon-bases", [base["name"] for base in bases.values()])
    stats_by_name = attack_base_stats()
    entries = {}
    unread_total = 0
    for weapon_type, base in sorted(bases.items()):
        row = rows.get(base["name"])
        craft_base = ATTACK_WEAPON_CRAFT_BASES.get(base["class"])
        if row is None or craft_base is None:
            print(f"  {base['name']} isn't on poewiki or in the crafting data: no rare {weapon_type} for attack builds")
            continue
        mods, unread = read_base(craft_base, False, attack_weapon=True)
        requirements = {"str": whole_number(row.get("required_strength")) or 0,
                        "dex": whole_number(row.get("required_dexterity")) or 0,
                        "int": whole_number(row.get("required_intelligence")) or 0}
        best_dps = (base["physicalMin"] + base["physicalMax"]) * base["attackSpeed"]
        others = []
        for item in items_by_craft_base.get(craft_base, []):
            stats = stats_by_name.get(item["name"])
            if stats is None or WEAPON_CLASS_TAGS.get(stats["class"]) != weapon_type:
                continue
            dps = (stats["physicalMin"] + stats["physicalMax"]) * stats["attackSpeed"]
            if dps >= best_dps * ATTACK_BASE_DPS_SHARE:
                others.append({**item, "physicalMin": stats["physicalMin"], "physicalMax": stats["physicalMax"],
                               "attackSpeed": stats["attackSpeed"], "crit": stats["crit"], "dps": dps})
        entries[f"weapon:attack-{weapon_type}"] = {
            "slot": "weapon", "type": weapon_type, "attack": True, "twoHanded": weapon_type in TWO_HANDED_TYPES,
            "craftBase": craft_base, "baseName": base["name"], "physicalMin": base["physicalMin"],
            "physicalMax": base["physicalMax"], "attackSpeed": base["attackSpeed"], "crit": base["crit"],
            "implicit": implicit_effects(row),
            "implicitText": "\n".join(split_lines(wiki_text(row.get("implicit_stat_text") or ""))),
            "requirements": requirements, "mods": mods,
            "baseItems": best_per_implicit(others, key=lambda item: item["dps"])}
        unread_total += unread
    return entries, unread_total


def attack_base_stats():
    """{base name: physical damage, attack speed, crit and item class} for every weapon base in the game."""
    stats = {}
    for row in fetch_weapon_bases(False):
        if not flag(row.get("is_in_game")):
            continue
        low = number(row.get("physical_damage_min")) or 0
        high = number(row.get("physical_damage_max")) or 0
        speed = number(row.get("attack_speed")) or 0
        if speed <= 0 or high <= 0:
            continue
        stats[wiki_text(row.get("name"))] = {"class": row.get("class_id"), "physicalMin": low, "physicalMax": high,
                                             "attackSpeed": speed, "crit": number(row.get("critical_strike_chance")) or 5}
    return stats


# ---------- base items ----------
# Every base item the crafting data lists (index.bitems: name -> crafting base), with what the wiki says of it: its
# implicit, requirements, level and (armour pieces) defences, and what the crafting data says: an Experimented base's
# changes (more or fewer prefixes or suffixes, larger values, every influence) and a base whose implicit stops mods
# rolling (Cryonic Ring, Kinetic Wand). The solver picks one per slot (public/buildgear.js).
ATTACK_BASE_DPS_SHARE = 0.85  # attack bases kept beside the endgame one: at least this share of its physical DPS
BASE_ITEM_CLASSES = ["Ring", "Amulet", "Belt", "Quiver", "Shield", "Body Armour", "Helmet", "Gloves", "Boots", "Wand",
                     "Rune Dagger", "Sceptre", "Staff", "Warstaff", "One Hand Sword", "Thrusting One Hand Sword",
                     "One Hand Axe", "One Hand Mace", "Claw", "Dagger", "Bow", "Two Hand Sword", "Two Hand Axe",
                     "Two Hand Mace"]
ENERGY_SHIELD_PER_RATING = 4  # to rank bases of one defence type by their defences (our weighting)


def fetch_base_item_rows():
    classes = ", ".join('"' + name + '"' for name in BASE_ITEM_CLASSES)
    rows = cargo_rows(
        "gear-base-items", tables="items,armours", join_on="items._pageName=armours._pageName",
        fields=["items.name", "items.class_id", "items.implicit_stat_text", "items.required_level",
                "items.required_strength", "items.required_dexterity", "items.required_intelligence",
                "items.is_in_game", "armours.armour_range_average", "armours.evasion_range_average",
                "armours.energy_shield_range_average"],
        where=f'items.rarity_id="normal" AND items.class_id IN ({classes})', order_by="items.name")
    found = {}
    for row in rows:
        if flag(row.get("is_in_game")):
            found[wiki_text(row.get("name"))] = row
    return found


def base_items_by_craft_base(index):
    """{crafting base id: [base item]}, each the best base of its implicit (see best_per_implicit)."""
    rows = fetch_base_item_rows()
    experimented = index.get("experimented") or {}
    limits = index.get("limits") or {}
    grouped = {}
    missing = 0
    for name, craft_base in (index.get("bitems") or {}).items():
        row = rows.get(name)
        if row is None:
            missing += 1
            continue
        implicit_text = "\n".join(split_lines(wiki_text(row.get("implicit_stat_text") or "")))
        item = {"name": name, "level": whole_number(row.get("required_level")) or 0,
                "implicit": implicit_effects(row), "implicitText": implicit_text,
                "requirements": {"str": whole_number(row.get("required_strength")) or 0,
                                 "dex": whole_number(row.get("required_dexterity")) or 0,
                                 "int": whole_number(row.get("required_intelligence")) or 0}}
        for field, column in (("armour", "armour_range_average"), ("evasion", "evasion_range_average"),
                              ("energyShield", "energy_shield_range_average")):
            value = number(row.get(column))
            if value:
                item[field] = value
        if name in experimented:
            item["exp"] = experimented[name]
        if name in limits:
            item["limit"] = limits[name]
        grouped.setdefault(craft_base, []).append(item)
    if missing:
        print(f"  {missing} base items of the crafting data aren't on poewiki (left out)")
    return {craft_base: best_per_implicit(items, key=base_rank) for craft_base, items in grouped.items()}


def base_rank(item):
    defences = item.get("armour", 0) + item.get("evasion", 0) + ENERGY_SHIELD_PER_RATING * item.get("energyShield", 0)
    return (defences, item["level"])


def best_per_implicit(items, key):
    """One base per implicit (and per Experimented change or limit): the best by key. Bases with the same implicit
    differ only in level and defences, so the rest add nothing; best first."""
    best = {}
    for item in items:
        group = (item["implicitText"], json.dumps(item.get("exp"), sort_keys=True), json.dumps(item.get("limit"), sort_keys=True))
        if group not in best or key(item) > key(best[group]):
            best[group] = item
    return sorted(best.values(), key=key, reverse=True)


def main():
    use_utf8_console()
    if not (CRAFT / "index-poe1.json").exists():
        # Optional: the generator plans with its fixed gear figures without it, so builds:build carries on.
        print("no crafting data (npm run craft:build): rare gear stays the fixed figures")
        return 0
    index = json.loads(read_utf8(CRAFT / "index-poe1.json"))
    items_by_craft_base = base_items_by_craft_base(index)
    bases = {}
    unread_total = 0
    for slot, by_type in ARMOUR_BASES.items():
        for defence_type, base_id in by_type.items():
            eldritch = bool(index["bases"].get(str(base_id), {}).get("eldritch"))
            mods, unread = read_base(base_id, True, eldritch=eldritch)
            bases[f"{slot}:{defence_type}"] = {"slot": slot, "type": defence_type, "craftBase": base_id, "mods": mods,
                                               "baseItems": items_by_craft_base.get(base_id, [])}
            unread_total += unread
    for slot, base_id in OTHER_BASES.items():
        mods, unread = read_base(base_id, False)
        bases[slot] = {"slot": slot, "type": None, "craftBase": base_id, "mods": mods,
                       "baseItems": items_by_craft_base.get(base_id, [])}
        unread_total += unread
    weapons, unread = caster_weapon_bases()
    for entry in weapons.values():
        entry["baseItems"] = items_by_craft_base.get(entry["craftBase"], [])
    bases.update(weapons)
    unread_total += unread
    weapons, unread = attack_weapon_bases(items_by_craft_base)
    bases.update(weapons)
    unread_total += unread
    write_utf8(OUT, json.dumps({"source": "public/data/craft (Craft of Exile's public data); base items from poewiki.net",
                                "bases": bases}, ensure_ascii=False, separators=(",", ":")))
    count = sum(len(base["mods"]) for base in bases.values())
    items = sum(len(base["baseItems"]) for base in bases.values())
    print(f"gear: {len(bases)} slot bases, {items} base items, {count} affixes ({unread_total} tiers with a line left "
          f"unread) -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
