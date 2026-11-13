#!/usr/bin/env python3
"""Build public/data/builds/icons-poe1.json, which tells the Build maker's cards where each piece's icon is:

    python3 scripts/build_icons.py [--refresh] [--check]

No image is stored here: every icon is loaded from Grinding Gear Games' own image server (web.poecdn.com),
and this file only says where. From public sources only:
- passives (keystones, notables, ascendancy and bloodline notables, masteries): GGG's passive tree export
  (scripts/build_sources.py) names each node's icon and where it sits on the sprite sheets the export links to;
- gems, unique items, flasks and jewels: GGG's game files (scripts/game_files.py) give each item's art file
  (ItemVisualIdentity), which poecdn serves as a PNG at /image/<art path>.png;
- the keystones only timeless jewels grant: poewiki.net's tables (as scripts/build_sources.py reads them) say
  which jewel grants each, and that jewel's picture stands for the keystone.

--refresh asks for the tree export and the wiki again even when their answers are less than a week old. --check asks poecdn for every item
picture (one request at a time) and lists the ones it doesn't have; it isn't needed for a normal rebuild.
"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from build_sources import fetch_timeless_jewels, fetch_timeless_keystones, fetch_tree
from game_files import export_tables
from poewiki import USER_AGENT
from text_files import use_utf8_console, write_utf8

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "builds" / "icons-poe1.json"
ITEM_ART_PREFIX = "Art/2DItems/"
ITEM_IMAGE_URL = "https://web.poecdn.com/image/" + ITEM_ART_PREFIX
ITEM_TABLES = [
    {"name": "BaseItemTypes", "columns": ["Id", "Name", "ItemVisualIdentity"]},
    {"name": "ItemVisualIdentity", "columns": ["Id", "DDSFile"]},
    {"name": "UniqueStashLayout", "columns": ["WordsKey", "ItemVisualIdentityKey", "RenamedVersion"]},
    {"name": "Words", "columns": ["Text2"]},
]
# Base items whose pictures the cards can show: gems (supports, auras, curses), flasks, and jewel bases.
ITEM_ID_PREFIXES = ("Metadata/Items/Gems/", "Metadata/Items/Flasks/", "Metadata/Items/Jewels/")
# Names the cards use that aren't an item's name. The generator writes "Rare jewel" for a rare jewel of any colour;
# a Crimson Jewel's picture stands for it.
ITEM_ALIASES = {"Rare jewel": "Crimson Jewel"}
# The sprite sheets a passive's icon is looked up on, in order: the allocated ("active") look of each node kind.
SHEETS_BY_KIND = {
    "keystone": ["keystoneActive"],
    "notable": ["notableActive"],
    "mastery": ["masteryActiveSelected", "mastery"],
}


# ---------- passives ----------
def largest_zoom(sheet_by_zoom):
    """The sharpest copy of a sprite sheet: the cards draw icons small, but screens with dense pixels need detail."""
    largest = None
    for zoom in sheet_by_zoom:
        if largest is None or float(zoom) > float(largest):
            largest = zoom
    return sheet_by_zoom[largest]


def node_kind(node):
    if node.get("isKeystone"):
        return "keystone"
    if node.get("isMastery"):
        return "mastery"
    if node.get("isNotable"):
        return "notable"
    return None


def icon_paths_of(node, kind):
    """A mastery's allocated icon is its activeIcon; every other node has a single icon."""
    paths = []
    if kind == "mastery" and node.get("activeIcon"):
        paths.append(node["activeIcon"])
    if node.get("icon"):
        paths.append(node["icon"])
    return paths


def sheet_index(sheets, sheet):
    for index, known in enumerate(sheets):
        if known["url"] == sheet["filename"]:
            return index
    sheets.append({"url": sheet["filename"], "w": sheet["w"], "h": sheet["h"]})
    return len(sheets) - 1


def find_on_sheets(tree, kind, icon_paths, sheets):
    for sheet_name in SHEETS_BY_KIND[kind]:
        if sheet_name not in tree["sprites"]:
            continue
        sheet = largest_zoom(tree["sprites"][sheet_name])
        for path in icon_paths:
            spot = sheet["coords"].get(path)
            if spot is not None:
                return [sheet_index(sheets, sheet), spot["x"], spot["y"], spot["w"], spot["h"]]
    return None


def passive_icons(tree):
    """{node name: [sheet index, x, y, width, height]} and the sheets, for keystones, notables and masteries."""
    sheets = []
    icons = {}
    missing = []
    for node in tree["nodes"].values():
        name = node.get("name")
        kind = node_kind(node)
        if not name or kind is None or name in icons:
            continue
        spot = find_on_sheets(tree, kind, icon_paths_of(node, kind), sheets)
        if spot is None:
            missing.append(name)
            continue
        icons[name] = spot
    return sheets, icons, missing


