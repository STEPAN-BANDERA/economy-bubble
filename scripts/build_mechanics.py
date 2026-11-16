#!/usr/bin/env python3
"""Build public/data/builds/mechanics-poe1.json: everything the build generator knows about Path of Exile 1's
pieces, read into effects it can reason with.

    python3 scripts/build_mechanics.py [--refresh]

Sources (all public, gathered by scripts/build_sources.py): GGG's passive tree export for keystones, notables and
ascendancy notables; poewiki.net's data tables (CC BY-NC-SA 3.0) for gems and uniques; GGG's game files for the
skill types of every skill and each support's rules (which skill types it supports, adds and excludes). The
rules are exact, so which support fits which skill is never guessed from text.

Every stat line goes through scripts/mechanics_vocabulary.py (our own reading of the game's wording). The lines it
couldn't read go to .cache/mechanics-unread.json, and a coverage report is printed and saved in the file, so the
vocabulary can be taught what it misses. --refresh asks the wiki and GGG again even when their answers are recent.
"""
import json
import re
import sys
import time
from pathlib import Path

from build_sources import load_build_sources
from radius_jewels import radius_rules_of
from timeless_conquest import conquests_of
from mechanics_vocabulary import is_buff_line, read_line_effects, split_lines
from text_files import use_utf8_console, write_utf8

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "builds" / "mechanics-poe1.json"
TREE_OUT = ROOT / "public" / "data" / "builds" / "tree-poe1.json"

# Item classes in weapon restrictions -> the weapon tags the vocabulary uses.
WEAPON_TAGS = {
    "Bow": "bow", "Wand": "wand", "Staff": "staff", "Warstaff": "staff", "One Hand Sword": "sword",
    "Two Hand Sword": "sword", "Thrusting One Hand Sword": "sword", "One Hand Axe": "axe", "Two Hand Axe": "axe",
    "One Hand Mace": "mace", "Two Hand Mace": "mace", "Sceptre": "mace", "Claw": "claw", "Dagger": "dagger",
    "Rune Dagger": "dagger", "Shield": "shield",
}
# The two-handed melee classes a skill's weapon rule allows, as the generator's two-handed weapon kinds: "sword" in
# a skill's weapons doesn't say whether a two-handed sword is allowed (Dual Strike takes one-handers only).
TWO_HANDED_WEAPON_KINDS = {"Two Hand Sword": "twoHandSword", "Two Hand Axe": "twoHandAxe", "Two Hand Mace": "twoHandMace"}

# Skill types (GGG's names) -> the scope tags of the vocabulary. A skill's tags decide which effects reach it.
TYPE_TAGS = {
    "Attack": "attack", "Spell": "spell", "Projectile": "projectile", "Area": "area", "Minion": "minion",
    "CreatesMinion": "minion", "SummonsTotem": "totem", "Trapped": "trap", "RemoteMined": "mine", "Brand": "brand",
    "Aura": "aura", "AppliesCurse": "curse", "Hex": "curse", "Warcry": "warcry", "Herald": "herald",
    "Channel": "channel", "Slam": "slam", "Melee": "melee", "Vaal": "vaal", "Golem": "golem", "DamageOverTime": "dot",
    "Fire": "fire", "Cold": "cold", "Lightning": "lightning", "Chaos": "chaos", "Physical": "physical",
    "CausesBurning": "ignite", "Duration": "duration", "Chains": "chain", "Orb": "orb", "Strike": "strike",
    # The tree's "Retaliation Skills deal 30% increased Damage", "Link Skills have ...", "Mark Skills have ..." and
    # "... of Stance Skills" lines reach only skills of that type.
    "Retaliation": "retaliation", "Link": "link", "Mark": "mark", "Stance": "stance",
}
DAMAGE_TYPES = ["physical", "fire", "cold", "lightning", "chaos"]
# Types that mark a skill as one a build is made around (not a buff, aura, movement skill or curse).
MAIN_SKILL_TYPES = {"Damage", "Attack", "DamageOverTime", "CreatesMinion", "CausesBurning"}
NOT_MAIN_SKILL_TYPES = {"Aura", "Herald", "Blink", "Travel", "Hex", "AppliesCurse", "Warcry", "Guard", "Vaal",
                        "Banner", "Link", "Golem", "Buff"}


# ---------- GGG's game files ----------
def type_names(indexes, skill_types):
    names = []
    for index in indexes or []:
        names.append(skill_types[index]["Id"])
    return names


def weapon_tags(indexes, item_classes):
    tags = []
    for index in indexes or []:
        # The class id ("One Hand Mace"), not its display name, which is plural ("One Hand Maces") and matched nothing.
        name = item_classes[index]["Id"]
        tag = WEAPON_TAGS.get(name)
        if tag is not None and tag not in tags:
            tags.append(tag)
    return tags


def two_handed_weapon_kinds(indexes, item_classes):
    kinds = []
    for index in indexes or []:
        kind = TWO_HANDED_WEAPON_KINDS.get(item_classes[index]["Id"])
        if kind is not None and kind not in kinds:
            kinds.append(kind)
    return kinds


def rules_by_effect_id(tables):
    """GrantedEffects id -> its skill types and, for supports, which skill types it supports, adds and excludes.
    Allowed and excluded lists are GGG's postfix expressions: OR, AND and NOT combine the entries before them."""
    skill_types = tables["ActiveSkillType"]
    item_classes = tables["ItemClasses"]
    active_skills = tables["ActiveSkills"]
    rules = {}
    for granted in tables["GrantedEffects"]:
        rule = {
            "isSupport": bool(granted["IsSupport"]),
            "allowed": type_names(granted["AllowedActiveSkillTypes"], skill_types),
            "added": type_names(granted["AddedActiveSkillTypes"], skill_types),
            "excluded": type_names(granted["ExcludedActiveSkillTypes"], skill_types),
            "addedMinion": type_names(granted["AddedMinionActiveSkillTypes"], skill_types),
            "gemsOnly": bool(granted["SupportsGemsOnly"]),
            "cannotBeSupported": bool(granted["CannotBeSupported"]),
            "ignoreMinionTypes": bool(granted["IgnoreMinionTypes"]),
            "supportWeapons": weapon_tags(granted["SupportWeaponRestrictions"], item_classes),
        }
        if granted["ActiveSkill"] is not None:
            active = active_skills[granted["ActiveSkill"]]
            rule["types"] = type_names(active["ActiveSkillTypes"], skill_types)
            rule["minionTypes"] = type_names(active["MinionActiveSkillTypes"], skill_types)
            rule["weapons"] = weapon_tags(active["WeaponRestriction_ItemClassesKeys"], item_classes)
            rule["twoHandedWeapons"] = two_handed_weapon_kinds(active["WeaponRestriction_ItemClassesKeys"], item_classes)
        rules[granted["Id"]] = rule
    return rules


