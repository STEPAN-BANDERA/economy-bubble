"""What a timeless jewel does to the passives in its radius, from GGG's game files, as the tree planner applies it
(public/buildradius.js, the "conquer" rule).

    sources = fetch_conquest_sources()        # scripts/build_sources.py calls this
    conquests = conquests_of(sources, read_effects)   # {family: conquest}, family as in AlternateTreeVersions ("Karui")

Each conqueror (AlternateTreeVersions) says, for small attribute passives (+10 to an attribute), other small
passives and notables, whether they are replaced by one of its own passives (AlternatePassiveSkills) or keep their
stats and gain some of its additions (AlternatePassiveAdditions), how many additions, and how often a notable is
replaced. Which passive or addition a passive gets depends on the jewel's seed. The planner has no seed, so this is
the typical seed: every replacement and addition weighted by its spawn weight, at the middle of its roll. A seed
someone chose for a build is better than this; one nobody chose is about this.

The columns of AlternateTreeVersions have no names in the schema; their order, read from the rows themselves:
two flags (small attribute passives replaced, other small passives replaced), then the least and most additions
for small attribute passives, other small passives and notables, then the notable replacement weight (out of 100).
Karui and Maraketh: nothing replaced, one addition each. Vaal and Eternal: everything replaced. Templar: attribute passives
replaced, one Devotion addition on the others, notables replaced at 20. Kalguur: one Ward addition on small passives,
notables always replaced. A layout that doesn't give these is refused (conquests_of raises), not guessed.

Additions and replacements give their stats as ids and rolls; their wording comes from the game's stat description
files (scripts/stat_descriptions.py) and is read by our vocabulary like any line. A stat line it can't read fully
counts as nothing, and the share of the weight read is kept (`read`) for the coverage report.

The conquest data (AlternateTreeVersions, AlternatePassiveSkills, AlternatePassiveAdditions) is GGG's; nothing here
comes from Path of Building or a seed calculator.
"""
import json
import struct

from game_files import export_files, export_tables
from stat_descriptions import describe, read_descriptions

CONQUEST_TABLES = [
    {"name": "AlternatePassiveAdditions", "columns": ["Id", "AlternateTreeVersionsKey", "SpawnWeight", "StatsKeys",
                                                      "Stat1Min", "Stat1Max", "PassiveType"]},
    {"name": "AlternatePassiveSkills", "columns": ["Id", "AlternateTreeVersionsKey", "Name", "PassiveType", "StatsKeys",
                                                   "Stat1Min", "Stat1Max", "Stat2Min", "Stat2Max", "SpawnWeight"]},
    {"name": "Stats", "columns": ["Id"]},
]
TREE_VERSIONS_FILE = "Data/AlternateTreeVersions.datc64"
DESCRIPTION_FILES = ["Metadata/StatDescriptions/stat_descriptions.csd",
                     "Metadata/StatDescriptions/passive_skill_stat_descriptions.csd"]
# The passive kinds as the conquest tables number them.
SMALL_ATTRIBUTE = 1
SMALL_OTHER = 2
NOTABLE = 3
# AlternateTreeVersions' row: Id (string), two flags, seven 32-bit numbers, Name (string).
TREE_VERSION_ROW = struct.Struct("<QBB7iQ")
# Known rows, to refuse a changed layout: (small attribute replaced, other small replaced, notable additions, weight).
EXPECTED_LAYOUT = {"Karui": (False, False, 1, 0), "Maraketh": (False, False, 1, 0), "Vaal": (True, True, 0, 100), "Templar": (True, False, 1, 20),
                   "Eternal": (True, True, 0, 100), "Kalguuran": (False, False, 0, 100)}


def fetch_conquest_sources():
    """The game files the conquests are read from: {tables, files} (files as bytes; the description files are
    UTF-16 text, the game's own encoding)."""
    tables = export_tables("poe1-timeless", CONQUEST_TABLES)[1]
    files = export_files("poe1-timeless-files", [TREE_VERSIONS_FILE] + DESCRIPTION_FILES)[1]
    return {"tables": tables, "files": files}


def conquests_of(sources, read_effects):
    """{family: {smallAttribute, small, notable, read}}: see the module's docstring."""
    tables = sources["tables"]
    files = sources["files"]
    descriptions = read_descriptions([files[path].decode("utf-16") for path in DESCRIPTION_FILES])
    versions = tree_versions(files[TREE_VERSIONS_FILE])
    check_layout(versions)
    stat_ids = [row["Id"] for row in tables["Stats"]]
    reader = OptionReader(descriptions, read_effects)
    conquests = {}
    for index, version in enumerate(versions):
        if version["id"] not in EXPECTED_LAYOUT:
            continue  # the Abyss and Blight versions: no timeless jewel in our list conquers with them
        replacements = [row for row in tables["AlternatePassiveSkills"] if row["AlternateTreeVersionsKey"] == index]
        additions = [row for row in tables["AlternatePassiveAdditions"] if row["AlternateTreeVersionsKey"] == index]
        conquests[version["id"]] = conquest_of(version, replacements, additions, stat_ids, reader)
    return conquests


