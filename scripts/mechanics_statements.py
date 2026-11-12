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
    (r"^You can inflict Bleeding on an Enemy up to 8 times$", [more("damage", ["bleed"], value=150), flag("crimsonDance")]),
    (r"^Bleeding you inflict is Aggravated$", [more("damage", ["bleed"], value=50)]),
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
    (r"^Inherent Bonuses from Dual Wielding are doubled$", [more("speed", ["attack"], value=10, condition="dualWield"), flag("needsDualWield")]),
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
    (r"^When your Traps Trigger, your nearby Traps also Trigger$", [more("damage", ["trap"], value=10)]),
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
    (r"^Hits that deal Elemental Damage remove Exposure to those Elements", [more("damage", ["elemental"], value=10)]),
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
    (r"^Minions have Unholy Might$", [{"kind": "extra", "stat": "damage", "tags": ["chaos"], "value": 30, "subject": "minion", "condition": None, "from": ["physical"]}]),
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
    (r"^" + NUMBER + r"% of Non-Chaos Damage taken bypasses Energy Shield$", [flag("eldritchBatteryBypass")]),
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
