// The build planner's search: plans builds on demand from hard limits, like the Crafting tab plans an item, instead
// of sorting a list made in advance. Pure functions with no page access; public/build-worker.js runs them off the
// main thread and scripts/test_builds.mjs runs them in Node.
//
// 1. Limits. The planner starts only when at least MIN_LIMITS of class, ascendancy, damage type, weapon, weapon
//    type and playstyle are chosen; they pick the ascendancies and the skill variants worth planning (a skill, the
//    weapons it may use, the supports a playstyle needs first, the supports it forbids).
// 2. Quick pass. Every variant x ascendancy is composed without a passive tree (about 20 ms each), scored by the
//    stage weights (public/buildstages.js).
// 3. Full plans. The best few get the whole treatment: the tree planned, the stage agents' rounds, the tree planned
//    again for what the agents settled on, and the value plan beside it when prices are known.
//
// Tags (public/buildtags.js) skip what can't help each build. The wide search ignores them: skills that could
// reach a damage type or a playstyle only through conversion or an ailment are planned too, uniques are tried
// against each ascendancy's build rather than the bare skill, and the tree measures every node. It is slower and
// rarely changes the winner, which is the point of having it: to find the exceptions.
import { buildContext, weaponChoicesOf, planSkill, composeForAscendancy, finalizeTree, evaluateBuild, compactBuild,
  costOf, pricePenalty } from './buildgen.js';
import { tagIndex, tagReport } from './buildtags.js';
import { DEFAULT_WEIGHTS, DEFAULT_TOLERANCE, scoreFunctionFor, totalOf, stageValues, negotiate } from './buildstages.js';

export const MIN_LIMITS = 2;

export const DAMAGE_TYPES = [
  { id: 'physical', label: 'Physical' }, { id: 'fire', label: 'Fire' }, { id: 'cold', label: 'Cold' },
  { id: 'lightning', label: 'Lightning' }, { id: 'chaos', label: 'Chaos' },
];
export const WEAPONS = [
  { id: 'sword', label: 'Sword' }, { id: 'axe', label: 'Axe' }, { id: 'mace', label: 'Mace or sceptre' }, { id: 'claw', label: 'Claw' },
  { id: 'dagger', label: 'Dagger' }, { id: 'wand', label: 'Wand' }, { id: 'staff', label: 'Staff' }, { id: 'bow', label: 'Bow' },
  { id: 'shield', label: 'Shield (spells)' },
];
// The generator plans one-handed weapons, staves and bows; two-handed swords, axes and maces aren't separate bases.
export const WEAPON_TYPES = [
  { id: 'oneHand', label: 'One-handed', weapons: ['sword', 'axe', 'mace', 'claw', 'dagger', 'wand'] },
  { id: 'twoHand', label: 'Two-handed (staff, bow)', weapons: ['staff', 'bow'] },
  { id: 'shield', label: 'With a shield', weapons: ['shield'] },
];
export const PLAYSTYLES = [
  { id: 'hit', label: 'Hits, your own' },
  { id: 'dot', label: 'Damage over time' },
  { id: 'totem', label: 'Totems' },
  { id: 'trapMine', label: 'Traps and mines' },
  { id: 'minion', label: 'Minions' },
];
export const LIMIT_IDS = ['class', 'ascendancy', 'damage', 'weapon', 'weaponType', 'playstyle'];

// The skill types that decide how a skill is delivered, and the supports that add them.
const TOTEM_TYPES = ['SummonsTotem'];
const TRAP_MINE_TYPES = ['Trapped', 'RemoteMined'];
const DELIVERY_TYPES = [...TOTEM_TYPES, ...TRAP_MINE_TYPES];

// A damage type limit holds when at least this share of the finished build's damage is of that type: the same
// floor as the "What people play" view's damage types (DAMAGE_TYPE_FLOOR_PERCENT in builds.js).
const DAMAGE_SHARE_FLOOR = 0.25;