def tree_versions(data):
    row_count = struct.unpack_from("<I", data, 0)[0]
    marker = data.find(b"\xbb" * 8)
    if row_count == 0 or (marker - 4) % row_count != 0 or (marker - 4) // row_count != TREE_VERSION_ROW.size:
        raise ValueError("AlternateTreeVersions: the row size changed; read the new layout before using it")
    variable = data[marker:]
    versions = []
    for row in range(row_count):
        fields = TREE_VERSION_ROW.unpack_from(data, 4 + row * TREE_VERSION_ROW.size)
        numbers = fields[3:10]
        versions.append({
            "id": string_at(variable, fields[0]),
            "smallAttributeReplaced": bool(fields[1]), "smallReplaced": bool(fields[2]),
            "additions": {SMALL_ATTRIBUTE: (numbers[0], numbers[1]), SMALL_OTHER: (numbers[2], numbers[3]),
                          NOTABLE: (numbers[4], numbers[5])},
            "notableReplacementWeight": numbers[6],
        })
    return versions


def string_at(variable, offset):
    end = offset
    while variable[end:end + 4] != b"\0\0\0\0":
        end += 2
    return variable[offset:end].decode("utf-16-le")


def check_layout(versions):
    by_id = {version["id"]: version for version in versions}
    for family, expected in EXPECTED_LAYOUT.items():
        version = by_id.get(family)
        if version is None:
            raise ValueError(f"AlternateTreeVersions: no {family} row")
        found = (version["smallAttributeReplaced"], version["smallReplaced"], version["additions"][NOTABLE][1],
                 version["notableReplacementWeight"])
        if found != expected:
            raise ValueError(f"AlternateTreeVersions: {family} reads {found}, expected {expected}; the layout changed")


class OptionReader:
    """Each replacement's or addition's effects at the middle of its rolls, read once."""

    def __init__(self, descriptions, read_effects):
        self.descriptions = descriptions
        self.read_effects = read_effects

    def effects(self, values):
        """(effects, read): read is False when a line couldn't be worded or read fully (its effects then count as
        nothing)."""
        if not values:
            return [], True
        lines = describe(self.descriptions, values)
        if lines is None:
            return [], False
        effects = []
        for line in lines:
            found, unread = self.read_effects(line)
            if unread:
                return [], False
            effects.extend(found)
        return effects, True


def middle(low, high):
    return (low + high) / 2


def replacement_values(row, stat_ids):
    rolls = [(row["Stat1Min"], row["Stat1Max"]), (row["Stat2Min"], row["Stat2Max"])]
    values = {}
    for position, stat in enumerate(row["StatsKeys"][:2]):
        values[stat_ids[stat]] = middle(*rolls[position])
    return values


def addition_values(row, stat_ids):
    return {stat_ids[row["StatsKeys"][0]]: middle(row["Stat1Min"], row["Stat1Max"])} if row["StatsKeys"] else {}


def weighted_effects(options, reader, count=1):
    """The options' effects weighted by spawn weight and summed (the typical one), times `count`; and the share of
    the weight whose lines were read."""
    total = sum(weight for weight, _ in options)
    if total <= 0:
        return [], 1
    expected = {}
    read_weight = 0
    for weight, values in options:
        effects, read = reader.effects(values)
        if read:
            read_weight += weight
        for effect in effects:
            if not isinstance(effect.get("value"), (int, float)):
                continue  # a rule without a number can't be a share of one; only a sure one would count
            key = json.dumps({name: value for name, value in effect.items() if name != "value"}, sort_keys=True)
            share = effect["value"] * weight / total * count
            if key in expected:
                expected[key]["value"] += share
            else:
                expected[key] = {**effect, "value": share}
    rounded = []
    for effect in expected.values():
        effect["value"] = round(effect["value"], 3)
        if effect["value"] != 0:
            rounded.append(effect)
    return rounded, read_weight / total


def conquest_of(version, replacements, additions, stat_ids, reader):
    shares_read = []

    def options_for(rows, kind, values_of):
        return [(row["SpawnWeight"], values_of(row, stat_ids)) for row in rows if kind in (row["PassiveType"] or [])]

    def small_part(kind, replaced):
        if replaced:
            effects, read = weighted_effects(options_for(replacements, kind, replacement_values), reader)
        else:
            low, high = version["additions"][kind]
            effects, read = weighted_effects(options_for(additions, kind, addition_values), reader, middle(low, high))
        shares_read.append(read)
        return {"replaced": replaced, "effects": effects}

    low, high = version["additions"][NOTABLE]
    addition, addition_read = weighted_effects(options_for(additions, NOTABLE, addition_values), reader, middle(low, high))
    replacement, replacement_read = weighted_effects(options_for(replacements, NOTABLE, replacement_values), reader)
    shares_read.extend([addition_read, replacement_read])
    return {
        "smallAttribute": small_part(SMALL_ATTRIBUTE, version["smallAttributeReplaced"]),
        "small": small_part(SMALL_OTHER, version["smallReplaced"]),
        "notable": {"replacedShare": min(1, version["notableReplacementWeight"] / 100), "replacement": replacement,
                    "addition": addition},
        "read": round(min(shares_read), 3),
    }
