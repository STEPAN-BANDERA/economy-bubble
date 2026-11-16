"""Hand-written readings of stat lines that are rules rather than numbers: keystones, ascendancy mechanics and
build-defining unique lines. The general grammar in mechanics_vocabulary.py can't read "Hits always Ignite" or
"Strength's Damage bonus applies to all Spell Damage as well", so each such mechanic is written here once, in our
own terms, as one or more effects the generator understands.

Each entry is (pattern, effects). The pattern is a regular expression matched case-insensitively against the
whole line; its first group, when it has one, is the number in the line. Each effect is a dict like those
mechanics_vocabulary.effect() makes; "value": "#" means "the pattern's number", and a plain number is our own
estimate of what the rule is worth (each one says why in a comment).

"minor" effects mark lines we read and deliberately ignore: they don't change how strong a build is in the ways
the generator measures (side systems like Mercenaries, Tinctures and Barks, or pure convenience).
"""

# A number, or a "(low-high)" range (gem text gives level 1 to level 20, unique text gives the roll range).
NUMBER = r"([+-]?(?:\(\d+(?:\.\d+)?-\d+(?:\.\d+)?\)|\d+(?:\.\d+)?))"


def more(stat, tags=None, value="#", condition=None, subject="self"):
    return {"kind": "more", "stat": stat, "tags": tags or [], "value": value, "subject": subject, "condition": condition}


def flat(stat, tags=None, value="#", condition=None, subject="self"):
    return {"kind": "flat", "stat": stat, "tags": tags or [], "value": value, "subject": subject, "condition": condition}


def flag(name, tags=None, subject="self"):
    return {"kind": "flag", "stat": name, "tags": tags or [], "value": None, "subject": subject, "condition": None}


def minor():
    return {"kind": "minor", "stat": "minor", "tags": [], "value": None, "subject": "self", "condition": None}


def increased(stat, tags=None, value="#", condition=None, subject="self", requires=None):
    found = {"kind": "increased", "stat": stat, "tags": tags or [], "value": value, "subject": subject, "condition": condition}
    if requires:
        found["requires"] = list(requires)
    return found


# Exposure lowers the enemy's resistance to one element by 10%: our understanding of the game's base value, not
# checked against a source (poewiki.net refused an automated read on 2026-11-23; the patch notes only give the
# exceptions, such as Avatar of the Veil's -20% outside Ruthless). The vocabulary writes enemy resistance as a
# negative value.
EXPOSURE_RESISTANCE = 10


def exposure(element, value=-EXPOSURE_RESISTANCE, condition=None):
    return {"kind": "exposure", "stat": "resistance", "tags": [element], "value": value, "subject": "enemy",
            "condition": condition}


def enemy_takes(value, tags=None, condition=None, requires=None):
    """"Enemies take N% increased Damage", as the vocabulary reads "Nearby Enemies take ..."."""
    found = {"kind": "increased", "stat": "damage", "tags": tags or [], "value": value, "subject": "enemy",
             "condition": condition}
    if requires:
        found["requires"] = list(requires)
    return found


# Character figures some tree lines are read against: our estimates for a level 90-95 character, not measurements.
# Strength or intelligence of a character that invests in it (base, tree and gear), and dexterity for accuracy.
TYPICAL_MAIN_ATTRIBUTE = 200
TYPICAL_DEXTERITY = 150
# Maximum life of a finished life build (the "ready" threshold is 3,000; most finished builds carry more).
TYPICAL_LIFE = 4500
# Armour plus evasion of a hybrid armour/evasion build.
TYPICAL_ARMOUR_AND_EVASION = 20000


# ---------- Withered, Unholy Might and Chaotic Might ----------
# Withered (the tree's reminder text): each debuff makes the enemy take 6% increased Chaos Damage, up to 15 debuffs,
# and each one expires on its own 2 seconds after it was inflicted. So the debuffs an enemy carries are what arrives
# in 2 seconds: hits a second x the chance to wither on hit x 2. The fight doesn't hold the full 15 unless about 30
# withering hits land every 2 seconds; when the hits pause, the debuffs fall off within 2 seconds (a player's report
# of Phantasms with Command of the Pit, 2026-11-21: "wither fades very fast").
WITHERED_INCREASED_TAKEN = 6
WITHERED_MAXIMUM = 15
WITHERED_SECONDS = 2
# Hits a second on one enemy. A minion army's: our estimate, from a player's report of Phantasms each hitting
# "multiple times per second" (2026-11-21), several of them at once. Your own: our estimate of a fast attack or cast
# on a boss. Not measurements.
MINION_HITS_PER_SECOND = 10
SELF_HITS_PER_SECOND = 4
# Events a second for "chance to gain ... for N seconds on Kill / on Critical Strike", while they happen at all (the
# line's condition says how often that is): our estimates. Kills while clearing a map; crits for a crit build, about
# half of its hits.
KILLS_PER_SECOND_WHILE_KILLING = 2
CRITS_PER_SECOND = 2
# How often public/buildgen.js holds these conditions (CONDITION_UPTIME there). The generator converts damage whatever
# a conversion's condition, so a buff's conversion is written already scaled by how often the buff is up.
CONDITION_SHARE = {None: 1.0, "recentCrit": 0.95, "recentBlock": 0.2, "recentKill": 0.7, "flask": 0.8, "other": 0.5,
                   "minionUnholyMightOnHit": 0.85, "noEnergyShieldPool": 1.0}


def withered_held(chance_percent, hits_per_second=MINION_HITS_PER_SECOND):
    """How many Withered debuffs an enemy carries when every hit has this chance to inflict one."""
    return min(WITHERED_MAXIMUM, hits_per_second * chance_percent / 100 * WITHERED_SECONDS)


def chance_uptime(chance_percent, seconds, events_per_second):
    """How much of the time a buff gained "for N seconds" at a chance on each event is up: the share of N-second
    windows with at least one success."""
    return 1 - (1 - chance_percent / 100) ** (seconds * events_per_second)


# A statement's value as a multiple of its number ("1.2*#"): the more chaos damage each 1% chance to wither is worth
# to minions, linear below the 15-debuff cap (up to a 75% chance at 10 hits a second).
MINION_WITHER_PER_CHANCE_POINT = str(WITHERED_INCREASED_TAKEN * MINION_HITS_PER_SECOND * WITHERED_SECONDS / 100) + "*#"


def wither_more(chance_percent, subject="minion", tags=None, condition=None, share=1.0):
    """A chance to wither on hit as what it is worth: the increased chaos damage taken of the debuffs held, counted as
    more chaos damage (it is the enemy's multiplier, apart from the attacker's own increases). share: how much of the
    time the chance is there (a buff that comes and goes)."""
    hits = MINION_HITS_PER_SECOND if subject == "minion" else SELF_HITS_PER_SECOND
    value = round(WITHERED_INCREASED_TAKEN * withered_held(chance_percent, hits) * share, 1)
    return more("damage", ["chaos"] + (tags or []), value=value, condition=condition, subject=subject)


# The two buffs, as the 3.24 patch notes and the tree's reminder text word them. They are different buffs:
#   Unholy Might: "100% of Physical Damage converted to Chaos Damage and 25% chance to apply Withered on Hit".
#   Chaotic Might: "30% of Physical Damage as extra Chaos Damage" (Unholy Might's old effect, which 3.24 gave this
#   new buff; until 2026-11-22 we read Unholy Might as it).
# subject: who has the buff; condition: when it can be up (the line's event, as a condition of the generator's);
# share: how much of that time it is up, for buffs gained at a chance (chance_uptime); tags=["spell"] limits a minion
# buff to minions that hit with spells (Command of the Pit).
UNHOLY_MIGHT_WITHER_CHANCE = 25
CHAOTIC_MIGHT_EXTRA = 30


def might_buff(buff, subject="self", condition=None, share=1.0, tags=None):
    tags = tags or []
    if buff == "Unholy Might":
        converted = round(100 * share * CONDITION_SHARE[condition], 1)
        conversion = {"kind": "conversion", "stat": "damage", "tags": ["chaos"] + tags, "value": converted,
                      "subject": subject, "condition": None, "from": ["physical"]}
        return [conversion, wither_more(UNHOLY_MIGHT_WITHER_CHANCE, subject, tags, condition, share)]
    if buff == "Chaotic Might":
        return [{"kind": "extra", "stat": "damage", "tags": ["chaos"] + tags, "value": round(CHAOTIC_MIGHT_EXTRA * share, 1),
                 "subject": subject, "condition": condition, "from": ["physical"]}]
    raise ValueError("not a Might buff: " + buff)


