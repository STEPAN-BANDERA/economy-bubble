"""Our own reading of Path of Exile stat text: turns a line like "Supported Skills deal 39% more Spell Damage" into
an effect the build generator can reason with:

    {"kind": "more", "stat": "damage", "tags": ["spell"], "value": 39, "subject": "self", "condition": None}

kind       what the line does: increased, more, added, flat, level, conversion, extra, penetration, exposure,
           resistance, chance, grants, trigger, limit, flag, minor
stat       what it changes (damage, castSpeed, critChance, life, block, ...); "minor" lines are understood but
           don't matter for a build's power (light radius, stun on enemies, ...). Item rarity and quantity are read
           (itemRarity, itemQuantity) for the build planner's rarity stage; they aren't part of the power score
tags       the scope: which damage types, skill kinds and weapons the line applies to. An effect only helps a
           build whose own tags include them all.
subject    who gets it: self, minion, totem, enemy (an enemy debuff), supported (a support gem's skill)
condition  None when always on, else a short id (recentKill, lowLife, ...) the engine weighs by how often it holds
requires   tags that must hold for the line to work at all ("while wielding a Staff" -> staff)

The dictionaries below are hand-written from how the game words its stats. The game data only supplies the text;
a line this module can't read is reported, never guessed, so the coverage report shows what to teach it next.
"""
import re

from mechanics_statements import STATEMENTS

# ---------- reading numbers ----------
NUMBER = r"[+-]?\d+(?:\.\d+)?"
RANGE = r"\(\s*" + NUMBER + r"\s*[-–]\s*" + NUMBER + r"\s*\)"
VALUE = "(?:[+-]?" + RANGE + "|" + NUMBER + ")"


def read_value(text, range_mode):
    """A number or a "(low-high)" range, maybe signed ("-(20-10)"). range_mode "level" takes the last value (gem
    text runs level 1 to 20), "roll" takes the middle (a unique's roll range)."""
    text = text.strip()
    sign = 1
    if text.startswith("-("):
        sign = -1
        text = text[1:]
    elif text.startswith("+("):
        text = text[1:]
    range_match = re.fullmatch(r"\(\s*(" + NUMBER + r")\s*[-–]\s*(" + NUMBER + r")\s*\)", text)
    if range_match is None:
        return sign * float(text)
    low = float(range_match.group(1))
    high = float(range_match.group(2))
    if range_mode == "level":
        return sign * high
    return sign * (low + high) / 2


# Text on items and areas that says nothing about a character's power: understood, and ignored.
MINOR_PATTERNS = [
    r"\bfish", r"^map has\b", r"^area (?:contains|has|is)\b", r"^monster level", r"\(hidden\)", r"\buses remaining\b",
    r"^has \d+ (?:abyssal )?sockets?\b", r"^has \d+ socket", r"\brequirements?\b", r"^cannot be used with forbidden tomes",
    r"\bimplicit modifier magnitudes\b", r"\bcharges per use\b", r"\bcharge recovery\b", r"\bcharacter size\b",
    r"^empowers\b", r"^duplicates\b", r"^found items\b", r"\bnumber of rare monsters\b", r"^monsters\b",
    r"^reflects\b", r"\bdamage taken from attack hits\b", r"\bitems dropped by\b", r"\brarity of\b", r"\bquantity of\b",
    r"\blight radius\b", r"^\d+ ring slot", r"^<", r"^&lt;", r"\bexperience\b",
    r"\bcorrupted\b", r"\bkills? (?:count|with)\b.*\btowards\b", r"\bstun threshold\b", r"\bstun duration\b",
    r"\bstun recovery\b", r"\bblock recovery\b", r"\bknock(?:s|back| back)\b", r"\bto flee\b", r"\bbeyond\b.*\bportal",
    r"^\+?\d+(?:\.\d+)? to charge$", r"\bmaximum charges\b", r"\bweapon range\b",
    r"^historic$", r"^extra gore$", r"\bdestroyed when applied\b", r"^has no sockets$", r"^passives affected\b",
    r"\bveiled \((?:prefix|suffix)\)$", r"^cannot roll\b", r"^primordial$", r"^no physical damage$", r"^rampage$",
    r"\bmovement penalties\b", r"\bmana flasks? gain\b",
    r"\bcharge duration\b", r"\bmaximum rage\b", r"\bminimum rage\b", r"\bbanner buffs linger\b",
]


def is_minor(line):
    lowered = line.lower()
    for pattern in MINOR_PATTERNS:
        if re.search(pattern, lowered):
            return True
    return False


# ---------- cleaning the wiki's text ----------
def clean_line(text):
    """Drops wiki markup: [[Page|shown words]] -> shown words, [[Page]] -> Page, and any HTML tags."""
    without_links = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", text)
    without_tags = re.sub(r"<[^>]+>", "", without_links)
    return re.sub(r"\s+", " ", without_tags).strip()


def split_lines(text):
    """One stat per line. The wiki breaks long stats over two lines; a line starting in lower case continues the
    one before it."""
    if not text:
        return []
    pieces = re.split(r"<br\s*/?>|\n", str(text))
    lines = []
    for piece in pieces:
        line = clean_line(piece)
        if not line:
            continue
        if lines and line[0].islower():
            lines[-1] = lines[-1] + " " + line
            continue
        lines.append(line)
    return lines


# ---------- what a phrase is about: stats (longest phrases first) ----------
STAT_PHRASES = [
    ("critical strike multiplier", "critMulti"),
    ("critical strike chance", "critChance"),
    ("attack and cast speed", "speed"),
    ("attack, cast and movement speed", "speed"),
    ("cast speed", "castSpeed"),
    ("attack speed", "attackSpeed"),
    ("activation frequency", "speed"),
    ("trap throwing speed", "speed"),
    ("mine throwing speed", "speed"),
    ("totem placement speed", "totemPlacement"),
    ("brand attachment range", "minor"),
    ("movement speed", "movementSpeed"),
    ("projectile speed", "projectileSpeed"),
    ("area of effect", "area"),
    ("skill effect duration", "duration"),
    ("damage over time multiplier", "dotMulti"),
    ("damage taken", "damageTaken"),
    ("damage over time", "damage"),
    ("damage", "damage"),
    ("maximum energy shield", "energyShield"),
    # "faster start" shortens the wait before recharge begins; "recharge rate" speeds the recharge itself.
    ("start of energy shield recharge", "esRechargeStart"),
    ("energy shield recharge rate", "esRecharge"),
    ("energy shield recharge", "esRecharge"),
    ("energy shield", "energyShield"),
    ("maximum life", "life"),
    ("maximum mana", "mana"),
    ("life regeneration rate", "lifeRegen"),
    ("mana regeneration rate", "manaRegen"),
    ("armour and evasion rating", "armour"),
    ("evasion rating and armour", "armour"),
    ("armour and evasion", "armour"),
    ("strength and intelligence", "attributes"),
    ("strength and dexterity", "attributes"),
    ("dexterity and intelligence", "attributes"),
    ("armour and energy shield", "armour"),
    ("evasion and energy shield", "evasion"),
    ("evasion rating", "evasion"),
    ("armour", "armour"),
    ("accuracy rating", "accuracy"),
    ("ward", "ward"),
    ("all attributes", "attributes"),
    ("strength", "strength"),
    ("dexterity", "dexterity"),
    ("intelligence", "intelligence"),
    ("effect of non-curse auras", "auraEffect"),
    ("aura effect", "auraEffect"),
    ("effect of auras", "auraEffect"),
    ("curse effect", "curseEffect"),
    ("effect of your curses", "curseEffect"),
    ("effect of curses", "curseEffect"),
    ("effect of shock", "shockEffect"),
    ("effect of chill", "chillEffect"),
    ("shock effect", "shockEffect"),
    ("chill effect", "chillEffect"),
    ("ignite duration", "ailmentDuration"),
    ("bleeding duration", "ailmentDuration"),
    ("poison duration", "ailmentDuration"),
    ("duration of ailments", "ailmentDuration"),
    ("duration", "duration"),
    ("mana reservation efficiency", "reservation"),
    ("reservation efficiency", "reservation"),
    ("mana reserved", "reservation"),
    ("reservation", "reservation"),
    # Cost efficiency divides a cost (cost x 100 / (100 + efficiency)); "increased cost" multiplies it. Since 3.26 the
    # tree's "reduced Cost" lines are cost efficiency (GGG's patch notes).
    ("mana cost efficiency", "costEfficiency"),
    ("cost efficiency", "costEfficiency"),
    ("mana cost", "cost"),
    ("cost", "cost"),
    # Flask lines say different things: how long, how strong, how often, how much life (they were all "flask").
    ("flask effect duration", "flaskDuration"),
    ("flask charges gained", "flaskCharges"),
    ("effect of flasks", "flaskEffect"),
    ("flask effect", "flaskEffect"),
    ("life recovery from flasks", "flaskRecovery"),
    ("life recovery rate", "recovery"),
    ("recovery rate", "recovery"),
    ("stun and block recovery", "minor"),
    ("stun threshold", "minor"),
    ("stun duration", "minor"),
    ("enemy stun threshold", "minor"),
    ("rarity of items", "minor"),
    ("quantity of items", "minor"),
    ("light radius", "minor"),
    ("experience gain", "minor"),
    ("maps found", "minor"),
    ("knockback distance", "minor"),
    ("cooldown recovery rate", "cooldown"),
    ("cooldown recovery speed", "cooldown"),
    ("warcry speed", "minor"),
    ("warcry cooldown", "minor"),
    ("totem life", "totemLife"),
    ("totem duration", "minor"),
    ("projectiles", "projectiles"),
    ("life", "life"),
    ("mana", "mana"),
    ("block", "block"),
    ("rarity", "minor"),
]