// How many quick-pass builds get full plans, and at most how many of them per skill, so a few skills don't fill
// every place.
export const FULL_PLANS = 12;
const FULL_PLANS_PER_SKILL = 3;

// ---------- limits ----------
// How many limits narrow the search. A class is a loose limit (it leaves three ascendancies); an ascendancy narrows
// 21 to one and names its class too, so it counts as two: an ascendancy alone is enough to plan (every skill for
// that one ascendancy, about 355 quick plans). A weapon names its weapon type, so that pair counts once.
export function limitCount(limits) {
  let count = 0;
  if (limits.ascendancy) {
    count += 2;
  } else if (limits.class) {
    count += 1;
  }
  if (limits.damage) {
    count += 1;
  }
  if (limits.weapon || limits.weaponType) {
    count += 1;
  }
  if (limits.playstyle) {
    count += 1;
  }
  return count;
}

// The ascendancies the limits leave. A class and an ascendancy of another class leave none.
export function ascendanciesFor(index, limits) {
  const kept = [];
  for (const ascendancy of index.ascendancies) {
    if (limits.class && ascendancy.baseClass !== limits.class) {
      continue;
    }
    if (limits.ascendancy && ascendancy.name !== limits.ascendancy) {
      continue;
    }
    kept.push(ascendancy);
  }
  return kept;
}

export function classesOf(index) {
  const classes = new Set();
  for (const ascendancy of index.ascendancies) {
    if (ascendancy.baseClass) {
      classes.add(ascendancy.baseClass);
    }
  }
  return [...classes].sort();
}

// ---------- skill variants ----------
// A variant is one way to plan a skill under the limits, small enough to send to a worker: the skill's name, the
// weapons it may use, supports it starts with, supports it may not take, and the ailment it builds on.
export function skillVariants(index, limits, wide) {
  const variants = [];
  for (const skill of index.skills) {
    if (!skill.main) {
      continue;
    }
    for (const variant of variantsOfSkill(skill, index, limits, wide)) {
      variants.push(variant);
    }
  }
  return variants;
}

function variantsOfSkill(skill, index, limits, wide) {
  const weapons = allowedWeapons(skill, limits);
  if (weapons.length === 0) {
    return [];
  }
  if (limits.damage && !wide && !ownDamageTypes(skill).includes(limits.damage)) {
    return [];
  }
  const nature = natureOf(skill, weapons[0]);
  const base = { skill: skill.name, weapons, seedSupports: [], forbiddenAddedTypes: null, ailment: null };
  const playstyle = limits.playstyle;
  if (!playstyle) {
    return [withKey(base)];
  }
  if (playstyle === 'minion') {
    return nature.isMinion ? [withKey({ ...base, forbiddenAddedTypes: DELIVERY_TYPES })] : [];
  }
  if (nature.isMinion) {
    return [];
  }
  if (playstyle === 'hit') {
    if (nature.isDamageOverTime || nature.deliveredBy !== null || !nature.hits) {
      return [];
    }
    return [withKey({ ...base, forbiddenAddedTypes: DELIVERY_TYPES })];
  }
  if (playstyle === 'dot') {
    return dotVariants(skill, base, nature, wide);
  }
  if (playstyle === 'totem') {
    return deliveryVariants(skill, index, base, nature, 'totem', TOTEM_TYPES, TRAP_MINE_TYPES);
  }
  if (playstyle === 'trapMine') {
    return deliveryVariants(skill, index, base, nature, 'trapMine', TRAP_MINE_TYPES, TOTEM_TYPES);
  }
  return [];
}

// The damage types a skill deals before any conversion. A skill that lists none (most minion skills) deals
// physical damage, as the engine counts it (damageShares in buildgen.js).
function ownDamageTypes(skill) {
  if (skill.damageTypes.length > 0) {
    return skill.damageTypes;
  }
  return ['physical'];
}

