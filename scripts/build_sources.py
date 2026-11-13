"""The game knowledge the Build maker's data scripts read, from public sources only:

- Grinding Gear Games' passive tree export (github.com/grindinggear/skilltree-export, published for tool makers):
  which keystones, notables, ascendancy notables and bloodline nodes are on the current tree, with their stat text,
  and which class each ascendancy belongs to. This is the authority on what exists now: the wiki and the game
  files also keep removed and league-only nodes.
- poewiki.net's Cargo tables (CC BY-NC-SA 3.0), through scripts/poewiki.py: gems (items + skill_gems + skill, and
  skill_levels at level 20 with the static level-0 values), unique items with their implicit and explicit stat
  text, the keystones timeless jewels grant (poe.ninja lists those among a build's keystones; they aren't on
  the tree), flask bases (flasks + item_buffs: duration, charges, life recovered, a utility flask's buff), and
  weapon bases (weapons: physical damage, attack speed, critical strike chance), jewel modifiers (mods, domain 10)
  and the stat text of cluster jewel passives (passive_skills, ids "affliction_...").
- GGG's game files again for cluster jewels: each large cluster type's tag and small passive
  (PassiveTreeExpansionSkills) and which notables each type can roll (the spawn weights of the AfflictionNotable
  mods).
- Grinding Gear Games' game files, through scripts/game_files.py: every skill's types and every support's rules,
  which also stand in for gem tags where the wiki has none.

    sources = load_build_sources(refresh=False)

Everything is normalised to this project's own field names here, so the build scripts don't depend on how each
source names things.
"""
import html
import math
import json
import re
import time
import urllib.request
from pathlib import Path

from game_files import export_tables
from poewiki import USER_AGENT, cargo_rows
from text_files import read_utf8, write_utf8

ROOT = Path(__file__).resolve().parent.parent
TREE_URL = "https://raw.githubusercontent.com/grindinggear/skilltree-export/master/data.json"
TREE_CACHE = ROOT / ".cache" / "skilltree" / "data.json"
TREE_CACHE_DAYS = 7
GEM_CLASSES = ("Active Skill Gem", "Support Skill Gem")
SKILL_TABLES = [
    {"name": "ActiveSkills", "columns": ["Id", "DisplayedName", "ActiveSkillTypes", "MinionActiveSkillTypes",
                                         "WeaponRestriction_ItemClassesKeys", "IsGem", "IsManuallyCasted", "SkillTotemId"]},
    {"name": "GrantedEffects", "columns": ["Id", "IsSupport", "AllowedActiveSkillTypes", "AddedActiveSkillTypes",
                                           "ExcludedActiveSkillTypes", "SupportsGemsOnly", "CannotBeSupported",
                                           "ActiveSkill", "AddedMinionActiveSkillTypes", "IgnoreMinionTypes", "CastTime",
                                           "SupportWeaponRestrictions"]},
    {"name": "ActiveSkillType", "columns": ["Id"]},
    {"name": "ItemClasses", "columns": ["Id", "Name"]},
]
# GGG's skill types -> the gem tags the wiki would show, for gems the wiki has no tags for.
TAG_OF_TYPE = {
    "Attack": "Attack", "Spell": "Spell", "Melee": "Melee", "Projectile": "Projectile", "Area": "AoE",
    "SummonsTotem": "Totem", "Trapped": "Trap", "RemoteMined": "Mine", "Brand": "Brand", "CreatesMinion": "Minion",
    "Aura": "Aura", "Warcry": "Warcry", "Channel": "Channelling", "Slam": "Slam", "Strike": "Strike",
    "Duration": "Duration", "Chains": "Chaining", "Physical": "Physical", "Fire": "Fire", "Cold": "Cold",
    "Lightning": "Lightning", "Chaos": "Chaos", "Herald": "Herald", "Golem": "Golem", "Vaal": "Vaal",
}


def flag(value):
    """Cargo answers booleans as "1"/"0" (or nothing)."""
    return str(value or "").strip() in ("1", "true", "True", "yes")


def number(value):
    text = str(value or "").strip()
    if text == "":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def whole_number(value):
    parsed = number(value)
    if parsed is None:
        return None
    return int(parsed)


