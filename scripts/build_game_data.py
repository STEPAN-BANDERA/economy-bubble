#!/usr/bin/env python3
"""Build public/data/builds/game-poe1.json, the game knowledge the Build maker's "What people play" view needs:

    python3 scripts/build_game_data.py [--refresh]

From public sources only (scripts/build_sources.py: poewiki.net's data tables and GGG's game files):
- skill gems: name, tags, level and attribute requirements, and two things derived here: the delivery
  (self-cast spell, attack, totem, mine, trap, brand, minion, ...) and the damage types from the tags;
- classes and their ascendancies, each ascendancy's notables, the bloodlines, and the keystones (name and stats);
- unique items: name, category and level requirement (the tab prices them).

--refresh asks the wiki again even when its answers are less than a week old. The wiki is CC BY-NC-SA 3.0, so the
output keeps that licence: see public/data/builds/LICENSE.md.
"""
import json
import sys
from pathlib import Path

from build_sources import load_build_sources
from mechanics_vocabulary import clean_line, split_lines
from text_files import use_utf8_console, write_utf8

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "builds" / "game-poe1.json"

BASE_CLASSES = ["Marauder", "Ranger", "Witch", "Duelist", "Templar", "Shadow", "Scion"]
DAMAGE_TYPES = ["Physical", "Fire", "Cold", "Lightning", "Chaos"]

# How a skill is used, from its tags, in this order: a Totem spell is a totem build first, an Attack with the
# Trap tag is a trap build. Minions are checked by name and description too, because Absolution carries the
# Minion tag although it's cast as a damage spell.
DELIVERY_BY_TAG = [("Totem", "totem"), ("Mine", "mine"), ("Trap", "trap"), ("Brand", "brand")]
MINION_NAME_STARTS = ("Summon ", "Raise ", "Animate ")

# Skills whose damage is mostly damage over time although no tag says so. The Build maker prefers poe.ninja's
# measured damage mode for each archetype and uses this only as the fallback (see public/builds.js).
DAMAGE_OVER_TIME_SKILLS = {
    "Righteous Fire", "Essence Drain", "Contagion", "Blight", "Bane", "Soulrend", "Caustic Arrow", "Toxic Rain",
    "Scorching Ray", "Fire Trap", "Vortex", "Cold Snap", "Wither", "Death Aura", "Forbidden Rite", "Poisonous Concoction",
    "Corrupting Fever", "Exsanguinate", "Reap", "Flameblast", "Incinerate", "Searing Bond", "Venom Gyre",
}
DAMAGE_OVER_TIME_WORDS = ("damage over time", "burning damage", "deals chaos damage over time", "burns")


def readable_stats(text):
    """A node's stat text as plain lines, without the wiki's links and markup."""
    return "\n".join(split_lines(text))


def skill_delivery(gem):
    tags = gem["tags"]
    for tag, delivery in DELIVERY_BY_TAG:
        if tag in tags:
            return delivery
    if is_minion_skill(gem):
        return "minion"
    if "Trigger" in tags:
        return "trigger"
    if "Attack" in tags:
        return "attack"
    if "Spell" in tags:
        return "spell"
    return "other"


def is_minion_skill(gem):
    if "Minion" not in gem["tags"]:
        return False
    if gem["name"].startswith(MINION_NAME_STARTS):
        return True
    if "Golem" in gem["tags"]:
        return True
    description = clean_line(gem["description"]).lower()
    return description.startswith(("summons", "raises", "animates"))


def skill_damage_types(gem):
    types = []
    for damage_type in DAMAGE_TYPES:
        if damage_type in gem["tags"]:
            types.append(damage_type.lower())
    return types


def skill_hit_or_dot_guess(gem):
    if gem["name"] in DAMAGE_OVER_TIME_SKILLS:
        return "dot"
    description = clean_line(gem["description"]).lower()
    for words in DAMAGE_OVER_TIME_WORDS:
        if words in description:
            return "dot"
    return "hit"


def weapon_kind(gem):
    # Attacks say which weapons they can use; a bow attack plays differently from a melee one.
    tags = gem["tags"]
    if "Attack" not in tags:
        return None
    if "Bow" in tags:
        return "bow"
    if "Melee" in tags:
        return "melee"
    if "Projectile" in tags:
        return "projectile"
    return "other"