function withKey(variant) {
  const parts = [variant.skill, variant.weapons.join('+'), variant.seedSupports.join('+'), variant.ailment || ''];
  return { ...variant, key: parts.join('|') };
}

function allowedWeapons(skill, limits) {
  const allowed = [];
  for (const weapon of weaponChoicesOf(skill)) {
    if (limits.weapon && weapon !== limits.weapon) {
      continue;
    }
    if (limits.weaponType) {
      const type = WEAPON_TYPES.find(entry => entry.id === limits.weaponType);
      if (!type || !type.weapons.includes(weapon)) {
        continue;
      }
    }
    allowed.push(weapon);
  }
  return allowed;
}

// What a skill is on its own, before any support: a minion skill, damage over time, a hit, and whether it is a
// totem, trap or mine already.
function natureOf(skill, weapon) {
  const bare = { skill, ascendancy: { name: 'none', baseClass: null, notables: [] }, weapon, ailment: null,
    supports: [], notables: [], keystones: [], uniques: [], buffs: [], flasks: [] };
  const context = buildContext(bare);
  let deliveredBy = null;
  if (context.types.has('SummonsTotem')) {
    deliveredBy = 'totem';
  } else if (context.types.has('Trapped') || context.types.has('RemoteMined')) {
    deliveredBy = 'trapMine';
  }
  const hits = context.types.has('Damage') || context.types.has('Attack');
  return { isMinion: context.isMinion, isDamageOverTime: context.isDamageOverTime, hits, deliveredBy };
}

// A damage-over-time skill as it is. The wide search also plans hits built on an ailment: ignite for fire,
// bleeding for physical attacks, poison for physical or chaos.
function dotVariants(skill, base, nature, wide) {
  const variants = [];
  if (nature.isDamageOverTime && nature.deliveredBy === null) {
    variants.push(withKey({ ...base, forbiddenAddedTypes: DELIVERY_TYPES }));
  }
  if (!wide || nature.isDamageOverTime || !nature.hits || nature.deliveredBy !== null) {
    return variants;
  }
  const damage = skill.damageTypes;
  const ailments = [];
  if (damage.includes('fire')) {
    ailments.push('ignite');
  }
  if (damage.includes('physical') && skill.types.includes('Attack')) {
    ailments.push('bleed');
  }
  if (damage.includes('physical') || damage.includes('chaos')) {
    ailments.push('poison');
  }
  for (const ailment of ailments) {
    variants.push(withKey({ ...base, ailment, forbiddenAddedTypes: DELIVERY_TYPES }));
  }
  return variants;
}

// A totem (or trap, or mine) skill as it is, or any other skill with each support that makes it one: Fireball with
// Spell Totem, Ice Shot with Ballista Totem. The other delivery's supports are forbidden.
function deliveryVariants(skill, index, base, nature, wanted, addedTypes, otherTypes) {
  if (nature.deliveredBy === wanted) {
    return [withKey({ ...base, forbiddenAddedTypes: otherTypes })];
  }
  if (nature.deliveredBy !== null) {
    return [];
  }
  const variants = [];
  for (const support of index.supports) {
    if (support.awakened || support.trigger) {
      continue;
    }
    let adds = false;
    for (const type of support.added || []) {
      if (addedTypes.includes(type)) {
        adds = true;
      }
    }
    if (adds) {
      variants.push(withKey({ ...base, seedSupports: [support.name], forbiddenAddedTypes: otherTypes }));
    }
  }
  return variants;
}

// What a search will plan: its variants, ascendancies and how many quick plans that makes.
export function searchSize(index, limits, wide) {
  const ascendancies = ascendanciesFor(index, limits);
  const variants = skillVariants(index, limits, wide);
  return { variants, ascendancies, pairs: variants.length * ascendancies.length };
}

// ---------- planning ----------
function findSkill(index, name) {
  for (const skill of index.skills) {
    if (skill.name === name) {
      return skill;
    }
  }
  return null;
}

