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
import { prepareGear, solveGear, solveFreedSlots, freesRareSlot, gearEffects, gearRequirements, compactGear, rebuildGear, DEFAULT_GEAR_LEVEL } from './buildgear.js';

// ---------- tuning (each value says what it stands for) ----------
const ENEMY_ELEMENTAL_RESISTANCE = 40; // an endgame map boss or pinnacle-lite enemy
const ENEMY_CHAOS_RESISTANCE = 25;
const BASE_CRIT_MULTIPLIER = 150;
const ATTACK_WEAPON_BASE_CRIT = 6; // a typical endgame weapon base
const MINION_BASE_CRIT = 5;
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
// implicit; rare gear can't roll it). Our estimate: 10%, which with RESERVABLE_PERCENT keeps the 100% of base
// reservation the budget allowed before efficiency was counted.
const RESERVATION_EFFICIENCY_ASSUMED = 10;
// At most this much of the pool is reserved: the rest pays the main skill's costs (our estimate).
const RESERVABLE_PERCENT = 90;
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
const MAX_BUFFS = 4;
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
const TREE_ALLOWANCE = { increased: 190, speed: 20, dotMultiplier: 20, critIncreased: 100, critMultiplier: 40 };
// With rare gear solved affix by affix (public/buildgear.js), the gear figures above shrink to what the solver
// doesn't fill: the weapon's own modifiers on a spell or damage-over-time build, and for crit the power charges a
// crit build keeps (about three, over 100% increased crit; nothing else models them) and the weapon's multiplier.
// The crit part was 50% and +15 at first, which cost Assassin and Deadeye most of their calibration hits.
const SOLVED_GEAR_ALLOWANCE = { increased: 30, speed: 5, dotMultiplier: 5, critIncreased: 100, critMultiplier: 25 };
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
// (the endgame base with the most physical DPS, from the wiki), with a good rare's local modifiers, then everything
// the offence index multiplies. Our estimates of a good endgame rare: 170% increased physical damage, flat physical
// damage (about 32 on a one-handed weapon, half again on a staff or bow), 20% increased attack speed, 20% quality;
// and about 30 more flat attack damage from rings, amulet and gloves.
const RARE_WEAPON_INCREASED_PHYSICAL = 170;
const WEAPON_QUALITY = 20;
const RARE_WEAPON_FLAT_PHYSICAL = 32;
const TWO_HANDED_FLAT_FACTOR = 1.5;
const RARE_WEAPON_ATTACK_SPEED = 20;
const GEAR_ADDED_ATTACK_DAMAGE = 30;
// Jewels in the tree's sockets (planned with the tree, public/buildtree.js). Our estimates: a good rare jewel has
// three useful modifiers (the three that help the build most among the wiki's jewel modifiers, at most two
// prefixes and two suffixes, at their middle roll); a large cluster jewel gives its type's small passive on four
// small passives and its type's three best notables, for 8 points inside it; a build runs at most two of them.
const RARE_JEWEL_MODS = 3;
const LARGE_CLUSTER_SMALLS = 4;
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
// Weapons a skill without weapon rules might be built around. Spells may hold anything; 'none' leaves weapon
// effects out of the picture.
const MELEE_WEAPON_CHOICES = ['sword', 'axe', 'mace', 'claw', 'dagger', 'staff'];
const SPELL_WEAPON_CHOICES = ['none', 'staff', 'wand', 'dagger', 'mace', 'shield'];

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
    if (!slot || unique.effects.length === 0) {
      continue;
    }
    const twoHanded = TWO_HANDED_CATEGORIES.has(unique.category);
    const effects = effectsForMainSkillSlot(unique.effects, slot, twoHanded);
    if (effects.length === 0) {
      continue;
    }
    uniques.push({ ...unique, effects, slot, weapon: WEAPON_OF_CATEGORY[unique.category] || null, twoHanded });
  }
  const keystones = [];
  for (const keystone of mechanics.keystones) {
    if (keystone.cluster || keystone.effects.length === 0) {
      continue;
    }
    keystones.push(keystone);
  }
  const buffs = buffsOf(skills, mechanics.supports || {});
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
  return { skills, supports, ascendancies, bloodlineNotables, uniques, keystones, buffs, flasks, jewelMods, largeClusters, patch: mechanics.patch,
    timeless: timeless.choices, tree, gear: prepareGear(gearData) };
}

