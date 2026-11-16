#!/usr/bin/env python3
"""Tests scripts/mechanics_vocabulary.py: real stat lines and the effect each must read as.

    python3 scripts/test_mechanics.py      (part of npm run test:builds)

Several cases are lines that were once misread; each says what went wrong, so the mistake can't come back.
"""
import sys

from mechanics_vocabulary import read_line, read_line_effects, split_lines
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
    # Dance with Death's downside was left unread (2026-11-25), so the generator took its lucky crits for free; it
    # needs immunity to extra crit damage (The Brass Dome) beside it.
    ("Enemies' Damage with Critical Strikes against you is Lucky", "roll", dict(kind="flag", stat="critTakenLucky")),
    ("Take no Extra Damage from Critical Strikes", "roll", dict(kind="flag", stat="noExtraCritDamage")),
    ("You take 100% reduced Extra Damage from Critical Strikes", "roll", dict(kind="flag", stat="noExtraCritDamage")),
    # Life leech lost its scope (2026-11-25), so a caster weapon's attack leech kept spell builds alive.
    ("2.2% of Physical Attack Damage Leeched as Life", "roll", dict(kind="flat", stat="leech", tags=["physical", "attack"])),
    # Hidden Potential (2026-11-25): "for each Magic Item Equipped" read as stacks; the builds wear no magic items.
    ("(20-25)% increased Damage for each Magic Item Equipped", "roll", dict(kind="minor")),
    # Precise Technique read as an unknown condition (2026-11-14), so its 40% counted at a guessed uptime whatever
    # the build's accuracy.
    ("40% more Attack Damage if Accuracy Rating is higher than Maximum Life", "roll", dict(kind="more", condition="accuracyAboveLife")),
    # Two-attribute lines read as all three (2026-11-12), which matters once attribute requirements are met by gear.
    ("+20 to Strength and Dexterity", "roll", dict(stat="strength", value=20.0)),
    # Bloodlines (2026-11-12): per-minion lines read as 3 stacks, so Umbral Army went on every attack build.
    ("15% increased Attack Damage per Raised Zombie", "roll", dict(stat="damage", condition="perOwnMinion")),
    ("6% increased Spell Damage per Summoned Skeleton", "roll", dict(stat="damage", condition="perOwnMinion")),
    ("4% increased Attack Speed per Minion, up to a maximum of 80%", "roll", dict(stat="attackSpeed", condition="perOwnMinion")),
    # Oath of the Maji wants gemless slots: gloves and boots are given up for it, body and helmet lines aren't counted.
    ("25% increased Maximum Life if you have Equipped Gloves with no Socketed Gems", "roll", dict(stat="life", value=25.0, condition=None)),
    ("+50% to all Elemental Resistances if you have an Equipped Helmet with no Socketed Gems", "roll", dict(kind="minor")),
    ("+2 to Level of all Lightning Skill Gems if at least 4 Foulborn Unique Items are Equipped", "roll", dict(kind="minor")),
    # Defensive self buffs: Arctic Armour's "while stationary" lingers after you move; Frost Shield's life is a pool.
    ("Buff grants (11-21)% less Physical Damage taken from Hits while stationary", "level",
     dict(kind="more", stat="damageTaken", value=-21.0, condition="stationaryLingering")),
    # The Offerings' buff read as a skill they grant ("Grants Minions ..." took the grant pattern) until 2026-11-22,
    # so no Offering did anything.
    ("Grants Minions (20-30)% increased Attack Speed", "level",
     dict(kind="increased", stat="attackSpeed", subject="minion", value=30.0)),
    ("Grants Minions +(30-39)% to Critical Strike Multiplier", "level",
     dict(kind="flat", stat="critMulti", subject="minion", value=39.0)),
    ("Frost Shield has (190-910) maximum Life per Stage", "level", dict(stat="frostShieldPool", value=3640.0)),
    # Conversion moves life into energy shield; it read like "as extra", which kept the life (Ghostwrithe doubled half
    # the pool and sat in 88% of generated builds, 2026-11-12).
    ("50% of Maximum Life Converted to Energy Shield", "roll", dict(stat="lifeConvertedToEnergyShield", value=50.0)),
    ("Gain 20% of Maximum Life as Extra Maximum Energy Shield", "roll", dict(stat="lifeToEnergyShield", value=20.0)),
    # Damage from defences (Righteous Fire, Ephemeral Edge, Dreamfeather): Dreamfeather read as 3 stacks.
    ("1% increased Attack Damage per 450 Evasion Rating", "roll", dict(kind="perDefence", defence="evasion", per=450)),
    ("Deals 70% of your Maximum Life as Base Fire Damage per second", "level", dict(kind="perDefence", defence="life", value=70.0)),
    ("You Burn for 90% of your Maximum Life per second as Fire Damage", "level", dict(stat="selfBurnLife", value=90.0)),
    ("Attacks with this Weapon have Added Maximum Lightning Damage equal to (10-15)% of Player's Maximum Energy Shield", "roll",
     dict(kind="perDefence", defence="energyShield", value=6.25)),
    ("Armour is increased by Overcapped Fire Resistance", "roll", dict(kind="flag", stat="armourFromOvercappedFire")),
    # Endurance Charges are counted, not assumed at 3; Undeniable's accuracy line read as 3 stacks (3%).
    ("1% additional Physical Damage Reduction per Endurance Charge", "roll", dict(stat="physicalReduction", condition="perEnduranceCharge")),
    ("1% increased Attack Speed per 150 Accuracy Rating", "roll", dict(stat="attackSpeed", value=15)),
    ("Enemies you or your Totems Kill have 10% chance to Explode, dealing 250% of their maximum Life as Fire Damage", "roll",
     dict(kind="flag", stat="explodeOnKill")),
    # Impale lines were always on, so a Champion with no chance to impale got them in full (2026-11-12). Impale is
    # modelled now: the extra hits and Impales feed it, and "when you impale" lines hold as often as the build does.
    ("Impales you inflict last 1 additional Hit", "roll", dict(kind="flat", stat="impaleHits", value=1.0)),
    ("Inflict 5 additional Impales on Enemies you Impale", "roll", dict(kind="flat", stat="impaleExtra", value=5.0)),
    ("15% increased Impale Effect", "roll", dict(kind="increased", stat="effect:impale", value=15.0)),
    ("If you've Impaled an Enemy Recently, you\nand nearby Allies have +1000 to Armour", "roll",
     dict(stat="armour", value=1000.0, condition="impale")),
    ("You and nearby Allies deal 6 to 12 added Physical Damage for\neach Impale on Enemy", "roll",
     dict(kind="added", stat="damage", value=45, condition="impale")),
    # "per Fortification above 20" read as 3 stacks, so every Champion got 9% more armour and attack speed.
    ("3% more Armour and Evasion Rating per Fortification above 20", "roll", dict(stat="armour", condition="fortificationAbove20")),
    ("3% increased Attack Speed per Fortification above 20", "roll", dict(stat="attackSpeed", condition="fortificationAbove20")),
    # Rage wasn't modelled: these lines were unread or a flat guess. Now they are Rage sources and riders the engine
    # scales by Rage.
    ("Every Rage also grants 1% increased Attack Speed", "roll", dict(kind="flag", stat="rageGrantsAttackSpeed")),
    ("Gain 1 Rage on Attack Hit", "roll", dict(kind="flag", stat="rageSource", tags=["attack"])),
    ("Gain 3 Rage on Melee Weapon Hit", "roll", dict(kind="flag", stat="rageSource", tags=["melee"])),
    ("Gain 1 Rage on Hit with Axes", "roll", dict(kind="flag", stat="rageSource", tags=["axe"])),
    # Conditions found missing by scripts/check_against_pob.py (2026-11-12). Special shapes and hand-written statements
    # matched the start of a line and dropped the condition after it, so these all read as always on.
    ("+10% to Damage over Time Multiplier if you've Killed Recently", "roll", dict(stat="dotMulti", condition="recentKill")),
    ("+18% to Cold Damage over Time Multiplier per Power Charge", "roll", dict(stat="dotMulti", tags=["cold"], condition="perStack")),
    ("+12% to Damage over Time Multiplier for Poison you inflict on Bleeding Enemies", "roll",
     dict(stat="dotMulti", tags=["poison"], condition="enemyBleeding")),
    ("+3 to Minimum Endurance Charges while on Low Life", "roll", dict(stat="minimumEnduranceCharges", condition="lowLife")),
    ("Prevent +15% of Suppressed Spell Damage while on Full Energy Shield", "roll", dict(stat="suppressPrevent", condition="fullEnergyShield")),
    # ...but a "per" that belongs to the stat stays: life per enemy hit is not a stacking condition.
    ("Grants 10 Life per Enemy Hit", "roll", dict(stat="onHitRecovery", value=10, condition=None)),
    # "while affected by Hatred" holds when the build runs Hatred (the engine checks); it read as "other" or not at all.
    ("+1.5% to Critical Strike Chance while affected by Hatred", "roll", dict(stat="baseCrit", condition="affectedBy:Hatred")),
    ("+20% to Damage over Time Multiplier while affected by Malevolence", "roll", dict(stat="dotMulti", condition="affectedBy:Malevolence")),
    ("20% increased Damage while affected by a Guard Skill", "roll", dict(stat="damage", condition="guard")),
    ("+15% Chance to Block Attack Damage from Cursed Enemies", "roll", dict(stat="block", condition="enemyCursed")),
    # A unique flask's lines hold during its effect; they were read as a made-up stat "effect:attackSpeedDuring".
    ("10% increased Attack Speed during Effect", "roll", dict(kind="increased", stat="attackSpeed", condition="flask")),
    ("10% increased Attack and Cast Speed during any Flask Effect", "roll", dict(kind="increased", condition="flask")),
    # A burst of regeneration every 4 seconds averages a quarter of it a second; it was a flat 8% a second.
    ("Every 4 seconds, Regenerate 10% of Life over one second", "roll", dict(stat="lifeRegen", value=2.5)),
    # Burning damage was read as ignite only, so burning skills didn't get it; it is fire damage over time.
    ("11% increased Burning Damage", "roll", dict(kind="increased", stat="damage", tags=["fire", "dot"], value=11)),
    ("Supported Skills deal 20% more Burning Damage", "roll", dict(kind="more", stat="damage", tags=["fire", "dot"])),
    # Item rarity and quantity were all read as minor; the build planner's rarity stage weighs the plain lines.
    ("(10-15)% increased Rarity of Items found", "roll", dict(kind="increased", stat="itemRarity", value=12.5)),
    ("10% reduced Quantity of Items found", "roll", dict(kind="increased", stat="itemQuantity", value=-10)),
    # A line about items dropped by some enemies has a scope we don't model: it stays minor, not global rarity.
    ("30% increased Rarity of Items Dropped by Enemies killed with a Critical Strike", "roll", dict(kind="minor")),
    ("Supported Skills deal (25-39)% more Spell Damage", "level",
     dict(kind="more", stat="damage", tags=["spell"], value=39, subject="supported")),
    ("Supported Skills have (40-54)% more Cast Speed", "level", dict(kind="more", stat="castSpeed", value=54)),
    ("+1 to Level of all Spell Skill Gems", "roll", dict(kind="level", stat="gemLevel", tags=["spell"], value=1)),
    ("Minions deal 25% increased Damage", "roll", dict(kind="increased", stat="damage", subject="minion", value=25)),
    ("20% more Critical Strike Chance while wielding a Dagger", "roll",
     dict(kind="more", stat="critChance", requires=["dagger"], value=20)),
    ("8% increased Damage per Endurance Charge", "roll", dict(kind="increased", stat="damage", condition="perEnduranceCharge")),
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
    ("Life Recovery other than Flasks cannot Recover Life to above Low Life", "roll", dict(kind="flag", stat="lifeCappedAtLowLife")),
    ("When taking Damage from Hits, 40% of Life loss below half Life is Prevented, then (100-81)% of Life loss prevented this way is lost over 4 seconds",
     "level", dict(kind="flag", stat="lowerHalfLifeProtected")),
    ("Supported Skills gain Added Lightning Damage equal to (8-14)% of Unreserved Maximum Mana", "level",
     dict(kind="more", stat="damage", subject="supported", condition="unreservedMana")),
    ("Supported Skills have +(70-98)% Damage over Time Multiplier for Ailments from Critical Strikes", "level",
     dict(kind="flat", stat="dotMulti", value=98, condition="onCrit")),
    ("-(20-10)% to all Elemental Resistances", "roll", dict(kind="resistance", value=-15)),
    ("Grants Level 20 Summon Raging Spirit Skill", "roll", dict(kind="grants", stat="Summon Raging Spirit", value=20)),
    # Unholy Might was read as its pre-3.24 self (30% of physical as extra chaos); it converts physical to chaos and
    # withers (2026-11-22).
    ("Minions have Unholy Might", "roll", dict(kind="conversion", tags=["chaos"], value=100, subject="minion", condition=None)),
    # Command of the Pit was unread: each minion rolls the buff on its own spell hits.
    ("With a Ghastly Eye Jewel Socketed, Minions have 25% chance to gain Unholy Might on Hit with Spells", "roll",
     dict(kind="conversion", tags=["chaos", "spell"], subject="minion", value=85.0)),
    # Chaotic Might is its own buff (30% of physical as extra chaos), not Unholy Might: both were unread.
    ("10% chance to gain Chaotic Might for 10 seconds on Kill", "roll",
     dict(kind="extra", tags=["chaos"], value=26.4, condition="recentKill")),
    ("Gain Unholy Might for 4 seconds on Critical Strike", "roll", dict(kind="conversion", tags=["chaos"], subject="self")),
    # Ghastly Gaze of the Lich needs 3 Ghastly Eye jewels socketed; its penetration was read as always on.
    ("Unholy Might you grant also causes target's Damage to Penetrate 10% Chaos Resistance", "roll", dict(kind="minor")),
    # 3.30.0.4's tree export marks game terms as links and gives exact ranges; these went unread (2026-11-22).
    ("15% reduced Damage taken from [Blind|Blinded] Enemies", "roll", dict(kind="flat", stat="damageTakenLess")),
    ("Triggers Level 20 [SummonTriggerbots::20|Summon Triggerbots] when Allocated", "roll", dict(kind="flag", stat="ascendancyGrant")),
    ("With at least one corpse within 6 metres, you and Allies within 6 metres deal 10% more Damage", "roll",
     dict(kind="more", stat="damage", value=10.0, condition="corpse")),
    ("When your Traps Trigger, your Traps within 2 metres also Trigger", "roll", dict(kind="more", tags=["trap"])),
    ("50% less Flask Life Recovery rate", "roll", dict(kind="more", stat="flaskRecovery", value=-50.0)),
    # 60% to wither at 10 minion hits a second holds 12 debuffs: 72% more chaos damage.
    ("Minions have 60% chance to inflict Withered on Hit", "roll", dict(kind="more", tags=["chaos"], value=72.0, subject="minion")),
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
    # gave every build, spells too, 12% more damage. Since 2026-11-23 it is 12% more attack damage under its condition
    # (it was a chance nothing read).
    ("12% chance to deal Double Damage with Attacks if Attack Time is longer than 1 second", "roll",
     dict(kind="more", stat="damage", tags=["attack"], condition="other")),
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
    # Mana costs (2026-11-13): mana leech, mana on hit or kill and cost efficiency pay for the main skill, so the
    # generator can reserve nearly all mana. Mana leech keeps its scope (a spell doesn't leech from attack lines),
    # and mana gained on hit or kill was read as life recovery.
    ("0.4% of Attack Damage Leeched as Mana", "roll", dict(kind="flat", stat="manaLeech", tags=["attack"], value=0.4)),
    ("0.5% of Physical Attack Damage Leeched as Mana", "roll", dict(stat="manaLeech", tags=["physical", "attack"])),
    ("Supported Attacks have (2-3.9)% of Damage Leeched as Mana", "level", dict(stat="manaLeech", tags=["attack"], subject="supported")),
    ("Gain 2 Mana per Enemy Hit with Attacks", "roll", dict(kind="flat", stat="manaOnHit", tags=["attack"], value=2.0)),
    ("Gain 15 Mana per Enemy Killed", "roll", dict(kind="flat", stat="manaOnKill", value=15.0)),
    ("Recover 2% of Mana on Kill", "roll", dict(kind="flat", stat="manaOnKillPercent", value=2.0)),
    ("Recover 1% of Mana when you Kill a Cursed Enemy", "roll", dict(stat="manaOnKillPercent")),
    ("15% increased Cost Efficiency of Attacks", "roll", dict(kind="increased", stat="costEfficiency", tags=["attack"], value=15.0)),
    ("10% increased Mana Cost Efficiency of Spells", "roll", dict(kind="increased", stat="costEfficiency", tags=["spell"], value=10.0)),
    ("6% increased Mana Cost Efficiency", "roll", dict(kind="increased", stat="costEfficiency", tags=[], value=6.0)),
    ("(3-5)% reduced Mana Cost of Skills", "roll", dict(kind="increased", stat="cost", value=-4.0)),
    ("Gain 10 Life per Enemy Hit with Attacks", "roll", dict(stat="onHitRecovery", value=10.0)),
    ("Supported Skills gain Base Mana Cost equal to 5% of Unreserved Maximum Mana", "level",
     dict(kind="flat", stat="costPerUnreservedMana", value=5.0, subject="supported")),
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
    # The tree audit (scripts/audit_tree_reading.py, 2026-11-23). "Area of Effect" became effect:areaOf, a stat nothing
    # read, on 33 tree nodes and the area supports (Increased Area of Effect, Intensify, Pulverise).
    ("12% increased Area of Effect", "roll", dict(kind="increased", stat="area", value=12.0)),
    ("3% increased Area of Effect per Power Charge, up to a maximum of 50%", "roll", dict(stat="area", condition="perStack")),
    ("60% increased Trap Trigger Area of Effect", "roll", dict(kind="minor")),
    # Conditions were folded into made-up effect names (effect:shocksYouInflictOnCursedEnemies).
    ("30% increased Effect of Shocks you inflict on Cursed Enemies", "roll", dict(stat="effect:shocks", condition="enemyCursed")),
    ("40% reduced Effect of Curses on you during Effect of any Mana Flask", "roll",
     dict(stat="effect:cursesOnYou", value=-40.0, condition="flask")),
    ("(25-44)% increased Effect of Chill inflicted with Supported Skills", "level", dict(stat="effect:chill", condition=None)),
    # Ailment duration on you is a defence; it read as the duration of the ailments you inflict.
    ("30% reduced Ignite Duration on you", "roll", dict(stat="ailmentDurationOnYou", value=-30.0)),
    # "fire an additional Projectile" was a flag nothing read; "with Claws or Daggers" needed both weapons at once.
    ("Attack Skills fire an additional Projectile while wielding a Claw or Dagger", "roll",
     dict(kind="flat", stat="projectiles", value=1.0, requires=["claw|dagger"])),
    ("20% increased Physical Damage with Axes or Swords", "roll", dict(stat="damage", tags=["axe|sword", "physical"])),
    # Double damage with a scope or condition stayed a chance nothing read.
    ("4% chance to deal Double Damage while wielding a Mace, Sceptre or Staff", "roll",
     dict(kind="more", stat="damage", value=4.0, requires=["mace|staff"])),
    ("Minions have 8% chance to deal Double Damage", "roll", dict(kind="more", stat="damage", subject="minion", value=8.0)),
    # Hex Master's drawback was a stat ("curseEffect") nothing read, so the keystone cost nothing.
    ("20% less Effect of your Curses", "roll", dict(kind="more", stat="effect:curses", value=-20.0)),
    ("15% reduced Effect of Curses on you", "roll", dict(stat="effect:cursesOnYou")),
    # "Recovery per second" isn't a "per" stack; "per second Channelled" and "per second you've been stationary" are.
    ("30% increased Maximum total Life Recovery per second from Leech", "roll", dict(stat="leechCap", condition=None)),
    ("100% increased total Recovery per second from Life Leech", "roll", dict(stat="leechRate", value=100.0)),
    ("Supported Skills deal (9-24)% more Damage per second Channelled, up to a maximum of 60%", "level",
     dict(kind="more", stat="damage", condition="perStack")),
    ("10% increased Area of Effect per second you've been stationary, up to a maximum of 50%", "roll",
     dict(stat="area", condition="perStack")),
    ("+15% to Critical Strike Multiplier for Spell Damage", "roll", dict(stat="critMulti", tags=["spell"])),
    ("+5% Elemental Resistances while holding a Shield", "roll", dict(kind="resistance", tags=["elemental"], requires=["shield"])),
    ("Retaliation Skills deal 15% increased Damage", "roll", dict(stat="damage", tags=["retaliation"])),
    ("Spell Skills have +5% to Damage over Time Multiplier for Poison", "roll", dict(stat="dotMulti", tags=["poison", "spell"])),
    ("Hatred has 50% increased Mana Reservation Efficiency", "roll", dict(stat="reservation", skill="Hatred", value=50.0)),
    ("Nearby Enemies have Cold Exposure while you are affected by Herald of Ice", "roll",
     dict(kind="exposure", tags=["cold"], value=-10, condition="affectedBy:Herald of Ice")),
    # Found by counting what the generated builds wear (2026-11-25). Corrupted Soul's bypass was a flag nothing read.
    ("50% of Non-Chaos Damage taken bypasses Energy Shield", "roll", dict(stat="nonChaosEsBypass", value=50.0)),
    # Gladiator doubles dual wielding's +20% block as well as its 10% more attack speed (it was the speed alone).
    ("Inherent Bonuses from Dual Wielding are doubled", "roll", dict(stat="block", value=20.0, condition="dualWield")),
    # Bitter Heresy's Chaotic Might needs Profane Ground you make, from a way to make Consecrated Ground; it was a
    # generic half for every build.
    ("Profane Ground you create also affects you and your Allies, granting Chaotic Might", "roll",
     dict(stat="damage", kind="extra", condition="ownConsecratedGround")),
    ("10% chance to create Consecrated Ground on Melee Kill, lasting 4 seconds", "roll",
     dict(kind="flag", stat="consecratedGroundSource")),
    # Close range read as "nearby" (bow builds took it) and enemies in it as 3 stacks.
    ("50% more Accuracy Rating at Close Range", "roll", dict(stat="accuracy", condition="closeRange")),
    ("5% increased Attack Speed per Enemy in Close Range", "roll", dict(stat="attackSpeed", condition="perEnemyInCloseRange")),
    # An enemy on full life is only the first hit; it read as your own full life.
    ("150% increased Critical Strike Chance against Enemies that are on Full Life", "roll",
     dict(stat="critChance", condition="enemyFullLife")),
    ("40% increased Physical Damage with Skills that Cost Life", "roll", dict(stat="damage", condition="skillCostsLife")),
    ("6% increased Cast Speed for each different Non-Instant Spell you've Cast Recently", "roll",
     dict(stat="castSpeed", condition="perDifferentSpellRecently")),
    ("12% of Damage taken Recouped as Life", "roll", dict(stat="recoup", value=12.0)),
    # Shadowed Blood (Assassin): physical damage only; it read as 40% of all damage recouped.
    ("40% of Physical Damage taken Recouped as Life", "roll", dict(stat="recoup", value=40.0, tags=["physical"])),
    # One number for two defences gives both (read as armour, or evasion, alone before 2026-11-27); the test reads
    # the first effect, so the second is checked by the line below in reverse order.
    ("+370 to Armour and Evasion Rating", "roll", dict(stat="armour", value=370.0)),
    ("20% increased Evasion and Energy Shield", "roll", dict(stat="evasion", value=20.0)),
    # Throwing speed speeds up traps or mines only (read as every skill's speed before 2026-11-27).
    ("15% increased Mine Throwing Speed", "roll", dict(stat="speed", value=15.0, tags=["mine"])),
    ("15% increased Trap Throwing Speed", "roll", dict(stat="speed", value=15.0, tags=["trap"])),
    # Item mod conditions the gear solver meets (2026-11-27): each its own, not "other".
    ("+3600 to Armour during Soul Gain Prevention", "roll", dict(stat="armour", condition="soulGainPrevention")),
    ("9.5% additional Physical Damage Reduction while Focused", "roll", dict(stat="physicalReduction", condition="focused")),
    ("While a Pinnacle Atlas Boss is in your Presence, 28% of Damage taken Recouped as Life", "roll",
     dict(stat="recoup", value=28.0, condition="pinnaclePresence")),
    # "Taken as" keeps its damage types for the card (they were dropped before 2026-11-27).
    ("50% of Physical Damage taken as Fire Damage", "roll", dict(stat="damageTakenAs", value=50.0, tags=["fire"], **{"from": ["physical"]})),
    ("15% of Physical Damage from Hits taken as Lightning Damage", "roll", dict(stat="damageTakenAs", value=15.0, tags=["lightning"], **{"from": ["physical"]})),
]