# ---------- reading stat text ----------
class Coverage:
    """Counts how many stat lines of each source were understood, and keeps the ones that weren't."""

    def __init__(self):
        self.read = {}
        self.total = {}
        self.unread = {}

    def count(self, source, line, understood):
        self.total[source] = self.total.get(source, 0) + 1
        if understood:
            self.read[source] = self.read.get(source, 0) + 1
            return
        self.unread.setdefault(source, {})
        self.unread[source][line] = self.unread[source].get(line, 0) + 1

    def report(self):
        summary = {}
        for source, total in self.total.items():
            summary[source] = round(100 * self.read.get(source, 0) / total, 1)
        return summary


# Item categories whose damage and defence lines are local: they raise that item's own numbers, not the
# character's. A unique's local lines are left out, because a good rare item of the same kind offers about as
# much; what makes a unique worth building around is its other lines.
WEAPON_CATEGORIES = {"Wand", "Staff", "Warstaff", "Bow", "Claw", "Dagger", "Rune Dagger", "One Hand Sword",
                     "Thrusting One Hand Sword", "Two Hand Sword", "One Hand Axe", "Two Hand Axe", "One Hand Mace",
                     "Two Hand Mace", "Sceptre"}
ARMOUR_CATEGORIES = {"Body Armour", "Helmet", "Gloves", "Boots", "Shield"}
LOCAL_WEAPON_LINE = re.compile(
    r"^(?:\+?\(?[\d.-]+\)?%? (?:increased|reduced) (?:Physical Damage|Attack Speed|Critical Strike Chance|Elemental Damage)"
    r"|Adds \(?[\d.-]+\)? to \(?[\d.-]+\)? (?:Physical|Fire|Cold|Lightning|Chaos) Damage"
    r"|\+?\(?[\d.-]+\)?% to Critical Strike Chance"
    r"|Gain \(?[\d.-]+\)?% of Weapon Physical Damage as Extra Damage of (?:a random Element|each Element))$", re.IGNORECASE)
LOCAL_ARMOUR_LINE = re.compile(
    # "Armour, Evasion and Energy Shield" lists them with a comma too (Shadowstitch; read as a global line until
    # 2026-11-27).
    r"^(?:\+?\(?[\d.-]+\)?%? increased (?:Armour|Evasion Rating|Evasion|Energy Shield|Ward)(?:(?:,| and) (?:Armour|Evasion Rating|Evasion|Energy Shield))*"
    r"|\+?\(?[\d.-]+\)? to (?:Armour|Evasion Rating|maximum Energy Shield|Ward))$", re.IGNORECASE)


def is_local_line(category, line):
    if category in WEAPON_CATEGORIES:
        return LOCAL_WEAPON_LINE.match(line) is not None
    if category in ARMOUR_CATEGORIES:
        return LOCAL_ARMOUR_LINE.match(line) is not None
    return False


def effects_of(text, source, range_mode, coverage, category=None):
    """All effects of a stat text block, plus the lines nothing understood. With a unique's category, its local
    lines are counted as read and left out."""
    effects = []
    unread = []
    for line in split_lines(text):
        if category is not None and is_local_line(category, line):
            coverage.count(source, line, True)
            continue
        line_effects = read_line_effects(line, range_mode)
        understood = True
        for found in line_effects:
            if not found.get("understood"):
                understood = False
                continue
            found = dict(found)
            found.pop("understood", None)
            found.pop("leftover", None)
            if found["kind"] == "minor":
                continue
            effects.append(compact_effect(found))
        coverage.count(source, line, understood)
        if not understood:
            unread.append(line)
    # The lines nothing understood go to the coverage report (.cache/mechanics-unread.json), not the shipped file.
    return effects, unread


def compact_effect(found):
    """Drops empty fields so the shipped file stays small."""
    compact = {"kind": found["kind"], "stat": found["stat"]}
    if found.get("tags"):
        compact["tags"] = found["tags"]
    if found.get("value") is not None:
        compact["value"] = round(found["value"], 2)
    if found.get("subject") and found["subject"] != "self":
        compact["subject"] = found["subject"]
    if found.get("condition"):
        compact["condition"] = found["condition"]
    if found.get("requires"):
        compact["requires"] = found["requires"]
    if found.get("from"):
        compact["from"] = found["from"]
    if found.get("socketed"):
        compact["socketed"] = True
    if found.get("skill"):
        compact["skill"] = found["skill"]
    # "perDefence" lines (damage from a defence): how they count, which defence, and how much of it one value needs.
    for key in ("as", "defence", "per"):
        if found.get(key) is not None:
            compact[key] = found[key]
    return compact


# ---------- gems ----------
def cost_type_of(wiki_cost_type):
    """The wiki's cost type ("Mana", "Life", "Energy Shield", "Mana per second") as 'mana', 'life' or 'es'."""
    lowered = (wiki_cost_type or "mana").lower()
    if lowered.startswith("life"):
        return "life"
    if lowered.startswith("energy shield"):
        return "es"
    return "mana"


def skill_tags(types, weapons):
    tags = []
    for type_name in types:
        tag = TYPE_TAGS.get(type_name)
        if tag is not None and tag not in tags:
            tags.append(tag)
    for weapon in weapons:
        if weapon not in tags:
            tags.append(weapon)
    return tags


def damage_types_of(types, effects, stat_text):
    """The damage types a skill deals before any conversion: its own type tags, and the types named in its
    "Deals ... Damage" lines."""
    found = []
    for damage_type in DAMAGE_TYPES:
        if damage_type.capitalize() in types:
            found.append(damage_type)
    lowered = (stat_text or "").lower()
    for damage_type in DAMAGE_TYPES:
        if damage_type in found:
            continue
        if f"{damage_type} damage" in lowered and ("deals" in lowered or "base" in lowered):
            found.append(damage_type)
    if not found and "Attack" in types:
        found.append("physical")  # attacks deal their weapon's damage, which is physical on most bases
    return found


