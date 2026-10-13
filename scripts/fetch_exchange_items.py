#!/usr/bin/env python3
"""Build public/data/items-<game>.json: everything the frontend needs to turn
the Currency Exchange API's raw "Metadata/Items/..." ids into readable rows.

    python3 scripts/fetch_exchange_items.py [poe1] [poe2]

Per item: name, exchange category/sub-category, gold fee (CurrencyExchange.
GoldPurchaseFee -- the gold you pay per unit *received*; when the unnamed
column 6 is set the fee is inverted, "1 gold per N units", e.g. Rogue's
Marker = 1/1000 as poedb shows it), whether it is
enabled in challenge/standard leagues, and an icon URL.

Sources:
- Game files (via the pathofexile-dat CLI): the
  CurrencyExchange, CurrencyExchangeCategories and BaseItemTypes tables.
- Icons: the official trade site's static data (name -> web.poecdn.com image),
  matched by item name. Items without a match get no icon.
"""
import json
import os
import re
import socket
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "dat"
CLI = ROOT / "node_modules" / ".bin" / "pathofexile-dat"
CDN_FIX = ROOT / "scripts" / "dat_preload.mjs"
UA = "faustus-ledger/0.1 (currency exchange viewer)"

GAMES = {
    "poe1": {"patch_server": ("patch.pathofexile.com", 12995),
             "static": "https://www.pathofexile.com/api/trade/data/static"},
    "poe2": {"patch_server": ("patch.pathofexile2.com", 13060),
             "static": "https://www.pathofexile.com/api/trade2/data/static"},
}
TABLES = [
    {"name": "CurrencyExchange", "columns": ["Item", "Category", "SubCategory", "EnabledInStandardLeague",
                                             "EnabledInChallengeLeague", "GoldPurchaseFee", "Unk6", "Unk7"]},
    {"name": "CurrencyExchangeCategories", "columns": ["Id", "Name"]},
    {"name": "BaseItemTypes", "columns": ["Id", "Name"]},
]


def current_patch(game):
    host, port = GAMES[game]["patch_server"]
    with socket.create_connection((host, port), timeout=15) as s:
        s.sendall(bytes([1, 7]))
        data = s.recv(1024)
    start = data.find("https".encode("utf-16-le"))
    text = data[start:].decode("utf-16-le", errors="ignore") if start >= 0 else ""
    m = re.search(r"https://[^/]+/([\d.]+)/", text)
    if not m:
        raise RuntimeError(f"Couldn't read a patch version from {host}:{port}")
    # PoE2 reports "0.x"; pathofexile-dat only treats "4.x" as PoE2 (dat_preload.mjs maps it back).
    if game == "poe2" and m.group(1).startswith("0."):
        return "4." + m.group(1)[2:]
    return m.group(1)


def export(game, patch):
    work = CACHE / game
    work.mkdir(parents=True, exist_ok=True)
    (work / "config.json").write_text(json.dumps({"patch": patch, "translations": ["English"], "tables": TABLES}, indent=1))
    env = {**os.environ, "NODE_OPTIONS": f"--import {CDN_FIX.as_uri()}"}
    subprocess.run([str(CLI)], cwd=work, check=True, env=env)
    out = work / "tables" / "English"
    return {t["name"]: json.loads((out / f"{t['name']}.json").read_text(encoding="utf-8")) for t in TABLES}


def trade_icons(game):
    req = urllib.request.Request(GAMES[game]["static"], headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)["result"]
    icons = {}
    for group in data:
        for e in group.get("entries", []):
            if e.get("image") and e.get("text"):
                img = e["image"]
                icons.setdefault(e["text"], img if img.startswith("http") else "https://web.poecdn.com" + img)
    return icons


def build(game):
    patch = current_patch(game)
    t = export(game, patch)
    bases, cats = t["BaseItemTypes"], t["CurrencyExchangeCategories"]
    icons = trade_icons(game)
    items, no_icon = {}, []
    for row in t["CurrencyExchange"]:
        if row["Item"] is None:
            continue
        base = bases[row["Item"]]
        cat = cats[row["Category"]]["Name"] if row["Category"] is not None else None
        sub = cats[row["SubCategory"]]["Name"] if row["SubCategory"] is not None else None
        icon = icons.get(base["Name"])
        if not icon:
            no_icon.append(base["Name"])
        items[base["Id"]] = {
            "name": base["Name"], "cat": cat, "sub": sub, "fee": 1 / row["GoldPurchaseFee"] if row["Unk6"] else row["GoldPurchaseFee"],
            "league": bool(row["EnabledInChallengeLeague"]), "std": bool(row["EnabledInStandardLeague"]),
            "icon": icon,
        }
    out = ROOT / "public" / "data" / f"items-{game}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"patch": patch, "items": items}, separators=(",", ":"), ensure_ascii=False))
    print(f"[{game}] patch {patch}: {len(items)} exchange items, {len(no_icon)} without icon -> {out.relative_to(ROOT)}")
    if no_icon:
        print("  no icon:", ", ".join(sorted(no_icon)[:30]), "..." if len(no_icon) > 30 else "")


if __name__ == "__main__":
    for g in sys.argv[1:] or ("poe1", "poe2"):
        build(g)
