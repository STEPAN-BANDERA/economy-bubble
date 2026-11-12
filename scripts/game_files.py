"""Reading tables from Grinding Gear Games' game files with pathofexile-dat (the same pipeline as
scripts/fetch_exchange_items.py), for the Build maker's data scripts.

    tables = export_tables("poe1-skills", [{"name": "ActiveSkills", "columns": [...]}, ...])

Each export lives in its own folder under .cache/dat. An export of the current patch is reused; when GGG's patch
server can't be reached, the last export is used (skill rules and passives change only with patches).
"""
import json
import os
import subprocess
from pathlib import Path

from fetch_exchange_items import CDN_FIX, current_patch, dat_cli_path
from text_files import read_utf8, write_utf8

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "dat"


def table_file(work, name):
    return work / "tables" / "English" / f"{name}.json"


def cached_patch(work, tables):
    config = work / "config.json"
    if not config.exists():
        return None
    saved = json.loads(read_utf8(config))
    if saved.get("tables") != tables:
        return None  # asked for other tables or columns than last time
    for table in tables:
        if not table_file(work, table["name"]).exists():
            return None
    return saved.get("patch")


def read_tables(work, tables):
    read = {}
    for table in tables:
        read[table["name"]] = json.loads(read_utf8(table_file(work, table["name"])))
    return read


def export_tables(work_name, tables):
    """(patch, {table name: rows}) for PoE 1's current patch."""
    work = CACHE / work_name
    previous_patch = cached_patch(work, tables)
    try:
        patch = current_patch("poe1")
    except OSError as error:
        if previous_patch is None:
            raise
        print(f"  patch server unreachable ({error}); using the game files of patch {previous_patch}")
        return previous_patch, read_tables(work, tables)
    if patch == previous_patch:
        return patch, read_tables(work, tables)
    work.mkdir(parents=True, exist_ok=True)
    write_utf8(work / "config.json", json.dumps({"patch": patch, "translations": ["English"], "tables": tables}, indent=1))
    environment = dict(os.environ)
    environment["NODE_OPTIONS"] = f"--import {CDN_FIX.as_uri()}"
    cli = dat_cli_path()
    if not cli.exists():
        raise RuntimeError(f"{cli} is missing; run npm install first")
    subprocess.run([str(cli)], cwd=work, check=True, env=environment)
    return patch, read_tables(work, tables)