# Skills typed as a Buff that are still a build's main damage: Righteous Fire burns enemies for a share of your life
# and energy shield, and whole builds are made around it.
MAIN_BUFF_SKILL_IDS = {"RighteousFire"}


def is_main_skill(types, skill_id=None):
    if skill_id in MAIN_BUFF_SKILL_IDS:
        return True
    if not (MAIN_SKILL_TYPES & set(types)):
        return False
    if NOT_MAIN_SKILL_TYPES & set(types):
        return False
    return True


# Skills a build runs beside its main skill for what they grant: of these only the lines worded as the buff or the
# curse are kept (a herald's own burning damage or summoned minions aren't something it gives the main skill).
BUFF_SKILL_TYPES = {"Aura", "Herald", "Hex", "AppliesCurse", "Banner"}


def is_buff_skill(types, skill_id=None):
    return not is_main_skill(types, skill_id) and bool(BUFF_SKILL_TYPES & set(types))


def read_gems(gems, rules, coverage):
    skills = {}
    supports = {}
    missing_rules = []
    for gem in gems:
        if not gem["current"]:
            continue
        rule = rules.get(gem["skillId"])
        if rule is None:
            missing_rules.append(gem["name"])
            continue
        if gem["isSupport"]:
            effects, unread = effects_of(gem["statText"], "support", "level", coverage)
            supports[gem["name"]] = {
                "id": gem["skillId"],
                "allowed": rule["allowed"], "added": rule["added"], "excluded": rule["excluded"],
                "addedMinion": rule["addedMinion"], "gemsOnly": rule["gemsOnly"],
                "ignoreMinionTypes": rule["ignoreMinionTypes"], "weapons": rule["supportWeapons"],
                "attributes": gem["requires"], "level": gem["levelRequirement"],
                "awakened": gem["name"].startswith("Awakened "),
                # Trigger supports (Cast on Death, Cast when Damage Taken...) need a second skill or an event the
                # generator doesn't model yet.
                "trigger": "Triggered" in rule["added"] or "InbuiltTrigger" in rule["added"],
                "exceptional": gem["dropRestricted"],
                # The cost of a supported skill is multiplied by this, in percent (100 when the wiki has none).
                "costMultiplier": gem.get("costMultiplier") or 100,
                "effects": effects,
            }
            continue
        if gem["isVaal"]:
            continue
        types = rule.get("types", [])
        weapons = rule.get("weapons", [])
        stat_text = gem["statText"]
        if is_buff_skill(types, gem["skillId"]):
            stat_text = "\n".join(line for line in split_lines(stat_text) if is_buff_line(line))
        effects, unread = effects_of(stat_text, "skill", "level", coverage)
        skills[gem["name"]] = {
            "id": gem["skillId"],
            "types": types, "minionTypes": rule.get("minionTypes", []), "weapons": weapons,
            "twoHandedWeapons": rule.get("twoHandedWeapons", []),
            "tags": skill_tags(types, weapons),
            "damageTypes": damage_types_of(types, effects, gem["statText"]),
            "main": is_main_skill(types, gem["skillId"]),
            "cannotBeSupported": rule["cannotBeSupported"],
            "attributes": gem["requires"], "level": gem["levelRequirement"],
            "castTime": gem["castTime"],
            "effectiveness": gem["effectiveness"],
            "attackSpeedMultiplier": gem["attackSpeedMultiplier"],
            "baseCrit": gem["baseCrit"],
            "transfigured": gem["transfigured"],
            "effects": effects,
        }
        if gem.get("reservation"):
            skills[gem["name"]]["reservation"] = gem["reservation"]
        if gem.get("reservationFlat"):
            skills[gem["name"]]["reservationFlat"] = gem["reservationFlat"]
        # What one use costs at gem level 20, and whether in mana or life; skills without a cost have none here.
        if gem.get("cost"):
            skills[gem["name"]]["cost"] = {"amount": gem["cost"], "type": cost_type_of(gem["costType"])}
    return skills, supports, missing_rules


# ---------- main skills that a unique gives ----------
# Archetypes built around a skill no gem gives: the unique grants or triggers it, and the support gems socketed in
# that unique support it (the game's rule for item-granted skills). Each entry names the unique, the skill's
# GrantedEffects id in GGG's game files (its types come from there) and what the set-up needs besides.
#
# Soulwrest (poewiki): "Trigger Level 25 Summon Phantasm Skill when you Consume a corpse". The Phantasms are the
# build's damage, supported by the gems in the staff's six sockets. The skill isn't a gem, so it takes no socket
# and costs nothing; corpses are made and consumed by other gems, two of them as a player's report has it
# (2026-11-21: "cyclone+desecrate+offering"; Desecrate makes corpses, an Offering consumes one), which take sockets
# the buffs would otherwise have. Its level is the item's, so lines that raise gem levels don't reach it.
UNIQUE_MAIN_SKILLS = [
    {"unique": "Soulwrest", "name": "Summon Phantasm (Soulwrest)", "effectId": "TriggeredSummonGhostOnKill",
     "weapon": "staff", "level": 25, "setupGems": 2, "damageTypes": ["physical"]},
]


def read_unique_main_skills(uniques, rules):
    """The UNIQUE_MAIN_SKILLS whose unique and game-file skill both exist, as main skills like the gems'."""
    unique_names = {unique["name"] for unique in uniques}
    skills = {}
    for spec in UNIQUE_MAIN_SKILLS:
        rule = rules.get(spec["effectId"])
        if spec["unique"] not in unique_names or rule is None or "types" not in rule:
            print(f"  {spec['name']}: no {spec['unique']} or no game-file skill {spec['effectId']}, left out")
            continue
        weapons = [spec["weapon"]]
        skills[spec["name"]] = {
            "id": spec["effectId"],
            "types": rule["types"], "minionTypes": rule["minionTypes"], "weapons": weapons,
            "tags": skill_tags(rule["types"], weapons),
            "damageTypes": spec["damageTypes"],
            "main": True,
            "cannotBeSupported": rule["cannotBeSupported"],
            "attributes": [], "level": 1,
            "castTime": None, "effectiveness": 100.0, "attackSpeedMultiplier": 100.0, "baseCrit": None,
            "transfigured": False,
            "effects": [],
            "grantedBy": spec["unique"],
            "fixedLevel": spec["level"],
            "setupGems": spec["setupGems"],
        }
    return skills