def first_number(value):
    """The first number of a Cargo list field ("29" or "12,30"), or None."""
    for part in str(value or "").split(","):
        parsed = number(part)
        if parsed is not None:
            return parsed
    return None


def text_list(value):
    items = []
    for part in str(value or "").split(","):
        part = part.strip()
        if part:
            items.append(part)
    return items


def wiki_text(value):
    """Text as the wiki stores it, with its HTML escaped ("&lt;br&gt;", "&#039;"); the vocabulary reads the
    unescaped form, wiki links and all."""
    return html.unescape(value or "")


# ---------- the passive tree ----------
def fetch_tree(refresh):
    fresh = TREE_CACHE.exists() and time.time() - TREE_CACHE.stat().st_mtime < TREE_CACHE_DAYS * 86400
    if fresh and not refresh:
        return json.loads(read_utf8(TREE_CACHE))
    request = urllib.request.Request(TREE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        body = response.read().decode("utf-8")
    TREE_CACHE.parent.mkdir(parents=True, exist_ok=True)
    write_utf8(TREE_CACHE, body)
    print(f"  GGG passive tree export: {len(body) // 1024} KB")
    return json.loads(body)


def read_tree(tree):
    """The tree's classes, ascendancies, bloodlines and named nodes. Ascendancies are named by internal id on the
    nodes (Ranger's Warden is "Raider"); a node whose id isn't a class ascendancy belongs to a bloodline."""
    class_of_ascendancy = {}
    ascendancy_name = {}
    for character_class in tree["classes"]:
        for ascendancy in character_class.get("ascendancies", []):
            ascendancy_name[ascendancy["id"]] = ascendancy["name"]
            class_of_ascendancy[ascendancy["name"]] = character_class["name"]
    bloodline_name = {}
    for bloodline in tree.get("alternate_ascendancies", []):
        bloodline_name[bloodline["id"]] = bloodline["name"]
    passives = []
    for node in tree["nodes"].values():
        if not node.get("name") or node.get("isMastery") or node.get("isJewelSocket") or node.get("isProxy"):
            continue
        if not (node.get("isNotable") or node.get("isKeystone")):
            continue
        owner = node.get("ascendancyName")
        ascendancy = None
        bloodline = None
        if owner in ascendancy_name:
            ascendancy = ascendancy_name[owner]
        elif owner:
            bloodline = bloodline_name.get(owner, owner)
        passives.append({
            "id": str(node.get("skill")),
            "name": node["name"],
            "statText": "\n".join(node.get("stats", [])),
            "ascendancy": ascendancy,
            "bloodline": bloodline,
            "keystone": bool(node.get("isKeystone")),
            "notable": bool(node.get("isNotable")),
            # Blighted notables can only be anointed; they aren't allocated on the tree.
            "anointOnly": bool(node.get("isBlighted")),
            "connections": list(node.get("out", [])) + list(node.get("in", [])),
        })
    passives.sort(key=lambda passive: (passive["ascendancy"] or "", passive["bloodline"] or "", passive["name"]))
    return class_of_ascendancy, passives


# ---------- the game files ----------
def skill_types_by_effect(tables):
    """GrantedEffects id (the wiki's skill id) -> the skill's type names."""
    type_names = []
    for row in tables["ActiveSkillType"]:
        type_names.append(row["Id"])
    types = {}
    for granted in tables["GrantedEffects"]:
        if granted["ActiveSkill"] is None:
            continue
        active = tables["ActiveSkills"][granted["ActiveSkill"]]
        names = []
        for index in active["ActiveSkillTypes"] or []:
            names.append(type_names[index])
        types[granted["Id"]] = names
    return types


def tags_from_types(types):
    tags = []
    for type_name in types:
        tag = TAG_OF_TYPE.get(type_name)
        if tag is not None and tag not in tags:
            tags.append(tag)
    return tags


# ---------- gems ----------
def fetch_gems(refresh):
    gems = cargo_rows(
        "gems", tables="items,skill_gems,skill",
        join_on="items._pageName=skill_gems._pageName,skill_gems.skill_id=skill.skill_id",
        fields=["items._pageName=page", "items.name", "items.class_id", "items.is_in_game", "items.removal_version",
                "items.required_level", "items.required_strength", "items.required_dexterity",
                "items.required_intelligence", "items.is_drop_restricted", "skill_gems.skill_id", "skill_gems.gem_tags",
                "skill_gems.requires_strength", "skill_gems.requires_dexterity", "skill_gems.requires_intelligence",
                "skill_gems.is_vaal_skill_gem", "skill.stat_text", "skill.description", "skill.cast_time"],
        where='items.class_id IN ("Active Skill Gem","Support Skill Gem")', order_by="items.name", refresh=refresh)
    # The wiki keeps a skill's values that are the same at every level on a "level 0" row, and the rest per level;
    # the generator wants level 20, so both rows are read.
    levels = cargo_rows(
        "gem-levels", tables="skill_levels",
        fields=["skill_levels._pageName=page", "skill_levels.level", "skill_levels.damage_effectiveness",
                "skill_levels.attack_speed_multiplier", "skill_levels.critical_strike_chance",
                "skill_levels.mana_reservation_percent", "skill_levels.mana_reservation_flat",
                "skill_levels.cost_amounts", "skill_levels.cost_types",
                "skill_levels.cost_multiplier"],
        where="skill_levels.level=0 OR skill_levels.level=20", order_by="skill_levels._pageName", refresh=refresh)
    return gems, levels


LEVEL_FIELDS = ("damage_effectiveness", "attack_speed_multiplier", "critical_strike_chance", "mana_reservation_percent",
                "mana_reservation_flat", "cost_amounts", "cost_types", "cost_multiplier")


def level_values_by_skill(level_rows):
    """skill id -> its level-20 values, each falling back to the static level-0 value. Level data sits on the
    skill's own page, "Skill:<skill id>", not on the gem's page."""
    static = {}
    at_twenty = {}
    for row in level_rows:
        page = row.get("page") or ""
        if not page.startswith("Skill:"):
            continue
        skill_id = page[len("Skill:"):]
        level = str(row.get("level") or "").strip()
        if level == "0":
            static[skill_id] = row
        elif level == "20":
            at_twenty[skill_id] = row
    values = {}
    for skill_id in set(static) | set(at_twenty):
        merged = {}
        for field in LEVEL_FIELDS:
            value = at_twenty.get(skill_id, {}).get(field)
            if value in (None, ""):
                value = static.get(skill_id, {}).get(field)
            merged[field] = value
        values[skill_id] = merged
    return values


def normalise_gems(gem_rows, level_rows, types_by_effect):
    level_by_skill = level_values_by_skill(level_rows)
    gems = {}
    for row in gem_rows:
        name = wiki_text(row.get("name"))
        if not name or row.get("class_id") not in GEM_CLASSES:
            continue
        skill_id = row.get("skill_id") or ""
        level = level_by_skill.get(skill_id, {})
        requires = []
        for attribute in ("strength", "dexterity", "intelligence"):
            if flag(row.get("requires_" + attribute)):
                requires.append(attribute[:3])
        tags = text_list(row.get("gem_tags"))
        if not tags:
            tags = tags_from_types(types_by_effect.get(skill_id, []))
        gem = {
            "name": name,
            "isSupport": row.get("class_id") == "Support Skill Gem",
            "skillId": skill_id,
            "tags": tags,
            "requires": requires,
            "attributeRequirements": {"str": whole_number(row.get("required_strength")) or 0,
                                      "dex": whole_number(row.get("required_dexterity")) or 0,
                                      "int": whole_number(row.get("required_intelligence")) or 0},
            "levelRequirement": whole_number(row.get("required_level")) or 1,
            "isVaal": flag(row.get("is_vaal_skill_gem")),
            "dropRestricted": flag(row.get("is_drop_restricted")),
            "statText": wiki_text(row.get("stat_text")),
            "description": wiki_text(row.get("description")),
            "castTime": number(row.get("cast_time")),
            "effectiveness": number(level.get("damage_effectiveness")),
            "attackSpeedMultiplier": number(level.get("attack_speed_multiplier")),
            "baseCrit": number(level.get("critical_strike_chance")),
            # Auras and heralds reserve a share of mana; a few reserve a flat amount instead (Clarity, Vitality,
            # Precision: reservationFlat, in mana at level 20).
            "reservation": number(level.get("mana_reservation_percent")),
            "reservationFlat": number(level.get("mana_reservation_flat")),
            # What one use costs at level 20, and in what ("Mana", "Life", "Energy Shield"; "Mana" when the wiki is
            # silent). A skill with two costs lists both; the first is its main one. Supports instead multiply the
            # cost of the skills they support (costMultiplier, in percent: Elemental Focus 130).
            "cost": first_number(level.get("cost_amounts")),
            "costType": (text_list(level.get("cost_types")) or ["Mana"])[0],
            "costMultiplier": number(level.get("cost_multiplier")),
            # Transfigured gems ("Arc of Surging") have skill ids ending AltX, AltY or AltZ.
            "transfigured": re.search(r"Alt[XYZ]$", skill_id) is not None,
            "current": flag(row.get("is_in_game")) and not row.get("removal_version"),
        }
        previous = gems.get(name)
        if previous is None or (gem["current"] and not previous["current"]):
            gems[name] = gem
    return sorted(gems.values(), key=lambda gem: gem["name"])


# ---------- uniques ----------
def fetch_uniques(refresh):
    return cargo_rows(
        "uniques", tables="items",
        fields=["items.name", "items.class", "items.base_item", "items.required_level", "items.required_strength",
                "items.required_dexterity", "items.required_intelligence", "items.implicit_stat_text",
                "items.explicit_stat_text", "items.is_in_game", "items.drop_enabled", "items.removal_version",
                "items.is_replica"],
        where='items.rarity_id="unique"', order_by="items.name", refresh=refresh)


def normalise_uniques(rows):
    uniques = {}
    for row in rows:
        name = wiki_text(row.get("name"))
        if not name:
            continue
        unique = {
            "name": name,
            "category": row.get("class") or None,
            "base": wiki_text(row.get("base_item")) or None,
            "levelRequirement": whole_number(row.get("required_level")) or 1,
            "requirements": {"str": whole_number(row.get("required_strength")) or 0,
                             "dex": whole_number(row.get("required_dexterity")) or 0,
                             "int": whole_number(row.get("required_intelligence")) or 0},
            "implicitText": wiki_text(row.get("implicit_stat_text")),
            "explicitText": wiki_text(row.get("explicit_stat_text")),
            # Legacy versions stay on the wiki with drops disabled; the current version is the one that drops.
            "current": flag(row.get("is_in_game")) and flag(row.get("drop_enabled")) and not row.get("removal_version"),
        }
        previous = uniques.get(name)
        if previous is None or (unique["current"] and not previous["current"]):
            uniques[name] = unique
    return sorted(uniques.values(), key=lambda unique: unique["name"])


# ---------- keystones from timeless jewels ----------
# The flask bases the generator plans with: every utility flask, and the best life flask (the one with the most
# life). Normal-rarity base items only; unique flasks come with the uniques.
FLASK_CLASSES = ("UtilityFlask", "LifeFlask")


def fetch_flasks(refresh):
    bases = cargo_rows(
        "flask-bases", tables="items,flasks",
        join_on="items._pageName=flasks._pageName",
        fields=["items._pageName=page", "items.name", "items.class_id", "items.required_level", "items.is_in_game",
                "flasks.duration", "flasks.charges_max", "flasks.charges_per_use", "flasks.life"],
        where='items.rarity_id="normal" AND items.class_id IN ("UtilityFlask","LifeFlask")', order_by="items.name",
        refresh=refresh)
    buffs = cargo_rows(
        "flask-buffs", tables="item_buffs",
        fields=["item_buffs._pageName=page", "item_buffs.id", "item_buffs.stat_text"],
        where='item_buffs._pageName LIKE "%Flask%"', order_by="item_buffs._pageName", refresh=refresh)
    return bases, buffs


def normalise_flasks(base_rows, buff_rows):
    buff_text = {}
    for row in buff_rows:
        buff_text[row.get("page")] = wiki_text(row.get("stat_text"))
    utility = []
    life_flasks = []
    for row in base_rows:
        if not flag(row.get("is_in_game")):
            continue
        flask = {
            "name": wiki_text(row.get("name")),
            "level": whole_number(row.get("required_level")) or 1,
            "duration": number(row.get("duration")),
            "chargesMax": whole_number(row.get("charges_max")),
            "chargesPerUse": whole_number(row.get("charges_per_use")),
        }
        if row.get("class_id") == "LifeFlask":
            flask["life"] = number(row.get("life"))
            if flask["life"] and flask["duration"]:
                life_flasks.append(flask)
            continue
        flask["buffText"] = buff_text.get(row.get("page"), "")
        if flask["buffText"] and flask["duration"]:
            utility.append(flask)
    best_life = max(life_flasks, key=lambda flask: flask["life"], default=None)
    return {"utility": utility, "life": best_life}


# Weapon item classes -> the weapon tags the generator plans with. Two-handed swords, axes and maces aren't listed:
# the generator doesn't tell one- from two-handed melee weapons, and one-handed ones are the common choice.
WEAPON_CLASS_TAGS = {
    "One Hand Sword": "sword", "Thrusting One Hand Sword": "sword", "One Hand Axe": "axe", "One Hand Mace": "mace",
    "Claw": "claw", "Dagger": "dagger", "Staff": "staff", "Bow": "bow", "Wand": "wand",
}


def fetch_weapon_bases(refresh):
    return cargo_rows(
        "weapon-bases", tables="items,weapons",
        join_on="items._pageName=weapons._pageName",
        fields=["items.name", "items.class_id", "items.drop_level", "items.is_in_game", "weapons.physical_damage_min",
                "weapons.physical_damage_max", "weapons.attack_speed", "weapons.critical_strike_chance"],
        where='items.rarity_id="normal"', order_by="items.name", refresh=refresh)


def best_weapon_bases(rows):
    """Per weapon tag, the base an endgame crafter picks for physical attacks: the highest physical DPS."""
    best = {}
    for row in rows:
        tag = WEAPON_CLASS_TAGS.get(row.get("class_id"))
        if tag is None or not flag(row.get("is_in_game")):
            continue
        low = number(row.get("physical_damage_min")) or 0
        high = number(row.get("physical_damage_max")) or 0
        speed = number(row.get("attack_speed")) or 0
        if speed <= 0 or high <= 0:
            continue
        base = {"name": wiki_text(row.get("name")), "physicalMin": low, "physicalMax": high, "attackSpeed": speed,
                "crit": number(row.get("critical_strike_chance")) or 5, "dropLevel": whole_number(row.get("drop_level")) or 1}
        dps = (low + high) / 2 * speed
        held = best.get(tag)
        if held is None or dps > (held["physicalMin"] + held["physicalMax"]) / 2 * held["attackSpeed"]:
            best[tag] = base
    return best


CLUSTER_TABLES = [
    {"name": "PassiveTreeExpansionJewelSizes", "columns": ["Name"]},
    {"name": "PassiveTreeExpansionSkills", "columns": ["PassiveSkillsKey", "Mastery_PassiveSkillsKey", "TagsKey",
                                                       "PassiveTreeExpansionJewelSizesKey"]},
    {"name": "PassiveSkills", "columns": ["Id", "Name", "IsNotable"]},
    {"name": "Tags", "columns": ["Id"]},
    {"name": "Mods", "columns": ["Id", "Domain", "GenerationType", "SpawnWeight_TagsKeys", "SpawnWeight_Values"]},
]


def name_key(text):
    """Letters only, lower case: "Vicious Skewering" and "AfflictionNotableViciousSkewering_" meet as viciousskewering."""
    return re.sub(r"[^a-z]", "", (text or "").lower())


def fetch_cluster_passives(refresh):
    return cargo_rows(
        "cluster-passives", tables="passive_skills",
        fields=["passive_skills.id", "passive_skills.name", "passive_skills.stat_text", "passive_skills.is_notable"],
        where='passive_skills.id LIKE "affliction_%"', order_by="passive_skills.id", refresh=refresh)


def large_cluster_types(cluster_tables, passive_rows):
    """Each large cluster jewel type: its small passive's name and stat text, and the notables it can roll."""
    text_of_id = {}
    notable_text_of_name = {}
    for row in passive_rows:
        text_of_id[row.get("id")] = wiki_text(row.get("stat_text"))
        if flag(row.get("is_notable")):
            notable_text_of_name[name_key(row.get("name"))] = (wiki_text(row.get("name")), wiki_text(row.get("stat_text")))
    sizes = cluster_tables["PassiveTreeExpansionJewelSizes"]
    passives = cluster_tables["PassiveSkills"]
    tags = cluster_tables["Tags"]
    notable_mods = [mod for mod in cluster_tables["Mods"] if mod["Id"].startswith("AfflictionNotable")]
    types = []
    for row in cluster_tables["PassiveTreeExpansionSkills"]:
        if sizes[row["PassiveTreeExpansionJewelSizesKey"]]["Name"] != "Large":
            continue
        tag = tags[row["TagsKey"]]["Id"]
        small = passives[row["PassiveSkillsKey"]]
        notables = []
        for mod in notable_mods:
            weights = zip(mod.get("SpawnWeight_TagsKeys") or [], mod.get("SpawnWeight_Values") or [])
            if not any(tags[key]["Id"] == tag and weight > 0 for key, weight in weights):
                continue
            found = notable_text_of_name.get(name_key(mod["Id"][len("AfflictionNotable"):]))
            if found and found[1]:
                notables.append({"name": found[0], "statText": found[1]})
        types.append({"tag": tag, "name": small["Name"], "smallText": text_of_id.get(small["Id"], ""),
                      "notables": notables})
    return types


def fetch_jewel_mods(refresh):
    rows = cargo_rows(
        "jewel-mods", tables="mods",
        fields=["mods.id", "mods.stat_text", "mods.generation_type"],
        where="mods.domain=10 AND mods.generation_type IN (1,2)", order_by="mods.id", refresh=refresh)
    mods = []
    for row in rows:
        text = wiki_text(row.get("stat_text"))
        if text:
            mods.append({"id": row.get("id"), "side": "p" if str(row.get("generation_type")) == "1" else "s", "statText": text})
    return mods


# The timeless jewels themselves: each unique "Historic" jewel says which conquerors it brings ("Passives in radius
# are Conquered by the Karui"), which is the keystones' alternate tree. The wiki's words for the families differ a
# little from the alternate tree names.
TIMELESS_FAMILY_OF_WORD = {"Karui": "Karui", "Vaal": "Vaal", "Templars": "Templar", "Eternal": "Eternal",
                           "Maraketh": "Maraketh", "Kalguur": "Kalguuran"}


def fetch_timeless_jewels(refresh):
    rows = cargo_rows(
        "timeless-jewels", tables="items", fields=["items.name", "items.stat_text"],
        where='items.class_id="Jewel" AND items.rarity_id="unique" AND items.stat_text LIKE "%Historic%"',
        order_by="items.name", refresh=refresh)
    jewels = []
    for row in rows:
        match = re.search(r"Conquered by the (\w+)", row.get("stat_text") or "")
        if match and match.group(1) in TIMELESS_FAMILY_OF_WORD:
            jewels.append({"name": wiki_text(row.get("name")), "family": TIMELESS_FAMILY_OF_WORD[match.group(1)]})
    return jewels


# Jewel radii from the game files (PassiveJewelRadii): Small 800, Medium 1200, Large 1500, in the game's units.
JEWEL_RADIUS_TABLES = [{"name": "PassiveJewelRadii", "columns": ["ID", "RingOuterRadius", "RingInnerRadius", "Radius"]}]


def fetch_jewel_radii():
    tables = export_tables("poe1-jewel-radii", JEWEL_RADIUS_TABLES)[1]
    radii = {}
    for row in tables["PassiveJewelRadii"]:
        radii[row["ID"]] = row["Radius"]
    return radii


def fetch_timeless_keystones(refresh):
    rows = cargo_rows(
        "timeless-keystones", tables="passive_skills",
        fields=["passive_skills.id", "passive_skills.name", "passive_skills.stat_text", "passive_skills.alternate_tree"],
        where='passive_skills.is_keystone=1 AND passive_skills.alternate_tree<>""', order_by="passive_skills.name",
        refresh=refresh)
    keystones = {}
    for row in rows:
        name = wiki_text(row.get("name"))
        if name:
            keystones[name] = {"name": name, "statText": wiki_text(row.get("stat_text")), "jewel": row.get("alternate_tree")}
    return sorted(keystones.values(), key=lambda keystone: keystone["name"])


# Where a node sits: its group's centre, then its orbit's radius at its slot's angle. Orbits of 16 and 40 slots
# space their slots unevenly (these angle tables are the game's; tree planners use the same); the others evenly.
ORBIT_ANGLES = {
    16: [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330],
    40: [0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170, 180, 190, 200, 210,
         220, 225, 230, 240, 250, 260, 270, 280, 290, 300, 310, 315, 320, 330, 340, 350],
}


def node_position(tree, node):
    """(x, y) of a node on GGG's tree, or None when it has no group."""
    group = tree["groups"].get(str(node.get("group")))
    if group is None:
        return None
    orbit = node.get("orbit", 0)
    slots = tree["constants"]["skillsPerOrbit"][orbit]
    radius = tree["constants"]["orbitRadii"][orbit]
    index = node.get("orbitIndex", 0)
    if slots in ORBIT_ANGLES:
        degrees = ORBIT_ANGLES[slots][index % slots]
    else:
        degrees = 360 * index / slots
    angle = math.radians(degrees)
    return round(group["x"] + radius * math.sin(angle)), round(group["y"] - radius * math.cos(angle))


def tree_graph(tree):
    """The main tree as the planner needs it: every node a character can allocate outside its ascendancy (no
    masteries, cluster proxies or anoint-only nodes), its kind, stat text and neighbours, and each class's start."""
    allocatable = {}
    for node_id, node in tree["nodes"].items():
        if node.get("ascendancyName") or node.get("isMastery") or node.get("isProxy") or node.get("isBlighted"):
            continue
        if node.get("expansionJewel") and not node.get("isJewelSocket"):
            continue
        # Sockets inside cluster jewel space are only there once a cluster jewel is socketed.
        if node.get("isJewelSocket") and (node.get("expansionJewel") or {}).get("parent"):
            continue
        if not node.get("name") and node.get("classStartIndex") is None:
            continue
        allocatable[str(node_id)] = node
    starts = {}
    nodes = {}
    for node_id, node in allocatable.items():
        if node.get("classStartIndex") is not None:
            kind = "start"
            starts[tree["classes"][node["classStartIndex"]]["name"]] = node_id
        elif node.get("isJewelSocket"):
            kind = "jewel"
        elif node.get("isKeystone"):
            kind = "keystone"
        elif node.get("isNotable"):
            kind = "notable"
        else:
            kind = "small"
        neighbours = []
        for other in list(node.get("out", [])) + list(node.get("in", [])):
            other = str(other)
            if other in allocatable and other not in neighbours and other != node_id:
                neighbours.append(other)
        nodes[node_id] = {"name": node.get("name") or "", "kind": kind, "statText": "\n".join(node.get("stats", [])),
                          "neighbours": neighbours}
        position = node_position(tree, node)
        if position is not None:
            # For drawing (public/buildtreeview.js): the position, and the group and orbit, since links between
            # nodes on the same orbit of a group are drawn as arcs, as in the game.
            nodes[node_id]["position"] = {"x": position[0], "y": position[1], "group": str(node.get("group")),
                                          "orbit": node.get("orbit", 0)}
        if kind == "jewel" and (node.get("expansionJewel") or {}).get("size") == 2:
            nodes[node_id]["largeCluster"] = True  # an outer socket: takes a large cluster jewel
    masteries, mastery_options = tree_masteries(tree, nodes)
    groups = {}
    for group_id, group in tree["groups"].items():
        groups[group_id] = {"x": round(group["x"]), "y": round(group["y"])}
    radii = tree["constants"]["orbitRadii"]
    return {"starts": starts, "nodes": nodes, "points": tree.get("points", {}), "masteries": masteries,
            "groups": groups, "orbitRadii": radii,
            "masteryOptions": mastery_options}


def tree_masteries(tree, nodes):
    """The tree's masteries: each mastery node with the notables that unlock it (one of them allocated makes it
    allocatable, for one point), and each mastery type's options. Masteries of one type share their options, and a
    tree can take each option only once."""
    masteries = {}
    options_of_type = {}
    for node_id, node in tree["nodes"].items():
        if not node.get("isMastery") or not node.get("masteryEffects") or node.get("ascendancyName"):
            continue
        unlocked_by = []
        for other in list(node.get("in", [])) + list(node.get("out", [])):
            other = str(other)
            if other in nodes and nodes[other]["kind"] == "notable" and other not in unlocked_by:
                unlocked_by.append(other)
        if not unlocked_by:
            continue
        masteries[str(node_id)] = {"name": node["name"], "unlockedBy": unlocked_by, "position": node_position(tree, node)}
        options = options_of_type.setdefault(node["name"], {})
        for effect in node["masteryEffects"]:
            options[str(effect["effect"])] = "\n".join(effect.get("stats", []))
    mastery_options = {}
    for name, options in options_of_type.items():
        mastery_options[name] = [{"id": option_id, "statText": text} for option_id, text in options.items()]
    return masteries, mastery_options


def bloodline_graphs(tree):
    """Each bloodline's nodes, small ones included, with their links: {bloodline name: {node id: node}}. A bloodline
    shares the ascendancy points (3.28 patch notes), so what a notable costs is the path to it from the start."""
    ascendancy_ids = set()
    for character_class in tree["classes"]:
        for ascendancy in character_class.get("ascendancies", []):
            ascendancy_ids.add(ascendancy["id"])
    bloodline_name = {}
    for bloodline in tree.get("alternate_ascendancies", []):
        bloodline_name[bloodline["id"]] = bloodline["name"]
    graphs = {}
    for node_id, node in tree["nodes"].items():
        owner = node.get("ascendancyName")
        if not owner or owner in ascendancy_ids or not node.get("name"):
            continue
        name = bloodline_name.get(owner, owner)
        graphs.setdefault(name, {})[str(node_id)] = {
            "name": node["name"],
            "statText": "\n".join(node.get("stats", [])),
            "notable": bool(node.get("isNotable")),
            "start": bool(node.get("isAscendancyStart")),
            "out": [str(other) for other in node.get("out", [])],
        }
    return graphs


def load_build_sources(refresh=False):
    patch, skill_tables = export_tables("poe1-skills", SKILL_TABLES)
    tree = fetch_tree(refresh)
    class_of_ascendancy, passives = read_tree(tree)
    gem_rows, level_rows = fetch_gems(refresh)
    return {
        "patch": patch,
        "source": "GGG's passive tree export and game files; poewiki.net (CC BY-NC-SA 3.0) for gems and uniques",
        "gems": normalise_gems(gem_rows, level_rows, skill_types_by_effect(skill_tables)),
        "uniques": normalise_uniques(fetch_uniques(refresh)),
        "passives": passives,
        "timelessKeystones": fetch_timeless_keystones(refresh),
        "timelessJewels": fetch_timeless_jewels(refresh),
        "jewelRadii": fetch_jewel_radii(),
        "flasks": normalise_flasks(*fetch_flasks(refresh)),
        "weaponBases": best_weapon_bases(fetch_weapon_bases(refresh)),
        "jewelMods": fetch_jewel_mods(refresh),
        "largeClusters": large_cluster_types(export_tables("poe1-clusters", CLUSTER_TABLES)[1], fetch_cluster_passives(refresh)),
        "classOfAscendancy": class_of_ascendancy,
        "skillTables": skill_tables,
        "treeGraph": tree_graph(tree),
        "bloodlineGraphs": bloodline_graphs(tree),
    }
