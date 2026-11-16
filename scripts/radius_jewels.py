"""Unique jewels that work on the passives in their radius, read into rules the tree planner applies
(public/buildradius.js). The jewel's other lines are read as usual; the radius lines become rules instead, so they no
longer count as stats of their own (Might of the Meek's "50% increased Effect" was a stat nothing used).

    rules, other_lines = radius_rules_of(lines, read_effects)

read_effects(text) is the unique reader's own (build_mechanics.effects_of), so a stat inside a rule ("instead grant:
Minions take 20% increased Damage") is read by our vocabulary like any other line. A radius line none of these
shapes matches is left to the usual reading, where it stays unread.

The rules, as the planner applies them to the passives inside the jewel's area (small passives and notables;
keystones only where a rule says so):
- transform: an effect of one kind and stat becomes another stat, at a factor (Healthy Mind: increased Life to
  increased Mana at 200%). For an attribute, "+X to all Attributes" moves its share of that attribute too.
- retag: effects tagged for melee or a melee weapon count for bows instead (Lioneye's Fall).
- scale: the effects of the given passives count at a factor (Might of the Meek, 150%).
- nothing: the given passives give nothing (Might of the Meek's notables, Unnatural Instinct's allocated smalls).
- instead: the given passives give these effects instead of their own (Fevered Mind's notables).
- also: the given passives give these effects as well (The Light of Meaning).
- alsoFromResistance: a passive with a resistance of the given elements gives these effects as well, valued at the
  resistance times a factor (The Red Nightmare: block at 50% of the fire resistance).
- unallocated: the given passives give their effects while they are not allocated (Unnatural Instinct).
- perAttribute: these effects for each `per` of an attribute on allocated (or unallocated) passives in the area
  (Transcendent Flesh).
- threshold: these effects once the allocated passives in the area give at least `amount` of the attributes.
- free: the passives in the area can be allocated without being connected to the tree (Intuitive Leap).
"""
import re

ATTRIBUTE_STAT = {"Strength": "strength", "Dexterity": "dexterity", "Intelligence": "intelligence"}
ATTRIBUTE = r"(Strength|Dexterity|Intelligence)"
NODE_KINDS = {"Notable": ["notable"], "Small": ["small"], "non-Keystone": ["small", "notable"]}
# Tags of effects about melee or a melee weapon, which Lioneye's Fall turns into bow ones (one tag may name a choice
# of weapons, "claw|dagger"). "oneHand" and "twoHand" come from "with One/Two Handed Melee Weapons".
MELEE_TAGS = ["melee", "axe", "sword", "mace", "claw", "dagger", "staff", "axe|sword", "claw|dagger", "mace|staff",
              "oneHand", "twoHand"]
# What "Increases and Reductions to X in Radius" names, as the vocabulary's stat for increased X.
INCREASE_STAT = {"Life": "life", "Energy Shield": "energyShield", "Mana": "mana", "Armour": "armour"}
# Lines that carry no rule and no stat: the free-allocation jewels' name for their mechanic.
LINES_WITHOUT_EFFECT = {"Passage"}
# A rule's stat in the wording the vocabulary reads: the game words these two only inside radius rules.
STAT_REWRITES = [
    (r"^Minions take (.+) Damage$", r"Minions have \1 Damage taken"),  # Fortress Covenant's notables
    (r"^([+-]?\d+) (Strength|Dexterity|Intelligence)$", r"\1 to \2"),  # "-1 Strength per 1 Strength on ..."
]


def radius_rules_of(lines, read_effects):
    """The rules the lines describe and the lines left for the usual reading."""
    rules = []
    other_lines = []
    for line in lines:
        if line in LINES_WITHOUT_EFFECT:
            continue
        rule = rule_of_line(line, read_effects)
        if rule is None:
            other_lines.append(line)
        elif rule != "consumed":
            rules.append(rule)
    return rules, other_lines