# ---------- passives and uniques ----------
def read_passives(passives, class_of_ascendancy, coverage):
    """Ascendancy notables, keystones and tree notables from GGG's tree export. Bloodline nodes and notables that
    can only be anointed aren't pieces the generator picks."""
    ascendancies = {}
    keystones = []
    notables = []
    for node in passives:
        if node["bloodline"] or node["anointOnly"]:
            continue
        if node["ascendancy"]:
            if not node["notable"]:
                continue
            effects, unread = effects_of(node["statText"], "ascendancy", "roll", coverage)
            ascendancy = ascendancies.setdefault(node["ascendancy"], {"class": class_of_ascendancy.get(node["ascendancy"]), "notables": []})
            ascendancy["notables"].append({"name": node["name"], "effects": effects})
            continue
        if node["keystone"]:
            effects, unread = effects_of(node["statText"], "keystone", "roll", coverage)
            keystones.append({"name": node["name"], "effects": effects})
            continue
        effects, unread = effects_of(node["statText"], "notable", "roll", coverage)
        notables.append({"name": node["name"], "effects": effects})
    return ascendancies, keystones, notables


def read_bloodlines(graphs, coverage):
    """Each bloodline's notables as pieces the generator can pick: a notable's effects with those of the small
    passives on the path to it, and its cost in ascendancy points (the nodes on that path, the free start left out).
    Leaves past a notable (skills it grants, jewel-conditional smalls) aren't offered."""
    bloodlines = {}
    for bloodline, nodes in graphs.items():
        start = next((node_id for node_id, node in nodes.items() if node["start"]), None)
        if start is None:
            continue
        parent = {start: None}
        queue = [start]
        while queue:
            current = queue.pop(0)
            for other in nodes[current]["out"]:
                if other in nodes and other not in parent:
                    parent[other] = current
                    queue.append(other)
        notables = []
        for node_id, node in nodes.items():
            if not node["notable"] or node_id not in parent:
                continue
            path = []
            step = node_id
            while step is not None and step != start:
                path.append(step)
                step = parent[step]
            effects = []
            for step in reversed(path):
                step_effects, unread = effects_of(nodes[step]["statText"], "bloodline", "roll", coverage)
                effects.extend(step_effects)
            if effects:
                notables.append({"name": node["name"], "points": len(path), "effects": effects})
        if notables:
            notables.sort(key=lambda notable: notable["name"])
            bloodlines[bloodline] = {"notables": notables}
    return bloodlines


def read_flasks(flasks, coverage):
    """Utility flasks with their buff read into effects, and the best life flask. A flask none of whose buff lines
    could be read is left out: the generator can't value it."""
    utility = []
    for flask in flasks["utility"]:
        effects, unread = effects_of(flask["buffText"], "flask", "roll", coverage)
        if not effects:
            continue
        utility.append({"name": flask["name"], "level": flask["level"], "duration": flask["duration"],
                        "chargesMax": flask["chargesMax"], "chargesPerUse": flask["chargesPerUse"], "effects": effects})
    life = flasks["life"]
    return {"utility": utility, "life": {"name": life["name"], "life": life["life"], "duration": life["duration"]} if life else None}


def read_jewels(jewel_mods, large_clusters, coverage):
    """Rare jewel modifiers and large cluster jewel types, read into effects. A modifier or notable none of whose
    lines could be read is left out; a cluster type keeps the notables that were read."""
    mods = []
    seen = set()
    for mod in jewel_mods:
        if mod["statText"] in seen:
            continue
        seen.add(mod["statText"])
        effects, unread = effects_of(mod["statText"], "jewel mod", "roll", coverage)
        if effects:
            # The text without wiki markup ("[[Life]]"), one line per stat, for showing.
            mods.append({"id": mod["id"], "side": mod["side"], "text": "\n".join(split_lines(mod["statText"])), "effects": effects})
    clusters = []
    for cluster in large_clusters:
        small, unread = effects_of(cluster["smallText"], "cluster small", "roll", coverage)
        notables = []
        for notable in cluster["notables"]:
            effects, unread = effects_of(notable["statText"], "cluster notable", "roll", coverage)
            if effects:
                notables.append({"name": notable["name"], "effects": effects})
        if small or notables:
            clusters.append({"name": cluster["name"], "small": small, "notables": notables})
    return {"mods": mods, "largeClusters": clusters}


# GGG's tree export is drawn at 1.2 times the game's jewel radius units since 3.16: the game files' Large radius 1500
# reaches 1800 tree units. (Path of Building's radius tables, 960 / 1440 / 1800 for 800 / 1200 / 1500, agree; it is
# a check, not the source.)
TREE_UNITS_PER_RADIUS_UNIT = 1.2
def jewel_radii_on_tree(radii):
    """Every jewel size's radius and ring in tree units, for the planner's areas (public/buildradius.js)."""
    sizes = {}
    for size, entry in radii.items():
        sizes[size] = {"radius": round(entry["radius"] * TREE_UNITS_PER_RADIUS_UNIT),
                       "ringInner": round(entry["ringInner"] * TREE_UNITS_PER_RADIUS_UNIT),
                       "ringOuter": round(entry["ringOuter"] * TREE_UNITS_PER_RADIUS_UNIT)}
    return sizes


# Timeless jewels conquer passives in a Large radius.
TIMELESS_RADIUS = "Large"


