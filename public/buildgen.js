// The Build maker's generator: composes builds from the game's mechanics, the way the crafting planner composes
// crafts from mods. Pure functions over public/data/builds/mechanics-poe1.json, so the same code runs in Node
// (scripts/generate_builds.mjs, the tests) and in the browser.
//
// A build is a main skill, an ascendancy, up to five support gems, ascendancy notables, keystones and a few
// unique items. Each piece carries effects (read from its stat text by scripts/mechanics_vocabulary.py); the
// generator works out which effects reach the main skill and how much they're worth, and keeps the pieces that
// help most. The numbers are indexes for comparing builds with each other, not damage a character would show.
//
// poe.ninja is not an input here: verifyBuild() asks it afterwards whether anyone plays what was generated.
import { prepareTree, planTree, mergeEffects } from './buildtree.js';
import { radiusJewelChoices } from './buildradius.js';
import { prepareGear, solveGear, solveFreedSlots, freesRareSlot, gearEffects, gearRequirements, compactGear, rebuildGear, wornGear, dualWields,
  holdsTwoHandedUnique, weaponsHeld, weaponShareOf, solvedWeaponFactors, REFERENCE_RARE_WEAPON, DEFAULT_GEAR_LEVEL,
  weaponFamilyOf, isTwoHandedWeapon } from './buildgear.js';

// ---------- tuning (each value says what it stands for) ----------
const ENEMY_ELEMENTAL_RESISTANCE = 40; // an endgame map boss or pinnacle-lite enemy
const ENEMY_CHAOS_RESISTANCE = 25;
const BASE_CRIT_MULTIPLIER = 150;
const ATTACK_WEAPON_BASE_CRIT = 6; // a typical endgame weapon base
const MINION_BASE_CRIT = 5;
// Accuracy: an attack lands with chance 1.25 x accuracy / (accuracy + the enemy's evasion term), between 5% and 100%
// (the same formula MONSTER_ACCURACY uses against your evasion). The player's report: 3,500 to 4,000 accuracy is
// usually enough to hit an endgame boss every time, so the term is a quarter of 3,750 (that much lands every hit).
// Spells always land; so do minions (3.2x removed minion accuracy) and hits that can't be evaded (Resolute Technique).
const FULL_HIT_ACCURACY = 3750;
const ENEMY_EVASION_TERM = FULL_HIT_ACCURACY / 4;
const MIN_HIT_CHANCE = 0.05;
// A character's own accuracy: 2 a level (level 92) and 2 for each point of Dexterity.
const CHARACTER_ACCURACY = 2 * 92;
const ACCURACY_PER_DEXTERITY = 2;
const STACKS_ASSUMED = 3; // "per Frenzy Charge", "per Endurance Charge": a build that cares keeps about three
// Rage (3.2x patch notes): each Rage grants 1% more Attack Damage, up to 30, and "increased Rage Effect" scales that.
// A build with a Rage source (a line flagged rageSource) hits often enough to sit near the cap in a fight, but starts
// each pack and boss at 0 and loses 10 a second once it stops hitting, so it counts 25 of the 30.
const MAX_RAGE = 30;
const RAGE_ASSUMED = 25;
// Impale (poewiki): an impaling hit stores 10% of its physical damage, dealt again on each of the next 5 hits, with at
// most 5 Impales on an enemy at once (a sixth replaces the oldest). "increased Impale Effect" scales the 10%.
const IMPALE_STORED_SHARE = 0.1;
// What a bare character has of each defence, for damage that is a share of one (Righteous Fire's base damage is 70%
// of life plus 70% of energy shield): the character's and gear's life (CHARACTER_LIFE + GEAR_LIFE, below) and no
// energy shield. A build's own pool against this is how much more its base damage is.
const REFERENCE_DEFENCE = { life: 1950, energyShield: 0, armour: 0, evasion: 0 };
const IMPALE_HITS = 5;
const MAX_IMPALES = 5;
// Damaging ailments from hits, the game's base rules: each deals this share of the damage of the hit that inflicted it
// per second, for this many seconds. Ignite takes the hit's fire damage, bleeding its physical damage, poison its
// physical and chaos damage. Only the strongest Ignite and the strongest Bleeding on an enemy deal damage; every poison
// does. Critical Strike Multiplier never reaches an ailment's damage. (Checked against Path of Building's constants,
// 2026-11-22; nothing is read from it.)
const AILMENT_RULES = {
  ignite: { damagePerSecond: 0.9, duration: 4, damageTypes: ['fire'], stacks: false },
  bleed: { damagePerSecond: 0.7, duration: 5, damageTypes: ['physical'], stacks: false },
  poison: { damagePerSecond: 0.3, duration: 2, damageTypes: ['physical', 'chaos'], stacks: true },
};
// Bleeding deals more while the enemy moves. Bosses mostly stand and hit back, so the plan counts no moving bonus
// (Aggravated bleeding is a line of its own in scripts/mechanics_statements.py).
// Crimson Dance: up to 8 bleeds on an enemy (GGG's tree text). The 8 are reached only by a build that keeps hitting the
// same enemy faster than the bleeds run out, through boss phases, movement and missed hits, and few do, so a plan
// counts 60% of the bleeds its hit rate could keep up, never more than 8. Our estimate.
const CRIMSON_DANCE_MAX_BLEEDS = 8;
const CRIMSON_DANCE_BLEEDS_KEPT = 0.6;
const MAX_SUPPORTS = 5; // a six-link
// Sockets of each slot on a rare item: a body armour or two-handed weapon has six (the only six-links), a helmet,
// gloves or boots four, a one-handed weapon or shield three, jewellery none. A unique with "Has no Sockets" (Kaom's
// Heart) or "Has 1 Socket" (some rings) has its own count.
const SLOT_SOCKETS = { body: 6, helmet: 4, gloves: 4, boots: 4, weapon: 3, offhand: 3, ring: 0, amulet: 0, belt: 0 };
const TWO_HANDED_SOCKETS = 6;
// Gems besides the main skill and its buffs that every build carries: a movement skill, a guard skill and their
// supports.
const UTILITY_GEMS = 4;
const MAX_ASCENDANCY_NOTABLES = 4; // eight ascendancy points
// Ascendancy points: eight, shared since 3.28 between the ascendancy and one bloodline (patch notes: "You can decide
// how many points to allocate to your original Ascendancy Class, and how many to allocate to your Bloodline"). An
// ascendancy notable costs two (a small passive and the notable); a bloodline notable costs the path to it.
const ASCENDANCY_POINTS = 8;
const ASCENDANCY_NOTABLE_POINTS = 2;
const MAX_KEYSTONES = 2;
const MAX_UNIQUES = 4;
const MAX_TOTEMS = 6;
// Auras, heralds and reserved self buffs reserve a share of mana (of life with Blood Magic), less by the build's
// reservation efficiency: a skill reserves its base share times 100 / (100 + efficiency). The planned pieces' lines
// count, and RESERVATION_EFFICIENCY_ASSUMED stands for what isn't planned (an Enlighten, cluster jewels, a corrupted
// implicit; rare gear can't roll it). Our estimate: 10%.
const RESERVATION_EFFICIENCY_ASSUMED = 10;
// Mana can be reserved up to all of it: whether what is left pays for the main skill is the mana upkeep's question
// (manaUpkeepOf), which the score answers. It was a fixed 90% until 2026-11-13, so builds stopped at whatever share the
// last aura that fit left. Life keeps a margin: reserved life isn't there to take hits.
const RESERVABLE_MANA_PERCENT = 100;
const RESERVABLE_LIFE_PERCENT = 90;
// What a class tree, planned before the buffs, takes them to reserve after efficiency: about an aura and a herald, or
// two auras, at the endgame efficiency (our estimate).
const RESERVATION_WHILE_BUFFS_PENDING = 60;
// Skills whose reservation is always life, whatever reserves mana (Petrified Blood: the wiki keeps its 35 in the mana
// field, but the gem reserves life to protect the lower half of it).
const LIFE_RESERVING_SKILLS = new Set(['Petrified Blood']);
// Low life is 50% of maximum life or less.
const LOW_LIFE_SHARE = 0.5;
// Petrified Blood at level 20 (its gem text): 40% of life loss from hits below half life is prevented, then 81% of
// that is lost over 4 seconds. Within the RECOVERY_SECONDS window a quarter of the delayed loss lands.
const PETRIFIED_PREVENTED = 0.4;
const PETRIFIED_DELAYED = 0.81;
const PETRIFIED_DELAY_SECONDS = 4;
// Efficiency at or under -100% would make a reservation endless; no real build gets near it.
const RESERVATION_EFFICIENCY_FLOOR = -90;
const MAX_CURSES = 1; // the curse limit without curse-limit gear or notables
// Our estimate of how much of a curse lands over a fight. Bosses take curses at full effect (3.20 removed their 33% and
// 66% less curse effect, GGG's patch notes), but a cast curse isn't up every moment: it has to be cast again as targets
// change and its duration runs out, where an aura is always on.
const CURSE_EFFECT_ASSUMED = 0.9;
// Offerings (Flesh, Bone and Spirit Offering's gem text, poewiki): each consumes a corpse for a 5 second buff on your
// minions, a second longer for each extra corpse it consumes. Kept up by casting it again whenever corpses are near,
// which on a boss means making them (Desecrate). Our estimate of the share of a fight the buff is on: a little under
// a curse's, as every recast needs a corpse as well as a cast, and few builds keep it up through every phase.
const OFFERING_UPTIME = 0.75;
// The gem that makes corpses for the Offerings (Desecrate, or Unearth): one socket, shared by every Offering.
const OFFERING_CORPSE_GEM_SOCKETS = 1;
// Buffs kept up beside the main skill: a curse, auras, heralds and defensive spells. What really limits them is the
// sockets left (socketsForBuffs), the mana and life they reserve and whether each adds MIN_GAIN_TO_KEEP; this only
// bounds the search. It was 4 until 2026-11-13, which with a curse and a guard spell left room for two auras, so
// builds stopped short of reserving the mana their skill didn't need.
const MAX_BUFFS = 6;
// Flasks: five slots, one of them the life flask, so four utility flasks (fewer when unique flasks take slots).
const UTILITY_FLASK_SLOTS = 4;
// Our estimate of the flask charges an endgame character gains a second in a fight (hits, kills and the usual
// "charges gained" crafts on the flasks); "Flasks gain N Charges every M seconds" lines add to it. A utility
// flask's buff is up for duration x charges a second / charges per use of the time, at most always.
const FLASK_CHARGES_PER_SECOND = 2;
// Two scores. The power score is the original plan: pieces chosen for their gain alone, prices never seen. The
// value score is a second plan (options.priced, once attachPrices has run) whose pieces are chosen for their gain
// over what they cost; its "value" is its power divided by the price penalty below. Our estimate of what players pay for power: a unique worth 1 Divine has to add about 3% to the
// score, 10 Divines about 10%, 100 Divines about 20%: ln(1 + Divines) x PRICE_WEIGHT.
const PRICE_WEIGHT = 0.04;
// A unique poe.ninja doesn't list is one hardly anyone sells (a chase drop, or new and rare), so it is weighed as a
// dear one. Our estimate.
const UNPRICED_DIVINES = 20;
// Damage gained per gem level at level 20: spells and damage over time scale their base damage steeply, attacks
// mostly through damage effectiveness, minions through their own level.
const DAMAGE_PER_GEM_LEVEL = { spell: 0.11, dot: 0.1, attack: 0.03, minion: 0.09 };
// Added flat damage is worth about this many points of the skill's own base damage per use.
const REFERENCE_HIT_DAMAGE = 250;
// Build strength as damage times effective health, the usual way players weigh a build: equal parts.
const SCORE_WEIGHTS = { offence: 0.5, defence: 0.5, clear: 0.15 };
// The Ascendant and Reliquarian borrow other classes' notables in weaker form and take only a couple of them;
// letting them pick the best four of two dozen would make them the answer to every skill.
const BORROWING_ASCENDANCY_NOTABLE_COUNT = 12;
const BORROWING_ASCENDANCY_MAX_NOTABLES = 2;
// What a finished character has from rare gear (and, for crit, power charges) before any of the pieces chosen
// here. The passive tree is planned for real (public/buildtree.js); without the tree data (the tests' small
// fixtures) a fixed allowance stands in for it, so the first "increased" bonus isn't overvalued either way.
const GEAR_INCREASED_DAMAGE = 60;
const GEAR_INCREASED_SPEED = 10;
const GEAR_DOT_MULTIPLIER = 10;
const GEAR_INCREASED_CRIT = 100;
const GEAR_CRIT_MULTIPLIER = 40;
// Accuracy on unsolved rare gear: the weapon's own line and some on gloves, helmet and jewellery (our estimate).
const GEAR_ACCURACY = 600;
const TREE_ALLOWANCE = { increased: 190, speed: 20, dotMultiplier: 20, critIncreased: 100, critMultiplier: 40, accuracyIncreased: 30 };
// With rare gear solved affix by affix (public/buildgear.js), the gear figures above shrink to what the solver
// doesn't fill: the weapon's own modifiers on a spell or damage-over-time build, and for crit the power charges a
// crit build keeps (about three, over 100% increased crit; nothing else models them) and the weapon's multiplier.
// The crit part was 50% and +15 at first, which cost Assassin and Deadeye most of their calibration hits. The weapon
// isn't solved, so its own accuracy line stays (our estimate).
const SOLVED_GEAR_ALLOWANCE = { increased: 30, speed: 5, dotMultiplier: 5, critIncreased: 100, critMultiplier: 25 };
// A spell build's weapon is solved too (a caster weapon, public/buildgear.js): its modifiers are the item's own lines,
// so only the power charges stay.
const SOLVED_GEAR_WITH_WEAPON_ALLOWANCE = { increased: 0, speed: 0, dotMultiplier: 0, critIncreased: 100, critMultiplier: 0 };
const SOLVED_GEAR_WEAPON_ACCURACY = 300;
// Every character ends the campaign at -60% to all resistances (fire, cold, lightning and chaos); gear makes it up.
const CAMPAIGN_RESISTANCE_PENALTY = -60;
// A level 20 active skill gem asks for about 155 of its attribute and a level 20 support about 111 (two-attribute gems
// split it, about 98 and 68 for an active one). Our estimates.
const GEM_ATTRIBUTE_REQUIREMENT = 155;
const SUPPORT_ATTRIBUTE_REQUIREMENT = 111;
const GEM_ATTRIBUTE_SHARES = { 1: [1], 2: [0.63, 0.44], 3: [0.5, 0.35, 0.35] };
// The attributes each class starts with.
const CLASS_BASE_ATTRIBUTES = {
  Marauder: { str: 32, dex: 14, int: 14 }, Duelist: { str: 23, dex: 23, int: 14 }, Ranger: { str: 14, dex: 32, int: 14 },
  Shadow: { str: 14, dex: 23, int: 23 }, Witch: { str: 14, dex: 14, int: 32 }, Templar: { str: 23, dex: 14, int: 23 },
  Scion: { str: 20, dex: 20, int: 20 },
};
// A build that can't meet a requirement can't use one of its gems or items at full strength: 0.2% off per point
// short, down to 0.8, so the tree and gear see the gain of each point they make up.
const ATTRIBUTE_SHORT_PER_POINT = 0.002;
const ATTRIBUTE_SHORT_FLOOR = 0.8;
// An attack build's damage in absolute terms (shown, not scored): the weapon base the data names for its weapon type
// (the endgame base with the most physical DPS, from the wiki), with a good rare's local modifiers (the reference rare,
// REFERENCE_RARE_WEAPON in public/buildgear.js: 170% increased physical damage, flat physical damage of about 32 on a
// one-handed weapon and half again on a staff or bow, 20% increased attack speed, 20% quality), then everything the
// offence index multiplies; and about 30 more flat attack damage from rings, amulet and gloves. With the weapon solved,
// its own damage and speed take the reference's place (solvedWeaponFactors).
const RARE_WEAPON_INCREASED_PHYSICAL = REFERENCE_RARE_WEAPON.increasedPhysical;
const WEAPON_QUALITY = REFERENCE_RARE_WEAPON.quality;
const RARE_WEAPON_FLAT_PHYSICAL = REFERENCE_RARE_WEAPON.flatPhysical;
const TWO_HANDED_FLAT_FACTOR = REFERENCE_RARE_WEAPON.twoHandedFlatFactor;
const RARE_WEAPON_ATTACK_SPEED = REFERENCE_RARE_WEAPON.attackSpeed;
const GEAR_ADDED_ATTACK_DAMAGE = 30;
// Jewels in the tree's sockets (planned with the tree, public/buildtree.js). Our estimates: a good rare jewel has
// three useful modifiers (the three that help the build most among the wiki's jewel modifiers, at most two
// prefixes and two suffixes, at their middle roll); a large cluster jewel adds 8 passives, and a build runs at most two
// of them. The game lays out an 8-passive large cluster as 2 jewel sockets, 3 notables (its type's three best for the
// build) and 3 small passives with the type's small passive (Path of Building's layout tables agree; a check, not the
// source); all 8 are allocated to reach the notables. The sockets inside aren't planned. It counted 4 small passives
// until 2026-11-25, when drawing the cluster on the tree showed only 3 places for them.
const RARE_JEWEL_MODS = 3;
const LARGE_CLUSTER_SMALLS = 3;
const LARGE_CLUSTER_NOTABLES = 3;
const LARGE_CLUSTER_POINTS = 8;
const MAX_LARGE_CLUSTERS = 2;
const LARGE_CLUSTER_TYPES_OFFERED = 3;
const MIN_GAIN_TO_KEEP = 0.015; // a piece that adds less than 1.5% to the score isn't worth a slot

const DAMAGE_TYPES = ['physical', 'fire', 'cold', 'lightning', 'chaos'];
const DAMAGE_TYPE_TAGS = new Set(['physical', 'fire', 'cold', 'lightning', 'chaos', 'elemental', 'nonChaos']);
const AILMENT_TAGS = new Set(['ignite', 'bleed', 'poison', 'ailment']);

// How often a condition holds, for a build that doesn't arrange for it on purpose.
const CONDITION_UPTIME = {
  recentKill: 0.7, onKill: 0.5, recentlyHit: 0.5, onHit: 0.4, onBlock: 0.2, recentBlock: 0.2,
  lowLife: 0.05, fullLife: 0.3, fullEnergyShield: 0.4, flask: 0.8, nearby: 0.8, rareOrUnique: 0.5, chargeState: 0.5,
  enemyChilled: 0.4, enemyFrozen: 0.15, enemyShocked: 0.4, enemyIgnited: 0.4, enemyPoisoned: 0.3,
  enemyBleeding: 0.3, enemyCursed: 0.6, enemyHindered: 0.3, enemyIntimidated: 0.3, enemyTaunted: 0.2,
  arcaneSurge: 0.6, onslaught: 0.5, fortify: 0.7, rage: 0.6, unbound: 0.3, periodic: 0.3, recentSpell: 0.9,
  recentSkill: 0.95, unencumbered: 0.2, corpse: 0.5, exposure: 0.4, phantasm: 0.4, perAura: 2,
  warcry: 0.5, chained: 0.4, pierced: 0.4, spectre: 0, other: 0.5,
  guard: 0.35, // a guard skill's buff lasts a few seconds out of a cooldown several times as long
  // Arctic Armour's "while stationary": the buff stays 2.5-4.4 seconds after you move, so most of a fight.
  stationaryLingering: 0.6,
  // "haven't ... recently": the complement of the plain condition's uptime above
  notRecentlyHit: 0.5, noRecentBlock: 0.8, noRecentKill: 0.3,
  masteryCount: 0, // "if you have at least 6 Life Masteries allocated": the planner doesn't count them, so no credit
  // "per Fortification above 20" (Unstoppable Hero): needs gear or passives raising maximum Fortification, which the
  // generator doesn't plan, so no credit.
  fortificationAbove20: 0,
  // "per Raised Zombie", "per Summoned Skeleton": minions the generator doesn't plan beside the main skill.
  perOwnMinion: 0,
  unleechable: 0.05, // enemies that can't be leeched from are a few special ones
  // Command of the Pit: each minion gains Unholy Might for 4 seconds at a 25% chance per spell hit. A minion hitting
  // a few times a second keeps it nearly always (0.75 to the 8th, a 10% chance of missing it over 4 seconds of two
  // hits a second), but every newly summoned minion starts without it, so a little under that: our estimate.
  minionUnholyMightOnHit: 0.85,
  // Item mods (2026-11-27): "during Soul Gain Prevention" follows a Vaal skill, which the generator doesn't plan;
  // Focus lasts 4 seconds out of a cooldown about four times as long (our estimate of its use in a fight); a
  // Pinnacle Atlas Boss is there for the fights the defence index is measured against, but not for clearing.
  soulGainPrevention: 0, focused: 0.25, pinnaclePresence: 0.5,

};

// Item categories -> the equipment slot they take, and how many of that slot a character has.
const SLOT_OF_CATEGORY = {
  'Body Armour': 'body', Helmet: 'helmet', Gloves: 'gloves', Boots: 'boots', Belt: 'belt', Amulet: 'amulet',
  Ring: 'ring', Shield: 'offhand', Quiver: 'offhand', Jewel: 'jewel', 'Abyss Jewel': 'jewel',
  'Utility Flask': 'flask', 'Life Flask': 'flask', 'Mana Flask': 'flask', 'Hybrid Flask': 'flask',
  Wand: 'weapon', Staff: 'weapon', Warstaff: 'weapon', Bow: 'weapon', Claw: 'weapon', Dagger: 'weapon',
  'Rune Dagger': 'weapon', 'One Hand Sword': 'weapon', 'Thrusting One Hand Sword': 'weapon',
  'Two Hand Sword': 'weapon', 'One Hand Axe': 'weapon', 'Two Hand Axe': 'weapon', 'One Hand Mace': 'weapon',
  'Two Hand Mace': 'weapon', Sceptre: 'weapon',
};
const SLOT_COUNT = { body: 1, helmet: 1, gloves: 1, boots: 1, belt: 1, amulet: 1, ring: 2, offhand: 1, jewel: 2, flask: 2, weapon: 1 };
const WEAPON_OF_CATEGORY = {
  Wand: 'wand', Staff: 'staff', Warstaff: 'staff', Bow: 'bow', Claw: 'claw', Dagger: 'dagger', 'Rune Dagger': 'dagger',
  'One Hand Sword': 'sword', 'Thrusting One Hand Sword': 'sword', 'Two Hand Sword': 'sword', 'One Hand Axe': 'axe',
  'Two Hand Axe': 'axe', 'One Hand Mace': 'mace', 'Two Hand Mace': 'mace', Sceptre: 'mace',
};
const TWO_HANDED_CATEGORIES = new Set(['Staff', 'Warstaff', 'Bow', 'Two Hand Sword', 'Two Hand Axe', 'Two Hand Mace']);
// Weapons a skill without weapon rules might be built around. Spells may hold anything a caster holds. There was a
// 'none' that left weapon effects out of the picture, and with it both hands empty; every build now holds a weapon
// (2026-11-25).
// Two-handed swords, axes and maces are choices of their own (2026-11-25): before, a sword build was always a
// one-hander, so the tree's two-handed lines and the larger two-handed bases never reached Boneshatter or Earthshatter.
const MELEE_WEAPON_CHOICES = ['sword', 'axe', 'mace', 'claw', 'dagger', 'staff', 'twoHandSword', 'twoHandAxe', 'twoHandMace'];
const SPELL_WEAPON_CHOICES = ['staff', 'wand', 'dagger', 'mace', 'shield'];

// Which attributes each class starts near; a skill needing another one costs passive points to reach.
const CLASS_ATTRIBUTES = {
  Marauder: ['str'], Ranger: ['dex'], Witch: ['int'], Duelist: ['str', 'dex'], Templar: ['str', 'int'],
  Shadow: ['dex', 'int'], Scion: ['str', 'dex', 'int'],
};
const OFF_ATTRIBUTE_FACTOR = 0.88;

// Support effects that the generator can't model yet: trigger set-ups need two skills, and a few supports only
// make sense with a second skill or a curse.
const SUPPORT_FLAGS_SKIPPED = new Set(['castOnCrit', 'castOnKill', 'cannotKill', 'linkDamage', 'curseOnHit', 'curseOnGround', 'generosity']);

// ---------- support rules ----------
// GGG writes a support's allowed and excluded skill types in postfix: plain entries are tested against the
// skill's types, OR/AND pop two results, NOT flips one. The expression matches when any result left is true.
export function typeExpressionMatches(expression, typeSet) {
  const stack = [];
  for (const token of expression) {
    if (token === 'OR') {
      const right = stack.pop();
      const left = stack.pop();
      stack.push(Boolean(left) || Boolean(right));
      continue;
    }
    if (token === 'AND') {
      const right = stack.pop();
      const left = stack.pop();
      stack.push(Boolean(left) && Boolean(right));
      continue;
    }
    if (token === 'NOT') {
      stack.push(!stack.pop());
      continue;
    }
    stack.push(typeSet.has(token));
  }
  for (const value of stack) {
    if (value) {
      return true;
    }
  }
  return false;
}

// 'skill' when the support works on the skill itself, 'minion' when only on the minions it creates, else null.
export function supportFits(support, typeSet, minionTypeSet, isGem) {
  if (support.gemsOnly && !isGem) {
    return null;
  }
  if (supportMatchesTypes(support, typeSet)) {
    return 'skill';
  }
  if (!support.ignoreMinionTypes && minionTypeSet.size > 0 && supportMatchesTypes(support, minionTypeSet)) {
    return 'minion';
  }
  return null;
}

function supportMatchesTypes(support, typeSet) {
  if (support.excluded.length > 0 && typeExpressionMatches(support.excluded, typeSet)) {
    return false;
  }
  if (support.allowed.length === 0) {
    return true;
  }
  return typeExpressionMatches(support.allowed, typeSet);
}

// A skill's types once its supports have added theirs (Spell Totem makes a spell a totem skill, which in turn
// lets Multiple Totems support it). Repeats until nothing more is added.
export function typesWithSupports(skill, supports) {
  const types = new Set(skill.types);
  let changed = true;
  while (changed) {
    changed = false;
    for (const support of supports) {
      if (!supportMatchesTypes(support, types)) {
        continue;
      }
      for (const added of support.added) {
        if (!types.has(added)) {
          types.add(added);
          changed = true;
        }
      }
    }
  }
  return types;
}

// ---------- the data, prepared once ----------
// treeData (public/data/builds/tree-poe1.json) is optional: without it the tree is a fixed allowance.
// gearData: public/data/craft/gear-poe1.json when the crafting data is built (scripts/build_gear_mods.py); without it
// rare gear is the fixed figures below.
export function prepareMechanics(mechanics, treeData = null, gearData = null) {
  const supports = [];
  for (const [name, support] of Object.entries(mechanics.supports)) {
    supports.push({ name, ...support });
  }
  supports.sort((first, second) => first.name.localeCompare(second.name));
  const skills = [];
  for (const [name, skill] of Object.entries(mechanics.skills)) {
    skills.push({ name, ...skill });
  }
  skills.sort((first, second) => first.name.localeCompare(second.name));
  const ascendancies = [];
  // Bloodline notables: any ascendancy can take them, from one bloodline, paid in the same points.
  const bloodlineNotables = [];
  for (const [bloodline, entry] of Object.entries(mechanics.bloodlines || {})) {
    for (const notable of entry.notables) {
      bloodlineNotables.push({ name: notable.name, effects: notable.effects, points: notable.points, bloodline });
    }
  }
  for (const [name, ascendancy] of Object.entries(mechanics.ascendancies)) {
    ascendancies.push({ name, baseClass: ascendancy.class, notables: ascendancy.notables });
  }
  ascendancies.sort((first, second) => first.name.localeCompare(second.name));
  const uniques = [];
  for (const unique of mechanics.uniques) {
    const slot = SLOT_OF_CATEGORY[unique.category];
    // A jewel that works on the passives in its radius is placed with the tree (radiusJewels below), not worn.
    if (!slot || unique.effects.length === 0 || unique.radius) {
      continue;
    }
    const twoHanded = TWO_HANDED_CATEGORIES.has(unique.category);
    const effects = effectsForMainSkillSlot(unique.effects, slot, twoHanded);
    if (effects.length === 0) {
      continue;
    }
    uniques.push({ ...unique, effects, effectsBesideWeaponSkill: effectsNotAboutSocketed(effects), slot,
      weapon: WEAPON_OF_CATEGORY[unique.category] || null, twoHanded });
  }
  attachGrantingUniques(skills, uniques);
  const keystones = [];
  for (const keystone of mechanics.keystones) {
    if (keystone.cluster || keystone.effects.length === 0) {
      continue;
    }
    keystones.push(keystone);
  }
  const buffs = buffsOf(skills, mechanics.supports || {}, uniques);
  knownBuffNames = new Set();
  for (const buff of buffs) {
    knownBuffNames.add(buff.name);
  }
  const flasks = [];
  for (const flask of mechanics.flasks?.utility || []) {
    flasks.push({ ...flask, kind: 'flask' });
  }
  setLifeFlask(mechanics.flasks?.life || null);
  const jewelMods = mechanics.jewels?.mods || [];
  const largeClusters = mechanics.jewels?.largeClusters || [];
  weaponBases = mechanics.weaponBases || null;
  const tree = treeData ? prepareTree(treeData) : null;
  const timeless = timelessChoicesOf(mechanics.timeless);
  if (tree && timeless.radius) {
    tree.keystonesNearSocket = keystonesNearSockets(tree, timeless.radius);
  }
  const radiusJewels = radiusJewelChoices(mechanics.uniques, tree, mechanics.jewelRadii);
  return { skills, supports, ascendancies, bloodlineNotables, uniques, keystones, buffs, flasks, jewelMods, largeClusters, patch: mechanics.patch,
    timeless: timeless.choices, radiusJewels, tree, gear: prepareGear(gearData) };
}

// Timeless jewels as jewel choices: one per keystone they can grant ("Lethal Pride: Strength of Blood"), and one
// with no keystone, for a socket whose radius holds none the build takes. Each conquers the small passives and
// notables in its Large radius (public/buildradius.js, the conquer rule), for a typical seed.
function timelessChoicesOf(timeless) {
  const choices = [];
  const radius = timeless?.radius || null;
  for (const jewel of timeless?.jewels || []) {
    const placed = { area: { inner: -1, outer: radius, around: null },
      rules: jewel.conquest ? [{ rule: 'conquer', family: jewel.family, ...jewel.conquest }] : [] };
    for (const keystone of jewel.keystones) {
      choices.push({ key: 'timeless:' + keystone.name, kind: 'timeless', jewel: jewel.name, keystone: keystone.name,
        name: jewel.name + ': ' + keystone.name, effects: keystone.effects, points: 0, ...placed });
    }
    if (jewel.conquest) {
      choices.push({ key: 'timeless:' + jewel.name, kind: 'timeless', jewel: jewel.name, keystone: null,
        name: jewel.name, effects: [], points: 0, ...placed });
    }
  }
  return { choices, radius };
}