def rule_of_line(line, read_effects):
    for reader in (attribute_transform, increase_transform, melee_to_bow, effect_scale, grant_nothing,
                   instead_grant, also_grant, also_from_resistance, unallocated_smalls, per_attribute, threshold,
                   free_allocation, ring_only):
        rule = reader(line, read_effects)
        if rule is not None:
            return rule
    return None


def attribute_transform(line, read_effects):
    # "Strength from Passives in Radius is Transformed to Intelligence" (Brute Force Solution).
    match = re.match(r"^" + ATTRIBUTE + r" from Passives in Radius is Transformed to " + ATTRIBUTE + r"$", line)
    if match is None:
        return None
    return {"rule": "transform", "from": {"kind": "flat", "stat": ATTRIBUTE_STAT[match.group(1)]},
            "to": ATTRIBUTE_STAT[match.group(2)], "factor": 1}


def increase_transform(line, read_effects):
    # "Increases and Reductions to Life in Radius are Transformed to apply to Energy Shield" (Energy From Within),
    # "... to apply to Mana at 200% of their value" (Healthy Mind).
    match = re.match(r"^Increases and Reductions to (.+?) in Radius are Transformed to apply to (.+?)"
                     r"(?: at (\d+)% of their value)?$", line)
    if match is None or match.group(1) not in INCREASE_STAT or match.group(2) not in INCREASE_STAT:
        return None
    factor = int(match.group(3)) / 100 if match.group(3) else 1
    return {"rule": "transform", "from": {"kind": "increased", "stat": INCREASE_STAT[match.group(1)]},
            "to": INCREASE_STAT[match.group(2)], "factor": factor}


def melee_to_bow(line, read_effects):
    if line != "Melee and Melee Weapon Type modifiers in Radius are Transformed to Bow Modifiers":
        return None
    return {"rule": "retag", "from": MELEE_TAGS, "to": "bow"}


def effect_scale(line, read_effects):
    # "50% increased Effect of non-Keystone Passive Skills in Radius" (Might of the Meek).
    match = re.match(r"^(\d+)% increased Effect of (non-Keystone) Passive Skills in Radius$", line)
    if match is None:
        return None
    return {"rule": "scale", "nodes": NODE_KINDS[match.group(2)], "factor": 1 + int(match.group(1)) / 100}


def grant_nothing(line, read_effects):
    # "Notable Passive Skills in Radius grant nothing", "Allocated Small Passive Skills in Radius grant nothing".
    match = re.match(r"^(?:Allocated )?(Notable|Small) Passive Skills in Radius grant nothing$", line)
    if match is None:
        return None
    return {"rule": "nothing", "nodes": NODE_KINDS[match.group(1)]}


def instead_grant(line, read_effects):
    # "Notable Passive Skills in Radius are Transformed to instead grant: 10% increased Mana Cost of Skills and 20%
    # increased Spell Damage" (Fevered Mind; the wiki breaks it over two lines, which the splitter joins).
    match = re.match(r"^(Notable|Small) Passive Skills in Radius are Transformed to instead grant: (.+)$", line)
    if match is None:
        return None
    effects = effects_of_parts(match.group(2), read_effects)
    if effects is None:
        return None
    return {"rule": "instead", "nodes": NODE_KINDS[match.group(1)], "effects": effects}


def also_grant(line, read_effects):
    # "Passive Skills in Radius also grant 6% increased Fire Damage" (The Light of Meaning).
    match = re.match(r"^Passive Skills in Radius also grant (.+)$", line)
    if match is None:
        return None
    effects = effects_of_parts(match.group(1), read_effects)
    if effects is None:
        return None
    return {"rule": "also", "nodes": ["small", "notable"], "effects": effects}


