#!/usr/bin/env python3
"""Build public/data/craft/: the PoE 1 modifier data the Crafting tab runs on.

    python3 scripts/fetch_craft_data.py

Source: Craft of Exile's public data files (craftofexile.com/json/data/...).
They carry every explicit modifier with its tiers, item levels and spawn
weights per base type, plus the pools the game files don't expose
(veiled mods, Eldritch implicits, essence-only and bench mods), several of
them worked out by the Prohibited Library community.

Output (all small enough to load on demand):
- craft/index-poe1.json  base groups, bases, base item names -> base, mod tags,
                         fossils, essences, bench currency ids, a few fallback
                         prices for things the exchange doesn't list
- craft/base-<id>.json   every modifier that can appear on that base:
                         [id, text, affix, source, groups, tags, tiers, extra]
                         tiers = [[ilvl, weight, values], ...] lowest first
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "coe"
OUT = ROOT / "public" / "data" / "craft"
SITE = "https://www.craftofexile.com/"
UA = "Mozilla/5.0 (faustus-ledger crafting data build)"
FILES = {
    "data": "json/data/main/poec_data.json",
    "common": "json/data/poec_common.json",
    "prices": "json/data/prices/poec_prices.json",
}

# Craft of Exile's modifier groups ("mgroups") that matter for crafting.
SOURCES = {"1": "base", "2": "shaper", "3": "elder", "4": "crusader", "5": "hunter", "6": "warlord",
           "7": "redeemer", "8": "fossil", "10": "veiled", "11": "bench", "13": "essence", "14": "beast"}
INFLUENCES = ["shaper", "elder", "crusader", "hunter", "warlord", "redeemer"]
AFFIX = {"prefix": "p", "suffix": "s", "eldritch_red": "r", "eldritch_blue": "b"}
# Item classes the tab supports: jewellery, armour pieces, weapons, off-hands.
GROUPS = {"1", "2", "3", "4", "5", "6", "7", "8"}
ELDRITCH_GROUPS = {"2", "3", "4", "5"}          # body, boots, helmet, gloves
RECOMB = {"1": "Jewellery", "2": "Armour", "3": "Armour", "4": "Armour", "5": "Armour", "8": "Armour",
          "6": "Weapon", "7": "Weapon"}
BENCH_CURRENCY = {1: "Orb of Alteration", 2: "Chaos Orb", 3: "Orb of Transmutation", 4: "Orb of Augmentation",
                  5: "Orb of Alchemy", 6: "Orb of Chance", 7: "Exalted Orb", 8: "Regal Orb",
                  9: "Glassblower's Bauble", 10: "Divine Orb", 11: "Vaal Orb", 12: "Blessed Orb",
                  13: "Armourer's Scrap", 14: "Gemcutter's Prism", 15: "Orb of Scouring"}
ESSENCE_LEVELS = ["Whispering", "Muttering", "Weeping", "Wailing", "Screaming", "Shrieking", "Deafening"]
# Not on the Currency Exchange; rough chaos values the page lets you edit.
FALLBACK_PRICES = {"Craicic Chimeral": 60, "Farric Wolf Alpha": 15, "Farric Lynx Alpha": 15,
                   "Farrul, First of the Plains": 40, "Saqawal, First of the Sky": 40,
                   "Fenumus, First of the Night": 40, "Craiceann, First of the Deep": 40,
                   "Wild Bristle Matron": 75, "Craicic Croaker": 353, "Black Mórrigan": 705}


def fetch(key):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / Path(FILES[key]).name
    if not path.exists() or time.time() - path.stat().st_mtime > 6 * 3600:
        req = urllib.request.Request(SITE + FILES[key], headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            path.write_bytes(r.read())
    text = path.read_text(encoding="utf-8")
    return json.loads(text[text.index("=") + 1:].rstrip().rstrip(";"))


def jload(s, default=None):
    if s in (None, "", "null"):
        return default
    return json.loads(s) if isinstance(s, str) else s


def num(v):
    f = float(v)
    return int(f) if f.is_integer() else f


def experimented_info(implicits):
    """Affix limits, magnitudes and influence from an experimented base's implicits
    ("-1 Prefix Modifier allowed", "50% increased Suffix Modifier magnitudes",
    "Has Elder, Shaper and all Conqueror Influences"); None for an ordinary base."""
    x = {"p": 0, "s": 0, "mag": {}}
    hit = False
    for line in implicits:
        m = re.fullmatch(r"([+-]\d+) (Prefix|Suffix) Modifiers? allowed", line)
        if m:
            x[m[2][0].lower()] = int(m[1])
            hit = True
            continue
        m = re.fullmatch(r"(\d+)% increased (Prefix|Suffix|Explicit) Modifier magnitudes", line)
        if m:
            for side in ("p", "s") if m[2] == "Explicit" else (m[2][0].lower(),):
                x["mag"][side] = int(m[1])
            hit = True
            continue
        if line == "Has Elder, Shaper and all Conqueror Influences":
            x["allInfl"] = True
            hit = True
    if not hit:
        return None
    x["implicits"] = [l for l in implicits if l != "Implicit Modifiers Cannot Be Changed"]
    return x


def limits_info(implicits):
    """Mods a base item's implicit stops from rolling: "Cannot roll Caster Modifiers" (Kinetic,
    Somatic, Blasting Wand) -> {"noTag": "caster"}; "Cannot roll Modifiers of Non-Cold Damage
    Types" (Cryonic Ring, ...) -> {"onlyDamage": "cold"}. None when nothing is limited."""
    x = {}
    for line in implicits:
        if not isinstance(line, str):
            continue
        m = re.fullmatch(r"Cannot roll (Attack|Caster) Modifiers", line)
        if m:
            x["noTag"] = m[1].lower()
        m = re.fullmatch(r"Cannot roll Modifiers of Non-(Fire|Cold|Lightning|Chaos|Physical) Damage Types", line)
        if m:
            x["onlyDamage"] = m[1].lower()
    return x or None