# ---------- items ----------
def short_art_path(dds_file):
    """'Art/2DItems/Gems/Support/AddedFireDamage.dds' -> 'Gems/Support/AddedFireDamage'; None if it isn't item art."""
    if not dds_file or not dds_file.startswith(ITEM_ART_PREFIX) or not dds_file.endswith(".dds"):
        return None
    return dds_file[len(ITEM_ART_PREFIX):-len(".dds")]


def unique_item_art(tables):
    """Each unique's art. A unique renamed in a later patch keeps a second row under its old name; the current
    name is the one without RenamedVersion."""
    visuals = tables["ItemVisualIdentity"]
    words = tables["Words"]
    art = {}
    for row in tables["UniqueStashLayout"]:
        if row.get("RenamedVersion") is not None:
            continue
        name = words[row["WordsKey"]]["Text2"]
        path = short_art_path(visuals[row["ItemVisualIdentityKey"]]["DDSFile"])
        if name and path and name not in art:
            art[name] = path
    return art


def base_item_art(tables):
    """Gems, flasks and jewel bases by name. A name listed twice (an old copy of a gem) keeps its first row."""
    visuals = tables["ItemVisualIdentity"]
    art = {}
    for row in tables["BaseItemTypes"]:
        if not row["Id"].startswith(ITEM_ID_PREFIXES):
            continue
        name = row.get("Name")
        if not name or name in art or row.get("ItemVisualIdentity") is None:
            continue
        path = short_art_path(visuals[row["ItemVisualIdentity"]]["DDSFile"])
        if path:
            art[name] = path
    return art


def timeless_keystone_aliases(refresh):
    """{keystone: jewel} for the keystones only a timeless jewel grants. They aren't on the tree, so their icons
    aren't on its sprite sheets (and poecdn doesn't serve single passive icons): the jewel's picture stands for them.
    A keystone whose family has no jewel on the wiki (the newer Abyss families) gets no picture."""
    jewel_of_family = {}
    for jewel in fetch_timeless_jewels(refresh):
        jewel_of_family[jewel["family"]] = jewel["name"]
    aliases = {}
    for keystone in fetch_timeless_keystones(refresh):
        jewel = jewel_of_family.get(keystone["jewel"])
        if jewel:
            aliases[keystone["name"]] = jewel
    return aliases


def item_icons(refresh, passive_names):
    patch, tables = export_tables("poe1-icons", ITEM_TABLES)
    art = base_item_art(tables)
    for name, path in unique_item_art(tables).items():
        art.setdefault(name, path)
    aliases = dict(ITEM_ALIASES)
    for keystone, jewel in timeless_keystone_aliases(refresh).items():
        if keystone not in passive_names:  # a keystone also on the tree keeps its own icon
            aliases[keystone] = jewel
    for alias, name in aliases.items():
        if name in art:
            art[alias] = art[name]
    return patch, art


def item_url(path):
    return ITEM_IMAGE_URL + urllib.request.quote(path) + ".png"


def check_item_pictures(art):
    """Asks poecdn for each picture, one at a time, and returns the names it has no picture for."""
    missing = []
    for count, (name, path) in enumerate(sorted(art.items()), start=1):
        request = urllib.request.Request(item_url(path), method="HEAD", headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=30):
                pass
        except urllib.error.HTTPError as error:
            if error.code == 404:
                missing.append(name)
            else:
                print(f"  {name}: HTTP {error.code}")
        if count % 200 == 0:
            print(f"  checked {count} of {len(art)}")
        time.sleep(0.05)
    return missing


def main():
    refresh = "--refresh" in sys.argv
    check = "--check" in sys.argv
    tree = fetch_tree(refresh)
    sheets, passives, missing_passives = passive_icons(tree)
    patch, items = item_icons(refresh, passives)
    print(f"  passives: {len(passives)} icons on {len(sheets)} sprite sheets"
          + (f"; no icon for {len(missing_passives)}: {', '.join(sorted(missing_passives)[:10])}" if missing_passives else ""))
    print(f"  items: {len(items)} pictures (gems, uniques, flasks, jewels, timeless keystones)")
    if check:
        missing_items = check_item_pictures(items)
        print(f"  poecdn has no picture for {len(missing_items)}: {', '.join(missing_items[:30])}")
        for name in missing_items:
            del items[name]
    output = {
        "patch": patch,
        "source": "GGG's passive tree export (sprite sheets) and game files (item art); images served by web.poecdn.com",
        "itemImageUrl": ITEM_IMAGE_URL,
        "sheets": sheets,
        "passives": dict(sorted(passives.items())),
        "items": dict(sorted(items.items())),
    }
    write_utf8(OUT, json.dumps(output, ensure_ascii=False, separators=(",", ":")))
    print(f"  wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    use_utf8_console()
    main()
