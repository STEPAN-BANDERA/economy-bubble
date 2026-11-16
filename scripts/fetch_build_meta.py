#!/usr/bin/env python3
"""Build public/data/builds/meta-poe1-<league>.json: what PoE 1 players actually play, from poe.ninja's
builds API, for the Build maker tab. One file for the running softcore trade league and one for each past
league poe.ninja still keeps (Mirage, Ancestors):

    python3 scripts/fetch_build_meta.py [archetypes=120] [characters-sampled=0] [past-league-archetypes=80] [--cached]

An archetype is an ascendancy plus a main skill (poe.ninja's own pairing). For each league:
1. one search per ascendancy counts its characters by main skill: every archetype's population;
2. one search per archetype (the most played ones) aggregates all its characters: the uniques they wear,
   keystones, support gems, auras and bloodlines as shares, plus medians over the top 100 characters by level
   (life, energy shield, EHP, DPS, the damage type split and whether the damage is hit or damage over time);
3. for the running league only, a few characters per archetype are opened for what the search doesn't
   return: armour, evasion, spell suppression, block, item rarity and movement speed.

--cached builds only from responses already in the disk cache (however old) and asks poe.ninja nothing: for
when a run was rate limited or stopped. Archetypes whose search isn't cached keep their population only (the
tab ranks them but can't answer questions about them), and "detailsMissing" in the file counts them.

Medians come from the highest-level characters, so they describe finished builds, not a fresh one.
Player and account names are used only to open characters and are never saved. Run
scripts/build_game_data.py first: its skill, keystone and unique lists decide what counts.
"""
import json
import statistics
import sys
import time
import urllib.parse
from pathlib import Path

from ninja_builds import NotCached, RateLimited, get, read_search, search_names, use_cache_only
from text_files import read_utf8, use_utf8_console, write_utf8

ROOT = Path(__file__).resolve().parent.parent
BUILDS = ROOT / "public" / "data" / "builds"
GAME_FILE = BUILDS / "game-poe1.json"

MIN_CHARACTERS_FOR_ARCHETYPE = 20  # fewer and the medians and shares mean little
UNIQUE_SHARE_FLOOR = 0.04  # a unique worn by fewer than 4% of an archetype is a personal choice, not the build's
KEYSTONE_SHARE_FLOOR = 0.10
SUPPORT_SHARE_FLOOR = 0.15
AURA_SHARE_FLOOR = 0.10
TOP_UNIQUES = 12
TOP_SUPPORTS = 8
DAMAGE_TYPES = ["physical", "fire", "cold", "lightning", "chaos"]
# poe.ninja's per-skill "mode" column, read against known skills (2026-11-10): Winter Orb and other hit
# skills report 0, Righteous Fire reports 2. Anything but 0 is counted as damage over time.
HIT_MODE = 0
SHARE_DECIMALS = 3
CLASS_COUNT_TOLERANCE = 0.05


def plays_standard_ascendancies(classes, game):
    # Event leagues can swap the ascendancies (Ancestors used Phrecia's: Bog Shaman, Daughter of Oshabi, ...),
    # and archetypes there say nothing about the normal game.
    for ascendancies in game["classes"].values():
        for ascendancy in ascendancies:
            if classes.get(ascendancy, 0) > 0:
                return True
    return False


def snapshot_for(index_state, league_url):
    for snapshot in index_state["snapshotVersions"]:
        if snapshot["url"] == league_url and snapshot["type"] == "exp":
            return snapshot
    return None


def is_softcore_trade(league_name):
    # Past leagues come as "Mirage", "Hardcore Mirage", "SSF Mirage", "Ruthless Mirage", ...: only the plain one.
    prefixes = ("Hardcore", "HC ", "SSF", "Solo", "Ruthless", "Standard")
    return not league_name.startswith(prefixes) and "(PL" not in league_name


def is_challenge_league(league):
    # A challenge league's address is its name ("Mirage" -> "mirage"); events such as "Exilecon 2026 PoE1
    # Qualifier #4" (an SSF race, "exilecon2026poe1qualifier4ssf") aren't, and are no guide to trade play.
    return league["url"] == league["name"].lower().replace(" ", "")


