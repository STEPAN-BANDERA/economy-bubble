"""The game's own wording of stats, read from GGG's stat description files (Metadata/StatDescriptions/*.csd in the
game files), for stats the game files give only as ids and values (the timeless jewels' additions, "+4 to
Strength" as the stat base_strength at 4).

    descriptions = read_descriptions([text_of_stat_descriptions, text_of_passive_skill_stat_descriptions])
    lines = describe(descriptions, {"base_strength": 4})   # ["+4 to Strength"], or None

Only the English wording is read (the block before a description's first `lang`). A description covers one or more
stats; it is used when every stat it names is given (a stat it names that isn't given counts as 0, as the game does).
A value outside every range, or a wording handler this reader doesn't know, leaves the stats undescribed (None), so
nothing is guessed. The handlers known are the ones that change a number: negate, divide_by_one_hundred,
per_minute_to_per_second, milliseconds_to_seconds and their kin below; reminder texts and markup are dropped.
"""
import re

# Handlers that change the shown number, as the game applies them.
NUMBER_HANDLERS = {
    "negate": lambda value: -value,
    "divide_by_one_hundred": lambda value: value / 100,
    "divide_by_ten_0dp": lambda value: value / 10,
    "divide_by_one_thousand": lambda value: value / 1000,
    "per_minute_to_per_second": lambda value: value / 60,
    "per_minute_to_per_second_0dp": lambda value: value / 60,
    "per_minute_to_per_second_1dp": lambda value: value / 60,
    "per_minute_to_per_second_2dp": lambda value: value / 60,
    "per_minute_to_per_second_2dp_if_required": lambda value: value / 60,
    "milliseconds_to_seconds": lambda value: value / 1000,
    "milliseconds_to_seconds_0dp": lambda value: value / 1000,
    "milliseconds_to_seconds_1dp": lambda value: value / 1000,
    "milliseconds_to_seconds_2dp": lambda value: value / 1000,
    "milliseconds_to_seconds_2dp_if_required": lambda value: value / 1000,
    "deciseconds_to_seconds": lambda value: value / 10,
}
# Words after the text that don't change the number: the reminder text shown under the line, and markers for the
# item's look.
IGNORED_WORDS = {"reminderstring", "canonical_line", "canonical_stat"}
VARIANT_LINE = re.compile(r'^\s*(\S+(?:\s+\S+)*?)\s+"((?:[^"\\]|\\.)*)"\s*(.*)$')
PLACEHOLDER = re.compile(r"\{(\d*)(?::([^}]*))?\}")
MARKUP = re.compile(r"\[([^\]|]+)(?:\|([^\]]+))?\]")


def read_descriptions(texts):
    """{stat id: [description, ...]} from the description files' text; a description is {stats: [ids],
    variants: [{ranges, text, handlers}]}. Later files win over earlier ones for the same stats."""
    by_stat = {}
    for text in texts:
        for description in descriptions_in(text):
            for stat in description["stats"]:
                by_stat.setdefault(stat, []).insert(0, description)
    return by_stat


def descriptions_in(text):
    lines = text.replace("\r\n", "\n").split("\n")
    index = 0
    while index < len(lines):
        if lines[index].strip() != "description":
            index += 1
            continue
        index += 1
        header = lines[index].split()
        count = int(header[0])
        stats = header[1:1 + count]
        index += 1
        variant_count = int(lines[index].strip())
        index += 1
        variants = []
        for _ in range(variant_count):
            variant = variant_of(lines[index], count)
            if variant is not None:
                variants.append(variant)
            index += 1
        yield {"stats": stats, "variants": variants}


def variant_of(line, stat_count):
    match = VARIANT_LINE.match(line)
    if match is None:
        return None
    ranges = match.group(1).split()
    if len(ranges) != stat_count:
        return None
    words = match.group(3).split()
    handlers = []
    position = 0
    while position < len(words):
        word = words[position]
        if word in IGNORED_WORDS:
            position += 2
            continue
        if position + 1 < len(words) and words[position + 1].isdigit():
            handlers.append((word, int(words[position + 1]) - 1))
            position += 2
            continue
        handlers.append((word, None))
        position += 1
    return {"ranges": [range_of(text) for text in ranges], "text": match.group(2), "handlers": handlers}


def range_of(text):
    """(low, high) of "#", "1|#", "#|-1", "100", "1|99", "!0"; None for a range this reader doesn't know."""
    if text == "#":
        return (None, None)
    if text.startswith("!"):
        return None
    parts = text.split("|")
    if len(parts) > 2 or not all(part == "#" or re.fullmatch(r"-?\d+", part) for part in parts):
        return None  # the files hold a few typos ("1|99#"); such a range matches nothing
    if len(parts) == 1:
        value = int(parts[0])
        return (value, value)
    low = None if parts[0] == "#" else int(parts[0])
    high = None if parts[1] == "#" else int(parts[1])
    return (low, high)


def in_range(value, bounds):
    if bounds is None:
        return False
    low, high = bounds
    return (low is None or value >= low) and (high is None or value <= high)


def describe(by_stat, values):
    """The lines the game shows for these stat values ({stat id: number}), or None when one can't be worded."""
    remaining = dict(values)
    lines = []
    while remaining:
        stat = next(iter(remaining))
        description = best_description(by_stat, stat, values)
        if description is None:
            return None
        line = worded(description, values)
        if line is None:
            return None
        if line:
            lines.append(line)
        for covered in description["stats"]:
            remaining.pop(covered, None)
    return lines


def best_description(by_stat, stat, values):
    """The description naming this stat and the most of the given ones (two stats shown as one line)."""
    best = None
    best_count = 0
    for description in by_stat.get(stat, []):
        count = sum(1 for named in description["stats"] if named in values)
        if count > best_count:
            best = description
            best_count = count
    return best


def worded(description, values):
    numbers = [values.get(stat, 0) for stat in description["stats"]]
    for variant in description["variants"]:
        if not all(in_range(number, bounds) for number, bounds in zip(numbers, variant["ranges"])):
            continue
        shown = list(numbers)
        for handler, position in variant["handlers"]:
            if handler not in NUMBER_HANDLERS:
                return None
            target = 0 if position is None else position
            shown[target] = NUMBER_HANDLERS[handler](shown[target])
        return filled(variant["text"], shown)
    if all(number == 0 for number in numbers):
        return ""  # a stat at 0 the game doesn't show
    return None


def filled(text, numbers):
    unnumbered = [0]  # "{}" takes the next stat in turn

    def replacement(match):
        if match.group(1):
            position = int(match.group(1))
        else:
            position = unnumbered[0]
            unnumbered[0] += 1
        value = numbers[position]
        shown = number_text(value)
        if match.group(2) == "+d" and value >= 0:
            shown = "+" + shown
        return shown
    plain = PLACEHOLDER.sub(replacement, text)
    plain = MARKUP.sub(lambda match: match.group(2) or match.group(1), plain)
    return plain.replace("\\n", " ").strip()


def number_text(value):
    if abs(value - round(value)) < 1e-9:
        return str(int(round(value)))
    return f"{value:.2f}".rstrip("0").rstrip(".")
