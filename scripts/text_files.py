"""Text input and output that behave the same on Linux, macOS and Windows.

Python picks the encoding of open(), Path.read_text() and Path.write_text(), and of print() when the
output goes to a pipe, from the system locale unless told otherwise. Linux and macOS use UTF-8. Windows
uses its ANSI code page (cp1252 on Western systems) up to Python 3.14, so there a name like
"Maelström Talons" was written as a cp1252 byte that the browser, reading the JSON as UTF-8, showed as
"Maelstr�m", and a character cp1252 lacks raised UnicodeEncodeError. Windows also turns every "\n"
into "\r\n" in files opened as text, so a generated file would differ byte for byte from a Linux build.

The scripts therefore read text through read_utf8(), write it through write_utf8(), and call
use_utf8_console() first thing so their progress lines can print any item name.
"""
import sys
from pathlib import Path


def read_utf8(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_utf8(path: Path, text: str) -> None:
    # Written as bytes so the line endings stay "\n" on Windows too (Path.write_text only takes a
    # newline argument from Python 3.10 on).
    path.write_bytes(text.encode("utf-8"))


def use_utf8_console() -> None:
    # A Windows console already takes any character, but output piped through npm, tail or a CI log
    # uses the locale's code page; "replace" keeps an odd character from stopping a long build.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