def leagues_to_read(index_state, build_index_state):
    leagues = []
    for league in build_index_state["leagueBuilds"]:
        if league["hardcore"] or league["status"] != 0 or not is_softcore_trade(league["leagueName"]):
            continue
        leagues.append({"name": league["leagueName"], "url": league["leagueUrl"], "current": True})
        break
    for league in index_state.get("oldBuildLeagues", []):
        if is_softcore_trade(league["name"]) and is_challenge_league(league):
            leagues.append({"name": league["name"], "url": league["url"], "current": False})
    return leagues


def search(snapshot, filters):
    parameters = {"overview": snapshot["snapshotName"], "type": "exp"}
    parameters.update(filters)
    body = get(f"builds/{snapshot['version']}/search?{urllib.parse.urlencode(parameters)}", raw=True)
    return body


def nonzero(counts):
    kept = {}
    for name, characters in counts.items():
        if characters > 0:
            kept[name] = characters
    return kept


def parse_short_number(text):
    # poe.ninja prints EHP and DPS as "93k", "5.2M", "1.1B"; empty when Path of Building had no number.
    if not text:
        return None
    multipliers = {"k": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}
    suffix = text[-1]
    try:
        if suffix in multipliers:
            return float(text[:-1]) * multipliers[suffix]
        return float(text)
    except ValueError:
        return None


def median_or_none(values):
    present = []
    for value in values:
        if value is not None:
            present.append(value)
    if not present:
        return None
    return statistics.median(present)


def rounded_median(values):
    median = median_or_none(values)
    if median is None:
        return None
    return round(median)


def shares_over_floor(counts, characters, allowed_names, floor, limit):
    shares = []
    for name, count in counts.items():
        if allowed_names is not None and name not in allowed_names:
            continue
        share = count / characters
        if share >= floor:
            shares.append([name, round(share, SHARE_DECIMALS)])
    shares.sort(key=lambda entry: (-entry[1], entry[0]))
    return shares[:limit]


def expected_count(counts, characters, allowed_names):
    # Each character counts once per gem, so the sum over aura gems divided by characters is the average number
    # of auras a character runs.
    total = 0
    for name, count in counts.items():
        if name in allowed_names:
            total += count
    return round(total / characters, 2)


def bloodline_shares(counts, characters):
    # poe.ninja lists characters without a bloodline as "None".
    named = {}
    for name, count in counts.items():
        if name != "None":
            named[name] = count
    return shares_over_floor(named, characters, None, 0.05, 5)


def class_populations(snapshot):
    overview = read_search(search(snapshot, {}))
    return nonzero(overview["dimensions"].get("class", {}))


class ClassFilterIgnored(Exception):
    pass


def skill_populations(snapshot, ascendancy, classes):
    expected = classes.get(ascendancy, 0)
    # poe.ninja answers a filter on an ascendancy nobody in the league has with the whole league, which would
    # pair every skill with it, so those aren't asked about at all.
    if expected == 0:
        return {}
    by_class = read_search(search(snapshot, {"class": ascendancy}))
    matched = sum(nonzero(by_class["dimensions"].get("class", {})).values())
    # Counts move a little between two requests to a running league (1,582 then 1,583 Berserkers); a filter
    # that was ignored returns many times more.
    if abs(matched - expected) > CLASS_COUNT_TOLERANCE * expected + 5:
        raise ClassFilterIgnored(f"asked for {ascendancy} ({expected} characters), got {matched}")
    return nonzero(by_class["dimensions"].get("skills", {}))


def counts_as_main_skill(details):
    # Auras and the like are listed among main skills by some characters; Vaal versions are cast alongside the
    # plain skill (Vaal Righteous Fire with Righteous Fire), so the plain one stands for the build.
    if details is None or details["aura"] or details["delivery"] == "other":
        return False
    return "Vaal" not in details["tags"]


def candidate_archetypes(snapshot, game, classes):
    """The archetypes worth detailing (20+ characters), and every ascendancy's main-skill counts down to a single
    character: the Build maker's generator checks its own ideas against those, and a pair played by 10 people
    is exactly the niche it looks for."""
    candidates = []
    populations = {}
    for base_class, ascendancies in game["classes"].items():
        for ascendancy in ascendancies:
            for skill, characters in skill_populations(snapshot, ascendancy, classes).items():
                if not counts_as_main_skill(game["skills"].get(skill)):
                    continue
                populations.setdefault(ascendancy, {})[skill] = characters
                if characters < MIN_CHARACTERS_FOR_ARCHETYPE:
                    continue
                if not counts_as_main_skill(game["skills"].get(skill)):
                    continue
                candidates.append({"baseClass": base_class, "ascendancy": ascendancy, "skill": skill,
                                   "characters": characters})
    candidates.sort(key=lambda candidate: (-candidate["characters"], candidate["ascendancy"], candidate["skill"]))
    return candidates, populations