// For each jewel socket, the tree's keystones within a timeless jewel's radius (tree units), nearest first.
function keystonesNearSockets(tree, radius) {
  const keystones = [];
  for (const node of tree.nodes.values()) {
    if (node.kind === 'keystone' && node.position) {
      keystones.push(node);
    }
  }
  const near = new Map();
  for (const socket of tree.nodes.values()) {
    if (socket.kind !== 'jewel' || !socket.position) {
      continue;
    }
    const inRadius = [];
    for (const keystone of keystones) {
      const distance = Math.hypot(keystone.position.x - socket.position.x, keystone.position.y - socket.position.y);
      if (distance <= radius) {
        inRadius.push({ id: keystone.id, distance });
      }
    }
    if (inRadius.length > 0) {
      inRadius.sort((first, second) => first.distance - second.distance);
      near.set(socket.id, inRadius.map(entry => entry.id));
    }
  }
  return near;
}

// The auras, heralds and curses a build can run beside its main skill. An aura reaches the allies around you,
// your minions too, so each of its lines is also given to the minions; a herald's buff is yours alone. A curse's
// lines count at CURSE_EFFECT_ASSUMED.
// Defensive spells kept up beside the main skill that have no reservation and no Buff type.
const SELF_BUFF_SKILLS = new Set(['Frost Shield']);

// Eternal Blessing (its gem text): the supported aura reserves nothing and has increased aura effect, it counts as a
// Blessing, only one aura from a Blessing can be on you, and your non-Blessing skills that reserve mana are disabled
// while it is. So it carries one strong aura, and anything else reserved must reserve life (Blood Magic, Petrified
// Blood). It is offered as its own buff: the aura linked to the support, two sockets.
function blessingCanSupport(skill, support) {
  const types = new Set(skill.types);
  return supportMatchesTypes(support, types);
}

function eternalBlessingAura(skill, effects, support) {
  let auraEffect = 0;
  for (const effect of support.effects) {
    if (effect.stat === 'effect:aura' && effect.kind === 'increased') {
      auraEffect += effect.value || 0;
    }
  }
  return { name: skill.name + ' (Eternal Blessing)', baseName: skill.name, kind: 'aura', reservation: 0, blessing: true,
    sockets: 2, ownAuraEffect: auraEffect, attributes: skill.attributes, supportAttributes: support.attributes || [], effects };
}

// Arrogance (its gem text): the supported skill reserves life instead of mana, at the support's reservation multiplier
// (201% at level 20, poewiki's cost_multiplier), with increased aura effect. The usual use is an aura with a flat
// reservation (Precision, Vitality, Clarity: a few hundred life) beside an Eternal Blessing aura, which allows only
// life reservations next to it. It is offered as its own buff, like Eternal Blessing: the aura linked to the support,
// two sockets.
function arroganceAura(skill, effects, support) {
  let auraEffect = 0;
  for (const effect of support.effects) {
    if (effect.stat === 'effect:aura' && effect.kind === 'increased') {
      auraEffect += effect.value || 0;
    }
  }
  const multiplier = (support.costMultiplier || 100) / 100;
  return { name: skill.name + ' (Arrogance)', baseName: skill.name, kind: 'aura',
    reservation: (skill.reservation || 0) * multiplier, reservationFlat: (skill.reservationFlat || 0) * multiplier,
    reservesLife: true, sockets: 2, ownAuraEffect: auraEffect, attributes: skill.attributes,
    supportAttributes: support.attributes || [], effects };
}

function skillReserves(skill) {
  return skill.reservation > 0 || skill.reservationFlat > 0;
}

function buffsOf(skills, supports, uniques = []) {
  const buffs = [];
  const eternalBlessing = supports['Eternal Blessing Support'] || null;
  const arrogance = supports['Arrogance Support'] || null;
  for (const skill of skills) {
    if (skill.main || skill.effects.length === 0) {
      continue;
    }
    const isAura = skill.tags.includes('aura');
    const isHerald = skill.tags.includes('herald');
    const isCurse = skill.tags.includes('curse');
    if ((isAura || isHerald) && skillReserves(skill)) {
      const effects = isAura ? withMinionCopies(skill.effects) : skill.effects;
      buffs.push({ name: skill.name, kind: isAura ? 'aura' : 'herald', reservation: skill.reservation || 0,
        reservationFlat: skill.reservationFlat || 0, attributes: skill.attributes, effects });
      if (isAura && eternalBlessing && blessingCanSupport(skill, eternalBlessing)) {
        buffs.push(eternalBlessingAura(skill, effects, eternalBlessing));
      }
      if (isAura && arrogance && blessingCanSupport(skill, arrogance)) {
        buffs.push(arroganceAura(skill, effects, arrogance));
      }
      continue;
    }
    // Self buffs that aren't auras or guard skills: reserved ones (Arctic Armour, Tempest Shield, Blood and Sand) and
    // Frost Shield, a cooldown spell. Their lines are about you.
    const isReservedSelfBuff = skill.types.includes('Buff') && skill.reservation > 0 && !skill.types.includes('Guard');
    if (!isAura && !isHerald && (isReservedSelfBuff || SELF_BUFF_SKILLS.has(skill.name))) {
      buffs.push({ name: skill.name, kind: 'self', reservation: skill.reservation || 0, attributes: skill.attributes,
        effects: skill.effects, reservesLife: LIFE_RESERVING_SKILLS.has(skill.name) });
      continue;
    }
    // Offerings: their lines are about your minions, at OFFERING_UPTIME. They reserve nothing; their corpse gem
    // takes a socket (buffAllowed).
    if (skill.types.includes('Offering')) {
      buffs.push({ name: skill.name, kind: 'offering', reservation: 0, attributes: skill.attributes,
        effects: scaledEffects(skill.effects, OFFERING_UPTIME) });
      continue;
    }
    // Bane and Hexblast apply hexes but are damage skills of their own: their lines are about their own damage.
    const dealsDamage = skill.types.includes('Damage') || skill.types.includes('DamageOverTime');
    if (isCurse && !isAura && !dealsDamage) {
      buffs.push({ name: skill.name, kind: 'curse', reservation: 0, attributes: skill.attributes,
        effects: scaledEffects(skill.effects, CURSE_EFFECT_ASSUMED) });
    }
  }
  const guardian = guardianBuffOf(skills, uniques);
  if (guardian) {
    buffs.push(guardian);
  }
  return buffs;
}

// An Animated Guardian wearing Garb of the Ephemeral: the guardian ignores the Garb's +600 Strength and Intelligence
// requirement, and the Garb's "Nearby Enemies cannot deal Critical Strikes" reaches the enemies around it, which
// follow you. It is what makes Dance with Death's lucky enemy crits safe without giving up your body armour (the
// other answer is The Brass Dome, worn). One socket for the gem, no reservation; the value plan pays for the Garb
// (carriedUnique, costOf). Only the Garb's lines about others count: its own lines are the guardian's.
const GUARDIAN_SKILL = 'Animate Guardian';
const GUARDIAN_GARB = 'Garb of the Ephemeral';

function guardianBuffOf(skills, uniques) {
  const skill = skills.find(candidate => candidate.name === GUARDIAN_SKILL);
  const garb = uniques.find(candidate => candidate.name === GUARDIAN_GARB);
  if (!skill || !garb) {
    return null;
  }
  const effects = [];
  for (const effect of garb.effects) {
    if ((effect.subject || 'self') === 'enemy') {
      effects.push(effect);
    }
  }
  return { name: GUARDIAN_SKILL + ' (' + GUARDIAN_GARB + ')', baseName: GUARDIAN_SKILL, kind: 'guardian', reservation: 0,
    attributes: skill.attributes, effects, carriedUnique: garb };
}

function withMinionCopies(effects) {
  const all = [...effects];
  for (const effect of effects) {
    if ((effect.subject || 'self') === 'self') {
      all.push({ ...effect, subject: 'minion' });
    }
  }
  return all;
}

function scaledEffects(effects, factor) {
  const scaled = [];
  for (const effect of effects) {
    if (typeof effect.value === 'number') {
      scaled.push({ ...effect, value: effect.value * factor });
    } else {
      scaled.push(effect);
    }
  }
  return scaled;
}

// The main skill sits in a six-link, which only a body armour or a two-handed weapon has; lines about socketed
// gems on any other item can't reach it.
function effectsForMainSkillSlot(effects, slot, twoHanded) {
  const sixLink = slot === 'body' || (slot === 'weapon' && twoHanded);
  const kept = [];
  for (const effect of effects) {
    const aboutSocketed = effect.socketed || effect.condition === 'socketedSkill';
    if (aboutSocketed && !sixLink) {
      continue;
    }
    if (effect.condition === 'socketedSkill') {
      kept.push({ ...effect, condition: null, socketed: true });
      continue;
    }
    kept.push(effect);
  }
  return kept;
}

// A unique's lines without those about the gems socketed in it: what it gives a skill a unique grants, which sits in
// that unique's sockets rather than this one's (a body armour's "Socketed Gems deal more damage" can't reach
// Soulwrest's Phantasms). The same array when nothing was taken out.
function effectsNotAboutSocketed(effects) {
  const kept = [];
  for (const effect of effects) {
    if (!effect.socketed) {
      kept.push(effect);
    }
  }
  return kept.length === effects.length ? effects : kept;
}

// ---------- main skills a unique gives ----------
// A skill no gem gives (scripts/build_mechanics.py, UNIQUE_MAIN_SKILLS: Soulwrest's Phantasms) names its unique in
// grantedBy. The build always wears that unique, and its supports are the gems socketed in it. Without the unique
// in the data the skill can't be built, so it stops being a main skill.
function attachGrantingUniques(skills, uniques) {
  for (const skill of skills) {
    if (!skill.grantedBy) {
      continue;
    }
    let granting = null;
    for (const unique of uniques) {
      if (unique.name === skill.grantedBy) {
        granting = unique;
      }
    }
    skill.grantingUnique = granting;
    if (granting === null) {
      skill.main = false;
    }
  }
}

// The uniques every build of this skill starts with: the one that grants it, or none.
function startingUniquesOf(skill) {
  return skill.grantingUnique ? [skill.grantingUnique] : [];
}

function isGrantingUnique(build, unique) {
  return Boolean(build.skill.grantedBy) && unique.name === build.skill.grantedBy;
}

// The uniques the build planner was told to include ("Include these items"): they are worn from the start and never
// swapped out, like the unique that grants the skill.
function isRequiredUnique(build, unique) {
  for (const required of build.requiredUniques || []) {
    if (required.name === unique.name) {
      return true;
    }
  }
  return false;
}

// A unique that stays whatever scores better: the one granting the skill, or one the planner must include.
function isKeptUnique(build, unique) {
  return isGrantingUnique(build, unique) || isRequiredUnique(build, unique);
}

// The uniques a build starts with: the one granting its skill and the required ones.
function keptUniquesOf(build) {
  const kept = [...startingUniquesOf(build.skill)];
  for (const required of build.requiredUniques || []) {
    if (!kept.some(unique => unique.name === required.name)) {
      kept.push(required);
    }
  }
  return kept;
}

// How many uniques the build may wear: the usual four, besides the one that grants its skill, and at least the
// required ones.
function uniqueLimitOf(build) {
  const granting = startingUniquesOf(build.skill).length;
  return Math.max(MAX_UNIQUES + granting, keptUniquesOf(build).length);
}

// The build with the planner's required uniques worn, or null when they can't all be worn together on this weapon
// (two body armours, a two-handed sword on an axe plan, a shield with a staff).
function withRequiredUniques(build, index, requiredNames) {
  if (!requiredNames || requiredNames.length === 0) {
    return build;
  }
  const required = [];
  for (const name of requiredNames) {
    const unique = index.uniques.find(entry => entry.name === name);
    if (!unique) {
      return null; // not a unique the mechanics know: no build can include it
    }
    required.push(unique);
  }
  let current = { ...build, requiredUniques: required, uniques: startingUniquesOf(build.skill) };
  for (const unique of required) {
    if (current.uniques.some(worn => worn.name === unique.name)) {
      continue;
    }
    if (!uniqueAllowed(current, unique)) {
      return null;
    }
    current = { ...current, uniques: [...current.uniques, unique] };
  }
  return current;
}

// ---------- a build's context: what its skill is and does ----------
// The weapons a skill can be planned with (the build planner's weapon limits pick among them).
export function weaponChoicesOf(skill) {
  return weaponChoicesFor(skill);
}

function weaponChoicesFor(skill) {
  if (skill.weapons.length > 0) {
    // "sword" covers both hands' swords; the two-handed ones the skill's weapon rule allows are choices of their own.
    return [...skill.weapons, ...(skill.twoHandedWeapons || [])];
  }
  // Some skills say what they need through their types rather than weapon rules.
  if (skill.types.includes('WandAttack')) {
    return ['wand'];
  }
  if (skill.types.includes('RequiresStaff')) {
    return ['staff'];
  }
  if (skill.types.includes('RequiresShield')) {
    return ['shield'];
  }
  if (skill.types.includes('Attack') && skill.types.includes('RangedAttack')) {
    return ['bow'];
  }
  if (skill.types.includes('Attack')) {
    if (skill.types.includes('Melee')) {
      return MELEE_WEAPON_CHOICES;
    }
    return ['bow', 'wand'];
  }
  return SPELL_WEAPON_CHOICES;
}

// A line that keeps the build's Endurance Charges: one without a number, or one worth at least ENDURANCE_SOURCE_MIN_CHANCE
// (a 1% chance, one charge).
// A timeless jewel's typical seed spreads "5% chance to gain an Endurance Charge on Kill" over its notables as a few
// hundredths of a percent each, which is no source (it gave every Lethal Pride build full charges, 2026-11-27).
const ENDURANCE_SOURCE_MIN_CHANCE = 1;
function isEnduranceSource(effect) {
  if (!effect.stat.startsWith('enduranceCharge') && effect.stat !== 'minimumEnduranceCharges') {
    return false;
  }
  // Militant Faith's typical "+1 to Minimum Endurance Charges" share (0.07) is no source either.
  return typeof effect.value !== 'number' || effect.value >= ENDURANCE_SOURCE_MIN_CHANCE;
}

function contextOf(build) {
  const skill = build.skill;
  const chosenSupports = [];
  for (const entry of linkedSupports(build)) {
    chosenSupports.push(entry.support);
  }
  const types = typesWithSupports(skill, chosenSupports);
  const tags = new Set(skill.tags);
  // A skill's tags list every weapon it can be used with; the build holds only one of them, so the others go,
  // or a sword Cyclone would take staff block and axe damage from the tree.
  for (const weapon of skill.weapons || []) {
    if (weapon !== weaponFamilyOf(build.weapon)) {
      tags.delete(weapon);
    }
  }
  addTypeTags(types, tags);
  if (build.weapon && build.weapon !== 'none') {
    tags.add(weaponFamilyOf(build.weapon));
    if (build.weapon === 'shield') {
      tags.add('shield');
    }
    // A two-handed unique (Starforge on a two-handed sword build) is held in both hands.
    if (isTwoHandedWeapon(build.weapon) || holdsTwoHandedUnique(build)) {
      tags.add('twoHand');
    } else if (build.weapon !== 'shield') {
      tags.add('oneHand');
    }
    if (dualWields(build)) {
      tags.add('dualWield');
    }
  }
  const isMinion = types.has('CreatesMinion') && !types.has('Damage');
  const isDamageOverTime = types.has('DamageOverTime') || (types.has('CausesBurning') && !types.has('Damage'));
  if (isDamageOverTime) {
    tags.add('dot');
  }
  const ailment = build.ailment || null;
  if (ailment) {
    tags.add(ailment);
    tags.add('ailment');
    tags.add('dot');
  }
  if (isMinion) {
    tags.add('minion');
  }
  const flags = new Set();
  // Lines read again once the context exists: "chance to Impale" and Rage lines (see impaleChanceOf and rageOf).
  const impaleLines = [];
  const rageLines = [];
  let enduranceMaximum = 0;
  let hasEnduranceSource = false;
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      // A flag about enemies ("Nearby Enemies cannot deal Critical Strikes") isn't the build's own: kept as
      // "enemy:<flag>", so it can't read as the build never critting.
      if (effect.kind === 'flag' && (effect.subject || 'self') === 'enemy') {
        flags.add('enemy:' + effect.stat);
      } else if (effect.kind === 'flag' && appliesToSubject(effect, isMinion, tags)) {
        flags.add(effect.stat);
      }
      if (effect.kind === 'chance' && effect.stat === 'impale') {
        impaleLines.push(effect);
      }
      if (effect.stat === 'rageSource' || effect.stat === 'effect:rage') {
        rageLines.push(effect);
      }
      if ((effect.subject || 'self') === 'self') {
        if (effect.stat === 'enduranceCharges' && effect.kind === 'limit') {
          enduranceMaximum += effect.value || 0;
        } else if (isEnduranceSource(effect)) {
          hasEnduranceSource = true;
        }
      }
    }
  }
  const buffNames = new Set();
  for (const buff of build.buffs || []) {
    buffNames.add(buff.name);
  }
  const minionTypes = minionTypesOf(build);
  const context = { skill, types, tags, isMinion, minionTypes, isDamageOverTime, ailment, flags, buffNames,
    shares: damageShares(build, skill, isMinion, tags, minionTypes, flags) };
  context.impaleChance = impaleChanceOf(impaleLines, context);
  context.rage = rageOf(rageLines, context);
  // Endurance Charges the build keeps: its maximum when something gives them (as defenceTotals counts them), else 0.
  context.enduranceCharges = hasEnduranceSource ? BASE_ENDURANCE_CHARGES + enduranceMaximum : 0;
  // The build's attributes, worked out when a "per 16 Intelligence" line asks (attribute lines with a condition don't
  // count towards them, so this never asks itself).
  let attributes = null;
  context.attributesNow = () => {
    attributes ??= attributeSupplyOf(build);
    return attributes;
  };
  return context;
}

// The build's chance to impale with its hits (0 to 1): the "chance to Impale" lines of its pieces that reach it,
// added up. Their "on Hit" reads as a condition, but a hit is what they need, so it holds.
function impaleChanceOf(impaleLines, context) {
  let chance = 0;
  for (const effect of impaleLines) {
    if (effectCoverage(effect, context) > 0) {
      chance += effect.value || 0;
    }
  }
  return Math.min(100, chance) / 100;
}

// The Rage a build keeps up in a fight (RAGE_ASSUMED, after "increased Rage Effect"), or 0 without a Rage source
// that reaches its skill. Only attacks gain from it, and not minions (Rage is the player's).
function rageOf(rageLines, context) {
  if (context.isMinion || !context.types.has('Attack')) {
    return 0;
  }
  let hasSource = false;
  let rageEffect = 0;
  for (const effect of rageLines) {
    if (effect.kind === 'flag' && effect.stat === 'rageSource' && effectCoverage(effect, context) > 0) {
      hasSource = true;
    }
    if (effect.kind === 'increased' && effect.stat === 'effect:rage' && appliesToSubject(effect, context.isMinion, context.tags)) {
      const uptime = effect.condition ? conditionUptime(effect.condition, context, { crit: false, critChance: 0 }) : 1;
      rageEffect += (effect.value || 0) * uptime;
    }
  }
  if (!hasSource) {
    return 0;
  }
  return Math.min(MAX_RAGE, RAGE_ASSUMED) * (1 + rageEffect / 100);
}

function addTypeTags(types, tags) {
  const typeTags = {
    Attack: 'attack', Spell: 'spell', Projectile: 'projectile', Area: 'area', SummonsTotem: 'totem', Trapped: 'trap',
    RemoteMined: 'mine', Brand: 'brand', Channel: 'channel', Slam: 'slam', Melee: 'melee', Strike: 'strike',
    Chains: 'chain', CreatesMinion: 'minion', Orb: 'orb',
  };
  for (const [type, tag] of Object.entries(typeTags)) {
    if (types.has(type)) {
      tags.add(tag);
    }
  }
}

// The build's sockets by slot: the usual count, or a unique's own. Rings add theirs to the usual none.
function socketsOf(build) {
  const twoHanded = isTwoHandedWeapon(build.weapon) || build.uniques.some(unique => unique.twoHanded);
  const sockets = { ...SLOT_SOCKETS };
  if (twoHanded) {
    sockets.weapon = TWO_HANDED_SOCKETS;
    sockets.offhand = 0;
  }
  let ringSockets = 0;
  for (const unique of build.uniques) {
    if (unique.sockets === undefined) {
      continue;
    }
    if (unique.slot === 'ring') {
      ringSockets += unique.sockets;
    } else if (unique.slot in sockets) {
      sockets[unique.slot] = unique.sockets;
    }
  }
  sockets.ring = ringSockets;
  // Oath of the Maji: gloves and boots kept without gems.
  for (const notable of build.notables || []) {
    for (const effect of notable.effects) {
      if (effect.kind === 'flag' && effect.stat === 'gemlessGloves') {
        sockets.gloves = 0;
      } else if (effect.kind === 'flag' && effect.stat === 'gemlessBoots') {
        sockets.boots = 0;
      }
    }
  }
  return sockets;
}

// How many supports the main skill can have: five in a six-link (body armour or two-handed weapon), else one fewer
// than the most sockets any slot has (a four-link in helmet, gloves or boots: three).
function linkLimitOf(build) {
  let most = 0;
  for (const count of Object.values(socketsOf(build))) {
    most = Math.max(most, count);
  }
  return Math.max(0, Math.min(MAX_SUPPORTS, most - 1));
}

// The supports that are linked to the main skill: the first ones chosen (the best), as many as its links hold. A
// Kaom's Heart on a one-handed build leaves a four-link, so only three of five chosen supports count.
export function linkedSupports(build) {
  const limit = linkLimitOf(build);
  return build.supports.length > limit ? build.supports.slice(0, limit) : build.supports;
}

// Sockets left for buffs: all of them, less the main skill's links and the utility gems. A skill a unique grants
// takes no socket of its own, but its set-up gems do (Soulwrest: a gem that makes corpses and one that consumes them).
function socketsForBuffs(build) {
  let total = 0;
  for (const count of Object.values(socketsOf(build))) {
    total += count;
  }
  const mainSkillGems = build.skill.grantedBy ? build.skill.setupGems || 0 : 1;
  return total - (mainSkillGems + linkedSupports(build).length) - UTILITY_GEMS;
}

// Every piece of the build that carries effects: the skill itself, supports, notables, keystones, uniques.
function piecesOf(build) {
  const pieces = [{ kind: 'skill', name: build.skill.name, effects: build.skill.effects, via: 'skill' }];
  for (const entry of linkedSupports(build)) {
    pieces.push({ kind: 'support', name: entry.support.name, effects: entry.support.effects, via: entry.via });
  }
  for (const notable of build.notables) {
    pieces.push({ kind: 'notable', name: notable.name, effects: notable.effects, via: 'self' });
  }
  for (const keystone of build.keystones) {
    pieces.push({ kind: 'keystone', name: keystone.name, effects: keystone.effects, via: 'self' });
  }
  const skillInUniqueSockets = Boolean(build.skill.grantedBy);
  for (const unique of build.uniques) {
    let effects = unique.effects;
    if (skillInUniqueSockets && !isGrantingUnique(build, unique) && unique.effectsBesideWeaponSkill) {
      effects = unique.effectsBesideWeaponSkill;
    }
    pieces.push({ kind: 'unique', name: unique.name, effects, via: 'self' });
  }
  const buffTerms = (build.buffs || []).length ? buffEffectTermsOf(build) : null;
  for (const buff of build.buffs || []) {
    const scale = buffTerms ? buffEffectScale(buff, buffTerms) : 1;
    if (scale === 0) {
      continue; // a disabled aura (Lone Messenger) gives nothing, flags included
    }
    const effects = scale === 1 ? buff.effects : scaledEffects(buff.effects, scale);
    pieces.push({ kind: buff.kind, name: buff.name, effects, via: 'self' });
  }
  if (build.tree) {
    pieces.push({ kind: 'tree', name: 'Passive tree', effects: build.tree.effects, via: 'self' });
  }
  if (build.gear) {
    pieces.push({ kind: 'gear', name: 'Rare gear', effects: gearEffects(wornGear(build), weaponShareOf(build)), via: 'self' });
  }
  if ((build.flasks || []).length) {
    const terms = flaskTermsOf(pieces);
    for (const flask of build.flasks) {
      const scale = flaskUptime(flask, terms) * (1 + terms.effect / 100);
      pieces.push({ kind: 'flask', name: flask.name, effects: scaledEffects(flask.effects, scale), via: 'self' });
    }
  }
  return pieces;
}

// What the build's other pieces do to its auras, heralds and curses: "increased effect of Non-Curse Auras from your
// Skills", "Anger has 20% increased Aura Effect", "increased Effect of Herald Buffs on you", "increased Effect of your
// Curses". Each scales the lines of the buffs it names. Lines with a condition aren't counted (an aura's effect is
// steady or not worth planning around), nor support gem lines (the main skill's supports don't support auras).
const ALL_AURA_EFFECT_STATS = new Set(['effect:nonCurseAurasFromYourSkills', 'effect:aurasFromYourSkills']);

function buffEffectTermsOf(build) {
  const terms = { aura: 0, auraMore: 1, auraBySkill: new Map(), herald: 0, curse: 0, curseMore: 1, aurasDisabled: false };
  const lists = [build.notables, build.keystones, build.uniques];
  if (build.tree) {
    lists.push([{ effects: build.tree.effects }]);
  }
  for (const list of lists) {
    for (const piece of list || []) {
      for (const effect of piece.effects) {
        addBuffEffectTerm(terms, effect);
      }
    }
  }
  return terms;
}

function addBuffEffectTerm(terms, effect) {
  // Lone Messenger: "Your Aura Skills are Disabled". The flag was read but nothing checked it, so a tree could take the
  // keystone and keep every aura.
  if (effect.kind === 'flag' && effect.stat === 'noAuras') {
    terms.aurasDisabled = true;
    return;
  }
  if ((effect.subject || 'self') !== 'self' || effect.condition) {
    return;
  }
  // "20% less Effect of your Curses" (Hex Master): a multiplier of its own. It was read as a stat nothing used.
  if (effect.kind === 'more') {
    if (ALL_AURA_EFFECT_STATS.has(effect.stat) || (effect.stat === 'effect:aura' && !effect.skill)) {
      terms.auraMore *= 1 + (effect.value || 0) / 100;
    } else if (effect.stat === 'effect:curses') {
      terms.curseMore *= 1 + (effect.value || 0) / 100;
    }
    return;
  }
  if (effect.kind !== 'increased') {
    return;
  }
  const value = effect.value || 0;
  if (ALL_AURA_EFFECT_STATS.has(effect.stat) || (effect.stat === 'effect:aura' && !effect.skill)) {
    terms.aura += value;
  } else if (effect.stat === 'effect:aura') {
    terms.auraBySkill.set(effect.skill, (terms.auraBySkill.get(effect.skill) || 0) + value);
  } else if (effect.stat === 'effect:heraldBuffs') {
    terms.herald += value;
  } else if (effect.stat === 'effect:curses') {
    terms.curse += value;
  }
}

function buffEffectScale(buff, terms) {
  let increased = 0;
  let more = 1;
  if (buff.kind === 'aura') {
    if (terms.aurasDisabled) {
      return 0;
    }
    increased = terms.aura + (terms.auraBySkill.get(buff.baseName || buff.name) || 0) + (buff.ownAuraEffect || 0);
    more = terms.auraMore;
  } else if (buff.kind === 'herald') {
    increased = terms.herald;
  } else if (buff.kind === 'curse') {
    increased = terms.curse;
    more = terms.curseMore;
  }
  return Math.max(0, 1 + increased / 100) * more;
}

// What the build's other pieces do to its flasks: duration, charges gained, effect.
function flaskTermsOf(pieces) {
  const terms = { duration: 0, charges: 0, chargesPerSecond: 0, effect: 0 };
  for (const piece of pieces) {
    for (const effect of piece.effects) {
      if ((effect.subject || 'self') !== 'self') {
        continue;
      }
      const value = effect.value || 0;
      if (effect.stat === 'flaskDuration' && effect.kind === 'increased') {
        terms.duration += value;
      } else if (effect.stat === 'flaskCharges' && effect.kind === 'increased') {
        terms.charges += value;
      } else if (effect.stat === 'flaskChargesPerSecond') {
        terms.chargesPerSecond += value;
      } else if (effect.stat === 'flaskEffect' && effect.kind === 'increased') {
        terms.effect += value;
      }
    }
  }
  return terms;
}

// The share of a fight a utility flask's buff is up.
function flaskUptime(flask, terms) {
  const chargesPerSecond = (FLASK_CHARGES_PER_SECOND + terms.chargesPerSecond) * (1 + terms.charges / 100);
  const duration = (flask.duration || 0) * (1 + terms.duration / 100);
  if (!flask.chargesPerUse) {
    return 0;
  }
  return Math.min(1, duration * chargesPerSecond / flask.chargesPerUse);
}

// The share of the skill's damage of each type after conversions. Conversion moves damage along, and the
// converted damage is then scaled as its new type, which is how a physical skill becomes a fire build.
function damageShares(build, skill, isMinion, tags, minionTypes, flags) {
  const shares = {};
  for (const type of DAMAGE_TYPES) {
    shares[type] = 0;
  }
  const types = skill.damageTypes.length > 0 ? skill.damageTypes : ['physical'];
  for (const type of types) {
    shares[type] += 1 / types.length;
  }
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      if (effect.kind !== 'conversion' || !appliesToSubject(effect, isMinion, tags)) {
        continue;
      }
      if (!minionUsesWhatEffectNames(effect, minionTypes, isMinion)) {
        continue;
      }
      convertShares(shares, effect);
    }
  }
  for (const type of forbiddenDamageTypes(flags)) {
    shares[type] = 0;
  }
  return shares;
}