# ---------- scope words (longest first): which damage, skills and weapons a phrase is about ----------
TAG_PHRASES = [
    ("damage over time", ["dot"]),
    ("with hits and ailments", []),
    ("hits and ailments", []),
    ("non-chaos", ["nonChaos"]),
    ("elemental", ["elemental"]),
    ("physical", ["physical"]),
    ("fire", ["fire"]),
    ("cold", ["cold"]),
    ("lightning", ["lightning"]),
    ("chaos", ["chaos"]),
    ("spell skills", ["spell"]),
    ("spells", ["spell"]),
    ("spell", ["spell"]),
    ("attack skills", ["attack"]),
    ("attacks", ["attack"]),
    ("attack", ["attack"]),
    ("melee", ["melee"]),
    ("projectile", ["projectile"]),
    ("area skills", ["area"]),
    ("area", ["area"]),
    ("totems", ["totem"]),
    ("totem", ["totem"]),
    ("traps", ["trap"]),
    ("trap", ["trap"]),
    ("mines", ["mine"]),
    ("mine", ["mine"]),
    ("brand skills", ["brand"]),
    ("brands", ["brand"]),
    ("brand", ["brand"]),
    ("minions", ["minion"]),
    ("minion", ["minion"]),
    ("aura skills", ["aura"]),
    ("auras", ["aura"]),
    ("aura", ["aura"]),
    ("curse skills", ["curse"]),
    ("curses", ["curse"]),
    ("hex", ["curse"]),
    ("warcries", ["warcry"]),
    ("warcry", ["warcry"]),
    ("herald skills", ["herald"]),
    ("herald", ["herald"]),
    ("channelling skills", ["channel"]),
    ("channelling", ["channel"]),
    ("slam skills", ["slam"]),
    ("slams", ["slam"]),
    ("strike skills", ["strike"]),
    ("vaal skills", ["vaal"]),
    ("movement skills", ["movement"]),
    ("travel skills", ["movement"]),
    ("guard skills", ["guard"]),
    ("non-vaal", []),
    ("hits", []),
    ("hit", []),
    ("weapons", []),
    ("weapon", []),
    ("enemies", []),
    ("enemy", []),
    ("damaging", []),
    ("effects", []),
    ("effect", []),
    ("rating", []),
    ("rate", []),
    ("in", []),
    ("on", []),
    ("as", []),
    ("are", []),
    ("is", []),
    ("non-curse", []),
    ("melee weapons", ["melee"]),
    ("ranged", ["projectile"]),
    ("arrows", ["bow", "projectile"]),
    ("arrow", ["bow", "projectile"]),
    ("ailments", ["ailment"]),
    ("damage over time skills", ["dot"]),
    ("vaal", ["vaal"]),
    ("golems", ["golem"]),
    ("golem", ["golem"]),
    ("bow", ["bow"]),
    ("bows", ["bow"]),
    ("wands", ["wand"]),
    ("wand", ["wand"]),
    ("staves", ["staff"]),
    ("staff", ["staff"]),
    ("swords", ["sword"]),
    ("sword", ["sword"]),
    ("axes", ["axe"]),
    ("axe", ["axe"]),
    ("maces or sceptres", ["mace"]),
    ("mace or sceptre", ["mace"]),
    ("maces", ["mace"]),
    ("mace", ["mace"]),
    ("sceptres", ["mace"]),
    ("claws", ["claw"]),
    ("claw", ["claw"]),
    ("daggers", ["dagger"]),
    ("dagger", ["dagger"]),
    ("two handed melee weapons", ["twoHand", "melee"]),
    ("two handed weapons", ["twoHand"]),
    ("two handed weapon", ["twoHand"]),
    ("one handed melee weapons", ["oneHand", "melee"]),
    ("one handed weapons", ["oneHand"]),
    ("one handed weapon", ["oneHand"]),
    ("dual wielding", ["dualWield"]),
    ("shield", ["shield"]),
    ("unarmed", ["unarmed"]),
    ("ignites", ["ignite"]),
    ("ignite", ["ignite"]),
    ("poisons", ["poison"]),
    ("bleeds", ["bleed"]),
    # Burning damage is fire damage over time: ignite and burning skills (Righteous Fire, burning ground) alike.
    # It was read as ignite only, which left burning skills without it (found by scripts/check_against_pob.py).
    ("burning", ["fire", "dot"]),
    ("bleeding", ["bleed"]),
    ("bleed", ["bleed"]),
    ("poison", ["poison"]),
    ("ailments", ["ailment"]),
    ("ailment", ["ailment"]),
    ("global", []),
    ("supported", []),
    ("skills", []),
    ("skill", []),
    ("with", []),
    ("your", []),
    ("of", []),
    ("to", []),
    ("and", []),
    ("the", []),
    ("for", []),
    ("from", []),
    ("by", []),
    ("you", []),
    ("all", []),
    ("a", []),
    ("an", []),
    ("increased", []),
    ("added", []),
    ("base", []),
    ("dealt", []),
    ("deal", []),
    ("have", []),
    ("has", []),
    ("total", []),
]

# Weapons in a "while wielding ..." clause: the line only works with that weapon, so the build must use it.
WEAPON_REQUIREMENTS = [
    ("a two handed melee weapon", ["twoHand", "melee"]),
    ("a two handed weapon", ["twoHand"]),
    ("a one handed weapon", ["oneHand"]),
    ("a mace or sceptre", ["mace"]),
    ("a staff", ["staff"]),
    ("a bow", ["bow"]),
    ("a wand", ["wand"]),
    ("a sword", ["sword"]),
    ("an axe", ["axe"]),
    ("a claw", ["claw"]),
    ("a dagger", ["dagger"]),
    ("a shield", ["shield"]),
    ("a claw or dagger", ["claw"]),
]

