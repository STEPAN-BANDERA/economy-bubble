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

// ---------- tuning (each value says what it stands for) ----------
const ENEMY_ELEMENTAL_RESISTANCE = 40; // an endgame map boss or pinnacle-lite enemy
const ENEMY_CHAOS_RESISTANCE = 25;
const BASE_CRIT_MULTIPLIER = 150;
const ATTACK_WEAPON_BASE_CRIT = 6; // a typical endgame weapon base
const MINION_BASE_CRIT = 5;
const STACKS_ASSUMED = 3; // "per Frenzy Charge", "per Endurance Charge": a build that cares keeps about three
const MAX_SUPPORTS = 5; // a six-link
const MAX_ASCENDANCY_NOTABLES = 4; // eight ascendancy points
const MAX_KEYSTONES = 2;
const MAX_UNIQUES = 4;
const MAX_TOTEMS = 6;
// Auras and heralds reserve a share of mana. Our estimate: an endgame tree and gear give enough reservation
// efficiency to run skills worth 100% of base reservation (two 50% auras, or one and two heralds) and still keep
// mana for the main skill.
const RESERVATION_BUDGET = 100;
const MAX_CURSES = 1; // the curse limit without curse-limit gear or notables
// Our estimate of how much of a curse lands over a fight. Bosses take curses at full effect (3.20 removed their 33% and
// 66% less curse effect, patchnotes.txt), but a cast curse isn't up every moment: it has to be cast again as targets
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
  // "haven't ... recently": the complement of the plain condition's uptime above
  notRecentlyHit: 0.5, noRecentBlock: 0.8, noRecentKill: 0.3,
  masteryCount: 0, // "if you have at least 6 Life Masteries allocated": the planner doesn't count them, so no credit
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
export function prepareMechanics(mechanics, treeData = null) {
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
  const buffs = buffsOf(skills);
  const flasks = [];
  for (const flask of mechanics.flasks?.utility || []) {
    flasks.push({ ...flask, kind: 'flask' });
  }
  setLifeFlask(mechanics.flasks?.life || null);
  const jewelMods = mechanics.jewels?.mods || [];
  const largeClusters = mechanics.jewels?.largeClusters || [];
  weaponBases = mechanics.weaponBases || null;
  return { skills, supports, ascendancies, uniques, keystones, buffs, flasks, jewelMods, largeClusters, patch: mechanics.patch,
    tree: treeData ? prepareTree(treeData) : null };
}

