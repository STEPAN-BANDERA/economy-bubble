#!/usr/bin/env python3
"""How the vocabulary reads every passive tree line: tree nodes (small, notable, keystone), mastery options and
ascendancy notables, straight from GGG's tree export (.cache/skilltree/data.json, which scripts/build_sources.py
downloads). For each line it reports one of:

    unread     nothing read it (it is left out of the effects)
    leftover   it was read, but some words were not, so the reading isn't trusted and it is left out
    unused     it was read into a stat, flag or condition no engine file names, so it changes nothing
    ok         read into effects the engine knows

    python3 scripts/audit_tree_reading.py [--all]      (--all also lists the ok lines)

"Unused" catches misreadings that the coverage numbers count as understood: "12% increased Area of Effect" once
became effect:areaOf, a stat nothing reads, instead of area. The engine files are searched for each name in quotes
or as a property, which is how they refer to stats, flags and conditions. The report is saved to
.cache/tree-reading.json. It reads public sources only, like the rest of the build data.
"""
import json
import re
import sys
from pathlib import Path

from mechanics_vocabulary import read_line_effects, split_lines
from text_files import read_utf8, use_utf8_console, write_utf8

ROOT = Path(__file__).resolve().parent.parent
TREE_EXPORT = ROOT / ".cache" / "skilltree" / "data.json"
REPORT = ROOT / ".cache" / "tree-reading.json"
ENGINE_FILES = ["buildgen.js", "buildstages.js", "buildgear.js", "buildtree.js", "buildsearch.js", "buildtags.js"]

# Effect kinds whose stat is a name the engine looks up; "minor" and "unknown" have none.
NAMED_KINDS = {"increased", "more", "flat", "limit", "chance", "flag", "level", "resistance", "exposure",
               "penetration", "conversion", "extra", "added"}
# Names every reading may carry that aren't stats the engine has to know.
ALWAYS_KNOWN = {"minor", "damage", "other"}


def engine_names():
    """Every quoted word and property name in the engine files: the stats, flags and conditions they read."""
    names = set()
    for file_name in ENGINE_FILES:
        text = read_utf8(ROOT / "public" / file_name)
        for match in re.finditer(r"['\"`]([A-Za-z][\w:]*)['\"`]", text):
            names.add(match.group(1))
        for match in re.finditer(r"\b([A-Za-z]\w*)\s*:", text):
            names.add(match.group(1))
        for match in re.finditer(r"\.([A-Za-z]\w*)\b", text):
            names.add(match.group(1))
    return names


def name_is_known(name, known):
    if name is None or name in ALWAYS_KNOWN or name in known:
        return True
    # "affectedBy:Hatred" and "effect:aura" style names: the engine checks the prefix and the rest separately.
    if ":" in name:
        prefix, rest = name.split(":", 1)
        if prefix == "affectedBy":
            return True
        if prefix == "effect":
            return name in known or rest in known
    return False


def unknown_names(found, known):
    """The names in one effect that no engine file mentions."""
    unknown = []
    if found.get("kind") in NAMED_KINDS and not name_is_known(found.get("stat"), known):
        unknown.append("stat " + str(found.get("stat")))
    condition = found.get("condition")
    if condition and not name_is_known(condition, known):
        unknown.append("condition " + condition)
    return unknown


def verdict_of(effects, known):
    unread = []
    leftover = []
    unused = []
    for found in effects:
        if found.get("kind") == "unknown":
            unread.append(found)
            continue
        if not found.get("understood"):
            leftover.append(" ".join(found.get("leftover") or []))
            continue
        unused.extend(unknown_names(found, known))
    if unread:
        return "unread", ""
    if leftover:
        return "leftover", "; ".join(leftover)
    if unused:
        return "unused", ", ".join(unused)
    return "ok", ""


def tree_lines(export):
    """(where, line) for every stat line on the tree: nodes, mastery options, ascendancy nodes."""
    lines = []
    for node in export["nodes"].values():
        if node.get("isBloodline") or node.get("isProxy"):
            continue
        name = node.get("name") or ""
        if node.get("ascendancyName"):
            where = "ascendancy " + node["ascendancyName"] + ": " + name
        elif node.get("isMastery"):
            for option in node.get("masteryEffects") or []:
                for line in split_lines("\n".join(option.get("stats", []))):
                    lines.append(("mastery " + name, line))
            continue
        elif node.get("isKeystone"):
            where = "keystone " + name
        elif node.get("isNotable"):
            where = "notable " + name
        else:
            where = "small " + name
        for line in split_lines("\n".join(node.get("stats", []))):
            lines.append((where, line))
    return lines


def describe(effects):
    parts = []
    for found in effects:
        text = f"{found.get('kind')} {found.get('stat')} {found.get('value')}"
        if found.get("tags"):
            text += " [" + ",".join(found["tags"]) + "]"
        if found.get("condition"):
            text += " if " + found["condition"]
        if found.get("requires"):
            text += " needs " + ",".join(found["requires"])
        if found.get("subject") and found.get("subject") != "self":
            text += " (" + found["subject"] + ")"
        parts.append(text)
    return "; ".join(parts)


def main():
    show_all = "--all" in sys.argv[1:]
    export = json.loads(read_utf8(TREE_EXPORT))
    known = engine_names()
    seen = {}
    for where, line in tree_lines(export):
        if line in seen:
            seen[line]["where"].append(where)
            continue
        effects = read_line_effects(line)
        verdict, detail = verdict_of(effects, known)
        seen[line] = {"line": line, "where": [where], "verdict": verdict, "detail": detail, "reading": describe(effects)}
    counts = {}
    for entry in seen.values():
        counts[entry["verdict"]] = counts.get(entry["verdict"], 0) + 1
    for verdict in ("unread", "leftover", "unused", "ok"):
        if verdict == "ok" and not show_all:
            continue
        entries = [entry for entry in seen.values() if entry["verdict"] == verdict]
        if not entries:
            continue
        print(f"== {verdict} ({len(entries)})")
        for entry in sorted(entries, key=lambda item: item["where"][0]):
            detail = f"  <{entry['detail']}>" if entry["detail"] else ""
            print(f"  {entry['where'][0]}: {entry['line']}{detail}")
            if verdict != "unread":
                print(f"      -> {entry['reading']}")
    total = len(seen)
    summary = ", ".join(f"{verdict} {counts.get(verdict, 0)}" for verdict in ("ok", "unused", "leftover", "unread"))
    print(f"{total} distinct tree lines: {summary}")
    write_utf8(REPORT, json.dumps({"counts": counts, "lines": list(seen.values())}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    use_utf8_console()
    main()