# Conditions: phrase fragment -> id. The engine weighs each id by how often it holds for a given build. Order
# matters: "per"/"for each" come first, since "per Frenzy Charge" stacks while "while you have no Frenzy
# Charges" is a state that holds some of the time.
CONDITION_PHRASES = [
    ("masteries allocated", "masteryCount"),
    # Precise Technique: the engine compares the build's accuracy with its life.
    ("accuracy rating is higher than maximum life", "accuracyAboveLife"),
    ("cannot have life leeched", "unleechable"),
    # "per Raised Zombie", "per Summoned Skeleton": how many of your own minions of a kind you have, which the
    # generator doesn't plan beside a main skill; they read as 3 stacks (Umbral Army gave every attack build 45%).
    ("per summoned", "perOwnMinion"),
    ("per minion", "perOwnMinion"),
    ("per raised", "perOwnMinion"),
    # Endurance Charges are counted by the engine (the build's maximum, when it has a source), not assumed.
    ("per endurance charge", "perEnduranceCharge"),
    ("for each endurance charge", "perEnduranceCharge"),
    ("for each", "perStack"),
    (" per ", "perStack"),
    ("guard skill", "guard"),
    ("guard buff", "guard"),
    ("dual wielding", "dualWield"),
    ("holding a shield", "shield"),
    ("on low life", "lowLife"),
    ("at full life", "fullLife"),
    ("on full life", "fullLife"),
    ("on full energy shield", "fullEnergyShield"),
    ("killed recently", "recentKill"),
    ("killed an enemy recently", "recentKill"),
    ("on kill", "onKill"),
    ("crit recently", "recentCrit"),
    ("dealt a critical strike recently", "recentCrit"),
    ("critical strike", "onCrit"),
    ("blocked recently", "recentBlock"),
    ("blocked", "recentBlock"),
    ("when you block", "onBlock"),
    ("been hit recently", "recentlyHit"),
    ("when hit", "onHit"),
    ("using a flask", "flask"),
    ("affected by a flask", "flask"),
    ("during flask effect", "flask"),
    ("during any flask effect", "flask"),
    ("frenzy charge", "chargeState"),
    ("power charge", "chargeState"),
    ("endurance charge", "chargeState"),
    ("arcane surge", "arcaneSurge"),
    ("onslaught", "onslaught"),
    ("fortif", "fortify"),
    ("you have a totem", "totem"),
    ("near a totem", "totem"),
    ("you have a spectre", "spectre"),
    ("unencumbered", "unencumbered"),
    ("channelling", "channel"),
    ("cast a spell recently", "recentSpell"),
    ("used a skill recently", "recentSkill"),
    ("rare or unique", "rareOrUnique"),
    ("rare and unique", "rareOrUnique"),
    ("unique enemies", "rareOrUnique"),
    ("chilled", "enemyChilled"),
    ("frozen", "enemyFrozen"),
    ("shocked", "enemyShocked"),
    ("ignited", "enemyIgnited"),
    ("poisoned", "enemyPoisoned"),
    ("bleeding", "enemyBleeding"),
    ("cursed", "enemyCursed"),
    ("hindered", "enemyHindered"),
    ("intimidated", "enemyIntimidated"),
    ("taunted", "enemyTaunted"),
    ("nearby", "nearby"),
]

# Conditions that hold when something has NOT happened ("if you haven't dealt a Critical Strike Recently"): the
# plain phrase table would read them as their opposite. Checked first; a negated clause none of these names is
# "other", never the plain reading.
NEGATION_WORDS = ("haven't", "have not", "hasn't", "has not", "not been", "not dealt", "not blocked", "not killed")
NEGATED_CONDITION_PHRASES = [
    ("critical strike", "noRecentCrit"),
    ("crit", "noRecentCrit"),
    ("been hit", "notRecentlyHit"),
    ("blocked", "noRecentBlock"),
    ("killed", "noRecentKill"),
]


def negated_condition(clause_text):
    """The condition id of a clause that says something hasn't happened; None when the clause isn't negated."""
    lowered = clause_text.lower()
    negated = False
    for words in NEGATION_WORDS:
        if words in lowered:
            negated = True
            break
    if not negated:
        return None
    for words, condition_id in NEGATED_CONDITION_PHRASES:
        if words in lowered:
            return condition_id
    return "other"


# Whole statements that change how a build works rather than adding a number. Keyed by a lower-case phrase the
# line contains; the id is what the engine's conflict and enabler rules look for.
FLAG_PHRASES = [
    ("critical strikes do not deal extra damage", "noCritDamage"),
    ("never deal critical strikes", "neverCrit"),
    ("cannot deal critical strikes", "neverCrit"),
    ("ailments never count as being from critical strikes", "minor"),
    ("maximum life becomes 1", "chaosInoculation"),
    ("immune to chaos damage", "chaosImmune"),
    ("cannot evade enemy attacks", "noEvasion"),
    ("cannot recharge energy shield", "noEsRecharge"),
    ("removes all energy shield", "noEnergyShield"),
    ("ignore attribute requirements", "ignoreAttributes"),
    ("cannot ignite, chill, freeze or shock", "noElementalAilments"),
    ("damage is taken from mana before life", "mindOverMatter"),
    ("of damage is taken from mana before life", "mindOverMatter"),
    ("of damage taken from mana before life", "mindOverMatter"),
    ("your hits can't be evaded", "neverMiss"),
    ("hits can't be evaded", "neverMiss"),
    ("your hits can not be evaded", "neverMiss"),
    ("all damage from hits with this weapon can poison", "poisonEnabler"),
    ("cannot be stunned", "stunImmune"),
    ("spell skills cannot deal critical strikes", "neverCritSpells"),
    ("auras from your skills do not affect allies", "minor"),
    ("supported auras do not affect you", "minor"),
    ("you can have an additional curse", "extraCurse"),
    ("can apply an additional curse", "extraCurse"),
    ("summon two totems instead of one", "extraTotem"),
    ("your maximum number of summoned totems", "extraTotem"),
    ("deal no physical damage", "noPhysical"),
    ("deal no non-fire damage", "onlyFire"),
    ("deal no non-cold damage", "onlyCold"),
    ("deal no non-lightning damage", "onlyLightning"),
    ("deal no elemental damage", "noElemental"),
    ("deal no chaos damage", "noChaos"),
    ("life leech is instant", "instantLeech"),
    ("energy shield recharge is not interrupted", "constantRecharge"),
    ("do not inherit", "minor"),
    ("projectiles pierce all", "pierceAll"),
    ("fire an additional projectile", "extraProjectile"),
    ("modifiers to maximum fire resistance also apply", "maxResSync"),
    ("cannot be frozen", "freezeImmune"),
    ("cannot be shocked", "shockImmune"),
    ("cannot be ignited", "igniteImmune"),
    ("cannot be chilled", "chillImmune"),
    ("cannot be poisoned", "poisonImmune"),
    ("cannot be inflicted with bleeding", "bleedImmune"),
    ("totems cannot be stunned", "minor"),
]

# Ailments and charges in "N% chance to X" lines.
CHANCE_OBJECTS = [
    ("ignite", "ignite"),
    ("freeze", "freeze"),
    ("shock", "shock"),
    ("chill", "chill"),
    ("poison", "poison"),
    ("cause bleeding", "bleed"),
    ("inflict bleeding", "bleed"),
    ("bleed", "bleed"),
    ("blind", "blind"),
    ("maim", "maim"),
    ("impale", "impale"),
    ("hinder", "hinder"),
    ("intimidate", "intimidate"),
    ("double damage", "doubleDamage"),
    ("deal double damage", "doubleDamage"),
    ("gain a power charge", "powerCharge"),
    ("gain a frenzy charge", "frenzyCharge"),
    ("gain an endurance charge", "enduranceCharge"),
    ("gain onslaught", "onslaught"),
    ("avoid", "avoid"),
    ("suppress spell damage", "suppress"),
    ("block", "block"),
    ("knock", "minor"),
    ("flee", "minor"),
    ("stun", "minor"),
]


# ---------- the grammar ----------
def phrase_tags(phrase):
    """Scope tags in a phrase, plus the words nothing recognised (to judge how well the phrase was read)."""
    rest = " " + phrase.lower() + " "
    tags = []
    for words, phrase_tag_list in sorted(TAG_PHRASES, key=lambda entry: -len(entry[0])):
        pattern = r"(?<![a-z-])" + re.escape(words) + r"(?![a-z])"
        if re.search(pattern, rest):
            rest = re.sub(pattern, " ", rest)
            for tag in phrase_tag_list:
                if tag not in tags:
                    tags.append(tag)
    leftover = []
    for word in rest.split():
        if re.fullmatch(r"[\W\d]*", word):
            continue
        leftover.append(word)
    return tags, leftover


def phrase_stat(phrase):
    """(stat, phrase without the stat words). The longest stat phrase found wins."""
    lowered = phrase.lower()
    best = None
    for words, stat in STAT_PHRASES:
        position = lowered.find(words)
        if position < 0:
            continue
        if best is None or len(words) > len(best[0]):
            best = (words, stat, position)
    if best is None:
        return None, phrase
    words, stat, position = best
    remaining = phrase[:position] + " " + phrase[position + len(words):]
    if words == "damage over time":
        remaining = remaining + " damage over time"
    return stat, remaining