// Lines that stop damage of some types: Brutality and Void Manipulation's "Supported Skills deal no Elemental
// Damage", Starforge's, Wreath of Phrecia's "deal no Chaos Damage", Dyadian Dawn's "deal no Physical Damage". Damage
// of those types, the skill's own or converted or gained as extra, is lost; it doesn't move to another type.
const DAMAGE_TYPES_STOPPED_BY_FLAG = {
  noPhysical: ['physical'],
  noElemental: ['fire', 'cold', 'lightning'],
  noChaos: ['chaos'],
  onlyFire: ['physical', 'cold', 'lightning', 'chaos'],
  onlyCold: ['physical', 'fire', 'lightning', 'chaos'],
  onlyLightning: ['physical', 'fire', 'cold', 'chaos'],
};

function forbiddenDamageTypes(flags) {
  const forbidden = new Set();
  for (const [flag, types] of Object.entries(DAMAGE_TYPES_STOPPED_BY_FLAG)) {
    if (!flags.has(flag)) {
      continue;
    }
    for (const type of types) {
      forbidden.add(type);
    }
  }
  return forbidden;
}

// The part of an "extra damage" line's types the build can deal (1 when none is stopped).
function allowedShareOfTypes(effect, context) {
  const types = expandDamageTags(effect.tags || []);
  if (types.length === 0) {
    return 1;
  }
  const forbidden = forbiddenDamageTypes(context.flags);
  let allowed = 0;
  for (const type of types) {
    if (!forbidden.has(type)) {
      allowed += 1;
    }
  }
  return allowed / types.length;
}

function convertShares(shares, effect) {
  const targets = expandDamageTags(effect.tags || []);
  const sources = expandDamageTags(effect.from || []);
  if (targets.length === 0 || sources.length === 0) {
    return;
  }
  const fraction = Math.min(effect.value, 100) / 100;
  for (const source of sources) {
    if (targets.includes(source)) {
      continue;
    }
    const moved = shares[source] * fraction;
    shares[source] -= moved;
    for (const target of targets) {
      shares[target] += moved / targets.length;
    }
  }
}

function expandDamageTags(tags) {
  const expanded = [];
  for (const tag of tags) {
    if (tag === 'elemental') {
      expanded.push('fire', 'cold', 'lightning');
    } else if (tag === 'nonChaos') {
      expanded.push('physical', 'fire', 'cold', 'lightning');
    } else if (DAMAGE_TYPES.includes(tag)) {
      expanded.push(tag);
    }
  }
  return [...new Set(expanded)];
}

// A minion line about spells or attacks is about what the minions use, not the summoning spell: Zealotry's spell
// damage doesn't reach a zombie's slam, and Command of the Pit's Unholy Might (on hit with spells) doesn't reach it
// either. True when the effect names neither, or isn't about minions. minionTypes: minionTypesOf(build).
function minionUsesWhatEffectNames(effect, minionTypes, isMinion) {
  if (effect.subject !== 'minion' || !isMinion) {
    return true;
  }
  for (const tag of effect.tags || []) {
    if (tag !== 'spell' && tag !== 'attack') {
      continue;
    }
    const minionType = tag === 'spell' ? 'Spell' : 'Attack';
    if (!minionTypes.has(minionType)) {
      return false;
    }
  }
  return true;
}

// Raise Spectre's minion types in GGG's game files are those of every monster it can raise together: attacks,
// spells, channelled skills, totems, traps. A real spectre is one monster that either attacks or casts, so counting
// all of them gave a spectre attack supports and spell supports at once, both at full worth. The types only one kind
// of spectre has:
const SPECTRE_ATTACK_ONLY_TYPES = new Set(['Attack', 'Melee', 'MeleeSingleTarget', 'Multistrikeable', 'RangedAttack', 'Warcry']);
const SPECTRE_SPELL_ONLY_TYPES = new Set(['Spell', 'Channel']);
// Types only a few spectres have (monsters that place totems, throw traps or mines, channel or shout): planning a
// spectre around them would assume one of those few, so a spectre is planned without them.
const SPECTRE_RARE_TYPES = new Set(['SummonsTotem', 'Trapped', 'RemoteMined', 'Channel', 'Warcry']);

function isSpectreSkill(skill) {
  return (skill.id || '').startsWith('RaiseSpectre');
}

// A spectre's minion types without the rare ones and, for a kind ('attack' or 'spell'), without the other kind's.
function spectreTypesOfKind(skill, kind) {
  let leftOut = new Set();
  if (kind === 'attack') {
    leftOut = SPECTRE_SPELL_ONLY_TYPES;
  } else if (kind === 'spell') {
    leftOut = SPECTRE_ATTACK_ONLY_TYPES;
  }
  const types = new Set();
  for (const type of skill.minionTypes || []) {
    if (!leftOut.has(type) && !SPECTRE_RARE_TYPES.has(type)) {
      types.add(type);
    }
  }
  return types;
}

// Which kind of spectre the build raises: the first support on its minions that only one kind takes decides
// ('attack' or 'spell'), null while none has.
function spectreKindOf(build) {
  const attackTypes = spectreTypesOfKind(build.skill, 'attack');
  const spellTypes = spectreTypesOfKind(build.skill, 'spell');
  for (const entry of build.supports) {
    if (entry.via !== 'minion') {
      continue;
    }
    const fitsAttack = supportMatchesTypes(entry.support, attackTypes);
    const fitsSpell = supportMatchesTypes(entry.support, spellTypes);
    if (fitsAttack && !fitsSpell) {
      return 'attack';
    }
    if (fitsSpell && !fitsAttack) {
      return 'spell';
    }
  }
  return null;
}

// The types of the build's minions: the skill's, and for a spectre those of the kind its supports chose.
function minionTypesOf(build) {
  if (!isSpectreSkill(build.skill)) {
    return new Set(build.skill.minionTypes || []);
  }
  return spectreTypesOfKind(build.skill, spectreKindOf(build));
}

// ---------- does an effect reach this build, and how fully ----------
// Whether the build has a tag. A tag written "claw|dagger" (the vocabulary's "with Claws or Daggers") is any of its
// parts.
function hasTag(tags, tag) {
  if (!tag.includes('|')) {
    return tags.has(tag);
  }
  for (const part of tag.split('|')) {
    if (tags.has(part)) {
      return true;
    }
  }
  return false;
}

function appliesToSubject(effect, isMinion, tags) {
  const subject = effect.subject || 'self';
  if (subject === 'minion') {
    return isMinion;
  }
  if (subject === 'totem') {
    return tags.has('totem');
  }
  if ((subject === 'self' || subject === 'supported') && isMinion) {
    // Your own damage modifiers don't reach minions, and on a minion skill a support's lines about "Supported
    // Skills" speed up summoning, not the minions. Lines about minions are written with subject "minion",
    // except gem levels and a few "minion"-tagged lines.
    return (effect.tags || []).includes('minion') || effect.kind === 'flag' || (effect.stat === 'gemLevel' && subject === 'supported');
  }
  return true;
}

// 0 when the effect doesn't reach the build, else how much of it does (damage type share times how often its
// condition holds).
function effectWeight(effect, context, branch) {
  const coverage = effectCoverage(effect, context);
  if (coverage === 0) {
    return 0;
  }
  return coverage * conditionUptime(effect.condition, context, branch);
}

// The context the engine scores a build in: its skill's types and tags after supports and weapon, whether it is a
// minion or damage-over-time build, its rule flags and its damage split. The tags (public/buildtags.js) test
// pieces against it.
export function buildContext(build) {
  return contextOf(build);
}

// Whether an effect could change this build's score at all, whatever its condition: a defence of your own, a rule
// (flag), a conversion (which changes what else reaches the build), or an effect that reaches the skill. Anything
// else adds nothing, so the planner can skip it without measuring it.
export function effectCanMatter(effect, context) {
  if ((effect.subject || 'self') === 'self' && DEFENCE_STATS.has(effect.stat)) {
    return true;
  }
  if (effect.kind === 'flag' || effect.kind === 'conversion') {
    return true;
  }
  return effectReaches(effect, context);
}

// Whether an effect can reach the build at all, whatever its condition: its subject, its required tags, its scope
// tags and the skill it names fit, and its damage types are some of the build's damage. Exported for the tags
// (public/buildtags.js), which skip the pieces none of whose effects reach a build.
export function effectReaches(effect, context) {
  return effectCoverage(effect, context) > 0;
}

// How much of the build's damage an effect scales: 0 when it doesn't reach the build, 1 when it reaches all of it,
// in between when it names some of the build's damage types.
function effectCoverage(effect, context) {
  if (!appliesToSubject(effect, context.isMinion, context.tags)) {
    return 0;
  }
  for (const required of effect.requires || []) {
    if (!hasTag(context.tags, required)) {
      return 0;
    }
  }
  let coverage = 1;
  const damageTags = [];
  for (const tag of effect.tags || []) {
    if (DAMAGE_TYPE_TAGS.has(tag)) {
      damageTags.push(tag);
      continue;
    }
    if (tag === 'minion' && context.isMinion) {
      continue;
    }
    if ((tag === 'spell' || tag === 'attack') && effect.subject === 'minion' && context.isMinion) {
      if (!minionUsesWhatEffectNames(effect, context.minionTypes, context.isMinion)) {
        return 0;
      }
      continue;
    }
    if (AILMENT_TAGS.has(tag) || tag === 'dot') {
      if (!context.tags.has(tag) && !(tag === 'dot' && context.isDamageOverTime)) {
        return 0;
      }
      continue;
    }
    if (!hasTag(context.tags, tag)) {
      return 0;
    }
  }
  if (effect.skill && !namesSkill(effect.skill, context.skill.name)) {
    return 0;
  }
  // Damage types limit how much of the damage an effect scales ("increased Cold Damage" on a half-cold skill);
  // penetration, exposure, conversion and extra damage handle their types themselves.
  const typeHandledElsewhere = ['penetration', 'exposure', 'resistance', 'conversion', 'extra'].includes(effect.kind);
  if (damageTags.length > 0 && !typeHandledElsewhere) {
    coverage = 0;
    for (const type of expandDamageTags(damageTags)) {
      coverage += context.shares[type];
    }
    coverage = Math.min(coverage, 1);
    if (coverage === 0) {
      return 0;
    }
  }
  return coverage;
}

// "while affected by Hatred" (the vocabulary's condition "affectedBy:Hatred"): when Hatred is an aura, herald or curse
// the build could run, the line holds exactly when it runs it. Another name (Elusive, an Aspect, Arcane Surge's
// riders are read elsewhere) isn't one of the build's pieces, so it keeps the generic uptime.
const AFFECTED_BY = 'affectedBy:';
let knownBuffNames = new Set();

function affectedByUptime(name, context) {
  if (!knownBuffNames.has(name)) {
    return CONDITION_UPTIME.other;
  }
  return context.buffNames && context.buffNames.has(name) ? 1 : 0;
}

// A defence under a condition that holds for a whole fight isn't discounted: the listed ones, and an aura the build
// runs.
function isConsistentCondition(condition) {
  return CONSISTENT_CONDITIONS.has(condition) || condition.startsWith(AFFECTED_BY) || condition.startsWith(PER_ATTRIBUTE);
}

// "per 16 Intelligence" (perAttribute:int:16): the line counts once for each 16 Intelligence the build has.
const PER_ATTRIBUTE = 'perAttribute:';
function perAttributeTimes(condition, context) {
  const [, attribute, per] = condition.split(':');
  if (!context.attributesNow) {
    return 0; // the reference character has no build to count
  }
  return Math.max(0, context.attributesNow()[attribute] || 0) / Math.max(1, Number(per));
}

// "+5 to Level of all Cyclone Gems" names its skill; transfigured versions ("Cyclone of Tumult") count too.
function namesSkill(effectSkill, skillName) {
  const wanted = effectSkill.toLowerCase().replace(/^all /, '').replace(/ gems?$/, '').trim();
  const name = skillName.toLowerCase();
  return name === wanted || name.startsWith(wanted + ' of ');
}

// Whether the build deals damage of the element an ailment needs, or has a line letting all damage cause it.
function causesElementalAilment(context, element, allDamageFlag) {
  if (context.flags.has(allDamageFlag)) {
    return true;
  }
  return (context.shares[element] || 0) > 0;
}

// Conditions that depend on what the build is, our estimates (2026-11-25; each had read as 3 stacks, "nearby" or a
// generic 50%, so builds that can't meet them took them):
//   close range: a melee hit is always there; a ranged build is close now and then.
//   enemies in close range: a boss and a few adds stand by a melee build, about one and a half on average.
//   enemies on full life: only each enemy's first hit.
//   skills that cost life: only when the main skill is paid with life (Blood Magic, Lifetap, a life-cost skill).
//   different spells cast recently: the main skill and one more (a curse, a guard, a movement spell).
//   empty sockets: one, the gem it would have held being given up.
//   your own Consecrated Ground (Bitter Heresy's Profane Ground): half the time with a way to make it, else never.
const CLOSE_RANGE_RANGED_UPTIME = 0.3;
const MELEE_ENEMIES_IN_CLOSE_RANGE = 1.5;
const RANGED_ENEMIES_IN_CLOSE_RANGE = 0.3;
const ENEMY_FULL_LIFE_UPTIME = 0.05;
const DIFFERENT_SPELLS_RECENTLY = 2;
const CONSECRATED_GROUND_UPTIME = 0.5;
const CONSECRATED_GROUND_SKILLS = ['Consecrated Path', 'Sanctify', 'Holy Relic'];
const OWN_SITUATION_CONDITIONS = {
  closeRange: context => (context.tags.has('melee') ? 1 : CLOSE_RANGE_RANGED_UPTIME),
  perEnemyInCloseRange: context => (context.tags.has('melee') ? MELEE_ENEMIES_IN_CLOSE_RANGE : RANGED_ENEMIES_IN_CLOSE_RANGE),
  enemyFullLife: () => ENEMY_FULL_LIFE_UPTIME,
  skillCostsLife: context => (skillPaidWithLife(context) ? 1 : 0),
  perDifferentSpellRecently: context => (context.tags.has('spell') ? DIFFERENT_SPELLS_RECENTLY : 1),
  perEmptySocket: () => 1,
  ownConsecratedGround: context => (makesConsecratedGround(context) ? CONSECRATED_GROUND_UPTIME : 0),
};

function skillPaidWithLife(context) {
  const cost = context.skill.cost || {};
  return cost.type === 'life' || context.flags.has('costLife') || context.flags.has('bloodMagic');
}

function makesConsecratedGround(context) {
  if (context.flags.has('consecratedGroundSource')) {
    return true;
  }
  for (const name of CONSECRATED_GROUND_SKILLS) {
    if (context.skill.name === name || context.skill.name.startsWith(name + ' of ')) {
      return true;
    }
  }
  return false;
}

function conditionUptime(condition, context, branch) {
  if (!condition) {
    return 1;
  }
  if (condition.startsWith(AFFECTED_BY)) {
    return affectedByUptime(condition.slice(AFFECTED_BY.length), context);
  }
  if (condition.startsWith(PER_ATTRIBUTE)) {
    return perAttributeTimes(condition, context);
  }
  if (condition === 'perStack') {
    return STACKS_ASSUMED;
  }
  if (condition === 'impale') {
    return context.impaleChance || 0;
  }
  if (condition === 'perEnduranceCharge') {
    return context.enduranceCharges || 0;
  }
  // "while you have no Energy Shield" (Broken Faith): holds for a build whose pool has none, once its defences are
  // known (evaluateBuild works them out before the offence).
  if (condition === 'noEnergyShieldPool') {
    if (!context.defence) {
      return 1;
    }
    return context.defence.energyShield > 0 ? 0 : 1;
  }
  // Unholy Might is one buff: minions that always have it (Unnatural Strength) gain nothing from a chance to gain it.
  if (condition === 'minionUnholyMightOnHit' && context.flags.has('minionsHaveUnholyMight')) {
    return 0;
  }
  if (condition === 'onCrit' || condition === 'recentCrit') {
    if (branch.crit) {
      return condition === 'recentCrit' ? 0.95 : branch.critChance;
    }
    if (condition === 'recentCrit' && context.flags.has('elementalOverload') && branch.critChance >= 0.08) {
      return 0.85; // Elemental Overload only needs an occasional crit
    }
    return 0;
  }
  if (condition === 'nonCrit') {
    return branch.crit ? 1 - branch.critChance : 1;
  }
  if (condition === 'noRecentCrit') {
    return branch.crit ? 0.05 : 1; // a crit build has always crit recently
  }
  if (condition === 'totem') {
    return context.tags.has('totem') ? 1 : 0;
  }
  if (condition === 'stationary') {
    return context.tags.has('channel') || context.tags.has('totem') ? 1 : 0.35;
  }
  if (condition === 'channel') {
    return context.tags.has('channel') ? 1 : 0;
  }
  if (condition === 'dualWield' || condition === 'shield') {
    return context.tags.has(condition) ? 1 : 0;
  }
  if (condition === 'enemyChilled' && context.shares.cold > 0.3) {
    return 0.9;
  }
  // Ignite needs fire damage and shock lightning damage (unless "All Damage can Ignite/Shock"): a build without that
  // damage leaves none of it on the enemy. It counted 40% for everyone, so a physical attack build took Fire Mastery's
  // "100% increased Damage with Hits against Ignited Enemies" (in 28% of builds, 2026-11-25).
  if (condition === 'enemyIgnited' && !causesElementalAilment(context, 'fire', 'allDamageCanIgnite')) {
    return 0;
  }
  if (condition === 'enemyShocked' && !causesElementalAilment(context, 'lightning', 'allDamageCanShock')) {
    return 0;
  }
  if (condition === 'enemyShocked' && context.shares.lightning > 0.3) {
    return 0.8;
  }
  // With "Non-Critical Strikes cannot inflict Ailments", a plan that doesn't crit leaves no ailment on the enemy.
  const inflictsAilments = !(context.flags.has('critOnlyAilments') && !branch.crit);
  if (!inflictsAilments && ['enemyChilled', 'enemyShocked', 'enemyIgnited', 'enemyPoisoned', 'enemyBleeding'].includes(condition)) {
    return 0;
  }
  if (condition === 'enemyIgnited' && (context.shares.fire > 0.3 || context.ailment === 'ignite')) {
    return 0.9;
  }
  if (condition === 'enemyPoisoned' && context.ailment === 'poison') {
    return 1;
  }
  if (condition === 'enemyBleeding' && context.ailment === 'bleed') {
    return 1;
  }
  // Crimson Dance's bleeding cannot be Aggravated.
  if (condition === 'aggravatedBleed') {
    if (context.flags.has('crimsonDance')) {
      return 0;
    }
    return 1;
  }
  if (condition === 'lowLife' && context.flags.has('lifeCappedAtLowLife')) {
    return 1;
  }
  if (condition === 'unreservedMana') {
    const unreserved = context.defence ? context.defence.unreservedMana : UNRESERVED_MANA_REFERENCE;
    return Math.min(UNRESERVED_MANA_FACTOR_MAX, unreserved / UNRESERVED_MANA_REFERENCE);
  }
  if (condition === 'accuracyAboveLife') {
    return accuracyAboveLifeUptime(context);
  }
  if (condition in OWN_SITUATION_CONDITIONS) {
    return OWN_SITUATION_CONDITIONS[condition](context);
  }
  if (condition === 'arcaneSurge' && context.tags.has('spell')) {
    return 0.7;
  }
  if (condition in CONDITION_UPTIME) {
    return CONDITION_UPTIME[condition];
  }
  return CONDITION_UPTIME.other;
}

// ---------- offence ----------
function baseRate(context) {
  const skill = context.skill;
  if (context.isMinion) {
    return 1;
  }
  if (context.isDamageOverTime && !context.types.has('Damage')) {
    return 1;
  }
  const effectiveness = (skill.effectiveness || 100) / 100;
  if (context.types.has('Attack')) {
    return effectiveness * (skill.attackSpeedMultiplier || 100) / 100;
  }
  const castTime = skill.castTime && skill.castTime > 0 ? skill.castTime : 0.75;
  // A dampened rate: cast time matters, but base damage per cast mostly makes up for slow skills.
  return Math.sqrt(effectiveness * 0.75 / castTime);
}

function gemLevelGain(context) {
  if (context.isMinion) {
    return DAMAGE_PER_GEM_LEVEL.minion;
  }
  if (context.types.has('Attack')) {
    return DAMAGE_PER_GEM_LEVEL.attack;
  }
  if (context.isDamageOverTime) {
    return DAMAGE_PER_GEM_LEVEL.dot;
  }
  return DAMAGE_PER_GEM_LEVEL.spell;
}

function speedStatApplies(stat, context) {
  if (stat === 'speed') {
    return true;
  }
  if (context.isMinion) {
    return minionSpeedStatApplies(stat, context.minionTypes);
  }
  if (stat === 'castSpeed') {
    return context.tags.has('spell');
  }
  if (stat === 'attackSpeed') {
    return context.tags.has('attack');
  }
  return false;
}

// Minions cast faster with cast speed when they cast spells (Skeleton Mages, a spell spectre) and attack faster with
// attack speed when they attack. Minions whose types say neither keep attack speed, as before cast speed was read.
function minionSpeedStatApplies(stat, minionTypes) {
  const casts = minionTypes.has('Spell');
  if (stat === 'castSpeed') {
    return casts;
  }
  if (stat === 'attackSpeed') {
    return minionTypes.has('Attack') || !casts;
  }
  return false;
}

// The offence index of one branch (crit or not). Returns the index and each piece's contributions for the
// "why" notes.
function offenceOf(build, context, branch) {
  // A build without a planned tree gets the fixed allowance in its place.
  const allowance = build.tree ? null : TREE_ALLOWANCE;
  let solvedFigures = SOLVED_GEAR_ALLOWANCE;
  if (build.gear && wornGear(build).items.some(item => item.slot === 'weapon')) {
    solvedFigures = SOLVED_GEAR_WITH_WEAPON_ALLOWANCE;
  }
  const gearFigures = build.gear ? solvedFigures : { increased: GEAR_INCREASED_DAMAGE, speed: GEAR_INCREASED_SPEED,
    dotMultiplier: GEAR_DOT_MULTIPLIER, critIncreased: GEAR_INCREASED_CRIT, critMultiplier: GEAR_CRIT_MULTIPLIER };
  let increased = gearFigures.increased + (allowance ? allowance.increased : 0);
  let more = 1;
  let speedIncreased = gearFigures.speed + (allowance ? allowance.speed : 0);
  let speedMore = 1;
  let critIncreased = branch.crit ? gearFigures.critIncreased + (allowance ? allowance.critIncreased : 0) : 0;
  let critMore = 1;
  let baseCrit = context.isMinion ? MINION_BASE_CRIT : (context.types.has('Attack') ? ATTACK_WEAPON_BASE_CRIT : (context.skill.baseCrit || 5));
  // An attack build's solved weapons: their physical hit, speed and local crit against the reference rare.
  const weaponFactors = attackWeaponFactors(build, context);
  if (weaponFactors) {
    baseCrit = (ATTACK_WEAPON_BASE_CRIT + weaponFactors.critFlat) * (1 + weaponFactors.critIncreased / 100);
  }
  let critMultiplier = BASE_CRIT_MULTIPLIER + (branch.crit ? gearFigures.critMultiplier + (allowance ? allowance.critMultiplier : 0) : 0);
  let levels = 0;
  let dotMultiplier = context.isDamageOverTime || context.ailment ? gearFigures.dotMultiplier + (allowance ? allowance.dotMultiplier : 0) : 0;
  let added = 0;
  let extra = 0;
  let totems = 1;
  const impale = { effect: 0, hits: 0, extra: 0 };
  // Base damage that is a share of a defence (Righteous Fire): the build's share against a bare character's.
  let baseFromDefence = 0;
  let referenceBaseFromDefence = 0;
  const resistanceDrop = { fire: 0, cold: 0, lightning: 0, chaos: 0, physical: 0 };
  // A hit that builds on an ailment deals two parts, the hit and the ailment it leaves: lines about the ailment or
  // damage over time scale only the second, and penetration (which works on hits only) only the first.
  const ailmentFromHits = hitsInflictAilment(context);
  const ailmentPart = { increased: 0, more: 1 };
  const ailmentResistanceDrop = { fire: 0, cold: 0, lightning: 0, chaos: 0, physical: 0 };
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      const weight = effectWeight(effect, context, branch);
      if (weight === 0) {
        continue;
      }
      const value = (effect.value || 0) * weight;
      // A damage over time multiplier of the ailment's damage type scales all of it, however little of the hit is that
      // type ("+10% to Fire Damage over Time Multiplier" on a half-fire hit that ignites); another type's adds nothing.
      // Lines about the ailment of its damage type scale all of it the same way ("increased Burning Damage").
      if (ailmentFromHits && effect.stat === 'dotMulti') {
        if (damageTypesReachAilment(effect, context)) {
          dotMultiplier += (effect.value || 0) * ailmentConditionUptime(effect.condition, context, branch);
        }
        continue;
      }
      if (ailmentFromHits && effect.stat === 'damage' && isAilmentOnlyEffect(effect)) {
        if (!damageTypesReachAilment(effect, context)) {
          continue;
        }
        const ailmentValue = (effect.value || 0) * ailmentConditionUptime(effect.condition, context, branch);
        if (effect.kind === 'increased') {
          ailmentPart.increased += ailmentValue;
          continue;
        }
        if (effect.kind === 'more') {
          ailmentPart.more *= 1 + ailmentValue / 100;
          continue;
        }
      }
      if (ailmentFromHits && effect.stat === 'ailmentSpeed') {
        ailmentPart.more *= 1 + value / 100;
        continue;
      }
      if (ailmentFromHits && (effect.kind === 'exposure' || (effect.kind === 'resistance' && effect.subject === 'enemy'))) {
        dropResistance(ailmentResistanceDrop, effect, value);
      }
      if (effect.kind === 'perDefence') {
        const defence = context.defence ? context.defence[effect.defence] || 0 : null;
        if (effect.as === 'base') {
          referenceBaseFromDefence += value / 100 * (REFERENCE_DEFENCE[effect.defence] || 0);
          baseFromDefence += value / 100 * (defence ?? REFERENCE_DEFENCE[effect.defence] ?? 0);
        } else if (defence !== null) {
          const amount = value * defence / (effect.per || 1);
          if (effect.as === 'increased') {
            increased += amount;
          } else if (effect.as === 'added') {
            added += amount;
          }
        }
      } else if (effect.stat === 'damage' && effect.kind === 'increased') {
        increased += value;
      } else if (effect.stat === 'mana' && effect.kind === 'increased' && (effect.subject || 'self') === 'self' && context.flags.has('transfigurationOfMind')) {
        increased += value * TRANSFIGURATION_SHARE;
      } else if (effect.stat === 'life' && effect.kind === 'increased' && (effect.subject || 'self') === 'self' && context.flags.has('transfigurationOfBody') && context.types.has('Attack')) {
        increased += value * TRANSFIGURATION_SHARE;
      } else if (effect.stat === 'damage' && effect.kind === 'more') {
        more *= 1 + value / 100;
      } else if (effect.kind === 'increased' && speedStatApplies(effect.stat, context)) {
        speedIncreased += value;
      } else if (effect.kind === 'more' && speedStatApplies(effect.stat, context)) {
        speedMore *= 1 + value / 100;
      } else if (effect.stat === 'ailmentSpeed') {
        // Faster ailments only help damage that is an ailment or burns over time.
        if (context.isDamageOverTime || context.ailment) {
          more *= 1 + value / 100;
        }
      } else if (effect.stat === 'critChance' && effect.kind === 'increased') {
        critIncreased += value;
      } else if (effect.stat === 'critChance' && effect.kind === 'more') {
        critMore *= 1 + value / 100;
      } else if (effect.stat === 'baseCrit') {
        baseCrit += value;
      } else if (effect.stat === 'critMulti' && effect.kind === 'flat') {
        critMultiplier += value;
      } else if (effect.stat === 'gemLevel') {
        // A skill a unique grants has the unique's level: it isn't a gem, so gem levels don't reach it.
        if (!context.skill.grantedBy) {
          levels += value;
        }
      } else if (effect.stat === 'dotMulti') {
        dotMultiplier += value;
      } else if (effect.kind === 'added' && effect.stat === 'damage') {
        added += value;
      } else if (effect.kind === 'extra' && effect.stat === 'damage') {
        extra += value * sourceShare(effect, context) * allowedShareOfTypes(effect, context);
      } else if (effect.kind === 'penetration' || effect.kind === 'exposure' || (effect.kind === 'resistance' && effect.subject === 'enemy')) {
        dropResistance(resistanceDrop, effect, value);
      } else if (effect.stat === 'effect:impale' && effect.kind === 'increased') {
        impale.effect += value;
      } else if (effect.stat === 'impaleHits') {
        impale.hits += value;
      } else if (effect.stat === 'impaleExtra') {
        impale.extra += value;
      } else if (effect.kind === 'limit' && effect.stat === 'totems') {
        totems += value;
      } else if (effect.kind === 'flag' && effect.stat === 'extraTotem') {
        totems += 1;
      }
    }
  }
  // Rage: 1% more Attack Damage per Rage, and with Crave the Slaughter 1% increased Attack Speed per Rage too.
  if (context.rage > 0) {
    more *= 1 + context.rage / 100;
    if (context.flags.has('rageGrantsAttackSpeed')) {
      speedIncreased += context.rage;
    }
  }
  // Enmity's Embrace: hits penetrate fire resistance by the overcapped fire resistance, up to 200%.
  if (context.flags.has('penetrationFromOvercappedFire') && context.defence && !context.isDamageOverTime) {
    resistanceDrop.fire += Math.min(200, context.defence.overcappedFire || 0);
  }
  const critChance = Math.min(1, Math.max(0, baseCrit * (1 + critIncreased / 100) * critMore / 100));
  let critFactor = 1;
  // Damage over time never crits, and Critical Strike Multiplier never reaches an ailment: this is the hit's part.
  // Ailments gain from crits through their own lines ("from Critical Strikes") and Perfect Agony, below.
  const hits = !(context.isDamageOverTime && !context.types.has('Damage'));
  if (branch.crit && hits) {
    let multiplier = critMultiplier;
    if (context.flags.has('noCritDamage')) {
      multiplier = 100;
    }
    critFactor = 1 + critChance * (multiplier / 100 - 1);
  }
  if (weaponFactors) {
    speedMore *= weaponFactors.speed;
  }
  if (hitsWithWeapon(context) && context.tags.has('dualWield')) {
    speedMore *= 1 + DUAL_WIELD_ATTACK_SPEED_MORE / 100;
  }
  // The weapon's own damage (1 for the reference rare) plus added flat damage against the reference hit: for an
  // attack, the reference rare's hit on its weapon's base, so flat damage adds less to a two-hander's bigger hit.
  const weaponDamage = weaponFactors ? weaponFactors.damage : 1;
  const referenceWeapon = hitsWithWeapon(context) ? referenceWeaponOf(build.weapon) : null;
  const referenceHit = referenceWeapon ? referenceWeapon.hit : REFERENCE_HIT_DAMAGE;
  const hitFactor = context.isDamageOverTime || context.isMinion ? 1 : weaponDamage + Math.min(2, added * (context.skill.effectiveness || 100) / 100 / referenceHit);
  // The weapon base's damage per second (the reference rare on it) against the reference one-handed sword's: a
  // Karui Chopper hits harder than an Imperial Staff. It was left out, and each weapon was measured against its own
  // bare skill, so every weapon base counted the same and a staff's block cost it no damage (staves took 48% of melee
  // builds, 2026-11-25).
  const weaponBaseFactor = referenceWeapon ? referenceWeapon.damagePerSecond / referenceAttackDamagePerSecond() : 1;
  // A hit that inflicts an ailment gets its damage over time multiplier in the ailment's part, below.
  const dotFactor = context.isDamageOverTime || (context.ailment && !ailmentFromHits) ? 1 + dotMultiplier / 100 : 1;
  const levelFactor = 1 + gemLevelGain(context) * levels;
  const speedFactor = context.isDamageOverTime && !context.ailment ? 1 : (1 + speedIncreased / 100) * speedMore;
  const totemFactor = context.tags.has('totem') ? Math.min(MAX_TOTEMS, totems) : 1;
  const resistanceFactor = resistanceFactorOf(context, resistanceDrop);
  const impaleFactor = hits ? impaleFactorOf(context, impale) : 1;
  const defenceBaseFactor = referenceBaseFromDefence > 0 ? Math.max(0.1, baseFromDefence / referenceBaseFromDefence) : 1;
  const landedFactor = hits ? hitChanceOf(context) : 1;
  let value = baseRate(context) * (1 + increased / 100) * more * critFactor * hitFactor * dotFactor * levelFactor
    * speedFactor * totemFactor * resistanceFactor * (1 + extra / 100) * impaleFactor * defenceBaseFactor * landedFactor
    * weaponBaseFactor;
  if (ailmentFromHits) {
    // The hit's damage before crits and resistances, per second: what the ailment is a share of.
    const plainHitPerSecond = baseRate(context) * (1 + increased / 100) * more * hitFactor * levelFactor * speedFactor
      * totemFactor * (1 + extra / 100) * defenceBaseFactor * landedFactor * weaponBaseFactor;
    const hitsPerSecond = usesPerSecondOf(build, context, (1 + speedIncreased / 100) * speedMore) * totemFactor;
    const ailmentModifiers = { increased, ailmentPart, dotMultiplier, critMultiplier, critChance, branch,
      resistanceDrop: ailmentResistanceDrop };
    value += ailmentDamagePerSecond(context, plainHitPerSecond, hitsPerSecond, ailmentModifiers);
  }
  const sheetFactors = (1 + increased / 100) * more * critFactor * levelFactor * speedFactor * totemFactor * (1 + extra / 100)
    * impaleFactor;
  const dps = attackSheetDps(context, build.weapon, added, sheetFactors, weaponDamage);
  // How much faster than its base the skill is used, which is also how much faster it spends mana: a damage-over-time
  // skill's speed doesn't raise its damage, but each cast still costs.
  const useSpeed = (1 + speedIncreased / 100) * speedMore;
  return { value: Math.max(value, 0.0001), critChance, dps, useSpeed };
}