def damage_profile(columns, skill):
    prefix = "dps-" + skill
    split = {}
    for damage_type in DAMAGE_TYPES:
        median = median_or_none(columns.get(f"{prefix}.{damage_type}", []))
        if median is not None and median > 0:
            split[damage_type] = round(median)
    modes = columns.get(f"{prefix}.mode", [])
    hit_share = None
    if modes:
        hits = 0
        for mode in modes:
            if mode == HIT_MODE:
                hits += 1
        hit_share = round(hits / len(modes), SHARE_DECIMALS)
    dps_values = []
    for text in columns.get(f"{prefix}.total", []):
        dps_values.append(parse_short_number(text))
    return {"damageSplit": split, "hitShare": hit_share, "dpsMedian": rounded_median(dps_values)}


def archetype_details(snapshot, candidate, game, aura_names, keystone_names, unique_names):
    found = read_search(search(snapshot, {"class": candidate["ascendancy"], "skills": candidate["skill"]}))
    dimensions = found["dimensions"]
    columns = found["columns"]
    characters = sum(nonzero(dimensions.get("class", {})).values()) or candidate["characters"]
    ehp_values = []
    for text in columns.get("ehp__str", []):
        ehp_values.append(parse_short_number(text))
    details = {
        "characters": characters,
        "levelMedian": rounded_median(columns.get("level", [])),
        "lifeMedian": rounded_median(columns.get("life", [])),
        "energyShieldMedian": rounded_median(columns.get("energyshield", [])),
        "ehpMedian": rounded_median(ehp_values),
        "uniques": shares_over_floor(dimensions.get("items", {}), characters, unique_names, UNIQUE_SHARE_FLOOR, TOP_UNIQUES),
        "keystones": shares_over_floor(dimensions.get("keypassives", {}), characters, keystone_names, KEYSTONE_SHARE_FLOOR, 10),
        "supports": shares_over_floor(dimensions.get("supportgems-" + candidate["skill"], {}), characters, None,
                                      SUPPORT_SHARE_FLOOR, TOP_SUPPORTS),
        "auras": shares_over_floor(dimensions.get("allgems", {}), characters, aura_names, AURA_SHARE_FLOOR, 8),
        "auraCountAverage": expected_count(dimensions.get("allgems", {}), characters, aura_names),
        "bloodlines": bloodline_shares(dimensions.get("secondascendancy", {}), characters),
    }
    details.update(damage_profile(columns, candidate["skill"]))
    return details


def sampled_defences(snapshot, candidate, sample_size):
    """Medians over a few of the archetype's top characters, for the defences the search doesn't return."""
    names = search_names(search(snapshot, {"class": candidate["ascendancy"], "skills": candidate["skill"]}))
    keys = ["armour", "evasionRating", "spellSuppressionChance", "blockChance", "spellBlockChance", "itemRarity",
            "movementSpeed", "lowestMaximumHitTaken"]
    values_by_key = {}
    for key in keys:
        values_by_key[key] = []
    opened = 0
    for account, character_name in names:
        if opened >= sample_size:
            break
        query = urllib.parse.urlencode({"account": account, "name": character_name,
                                        "overview": snapshot["snapshotName"], "type": "exp"})
        try:
            character = get(f"builds/{snapshot['version']}/character?{query}")
        except RateLimited:
            # Skipping to the next character would only be refused again; read_league stops sampling.
            raise
        except NotCached:
            continue
        except Exception as error:
            print(f"    skip character: {error}", file=sys.stderr)
            continue
        opened += 1
        stats = character.get("defensiveStats") or {}
        for key in keys:
            values_by_key[key].append(stats.get(key))
    if opened == 0:
        return None
    medians = {"sampled": opened}
    for key in keys:
        medians[key] = rounded_median(values_by_key[key])
    return medians