def split_subject(line):
    """Who the line is about, and the line without that part."""
    patterns = [
        (r"^Supported Skills (?:have |deal |gain |are |fire |can )?", "supported"),
        (r"^Supported (Spells|Attacks|Skills) ", "supported"),
        (r"^Minions from Supported Skills (?:have |deal |gain )?", "minion"),
        (r"^Minions (?:have |deal |gain |are )?", "minion"),
        (r"^Your Minions (?:have |deal )?", "minion"),
        (r"^Totems (?:have |deal |gain )?", "totem"),
        # What enemies deal is about your defence, what they take or have is about your offence.
        (r"^Nearby Enemies deal ", "enemyDealt"),
        (r"^Enemies [^,]*? deal ", "enemyDealt"),
        (r"^Nearby Enemies (?:have |take )?", "enemy"),
        (r"^Enemies [^,]*? (?:have |take )", "enemy"),
    ]
    for pattern, subject in patterns:
        match = re.match(pattern, line)
        if match:
            remainder = line[match.end():]
            if subject == "supported" and match.groups():
                remainder = match.group(1) + " " + remainder
            return subject, remainder
    if re.search(r"\bwith Supported Skills\b|\bfrom Supported Skills\b|\bby Supported Skills\b", line):
        return "supported", line
    return "self", line


def split_condition(text):
    """Pulls weapon requirements and conditions out of the line. Returns (core text, requires, condition)."""
    requires = []
    lowered = text.lower()
    weapon_clause = re.search(r"\s+while (?:you are )?(?:wielding|holding) (.+?)$", lowered)
    if weapon_clause:
        weapon_words = weapon_clause.group(1)
        for words, tags in WEAPON_REQUIREMENTS:
            if weapon_words.startswith(words):
                requires = list(tags)
                text = text[:weapon_clause.start()]
                lowered = text.lower()
                break
    if re.search(r"\s+while dual wielding$", lowered):
        requires = ["dualWield"]
        text = re.sub(r"\s+while dual wielding$", "", text, flags=re.IGNORECASE)
        lowered = text.lower()
    # "while affected by Hatred" holds exactly when the build runs that aura (or herald): the engine checks the build's
    # auras. "while affected by a Guard Skill" names no skill and goes through the phrase table below.
    affected = re.search(r"\s+while affected by (?!a |an |any |your )([A-Z][\w']*(?: (?:of )?[A-Z][\w']*)*)$", text)
    if affected:
        return text[:affected.start()], requires, "affectedBy:" + affected.group(1)
    # "+15% Chance to Block Attack Damage from Cursed Enemies": a defence against some enemies only.
    from_enemies = re.search(r"\s+from (\w+) Enemies$", text, flags=re.IGNORECASE)
    if from_enemies:
        return text[:from_enemies.start()], requires, condition_of_clause(from_enemies.group(1))
    clause = re.search(r"\s+(while|if|when|during|against|on|for each|per|after|to enemies that|for \d+ seconds)\b(.*)$",
                       text, flags=re.IGNORECASE)
    if clause is None:
        return text, requires, None
    clause_text = clause.group(0).lower()
    condition = negated_condition(clause_text)
    if condition is None:
        condition = "other"
        for words, condition_id in CONDITION_PHRASES:
            if words in clause_text:
                condition = condition_id
                break
    if clause.group(1).lower() == "on" and re.match(r"\s+on (hit|kill)", clause_text) is None:
        # "Damage on Kill" style is handled above; "Adds X to Y Damage to Spells and Attacks on ..." is rare.
        pass
    return text[:clause.start()], requires, condition


def effect(kind, stat, tags, value, subject, condition, requires):
    return {"kind": kind, "stat": stat, "tags": tags, "value": value, "subject": subject,
            "condition": condition, "requires": requires}


def read_flag(line, subject):
    lowered = line.lower()
    for words, flag in FLAG_PHRASES:
        if words in lowered:
            if flag == "minor":
                return effect("minor", "minor", [], None, subject, None, [])
            return effect("flag", flag, [], None, subject, None, [])
    return None


def read_grant_or_trigger(line, subject, range_mode):
    match = re.match(r"^Grants (?:Level (" + VALUE + r") )?(.+?)(?: Skill)?$", line)
    if match and not re.search(r"\b(Life|Mana|Charge|Onslaught|Armour|Evasion)\b", match.group(2)):
        level = read_value(match.group(1), range_mode) if match.group(1) else None
        name = re.sub(r"^Skill:\s*", "", match.group(2))
        return effect("grants", name, [], level, subject, None, [])
    match = re.match(r"^Trigger (?:a Socketed |Level (" + VALUE + r") )?(.+?)(?: when | on | every |$)", line)
    if match:
        name = match.group(2).strip()
        return effect("trigger", name, [], None, subject, None, [])
    return None