// The solved weapons' factors (public/buildgear.js, solvedWeaponFactors) for the build's own attacks; null for
// spells, minions and builds whose weapons aren't solved (the reference rare stands in).
function attackWeaponFactors(build, context) {
  if (!context.types.has('Attack') || context.isMinion) {
    return null;
  }
  // A unique weapon is weighed against the reference rare on the planned weapon's base.
  return solvedWeaponFactors(build, weaponBases ? weaponBases[build.weapon] || null : null);
}

// ---------- ailments inflicted by hits ----------
// A hit skill planned on an ailment (the wide search's ignite, bleeding and poison variants) deals its hit and the
// ailment the hit leaves. A damage-over-time skill and minions keep their single part.
function hitsInflictAilment(context) {
  if (!context.ailment || context.isMinion) {
    return false;
  }
  if (!AILMENT_RULES[context.ailment]) {
    return false;
  }
  return !context.isDamageOverTime || context.types.has('Damage');
}

// "increased Damage with Ignite", "Damage over Time": lines that scale only the ailment's part.
function isAilmentOnlyEffect(effect) {
  for (const tag of effect.tags || []) {
    if (AILMENT_TAGS.has(tag) || tag === 'dot') {
      return true;
    }
  }
  return false;
}

// A line about the ailment's damage ("Damage over Time Multiplier", "increased Damage with Ignite") reaches it when
// it names no damage type, or names the ailment's own.
function damageTypesReachAilment(effect, context) {
  const rule = AILMENT_RULES[context.ailment];
  const damageTags = [];
  for (const tag of effect.tags || []) {
    if (DAMAGE_TYPE_TAGS.has(tag)) {
      damageTags.push(tag);
    }
  }
  if (damageTags.length === 0) {
    return true;
  }
  const named = expandDamageTags(damageTags);
  for (const type of rule.damageTypes) {
    if (named.includes(type)) {
      return true;
    }
  }
  return false;
}

// A line's uptime for the ailment's part. "Ailments from Critical Strikes" lines hold for every ailment when only crits
// inflict them (Perfect Agony), not for the crit share of them.
function ailmentConditionUptime(condition, context, branch) {
  if (condition === 'onCrit' && context.flags.has('critOnlyAilments') && branch.crit) {
    return 1;
  }
  return conditionUptime(condition, context, branch);
}

// How often a hit inflicts the ailment. A build planned on an ailment is taken to apply it with every hit (its
// supports and lines give the chance); with "Non-Critical Strikes cannot inflict Ailments" (Perfect Agony) only crits
// do, so a plan that doesn't crit inflicts none.
function ailmentChanceOf(context, branch, critChance) {
  if (!context.flags.has('critOnlyAilments')) {
    return 1;
  }
  if (!branch.crit) {
    return 0;
  }
  return critChance;
}

// The share of the time an enemy has the ailment when only the strongest counts: the chance that at least one hit
// within its duration inflicted it.
function strongestAilmentUptime(chance, hitsPerSecond, duration) {
  if (chance >= 1) {
    return 1;
  }
  return 1 - Math.pow(1 - chance, hitsPerSecond * duration);
}

// How many of the ailment are on the enemy at once and dealing damage: one (the strongest, while it is up), the
// bleeds Crimson Dance keeps (see CRIMSON_DANCE_BLEEDS_KEPT), or every poison the hits inflict within its duration.
function ailmentsOnEnemy(context, rule, chance, hitsPerSecond) {
  const inflictedWithinDuration = hitsPerSecond * chance * rule.duration;
  if (rule.stacks) {
    return inflictedWithinDuration;
  }
  const uptime = strongestAilmentUptime(chance, hitsPerSecond, rule.duration);
  if (context.ailment === 'bleed' && context.flags.has('crimsonDance')) {
    const kept = Math.min(CRIMSON_DANCE_MAX_BLEEDS, inflictedWithinDuration * CRIMSON_DANCE_BLEEDS_KEPT);
    return Math.max(uptime, kept);
  }
  return uptime;
}

// The ailment's damage per second, in the same units as the hit's part: a share of the plain hit (before crits and
// resistances) that inflicted it, scaled by its own lines and damage over time multiplier, against the enemy's
// resistances to its damage types (exposure and curses lower them; penetration works on hits only). With Perfect
// Agony its damage over time multiplier is the crit multiplier instead (the keystone's "is equal to").
function ailmentDamagePerSecond(context, plainHitPerSecond, hitsPerSecond, modifiers) {
  const rule = AILMENT_RULES[context.ailment];
  const chance = ailmentChanceOf(context, modifiers.branch, modifiers.critChance);
  if (chance <= 0 || hitsPerSecond <= 0) {
    return 0;
  }
  let dotMultiplier = modifiers.dotMultiplier;
  if (context.flags.has('perfectAgony')) {
    dotMultiplier = modifiers.critMultiplier - 100;
  }
  let typeShare = 0;
  for (const type of rule.damageTypes) {
    typeShare += context.shares[type] * resistanceFactorOfType(type, modifiers.resistanceDrop);
  }
  if (typeShare <= 0) {
    return 0;
  }
  const ownIncreased = (1 + (modifiers.increased + modifiers.ailmentPart.increased) / 100) / (1 + modifiers.increased / 100);
  const scale = ownIncreased * modifiers.ailmentPart.more * (1 + dotMultiplier / 100) * typeShare;
  const plainHit = plainHitPerSecond / hitsPerSecond;
  const onEnemy = ailmentsOnEnemy(context, rule, chance, hitsPerSecond);
  return plainHit * rule.damagePerSecond * onEnemy * scale;
}

// ---------- accuracy ----------
// Whether the skill's hits can miss: attacks of your own can, unless something makes them unevadable.
function hitsCanMiss(context) {
  if (!context.types.has('Attack') || context.isMinion) {
    return false;
  }
  if (context.flags.has('neverMiss')) {
    return false;
  }
  return true;
}

// The share of the skill's hits that land (0.05 to 1). The bare reference (bareOffence) has every hit land, the
// skill's damage as listed, so a miss is a loss against it as it is beside a spell.
function hitChanceOf(context) {
  if (!hitsCanMiss(context) || context.everyHitLands) {
    return 1;
  }
  const accuracy = context.accuracy ?? 0;
  const chance = 1.25 * accuracy / (accuracy + ENEMY_EVASION_TERM);
  return Math.min(1, Math.max(MIN_HIT_CHANCE, chance));
}

// The build's accuracy rating: the character's own (level and Dexterity), the gear's, and the accuracy lines of its
// pieces that reach the skill, as flat x (1 + increased) x more.
function accuracyOf(build, context) {
  const allowance = build.tree ? null : TREE_ALLOWANCE;
  let flat = CHARACTER_ACCURACY + ACCURACY_PER_DEXTERITY * attributeSupplyOf(build).dex;
  // A solved attack weapon's accuracy lines are the gear's own; otherwise the weapon's line is assumed.
  if (build.gear && !attackWeaponFactors(build, context)) {
    flat += SOLVED_GEAR_WEAPON_ACCURACY;
  } else if (!build.gear) {
    flat += GEAR_ACCURACY;
  }
  let increased = allowance ? allowance.accuracyIncreased : 0;
  let more = 1;
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      if (effect.stat !== 'accuracy') {
        continue;
      }
      const weight = effectWeight(effect, context, NO_CRIT_BRANCH);
      if (weight === 0) {
        continue;
      }
      const value = (effect.value || 0) * weight;
      if (effect.kind === 'flat') {
        flat += value;
      } else if (effect.kind === 'increased') {
        increased += value;
      } else if (effect.kind === 'more') {
        more *= 1 + value / 100;
      }
    }
  }
  return Math.max(0, flat * (1 + increased / 100) * more);
}

// Precise Technique's "if Accuracy Rating is higher than Maximum Life": holds or not once both are known; before
// that (the planner's first look at a piece) it counts as an ordinary condition.
function accuracyAboveLifeUptime(context) {
  if (context.accuracy === undefined || !context.defence) {
    return CONDITION_UPTIME.other;
  }
  return context.accuracy > context.defence.life ? 1 : 0;
}

// What Impale adds to the hits, as a factor: each hit also deals the stored share of every Impale on the enemy. The
// Impales on an enemy you keep hitting are the impaling hits among the last few (chance x Impales each inflicts x
// hits each lasts), no more than 5. Physical damage after conversion is what is stored.
function impaleFactorOf(context, impale) {
  if (!(context.impaleChance > 0) || !(context.shares.physical > 0)) {
    return 1;
  }
  const impalesPerImpalingHit = 1 + impale.extra;
  const hitsEachLasts = IMPALE_HITS + impale.hits;
  const impalesOnEnemy = Math.min(MAX_IMPALES, context.impaleChance * impalesPerImpalingHit * hitsEachLasts);
  const storedShare = IMPALE_STORED_SHARE * (1 + impale.effect / 100);
  return 1 + context.shares.physical * storedShare * impalesOnEnemy;
}

function sourceShare(effect, context) {
  const sources = expandDamageTags(effect.from || []);
  if (sources.length === 0) {
    return 1;
  }
  let share = 0;
  for (const source of sources) {
    share += context.shares[source];
  }
  return Math.min(1, share);
}

function dropResistance(resistanceDrop, effect, value) {
  const types = expandDamageTags(effect.tags || []);
  // Exposure and curses are written as negative resistances ("-20% to Cold Resistance"); penetration as positive.
  const amount = Math.abs(value);
  for (const type of types) {
    resistanceDrop[type] += amount;
  }
}

function resistanceFactorOf(context, resistanceDrop) {
  let factor = 0;
  for (const type of DAMAGE_TYPES) {
    const share = context.shares[type];
    if (share === 0) {
      continue;
    }
    if (type === 'physical') {
      factor += share;
      continue;
    }
    factor += share * resistanceFactorOfType(type, resistanceDrop);
  }
  return factor;
}

// How much of one damage type's damage gets through the enemy's resistance, against an enemy at its base resistance.
function resistanceFactorOfType(type, resistanceDrop) {
  if (type === 'physical') {
    return 1;
  }
  const base = type === 'chaos' ? ENEMY_CHAOS_RESISTANCE : ENEMY_ELEMENTAL_RESISTANCE;
  const resistance = Math.max(-50, base - resistanceDrop[type]);
  return (100 - resistance) / (100 - base);
}

// Tries the crit and non-crit ways of building the same pieces and keeps the better one.
// The weapon bases by weapon tag (set by prepareMechanics from the mechanics file).
let weaponBases = null;

// The one-handed melee weapons a shield build may hold: its reference is the best of their bases.
const SHIELD_HAND_WEAPONS = ['sword', 'axe', 'mace', 'claw', 'dagger'];

// The reference rare (REFERENCE_RARE_WEAPON) on a weapon kind's base: its physical hit, attacks per second and their
// product. null without weapon bases or for a kind the data has no base for.
function referenceWeaponOf(weapon) {
  if (!weaponBases) {
    return null;
  }
  if (weapon === 'shield') {
    let best = null;
    for (const handWeapon of SHIELD_HAND_WEAPONS) {
      const candidate = referenceWeaponOf(handWeapon);
      if (candidate !== null && (best === null || candidate.damagePerSecond > best.damagePerSecond)) {
        best = candidate;
      }
    }
    return best;
  }
  const base = weaponBases[weapon];
  if (!base) {
    return null;
  }
  const flat = RARE_WEAPON_FLAT_PHYSICAL * (isTwoHandedWeapon(weapon) ? TWO_HANDED_FLAT_FACTOR : 1);
  const hit = ((base.physicalMin + base.physicalMax) / 2 + flat) * (1 + (RARE_WEAPON_INCREASED_PHYSICAL + WEAPON_QUALITY) / 100);
  const attacksPerSecond = base.attackSpeed * (1 + RARE_WEAPON_ATTACK_SPEED / 100);
  return { hit, attacksPerSecond, damagePerSecond: hit * attacksPerSecond };
}

// Whether the skill's damage is the weapon's hit: an attack of the build's own, not a minion's or a degen.
function hitsWithWeapon(context) {
  return context.types.has('Attack') && !context.isMinion && !context.isDamageOverTime;
}

// An attack's sheet DPS (before enemy resistances, as poe.ninja shows it), from the weapon and the offence index's
// own factors; null for anything that isn't a weapon attack.
function attackSheetDps(context, weapon, added, factors, weaponDamage = 1) {
  if (!context.types.has('Attack') || context.isMinion) {
    return null;
  }
  const reference = referenceWeaponOf(weapon);
  if (reference === null) {
    return null;
  }
  const weaponHit = reference.hit * weaponDamage;
  const attacksPerSecond = reference.attacksPerSecond * (context.skill.attackSpeedMultiplier || 100) / 100;
  const hit = (weaponHit + added + GEAR_ADDED_ATTACK_DAMAGE) * (context.skill.effectiveness || 100) / 100;
  return hit * attacksPerSecond * factors;
}

function bestOffence(build, context) {
  // Crits that deal no extra damage (Perfect Agony) still decide a crit-only ailment build, so it tries both ways.
  const critsStillMatter = context.flags.has('noCritDamage') && context.flags.has('critOnlyAilments') && hitsInflictAilment(context);
  if (context.flags.has('neverCrit') || (context.flags.has('noCritDamage') && !critsStillMatter)) {
    const plain = offenceOf(build, context, { crit: false, critChance: 0.1 });
    const elementalOverloadProbe = offenceOf(build, context, { crit: false, critChance: plain.critChance });
    return { value: elementalOverloadProbe.value, crit: false, critChance: plain.critChance, dps: elementalOverloadProbe.dps,
      useSpeed: elementalOverloadProbe.useSpeed };
  }
  const probe = offenceOf(build, context, { crit: true, critChance: 0.3 });
  const crit = offenceOf(build, context, { crit: true, critChance: probe.critChance });
  const plain = offenceOf(build, context, { crit: false, critChance: probe.critChance });
  if (crit.value > plain.value) {
    return { value: crit.value, crit: true, critChance: crit.critChance, dps: crit.dps, useSpeed: crit.useSpeed };
  }
  return { value: plain.value, crit: false, critChance: plain.critChance, dps: plain.dps, useSpeed: plain.useSpeed };
}

// ---------- defence: effective hit points ----------
// The defence index is the build's effective HP, its pool over the share of a reference boss hit it takes, divided
// by the effective HP of a character with no defensive pieces at all (so 1 is "nothing but gear"). It is an
// estimate for comparing builds, not what Path of Building would show: every number below is our own.

// The reference hit: a pinnacle boss's big slam or spell, split by damage type, half of them attacks. poe.ninja's
// sampled top characters (Allflame, 2026-11-11) survive a median largest hit of about 13,000 (10% under 5,900), so
// 10,000 is a hit a ready build has to take.
const REFERENCE_HIT = 10000;
const FROST_SHIELD_SHARE = 0.5;
const HIT_SHARES = { physical: 0.5, fire: 0.4 / 3, cold: 0.4 / 3, lightning: 0.4 / 3, chaos: 0.1 };
const ATTACK_SHARE = 0.5;
const MONSTER_ACCURACY = 2000; // a level 83 boss, roughly
// What every endgame character has before its build's own pieces: life at level ~92 with some strength, and rare
// gear. A life build wears armour or evasion bases with life on them; an energy shield build wears ES bases.
const CHARACTER_LIFE = 1250;
const GEAR_LIFE = 700; // about +90 life on each of eight rare items
const GEAR_DEFENCE_RATING = 3000; // armour and/or evasion of life bases, before any increase
const GEAR_ENERGY_SHIELD = 1600; // energy shield of ES bases with flat ES, before any increase
const GEAR_CHAOS_RESISTANCE = 20;
const MAX_RESISTANCE = 75;
const RESISTANCE_CEILING = 90;
const SHIELD_BLOCK = 25; // a shield's own chance to block
// Dual wielding's inherent bonuses (3.25: "+20% chance to Block Attack Damage and 10% more Attack Speed", up from
// +15% block, which was all the model had; the speed was missing until 2026-11-25).
const DUAL_WIELD_ATTACK_BLOCK = 20;
const DUAL_WIELD_ATTACK_SPEED_MORE = 10;
// Maximum mana: a level 92 character has 34 + 6 a level, and 1 more for each 2 intelligence. With the fixed gear
// figures, rare gear adds GEAR_MANA (a few mana rolls); solved gear adds its own lines.
const CHARACTER_MANA = 34 + 6 * 92;
const MANA_PER_INTELLIGENCE = 0.5;
const GEAR_MANA = 150;
// ---------- mana upkeep: paying for the main skill ----------
// Each use of the main skill costs its gem's level-20 cost times each linked support's cost multiplier, more or less
// by the build's cost lines and divided by its cost efficiency (cost x 100 / (100 + efficiency), GGG's 3.26 notes).
// Over a fight the build regains mana from regeneration, mana leech, mana on hit and mana on kill; what it can't
// pay for, it can't cast. So a build may reserve nearly all its mana when the rest pays for its skill, and the
// pieces that lower the cost or raise the upkeep (cost efficiency, less cost, mana regeneration, cost paid with life,
// leech of the right damage type, mana on hit) earn their place by the casting they keep going.
// Every character regenerates 1.75% of maximum mana per second (the game's base rate, as poewiki gives it).
const BASE_MANA_REGEN_PERCENT = 1.75;
// Leech recovers at most 20% of maximum mana per second (the game's cap); each 1% leeched is taken to recover
// LEECH_RATE_PER_PERCENT of the pool per second while hitting, as for life.
const MAX_MANA_LEECH_RATE = 20;
// Enemies killed per second while the mana matters: many while mapping, none while a boss stands (our estimate).
const MANA_KILLS_PER_SECOND = 0.5;
// The fight the upkeep is measured over: unreserved mana carries the first casts, regained mana the rest. A long
// boss phase (our estimate): a short one would let any big pool pass, a very long one would ignore the pool.
const UPKEEP_WINDOW_SECONDS = 20;
// Skills paid for on placement, not on every hit (our estimates): totems are put down every few seconds and their
// skill costs nothing; brands are cast again as they expire or move to a new target.
const TOTEM_PLACEMENTS_PER_SECOND = 0.2;
const BRAND_CASTS_PER_SECOND = 0.5;
const DEFAULT_CAST_TIME = 0.75;
// A skill paid with life (Lifetap, Blood Magic, Transfusion) spends at most this share of life before what comes back
// has to keep up: life spent on casting isn't there to take the next hit (our estimate).
const LIFE_COST_BUFFER_SHARE = 0.25;
const DEFAULT_ATTACKS_PER_SECOND = 1.5; // a weapon the data has no base for
// With the fixed gear figures, rare gear's increased mana regeneration: an amulet and two rings with a regeneration
// roll each (our estimate). Solved gear brings its own lines instead.
const GEAR_MANA_REGEN_INCREASED = 80;
// Without a planned tree, its increased mana regeneration: a few regeneration nodes on the way (our estimate, like
// TREE_ALLOWANCE). A planned tree brings its own nodes instead.
const TREE_MANA_REGEN_INCREASED = 60;
// A build that can't pay for one use from what isn't reserved can't use its skill: its damage counts at this share,
// which is nothing to the score but still orders such builds for the search.
const UNPAYABLE_SHARE = 0.01;

// Lines that grow with unreserved mana (Archmage) are read at this much unreserved mana and scaled by the build's own.
const UNRESERVED_MANA_REFERENCE = 1000;
// No more than this many times the reference: a mana-stacked Archmage build reaches about 8000 unreserved mana.
const UNRESERVED_MANA_FACTOR_MAX = 8;
// Stacking: a build that commits early to one stat (mana for Archmage and Transfiguration of Mind, life for
// Righteous Fire, energy shield, armour or evasion for the pieces that turn them into damage) chooses its supports,
// uniques, tree and rare gear for it. Until its gear is solved, it is taken to have this much more of the stat, what
// a committed tree and gear add over a usual endgame build (our estimates). Then the real figures decide, and the
// committed plan is kept only where it scores best.
const STACKING_EXTRA = { mana: 3000, life: 3000, energyShield: 5000, armour: 30000, evasion: 30000 };
// A commitment is planned when it raises the plan's score by this much at the assumed extra (our estimate: below it
// the stat is a side benefit, not an archetype).
const STACKING_MIN_GAIN = 1.1;
// Transfiguration of Mind (Divine Guidance, Crown of the Pale King): increases to maximum mana also apply to damage
// at 30% of their value; Transfiguration of Body does the same with maximum life for attack damage (GGG's tree text).
const TRANSFIGURATION_SHARE = 0.3;
// Recovery counts for a short window: what comes back in the second before the next big hit.
const RECOVERY_SECONDS = 1;
// Endurance charges, for a build with a way to gain them: 3, plus any added maximum, each 4% physical damage
// reduction (the game's values; their +4% elemental resistances add nothing while resistances are capped).
const BASE_ENDURANCE_CHARGES = 3;
const PHYSICAL_REDUCTION_PER_ENDURANCE_CHARGE = 4;
const MAX_LEECH_RATE = 20; // % of life recovered per second from leech, the game's cap
const LEECH_RATE_PER_PERCENT = 4; // % of life per second each 1% leeched recovers while hitting, our estimate

// % of life a second that leech gives back while hitting: the leech lines at their rate, sped up by the leech rate
// lines, up to the cap (MAX_LEECH_RATE, raised or lowered by the cap lines: Eternal Youth halves it).
function leechRecoveryRate(totals) {
  const rate = scaled(totals.leechRate, totals.leech * LEECH_RATE_PER_PERCENT);
  const cap = scaled(totals.leechCap, MAX_LEECH_RATE);
  return Math.min(cap, rate);
}
// Recoup returns over 4 seconds, so against a burst only part of it is back in time: three quarters of it counts,
// and it can at most double the pool (our estimate; 90% recoup is strong, but it doesn't make you take a tenth).
const RECOUP_WITHIN_WINDOW = 0.75;
const RECOUP_MAX_SHARE = 0.5;
const HITS_PER_SECOND = 3; // for "life gained on hit"
const HITS_TAKEN_PER_SECOND = 1; // a pinnacle boss's hits at the build, for recovery on block (our estimate)
// Energy shield recharge: 33.3% of maximum energy shield a second (the game's rate), once you go unhit for 2 seconds.
// Our estimate: in a boss fight that happens about 15% of the time at the base delay; a faster start raises it.
const ES_RECHARGE_RATE = 33.3;
const ES_RECHARGE_SHARE_AT_BASE_DELAY = 0.15;
const ES_RECHARGE_SHARE_MAX = 0.5;
// The life flask (the best one the data has, set by prepareMechanics): its life over its duration, a second of it in
// the window, since it is drunk when a hit lands.
let lifeFlaskBase = null;
function setLifeFlask(flask) {
  if (lifeFlaskBase?.life !== flask?.life || lifeFlaskBase?.duration !== flask?.duration) {
    lifeFlaskBase = flask;
    referenceEffectiveHp = null;
  }
}

// Players count on defences that are always there. A defensive line under a condition (a guard skill's buff,
// "if you haven't been hit recently", "while stationary") counts at its uptime, and then at half again: being
// safe only part of the time is what kills a build. Conditions that hold for a whole boss fight aren't discounted.
const INCONSISTENT_DEFENCE_FACTOR = 0.5;
const CONSISTENT_CONDITIONS = new Set(['perStack', 'nearby', 'rareOrUnique', 'pinnaclePresence', 'recentSkill', 'recentSpell', 'fortify',
  'enemyCursed', 'flask', 'impale', 'perEnduranceCharge']);
// Spell suppression below the cap is a gamble on each spell: of the 50 Allflame archetypes whose top characters
// poe.ninja sampled, 28 run under 10% and 13 at 90% or more; few sit in between. So suppression counts at its
// chance squared: 100% is worth all of it, 50% a quarter.
const SUPPRESSION_CONSISTENCY_POWER = 2;
// A ready character has at least about 3,000 life, or, built on energy shield, about 5,000 of it: the lowest
// medians among poe.ninja's life archetypes are 2,300 to 3,000 (Allflame and Mirage), and its energy shield
// archetypes' 10th percentile is 4,000 to 7,000. Below that a build is one-shot whatever its mitigation, so its
// effective HP is cut by the square of how far short the better of the two falls. Life and energy shield aren't
// added for this: 1,700 life with 4,000 energy shield is neither a life build nor an energy shield one.
const READY_LIFE = 3000;
const READY_ENERGY_SHIELD = 5000;
const DEFENCE_STATS = new Set(['lifeOnBlock', 'energyShieldOnBlock', 'mana', 'frostShieldPool', 'nonChaosEsBypass', 'selfBurnLife', 'selfBurnEnergyShield', 'life', 'energyShield', 'armour', 'evasion', 'defences', 'block', 'spellBlock', 'suppress',
  'suppressPrevent', 'damageTakenLess', 'physicalReduction', 'elementalReduction', 'maxResistance', 'recoup', 'lifeRegen',
  'lifeRegenFlat', 'esRegen', 'esRegenFlat', 'leech', 'onHitRecovery', 'maxBlock', 'maxSpellBlock', 'lifeToEnergyShield', 'lifeConvertedToEnergyShield',
  'damageTaken', 'manaToEnergyShield', 'resistance', 'shieldDefences', 'enduranceCharge', 'enduranceCharges',
  'enduranceChargeGenerator', 'minimumEnduranceCharges', 'esRecharge', 'esRechargeStart', 'flaskRecovery',
  'leechRate', 'leechCap']);
const ELEMENTS = ['fire', 'cold', 'lightning'];