STATEMENTS = [
    # ---------- defensive self buffs (not auras, not guard skills) ----------
    # Arctic Armour: less physical and fire damage from hits while stationary. The buff lasts 2.5-4.4 seconds after you
    # move, so it holds more often than "stationary" alone (condition "stationaryLingering").
    (r"^Buff grants " + NUMBER + r"% less Physical Damage taken from Hits while stationary$",
     [more("damageTaken", ["physical"], value="-#", condition="stationaryLingering")]),
    (r"^Buff grants " + NUMBER + r"% less Fire Damage taken from Hits while stationary$",
     [more("damageTaken", ["fire"], value="-#", condition="stationaryLingering")]),
    # Frost Shield: a shield with up to 4 stages of 910 life at gem level 20 takes a share of each hit before your life
    # or energy shield; it gains stages only while you lose energy shield (public/buildgen.js, frostShieldPool).
    (r"^Frost Shield has " + NUMBER + r" maximum Life per Stage$", [flat("frostShieldPool", value="4*#")]),
    (r"^Maximum 4 Stages$", [minor()]),
    (r"of Damage dealt to you or Allies in Area with Hits by Enemies (?:in|outside) Area is taken from Frost Shield", [minor()]),
    (r"^Gains 1 Stage every 0.3 seconds while you are losing Energy Shield$", [minor()]),
    (r"^You lose " + NUMBER + r" Energy Shield per second$", [minor()]),
    # ---------- attributes ----------
    # Two-attribute lines give those two only; they read as "+# to all Attributes" (the gear solver meets attribute
    # requirements, so the third one mattered).
    (r"^\+" + NUMBER + r" to Strength and Dexterity$", [flat("strength"), flat("dexterity")]),
    (r"^\+" + NUMBER + r" to Strength and Intelligence$", [flat("strength"), flat("intelligence")]),
    (r"^\+" + NUMBER + r" to Dexterity and Intelligence$", [flat("dexterity"), flat("intelligence")]),
    # ---------- bloodlines ----------
    # Breachlord: the gem levels need four Foulborn uniques worn and the resistance lines all rings of one base, which
    # the generator doesn't plan, so they get no credit (the gem levels read as a generic condition, half on).
    (r"if at least \d+ Foulborn Unique Items are Equipped$", [minor()]),
    (r"^Your Hits ignore Enemy Monster (?:Lightning|Cold|Fire) Resistances if all Equipped Rings are", [minor()]),
    # Oath of the Maji (Warden of the Maji): each line wants a slot without gems. Builds take it for gloves and boots
    # left empty (life and movement speed), giving up their eight sockets (public/buildgen.js, socketsOf). The body
    # holds the six-link and the helmet a four-link, so those two lines aren't counted.
    (r"^Defences from Equipped Body Armour are doubled if it has no Socketed Gems$", [minor()]),
    (r"^\+50% to all Elemental Resistances if you have an Equipped Helmet with no Socketed Gems$", [minor()]),
    (r"^" + NUMBER + r"% increased Maximum Life if you have Equipped Gloves with no Socketed Gems$",
     [{"kind": "increased", "stat": "life", "tags": [], "value": "#", "subject": "self", "condition": None}, flag("gemlessGloves")]),
    (r"^" + NUMBER + r"% increased Movement Speed if you have Equipped Boots with no Socketed Gems$",
     [{"kind": "increased", "stat": "movementSpeed", "tags": [], "value": "#", "subject": "self", "condition": None}, flag("gemlessBoots")]),
    # ---------- damage from defences ----------
    # Overcapped fire resistance: gear is taken to cap resistances exactly, so the build's own "+% to Fire Resistance"
    # lines are what goes over the cap (public/buildgen.js, overcappedFire).
    (r"^Armour is increased by Overcapped Fire Resistance$", [flag("armourFromOvercappedFire")]),
    (r"^Damage Penetrates Fire Resistance equal to your Overcapped Fire Resistance", [flag("penetrationFromOvercappedFire")]),
    # Tasalio: fire resistance lines also count for cold and lightning at half their value, which frees gear the
    # solver would spend on resistances (public/buildgear.js).
    (r"^Modifiers to Fire Resistance also apply to Cold and Lightning Resistances at 50% of their Value$", [flag("fireResistanceShared")]),
    # "perDefence" lines scale with the build's own life, energy shield, armour or evasion (public/buildgen.js reads
    # them after its defences): "as" is how the line counts ("increased" or "added" damage, or "base" for a skill
    # whose base damage is a share of the pool), "per" how much of the defence one "value" needs.
    # Righteous Fire: its base damage is 70% of maximum life plus 70% of maximum energy shield a second.
    (r"^Deals " + NUMBER + r"% of your Maximum Life as Base Fire Damage per second$",
     [{"kind": "perDefence", "stat": "damage", "as": "base", "defence": "life", "per": 100, "value": "#", "tags": ["fire"], "subject": "self", "condition": None}]),
    (r"^Deals " + NUMBER + r"% of your Maximum Energy Shield as Base Fire Damage per second$",
     [{"kind": "perDefence", "stat": "damage", "as": "base", "defence": "energyShield", "per": 100, "value": "#", "tags": ["fire"], "subject": "self", "condition": None}]),
    # ...and it burns you for 90% of life and 70% of energy shield a second, which fire resistance reduces: why RF
    # builds stack maximum fire resistance and regeneration.
    (r"^You Burn for " + NUMBER + r"% of your Maximum Life per second as Fire Damage$", [flat("selfBurnLife", value="#")]),
    (r"^You Burn for " + NUMBER + r"% of your Maximum Energy Shield per second as Fire Damage$", [flat("selfBurnEnergyShield", value="#")]),
    # Ephemeral Edge: added maximum lightning damage of 10-15% of energy shield, so 0 to 12.5% of it, about 6.25 per
    # 100 energy shield on average.
    (r"^Attacks with this Weapon have Added Maximum Lightning Damage equal to " + NUMBER + r"% of Player's Maximum Energy Shield$",
     [{"kind": "perDefence", "stat": "damage", "as": "added", "defence": "energyShield", "per": 100, "value": 6.25, "tags": ["lightning", "attack"], "subject": "self", "condition": None}]),
    # Dreamfeather and Replica Dreamfeather: attack damage per 450 evasion or armour. It read as 3 stacks.
    (r"^1% increased Attack Damage per 450 Evasion Rating$",
     [{"kind": "perDefence", "stat": "damage", "as": "increased", "defence": "evasion", "per": 450, "value": 1, "tags": ["attack"], "subject": "self", "condition": None}]),
    (r"^1% increased Attack Damage per 450 Armour$",
     [{"kind": "perDefence", "stat": "damage", "as": "increased", "defence": "armour", "per": 450, "value": 1, "tags": ["attack"], "subject": "self", "condition": None}]),
    # Explosions on kill clear packs; they were a flat 4% more damage. Hinekora's (10% of kills for 250% of their life)
    # is the Chieftain's.
    (r"^Enemies you or your Totems Kill have " + NUMBER + r"% chance to Explode", [flag("explodeOnKill")]),
    # Ramako: -20% fire resistance against damage over time near you while stationary, so fire damage over time gains
    # as if it penetrated; it was 10% more fire damage of any kind.
    (r"^Nearby Enemy Monsters' Fire Resistance against Damage over Time is " + NUMBER + r"% while you are Stationary$",
     [{"kind": "resistance", "stat": "resistance", "tags": ["fire", "dot"], "value": "#", "subject": "enemy", "condition": "stationary"}]),
    # Righteous Fire's buff: more spell damage while it burns, its own burning included.
    (r"^Grants " + NUMBER + r"% more Spell Damage$", [more("damage", ["spell"])]),
    # ---------- keystones that change how damage works ----------
    (r"^Your Critical Strike Chance is Lucky$", [more("critChance", value=40)]),  # lucky crit at ~40-60% chance
    (r"^Your Damage with Critical Strikes is Lucky$", [more("damage", value=10, condition="onCrit")]),
    (r"^Damage with Hits is Unlucky$", [more("damage", value=-15)]),
    (r"^Skills that have dealt a Critical Strike in the past 8 seconds deal " + NUMBER + r"% more Elemental Damage",
     [more("damage", ["elemental"], condition="recentCrit"), flag("elementalOverload")]),
    (r"^Non-Critical Strikes Penetrate " + NUMBER + r"% of Enemy Elemental Resistances",
     [{"kind": "penetration", "stat": "resistance", "tags": ["elemental"], "value": "#", "subject": "self", "condition": "nonCrit"}]),
    (r"^Critical Strikes ignore Enemy Monster Elemental Resistances$",
     [{"kind": "penetration", "stat": "resistance", "tags": ["elemental"], "value": 40, "subject": "self", "condition": "onCrit"}]),
    (r"^Non-Critical Strikes cannot inflict Ailments$", [flag("critOnlyAilments")]),
    (r"^Damage over Time Multiplier for Ailments is equal to Critical Strike Multiplier$", [flag("perfectAgony")]),
    # Iron Will: worth about a sixth more spell damage at the strength a spell build reaches without trying.
    (r"^Strength's Damage bonus applies to all Spell Damage as well$", [more("damage", ["spell"], value=15), flag("needsStrength")]),
    (r"^Strength's Damage bonus applies to Projectile Attack Damage as well as Melee Damage$",
     [more("damage", ["projectile", "attack"], value=25), flag("needsStrength")]),
    (r"^Base Critical Strike Chance for Attacks with Weapons is " + NUMBER + r"%$", [flat("baseCritAttacks", ["attack"])]),
    (r"^Base Spell Critical Strike Chance of Spells is equal to that of Main Hand Weapon$", [flag("spellCritFromWeapon")]),
    (r"^Spell Critical Strike Chance Bifurcates$", [more("critChance", ["spell"], value=30)]),
    (r"^Battlemage$", [flag("battlemage")]),
    (r"^Cannot deal non-(Fire|Cold|Lightning) Damage$", [flag("pureElement")]),
    (r"^You can't deal Damage with Skills yourself$", [flag("noSelfDamage")]),
    (r"^Hits always Ignite$", [flat("ailmentChance", ["ignite"], value=100), more("damage", ["ignite"], value=10)]),
    (r"^Hits always Shock$", [flat("ailmentChance", ["shock"], value=100), more("damage", [], value=15)]),
    (r"^Your Hits always inflict Freeze, Shock and Ignite while Unbound$", [more("damage", [], value=15, condition="unbound")]),
    (r"^Shocks from your Hits always increase Damage taken by at least " + NUMBER + r"%$", [more("damage", condition="enemyShocked")]),
    (r"^Exposure you inflict applies an extra " + NUMBER + r"% to the affected Resistance$",
     [{"kind": "exposure", "stat": "resistance", "tags": ["elemental"], "value": "#", "subject": "enemy", "condition": "exposure"}]),
    (r"^Hits have " + NUMBER + r"% chance to deal 50% more Area Damage$", [more("damage", ["area"], value=12)]),
    (r"^Kill Enemies that have 20% or lower Life when Hit by your Skills$", [more("damage", value=25)]),
    (r"^Culling Strike$", [more("damage", value=10)]),
    (r"^Critical Strikes have Culling Strike$", [more("damage", value=8, condition="onCrit")]),
    (r"^Deal 1% more Damage with Hits and Ailments to Rare and Unique Enemies for each second", [more("damage", value=60, condition="rareOrUnique")]),
    (r"^Deal 1% more Damage with Hits and Ailments to Rare and Unique Enemies for every 2 seconds", [more("damage", value=30, condition="rareOrUnique")]),
    (r"^Deal up to " + NUMBER + r"% more Melee Damage to Enemies, based on proximity$", [more("damage", ["melee"], value=10)]),
    (r"^Projectiles gain Damage as they travel farther", [more("damage", ["projectile"], value=20)]),
    (r"^Projectile Attack Hits deal up to " + NUMBER + r"% more Damage to targets at the start", [more("damage", ["projectile", "attack"], value=10)]),
    (r"^Projectiles that have Chained gain " + NUMBER + r"% of Non-Chaos Damage as extra Chaos Damage$",
     [{"kind": "extra", "stat": "damage", "tags": ["chaos"], "value": "#", "subject": "self", "condition": "chained", "from": ["nonChaos"]}]),
    (r"^Poison you inflict with Critical Strikes deals " + NUMBER + r"% more Damage$", [more("damage", ["poison"], condition="onCrit")]),
    (r"^Poisons you inflict during any Flask Effect have 20% chance to deal 100% more Damage$", [more("damage", ["poison"], value=20, condition="flask")]),
    (r"^You can inflict an additional Ignite on each Enemy$", [more("damage", ["ignite"], value=40)]),
    # Crimson Dance: the engine counts the bleeds a build's hit rate keeps up (offenceOf in public/buildgen.js), so the
    # line is only a flag; the keystone's "50% less Damage with Bleeding" is read as written.
    (r"^You can inflict Bleeding on an Enemy up to 8 times$", [flag("crimsonDance")]),
    # Aggravated bleeding deals damage as though the enemy were moving; Crimson Dance's bleeding cannot be Aggravated,
    # so the line holds only without it (the "aggravatedBleed" condition).
    (r"^Bleeding you inflict is Aggravated$", [more("damage", ["bleed"], value=50, condition="aggravatedBleed")]),
    (r"^Your Bleeding does not deal extra Damage while the Enemy is moving", [flag("crimsonDance")]),
    (r"^You can apply up to 50 Shocks to each Enemy$", [more("damage", [], value=20, condition="enemyShocked")]),
    (r"^Skills Chain \+" + NUMBER + r" times$", [flat("chains", ["projectile"])]),
    (r"^Projectiles Pierce " + NUMBER + r" additional Targets$", [flat("pierce", ["projectile"])]),
    (r"^Projectiles cannot Pierce, Fork or Chain$", [flag("noChain")]),
    (r"^Projectiles have 50% chance to Return to you$", [more("damage", ["projectile"], value=15)]),
    (r"^Projectiles have " + NUMBER + r"% increased Critical Strike Chance against Targets they Pierce$",
     [{"kind": "increased", "stat": "critChance", "tags": ["projectile"], "value": "#", "subject": "self", "condition": "pierced"}]),
    (r"^Projectiles have " + NUMBER + r"% chance to be able to Chain when colliding with terrain$", [minor()]),
    (r"^Projectile Barrages have no spread$", [more("damage", ["projectile"], value=20)]),
    (r"^Projectiles are fired in random directions$", [more("damage", ["projectile"], value=-20)]),
    # Crave the Slaughter. Rage itself is modelled by the engine (public/buildgen.js, rageOf): this line makes each Rage
    # also give attack speed, so it scales with Rage effect like the damage. The small passive before it gains 1 Rage
    # on Attack Hit (3.2x patch notes: "The small Passive prior now causes you to Gain 1 Rage on Attack Hit"), and the
    # generator only picks notables, so the notable carries that Rage source too.
    (r"^Every Rage also grants 1% increased Attack Speed$", [flag("rageGrantsAttackSpeed"), flag("rageSource", ["attack"])]),
    # Rage sources: a build with one hits often enough to keep its Rage up (public/buildgen.js, RAGE_ASSUMED).
    (r"^Gain " + NUMBER + r" Rage on (?:Attack )?Hit$", [flag("rageSource", ["attack"])]),
    (r"^Gain " + NUMBER + r" Rage on Melee (?:Weapon )?Hit$", [flag("rageSource", ["melee"])]),
    (r"^Gain " + NUMBER + r" Rage on Hit with Axes or Swords$", [flag("rageSource", ["attack"])]),
    (r"^Gain " + NUMBER + r" Rage on Hit with Axes$", [flag("rageSource", ["axe"])]),
    (r"^Gain " + NUMBER + r" Rage when Hit by an Enemy$", [flag("rageSource")]),
    (r"^Gain Accuracy Rating equal to twice your Strength$", [flat("accuracy", value=400)]),
    # Dual wielding's inherent bonuses are +20% chance to block attack damage and 10% more attack speed (3.25 patch
    # notes; public/buildgen.js gives them to every dual wielder), so doubled is another +20% block and 10% more speed.
    # It was the speed alone.
    (r"^Inherent Bonuses from Dual Wielding are doubled$", [flat("block", value=20, condition="dualWield"),
                                                            more("speed", ["attack"], value=10, condition="dualWield"), flag("needsDualWield")]),
    (r"^You count as Dual Wielding while you are Unencumbered$", [flag("unencumberedDualWield")]),
    (r"^Adds " + NUMBER + r" to \d+ Attack Physical Damage to Melee Skills per \d+ Dexterity while you are Unencumbered$",
     [{"kind": "added", "stat": "damage", "tags": ["physical", "melee", "attack"], "value": 80, "subject": "self", "condition": "unencumbered"}]),
    (r"^Gain Spirit Infusion every 0.5 seconds while Channelling a Spell$", [more("damage", ["spell", "channel"], value=20)]),
    (r"^Gain (?:Chilling|Shocking|Igniting|Chilling, Shocking and Igniting) Conflux", [more("damage", ["elemental"], value=10)]),
    (r"^Gain Convergence when you Hit a Unique Enemy", [more("damage", ["elemental"], value=10, condition="rareOrUnique")]),
    (r"^Gain Arcane Surge when you or your Totems Hit an Enemy with a Spell$", [more("damage", ["spell"], value=10), more("castSpeed", ["spell"], value=10)]),
    (r"^Gain a Power Charge after Spending a total of 200 Mana$", [flag("powerChargeGenerator")]),
    (r"^Gain a Frenzy Charge (?:each second|every 3 seconds) while Moving$", [flag("frenzyChargeGenerator")]),
    (r"^Gain 1 Endurance Charge every second if you've been Hit Recently$", [flag("enduranceChargeGenerator")]),
    (r"^Gain 1 Fanatic Charge every second if you've Attacked in the past second$", [more("damage", ["attack"], value=15)]),
    (r"^\+" + NUMBER + r" to Maximum Fanatic Charges$", [minor()]),
    (r"^Gain Fanaticism for 5 seconds on reaching Maximum Fanatic Charges$", [more("castSpeed", ["spell"], value=20)]),
    (r"^Gain 1 Gale Force when you use a Skill$", [minor()]),
    (r"^Gain 1 Unbound Fury when you inflict an Elemental Ailment", [flag("unboundAvatar")]),
    (r"^Auras from your Skills grant " + NUMBER + r"% increased Attack and Cast", [{"kind": "increased", "stat": "speed", "tags": [], "value": 6, "subject": "self", "condition": "perAura"}]),
    (r"^Warcries Exert twice as many Attacks$", [more("damage", ["attack", "melee"], value=15, condition="warcry")]),
    (r"^Warcries have infinite Power$", [more("damage", ["attack"], value=10, condition="warcry")]),
    (r"^Using Warcries is Instant$", [minor()]),
    (r"^Warcries have no Cost$", [minor()]),
    (r"^Warcry Skills' Cooldown Time is 4 seconds$", [minor()]),
    (r"^Melee Hits have " + NUMBER + r"% chance to Fortify$", [flat("damageTakenLess", value=8)]),
    (r"^You have your maximum Fortification$", [flat("damageTakenLess", value=10)]),
    (r"^Your Hexes have infinite Duration$", [flag("permanentCurses")]),
    (r"^Your Hexes can affect Hexproof Enemies$", [more("damage", value=5, condition="curse")]),
    (r"^You can have an additional Brand Attached to an Enemy$", [more("damage", ["brand"], value=40)]),
    # 3.30.0.4's tree export gives the range: "your Traps within 2 metres also Trigger".
    (r"^When your Traps Trigger, your (?:nearby Traps|Traps within [\d.]+ metres) also Trigger$", [more("damage", ["trap"], value=10)]),
    (r"^Mines Hinder Enemies near them", [minor()]),
    # Impale is modelled by the engine (public/buildgen.js, impaleFactor): these lines are inputs to it, the hits an
    # Impale lasts and the Impales each impaling hit inflicts. They were a flat "more damage" for every physical
    # attack, impale or not. Lines that hold "when you impale" take the build's chance to impale (condition "impale").
    (r"^Impales you inflict last " + NUMBER + r" additional Hits?$", [flat("impaleHits", value="#")]),
    (r"^Inflict " + NUMBER + r" additional Impales? on Enemies you Impale$", [flat("impaleExtra", value="#")]),
    # Master of Metal: armour while impaling, and added damage per Impale on the enemy. Five Impales are on an enemy
    # you keep impaling, so 6 to 12 per Impale is about 45 in all.
    (r"^If you've Impaled an Enemy Recently, you\s+and nearby Allies have \+" + NUMBER + r" to Armour$",
     [flat("armour", value="#", condition="impale")]),
    (r"^You and nearby Allies deal \d+ to \d+ added Physical Damage for\s+each Impale on Enemy$",
     [{"kind": "added", "stat": "damage", "tags": ["physical"], "value": 45, "subject": "self", "condition": "impale"}]),
    # Unstoppable Hero: only Fortification above the usual 20 counts, which needs gear or passives that raise the
    # maximum. The generator doesn't plan those, so the lines get no credit; they read as 3 stacks before.
    (r"^" + NUMBER + r"% more Armour and Evasion Rating per Fortification above 20$",
     [more("armour", value="#", condition="fortificationAbove20"), more("evasion", value="#", condition="fortificationAbove20")]),
    (r"^" + NUMBER + r"% increased Attack Speed per Fortification above 20$",
     [{"kind": "increased", "stat": "attackSpeed", "tags": ["attack"], "value": "#", "subject": "self", "condition": "fortificationAbove20"}]),
    (r"^When your Hits Impale Enemies, also Impale other Enemies near them$", [minor()]),
    (r"^Hits that would Ignite instead Scorch$", [flag("noIgniteDamage")]),
    (r"^You can inflict an additional Scorch on each Enemy$", [minor()]),
    # Elemental Equilibrium: the -25% exposure lands on the elements a hit didn't deal, and the hit removes exposure to
    # those it did. A build of one element gains nothing (it may lose its own exposure); one that hits with a second
    # element first gains. The engine has no "several elements" condition, so the 10% is under "other". It was
    # unconditional, and once Skin of the Lords came in one version per keystone, the Elemental Equilibrium version
    # went on pure lightning builds (2026-11-23).
    (r"^Hits that deal Elemental Damage remove Exposure to those Elements", [more("damage", ["elemental"], value=10, condition="other")]),
    (r"^Critical Strikes inflict Scorch, Brittle and Sapped$", [more("damage", ["elemental"], value=8, condition="onCrit")]),
    (r"^Enemies Chilled by your Hits have Cold Damage taken increased by Chill Effect$", [more("damage", ["cold"], value=15)]),
    (r"^Enemies in your Chilling Areas have Cold Damage taken increased by Chill Effect$", [more("damage", ["cold"], value=15)]),
    (r"^Enemies Ignited by you have 40% of Physical Damage they deal converted to Fire$", [minor()]),
    (r"^Nearby Enemies Convert 25% of their Physical Damage to Fire$", [minor()]),
    (r"^Every second, inflict Withered on nearby Enemies for 15 seconds$", [more("damage", ["chaos"], value=30)]),
    (r"^Cover Enemies in (?:Ash|Frost)", [more("damage", [], value=5)]),
    (r"^Your Chills can reduce Action Speed by up to a maximum of 40%$", [minor()]),
    (r"^Chills from your Hits always reduce Action Speed by at least 10%$", [minor()]),
    (r"^Enemies you Freeze remain Frozen for at least 2 seconds$", [minor()]),
    (r"^Hits that fail to Freeze due to insufficient Freeze Duration inflict Hoarfrost$", [more("damage", ["cold"], value=10)]),
    (r"^With at least one nearby corpse, you and nearby Allies deal " + NUMBER + r"% more Damage$", [more("damage", condition="corpse")]),
    # ---------- Unholy Might and Chaotic Might (might_buff above) ----------
    # Unnatural Strength: every minion has Unholy Might all the time. The flag tells the generator the buff is always
    # there, so a chance to gain it (Command of the Pit) adds nothing.
    (r"^Minions have Unholy Might$", might_buff("Unholy Might", "minion") + [flag("minionsHaveUnholyMight", subject="minion")]),
    # Command of the Pit: each minion gains Unholy Might for 4 seconds with a 25% chance on each of its spell hits.
    # The buff is the minion's own, not shared: every newly summoned minion starts without it and has to hit to roll
    # it (condition "minionUnholyMightOnHit"). The Ghastly Eye goes in one of the gloves' two abyssal sockets, which
    # nothing else uses, so that requirement always holds.
    (r"^With a Ghastly Eye Jewel Socketed, Minions have 25% chance to gain Unholy Might on Hit with Spells$",
     might_buff("Unholy Might", "minion", "minionUnholyMightOnHit", tags=["spell"])),
    # A tree mastery: minions roll it on their own kills.
    (r"^Minions have 25% chance to gain Unholy Might for 4 seconds on Kill$",
     might_buff("Unholy Might", "minion", "recentKill", share=chance_uptime(25, 4, KILLS_PER_SECOND_WHILE_KILLING))),
    # Death's Hand: every crit refreshes it, so a crit build has it whenever it has crit recently.
    (r"^Gain Unholy Might for 4 seconds on Critical Strike$", might_buff("Unholy Might", condition="recentCrit")),
    # Overwhelming Malice (cluster notable): a 10% chance on each of about 2 crits a second keeps it up 57% of the time.
    (r"^10% chance to gain Unholy Might for 4 seconds on Critical Strike$",
     might_buff("Unholy Might", condition="recentCrit", share=chance_uptime(10, 4, CRITS_PER_SECOND))),
    # Malicious Intent: melee kills only, so only melee builds.
    (r"^5% chance to Gain Unholy Might for 4 seconds on Melee Kill$",
     [dict(found, requires=["melee"]) for found in
      might_buff("Unholy Might", condition="recentKill", share=chance_uptime(5, 4, KILLS_PER_SECOND_WHILE_KILLING))]),
    # Shadows and Dust: Rampage counts a kill streak, and we take an "on Rampage" effect to come about every 20 kills
    # (our assumption, unchecked): at 2 kills a second, 3 seconds of every 10.
    (r"^Gain Unholy Might for 3 seconds on Rampage$",
     might_buff("Unholy Might", condition="recentKill", share=3 / (20 / KILLS_PER_SECOND_WHILE_KILLING))),
    # A tree mastery: up for 3 seconds after each block.
    (r"^Gain Unholy Might on Block for 3 seconds$", might_buff("Unholy Might", condition="recentBlock")),
    # Broken Faith: holds for a build with no energy shield (condition "noEnergyShieldPool", the build's own pool).
    # Its conversion can't wait for the pool (the generator converts whatever the condition), so it is counted whole:
    # the shield is worn by life builds.
    (r"^You have Unholy Might while you have no Energy Shield$",
     might_buff("Unholy Might")[:1] + might_buff("Unholy Might", condition="noEnergyShieldPool")[1:]),
    # Sin's Rebirth: while its flask is up.
    (r"^Unholy Might during Effect$", might_buff("Unholy Might", condition="flask")),
    # The Iron Mass: its wielder has Unholy Might (3.24 took its own wither line away "as this is provided by the
    # Unholy Might Buff"); the item's only bare "Unholy Might" line.
    (r"^Unholy Might$", might_buff("Unholy Might")),
    # Extractor Mentis: a 10% chance on each of about 2 kills a second, for 10 seconds, holds 88% of the time.
    (r"^10% chance to gain Chaotic Might for 10 seconds on Kill$",
     might_buff("Chaotic Might", condition="recentKill", share=chance_uptime(10, 10, KILLS_PER_SECOND_WHILE_KILLING))),
    # Extractor Mentis again: Chaotic Might for enemies makes them stronger, which the generator doesn't score.
    (r"^5% chance to grant Chaotic Might to nearby Enemies on Kill$", [minor()]),
    # Bitter Heresy (Lycia bloodline): while you stand in your own Profane Ground, which needs a way to make
    # Consecrated Ground; you and your minions both have it, half the time by our estimate. Without such a way it
    # gives nothing (condition ownConsecratedGround); it was counted for every build and sat in 26% of them.
    (r"^Profane Ground you create also affects you and your Allies, granting Chaotic Might$",
     might_buff("Chaotic Might", condition="ownConsecratedGround")
     + might_buff("Chaotic Might", "minion", condition="ownConsecratedGround")),
    # Ghastly Gaze of the Lich (Abyssal bloodline): only "While you have at least 3 Ghastly Eye Jewels socketed", which
    # the generator doesn't plan (it places no abyss jewels). Its penetration line was read as always on.
    (r"^Unholy Might you grant also ", [minor()]),
    # Severed in Sleep and the like: the debuffs held at the army's hit rate (withered_held), which is linear in the
    # chance below the 15-debuff cap (up to a 75% chance at 10 hits a second).
    (r"^Minions have " + NUMBER + r"% chance to inflict Withered on Hit$",
     [more("damage", ["chaos"], value=MINION_WITHER_PER_CHANCE_POINT, subject="minion")]),
    (r"^Each Summoned Phantasm grants you Phantasmal Might$", [more("damage", value=10, condition="phantasm")]),
    (r"^Summoned Golems are", [minor()]),
    (r"^Link Skills have infinite Attachment Duration$", [minor()]),
    (r"^Your Mark Transfers", [minor()]),
    (r"^Mark Skills Cost no Mana$", [minor()]),
    (r"^Strike Skills also target the previous location they were used$", [more("damage", ["strike"], value=30)]),
    (r"^Inflict Hallowing Flame on Melee Hit$", [more("damage", ["melee", "fire"], value=15)]),
    (r"^You can inflict \+1 Hallowing Flame on Enemies$", [more("damage", ["fire"], value=10)]),
    (r"^Skills from Equipped Body Armour are Supported by Level \d+ (.+)$",
     [{"kind": "socketedSupport", "stat": "#name", "tags": [], "value": 20, "subject": "self", "condition": None}]),
    (r"^Triggers Level 20 (Primal Aegis|Summon Triggerbots) when Allocated$", [flag("ascendancyGrant")]),
    (r"^Transfiguration of Mind$", [flag("transfigurationOfMind")]),
    (r"^Transfiguration of Body$", [flag("transfigurationOfBody")]),
    # Petrified Blood (its gem text): life sits at low life, and the lower half of it loses less to hits at once. The
    # amounts are the level 20 ones, in PETRIFIED_* in public/buildgen.js; the life cost line changes nothing we score.
    (r"^Life Recovery other than Flasks cannot Recover Life to above Low Life$", [flag("lifeCappedAtLowLife")]),
    (r"^When taking Damage from Hits, " + NUMBER + r"% of Life loss below half Life is Prevented", [flag("lowerHalfLifeProtected")]),
    (r"^Skills gain a Base Life Cost equal to " + NUMBER + r"% of Base Mana Cost while not on Low Life$", [minor()]),

    # ---------- keystones and ascendancies that change defences ----------
    (r"^Removes all mana", [flag("bloodMagic")]),
    (r"^Skills (?:Cost|Reserve) Life instead of Mana$", [flag("bloodMagic")]),
    (r"^Spend Energy Shield before Mana for Skill Mana Costs$", [flag("eldritchBattery")]),
    (r"^Energy Shield protects Mana instead of Life$", [flag("eldritchBattery")]),
    # Corrupted Soul: half of non-chaos damage goes past energy shield. It was a flag nothing read, so the keystone's
    # 15% of life as energy shield came with no downside (37% of builds, 2026-11-25); the engine now limits the pool.
    (r"^" + NUMBER + r"% of Non-Chaos Damage taken bypasses Energy Shield$", [flat("nonChaosEsBypass")]),
    (r"^All Damage taken bypasses Energy Shield$", [flag("esBypass")]),
    (r"^Cannot Recharge or Regenerate Energy Shield$", [flag("noEsRecharge")]),
    (r"^Life Regeneration is applied to Energy Shield instead$", [flag("zealotsOath")]),
    (r"^Energy Shield Recharge instead applies to Life$", [flag("painAttunementEs")]),
    (r"^Leech Energy Shield instead of Life$", [flag("ghostReaver")]),
    (r"^Life Leech effects Recover Energy Shield instead while on Full Life$", [flag("ghostReaver")]),
    (r"^Cannot Recover Life other than from Leech$", [flag("vaalPact")]),
    (r"^Life Recovery from Non-Instant Leech is not applied$", [flag("vaalPact")]),
    (r"^Life Leech effects are not removed when Unreserved Life is Filled$", [flag("vaalPact")]),
    (r"^Maximum total Energy Shield Recovery per second from Leech is doubled$", [minor()]),
    (r"^Energy Shield Leech effects are not removed", [flag("ghostReaver")]),
    (r"^Mana Recovery from Regeneration is not applied$", [flag("noManaRegen")]),
    (r"^Converts all Evasion Rating to Armour", [flag("ironReflexes")]),
    (r"^Dexterity provides no inherent bonus to Evasion Rating$", [flag("ironReflexes")]),
    (r"^Intelligence provides no inherent bonus to Energy Shield$", [minor()]),
    (r"^Gain no inherent bonuses from Attributes$", [flag("gloriousVanity")]),
    (r"^Armour applies to Fire, Cold and Lightning Damage taken from Hits instead of Physical Damage$", [flag("hollowPalm")]),
    (r"^Physical Damage Reduction from Hits is based off of 200% of your Ward", [flag("wardArmour")]),
    (r"^Chance to Evade Hits is based off of " + NUMBER + r"% of your Ward", [flag("wardEvasion")]),
    (r"^Ward has a 60% chance to not Break$", [minor()]),
    (r"^While you have Unbroken Ward, your next non-channelling Attack", [more("damage", ["attack", "cold"], value=10)]),
    (r"^Cannot Recover Energy Shield to above (?:Armour|Evasion Rating)$", [flag("esCappedByDefence")]),
    (r"^" + NUMBER + r"% of Maximum Mana is Converted to twice that much Armour$", [flag("manaToArmour")]),
    (r"^Gain " + NUMBER + r"% of Maximum Mana as Extra Maximum Energy Shield$", [flat("manaToEnergyShield")]),
    (r"^Gain Maximum Life instead of Maximum Energy Shield from Equipped Armour Items$", [flag("esToLife")]),
    # Radiant Faith gives 25% / 10% of reserved mana. A Guardian running auras reserves about 1000 mana (its level 92
    # mana, intelligence and some gear: CHARACTER_MANA in public/buildgen.js), so about 250 armour and 100 energy shield. (It was 3000 /
    # 300, which needs 12000 reserved mana and pushed Guardian to the top for most skills.)
    (r"^Grants Armour equal to " + NUMBER + r"% of your Reserved Mana", [flat("armour", value=250)]),
    (r"^Grants maximum Energy Shield equal to " + NUMBER + r"% of your Reserved Mana", [flat("energyShield", value=100)]),
    (r"^Maximum Energy Shield is increased by Chance to Block Spell Damage$", [{"kind": "increased", "stat": "energyShield", "tags": [], "value": 40, "subject": "self", "condition": None}]),
    # Glancing Blows doubles block but blocked hits still deal 65%: worth far less than the doubled numbers.
    (r"^Chance to Block Attack Damage is doubled$", [flat("block", value=6)]),
    (r"^Chance to Block Spell Damage is doubled$", [flat("spellBlock", value=4)]),
    (r"^Gain 50% Chance to Block from Equipped Shield instead of the Shield's value$", [flat("block", value=25), flag("needsShield")]),
    (r"^Chance to Block Attack or Spell Damage is Lucky if you've Blocked Recently$", [flat("block", value=10)]),
    (r"^You take " + NUMBER + r"% of Damage from Blocked Hits$", [minor()]),
    # Unbreakable: the body armour holds about half of a life build's base armour, so doubling it is about 50% more
    # armour (after increases, since it doubles the body's local total). It was 60% increased, which the tree's
    # increases dilute.
    (r"^Armour from Equipped Body Armour is doubled$", [more("armour", value=50)]),
    # Untiring: life back from physical damage armour stopped. Against a boss hitting a 5,000-life armour build for a
    # few thousand physical every two seconds with half of it prevented, 1.5% of ten seconds' prevented damage a
    # second is about 1.5% of life a second.
    (r"^" + NUMBER + r"% of Physical Damage prevented from Hits in the past 10 seconds is Regenerated as Life per second$",
     [flat("lifeRegen", value=1.5)]),
    # Undeniable: 500 flat, twice Strength (about 300) and the level's own accuracy put a Juggernaut near 2,300
    # accuracy, so 1% attack speed per 150 is about 15%.
    (r"^1% increased Attack Speed per 150 Accuracy Rating$",
     [{"kind": "increased", "stat": "attackSpeed", "tags": ["attack"], "value": 15, "subject": "self", "condition": None}]),
    (r"^Take " + NUMBER + r"% less damage from Critical Strikes$", [minor()]),
    (r"^Take " + NUMBER + r"% more damage from Non-Critical Strikes$", [flat("damageTakenLess", value=-10)]),
    (r"^Take 50% less Damage over Time if you've started taking Damage over Time in the past second$", [minor()]),
    (r"^Take 50% less Damage (?:from Hits|over Time) for 5 seconds$", [flat("damageTakenLess", value=8)]),
    (r"^Damage of Enemies Hitting you is Unlucky$", [flat("damageTakenLess", value=8)]),
    (r"^You take no Extra Damage from Critical Strikes while Elusive$", [minor()]),
    (r"^Elemental Resistances are capped by your highest Maximum Elemental Resistance instead$", [minor()]),
    (r"^Modifiers to (?:Maximum )?Fire Resistance also apply to Cold and Lightning Resistances", [minor()]),
    (r"^Modifiers to Chance to Suppress Spell Damage instead apply to Chance to Dodge Spell Hits", [flag("acrobatics")]),
    (r"^Maximum Chance to Dodge Spell Hits is " + NUMBER + r"%$", [flag("acrobatics")]),
    (r"^Maximum Damage Reduction for any Damage Type is " + NUMBER + r"%$", [minor()]),
    (r"^" + NUMBER + r"% (?:less|reduced) (?:Cold|Lightning|Fire) Resistance$", [minor()]),
    (r"^Unaffected by (?:Damaging Ailments|Ignite)$", [minor()]),
    (r"^Immune to Ignite and Shock$", [minor()]),
    (r"^Cannot take Reflected", [minor()]),
    (r"^Damage cannot be Reflected$", [minor()]),
    (r"^Cannot be (?:Blinded|Knocked Back)$", [minor()]),
    (r"^You are Blind$", [minor()]),
    (r"^You are Unaffected by Bleeding while Leeching$", [minor()]),
    (r"^Every 4 seconds, remove Curses and Ailments from you$", [minor()]),
    # "Every 4 seconds, Regenerate X% of Life over one second" is read by mechanics_vocabulary.py's special shapes as its
    # average over a fight (X / 4 a second); it was a flat 8% a second here, without a reason.
    (r"^While not on Full Life, Sacrifice " + NUMBER + r"% of Mana per Second to Recover that much Life$", [flag("manaToLifeRecovery")]),
    (r"^Life Recoup also recovers Mana$", [minor()]),
    (r"^Life Recovery from Flasks also applies to Energy Shield$", [minor()]),
    (r"^Lose " + NUMBER + r"% of Energy Shield per second$", [minor()]),
    (r"^Energy Shield starts at zero$", [minor()]),
    (r"^Every second, Consume a nearby Corpse to Recover", [minor()]),
    (r"^Gain Adrenaline for 20 seconds when you reach Low Life$", [minor()]),
    (r"^Remove all Ailments and Burning when you gain Adrenaline$", [minor()]),
    (r"^Gain Elusive on Critical Strike$", [flat("damageTakenLess", value=8, condition="onCrit")]),
    (r"^Gain " + NUMBER + r"% of Missing Unreserved Life before being Hit by an Enemy Per Defiance$", [minor()]),
    (r"^Lose all Defiance when you reach 10 Defiance$", [minor()]),
    (r"^Gain Defiance for 10 seconds on losing Life", [minor()]),
    (r"^Evasion Rating is Doubled against Projectile Attacks$", [minor()]),
    (r"^" + NUMBER + r"% more chance to Evade Attacks if you have been Hit by an Attack Recently$", [minor()]),
    (r"^Every \d+ seconds, gain a Ghost Shroud", [minor()]),
    (r"^When Hit, lose a Ghost Shroud", [minor()]),
    (r"^" + NUMBER + r"% chance for Energy Shield Recharge to start when you (?:Block|Suppress Spell Damage)$", [minor()]),
    (r"^Prevent \+?" + NUMBER + r"% of Suppressed Spell Damage", [flat("suppressPrevent")]),
    (r"^You have Impenetrable Shrine Buff while affected by no Flasks$", [flat("armour", value=3000)]),
    (r"^Nearby Allies count as having Fortification equal to yours$", [minor()]),
    (r"^Nearby Enemies are Blinded$", [flat("damageTakenLess", value=5)]),
    (r"^Blind Enemies on Hit$", [flat("damageTakenLess", value=4)]),
    (r"^Taunt on Hit$", [minor()]),
    (r"^Enemies Taunted by you cannot Evade Attacks$", [minor()]),
    (r"^Your Hits permanently Intimidate Enemies that are on Full Life$", [more("damage", ["attack"], value=5)]),
    (r"^Nearby Enemy Monsters' Action Speed is at most 90% of base value$", [minor()]),
    (r"^(?:Action|Movement) Speed cannot be modified to below Base Value$", [minor()]),
    (r"^Your Action Speed is at least 90% of base value$", [minor()]),
    (r"^Gain a random Shrine buff every 10 seconds$", [more("damage", value=5)]),
    (r"^You and nearby Allies have Tailwind$", [minor()]),
    (r"^Maximum Effect of Shock is 2% increased Damage taken$", [minor()]),

    # ---------- limits and rules on minions, totems, auras, heralds, flasks ----------
    (r"^Maximum number of raised Spectres, Skeletons and Zombies is " + NUMBER + r"$", [flag("necromanticAegisLike")]),
    (r"^All bonuses from an Equipped Shield apply to your Minions instead of you$", [flag("necromanticAegis")]),
    (r"^Minions Explode when reduced to Low Life", [minor()]),
    (r"^Minions take " + NUMBER + r"% less Damage while you have a Zombie$", [minor()]),
    (r"^" + NUMBER + r"% of Damage Dealt by your Minions is Leeched to you as Life$", [minor()]),
    (r"^Auras from your Skills can only affect you$", [flag("auraOnlySelf")]),
    (r"^Your Aura Skills are Disabled$", [flag("noAuras")]),
    (r"^You can only have one Herald$", [flag("oneHerald")]),
    (r"^" + NUMBER + r"% more Effect of Herald Buffs on you$", [more("damage", ["herald"], value=10)]),
    (r"^Herald of Thunder has", [minor()]),
    (r"^Skills Cost \+" + NUMBER + r" Rage$", [minor()]),
    (r"^Regenerate " + NUMBER + r"% of Mana per second (?:for each|if)", [minor()]),
    (r"^Regenerate " + NUMBER + r"% of Energy Shield per second (?:for each|if)", [flat("esRegen", value=1)]),
    (r"^Regenerate " + NUMBER + r"% of Life per second (?:for each|if)", [flat("lifeRegen", value=2)]),
    (r"^Regenerate " + NUMBER + r"% of (?:Life|Mana|Energy Shield) per Second for each", [flat("lifeRegen", value=2)]),
    (r"^You and your Totems Regenerate", [flat("lifeRegen", value=2)]),
    (r"^Regenerate " + NUMBER + r"% of (?:Mana|Energy Shield) over 2 seconds when you Consume a corpse$", [minor()]),
    (r"^For each nearby corpse", [minor()]),
    (r"^Flasks Gain \d+ Charges per empty Flask Slot", [minor()]),
    (r"^Life Flask Effects", [minor()]),
    (r"^" + NUMBER + r"% chance for Flasks you use to not consume Charges$", [minor()]),
    (r"^Gain a Flask Charge when you deal a Critical Strike$", [minor()]),
    (r"^Removes (?:Bleeding|Elemental Ailments) when you use a Flask$", [minor()]),
    (r"^Grant bonuses to Non-Channelling Skills you use by consuming 3 Charges", [more("damage", value=10)]),
    (r"^Gain (?:10% increased Attack Speed|10% increased Movement Speed) for 20 seconds", [minor()]),
    (r"^Ignore Attribute Requirements$", [flag("ignoreAttributes")]),
    (r"^Can't use Helmets$", [flag("noHelmet")]),
    # Dance with Death (Brutal Restraint). Lucky crit damage against you takes the higher of two rolls on every enemy
    # critical strike, and pinnacle bosses crit often: without immunity to extra crit damage one hit can take a full
    # life pool, so it isn't a percentage of damage taken but a condition. The generator refuses the keystone unless
    # the build has noExtraCritDamage (problemsOf in public/buildgen.js).
    (r"^Enemies' Damage with Critical Strikes against you is Lucky$", [flag("critTakenLucky")]),
    # The Brass Dome, Zana's Ingenuity's "100% reduced" roll: enemy crits deal no more than a normal hit, which is what
    # makes critTakenLucky survivable. Partial (Belt of the Deceiver's 30%) and conditional versions (Viridi's Veil's
    # magic ring, Mistwalker while Elusive) are other lines and stay unread.
    (r"^(?:You )?[Tt]ake no Extra Damage from Critical Strikes$", [flag("noExtraCritDamage")]),
    (r"^You take 100% reduced Extra Damage from Critical Strikes$", [flag("noExtraCritDamage")]),
    # Hidden Potential: "for each Magic Item Equipped" counts the character's own worn items, not the tree or jewels,
    # and a magic item has two mods: the builds wear rares and uniques, so it gives nothing. Read as "for each"
    # (a charge or stack, STACKS_ASSUMED) it was free damage on a jewel.
    (r"for each Magic Item Equipped$", [minor()]),
    (r"^Gain Power Charges instead of Frenzy Charges$", [minor()]),
    (r"^Your Maximum Endurance Charges is equal to your Maximum Frenzy Charges$", [minor()]),
    (r"^\+" + NUMBER + r" to Maximum Power Charges and Maximum Endurance Charges$", [more("damage", value=4)]),
    (r"^" + NUMBER + r"% chance that if you would gain Endurance Charges", [minor()]),
    (r"^Share (?:Endurance, Frenzy and Power )?Charges", [minor()]),
    (r"^Nearby Allies and Enemies Share Charges with you$", [minor()]),
    (r"^Brand Recall has", [minor()]),
    (r"^Banner Skills have", [minor()]),
    (r"^Having a placed Banner does not prevent you gaining Valour$", [minor()]),
    (r"^When you leave your Banner's Area", [minor()]),
    (r"^You and Allies near your Banner Regenerate", [minor()]),
    (r"^" + NUMBER + r"% chance for used Retaliation Skills", [minor()]),
    (r"^(?:Damaging )?Retaliation Skills become Usable", [minor()]),
    (r"^Cannot Summon Mirage Archers while near your Mirage Archers$", [minor()]),
    (r"^Mirage Archers are not attached to you$", [minor()]),
    (r"^Other Aegis Skills are Disabled$", [minor()]),
    (r"^Primal Aegis can take", [minor()]),
    (r"^Gain Spirit Infusion", [more("damage", ["spell"], value=15)]),

    # ---------- systems the generator doesn't model (Mercenaries, Tinctures, Barks, Rage details, Offerings) ----------
    (r"[Mm]ercenar", [minor()]),
    (r"Tincture", [minor()]),
    (r"\bBarks?\b", [minor()]),
    (r"Inherent (?:Rage )?Loss", [minor()]),
    (r"^Does not delay Inherent Loss of Rage$", [minor()]),
    (r"^Lose 0.1% of Life per second per Rage", [minor()]),
    (r"Rage Regenerated", [minor()]),
    (r"Increases and reductions to Maximum Life also apply to Maximum Rage", [minor()]),
    (r"^Your Offering", [minor()]),
    (r"Grasping Vines", [minor()]),
    (r"Fungal Ground", [minor()]),
    (r"Consecrated Ground you create", [minor()]),
    (r"^Effects that interact with Mana Burn", [minor()]),
    (r"^For \d+ seconds after you Impale Enemies", [minor()]),
    (r"^Non-Unique Jewels cause", [flag("timelessLikeConversion")]),
    (r"^Cannot gain Unbound Fury while Unbound$", [minor()]),
    (r"^Lose all (?:Gale Force|Fanatic Charges)", [minor()]),
    (r"^Enemies Taunted by your Warcries Explode", [more("damage", value=5)]),
    (r"Explode", [more("damage", value=4)]),
    (r"^Your Warcries do not grant Buffs or Charges to You$", [minor()]),
    (r"^You can hire a Mercenary permanently$", [minor()]),
    (r"^Every \d+ seconds:$", [minor()]),
    (r"^Base Ignite Duration is \d+ second$", [more("damage", ["ignite"], value=0)]),
    (r"^Damage over Time is -20% while you are Stationary$", [minor()]),
    (r"^-" + NUMBER + r" Maximum Life per Level$", [flat("life", value=-600)]),
    (r"^Enemies near corpses you Spawned Recently are Chilled and Shocked$", [more("damage", value=10)]),
    (r"^Nearby (?:Chilled|Hindered) Enemies deal", [flat("damageTakenLess", value=4)]),
    (r"^With at least one nearby corpse, nearby Enemies deal " + NUMBER + r"% reduced Damage$", [flat("damageTakenLess", value=4)]),
    (r"^" + NUMBER + r"% reduced Damage taken from Blinded Enemies$", [flat("damageTakenLess", value=5)]),
    (r"^" + NUMBER + r"% less Damage taken from other Enemies near your Marked Enemy$", [flat("damageTakenLess", value=5)]),
    (r"^Enemies Chilled by your Hits lessen their Damage dealt by half of Chill Effect$", [flat("damageTakenLess", value=5)]),
    (r"^Nearby Enemy Monsters' Fire Resistance", [more("damage", ["fire"], value=10)]),
    (r"^" + NUMBER + r"% of (?:Leech is Instant|Physical Damage prevented)", [minor()]),
    (r"^" + NUMBER + r"% (?:increased|reduced) Maximum Recovery per (?:Life|Energy Shield) Leech$", [minor()]),
    (r"^" + NUMBER + r"% of Attack Damage Leeched as Life and Mana", [flat("leech")]),
    (r"^" + NUMBER + r"% of Damage from Hits is taken from your Sentinel", [flat("damageTakenLess", value=10)]),
    # Anchored: a trailing scope or condition ("with Attacks if Attack Time is longer than 1 second") must not be
    # dropped, so longer lines go to the general reader, which keeps or rejects them.
    (r"^" + NUMBER + r"% chance to deal Double Damage$", [more("damage", value="#")]),

    # ---------- passive tree, masteries and ascendancies (scripts/audit_tree_reading.py, 2026-11-23) ----------
    # Lines the general grammar can't read, from the audit of every tree line. Values are our estimates unless the
    # line gives its own number; each group says why.

    # Exposure and enemy damage taken.
    (r"^Nearby Enemies have Cold Exposure while you are affected by Herald of Ice$",
     [exposure("cold", condition="affectedBy:Herald of Ice")]),
    (r"^Nearby Enemies have Fire Exposure while you are affected by Herald of Ash$",
     [exposure("fire", condition="affectedBy:Herald of Ash")]),
    (r"^Nearby Enemies have Lightning Exposure while you are affected by Herald of Thunder$",
     [exposure("lightning", condition="affectedBy:Herald of Thunder")]),
    (r"^Nearby Enemies have Fire Exposure$", [exposure("fire", condition="nearby")]),
    # Corrosive Elements: a 25% chance on each hit keeps a 4-second exposure up nearly all the time on a boss.
    (r"^Fire Skills have a " + NUMBER + r"% chance to apply Fire Exposure on Hit$", [exposure("fire")]),
    (r"^Cold Skills have a " + NUMBER + r"% chance to apply Cold Exposure on Hit$", [exposure("cold")]),
    (r"^Lightning Skills have a " + NUMBER + r"% chance to apply Lightning Exposure on Hit$", [exposure("lightning")]),
    (r"^Fire Exposure you inflict applies an extra " + NUMBER + r"% to Fire Resistance$",
     [{"kind": "exposure", "stat": "resistance", "tags": ["fire"], "value": "#", "subject": "enemy", "condition": "exposure"}]),
    # A floor on exposure the build already inflicts: only above our 10% base, and only with a source of exposure.
    (r"^Exposure you inflict applies at least " + NUMBER + r"% to the affected Resistance$",
     [{"kind": "exposure", "stat": "resistance", "tags": ["elemental"], "value": -8, "subject": "enemy", "condition": "exposure"}]),
    # Elemental Equilibrium's exposure lands on the elements you didn't hit with, which a build of one element never uses.
    (r"^Exposure inflicted this way applies " + NUMBER + r"% to Resistances$", [minor()]),
    # Exposure while you suppress, or near a linked ally: neither is planned.
    (r"^Inflict Fire, Cold and Lightning Exposure on Enemies when you Suppress their Spell Damage$", [minor()]),
    (r"^Enemies near your Linked targets have Fire, Cold and Lightning Exposure$", [minor()]),
    # Ramako, Sun's Light: -20% fire resistance to damage over time while you stand still (Righteous Fire builds often do).
    (r"^(?:Nearby Enemy Monsters|Enemy Monsters within [\d.]+ metres) have Fire Resistance against Damage over Time is " + NUMBER + r"% while you are Stationary$",
     [{"kind": "resistance", "stat": "resistance", "tags": ["fire", "dot"], "value": "#", "subject": "enemy", "condition": "other"}]),
    # Brands attached to the boss: one or two at a time.
    (r"^Enemies take " + NUMBER + r"% increased Damage for each of your Brands Attached to them$",
     [enemy_takes("1.5*#", requires=["brand"])]),
    # Surveillance: a totem build keeps two totems near the boss.
    (r"^Each Totem applies " + NUMBER + r"% increased Damage taken to (?:nearby Enemies|Enemies near them|Enemies within [\d.]+ metres)$",
     [enemy_takes("2*#", requires=["totem"])]),
    # Mine Mastery: a mine build keeps the five mines the cap needs near the boss.
    (r"^Each Mine applies " + NUMBER + r"% increased Damage taken to (?:nearby Enemies|Enemies near them|Enemies within [\d.]+ metres), up to " + NUMBER + r"%$",
     [enemy_takes("5*#", requires=["mine"])]),
    (r"^Each Mine applies " + NUMBER + r"% reduced Damage dealt to ", [flat("damageTakenLess", value=5, condition="other")]),
    # Marks: the generator plans marks as curses only for some builds; "other" says they may not be there.
    (r"^Marked Enemy takes " + NUMBER + r"% increased Damage$", [enemy_takes("#", condition="other")]),
    (r"^Culling Strike against Marked Enemy$", [more("damage", value=10, condition="other")]),
    (r"^(?:You have )?Culling Strike against Cursed Enemies$", [more("damage", value=10, condition="enemyCursed")]),
    (r"^Hits that Stun Enemies have Culling Strike$", [minor()]),
    # Settling Ash: Covered in Ash makes enemies take 20% increased fire damage; it needs you to stand still.
    (r"^Nearby Enemies are Covered in Ash if you haven't moved in the past 2 seconds$",
     [enemy_takes(20, ["fire"], condition="other")]),

    # Double damage, extra damage, lucky damage.
    (r"^Your Critical Strikes have a " + NUMBER + r"% chance to deal Double Damage$", [more("damage", condition="onCrit")]),
    # A 3% chance to add 300% of physical as one element: 9% of physical damage on average.
    (r"^" + NUMBER + r"% chance for Hits to deal 300% of Physical Damage as Extra Damage of a random Element$",
     [{"kind": "extra", "stat": "damage", "tags": ["elemental"], "value": "3*#", "subject": "self", "condition": None, "from": ["physical"]}]),
    # Lucky damage rolls twice and keeps the higher: on lightning's wide range (about 1 to 20) that is 30% more on average.
    (r"^Lightning Damage with Non-Critical Strikes is Lucky$", [more("damage", ["lightning"], value=30, condition="nonCrit")]),
    # Roiling Tempest: on lightning's range more maximum and less minimum come to about 20% more damage.
    (r"^" + NUMBER + r"% more Maximum Lightning Damage$", [more("damage", ["lightning"], value=20)]),
    (r"^" + NUMBER + r"% less Minimum Lightning Damage$", [minor()]),
    (r"^Ignites from Stunning Melee Hits deal " + NUMBER + r"% more Damage$", [more("damage", ["ignite"], condition="other")]),
    # Traps and mines that go off again deal their damage again.
    (r"^" + NUMBER + r"% Chance for Traps to Trigger an additional time$", [more("damage", ["trap"])]),
    (r"^Mines have a " + NUMBER + r"% chance to be Detonated an Additional Time$", [more("damage", ["mine"])]),
    (r"^Mines can be Detonated an additional time$", [more("damage", ["mine"], value=100)]),
    # Brands: a second brand doubles that brand's damage; the brand limit allows it most of the time.
    (r"^Skills which create Brands have " + NUMBER + r"% chance to create an additional Brand$", [more("damage", ["brand"])]),
    (r"^You can Cast " + NUMBER + r" additional Brands$", [more("damage", ["brand"], value=20)]),
    # Projectiles: damage over distance at a typical distance, half the maximum.
    (r"^Arrows gain Damage as they travel farther, dealing up to " + NUMBER + r"% increased Damage with Hits to targets$",
     [increased("damage", ["bow", "projectile"], value="0.5*#")]),
    (r"^Projectiles gain Damage as they travel farther, dealing up to " + NUMBER + r"% increased Damage with Hits to targets$",
     [increased("damage", ["projectile"], value="0.5*#")]),
    (r"^Projectiles deal " + NUMBER + r"% increased Damage with Hits to targets at the start of their movement, reducing to 0% as they travel farther$",
     [increased("damage", ["projectile"], value="0.3*#")]),
    (r"^Arrows gain Critical Strike Chance as they travel farther, up to " + NUMBER + r"% increased Critical Strike Chance$",
     [increased("critChance", ["bow", "projectile"], value="0.5*#")]),
    (r"^Projectiles deal " + NUMBER + r"% increased Damage with Hits against (?:nearby Enemies|Enemies near them|Enemies within [\d.]+ metres)$",
     [increased("damage", ["projectile"], condition="other")]),
    # One pierce or one chain before the hit that matters, on average, for builds that pierce or chain.
    (r"^Projectiles deal " + NUMBER + r"% increased Damage with Hits and Ailments for each Enemy Pierced$",
     [increased("damage", ["projectile"], condition="pierced")]),
    (r"^Projectiles deal " + NUMBER + r"% increased Damage with Hits and Ailments for each time they have Chained$",
     [increased("damage", ["projectile", "chain"])]),
    (r"^Projectiles deal " + NUMBER + r"% increased Damage with Hits and Ailments for each remaining Chain, up to a maximum of " + NUMBER + r"%$",
     [increased("damage", ["projectile", "chain"], value="2*#")]),
    (r"^Projectiles Pierce an additional Target$", [flat("pierce", ["projectile"], value=1)]),
    # Bow Mastery: bow builds carry about 50% increased projectile speed.
    (r"^Increases and Reductions to Projectile Speed also apply to Damage with Bows$", [increased("damage", ["bow"], value=50)]),
    (r"^Poisons you inflict on non-Poisoned Enemies deal " + NUMBER + r"% increased Damage$", [minor()]),
    # Inherent dual wielding speed (10% more attack speed) doubled.
    (r"^Inherent Attack Speed bonus from Dual Wielding is doubled while wielding two Claws$",
     [{"kind": "more", "stat": "attackSpeed", "tags": ["attack"], "value": 10, "subject": "self", "condition": None,
       "requires": ["claw", "dualWield"]}]),
    (r"^\+" + NUMBER + r"% to Off Hand Critical Strike Chance while Dual Wielding$",
     [{"kind": "flat", "stat": "baseCrit", "tags": [], "value": "0.5*#", "subject": "self", "condition": None, "requires": ["dualWield"]}]),
    # Main-hand or off-hand lines reach half the hits of a dual wielder.
    (r"^" + NUMBER + r"% increased Attack Damage with Main Hand while Dual Wielding$",
     [increased("damage", ["attack"], value="0.5*#", requires=["dualWield"])]),
    (r"^" + NUMBER + r"% increased Attack Speed with Off Hand while Dual Wielding$",
     [increased("attackSpeed", ["attack"], value="0.5*#", requires=["dualWield"])]),
    (r"^" + NUMBER + r"% increased Main Hand Attack Damage while wielding two different Weapon Types$",
     [increased("damage", ["attack"], value="0.5*#", condition="other", requires=["dualWield"])]),
    (r"^" + NUMBER + r"% increased Off Hand Attack Speed while wielding two different Weapon Types$",
     [increased("attackSpeed", ["attack"], value="0.5*#", condition="other", requires=["dualWield"])]),
    # A melee hit is always at close range.
    (r"^" + NUMBER + r"% increased Melee Damage with Hits at Close Range$", [increased("damage", ["melee"])]),
    # Close range: always for melee, now and then for a ranged build (the engine's closeRange).
    (r"^" + NUMBER + r"% more Accuracy Rating at Close Range$", [more("accuracy", condition="closeRange")]),
    (r"^Deal " + NUMBER + r"% more Chaos Damage to enemies which have Energy Shield$", [more("damage", ["chaos"], condition="other")]),
    (r"^Critical Strikes with Daggers Poison the Enemy$",
     [{"kind": "chance", "stat": "poison", "tags": [], "value": 100, "subject": "self", "condition": "onCrit", "requires": ["dagger"]}]),
    # Perfect Crime's drawback reaches triggered spells (Cast on Critical Strike and the like).
    (r"^" + NUMBER + r"% less Damage with Triggered Spells$", [more("damage", ["spell", "triggered"], value="-#")]),
    (r"^Retaliation Skills have " + NUMBER + r"% increased Speed$", [increased("speed", ["retaliation"])]),
    # Wand Mastery: Arcane Might makes spell damage increases apply to attacks (3.30 patch notes); the engine has no
    # such rule, so it is a flag it doesn't read.
    (r"^Attacks have " + NUMBER + r"% Arcane Might while wielding a Wand$", [flag("arcaneMightWand")]),
    (r"^Spells which can gain Intensity have \+1 to maximum Intensity$", [minor()]),
    (r"^Skills supported by Unleash have \+1 to maximum number of Seals$", [minor()]),
    (r"^Skills Supported by Unleash have " + NUMBER + r"% increased Seal gain frequency$", [minor()]),
    (r"^Summoned Skeletons have " + NUMBER + r"% of Physical Damage Converted to Chaos Damage$",
     [{"kind": "conversion", "stat": "damage", "tags": ["chaos"], "value": "#", "subject": "minion", "condition": None,
       "from": ["physical"], "skill": "Summon Skeletons"}]),
    (r"^Summoned Skeletons have " + NUMBER + r"% chance to Wither Enemies for 2 seconds on Hit$",
     [dict(wither_more(10), skill="Summon Skeletons")]),

    # Defences.
    (r"^Gain " + NUMBER + r"% of Maximum Life as Extra Armour$", [flat("armour", value=str(TYPICAL_LIFE / 100) + "*#")]),
    (r"^\+1 Armour per 2 Strength$", [flat("armour", value=TYPICAL_MAIN_ATTRIBUTE / 2)]),
    (r"^\+1 Armour per 10 Unreserved Maximum Mana$", [flat("armour", value=50)]),
    (r"^\+" + NUMBER + r" Armour if you've Blocked Recently$", [flat("armour", condition="recentBlock")]),
    (r"^Every Rage also grants 1% increased Armour$", [increased("armour", value=30, condition="rage")]),
    (r"^" + NUMBER + r"% increased Defences while wielding a Staff$", [increased("defences", requires=["staff"])]),
    (r"^Chaos Resistance is doubled$", [{"kind": "resistance", "stat": "resistance", "tags": ["chaos"], "value": 20,
                                         "subject": "self", "condition": None}]),
    (r"^\+" + NUMBER + r"% to all Elemental Resistances and maximum Elemental Resistances while affected by a Non-Vaal Guard Skill$",
     [{"kind": "resistance", "stat": "resistance", "tags": ["elemental"], "value": "#", "subject": "self", "condition": "guard"},
      {"kind": "flat", "stat": "maxResistance", "tags": ["elemental"], "value": "#", "subject": "self", "condition": "guard"}]),
    # Item-local increases on one slot: the share of the build's base that slot holds (body armour about half of armour
    # or evasion, a helmet about a sixth of energy shield, boots and gloves together about a fifth), so 100% on it is
    # about that share more.
    (r"^" + NUMBER + r"% increased Evasion Rating from Equipped Body Armour$", [more("evasion", value="0.4*#")]),
    (r"^" + NUMBER + r"% increased Armour from Equipped Body Armour$", [more("armour", value="0.4*#")]),
    (r"^" + NUMBER + r"% increased Armour and Energy Shield from Equipped Body Armour if Equipped Helmet, Gloves and Boots all have Armour and Energy Shield$",
     [more("armour", value="0.4*#", condition="other"), more("energyShield", value="0.4*#", condition="other")]),
    (r"^" + NUMBER + r"% increased Energy Shield from Equipped Helmet$", [more("energyShield", value="0.15*#")]),
    (r"^" + NUMBER + r"% increased Armour from Equipped Boots and Gloves$", [more("armour", value="0.2*#")]),
    (r"^" + NUMBER + r"% increased Energy Shield from Equipped Shield$", [increased("shieldDefences", ["shield"], requires=["shield"])]),
    (r"^" + NUMBER + r"% increased maximum Life, Mana and Global Energy Shield$",
     [increased("life"), increased("mana"), increased("energyShield")]),
    (r"^" + NUMBER + r"% increased maximum Life and Mana if your equipped Staff has a Red and Blue Socket$",
     [increased("life", requires=["staff"]), increased("mana", requires=["staff"])]),
    # 120% of armour against projectile attacks, about a quarter of the hits a build takes.
    (r"^Defend with 120% of Armour against Projectile Attacks$", [more("armour", value=5)]),
    # Every 4 seconds, 1% of armour and evasion over a second: a quarter of that a second on average.
    (r"^Every 4 seconds, Regenerate Life equal to 1% of Armour and Evasion Rating over 1 second$",
     [flat("lifeRegenFlat", value=TYPICAL_ARMOUR_AND_EVASION / 100 / 4)]),
    (r"^Every 4 seconds, Regenerate Energy Shield equal to 1% of Evasion Rating over 1 second$",
     [flat("esRegenFlat", value=TYPICAL_ARMOUR_AND_EVASION / 2 / 100 / 4)]),
    # Recovery Mastery: regeneration stops, and every 4 seconds you recover ten times its rate a second, so 2.5 times
    # the regeneration on average (150% more), in bursts.
    (r"^Life Recovery from Regeneration is not applied$", [minor()]),
    (r"^Every 4 seconds, Recover 1 Life for every 0.1 Life Recovery per second from Regeneration$", [more("lifeRegen", value=150)]),
    (r"^" + NUMBER + r"% of Damage from Hits is taken from your nearest Totem's Life before you$",
     [{"kind": "flat", "stat": "damageTakenLess", "tags": [], "value": "#", "subject": "self", "condition": None, "requires": ["totem"]}]),
    (r"^" + NUMBER + r"% (?:less Damage over Time taken|less Damage Taken from Damage over Time|reduced Damage over Time Taken)", [minor()]),
    # Chance to suppress rolled twice: about 15 points on a build that doesn't cap it, nothing on one that does.
    (r"^Chance to Suppress Spell Damage is Lucky$", [flat("suppress", value=15)]),
    (r"^Auras from your Skills have " + NUMBER + r"% increased Effect on you$", [increased("effect:aurasFromYourSkills")]),
    (r"^Auras from your Skills have " + NUMBER + r"% increased Effect on you for each Herald affecting you", [increased("effect:aurasFromYourSkills", condition="other")]),
    (r"^Aura Skills have 1% more Aura Effect per 2% of maximum Mana they Reserve$",
     # Supreme Ego: an aura reserving a quarter to a half of mana (most Supreme Ego auras do, as the other line makes
     # them dearer) is about 20% stronger.
     [more("effect:aura", ["aura"], value=20)]),
    (r"^" + NUMBER + r"% more Mana Reservation of Aura Skills$", [more("reservation", ["aura"])]),
    (r"^" + NUMBER + r"% increased Life Reservation Efficiency of Skills$", [increased("lifeReservation")]),
    (r"^" + NUMBER + r"% increased Mana Reservation Efficiency of Skills Supported by Spellslinger$", [minor()]),
    (r"^Life Leech from Melee Damage is Instant$", [more("leechRate", value=100, subject="self"), flag("instantMeleeLeech")]),
    (r"^Gain Alchemist's Genius when you use a Flask$", [increased("flaskEffect", value=20)]),

    # Accuracy from attributes.
    (r"^Gain Accuracy Rating equal to your Intelligence$", [flat("accuracy", value=TYPICAL_MAIN_ATTRIBUTE)]),
    (r"^Intelligence is added to Accuracy Rating with Wands$",
     [{"kind": "flat", "stat": "accuracy", "tags": [], "value": TYPICAL_MAIN_ATTRIBUTE, "subject": "self", "condition": None, "requires": ["wand"]}]),
    (r"^Dexterity's Accuracy Bonus instead grants \+3 to Accuracy Rating per Dexterity$", [flat("accuracy", value=TYPICAL_DEXTERITY)]),
    (r"^" + NUMBER + r"% increased Attributes$", [increased("attributes")]),
    (r"^Gain Arcane Surge", [minor()]),
    (r"^You have (?:Onslaught|\[Onslaught\]) if you've", [minor()]),
    (r"^When you Warcry, you and nearby Allies gain (?:Onslaught|\[Onslaught\])", [minor()]),

    # Rules the generator doesn't measure: what enemies can't do to you, ailments removed or avoided, stun and
    # crit details on you, flask charges, minion upkeep, corpses, links, banners and Valour, warcry power and
    # exertion, Fortification details (the engine counts Fortify as a condition), forks, chain range, trap and mine
    # counts and timings, brand attachment, hexproof enemies (bosses aren't), destroyed corpses, stealth, Elusive and
    # Nightblade details, Call of Steel, impale bookkeeping, Hallowing Flame, low and full life thresholds, reflected
    # damage, and skills costing life for part of their mana cost.
    (r"can affect Hexproof Enemies$", [minor()]),
    (r"^Enemies (?:Cannot|cannot) Leech Life From you$", [minor()]),
    (r"^(?:Bleeding|Ignited) enemies cannot inflict (?:Bleeding|Ignite) on you$", [minor()]),
    (r"^Ignited enemies cannot Ignite you$", [minor()]),
    (r"^Unaffected by (?:Shocked|Chilled|Burning) Ground$", [minor()]),
    (r"^Unaffected by Chill while Channelling$", [minor()]),
    (r"^Remove (?:Bleeding|Maim and Hinder|a Curse|Elemental Ailments|all Damaging Ailments|Damaging Ailments|a random (?:Elemental |Non-Elemental )?Ailment)", [minor()]),
    (r"^Removes Ailments when you use a Flask$", [minor()]),
    (r"^(?:Damaging|Non-Damaging) Ailments Cannot Be inflicted on you while you already have one$", [minor()]),
    (r"^You cannot be (?:Maimed|Hindered|Impaled)$", [minor()]),
    (r"^Bleeding cannot be inflicted on you$", [minor()]),
    (r"^Immune to (?:Bleeding|Poison) if Equipped Helmet has", [minor()]),
    (r"^Your Elemental Resistances cannot be lowered by Curses$", [minor()]),
    (r"^Prevent \+" + NUMBER + r"% of Reflected", [minor()]),
    (r"^Critical Strikes against you do not inherently inflict Elemental Ailments$", [minor()]),
    (r"^Suppressed Spell Damage cannot inflict Elemental Ailments on you$", [minor()]),
    (r"^Hits against you Cannot be Critical Strikes if you've been Stunned Recently$", [minor()]),
    (r"^You take " + NUMBER + r"% reduced Extra Damage from Critical Strikes", [minor()]),
    (r"^Take no Extra Damage from Critical Strikes$", [minor()]),
    (r"^Debuffs on you expire " + NUMBER + r"% faster$", [minor()]),
    (r"^Non-Damaging Ailments have " + NUMBER + r"% reduced Effect on you while you have Arcane Surge$", [minor()]),
    (r"^Lightning Damage of Enemies Hitting you while you're Shocked is Unlucky$", [minor()]),
    (r"^Moving while Bleeding doesn't cause (?:you|Minions) to take extra Damage$", [minor()]),
    (r"^The first \d+ Mana Burn applied to you have no effect$", [minor()]),
    (r"^Modifiers to (?:Chance to Avoid being Shocked|Ignite Duration on you) apply to all Elemental Ailments$", [minor()]),
    (r"^Unaffected by Ignite or Shock if Maximum Life and Maximum Mana are within", [minor()]),
    (r"^When you Kill an Enemy Cursed with a Non-Aura Hex, become Immune to Curses", [minor()]),
    (r"^Curses are inflicted on you instead of Linked targets$", [minor()]),
    (r"^(?:Nearby Enemies|Enemies near your Marked Enemy) (?:cannot gain|are Blind)", [minor()]),
    (r"^(?:Recover|Regenerate) " + NUMBER + r"% of (?:Energy Shield|Life|Mana) over 1 second when", [minor()]),
    (r"^" + NUMBER + r" (?:Life|Mana) gained when you Block$", [minor()]),
    (r"^Recover " + NUMBER + r" Life for each Fortification lost$", [minor()]),
    (r"^" + NUMBER + r"% of Damage taken from Stunning Hits is Recovered as Life$", [minor()]),
    (r"^Every 3 seconds, Consume a Corpse", [minor()]),
    (r"^Life Recoup Effects instead occur over 3 seconds$", [minor()]),
    (r"^Lose " + NUMBER + r"% of Life and Energy Shield when you use a Chaos Skill$", [minor()]),
    (r"^-" + NUMBER + r" Physical Damage taken from Hits", [minor()]),
    (r"^You count as on (?:Low|Full) Life while at", [minor()]),
    (r"^(?:Attack )?Skills Cost Life instead of " + NUMBER + r"% of Mana Cost$", [minor()]),
    (r"^Strength provides no bonus to Maximum Life$", [minor()]),
    (r"^Count as Blocking Attack Damage from the first target Hit with each Shield Attack$", [minor()]),
    (r"^Dual Wielding does not inherently grant chance to Block Attack Damage$",
     [{"kind": "flat", "stat": "block", "tags": [], "value": -15, "subject": "self", "condition": None, "requires": ["dualWield"]}]),
    (r"^Off Hand Accuracy is equal to Main Hand Accuracy while wielding a Sword$", [minor()]),
    (r"^" + NUMBER + r"% reduced Enemy Chance to Block Sword Attacks$", [minor()]),
    (r"^" + NUMBER + r"% more chance to Evade Melee Attacks$", [minor()]),
    (r"^Gain an Endurance Charge when you Stun an Enemy with a Melee Hit$", [minor()]),
    (r"^Gain a Power Charge each second while Channelling a Spell$", [minor()]),
    (r"^Gain \d+ (?:Endurance|Frenzy) Charges when you consume maximum Valour", [minor()]),
    (r"^(?:\+\d+ to maximum Valour|\d+% increased Valour gained|Gain \d+ Valour when you Warcry)", [minor()]),
    (r"^Banners also grant", [minor()]),
    (r"^Enemies near your Banner", [minor()]),
    (r"^(?:[+-]\d+ to maximum Fortification$|Fortifying Hits|Melee Hits Fortify$|Retaliation Skills Fortify|Melee Hits with [\w ,]+ Fortify for)", [minor()]),
    (r"^(?:Warcries (?:cannot Exert|have a minimum of|Debilitate|Exert \d+ additional)|\d+% increased total Power counted by Warcries$|Enemies Taunted by your Warcries are Intimidated$|Gain \d+% increased Armour per \d+ Power for \d+ seconds when you Warcry)", [minor()]),
    (r"^Hallowing Flame you inflict|inflict Hallowing Flame$", [minor()]),
    (r"^(?:Link Skills have " + NUMBER + r"% increased Buff Effect|Link Skills Link to|Link Skills can target|Links take twice|Linked targets share|Enemies in your Link Beams)", [minor()]),
    (r"^Link Skills have " + NUMBER + r"% increased Buff Effect if you have Linked to a target Recently$", [minor()]),
    (r"of your Links ", [minor()]),
    (r"Call of Steel|Impales removed this way|remove all Impales|all Impales on that Enemy|Impale Damage dealt to Enemies Impaled by you", [minor()]),
    (r"^Impales you inflict gain " + NUMBER + r"% increased Effect once 1 second of Duration has expired$", [increased("effect:impale", value="0.6*#")]),
    (r"^Minions have a " + NUMBER + r"% chance to Impale on Hit with Attacks$",
     [{"kind": "chance", "stat": "impale", "tags": [], "value": "#", "subject": "minion", "condition": None}]),
    (r"Fork(?:ing\b| angle| 1 additional)|^Projectiles from Attacks Fork$", [minor()]),
    (r"Chaining range", [minor()]),
    (r"Projectiles that Return|^Returning Projectiles", [minor()]),
    (r"^Strike Skills which target additional Enemies|^Non-Vaal Strike Skills target", [minor()]),
    (r"^Melee Strike Skills deal Splash Damage to surrounding targets$", [minor()]),
    (r"^Final Repeat of Spells has", [minor()]),
    (r"^Can have up to \d+ additional (?:Traps|Remote Mines) placed at a time$", [minor()]),
    (r"^Mines have " + NUMBER + r"% increased Detonation Speed$", [minor()]),
    (r"^(?:Mines|Traps) cannot be Damaged$", [minor()]),
    (r"^Detonate Mines is Triggered while you are moving$", [minor()]),
    (r"^Skills which Throw Traps have \+1 Cooldown Use$", [minor()]),
    (r"^Mines Hinder\b", [minor()]),
    (r"^Totems' Action Speed cannot be modified to below Base Value$", [minor()]),
    (r"^Totems (?:Taunt|Hinder) Enemies", [minor()]),
    (r"^" + NUMBER + r"% increased Totem Placement range$", [minor()]),
    (r"^" + NUMBER + r"% of Physical Attack Damage dealt by your Totems is Leeched to you as Life$", [minor()]),
    (r"Brand Attachment [Rr]ange|^Brands Attach to a new Enemy", [minor()]),
    (r"^Minions created Recently|^Minions Recover|^Minions Leech|^Raised Zombies have|^Summoned Sentinels have|^Convocation has|^Desecrate and Unearth", [minor()]),
    (r"^Corpses you Spawn have", [minor()]),
    (r"^Increases and Reductions to Minion (?:Damage|Attack Speed) also affect you$", [minor()]),
    (r"^Plague Bearer has|Maximum Virulence", [minor()]),
    (r"^Withered you Inflict expires|^" + NUMBER + r"% chance when you inflict Withered to inflict up to", [minor()]),
    (r"(?:Killed by your Hits|Cursed Enemies you Kill) are destroyed$", [minor()]),
    (r"increased Stealth if|^Skills Supported by Nightblade have|^Elusive also grants|^Elusive on you reduces|^Elusive is removed from you", [minor()]),
    (r"^Enemies Poisoned by you cannot|^Disease Vector|^Enemies Poisoned by you cannot Regenerate", [minor()]),
    (r"^Marked Enemy (?:cannot|has|grants)", [minor()]),
    (r"^Every fourth Retaliation Skill|Retaliation Skill to become Usable|^Retaliation Skills (?:Debilitate|Fortify)|^Gain \d+ Rage on Hit with Retaliation", [minor()]),
    (r"^Warcries grant \d+ Rage|^Nearby Enemies are Intimidated while you have Rage|^Ruthless Hits Intimidate|^Intimidate Enemies for", [minor()]),
    (r"^Enemies you Curse are (?:Unnerved|Hindered)|^Non-Cursed Enemies you inflict|^Refresh Duration of Chill and Shock", [minor()]),
    # Malediction (tree text: lowers the damage cursed enemies deal); the generator's curses are always up.
    (r"^Enemies Cursed by you have Malediction if", [flat("damageTakenLess", value=3, condition="enemyCursed")]),
    (r"^Your Curses have " + NUMBER + r"% increased Effect if 50% of Curse Duration expired$", [increased("effect:curses", value="0.5*#", condition="other")]),
    (r"^(?:All Damage with Maces and Sceptres inflicts Chill|Crush Enemies)", [minor()]),
    (r"^Enemies Become Chilled as they Unfreeze|^(?:Freezes|Ignites|Shocks) you inflict spread to other (?:nearby )?Enemies", [minor()]),
    (r"^Chaos Skills ignore interruption from Stuns|^Hits Stun as though", [minor()]),
    (r"^Life Flasks gain|^Enemies you Kill that are affected by Elemental Ailments grant " + NUMBER + r"% increased Flask Charges$", [minor()]),
    (r"^" + NUMBER + r"% reduced Flask Charges used$", [minor()]),
    (r"^\+" + NUMBER + r"% to Maximum Effect of Shock$|^Increases and reductions to Maximum Mana also apply to Shock Effect", [minor()]),
    (r"^Your Movement Speed is equal to the highest", [minor()]),
    (r"^Blink Arrow and Mirror Arrow have|^" + NUMBER + r"% increased bonuses gained from Equipped Quiver$", [minor()]),
    (r"^You have Phasing if|^Stuns from Critical Strikes have", [minor()]),
    (r"^Recover " + NUMBER + r"% of Mana over 1 second when you use a Guard Skill$", [minor()]),
    (r"^(?:For each corpse within [\d.]+ metres|For each nearby corpse)", [minor()]),
    (r"^When you kill a Poisoned Enemy during any Flask Effect", [minor()]),
    (r"^Barrage|First and Final shots of Barrage", [minor()]),
    (r"^" + NUMBER + r"% chance for Energy Shield Recharge to start when you Link", [minor()]),
    (r"^Your Action Speed is at least " + NUMBER + r"% of base value$", [minor()]),
    (r"^Take 75% less Damage over Time for 5 seconds$", [minor()]),
    (r"^Summon Skitterbots also summons|^Skills Supported by Spell Totem are|Draugurflame", [minor()]),
    (r"^Gain \d+ Fortification on Melee Kill|^Melee Hits which Stun have " + NUMBER + r"% chance to Fortify$", [minor()]),
    (r"^" + NUMBER + r"% increased Buff Effect of your Links", [minor()]),
    (r"^Nearby Enemies are Chilled$", [minor()]),
    # A way to make Consecrated Ground (consecratedGroundSource) is what Bitter Heresy's Profane Ground needs.
    (r"^You have Consecrated Ground around you while stationary$",
     [flat("lifeRegen", value=2, condition="other"), flag("consecratedGroundSource")]),
    (r"^" + NUMBER + r"% chance to create Consecrated Ground (?:when you Hit|on)", [flag("consecratedGroundSource")]),
    (r"^Creates Consecrated Ground on Use$", [flag("consecratedGroundSource")]),
    # Claw Mastery: life or mana on hit with one hand's claw attacks, half the hits of a claw dual wielder. The general
    # shape read "Gain 25 Life per Enemy Hit" and dropped the rest, so spell builds took it (found 2026-11-23).
    (r"^Gain " + NUMBER + r" Life per Enemy Hit with (?:Main|Off) Hand Claw Attacks$",
     [{"kind": "flat", "stat": "onHitRecovery", "tags": ["attack"], "value": "0.5*#", "subject": "self", "condition": None, "requires": ["claw"]}]),
    (r"^Gain " + NUMBER + r" Mana per Enemy Hit with (?:Main|Off) Hand Claw Attacks$",
     [{"kind": "flat", "stat": "manaOnHit", "tags": ["attack"], "value": "0.5*#", "subject": "self", "condition": None, "requires": ["claw"]}]),
    # A build that takes this keeps about 300% increased armour, a fifth of which speeds its energy shield recharge.
    (r"^Increases and Reductions to Armour also apply to Energy Shield Recharge Rate at 20% of their value$",
     [increased("esRecharge", value=60)]),
    (r"^Stance Skills have \+\d+ seconds to Cooldown$", [minor()]),
    (r"^" + NUMBER + r"% of Chaos Damage taken does not bypass Energy Shield$", [minor()]),
    (r"^Maximum Recovery per Energy Shield Leech is Doubled$|^Energy Shield Leech Effects from Attacks are not removed", [minor()]),
    (r"^" + NUMBER + r"% increased Defences while you have at least four Linked targets$", [minor()]),
    (r"^Totems Hinder\b|^Projectiles have " + NUMBER + r"% chance for an additional Projectile when Forking$", [minor()]),
    # Only when the main skill is paid with life (Blood Magic, Lifetap): the engine's skillCostsLife.
    (r"^" + NUMBER + r"% increased Physical Damage with Skills that Cost Life$", [increased("damage", ["physical"], condition="skillCostsLife")]),

    # ---------- unique lines whose plain reading would mislead ----------
    # Pragmatism: +12 socketed levels, then -2 per socketed gem; a six-link nets nothing.
    (r"^-2 to level of Socketed Skill Gems per Socketed Gem$", [{"kind": "level", "stat": "gemLevel", "tags": [], "value": -12,
                                                                 "subject": "self", "condition": None, "socketed": True}]),
    # Ryslatha's Coil: "more maximum" and "less minimum" average out to about the same damage, only swingier.
    (r"^" + NUMBER + r"% (?:more Maximum|less Minimum) Physical Attack Damage$", [minor()]),
    # Volatility: much more maximum, much less minimum damage; on average about a tenth more.
    (r"^Supported Skills deal " + NUMBER + r"% more Maximum Attack Damage$", [more("damage", ["attack"], value=10, subject="supported")]),
    (r"^Supported Skills deal " + NUMBER + r"% less Minimum Attack Damage$", [minor()]),
    # Momentum: stacks while standing still and is lost on moving, so it mostly helps channelled or stationary play.
    (r"^Supported Skills have " + NUMBER + r"% increased Attack Speed per Momentum$",
     [{"kind": "increased", "stat": "attackSpeed", "tags": [], "value": 50, "subject": "supported", "condition": "stationary"}]),
    (r"Momentum", [minor()]),
    (r"^Swiftness grants", [minor()]),
    (r"^Deal no Non-Elemental Damage$", [flag("noNonElemental")]),
    # Echoes of Creation and the like: only attacks exerted by warcries gain, about one warcry at a time.
    (r"more Damage for each Warcry Exerting them$", [more("damage", ["attack", "melee"], value=12, condition="warcry")]),
    (r"^Socketed Skills deal Double Damage$", [more("damage", value=100, condition="socketedSkill")]),

    # ---------- support gems: what the supported skill gains (subject "supported") ----------
    # Archmage: its added damage grows with unreserved mana. 35% more at 1000 unreserved mana (our estimate), scaled by
    # the build's own unreserved mana (condition "unreservedMana", public/buildgen.js), so auras reserving most of the
    # mana leave it little. The reserved-mana form (Manaforged Arrows' kin) keeps the fixed figure.
    (r"^Supported Skills gain Added (?:Lightning|Cold) Damage equal to " + NUMBER + r"% of Unreserved Maximum Mana$",
     [more("damage", ["spell"], value=35, condition="unreservedMana", subject="supported"), flag("scalesWithMana", subject="supported")]),
    (r"^Supported Skills gain Added (?:Lightning|Cold) Damage equal to " + NUMBER + r"% of Reserved Maximum Mana$",
     [more("damage", ["spell"], value=35, subject="supported"), flag("scalesWithMana", subject="supported")]),
    # Its cost line: each use costs a share of the unreserved mana on top of the skill's own base cost, which the
    # supports' multipliers then raise; the generator's mana upkeep adds it. It was read as minor until 2026-11-13,
    # so Archmage looked free to cast. Another form of the line (reserved mana) stays minor.
    (r"^Supported Skills gain Base Mana Cost equal to " + NUMBER + r"% of Unreserved Maximum Mana$",
     [flat("costPerUnreservedMana", subject="supported")]),
    (r"^Supported Skills gain Base Mana Cost equal to", [minor()]),
    (r"^\+?" + NUMBER + r"% to Quality of Supported Skill Gems$", [minor()]),
    (r"^Supported Attacks will Trigger a Supported Spell when you Crit an Enemy$", [flag("castOnCrit", subject="supported")]),
    (r"^Supported Melee Attacks will Trigger a Supported Spell on Kill$", [flag("castOnKill", subject="supported")]),
    (r"^(?:Supported Skills )?deal up to " + NUMBER + r"% more Melee Damage to Enemies, based on proximity$",
     [more("damage", ["melee"], value=25, subject="supported")]),
    (r"^Supported Skills grant Combat Rush on Hit$", [more("attackSpeed", ["attack"], value=10, subject="supported")]),
    (r"^Combat Rush (?:lasts|grants)", [minor()]),
    (r"^Minions from Supported Skills take", [minor()]),
    (r"^" + NUMBER + r"% more maximum number of Minions from Supported Skills$", [more("damage", ["minion"], value=30, subject="supported")]),
    (r"^Supported Skills have \+?" + NUMBER + r"% Damage over Time Multiplier for Ailments from Critical Strikes$",
     [flat("dotMulti", ["ailment"], value="#", condition="onCrit", subject="supported")]),
    (r"^Supported Skills will Trigger .+? on (?:Hit|Melee Hit|Killing Blow)$", [more("damage", value=10, subject="supported")]),
    (r"^Supported Skills trigger .+? on Killing Blow$", [more("damage", value=8, subject="supported")]),
    (r"^Supported Attacks Trigger Windburst on Hit", [more("damage", value=6, subject="supported")]),
    (r"^Kill Normal and Magic Rarity Enemies that have " + NUMBER + r"% Life or lower", [more("damage", value=10, subject="supported")]),
    (r"^Supported Skills inflict Decay on Hit", [more("damage", ["chaos"], value=10, subject="supported")]),
    (r"^Killing Blows with Supported Skills Consume corpses", [minor()]),
    (r"^Consuming a Corpse with Supported Skills", [minor()]),
    (r"^Attacks with Supported Skill are Ancestrally Boosted", [minor()]),
    (r"^Ancestral Boost does not apply", [minor()]),
    (r"^Ancestrally Boosted Slams deal " + NUMBER + r"% more Damage", [more("damage", ["slam"], value=30, subject="supported")]),
    (r"^Ancestrally Boosted Slams have", [minor()]),
    (r"^Totems from Supported Skills gain the Avenging Flame$", [more("damage", ["totem", "fire"], value=10, subject="supported")]),
    (r"^Skill and Trigger it when Hit by an Enemy$", [minor()]),
    (r"^Supported Skills can Cast " + NUMBER + r" additional Brands$", [more("damage", ["brand"], value=30, subject="supported")]),
    (r"^Supported Brands Trigger", [minor()]),
    (r"^Minions created by Supported Skills gain Wakened Fury", [more("damage", ["minion"], value=20, subject="supported")]),
    (r"^Wakened Fury grants", [minor()]),
    (r"^Supported Skills Damage and Chill Enemies between you and Linked Targets$", [flag("linkDamage", subject="supported")]),
    (r"^Supported Skills deal " + NUMBER + r" Base (?:Cold|Fire|Physical|Chaos|Lightning) Damage per second$", [minor()]),
    (r"^Damage and Chill Linger", [minor()]),
    (r"^Modifiers to Spell", [minor()]),
    (r"^Supported Auras do not affect you$", [flag("generosity", subject="supported")]),
    (r"^Non-Curse Auras from Supported Skills have " + NUMBER + r"% increased Effect$",
     [{"kind": "increased", "stat": "auraEffect", "tags": ["aura"], "value": "#", "subject": "supported", "condition": None}]),
    (r"^Supported Strike Skills target " + NUMBER + r" additional nearby Enemies$", [more("damage", ["strike"], value=20, subject="supported")]),
    (r"^Extra Targets for Supported Skills", [minor()]),
    (r"^Supported Skills Chain \+?" + NUMBER + r" times$", [flat("chains", ["projectile"], value="#", subject="supported")]),
    (r"^Supported Skills Chain " + NUMBER + r"% more times$", [minor()]),
    (r"^Supported Skills have " + NUMBER + r"% increased Chaining range$", [minor()]),
    (r"^Projectiles from Supported Skills (?:can )?Fork", [more("damage", ["projectile"], value=10, subject="supported")]),
    (r"^Projectiles from Supported Skills have " + NUMBER + r"% chance for an additional", [minor()]),
    (r"^Projectile when Forking$", [minor()]),
    (r"^" + NUMBER + r"% increased magnitude of Hallowing Flame", [minor()]),
    (r"^Supported Skills inflict Hallowing Flame on Melee Hit$", [more("damage", ["melee", "fire"], value=10, subject="supported")]),
    (r"^Supported Skills have " + NUMBER + r"% increased Hex Transfer range$", [minor()]),
    (r"^Hexes from Supported Skills (?:Transfer|have no Duration)", [minor()]),
    (r"^Supported Skills create Cursed Ground", [flag("curseOnGround", subject="supported")]),
    (r"^Enemies on the Cursed Ground", [minor()]),
    (r"^Maximum 1 area", [minor()]),
    (r"^Supported Skills apply supported Curses on Hit$", [flag("curseOnHit", subject="supported")]),
    (r"^Supported Offerings Trigger", [minor()]),
    (r"^Minions from Supported Skills deal " + NUMBER + r" Fire Damage per second to Enemies near them$",
     [more("damage", ["minion", "fire"], value=15, subject="supported")]),
    (r"^Hits from Supported Skills have " + NUMBER + r"% chance to treat Enemy Monster Elemental Resistance values as inverted$",
     [more("damage", ["elemental"], value=15, subject="supported")]),
    (r"^Supported Skills have " + NUMBER + r"% chance to (?:cause Monsters to Flee|Knock Enemies Back)", [minor()]),
    (r"^" + NUMBER + r" Life gained per Enemy Hit with Supported Attacks$", [flat("onHitRecovery", subject="supported")]),
    (r"^Maximum 1 Summoned Mirage Archer$", [minor()]),
    (r"^When you Hit an Enemy with an Arrow from a Supported Skill, Summon a Mirage Archer", [more("damage", ["bow"], value=25, subject="supported")]),
    (r"^Mirage Archer", [minor()]),
    (r"^Supported Skills consume all Fortification on use", [more("damage", ["ailment"], value=15, subject="supported")]),
    (r"^Ailments per \d+ Fortification consumed$", [minor()]),
    (r"^Hits froms? Supported Skills cannot kill Enemies$", [flag("cannotKill", subject="supported")]),
    (r"^Projectiles from Supported Skills Return to you$", [more("damage", ["projectile"], value=25, subject="supported")]),
    (r"^Projectiles from Supported Skills (?:deal " + NUMBER + r"% less Damage with Hits and Ailments while Returning|Pierce all Targets while Returning)", [minor()]),
    (r"^Critical Strikes with Supported Skills that inflict Bleeding also inflict Rupture$",
     [more("damage", ["bleed"], value=40, condition="onCrit", subject="supported")]),
    (r"^Targets take " + NUMBER + r"% more Damage from Bleeding per Rupture", [minor()]),
    (r"^Bleeding expires", [minor()]),
    (r"^Every third Attack with Supported Melee Attacks deals a Ruthless Blow$", [minor()]),
    (r"^Ruthless Blows with Supported Skills deal " + NUMBER + r"% more", [more("damage", ["melee"], value=25, subject="supported")]),
    (r"^Supported Spells Sacrifice", [more("damage", ["spell", "chaos"], value=15, subject="supported")]),
    (r"^Supported Skills can only be used with", [flag("weaponLimited", subject="supported")]),
    (r"^Supported Skills have Added Spell Damage equal to " + NUMBER + r"% of", [flag("spellblade", subject="supported")]),
    (r"^Damage of Equipped One Handed Melee Weapons$", [minor()]),
    (r"^If two Weapons are Equipped, each contributes", [minor()]),
    (r"^Supported Skills have " + NUMBER + r"% reduced Enemy Stun Threshold$", [minor()]),
    (r"^Supported Skills Cost Life instead of Mana$", [flag("costLife", subject="supported")]),
    (r"^A nearby Minion gains a Soul", [minor()]),
    (r"^Costs with Supported Spells$", [minor()]),
    (r"^Supported Skills have " + NUMBER + r"% increased Warcry Speed$", [minor()]),
    (r"^Using Supported Vaal Skills inflicts Vaal Temptation", [more("damage", ["vaal"], value=30, subject="supported")]),
    (r"^Supported Banners inflict Corrupted Blood", [minor()]),
    (r"^Corrupted Blood inflicted by Supported", [minor()]),
    (r"^Supported Warcries Trigger", [minor()]),
    (r"^Overpowered applies", [minor()]),
    (r"^Supported Skills inflict Overpowered", [minor()]),
    (r"^Enemies have -?" + NUMBER + r"% chance to Block Attack or Spell Damage from Supported Skills$", [minor()]),
]
