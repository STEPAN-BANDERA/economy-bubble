#!/usr/bin/env python3
"""Tests scripts/mechanics_vocabulary.py: real stat lines and the effect each must read as.

    python3 scripts/test_mechanics.py      (part of npm run test:builds)

Several cases are lines that were once misread; each says what went wrong, so the mistake can't come back.
"""
import sys

from mechanics_vocabulary import read_line, read_line_effects
from text_files import use_utf8_console


def expect(line, range_mode, **wanted):
    """The first effect of the line must have every wanted field."""
    found = read_line_effects(line, range_mode)[0]
    problems = []
    for key, value in wanted.items():
        actual = found.get(key)
        if isinstance(value, list):
            actual = sorted(actual or [])
            value = sorted(value)
        if actual != value:
            problems.append(f"{key}={actual!r}, wanted {value!r}")
    return problems


CASES = [
    # (line, range mode, expected fields)
    ("Supported Skills deal (25-39)% more Spell Damage", "level",
     dict(kind="more", stat="damage", tags=["spell"], value=39, subject="supported")),
    ("Supported Skills have (40-54)% more Cast Speed", "level", dict(kind="more", stat="castSpeed", value=54)),
    ("+1 to Level of all Spell Skill Gems", "roll", dict(kind="level", stat="gemLevel", tags=["spell"], value=1)),
    ("Minions deal 25% increased Damage", "roll", dict(kind="increased", stat="damage", subject="minion", value=25)),
    ("20% more Critical Strike Chance while wielding a Dagger", "roll",
     dict(kind="more", stat="critChance", requires=["dagger"], value=20)),
    ("8% increased Damage per Endurance Charge", "roll", dict(kind="increased", stat="damage", condition="perStack")),
    ("Nearby Enemies have -20% to Cold Resistance", "roll",
     dict(kind="exposure", stat="resistance", tags=["cold"], value=-20, subject="enemy")),
    ("Attack Damage Penetrates 8% of Enemy Elemental Resistances", "roll",
     dict(kind="penetration", tags=["elemental", "attack"], value=8)),
    ("Supported Skills have (1-19) to (8-358) added Lightning Damage", "level",
     dict(kind="added", stat="damage", tags=["lightning"], value=188.5)),
    ("Arcane Surge also grants 20% more Spell Damage to you", "roll",
     dict(kind="more", stat="damage", tags=["spell"], condition="arcaneSurge")),
    ("Supported Skills deal (58-52)% less Damage", "level", dict(kind="more", stat="damage", value=-52)),
    ("10% increased Damage taken", "roll", dict(kind="increased", stat="damageTaken", value=10)),
    ("+60% to Chaos Resistance", "roll", dict(kind="resistance", tags=["chaos"], value=60)),
    ("4% less Damage taken per Gale Force", "roll", dict(kind="more", stat="damageTaken", condition="perStack")),
    ("Axe Attacks deal 12% increased Damage with Hits and Ailments", "roll",
     dict(kind="increased", stat="damage", tags=["axe", "attack"])),
    ("+15% to Damage over Time Multiplier for Poison", "roll", dict(kind="flat", stat="dotMulti", tags=["poison"])),
    ("If you've Cast a Spell Recently, you and nearby Allies have +10% Chance to Block Spell Damage", "roll",
     dict(kind="flat", stat="spellBlock", condition="recentSpell")),
    ("Socketed Gems are Supported by Level 20 Trap", "roll", dict(kind="socketedSupport", stat="Trap", value=20)),
    ("Hits always Ignite", "roll", dict(kind="flat", stat="ailmentChance", tags=["ignite"], value=100)),
    ("Your Critical Strike Chance is Lucky", "roll", dict(kind="more", stat="critChance")),
    ("Exposure you inflict applies an extra -25% to the affected Resistance", "roll",
     dict(kind="exposure", value=-25, subject="enemy")),
    ("Cannot deal non-Cold Damage", "roll", dict(kind="flag", stat="pureElement")),
    ("Supported Skills gain Added Lightning Damage equal to (8-14)% of Unreserved Maximum Mana", "level",
     dict(kind="more", stat="damage", subject="supported")),
    ("Supported Skills have +(70-98)% Damage over Time Multiplier for Ailments from Critical Strikes", "level",
     dict(kind="flat", stat="dotMulti", value=98, condition="onCrit")),
    ("-(20-10)% to all Elemental Resistances", "roll", dict(kind="resistance", value=-15)),
    ("Grants Level 20 Summon Raging Spirit Skill", "roll", dict(kind="grants", stat="Summon Raging Spirit", value=20)),
    ("+(50-70) to maximum Life", "roll", dict(kind="flat", stat="life", value=60)),
    ("(10-15)% increased maximum Life", "roll", dict(kind="increased", stat="life", value=12.5)),
    ("+(30-40)% to Global Critical Strike Multiplier", "roll", dict(kind="flat", stat="critMulti", value=35)),
    ("Adds (10-15) to (25-30) Cold Damage to Attacks", "roll", dict(kind="added", tags=["cold", "attack"])),
    ("20% of Physical Damage Converted to Fire Damage", "roll",
     dict(kind="conversion", tags=["fire"], **{"from": ["physical"]}, value=20)),
    ("Gain 10% of Physical Damage as Extra Chaos Damage", "roll",
     dict(kind="extra", tags=["chaos"], **{"from": ["physical"]})),
    ("+1 to Maximum Power Charges", "roll", dict(kind="limit", stat="powerCharges", value=1)),
    ("+1 to maximum number of Summoned Totems", "roll", dict(kind="limit", stat="totems", value=1)),
    ("25% increased Light Radius", "roll", dict(kind="minor")),
    ("Has 1 Socket", "roll", dict(kind="minor")),

    # ---------- lines once misread ----------
    # Flat regeneration was taken for a percentage of life (Immortal Flesh looked enormous).
    ("Regenerate (250-300) Life per second", "roll", dict(kind="flat", stat="lifeRegenFlat")),
    ("Regenerate 2% of Life per second", "roll", dict(kind="flat", stat="lifeRegen", value=2)),
    # "+5 to Level of all Cyclone Gems" read as all gems.
    ("+5 to Level of all Cyclone Gems", "roll", dict(kind="level", skill="Cyclone")),
    # "while you have no Frenzy Charges" was multiplied as if per charge.
    ("(60-80)% increased Damage while you have no Frenzy Charges", "roll",
     dict(kind="increased", stat="damage", condition="chargeState")),
    # A plural ("Ignites") dropped the scope, so the line sped up every build.
    ("Ignites you inflict deal Damage (35-45)% faster", "roll", dict(kind="more", stat="ailmentSpeed", tags=["ignite"])),
    # Volatility's "more Maximum" damage read as plain more damage.
    ("Supported Skills deal (30-58)% more Maximum Attack Damage", "level", dict(kind="more", value=10)),
    # Pragmatism's per-gem penalty was ignored.
    ("-2 to level of Socketed Skill Gems per Socketed Gem", "roll", dict(kind="level", value=-12)),
    # Momentum's attack speed only lasts while standing still.
    ("Supported Skills have (15-20)% increased Attack Speed per Momentum", "level",
     dict(kind="increased", stat="attackSpeed", condition="stationary")),
    # Mana regeneration read as life regeneration (Mastermind of Discord).
    ("Regenerate 1% of Mana per second if you've inflicted Exposure Recently", "roll", dict(kind="minor")),
    # The condition after "Damage Reduction" was dropped, so Veteran's Awareness looked always on.
    ("20% additional Physical Damage Reduction while affected by a Non-Vaal Guard Skill", "roll",
     dict(kind="flat", stat="physicalReduction", value=20, condition="guard")),
    # "Blocked Spell Damage Recently" read as an ordinary 50% condition on 100% block.
    ("+100% Chance to Block Attack Damage if you have Blocked Spell Damage Recently", "roll",
     dict(kind="flat", stat="block", condition="recentBlock")),
    # Mace Mastery: the double damage statement swallowed "with Attacks if Attack Time is longer than 1 second" and
    # gave every build, spells too, 12% more damage.
    ("12% chance to deal Double Damage with Attacks if Attack Time is longer than 1 second", "roll",
     dict(kind="chance", stat="doubleDamage", condition="other")),
    # Staff Mastery: "haven't dealt a Critical Strike Recently" was read as "have", the opposite.
    ("+60% to Critical Strike Multiplier if you haven't dealt a Critical Strike Recently", "roll",
     dict(kind="flat", stat="critMulti", value=60, condition="noRecentCrit")),
    ("35% less Damage taken if you have not been Hit Recently", "roll",
     dict(kind="more", stat="damageTaken", condition="notRecentlyHit")),
    # Leech Mastery: the recoup's condition was dropped, so it looked always on.
    ("25% of Damage taken Recouped as Life if Leech was removed by Filling Unreserved Life Recently", "roll",
     dict(kind="flat", stat="recoup", condition="other")),
    # Life Mastery: counted as a 50% condition, though the planner never counts masteries.
    ("10% more Maximum Life if you have at least 6 Life Masteries allocated", "roll",
     dict(kind="more", stat="life", condition="masteryCount")),
    ("25% more Damage with Hits against Enemies that cannot have Life Leeched from them", "roll",
     dict(kind="more", stat="damage", condition="unleechable")),
    # Augury of Penitence: "Nearby Enemies deal 8% less Elemental Damage" lost its verb and cut the build's own
    # damage by 8%. Less damage dealt by enemies is less damage taken.
    ("Nearby Enemies deal 8% less Elemental Damage", "roll",
     dict(kind="more", stat="damageTaken", value=-8, subject="self")),
    ("Nearby Enemies take 16% increased Elemental Damage", "roll",
     dict(kind="increased", stat="damage", value=16, subject="enemy")),
    # Auras, heralds and curses word their stats from the outside; all of these were unread.
    ("You and nearby allies gain (30-39)% of Physical Damage as Extra Cold Damage", "level",
     dict(kind="extra", stat="damage", tags=["cold"], value=39, subject="self")),
    ("You and nearby allies deal (16-109) to (23-155) additional Fire Damage with Attacks", "level",
     dict(kind="added", stat="damage", tags=["attack", "fire"], subject="self")),
    ("You and nearby allies gain (90-1026) additional Armour", "level", dict(kind="flat", stat="armour", value=1026)),
    ("You and nearby allies gain (0-4)% additional maximum Cold Resistance", "level",
     dict(kind="flat", stat="maxResistance", tags=["cold"], value=4)),
    ("Buff grants (4-38) to (5-56) Added Spell Cold Damage", "level",
     dict(kind="added", stat="damage", tags=["spell", "cold"], subject="self")),
    ("Banner grants +4% Chance to Block Attack Damage to You and Allies", "roll", dict(kind="flat", stat="block", value=4)),
    # A curse's resistance cut is not exposure (exposure doesn't stack with other exposure).
    ("Cursed enemies have -(17-36)% to Fire Resistance", "level",
     dict(kind="resistance", stat="resistance", tags=["fire"], value=-36, subject="enemy")),
    ("Hits against Cursed Enemies have +(30-49)% to Critical Strike Multiplier", "level",
     dict(kind="flat", stat="critMulti", value=49, subject="self")),
    # Enfeeble: the build is measured against a boss, so only the rare-or-unique half counts.
    ("Cursed Rare or Unique enemies deal (9-18)% less Damage", "level",
     dict(kind="more", stat="damageTaken", value=-18, subject="self")),
    ("Cursed Normal or Magic enemies deal (15-29)% less Damage", "level", dict(kind="minor")),
    # Slayer's Endless Hunger: overkill leech was read as 20% of all damage leeched, the largest leech in the game;
    # it only recovers on a kill. Mana leech was counted as life leech.
    ("20% of Overkill Damage is Leeched as Life", "roll", dict(kind="minor")),
    ("0.4% of Attack Damage Leeched as Mana", "roll", dict(kind="minor")),
    ("0.5% of Physical Attack Damage Leeched as Life", "roll", dict(kind="flat", stat="leech", value=0.5)),
    # Timeclasp: mana recoup was counted as life recoup.
    ("(6-12)% of Damage taken Recouped as Mana", "roll", dict(kind="minor")),
    ("(6-12)% of Damage taken Recouped as Life", "roll", dict(kind="flat", stat="recoup", value=9)),
    # Flask and recharge lines were one "flask" / "esRecharge" stat whatever they changed.
    ("25% increased Flask Effect Duration", "roll", dict(kind="increased", stat="flaskDuration", value=25)),
    ("20% increased Life Recovery from Flasks", "roll", dict(kind="increased", stat="flaskRecovery", value=20)),
    ("Magic Utility Flasks applied to you have 30% increased Effect", "roll", dict(kind="increased", stat="flaskEffect", value=30)),
    ("Flasks gain 3 Charges every 3 seconds", "roll", dict(kind="flat", stat="flaskChargesPerSecond", value=1)),
    ("30% faster start of Energy Shield Recharge", "roll", dict(kind="increased", stat="esRechargeStart", value=30)),
    ("40% increased Energy Shield Recharge Rate", "roll", dict(kind="increased", stat="esRecharge", value=40)),
    # 3.30 words "nearby" as an exact range; these are our guesses at its shape, read like the "nearby" lines.
    ("Enemies within 4 metres have -20% to Cold Resistance", "roll",
     dict(kind="exposure", stat="resistance", tags=["cold"], value=-20, subject="enemy")),
    ("Enemies within 6 metres deal 8% less Elemental Damage", "roll",
     dict(kind="more", stat="damageTaken", value=-8, subject="self")),
    ("You and Allies within 4.5 metres gain (30-39)% of Physical Damage as Extra Cold Damage", "level",
     dict(kind="extra", stat="damage", tags=["cold"], value=39, subject="self")),
]

# Lines whose scope words the vocabulary doesn't know must stay unread, never read as global.
UNREAD = [
    "(20-30)% increased Damage with Ballista Skills",
]


def main():
    failed = 0
    for line, range_mode, wanted in CASES:
        problems = expect(line, range_mode, **wanted)
        if problems:
            failed += 1
            print(f"FAIL {line}: {'; '.join(problems)}")
        else:
            print(f"ok   {line}")
    for line in UNREAD:
        if read_line(line, "roll").get("understood"):
            failed += 1
            print(f"FAIL {line}: read, but its scope is unknown")
        else:
            print(f"ok   {line} (left unread)")
    if failed:
        print(f"\n{failed} failed.")
        sys.exit(1)
    print("\nAll passed.")


if __name__ == "__main__":
    use_utf8_console()
    main()