// Every defensive line of the build summed by what it changes. Only your own lines count; support and minion
// lines are about the skill or the minions.
function defenceTotals(build, context) {
  const totals = {
    life: { flat: 0, increased: 0, more: 1 }, energyShield: { flat: 0, increased: 0, more: 1 },
    armour: { flat: 0, increased: 0, more: 1 }, evasion: { flat: 0, increased: 0, more: 1 },
    mana: { flat: 0, increased: 0, more: 1 },
    block: 0, spellBlock: 0, suppress: 0, suppressPrevent: 50, maxBlock: 0, maxSpellBlock: 0,
    physicalReduction: 0, elementalReduction: 0, maxResistance: { fire: 0, cold: 0, lightning: 0, chaos: 0 },
    chaosResistance: build.gear ? CAMPAIGN_RESISTANCE_PENALTY : GEAR_CHAOS_RESISTANCE, gearSolved: Boolean(build.gear),
    resistance: { fire: 0, cold: 0, lightning: 0 }, takenMultiplier: { physical: 1, fire: 1, cold: 1, lightning: 1, chaos: 1 },
    takenAttackMultiplier: 1, takenIncreased: { physical: 0, fire: 0, cold: 0, lightning: 0, chaos: 0 },
    lifeRegenPercent: 0, lifeRegenFlat: 0, lifeRegenMore: 1, esRegenPercent: 0, esRegenFlat: 0, leech: 0, recoup: 0, onHit: 0,
    lifeAsEnergyShield: 0, lifeConvertedToEnergyShield: 0, manaAsEnergyShield: 0, shieldDefences: 0, enduranceSource: false, enduranceMaximum: 0,
    esRecharge: { increased: 0, more: 1 }, esRechargeStart: 0, flaskRecovery: 0,
    leechRate: { flat: 0, increased: 0, more: 1 }, leechCap: { flat: 0, increased: 0, more: 1 },
    selfBurnLife: 0, selfBurnEnergyShield: 0, overcappedFire: 0, frostShieldPool: 0, nonChaosEsBypass: 0,
    // "50% of Physical Damage taken as Fire Damage": shown on the card, not yet counted in the effective HP.
    takenAs: [],
    // "Recover 4% of Life when you Block": percent of the pool for each block.
    lifeOnBlock: 0, energyShieldOnBlock: 0,
    // Dual wielding blocks attacks on its own (DUAL_WIELD_ATTACK_BLOCK).
    dualWield: context.tags.has('dualWield'),
  };
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      if (effect.stat === 'damageTakenAs' && (effect.subject || 'self') === 'self') {
        totals.takenAs.push({ from: effect.from || [], to: effect.tags || [], value: effect.value || 0, condition: effect.condition || null });
        continue;
      }
      if ((effect.subject || 'self') !== 'self' || !DEFENCE_STATS.has(effect.stat) || effect.kind === 'penetration') {
        continue;
      }
      if (effect.stat === 'enduranceCharges' && effect.kind === 'limit') {
        totals.enduranceMaximum += effect.value || 0;
        continue;
      }
      if (effect.stat.startsWith('enduranceCharge') || effect.stat === 'minimumEnduranceCharges') {
        if (isEnduranceSource(effect)) {
          totals.enduranceSource = true;
        }
        continue;
      }
      if (!(effect.requires || []).every(required => hasTag(context.tags, required))) {
        continue;
      }
      // Leech with a scope ("Physical Attack Damage Leeched as Life") recovers only from damage of that kind, the
      // way mana leech pays for skills (upkeepLinesOf): nothing for a spell.
      if (effect.stat === 'leech' && (effect.tags || []).length > 0 && effectWeight(effect, context, NO_CRIT_BRANCH) === 0) {
        continue;
      }
      let amount = (effect.value || 0) * conditionUptime(effect.condition, context, { crit: false, critChance: 0 });
      // Recoup of one damage type comes back from that type's share of the reference hit.
      if (effect.stat === 'recoup' && (effect.tags || []).length > 0) {
        amount *= shareOfHit(damageTypesNamed(effect.tags));
      }
      if (effect.condition && !isConsistentCondition(effect.condition)) {
        amount *= INCONSISTENT_DEFENCE_FACTOR;
      }
      addDefenceLine(totals, effect, amount);
    }
  }
  if (totals.enduranceSource) {
    totals.physicalReduction += (BASE_ENDURANCE_CHARGES + totals.enduranceMaximum) * PHYSICAL_REDUCTION_PER_ENDURANCE_CHARGE;
  }
  // Tasalio: fire resistance lines also count for cold and lightning at half their value.
  if (context.flags.has('fireResistanceShared')) {
    totals.resistance.cold += totals.resistance.fire / 2;
    totals.resistance.lightning += totals.resistance.fire / 2;
  }
  if (totals.gearSolved) {
    totals.overcappedFire = CAMPAIGN_RESISTANCE_PENALTY + totals.resistance.fire - maximumResistanceOf(totals, context.flags, 'fire', true);
  }
  totals.overcappedFire = Math.max(0, totals.overcappedFire);
  // The Formless Flame: armour increased by overcapped fire resistance.
  if (context.flags.has('armourFromOvercappedFire')) {
    totals.armour.increased += totals.overcappedFire;
  }
  return totals;
}

// The share of the reference hit that is of these damage types.
function shareOfHit(types) {
  let share = 0;
  for (const type of types) {
    share += HIT_SHARES[type] || 0;
  }
  return share;
}

// The damage types a line about damage taken names; all of them when it names none.
function damageTypesNamed(tags) {
  const named = [];
  for (const tag of tags || []) {
    if (tag === 'elemental') {
      named.push(...ELEMENTS);
    } else if (HIT_SHARES[tag] !== undefined) {
      named.push(tag);
    }
  }
  return named.length ? named : Object.keys(HIT_SHARES);
}

function addDefenceLine(totals, effect, amount) {
  const stat = effect.stat;
  if (stat === 'life' || stat === 'energyShield' || stat === 'armour' || stat === 'evasion' || stat === 'mana') {
    addScaling(totals[stat], effect.kind, amount);
    return;
  }
  if (stat === 'defences') {
    for (const rating of ['armour', 'evasion', 'energyShield']) {
      addScaling(totals[rating], effect.kind, amount);
    }
    return;
  }
  if (stat === 'resistance') {
    // Elemental resistances are taken as capped by gear, so more of them only goes over the cap, which counts for
    // lines that read overcapped fire resistance; chaos resistance isn't capped by gear.
    const tags = effect.tags || [];
    if (tags.includes('chaos')) {
      totals.chaosResistance += amount;
    }
    if (effect.kind === 'resistance' && !effect.condition && (tags.includes('fire') || tags.includes('elemental'))) {
      totals.overcappedFire += amount;
    }
    // Resistance lines as they add up, for builds whose gear is solved (the solver caps them, or doesn't).
    if (effect.kind === 'resistance' && !effect.condition) {
      for (const element of ELEMENTS) {
        if (tags.includes(element) || tags.includes('elemental')) {
          totals.resistance[element] += amount;
        }
      }
    }
    return;
  }
  if (stat === 'maxResistance') {
    const tags = effect.tags && effect.tags.length ? effect.tags : ['elemental'];
    for (const type of damageTypesNamed(tags)) {
      if (totals.maxResistance[type] !== undefined) {
        totals.maxResistance[type] += amount;
      }
    }
    return;
  }
  if (stat === 'damageTaken') {
    // A line about damage taken from attacks only meets the attack half of the hits.
    if ((effect.tags || []).includes('attack')) {
      if (effect.kind === 'more') {
        totals.takenAttackMultiplier *= 1 + amount / 100;
      }
      return;
    }
    for (const type of damageTypesNamed(effect.tags)) {
      if (effect.kind === 'more') {
        totals.takenMultiplier[type] *= 1 + amount / 100;
      } else {
        totals.takenIncreased[type] += amount;
      }
    }
    return;
  }
  if (stat === 'damageTakenLess') {
    // "X% less damage taken" (a negative value is more damage taken).
    for (const type of Object.keys(HIT_SHARES)) {
      totals.takenMultiplier[type] *= 1 - amount / 100;
    }
    return;
  }
  const simple = {
    block: 'block', spellBlock: 'spellBlock', suppress: 'suppress', suppressPrevent: 'suppressPrevent',
    maxBlock: 'maxBlock', maxSpellBlock: 'maxSpellBlock', physicalReduction: 'physicalReduction',
    elementalReduction: 'elementalReduction', lifeRegenFlat: 'lifeRegenFlat', esRegenFlat: 'esRegenFlat',
    leech: 'leech', recoup: 'recoup', onHitRecovery: 'onHit', lifeOnBlock: 'lifeOnBlock', energyShieldOnBlock: 'energyShieldOnBlock', lifeToEnergyShield: 'lifeAsEnergyShield', lifeConvertedToEnergyShield: 'lifeConvertedToEnergyShield',
    manaToEnergyShield: 'manaAsEnergyShield', shieldDefences: 'shieldDefences',
  };
  if (stat === 'esRecharge') {
    addScaling(totals.esRecharge, effect.kind, amount);
    return;
  }
  if (stat === 'esRechargeStart') {
    totals.esRechargeStart += amount;
    return;
  }
  // "increased total Recovery per second from Life Leech" (how fast the leeched life comes back) and "increased Maximum
  // total Life Recovery per second from Leech" (the cap on it): the vocabulary read neither until 2026-11-23.
  if (stat === 'leechRate' || stat === 'leechCap') {
    addScaling(totals[stat], effect.kind, amount);
    return;
  }
  if (stat === 'flaskRecovery') {
    if (effect.kind === 'increased') {
      totals.flaskRecovery += amount;
    }
    return;
  }
  if (stat === 'selfBurnLife' || stat === 'selfBurnEnergyShield' || stat === 'frostShieldPool' || stat === 'nonChaosEsBypass') {
    totals[stat] += amount;
    return;
  }
  if (stat === 'lifeRegen') {
    if (effect.kind === 'flat') {
      totals.lifeRegenPercent += amount;
    } else if (effect.kind === 'more') {
      totals.lifeRegenMore *= 1 + amount / 100;
    }
    return;
  }
  if (stat === 'esRegen') {
    if (effect.kind === 'flat') {
      totals.esRegenPercent += amount;
    }
    return;
  }
  if (simple[stat]) {
    totals[simple[stat]] += amount;
  }
}

function addScaling(scaling, kind, amount) {
  if (kind === 'flat') {
    scaling.flat += amount;
  } else if (kind === 'increased') {
    scaling.increased += amount;
  } else if (kind === 'more') {
    scaling.more *= 1 + amount / 100;
  }
}

function scaled(scaling, base) {
  return Math.max(0, (base + scaling.flat) * (1 + scaling.increased / 100) * scaling.more);
}

// The share of the reference hit that lands, for one gear choice. Mitigation (armour, resistances, damage
// reduction) and avoidance (evasion, block, suppression) both count at their expected value.
// The resistance an element sits at: the usual cap plus its maximum resistance lines, no more than 90%. With Valako
// (flag maxResSync) maximum fire resistance lines also raise cold and lightning.
// With solved gear, the resistance the build actually reaches (capped there); capOnly gives the cap itself.
function maximumResistanceOf(totals, flags, element, capOnly = false) {
  let maximum = totals.maxResistance[element];
  if (flags.has('maxResSync') && element !== 'fire') {
    maximum += totals.maxResistance.fire;
  }
  const cap = Math.min(RESISTANCE_CEILING, MAX_RESISTANCE + maximum);
  if (!totals.gearSolved || capOnly) {
    return cap;
  }
  return Math.min(cap, CAMPAIGN_RESISTANCE_PENALTY + totals.resistance[element]);
}

// Righteous Fire's burn on you, per second: its share of life and energy shield, after fire resistance (damage over
// time, so no armour or other reduction).
function selfBurnPerSecond(totals, flags, life, energyShield) {
  const burned = life * totals.selfBurnLife / 100 + energyShield * totals.selfBurnEnergyShield / 100;
  if (burned <= 0) {
    return 0;
  }
  const fireTaken = (1 - maximumResistanceOf(totals, flags, 'fire') / 100) * totals.takenMultiplier.fire
    * Math.max(0, 1 + totals.takenIncreased.fire / 100);
  return burned * Math.max(0, fireTaken);
}

function shareTaken(totals, flags, armour, evasion, weapon) {
  return hitDefencesOf(totals, flags, armour, evasion, weapon).taken;
}

// The share of the reference hit taken (taken), and the parts it comes from, for the card: physical reduction,
// the chance to evade an attack, block, spell block and suppression (as chances, 0 to 1), the resistances, and the
// "more/less damage taken" lines as one multiplier over the hit's types.
function hitDefencesOf(totals, flags, armour, evasion, weapon) {
  const physicalHit = REFERENCE_HIT * HIT_SHARES.physical;
  const armourReduction = armour > 0 ? armour / (armour + 5 * physicalHit) * 100 : 0;
  const physicalReduction = Math.min(90, armourReduction + totals.physicalReduction);
  const mitigated = {
    physical: 1 - physicalReduction / 100,
    chaos: flags.has('chaosInoculation') ? 0 : 1 - Math.min(MAX_RESISTANCE + totals.maxResistance.chaos, totals.chaosResistance) / 100,
  };
  for (const element of ELEMENTS) {
    const resistance = maximumResistanceOf(totals, flags, element);
    mitigated[element] = (1 - resistance / 100) * (1 - Math.min(90, totals.elementalReduction) / 100);
  }
  let hitTaken = 0;
  let takenFactor = 0;
  for (const [type, share] of Object.entries(HIT_SHARES)) {
    const factor = totals.takenMultiplier[type] * Math.max(0, 1 + totals.takenIncreased[type] / 100);
    const taken = mitigated[type] * factor;
    hitTaken += share * Math.max(0, taken);
    takenFactor += share * Math.max(0, factor);
  }
  const hitChance = flags.has('noEvasion') || evasion <= 0
    ? 1
    : Math.min(1, Math.max(0.05, 1.25 * MONSTER_ACCURACY / (MONSTER_ACCURACY + Math.pow(evasion / 5, 0.9))));
  const shieldBlock = weapon === 'shield' ? SHIELD_BLOCK * (1 + totals.shieldDefences / 100) : 0;
  const dualWieldBlock = totals.dualWield ? DUAL_WIELD_ATTACK_BLOCK : 0;
  const block = Math.min(75 + totals.maxBlock, totals.block + shieldBlock + dualWieldBlock) / 100;
  const spellBlock = Math.min(75 + totals.maxSpellBlock, totals.spellBlock) / 100;
  const suppressChance = Math.min(100, totals.suppress) / 100;
  const suppressed = Math.pow(suppressChance, SUPPRESSION_CONSISTENCY_POWER) * Math.min(100, totals.suppressPrevent) / 100;
  const attackTaken = hitChance * (1 - block) * totals.takenAttackMultiplier;
  const spellTaken = (1 - spellBlock) * (1 - suppressed);
  const resistances = {};
  for (const element of ELEMENTS) {
    resistances[element] = maximumResistanceOf(totals, flags, element);
  }
  resistances.chaos = flags.has('chaosInoculation') ? 100 : Math.min(MAX_RESISTANCE + totals.maxResistance.chaos, totals.chaosResistance);
  return { taken: Math.max(0.005, hitTaken * (ATTACK_SHARE * attackTaken + (1 - ATTACK_SHARE) * spellTaken)),
    physicalReduction, evade: 1 - hitChance, block, spellBlock, suppress: suppressChance, resistances,
    takenFactor: takenFactor * (ATTACK_SHARE * totals.takenAttackMultiplier + (1 - ATTACK_SHARE)) };
}

// Effective HP for one gear choice: ('life' or 'es' gear, and how a life build's defence rating splits between
// armour and evasion).
// Life and energy shield as one pool. With part of the damage going past energy shield (Corrupted Soul: 50% of
// non-chaos damage), energy shield takes only its share of each hit and life the rest: when energy shield runs out
// first the pool is still both, but when life runs out first, only life / (life's share) of damage was taken.
function pooledLifeAndEnergyShield(life, energyShield, bypassPercent) {
  if (bypassPercent <= 0 || energyShield <= 0) {
    return life + energyShield;
  }
  const bypassedShare = Math.min(1, bypassPercent / 100) * (1 - HIT_SHARES.chaos);
  return Math.min(life + energyShield, life / bypassedShare);
}

function effectiveHp(totals, flags, context, weapon, reservation, gear) {
  const gearScale = flags.has('noHelmet') ? 0.85 : 1;
  const lifeGear = gear.pool === 'life' ? GEAR_LIFE * gearScale : 0; // 'solved': the items' own lines instead
  const esGear = gear.pool === 'es' ? GEAR_ENERGY_SHIELD * gearScale : 0;
  let life = flags.has('chaosInoculation') ? 1 : scaled(totals.life, CHARACTER_LIFE + lifeGear) + stackedExtra(reservation, 'life');
  // Blood Magic removes mana. Reserved life (Blood Magic's buffs, Petrified Blood) isn't there to take hits.
  const mana = flags.has('bloodMagic') ? 0 : scaled(totals.mana, reservation.baseMana + (gear.pool === 'solved' ? 0 : GEAR_MANA)) + stackedExtra(reservation, 'mana');
  const maximumLife = life;
  const lifeFlatShare = maximumLife > 0 ? (reservation.lifeFlat || 0) / maximumLife * 100 : 0;
  life *= Math.max(0.1, 1 - (reservation.life + lifeFlatShare) / 100);
  life = petrifiedBloodLife(life, maximumLife, flags);
  const unreservedMana = Math.max(0, mana * (1 - reservation.mana / 100) - (reservation.manaFlat || 0));
  let energyShield = scaled(totals.energyShield, esGear) + stackedExtra(reservation, 'energyShield');
  // Life converted to energy shield leaves life; life "as extra" energy shield keeps it.
  const converted = life * Math.min(100, totals.lifeConvertedToEnergyShield) / 100;
  life = Math.max(1, life - converted);
  energyShield += converted + life * totals.lifeAsEnergyShield / 100 + mana * totals.manaAsEnergyShield / 100;
  if (flags.has('noEnergyShield')) {
    energyShield = 0; // "Removes all Energy Shield" takes the converted and extra energy shield too
  }
  if (flags.has('eldritchBattery') || flags.has('esBypass')) {
    energyShield = 0; // it protects mana, or hits go past it
  }
  const ratingGear = gear.pool === 'life' ? GEAR_DEFENCE_RATING * gearScale : 0;
  let armour = scaled(totals.armour, ratingGear * gear.armourShare) + stackedExtra(reservation, 'armour');
  let evasion = scaled(totals.evasion, ratingGear * (1 - gear.armourShare)) + stackedExtra(reservation, 'evasion');
  if (flags.has('ironReflexes')) {
    armour += evasion;
    evasion = 0;
  }
  let pool = pooledLifeAndEnergyShield(life, energyShield, totals.nonChaosEsBypass);
  // Frost Shield: its life takes part of each hit first. It is up for its duration out of a cooldown, so half of it
  // counts, and it only grows while you lose energy shield, so it counts in proportion to how much of the pool is
  // energy shield: a life build with 50 energy shield gets almost nothing (it sat in 72% of builds when any energy
  // shield got all of it).
  if (totals.frostShieldPool > 0 && energyShield > 0) {
    const energyShieldShare = energyShield / (life + energyShield);
    pool += totals.frostShieldPool * FROST_SHIELD_SHARE * energyShieldShare;
  }
  // Mind over Matter takes 40% of the damage from unreserved mana, so it adds up to two thirds of life, if the mana is
  // there: auras reserving most of it leave little.
  if (flags.has('mindOverMatter')) {
    pool += Math.min(life * 0.4 / 0.6, unreservedMana);
  }
  // What comes back within the window.
  const hitsEnemies = !context.isMinion && !context.isDamageOverTime;
  const leechRate = hitsEnemies ? leechRecoveryRate(totals) : 0;
  const lifeRegen = flags.has('vaalPact') ? 0 : (life * totals.lifeRegenPercent / 100 + totals.lifeRegenFlat) * totals.lifeRegenMore;
  const lifeFlask = lifeFlaskBase && !flags.has('chaosInoculation') && !flags.has('vaalPact')
    ? lifeFlaskBase.life / lifeFlaskBase.duration * (1 + totals.flaskRecovery / 100)
    : 0;
  const lifeSustain = lifeRegen + life * leechRate / 100 + (hitsEnemies ? totals.onHit * HITS_PER_SECOND : 0);
  // Recovery on block: each of the boss's hits (HITS_TAKEN_PER_SECOND) blocked at the build's chance, attacks and
  // spells in their shares.
  const hit = hitDefencesOf(totals, flags, armour, evasion, weapon);
  const blocksPerSecond = HITS_TAKEN_PER_SECOND * (ATTACK_SHARE * hit.block + (1 - ATTACK_SHARE) * hit.spellBlock);
  const onBlock = blocksPerSecond * (life * totals.lifeOnBlock + energyShield * totals.energyShieldOnBlock) / 100;
  const recoveryPerSecond = lifeSustain + onBlock
    + lifeFlask + esRechargePerSecond(totals, flags, energyShield, life)
    + (flags.has('noEsRecharge') ? 0 : energyShield * totals.esRegenPercent / 100 + totals.esRegenFlat);
  // A self-burn (Righteous Fire) comes out of the recovery; burning faster than it recovers drains the pool, though
  // never below a tenth of it, which is the build only just keeping RF up.
  const netRecovery = recoveryPerSecond - selfBurnPerSecond(totals, flags, life, energyShield);
  pool = Math.max((life + energyShield) * 0.1, pool + netRecovery * RECOVERY_SECONDS);
  const taken = hit.taken;
  const recoup = Math.min(RECOUP_MAX_SHARE, Math.min(100, totals.recoup) / 100 * RECOUP_WITHIN_WINDOW);
  const standingPool = life + energyShield;
  const readyShare = Math.min(1, Math.max(life / READY_LIFE, energyShield / READY_ENERGY_SHIELD));
  const readiness = Math.pow(readyShare, 2);
  // Reported apart for the build planner's EHP stage: the largest hit the standing pool takes (no recovery, the
  // same life floor) and what comes back in a second.
  const maxHit = standingPool / taken * readiness;
  return { ehp: pool / (taken * Math.max(0.1, 1 - recoup)) * readiness, pool: standingPool, life, energyShield,
    armour, evasion, overcappedFire: totals.overcappedFire, maxHit, recovery: netRecovery, lifeSustain, mana, unreservedMana,
    hit, takenAs: totals.takenAs };
}

// The assumed extra of a committed stat while the build's gear isn't solved yet (STACKING_EXTRA).
function stackedExtra(reservation, stat) {
  if (!reservation.stacking || reservation.stacking.stat !== stat) {
    return 0;
  }
  return reservation.stacking.amount;
}

// Petrified Blood: life can't be recovered above low life (except by flasks), so the build fights at half its life
// or less; hits below half life lose 40% less at once, and of that, 81% is lost over 4 seconds, a quarter of it
// within the window. The part of life below half counts as that much larger.
function petrifiedBloodLife(life, maximumLife, flags) {
  let current = life;
  if (flags.has('lifeCappedAtLowLife')) {
    current = Math.min(current, maximumLife * LOW_LIFE_SHARE);
  }
  if (!flags.has('lowerHalfLifeProtected')) {
    return current;
  }
  const delayedInWindow = PETRIFIED_DELAYED * Math.min(1, RECOVERY_SECONDS / PETRIFIED_DELAY_SECONDS);
  const prevented = PETRIFIED_PREVENTED * (1 - delayedInWindow);
  const lowerHalf = Math.min(current, maximumLife * LOW_LIFE_SHARE);
  return current - lowerHalf + lowerHalf / (1 - prevented);
}

// Energy shield recharge averaged over a fight: its rate times the share of the time it runs. Recharge that is never
// interrupted runs all the time; Pain Attunement-style "recharge applies to life" recovers life at the same rate.
function esRechargePerSecond(totals, flags, energyShield, life) {
  if (flags.has('noEsRecharge')) {
    return 0;
  }
  const pool = flags.has('painAttunementEs') ? life : energyShield;
  const rate = ES_RECHARGE_RATE / 100 * pool * (1 + totals.esRecharge.increased / 100) * totals.esRecharge.more;
  const share = flags.has('constantRecharge')
    ? 1
    : Math.min(ES_RECHARGE_SHARE_MAX, ES_RECHARGE_SHARE_AT_BASE_DELAY * (1 + totals.esRechargeStart / 100));
  return rate * share;
}

const GEAR_CHOICES = [
  { pool: 'life', armourShare: 1 }, { pool: 'life', armourShare: 0 }, { pool: 'life', armourShare: 0.5 },
  { pool: 'es', armourShare: 0 },
];

// The build's effective HP with the gear that suits it best.
function bestEffectiveHp(build, context) {
  const totals = defenceTotals(build, context);
  const reserved = reservedPercentOf(build, build.buffs || []);
  // A class tree planned before the buffs takes them to reserve a typical share, of life under Blood Magic.
  if (build.pendingReservation) {
    if (context.flags.has('bloodMagic')) {
      reserved.life += build.pendingReservation;
    } else {
      reserved.mana += build.pendingReservation;
    }
  }
  const reservation = { mana: reserved.mana, life: reserved.life, manaFlat: reserved.manaFlat, lifeFlat: reserved.lifeFlat,
    baseMana: CHARACTER_MANA + attributeSupplyOf(build).int * MANA_PER_INTELLIGENCE,
    stacking: build.stacking && build.stackingPending ? { stat: build.stacking, amount: STACKING_EXTRA[build.stacking] || 0 } : null };
  let best = null;
  const choices = build.gear ? [{ pool: 'solved', armourShare: 0 }] : GEAR_CHOICES;
  for (const gear of choices) {
    const result = effectiveHp(totals, context.flags, context, build.weapon, reservation, gear);
    if (!best || result.ehp > best.ehp) {
      best = result;
    }
  }
  return best;
}

// A character with nothing defensive but gear: the 1 the index is measured from.
let referenceEffectiveHp = null;
function referenceHp() {
  if (referenceEffectiveHp === null) {
    const empty = { skill: { effects: [] }, supports: [], notables: [], keystones: [], uniques: [], buffs: [], flasks: [] };
    const context = { flags: new Set(), tags: new Set(), isMinion: false, isDamageOverTime: false };
    referenceEffectiveHp = bestEffectiveHp(empty, context).ehp;
  }
  return referenceEffectiveHp;
}

function defenceOf(build, context) {
  const best = bestEffectiveHp(build, context);
  return { index: best.ehp / referenceHp(), ehp: best.ehp, pool: best.pool, life: best.life, energyShield: best.energyShield,
    armour: best.armour, evasion: best.evasion, overcappedFire: best.overcappedFire, maxHit: best.maxHit, recovery: best.recovery,
    lifeSustain: best.lifeSustain, mana: best.mana, unreservedMana: best.unreservedMana, hit: best.hit, takenAs: best.takenAs };
}

// ---------- mana upkeep ----------
const NO_CRIT_BRANCH = { crit: false, critChance: 0 };

// What paying for the main skill comes to (see UPKEEP_WINDOW_SECONDS): its cost per use and what it is paid with,
// uses per second, what it spends and regains per second, and share, the part of a fight it can keep using it (1 when
// it pays for itself, less when its mana runs out, UNPAYABLE_SHARE when one use costs more than isn't reserved).
function manaUpkeepOf(build, context, defenceResult, useSpeed) {
  const cost = build.skill.cost;
  const usesPerSecond = usesPerSecondOf(build, context, useSpeed);
  // upkeepWaived: the build is scored as if its skill cost nothing (finalizeTree, choosing the buffs to balance for).
  if (!cost || !(cost.amount > 0) || usesPerSecond === 0 || build.upkeepWaived) {
    return { costPerUse: 0, paidWith: null, usesPerSecond, spentPerSecond: 0, regainedPerSecond: 0, share: 1 };
  }
  const lines = upkeepLinesOf(build, context);
  let multiplier = 1;
  for (const entry of linkedSupports(build)) {
    multiplier *= (entry.support.costMultiplier || 100) / 100;
  }
  // Archmage adds a share of the unreserved mana to the base cost, before the multipliers.
  const baseCost = cost.amount + defenceResult.unreservedMana * lines.costPerUnreservedMana / 100;
  const costPerUse = Math.max(0, baseCost * multiplier * (1 + lines.costIncreased / 100) * lines.costMore
    * 100 / Math.max(10, 100 + lines.costEfficiency));
  const paidWithLife = skillPaidWithLife(context);
  const spentPerSecond = costPerUse * usesPerSecond;
  let pool;
  let regainedPerSecond;
  if (paidWithLife) {
    // Life pays: a share of what isn't reserved carries the first uses (LIFE_COST_BUFFER_SHARE), then what life comes
    // back all fight long (regeneration, leech, life on hit; not the life flask or energy shield recharge, which
    // don't last a fight).
    pool = defenceResult.life * LIFE_COST_BUFFER_SHARE;
    regainedPerSecond = Math.max(0, defenceResult.lifeSustain);
  } else {
    pool = defenceResult.unreservedMana;
    regainedPerSecond = manaRegainedPerSecond(build, context, defenceResult.mana, usesPerSecond, lines);
  }
  let share = Math.min(1, (pool + regainedPerSecond * UPKEEP_WINDOW_SECONDS) / Math.max(1e-9, spentPerSecond * UPKEEP_WINDOW_SECONDS));
  if (pool < costPerUse) {
    share = Math.min(share, UNPAYABLE_SHARE);
  }
  return { costPerUse, paidWith: paidWithLife ? 'life' : 'mana', usesPerSecond, spentPerSecond, regainedPerSecond, share };
}

// How often the main skill is paid for: attacks and casts at their rate times the build's speed, totems as they are
// placed and brands as they are cast again; a minion skill is paid for once, when its minions are summoned.
function usesPerSecondOf(build, context, useSpeed) {
  if (context.isMinion) {
    return 0;
  }
  if (context.tags.has('totem')) {
    return TOTEM_PLACEMENTS_PER_SECOND;
  }
  if (context.types.has('Brand')) {
    return BRAND_CASTS_PER_SECOND;
  }
  const speed = useSpeed > 0 ? useSpeed : 1;
  if (context.types.has('Attack')) {
    const base = weaponBases && weaponBases[build.weapon];
    const weaponRate = base ? base.attackSpeed * (1 + RARE_WEAPON_ATTACK_SPEED / 100) : DEFAULT_ATTACKS_PER_SECOND;
    return weaponRate * (build.skill.attackSpeedMultiplier || 100) / 100 * speed;
  }
  const castTime = build.skill.castTime > 0 ? build.skill.castTime : DEFAULT_CAST_TIME;
  return speed / castTime;
}

// The build's lines about costs and mana recovery, each counted as far as it reaches the skill (a line about attack
// costs doesn't lower a spell's, "Physical Attack Damage Leeched as Mana" leeches from the physical share only).
function upkeepLinesOf(build, context) {
  const lines = { costIncreased: 0, costMore: 1, costEfficiency: 0, costPerUnreservedMana: 0, regenIncreased: 0,
    regenPercent: 0, regenFlat: 0, leech: 0, onHit: 0, onKill: 0, onKillPercent: 0 };
  // Without solved gear or a planned tree, their usual mana regeneration stands in (as their other fixed figures do).
  if (!build.gear) {
    lines.regenIncreased += GEAR_MANA_REGEN_INCREASED;
  }
  if (!build.tree) {
    lines.regenIncreased += TREE_MANA_REGEN_INCREASED;
  }
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      if (!UPKEEP_STATS.has(effect.stat)) {
        continue;
      }
      const weight = effectWeight(effect, context, NO_CRIT_BRANCH);
      if (weight === 0) {
        continue;
      }
      addUpkeepLine(lines, effect, (effect.value || 0) * weight);
    }
  }
  return lines;
}

const UPKEEP_STATS = new Set(['cost', 'costEfficiency', 'costPerUnreservedMana', 'manaRegen', 'manaRegenFlat', 'manaLeech', 'manaOnHit', 'manaOnKill', 'manaOnKillPercent']);