def read_timeless(timeless_keystones, timeless_jewels, radii, tree_keystone_names, conquest_sources, coverage):
    """The keystones timeless jewels grant, grouped by jewel: a timeless jewel in a socket turns a keystone in its
    radius into one of its conquerors' keystones. Keystones of a family no jewel here brings (the Abyss ones) and
    keystones none of whose lines could be read are left out, and so are keystones the tree has anyway (the wiki
    files Glancing Blows, Eternal Youth, The Agnostic and Wind Dancer under a family too)."""
    jewel_of_family = {jewel["family"]: jewel["name"] for jewel in timeless_jewels}
    jewels = {}
    for keystone in timeless_keystones:
        jewel_name = jewel_of_family.get(keystone["jewel"])
        if jewel_name is None or keystone["name"] in tree_keystone_names:
            continue
        effects, unread = effects_of(keystone["statText"], "timeless keystone", "roll", coverage)
        if not effects:
            continue
        entry = jewels.setdefault(jewel_name, {"name": jewel_name, "family": keystone["jewel"], "keystones": []})
        entry["keystones"].append({"name": keystone["name"], "effects": effects})
    # What each jewel does to the small passives and notables in its radius, for a typical seed (scripts/timeless_conquest.py).
    conquests = conquests_of(conquest_sources, lambda line: effects_of(line, "timeless passive", "roll", coverage))
    for entry in jewels.values():
        if entry["family"] in conquests:
            entry["conquest"] = conquests[entry["family"]]
    radius = radii.get(TIMELESS_RADIUS, {}).get("radius")
    return {"radius": round(radius * TREE_UNITS_PER_RADIUS_UNIT) if radius else None,
            "jewels": sorted(jewels.values(), key=lambda jewel: jewel["name"])}


# "Has no Sockets", "Has 1 Socket", "Has 6 Sockets": a unique with a fixed number of sockets (Kaom's Heart has none,
# so no six-link in the body). These are local lines, left out of the effects, so they are kept as a field.
FIXED_SOCKETS = re.compile(r"^Has (no|\d+) Sockets?$", flags=re.IGNORECASE)


def fixed_sockets_of(text):
    for line in split_lines(text):
        match = FIXED_SOCKETS.match(line.strip())
        if match:
            if match.group(1).lower() == "no":
                return 0
            return int(match.group(1))
    return None


# poewiki's table of random modifiers ("<Random Keystone>", "<Two or Three random aura modifiers>"): the item rolls one
# or a few of the alternatives listed, separated by <hr>. They were read as if the item had every one of them, so Skin
# of the Lords carried all 49 keystones at once (it was in half the generated builds) and Sublime Vision every aura
# bonus. The table is left out of the reading; the item's other lines are read as usual (2026-11-23).
RANDOM_MODIFIER_TABLE = re.compile(r'<table class="random-modifier-stats.*?</table>', flags=re.DOTALL)
RANDOM_ALTERNATIVE_SEPARATOR = re.compile(r"<hr[^>]*>")
# Uniques that roll exactly one keystone, which players buy for the keystone they want: each keystone is a version of
# the unique of its own ("Skin of the Lords (Iron Reflexes)"), named apart so cards rebuild the right one, with the
# keystone's effects as the tree reads them. baseName is the item, for prices and for wearing only one.
KEYSTONE_CHOICE_UNIQUES = {"Skin of the Lords"}


def random_alternatives(text):
    """The alternatives listed in the text's random modifier tables, each as the names it links (wiki markup gone)."""
    alternatives = []
    for table in RANDOM_MODIFIER_TABLE.findall(text or ""):
        body = re.sub(r"^.*?<td>", "", table, flags=re.DOTALL)
        body = re.sub(r"</td>.*$", "", body, flags=re.DOTALL)
        for piece in RANDOM_ALTERNATIVE_SEPARATOR.split(body):
            alternatives.append(split_lines(piece))
    return alternatives


# "+600 Strength and Intelligence Requirement" (Garb of the Ephemeral) raises the item's own requirements, which the
# wiki's required_* fields leave at the base's. The line reads as minor (it is no effect), so it is added here.
ATTRIBUTE_REQUIREMENT_LINE = re.compile(
    r"^\+(\d+) (Strength|Dexterity|Intelligence)(?: and (Strength|Dexterity|Intelligence))? Requirements?$")
ATTRIBUTE_KEY = {"Strength": "str", "Dexterity": "dex", "Intelligence": "int"}


def requirements_with_lines(requirements, text):
    """The item's attribute requirements with its "+N <attribute> Requirement" lines added."""
    raised = dict(requirements)
    for line in split_lines(text):
        match = ATTRIBUTE_REQUIREMENT_LINE.match(line)
        if not match:
            continue
        amount = int(match.group(1))
        for attribute in (match.group(2), match.group(3)):
            if attribute:
                key = ATTRIBUTE_KEY[attribute]
                raised[key] = raised.get(key, 0) + amount
    return raised


# An attack weapon's local lines, as weapon stats: its physical damage (increased and flat), attack speed and crit
# chance (increased and flat), and its flat elemental or chaos damage as added attack damage (it hits with the weapon;
# "weaponHand" marks it as that hand's own, so a dual-wielded weapon's counts for half the hits).
LOCAL_PHYSICAL_INCREASED = re.compile(r"^([\d.]+)% increased Physical Damage$")
LOCAL_FLAT_DAMAGE = re.compile(r"^Adds ([\d.]+) to ([\d.]+) (Physical|Fire|Cold|Lightning|Chaos) Damage$")
LOCAL_ATTACK_SPEED = re.compile(r"^([\d.]+)% increased Attack Speed$")
LOCAL_CRIT_INCREASED = re.compile(r"^([\d.]+)% increased Critical Strike Chance$")
LOCAL_CRIT_FLAT = re.compile(r"^\+([\d.]+)% to Critical Strike Chance$")


def attack_weapon_local_effects(line):
    """The weapon stats of one local line of an attack weapon, or None when it isn't one this knows."""
    match = LOCAL_PHYSICAL_INCREASED.match(line)
    if match:
        return [{"kind": "increased", "stat": "weaponPhysical", "value": float(match.group(1)), "local": True}]
    match = LOCAL_FLAT_DAMAGE.match(line)
    if match:
        average = (float(match.group(1)) + float(match.group(2))) / 2
        damage_type = match.group(3).lower()
        if damage_type == "physical":
            return [{"kind": "flat", "stat": "weaponPhysical", "value": round(average, 2), "local": True}]
        return [{"kind": "added", "stat": "damage", "tags": ["attack", damage_type], "value": round(average, 2),
                 "weaponHand": True}]
    match = LOCAL_ATTACK_SPEED.match(line)
    if match:
        return [{"kind": "increased", "stat": "weaponAttackSpeed", "value": float(match.group(1)), "local": True}]
    match = LOCAL_CRIT_INCREASED.match(line)
    if match:
        return [{"kind": "increased", "stat": "weaponCrit", "value": float(match.group(1)), "local": True}]
    match = LOCAL_CRIT_FLAT.match(line)
    if match:
        return [{"kind": "flat", "stat": "weaponCrit", "value": float(match.group(1)), "local": True}]
    return None