function planOptionsOf(variant, weights, wide, gearLevel = null) {
  const options = { weapons: variant.weapons, seedSupports: variant.seedSupports, ailment: variant.ailment };
  if (gearLevel) {
    options.gearLevel = gearLevel; // how good the solved rare items are (public/buildgear.js, GEAR_LEVELS)
  }
  if (variant.forbiddenAddedTypes) {
    options.forbiddenAddedTypes = variant.forbiddenAddedTypes;
  }
  options.scoreOf = scoreFunctionFor(weights || DEFAULT_WEIGHTS);
  if (wide) {
    options.wide = true;
  }
  return options;
}

// Whether a finished build still keeps its limits: its damage is mostly the asked type, and a damage-over-time plan
// really is one. A seeded support that fell out isn't possible (seeds never move), so playstyles hold.
export function keepsLimits(evaluation, limits) {
  if (limits.damage && (evaluation.shares[limits.damage] || 0) < DAMAGE_SHARE_FLOOR) {
    return false;
  }
  return true;
}

// The quick pass for one variant: composed for every ascendancy without a tree. index must be prepared without a
// tree. onProgress(done, total) is called after each ascendancy.
export function quickPlans(variant, index, ascendancyNames, options = {}) {
  const skill = findSkill(index, variant.skill);
  if (!skill) {
    return [];
  }
  const weights = options.weights || DEFAULT_WEIGHTS;
  const planOptions = planOptionsOf(variant, weights, options.wide);
  const skillPlan = planSkill(skill, index, planOptions);
  const results = [];
  let done = 0;
  for (const ascendancyName of ascendancyNames) {
    done += 1;
    const result = quickPlanForAscendancy(variant, skillPlan, ascendancyName, index, planOptions, weights, options.limits || {});
    if (result !== null) {
      results.push(result);
    }
    if (options.onProgress) {
      options.onProgress(done, ascendancyNames.length);
    }
  }
  return results;
}

function quickPlanForAscendancy(variant, skillPlan, ascendancyName, index, planOptions, weights, limits) {
  const ascendancy = index.ascendancies.find(entry => entry.name === ascendancyName);
  if (!ascendancy || skillPlan.plans.length === 0) {
    return null;
  }
  const { build, evaluation } = composeForAscendancy(skillPlan, ascendancy, index, planOptions);
  if (!build || !(evaluation.score > 0) || !keepsLimits(evaluation, limits)) {
    return null;
  }
  return { variantKey: variant.key, skill: variant.skill, ascendancy: ascendancyName, total: totalOf(evaluation, weights) };
}

// The quick results that get full plans: the best totals, at most FULL_PLANS_PER_SKILL per skill.
export function chooseForFullPlans(quickResults, count = FULL_PLANS) {
  const sorted = [...quickResults].sort((first, second) => second.total - first.total
    || first.skill.localeCompare(second.skill) || first.ascendancy.localeCompare(second.ascendancy));
  const chosen = [];
  const perSkill = new Map();
  for (const result of sorted) {
    const used = perSkill.get(result.skill) || 0;
    if (used >= FULL_PLANS_PER_SKILL) {
      continue;
    }
    chosen.push(result);
    perSkill.set(result.skill, used + 1);
    if (chosen.length >= count) {
      break;
    }
  }
  return chosen;
}