function addUpkeepLine(lines, effect, amount) {
  if (effect.stat === 'cost') {
    if (effect.kind === 'increased') {
      lines.costIncreased += amount;
    } else if (effect.kind === 'more') {
      lines.costMore *= Math.max(0, 1 + amount / 100);
    }
  } else if (effect.stat === 'costEfficiency' && effect.kind === 'increased') {
    lines.costEfficiency += amount;
  } else if (effect.stat === 'costPerUnreservedMana') {
    lines.costPerUnreservedMana += amount;
  } else if (effect.stat === 'manaRegen') {
    if (effect.kind === 'increased') {
      lines.regenIncreased += amount;
    } else if (effect.kind === 'flat') {
      lines.regenPercent += amount;
    }
  } else if (effect.stat === 'manaRegenFlat') {
    lines.regenFlat += amount;
  } else if (effect.stat === 'manaLeech') {
    lines.leech += amount;
  } else if (effect.stat === 'manaOnHit') {
    lines.onHit += amount;
  } else if (effect.stat === 'manaOnKill') {
    lines.onKill += amount;
  } else if (effect.stat === 'manaOnKillPercent') {
    lines.onKillPercent += amount;
  }
}

// Mana regained per second: regeneration of the whole pool (reserved mana regenerates too), leech and mana on hit
// while the skill hits, and mana on kill.
function manaRegainedPerSecond(build, context, maximumMana, usesPerSecond, lines) {
  let regeneration = 0;
  if (!context.flags.has('noManaRegen')) {
    regeneration = maximumMana * (BASE_MANA_REGEN_PERCENT + lines.regenPercent) / 100
      * Math.max(0, 1 + lines.regenIncreased / 100) + lines.regenFlat;
  }
  const hits = !(context.isDamageOverTime && !context.types.has('Damage'));
  const leechRate = hits ? Math.min(MAX_MANA_LEECH_RATE, lines.leech * LEECH_RATE_PER_PERCENT) : 0;
  const leech = maximumMana * leechRate / 100;
  const onHit = hits ? lines.onHit * usesPerSecond : 0;
  const onKill = (lines.onKill + maximumMana * lines.onKillPercent / 100) * MANA_KILLS_PER_SECOND;
  return regeneration + leech + onHit + onKill;
}

// ---------- reservation ----------
// What a buff reserves is scaled by the reservation lines of the build's pieces (not the buffs themselves) that apply
// to it: those whose tags the buff has (a line naming heralds applies to heralds only) and, when a line names a skill
// ("Hatred has 50% increased Mana Reservation Efficiency"), only that skill. Lines under a condition aren't counted
// (Bubonic Trail's, Mask of the Tribunal's per attributes). Increased efficiency divides the reservation (the
// assumed share plus the lines); "40% more Mana Reservation of Aura Skills" (Supreme Ego) multiplies it.
function reservationScaleFor(build, buff) {
  let efficiency = RESERVATION_EFFICIENCY_ASSUMED;
  let multiplier = 1;
  for (const piece of piecesOf(build)) {
    if (piece.kind === 'aura' || piece.kind === 'herald' || piece.kind === 'self' || piece.kind === 'curse') {
      continue;
    }
    for (const effect of piece.effects) {
      if (effect.stat !== 'reservation' || effect.condition) {
        continue;
      }
      if (effect.kind !== 'increased' && effect.kind !== 'more') {
        continue;
      }
      if ((effect.subject || 'self') !== 'self') {
        continue;
      }
      if (effect.skill && effect.skill !== (buff.baseName || buff.name)) {
        continue;
      }
      if (!(effect.tags || []).every(tag => tag === buff.kind)) {
        continue;
      }
      if (effect.kind === 'increased') {
        efficiency += effect.value || 0;
      } else {
        multiplier *= 1 + (effect.value || 0) / 100;
      }
    }
  }
  return 100 / (100 + Math.max(RESERVATION_EFFICIENCY_FLOOR, efficiency)) * multiplier;
}

// What these buffs reserve, after efficiency: shares of mana and of life (mana, life, in percent) and flat amounts
// (manaFlat, lifeFlat).
function reservedPercentOf(build, buffs) {
  const reserved = { mana: 0, life: 0, manaFlat: 0, lifeFlat: 0 };
  const bloodMagic = hasBloodMagic(build);
  for (const buff of buffs) {
    if (!buffReserves(buff)) {
      continue;
    }
    const efficiencyScale = reservationScaleFor(build, buff);
    const share = (buff.reservation || 0) * efficiencyScale;
    const flat = (buff.reservationFlat || 0) * efficiencyScale;
    if (buff.reservesLife || bloodMagic) {
      reserved.life += share;
      reserved.lifeFlat += flat;
    } else {
      reserved.mana += share;
      reserved.manaFlat += flat;
    }
  }
  return reserved;
}

function buffReserves(buff) {
  return buff.reservation > 0 || buff.reservationFlat > 0;
}

// The reservable limits' check. Flat reservations (Clarity, Vitality, Precision reserve an amount, not a share) count
// as a share of a bare character's pool: its life (REFERENCE_DEFENCE) and its mana with gear. The score itself takes
// them from the build's own pools (effectiveHp).
function reservationFits(reserved) {
  const manaShare = reserved.mana + reserved.manaFlat / (CHARACTER_MANA + GEAR_MANA) * 100;
  const lifeShare = reserved.life + reserved.lifeFlat / REFERENCE_DEFENCE.life * 100;
  return manaShare <= RESERVABLE_MANA_PERCENT && lifeShare <= RESERVABLE_LIFE_PERCENT;
}

// ---------- utility: speed and item find ----------
// What the build planner's speed and rarity stages weigh. Neither is part of the power score. Movement speed counts
// each line at how often its condition holds (a Quicksilver Flask at its uptime); rarity and quantity are the plain
// "of Items found" lines (scripts/mechanics_vocabulary.py).
const UTILITY_STATS = { movementSpeed: 'movementSpeed', itemRarity: 'itemRarity', itemQuantity: 'itemQuantity' };

function utilityOf(build, context) {
  const totals = { movementSpeed: 0, itemRarity: 0, itemQuantity: 0 };
  const branch = { crit: false, critChance: 0 };
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      const total = UTILITY_STATS[effect.stat];
      if (!total || effect.kind !== 'increased' || (effect.subject || 'self') !== 'self') {
        continue;
      }
      const weight = effectWeight(effect, context, branch);
      if (weight === 0) {
        continue;
      }
      totals[total] += effect.value * weight;
    }
  }
  return totals;
}

// ---------- clear ----------
function clearOf(build, context) {
  let total = 1;
  if (context.tags.has('area')) {
    total += 0.25;
  }
  if (context.tags.has('projectile')) {
    total += 0.2;
  }
  if (context.tags.has('chain')) {
    total += 0.2;
  }
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      if (effectWeight(effect, context, { crit: false, critChance: 0 }) === 0) {
        continue;
      }
      if (effect.stat === 'area' && (effect.kind === 'increased' || effect.kind === 'more')) {
        total += 0.003 * effect.value;
      } else if (effect.stat === 'projectiles') {
        total += 0.06 * effect.value;
      } else if (effect.stat === 'chains' || effect.stat === 'pierce') {
        total += 0.08 * effect.value;
      } else if (effect.stat === 'movementSpeed') {
        total += 0.004 * effect.value;
      } else if (effect.kind === 'flag' && effect.stat === 'explodeOnKill') {
        total += 0.15; // corpses exploding through a pack, about as much as chaining
      }
    }
  }
  return Math.max(0.5, total);
}

// ---------- feasibility ----------
// Problems that make a build not work at all; the generator never keeps a build with one.
// Immune to what enemies' critical strikes add: no extra damage from them (The Brass Dome), or no enemy crits at all
// (Garb of the Ephemeral on an Animated Guardian).
function critImmune(flags) {
  return flags.has('noExtraCritDamage') || flags.has('enemy:neverCrit');
}

function problemsOf(build, context) {
  const problems = [];
  if (context.flags.has('noSelfDamage') && !context.tags.has('totem') && !context.isMinion) {
    problems.push('the keystone stops you dealing damage yourself, and this skill is yours');
  }
  if (context.flags.has('pureElement')) {
    let hasElement = false;
    for (const type of ['fire', 'cold', 'lightning']) {
      if (context.shares[type] > 0.5) {
        hasElement = true;
      }
    }
    if (!hasElement) {
      problems.push('the keystone allows only one element, and this skill deals another kind of damage');
    }
  }
  if (context.flags.has('noElementalAilments') && context.ailment === 'ignite') {
    problems.push('the build relies on Ignite but a piece forbids it');
  }
  // Dance with Death makes enemies' critical strikes lucky: without immunity to extra crit damage a boss's crit can
  // take a full life pool, so the keystone is only worth taking beside it (mechanics_statements.py says why).
  if (context.flags.has('critTakenLucky') && !critImmune(context.flags)) {
    problems.push('a keystone makes enemies\' critical strikes lucky, and nothing stops them (The Brass Dome, or an Animated Guardian in Garb of the Ephemeral)');
  }
  if (context.flags.has('noHelmet')) {
    for (const unique of build.uniques) {
      if (unique.slot === 'helmet') {
        problems.push(`a keystone forbids helmets, so ${unique.name} can't be worn`);
      }
    }
  }
  let weaponUniques = 0;
  for (const unique of build.uniques) {
    if (unique.slot === 'weapon') {
      weaponUniques += 1;
      const heldWithShield = build.weapon === 'shield' && !unique.twoHanded;
      if (build.weapon !== 'none' && !heldWithShield && unique.weapon && !uniqueFitsWeapon(unique, build.weapon)) {
        problems.push(`${unique.name} is a ${unique.category}, not the ${build.weapon} the build uses`);
      }
    }
    if (unique.slot === 'offhand' && unique.category === 'Shield' && build.weapon && isTwoHandedWeapon(build.weapon)) {
      problems.push(`${unique.name} needs a free off-hand`);
    }
    if (unique.slot === 'offhand' && unique.category === 'Quiver' && build.weapon !== 'bow') {
      problems.push(`${unique.name} is a quiver, for bow builds`);
    }
  }
  for (const entry of build.supports) {
    if (entry.support.weapons.length > 0 && !entry.support.weapons.includes(weaponFamilyOf(build.weapon))) {
      problems.push(`${entry.support.name} works only with ${entry.support.weapons.join(' or ')}`);
    }
  }
  return problems;
}

function attributeFactor(build) {
  if (build.gear) {
    const short = attributeShortOf(build);
    const missing = Math.max(0, short.str) + Math.max(0, short.dex) + Math.max(0, short.int);
    return Math.max(ATTRIBUTE_SHORT_FLOOR, 1 - missing * ATTRIBUTE_SHORT_PER_POINT);
  }
  const classAttributes = CLASS_ATTRIBUTES[build.ascendancy.baseClass] || [];
  for (const attribute of build.skill.attributes) {
    if (!classAttributes.includes(attribute)) {
      return OFF_ATTRIBUTE_FACTOR;
    }
  }
  return 1;
}

// ---------- gear needs (public/buildgear.js) ----------
// What a build is short of with its gear so far: resistance to its cap for each element, and attribute points for
// its requirements.
export function gearNeedsOf(build) {
  const context = contextOf(build);
  const totals = defenceTotals(build, context);
  const resistanceShort = {};
  for (const element of ELEMENTS) {
    const cap = maximumResistanceOf(totals, context.flags, element, true);
    resistanceShort[element] = cap - (CAMPAIGN_RESISTANCE_PENALTY + totals.resistance[element]);
  }
  return { resistanceShort, attributeShort: attributeShortOf(build) };
}

// The hooks the gear solver uses: the score, the shortfalls, and whether an affix can change this build at all
// (its context taken once per solve: the skill, supports and weapon decide it).
function gearEngine(scoreOf) {
  return {
    evaluate: scoreOf,
    needsOf: gearNeedsOf,
    affixFilterFor: build => {
      const context = contextOf(build);
      return affix => affix.effects.some(effect => effect.local || effectCanMatter(effect, context));
    },
  };
}

// The attributes the build has: its class's, then every flat line (tree, pieces, gear) and "increased" lines.
function attributeSupplyOf(build) {
  // The reference character (referenceHp) has no ascendancy: it gets the plain 20 of each.
  const baseClass = build.ascendancy ? build.ascendancy.baseClass : null;
  const base = CLASS_BASE_ATTRIBUTES[baseClass] || { str: 20, dex: 20, int: 20 };
  const flat = { ...base };
  const increased = { str: 0, dex: 0, int: 0 };
  const statOf = { strength: ['str'], dexterity: ['dex'], intelligence: ['int'], attributes: ['str', 'dex', 'int'] };
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      const attributes = statOf[effect.stat];
      if (!attributes || (effect.subject || 'self') !== 'self' || effect.condition) {
        continue;
      }
      for (const attribute of attributes) {
        if (effect.kind === 'flat') {
          flat[attribute] += effect.value || 0;
        } else if (effect.kind === 'increased') {
          increased[attribute] += effect.value || 0;
        }
      }
    }
  }
  const supply = {};
  for (const attribute of ['str', 'dex', 'int']) {
    supply[attribute] = flat[attribute] * (1 + increased[attribute] / 100);
  }
  return supply;
}

// The highest requirement of each attribute among the build's gems (level 20), uniques and item bases.
function attributeRequirementsOf(build) {
  const requirements = { str: 0, dex: 0, int: 0 };
  const raise = (attribute, amount) => {
    requirements[attribute] = Math.max(requirements[attribute], amount);
  };
  const gems = [
    ...[build.skill, ...(build.buffs || [])].map(gem => ({ gem, requirement: GEM_ATTRIBUTE_REQUIREMENT })),
    ...linkedSupports(build).map(entry => ({ gem: entry.support, requirement: SUPPORT_ATTRIBUTE_REQUIREMENT })),
    ...(build.buffs || []).filter(buff => buff.supportAttributes).map(buff => ({ gem: { attributes: buff.supportAttributes }, requirement: SUPPORT_ATTRIBUTE_REQUIREMENT })),
  ];
  for (const { gem, requirement } of gems) {
    const attributes = gem.attributes || [];
    const shares = GEM_ATTRIBUTE_SHARES[attributes.length] || [];
    attributes.forEach((attribute, position) => raise(attribute, requirement * (shares[position] || 0)));
  }
  for (const unique of build.uniques) {
    for (const [attribute, amount] of Object.entries(unique.requirements || {})) {
      raise(attribute, amount || 0);
    }
  }
  if (build.gear) {
    for (const [attribute, amount] of Object.entries(gearRequirements(wornGear(build)))) {
      raise(attribute, amount);
    }
  }
  return requirements;
}

export function attributeDetailOf(build) {
  return { supply: attributeSupplyOf(build), requirements: attributeRequirementsOf(build) };
}

function attributeShortOf(build) {
  const supply = attributeSupplyOf(build);
  const requirements = attributeRequirementsOf(build);
  const short = {};
  for (const attribute of ['str', 'dex', 'int']) {
    short[attribute] = Math.ceil(requirements[attribute] - supply[attribute]);
  }
  return short;
}

// ---------- scoring ----------
// Raw damage can't be compared between a minion skill, a spell and an attack (their bases mean different
// things), so a build's offence is measured against its own bare skill: how far its pieces scale it.
const bareOffenceCache = new Map();

// An attack's baseline is the best of its weapons bare (the weapon base's damage now counts), so a staff's lower
// damage shows against a two-handed axe's; any other skill is measured against itself with the build's weapon.
function bareOffence(build) {
  const weaponCounts = build.skill.types.includes('Attack') && weaponBases !== null;
  const key = build.skill.name + '|' + (weaponCounts ? 'best weapon' : build.weapon) + '|' + (build.ailment || '');
  if (bareOffenceCache.has(key)) {
    return bareOffenceCache.get(key);
  }
  let value = 0;
  const weapons = weaponCounts ? weaponChoicesFor(build.skill) : [build.weapon];
  for (const weapon of weapons) {
    value = Math.max(value, bareOffenceWith(build, weapon));
  }
  bareOffenceCache.set(key, value);
  return value;
}

function bareOffenceWith(build, weapon) {
  const bare = { skill: build.skill, ascendancy: NO_ASCENDANCY, weapon, ailment: build.ailment,
    supports: [], notables: [], keystones: [], uniques: [], buffs: [], flasks: [] };
  const bareContext = contextOf(bare);
  bareContext.everyHitLands = true;
  return bestOffence(bare, bareContext).value;
}

// The reference rare one-handed sword's damage per second: the unit of weaponBaseFactor (any constant would do, as
// the baseline carries it too; this keeps the factor near 1).
function referenceAttackDamagePerSecond() {
  const sword = referenceWeaponOf('sword');
  return sword ? sword.damagePerSecond : 1;
}

export function evaluateBuild(build) {
  const context = contextOf(build);
  // Defences first: lines that turn a defence into damage (perDefence: Righteous Fire, Ephemeral Edge, Dreamfeather)
  // read the build's own life, energy shield, armour and evasion.
  const defenceResult = defenceOf(build, context);
  context.defence = { life: defenceResult.life, energyShield: defenceResult.energyShield, armour: defenceResult.armour,
    evasion: defenceResult.evasion, overcappedFire: defenceResult.overcappedFire, mana: defenceResult.mana,
    unreservedMana: defenceResult.unreservedMana };
  context.accuracy = accuracyOf(build, context);
  const offence = bestOffence(build, context);
  // The skill is used only as often as the build can pay for it.
  const upkeep = manaUpkeepOf(build, context, defenceResult, offence.useSpeed);
  offence.value *= upkeep.share;
  if (offence.dps) {
    offence.dps *= upkeep.share;
  }
  const scaling = offence.value / bareOffence(build);
  const defence = defenceResult.index;
  const clear = clearOf(build, context);
  const problems = problemsOf(build, context);
  const attributes = attributeFactor(build);
  const score = Math.pow(scaling, SCORE_WEIGHTS.offence) * Math.pow(defence, SCORE_WEIGHTS.defence)
    * Math.pow(clear, SCORE_WEIGHTS.clear) * attributes;
  const utility = utilityOf(build, context);
  return { score: problems.length > 0 ? 0 : score, offence: offence.value, scaling, defence, ehp: defenceResult.ehp, pool: defenceResult.pool, life: defenceResult.life, dps: offence.dps ?? null,
    energyShield: defenceResult.energyShield, clear, crit: offence.crit,
    critChance: offence.critChance, accuracy: context.accuracy, hitChance: hitChanceOf(context), problems, tags: [...context.tags].sort(), shares: context.shares,
    attributes, maxHit: defenceResult.maxHit, recovery: defenceResult.recovery, sheet: defenceSheetOf(defenceResult),
    mana: defenceResult.mana, unreservedMana: defenceResult.unreservedMana, upkeep,
    movementSpeed: utility.movementSpeed, itemRarity: utility.itemRarity, itemQuantity: utility.itemQuantity };
}

// The card's defence numbers, rounded, from the gear choice the effective HP was measured with: life, energy
// shield, armour, evasion and the chance to evade an attack, physical damage reduction against the reference hit,
// block, spell block and suppression (percent), the resistances, "damage taken" lines as one percent (negative is
// less taken), and the "taken as" lines (which the effective HP doesn't count yet).
function defenceSheetOf(defence) {
  const hit = defence.hit;
  if (!hit) {
    return null;
  }
  const percent = share => Math.round(share * 100);
  const resistances = {};
  for (const [type, value] of Object.entries(hit.resistances)) {
    resistances[type] = Math.round(value);
  }
  const sheet = {
    life: Math.round(defence.life), energyShield: Math.round(defence.energyShield),
    armour: Math.round(defence.armour), evasion: Math.round(defence.evasion), evade: percent(hit.evade),
    physicalReduction: Math.round(hit.physicalReduction), block: percent(hit.block), spellBlock: percent(hit.spellBlock),
    suppress: percent(hit.suppress), resistances, damageTaken: Math.round((hit.takenFactor - 1) * 100),
  };
  if (defence.takenAs && defence.takenAs.length > 0) {
    sheet.takenAs = defence.takenAs.map(line => ({ from: line.from, to: line.to, value: roundTo(line.value, 1) }));
  }
  return sheet;
}

// The power score's weights, for the build planner's stages (public/buildstages.js), whose defaults reproduce it.
export const POWER_SCORE_WEIGHTS = SCORE_WEIGHTS;

// ---------- prices ----------
// Gives each unique its price in Divines (null when poe.ninja doesn't list it). Without this call the generator
// plans without prices.
export function attachPrices(index, chaosByName, divineChaos) {
  index.priced = true;
  for (const unique of index.uniques) {
    // A version of a unique ("Skin of the Lords (Iron Reflexes)") is priced as the item, which is what poe.ninja lists.
    let chaos = chaosByName[unique.name];
    if (typeof chaos !== 'number' && unique.baseName) {
      chaos = chaosByName[unique.baseName];
    }
    unique.price = typeof chaos === 'number' ? chaos / divineChaos : null;
  }
}

// The build's uniques' cost in Divines, an unpriced unique counted at UNPRICED_DIVINES. null when no prices
// were given.
// The uniques a build pays for: those it wears and those its buffs carry (the Animated Guardian's Garb).
function pricedUniquesOf(build) {
  const priced = [...build.uniques];
  for (const buff of build.buffs || []) {
    if (buff.carriedUnique) {
      priced.push(buff.carriedUnique);
    }
  }
  return priced;
}

export function costOf(build) {
  let total = 0;
  let anyPriced = false;
  for (const unique of pricedUniquesOf(build)) {
    if (unique.price === undefined) {
      continue;
    }
    anyPriced = true;
    total += unique.price === null ? UNPRICED_DIVINES : unique.price;
  }
  return anyPriced ? total : null;
}

// The power score: what the original plan chooses by and what every build reports.
function powerScore(build) {
  return evaluateBuild(build).score;
}

// The value score: the power over what the build's uniques cost. Each unique is weighed on its own, since a build
// doesn't buy its uniques as one item.
export function valueScore(build) {
  const score = evaluateBuild(build).score;
  return score / pricePenalty(build);
}

// What the value plan divides power by: per unique, 1 + PRICE_WEIGHT x ln(1 + its price in Divines).
export function pricePenalty(build) {
  let penalty = 1;
  for (const unique of pricedUniquesOf(build)) {
    if (unique.price === undefined) {
      continue;
    }
    const divines = unique.price === null ? UNPRICED_DIVINES : unique.price;
    penalty *= 1 + PRICE_WEIGHT * Math.log(1 + divines);
  }
  return penalty;
}

// The value version of a score: the build planner's stage score over the same price penalty. For the power score
// this is valueScore.
function pricedScoreOf(scoreOf) {
  if (scoreOf === powerScore) {
    return valueScore;
  }
  return build => scoreOf(build) / pricePenalty(build);
}

// ---------- composing a build ----------
function emptyBuild(skill, ascendancy, weapon, ailment) {
  return { skill, ascendancy, weapon, ailment, supports: [], notables: [], keystones: [], uniques: startingUniquesOf(skill),
    buffs: [], flasks: [] };
}

function withPiece(build, field, piece) {
  const copy = { ...build, [field]: [...build[field], piece] };
  return copy;
}

function supportCandidates(build, index) {
  const chosen = [];
  for (const entry of build.supports) {
    chosen.push(entry.support);
  }
  const types = typesWithSupports(build.skill, chosen);
  const minionTypes = minionTypesOf(build);
  const candidates = [];
  for (const support of index.supports) {
    if (support.awakened) {
      continue;
    }
    let alreadyChosen = false;
    for (const entry of build.supports) {
      if (entry.support.name === support.name || baseSupportName(entry.support.name) === baseSupportName(support.name)) {
        alreadyChosen = true;
      }
    }
    if (alreadyChosen || support.trigger || hasSkippedFlag(support)) {
      continue;
    }
    if (build.forbiddenAddedTypes && addsAnyType(support, build.forbiddenAddedTypes)) {
      continue;
    }
    if (support.weapons.length > 0 && !support.weapons.includes(weaponFamilyOf(build.weapon))) {
      continue;
    }
    const fit = supportFits(support, types, minionTypes, true);
    if (fit === null) {
      continue;
    }
    candidates.push({ support, via: fit });
  }
  return candidates;
}

// Whether a support adds one of these skill types (Spell Totem adds SummonsTotem). The build planner's playstyle
// limit forbids the supports that would change how the skill is delivered.
function addsAnyType(support, types) {
  for (const type of support.added || []) {
    if (types.includes(type)) {
      return true;
    }
  }
  return false;
}

// "Greater Multiple Projectiles Support" and "Greater Multiple Projectiles" variants count as one gem.
function baseSupportName(name) {
  return name.replace(/^(Greater|Lesser|Awakened) /, '').replace(/ Support$/, '');
}

function hasSkippedFlag(support) {
  for (const effect of support.effects) {
    if (effect.kind === 'flag' && SUPPORT_FLAGS_SKIPPED.has(effect.stat)) {
      return true;
    }
  }
  return false;
}

// A support that only reaches the minions has its "supported" effects apply to them.
function supportEntry(candidate) {
  if (candidate.via !== 'minion') {
    return { support: candidate.support, via: 'skill' };
  }
  const minionEffects = [];
  for (const effect of candidate.support.effects) {
    minionEffects.push({ ...effect, subject: effect.subject === 'supported' || !effect.subject ? 'minion' : effect.subject });
  }
  return { support: { ...candidate.support, effects: minionEffects }, via: 'minion' };
}

// Adds the best candidate of one kind while it improves the score enough. Returns the improved build.
function addBest(build, field, candidates, limit, makeEntry, isAllowed, scoreOf = powerScore) {
  let current = build;
  let currentScore = scoreOf(current);
  while (current[field].length < limit) {
    let bestBuild = null;
    let bestScore = currentScore;
    const pool = typeof candidates === 'function' ? candidates(current) : candidates;
    for (const candidate of pool) {
      if (isAllowed && !isAllowed(current, candidate)) {
        continue;
      }
      if (alreadyIn(current[field], candidate)) {
        continue;
      }
      const trial = withPiece(current, field, makeEntry(candidate));
      const trialScore = scoreOf(trial);
      if (trialScore > bestScore) {
        bestScore = trialScore;
        bestBuild = trial;
      }
    }
    if (bestBuild === null || bestScore < currentScore * (1 + MIN_GAIN_TO_KEEP)) {
      break;
    }
    current = bestBuild;
    currentScore = bestScore;
  }
  return current;
}

function alreadyIn(chosen, candidate) {
  const candidateName = candidate.support ? candidate.support.name : candidate.name;
  for (const entry of chosen) {
    const name = entry.support ? entry.support.name : entry.name;
    if (name === candidateName) {
      return true;
    }
  }
  return false;
}

function uniqueAllowed(build, unique) {
  let used = 0;
  if (!keepsReservationFit(build, 'uniques', unique)) {
    return false;
  }
  // A version that grants a keystone the build already has adds nothing for it.
  if (unique.baseName && unique.variant && keystonesHeldBy(build).has(unique.variant)) {
    return false;
  }
  for (const chosen of build.uniques) {
    // One of an item, whichever version of it (Skin of the Lords comes in one version per keystone).
    if ((chosen.baseName || chosen.name) === (unique.baseName || unique.name)) {
      return false;
    }
    if (chosen.slot === unique.slot) {
      used += 1;
    }
  }
  let slotCount = SLOT_COUNT[unique.slot] || 1;
  if (unique.slot === 'weapon') {
    slotCount = weaponsHeld(build);
  }
  if (used >= slotCount) {
    return false;
  }
  // Dual wielding holds no shield: a one-handed weapon and a shield is the "shield" plan.
  if (unique.category === 'Shield' && dualWields(build)) {
    return false;
  }
  // A two-handed weapon takes both hands, so it goes with no other weapon.
  if (unique.slot === 'weapon') {
    for (const chosen of build.uniques) {
      if (chosen.slot === 'weapon' && (chosen.twoHanded || unique.twoHanded)) {
        return false;
      }
    }
  }
  // Hands: a two-handed weapon leaves no room for a shield or quiver, and the other way round.
  for (const chosen of build.uniques) {
    if (chosen.twoHanded && unique.slot === 'offhand' && unique.category !== 'Quiver') {
      return false;
    }
    if (unique.twoHanded && chosen.slot === 'offhand' && chosen.category !== 'Quiver') {
      return false;
    }
  }
  if (unique.slot === 'weapon') {
    // A weapon unique has to be the weapon the build was planned around; "none" means no weapon matters.
    if (build.weapon === 'none') {
      return false;
    }
    if (build.weapon === 'shield') {
      return !unique.twoHanded;
    }
    return uniqueFitsWeapon(unique, build.weapon);
  }
  if (unique.category === 'Quiver' && build.weapon !== 'bow') {
    return false;
  }
  if (unique.category === 'Shield' && isTwoHandedWeapon(build.weapon)) {
    return false;
  }
  return true;
}

// A unique weapon fits the planned weapon kind when it is of its family and held the same way: Starforge on a
// two-handed sword build, Paradoxica on a one-handed one. Two-handed melee weapons were planned as one-handers until
// 2026-11-25, and a two-handed unique then made the build two-handed.
function uniqueFitsWeapon(unique, weapon) {
  if (unique.weapon !== weaponFamilyOf(weapon)) {
    return false;
  }
  return Boolean(unique.twoHanded) === isTwoHandedWeapon(weapon);
}

// Utility flasks in the flask slots unique flasks leave.
function flaskAllowed(build, flask) {
  let uniqueFlasks = 0;
  for (const unique of build.uniques) {
    if (unique.slot === 'flask') {
      uniqueFlasks += 1;
    }
  }
  return (build.flasks || []).length + uniqueFlasks < UTILITY_FLASK_SLOTS;
}

// The curses a build can apply: one, and one more for each "You can apply an additional Curse" (Whispers of Doom, the
// Occultist's) among its pieces. That flag was read but never counted.
function curseLimitOf(build) {
  let limit = MAX_CURSES;
  const lists = [build.notables, build.keystones, build.uniques];
  if (build.tree) {
    lists.push([{ effects: build.tree.effects }]);
  }
  for (const list of lists) {
    for (const piece of list || []) {
      for (const effect of piece.effects) {
        if (effect.kind === 'flag' && effect.stat === 'extraCurse') {
          limit += 1;
        }
      }
    }
  }
  return limit;
}