def main():
    d = fetch("data")
    common = fetch("common")
    try:
        prices = fetch("prices")
    except Exception as e:  # prices are only a fallback
        print("prices:", e, file=sys.stderr)
        prices = {}

    mods = {m["id_modifier"]: m for m in d["modifiers"]["seq"]}
    tags = {t["id_mtype"]: t["poedb_id"] for t in d["mtypes"]["seq"]}
    groups = {g["id_bgroup"]: g for g in d["bgroups"]["seq"] if g["id_bgroup"] in GROUPS}
    bases = {b["id_base"]: b for b in d["bases"]["seq"] if b["id_bgroup"] in groups}
    bench = common.get("benchcosts", {})

    # Essence per (base, mod): the base-specific essence modifier id -> essence.
    ess_names = {e["id_essence"]: e["name_essence"] for e in d["essences"]["seq"]}
    ess_by_base = d["essences"]["dir"]
    corrupt = {e["id_essence"] for e in d["essences"]["seq"] if e.get("corrupt") == "1"}

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("base-*.json"):
        old.unlink()

    base_out = {}
    for bid, b in bases.items():
        rows = []
        for mid in d["basemods"].get(bid, []):
            m = mods.get(mid)
            if not m or m["id_mgroup"] not in SOURCES or m["affix"] not in AFFIX:
                continue
            src = SOURCES[m["id_mgroup"]]
            tiers = d["tiers"].get(mid, {}).get(bid)
            if not tiers:
                continue
            tl = [[int(t["ilvl"]), num(t["weighting"]), jload(t["nvalues"], [])] for t in tiers]
            # Rollable pools need a weight; bench, essence and beast mods are placed, not rolled.
            if src not in ("bench", "essence", "beast") and not any(t[1] for t in tl):
                continue
            extra = {}
            if m.get("id_fossil"):
                extra["fossil"] = m["id_fossil"]
            if m.get("meta"):
                extra["meta"] = m["meta"]
            if src == "bench":
                costs = bench.get(f"{mid}b{bid}")
                if costs:
                    extra["cost"] = [{BENCH_CURRENCY.get(int(k), k): v for k, v in c.items()} for c in costs]
            if src == "essence":
                eid = ess_by_base.get(bid, {}).get(mid)
                if eid:
                    extra["essence"] = ess_names.get(eid, eid)
                    if eid in corrupt:
                        extra["corrupt"] = 1
            if m.get("tgb"):
                extra["tgb"] = jload(m["tgb"], [])
            rows.append([
                int(mid),
                m["name_modifier"],
                AFFIX[m["affix"]],
                src,
                jload(m["modgroups"], [m["modgroup"]]),
                [tags[t] for t in (m["mtypes"] or "").strip("|").split("|") if t in tags],
                tl,
                extra,
            ])
        if not rows:
            continue
        (OUT / f"base-{bid}.json").write_text(json.dumps({"id": int(bid), "mods": rows}, separators=(",", ":")))
        g = b["id_bgroup"]
        base_out[bid] = {
            "name": b["name_base"], "group": int(g),
            "eldritch": g in ELDRITCH_GROUPS, "recomb": RECOMB.get(g),
            "influence": groups[g]["is_influenced"] == "1", "fossil": groups[g]["is_fossil"] == "1",
            "essence": groups[g]["is_ess"] == "1",
            "mods": len(rows),
        }

    # Base item names ("Astral Plate") -> base id, for reading real items.
    bitems = {}
    experimented = {}
    limits = {}
    for it in d["bitems"]["seq"]:
        if it["id_base"] in base_out and it.get("is_legacy") != "1":
            bitems[it["name_bitem"]] = int(it["id_base"])
            imps = jload(it.get("implicits"), []) or []
            x = experimented_info([l for l in imps if isinstance(l, str)])
            if x:
                experimented[it["name_bitem"]] = x
            lim = limits_info(imps)
            if lim:
                limits[it["name_bitem"]] = lim

    fossils = []
    for f in d["fossils"]["seq"]:
        data = jload(f["mod_data"], {}) or {}
        if not data:
            # Hollow Fossil forces an Abyssal Socket; Glyphic and Sanctified aren't modelled.
            if f["name_fossil"] == "Hollow":
                fossils.append({"name": "Hollow Fossil", "id": int(f["id_fossil"]), "more": {}, "less": {}, "block": [],
                                "forces": 757})
            continue
        fossils.append({"name": f["name_fossil"] + " Fossil", "id": int(f["id_fossil"]),
                        "more": {k: v / 100 for k, v in data.items() if v > 100},
                        "less": {k: v / 100 for k, v in data.items() if 0 < v < 100},
                        "block": [k for k, v in data.items() if v == 0]})

    essences = []
    for e in d["essences"]["seq"]:
        essences.append({"name": e["name_essence"], "corrupt": e.get("corrupt") == "1"})

    fallback = dict(FALLBACK_PRICES)
    league = next(iter((prices.get("data") or {}).values()), {})
    # Craft of Exile's own price snapshot (poe.ninja, in chaos) as a fallback for every currency.
    for grp in ("currency", "beasts", "essences"):
        for k, v in (league.get(grp) or {}).items():
            if v:
                fallback[k] = v
    for k, v in (league.get("fossils") or {}).items():
        fallback.setdefault(k + " Fossil", v)
    for k, v in (league.get("resonators") or {}).items():
        fallback.setdefault(k + " Resonator", v)

    index = {
        "source": "Craft of Exile (craftofexile.com) data files; unminable weights by the Prohibited Library community",
        "built": time.strftime("%Y-%m-%d"),
        "groups": {g: {"name": v["name_bgroup"], "maxAffix": int(v["max_affix"])} for g, v in groups.items()},
        "bases": base_out,
        "bitems": dict(sorted(bitems.items())),
        # Heist's experimented base items whose implicits change the affix limits, mod
        # magnitudes or influence: {name: {p, s, mag: {p, s}, allInfl, implicits}}.
        "experimented": dict(sorted(experimented.items())),
        "limits": dict(sorted(limits.items())),
        "fossils": fossils,
        "essences": essences,
        "essenceLevels": ESSENCE_LEVELS,
        "influences": INFLUENCES,
        "fallbackPrices": fallback,
    }
    (OUT / "index-poe1.json").write_text(json.dumps(index, separators=(",", ":")))
    size = sum(p.stat().st_size for p in OUT.glob("*.json"))
    print(f"craft data: {len(base_out)} bases, {len(bitems)} base items, {len(fossils)} fossils, "
          f"{size / 1e6:.1f} MB in {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
