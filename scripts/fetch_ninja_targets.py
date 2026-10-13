#!/usr/bin/env python3
"""Build public/data/craft/targets-poe1.json: rare items worn by the most
played PoE 1 builds on poe.ninja, with every modifier matched to the craft data.

    python3 scripts/fetch_ninja_targets.py [archetypes=8] [items_per_archetype=4]

Run scripts/fetch_craft_data.py first (it writes the per-base mod files used
for matching).

poe.ninja endpoints (public, used by its own site):
- /poe1/api/data/index-state          leagues and the current build snapshot version
- /poe1/api/data/build-index-state    the top class + skill pairs per league
- /poe1/api/builds/<ver>/search       protobuf; we only read the name/account columns
- /poe1/api/builds/<ver>/character    JSON; the character's items

Player and account names are used only to fetch the items and are not saved.
"""
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CRAFT = ROOT / "public" / "data" / "craft"
CACHE = ROOT / ".cache" / "ninja"
NINJA = "https://poe.ninja/poe1/api/"
UA = "Mozilla/5.0 (faustus-ledger crafting targets build)"
SLOTS = {"Helm": "Helmet", "BodyArmour": "Body Armour", "Gloves": "Gloves", "Boots": "Boots",
         "Belt": "Belt", "Amulet": "Amulet", "Ring": "Ring", "Ring2": "Ring", "Weapon": "Weapon",
         "Offhand": "Off-hand", "Weapon2": "Weapon", "Offhand2": "Off-hand"}


def get(path, raw=False):
    # Cached for a few hours so re-runs while tuning the matcher don't hit poe.ninja again.
    cached = CACHE / hashlib.sha1(path.encode()).hexdigest()
    if cached.exists() and time.time() - cached.stat().st_mtime < 6 * 3600:
        body = cached.read_bytes()
        return body if raw else json.loads(body)
    req = urllib.request.Request(NINJA + path, headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
            CACHE.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(body)
            time.sleep(0.4)  # be gentle with a free service
            return body if raw else json.loads(body)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)


# ---- minimal protobuf reader (wire format only, no schema) ----
def varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        s += 7
        if c < 0x80:
            return r, i


def fields(b):
    i = 0
    while i < len(b):
        k, i = varint(b, i)
        f, w = k >> 3, k & 7
        if w == 0:
            v, i = varint(b, i)
        elif w == 2:
            n, i = varint(b, i)
            v = b[i:i + n]
            i += n
        elif w == 1:
            v, i = b[i:i + 8], i + 8
        elif w == 5:
            v, i = b[i:i + 4], i + 4
        else:
            raise ValueError("unsupported wire type")
        yield f, v


def search_names(body):
    """The search answer's string columns: message 1 -> repeated field 12
    {1: column id, 7: value per row}. Returns (account, name) pairs."""
    result = next(v for f, v in fields(body) if f == 1)
    cols = {}
    for f, v in fields(result):
        if f != 12:
            continue
        sub = list(fields(v))
        cid = next((x.decode() for g, x in sub if g == 1), None)
        if cid in ("name", "account"):
            cols[cid] = [x.decode("utf-8", "replace") for g, x in sub if g == 7]
    return list(zip(cols.get("account", []), cols.get("name", [])))


# ---- matching item text to modifiers ----
NUM = r"([+-]?\d+(?:\.\d+)?)"


def template_re(text):
    parts = [re.escape(p) for p in text.split("#")]
    return re.compile("^" + NUM.join(parts).replace(r"\+" + NUM, r"\+?" + NUM) + "$", re.I)


def ranges(values):
    out = []
    for v in values:
        out.append((v[0], v[1]) if isinstance(v, list) else (v, v))
    return out


def pick_tier(tiers, nums):
    """(index, distance): the highest tier whose ranges hold the numbers
    (distance 0), else the closest one."""
    best, best_d = 0, None
    for i, t in enumerate(tiers):
        rs = ranges(t[2])
        if len(rs) != len(nums):
            continue
        d = sum(0 if lo <= abs(n) <= hi or lo <= n <= hi else min(abs(n - lo), abs(n - hi)) for n, (lo, hi) in zip(nums, rs))
        if best_d is None or d < best_d or (d == best_d and d == 0):
            best, best_d = i, d
    return best, (best_d if best_d is not None else 1e9)