// Auras, heralds and reserved buffs that fit in the pools after efficiency (RESERVABLE_MANA_PERCENT and
// RESERVABLE_LIFE_PERCENT), and the curses curseLimitOf allows.
function buffAllowed(build, buff) {
  let curses = 0;
  for (const chosen of build.buffs) {
    if (chosen.kind === 'curse') {
      curses += 1;
    }
  }
  // Each buff takes a socket, an aura linked to Eternal Blessing or Arrogance two.
  let sockets = buff.sockets || 1;
  let hasOffering = buff.kind === 'offering';
  for (const chosen of build.buffs || []) {
    sockets += chosen.sockets || 1;
    if (chosen.kind === 'offering') {
      hasOffering = true;
    }
  }
  // Offerings need corpses: one gem that makes them, however many Offerings use them.
  if (hasOffering) {
    sockets += OFFERING_CORPSE_GEM_SOCKETS;
  }
  if (sockets > socketsForBuffs(build)) {
    return false;
  }
  if (buff.kind === 'curse') {
    return curses < curseLimitOf(build);
  }
  if (!blessingRulesHold(build, buff)) {
    return false;
  }
  if (!buffReserves(buff)) {
    return true;
  }
  return reservationFits(reservedPercentOf(build, [...build.buffs, buff]));
}

// Whether the composer would let this buff join the build (sockets, reservation, curse and Blessing rules).
export function canAddBuff(build, buff) {
  return buffAllowed(build, buff);
}

// One Blessing aura, never beside the same aura reserved, and while it is on, only buffs that reserve life.
function blessingRulesHold(build, buff) {
  const chosen = build.buffs || [];
  const baseName = buff.baseName || buff.name;
  for (const other of chosen) {
    if ((other.baseName || other.name) === baseName) {
      return false;
    }
  }
  const blessingChosen = chosen.some(other => other.blessing);
  if (buff.blessing) {
    if (blessingChosen) {
      return false;
    }
    return chosen.every(other => !buffReserves(other) || reservesLife(build, other));
  }
  if (blessingChosen && buffReserves(buff)) {
    return reservesLife(build, buff);
  }
  return true;
}

// Whether a buff's reservation comes out of life: Petrified Blood's always, everything's with Blood Magic.
function reservesLife(build, buff) {
  return Boolean(buff.reservesLife) || hasBloodMagic(build);
}

// Blood Magic from a keystone, a unique, a notable or the tree (a cheap look, without the whole context).
function hasBloodMagic(build) {
  const lists = [build.keystones, build.uniques, build.notables];
  if (build.tree) {
    lists.push([build.tree]);
  }
  for (const list of lists) {
    for (const piece of list || []) {
      for (const effect of piece.effects || []) {
        if (effect.kind === 'flag' && effect.stat === 'bloodMagic') {
          return true;
        }
      }
    }
  }
  return false;
}

function keystoneAllowed(build, keystone) {
  if (keystonesHeldBy(build).has(keystone.name)) {
    return false;
  }
  return keepsReservationFit(build, 'keystones', keystone);
}

// Pieces are added after the buffs are chosen, and some change what the buffs reserve: Supreme Ego (40% more aura
// reservation) and Blood Magic (everything reserved moves to life, whose limit is lower). A piece that would push
// buffs that fit over the reservable limits is refused; a build already over them (none should be) is left alone.
function keepsReservationFit(build, field, piece) {
  const buffs = build.buffs || [];
  if (!buffs.some(buffReserves)) {
    return true;
  }
  if (!reservationFits(reservedPercentOf(build, buffs))) {
    return true;
  }
  const withPiece = { ...build, [field]: [...(build[field] || []), piece] };
  return reservationFits(reservedPercentOf(withPiece, buffs));
}

// The keystones a build has from its keystone pieces and from versions of uniques that grant one ("Skin of the Lords
// (Iron Reflexes)"). A keystone held twice does nothing more, so neither the composer nor the tree takes it again.
export function keystonesHeldBy(build) {
  const held = new Set();
  for (const chosen of build.keystones || []) {
    held.add(chosen.name);
  }
  for (const unique of build.uniques || []) {
    if (unique.baseName && unique.variant) {
      held.add(unique.variant);
    }
  }
  return held;
}

// Uniques worth trying for a skill: those with at least one effect that reaches it.
function relevantUniques(skillBuild, index) {
  const context = contextOf(skillBuild);
  const relevant = [];
  for (const unique of index.uniques) {
    let reaches = false;
    for (const effect of unique.effects) {
      if (effectWeight(effect, context, { crit: true, critChance: 0.5 }) > 0 && effect.kind !== 'flag') {
        reaches = true;
        break;
      }
    }
    if (reaches) {
      relevant.push(unique);
    }
  }
  return relevant;
}

const UNIQUE_SHORTLIST = 24;
const KEYSTONE_SHORTLIST = 10;
const WEAPONS_KEPT = 2;

// The weapon plans composed for each ascendancy: the best WEAPONS_KEPT, and the best of each weapon group besides
// (one hand, with or without a shield; a staff; a two-handed sword, axe or mace; a bow). A plan has no tree yet, and
// what lifts a staff or a two-handed weapon is mostly on the tree (staff block, two-handed lines): Heavy Strike planned
// bare put one-handed axes and swords first, and with Juggernaut's tree a staff scored 72.2, a two-handed sword 60.4
// and one-handed swords 63.1 (2026-11-25).
const WEAPON_GROUPS = { staff: 'staff', bow: 'bow', twoHandSword: 'twoHandMelee', twoHandAxe: 'twoHandMelee', twoHandMace: 'twoHandMelee' };

function weaponGroupOf(weapon) {
  return WEAPON_GROUPS[weapon] || 'oneHand';
}

function keptWeaponPlans(plans) {
  const kept = plans.slice(0, WEAPONS_KEPT);
  const groups = new Set(kept.map(plan => weaponGroupOf(plan.weapon)));
  for (const plan of plans) {
    const group = weaponGroupOf(plan.weapon);
    if (!groups.has(group)) {
      groups.add(group);
      kept.push(plan);
    }
  }
  return kept;
}
const NO_ASCENDANCY = { name: 'none', baseClass: null, notables: [] };

// Stage one, once per skill: for each weapon it could use, the supports that suit it best (before any
// ascendancy; supports decide what the skill is: a totem, a trap...), and shortlists of the uniques and
// keystones that help that set-up on their own. The best two weapons go on to stage two.
// The build planner's hard limits come in options: options.weapons keeps only those weapons, options.seedSupports
// puts supports in first (Spell Totem for a totem build) that the plan must keep, and options.scoreOf scores by the
// planner's stage weights instead of the power score. Without them this is the generator's plan.
export function planSkill(skill, index, options = {}) {
  const scoreOf = options.scoreOf || powerScore;
  const plans = [];
  for (const weapon of weaponChoicesFor(skill)) {
    if (options.weapons && !options.weapons.includes(weapon)) {
      continue;
    }
    let build = withRequiredUniques(emptyBuild(skill, NO_ASCENDANCY, weapon, options.ailment || null), index, options.requiredUniques);
    if (build === null) {
      continue;
    }
    if (options.forbiddenAddedTypes) {
      build.forbiddenAddedTypes = options.forbiddenAddedTypes;
    }
    build = seededSupports(build, index, options.seedSupports || []);
    if (build === null) {
      continue;
    }
    build = addBest(build, 'supports', current => supportCandidates(current, index), MAX_SUPPORTS, supportEntry, null, scoreOf);
    const score = scoreOf(build);
    if (score > 0) {
      plans.push({ weapon, build, score });
    }
  }
  plans.sort((first, second) => second.score - first.score);
  const kept = keptWeaponPlans(plans);
  if (kept.length > 0 && !options.noStacking) {
    const stacked = stackingPlanFor(kept[0], skill, index, options, scoreOf);
    if (stacked) {
      kept.push(stacked);
    }
  }
  for (const plan of kept) {
    plan.uniques = shortlist(plan.build, relevantUniques(plan.build, index), UNIQUE_SHORTLIST, 'uniques', uniqueAllowed, scoreOf);
    plan.keystones = shortlist(plan.build, index.keystones, KEYSTONE_SHORTLIST, 'keystones', keystoneAllowed, scoreOf);
    if (index.priced) {
      // The value plan's uniques: the same candidates, shortlisted for their gain over their price. Supports and
      // keystones come before any unique, so their shortlists are the same for both plans.
      plan.pricedUniques = shortlist(plan.build, relevantUniques(plan.build, index), UNIQUE_SHORTLIST, 'uniques', uniqueAllowed, pricedScoreOf(scoreOf));
    }
  }
  return { skill, plans: kept, seedSupports: options.seedSupports || [] };
}

// The stats this build's possible pieces turn into damage: a support, unique, keystone or ascendancy notable whose
// lines read a defence (perDefence), grow with unreserved mana (Archmage), or carry Transfiguration of Mind (mana) or
// of Body (life, for attacks).
function stackableStatsFor(build, index) {
  const stats = new Set();
  const isAttack = build.skill.types.includes('Attack');
  const lists = [[build.skill], supportCandidates(build, index).map(candidate => candidate.support), relevantUniques(build, index),
    index.keystones, index.bloodlineNotables || []];
  for (const ascendancy of index.ascendancies) {
    lists.push(ascendancy.notables);
  }
  for (const list of lists) {
    for (const piece of list) {
      for (const effect of piece.effects || []) {
        if (effect.kind === 'perDefence' && STACKING_EXTRA[effect.defence] !== undefined) {
          stats.add(effect.defence);
        } else if (effect.condition === 'unreservedMana' || (effect.kind === 'flag' && effect.stat === 'transfigurationOfMind')) {
          stats.add('mana');
        } else if (effect.kind === 'flag' && effect.stat === 'transfigurationOfBody' && isAttack) {
          stats.add('life');
        }
      }
    }
  }
  return stats;
}

// The plan committed to the stacked stat that gains most from the commitment, or null when none gains
// STACKING_MIN_GAIN. Its supports are chosen with the stat assumed (STACKING_EXTRA); the gain is measured against the
// plain plan given the same extra, so it counts what the committed pieces make of the stat.
function stackingPlanFor(plain, skill, index, options, scoreOf) {
  let best = null;
  for (const stat of stackableStatsFor(plain.build, index)) {
    let build = withRequiredUniques(emptyBuild(skill, NO_ASCENDANCY, plain.weapon, options.ailment || null), index, options.requiredUniques);
    if (build === null) {
      continue;
    }
    build = { ...build, stacking: stat, stackingPending: true };
    if (options.forbiddenAddedTypes) {
      build.forbiddenAddedTypes = options.forbiddenAddedTypes;
    }
    build = seededSupports(build, index, options.seedSupports || []);
    if (build === null) {
      continue;
    }
    build = addBest(build, 'supports', current => supportCandidates(current, index), MAX_SUPPORTS, supportEntry, null, scoreOf);
    const score = scoreOf(build);
    const plainWithExtra = scoreOf({ ...plain.build, stacking: stat, stackingPending: true });
    const gain = plainWithExtra > 0 ? score / plainWithExtra : 0;
    if (gain >= STACKING_MIN_GAIN && (best === null || gain > best.gain)) {
      best = { weapon: plain.weapon, build, score, gain, stacking: stat };
    }
  }
  return best;
}

// The build with the named supports socketed first, or null when one of them doesn't fit this skill and weapon
// (a totem build whose skill no totem support can carry).
function seededSupports(build, index, names) {
  let current = build;
  for (const name of names) {
    const candidates = supportCandidates(current, index);
    let found = null;
    for (const candidate of candidates) {
      if (candidate.support.name === name) {
        found = candidate;
      }
    }
    if (found === null) {
      return null;
    }
    current = withPiece(current, 'supports', supportEntry(found));
  }
  return current;
}

// The candidates that improve the build on their own, best first.
function shortlist(build, candidates, size, field, isAllowed, scoreOf = powerScore) {
  const baseScore = scoreOf(build);
  const scored = [];
  for (const candidate of candidates) {
    if (!isAllowed(build, candidate)) {
      continue;
    }
    const score = scoreOf(withPiece(build, field, candidate));
    if (score > baseScore) {
      scored.push({ candidate, gain: score / baseScore });
    }
  }
  scored.sort((first, second) => second.gain - first.gain);
  const kept = [];
  for (const entry of scored.slice(0, size)) {
    kept.push(entry.candidate);
  }
  return kept;
}

// Stage two, for each ascendancy: its notables, then keystones and uniques from the shortlists, then the
// supports once more now that the rest of the build is known. options.priced makes the value plan (prices must have
// been attached); otherwise it is the power plan, which never sees a price.
// options.scoreOf scores by the build planner's stage weights instead of the power score (the value plan divides
// it by the price penalty the same way). options.wide is the planner's wide search: the uniques are shortlisted
// again from all of them against this ascendancy's build, and the tree measures every node instead of skipping
// those whose tags can't reach the build.
export function composeForAscendancy(skillPlan, ascendancy, index, options = {}) {
  const priced = Boolean(options.priced && index.priced);
  const powerOf = options.scoreOf || powerScore;
  const scoreOf = priced ? pricedScoreOf(powerOf) : powerOf;
  let best = null;
  let bestChoice = -1;
  for (const plan of skillPlan.plans) {
    let build = { ...plan.build, ascendancy, notables: [], keystones: [], uniques: keptUniquesOf(plan.build), buffs: [], flasks: [] };
    if (index.tree) {
      // The tree follows the class (it decides where the tree starts), so one tree per class serves all three
      // of its ascendancies while they are compared; finalizeTree() plans it again for the finished build.
      build.tree = classTree(plan, ascendancy.baseClass, index, options);
    }
    build = addBest(build, 'notables', notableCandidates(build, index), ASCENDANCY_POINTS, notable => notable, notableAllowed, scoreOf);
    if (!index.tree) {
      build = addBest(build, 'keystones', plan.keystones, MAX_KEYSTONES, keystone => keystone, keystoneAllowed, scoreOf);
    }
    build = addBestBuffs(build, index, scoreOf);
    let uniques = priced ? plan.pricedUniques : plan.uniques;
    if (options.wide) {
      uniques = shortlist(build, index.uniques, UNIQUE_SHORTLIST, 'uniques', uniqueAllowed, scoreOf);
    }
    build = addBest(build, 'uniques', uniques, uniqueLimitOf(build), unique => unique, uniqueAllowed, scoreOf);
    build = addBest(build, 'flasks', index.flasks, UTILITY_FLASK_SLOTS, flask => flask, flaskAllowed, scoreOf);
    // A stacking commitment's assumed extra ends here: the gear is solved for the stat, and the real figures decide.
    if (build.stackingPending) {
      build = { ...build, stackingPending: false };
    }
    if (index.gear) {
      const gearLevel = options.gearLevel || DEFAULT_GEAR_LEVEL;
      build = solveGear(build, index.gear, gearEngine(scoreOf), gearLevel);
      build = dropUniquesRaresBeat(build, index, scoreOf, gearLevel);
    }
    // Its uniques are fixed by now, so the price penalty is the same for every support set: power decides.
    build = refineSupports(build, index, powerOf, skillPlan.seedSupports || []);
    build = betterWithSupportsFirst(build, index, scoreOf, powerOf, skillPlan.seedSupports || []);
    build = rebalancedBuffs(build, index, scoreOf);
    const choice = scoreOf(build);
    if (best === null || choice > bestChoice) {
      best = build;
      bestChoice = choice;
    }
  }
  // The evaluation is always the build's power; the value plan's prices only decided which pieces were chosen.
  return { build: best, evaluation: best ? evaluateBuild(best) : null };
}

// The uniques were chosen against the fixed gear figures, so a unique can win its slot over a figure that a solved
// rare item beats (a spell shield with +1 to spell gems and spell damage against Rathpith Globe). Each unique whose
// slot a rare item can fill is taken out in turn and only the freed slot filled (solveFreedSlots, quick); the best
// change is kept, until none helps, and a build that lost a unique has its gear solved in full once more.
function dropUniquesRaresBeat(build, index, scoreOf, gearLevel) {
  const engine = gearEngine(scoreOf);
  let current = build;
  let currentScore = scoreOf(current);
  let improved = true;
  while (improved) {
    improved = false;
    let bestTrial = null;
    let bestTrialScore = currentScore;
    for (const unique of current.uniques) {
      if (!freesRareSlot(current, unique) || isKeptUnique(current, unique)) {
        continue;
      }
      const without = { ...current, uniques: current.uniques.filter(other => other !== unique) };
      const trial = solveFreedSlots(without, index.gear, engine);
      const trialScore = scoreOf(trial);
      if (trialScore > bestTrialScore) {
        bestTrial = trial;
        bestTrialScore = trialScore;
      }
    }
    if (bestTrial !== null) {
      current = bestTrial;
      currentScore = bestTrialScore;
      improved = true;
    }
  }
  if (current === build) {
    return build;
  }
  const resolved = solveGear({ ...current, gear: undefined }, index.gear, engine, gearLevel);
  return scoreOf(resolved) >= currentScore ? resolved : current;
}

// The buffs, greedily, twice: from all of them, and without the Eternal Blessing auras. A Blessing aura is often the
// best single buff, but it shuts out every other buff reserving mana, so a set of reserved auras can beat it.
function addBestBuffs(build, index, scoreOf) {
  const withBlessing = addBest(build, 'buffs', index.buffs, MAX_BUFFS, buff => buff, buffAllowed, scoreOf);
  if (!withBlessing.buffs.some(buff => buff.blessing)) {
    return withBlessing;
  }
  const unblessed = index.buffs.filter(buff => !buff.blessing);
  const withoutBlessing = addBest(build, 'buffs', unblessed, MAX_BUFFS, buff => buff, buffAllowed, scoreOf);
  return scoreOf(withoutBlessing) > scoreOf(withBlessing) ? withoutBlessing : withBlessing;
}

// The buffs were chosen early, against a build without its uniques, gear and supports' final set: an Eternal Blessing
// aura could win then and shut out the reserved auras that the finished build, paying for its skill, has mana for.
// So they are chosen once more from nothing on the finished build, and the better set kept.
function rebalancedBuffs(build, index, scoreOf) {
  const trial = addBestBuffs({ ...build, buffs: [] }, index, scoreOf);
  return scoreOf(trial) > scoreOf(build) ? trial : build;
}

// The buffs were chosen before the supports were refined, so a support that wants unreserved mana (Archmage) loses to
// the auras already reserving it. The other order is tried too: the reserved buffs out, the supports refined with the
// whole pool, then the buffs chosen again, and the better build kept.
function betterWithSupportsFirst(build, index, scoreOf, powerOf, seedSupports) {
  const reservedBuffs = build.buffs.filter(buff => buffReserves(buff));
  if (reservedBuffs.length === 0) {
    return build;
  }
  let trial = { ...build, buffs: build.buffs.filter(buff => !buffReserves(buff)) };
  trial = refineSupports(trial, index, powerOf, seedSupports);
  trial = addBestBuffs(trial, index, scoreOf);
  return scoreOf(trial) > scoreOf(build) ? trial : build;
}

function classTree(plan, baseClass, index, options = {}) {
  plan.trees ??= new Map();
  if (!plan.trees.has(baseClass)) {
    // The class tree is planned before the buffs are chosen, so it is told they will reserve a typical share; else
    // Blood Magic looks like free life and Mind over Matter like a full pool of mana.
    const pending = { ...plan.build, ascendancy: NO_ASCENDANCY, pendingReservation: RESERVATION_WHILE_BUFFS_PENDING };
    plan.trees.set(baseClass, planTreeFor(pending, baseClass, index, treeOptionsOf(options)));
  }
  return plan.trees.get(baseClass);
}

// The planner options the tree needs: its score and whether the search is wide.
function treeOptionsOf(options) {
  const treeOptions = {};
  if (options.scoreOf) {
    treeOptions.scoreOf = options.scoreOf;
  }
  if (options.wide) {
    treeOptions.wide = true;
  }
  return treeOptions;
}

// The tree the build's own pieces call for, from its class's start. options.scoreOf and options.wide as for
// composeForAscendancy; the other options go to the tree planner.
function planTreeFor(build, baseClass, index, options = {}) {
  const { scoreOf, wide, ...plannerOptions } = options;
  const scoreFunction = scoreOf || powerScore;
  const matters = wide ? () => true : effectMattersFor(build);
  const evaluate = effects => scoreFunction({ ...build, tree: { effects } });
  const jewels = jewelChoicesFor(index, evaluate);
  const forbiddenKeystones = keystoneNodesNamed(index.tree, keystonesHeldBy(build));
  const tree = planTree(index.tree, baseClass, evaluate, matters, { ...plannerOptions, jewels, forbiddenKeystones });
  // The tree is scored without the reservable limits, so it can take a keystone that pushes the build's buffs over
  // them: Supreme Ego (more aura reservation) or Blood Magic (everything reserved moves to life, whose limit is
  // lower). Such a tree is planned again without those keystones.
  if (!tree) {
    return tree;
  }
  const breaking = reservationKeystonesIn(index.tree, tree);
  if (breaking.size === 0 || !(build.buffs || []).some(buffReserves)) {
    return tree;
  }
  if (reservationFits(reservedPercentOf({ ...build, tree }, build.buffs))) {
    return tree;
  }
  for (const id of breaking) {
    forbiddenKeystones.add(id);
  }
  return planTree(index.tree, baseClass, evaluate, matters, { ...plannerOptions, jewels, forbiddenKeystones });
}

// The keystones a planned tree took that change what buffs reserve (a reservation line or Blood Magic's flag).
function reservationKeystonesIn(passiveTree, planned) {
  const ids = new Set();
  for (const id of planned.nodes || []) {
    const node = passiveTree.nodes.get(id);
    if (!node || node.kind !== 'keystone') {
      continue;
    }
    if (node.effects.some(effect => effect.stat === 'reservation' || effect.stat === 'bloodMagic')) {
      ids.add(id);
    }
  }
  return ids;
}

// The tree's keystone nodes with these names: a keystone the build already holds (keystonesHeldBy).
function keystoneNodesNamed(tree, names) {
  const ids = new Set();
  if (names.size === 0) {
    return ids;
  }
  for (const [id, node] of tree.nodes) {
    if (node.kind === 'keystone' && names.has(node.name)) {
      ids.add(id);
    }
  }
  return ids;
}

// What the tree's sockets can hold for this build: its rare jewel and its best large cluster jewels.
function jewelChoicesFor(index, evaluate) {
  const base = evaluate([]);
  if (!(base > 0)) {
    return null;
  }
  const rare = bestRareJewel(index.jewelMods || [], evaluate);
  const clusters = [];
  for (const type of index.largeClusters || []) {
    const cluster = largeClusterFor(type, evaluate);
    if (cluster) {
      clusters.push(cluster);
    }
  }
  clusters.sort((first, second) => second.gain - first.gain);
  return { rare, clusters: clusters.slice(0, LARGE_CLUSTER_TYPES_OFFERED), maxClusters: MAX_LARGE_CLUSTERS,
    timeless: bestTimelessChoices(index.timeless || [], evaluate, base),
    radius: radiusChoicesFor(index.radiusJewels || [], index.tree, evaluate, base) };
}

// The radius jewels worth trying in this build's sockets (public/buildradius.js). Each is scored exactly at a socket,
// so the list is kept short: a jewel whose rules change passives (a transform, Might of the Meek, Unnatural
// Instinct) or allocate them (Intuitive Leap, Thread of Hope) is always tried; one whose rules only add stats (The
// Light of Meaning, Transcendent Flesh) when those stats help this build; of the items that come in many versions,
// the few best: Impossible Escape's keystones by the keystone and the notables round it, The Light of Meaning's lines
// by the line.
const RADIUS_VERSIONS_OFFERED = 3;
const PASSIVES_ASSUMED_IN_RADIUS = 8; // to weigh an "also grant" line before a socket is known (our estimate)
const STRUCTURAL_RADIUS_RULES = new Set(['transform', 'retag', 'scale', 'nothing', 'unallocated', 'free']);

function radiusChoicesFor(choices, tree, evaluate, base) {
  const offered = [];
  const versionsOf = new Map();
  for (const choice of choices) {
    const worth = radiusChoiceWorth(choice, tree, evaluate, base);
    if (worth === null) {
      continue;
    }
    const versionsDifferInWorth = Boolean(choice.area.around) || choice.rules.some(rule => rule.rule === 'also');
    if (choice.baseName === choice.name || !versionsDifferInWorth) {
      offered.push(choice); // Thread of Hope's rings differ in where they reach, which only a socket tells
      continue;
    }
    if (!versionsOf.has(choice.baseName)) {
      versionsOf.set(choice.baseName, []);
    }
    versionsOf.get(choice.baseName).push({ choice, worth });
  }
  for (const versions of versionsOf.values()) {
    versions.sort((first, second) => second.worth - first.worth);
    for (const entry of versions.slice(0, RADIUS_VERSIONS_OFFERED)) {
      offered.push(entry.choice);
    }
  }
  return offered;
}

// A rough worth of a radius jewel for this build before any socket is known, or null when it can't help: its own
// lines and the stats its rules add (at PASSIVES_ASSUMED_IN_RADIUS passives), and for a free-allocation jewel round a
// keystone, that keystone with the notables round it.
function radiusChoiceWorth(choice, tree, evaluate, base) {
  const added = [...choice.effects];
  let structural = false;
  for (const rule of choice.rules) {
    if (STRUCTURAL_RADIUS_RULES.has(rule.rule)) {
      structural = true;
    }
    if (rule.rule === 'also' || rule.rule === 'alsoFromResistance') {
      for (const effect of rule.effects) {
        added.push({ ...effect, value: (effect.value || 0) * PASSIVES_ASSUMED_IN_RADIUS });
      }
    } else if (rule.rule === 'perAttribute' || rule.rule === 'threshold') {
      added.push(...rule.effects);
    }
  }
  if (choice.area.around && tree) {
    added.push(...tree.nodes.get(choice.area.around).effects);
    for (const id of radiusAreaNotables(tree, choice)) {
      added.push(...tree.nodes.get(id).effects);
    }
  }
  const worth = evaluate(added) / base - 1;
  if (worth > 0 || (structural && !choice.area.around)) {
    return worth;
  }
  return null;
}

function radiusAreaNotables(tree, choice) {
  const centre = tree.nodes.get(choice.area.around);
  const ids = [];
  for (const node of tree.nodes.values()) {
    if (node.kind !== 'notable' || !node.position || !centre.position) {
      continue;
    }
    if (Math.hypot(node.position.x - centre.position.x, node.position.y - centre.position.y) <= choice.area.outer) {
      ids.push(node.id);
    }
  }
  return ids;
}

// The timeless keystones that help this build on their own, best first (the planner then weighs each against the
// points it costs to reach a socket and a keystone it can conquer, and what the jewel does to the passives round
// it), and the jewels without a keystone whose conquered passives could help at all: what a conquered small passive
// and notable may gain, before a socket says what they replace.
const TIMELESS_CHOICES_OFFERED = 3;

function bestTimelessChoices(choices, evaluate, base) {
  const helpful = [];
  const withoutKeystone = [];
  for (const choice of choices) {
    if (choice.keystone === null) {
      if (evaluate(conquestGains(choice)) / base - 1 > 0) {
        withoutKeystone.push(choice);
      }
      continue;
    }
    const gain = evaluate(choice.effects) / base - 1;
    if (gain > 0) {
      helpful.push({ choice, gain });
    }
  }
  helpful.sort((first, second) => second.gain - first.gain);
  return [...helpful.slice(0, TIMELESS_CHOICES_OFFERED).map(entry => entry.choice), ...withoutKeystone];
}

function conquestGains(choice) {
  const gains = [];
  for (const rule of choice.rules) {
    if (rule.rule === 'conquer') {
      gains.push(...rule.smallAttribute.effects, ...rule.small.effects, ...rule.notable.addition, ...rule.notable.replacement);
    }
  }
  return gains;
}

// The rare jewel: the modifiers that raise the score most, one at a time.
function bestRareJewel(mods, evaluate) {
  const chosen = [];
  const sides = { p: 0, s: 0 };
  let current = evaluate([]);
  while (chosen.length < RARE_JEWEL_MODS) {
    let best = null;
    for (const mod of mods) {
      if (chosen.includes(mod) || sides[mod.side] >= 2 || sharesAStat(mod, chosen)) {
        continue;
      }
      const score = evaluate(mergeEffects([...chosen.map(entry => entry.effects), mod.effects]));
      if (score > current && (best === null || score > best.score)) {
        best = { mod, score };
      }
    }
    if (best === null) {
      break;
    }
    chosen.push(best.mod);
    sides[best.mod.side] += 1;
    current = best.score;
  }
  if (!chosen.length) {
    return null;
  }
  return { key: 'rare', kind: 'rare', name: 'Rare jewel: ' + chosen.map(mod => mod.text.replace(/\n/g, ', ')).join('; '),
    effects: mergeEffects(chosen.map(mod => mod.effects)), points: 0 };
}

// A jewel can't roll two modifiers of one kind: two that change the same stat ("increased maximum Life" and a
// hybrid with it) are one too many.
function sharesAStat(mod, chosen) {
  const statKey = effect => effect.kind + ' ' + effect.stat + ' ' + (effect.tags || []).join('+') + ' ' + (effect.subject || 'self');
  const taken = new Set();
  for (const other of chosen) {
    for (const effect of other.effects) {
      taken.add(statKey(effect));
    }
  }
  return mod.effects.some(effect => taken.has(statKey(effect)));
}

// A large cluster jewel of one type: its small passive on the small passives taken, and its best notables.
function largeClusterFor(type, evaluate) {
  const smalls = scaledEffects(type.small || [], LARGE_CLUSTER_SMALLS);
  const chosen = [];
  let current = evaluate(smalls);
  while (chosen.length < LARGE_CLUSTER_NOTABLES) {
    let best = null;
    for (const notable of type.notables) {
      if (chosen.includes(notable)) {
        continue;
      }
      const score = evaluate(mergeEffects([smalls, ...chosen.map(entry => entry.effects), notable.effects]));
      if (score > current && (best === null || score > best.score)) {
        best = { notable, score };
      }
    }
    if (best === null) {
      break;
    }
    chosen.push(best.notable);
    current = best.score;
  }
  const base = evaluate([]);
  if (!(current > base)) {
    return null;
  }
  return { key: 'cluster:' + type.name, kind: 'cluster',
    name: 'Large Cluster Jewel (' + type.name + '): ' + chosen.map(notable => notable.name).join(', '),
    // For drawing the cluster's passives on the tree (public/buildtreeview.js).
    clusterType: type.name, notables: chosen.map(notable => notable.name), smallEffects: type.small || [],
    effects: mergeEffects([smalls, ...chosen.map(entry => entry.effects)]), points: LARGE_CLUSTER_POINTS,
    gain: current / base - 1 };
}