def read_league(league, index_state, game, archetype_limit, sample_size):
    snapshot = snapshot_for(index_state, league["url"])
    if snapshot is None:
        print(f"{league['name']}: poe.ninja has no build snapshot any more; skipped")
        return None
    aura_names = set()
    for name, skill in game["skills"].items():
        if skill["aura"]:
            aura_names.add(name)
    keystone_names = set()
    for keystone in game["keystones"]:
        keystone_names.add(keystone["name"])
    unique_names = set(game["uniques"])

    try:
        classes = class_populations(snapshot)
    except NotCached:
        print(f"{league['name']}: skipped, its class counts are not in the cache")
        return None
    total_characters = sum(classes.values())
    if not plays_standard_ascendancies(classes, game):
        print(f"{league['name']}: skipped, it used other ascendancies ({', '.join(sorted(classes)[:4])}, ...)")
        return None
    try:
        candidates, populations = candidate_archetypes(snapshot, game, classes)
    except ClassFilterIgnored as reason:
        print(f"{league['name']}: skipped, poe.ninja ignores the class filter for this league ({reason})")
        return None
    except NotCached:
        print(f"{league['name']}: skipped, some ascendancy's skill counts are not in the cache")
        return None
    print(f"{league['name']}: {total_characters} characters, {len(candidates)} archetypes with "
          f"{MIN_CHARACTERS_FOR_ARCHETYPE}+ characters; detailing the top {min(archetype_limit, len(candidates))}")
    archetypes = []
    sampling = league["current"] and sample_size > 0
    sampling_stopped = False
    details_missing = 0
    for position, candidate in enumerate(candidates):
        record = dict(candidate)
        record["shareOfLeague"] = round(candidate["characters"] / total_characters, 5)
        if position < archetype_limit:
            try:
                record.update(archetype_details(snapshot, candidate, game, aura_names, keystone_names, unique_names))
            except NotCached:
                details_missing += 1
                archetypes.append(record)
                continue
            if sampling and not sampling_stopped:
                try:
                    defences = sampled_defences(snapshot, candidate, sample_size)
                    if defences is not None:
                        record["defences"] = defences
                except NotCached:
                    pass  # the archetype's character list isn't cached; it simply has no defence layers
                except RateLimited:
                    # The rest of the archetypes keep their search data and simply have no defence layers.
                    sampling_stopped = True
                    print(f"  poe.ninja kept rate limiting character pages; defences sampled for {position} "
                          f"archetypes only", file=sys.stderr)
        archetypes.append(record)
        if position < archetype_limit and (position + 1) % 20 == 0:
            print(f"  {position + 1} detailed")
    return {"league": league["name"], "leagueUrl": league["url"], "current": league["current"],
            "snapshot": snapshot["version"], "built": time.strftime("%Y-%m-%d"), "source": "poe.ninja builds",
            "characters": total_characters, "classes": classes, "defenceSamplingStopped": sampling_stopped,
            "detailsMissing": details_missing, "populations": populations, "archetypes": archetypes}


def main():
    arguments = []
    cached_only = False
    for argument in sys.argv[1:]:
        if argument == "--cached":
            use_cache_only()
            cached_only = True
            continue
        arguments.append(int(argument))
    archetype_limit = arguments[0] if len(arguments) > 0 else 120
    # Opening characters (for armour, evasion, block...) costs a request each and is what poe.ninja rate limits;
    # it is off unless asked for. The search data alone carries the archetypes and the generator's checks. From the
    # cache it costs poe.ninja nothing, so --cached reads whatever characters an earlier run saved.
    sample_size = arguments[1] if len(arguments) > 1 else (5 if cached_only else 0)
    past_archetype_limit = arguments[2] if len(arguments) > 2 else 80
    game = json.loads(read_utf8(GAME_FILE))

    index_state = get("data/index-state")
    build_index_state = get("data/build-index-state")
    written = []
    for league in leagues_to_read(index_state, build_index_state):
        limit = archetype_limit if league["current"] else past_archetype_limit
        meta = read_league(league, index_state, game, limit, sample_size)
        if meta is None:
            continue
        out = BUILDS / f"meta-poe1-{league['url']}.json"
        write_utf8(out, json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
        written.append({"league": meta["league"], "url": league["url"], "current": meta["current"],
                        "file": out.name, "characters": meta["characters"], "built": meta["built"]})
        print(f"  -> {out.relative_to(ROOT)} ({out.stat().st_size // 1024} KB; "
              f"{meta['detailsMissing']} archetypes without details, not cached)")
    write_utf8(BUILDS / "leagues-poe1.json", json.dumps({"leagues": written}, ensure_ascii=False, indent=1) + "\n")


if __name__ == "__main__":
    use_utf8_console()
    main()