def also_from_resistance(line, read_effects):
    # "Passives granting Fire Resistance or all Elemental Resistances in Radius also grant Chance to Block Attack
    # Damage at 50% of its value" (The Red Nightmare), "... also grant an equal chance to gain an Endurance Charge on
    # Kill" (The Red Dream). The granted stat is read at a value of 1, then scaled by each passive's resistance.
    match = re.match(r"^Passives granting (Fire|Cold|Lightning) Resistance or all Elemental Resistances in Radius "
                     r"also grant (.+)$", line)
    if match is None:
        return None
    granted = match.group(2)
    factor = 1
    at_value = re.match(r"^(.+?) at (\d+)% of its value$", granted)
    if at_value:
        granted = "+1% " + at_value.group(1)
        factor = int(at_value.group(2)) / 100
    elif granted.startswith("an equal chance "):
        granted = "1% chance " + granted[len("an equal chance "):]
    else:
        return None
    effects = effects_of_parts(granted, read_effects)
    if effects is None:
        return None
    return {"rule": "alsoFromResistance", "resistances": [match.group(1).lower(), "elemental"], "effects": effects,
            "factor": factor}


def unallocated_smalls(line, read_effects):
    if line != "Grants all bonuses of Unallocated Small Passive Skills in Radius":
        return None
    return {"rule": "unallocated", "nodes": ["small"]}


def per_attribute(line, read_effects):
    # "+7% to Critical Strike Multiplier per 10 Strength on Unallocated Passives in Radius", "-1 Strength per 1
    # Strength on Allocated Passives in Radius" (Transcendent Flesh): the stat, for each 10 (or 1) of the attribute.
    match = re.match(r"^(.+) per (\d+) " + ATTRIBUTE + r" on (Allocated|Unallocated) Passives in Radius$", line)
    if match is None:
        return None
    effects = effects_of_parts(match.group(1), read_effects)
    if effects is None:
        return None
    return {"rule": "perAttribute", "attributes": [ATTRIBUTE_STAT[match.group(3)]], "per": int(match.group(2)),
            "on": match.group(4).lower(), "effects": effects}


def threshold(line, read_effects):
    # "With at least 40 Intelligence in Radius, ..." and "With 40 total Intelligence and Dexterity in Radius, ...":
    # the attributes on the allocated passives in the area.
    match = re.match(r"^With (?:at least )?(\d+) (?:total )?" + ATTRIBUTE + r"(?: and " + ATTRIBUTE + r")? in Radius, (.+)$", line)
    if match is None:
        return None
    effects = effects_of_parts(match.group(4), read_effects)
    if effects is None:
        return None
    attributes = [ATTRIBUTE_STAT[match.group(2)]]
    if match.group(3):
        attributes.append(ATTRIBUTE_STAT[match.group(3)])
    return {"rule": "threshold", "attributes": attributes, "amount": int(match.group(1)), "effects": effects}


def free_allocation(line, read_effects):
    # Intuitive Leap and Thread of Hope ("Passive Skills in Radius can be Allocated without being connected to your
    # tree"), Impossible Escape ("... in Radius of <random Keystone> ..."; the area is round the keystone, which each
    # version of the item names).
    # The wiki escapes Impossible Escape's placeholder twice ("&lt;random Keystone&gt;").
    keystone_placeholder = r"(?:<|&lt;)random Keystone(?:>|&gt;)"
    if re.match(r"^Passive Skills in Radius(?: of " + keystone_placeholder + r")? can be Allocated without being "
                r"connected to your tree$", line):
        return {"rule": "free"}
    return None


def ring_only(line, read_effects):
    # "Only affects Passives in Massive Ring" (Thread of Hope): the item's area, which its versions carry.
    if re.match(r"^Only affects Passives in .+ Ring$", line):
        return "consumed"
    return None


def effects_of_parts(text, read_effects):
    """The effects of a rule's stat text, which may join two stats with " and " ("10% increased Mana Cost of Skills
    and 20% increased Spell Damage"). None when any part stays unread: a rule is kept only when all of it is read."""
    parts = [text]
    joined = re.split(r" and (?=[+-]?\d)", text)
    if len(joined) > 1:
        parts = joined
    effects = []
    for part in parts:
        for pattern, replacement in STAT_REWRITES:
            part = re.sub(pattern, replacement, part)
        found, unread = read_effects(part)
        if unread or not found:
            return None
        effects.extend(found)
    return effects