# A unique weapon's own hit: its base's damage, speed and crit with its local lines at the middle of their rolls. Its
# local lines used to be left out on the view that a good rare gives about as much, and the engine counted every
# unique weapon as hitting like its reference rare; then The Grey Spire (a staff without physical damage lines, with
# 350% increased global damage) carried that 350% on top of a rare's hit and melee builds took staves for it
# (2026-11-25). The engine weighs this hand against the reference rare as it does a solved one.
ROLL_RANGE = re.compile(r"\((-?[\d.]+)-(-?[\d.]+)\)")


def middle_of_rolls(line):
    """The line with each "(a-b)" roll replaced by its middle, as the game would show one roll."""
    def middle(match):
        value = (float(match.group(1)) + float(match.group(2))) / 2
        return f"{value:g}"
    return ROLL_RANGE.sub(middle, line)


def weapon_hand_of(unique, text, base_stats):
    """The unique weapon's hand for the engine, or None when its base isn't a known weapon base."""
    base = base_stats.get(unique["base"])
    if unique["category"] not in WEAPON_CATEGORIES or base is None:
        return None
    hand = dict(base)
    hand.update({"physicalFlat": 0, "physicalIncreased": 0, "attackSpeedIncreased": 0, "critIncreased": 0, "critFlat": 0})
    for line in split_lines(text):
        effects = attack_weapon_local_effects(middle_of_rolls(line))
        for effect in effects or []:
            if effect["stat"] == "weaponPhysical" and effect["kind"] == "flat":
                hand["physicalFlat"] += effect["value"]
            elif effect["stat"] == "weaponPhysical":
                hand["physicalIncreased"] += effect["value"]
            elif effect["stat"] == "weaponAttackSpeed":
                hand["attackSpeedIncreased"] += effect["value"]
            elif effect["stat"] == "weaponCrit" and effect["kind"] == "increased":
                hand["critIncreased"] += effect["value"]
            elif effect["stat"] == "weaponCrit":
                hand["critFlat"] += effect["value"]
    return hand


# "Implicit Modifier Magnitudes are Doubled" (The Grey Spire: 50% chance to block, not 25%) and "(80-100)% increased
# Implicit Modifier magnitudes" scale the item's implicit lines. Read as nothing, the implicit counted once.
IMPLICIT_DOUBLED = re.compile(r"^Implicit Modifier Magnitudes are Doubled$", re.IGNORECASE)
IMPLICIT_INCREASED = re.compile(r"^([\d.]+)% increased Implicit Modifier magnitudes$", re.IGNORECASE)


def implicit_magnitude_of(text):
    """How much the item's lines scale its implicit: 1 when they don't."""
    factor = 1.0
    for line in split_lines(text):
        line = middle_of_rolls(line)
        if IMPLICIT_DOUBLED.match(line):
            factor *= 2
        match = IMPLICIT_INCREASED.match(line)
        if match:
            factor *= 1 + float(match.group(1)) / 100
    return factor


def scaled_implicit_effects(unique, explicit_text, category, coverage):
    """The implicit's effects, scaled by the item's implicit magnitude lines."""
    implicit_text = RANDOM_MODIFIER_TABLE.sub("", unique["implicitText"] or "")
    effects, unread = effects_of(implicit_text, "unique", "roll", coverage, category)
    factor = implicit_magnitude_of(explicit_text)
    if factor != 1:
        for effect in effects:
            if effect.get("value") is not None:
                effect["value"] = round(effect["value"] * factor, 2)
    return effects, unread


# poewiki names melee weapon classes "One-Handed Sword", "Two-Handed Axe"; GGG's item class ids, which the
# categories here and the generator's slots use, are "One Hand Sword", "Two Hand Axe". Under the wiki's names the 119
# sword, axe and mace uniques had no slot, so the generator never held one, and their local lines were read as global
# ones (Starforge's increased physical damage as the character's) (2026-11-25).
WIKI_WEAPON_CATEGORIES = {
    "One-Handed Sword": "One Hand Sword", "Thrusting One-Handed Sword": "Thrusting One Hand Sword",
    "Two-Handed Sword": "Two Hand Sword", "One-Handed Axe": "One Hand Axe", "Two-Handed Axe": "Two Hand Axe",
    "One-Handed Mace": "One Hand Mace", "Two-Handed Mace": "Two Hand Mace",
}


def read_uniques(uniques, coverage, keystones, base_stats, jewel_radii=None):
    keystone_effects = {keystone["name"]: keystone["effects"] for keystone in keystones}
    jewel_radii = jewel_radii or {}
    read = []
    for wiki_unique in uniques:
        if not wiki_unique["current"]:
            continue
        unique = dict(wiki_unique)
        unique["category"] = WIKI_WEAPON_CATEGORIES.get(unique["category"], unique["category"])
        combined = "\n".join(part for part in (unique["implicitText"], unique["explicitText"]) if part)
        alternatives = random_alternatives(combined)
        fixed_text = RANDOM_MODIFIER_TABLE.sub("", combined)
        explicit_text = RANDOM_MODIFIER_TABLE.sub("", unique["explicitText"] or "")
        implicit_effects, implicit_unread = scaled_implicit_effects(unique, explicit_text, unique["category"], coverage)
        radius = radius_of_jewel(unique, jewel_radii, explicit_text, alternatives, coverage)
        if radius is not None:
            explicit_text = "\n".join(radius["otherLines"])
        explicit_effects, unread = effects_of(explicit_text, "unique", "roll", coverage, unique["category"])
        effects = implicit_effects + explicit_effects
        unread = implicit_unread + unread
        entry = {
            "name": unique["name"], "category": unique["category"], "base": unique["base"],
            "level": unique["levelRequirement"], "requirements": requirements_with_lines(unique["requirements"], fixed_text),
            "effects": effects,
        }
        sockets = fixed_sockets_of(fixed_text)
        if sockets is not None:
            entry["sockets"] = sockets
        hand = weapon_hand_of(unique, fixed_text, base_stats)
        if hand is not None:
            entry["weaponHand"] = hand
        if alternatives:
            entry["randomModifiersLeftOut"] = len(alternatives)
        if radius is not None:
            read.extend(radius_jewel_versions(entry, radius, keystone_effects))
            continue
        if unique["name"] in KEYSTONE_CHOICE_UNIQUES:
            read.extend(keystone_versions(entry, alternatives, keystone_effects))
            continue
        if entry.get("sockets") == 1 and names_socket_colours(fixed_text):
            read.extend(socket_colour_versions(entry, fixed_text, unique["category"]))
            continue
        read.append(entry)
    return read