// The auras, heralds and curses a build can run beside its main skill. An aura reaches the allies around you,
// your minions too, so each of its lines is also given to the minions; a herald's buff is yours alone. A curse's
// lines count at CURSE_EFFECT_ASSUMED.
function buffsOf(skills) {
  const buffs = [];
  for (const skill of skills) {
    if (skill.main || skill.effects.length === 0) {
      continue;
    }
    const isAura = skill.tags.includes('aura');
    const isHerald = skill.tags.includes('herald');
    const isCurse = skill.tags.includes('curse');
    if ((isAura || isHerald) && skill.reservation > 0) {
      buffs.push({ name: skill.name, kind: isAura ? 'aura' : 'herald', reservation: skill.reservation,
        attributes: skill.attributes, effects: isAura ? withMinionCopies(skill.effects) : skill.effects });
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
  for (const entry of build.supports) {
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
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      if (effect.kind === 'flag' && appliesToSubject(effect, isMinion, tags)) {
        flags.add(effect.stat);
      }
    }
  }
  return { skill, types, tags, isMinion, isDamageOverTime, ailment, flags, shares: damageShares(build, skill, isMinion, tags) };
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

// Every piece of the build that carries effects: the skill itself, supports, notables, keystones, uniques.
function piecesOf(build) {
  const pieces = [{ kind: 'skill', name: build.skill.name, effects: build.skill.effects, via: 'skill' }];
  for (const entry of build.supports) {
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
  for (const buff of build.buffs || []) {
    pieces.push({ kind: buff.kind, name: buff.name, effects: buff.effects, via: 'self' });
  }
  if (build.tree) {
    pieces.push({ kind: 'tree', name: 'Passive tree', effects: build.tree.effects, via: 'self' });
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
  return coverage * conditionUptime(effect.condition, context, branch);
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
  if (condition === 'perStack') {
    return STACKS_ASSUMED;
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
  let increased = GEAR_INCREASED_DAMAGE + (allowance ? allowance.increased : 0);
  let more = 1;
  let speedIncreased = GEAR_INCREASED_SPEED + (allowance ? allowance.speed : 0);
  let speedMore = 1;
  let critIncreased = branch.crit ? GEAR_INCREASED_CRIT + (allowance ? allowance.critIncreased : 0) : 0;
  let critMore = 1;
  let baseCrit = context.isMinion ? MINION_BASE_CRIT : (context.types.has('Attack') ? ATTACK_WEAPON_BASE_CRIT : (context.skill.baseCrit || 5));
  let critMultiplier = BASE_CRIT_MULTIPLIER + (branch.crit ? GEAR_CRIT_MULTIPLIER + (allowance ? allowance.critMultiplier : 0) : 0);
  let levels = 0;
  let dotMultiplier = context.isDamageOverTime || context.ailment ? GEAR_DOT_MULTIPLIER + (allowance ? allowance.dotMultiplier : 0) : 0;
  let added = 0;
  let extra = 0;
  let totems = 1;
  const resistanceDrop = { fire: 0, cold: 0, lightning: 0, chaos: 0, physical: 0 };
  for (const piece of piecesOf(build)) {
    for (const effect of piece.effects) {
      const weight = effectWeight(effect, context, branch);
      if (weight === 0) {
        continue;
      }
      const value = (effect.value || 0) * weight;
      if (effect.stat === 'damage' && effect.kind === 'increased') {
        increased += value;
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
      } else if (effect.kind === 'limit' && effect.stat === 'totems') {
        totems += value;
      } else if (effect.kind === 'flag' && effect.stat === 'extraTotem') {
        totems += 1;
      }
    }
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
  const value = baseRate(context) * (1 + increased / 100) * more * critFactor * hitFactor * dotFactor * levelFactor
    * speedFactor * totemFactor * resistanceFactor * (1 + extra / 100);
  const sheetFactors = (1 + increased / 100) * more * critFactor * levelFactor * speedFactor * totemFactor * (1 + extra / 100);
  const dps = attackSheetDps(context, build.weapon, added, sheetFactors);
  return { value: Math.max(value, 0.0001), critChance, dps };
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
const MANA_ASSUMED = 1000; // for Mind over Matter and mana-to-energy-shield lines
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

// Blood Magic reserves life instead of mana. With the reservation efficiency the budget assumes, the auras take
// about this share of the reservation they cost.
const RESERVED_SHARE_AFTER_EFFICIENCY = 0.6;
// Players count on defences that are always there. A defensive line under a condition (a guard skill's buff,
// "if you haven't been hit recently", "while stationary") counts at its uptime, and then at half again: being
// safe only part of the time is what kills a build. Conditions that hold for a whole boss fight aren't discounted.
const INCONSISTENT_DEFENCE_FACTOR = 0.5;
const CONSISTENT_CONDITIONS = new Set(['perStack', 'nearby', 'rareOrUnique', 'recentSkill', 'recentSpell', 'fortify',
  'enemyCursed', 'flask']);
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
const DEFENCE_STATS = new Set(['life', 'energyShield', 'armour', 'evasion', 'defences', 'block', 'spellBlock', 'suppress',
  'suppressPrevent', 'damageTakenLess', 'physicalReduction', 'elementalReduction', 'maxResistance', 'recoup', 'lifeRegen',
  'lifeRegenFlat', 'esRegen', 'esRegenFlat', 'leech', 'onHitRecovery', 'maxBlock', 'maxSpellBlock', 'lifeToEnergyShield',
  'damageTaken', 'manaToEnergyShield', 'resistance', 'shieldDefences', 'enduranceCharge', 'enduranceCharges',
  'enduranceChargeGenerator', 'minimumEnduranceCharges', 'esRecharge', 'esRechargeStart', 'flaskRecovery']);
const ELEMENTS = ['fire', 'cold', 'lightning'];

// Every defensive line of the build summed by what it changes. Only your own lines count; support and minion
// lines are about the skill or the minions.
function defenceTotals(build, context) {
  const totals = {
    life: { flat: 0, increased: 0, more: 1 }, energyShield: { flat: 0, increased: 0, more: 1 },
    armour: { flat: 0, increased: 0, more: 1 }, evasion: { flat: 0, increased: 0, more: 1 },
    block: 0, spellBlock: 0, suppress: 0, suppressPrevent: 50, maxBlock: 0, maxSpellBlock: 0,
    physicalReduction: 0, elementalReduction: 0, maxResistance: { fire: 0, cold: 0, lightning: 0, chaos: 0 },
    chaosResistance: GEAR_CHAOS_RESISTANCE, takenMultiplier: { physical: 1, fire: 1, cold: 1, lightning: 1, chaos: 1 },
    takenAttackMultiplier: 1, takenIncreased: { physical: 0, fire: 0, cold: 0, lightning: 0, chaos: 0 },
    lifeRegenPercent: 0, lifeRegenFlat: 0, esRegenPercent: 0, esRegenFlat: 0, leech: 0, recoup: 0, onHit: 0,
    lifeAsEnergyShield: 0, manaAsEnergyShield: 0, shieldDefences: 0, enduranceSource: false, enduranceMaximum: 0,
    esRecharge: { increased: 0, more: 1 }, esRechargeStart: 0, flaskRecovery: 0,
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
      if (effect.condition && !CONSISTENT_CONDITIONS.has(effect.condition)) {
        amount *= INCONSISTENT_DEFENCE_FACTOR;
      }
      addDefenceLine(totals, effect, amount);
    }
  }
  if (totals.enduranceSource) {
    totals.physicalReduction += (BASE_ENDURANCE_CHARGES + totals.enduranceMaximum) * PHYSICAL_REDUCTION_PER_ENDURANCE_CHARGE;
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
  if (stat === 'life' || stat === 'energyShield' || stat === 'armour' || stat === 'evasion') {
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
    // Elemental resistances are taken as capped by gear, so more of them adds nothing; chaos resistance isn't.
    if ((effect.tags || []).includes('chaos')) {
      totals.chaosResistance += amount;
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
    leech: 'leech', recoup: 'recoup', onHitRecovery: 'onHit', lifeToEnergyShield: 'lifeAsEnergyShield',
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
function shareTaken(totals, flags, armour, evasion, weapon) {
  const physicalHit = REFERENCE_HIT * HIT_SHARES.physical;
  const armourReduction = armour > 0 ? armour / (armour + 5 * physicalHit) * 100 : 0;
  const physicalReduction = Math.min(90, armourReduction + totals.physicalReduction);
  const mitigated = {
    physical: 1 - physicalReduction / 100,
    chaos: flags.has('chaosInoculation') ? 0 : 1 - Math.min(MAX_RESISTANCE + totals.maxResistance.chaos, totals.chaosResistance) / 100,
  };
  for (const element of ELEMENTS) {
    const resistance = Math.min(RESISTANCE_CEILING, MAX_RESISTANCE + totals.maxResistance[element]);
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
function effectiveHp(totals, flags, context, weapon, reservedShare, gear) {
  const gearScale = flags.has('noHelmet') ? 0.85 : 1;
  const lifeGear = gear.pool === 'life' ? GEAR_LIFE * gearScale : 0;
  const esGear = gear.pool === 'es' ? GEAR_ENERGY_SHIELD * gearScale : 0;
  let life = flags.has('chaosInoculation') ? 1 : scaled(totals.life, CHARACTER_LIFE + lifeGear);
  if (flags.has('bloodMagic')) {
    life *= Math.max(0.1, 1 - reservedShare);
  }
  let energyShield = flags.has('noEnergyShield') ? 0 : scaled(totals.energyShield, esGear);
  energyShield += life * totals.lifeAsEnergyShield / 100 + MANA_ASSUMED * totals.manaAsEnergyShield / 100;
  if (flags.has('eldritchBattery') || flags.has('esBypass')) {
    energyShield = 0; // it protects mana, or hits go past it
  }
  const ratingGear = gear.pool === 'life' ? GEAR_DEFENCE_RATING * gearScale : 0;
  let armour = scaled(totals.armour, ratingGear * gear.armourShare);
  let evasion = scaled(totals.evasion, ratingGear * (1 - gear.armourShare));
  if (flags.has('ironReflexes')) {
    armour += evasion;
    evasion = 0;
  }
  let pool = life + energyShield;
  if (flags.has('mindOverMatter')) {
    pool += Math.min(life * 0.4 / 0.6, MANA_ASSUMED);
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
  pool += recoveryPerSecond * RECOVERY_SECONDS;
  const taken = shareTaken(totals, flags, armour, evasion, weapon);
  const recoup = Math.min(RECOUP_MAX_SHARE, Math.min(100, totals.recoup) / 100 * RECOUP_WITHIN_WINDOW);
  const standingPool = life + energyShield;
  const readyShare = Math.min(1, Math.max(life / READY_LIFE, energyShield / READY_ENERGY_SHIELD));
  const readiness = Math.pow(readyShare, 2);
  return { ehp: pool / (taken * Math.max(0.1, 1 - recoup)) * readiness, pool: standingPool, life, energyShield };
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
  let reserved = 0;
  for (const buff of build.buffs || []) {
    reserved += buff.reservation || 0;
  }
  const reservedShare = reserved / 100 * RESERVED_SHARE_AFTER_EFFICIENCY;
  let best = null;
  for (const gear of GEAR_CHOICES) {
    const result = effectiveHp(totals, context.flags, context, build.weapon, reservedShare, gear);
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
  return { index: best.ehp / referenceHp(), ehp: best.ehp, pool: best.pool, life: best.life, energyShield: best.energyShield };
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
  const classAttributes = CLASS_ATTRIBUTES[build.ascendancy.baseClass] || [];
  for (const attribute of build.skill.attributes) {
    if (!classAttributes.includes(attribute)) {
      return OFF_ATTRIBUTE_FACTOR;
    }
  }
  return 1;
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
  const offence = bestOffence(build, context);
  const scaling = offence.value / bareOffence(build);
  const defenceResult = defenceOf(build, context);
  const defence = defenceResult.index;
  const clear = clearOf(build, context);
  const problems = problemsOf(build, context);
  const score = Math.pow(scaling, SCORE_WEIGHTS.offence) * Math.pow(defence, SCORE_WEIGHTS.defence)
    * Math.pow(clear, SCORE_WEIGHTS.clear) * attributeFactor(build);
  return { score: problems.length > 0 ? 0 : score, offence: offence.value, scaling, defence, ehp: defenceResult.ehp, pool: defenceResult.pool, life: defenceResult.life, dps: offence.dps ?? null,
    energyShield: defenceResult.energyShield, clear, crit: offence.crit,
    critChance: offence.critChance, problems, tags: [...context.tags].sort(), shares: context.shares };
}

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
  let penalty = 1;
  for (const unique of build.uniques) {
    if (unique.price === undefined) {
      continue;
    }
    const divines = unique.price === null ? UNPRICED_DIVINES : unique.price;
    penalty *= 1 + PRICE_WEIGHT * Math.log(1 + divines);
  }
  return score / penalty;
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

// Auras and heralds within the reservation budget, and one curse.
function buffAllowed(build, buff) {
  let reserved = 0;
  let curses = 0;
  for (const chosen of build.buffs) {
    reserved += chosen.reservation;
    if (chosen.kind === 'curse') {
      curses += 1;
    }
  }
  if (buff.kind === 'curse') {
    return curses < MAX_CURSES;
  }
  return reserved + buff.reservation <= RESERVATION_BUDGET;
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
export function planSkill(skill, index, options = {}) {
  const plans = [];
  for (const weapon of weaponChoicesFor(skill)) {
    let build = emptyBuild(skill, NO_ASCENDANCY, weapon, options.ailment || null);
    build = addBest(build, 'supports', current => supportCandidates(current, index), MAX_SUPPORTS, supportEntry);
    const score = evaluateBuild(build).score;
    if (score > 0) {
      plans.push({ weapon, build, score });
    }
  }
  plans.sort((first, second) => second.score - first.score);
  const kept = plans.slice(0, WEAPONS_KEPT);
  for (const plan of kept) {
    plan.uniques = shortlist(plan.build, relevantUniques(plan.build, index), UNIQUE_SHORTLIST, 'uniques', uniqueAllowed);
    plan.keystones = shortlist(plan.build, index.keystones, KEYSTONE_SHORTLIST, 'keystones', keystoneAllowed);
    if (index.priced) {
      // The value plan's uniques: the same candidates, shortlisted for their gain over their price. Supports and
      // keystones come before any unique, so their shortlists are the same for both plans.
      plan.pricedUniques = shortlist(plan.build, relevantUniques(plan.build, index), UNIQUE_SHORTLIST, 'uniques', uniqueAllowed, valueScore);
    }
  }
  return { skill, plans: kept };
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
export function composeForAscendancy(skillPlan, ascendancy, index, options = {}) {
  const priced = Boolean(options.priced && index.priced);
  const scoreOf = priced ? valueScore : powerScore;
  let best = null;
  let bestChoice = -1;
  for (const plan of skillPlan.plans) {
    let build = { ...plan.build, ascendancy, notables: [], keystones: [], uniques: [], buffs: [], flasks: [] };
    if (index.tree) {
      // The tree follows the class (it decides where the tree starts), so one tree per class serves all three
      // of its ascendancies while they are compared; finalizeTree() plans it again for the finished build.
      build.tree = classTree(plan, ascendancy.baseClass, index);
    }
    build = addBest(build, 'notables', ascendancy.notables, notableLimitOf(ascendancy), notable => notable, null, scoreOf);
    if (!index.tree) {
      build = addBest(build, 'keystones', plan.keystones, MAX_KEYSTONES, keystone => keystone, keystoneAllowed, scoreOf);
    }
    build = addBest(build, 'buffs', index.buffs, MAX_BUFFS, buff => buff, buffAllowed, scoreOf);
    const uniques = priced ? plan.pricedUniques : plan.uniques;
    build = addBest(build, 'uniques', uniques, MAX_UNIQUES, unique => unique, uniqueAllowed, scoreOf);
    build = addBest(build, 'flasks', index.flasks, UTILITY_FLASK_SLOTS, flask => flask, flaskAllowed, scoreOf);
    // Its uniques are fixed by now, so the price penalty is the same for every support set: power decides.
    build = refineSupports(build, index);
    const choice = scoreOf(build);
    if (best === null || choice > bestChoice) {
      best = build;
      bestChoice = choice;
    }
  }
  // The evaluation is always the build's power; the value plan's prices only decided which pieces were chosen.
  return { build: best, evaluation: best ? evaluateBuild(best) : null };
}

function classTree(plan, baseClass, index) {
  plan.trees ??= new Map();
  if (!plan.trees.has(baseClass)) {
    plan.trees.set(baseClass, planTreeFor({ ...plan.build, ascendancy: NO_ASCENDANCY }, baseClass, index));
  }
  return plan.trees.get(baseClass);
}

// The tree the build's own pieces call for, from its class's start.
function planTreeFor(build, baseClass, index, options = {}) {
  const matters = effectMattersFor(build);
  const evaluate = effects => evaluateBuild({ ...build, tree: { effects } }).score;
  const jewels = jewelChoicesFor(index, evaluate);
  return planTree(index.tree, baseClass, evaluate, matters, { ...options, jewels });
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
  return { rare, clusters: clusters.slice(0, LARGE_CLUSTER_TYPES_OFFERED), maxClusters: MAX_LARGE_CLUSTERS };
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
export function finalizeTree(build, index) {
  if (!index.tree) {
    return build;
  }
  const withoutTree = { ...build, tree: null };
  const tree = planTreeFor(withoutTree, build.ascendancy.baseClass, index, { tryWithoutKeystones: true });
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

function notableLimitOf(ascendancy) {
  if (ascendancy.notables.length > BORROWING_ASCENDANCY_NOTABLE_COUNT) {
    return BORROWING_ASCENDANCY_MAX_NOTABLES;
  }
  return MAX_ASCENDANCY_NOTABLES;
}

// Drops the two supports picked last and refills, keeping whichever set scores higher.
function refineSupports(build, index) {
  if (build.supports.length < 3) {
    return build;
  }
  const trimmed = { ...build, supports: build.supports.slice(0, build.supports.length - 2) };
  const refilled = addBest(trimmed, 'supports', current => supportCandidates(current, index), MAX_SUPPORTS, supportEntry);
  if (evaluateBuild(refilled).score > evaluateBuild(build).score) {
    return refilled;
  }
  return build;
}

// One build for a skill and ascendancy (both stages), for a single question.
export function bestBuildFor(skill, ascendancy, index, options = {}) {
  return composeForAscendancy(planSkill(skill, index, options), ascendancy, index, options);
}

// A build stored by name (scripts/generate_builds.mjs) back as pieces the engine can evaluate. Returns null
// when the mechanics file no longer has one of its pieces.
export function rebuildFromNames(stored, index) {
  const skill = findByName(index.skills, stored.skill);
  const ascendancy = findByName(index.ascendancies, stored.ascendancy);
  if (!skill || !ascendancy) {
    return null;
  }
  const build = emptyBuild(skill, ascendancy, stored.weapon, stored.ailment || null);
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
  for (const name of stored.notables) {
    const notable = findByName(ascendancy.notables, name);
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
    return finalizeTree(build, index);
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
  perStack: 'per charge or stack', recentKill: 'after a recent kill', onKill: 'on kill', recentCrit: 'after a recent crit',
  onCrit: 'on critical strikes', nonCrit: 'with non-critical strikes', lowLife: 'on low life', fullLife: 'on full life',
  flask: 'during a flask', rareOrUnique: 'against rare and unique enemies', enemyShocked: 'against shocked enemies',
  enemyChilled: 'against chilled enemies', enemyIgnited: 'against ignited enemies', arcaneSurge: 'with Arcane Surge',
  totem: 'with a totem out', channel: 'while channelling', nearby: 'near enemies', periodic: 'some of the time',
  frenzyCharges: 'per frenzy charge', powerCharges: 'per power charge', enduranceCharges: 'per endurance charge',
  other: 'under a condition',
};

function describeCondition(condition) {
  return CONDITION_WORDS[condition] || condition.replace(/([A-Z])/g, ' $1').toLowerCase();
}

const FLAG_WORDS = {
  elementalOverload: 'big elemental damage boost after any crit, but crits do no extra damage',
  noCritDamage: 'critical strikes deal no extra damage', neverCrit: 'never crits, never misses',
  chaosInoculation: 'immune to chaos damage, life fixed at 1', mindOverMatter: 'part of the damage taken comes from mana',
  pureElement: 'only one element can deal damage', noSelfDamage: 'you deal no damage yourself; totems and minions do',
  battlemage: 'weapon damage adds to spells', scalesWithMana: 'damage grows with maximum mana',
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