def scaled(tiers, pct):
    """Tiers with values raised by an experimented base's magnitude bonus (as the page shows them)."""
    f = 1 + pct / 100
    by = lambda v: [by(x) for x in v] if isinstance(v, list) else (int(v * f) if isinstance(v, int) else v * f)
    return [[t[0], t[1], [by(v) for v in t[2]]] for t in tiers]


class Matcher:
    def __init__(self, base_id, exp=None):
        self.mods = json.loads((CRAFT / f"base-{base_id}.json").read_text())["mods"]
        # Experimented bases (Helical Ring, ...) show bigger numbers: match against scaled tiers.
        mag = (exp or {}).get("mag") or {}
        if mag:
            self.mods = [[*m[:6], scaled(m[6], mag[m[2]]), *m[7:]] if m[2] in mag else m for m in self.mods]
        self.res = [(m, template_re(m[1])) for m in self.mods]
        self.used = set()

    def match(self, line, sources, affix=None):
        hits = []
        for m, rx in self.res:
            if m[3] not in sources or m[0] in self.used or (affix and m[2] != affix):
                continue
            mm = rx.match(line)
            if mm:
                nums = [float(x) for x in mm.groups()]
                tier, dist = pick_tier(m[6], nums)
                # A number outside every tier means another mod with the same text fits better.
                hits.append((dist > 0, sources.index(m[3]), dist, m, tier))
        if not hits:
            return None
        hits.sort(key=lambda h: h[:3])
        m, tier = hits[0][3], hits[0][4]
        self.used.add(m[0])  # an item can't have the same mod twice
        return {"id": m[0], "tier": tier, "affix": m[2], "src": m[3]}

    def exact(self, line, sources):
        """True when a single (non-hybrid) mod explains the line with in-range numbers."""
        for m, rx in self.res:
            if m[3] in sources and ", " not in m[1]:
                mm = rx.match(line)
                if mm and pick_tier(m[6], [float(x) for x in mm.groups()])[1] == 0:
                    return True
        return False

    def match_lines(self, lines, sources):
        """Match a list of item lines. A hybrid mod shows as two lines, not
        always next to each other; pair them when no single mod explains one
        of the two lines."""
        used, out = set(), []
        for i, a in enumerate(lines):
            if i in used or self.exact(a, sources):
                continue
            for j, b in enumerate(lines):
                if j == i or j in used:
                    continue
                for text in (a + ", " + b, b + ", " + a):
                    r = self.match(text, sources)
                    if r and not pick_tier(next(m for m in self.mods if m[0] == r["id"])[6],
                                           [float(x) for x in re.findall(NUM, text)])[1] == 0:
                        self.used.discard(r["id"])
                        r = None
                    if r and pick_tier(next(m for m in self.mods if m[0] == r["id"])[6],
                                       [float(x) for x in re.findall(NUM, text)])[1] == 0:
                        used.update((i, j))
                        out.append({"text": a + "\n" + b, **r})
                        break
                if i in used:
                    break
        for i, line in enumerate(lines):
            if i not in used:
                one = self.match(line, sources)
                out.append({"text": line, **(one or {"id": None})})
        return out


