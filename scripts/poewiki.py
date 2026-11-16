"""A small, polite client for poewiki.net's Cargo API (the wiki's public data tables), for the Build maker's
data scripts. Wiki content is CC BY-NC-SA 3.0: whatever is built from it keeps that licence
(public/data/builds/LICENSE.md).

    rows = cargo_rows("uniques", tables="items", fields=["name", "class"], where='items.rarity_id="unique"')

Each query's full answer is cached in .cache/poewiki/<name>.json for a week, so rebuilding while tuning asks the
wiki nothing. Pages of 500 rows, a second apart; when the wiki answers 429 or 5xx, the request waits (as long as
Retry-After asks, at least 30, 90, then 240 seconds) and gives up after that rather than keep asking.
"""
import hashlib
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from text_files import read_utf8, write_utf8

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "poewiki"
API = "https://www.poewiki.net/w/api.php"
# A generic client name: requests carry nothing about who runs the script.
USER_AGENT = "build-data-fetcher/1.0 (Python urllib)"
PAGE_SIZE = 500
PAUSE_BETWEEN_PAGES = 1.0
CACHE_DAYS = 7
BUSY_WAITS = [30, 90, 240]


class WikiUnavailable(Exception):
    """The wiki kept answering 429 or a server error after every wait."""


def seconds_to_wait(error, attempt):
    planned = BUSY_WAITS[attempt]
    asked = None
    if error.headers is not None:
        asked = error.headers.get("Retry-After")
    if asked is None:
        return planned
    try:
        return max(int(asked), planned)
    except ValueError:
        return planned


def call(params):
    query = dict(params)
    query["format"] = "json"
    request = urllib.request.Request(API + "?" + urllib.parse.urlencode(query), headers={"User-Agent": USER_AGENT})
    busy_times = 0
    while True:
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                answer = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code != 429 and error.code < 500:
                raise
            if busy_times >= len(BUSY_WAITS):
                raise WikiUnavailable(f"poewiki.net still answers {error.code} after {busy_times} waits") from error
            wait = seconds_to_wait(error, busy_times)
            print(f"    poewiki.net is busy ({error.code}): waiting {wait} s", file=sys.stderr)
            time.sleep(wait)
            busy_times += 1
            continue
        if "error" in answer:
            raise RuntimeError(f"poewiki.net refused the query: {answer['error'].get('info', answer['error'])}")
        return answer


def cache_path(name, params):
    # The query itself is part of the file name, so asking for other fields never reuses an older answer.
    digest = hashlib.sha1(json.dumps(params, sort_keys=True).encode("utf-8")).hexdigest()[:10]
    return CACHE / f"{name}-{digest}.json"


def cached(path):
    if not path.exists():
        return None
    if time.time() - path.stat().st_mtime > CACHE_DAYS * 86400:
        return None
    return json.loads(read_utf8(path))


def cargo_rows(name, tables, fields, where=None, join_on=None, order_by=None, refresh=False):
    """Every row of a Cargo query, as dicts keyed by the given field names (without the table prefix).
    fields are "table.column" strings; the alias is the column name."""
    path = cache_path(name, {"tables": tables, "fields": fields, "where": where, "join_on": join_on, "order_by": order_by})
    if not refresh:
        saved = cached(path)
        if saved is not None:
            return saved
    aliased = []
    for field in fields:
        if "=" in field:
            aliased.append(field)  # already "table.column=alias"
            continue
        aliased.append(f"{field}={field.split('.')[-1]}")
    rows = []
    offset = 0
    while True:
        params = {"action": "cargoquery", "tables": tables, "fields": ",".join(aliased),
                  "limit": str(PAGE_SIZE), "offset": str(offset)}
        if where:
            params["where"] = where
        if join_on:
            params["join_on"] = join_on
        if order_by:
            params["order_by"] = order_by
        page = call(params).get("cargoquery", [])
        for entry in page:
            rows.append(entry["title"])
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        time.sleep(PAUSE_BETWEEN_PAGES)
    CACHE.mkdir(parents=True, exist_ok=True)
    write_utf8(path, json.dumps(rows, ensure_ascii=False))
    print(f"  poewiki.net {name}: {len(rows)} rows")
    time.sleep(PAUSE_BETWEEN_PAGES)
    return rows