# ---------- jewels that work on the passives in their radius (scripts/radius_jewels.py) ----------
# The rules' own stats are read with a coverage of their own: each radius line is counted once, as read.
RADIUS_RULE_COVERAGE = Coverage()
# Thread of Hope's ring is a roll the item names ("Only affects Passives in Large Ring"): one version per ring, like
# Skin of the Lords' keystones. The ring sizes are the game files' (PassiveJewelRadii).
THREAD_OF_HOPE_RINGS = [("Small", "Small"), ("Medium", "Medium"), ("Large", "Large"), ("VeryLarge", "Very Large"),
                        ("Massive", "Massive")]
# Impossible Escape names a random keystone, round which its area lies: one version per keystone of the tree.
KEYSTONE_AREA_UNIQUES = {"Impossible Escape"}
# The Light of Meaning rolls one "Passive Skills in Radius also grant ..." line: one version per line.
RADIUS_LINE_CHOICE_UNIQUES = {"The Light of Meaning"}


def read_radius_rule_text(text):
    return effects_of(text, "radius rule", "roll", RADIUS_RULE_COVERAGE)


def radius_of_jewel(unique, jewel_radii, explicit_text, alternatives, coverage):
    """A unique jewel's radius and the rules its radius lines describe, or None for a jewel without a radius, one none
    of whose radius lines could be read (it stays an ordinary unique, as before), and a timeless jewel (those are
    read_timeless's). otherLines are the lines left for the usual reading."""
    size = jewel_radii.get(unique["name"], {}).get("radius")
    if size is None or "Historic" in explicit_text:
        return None
    lines = split_lines(explicit_text)
    rules, other_lines = radius_rules_of(lines, read_radius_rule_text)
    choices = []
    if unique["name"] in RADIUS_LINE_CHOICE_UNIQUES:
        for alternative in alternatives:
            choice_rules, unread_lines = radius_rules_of(alternative, read_radius_rule_text)
            if choice_rules and not unread_lines:
                choices.append({"text": alternative[0], "rules": choice_rules})
    if not rules and not choices:
        return None
    for line in lines:
        if line not in other_lines:
            coverage.count("unique", line, True)
    limit = jewel_radii[unique["name"]].get("limit")
    return {"size": size, "rules": rules, "choices": choices, "otherLines": other_lines,
            "limit": int(limit) if limit and limit.isdigit() else None}


def radius_jewel_versions(entry, radius, keystone_effects):
    """The jewel as the planner places it. entry["radius"] holds its area and its rules: {size} in the game's size
    names, a ring instead ({ring}, Thread of Hope), or a size round a keystone ({size, around}, Impossible Escape). A
    jewel whose area or radius line is a roll comes in one version per roll."""
    base = dict(entry)
    base["radius"] = {"size": radius["size"], "rules": radius["rules"]}
    if radius["limit"] is not None:
        base["limit"] = radius["limit"]
    if entry["name"] == "Thread of Hope":
        versions = []
        for ring, label in THREAD_OF_HOPE_RINGS:
            version = version_of(base, label + " Ring")
            version["radius"] = {"ring": ring, "rules": radius["rules"]}
            versions.append(version)
        return versions
    if entry["name"] in KEYSTONE_AREA_UNIQUES:
        versions = []
        for keystone in sorted(keystone_effects):
            version = version_of(base, keystone)
            version["radius"] = {"size": radius["size"], "around": keystone, "rules": radius["rules"]}
            versions.append(version)
        return versions
    if radius["choices"]:
        versions = []
        for choice in radius["choices"]:
            version = version_of(base, choice["text"].replace("Passive Skills in Radius also grant ", ""))
            version["radius"] = {"size": radius["size"], "rules": radius["rules"] + choice["rules"]}
            versions.append(version)
        return versions
    return [base]


def version_of(base, variant):
    version = dict(base)
    version.pop("randomModifiersLeftOut", None)
    version["name"] = f"{base['name']} ({variant})"
    version["baseName"] = base["name"]
    version["variant"] = variant
    return version


# "+(100-200) to Maximum Life per Red Socket" (The Pariah): the item's own sockets, and it has one, so a player gets
# exactly one of its colour lines, picked by the colour of that socket. They were read as "per stack" at three stacks
# each (450 life, mana and energy shield at once), and The Pariah sat in 49% of builds (2026-11-25). Each colour is a
# version of its own, like Skin of the Lords' keystones, with that line counted once and the others left out. Only for
# one-socket items: on Crown of the Tyrant or Scaeva the colours of several sockets add up.
SOCKET_COLOUR_LINE = re.compile(r" per (Red|Green|Blue|White) Socket$")


def names_socket_colours(text):
    for line in split_lines(text):
        if SOCKET_COLOUR_LINE.search(line):
            return True
    return False


def socket_colour_versions(entry, text, category):
    """One version of the unique per socket colour its lines name. The item's lines were counted in the coverage
    already, so the versions are read with a coverage of their own."""
    lines = split_lines(text)
    colours = []
    for line in lines:
        match = SOCKET_COLOUR_LINE.search(line)
        if match and match.group(1) not in colours:
            colours.append(match.group(1))
    versions = []
    for colour in colours:
        kept = []
        for line in lines:
            match = SOCKET_COLOUR_LINE.search(line)
            if match is None:
                kept.append(line)
            elif match.group(1) == colour:
                kept.append(line[:match.start()])
        effects, unread = effects_of("\n".join(kept), "unique", "roll", Coverage(), category)
        version = dict(entry)
        version["name"] = f"{entry['name']} ({colour} socket)"
        version["baseName"] = entry["name"]
        version["variant"] = f"{colour} socket"
        version["effects"] = effects
        versions.append(version)
    return versions