# GGG's tree export wraps long stats inside one string; the halves must be read as one line (Arcane Capacitor's first
# half read as effect:arcaneSurgeOnYouPer), while separate stats in one string stay apart.
SPLITS = [
    ("10% increased Effect of Arcane Surge on you per\n200 Mana spent Recently, up to 50%",
     ["10% increased Effect of Arcane Surge on you per 200 Mana spent Recently, up to 50%"]),
    ("10% increased Critical Strike Chance for each Mine Detonated\nRecently, up to 100%",
     ["10% increased Critical Strike Chance for each Mine Detonated Recently, up to 100%"]),
    ("Life Leech from Melee Damage is Instant\nCannot Recover Life other than from Leech",
     ["Life Leech from Melee Damage is Instant", "Cannot Recover Life other than from Leech"]),
]

# Lines whose scope words the vocabulary doesn't know must stay unread, never read as global.
UNREAD = [
    "(20-30)% increased Damage with Ballista Skills",
    # Haunting Memories: only suppressed spell damage, and recouped as energy shield. It read as 75% of all damage
    # recouped as life and sat in 55% of generated builds (2026-11-25).
    "(50-100)% of Suppressed Spell Damage taken Recouped as Energy Shield",
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
    # Both defences of a two-defence line, each with the number.
    for line, stats in (("+370 to Armour and Evasion Rating", ["armour", "evasion"]),
                        ("20% increased Evasion and Energy Shield", ["evasion", "energyShield"])):
        found = [(effect["stat"], effect.get("value")) for effect in read_line_effects(line, "roll")]
        if [stat for stat, _ in found] != stats or len({value for _, value in found}) != 1:
            failed += 1
            print(f"FAIL {line}: {found}")
        else:
            print(f"ok   {line} (both)")
    for text, wanted_lines in SPLITS:
        lines = split_lines(text)
        if lines != wanted_lines:
            failed += 1
            print(f"FAIL split {text!r}: {lines!r}")
        else:
            print(f"ok   split {text!r}")
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