def read_item(it, index):
    x = it["itemData"]
    if x.get("frameType") != 2:  # rares only
        return None
    base = index["bitems"].get(x.get("baseType"))
    if base is None:
        return None
    exp = (index.get("experimented") or {}).get(x.get("baseType"))
    infl = [k for k, v in (x.get("influences") or {}).items() if v and k in index["influences"]]
    if exp and exp.get("allInfl"):
        infl = list(index["influences"])
    m = Matcher(base, exp)
    explicit_src = ["base"] + infl + ["essence", "veiled", "fossil", "beast"]
    mods = []
    for line in x.get("fracturedMods") or []:
        r = m.match(line, explicit_src)
        mods.append({"text": line, **(r or {"id": None}), "fractured": 1})
    mods += m.match_lines(x.get("explicitMods") or [], explicit_src)
    for line in x.get("craftedMods") or []:
        r = m.match(line, ["bench", "veiled"])
        mods.append({"text": line, **(r or {"id": None}), "crafted": 1})
    eldritch = []
    if x.get("searing") or x.get("tangled"):
        for line in x.get("implicitMods") or []:
            r = m.match(line, ["base"])
            if r and r["affix"] in ("r", "b"):
                eldritch.append({"text": line, **r})
    # Some texts exist as both a prefix and a suffix (Rarity, for one). If a side
    # holds more mods than it can, move an ambiguous one to the other side.
    half = index["groups"][str(index["bases"][str(base)]["group"])]["maxAffix"] // 2
    cap = {"p": half + (exp or {}).get("p", 0), "s": half + (exp or {}).get("s", 0)}
    for side, other in (("p", "s"), ("s", "p")):
        while sum(d.get("affix") == side for d in mods) > cap[side] and sum(d.get("affix") == other for d in mods) < cap[other]:
            moved = False
            for d in mods:
                if d.get("affix") != side or d.get("crafted"):
                    continue
                alt = m.match(d["text"].replace("\n", ", "), [src for src in explicit_src], affix=other)
                if alt:
                    m.used.discard(d["id"])
                    d.update(alt)
                    moved = True
                    break
            if not moved:
                break
    matched = [d for d in mods if d.get("id")]
    if len(matched) < 3:
        return None
    return {
        "slot": SLOTS.get(it.get("itemSlot") and x.get("inventoryId"), x.get("inventoryId")),
        "name": x.get("name") or x.get("baseType"), "baseType": x.get("baseType"), "base": base,
        "ilvl": x.get("ilvl"), "influences": infl, "mods": mods, "eldritch": eldritch,
        "corrupted": bool(x.get("corrupted")), "mirrored": bool(x.get("duplicated")),
    }


def main():
    want = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    per = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    index = json.loads((CRAFT / "index-poe1.json").read_text())

    state = get("data/index-state")
    builds = get("data/build-index-state")
    league = next(l for l in builds["leagueBuilds"] if not l["hardcore"] and l["status"] == 0)
    snap = next(s for s in state["snapshotVersions"] if s["url"] == league["leagueUrl"] and s["type"] == "exp")
    print(f"{league['leagueName']}: {league['total']} characters, snapshot {snap['version']}")

    archetypes = []
    for stat in league["statistics"][:want]:
        q = urllib.parse.urlencode({"overview": snap["snapshotName"], "type": "exp",
                                    "class": stat["class"], "skills": stat["skill"]})
        chars = search_names(get(f"builds/{snap['version']}/search?{q}", raw=True))
        items, seen_slots, used = [], set(), 0
        for account, char in chars[:12]:
            if len(items) >= per:
                break
            q2 = urllib.parse.urlencode({"account": account, "name": char,
                                         "overview": snap["snapshotName"], "type": "exp"})
            try:
                c = get(f"builds/{snap['version']}/character?{q2}")
            except Exception as e:
                print("  skip character:", e, file=sys.stderr)
                continue
            used += 1
            got = sorted(filter(None, (read_item(it, index) for it in c.get("items", []))),
                         key=lambda r: -sum(1 for d in r["mods"] if d.get("id") and not d.get("crafted")))
            for r in got:
                if r["slot"] in seen_slots or len(items) >= per:
                    continue
                seen_slots.add(r["slot"])
                r["from"] = f"Character {used} ({c.get('class')}, level {c.get('level')})"
                items.append(r)
        print(f"  {stat['class']} / {stat['skill']}: {len(items)} items from {used} characters")
        archetypes.append({"class": stat["class"], "skill": stat["skill"],
                           "share": round(stat["percentage"], 2), "items": items})

    out = {"league": league["leagueName"], "snapshot": snap["version"], "built": time.strftime("%Y-%m-%d"),
           "source": "poe.ninja builds", "archetypes": archetypes}
    (CRAFT / "targets-poe1.json").write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    main()
