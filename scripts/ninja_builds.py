"""Reading poe.ninja's builds API (the endpoints its own site uses; public, no key).

    data/index-state                  leagues and each league's build snapshot version
    data/build-index-state            the ten most played class + skill pairs per league
    builds/<version>/search?...       protobuf: per-dimension counts over every matching character,
                                      plus columns for the top ~100 rows (sorted by level)
    builds/<version>/character?...    JSON: one character's items, gems and defences
    builds/dictionary/<hash>          the names a search's dimension indexes point to ("NDIC" format)

Shared by fetch_ninja_targets.py (the Crafting tab's popular builds) and fetch_build_meta.py (the Build
maker tab). Responses are cached on disk for a few hours, so re-runs don't hit poe.ninja again.
Player and account names are used only to fetch characters and are never saved.
"""
import hashlib
import json
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "ninja"
NINJA = "https://poe.ninja/poe1/api/"
UA = "Mozilla/5.0 (faustus-ledger crafting targets build)"


# How long to wait after each "429 Too Many Requests" before trying again. When poe.ninja sends Retry-After, the
# longer of the two is used. After the last wait the request gives up with RateLimited, so the caller can stop
# asking instead of moving on to the next request and being refused again.
RATE_LIMIT_WAITS = [30, 90, 240]
LONGEST_RATE_LIMIT_WAIT = 600


class RateLimited(Exception):
    """poe.ninja still answered 429 Too Many Requests after every wait in RATE_LIMIT_WAITS."""


class NotCached(Exception):
    """In cache-only mode, the response was never saved to the disk cache."""


# Set by use_cache_only(): answer only from the disk cache, however old, and never ask poe.ninja. Used to
# build data from what an interrupted or rate limited run already downloaded.
cache_only = False


def use_cache_only():
    global cache_only
    cache_only = True


def seconds_to_wait(error, attempt):
    planned_wait = RATE_LIMIT_WAITS[attempt]
    asked_wait = None
    if error.headers is not None:
        asked_wait = error.headers.get("Retry-After")
    if asked_wait is None:
        return planned_wait
    try:
        asked_seconds = int(asked_wait)
    except ValueError:
        # Retry-After may also be an HTTP date; the planned wait is a safe stand-in for it.
        return planned_wait
    return min(max(asked_seconds, planned_wait), LONGEST_RATE_LIMIT_WAIT)


def download(request):
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def get(path, raw=False):
    # Cached for a few hours so re-runs while tuning the matcher don't hit poe.ninja again.
    cached = CACHE / hashlib.sha1(path.encode()).hexdigest()
    if cache_only:
        if not cached.exists():
            raise NotCached(path)
        body = cached.read_bytes()
        return body if raw else json.loads(body)
    if cached.exists() and time.time() - cached.stat().st_mtime < 6 * 3600:
        body = cached.read_bytes()
        return body if raw else json.loads(body)
    req = urllib.request.Request(NINJA + path, headers={"User-Agent": UA})
    rate_limited_times = 0
    other_failures = 0
    while True:
        try:
            body = download(req)
        except urllib.error.HTTPError as error:
            if error.code != 429:
                other_failures += 1
                if other_failures == 3:
                    raise
                time.sleep(2)
                continue
            if rate_limited_times >= len(RATE_LIMIT_WAITS):
                raise RateLimited(f"poe.ninja is still rate limiting after {rate_limited_times} waits") from error
            wait = seconds_to_wait(error, rate_limited_times)
            print(f"    poe.ninja rate limit: waiting {wait} s", file=sys.stderr)
            time.sleep(wait)
            rate_limited_times += 1
            continue
        except Exception:
            other_failures += 1
            if other_failures == 3:
                raise
            time.sleep(2)
            continue
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(body)
        time.sleep(0.4)  # be gentle with a free service
        return body if raw else json.loads(body)


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


# ---- dictionaries: the names behind a search's dimension indexes ----
def packed_varints(data):
    values = []
    position = 0
    while position < len(data):
        value, position = varint(data, position)
        values.append(value)
    return values


def parse_dictionary(body):
    """poe.ninja's "NDIC" file: a 36-byte header (magic, version, entry count at byte 12, block count at byte
    28, size of the lengths at byte 32), a table of 8 bytes per block, each entry's length as a varint, then
    the names back to back. Lengths are varints because mastery texts can pass 127 bytes; for short names the
    two counts are equal. Worked out from the files (2026-11-10); the lengths must fill the file exactly, or it
    raises."""
    if body[:4] != b"NDIC":
        raise ValueError("not a poe.ninja dictionary")
    entry_count = struct.unpack_from("<I", body, 12)[0]
    block_count, lengths_size = struct.unpack_from("<II", body, 28)
    lengths_start = 36 + 8 * block_count
    lengths = packed_varints(body[lengths_start:lengths_start + lengths_size])
    if len(lengths) != entry_count:
        raise ValueError(f"dictionary layout changed: {len(lengths)} lengths for {entry_count} entries")
    position = lengths_start + lengths_size
    names = []
    for length in lengths:
        names.append(body[position:position + length].decode("utf-8"))
        position += length
    if position != len(body):
        raise ValueError(f"dictionary layout changed: read {position} of {len(body)} bytes")
    return names


def dictionary(hash_id):
    return parse_dictionary(get(f"builds/dictionary/{hash_id}", raw=True))


# ---- a search answer, decoded ----
def read_search(body):
    """{"dimensions": {id: {name: characters}}, "columns": {id: [value per row]}} for one search.

    The answer is message 1, whose fields are: 2 a dimension {1: id, 2: dictionary type, 3: repeated
    {1: index (absent = 0), 2: characters}}; 6 a dictionary reference {1: type, 2: hash of the names};
    12 a column {1: id, 6: packed integers per row, 7: one string per row}."""
    result = next(value for field_number, value in fields(body) if field_number == 1)
    dictionary_hash_by_type = {}
    raw_dimensions = []
    columns = {}
    for field_number, value in fields(result):
        if field_number == 6:
            parts = list(fields(value))
            dictionary_hash_by_type[parts[0][1].decode()] = parts[1][1].decode()
        elif field_number == 2:
            raw_dimensions.append(read_dimension(value))
        elif field_number == 12:
            column_id, values = read_column(value)
            columns[column_id] = values
    dimensions = {}
    for dimension_id, dictionary_type, counts_by_index in raw_dimensions:
        if dictionary_type not in dictionary_hash_by_type:
            continue
        names = dictionary(dictionary_hash_by_type[dictionary_type])
        counts_by_name = {}
        for index, characters in counts_by_index.items():
            if index < len(names):
                counts_by_name[names[index]] = characters
        dimensions[dimension_id] = counts_by_name
    return {"dimensions": dimensions, "columns": columns}


def read_dimension(value):
    parts = list(fields(value))
    dimension_id = parts[0][1].decode()
    dictionary_type = parts[1][1].decode()
    counts_by_index = {}
    for field_number, entry in parts:
        if field_number != 3:
            continue
        entry_fields = dict(fields(entry))
        counts_by_index[entry_fields.get(1, 0)] = entry_fields.get(2, 0)
    return dimension_id, dictionary_type, counts_by_index


def read_column(value):
    parts = list(fields(value))
    column_id = next(entry.decode() for field_number, entry in parts if field_number == 1)
    numbers = []
    strings = []
    for field_number, entry in parts:
        if field_number == 6:
            numbers.extend(packed_varints(entry))
        elif field_number == 7:
            strings.append(entry.decode("utf-8", "replace"))
    if strings:
        return column_id, strings
    return column_id, numbers