def keystone_versions(entry, alternatives, keystone_effects):
    """One version of a keystone-rolling unique per keystone the tree reads."""
    versions = []
    for lines in alternatives:
        if len(lines) != 1 or lines[0] not in keystone_effects:
            continue
        keystone = lines[0]
        version = dict(entry)
        version.pop("randomModifiersLeftOut", None)
        version["name"] = f"{entry['name']} ({keystone})"
        version["baseName"] = entry["name"]
        version["variant"] = keystone
        version["effects"] = entry["effects"] + keystone_effects[keystone]
        versions.append(version)
    return versions


# The planner's budget: a level ~92 character with every quest point. Ascendancy points are separate.
TREE_POINT_BUDGET = 110


def read_tree_graph(graph, coverage):
    """public/data/builds/tree-poe1.json: every allocatable main-tree node with its effects and neighbours, for the
    tree planner (public/buildtree.js). Kinds: s small, n notable, k keystone, j jewel socket, c class start.
    s is GGG's own wording of the node, shown when hovering it on the drawn tree; the planner reads only e."""
    kind_letter = {"small": "s", "notable": "n", "keystone": "k", "jewel": "j", "start": "c"}
    source_of_kind = {"small": "tree small", "notable": "notable", "keystone": "keystone"}
    nodes = {}
    for node_id, node in graph["nodes"].items():
        effects = []
        if node["kind"] in source_of_kind and node["statText"]:
            effects, unread = effects_of(node["statText"], source_of_kind[node["kind"]] + " (tree)", "roll", coverage)
        entry = {"t": kind_letter[node["kind"]], "l": node["neighbours"]}
        if node["name"]:
            entry["n"] = node["name"]
        if effects:
            entry["e"] = effects
        if node["statText"]:
            entry["s"] = node["statText"]
        if node.get("largeCluster"):
            entry["c"] = 1  # a socket that takes a large cluster jewel
        if node.get("clusterRing"):
            entry["cr"] = node["clusterRing"]  # where a large cluster's passives are drawn
        if node.get("position"):
            position = node["position"]
            entry["p"] = [position["x"], position["y"], position["group"], position["orbit"]]  # for drawing the tree
        nodes[node_id] = entry
    masteries = {}
    for node_id, mastery in graph["masteries"].items():
        masteries[node_id] = {"n": mastery["name"], "on": mastery["unlockedBy"]}
        if mastery.get("position"):
            masteries[node_id]["p"] = list(mastery["position"])
    mastery_options = read_mastery_options(graph["masteryOptions"], coverage)
    return {"budget": TREE_POINT_BUDGET, "starts": graph["starts"], "nodes": nodes, "masteries": masteries,
            "groups": graph["groups"], "orbitRadii": graph["orbitRadii"],
            "masteryOptions": mastery_options}


def read_mastery_options(options_of_type, coverage):
    """Each mastery type's options with their effects (i id, s GGG's stat text for showing, e effects). An option
    none of whose lines could be read is left out: the planner can't value it."""
    read = {}
    for name, options in options_of_type.items():
        kept = []
        for option in options:
            if not option["statText"]:
                continue
            effects, unread = effects_of(option["statText"], "mastery (tree)", "roll", coverage)
            if effects:
                kept.append({"i": option["id"], "s": option["statText"], "e": effects})
        if kept:
            read[name] = kept
    return read


def main():
    sources = load_build_sources(refresh="--refresh" in sys.argv[1:])
    rules = rules_by_effect_id(sources["skillTables"])
    coverage = Coverage()
    skills, supports, missing_rules = read_gems(sources["gems"], rules, coverage)
    ascendancies, keystones, notables = read_passives(sources["passives"], sources["classOfAscendancy"], coverage)
    uniques = read_uniques(sources["uniques"], coverage, keystones, sources["weaponBaseStats"], sources["uniqueJewelRadii"])
    skills.update(read_unique_main_skills(uniques, rules))
    bloodlines = read_bloodlines(sources["bloodlineGraphs"], coverage)
    flasks = read_flasks(sources["flasks"], coverage)
    jewels = read_jewels(sources["jewelMods"], sources["largeClusters"], coverage)
    tree_keystone_names = {keystone["name"] for keystone in keystones}
    timeless = read_timeless(sources["timelessKeystones"], sources["timelessJewels"], sources["jewelRadii"], tree_keystone_names,
                             sources["timelessConquests"], coverage)
    tree = read_tree_graph(sources["treeGraph"], coverage)
    tree["patch"] = sources["patch"]
    write_utf8(TREE_OUT, json.dumps(tree, ensure_ascii=False, separators=(",", ":")))
    print(f"  tree: {len(tree['nodes'])} nodes, {len(tree['starts'])} class starts -> {TREE_OUT.relative_to(ROOT)} "
          f"({TREE_OUT.stat().st_size // 1024} KB)")
    summary = coverage.report()
    patch = sources["patch"]
    data = {
        "patch": patch, "built": time.strftime("%Y-%m-%d"),
        "source": sources["source"] + "; effects read by scripts/mechanics_vocabulary.py",
        "coverage": summary,
        "skills": skills, "supports": supports, "ascendancies": ascendancies, "bloodlines": bloodlines,
        "keystones": keystones, "notables": notables, "uniques": uniques, "flasks": flasks,
        "weaponBases": sources["weaponBases"], "jewels": jewels, "timeless": timeless,
        "jewelRadii": jewel_radii_on_tree(sources["jewelRadii"]),
    }
    write_utf8(OUT, json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(f"patch {patch}: {len(skills)} skills ({sum(1 for s in skills.values() if s['main'])} main), "
          f"{len(supports)} supports, {len(ascendancies)} ascendancies, {len(bloodlines)} bloodlines, {len(keystones)} keystones, "
          f"{len(notables)} notables, {len(uniques)} uniques -> {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    if missing_rules:
        print(f"  no game-file rules for {len(missing_rules)} gems: {', '.join(missing_rules[:10])}")
    print("  stat lines understood: " + ", ".join(f"{source} {percent}%" for source, percent in summary.items()))
    report = ROOT / ".cache" / "mechanics-unread.json"
    write_utf8(report, json.dumps(coverage.unread, ensure_ascii=False, indent=1))
    print(f"  unread lines by source: {report.relative_to(ROOT)}")


if __name__ == "__main__":
    use_utf8_console()
    main()