// The full plan of one variant and ascendancy. index must be prepared with the tree (and tagged). Returns the card's
// data: the stored build (compactBuild) plus the stage values, the agents' log, what the tags skipped, and the
// value plan when the index has prices. null when the plan fails or breaks a limit.
export function fullPlan(variant, ascendancyName, index, options = {}) {
  tagIndex(index);
  const skill = findSkill(index, variant.skill);
  const ascendancy = index.ascendancies.find(entry => entry.name === ascendancyName);
  if (!skill || !ascendancy) {
    return null;
  }
  const weights = options.weights || DEFAULT_WEIGHTS;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const planOptions = planOptionsOf(variant, weights, options.wide, options.gearLevel);
  const skillPlan = planSkill(skill, index, planOptions);
  const composed = composeForAscendancy(skillPlan, ascendancy, index, planOptions);
  if (!composed.build || !(composed.evaluation.score > 0)) {
    return null;
  }
  const negotiation = settle(composed.build, skillPlan, index, weights, tolerance, variant, options.wide, planOptions);
  const build = negotiation.build;
  const evaluation = evaluateBuild(build);
  if (!keepsLimits(evaluation, options.limits || {})) {
    return null;
  }
  const card = compactBuild(build, evaluation);
  card.total = totalOf(evaluation, weights);
  card.stages = stageValues(evaluation);
  card.stagesBefore = negotiation.before;
  card.negotiation = negotiation.log;
  card.maxHit = Math.round(evaluation.maxHit);
  card.recovery = Math.round(evaluation.recovery);
  card.movementSpeed = Math.round(evaluation.movementSpeed);
  card.itemRarity = Math.round(evaluation.itemRarity);
  card.itemQuantity = Math.round(evaluation.itemQuantity);
  card.tagsSkipped = tagReport(index, buildContext(build));
  card.variant = variant;
  if (index.priced) {
    card.value = valuePlanCard(skillPlan, ascendancy, index, planOptions, build, card);
  }
  return card;
}

// The agents' rounds around the tree: first with the class tree the composer used, then the tree planned again for
// what they settled on, then the agents once more on that tree.
function settle(build, skillPlan, index, weights, tolerance, variant, wide, planOptions) {
  const uniques = uniqueCandidatesFor(build, skillPlan, index, wide);
  const negotiationOptions = { weights, tolerance, uniques, locked: variant.seedSupports, index };
  const first = negotiate(build, negotiationOptions);
  const withTree = finalizeTree(first.build, index, planOptions);
  const second = negotiate(withTree, negotiationOptions);
  return { build: second.build, before: first.before, log: [...first.log, ...second.log] };
}

// The uniques the agents may swap in: the plan's shortlist for the build's weapon, or every unique in a wide search.
function uniqueCandidatesFor(build, skillPlan, index, wide) {
  if (wide) {
    return index.uniques;
  }
  for (const plan of skillPlan.plans) {
    if (plan.weapon === build.weapon) {
      return plan.uniques;
    }
  }
  return [];
}

// The value plan: the same skill and ascendancy composed with prices, its tree planned for its own pieces when they
// differ from the power plan's. Reports its own pieces, its power (total) and its value (power over the penalty).
function valuePlanCard(skillPlan, ascendancy, index, planOptions, powerBuild, powerCard) {
  const priced = composeForAscendancy(skillPlan, ascendancy, index, { ...planOptions, priced: true });
  if (!priced.build) {
    return null;
  }
  let finished = priced.build;
  if (piecesKey(priced.build) === piecesKey(powerBuild)) {
    finished = { ...priced.build, tree: powerBuild.tree };
  } else {
    finished = finalizeTree(priced.build, index, planOptions);
  }
  const plan = compactBuild(finished, evaluateBuild(finished));
  // planOptions.scoreOf is the stage total (scoreFunctionFor), so this is the value plan's power on the same scale.
  const total = planOptions.scoreOf(finished);
  return { ...plan, total, value: total / pricePenalty(finished), cost: costOf(finished),
    sameAsPower: piecesKey(finished) === piecesKey(powerBuild), shareOfPower: powerCard.total > 0 ? total / powerCard.total : null };
}

function piecesKey(build) {
  const names = list => list.map(piece => piece.support ? piece.support.name : piece.name);
  return JSON.stringify([build.weapon, names(build.supports), names(build.notables), names(build.uniques), names(build.buffs), names(build.flasks)]);
}