// Timeless jewels as jewel choices: one per keystone they can grant ("Lethal Pride: Strength of Blood").
function timelessChoicesOf(timeless) {
  const choices = [];
  for (const jewel of timeless?.jewels || []) {
    for (const keystone of jewel.keystones) {
      choices.push({ key: 'timeless:' + keystone.name, kind: 'timeless', jewel: jewel.name, keystone: keystone.name,
        name: jewel.name + ': ' + keystone.name, effects: keystone.effects, points: 0 });
    }
  }
  return { choices, radius: timeless?.radius || null };
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

function buffsOf(skills, supports) {
  const buffs = [];
  const eternalBlessing = supports['Eternal Blessing Support'] || null;
  for (const skill of skills) {
    if (skill.main || skill.effects.length === 0) {
      continue;
    }
    const isAura = skill.tags.includes('aura');
    const isHerald = skill.tags.includes('herald');
    const isCurse = skill.tags.includes('curse');
    if ((isAura || isHerald) && skill.reservation > 0) {
      const effects = isAura ? withMinionCopies(skill.effects) : skill.effects;
      buffs.push({ name: skill.name, kind: isAura ? 'aura' : 'herald', reservation: skill.reservation,
        attributes: skill.attributes, effects });
      if (isAura && eternalBlessing && blessingCanSupport(skill, eternalBlessing)) {
        buffs.push(eternalBlessingAura(skill, effects, eternalBlessing));
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
    // Bane and Hexblast apply hexes but are damage skills of their own: their lines are about their own damage.
    const dealsDamage = skill.types.includes('Damage') || skill.types.includes('DamageOverTime');
    if (isCurse && !isAura && !dealsDamage) {
      buffs.push({ name: skill.name, kind: 'curse', reservation: 0, attributes: skill.attributes,
        effects: scaledEffects(skill.effects, CURSE_EFFECT_ASSUMED) });
    }
  }
  return buffs;
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
      kept.push({ ...effect, condition: null });
      continue;
    }
    kept.push(effect);
  }
  return kept;
}

// ---------- a build's context: what its skill is and does ----------
// The weapons a skill can be planned with (the build planner's weapon limits pick among them).
export function weaponChoicesOf(skill) {
  return weaponChoicesFor(skill);
}

function weaponChoicesFor(skill) {
  if (skill.weapons.length > 0) {
    return [...skill.weapons];
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
    if (weapon !== build.weapon) {
      tags.delete(weapon);
    }
  }
  addTypeTags(types, tags);
  if (build.weapon && build.weapon !== 'none') {
    tags.add(build.weapon);
    if (build.weapon === 'shield') {
      tags.add('shield');
    }
    if (build.weapon === 'staff' || build.weapon === 'bow') {
      tags.add('twoHand');
    } else if (build.weapon !== 'shield') {
      tags.add('oneHand');
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
      if (effect.kind === 'flag' && appliesToSubject(effect, isMinion, tags)) {
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
        } else if (effect.stat.startsWith('enduranceCharge') || effect.stat === 'minimumEnduranceCharges') {
          hasEnduranceSource = true;
        }
      }
    }
  }
  const buffNames = new Set();
  for (const buff of build.buffs || []) {
    buffNames.add(buff.name);
  }
  const context = { skill, types, tags, isMinion, isDamageOverTime, ailment, flags, buffNames, shares: damageShares(build, skill, isMinion, tags) };
  context.impaleChance = impaleChanceOf(impaleLines, context);
  context.rage = rageOf(rageLines, context);
  // Endurance Charges the build keeps: its maximum when something gives them (as defenceTotals counts them), else 0.
  context.enduranceCharges = hasEnduranceSource ? BASE_ENDURANCE_CHARGES + enduranceMaximum : 0;
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
  const twoHanded = build.weapon === 'staff' || build.weapon === 'bow' || build.uniques.some(unique => unique.twoHanded);
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

// Sockets left for buffs: all of them, less the main skill's links and the utility gems.
function socketsForBuffs(build) {
  let total = 0;
  for (const count of Object.values(socketsOf(build))) {
    total += count;
  }
  return total - (1 + linkedSupports(build).length) - UTILITY_GEMS;
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
  for (const unique of build.uniques) {
    pieces.push({ kind: 'unique', name: unique.name, effects: unique.effects, via: 'self' });
  }
  const buffTerms = (build.buffs || []).length ? buffEffectTermsOf(build) : null;
  for (const buff of build.buffs || []) {
    const scale = buffTerms ? buffEffectScale(buff, buffTerms) : 1;
    const effects = scale === 1 ? buff.effects : scaledEffects(buff.effects, scale);
    pieces.push({ kind: buff.kind, name: buff.name, effects, via: 'self' });
  }
  if (build.tree) {
    pieces.push({ kind: 'tree', name: 'Passive tree', effects: build.tree.effects, via: 'self' });
  }
  if (build.gear) {
    pieces.push({ kind: 'gear', name: 'Rare gear', effects: gearEffects(build.gear), via: 'self' });
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
  const terms = { aura: 0, auraBySkill: new Map(), herald: 0, curse: 0 };
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
  if ((effect.subject || 'self') !== 'self' || effect.condition || effect.kind !== 'increased') {
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
  if (buff.kind === 'aura') {
    increased = terms.aura + (terms.auraBySkill.get(buff.baseName || buff.name) || 0) + (buff.ownAuraEffect || 0);
  } else if (buff.kind === 'herald') {
    increased = terms.herald;
  } else if (buff.kind === 'curse') {
    increased = terms.curse;
  }
  return Math.max(0, 1 + increased / 100);
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
function damageShares(build, skill, isMinion, tags) {
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
      convertShares(shares, effect);
    }
  }
  return shares;
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

// ---------- does an effect reach this build, and how fully ----------
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
    if (!context.tags.has(required)) {
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
    // A minion line about spells or attacks is about what the minions use, not the summoning spell: Zealotry's
    // spell damage doesn't reach a zombie's slam.
    if ((tag === 'spell' || tag === 'attack') && effect.subject === 'minion' && context.isMinion) {
      const minionType = tag === 'spell' ? 'Spell' : 'Attack';
      if (!(context.skill.minionTypes || []).includes(minionType)) {
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
    if (!context.tags.has(tag)) {
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
  return CONSISTENT_CONDITIONS.has(condition) || condition.startsWith(AFFECTED_BY);
}

// "+5 to Level of all Cyclone Gems" names its skill; transfigured versions ("Cyclone of Tumult") count too.
function namesSkill(effectSkill, skillName) {
  const wanted = effectSkill.toLowerCase().replace(/^all /, '').replace(/ gems?$/, '').trim();
  const name = skillName.toLowerCase();
  return name === wanted || name.startsWith(wanted + ' of ');
}

function conditionUptime(condition, context, branch) {
  if (!condition) {
    return 1;
  }
  if (condition.startsWith(AFFECTED_BY)) {
    return affectedByUptime(condition.slice(AFFECTED_BY.length), context);
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
  if (condition === 'enemyShocked' && context.shares.lightning > 0.3) {
    return 0.8;
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
  if (condition === 'lowLife' && context.flags.has('lifeCappedAtLowLife')) {
    return 1;
  }
  if (condition === 'unreservedMana') {
    const unreserved = context.defence ? context.defence.unreservedMana : UNRESERVED_MANA_REFERENCE;
    return Math.min(UNRESERVED_MANA_FACTOR_MAX, unreserved / UNRESERVED_MANA_REFERENCE);
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
  if (stat === 'castSpeed') {
    return context.tags.has('spell') && !context.isMinion;
  }
  if (stat === 'attackSpeed') {
    return context.tags.has('attack') || context.isMinion;
  }
  return false;
}

// The offence index of one branch (crit or not). Returns the index and each piece's contributions for the
// "why" notes.
function offenceOf(build, context, branch) {
  // A build without a planned tree gets the fixed allowance in its place.
  const allowance = build.tree ? null : TREE_ALLOWANCE;
  const gearFigures = build.gear ? SOLVED_GEAR_ALLOWANCE : { increased: GEAR_INCREASED_DAMAGE, speed: GEAR_INCREASED_SPEED,
    dotMultiplier: GEAR_DOT_MULTIPLIER, critIncreased: GEAR_INCREASED_CRIT, critMultiplier: GEAR_CRIT_MULTIPLIER };
  let increased = gearFigures.increased + (allowance ? allowance.increased : 0);
  let more = 1;
  let speedIncreased = gearFigures.speed + (allowance ? allowance.speed : 0);
  let speedMore = 1;
  let critIncreased = branch.crit ? gearFigures.critIncreased + (allowance ? allowance.critIncreased : 0) : 0;
  let critMore = 1;
  let baseCrit = context.isMinion ? MINION_BASE_CRIT : (context.types.has('Attack') ? ATTACK_WEAPON_BASE_CRIT : (context.skill.baseCrit || 5));
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
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      const weight = effectWeight(effect, context, branch);
      if (weight === 0) {
        continue;
      }
      const value = (effect.value || 0) * weight;
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
        levels += value;
      } else if (effect.stat === 'dotMulti') {
        dotMultiplier += value;
      } else if (effect.kind === 'added' && effect.stat === 'damage') {
        added += value;
      } else if (effect.kind === 'extra' && effect.stat === 'damage') {
        extra += value * sourceShare(effect, context);
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
  // Damage over time never crits; only hits (and ailments from crits, a later refinement) gain from it.
  const hits = !(context.isDamageOverTime && !context.types.has('Damage'));
  if (branch.crit && hits) {
    let multiplier = critMultiplier;
    if (context.flags.has('noCritDamage')) {
      multiplier = 100;
    }
    critFactor = 1 + critChance * (multiplier / 100 - 1);
  }
  const hitFactor = context.isDamageOverTime || context.isMinion ? 1 : 1 + Math.min(2, added * (context.skill.effectiveness || 100) / 100 / REFERENCE_HIT_DAMAGE);
  const dotFactor = context.isDamageOverTime || context.ailment ? 1 + dotMultiplier / 100 : 1;
  const levelFactor = 1 + gemLevelGain(context) * levels;
  const speedFactor = context.isDamageOverTime && !context.ailment ? 1 : (1 + speedIncreased / 100) * speedMore;
  const totemFactor = context.tags.has('totem') ? Math.min(MAX_TOTEMS, totems) : 1;
  const resistanceFactor = resistanceFactorOf(context, resistanceDrop);
  const impaleFactor = hits ? impaleFactorOf(context, impale) : 1;
  const defenceBaseFactor = referenceBaseFromDefence > 0 ? Math.max(0.1, baseFromDefence / referenceBaseFromDefence) : 1;
  const value = baseRate(context) * (1 + increased / 100) * more * critFactor * hitFactor * dotFactor * levelFactor
    * speedFactor * totemFactor * resistanceFactor * (1 + extra / 100) * impaleFactor * defenceBaseFactor;
  const sheetFactors = (1 + increased / 100) * more * critFactor * levelFactor * speedFactor * totemFactor * (1 + extra / 100)
    * impaleFactor;
  const dps = attackSheetDps(context, build.weapon, added, sheetFactors);
  return { value: Math.max(value, 0.0001), critChance, dps };
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
    const base = type === 'chaos' ? ENEMY_CHAOS_RESISTANCE : ENEMY_ELEMENTAL_RESISTANCE;
    const resistance = Math.max(-50, base - resistanceDrop[type]);
    factor += share * (100 - resistance) / (100 - base);
  }
  return factor;
}

// Tries the crit and non-crit ways of building the same pieces and keeps the better one.
// The weapon bases by weapon tag (set by prepareMechanics from the mechanics file).
let weaponBases = null;

// An attack's sheet DPS (before enemy resistances, as poe.ninja shows it), from the weapon and the offence index's
// own factors; null for anything that isn't a weapon attack.
function attackSheetDps(context, weapon, added, factors) {
  if (!context.types.has('Attack') || context.isMinion || !weaponBases) {
    return null;
  }
  const base = weaponBases[weapon];
  if (!base) {
    return null;
  }
  const twoHanded = weapon === 'staff' || weapon === 'bow';
  const flat = RARE_WEAPON_FLAT_PHYSICAL * (twoHanded ? TWO_HANDED_FLAT_FACTOR : 1);
  const weaponHit = ((base.physicalMin + base.physicalMax) / 2 + flat) * (1 + (RARE_WEAPON_INCREASED_PHYSICAL + WEAPON_QUALITY) / 100);
  const attacksPerSecond = base.attackSpeed * (1 + RARE_WEAPON_ATTACK_SPEED / 100) * (context.skill.attackSpeedMultiplier || 100) / 100;
  const hit = (weaponHit + added + GEAR_ADDED_ATTACK_DAMAGE) * (context.skill.effectiveness || 100) / 100;
  return hit * attacksPerSecond * factors;
}

function bestOffence(build, context) {
  if (context.flags.has('neverCrit') || context.flags.has('noCritDamage')) {
    const plain = offenceOf(build, context, { crit: false, critChance: 0.1 });
    const elementalOverloadProbe = offenceOf(build, context, { crit: false, critChance: plain.critChance });
    return { value: elementalOverloadProbe.value, crit: false, critChance: plain.critChance, dps: elementalOverloadProbe.dps };
  }
  const probe = offenceOf(build, context, { crit: true, critChance: 0.3 });
  const crit = offenceOf(build, context, { crit: true, critChance: probe.critChance });
  const plain = offenceOf(build, context, { crit: false, critChance: probe.critChance });
  if (crit.value > plain.value) {
    return { value: crit.value, crit: true, critChance: crit.critChance, dps: crit.dps };
  }
  return { value: plain.value, crit: false, critChance: plain.critChance, dps: plain.dps };
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
// Maximum mana: a level 92 character has 34 + 6 a level, and 1 more for each 2 intelligence. With the fixed gear
// figures, rare gear adds GEAR_MANA (a few mana rolls); solved gear adds its own lines.
const CHARACTER_MANA = 34 + 6 * 92;
const MANA_PER_INTELLIGENCE = 0.5;
const GEAR_MANA = 150;
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
// Recoup returns over 4 seconds, so against a burst only part of it is back in time: three quarters of it counts,
// and it can at most double the pool (our estimate; 90% recoup is strong, but it doesn't make you take a tenth).
const RECOUP_WITHIN_WINDOW = 0.75;
const RECOUP_MAX_SHARE = 0.5;
const HITS_PER_SECOND = 3; // for "life gained on hit"
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
const CONSISTENT_CONDITIONS = new Set(['perStack', 'nearby', 'rareOrUnique', 'recentSkill', 'recentSpell', 'fortify',
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
const DEFENCE_STATS = new Set(['mana', 'frostShieldPool', 'selfBurnLife', 'selfBurnEnergyShield', 'life', 'energyShield', 'armour', 'evasion', 'defences', 'block', 'spellBlock', 'suppress',
  'suppressPrevent', 'damageTakenLess', 'physicalReduction', 'elementalReduction', 'maxResistance', 'recoup', 'lifeRegen',
  'lifeRegenFlat', 'esRegen', 'esRegenFlat', 'leech', 'onHitRecovery', 'maxBlock', 'maxSpellBlock', 'lifeToEnergyShield', 'lifeConvertedToEnergyShield',
  'damageTaken', 'manaToEnergyShield', 'resistance', 'shieldDefences', 'enduranceCharge', 'enduranceCharges',
  'enduranceChargeGenerator', 'minimumEnduranceCharges', 'esRecharge', 'esRechargeStart', 'flaskRecovery']);
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
    lifeRegenPercent: 0, lifeRegenFlat: 0, esRegenPercent: 0, esRegenFlat: 0, leech: 0, recoup: 0, onHit: 0,
    lifeAsEnergyShield: 0, lifeConvertedToEnergyShield: 0, manaAsEnergyShield: 0, shieldDefences: 0, enduranceSource: false, enduranceMaximum: 0,
    esRecharge: { increased: 0, more: 1 }, esRechargeStart: 0, flaskRecovery: 0,
    selfBurnLife: 0, selfBurnEnergyShield: 0, overcappedFire: 0, frostShieldPool: 0,
  };
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      if ((effect.subject || 'self') !== 'self' || !DEFENCE_STATS.has(effect.stat) || effect.kind === 'penetration') {
        continue;
      }
      if (effect.stat === 'enduranceCharges' && effect.kind === 'limit') {
        totals.enduranceMaximum += effect.value || 0;
        continue;
      }
      if (effect.stat.startsWith('enduranceCharge') || effect.stat === 'minimumEnduranceCharges') {
        totals.enduranceSource = true;
        continue;
      }
      if (!(effect.requires || []).every(required => context.tags.has(required))) {
        continue;
      }
      let amount = (effect.value || 0) * conditionUptime(effect.condition, context, { crit: false, critChance: 0 });
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
    leech: 'leech', recoup: 'recoup', onHitRecovery: 'onHit', lifeToEnergyShield: 'lifeAsEnergyShield', lifeConvertedToEnergyShield: 'lifeConvertedToEnergyShield',
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
  if (stat === 'flaskRecovery') {
    if (effect.kind === 'increased') {
      totals.flaskRecovery += amount;
    }
    return;
  }
  if (stat === 'selfBurnLife' || stat === 'selfBurnEnergyShield' || stat === 'frostShieldPool') {
    totals[stat] += amount;
    return;
  }
  if (stat === 'lifeRegen') {
    if (effect.kind === 'flat') {
      totals.lifeRegenPercent += amount;
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
  for (const [type, share] of Object.entries(HIT_SHARES)) {
    const taken = mitigated[type] * totals.takenMultiplier[type] * Math.max(0, 1 + totals.takenIncreased[type] / 100);
    hitTaken += share * Math.max(0, taken);
  }
  const hitChance = flags.has('noEvasion') || evasion <= 0
    ? 1
    : Math.min(1, Math.max(0.05, 1.25 * MONSTER_ACCURACY / (MONSTER_ACCURACY + Math.pow(evasion / 5, 0.9))));
  const shieldBlock = weapon === 'shield' ? SHIELD_BLOCK * (1 + totals.shieldDefences / 100) : 0;
  const block = Math.min(75 + totals.maxBlock, totals.block + shieldBlock) / 100;
  const spellBlock = Math.min(75 + totals.maxSpellBlock, totals.spellBlock) / 100;
  const suppressChance = Math.min(100, totals.suppress) / 100;
  const suppressed = Math.pow(suppressChance, SUPPRESSION_CONSISTENCY_POWER) * Math.min(100, totals.suppressPrevent) / 100;
  const attackTaken = hitChance * (1 - block) * totals.takenAttackMultiplier;
  const spellTaken = (1 - spellBlock) * (1 - suppressed);
  return Math.max(0.005, hitTaken * (ATTACK_SHARE * attackTaken + (1 - ATTACK_SHARE) * spellTaken));
}

// Effective HP for one gear choice: ('life' or 'es' gear, and how a life build's defence rating splits between
// armour and evasion).
function effectiveHp(totals, flags, context, weapon, reservation, gear) {
  const gearScale = flags.has('noHelmet') ? 0.85 : 1;
  const lifeGear = gear.pool === 'life' ? GEAR_LIFE * gearScale : 0; // 'solved': the items' own lines instead
  const esGear = gear.pool === 'es' ? GEAR_ENERGY_SHIELD * gearScale : 0;
  let life = flags.has('chaosInoculation') ? 1 : scaled(totals.life, CHARACTER_LIFE + lifeGear) + stackedExtra(reservation, 'life');
  // Blood Magic removes mana. Reserved life (Blood Magic's buffs, Petrified Blood) isn't there to take hits.
  const mana = flags.has('bloodMagic') ? 0 : scaled(totals.mana, reservation.baseMana + (gear.pool === 'solved' ? 0 : GEAR_MANA)) + stackedExtra(reservation, 'mana');
  const maximumLife = life;
  life *= Math.max(0.1, 1 - reservation.life / 100);
  life = petrifiedBloodLife(life, maximumLife, flags);
  const unreservedMana = mana * Math.max(0, 1 - reservation.mana / 100);
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
  let pool = life + energyShield;
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
  const leechRate = hitsEnemies ? Math.min(MAX_LEECH_RATE, totals.leech * LEECH_RATE_PER_PERCENT) : 0;
  const lifeRegen = flags.has('vaalPact') ? 0 : life * totals.lifeRegenPercent / 100 + totals.lifeRegenFlat;
  const lifeFlask = lifeFlaskBase && !flags.has('chaosInoculation') && !flags.has('vaalPact')
    ? lifeFlaskBase.life / lifeFlaskBase.duration * (1 + totals.flaskRecovery / 100)
    : 0;
  const recoveryPerSecond = lifeRegen + life * leechRate / 100 + (hitsEnemies ? totals.onHit * HITS_PER_SECOND : 0)
    + lifeFlask + esRechargePerSecond(totals, flags, energyShield, life)
    + (flags.has('noEsRecharge') ? 0 : energyShield * totals.esRegenPercent / 100 + totals.esRegenFlat);
  // A self-burn (Righteous Fire) comes out of the recovery; burning faster than it recovers drains the pool, though
  // never below a tenth of it, which is the build only just keeping RF up.
  const netRecovery = recoveryPerSecond - selfBurnPerSecond(totals, flags, life, energyShield);
  pool = Math.max((life + energyShield) * 0.1, pool + netRecovery * RECOVERY_SECONDS);
  const taken = shareTaken(totals, flags, armour, evasion, weapon);
  const recoup = Math.min(RECOUP_MAX_SHARE, Math.min(100, totals.recoup) / 100 * RECOUP_WITHIN_WINDOW);
  const standingPool = life + energyShield;
  const readyShare = Math.min(1, Math.max(life / READY_LIFE, energyShield / READY_ENERGY_SHIELD));
  const readiness = Math.pow(readyShare, 2);
  // Reported apart for the build planner's EHP stage: the largest hit the standing pool takes (no recovery, the
  // same life floor) and what comes back in a second.
  const maxHit = standingPool / taken * readiness;
  return { ehp: pool / (taken * Math.max(0.1, 1 - recoup)) * readiness, pool: standingPool, life, energyShield,
    armour, evasion, overcappedFire: totals.overcappedFire, maxHit, recovery: netRecovery, mana, unreservedMana };
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
  const reservation = { mana: reserved.mana, life: reserved.life,
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
    mana: best.mana, unreservedMana: best.unreservedMana };
}

// ---------- reservation ----------
// The reservation efficiency that applies to one buff: the assumed share, plus every line of the build's pieces
// (not the buffs themselves) whose tags the buff has; a line naming heralds applies to heralds only. Lines under a
// condition aren't counted (Bubonic Trail's, Mask of the Tribunal's per attributes).
function reservationEfficiencyFor(build, buff) {
  let efficiency = RESERVATION_EFFICIENCY_ASSUMED;
  for (const piece of piecesOf(build)) {
    if (piece.kind === 'aura' || piece.kind === 'herald' || piece.kind === 'self' || piece.kind === 'curse') {
      continue;
    }
    for (const effect of piece.effects) {
      if (effect.stat !== 'reservation' || effect.kind !== 'increased' || effect.condition) {
        continue;
      }
      if ((effect.subject || 'self') !== 'self') {
        continue;
      }
      if ((effect.tags || []).every(tag => tag === buff.kind)) {
        efficiency += effect.value || 0;
      }
    }
  }
  return Math.max(RESERVATION_EFFICIENCY_FLOOR, efficiency);
}

// The shares of mana and of life these buffs reserve, after efficiency.
function reservedPercentOf(build, buffs) {
  const reserved = { mana: 0, life: 0 };
  const bloodMagic = hasBloodMagic(build);
  for (const buff of buffs) {
    if (!buff.reservation) {
      continue;
    }
    const share = buff.reservation * 100 / (100 + reservationEfficiencyFor(build, buff));
    if (buff.reservesLife || bloodMagic) {
      reserved.life += share;
    } else {
      reserved.mana += share;
    }
  }
  return reserved;
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
      if (build.weapon !== 'none' && unique.weapon && unique.weapon !== build.weapon) {
        problems.push(`${unique.name} is a ${unique.category}, not the ${build.weapon} the build uses`);
      }
    }
    if (unique.slot === 'offhand' && unique.category === 'Shield' && build.weapon && ['staff', 'bow'].includes(build.weapon)) {
      problems.push(`${unique.name} needs a free off-hand`);
    }
    if (unique.slot === 'offhand' && unique.category === 'Quiver' && build.weapon !== 'bow') {
      problems.push(`${unique.name} is a quiver, for bow builds`);
    }
  }
  for (const entry of build.supports) {
    if (entry.support.weapons.length > 0 && !entry.support.weapons.includes(build.weapon)) {
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
    for (const [attribute, amount] of Object.entries(gearRequirements(build.gear))) {
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

function bareOffence(build) {
  const key = build.skill.name + '|' + build.weapon + '|' + (build.ailment || '');
  if (bareOffenceCache.has(key)) {
    return bareOffenceCache.get(key);
  }
  const bare = { skill: build.skill, ascendancy: NO_ASCENDANCY, weapon: build.weapon, ailment: build.ailment,
    supports: [], notables: [], keystones: [], uniques: [], buffs: [], flasks: [] };
  const value = bestOffence(bare, contextOf(bare)).value;
  bareOffenceCache.set(key, value);
  return value;
}

export function evaluateBuild(build) {
  const context = contextOf(build);
  // Defences first: lines that turn a defence into damage (perDefence: Righteous Fire, Ephemeral Edge, Dreamfeather)
  // read the build's own life, energy shield, armour and evasion.
  const defenceResult = defenceOf(build, context);
  context.defence = { life: defenceResult.life, energyShield: defenceResult.energyShield, armour: defenceResult.armour,
    evasion: defenceResult.evasion, overcappedFire: defenceResult.overcappedFire, mana: defenceResult.mana,
    unreservedMana: defenceResult.unreservedMana };
  const offence = bestOffence(build, context);
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
    critChance: offence.critChance, problems, tags: [...context.tags].sort(), shares: context.shares,
    attributes, maxHit: defenceResult.maxHit, recovery: defenceResult.recovery,
    mana: defenceResult.mana, unreservedMana: defenceResult.unreservedMana,
    movementSpeed: utility.movementSpeed, itemRarity: utility.itemRarity, itemQuantity: utility.itemQuantity };
}

// The power score's weights, for the build planner's stages (public/buildstages.js), whose defaults reproduce it.
export const POWER_SCORE_WEIGHTS = SCORE_WEIGHTS;

// ---------- prices ----------
// Gives each unique its price in Divines (null when poe.ninja doesn't list it). Without this call the generator
// plans without prices.
export function attachPrices(index, chaosByName, divineChaos) {
  index.priced = true;
  for (const unique of index.uniques) {
    const chaos = chaosByName[unique.name];
    unique.price = typeof chaos === 'number' ? chaos / divineChaos : null;
  }
}

// The build's uniques' cost in Divines, an unpriced unique counted at UNPRICED_DIVINES. null when no prices
// were given.
export function costOf(build) {
  let total = 0;
  let anyPriced = false;
  for (const unique of build.uniques) {
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
  for (const unique of build.uniques) {
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
  return { skill, ascendancy, weapon, ailment, supports: [], notables: [], keystones: [], uniques: [], buffs: [], flasks: [] };
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
  const minionTypes = new Set(build.skill.minionTypes);
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
    if (support.weapons.length > 0 && !support.weapons.includes(build.weapon)) {
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
  for (const chosen of build.uniques) {
    if (chosen.name === unique.name) {
      return false;
    }
    if (chosen.slot === unique.slot) {
      used += 1;
    }
  }
  if (used >= (SLOT_COUNT[unique.slot] || 1)) {
    return false;
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
    return unique.weapon === build.weapon;
  }
  if (unique.category === 'Quiver' && build.weapon !== 'bow') {
    return false;
  }
  if (unique.category === 'Shield' && (build.weapon === 'staff' || build.weapon === 'bow')) {
    return false;
  }
  return true;
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

// Auras, heralds and reserved buffs that fit in RESERVABLE_PERCENT of the pool after efficiency, and one curse.
function buffAllowed(build, buff) {
  let curses = 0;
  for (const chosen of build.buffs) {
    if (chosen.kind === 'curse') {
      curses += 1;
    }
  }
  // Each buff takes a socket, an Eternal Blessing aura two.
  let sockets = buff.sockets || 1;
  for (const chosen of build.buffs || []) {
    sockets += chosen.sockets || 1;
  }
  if (sockets > socketsForBuffs(build)) {
    return false;
  }
  if (buff.kind === 'curse') {
    return curses < MAX_CURSES;
  }
  if (!blessingRulesHold(build, buff)) {
    return false;
  }
  if (!buff.reservation) {
    return true;
  }
  const reserved = reservedPercentOf(build, [...build.buffs, buff]);
  return reserved.mana <= RESERVABLE_PERCENT && reserved.life <= RESERVABLE_PERCENT;
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
    return chosen.every(other => !other.reservation || reservesLife(build, other));
  }
  if (blessingChosen && buff.reservation > 0) {
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
  for (const chosen of build.keystones) {
    if (chosen.name === keystone.name) {
      return false;
    }
  }
  return true;
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
    let build = emptyBuild(skill, NO_ASCENDANCY, weapon, options.ailment || null);
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
  const kept = plans.slice(0, WEAPONS_KEPT);
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
    let build = { ...emptyBuild(skill, NO_ASCENDANCY, plain.weapon, options.ailment || null), stacking: stat, stackingPending: true };
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
    let build = { ...plan.build, ascendancy, notables: [], keystones: [], uniques: [], buffs: [], flasks: [] };
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
    build = addBest(build, 'uniques', uniques, MAX_UNIQUES, unique => unique, uniqueAllowed, scoreOf);
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
      if (!freesRareSlot(current, unique)) {
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

// The buffs were chosen before the supports were refined, so a support that wants unreserved mana (Archmage) loses to
// the auras already reserving it. The other order is tried too: the reserved buffs out, the supports refined with the
// whole pool, then the buffs chosen again, and the better build kept.
function betterWithSupportsFirst(build, index, scoreOf, powerOf, seedSupports) {
  const reservedBuffs = build.buffs.filter(buff => buff.reservation > 0);
  if (reservedBuffs.length === 0) {
    return build;
  }
  let trial = { ...build, buffs: build.buffs.filter(buff => !buff.reservation) };
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
  return planTree(index.tree, baseClass, evaluate, matters, { ...plannerOptions, jewels });
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
    timeless: bestTimelessChoices(index.timeless || [], evaluate, base) };
}

// The timeless keystones that help this build on their own, best first (the planner then weighs each against the
// points it costs to reach a socket and a keystone it can conquer).
const TIMELESS_CHOICES_OFFERED = 3;

function bestTimelessChoices(choices, evaluate, base) {
  const helpful = [];
  for (const choice of choices) {
    const gain = evaluate(choice.effects) / base - 1;
    if (gain > 0) {
      helpful.push({ choice, gain });
    }
  }
  helpful.sort((first, second) => second.gain - first.gain);
  return helpful.slice(0, TIMELESS_CHOICES_OFFERED).map(entry => entry.choice);
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
    effects: mergeEffects([smalls, ...chosen.map(entry => entry.effects)]), points: LARGE_CLUSTER_POINTS,
    gain: current / base - 1 };
}

// Plans the finished build's tree again with everything else in place: what the generator stores and what the
// page shows when a card is opened, so both always agree.
// options.scoreOf and options.wide as for composeForAscendancy.
export function finalizeTree(build, index, options = {}) {
  if (!index.tree) {
    return build;
  }
  const withoutTree = { ...build, tree: null };
  const tree = planTreeFor(withoutTree, build.ascendancy.baseClass, index, { ...treeOptionsOf(options), tryWithoutKeystones: true });
  return { ...build, tree };
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
  const stored = {
    ascendancy: build.ascendancy.name, baseClass: build.ascendancy.baseClass, skill: build.skill.name,
    weapon: build.weapon, score: roundTo(evaluation.score, 3), scaling: roundTo(evaluation.scaling, 2),
    defence: roundTo(evaluation.defence, 3), ehp: Math.round(evaluation.ehp), dps: evaluation.dps ? Math.round(evaluation.dps) : null, clear: roundTo(evaluation.clear, 3), crit: evaluation.crit,
    supports, notables: names(build.notables), bloodline: bloodlineOf(build), keystones: names(build.keystones), uniques: names(build.uniques),
    buffs: names(build.buffs || []), flasks: names(build.flasks || []),
    // The shares of mana and of life its buffs reserve, after reservation efficiency.
    reserved: roundTo(reservedPercentOf(build, build.buffs || []).mana, 1),
    reservedLife: roundTo(reservedPercentOf(build, build.buffs || []).life, 1),
  };
  if (build.gear) {
    stored.gear = compactGear(build.gear);
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
    { field: 'uniques', limit: MAX_UNIQUES, candidates: () => lists.uniques || [], isAllowed: uniqueAllowed },
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
    if (unique) {
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
    return finalizeTree(build, index, options);
  }
  return build;
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
  gemLevel: 'gem levels', resistance: 'resistances', movementSpeed: 'movement speed', duration: 'skill duration',
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
  noCritDamage: 'critical strikes deal no extra damage', neverCrit: 'never crits, never misses',
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