// ---------- gear presets ----------
// A finished build at another gear preset (budget: three tiers below the best affixes, where the generator plans
// one below). Its tree, the long part, stays: for each weapon tried (options.weapons; its own by default) only the
// passives, masteries and jewels that serve the old weapon and not the new one go (a staff build's staff block), and
// the points they free are planned again from what is left (public/buildtree.js, options.seed). The uniques that
// still fit the weapon stay, supports it can't use go, and the rare gear is solved at the preset. The best-scoring
// weapon's build is returned; null without gear data, a tree or any weapon that works. A build whose block was
// cheap only at the generator's preset can swap its staff for an axe here.
// options.onlyListed tries options.weapons alone, without the build's own weapon (to compare one weapon).
export function gearPresetVariant(build, index, preset, options = {}) {
  if (!index.gear || !index.tree || !build.tree) {
    return null;
  }
  const scoreOf = options.scoreOf || powerScore;
  const engine = gearEngine(scoreOf);
  const weapons = options.onlyListed ? [] : [build.weapon];
  for (const weapon of options.weapons || []) {
    if (!weapons.includes(weapon)) {
      weapons.push(weapon);
    }
  }
  let best = null;
  let bestScore = -Infinity;
  for (const weapon of weapons) {
    let candidate = withWeaponSwapped(build, weapon, index, scoreOf);
    if (candidate === null) {
      continue;
    }
    if (weapon !== build.weapon) {
      candidate = { ...candidate, tree: reseededTree(build, candidate, index, options) };
    }
    candidate = solveGear({ ...candidate, gear: undefined }, index.gear, engine, preset);
    candidate = dropUniquesRaresBeat(candidate, index, scoreOf, preset);
    const score = scoreOf(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// The build holding another weapon: the uniques that still fit it (in order, each against those kept before it),
// the supports it can still use (refilled when one had to go), no solved gear. null when a unique that must stay
// (the one granting the skill) doesn't fit.
function withWeaponSwapped(build, weapon, index, scoreOf) {
  if (weapon === build.weapon) {
    return { ...build };
  }
  let current = { ...build, weapon, uniques: [], gear: undefined };
  for (const unique of build.uniques) {
    if (uniqueAllowed(current, unique)) {
      current = { ...current, uniques: [...current.uniques, unique] };
    } else if (isKeptUnique(build, unique)) {
      return null;
    }
  }
  const family = weaponFamilyOf(weapon);
  const supports = current.supports.filter(entry => entry.support.weapons.length === 0 || entry.support.weapons.includes(family));
  if (supports.length < current.supports.length) {
    current = refineSupports({ ...current, supports }, index, scoreOf);
  }
  return current;
}

// The old build's tree planned again for the new one: what served only the old weapon taken out, the rest kept as
// the seed, the freed points planned with the new build's own scoring.
function reseededTree(oldBuild, newBuild, index, options) {
  const oldContext = contextOf(oldBuild);
  const newContext = contextOf({ ...newBuild, tree: null });
  const servesOldWeaponOnly = effects => (effects || []).some(effect => effectReaches(effect, oldContext) && !effectReaches(effect, newContext));
  const oldTree = oldBuild.tree;
  const nodes = oldTree.nodes.filter(id => {
    const node = index.tree.nodes.get(id);
    return node && !servesOldWeaponOnly(node.effects);
  });
  const masteries = [];
  for (const taken of oldTree.masteries || []) {
    const mastery = index.tree.masteries.find(entry => entry.id === taken.id);
    const option = mastery ? mastery.options.find(entry => entry.text === taken.text) : null;
    if (option && !servesOldWeaponOnly(option.effects)) {
      masteries.push(taken);
    }
  }
  const jewels = (oldTree.jewels || []).filter(entry => !(entry.kind === 'cluster' && servesOldWeaponOnly(entry.smallEffects)));
  const seed = { nodes, masteries, jewels };
  return planTreeFor({ ...newBuild, tree: null }, newBuild.ascendancy.baseClass, index, { ...treeOptionsOf(options), seed });
}

// Plans the finished build's tree again with everything else in place: what the generator stores and what the
// page shows when a card is opened, so both always agree.
// options.scoreOf and options.wide as for composeForAscendancy.
export function finalizeTree(build, index, options = {}) {
  if (!index.tree) {
    return build;
  }
  const withoutTree = { ...build, tree: null };
  const treeOptions = { ...treeOptionsOf(options), tryWithoutKeystones: true };
  const tree = planTreeFor(withoutTree, build.ascendancy.baseClass, index, treeOptions);
  const planned = { ...build, tree };
  const scoreOf = options.scoreOf || powerScore;
  const replan = withBuffs => ({ ...withBuffs, tree: planTreeFor({ ...withBuffs, tree: null }, build.ascendancy.baseClass, index, treeOptions) });
  let best = planned;
  // The tree can lower the skill's cost or raise its mana upkeep, which leaves mana for another aura: the buffs are
  // chosen again, and when they changed the tree is planned once more for them.
  const rebalanced = rebalancedBuffs(planned, index, scoreOf);
  if (rebalanced !== planned) {
    best = betterOf(rebalanced, replan(rebalanced), scoreOf);
  }
  // Balancing the other way: the buffs the build would run if its skill cost nothing, with a tree planned for them,
  // which then buys the cost efficiency and mana regeneration that pay for the skill beside them. An aura that
  // starves the skill on its own can be worth it with the tree behind it.
  const ambitious = addBestBuffs({ ...planned, buffs: [], upkeepWaived: true }, index, scoreOf);
  if (!sameBuffs(ambitious.buffs, best.buffs)) {
    best = betterOf(best, replan({ ...ambitious, upkeepWaived: false }), scoreOf);
  }
  // Dance with Death is refused without immunity to enemy crits, and the guardian that gives it is worth nothing on
  // its own, so neither would be found one at a time: a crit build tries the guardian and a tree planned beside it.
  const guarded = withGuardian(best, index);
  if (guarded) {
    best = betterOf(best, replan(guarded), scoreOf);
  }
  // A build that already has a tree keeps it when planning again finds nothing better. The greedy planner can miss a
  // tree it kept before: the rebalanced buffs above may keep the tree planned for the old buffs because it scores
  // higher than the one planned for them, and planning again from scratch can't find its way back to it.
  if (build.tree) {
    best = betterOf(build, best, scoreOf);
  }
  return best;
}

// The build with the Animated Guardian among its buffs (taking the last buff's place when the sockets are full), or
// null: not a crit build, already immune, or no guardian in the data.
function withGuardian(build, index) {
  const guardian = (index.buffs || []).find(buff => buff.kind === 'guardian');
  if (!guardian || (build.buffs || []).some(buff => buff.kind === 'guardian')) {
    return null;
  }
  const context = contextOf(build);
  if (critImmune(context.flags) || !evaluateBuild(build).critChance) {
    return null;
  }
  let buffs = [...(build.buffs || [])];
  while (buffs.length > 0 && !buffAllowed({ ...build, buffs }, guardian)) {
    buffs = buffs.slice(0, -1);
  }
  if (!buffAllowed({ ...build, buffs }, guardian)) {
    return null;
  }
  return { ...build, buffs: [...buffs, guardian] };
}

function betterOf(first, second, scoreOf) {
  return scoreOf(second) > scoreOf(first) ? second : first;
}

function sameBuffs(first, second) {
  const names = buffs => buffs.map(buff => buff.name).sort().join('|');
  return names(first || []) === names(second || []);
}

// Whether an effect can change this build's score at all: it reaches the skill, or it defends the character, or it
// helps clear. The tree planner skips the rest without measuring them.
export function effectMattersFor(build) {
  const context = contextOf(build);
  const branch = { crit: true, critChance: 0.5 };
  return effect => {
    if ((effect.subject || 'self') === 'self' && DEFENCE_STATS.has(effect.stat)) {
      return true;
    }
    if (effect.kind === 'flag') {
      return true;
    }
    return effectWeight(effect, context, branch) > 0;
  };
}

// What an ascendancy or bloodline notable costs in ascendancy points. A borrowing ascendancy's notables (Ascendant,
// Reliquarian) cost four, so its eight points still buy two of them.
function notablePoints(notable, ascendancy) {
  if (notable.bloodline) {
    return notable.points || ASCENDANCY_NOTABLE_POINTS;
  }
  return ASCENDANCY_POINTS / notableLimitOf(ascendancy);
}

// The notables a build can take: its ascendancy's and every bloodline's.
function notableCandidates(build, index) {
  return [...build.ascendancy.notables, ...(index.bloodlineNotables || [])];
}

// Within the eight points, and bloodline notables from one bloodline only.
function notableAllowed(build, candidate) {
  let points = notablePoints(candidate, build.ascendancy);
  for (const chosen of build.notables) {
    points += notablePoints(chosen, build.ascendancy);
    if (candidate.bloodline && chosen.bloodline && chosen.bloodline !== candidate.bloodline) {
      return false;
    }
  }
  return points <= ASCENDANCY_POINTS;
}

// The bloodline a build's notables come from, or null.
export function bloodlineOf(build) {
  const chosen = build.notables.find(notable => notable.bloodline);
  return chosen ? chosen.bloodline : null;
}

function notableLimitOf(ascendancy) {
  if (ascendancy.notables.length > BORROWING_ASCENDANCY_NOTABLE_COUNT) {
    return BORROWING_ASCENDANCY_MAX_NOTABLES;
  }
  return MAX_ASCENDANCY_NOTABLES;
}

// Drops the two supports picked last and refills, keeping whichever set scores higher. Seeded supports (the
// planner's playstyle limit) come first and are never among the two dropped.
function refineSupports(build, index, scoreOf = powerScore, seedSupports = []) {
  if (build.supports.length < 3 || build.supports.length - 2 < seedSupports.length) {
    return build;
  }
  const trimmed = { ...build, supports: build.supports.slice(0, build.supports.length - 2) };
  const refilled = addBest(trimmed, 'supports', current => supportCandidates(current, index), MAX_SUPPORTS, supportEntry, null, scoreOf);
  if (scoreOf(refilled) > scoreOf(build)) {
    return refilled;
  }
  return build;
}

// ---------- a build stored by name ----------
// What scripts/generate_builds.mjs keeps of a build, and what the build planner sends from its worker: names only.
// The page looks the pieces up in the mechanics file and works out with the same engine why each is there, when a
// card is opened.
export function compactBuild(build, evaluation) {
  const supports = [];
  for (const entry of linkedSupports(build)) {
    supports.push(entry.support.name);
  }
  const names = list => list.map(piece => piece.name);
  const reserved = reservedPercentOf(build, build.buffs || []);
  const stored = {
    ascendancy: build.ascendancy.name, baseClass: build.ascendancy.baseClass, skill: build.skill.name,
    weapon: build.weapon, score: roundTo(evaluation.score, 3), scaling: roundTo(evaluation.scaling, 2),
    defence: roundTo(evaluation.defence, 3), ehp: Math.round(evaluation.ehp), dps: evaluation.dps ? Math.round(evaluation.dps) : null, clear: roundTo(evaluation.clear, 3), crit: evaluation.crit,
    supports, notables: names(build.notables), bloodline: bloodlineOf(build), keystones: names(build.keystones), uniques: names(build.uniques),
    buffs: names(build.buffs || []), flasks: names(build.flasks || []),
    // The shares of mana and of life its buffs reserve, after reservation efficiency.
    reserved: roundTo(reserved.mana, 1),
    reservedLife: roundTo(reserved.life, 1),
  };
  // And the flat amounts (Precision, Vitality, Clarity), when there are any.
  if (reserved.manaFlat > 0) {
    stored.reservedManaFlat = Math.round(reserved.manaFlat);
  }
  if (reserved.lifeFlat > 0) {
    stored.reservedLifeFlat = Math.round(reserved.lifeFlat);
  }
  if (build.gear) {
    stored.gear = compactGear(wornGear(build));
  }
  if (evaluation.sheet) {
    stored.sheet = evaluation.sheet;
  }
  // Paying for the main skill (manaUpkeepOf): a use's cost and what pays it, mana spent and regained per second, and
  // the share of a fight it keeps casting.
  const upkeep = evaluation.upkeep;
  if (upkeep && upkeep.costPerUse > 0) {
    stored.upkeep = { cost: Math.round(upkeep.costPerUse), paidWith: upkeep.paidWith, spent: Math.round(upkeep.spentPerSecond),
      regained: Math.round(upkeep.regainedPerSecond), share: roundTo(upkeep.share, 2) };
  }
  if (build.stacking) {
    stored.stacking = build.stacking;
  }
  const cost = costOf(build);
  if (cost !== null) {
    stored.cost = roundTo(cost, 1);
  }
  if (build.tree) {
    // The tree's own node list isn't stored: the page plans it again (finalizeTree) when a card is opened.
    stored.keystones = [...build.tree.keystones];
    stored.treeNotables = [...build.tree.notables];
    stored.treePoints = build.tree.points;
    stored.treeMasteries = masteryLines(build.tree.masteries);
    stored.treeJewels = (build.tree.jewels || []).map(jewel => jewel.name);
  }
  return stored;
}

function roundTo(value, places) {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

// Each chosen mastery as "Life Mastery: +50 to maximum Life", its lines joined when an option has several.
function masteryLines(masteries) {
  const lines = [];
  for (const mastery of masteries) {
    lines.push(mastery.name + ': ' + mastery.text.split('\n').join('; '));
  }
  return lines;
}

// ---------- moves for the build planner's stage agents (public/buildstages.js) ----------
// Every build one change away from this one: one piece of a field removed, swapped for a candidate, or a candidate
// added where there is room, within the same rules the composer follows (slots, hands, reservation, one curse,
// supports that still fit). lists.uniques are the unique candidates (the plan's shortlist); notables come from the
// build's ascendancy, auras and flasks from the index. Supports named in locked (the playstyle limit) never move.
// The tree stays as it is: it is planned again after the agents are done.
export function moveCandidates(build, index, lists = {}, locked = []) {
  const moves = [];
  const fields = [
    { field: 'supports', limit: MAX_SUPPORTS },
    { field: 'notables', limit: ASCENDANCY_POINTS, candidates: () => notableCandidates(build, index), isAllowed: notableAllowed },
    { field: 'uniques', limit: uniqueLimitOf(build), candidates: () => lists.uniques || [], isAllowed: uniqueAllowed },
    { field: 'buffs', limit: MAX_BUFFS, candidates: () => index.buffs, isAllowed: buffAllowed },
    { field: 'flasks', limit: UTILITY_FLASK_SLOTS, candidates: () => index.flasks, isAllowed: flaskAllowed },
  ];
  for (const spec of fields) {
    addMovesOfField(moves, build, index, spec, locked);
  }
  return moves;
}

function nameOfEntry(entry) {
  return entry.support ? entry.support.name : entry.name;
}

function addMovesOfField(moves, build, index, spec, locked) {
  const field = spec.field;
  const chosen = build[field] || [];
  for (let position = 0; position < chosen.length; position += 1) {
    const removedName = nameOfEntry(chosen[position]);
    if (field === 'supports' && locked.includes(removedName)) {
      continue;
    }
    // The unique that grants the main skill stays (without it there is no skill), and so does a required one.
    if (field === 'uniques' && isKeptUnique(build, chosen[position])) {
      continue;
    }
    const without = { ...build, [field]: [...chosen.slice(0, position), ...chosen.slice(position + 1)] };
    if (field !== 'supports' || supportsAllFit(without, index)) {
      moves.push({ field, removed: removedName, added: null, build: without });
    }
    for (const trial of trialsWithOneMore(without, index, spec)) {
      if (trial.name === removedName) {
        continue;
      }
      if (field === 'supports' && !supportsAllFit(trial.build, index)) {
        continue;
      }
      moves.push({ field, removed: removedName, added: trial.name, build: trial.build });
    }
  }
  if (chosen.length < spec.limit) {
    for (const trial of trialsWithOneMore(build, index, spec)) {
      moves.push({ field, removed: null, added: trial.name, build: trial.build });
    }
  }
}

// The builds with one more piece in the field, each a candidate the rules allow.
function trialsWithOneMore(build, index, spec) {
  const trials = [];
  if (spec.field === 'supports') {
    for (const candidate of supportCandidates(build, index)) {
      trials.push({ name: candidate.support.name, build: withPiece(build, 'supports', supportEntry(candidate)) });
    }
    return trials;
  }
  for (const candidate of spec.candidates()) {
    if (spec.isAllowed && !spec.isAllowed(build, candidate)) {
      continue;
    }
    if (alreadyIn(build[spec.field], candidate)) {
      continue;
    }
    trials.push({ name: candidate.name, build: withPiece(build, spec.field, candidate) });
  }
  return trials;
}

// Whether every support still fits once the others are in place: taking out Spell Totem leaves Multiple Totems with
// nothing to support.
function supportsAllFit(build, index) {
  for (let position = 0; position < build.supports.length; position += 1) {
    const others = [];
    for (let other = 0; other < build.supports.length; other += 1) {
      if (other !== position) {
        others.push(build.supports[other].support);
      }
    }
    const support = findByName(index.supports, build.supports[position].support.name);
    if (!support) {
      return false;
    }
    const types = typesWithSupports(build.skill, others);
    if (supportFits(support, types, new Set(build.skill.minionTypes), true) === null) {
      return false;
    }
  }
  return true;
}

// One build for a skill and ascendancy (both stages), for a single question.
export function bestBuildFor(skill, ascendancy, index, options = {}) {
  return composeForAscendancy(planSkill(skill, index, options), ascendancy, index, options);
}

// A build stored by name (scripts/generate_builds.mjs) back as pieces the engine can evaluate. Returns null
// when the mechanics file no longer has one of its pieces.
// options.scoreOf and options.wide as for composeForAscendancy: the build planner's cards plan their tree by their
// own stage weights.
export function rebuildFromNames(stored, index, options = {}) {
  const skill = findByName(index.skills, stored.skill);
  const ascendancy = findByName(index.ascendancies, stored.ascendancy);
  if (!skill || !ascendancy) {
    return null;
  }
  const build = emptyBuild(skill, ascendancy, stored.weapon, stored.ailment || null);
  if (stored.stacking) {
    build.stacking = stored.stacking; // the commitment it was planned with; its assumed extra is over
  }
  for (const name of stored.supports) {
    const support = findByName(index.supports, name);
    if (!support) {
      return null;
    }
    const chosen = [];
    for (const entry of build.supports) {
      chosen.push(entry.support);
    }
    const via = supportFits(support, typesWithSupports(skill, chosen), new Set(skill.minionTypes), true) || 'skill';
    build.supports.push(supportEntry({ support, via }));
  }
  if (stored.gear && index.gear) {
    build.gear = rebuildGear(stored.gear, index.gear);
  }
  for (const name of stored.notables) {
    const notable = findByName(ascendancy.notables, name) || findByName(index.bloodlineNotables || [], name);
    if (notable) {
      build.notables.push(notable);
    }
  }
  for (const name of stored.keystones) {
    const keystone = findByName(index.keystones, name);
    if (keystone) {
      build.keystones.push(keystone);
    }
  }
  for (const name of stored.uniques) {
    const unique = findByName(index.uniques, name);
    // The unique that grants the skill is already there (emptyBuild).
    if (unique && !alreadyIn(build.uniques, unique)) {
      build.uniques.push(unique);
    }
  }
  for (const name of stored.buffs || []) {
    const buff = findByName(index.buffs, name);
    if (buff) {
      build.buffs.push(buff);
    }
  }
  for (const name of stored.flasks || []) {
    const flask = findByName(index.flasks, name);
    if (flask) {
      build.flasks.push(flask);
    }
  }
  // Keystones come with the tree when there is one; the stored names are only for showing.
  if (index.tree) {
    build.keystones = [];
    if (options.plannedTree) {
      return withPlannedTree(build, index, options.plannedTree);
    }
    return finalizeTree(build, index, options);
  }
  return build;
}

// The tree and buffs finalizeTree chose for a rebuilt build, as plain data a worker can send (public/build-worker.js
// plans them off the page's thread, which takes seconds). Given back as options.plannedTree, they make the same build
// without planning again.
export function plannedTreeOf(build) {
  const buffs = [];
  for (const buff of build.buffs) {
    buffs.push(buff.name);
  }
  return { tree: build.tree, buffs };
}

function withPlannedTree(build, index, plannedTree) {
  const buffs = [];
  for (const name of plannedTree.buffs) {
    const buff = findByName(index.buffs, name);
    if (buff) {
      buffs.push(buff);
    }
  }
  return { ...build, buffs, tree: plannedTree.tree };
}

function findByName(list, name) {
  for (const entry of list) {
    if (entry.name === name) {
      return entry;
    }
  }
  return null;
}

// ---------- why each piece is there ----------
// The gain each piece brings: the score with it, divided by the score without it.
export function pieceGains(build) {
  const full = evaluateBuild(build).score;
  const gains = [];
  for (const field of ['supports', 'notables', 'keystones', 'uniques', 'buffs', 'flasks']) {
    for (let position = 0; position < (build[field] || []).length; position += 1) {
      const without = { ...build, [field]: build[field].filter((_, other) => other !== position) };
      const withoutScore = evaluateBuild(without).score;
      const piece = build[field][position];
      const name = field === 'supports' ? piece.support.name : piece.name;
      const effects = field === 'supports' ? piece.support.effects : piece.effects;
      gains.push({ field, name, gain: withoutScore > 0 ? full / withoutScore - 1 : 1, effects: usefulEffects(build, effects) });
    }
  }
  if (build.tree) {
    const withoutTreeScore = evaluateBuild({ ...build, tree: { effects: [] } }).score;
    gains.push({ field: 'tree', name: `Passive tree (${build.tree.points} points)`,
      gain: withoutTreeScore > 0 ? full / withoutTreeScore - 1 : 1, effects: [], keystones: build.tree.keystones, notables: build.tree.notables,
      masteries: build.tree.masteries || [] });
  }
  return gains;
}

function usefulEffects(build, effects) {
  const context = contextOf(build);
  const branch = { crit: true, critChance: 0.5 };
  const useful = [];
  for (const effect of effects) {
    if (effect.kind === 'flag' || effectWeight(effect, context, branch) > 0) {
      useful.push(effect);
    }
  }
  return useful;
}

// Our own short wording of an effect, for the cards.
export function describeEffect(effect) {
  const value = effect.value === undefined || effect.value === null ? '' : formatNumber(Math.abs(effect.value));
  const scope = describeScope(effect);
  const condition = effect.condition ? ` (${describeCondition(effect.condition)})` : '';
  const negative = effect.value < 0;
  if (effect.kind === 'more') {
    return `${value}% ${negative ? 'less' : 'more'} ${describeStat(effect.stat)}${scope}${condition}`;
  }
  if (effect.kind === 'increased') {
    return `${value}% ${negative ? 'reduced' : 'increased'} ${describeStat(effect.stat)}${scope}${condition}`;
  }
  if (effect.kind === 'level') {
    return `+${value} to the level of${scope || ' all'} gems${condition}`;
  }
  if (effect.kind === 'penetration') {
    return `penetrates ${value}%${scope} resistance${condition}`;
  }
  if (effect.kind === 'exposure' || (effect.kind === 'resistance' && effect.subject === 'enemy')) {
    return `enemies get -${value}%${scope} resistance${condition}`;
  }
  if (effect.kind === 'added') {
    return `adds about ${value}${scope} damage${condition}`;
  }
  if (effect.kind === 'conversion') {
    return `converts ${value}% of ${(effect.from || []).join('/')} damage to${scope}${condition}`;
  }
  if (effect.kind === 'extra') {
    return `${value}% of ${(effect.from || ['its']).join('/')} damage added as extra${scope}${condition}`;
  }
  if (effect.kind === 'limit') {
    return `+${value} maximum ${describeStat(effect.stat)}${condition}`;
  }
  if (effect.kind === 'flag') {
    return describeFlag(effect.stat);
  }
  if (effect.kind === 'socketedSupport') {
    return `gems in it are supported by ${effect.stat}`;
  }
  if (effect.kind === 'chance') {
    return `${value}% chance to ${describeStat(effect.stat)}${condition}`;
  }
  return `${value ? (negative ? '-' : '+') + value + ' ' : ''}${describeStat(effect.stat)}${scope}${condition}`;
}

function formatNumber(number) {
  if (Number.isInteger(number)) {
    return String(number);
  }
  return number.toFixed(1).replace(/\.0$/, '');
}

function describeScope(effect) {
  if (!effect.tags || effect.tags.length === 0) {
    return '';
  }
  return ' (' + effect.tags.join(', ') + ')';
}

const STAT_WORDS = {
  damage: 'damage', castSpeed: 'cast speed', attackSpeed: 'attack speed', speed: 'attack and cast speed',
  critChance: 'critical strike chance', critMulti: 'critical strike multiplier', baseCrit: 'base critical strike chance',
  dotMulti: 'damage over time multiplier', ailmentSpeed: 'ailment damage speed', area: 'area of effect',
  life: 'maximum life', energyShield: 'energy shield', armour: 'armour', evasion: 'evasion', block: 'block chance',
  spellBlock: 'spell block chance', suppress: 'spell suppression', damageTakenLess: 'less damage taken',
  maxResistance: 'maximum resistances', totems: 'totems', minions: 'minions', projectiles: 'projectiles',
  chains: 'chains', pierce: 'pierces', lifeRegen: 'life regeneration', leech: 'leech', recoup: 'life recoup',
  physicalReduction: 'physical damage reduction', elementalReduction: 'elemental damage reduction',
  gemLevel: 'gem levels', resistance: 'resistances', accuracy: 'accuracy rating', movementSpeed: 'movement speed', duration: 'skill duration',
};

function describeStat(stat) {
  if (STAT_WORDS[stat]) {
    return STAT_WORDS[stat];
  }
  if (stat.startsWith('effect:')) {
    return 'effect of ' + stat.slice(7).replace(/([A-Z])/g, ' $1').toLowerCase();
  }
  return stat.replace(/([A-Z])/g, ' $1').toLowerCase();
}

const CONDITION_WORDS = {
  perStack: 'per charge or stack', impale: 'when you impale', perEnduranceCharge: 'per endurance charge', fortificationAbove20: 'per Fortification above 20',
  recentKill: 'after a recent kill', onKill: 'on kill', recentCrit: 'after a recent crit',
  accuracyAboveLife: 'while accuracy is higher than maximum life',
  onCrit: 'on critical strikes', nonCrit: 'with non-critical strikes', lowLife: 'on low life', fullLife: 'on full life',
  flask: 'during a flask', rareOrUnique: 'against rare and unique enemies', enemyShocked: 'against shocked enemies',
  enemyChilled: 'against chilled enemies', enemyIgnited: 'against ignited enemies', arcaneSurge: 'with Arcane Surge',
  totem: 'with a totem out', channel: 'while channelling', nearby: 'near enemies', periodic: 'some of the time',
  frenzyCharges: 'per frenzy charge', powerCharges: 'per power charge', enduranceCharges: 'per endurance charge',
  other: 'under a condition',
};

function describeCondition(condition) {
  if (condition.startsWith(AFFECTED_BY)) {
    return 'while affected by ' + condition.slice(AFFECTED_BY.length);
  }
  return CONDITION_WORDS[condition] || condition.replace(/([A-Z])/g, ' $1').toLowerCase();
}

const FLAG_WORDS = {
  elementalOverload: 'big elemental damage boost after any crit, but crits do no extra damage',
  noCritDamage: 'critical strikes deal no extra damage', neverCrit: 'never crits', neverMiss: 'attacks never miss',
  chaosInoculation: 'immune to chaos damage, life fixed at 1', mindOverMatter: 'part of the damage taken comes from mana',
  pureElement: 'only one element can deal damage', noSelfDamage: 'you deal no damage yourself; totems and minions do',
  battlemage: 'weapon damage adds to spells', scalesWithMana: 'damage grows with maximum mana',
  lifeCappedAtLowLife: 'life stays at low life (Petrified Blood)', lowerHalfLifeProtected: 'hits below half life lose less at once',
  transfigurationOfMind: 'increased maximum mana also raises damage', transfigurationOfBody: 'increased maximum life also raises attack damage',
  extraTotem: 'one more totem', bloodMagic: 'skills cost life instead of mana', eldritchBattery: 'energy shield pays for mana costs',
  ghostReaver: 'leech energy shield instead of life', zealotsOath: 'life regeneration goes to energy shield',
  ironReflexes: 'evasion becomes armour', acrobatics: 'spell dodge instead of suppression', vaalPact: 'faster leech, no other life recovery',
  crimsonDance: 'bleeds stack up to 8 times', perfectAgony: 'ailments use the crit multiplier',
};

function describeFlag(flag) {
  return FLAG_WORDS[flag] || flag.replace(/([A-Z])/g, ' $1').toLowerCase();
}

// ---------- poe.ninja as the reviewer ----------
// The bands a generated build falls in, by how many characters play its ascendancy and main skill.
export const PLAYER_BANDS = [
  { id: 'untested', label: 'Nobody plays it', max: 0 },
  { id: 'experimental', label: 'A handful try it', max: 9 },
  { id: 'niche', label: 'Working niche', max: 200 },
  { id: 'established', label: 'Established', max: 1000 },
  { id: 'meta', label: 'Meta', max: Infinity },
];

export function bandOf(players) {
  for (const band of PLAYER_BANDS) {
    if (players <= band.max) {
      return band;
    }
  }
  return PLAYER_BANDS[PLAYER_BANDS.length - 1];
}

export function verifyBuild(ascendancyName, skillName, populations) {
  const players = populations?.[ascendancyName]?.[skillName] ?? 0;
  return { players, band: bandOf(players) };
}

// ---------- for the revisit panel (public/buildrevisit.js) ----------
// The gear solver's hooks for a score function (the power score when none is given).
export function gearEngineFor(scoreOf = powerScore) {
  return gearEngine(scoreOf);
}

// Whether a unique can join the build as it stands: its slot has room, the hands allow it, the weapon fits.
export function canAddUnique(build, unique) {
  return uniqueAllowed(build, unique);
}

// Whether this unique can't be swapped out: it gives the build its main skill (Soulwrest), or the build planner was told
// to include it.
export function grantsMainSkill(build, unique) {
  return isKeptUnique(build, unique);
}

// The Divines a unique poe.ninja doesn't list is counted at, wherever a price is needed.
export const UNPRICED_UNIQUE_DIVINES = UNPRICED_DIVINES;