def read_numeric(core, subject, condition, requires, range_mode):
    """The patterns with a number in them. Returns an effect, or None when no pattern fits."""
    patterns = [
        (r"^(" + VALUE + r")% (increased|reduced) (.+)$", "increased"),
        (r"^(" + VALUE + r")% (more|less) (.+)$", "more"),
        (r"^(?:deal |have )?(" + VALUE + r")% (more|less) (.+)$", "more"),
    ]
    for pattern, kind in patterns:
        match = re.match(pattern, core, flags=re.IGNORECASE)
        if match is None:
            continue
        value = read_value(match.group(1), range_mode)
        if match.group(2).lower() in ("reduced", "less"):
            value = -value
        stat, remaining = phrase_stat(match.group(3))
        if stat is None:
            return None
        tags, leftover = phrase_tags(remaining)
        found = effect(kind, stat, tags, value, subject, condition, requires)
        found["leftover"] = leftover
        return found

    match = re.match(r"^(?:Adds |have )?(" + VALUE + r") to (" + VALUE + r") (?:added )?(Physical|Fire|Cold|Lightning|Chaos) Damage(.*)$",
                     core, flags=re.IGNORECASE)
    if match:
        average = (read_value(match.group(1), range_mode) + read_value(match.group(2), range_mode)) / 2
        tags, leftover = phrase_tags(match.group(3) + " " + match.group(4))
        return effect("added", "damage", tags, average, subject, condition, requires)

    match = re.match(r"^\+?(" + VALUE + r") to Level of (?:all )?(.*?)(?:Skill )?Gems$", core, flags=re.IGNORECASE)
    if match:
        tags, leftover = phrase_tags(match.group(2))
        socketed = "socketed" in match.group(2).lower()
        found = effect("level", "gemLevel", tags, read_value(match.group(1), range_mode), subject, condition, requires)
        if socketed:
            found["socketed"] = True
            leftover = [word for word in leftover if word != "socketed"]
        if leftover:
            # "+5 to Level of all Cyclone Gems": the words nothing recognised name one skill, which alone gains it.
            found["skill"] = " ".join(match.group(2).split()).replace(" Skill", "").strip()
        return found

    match = re.match(r"^\+?(" + VALUE + r")% to (?:all )?maximum (.*?)Resistances?$", core, flags=re.IGNORECASE)
    if match:
        tags, leftover = phrase_tags(match.group(2))
        return effect("flat", "maxResistance", tags, read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^\+?(" + VALUE + r")% to (?:all )?(.*?)Resistances?$", core, flags=re.IGNORECASE)
    if match:
        tags, leftover = phrase_tags(match.group(2))
        kind = "exposure" if subject == "enemy" else "resistance"
        return effect(kind, "resistance", tags, read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^(?:.*? )?Penetrates? (" + VALUE + r")% (?:of )?(?:Enemy )?(.*?)Resistances?$", core, flags=re.IGNORECASE)
    if match:
        tags, leftover = phrase_tags(match.group(2))
        prefix_tags, prefix_leftover = phrase_tags(core.split("Penetrat")[0])
        for tag in prefix_tags:
            if tag not in tags and tag not in ("fire", "cold", "lightning", "elemental", "physical", "chaos"):
                tags.append(tag)
        return effect("penetration", "resistance", tags, read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^(" + VALUE + r")% of (.*?)Damage (?:is )?Converted to (.*?)Damage$", core, flags=re.IGNORECASE)
    if match:
        source, _ = phrase_tags(match.group(2))
        target, _ = phrase_tags(match.group(3))
        found = effect("conversion", "damage", target, read_value(match.group(1), range_mode), subject, condition, requires)
        found["from"] = source
        return found

    match = re.match(r"^(?:Gain |Gains? )?(" + VALUE + r")% of (.*?)Damage (?:as Extra|Gained as Extra|as extra) (.*?)Damage$", core, flags=re.IGNORECASE)
    if match:
        source, _ = phrase_tags(match.group(2))
        target, _ = phrase_tags(match.group(3))
        found = effect("extra", "damage", target, read_value(match.group(1), range_mode), subject, condition, requires)
        found["from"] = source
        return found

    match = re.match(r"^(" + VALUE + r")% of (.*?)Damage taken as (.*?)Damage$", core, flags=re.IGNORECASE)
    if match:
        return effect("flat", "damageTakenAs", [], read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^\+?(" + VALUE + r")% (?:to )?(?:Global )?(.*?)Critical Strike Multiplier(.*)$", core, flags=re.IGNORECASE)
    if match:
        # "+10% to Melee Critical Strike Multiplier": the words before name the scope, those after it too.
        tags, leftover = phrase_tags(match.group(2) + " " + match.group(3))
        found = effect("flat", "critMulti", tags, read_value(match.group(1), range_mode), subject, condition, requires)
        found["leftover"] = leftover
        return found

    match = re.match(r"^\+?(" + VALUE + r")% to (?:Global )?Critical Strike Chance(.*)$", core, flags=re.IGNORECASE)
    if match:
        tags, leftover = phrase_tags(match.group(2))
        return effect("flat", "baseCrit", tags, read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^\+?(" + VALUE + r")% (?:Chance to Block|chance to Block) (Spell )?(?:Attack )?Damage(.*)$", core, flags=re.IGNORECASE)
    if match:
        stat = "spellBlock" if match.group(2) else "block"
        return effect("flat", stat, [], read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^\+?(" + VALUE + r")% Chance to Block$", core, flags=re.IGNORECASE)
    if match:
        return effect("flat", "block", [], read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^\+?(" + VALUE + r")% chance to Suppress Spell Damage$", core, flags=re.IGNORECASE)
    if match:
        return effect("flat", "suppress", [], read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^\+?(" + VALUE + r")% chance to (.+)$", core, flags=re.IGNORECASE)
    if match:
        object_text = match.group(2).lower()
        for words, chance_object in CHANCE_OBJECTS:
            if words in object_text:
                if chance_object == "minor":
                    return effect("minor", "minor", [], None, subject, condition, requires)
                return effect("chance", chance_object, [], read_value(match.group(1), range_mode), subject, condition, requires)
        return effect("chance", "other", [], read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^\+?(" + VALUE + r") to maximum number of (.+)$", core, flags=re.IGNORECASE)
    if match:
        tags, leftover = phrase_tags(match.group(2))
        what = "totems" if "totem" in match.group(2).lower() else "minions"
        return effect("limit", what, tags, read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^\+?(" + VALUE + r") to Maximum (Power|Frenzy|Endurance) Charges?$", core, flags=re.IGNORECASE)
    if match:
        return effect("limit", match.group(2).lower() + "Charges", [], read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^(?:Supported Skills )?(?:fire |Skills fire )?\+?(" + VALUE + r") additional Projectiles?$", core, flags=re.IGNORECASE)
    if match:
        return effect("flat", "projectiles", ["projectile"], read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^Regenerate (" + VALUE + r")(%)? (?:of )?(Life|Mana|Energy Shield) per second$", core, flags=re.IGNORECASE)
    if match:
        # "Regenerate 2% of Life per second" and "Regenerate 100 Life per second" are different stats: the first
        # grows with the pool, the second is small at endgame.
        stat = {"life": "lifeRegen", "mana": "manaRegen", "energy shield": "esRegen"}[match.group(3).lower()]
        if not match.group(2):
            stat = stat + "Flat"
        return effect("flat", stat, [], read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^(" + VALUE + r")% of (.*?)Damage (?:is )?Leeched as (Life|Mana|Energy Shield)$", core, flags=re.IGNORECASE)
    if match:
        # Overkill leech only recovers on a kill: it doesn't keep you alive or casting in a fight.
        if "overkill" in match.group(2).lower():
            return effect("minor", "minor", [], None, subject, condition, requires)
        if match.group(3).lower() == "mana":
            # Mana leech pays for skills. Its scope matters: "Physical Attack Damage" leeches nothing for a spell or
            # for an attack that deals no physical damage, so the damage type and attack/spell words are kept as tags.
            tags, leftover = phrase_tags(match.group(2))
            found = effect("flat", "manaLeech", tags, read_value(match.group(1), range_mode), subject, condition, requires)
            if leftover:
                found["leftover"] = leftover
            return found
        return effect("flat", "leech", [], read_value(match.group(1), range_mode), subject, condition, requires)

    # Mana gained per hit or per kill, which pays for skills as they are used.
    match = re.match(r"^(?:Gain|\+)?\s*(" + VALUE + r") Mana (?:per Enemy Hit|gained for each Enemy hit|gained on Hit)( with Attacks| with Spells| by your Attacks| by your Spells)?$", core, flags=re.IGNORECASE)
    if match:
        scope = (match.group(2) or "").lower()
        tags = ["attack"] if "attack" in scope else ["spell"] if "spell" in scope else []
        return effect("flat", "manaOnHit", tags, read_value(match.group(1), range_mode), subject, condition, requires)
    match = re.match(r"^(?:Gain|\+)?\s*(" + VALUE + r") Mana (?:per Enemy Killed|gained on Kill|on Kill)$", core, flags=re.IGNORECASE)
    if match:
        return effect("flat", "manaOnKill", [], read_value(match.group(1), range_mode), subject, condition, requires)
    match = re.match(r"^Recover (" + VALUE + r")% of (?:maximum )?Mana (?:on Kill|when you Kill an Enemy)$", core, flags=re.IGNORECASE)
    if match:
        return effect("flat", "manaOnKillPercent", [], read_value(match.group(1), range_mode), subject, condition, requires)

    match = re.match(r"^\+?(" + VALUE + r") to (.+)$", core, flags=re.IGNORECASE)
    if match:
        stat, remaining = phrase_stat(match.group(2))
        if stat is None:
            return None
        tags, leftover = phrase_tags(remaining)
        found = effect("flat", stat, tags, read_value(match.group(1), range_mode), subject, condition, requires)
        found["leftover"] = leftover
        return found

    match = re.match(r"^(?:Recover|Gain) (" + VALUE + r")(%)? (?:of )?(?:your )?(?:maximum )?(Life|Mana|Energy Shield)(?: per| on| when)(.*)$", core, flags=re.IGNORECASE)
    if match:
        if match.group(3).lower() == "mana":
            # Mana regained this way pays for skills; it was once read as life recovery (2026-11-13).
            if "kill" in match.group(4).lower():
                stat = "manaOnKillPercent" if match.group(2) else "manaOnKill"
                return effect("flat", stat, [], read_value(match.group(1), range_mode), subject, condition, requires)
            return effect("minor", "minor", [], None, subject, condition, requires)
        return effect("flat", "recovery", [], read_value(match.group(1), range_mode), subject, condition, requires)

    return None


# Buffs whose own effects ascendancies and items extend: "Arcane Surge also grants 20% more Spell Damage".
BUFF_NAMES = ["Arcane Surge", "Onslaught", "Tailwind", "Elusive", "Fortification", "Fortify", "Rage", "Unholy Might",
              "Phasing", "Adrenaline", "Gale Force", "Valour", "Combat Rush", "Feeding Frenzy", "Infusion",
              "Resolute Technique", "Bulwark", "Divine Guidance", "Convergence", "Elemental Overload"]


def camel_case(words):
    parts = re.findall(r"[A-Za-z]+", words)
    if not parts:
        return "other"
    text = parts[0].lower()
    for part in parts[1:]:
        text += part[:1].upper() + part[1:].lower()
    return text


def read_leading_clause(line, range_mode):
    """Lines that start with their condition: "If you've Cast a Spell Recently, ...", "Every 4 seconds, ...",
    "While Channelling, ..." and buff riders such as "Arcane Surge also grants ..."."""
    match = re.match(r"^(If|While|When|During|Every \d+(?:\.\d+)? seconds?)(.*?), (.+)$", line)
    if match:
        inner = read_line(match.group(3), range_mode)
        if inner.get("understood"):
            clause = (match.group(1) + match.group(2)).lower()
            condition = "periodic" if clause.startswith("every") else "other"
            for words, condition_id in CONDITION_PHRASES:
                if words in clause:
                    condition = condition_id
                    break
            inner["condition"] = condition
            return inner
    for buff in BUFF_NAMES:
        match = re.match(r"^" + re.escape(buff) + r" (?:also )?grants (?:you )?(.+?)(?: to you)?$", line)
        if match:
            inner = read_line(match.group(1), range_mode)
            if inner.get("understood"):
                inner["condition"] = camel_case(buff)
                return inner
    return None


def condition_of_clause(clause):
    """The condition id of a trailing clause ("while affected by a Guard Skill", "per Endurance Charge"); None
    when there is no clause."""
    clause = (clause or "").strip().lower()
    if not clause:
        return None
    negated = negated_condition(clause)
    if negated is not None:
        return negated
    padded = " " + clause + " "
    for words, condition_id in CONDITION_PHRASES:
        if words in padded:
            return condition_id
    return "other"


def read_special_shapes(line, subject, range_mode):
    """Sentence shapes that aren't "number + stat": damage reduction, recoup, "All Damage can Ignite", effects of
    named buffs and ailments."""
    # "Every 4 seconds, Regenerate 10% of Life over one second": a burst, which over a fight averages its percent
    # divided by the period (2.5% a second). It was read as 10% a second.
    match = re.match(r"^Every (" + VALUE + r") seconds?, Regenerate (" + VALUE + r")% of (Life|Energy Shield|Mana) over one second$", line, flags=re.IGNORECASE)
    if match:
        average = read_value(match.group(2), range_mode) / max(1.0, read_value(match.group(1), range_mode))
        stats = {"life": "lifeRegen", "energy shield": "esRegen", "mana": "minor"}
        stat = stats[match.group(3).lower()]
        if stat == "minor":
            return effect("minor", "minor", [], None, subject, None, [])
        return effect("flat", stat, [], average, subject, None, [])
    # Flask charge generation ("Flasks gain 3 Charges every 3 seconds") keeps utility flasks up: charges a second.
    match = re.match(r"^Flasks gain (" + VALUE + r") Charges? every (" + VALUE + r") seconds?$", line, flags=re.IGNORECASE)
    if match:
        per_second = read_value(match.group(1), range_mode) / max(0.1, read_value(match.group(2), range_mode))
        return effect("flat", "flaskChargesPerSecond", [], per_second, subject, None, [])
    match = re.match(r"^(?:Magic Utility )?Flasks applied to you have (" + VALUE + r")% increased Effect$", line, flags=re.IGNORECASE)
    if match:
        return effect("increased", "flaskEffect", [], read_value(match.group(1), range_mode), subject, None, [])
    match = re.match(r"^(" + VALUE + r")% additional (Physical|Elemental) Damage Reduction(.*)$", line, flags=re.IGNORECASE)
    if match:
        stat = match.group(2).lower() + "Reduction"
        return effect("flat", stat, [], read_value(match.group(1), range_mode), subject, condition_of_clause(match.group(3)), [])
    match = re.match(r"^(" + VALUE + r")% of (.*?)Damage taken Recouped as (Life|Mana|Energy Shield)(.*)$", line, flags=re.IGNORECASE)
    if match:
        condition = condition_of_clause(match.group(4))
        # Recouped as mana refills mana, not the pool that keeps you alive (Timeclasp has both).
        if match.group(3).lower() == "mana":
            return effect("minor", "minor", [], None, subject, condition, [])
        return effect("flat", "recoup", [], read_value(match.group(1), range_mode), subject, condition, [])
    match = re.match(r"^All Damage (?:from Hits |with Hits )?can (Ignite|Shock|Chill|Freeze|Poison)$", line, flags=re.IGNORECASE)
    if match:
        return effect("flag", "allDamageCan" + match.group(1).capitalize(), [], None, subject, None, [])
    # "Anger has 20% increased Aura Effect": that one aura's effect (the engine scales its lines).
    match = re.match(r"^([A-Z][\w']*(?: (?:of )?[A-Z][\w']*)*) has (" + VALUE + r")% (increased|reduced) Aura Effect$", line)
    if match:
        value = read_value(match.group(2), range_mode)
        if match.group(3) == "reduced":
            value = -value
        found = effect("increased", "effect:aura", [], value, subject, None, [])
        found["skill"] = match.group(1)
        return found
    match = re.match(r"^(" + VALUE + r")% (increased|reduced) (?:Effect of (?:your )?(.+?)|(.+?) Effect)( on you)?(?: per (.+))?$",
                     line, flags=re.IGNORECASE)
    if match:
        what = match.group(3) or match.group(4)
        value = read_value(match.group(1), range_mode)
        if match.group(2).lower() == "reduced":
            value = -value
        condition = "perStack" if match.group(6) else None
        stat = "effect:" + camel_case(what)
        # What enemies put on you ("Effect of Curses on you", "Ailments on you") is a defence of its own, not the
        # effect of your own curses: both were read as effect:curses (found 2026-11-12).
        if match.group(5) and re.search(r"curse|ailment|chill|shock|freeze|ignite|poison|bleed|hex|mark", what, flags=re.IGNORECASE):
            stat += "OnYou"
        return effect("increased", stat, [], value, subject, condition, [])
    match = re.match(r"^\+?(" + VALUE + r")% to (.*?)Damage over Time Multiplier(.*)$", line, flags=re.IGNORECASE)
    if match:
        tags, leftover = phrase_tags(match.group(2) + " " + match.group(3))
        condition = "onCrit" if "critical" in match.group(3).lower() else None
        return effect("flat", "dotMulti", tags, read_value(match.group(1), range_mode), subject, condition, [])
    match = re.match(r"^(?:(.*?)(?:you inflict|inflicted with Supported Skills)? )?(?:deals? )?Damage (" + VALUE + r")% faster$", line, flags=re.IGNORECASE)
    if match:
        tags, leftover = phrase_tags(match.group(1) or "")
        return effect("more", "ailmentSpeed", tags, read_value(match.group(2), range_mode), subject, None, [])
    match = re.match(r"^\+?(" + VALUE + r") to Minimum (Power|Frenzy|Endurance) Charges", line, flags=re.IGNORECASE)
    if match:
        return effect("limit", "minimum" + match.group(2).capitalize() + "Charges", [], read_value(match.group(1), range_mode), subject, None, [])
    match = re.match(r"^\+?(" + VALUE + r")% to maximum Chance to Block (Spell |Attack )?Damage", line, flags=re.IGNORECASE)
    if match:
        stat = "maxSpellBlock" if match.group(2) and match.group(2).strip().lower() == "spell" else "maxBlock"
        return effect("flat", stat, [], read_value(match.group(1), range_mode), subject, None, [])
    match = re.match(r"^(" + VALUE + r")% faster start of Energy Shield Recharge", line, flags=re.IGNORECASE)
    if match:
        return effect("increased", "esRechargeStart", [], read_value(match.group(1), range_mode), subject, None, [])
    match = re.match(r"^(" + VALUE + r")% increased Defences from Equipped Shield", line, flags=re.IGNORECASE)
    if match:
        return effect("increased", "shieldDefences", ["shield"], read_value(match.group(1), range_mode), subject, None, ["shield"])
    match = re.match(r"^Hits (?:have|from Supported Skills have) (" + VALUE + r")% chance to ignore Enemy Physical Damage Reduction", line, flags=re.IGNORECASE)
    if match:
        return effect("chance", "ignoreArmour", ["physical"], read_value(match.group(1), range_mode), subject, None, [])
    match = re.match(r"^Socketed (?:Gems|Skill Gems|Spells|Attacks|[\w ]+?Gems) (?:are|have) Supported by Level (" + VALUE + r") (.+?)(?: Support)?$", line, flags=re.IGNORECASE)
    if match:
        found = effect("socketedSupport", match.group(2).strip(), [], read_value(match.group(1), range_mode), subject, None, [])
        return found
    match = re.match(r"^(?:Grants|Gain) (" + VALUE + r") (Life|Mana|Energy Shield) (?:per|for each) Enemy (?:Hit|you Hit)( with Attacks| with Spells)?", line, flags=re.IGNORECASE)
    if match:
        if match.group(2).lower() == "mana":
            # Mana on hit pays for skills, it doesn't recover life (it was read as life on hit until 2026-11-13).
            scope = (match.group(3) or "").lower()
            tags = ["attack"] if "attack" in scope else ["spell"] if "spell" in scope else []
            return effect("flat", "manaOnHit", tags, read_value(match.group(1), range_mode), subject, None, [])
        return effect("flat", "onHitRecovery", [], read_value(match.group(1), range_mode), subject, None, [])
    match = re.match(r"^(" + VALUE + r")% increased Global Defences$", line, flags=re.IGNORECASE)
    if match:
        return effect("increased", "defences", [], read_value(match.group(1), range_mode), subject, None, [])
    # "as Extra Maximum Energy Shield" adds energy shield and keeps the life; "Converted to Energy Shield" moves that
    # share of life into energy shield (Ghostwrithe). Both read as the first, so conversion doubled half the pool.
    match = re.match(r"^(?:Gain )?(" + VALUE + r")% of Maximum Life as Extra Maximum Energy Shield$", line, flags=re.IGNORECASE)
    if match:
        return effect("flat", "lifeToEnergyShield", [], read_value(match.group(1), range_mode), subject, None, [])
    match = re.match(r"^(" + VALUE + r")% of Maximum Life Converted to Energy Shield$", line, flags=re.IGNORECASE)
    if match:
        return effect("flat", "lifeConvertedToEnergyShield", [], read_value(match.group(1), range_mode), subject, None, [])
    match = re.match(r"^(.*?)(?:Attacks |Skills )?fire (" + VALUE + r") additional (?:Arrows|Projectiles)$", line, flags=re.IGNORECASE)
    if match:
        tags, leftover = phrase_tags(match.group(1))
        if "projectile" not in tags:
            tags.append("projectile")
        return effect("flat", "projectiles", tags, read_value(match.group(2), range_mode), subject, None, [])
    match = re.match(r"^Gain (" + VALUE + r")% of (?:Weapon )?(.*?)Damage as Extra Damage of (?:a random Element|each Element)", line, flags=re.IGNORECASE)
    if match:
        found = effect("extra", "damage", ["elemental"], read_value(match.group(1), range_mode), subject, None, [])
        found["from"], _ = phrase_tags(match.group(2))
        return found
    match = re.match(r"^\+?(" + VALUE + r") metres? to (?:Melee Strike Range|Weapon Range)", line, flags=re.IGNORECASE)
    if match:
        return effect("minor", "minor", [], None, subject, None, [])
    match = re.match(r"^Can Allocate Passives from the (\w+)'s starting point$", line)
    if match:
        return effect("flag", "startFrom" + match.group(1), [], None, subject, None, [])
    match = re.match(r"^(" + VALUE + r")% of (Physical|Elemental|Fire|Cold|Lightning) Damage from Hits taken as (.+?) Damage$", line, flags=re.IGNORECASE)
    if match:
        return effect("flat", "damageTakenAs", [], read_value(match.group(1), range_mode), subject, None, [])
    match = re.match(r"^(" + VALUE + r")% of (Armour|Evasion Rating) also applies to (.+)$", line, flags=re.IGNORECASE)
    if match:
        return effect("flat", "armourAppliesMore", [], read_value(match.group(1), range_mode), subject, None, [])
    return None


# A unique flask's lines hold while it is up: "10% increased Attack Speed during Effect". The "increased ... Effect"
# shape used to swallow them into a made-up stat (effect:attackSpeedDuring) the engine never used. The line without
# its last words is read as usual, under the flask condition unless it has a condition of its own ("against Enemies
# on Consecrated Ground during Effect"). Found by scripts/check_against_pob.py.
DURING_FLASK_PATTERN = re.compile(r"^(.+?) during (?:any )?(?:Flask )?Effect$", re.IGNORECASE)


def read_during_flask_effect(line, range_mode):
    match = DURING_FLASK_PATTERN.match(line.strip())
    if match is None:
        return None
    inner = read_line(match.group(1), range_mode)
    if not inner.get("understood") or inner.get("kind") in ("unknown", "minor"):
        return None
    if not inner.get("condition"):
        inner["condition"] = "flask"
    return inner


def with_trailing_condition(special, line, subject, range_mode):
    """A special shape matches the start of a line and ignored any condition after it: "+10% to Damage over Time
    Multiplier if you've Killed Recently" was read as always on. When the line without its trailing condition clause
    still reads as the same stat and value, that clause is the effect's condition (and the cleaner reading, without
    the clause's words, is kept). When it doesn't ("Grants 10 Life per Enemy Hit": the "per" belongs to the stat),
    the shape is left as it was."""
    if special.get("condition") or special.get("requires"):
        return special
    core, requires, condition = split_condition(line)
    if condition is None and not requires:
        return special
    # "on you" says who has it ("Effect of Herald Buffs on you"), not when it holds.
    if line[len(core):].strip().lower() in ("on you", "to you"):
        return special
    core_special = read_special_shapes(core.strip(), subject, range_mode)
    if core_special is None:
        return special
    if core_special.get("stat") != special.get("stat") or core_special.get("value") != special.get("value"):
        return special
    core_special["condition"] = condition
    core_special["requires"] = requires
    return core_special


def effect_understood(found):
    found["understood"] = True
    return found


def read_scope_first(core, subject, condition, requires, range_mode):
    """"Axe Attacks deal 10% increased Damage", "Channelling Skills have 20% increased Cast Speed",
    "Attacks used by Totems have ...": a scope phrase, then deal/have/gain, then an ordinary numeric stat. The
    scope's tags join the stat's own tags. Only taken when every word of the scope is a known tag word."""
    match = re.match(r"^(.+?) (?:deal|deals|have|has|gain|gains) ([+\-(\d].*)$", core)
    if match is None:
        return None
    scope_text = re.sub(r"\bused by\b", " ", match.group(1), flags=re.IGNORECASE)
    scope_tags, scope_leftover = phrase_tags(scope_text)
    if scope_leftover:
        return None
    found = read_numeric(match.group(2), subject, condition, requires, range_mode)
    if found is None:
        return None
    for tag in scope_tags:
        if tag not in found["tags"]:
            found["tags"].append(tag)
    return found


# The statements' patterns, compiled once: there are more of them than Python's regex cache holds (512), so
# re.search() with the raw pattern compiled every one again for every line, about 90 ms a line.
COMPILED_STATEMENTS = [(re.compile(pattern, flags=re.IGNORECASE), templates) for pattern, templates in STATEMENTS]


def read_statement(line, range_mode):
    """A line from the hand-written table in mechanics_statements.py, as a list of effects; None when no entry
    matches."""
    for pattern, templates in COMPILED_STATEMENTS:
        match = pattern.search(line)
        if match is None:
            continue
        # A pattern that matches only the start of the line ignored a condition after it ("Prevent +15% of Suppressed
        # Spell Damage while on Full Energy Shield"): such a clause becomes the condition of effects that have none.
        trailing_condition = trailing_clause_condition(line[match.end():])
        effects = []
        for template in templates:
            found = dict(template)
            found["tags"] = list(template.get("tags", []))
            if found.get("value") == "#":
                found["value"] = read_value(match.group(1), range_mode)
            elif isinstance(found.get("value"), str) and found["value"].endswith("#"):
                # "-#" is the number negated ("12% less damage taken" is -12% more), "4*#" four times it (per stage).
                factor_text = found["value"][:-1]
                factor = -1.0 if factor_text == "-" else float(factor_text.rstrip("*"))
                found["value"] = factor * read_value(match.group(1), range_mode)
            if found.get("stat") == "#name":
                found["stat"] = match.group(1)
            found.setdefault("requires", [])
            if trailing_condition and not found.get("condition") and found.get("kind") != "minor":
                found["condition"] = trailing_condition
            found["understood"] = True
            effects.append(found)
        return effects
    return None


TRAILING_CLAUSE_PATTERN = re.compile(r"^\s+(while|if|when|during|against|for each|per)\b", re.IGNORECASE)


def trailing_clause_condition(tail):
    """The condition of what is left of a line after a statement's pattern, when it starts like a condition clause;
    None otherwise."""
    if not tail or TRAILING_CLAUSE_PATTERN.match(tail) is None:
        return None
    _, _, condition = split_condition(tail)
    return condition


# Auras, heralds, banners and curses describe their effect from the outside ("You and nearby allies gain ...",
# "Buff grants ...", "Cursed enemies have ..."). Each pattern rewrites such a line into the words the same stat has
# on your own character, so the rest of the vocabulary reads it as usual. None as the rewrite means the line is
# understood but doesn't matter for a build's power.
BUFF_LINE_REWRITES = [
    (r"^[Yy]ou and nearby [Aa]llies deal (" + VALUE + r") to (" + VALUE + r") additional (\w+) Damage with (Attacks|Spells)$",
     r"Adds \1 to \2 \3 Damage to \4"),
    (r"^Buff grants (" + VALUE + r") to (" + VALUE + r") Added (Attack|Spell) (\w+) Damage$", r"Adds \1 to \2 \4 Damage to \3s"),
    (r"^[Yy]ou and nearby [Aa]llies gain (" + VALUE + r") additional (Armour|Evasion Rating)$", r"+\1 to \2"),
    (r"^[Yy]ou and nearby [Aa]llies gain (" + VALUE + r") additional Energy Shield$", r"+\1 to maximum Energy Shield"),
    (r"^[Yy]ou and nearby [Aa]llies gain (" + VALUE + r")% additional (maximum )?(\w+) Resistance$", r"+\1% to \2\3 Resistance"),
    (r"^[Yy]ou and nearby [Aa]llies (Regenerate) ", r"\1 "),
    (r"^(?:[Yy]ou and nearby [Aa]llies|You) (?:have|deal|gain) ", ""),
    (r"^Buff [Gg]rants ", ""),
    (r"^Banner grants (.+) to You and Allies$", r"\1"),
    (r"^Hits against Cursed Enemies have ", ""),
    # The generator measures against a map boss, which is rare or unique, so the normal-and-magic half of a
    # curse (Enfeeble's larger reduction) doesn't apply and the rare-or-unique half does.
    (r"^Cursed Normal or Magic enemies ", None),
    (r"^Cursed (?:Rare or Unique )?enemies (have|deal|take) ", r"Nearby Enemies \1 "),
]


# 3.30 rewords "nearby" as an exact range ("Inflict Barnacles on Enemies within 5 metres"; GGG's patch notes, 3.30.0
# General Changes): only the description changed, not the range. The range doesn't matter to a build's power, so
# these phrasings are folded back into the "nearby" wording the rest of the vocabulary reads.
METRE_RANGE = r"within " + VALUE + r" metres?"
NEARBY_REWRITES = [
    (r"^[Yy]ou and (?:your )?[Aa]llies " + METRE_RANGE + r" (?:of you )?", "You and nearby allies "),
    (r"^Enemies " + METRE_RANGE + r" (?:of you )?", "Nearby Enemies "),
    # These two had backspace characters where \b was meant, so they never matched (fixed 2026-11-12).
    (r"\b[Aa]llies " + METRE_RANGE + r"\b", "nearby Allies"),
    (r"\b[Ee]nemies " + METRE_RANGE + r"\b", "nearby Enemies"),
]


def nearby_wording(line):
    """The line with an exact range ("within 4 metres") put back as "nearby"."""
    for pattern, replacement in NEARBY_REWRITES:
        line = re.sub(pattern, replacement, line, count=1)
    return line


def is_buff_line(line):
    """Whether a line of an aura, herald, banner or curse gem describes what the buff or curse does to you or the
    enemy, rather than the skill's own damage, duration or minions."""
    line = nearby_wording(line)
    for pattern, rewrite in BUFF_LINE_REWRITES:
        if pattern.startswith("^(?:[Yy]ou and nearby [Aa]llies|You)") and re.match(r"^You (?:have|deal|gain) ", line):
            continue  # "You gain ..." on a buff gem is about the caster, often a cost; only ally-wide lines count
        if re.match(pattern, line):
            return True
    return False


def own_wording_of_buff_line(line):
    """(the line in a character's own wording, whether it came from a curse). The line is None when it doesn't
    matter for a build's power; a line no pattern fits comes back unchanged."""
    for pattern, rewrite in BUFF_LINE_REWRITES:
        match = re.match(pattern, line)
        if match is None:
            continue
        from_curse = pattern.startswith("^Cursed") or "Cursed Enemies" in pattern
        if rewrite is None:
            return None, from_curse
        return match.expand(rewrite) + line[match.end():], from_curse
    return line, False


def read_enemy_damage_dealt(remainder, range_mode):
    """"Nearby Enemies deal 8% less Elemental Damage": less damage dealt by the enemies around you is less damage
    you take, so it is read as your own damage taken. Any other line about what enemies deal stays unread."""
    core, requires, condition = split_condition(remainder)
    found = read_numeric(core.strip().rstrip("."), "self", condition, requires, range_mode)
    if found is None or found["stat"] != "damage" or found["kind"] not in ("more", "increased") or found.get("leftover"):
        return {"kind": "unknown", "text": remainder, "understood": False}
    found["stat"] = "damageTaken"
    found["understood"] = True
    return found


# Item rarity and quantity don't change a build's power, but the build planner's rarity stage weighs them. Only the
# plain "increased Rarity of Items found" shape is read: a line about items "dropped by" some enemies has a scope
# (shattered, killed with a crit, ...) and stays minor rather than being read as global.
ITEM_FIND_PATTERN = re.compile(r"^(" + VALUE + r")% (increased|reduced) (rarity|quantity) of items found$")
ITEM_FIND_STATS = {"rarity": "itemRarity", "quantity": "itemQuantity"}


def read_item_find(line, range_mode):
    match = ITEM_FIND_PATTERN.match(line.strip().lower())
    if match is None:
        return None
    value = read_value(match.group(1), range_mode)
    if match.group(2) == "reduced":
        value = -value
    found = effect("increased", ITEM_FIND_STATS[match.group(3)], [], value, "self", None, [])
    return effect_understood(found)


def read_line_effects(line, range_mode="roll"):
    """All the effects of one stat line: usually one, several for some hand-written statements."""
    line = nearby_wording(line)
    statement = read_statement(line, range_mode)
    if statement is not None:
        return statement
    return [read_line(line, range_mode)]


def read_line(line, range_mode="roll"):
    """One stat line -> an effect dict with "understood" True/False. Never raises on odd text."""
    line = nearby_wording(line)
    statement = read_statement(line, range_mode)
    if statement is not None:
        return statement[0]
    leading = read_leading_clause(line, range_mode)
    if leading is not None:
        return leading
    item_find = read_item_find(line, range_mode)
    if item_find is not None:
        return item_find
    line, from_curse = own_wording_of_buff_line(line)
    if line is None or is_minor(line):
        return effect_understood(effect("minor", "minor", [], None, "self", None, []))
    subject, remainder = split_subject(line)
    if subject == "enemyDealt":
        return read_enemy_damage_dealt(remainder, range_mode)
    if from_curse:
        found = read_line(line, range_mode)
        # A curse lowers resistance on its own terms: it isn't exposure, which doesn't stack with other exposure.
        if found.get("kind") == "exposure":
            found["kind"] = "resistance"
        return found

    during_flask = read_during_flask_effect(line, range_mode)
    if during_flask is not None:
        return during_flask

    special = read_special_shapes(remainder, subject, range_mode)
    if special is not None:
        special = with_trailing_condition(special, remainder, subject, range_mode)
        special["understood"] = True
        return special

    flag = read_flag(line, subject)
    if flag is not None:
        flag["understood"] = True
        return flag

    granted = read_grant_or_trigger(remainder, subject, range_mode)
    if granted is not None:
        granted["understood"] = True
        return granted

    core, requires, condition = split_condition(remainder)
    core = core.strip().rstrip(".")
    found = read_numeric(core, subject, condition, requires, range_mode)
    if found is None:
        # A condition clause can hide the pattern ("... per Endurance Charge"): try the whole remainder too.
        found = read_numeric(remainder.strip(), subject, None, requires, range_mode)
    if found is None:
        found = read_scope_first(core, subject, condition, requires, range_mode)
    if found is None:
        return {"kind": "unknown", "text": line, "understood": False}
    leftover = found.pop("leftover", [])
    # Any word left over may be the line's real scope ("Damage with Movement Skills"): reading the stat without
    # it would make a narrow line look global, which is worse than not reading it.
    found["understood"] = len(leftover) == 0
    if leftover:
        found["leftover"] = leftover
    if found["stat"] == "minor":
        found["kind"] = "minor"
    return found