def build_skills(gems):
    skills = {}
    supports = []
    for gem in gems:
        if not gem["current"]:
            continue
        if gem["isSupport"]:
            supports.append(gem["name"])
            continue
        skills[gem["name"]] = {
            "tags": gem["tags"],
            "delivery": skill_delivery(gem),
            "weapon": weapon_kind(gem),
            "damageTypes": skill_damage_types(gem),
            "hitOrDotGuess": skill_hit_or_dot_guess(gem),
            "levelRequirement": gem["levelRequirement"],
            "attributes": gem["attributeRequirements"],
            "transfigured": gem["transfigured"],
            "aura": "Aura" in gem["tags"],
            "inActivePool": gem["current"],
        }
    return skills, sorted(supports)


def build_classes(passives, class_of_ascendancy):
    ascendancies_by_class = {}
    for base_class in BASE_CLASSES:
        ascendancies_by_class[base_class] = []
    ascendancy_notables = {}
    for node in passives:
        ascendancy = node["ascendancy"]
        if not ascendancy or not node["notable"]:
            continue
        base_class = class_of_ascendancy.get(ascendancy)
        if base_class not in ascendancies_by_class:
            continue
        if ascendancy not in ascendancies_by_class[base_class]:
            ascendancies_by_class[base_class].append(ascendancy)
        ascendancy_notables.setdefault(ascendancy, []).append({"name": node["name"], "stats": readable_stats(node["statText"])})
    for base_class in ascendancies_by_class:
        ascendancies_by_class[base_class].sort()
    for ascendancy in ascendancy_notables:
        ascendancy_notables[ascendancy].sort(key=lambda notable: notable["name"])
    return ascendancies_by_class, ascendancy_notables


def build_keystones(passives, timeless_keystones):
    # The tree's keystones, and the ones timeless jewels grant: poe.ninja lists both among a build's keystones.
    keystones = {}
    for node in passives:
        if node["keystone"] and not node["ascendancy"] and not node["bloodline"]:
            keystones[node["name"]] = {"name": node["name"], "stats": readable_stats(node["statText"])}
    for keystone in timeless_keystones:
        if keystone["name"] not in keystones:
            keystones[keystone["name"]] = {"name": keystone["name"], "stats": readable_stats(keystone["statText"]),
                                           "timelessJewel": keystone["jewel"]}
    return sorted(keystones.values(), key=lambda keystone: keystone["name"])


def build_bloodlines(passives):
    bloodlines = {}
    for node in passives:
        if node["bloodline"]:
            bloodlines.setdefault(node["bloodline"], []).append({"name": node["name"], "stats": readable_stats(node["statText"])})
    for bloodline in bloodlines:
        bloodlines[bloodline].sort(key=lambda notable: notable["name"])
    return bloodlines


def build_uniques(uniques):
    built = {}
    for unique in uniques:
        built[unique["name"]] = {"category": unique["category"], "levelRequirement": unique["levelRequirement"],
                                 "inActivePool": unique["current"]}
    return built


def main():
    sources = load_build_sources(refresh="--refresh" in sys.argv[1:])
    skills, supports = build_skills(sources["gems"])
    ascendancies_by_class, ascendancy_notables = build_classes(sources["passives"], sources["classOfAscendancy"])
    output = {
        "source": sources["source"],
        "patch": sources["patch"],
        "classes": ascendancies_by_class,
        "ascendancyNotables": ascendancy_notables,
        "bloodlines": build_bloodlines(sources["passives"]),
        "keystones": build_keystones(sources["passives"], sources["timelessKeystones"]),
        "skills": skills,
        "supports": supports,
        "uniques": build_uniques(sources["uniques"]),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    write_utf8(OUT, json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    ascendancy_count = sum(len(names) for names in ascendancies_by_class.values())
    print(f"{OUT.relative_to(ROOT)}: {len(skills)} skills, {len(supports)} supports, {ascendancy_count} ascendancies, "
          f"{len(output['keystones'])} keystones, {len(output['bloodlines'])} bloodlines, {len(output['uniques'])} uniques, "
          f"{OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    use_utf8_console()
    main()
