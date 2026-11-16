#!/usr/bin/env python3
"""Checks our reading of stat lines (scripts/mechanics_vocabulary.py) against Path of Building's.

    python3 scripts/check_against_pob.py [--refresh] [--examples N]

Path of Building is a consultant here, like poe.ninja: nothing it says enters our data or our scores. Its
ModCache.lua holds about 23,000 game stat lines it has already read into mods (src/Data/ModCache.lua in
https://github.com/PathOfBuildingCommunity/PathOfBuilding, MIT licence). We run every one of those lines through
our own vocabulary and report where the two readings differ, so we know what to teach ours next:

- conditions: PoB reads a condition on the line ("while on Low Life", "per Frenzy Charge") and we read it as always
  on. These overrate a piece, so they come first.
- disagreements on lines both read: a different kind (increased / more / flat), value, sign or damage type, for the
  mods we know how to compare (MAPPED_NAMES).
- gaps: lines PoB reads fully and we leave unread, counted by PoB's mod name, so the biggest groups show what is
  worth teaching.
- lines we read and PoB doesn't: worth a look, since either of us may be wrong.

A disagreement is a question, not an answer: PoB is checked against the game too, but it can be wrong. Fix a
misreading in our vocabulary in our own words and add the line to scripts/test_mechanics.py.

The file is downloaded once a week into .cache/pob/ (--refresh asks again); the full report goes to
.cache/pob/comparison.json.
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

from mechanics_vocabulary import read_line_effects
from poewiki import USER_AGENT
from text_files import read_utf8, write_utf8, use_utf8_console

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "pob"
MOD_CACHE_FILE = CACHE / "ModCache.lua"
REPORT_FILE = CACHE / "comparison.json"
MOD_CACHE_URL = "https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding/master/src/Data/ModCache.lua"
CACHE_DAYS = 7

# PoB's mod types and our kinds. BASE is a flat amount for most stats; for damage it is the added damage of an
# "Adds X to Y" line, which PoB splits into a Min and a Max mod (not compared).
KIND_OF_TYPE = {"INC": "increased", "MORE": "more", "BASE": "flat", "FLAG": "flag"}

# PoB's mod names we know how to compare, as (our stat, our damage type tag or None, our kind when it differs
# from KIND_OF_TYPE). Only these are checked value for value; the rest count towards coverage.
MAPPED_NAMES = {
    "Life": ("life", None, None), "Mana": ("mana", None, None), "EnergyShield": ("energyShield", None, None),
    "Armour": ("armour", None, None), "Evasion": ("evasion", None, None), "MovementSpeed": ("movementSpeed", None, None),
    "CritChance": ("critChance", None, None), "CritMultiplier": ("critMulti", None, None),
    "Damage": ("damage", None, None), "PhysicalDamage": ("damage", "physical", None), "FireDamage": ("damage", "fire", None),
    "ColdDamage": ("damage", "cold", None), "LightningDamage": ("damage", "lightning", None), "ChaosDamage": ("damage", "chaos", None),
    "ElementalDamage": ("damage", "elemental", None),
    "FireResist": ("resistance", "fire", "resistance"), "ColdResist": ("resistance", "cold", "resistance"),
    "LightningResist": ("resistance", "lightning", "resistance"), "ChaosResist": ("resistance", "chaos", "resistance"),
    "LootRarity": ("itemRarity", None, None), "LootQuantity": ("itemQuantity", None, None),
}
# Where one PoB name is two of our stats, told apart by the mod type: "+1% to Critical Strike Chance" adds to the
# base crit chance (our baseCrit), "10% increased Critical Strike Chance" is our critChance.
MAPPED_BY_TYPE = {("CritChance", "BASE"): ("baseCrit", None, "flat")}
DAMAGE_TYPE_TAGS = {"physical", "fire", "cold", "lightning", "chaos", "elemental", "nonChaos"}
# PoB's ModFlag bits for how damage is dealt (src/Data/Global.lua), as our scope tags.
FLAG_TAGS = {1: "attack", 2: "spell"}
# Tag types on a PoB mod that mean the line holds only some of the time or scales with something.
CONDITIONAL_TAG_TYPES = {"Condition", "ActorCondition", "Multiplier", "MultiplierThreshold", "PerStat", "StatThreshold"}


# ---------- reading ModCache.lua ----------
def fetch_mod_cache(refresh):
    fresh = MOD_CACHE_FILE.exists() and time.time() - MOD_CACHE_FILE.stat().st_mtime < CACHE_DAYS * 86400
    if fresh and not refresh:
        return read_utf8(MOD_CACHE_FILE)
    request = urllib.request.Request(MOD_CACHE_URL, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        body = response.read().decode("utf-8")
    CACHE.mkdir(parents=True, exist_ok=True)
    write_utf8(MOD_CACHE_FILE, body)
    print(f"  Path of Building ModCache.lua: {len(body) // 1024} KB")
    return body


class LuaReader:
    """Reads the Lua table literals ModCache.lua is made of: tables, strings, numbers, true, false and nil."""

    NUMBER = re.compile(r"-?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)")
    NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
    DOTTED_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")

    def __init__(self, text, position=0):
        self.text = text
        self.position = position

    def skip_space(self):
        while self.position < len(self.text) and self.text[self.position] in " \t\r\n":
            self.position += 1

    def value(self):
        self.skip_space()
        character = self.text[self.position]
        if character == "{":
            return self.table()
        if character == '"':
            return self.string()
        negative = character == "-" and self.DOTTED_NAME.match(self.text, self.position + 1)
        name = self.DOTTED_NAME.match(self.text, self.position + 1 if negative else self.position)
        if name:
            self.position = name.end()
            # math.huge is how PoB writes "no limit".
            word = name.group(0)
            if word == "math.huge":
                return float("-inf") if negative else float("inf")
            return {"true": True, "false": False, "nil": None}.get(word, word)
        number = self.NUMBER.match(self.text, self.position)
        if number:
            self.position = number.end()
            return float(number.group(0))
        raise ValueError(f"unexpected {character!r} at {self.position}")

    def string(self):
        self.position += 1  # the opening quote
        characters = []
        while True:
            character = self.text[self.position]
            if character == "\\":
                following = self.text[self.position + 1]
                characters.append({"n": "\n", "t": "\t"}.get(following, following))
                self.position += 2
                continue
            self.position += 1
            if character == '"':
                return "".join(characters)
            characters.append(character)

    def table(self):
        """A Lua table as a dict; keys of [1], [2]... become the integers 1, 2..."""
        self.position += 1  # the opening brace
        result = {}
        next_index = 1
        while True:
            self.skip_space()
            if self.text[self.position] == "}":
                self.position += 1
                return result
            key = None
            if self.text[self.position] == "[":
                self.position += 1
                key = self.value()
                if isinstance(key, float):
                    key = int(key)
                self.skip_space()
                self.position += 2  # "]="
            else:
                name = self.NAME.match(self.text, self.position)
                after = self.text[name.end():name.end() + 1] if name else ""
                if name and after == "=" and self.text[name.end():name.end() + 2] != "==":
                    key = name.group(0)
                    self.position = name.end() + 1
            item = self.value()
            if key is None:
                key = next_index
                next_index += 1
            result[key] = item
            self.skip_space()
            if self.text[self.position] == ",":
                self.position += 1


ENTRY_START = re.compile(r'^c\["', re.MULTILINE)


def mod_cache_entries(text):
    """(line, mods or None, the part PoB couldn't read or None) for every entry."""
    entries = []
    for match in ENTRY_START.finditer(text):
        reader = LuaReader(text, match.end() - 1)
        line = reader.string()
        reader.skip_space()
        reader.position += 2  # "]="
        entry = reader.value()
        mods = entry.get(1)
        remainder = entry.get(2)
        mod_list = None
        if isinstance(mods, dict):
            mod_list = [mods[key] for key in sorted(key for key in mods if isinstance(key, int))]
        entries.append((line, mod_list, remainder.strip() if isinstance(remainder, str) else None))
    return entries


# ---------- comparing ----------
def pob_is_conditional(mod):
    for key, tag in mod.items():
        if isinstance(key, int) and isinstance(tag, dict) and tag.get("type") in CONDITIONAL_TAG_TYPES:
            return True
    return False


def our_reading(line):
    """Our first effect for the line, or None when we leave it unread."""
    try:
        effects = read_line_effects(line, "roll")
    except Exception:  # a crash on a line is a gap, reported like one
        return None
    if not effects:
        return None
    first = effects[0]
    if first.get("kind") in ("unknown", None) or first.get("understood") is False:
        return None
    return first


def compare_mapped(line, mod, ours):
    """What differs between PoB's mod and our effect for a mod name in MAPPED_NAMES; an empty list when they agree."""
    stat, damage_tag, kind_override = MAPPED_NAMES[mod["name"]]
    if (mod["name"], mod.get("type")) in MAPPED_BY_TYPE:
        stat, damage_tag, kind_override = MAPPED_BY_TYPE[(mod["name"], mod.get("type"))]
    problems = []
    wanted_kind = kind_override or KIND_OF_TYPE.get(mod.get("type"))
    if ours.get("stat") != stat:
        problems.append(f"stat {ours.get('stat')} (PoB {mod['name']})")
    if wanted_kind and ours.get("kind") != wanted_kind:
        problems.append(f"kind {ours.get('kind')} (PoB {mod.get('type')})")
    pob_value = mod.get("value")
    our_value = ours.get("value")
    if isinstance(pob_value, float) and isinstance(our_value, (int, float)) and abs(pob_value - our_value) > 0.01 + 0.001 * abs(pob_value):
        problems.append(f"value {our_value:g} (PoB {pob_value:g})")
    our_damage_tags = sorted(set(ours.get("tags") or []) & DAMAGE_TYPE_TAGS)
    pob_damage_tags = [damage_tag] if damage_tag else []
    if stat in ("damage", "resistance") and our_damage_tags != pob_damage_tags:
        problems.append(f"damage type {our_damage_tags or 'any'} (PoB {pob_damage_tags or 'any'})")
    flags = int(mod.get("flags") or 0)
    our_tags = set(ours.get("tags") or [])
    for bit, tag in FLAG_TAGS.items():
        if flags & bit and tag not in our_tags and stat == "damage":
            problems.append(f"scope: PoB limits it to {tag}, we don't")
    return problems


def compare(entries):
    report = {"conditions": [], "disagreements": [], "gaps": {}, "weReadPobDoesnt": [], "agree": 0, "bothReadUnmapped": 0,
              "pobRead": 0, "weRead": 0, "lines": len(entries)}
    for line, mods, remainder in entries:
        pob_reads = bool(mods) and not remainder
        ours = our_reading(line)
        if pob_reads:
            report["pobRead"] += 1
        if ours is not None:
            report["weRead"] += 1
        if pob_reads and ours is None:
            name = mods[0].get("name", "?")
            report["gaps"].setdefault(name, []).append(line)
            continue
        if not pob_reads:
            # PoB doesn't cache a line holding a roll range, "(10-15)%": it reads those when an item is loaded.
            has_range = re.search(r"\(\s*-?\d", line) is not None
            if ours is not None and ours.get("kind") != "minor" and remainder and not has_range:
                report["weReadPobDoesnt"].append({"line": line, "ours": ours, "pobLeftOver": remainder})
            continue
        first = mods[0]
        we_condition = ours.get("condition") or ours.get("requires")  # "while holding a Shield" is a requirement for us
        if pob_is_conditional(first) and not we_condition and ours.get("kind") != "minor":
            report["conditions"].append({"line": line, "ours": ours, "pob": first})
            continue
        if first.get("name") not in MAPPED_NAMES or len(mods) > 1:
            report["bothReadUnmapped"] += 1
            continue
        problems = compare_mapped(line, first, ours)
        if problems:
            report["disagreements"].append({"line": line, "problems": problems, "ours": ours, "pob": first})
        else:
            report["agree"] += 1
    return report


def with_text_keys(value):
    if isinstance(value, dict):
        return {str(key): with_text_keys(item) for key, item in value.items()}
    if isinstance(value, list):
        return [with_text_keys(item) for item in value]
    return value


def print_report(report, examples):
    print(f"{report['lines']} PoB lines: PoB reads {report['pobRead']}, we read {report['weRead']}")
    print(f"  of the mods we compare value for value: {report['agree']} agree, {len(report['disagreements'])} differ")
    print(f"  {report['bothReadUnmapped']} more lines both read (mods we don't compare yet)")
    print(f"\nconditions PoB reads and we don't ({len(report['conditions'])}; these overrate a piece):")
    for entry in report["conditions"][:examples]:
        print(f"  {entry['line']}")
    print(f"\ndisagreements ({len(report['disagreements'])}):")
    for entry in report["disagreements"][:examples]:
        print(f"  {entry['line']}: {'; '.join(entry['problems'])}")
    gap_groups = sorted(report["gaps"].items(), key=lambda item: -len(item[1]))
    gap_total = sum(len(lines) for _, lines in gap_groups)
    print(f"\ngaps: {gap_total} lines PoB reads and we don't, by PoB's mod name (the biggest groups):")
    for name, lines in gap_groups[:examples]:
        print(f"  {name}: {len(lines)}, e.g. {lines[0]}")
    print(f"\nlines we read and PoB doesn't ({len(report['weReadPobDoesnt'])}):")
    for entry in report["weReadPobDoesnt"][:examples]:
        print(f"  {entry['line']}")
    print(f"\nfull report: {REPORT_FILE.relative_to(ROOT)}")


def main():
    use_utf8_console()
    arguments = sys.argv[1:]
    examples = 12
    if "--examples" in arguments:
        examples = int(arguments[arguments.index("--examples") + 1])
    text = fetch_mod_cache("--refresh" in arguments)
    entries = mod_cache_entries(text)
    report = compare(entries)
    CACHE.mkdir(parents=True, exist_ok=True)
    # PoB's tables mix number and name keys, so keys are written as text and not sorted.
    write_utf8(REPORT_FILE, json.dumps(with_text_keys(report), indent=1, default=str))
    print_report(report, examples)


if __name__ == "__main__":
    main()
