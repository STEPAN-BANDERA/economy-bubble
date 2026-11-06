// Crafting engine for PoE 1, modelled on Craft of Exile's emulator and simulator.
//
// - pool(): which modifiers can roll on an item right now, with their weights
//   (item level, open prefix/suffix slots, mod groups already on the item,
//   influences, fossils, bench metamods).
// - apply(): one currency on one item, randomly, like the game (the "emulator").
//   Running it many times gives the "simulator" numbers.
// - odds(): the chance that a roll lands every target mod, worked out exactly
//   over prefix/suffix slots and mod groups instead of by random sampling, so
//   one-in-a-million crafts get a real number too.
// - plan(): chains methods (chaos, alt/aug/regal + imprint, essences, fossils,
//   veiled chaos/exalt, eldritch currency, recombinators, dominance, beasts,
//   bench blocks and metamods) into step lists with expected costs.
//
// Pure functions; runs in the browser and in Node.

// Number of mods on a new rare item, per affix limit (Craft of Exile's table).
export const RARE_COUNTS = { 6: [[4, 8 / 12], [5, 3 / 12], [6, 1 / 12]], 4: [[3, 0.65], [4, 0.35]] };
export const MAGIC_COUNTS = [[1, 0.5], [2, 0.5]];
// Recombinator bench (Kingsmarch / hideout), unpredictable mode: how many prefixes (or
// suffixes) survive from a pool of n. Community-measured (Butsicles' table, 3.29); pools of 7
// and 8 aren't in it and keep the older estimates.
export const RECOMB_COUNTS = {
  0: { 0: 1 }, 1: { 0: 0.41, 1: 0.59 }, 2: { 1: 2 / 3, 2: 1 / 3 }, 3: { 1: 0.4, 2: 0.5, 3: 0.1 },
  4: { 1: 0.1, 2: 0.6, 3: 0.3 }, 5: { 2: 0.43, 3: 0.57 }, 6: { 2: 0.3, 3: 0.7 }, 7: { 2: 0.3, 3: 0.5, 4: 0.2 },
  8: { 2: 0.1, 3: 0.55, 4: 0.35 },
};
// The bench is paid in Thaumaturgic Dust and gold, neither on the exchange: dust comes from
// disenchanting cheap uniques (100k+ dust per Chaos), gold from playing. Default values per unit,
// editable under "Prices used".
export const DUST = 'Thaumaturgic Dust', GOLD = 'Gold';
export const FARMED_PRICES = { [DUST]: 1 / 100000, [GOLD]: 0 };
// Mods only one of which survives a recombine: crafted, essence, veiled, elevated, beast mods
// and metamods.
function onlyOneSurvivesRecombine(x) {
  if (x.essence || x.crafted || x.veiled || x.elevated || x.m?.meta) {
    return true;
  }
  const src = x.m?.src;
  return src === 'essence' || src === 'veiled' || src === 'bench' || src === 'beast';
}
export const ELDRITCH_TIERS = ['Lesser', 'Greater', 'Grand', 'Exceptional', 'Exquisite', 'Perfect'];
export const CUR = {
  transmute: 'Orb of Transmutation', alt: 'Orb of Alteration', aug: 'Orb of Augmentation', regal: 'Regal Orb',
  alch: 'Orb of Alchemy', chaos: 'Chaos Orb', exalt: 'Exalted Orb', annul: 'Orb of Annulment', scour: 'Orb of Scouring',
  divine: 'Divine Orb', vchaos: 'Veiled Chaos Orb', vexalt: 'Veiled Exalted Orb',
  echaos: 'Eldritch Chaos Orb', eexalt: 'Eldritch Exalted Orb', eannul: 'Eldritch Orb of Annulment',
  conflict: 'Orb of Conflict', dominance: 'Orb of Dominance',
  imprint: 'Craicic Chimeral', wolf: 'Farric Wolf Alpha', lynx: 'Farric Lynx Alpha',
};
export const RESONATORS = ['Primitive Chaotic Resonator', 'Potent Chaotic Resonator', 'Powerful Chaotic Resonator', 'Prime Chaotic Resonator'];
// Fossils on a normal item (Ruthless has no Chaotic Resonators, so fossils only make a normal item rare).
export const ALCH_RESONATORS = ['Primitive Alchemical Resonator', 'Potent Alchemical Resonator', 'Powerful Alchemical Resonator', 'Prime Alchemical Resonator'];
export const ASPECTS = { 'Farrul, First of the Plains': 'Cat', 'Saqawal, First of the Sky': 'Avian', 'Fenumus, First of the Night': 'Spider', 'Craiceann, First of the Deep': 'Crab' };
const SIDE_NAME = { p: 'prefix', s: 'suffix' };
// The plan key for doing a side first.
const SIDE_WAY = { p: 'Prefixes first', s: 'Suffixes first' };

// ---------- data ----------

// Local defence mods: flat or % Armour / Evasion / Energy Shield, and their hybrids.
function isLocalDefenceMod(mod) {
  for (const group of mod.groups) {
    if (/^(DefencesPercent|BaseLocalDefences)/.test(group)) {
      return true;
    }
  }
  return false;
}

// Which defences a mod gives, as one string: "armour", "evasion+energy_shield", ...
function defenceKindOf(mod) {
  const kinds = [];
  for (const defence of ['armour', 'evasion', 'energy_shield']) {
    if (mod.tags.includes(defence)) {
      kinds.push(defence);
    }
  }
  return kinds.join('+');
}

// Turns a base's data file into the base the engine works with:
// {id, name, info, max: {p, s}, slots, mods, byId}.
export function prepareBase(raw, index) {
  const info = index.bases[raw.id];
  const affixesPerSide = index.groups[info.group].maxAffix / 2;

  let mods = [];
  for (const [id, text, affix, src, groups, tags, rawTiers, extra] of raw.mods) {
    const tiers = [];
    for (const [ilvl, w, values] of rawTiers) {
      tiers.push({ ilvl, w, values });
    }
    mods.push({ id, text, affix, src, groups, tags, ...extra, tiers });
  }

  // Local defence mods only go on a base with those defences: the data lists every kind of
  // bench craft and essence mod on every armour base. Keep the kinds the base's own mods roll
  // (a STR/INT base: Armour, Energy Shield, Armour and Energy Shield).
  const kindsOnThisBase = new Set();
  for (const mod of mods) {
    if (mod.src === 'base' && isLocalDefenceMod(mod)) {
      kindsOnThisBase.add(defenceKindOf(mod));
    }
  }
  if (kindsOnThisBase.size > 0) {
    const kept = [];
    for (const mod of mods) {
      if (mod.src === 'base' || !isLocalDefenceMod(mod) || kindsOnThisBase.has(defenceKindOf(mod))) {
        kept.push(mod);
      }
    }
    mods = kept;
  }

  const byId = new Map();
  for (const mod of mods) {
    byId.set(mod.id, mod);
  }
  return { id: raw.id, name: info.name, info, max: { p: affixesPerSide, s: affixesPerSide }, slots: affixesPerSide * 2, mods, byId };
}

// An experimented base item (Heist: Helical Ring, Focused Amulet, ...) as its own base: its
// implicits move the prefix/suffix limits (magic items too: 1 each plus the change, so a
// magic Helical Ring rolls only suffixes, up to two), scale explicit mod values, or give
// every influence (Astrolabe Amulet). Other base items return the base unchanged.
// Base items whose implicit stops mods from rolling (index.limits, from the data build):
// {noTag: 'caster'} is a permanent "Cannot roll Caster Modifiers" (Kinetic, Somatic, Blasting
// Wand); {onlyDamage: 'cold'} is "Cannot roll Modifiers of Non-Cold Damage Types" (Cryonic Ring:
// damage mods of other types can't roll, resistances still can). Bench crafts still work.
const DAMAGE_TYPES = ['fire', 'cold', 'lightning', 'chaos', 'physical'];

// True when the base item's implicit stops this mod from rolling.
export function baseBlocks(B, mod) {
  const limit = B.limit;
  if (!limit || mod.src === 'bench') {
    return false;
  }
  if (limit.noTag && mod.tags.includes(limit.noTag)) {
    return true;
  }
  if (!limit.onlyDamage || !mod.tags.includes('damage')) {
    return false;
  }
  for (const damageType of DAMAGE_TYPES) {
    if (damageType !== limit.onlyDamage && mod.tags.includes(damageType)) {
      return true;
    }
  }
  return false;
}

// Rounds every number in a (nested) list of mod values to 2 decimals.
function roundModValues(value) {
  if (Array.isArray(value)) {
    return value.map(roundModValues);
  }
  if (typeof value === 'number') {
    return Math.round(value * 100) / 100;
  }
  return value;
}

// Multiplies every number in a (nested) list of mod values; whole numbers stay whole.
function scaleModValues(value, factor) {
  if (Array.isArray(value)) {
    return value.map(v => scaleModValues(v, factor));
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? Math.trunc(value * factor) : value * factor;
  }
  return value;
}

export function forBaseItem(B, name, index) {
  const experimented = name ? index.experimented?.[name] : null;
  const limit = name ? index.limits?.[name] ?? null : null;
  if (!experimented && !limit) {
    return B;
  }
  const changes = experimented ?? { p: 0, s: 0 };
  B.variants ??= new Map();
  if (B.variants.has(name)) {
    return B.variants.get(name);
  }

  const max = { p: Math.max(0, B.max.p + changes.p), s: Math.max(0, B.max.s + changes.s) };
  const magnitudeFactor = side => 1 + (changes.mag?.[side] ?? 0) / 100;
  const mods = [];
  for (const mod of B.mods) {
    const isExplicit = mod.affix === 'p' || mod.affix === 's';
    const factor = isExplicit ? magnitudeFactor(mod.affix) : 1;
    if (factor === 1) {
      mods.push(mod);
      continue;
    }
    const tiers = [];
    for (const tier of mod.tiers) {
      const scaled = tier.values.map(v => scaleModValues(v, factor));
      tiers.push({ ...tier, values: roundModValues(scaled) });
    }
    mods.push({ ...mod, tiers });
  }

  const byId = new Map();
  for (const mod of mods) {
    byId.set(mod.id, mod);
  }
  const variant = {
    ...B,
    name,
    item: name,
    exp: experimented,
    max,
    magicMax: { p: Math.max(0, 1 + changes.p), s: Math.max(0, 1 + changes.s) },
    slots: max.p + max.s,
    mods,
    byId,
    innateInfl: changes.allInfl ? [...INFLUENCES] : null,
    limit,
  };
  delete variant.variants;
  B.variants.set(name, variant);
  return variant;
}

// A mod's text with a tier's numbers filled in: "+(80-89) to maximum Life".
export function modText(mod, tierIndex) {
  const tier = mod.tiers[tierIndex] ?? mod.tiers[mod.tiers.length - 1];
  const values = tier.values;
  let nextValue = 0;
  return mod.text.replace(/#/g, () => {
    const value = values[nextValue];
    nextValue++;
    if (value == null) {
      return '#';
    }
    if (Array.isArray(value)) {
      return value[0] === value[1] ? value[0] : `(${value[0]}-${value[1]})`;
    }
    return value;
  });
}

// In-game tier name: T1 is the best tier that can roll at this item level.
export function tierLabel(mod, tierIndex, ilvl = 100) {
  let bestRollable = 0;
  for (let i = 0; i < mod.tiers.length; i++) {
    if (mod.tiers[i].ilvl <= ilvl) {
      bestRollable = i;
    }
  }
  return 'T' + (bestRollable - tierIndex + 1);
}

// ---------- items ----------
export function newItem(B, { ilvl = 86, infl = [], rarity = 'normal' } = {}) {
  return { B, ilvl, infl: [...infl], rarity, mods: [], eld: null, imprint: null, veilOptions: null };
}

export function clone(item) {
  const mods = [];
  for (const x of item.mods) {
    mods.push({ ...x });
  }
  return { ...item, infl: [...item.infl], mods, eld: item.eld && { ...item.eld } };
}

// How many prefixes and suffixes the item can hold.
function maxAffixes(item) {
  if (item.rarity === 'magic') {
    return item.B.magicMax ?? { p: 1, s: 1 };
  }
  return item.B.max;
}

// How many mods the item has on one side ('p' or 's').
export function count(item, side) {
  let n = 0;
  for (const x of item.mods) {
    if (x.side === side) {
      n++;
    }
  }
  return n;
}

// The bench metamods on the item, as flags: {nchg_pre: true, no_attack: true, ...}.
export function metaFlags(item) {
  const flags = {};
  for (const x of item.mods) {
    if (x.m?.meta) {
      flags[x.m.meta] = true;
    }
  }
  return flags;
}

// "Prefixes/Suffixes Cannot Be Changed" on the item protects that side.
function sideIsLocked(item, side) {
  const flags = metaFlags(item);
  if (side === 'p') {
    return !!flags.nchg_pre;
  }
  return !!flags.nchg_suf;
}

function craftedModCount(item) {
  let n = 0;
  for (const x of item.mods) {
    if (x.crafted) {
      n++;
    }
  }
  return n;
}

// Every mod group on the item (a new mod can't share one).
function modGroupsOn(item) {
  const groups = new Set();
  for (const x of item.mods) {
    for (const group of x.m?.groups ?? []) {
      groups.add(group);
    }
  }
  return groups;
}

// Dominant eldritch side: Searing Exarch (red) rules prefixes, Eater of Worlds (blue) suffixes.
export function dominance(item) {
  const eldritch = item.eld;
  if (!eldritch || (!eldritch.r && !eldritch.b)) {
    return null;
  }
  const exarchLevel = eldritch.r ? eldritch.r.t + 1 : 0;
  const eaterLevel = eldritch.b ? eldritch.b.t + 1 : 0;
  if (exarchLevel === eaterLevel) {
    return null;
  }
  return exarchLevel > eaterLevel ? 'p' : 's';
}

// Several fossils combined into one effect: {more: {tag: x}, less: {tag: x}, block: Set, ids: Set}.
function combineFossils(fossils) {
  if (!fossils?.length) {
    return null;
  }
  const combined = { more: {}, less: {}, block: new Set(), ids: new Set() };
  for (const fossil of fossils) {
    combined.ids.add(String(fossil.id));
    for (const [tag, factor] of Object.entries(fossil.more)) {
      combined.more[tag] = (combined.more[tag] ?? 1) * factor;
    }
    for (const [tag, factor] of Object.entries(fossil.less)) {
      combined.less[tag] = (combined.less[tag] ?? 1) * factor;
    }
    for (const tag of fossil.block) {
      combined.block.add(tag);
    }
  }
  return combined;
}

// A fossil tag can be a combination ("ailment+chaos"): the mod needs every part.
function modHasTag(mod, fossilTag) {
  for (const part of fossilTag.split('+')) {
    if (!mod.tags.includes(part)) {
      return false;
    }
  }
  return true;
}

// How much a fossil effect multiplies a mod's weight (0: blocked).
function fossilWeightMultiplier(mod, fossilEffect) {
  if (!mod.tags.length) {
    return fossilEffect.ids.has('23') ? 0 : 1; // Opulent: untagged mods can't roll
  }
  for (const tag of fossilEffect.block) {
    if (modHasTag(mod, tag)) {
      return 0;
    }
  }
  let multiplier = 1;
  for (const [tag, factor] of Object.entries(fossilEffect.more)) {
    if (modHasTag(mod, tag)) {
      multiplier *= factor;
    }
  }
  for (const [tag, factor] of Object.entries(fossilEffect.less)) {
    if (modHasTag(mod, tag)) {
      multiplier *= factor;
    }
  }
  return multiplier;
}

// ----- Choosing which fossil combinations to try -----
//
// Pricing a fossil combination properly is slow, so the planner first ranks every
// combination with a quick score and only prices the best ones.
//
// The quick score: with these fossils in the resonator, what share of its side's pool
// (prefixes or suffixes) does each wanted mod get? The shares of all wanted mods are
// multiplied together (added up as logarithms). A combination that makes every wanted
// mod more likely gets the highest score.
//
// The same score is also worked out for each side's wanted mods alone, and the best
// combinations for one side are kept too: on a big craft the score over every mod is
// dominated by the rarest one, while the usual way is to fossil one side (two gem prefixes
// with Aetheric + Corroded + Metallic + Shuddering), then finish the other side another way.
//
// Fossils that only block count as much as fossils that boost, and they work together:
// Corroded blocks elemental mods, which cancels Metallic's lightning boost, so in that
// pair Metallic just blocks physical mods. That is why whole combinations are scored,
// not each fossil on its own.

const MAX_FOSSILS_PER_RESONATOR = 4;
const FOSSIL_COMBOS_TO_KEEP = 150;
// Also kept: the best combinations for each side's wanted mods alone (when not already kept).
const FOSSIL_COMBOS_TO_KEEP_PER_SIDE = 25;

function fossilBlocksAnyTarget(fossil, targets) {
  for (const target of targets) {
    for (const blockedTag of fossil.block) {
      if (modHasTag(target.m, blockedTag)) {
        return true;
      }
    }
  }
  return false;
}

// The fossils worth trying: they have a price, and they don't block a wanted mod
// (unless the wanted mod needs that very fossil, like Faceted Fossil's gem mods).
function findUsableFossils(allFossils, targets, requiredFossilIds, priceOf) {
  const usable = [];
  for (const fossil of allFossils) {
    if (fossil.forces) {
      continue; // Hollow Fossil (forces an Abyssal Socket) is planned on its own.
    }
    if (!isFinite(priceOf(fossil.name))) {
      continue;
    }
    const isRequired = requiredFossilIds.has(String(fossil.id));
    if (!isRequired && fossilBlocksAnyTarget(fossil, targets)) {
      continue;
    }
    usable.push(fossil);
  }
  return usable;
}

// What one fossil does to each entry of the mod pool: a weight multiplier (0 means blocked).
function fossilMultipliersForPool(fossil, modPool) {
  const fossilEffect = combineFossils([fossil]);
  const multipliers = new Float64Array(modPool.length);
  for (let i = 0; i < modPool.length; i++) {
    multipliers[i] = fossilWeightMultiplier(modPool[i].m, fossilEffect);
  }
  return multipliers;
}

// For each target: the positions in the mod pool that would count as hitting it
// (its mod at its tier or better). Targets that fossils don't roll (the fractured
// one, veiled and essence mods) get an empty list and are left out of the score.
function poolEntriesForEachTarget(targets, modPool, fracturedTargetIndex) {
  const entriesForEachTarget = [];
  for (let k = 0; k < targets.length; k++) {
    const target = targets[k];
    const entries = [];
    const isRolled = target.kind === 'roll' && k !== fracturedTargetIndex;
    if (isRolled) {
      for (let i = 0; i < modPool.length; i++) {
        if (modPool[i].m === target.m && modPool[i].t >= target.minTier) {
          entries.push(i);
        }
      }
    }
    entriesForEachTarget.push(entries);
  }
  return entriesForEachTarget;
}

// The quick score of one combination, given its weight multipliers for the pool.
// Higher is better; -Infinity means the combination makes a wanted mod impossible.
// onlySide: count only the wanted mods on that side ('p' or 's'), each by its estimated chance
// to be on the item after one reforge (see chanceEachGroupIsRolled). A share of the pool
// misleads there: with Aetheric + Corroded + Metallic + Shuddering, Spell Damage is 97% of the
// prefix weight, but it can roll only once, and then the gem prefixes are most of what's left.
// null counts every wanted mod, each as a share of its own side's pool.
// combo: the fossils, for the mods only a fossil rolls (Faceted Fossil's socketed-gem suffixes).
function fossilComboScore(modPool, multipliers, combo, targets, entriesForEachTarget, onlySide = null) {
  const sideWeight = { p: 0, s: 0 };
  for (let i = 0; i < modPool.length; i++) {
    if (modPool[i].m.src === 'fossil' && !comboHasFossil(combo, modPool[i].m.fossil)) {
      continue;
    }
    sideWeight[modPool[i].m.affix] += modPool[i].w * multipliers[i];
  }
  let rolledChance = null;
  if (onlySide) {
    rolledChance = chanceEachEntryIsRolled(modPool, multipliers, combo);
  }
  let score = 0;
  for (let k = 0; k < targets.length; k++) {
    const entries = entriesForEachTarget[k];
    if (entries.length === 0) {
      continue;
    }
    if (onlySide && targets[k].side !== onlySide) {
      continue;
    }
    let targetWeight = 0;
    for (const i of entries) {
      targetWeight += modPool[i].w * multipliers[i];
    }
    if (targetWeight <= 0) {
      return -Infinity;
    }
    let share = targetWeight / sideWeight[targets[k].side];
    if (onlySide) {
      share = 0;
      for (const i of entries) {
        share += rolledChance[i];
      }
    }
    score += Math.log(share);
  }
  return score;
}

// The average number of mods a reforge rolls on a rare item (4, 5 or 6 at 8/12, 3/12, 1/12).
const AVERAGE_RARE_MOD_COUNT = 4 * 8 / 12 + 5 * 3 / 12 + 6 * 1 / 12;
const MAX_MODS_PER_SIDE = 3;

// A mod group's key for the estimate below (a mod in no group is its own group).
function modGroupKey(mod) {
  if (mod.groups.length > 0) {
    return mod.groups[0];
  }
  return 'mod ' + mod.id;
}

// The estimated chance that each pool entry is on the item after one fossil reforge. A reforge
// picks mods by weight, one per mod group, so it's weighted picking without putting back. The
// usual estimate for that: group g is picked with chance 1 - e^(-W_g t), t chosen so the chances
// add up to the number of mods picked. First over both sides, for how many mods each side gets;
// a side can't take more than 3, so the rest go to the other side (a fossil that makes suffixes
// very likely fills the suffixes and so forces the remaining mods to be prefixes). Then per side
// with that many mods; an entry gets its share of its group's chance.
function chanceEachEntryIsRolled(modPool, multipliers, combo) {
  const groupWeight = { p: new Map(), s: new Map() };
  const entryWeight = new Float64Array(modPool.length);
  for (let i = 0; i < modPool.length; i++) {
    if (modPool[i].m.src === 'fossil' && !comboHasFossil(combo, modPool[i].m.fossil)) {
      continue;
    }
    entryWeight[i] = modPool[i].w * multipliers[i];
    const side = modPool[i].m.affix;
    const key = modGroupKey(modPool[i].m);
    groupWeight[side].set(key, (groupWeight[side].get(key) ?? 0) + entryWeight[i]);
  }
  const weightsOn = side => [...groupWeight[side].values()].filter(w => w > 0);
  const bothSides = weightsOn('p').concat(weightsOn('s'));
  const t = pickingRate(bothSides, AVERAGE_RARE_MOD_COUNT);

  const modsOnSide = {};
  for (const side of ['p', 's']) {
    let picks = 0;
    for (const w of weightsOn(side)) {
      picks += 1 - Math.exp(-w * t);
    }
    modsOnSide[side] = picks;
  }
  for (const [side, otherSide] of [['s', 'p'], ['p', 's']]) {
    if (modsOnSide[side] > MAX_MODS_PER_SIDE) {
      modsOnSide[otherSide] += modsOnSide[side] - MAX_MODS_PER_SIDE;
      modsOnSide[side] = MAX_MODS_PER_SIDE;
    }
  }
  const rateOnSide = {
    p: pickingRate(weightsOn('p'), modsOnSide.p),
    s: pickingRate(weightsOn('s'), modsOnSide.s),
  };

  const chances = new Float64Array(modPool.length);
  for (let i = 0; i < modPool.length; i++) {
    if (entryWeight[i] <= 0) {
      continue;
    }
    const side = modPool[i].m.affix;
    const w = groupWeight[side].get(modGroupKey(modPool[i].m));
    chances[i] = (1 - Math.exp(-w * rateOnSide[side])) * entryWeight[i] / w;
  }
  return chances;
}

// The t for which the groups' chances 1 - e^(-w t) add up to picks (all of them when picks is
// as many as there are groups). Found by halving: the sum grows with t.
function pickingRate(groupWeights, picks) {
  if (groupWeights.length === 0 || picks <= 0) {
    return 0;
  }
  const wanted = Math.min(picks, groupWeights.length - 1e-9);
  const expectedPicks = t => {
    let total = 0;
    for (const w of groupWeights) {
      total += 1 - Math.exp(-w * t);
    }
    return total;
  };
  let low = 0;
  let high = 1;
  while (expectedPicks(high) < wanted && high < 1e300) {
    high *= 2;
  }
  for (let step = 0; step < 60; step++) {
    const middle = (low + high) / 2;
    if (expectedPicks(middle) < wanted) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
}

function comboHasFossil(combo, fossilId) {
  for (const fossil of combo) {
    if (String(fossil.id) === String(fossilId)) {
      return true;
    }
  }
  return false;
}

// The pool of a new rare item, plus the mods only a fossil rolls (from any of these fossils,
// at their plain weight): the quick score counts those only for combinations with that fossil.
function freshRarePoolWithFossilMods(B, ilvl, infl, fossils) {
  const item = newItem(B, { ilvl, infl, rarity: 'rare' });
  const entries = pool(item);
  for (const fossil of fossils) {
    const plainFossil = { ...fossil, more: {}, less: {}, block: [] };
    for (const entry of pool(item, { fossils: [plainFossil] })) {
      if (entry.m.src === 'fossil') {
        entries.push(entry);
      }
    }
  }
  return entries;
}

function comboHasRequiredFossils(combo, requiredFossilIds) {
  for (const requiredId of requiredFossilIds) {
    let found = false;
    for (const fossil of combo) {
      if (String(fossil.id) === requiredId) {
        found = true;
      }
    }
    if (!found) {
      return false;
    }
  }
  return true;
}

// Every combination of 1 to 4 usable fossils, best quick score first; returns the best
// FOSSIL_COMBOS_TO_KEEP of them, then the best FOSSIL_COMBOS_TO_KEEP_PER_SIDE for each side's
// wanted mods alone, each as an array of fossils.
function rankFossilCombos({ fossils, modPool, targets, fracturedTargetIndex, requiredFossilIds }) {
  const multipliersForEachFossil = [];
  for (const fossil of fossils) {
    multipliersForEachFossil.push(fossilMultipliersForPool(fossil, modPool));
  }
  const entriesForEachTarget = poolEntriesForEachTarget(targets, modPool, fracturedTargetIndex);

  // Only a side with a wanted mod that fossils roll gets its own ranking.
  const sidesToRank = [];
  for (const side of ['p', 's']) {
    let rolledOnSide = 0;
    for (let k = 0; k < targets.length; k++) {
      if (targets[k].side === side && entriesForEachTarget[k].length > 0) {
        rolledOnSide++;
      }
    }
    // (A side whose rolled mods are all the rolled mods ranks the same as the whole score.)
    const rolledInAll = entriesForEachTarget.filter(entries => entries.length > 0).length;
    if (rolledOnSide > 0 && rolledOnSide < rolledInAll) {
      sidesToRank.push(side);
    }
  }

  const scoredCombos = [];
  // Builds the combinations one fossil at a time, in list order (so each one appears once).
  // comboMultipliers: the combined weight multipliers of the fossils already in the combo.
  function addCombosStartingWith(combo, comboMultipliers, nextFossilIndex) {
    if (combo.length > 0 && comboHasRequiredFossils(combo, requiredFossilIds)) {
      const score = fossilComboScore(modPool, comboMultipliers, combo, targets, entriesForEachTarget);
      if (isFinite(score)) {
        const scoreBySide = {};
        for (const side of sidesToRank) {
          scoreBySide[side] = fossilComboScore(modPool, comboMultipliers, combo, targets, entriesForEachTarget, side);
        }
        scoredCombos.push({ combo, score, scoreBySide });
      }
    }
    if (combo.length === MAX_FOSSILS_PER_RESONATOR) {
      return;
    }
    for (let f = nextFossilIndex; f < fossils.length; f++) {
      const newMultipliers = new Float64Array(modPool.length);
      for (let i = 0; i < modPool.length; i++) {
        newMultipliers[i] = comboMultipliers[i] * multipliersForEachFossil[f][i];
      }
      addCombosStartingWith([...combo, fossils[f]], newMultipliers, f + 1);
    }
  }
  const noFossils = new Float64Array(modPool.length).fill(1);
  addCombosStartingWith([], noFossils, 0);

  scoredCombos.sort((a, b) => b.score - a.score);
  const bestCombos = [];
  const kept = new Set();
  for (let i = 0; i < scoredCombos.length && i < FOSSIL_COMBOS_TO_KEEP; i++) {
    bestCombos.push(scoredCombos[i].combo);
    kept.add(scoredCombos[i]);
  }
  for (const side of sidesToRank) {
    const bestForSide = [...scoredCombos].sort((a, b) => b.scoreBySide[side] - a.scoreBySide[side]);
    let addedForSide = 0;
    for (const scored of bestForSide) {
      if (addedForSide >= FOSSIL_COMBOS_TO_KEEP_PER_SIDE) {
        break;
      }
      if (kept.has(scored) || !isFinite(scored.scoreBySide[side])) {
        continue;
      }
      bestCombos.push(scored.combo);
      kept.add(scored);
      addedForSide++;
    }
  }
  return bestCombos;
}

// Everything that can roll on the item right now: [{m, t, w}] (mod, tier index, weight).
// opts: {src: mod sources, fossils, side: only 'p' or 's', tagOnly: only mods with this tag,
// tagMult: Harvest "more likely" type (x10), boost: Set of mods made x10 more likely,
// reforge: true for a reforge}.
// Game rules (don't model them otherwise):
// - Explicit vs implicit "Cannot roll ...": the explicit one is a bench metamod (meta.no_caster,
//   meta.no_attack below). Any form of reforge (Chaos, Alteration, Essence, Fossils, Veiled Chaos,
//   Eldritch Chaos, Harvest reforges) ignores it: only slams (Exalted Orb, Harvest add, ...) and
//   Orb of Annulment respect it. The implicit one is the base item's own (Kinetic, Somatic,
//   Blasting Wand: "Cannot roll Caster Modifiers"; baseBlocks below): those bases never roll
//   such mods, so it holds for every roll, reforges included, and reforging stays an option.
// - Essences don't respect metamods at all ("Prefixes/Suffixes Cannot Be Changed" doesn't keep a
//   side through an essence), so there is no lock + essence reforge.
export function pool(item, opts = {}) {
  const max = maxAffixes(item);
  const groupsTaken = modGroupsOn(item);
  const meta = metaFlags(item);
  const sideHasRoom = { p: count(item, 'p') < max.p, s: count(item, 's') < max.s };
  const sources = new Set(opts.src ?? ['base', ...item.infl]);
  const fossilEffect = combineFossils(opts.fossils);
  if (fossilEffect) {
    sources.add('fossil');
  }

  const entries = [];
  for (const mod of item.B.mods) {
    if (!sources.has(mod.src)) {
      continue;
    }
    if (mod.affix !== 'p' && mod.affix !== 's') {
      continue; // implicits
    }
    if (!sideHasRoom[mod.affix]) {
      continue;
    }
    if (opts.side && mod.affix !== opts.side) {
      continue;
    }
    if (mod.src === 'fossil' && !(fossilEffect && fossilEffect.ids.has(String(mod.fossil)))) {
      continue; // a fossil-only mod needs its own fossil
    }
    if (mod.groups.some(group => groupsTaken.has(group))) {
      continue;
    }
    if (!opts.reforge && meta.no_attack && mod.tags.includes('attack')) {
      continue;
    }
    if (!opts.reforge && meta.no_caster && mod.tags.includes('caster')) {
      continue;
    }
    if (baseBlocks(item.B, mod)) {
      continue;
    }
    if (opts.tagOnly && !mod.tags.includes(opts.tagOnly)) {
      continue;
    }

    let multiplier = 1;
    if (fossilEffect && mod.src !== 'veiled') {
      multiplier = fossilWeightMultiplier(mod, fossilEffect);
    }
    if (opts.tagMult && mod.tags.includes(opts.tagMult)) {
      multiplier *= 10; // Harvest: that type is more common
    }
    if (opts.boost?.has(mod)) {
      multiplier *= 10; // Harvest "more likely": the same mod types as before
    }
    if (!multiplier) {
      continue;
    }
    for (let t = 0; t < mod.tiers.length; t++) {
      const tier = mod.tiers[t];
      if (tier.ilvl <= item.ilvl && tier.w > 0) {
        entries.push({ m: mod, t, w: tier.w * multiplier });
      }
    }
  }
  return entries;
}

// One random entry, weighted by w.
function pick(entries, rnd) {
  let total = 0;
  for (const entry of entries) {
    total += entry.w;
  }
  let x = rnd() * total;
  for (const entry of entries) {
    x -= entry.w;
    if (x < 0) {
      return entry;
    }
  }
  return entries[entries.length - 1];
}

// One random value from a distribution [[value, chance], ...].
function pickFromDistribution(distribution, rnd) {
  let x = rnd();
  for (const [value, chance] of distribution) {
    x -= chance;
    if (x < 0) {
      return value;
    }
  }
  return distribution[distribution.length - 1][0];
}

// Adds up to n random mods (fewer if the pool runs out); returns the mods added.
function addRandom(item, n, opts, rnd) {
  const added = [];
  for (let i = 0; i < n; i++) {
    const entries = pool(item, opts);
    if (!entries.length) {
      break;
    }
    const entry = pick(entries, rnd);
    const newMod = { m: entry.m, t: entry.t, side: entry.m.affix };
    item.mods.push(newMod);
    added.push(newMod);
  }
  return added;
}

// The mods a removal can take: not fractured, not on a locked side (and on `side`, if given).
function removableMods(item, side) {
  const removable = [];
  for (const x of item.mods) {
    if (x.frac) {
      continue;
    }
    if (side && x.side !== side) {
      continue;
    }
    if (sideIsLocked(item, x.side)) {
      continue;
    }
    removable.push(x);
  }
  return removable;
}

// The mod types an Orb of Annulment can't remove on this item: "Cannot roll Caster Modifiers"
// keeps caster mods, "Cannot roll Attack Modifiers" attack mods. (Annulment respects these
// metamods on explicit mods; reforges, which reroll the whole unlocked item, don't.)
function annulProtectedTags(item) {
  const flags = metaFlags(item);
  const tags = [];
  if (flags.no_caster) {
    tags.push('caster');
  }
  if (flags.no_attack) {
    tags.push('attack');
  }
  return tags;
}

// Removes one random removable mod; returns it, or null if there was none. protectedTags: mods
// with any of these tags stay (see annulProtectedTags).
function removeRandom(item, rnd, side, protectedTags = []) {
  const removable = [];
  for (const x of removableMods(item, side)) {
    if (x.m && protectedTags.some(tag => x.m.tags.includes(tag))) {
      continue;
    }
    removable.push(x);
  }
  if (!removable.length) {
    return null;
  }
  const removed = removable[Math.floor(rnd() * removable.length)];
  item.mods.splice(item.mods.indexOf(removed), 1);
  return removed;
}

// Clears the item for a reroll: keeps what is fractured, protected by a bench metamod, or
// picked by keepFilter.
function reroll(item, keepFilter = () => false) {
  const kept = [];
  for (const x of item.mods) {
    if (x.frac || sideIsLocked(item, x.side) || keepFilter(x)) {
      kept.push(x);
    }
  }
  item.mods = kept;
}

// How many mods a new rare item gets (random).
function rareModCount(item, rnd) {
  return pickFromDistribution(RARE_COUNTS[item.B.slots] ?? RARE_COUNTS[6], rnd);
}

// ---------- currency actions ----------
//
// apply(item, action, arg, rnd) uses one currency on an item, like the game, and returns
// {ok, msg, spent: {currency name: how many}}. The item is changed in place; pass
// clone(item) to keep the original.
//
// Each action below is its own function: (item, arg, rnd, receipt) -> result. The receipt
// collects what was spent; failed() results spend nothing.

function newReceipt() {
  const receipt = { spent: {} };
  receipt.pay = (name, amount = 1) => {
    receipt.spent[name] = (receipt.spent[name] ?? 0) + amount;
  };
  return receipt;
}

function failed(msg) {
  return { ok: false, msg, spent: {} };
}

function succeeded(msg, receipt) {
  return { ok: true, msg, spent: receipt.spent };
}

function hasVeiledMod(item) {
  return item.mods.some(x => x.veiled);
}

// Essences and fossils refuse an item with a metamod ("Can have up to 3 Crafted Modifiers"
// is the exception).
function hasMetamodOtherThanMultimod(item) {
  return item.mods.some(x => x.m?.meta && x.m.meta !== 'mul_mods');
}

// How many random mods to add so a reforged rare gets its random mod count.
function modsToFillRare(item, rnd) {
  return Math.max(0, rareModCount(item, rnd) - item.mods.length);
}

// The side that "Prefixes/Suffixes Cannot Be Changed" leaves open, or undefined with no lock.
function unlockedSideOf(item) {
  if (sideIsLocked(item, 'p')) {
    return 's';
  }
  if (sideIsLocked(item, 's')) {
    return 'p';
  }
  return undefined;
}

// The sides with room for one more mod.
function sidesWithRoom(item) {
  const sides = [];
  for (const side of ['p', 's']) {
    if (count(item, side) < item.B.max[side]) {
      sides.push(side);
    }
  }
  return sides;
}

function applyTransmute(item, arg, rnd, receipt) {
  if (item.rarity !== 'normal') {
    return failed('Needs a normal item');
  }
  item.rarity = 'magic';
  addRandom(item, 1, {}, rnd);
  receipt.pay(CUR.transmute);
  return succeeded('Now magic', receipt);
}

function applyAlteration(item, arg, rnd, receipt) {
  if (item.rarity !== 'magic') {
    return failed('Needs a magic item');
  }
  reroll(item);
  addRandom(item, pickFromDistribution(MAGIC_COUNTS, rnd), { reforge: true }, rnd);
  receipt.pay(CUR.alt);
  return succeeded('Rerolled the magic mods', receipt);
}

function applyAugmentation(item, arg, rnd, receipt) {
  if (item.rarity !== 'magic' || item.mods.length >= 2) {
    return failed('Needs a magic item with one mod');
  }
  addRandom(item, 1, {}, rnd);
  receipt.pay(CUR.aug);
  return succeeded('Added a mod', receipt);
}

function applyRegal(item, arg, rnd, receipt) {
  if (item.rarity !== 'magic') {
    return failed('Needs a magic item');
  }
  item.rarity = 'rare';
  addRandom(item, 1, {}, rnd);
  receipt.pay(CUR.regal);
  return succeeded('Now rare, one mod added', receipt);
}

function applyAlchemy(item, arg, rnd, receipt) {
  if (item.rarity !== 'normal') {
    return failed('Needs a normal item');
  }
  item.rarity = 'rare';
  addRandom(item, rareModCount(item, rnd), {}, rnd);
  receipt.pay(CUR.alch);
  return succeeded('Now rare', receipt);
}

function applyChaos(item, arg, rnd, receipt) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  // A locked side keeps its mods, but new ones can still land in its free slots.
  reroll(item);
  addRandom(item, modsToFillRare(item, rnd), { reforge: true }, rnd);
  receipt.pay(CUR.chaos);
  return succeeded('Rerolled', receipt);
}

function applyExalt(item, arg, rnd, receipt) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  const added = addRandom(item, 1, {}, rnd);
  if (!added.length) {
    return failed('No room for another mod');
  }
  receipt.pay(CUR.exalt);
  return succeeded('Added a mod', receipt);
}

function applyAnnul(item, arg, rnd, receipt) {
  if (item.rarity === 'normal') {
    return failed('Needs a magic or rare item');
  }
  if (!removeRandom(item, rnd, undefined, annulProtectedTags(item))) {
    return failed('Nothing that can be removed');
  }
  receipt.pay(CUR.annul);
  return succeeded('Removed a random mod', receipt);
}

// Wild Bristle Matron: a random craftable metamod that fits.
function applyMatron(item, arg, rnd, receipt) {
  const flags = metaFlags(item);
  if (item.rarity === 'normal') {
    return failed('Needs a magic or rare item');
  }
  const craftedLimit = flags.mul_mods ? 3 : 1;
  if (craftedModCount(item) >= craftedLimit) {
    return failed('Already has a crafted mod');
  }
  const fitting = [];
  for (const mod of item.B.mods) {
    if (mod.meta && mod.src === 'bench' && !flags[mod.meta] && count(item, mod.affix) < maxAffixes(item)[mod.affix]) {
      fitting.push(mod);
    }
  }
  if (!fitting.length) {
    return failed('No metamod fits');
  }
  const metamod = fitting[Math.floor(rnd() * fitting.length)];
  item.mods.push({ m: metamod, t: 0, side: metamod.affix, crafted: true });
  receipt.pay(MATRON);
  return succeeded('Matron added "' + metamod.text + '"', receipt);
}

// Harvest: change a resistance into another element (arg: 'Fire', 'Cold' or 'Lightning').
function applyHarvestResistanceSwap(item, element, rnd, receipt) {
  const from = item.mods.find(x => x.m && !x.frac && x.m.src === 'base' && RES_RE.test(x.m.text) && !x.m.text.includes(element));
  if (!from) {
    return failed(`No other single resistance to change into ${element}`);
  }
  const to = item.B.mods.find(mod => mod.src === 'base' && mod.affix === from.m.affix && mod.text === `+#% to ${element} Resistance`);
  if (!to || item.mods.some(x => x.m === to)) {
    return failed(`Already has ${element} resistance`);
  }
  // Same distance from the top tier.
  const tiersFromTop = from.m.tiers.length - from.t;
  from.m = to;
  from.t = Math.max(0, to.tiers.length - tiersFromTop);
  receipt.pay(lifeforce(RES_SWAP[element]), RES_SWAP_AMOUNT);
  return succeeded(`Changed to ${element} resistance`, receipt);
}

// Harvest + Crystallised Rancour: change a fire/cold/lightning damage mod into arg's element.
function applyHarvestDamageSwap(item, element, rnd, receipt) {
  const from = item.mods.find(x => x.m && !x.frac && damageSwap(item.B, x.m, element) && !item.mods.some(y => y.m === damageSwap(item.B, x.m, element)));
  if (!from) {
    return failed(`No other elemental damage mod to change into ${element}`);
  }
  const to = damageSwap(item.B, from.m, element);
  from.t = swapTier(from.m, from.t, to);
  from.m = to;
  receipt.pay(lifeforce(RES_SWAP[element]), RES_SWAP_AMOUNT);
  receipt.pay(RANCOUR, DMG_SWAP_RANCOUR);
  return succeeded(`Changed to ${element} damage: ${modText(from.m, from.t)}`, receipt);
}

function applyFracture(item, arg, rnd, receipt) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  if (item.mods.some(x => x.frac)) {
    return failed('Already fractured');
  }
  if (item.infl.length) {
    return failed("Fracturing Orbs can't be used on influenced items");
  }
  const candidates = item.mods.filter(x => x.m && !x.crafted && !x.veiled);
  if (candidates.length < 4) {
    return failed('Needs at least 4 mods');
  }
  const fractured = candidates[Math.floor(rnd() * candidates.length)];
  fractured.frac = true;
  receipt.pay('Fracturing Orb');
  return succeeded('Fractured: ' + modText(fractured.m, fractured.t), receipt);
}

// Harvest reforge with one guaranteed mod of a type (arg: tag); that type is also more common.
function applyHarvestReforge(item, tag, rnd, receipt) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  if (!HARVEST_REFORGE[tag]) {
    return failed('Unknown type');
  }
  // Harvest respects "Prefixes/Suffixes Cannot Be Changed": the locked side stays.
  // (New mods, the guaranteed one too, can also land in the locked side's free slots.)
  reroll(item);
  const modCount = rareModCount(item, rnd);
  const guaranteed = addRandom(item, 1, { tagOnly: tag, reforge: true }, rnd);
  if (!guaranteed.length) {
    return failed('No mod of that type can roll');
  }
  addRandom(item, Math.max(0, modCount - item.mods.length), { tagMult: tag, reforge: true }, rnd);
  const [colour, amount, rancour] = HARVEST_REFORGE[tag];
  receipt.pay(lifeforce(colour), amount);
  if (rancour) {
    receipt.pay(RANCOUR, rancour);
  }
  return succeeded(`Harvest reforge (${tag})`, receipt);
}

// Harvest: add a new mod of a type (arg: tag) and remove another random mod.
function applyHarvestAdd(item, tag, rnd, receipt) {
  if (item.rarity === 'normal') {
    return failed('Needs a magic or rare item');
  }
  if (item.infl.length) {
    return failed('Only works on non-influenced items');
  }
  if (!HARVEST_ADD[tag]) {
    return failed('No add craft for that type');
  }
  // The new mod goes on first, then another random mod goes (never the new one). The craft
  // needs an empty slot for the new mod, so it never adds to the mod count and can't fill the item.
  if (!sidesWithRoom(item).length) {
    return failed('No room for another mod');
  }
  const modsBefore = item.mods.slice();
  const [added] = addRandom(item, 1, { tagOnly: tag }, rnd);
  if (!added) {
    return failed(`No ${tag} mod can roll here`);
  }
  const newMod = item.mods[item.mods.length - 1];
  item.mods.splice(item.mods.length - 1, 1); // keep the new mod out of the removal
  const removed = removeRandom(item, rnd);
  item.mods.push(newMod);
  if (!removed) {
    item.mods = modsBefore;
    return failed('Nothing else that can be removed');
  }
  const [colour, amount] = HARVEST_ADD[tag];
  receipt.pay(lifeforce(colour), amount);
  receipt.pay(SACRED);
  const removedText = removed.veiled ? 'veiled mod' : modText(removed.m, removed.t);
  return succeeded(`Harvest: added a ${tag} mod, removed "${removedText}"`, receipt);
}

// Crusader's/Hunter's/... Exalted Orb (arg: influence): adds the influence and one of its mods.
function applyInfluencedExalt(item, influence, rnd, receipt) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  if (item.infl.length) {
    return failed('Only works on non-influenced items');
  }
  if (item.mods.some(x => x.frac)) {
    return failed("Influenced Exalted Orbs don't work on fractured items");
  }
  const influencesBefore = item.infl;
  item.infl = [influence];
  const added = addRandom(item, 1, { src: [influence] }, rnd);
  if (!added.length) {
    item.infl = influencesBefore;
    return failed(`No ${influence} mod fits`);
  }
  receipt.pay(influenceExalt(influence));
  return succeeded(`Added ${influence} influence and an influenced mod`, receipt);
}

// Harvest: randomise the influence types, and reforge the item.
function applyHarvestRandomiseInfluence(item, arg, rnd, receipt) {
  if (!item.infl.length) {
    return failed('Needs an influenced item');
  }
  const remaining = INFLUENCES.slice();
  const influenceCount = item.infl.length;
  item.infl = [];
  while (item.infl.length < influenceCount) {
    const chosen = remaining.splice(Math.floor(rnd() * remaining.length), 1)[0];
    item.infl.push(chosen);
  }
  if (item.rarity !== 'normal') {
    item.mods = item.mods.filter(x => x.frac);
    let toAdd;
    if (item.rarity === 'magic') {
      toAdd = Math.max(0, pickFromDistribution(MAGIC_COUNTS, rnd) - item.mods.length);
    } else {
      toAdd = modsToFillRare(item, rnd);
    }
    addRandom(item, toAdd, {}, rnd);
  }
  receipt.pay(lifeforce(INFLUENCE_RANDOMISE[0]), INFLUENCE_RANDOMISE[1]);
  const reforged = item.rarity === 'normal' ? '' : ', mods reforged';
  return succeeded(`Influence is now ${item.infl.join(' + ')}${reforged}`, receipt);
}

// Harvest: reforge an influenced rare, with at least one influenced mod.
function applyHarvestInfluencedReforge(item, arg, rnd, receipt) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  if (!item.infl.length) {
    return failed('Needs an influenced item');
  }
  const side = unlockedSideOf(item);
  const modsBefore = item.mods.slice();
  reroll(item);
  const modCount = rareModCount(item, rnd);
  const guaranteed = addRandom(item, 1, { src: item.infl, side, reforge: true }, rnd);
  if (!guaranteed.length) {
    item.mods = modsBefore;
    return failed('No influenced mod can roll');
  }
  addRandom(item, Math.max(0, modCount - item.mods.length), { side, reforge: true }, rnd);
  receipt.pay(lifeforce(HARVEST_INFLUENCE[0]), HARVEST_INFLUENCE[1]);
  receipt.pay(SACRED);
  return succeeded('Harvest reforge with an influenced mod', receipt);
}

// Awakener's Orb with another item. arg: the other item's influence, or {infl, mod, tier}
// for the influenced mod that item has.
function applyAwakener(item, arg, rnd, receipt) {
  const otherInfluence = typeof arg === 'string' ? arg : arg.infl;
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  if (item.infl.length !== 1) {
    return failed('Needs an item with exactly one influence');
  }
  if (item.infl.includes(otherInfluence)) {
    return failed(`Already ${otherInfluence}-influenced`);
  }
  if (item.mods.some(x => x.frac)) {
    return failed("The Awakener's Orb doesn't work on fractured items");
  }
  // One influenced mod from each item (random if an item has several).
  const ownInfluenced = item.mods.filter(x => x.m && item.infl.includes(x.m.src));
  const kept = ownInfluenced.length ? [ownInfluenced[Math.floor(rnd() * ownInfluenced.length)]] : [];
  item.infl = [item.infl[0], otherInfluence];
  item.mods = [...item.mods.filter(x => x.frac && !kept.includes(x)), ...kept];

  let theirs = null;
  if (arg.mod) {
    theirs = { m: arg.mod, t: arg.tier ?? 0, side: arg.mod.affix };
  } else {
    const [rolled] = addRandom(item, 1, { src: [otherInfluence] }, rnd);
    if (rolled) {
      item.mods.pop();
      theirs = rolled;
    }
  }
  // Two kept mods of the same mod group: one of them is dropped at random.
  if (theirs && kept.length && theirs.m.groups.some(g => kept[0].m.groups.includes(g))) {
    if (rnd() < 0.5) {
      item.mods = item.mods.filter(x => x !== kept[0]);
    } else {
      theirs = null;
    }
  }
  if (theirs) {
    item.mods.push(theirs);
  }
  addRandom(item, modsToFillRare(item, rnd), {}, rnd);
  receipt.pay(AWAKENER);

  const keptNames = [];
  for (const x of [...kept, theirs]) {
    if (x && item.mods.includes(x)) {
      keptNames.push(`"${modText(x.m, x.t)}"`);
    }
  }
  const keptText = keptNames.length ? keptNames.join(' and ') : 'no influenced mod';
  return succeeded(`Now ${item.infl.join(' + ')}: kept ${keptText}; the rest reforged`, receipt);
}

// Harvest: reforge, much more likely to get the same mod types.
function applyHarvestMoreLikely(item, arg, rnd, receipt) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  const boost = new Set();
  for (const x of item.mods) {
    if (x.m && !x.frac) {
      boost.add(x.m);
    }
  }
  const side = unlockedSideOf(item);
  reroll(item);
  addRandom(item, modsToFillRare(item, rnd), { boost, side, reforge: true }, rnd);
  receipt.pay(lifeforce(HARVEST_MORE_LIKELY[0]), HARVEST_MORE_LIKELY[1]);
  return succeeded('Harvest reforge, more likely the same types', receipt);
}

function applyScour(item, arg, rnd, receipt) {
  if (item.rarity === 'normal') {
    return failed('Already normal');
  }
  reroll(item, () => false);
  if (!item.mods.length) {
    item.rarity = 'normal';
  }
  receipt.pay(CUR.scour);
  return succeeded(item.mods.length ? 'Removed the unprotected side' : 'Now normal', receipt);
}

// arg: {mod, tier, name}: the essence's mod and its name.
function applyEssence(item, essence, rnd, receipt) {
  if (hasMetamodOtherThanMultimod(item)) {
    return failed('Essences can\'t be used on an item with a metamod');
  }
  if (item.rarity === 'magic') {
    return failed('Needs a normal or rare item');
  }
  reroll(item, () => false);
  item.mods = item.mods.filter(x => x.frac);
  if (item.mods.some(x => x.m.groups.some(g => essence.mod.groups.includes(g)))) {
    return failed('A fractured mod blocks this essence');
  }
  item.rarity = 'rare';
  item.mods.push({ m: essence.mod, t: essence.tier, side: essence.mod.affix, essence: true });
  // The other mods roll as if the item were at most this level.
  const levelCap = ESSENCE_MOD_LEVEL[essence.mod.essence];
  const realItemLevel = item.ilvl;
  if (levelCap) {
    item.ilvl = Math.min(item.ilvl, levelCap);
  }
  addRandom(item, modsToFillRare(item, rnd), { reforge: true }, rnd);
  item.ilvl = realItemLevel;
  receipt.pay(essence.name);
  if (levelCap) {
    return succeeded(`Reforged with the essence mod (other mods level ${levelCap} and below)`, receipt);
  }
  return succeeded('Reforged with the essence mod', receipt);
}

// arg: the fossils in the resonator, or { fossils, ruthless }. Ruthless has no Chaotic Resonators:
// an Alchemical Resonator only works on a normal item, so a rare one is scoured first (its
// fractured mods stay), the way the planner prices it.
function applyFossils(item, arg, rnd, receipt) {
  let fossils = arg;
  let ruthless = false;
  if (!Array.isArray(arg)) {
    fossils = arg.fossils;
    ruthless = !!arg.ruthless;
  }
  if (hasMetamodOtherThanMultimod(item)) {
    return failed('Fossils can\'t be used on an item with a metamod');
  }
  if (item.rarity === 'magic') {
    return failed('Needs a normal or rare item');
  }
  const needsScour = ruthless && item.rarity !== 'normal';
  item.rarity = 'rare';
  item.mods = item.mods.filter(x => x.frac);
  addRandom(item, modsToFillRare(item, rnd), { fossils, reforge: true }, rnd);
  if (needsScour) {
    receipt.pay(CUR.scour);
  }
  for (const fossil of fossils) {
    receipt.pay(fossil.name);
  }
  if (fossils.length > 0) {
    let resonators = RESONATORS;
    if (ruthless) {
      resonators = ALCH_RESONATORS;
    }
    receipt.pay(resonators[fossils.length - 1]);
  }
  if (needsScour) {
    return succeeded('Scoured, then reforged with fossils', receipt);
  }
  return succeeded('Reforged with fossils', receipt);
}

function applyVeiledChaos(item, arg, rnd, receipt) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  if (hasVeiledMod(item)) {
    return failed('Unveil the veiled mod first');
  }
  reroll(item);
  const open = sidesWithRoom(item);
  if (!open.length) {
    return failed('No room for a veiled mod');
  }
  const side = open[Math.floor(rnd() * open.length)];
  item.mods.push({ m: null, t: 0, side, veiled: true });
  addRandom(item, modsToFillRare(item, rnd), { reforge: true }, rnd);
  receipt.pay(CUR.vchaos);
  return succeeded(`Rerolled with a veiled ${SIDE_NAME[side]}`, receipt);
}

function applyVeiledExalt(item, arg, rnd, receipt) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  if (hasVeiledMod(item)) {
    return failed('Unveil the veiled mod first');
  }
  // The veiled mod goes on first (so it needs an open slot), then another random mod goes
  // (never the veiled one). The mod count never goes up, so it can't fill the last slot.
  const open = sidesWithRoom(item);
  if (!open.length) {
    return failed('No room for a veiled mod');
  }
  if (!removableMods(item).length) {
    return failed('Nothing that can be removed');
  }
  const side = open[Math.floor(rnd() * open.length)];
  removeRandom(item, rnd);
  item.mods.push({ m: null, t: 0, side, veiled: true });
  receipt.pay(CUR.vexalt);
  return succeeded(`Removed a mod, added a veiled ${SIDE_NAME[side]}`, receipt);
}

// Unveiling offers 3 veiled mods for the veiled slot (unveilPick takes one).
function applyUnveil(item, arg, rnd, receipt) {
  const veiled = item.mods.find(x => x.veiled);
  if (!veiled) {
    return failed('No veiled mod');
  }
  const groupsTaken = modGroupsOn(item);
  let candidates = [];
  for (const mod of item.B.mods) {
    if (mod.src !== 'veiled' || mod.affix !== veiled.side) {
      continue;
    }
    if (mod.groups.some(g => groupsTaken.has(g)) || baseBlocks(item.B, mod)) {
      continue;
    }
    const weight = mod.tiers[0].w;
    if (weight > 0) {
      candidates.push({ m: mod, t: 0, w: weight });
    }
  }
  const offers = [];
  while (offers.length < 3 && candidates.length) {
    const offered = pick(candidates, rnd);
    offers.push(offered.m);
    candidates = candidates.filter(x => x.m !== offered.m);
  }
  item.veilOptions = offers;
  return succeeded('Pick one of the offered mods', receipt);
}

// arg: which of the offered mods (0, 1 or 2).
function applyUnveilPick(item, choice, rnd, receipt) {
  const veiled = item.mods.find(x => x.veiled);
  const chosen = item.veilOptions?.[choice];
  if (!veiled || !chosen) {
    return failed('Unveil first');
  }
  Object.assign(veiled, { m: chosen, t: 0, veiled: false, unveiled: true });
  item.veilOptions = null;
  return succeeded('Unveiled', receipt);
}

// Eldritch Ember (Searing Exarch, 'r') or Ichor (Eater of Worlds, 'b'). arg: tier index.
function applyEmberOrIchor(item, tierIndex, rnd, receipt, isEmber) {
  if (item.infl.length) {
    return failed('Influenced items can\'t take eldritch implicits');
  }
  if (!item.B.info.eldritch) {
    return failed('Only body armours, helmets, gloves and boots');
  }
  const slot = isEmber ? 'r' : 'b';
  if (tierIndex > EMBER_MAX_TIER) {
    return failed('Embers and Ichors go up to Exceptional; higher tiers come from Orbs of Conflict');
  }
  const candidates = [];
  for (const mod of item.B.mods) {
    if (mod.affix === slot && mod.tiers[tierIndex] && mod.tiers[tierIndex].w > 0) {
      candidates.push({ m: mod, t: tierIndex, w: mod.tiers[tierIndex].w });
    }
  }
  if (!candidates.length) {
    return failed('No eldritch implicit of that tier for this base');
  }
  const chosen = pick(candidates, rnd);
  item.eld = { ...(item.eld ?? {}), [slot]: { m: chosen.m, t: tierIndex } };
  receipt.pay(`${ELDRITCH_TIERS[tierIndex]} Eldritch ${isEmber ? 'Ember' : 'Ichor'}`);
  return succeeded(`${isEmber ? 'Searing Exarch' : 'Eater of Worlds'} implicit set`, receipt);
}

function applyEmber(item, tierIndex, rnd, receipt) {
  return applyEmberOrIchor(item, tierIndex, rnd, receipt, true);
}

function applyIchor(item, tierIndex, rnd, receipt) {
  return applyEmberOrIchor(item, tierIndex, rnd, receipt, false);
}

// Eldritch Chaos / Exalted / Annulment work on the dominant side only.
function checkEldritchCurrency(item) {
  const side = dominance(item);
  if (item.rarity !== 'rare') {
    return { error: failed('Needs a rare item') };
  }
  if (!side) {
    return { error: failed('Needs a dominant eldritch implicit (one stronger than the other)') };
  }
  return { side };
}

function applyEldritchChaos(item, arg, rnd, receipt) {
  const { side, error } = checkEldritchCurrency(item);
  if (error) {
    return error;
  }
  item.mods = item.mods.filter(x => x.frac || x.side !== side);
  const toAdd = Math.min(item.B.max[side], modsToFillRare(item, rnd));
  addRandom(item, toAdd, { side, reforge: true }, rnd);
  receipt.pay(CUR.echaos);
  return succeeded(`Rerolled the ${SIDE_NAME[side]}es`, receipt);
}

function applyEldritchExalt(item, arg, rnd, receipt) {
  const { side, error } = checkEldritchCurrency(item);
  if (error) {
    return error;
  }
  if (!addRandom(item, 1, { side }, rnd).length) {
    return failed(`No room for another ${SIDE_NAME[side]}`);
  }
  receipt.pay(CUR.eexalt);
  return succeeded(`Added a ${SIDE_NAME[side]}`, receipt);
}

function applyEldritchAnnul(item, arg, rnd, receipt) {
  const { side, error } = checkEldritchCurrency(item);
  if (error) {
    return error;
  }
  if (!removeRandom(item, rnd, side, annulProtectedTags(item))) {
    return failed(`No ${SIDE_NAME[side]} to remove`);
  }
  receipt.pay(CUR.eannul);
  return succeeded(`Removed a random ${SIDE_NAME[side]}`, receipt);
}

// Orb of Conflict: one eldritch implicit goes up a tier, the other down.
function applyConflict(item, arg, rnd, receipt) {
  const eldritch = item.eld;
  if (!eldritch?.r || !eldritch?.b) {
    return failed('Needs both eldritch implicits');
  }
  const exarchGoesUp = rnd() < conflictUp(eldritch.r.t, eldritch.b.t);
  const up = exarchGoesUp ? 'r' : 'b';
  const down = exarchGoesUp ? 'b' : 'r';
  const tierCount = item.B.mods.find(mod => mod === eldritch[up].m).tiers.length;
  if (eldritch[up].t < tierCount - 1) {
    eldritch[up] = { ...eldritch[up], t: eldritch[up].t + 1 };
  }
  if (eldritch[down].t === 0) {
    eldritch[down] = null;
  } else {
    eldritch[down] = { ...eldritch[down], t: eldritch[down].t - 1 };
  }
  receipt.pay(CUR.conflict);
  return succeeded(`${up === 'r' ? 'Exarch' : 'Eater'} implicit up a tier, the other down`, receipt);
}

// Orb of Dominance: removes one influenced mod and upgrades another.
function applyDominance(item, arg, rnd, receipt) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  if (!DOMINANCE_GROUPS.has(item.B.info.group)) {
    return failed('Only works on body armours, boots, gloves and helmets');
  }
  const influenced = item.mods.filter(x => x.m && item.infl.includes(x.m.src) && !sideIsLocked(item, x.side));
  if (influenced.length < 2) {
    return failed('Needs at least two influenced mods');
  }
  const removed = influenced.splice(Math.floor(rnd() * influenced.length), 1)[0];
  const upgraded = influenced[Math.floor(rnd() * influenced.length)];
  item.mods.splice(item.mods.indexOf(removed), 1);
  if (upgraded.t < upgraded.m.tiers.length - 1) {
    upgraded.t++;
  } else {
    upgraded.elevated = true;
  }
  receipt.pay(CUR.dominance);
  return succeeded(`Removed ${removed.m.text.replace(/#/g, 'X')}; upgraded ${upgraded.m.text.replace(/#/g, 'X')}`, receipt);
}

// A bench craft. arg: {mod, tier}.
function applyBenchCraft(item, craft, rnd, receipt) {
  const mod = craft.mod;
  const flags = metaFlags(item);
  if (item.rarity === 'normal') {
    return failed('Needs a magic or rare item');
  }
  const craftedLimit = flags.mul_mods ? 3 : 1;
  if (craftedModCount(item) >= craftedLimit && mod.meta !== 'mul_mods') {
    return failed('Already has a crafted mod');
  }
  if (count(item, mod.affix) >= maxAffixes(item)[mod.affix]) {
    return failed(`No room for a ${SIDE_NAME[mod.affix]}`);
  }
  if (mod.groups.some(g => modGroupsOn(item).has(g))) {
    return failed('The item already has a mod of this kind');
  }
  item.mods.push({ m: mod, t: craft.tier, side: mod.affix, crafted: true });
  for (const [currency, amount] of Object.entries(mod.cost?.[craft.tier] ?? {})) {
    receipt.pay(currency, amount);
  }
  return succeeded('Crafted', receipt);
}

function applyRemoveBenchCrafts(item, arg, rnd, receipt) {
  const countBefore = item.mods.length;
  item.mods = item.mods.filter(x => !x.crafted);
  if (countBefore === item.mods.length) {
    return failed('No crafted mods');
  }
  return succeeded('Removed crafted mods', receipt);
}

// Craicic Chimeral: saves a copy of the magic item to come back to.
function applyImprint(item, arg, rnd, receipt) {
  if (item.rarity !== 'magic') {
    return failed('Imprints only work on magic items');
  }
  item.imprint = clone({ ...item, imprint: null });
  receipt.pay(CUR.imprint);
  return succeeded('Imprint saved', receipt);
}

function applyRestoreImprint(item, arg, rnd, receipt) {
  if (!item.imprint) {
    return failed('No imprint');
  }
  const saved = item.imprint;
  Object.assign(item, clone(saved), { imprint: null });
  return succeeded('Restored the imprint', receipt);
}

// Farric Wolf Alpha: a prefix becomes a suffix. Farric Lynx Alpha: a suffix becomes a prefix.
function applyFarricBeast(item, rnd, receipt, from, to, beast) {
  if (item.rarity !== 'rare') {
    return failed('Needs a rare item');
  }
  if (count(item, to) >= item.B.max[to]) {
    return failed(`No room for a ${SIDE_NAME[to]}`);
  }
  if (!removeRandom(item, rnd, from)) {
    return failed(`No ${SIDE_NAME[from]} to remove`);
  }
  addRandom(item, 1, { side: to }, rnd);
  receipt.pay(beast);
  return succeeded(`Swapped a ${SIDE_NAME[from]} for a ${SIDE_NAME[to]}`, receipt);
}

function applyWolf(item, arg, rnd, receipt) {
  return applyFarricBeast(item, rnd, receipt, 'p', 's', CUR.wolf);
}

function applyLynx(item, arg, rnd, receipt) {
  return applyFarricBeast(item, rnd, receipt, 's', 'p', CUR.lynx);
}

// A beast aspect (arg: the beast's name) as a suffix.
function applyAspect(item, beastName, rnd, receipt) {
  if (!item.B.info.recomb || item.B.info.group === 1) {
    return failed('Aspects go on armour and weapons');
  }
  if (count(item, 's') >= item.B.max.s) {
    return failed('No room for a suffix');
  }
  const aspect = item.B.mods.find(mod => mod.src === 'beast' && mod.text.includes(ASPECTS[beastName]));
  if (!aspect) {
    return failed('No aspect for this base');
  }
  if (item.mods.some(x => x.m?.src === 'beast')) {
    return failed('Already has an aspect');
  }
  item.mods.push({ m: aspect, t: 0, side: 's', beast: true });
  receipt.pay(beastName);
  return succeeded('Aspect added', receipt);
}

// The recombined item's level: the average plus 2, never above the higher one.
function recombinedItemLevel(a, b) {
  return Math.min(Math.max(a.ilvl, b.ilvl), Math.floor((a.ilvl + b.ilvl) / 2 + 2));
}

const INFLUENCE_SOURCES = ['shaper', 'elder', 'crusader', 'hunter', 'warlord', 'redeemer'];

// Recombinator, unpredictable mode. arg: {other, dust, gold} (or the other item itself):
// the other item, of the same recombinator type. Both are consumed.
function applyRecombine(item, arg, rnd, receipt) {
  const other = arg.other ?? arg;
  if (!item.B.info.recomb || other.B.info.recomb !== item.B.info.recomb) {
    return failed('Needs two items of the same recombinator type');
  }
  const influences = rnd() < 0.5 ? item.infl : other.infl;
  const result = newItem(item.B, { ilvl: recombinedItemLevel(item, other), infl: influences, rarity: 'rare' });
  for (const side of ['p', 's']) {
    // The candidates: both items' mods on this side (influenced ones only of the kept influence).
    let candidates = [];
    for (const x of [...item.mods, ...other.mods]) {
      if (x.side !== side || !x.m) {
        continue;
      }
      if (INFLUENCE_SOURCES.includes(x.m.src) && !influences.includes(x.m.src)) {
        continue;
      }
      candidates.push(x);
    }
    const countChances = [];
    for (const [n, chance] of Object.entries(RECOMB_COUNTS[Math.min(8, candidates.length)])) {
      countChances.push([+n, chance]);
    }
    const keepCount = pickFromDistribution(countChances, rnd);
    let lost = 0;
    while (count(result, side) + lost < Math.min(keepCount, item.B.max[side]) && candidates.length) {
      const x = candidates.splice(Math.floor(rnd() * candidates.length), 1)[0];
      // Only one exclusive mod; since 3.26.0 (2025-06-12) a second one still takes its slot.
      if (onlyOneSurvivesRecombine(x) && result.mods.some(onlyOneSurvivesRecombine)) {
        lost++;
        continue;
      }
      if (!x.m.groups.some(g => modGroupsOn(result).has(g))) {
        result.mods.push({ ...x });
      }
    }
  }
  Object.assign(item, result);
  receipt.pay(DUST, arg.dust ?? DEFAULT_OPTIONS.recombDust);
  receipt.pay(GOLD, arg.gold ?? DEFAULT_OPTIONS.recombGold);
  return succeeded('Recombined (unpredictable mode)', receipt);
}

// Recombinator, predictable mode. arg: {other, keep: [mods of either item], chance, dust, gold}.
// You pick the mods; the game shows the success chance (it falls with more and higher-tier
// mods, and no formula is published), so the chance comes from the player. A failure
// destroys both items.
function applyRecombinePredictable(item, arg, rnd, receipt) {
  const other = arg.other;
  if (!other || !item.B.info.recomb || other.B.info.recomb !== item.B.info.recomb) {
    return failed('Needs two items of the same recombinator type');
  }
  const kept = arg.keep ?? [];
  if (!kept.length) {
    return failed('Pick at least one mod to keep');
  }
  for (const side of ['p', 's']) {
    if (kept.filter(x => x.side === side).length > item.B.max[side]) {
      return failed(`Too many ${SIDE_NAME[side]}es for this base`);
    }
  }
  if (kept.filter(onlyOneSurvivesRecombine).length > 1) {
    return failed('Only one crafted, essence, veiled or similar mod can be kept');
  }
  const groupsSeen = new Set();
  for (const x of kept) {
    if (x.m.groups.some(g => groupsSeen.has(g))) {
      return failed('Two of the picked mods are in the same mod group');
    }
    for (const group of x.m.groups) {
      groupsSeen.add(group);
    }
  }
  receipt.pay(DUST, arg.dust ?? DEFAULT_OPTIONS.recombDust);
  receipt.pay(GOLD, arg.gold ?? DEFAULT_OPTIONS.recombGold);
  if (!(rnd() < (arg.chance ?? 0))) {
    Object.assign(item, newItem(item.B, { ilvl: item.ilvl, rarity: 'normal' }));
    return { ok: true, msg: 'Predictable recombine failed: both items destroyed', spent: receipt.spent };
  }
  const influences = item.infl.length ? item.infl : other.infl;
  const result = newItem(item.B, { ilvl: recombinedItemLevel(item, other), infl: influences, rarity: 'rare' });
  result.mods = kept.map(x => ({ ...x }));
  Object.assign(item, result);
  return succeeded('Recombined (predictable mode): kept the picked mods', receipt);
}

const CURRENCY_ACTIONS = {
  transmute: applyTransmute,
  alt: applyAlteration,
  aug: applyAugmentation,
  regal: applyRegal,
  alch: applyAlchemy,
  chaos: applyChaos,
  exalt: applyExalt,
  annul: applyAnnul,
  matron: applyMatron,
  hswap: applyHarvestResistanceSwap,
  hdswap: applyHarvestDamageSwap,
  fracture: applyFracture,
  harvest: applyHarvestReforge,
  hadd: applyHarvestAdd,
  iexalt: applyInfluencedExalt,
  hinfl: applyHarvestRandomiseInfluence,
  hinflref: applyHarvestInfluencedReforge,
  awaken: applyAwakener,
  hmore: applyHarvestMoreLikely,
  scour: applyScour,
  essence: applyEssence,
  fossil: applyFossils,
  vchaos: applyVeiledChaos,
  vexalt: applyVeiledExalt,
  unveil: applyUnveil,
  unveilPick: applyUnveilPick,
  ember: applyEmber,
  ichor: applyIchor,
  echaos: applyEldritchChaos,
  eexalt: applyEldritchExalt,
  eannul: applyEldritchAnnul,
  conflict: applyConflict,
  dominance: applyDominance,
  bench: applyBenchCraft,
  unbench: applyRemoveBenchCrafts,
  imprint: applyImprint,
  restore: applyRestoreImprint,
  wolf: applyWolf,
  lynx: applyLynx,
  aspect: applyAspect,
  recombine: applyRecombine,
  recombinePredictable: applyRecombinePredictable,
};

export function apply(item, action, arg, rnd = Math.random) {
  if (!Object.hasOwn(CURRENCY_ACTIONS, action)) {
    return failed('Unknown action');
  }
  const receipt = newReceipt();
  return CURRENCY_ACTIONS[action](item, arg, rnd, receipt);
}

// ---------- odds ----------
// A target: {m, minTier} (that mod at this tier or better), or a class:
// {any: entry => bool, label} (any one mod matching).
// The same mod can come from several sources (base, an influence, an essence, the bench):
// Craft of Exile lists each separately, in one mod group, so an item has only one of them.
// A copy with the same text and side meets a target when its values are at least as high.
export function sameMod(a, b) {
  if (a === b) {
    return true;
  }
  return !!a && !!b && a.text === b.text && a.affix === b.affix;
}

// "This tier or better" for a mod that isn't the target's own (an essence's copy, another source):
// every number's lowest roll is at least the wanted tier's lowest roll, so no roll of it is worse
// (Deafening Zeal's 17-18% counts for a 17-19% tier; "Adds 1 to 14-15" doesn't for "1-2 to 22-23").
function lowestRoll(value) {
  return Math.abs(Array.isArray(value) ? value[0] : value ?? 0);
}

function valuesAtLeast(values = [], wanted = []) {
  if (values.length !== wanted.length) {
    return false;
  }
  for (let i = 0; i < values.length; i++) {
    if (lowestRoll(values[i]) < lowestRoll(wanted[i])) {
      return false;
    }
  }
  return true;
}

// Does mod m at tier t meet target T?
export function meets(T, m, t) {
  if (m === T.m) {
    return t >= T.minTier;
  }
  if (!sameMod(m, T.m)) {
    return false;
  }
  return valuesAtLeast(m.tiers[t]?.values, T.m.tiers[T.minTier]?.values);
}

// Does a pool entry {m, t} hit the target?
function entryHitsTarget(T, entry) {
  if (T.any) {
    return T.any(entry);
  }
  return meets(T, entry.m, entry.t);
}

// Does a mod on the item {m, t, ...} satisfy the target?
function modSatisfiesTarget(T, x) {
  if (!x.m) {
    return x.m;
  }
  if (T.any) {
    return T.any(x);
  }
  return meets(T, x.m, x.t);
}

// ----- junk in the roll recursions -----
// The recursions below follow which wanted mods are hit, and how many junk mods (mods no target
// cares about) each side got. A junk mod's group can't roll twice, so the junk weight left
// shrinks as junk lands. For most pools that's taken as an even share per junk group: after j
// junk mods, (1 - j / groups) of the junk weight is left. That fails when fossils make one junk
// group most of its side (Aetheric + Corroded + Metallic + Shuddering on a wand: Spell Damage is
// 97% of the prefixes; once it lands, the gem prefixes are most of what's left, and Craft of
// Exile's 13 tries for both gem prefixes come out right only if that is followed). So a junk
// group with at least DOMINANT_JUNK_SHARE of its side's junk weight is followed on its own
// (taken or not); the rest keep the even share. With no such group nothing changes.
const DOMINANT_JUNK_SHARE = 0.25;

// One side's junk: dominant groups' weights, and the other junk's weight and group count.
// groupWeights: Map from a group key (modGroupKey) to its junk weight.
function junkModelForSide(totalWeight, groupCount, groupWeights) {
  const dominant = [];
  for (const weight of groupWeights.values()) {
    if (weight > 0 && weight >= DOMINANT_JUNK_SHARE * totalWeight) {
      dominant.push(weight);
    }
  }
  dominant.sort((a, b) => b - a);
  if (dominant.length === 0) {
    return { dominant, restWeight: totalWeight, restGroups: Math.max(1, groupCount) };
  }
  let restWeight = totalWeight;
  for (const weight of dominant) {
    restWeight -= weight;
  }
  return { dominant, restWeight: Math.max(0, restWeight), restGroups: Math.max(1, groupCount - dominant.length) };
}

// The weights of junk choices added up (0 for none).
function sumOfChoiceWeights(choices) {
  let total = 0;
  for (const choice of choices) {
    total += choice.w;
  }
  return total;
}

function bitCount(mask) {
  let count = 0;
  for (let rest = mask; rest; rest >>= 1) {
    count += rest & 1;
  }
  return count;
}

// The junk this side can still roll, given junkCount junk mods so far, takenMask of them the
// dominant groups (bit i: dominant[i]). [{w, taken}]: each choice's weight and the mask after it.
function junkChoices(model, junkCount, takenMask) {
  const choices = [];
  for (let i = 0; i < model.dominant.length; i++) {
    if (!(takenMask & (1 << i))) {
      choices.push({ w: model.dominant[i], taken: takenMask | (1 << i) });
    }
  }
  const restTaken = junkCount - bitCount(takenMask);
  const restWeight = model.restWeight * Math.max(0, 1 - restTaken / model.restGroups);
  if (restWeight) {
    choices.push({ w: restWeight, taken: takenMask });
  }
  return choices;
}

// Adds one junk entry's weight to its side's group weights (for junkModelForSide).
function addJunkGroupWeight(junkGroupWeights, entry) {
  const side = entry.m.affix;
  const key = modGroupKey(entry.m);
  junkGroupWeights[side].set(key, (junkGroupWeights[side].get(key) ?? 0) + entry.w);
}

// Chance that adding n random mods (n drawn from dist) to the item ends with every
// target on it. Exact over slot limits and mod groups, with one approximation: a
// non-target pick removes the average weight of one non-target group on its side
// (instead of its own), except for dominant junk groups, which are followed one by one
// (see junkChoices).
// opts: pool options, plus side (only that side may change) and room ({p, s}: slots
// that must stay free for later steps).
export function odds(item, targets, dist, opts = {}) {
  const entries = pool(item, opts);
  const max = maxAffixes(item);
  const freeSlots = { p: max.p - count(item, 'p'), s: max.s - count(item, 's') };
  if (opts.side) {
    const otherSide = opts.side === 'p' ? 's' : 'p';
    freeSlots[otherSide] = 0;
  }
  const room = opts.room ?? { p: 0, s: 0 };
  const leavesRoom = (prefixesAdded, suffixesAdded) => prefixesAdded <= freeSlots.p - room.p && suffixesAdded <= freeSlots.s - room.s;

  const targetCount = targets.length;
  // 1: the target is already on the item, 0: still missing.
  const startState = [];
  for (const T of targets) {
    startState.push(item.mods.some(x => modSatisfiesTarget(T, x)) ? 1 : 0);
  }

  // Per missing target: the weight that completes it (hitWeight) and the weight that kills
  // it (deadWeight: the same mod group at a wrong tier, or a wrong mod).
  const hitWeight = new Array(targetCount).fill(0);
  const deadWeight = new Array(targetCount).fill(0);
  const targetSide = targets.map(T => T.m?.affix ?? T.side);
  const targetGroups = targets.map(T => new Set(T.m?.groups ?? []));
  const otherWeight = { p: 0, s: 0 };
  const otherGroups = { p: new Set(), s: new Set() };
  const junkGroupWeights = { p: new Map(), s: new Map() };
  for (const entry of entries) {
    let used = false;
    for (let k = 0; k < targetCount && !used; k++) {
      if (startState[k]) {
        continue;
      }
      if (entryHitsTarget(targets[k], entry)) {
        hitWeight[k] += entry.w;
        used = true;
      } else if (!targets[k].any && entry.m.groups.some(g => targetGroups[k].has(g))) {
        deadWeight[k] += entry.w;
        used = true;
      }
    }
    if (!used) {
      otherWeight[entry.m.affix] += entry.w;
      for (const group of entry.m.groups) {
        otherGroups[entry.m.affix].add(group);
      }
      addJunkGroupWeight(junkGroupWeights, entry);
    }
  }

  // A missing target whose side is full, or that can't roll at all: impossible.
  for (let k = 0; k < targetCount; k++) {
    if (!startState[k] && (freeSlots[targetSide[k]] <= 0 || hitWeight[k] === 0)) {
      return 0;
    }
  }

  const junk = {
    p: junkModelForSide(otherWeight.p, otherGroups.p.size, junkGroupWeights.p),
    s: junkModelForSide(otherWeight.s, otherGroups.s.size, junkGroupWeights.s),
  };
  const memo = new Map();
  const allHit = state => state.every(x => x === 1);

  // state: per target 0 missing, 1 hit, 2 dead. prefixesAdded/suffixesAdded: mods added so
  // far; junkPrefixes/junkSuffixes: non-target mods among them; takenPrefixes/takenSuffixes:
  // which dominant junk groups they took (see junkChoices); left: mods still to add.
  function chanceFrom(state, prefixesAdded, suffixesAdded, junkPrefixes, junkSuffixes, left, takenPrefixes = 0, takenSuffixes = 0) {
    if (state.includes(2)) {
      return 0;
    }
    if (left === 0) {
      return allHit(state) && leavesRoom(prefixesAdded, suffixesAdded) ? 1 : 0;
    }
    const key = state.join('') + '|' + prefixesAdded + suffixesAdded + junkPrefixes + junkSuffixes + left + '|' + takenPrefixes + '|' + takenSuffixes;
    if (memo.has(key)) {
      return memo.get(key);
    }
    const prefixOpen = prefixesAdded < freeSlots.p;
    const suffixOpen = suffixesAdded < freeSlots.s;
    const isOpen = k => (targetSide[k] === 'p' ? prefixOpen : suffixOpen);
    const junkPrefixChoices = prefixOpen ? junkChoices(junk.p, junkPrefixes, takenPrefixes) : [];
    const junkSuffixChoices = suffixOpen ? junkChoices(junk.s, junkSuffixes, takenSuffixes) : [];
    let totalWeight = sumOfChoiceWeights(junkPrefixChoices) + sumOfChoiceWeights(junkSuffixChoices);
    for (let k = 0; k < targetCount; k++) {
      if (state[k] === 0 && isOpen(k)) {
        totalWeight += hitWeight[k] + deadWeight[k];
      }
    }

    let chance;
    if (totalWeight <= 0) {
      chance = allHit(state) && leavesRoom(prefixesAdded, suffixesAdded) ? 1 : 0;
    } else {
      chance = 0;
      for (let k = 0; k < targetCount; k++) {
        if (state[k] !== 0 || !isOpen(k)) {
          continue;
        }
        const prefixesAfter = prefixesAdded + (targetSide[k] === 'p');
        const suffixesAfter = suffixesAdded + (targetSide[k] === 's');
        if (hitWeight[k]) {
          const hitState = state.slice();
          hitState[k] = 1;
          chance += (hitWeight[k] / totalWeight) * chanceFrom(hitState, prefixesAfter, suffixesAfter, junkPrefixes, junkSuffixes, left - 1, takenPrefixes, takenSuffixes);
        }
        if (deadWeight[k]) {
          const deadState = state.slice();
          deadState[k] = 2;
          chance += (deadWeight[k] / totalWeight) * chanceFrom(deadState, prefixesAfter, suffixesAfter, junkPrefixes, junkSuffixes, left - 1, takenPrefixes, takenSuffixes);
        }
      }
      for (const choice of junkPrefixChoices) {
        chance += (choice.w / totalWeight) * chanceFrom(state, prefixesAdded + 1, suffixesAdded, junkPrefixes + 1, junkSuffixes, left - 1, choice.taken, takenSuffixes);
      }
      for (const choice of junkSuffixChoices) {
        chance += (choice.w / totalWeight) * chanceFrom(state, prefixesAdded, suffixesAdded + 1, junkPrefixes, junkSuffixes + 1, left - 1, takenPrefixes, choice.taken);
      }
    }
    memo.set(key, chance);
    return chance;
  }

  let total = 0;
  for (const [modsToAdd, chance] of dist) {
    total += chance * chanceFrom(startState, 0, 0, 0, 0, Math.max(0, modsToAdd));
  }
  return total;
}

// Mod count distribution for a reforge that keeps `kept` mods (at most sideCap new ones, if given).
export function rerollDist(B, kept, sideCap = null) {
  const counts = RARE_COUNTS[B.slots] ?? RARE_COUNTS[6];
  const result = [];
  for (const [n, chance] of counts) {
    let newMods = Math.max(0, n - kept);
    if (sideCap != null) {
      newMods = Math.min(sideCap, newMods);
    }
    result.push([newMods, chance]);
  }
  return result;
}

// Chance that the target veiled mod is among the 3 offered when unveiling.
export function unveilOdds(B, target, blockedGroups = new Set()) {
  const candidates = [];
  for (const mod of B.mods) {
    if (mod.src !== 'veiled' || mod.affix !== target.affix) {
      continue;
    }
    if (mod.groups.some(g => blockedGroups.has(g)) || baseBlocks(B, mod)) {
      continue;
    }
    if (mod.tiers[0].w > 0) {
      candidates.push({ m: mod, w: mod.tiers[0].w });
    }
  }
  let totalWeight = 0;
  for (const candidate of candidates) {
    totalWeight += candidate.w;
  }
  const targetWeight = candidates.find(c => c.m === target)?.w ?? 0;
  if (!targetWeight) {
    return 0;
  }
  // Offered first, second (after one other) or third (after two others).
  let chance = targetWeight / totalWeight;
  for (const first of candidates) {
    if (first.m === target) {
      continue;
    }
    const chanceFirst = first.w / totalWeight;
    const weightLeft = totalWeight - first.w;
    chance += chanceFirst * (targetWeight / weightLeft);
    for (const second of candidates) {
      if (second.m === target || second === first) {
        continue;
      }
      chance += chanceFirst * (second.w / weightLeft) * (targetWeight / (weightLeft - second.w));
    }
  }
  return Math.min(1, chance);
}

// Monte Carlo check of a single method: hit rate over n tries.
export function simulate(start, action, arg, targets, n = 20000, rnd = Math.random) {
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const item = clone(start);
    const actionArg = typeof arg === 'function' ? arg(item) : arg;
    apply(item, action, actionArg, rnd);
    if (targets.every(T => item.mods.some(x => modSatisfiesTarget(T, x)))) {
      hits++;
    }
  }
  const p = hits / n;
  const confidence95 = 1.96 * Math.sqrt(Math.max(p * (1 - p), 1 / n) / n);
  return { n, hits, p, ci: confidence95 };
}

// Seeded random numbers, so simulations can be repeated.
export function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- planning ----------
// The planner treats a craft as moves between item states and finds the
// cheapest strategy from every state (a Markov decision process):
//   state = which target mods are on the item (or "dead": a wrong tier of the
//   same mod group blocks it), how many junk mods sit on each side, and which
//   target, if any, is fractured.
// Moves: reforges (Chaos, essences, fossils, Veiled Chaos, Eldritch Chaos,
// lock-a-side + Chaos), Fracturing Orb, slams (Exalt with a bench blocker,
// Exalt under "Cannot roll Attack/Caster", Eldritch Exalt, Veiled Exalt),
// removals (Annul, Eldritch Annul, lock-a-side + Scour), Farric beasts, and
// Alteration/Regal with an Imprint from a fresh base. Progress is kept between
// moves: losing one mod to an Annul only costs that mod.

// Average tries for a success at chance p.
export function tries(p) {
  return p > 0 ? 1 / p : Infinity;
}

// Tries needed for a chance q of at least one success at chance p each.
export function triesAt(p, q) {
  if (p >= 1) {
    return 1;
  }
  if (p > 0) {
    return Math.ceil(Math.log(1 - q) / Math.log(1 - p));
  }
  return Infinity;
}

export const FRACTURE = 'Fracturing Orb';
// Harvest crafts (Horticrafting / Sacred Grove), lifeforce colour and amount (Maxroll, 3.24).
// Reforge: one guaranteed mod of the type, and that type is more common for the rest.
// A third number is the Crystallised Rancour the craft also takes (Mirage league crafts, poedb).
export const HARVEST_REFORGE = {
  fire: ['Wild', 50], cold: ['Vivid', 50], lightning: ['Primal', 50], physical: ['Vivid', 50], defences: ['Primal', 50],
  life: ['Wild', 75], chaos: ['Vivid', 100], attack: ['Wild', 75], caster: ['Primal', 75], speed: ['Vivid', 150], critical: ['Primal', 150],
  minion: ['Primal', 200, 3], elemental: ['Wild', 200, 1], attribute: ['Vivid', 200, 2], mana: ['Primal', 200, 2], drop: ['Vivid', 200, 1],
};
export const RANCOUR = 'Crystallised Rancour';

// What a Harvest reforge with this type takes: lifeforce, and Rancour for some types.
export function harvestBill(tag) {
  const [colour, amount, rancour = 0] = HARVEST_REFORGE[tag];
  return combineBills(billOf(lifeforce(colour), amount), rancour ? billOf(RANCOUR, rancour) : null);
}

// The same, in chaos.
export function harvestCost(tag, P) {
  const [colour, amount, rancour = 0] = HARVEST_REFORGE[tag];
  const rancourCost = rancour ? rancour * P(RANCOUR) : 0;
  return amount * P(lifeforce(colour)) + rancourCost;
}

// The same, as text: "100 Vivid Lifeforce".
export function harvestText(tag) {
  const [colour, amount, rancour = 0] = HARVEST_REFORGE[tag];
  const rancourText = rancour ? ` + ${rancour} Crystallised Rancour` : '';
  return `${amount} ${colour} Lifeforce${rancourText}`;
}

export const HARVEST_MORE_LIKELY = ['Wild', 200];
// Add a mod of a type, removing another random mod (non-influenced items only).
export const HARVEST_ADD = {
  fire: ['Wild', 15000], cold: ['Vivid', 15000], lightning: ['Primal', 15000], physical: ['Vivid', 15000], life: ['Wild', 17500],
  defences: ['Primal', 17500], chaos: ['Vivid', 17500], attack: ['Wild', 17500], caster: ['Primal', 17500], speed: ['Vivid', 20000], critical: ['Primal', 20000],
};

export function lifeforce(colour) {
  return `${colour} Crystallised Lifeforce`;
}

// Harvest "change a resistance": 500 lifeforce of the target element's colour (Maxroll, 3.24).
export const RES_SWAP = { Fire: 'Wild', Cold: 'Vivid', Lightning: 'Primal' };
export const RES_SWAP_AMOUNT = 500;
export const RES_RE = /^\+#% to (Fire|Cold|Lightning) Resistance$/;
// Rancour crafts: change a fire/cold/lightning damage mod into a similar-tier one of another
// element (500 lifeforce of the new element's colour + 1 Rancour).
export const DMG_SWAP_RANCOUR = 1;
const ELEMENTS = ['Fire', 'Cold', 'Lightning'];

// The one element a mod's text names, or null (none, or more than one).
function singleElementOf(mod) {
  const named = [];
  for (const element of ELEMENTS) {
    if (new RegExp(`\\b${element}\\b`).test(mod.text)) {
      named.push(element);
    }
  }
  return named.length === 1 ? named[0] : null;
}

/** The same damage mod with another element (or null): same side, source and wording. */
export function damageSwap(B, mod, toElement) {
  const fromElement = singleElementOf(mod);
  if (!fromElement || fromElement === toElement) {
    return null;
  }
  if (!mod.tags.includes('damage') || mod.tags.includes('resistance')) {
    return null;
  }
  const swappedText = mod.text.replace(new RegExp(`\\b${fromElement}\\b`), toElement);
  return B.mods.find(x => x !== mod && x.text === swappedText && x.affix === mod.affix && x.src === mod.src) ?? null;
}

// The tier of the swapped mod: the same distance from its top tier.
export function swapTier(from, tierIndex, to) {
  return Math.max(0, to.tiers.length - (from.tiers.length - tierIndex));
}

export const MATRON = 'Wild Bristle Matron'; // beast: adds a random craftable metamod that fits
export const SULPHUR = "Dead Man's Sulphur"; // Allflame bench fuel
export const HK_SETUP = ['Craicic Croaker', 'Black Mórrigan']; // Bestiary recipe: Hinekora's Lock on a magic item only
export const HK_LOCK = "Hinekora's Lock"; // the currency item, for rare items (exchange price)
export const INFLUENCE_RANDOMISE = ['Primal', 1000]; // Harvest: randomise influence types and reforge
export const AWAKENER = "Awakener's Orb";
const AWAKEN_DONOR = 5; // a cheap bought item with the other influence (chaos, rough)
export const INFLUENCES = ['shaper', 'elder', 'crusader', 'hunter', 'redeemer', 'warlord'];

// "crusader" -> "Crusader's Exalted Orb"
export function influenceExalt(influence) {
  return `${influence[0].toUpperCase()}${influence.slice(1)}'s Exalted Orb`;
}

// Harvest: reforge an influenced rare with at least one influenced mod (+ 1 Sacred Lifeforce; poedb).
export const HARVEST_INFLUENCE = ['Primal', 5000];
export const DEFAULT_OPTIONS = {
  allflame: true, allflameK: 3, allflameUses: 2, allflameIntang: 12.5,
  supplyCheck: true, supplyShare: 10, playerSupply: 20, timeValue: 0,
  recombDust: 100000, recombGold: 50000, sulphur: 2000, sulphurFracture: 50000,
  hinekora: true, matron: true, beasts: true, topEssence: true,
  influenceSetup: true, influenceExalt: true, awakener: true, rancour: true,
  noAlt: false, ruthless: false,
};
export const SACRED = 'Sacred Crystallised Lifeforce';
export const SOLVER = { maxIter: 400, iters: 0, states: 0, tExplore: 0, tSolve: 0 };

// The bench's price list entry for a mod at tier t (the last one if t is past the end).
function benchPriceList(mod, tierIndex) {
  return mod?.cost?.[Math.min(tierIndex, (mod.cost?.length ?? 1) - 1)];
}

// What a bench craft costs in chaos; null if it isn't a bench craft.
function benchCost(mod, tierIndex, price) {
  if (price.noBench) {
    return Infinity; // Ruthless
  }
  const priceList = benchPriceList(mod, tierIndex);
  if (!priceList) {
    return null;
  }
  if (price.clicks) {
    return 1; // (the fewest-clicks solve: one bench craft is one click)
  }
  let total = 0;
  for (const [currency, amount] of Object.entries(priceList)) {
    total += amount * price(currency);
  }
  return total;
}

// Ruthless (GGG's announcement): no crafting bench, no Chaotic Resonators, and these can't be obtained.
// Bestiary crafting isn't there either: no Farric beasts, Craicic imprints, Matron, Aspects or the
// beast recipe for Hinekora's Lock (the Lock currency itself drops, a handful a league).
export const RUTHLESS_BANNED = new Set(['Veiled Chaos Orb', 'Orb of Binding', 'Orb of Dominance', AWAKENER, ...INFLUENCES.map(influenceExalt), ...RESONATORS,
  CUR.imprint, CUR.wolf, CUR.lynx, MATRON, ...HK_SETUP, ...Object.keys(ASPECTS), RANCOUR]);
// Ruthless switches some methods off (above) and starts with Hinekora's Lock off: it's that rare.
export const RUTHLESS_FORCED = { matron: false, beasts: false, rancour: false };
export const RUTHLESS_DEFAULTS = { hinekora: false };

// Tries until a success at chance p (geometric), with the random generator rnd.
function triesUntilSuccess(rnd, p) {
  if (p >= 1) {
    return 1;
  }
  return 1 + Math.floor(Math.log(1 - rnd()) / Math.log(1 - p));
}

// Eldritch target implicits are a mix of Embers, Ichors and Orbs of Conflict: counted by value.
export const ELD_VALUE = 'Eldritch implicits (chaos value)';
// Bought donor items for the Awakener's Orb: counted by value too.
export const DONOR_VALUE = 'Bought influenced items (chaos value)';

// The value below which a share f of the sorted values lie.
function quantileOfSorted(sortedValues, f) {
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(f * sortedValues.length))];
}

function averageOf(values) {
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

// Per currency over the simulated crafts (runs: one bill per craft): average, and the
// counts that cover 66% and 90% of them.
function usageSummary(runs) {
  const names = new Set();
  for (const usage of runs) {
    for (const name of Object.keys(usage)) {
      names.add(name);
    }
  }
  const summary = [];
  for (const name of names) {
    const amounts = runs.map(usage => usage[name] ?? 0).sort((a, b) => a - b);
    const mean = averageOf(amounts);
    if (mean > 0) {
      summary.push({ name, mean, q66: quantileOfSorted(amounts, 0.66), q90: quantileOfSorted(amounts, 0.9) });
    }
  }
  return summary;
}

// How many times a step ran per craft (crafts that never reached it count 0): average and the
// counts that cover 66% and 90% of crafts.
function runsSummary(timesRun, runs) {
  const missing = new Array(Math.max(0, runs - timesRun.length)).fill(0);
  const all = [...timesRun, ...missing].sort((a, b) => a - b);
  return { mean: averageOf(all), q66: quantileOfSorted(all, 0.66), q90: quantileOfSorted(all, 0.9), reached: timesRun.length / runs };
}

// Currency bills: {currency name: how many}, for the "currency used" summary of a plan.
// combineBills adds bills together (null parts are skipped).
function combineBills(...parts) {
  const total = {};
  for (const part of parts) {
    if (!part) {
      continue;
    }
    for (const [name, amount] of Object.entries(part)) {
      total[name] = (total[name] ?? 0) + amount;
    }
  }
  return total;
}

function billOf(name, amount = 1) {
  return { [name]: amount };
}

function benchBill(mod, tierIndex) {
  return { ...(benchPriceList(mod, tierIndex) ?? {}) };
}

// Cheapest bench craft on a side that doesn't clash with the item (a "blocker").
function cheapestBlocker(B, item, side, price) {
  const groupsTaken = modGroupsOn(item);
  let best = null;
  for (const mod of B.mods) {
    if (mod.src !== 'bench' || mod.affix !== side || mod.meta) {
      continue;
    }
    if (mod.groups.some(g => groupsTaken.has(g))) {
      continue;
    }
    for (let tierIndex = 0; tierIndex < mod.tiers.length; tierIndex++) {
      if (mod.tiers[tierIndex].ilvl > item.ilvl) {
        continue;
      }
      const cost = benchCost(mod, tierIndex, price);
      if (cost != null && isFinite(cost) && (!best || cost < best.cost)) {
        best = { m: mod, t: tierIndex, cost, bill: benchBill(mod, tierIndex) };
      }
    }
  }
  return best;
}

// The bench metamod with this flag ('nchg_pre', 'no_attack', 'mul_mods', ...).
function findMetamod(B, flag) {
  return B.mods.find(mod => mod.meta === flag);
}

// The essence versions of a target mod (same side and text).
function essenceModsFor(B, T) {
  return B.mods.filter(mod => mod.src === 'essence' && mod.affix === T.m.affix && mod.text === T.m.text);
}

// Special essences (Hysteria, Insanity, Horror, Delirium, Desolation) come in one version
// with no level in the name; the data marks the first four and gives Desolation one tier.
// Essences whose other mods are "restricted to level N and below" (Mirage, poedb).
export const ESSENCE_MOD_LEVEL = { Desolation: 15 };

export function essenceName(mod, tierIndex, levels) {
  if (mod.corrupt || mod.tiers.length === 1) {
    return `Essence of ${mod.essence}`;
  }
  const level = levels[levels.length - mod.tiers.length + tierIndex] ?? 'Deafening';
  return `${level} Essence of ${mod.essence}`;
}

// Does essence tier t reach the target tier? The same rule as meets().
function essenceTierReaches(mod, tierIndex, T) {
  return valuesAtLeast(mod.tiers[tierIndex].values, T.m.tiers[T.minTier].values);
}

// Orb of Conflict: one Eldritch implicit goes up a tier, the other down (a Lesser one going down
// is lost). The lower one is more likely to go up: 50% at equal tiers, about 11 points per tier
// of difference (one community measurement; 5 vs 3 gives the 5 a 28% chance). The two top tiers
// (Exquisite, Perfect) only come from Conflict; Embers and Ichors give Lesser to Exceptional.
export const CONFLICT_STEP = 0.11;
// Orb of Dominance works on these item classes only (poedb): body armours, boots, helmets, gloves.
export const DOMINANCE_GROUPS = new Set([2, 3, 4, 5]);
export const EMBER_MAX_TIER = 3;

// Chance that the implicit at tier `mine` goes up (the other at tier `other`).
export function conflictUp(mine, other) {
  return Math.min(0.98, Math.max(0.02, 0.5 + CONFLICT_STEP * (other - mine)));
}
// ---------- Eldritch implicits ----------

const ELDRITCH_TIER_COUNT = 6;

function eldritchCurrencyName(slot, tierIndex) {
  return `${ELDRITCH_TIERS[tierIndex]} Eldritch ${slot === 'r' ? 'Ember' : 'Ichor'}`;
}

function eldritchSideName(slot) {
  return slot === 'r' ? 'Searing Exarch' : 'Eater of Worlds';
}

// One successful Ember/Ichor of a tier on a slot: {c: cost, p: chance per apply}. For a
// wanted slot it is repeated until it gives the wanted mod.
function emberOrIchorUntilWanted(B, want, P, slot, tierIndex) {
  const cost = P(eldritchCurrencyName(slot, tierIndex));
  if (!isFinite(cost)) {
    return { c: Infinity, p: 0 };
  }
  if (!want[slot]) {
    return { c: cost, p: 1 };
  }
  let totalWeight = 0;
  for (const mod of B.mods) {
    if (mod.affix === slot && mod.tiers[tierIndex]?.w > 0) {
      totalWeight += mod.tiers[tierIndex].w;
    }
  }
  const wantedWeight = want[slot].m.tiers[tierIndex]?.w ?? 0;
  const chance = totalWeight ? wantedWeight / totalWeight : 0;
  return { c: chance > 0 ? cost / chance : Infinity, p: chance };
}

/**
 * Cheapest way to the wanted Eldritch implicits. want: {r?: {m, tier}, b?: {m, tier}} (r: Searing
 * Exarch, b: Eater of Worlds). An optimal policy over the two tiers: apply an Ember or Ichor of a tier
 * (until it's the wanted mod, for a wanted side), or use an Orb of Conflict. Returns {cost, steps, counts}.
 *
 * The state is (exarchTier, eaterTier), each -1 (none) to 5.
 */
export function eldritchPlan(B, want, P) {
  const N = ELDRITCH_TIER_COUNT;
  const slots = ['r', 'b'];
  const applyOptions = { r: [], b: [] };
  for (const slot of slots) {
    for (let k = 0; k <= EMBER_MAX_TIER; k++) {
      applyOptions[slot][k] = emberOrIchorUntilWanted(B, want, P, slot, k);
    }
  }
  const conflictPrice = P(CUR.conflict);
  const stateIndex = (exarch, eater) => (exarch + 1) * (N + 1) + (eater + 1);
  const isDone = (exarch, eater) => (!want.r || exarch >= want.r.tier) && (!want.b || eater >= want.b.tier);
  // A wanted mod can't go past its own top tier (some stop at Exquisite).
  const topTier = { r: (want.r?.m.tiers.length ?? N) - 1, b: (want.b?.m.tiers.length ?? N) - 1 };
  const conflictOutcomes = (exarch, eater) => {
    const exarchUp = conflictUp(exarch, eater);
    return [
      { p: exarchUp, a: Math.min(topTier.r, exarch + 1), b: eater - 1 },
      { p: 1 - exarchUp, a: exarch - 1, b: Math.min(topTier.b, eater + 1) },
    ];
  };

  // Value iteration: value[state] = expected cost to finish, policy[state] = the action.
  const value = new Float64Array((N + 1) * (N + 1)).fill(0);
  const policy = new Array(value.length);
  for (let exarch = -1; exarch < N; exarch++) {
    for (let eater = -1; eater < N; eater++) {
      value[stateIndex(exarch, eater)] = isDone(exarch, eater) ? 0 : 1e12;
    }
  }
  for (let iteration = 0; iteration < 2000; iteration++) {
    let biggestChange = 0;
    for (let exarch = -1; exarch < N; exarch++) {
      for (let eater = -1; eater < N; eater++) {
        if (isDone(exarch, eater)) {
          continue;
        }
        let best = Infinity;
        let action = null;
        for (let k = 0; k <= EMBER_MAX_TIER; k++) {
          if (exarch !== k && applyOptions.r[k].c + value[stateIndex(k, eater)] < best) {
            best = applyOptions.r[k].c + value[stateIndex(k, eater)];
            action = { s: 'r', k };
          }
          if (eater !== k && applyOptions.b[k].c + value[stateIndex(exarch, k)] < best) {
            best = applyOptions.b[k].c + value[stateIndex(exarch, k)];
            action = { s: 'b', k };
          }
        }
        if (exarch >= 0 && eater >= 0 && isFinite(conflictPrice)) {
          let conflictValue = conflictPrice;
          let expectedAfter = 0;
          for (const outcome of conflictOutcomes(exarch, eater)) {
            expectedAfter = expectedAfter + outcome.p * value[stateIndex(outcome.a, outcome.b)];
          }
          conflictValue += expectedAfter;
          if (conflictValue < best) {
            best = conflictValue;
            action = { conflict: true };
          }
        }
        biggestChange = Math.max(biggestChange, Math.abs(value[stateIndex(exarch, eater)] - best));
        value[stateIndex(exarch, eater)] = best;
        policy[stateIndex(exarch, eater)] = action;
      }
    }
    if (biggestChange < 1e-7) {
      break;
    }
  }
  const cost = value[stateIndex(-1, -1)];
  if (!(cost < 1e11)) {
    return { cost: Infinity, steps: [] };
  }

  // Expected uses of each currency under that policy, from every state.
  const labelOf = action => (action.conflict ? CUR.conflict : eldritchCurrencyName(action.s, action.k));
  const expectedUses = new Map(); // state -> Map(currency -> uses)
  for (let iteration = 0; iteration < 3000; iteration++) {
    let biggestChange = 0;
    for (let exarch = -1; exarch < N; exarch++) {
      for (let eater = -1; eater < N; eater++) {
        if (isDone(exarch, eater)) {
          continue;
        }
        const action = policy[stateIndex(exarch, eater)];
        let outcomes;
        if (action.conflict) {
          outcomes = conflictOutcomes(exarch, eater);
        } else {
          outcomes = [{ p: 1, a: action.s === 'r' ? action.k : exarch, b: action.s === 'b' ? action.k : eater }];
        }
        const usesHere = action.conflict ? 1 : 1 / (applyOptions[action.s][action.k].p || 1);
        const previous = expectedUses.get(stateIndex(exarch, eater)) ?? new Map();
        const updated = new Map([[labelOf(action), usesHere]]);
        for (const outcome of outcomes) {
          for (const [label, uses] of expectedUses.get(stateIndex(outcome.a, outcome.b)) ?? []) {
            updated.set(label, (updated.get(label) ?? 0) + outcome.p * uses);
          }
        }
        for (const [label, uses] of updated) {
          biggestChange = Math.max(biggestChange, Math.abs(uses - (previous.get(label) ?? 0)));
        }
        expectedUses.set(stateIndex(exarch, eater), updated);
      }
    }
    if (biggestChange < 1e-6) {
      break;
    }
  }
  const counts = new Map();
  for (const [label, uses] of expectedUses.get(stateIndex(-1, -1)) ?? []) {
    counts.set(label, uses);
  }

  // The first applies, then the Conflict phase, as text.
  const steps = [];
  let exarch = -1;
  let eater = -1;
  for (let i = 0; i < 4 && !isDone(exarch, eater); i++) {
    const action = policy[stateIndex(exarch, eater)];
    if (action.conflict) {
      break;
    }
    const option = applyOptions[action.s][action.k];
    const currency = eldritchCurrencyName(action.s, action.k);
    const sideName = eldritchSideName(action.s);
    let text;
    if (want[action.s]) {
      text = `${currency} until the ${sideName} implicit is "${modText(want[action.s].m, action.k)}": ${pctText(option.p)} per try, about ${fmtN(tries(option.p))}.`;
    } else {
      text = `${currency} for any ${sideName} implicit (it only steers the Orbs of Conflict).`;
    }
    steps.push({ text, p: option.p, cost: option.c, how: 'Eldritch implicits' });
    if (action.s === 'r') {
      exarch = action.k;
    } else {
      eater = action.k;
    }
  }
  if (!isDone(exarch, eater)) {
    const goals = [];
    for (const slot of slots) {
      if (want[slot]) {
        goals.push(`the ${eldritchSideName(slot)} implicit is ${ELDRITCH_TIERS[want[slot].tier]}`);
      }
    }
    const refreshes = [];
    for (const [label, uses] of counts) {
      if (label !== CUR.conflict && uses > 0.05) {
        refreshes.push(`${fmtN(uses)} ${label}`);
      }
    }
    steps.push({
      text: `Orbs of Conflict until ${goals.join(' and ')}: about ${fmtN(counts.get(CUR.conflict) ?? 0)} in all. Each raises one implicit and lowers the other (a Lesser one is lost); the lower one is more likely to go up. When an implicit drops too low (or is lost), apply a fresh Ember or Ichor. On average, in all: ${refreshes.join(', ') || 'no more Embers or Ichors'}.`,
      p: 1,
      cost: value[stateIndex(exarch, eater)],
      how: 'Orb of Conflict',
    });
  }
  return { cost, steps, counts };
}

// Mean number of Orbs of Conflict to make `want` ('p' or 's') dominant, by simulation.
// exarchTier/eaterTier: the starting tiers; tierCount: how many tiers there are.
export function conflictCost(exarchTier, eaterTier, tierCount, want, runs = 4000) {
  const rnd = mulberry32(7);
  const isDominant = (exarch, eater) => (want === 'p' && exarch > eater) || (want === 's' && eater > exarch);
  let totalOrbs = 0;
  let successes = 0;
  for (let run = 0; run < runs; run++) {
    let exarch = exarchTier;
    let eater = eaterTier;
    let orbs = 0;
    while (orbs < 60 && !isDominant(exarch, eater)) {
      if (exarch < 0 || eater < 0) {
        break;
      }
      if (rnd() < conflictUp(exarch, eater)) {
        exarch = Math.min(tierCount - 1, exarch + 1);
        eater -= 1;
      } else {
        eater = Math.min(tierCount - 1, eater + 1);
        exarch -= 1;
      }
      orbs++;
    }
    const succeeded = (want === 'p' && exarch > eater && eater >= 0) || (want === 's' && eater > exarch && exarch >= 0);
    if (succeeded) {
      totalOrbs += orbs;
      successes++;
    }
  }
  return successes ? totalOrbs / successes : Infinity;
}

/*
 * Where n random mods (n drawn from dist) can leave the item: every end
 * state with its chance. targets: the targets still missing, [{k, m, minTier, alts?}].
 * Returns [{st (0 missing, 1 hit, 2 dead per target), np, ns, jp, js, p}], np/ns = new
 * mods on each side (jp/js are always 0 here). Same weights and group rules as odds().
 */
export function rollOutcomes(item, targets, dist, opts = {}) {
  const entries = pool(item, opts);
  const max = maxAffixes(item);
  const freeSlots = { p: max.p - count(item, 'p'), s: max.s - count(item, 's') };
  if (opts.side) {
    const otherSide = opts.side === 'p' ? 's' : 'p';
    freeSlots[otherSide] = 0;
  }
  const targetCount = targets.length;
  const hitWeight = new Array(targetCount).fill(0);
  const deadWeight = new Array(targetCount).fill(0);
  const targetSide = targets.map(T => T.m.affix);
  const targetGroups = targets.map(T => new Set(T.m.groups));
  const otherWeight = { p: 0, s: 0 };
  const otherGroups = { p: new Set(), s: new Set() };
  const junkGroupWeights = { p: new Map(), s: new Map() };
  for (const entry of entries) {
    let used = false;
    for (let k = 0; k < targetCount && !used; k++) {
      const T = targets[k];
      const hitsAlternative = T.alts?.some(alt => alt.m === entry.m && entry.t >= alt.minTier);
      if (meets(T, entry.m, entry.t) || hitsAlternative) {
        hitWeight[k] += entry.w;
        used = true;
      } else if (entry.m.groups.some(g => targetGroups[k].has(g))) {
        deadWeight[k] += entry.w;
        used = true;
      }
    }
    if (!used) {
      otherWeight[entry.m.affix] += entry.w;
      for (const group of entry.m.groups) {
        otherGroups[entry.m.affix].add(group);
      }
      addJunkGroupWeight(junkGroupWeights, entry);
    }
  }
  const junk = {
    p: junkModelForSide(otherWeight.p, otherGroups.p.size, junkGroupWeights.p),
    s: junkModelForSide(otherWeight.s, otherGroups.s.size, junkGroupWeights.s),
  };

  // Adds chance p to the state in `states` (a Map keyed by the state). takenPrefixes and
  // takenSuffixes: the dominant junk groups taken (see junkChoices).
  const addState = (states, state, newPrefixes, newSuffixes, junkPrefixes, junkSuffixes, p, takenPrefixes = 0, takenSuffixes = 0) => {
    const key = state.join('') + '|' + newPrefixes + newSuffixes + junkPrefixes + junkSuffixes + '|' + takenPrefixes + '|' + takenSuffixes;
    const existing = states.get(key);
    if (existing) {
      existing.p += p;
    } else {
      states.set(key, { st: state, np: newPrefixes, ns: newSuffixes, jp: junkPrefixes, js: junkSuffixes, tp: takenPrefixes, ts: takenSuffixes, p });
    }
  };

  const finalStates = new Map();
  for (const [modsToAdd, chanceOfCount] of dist) {
    let layer = new Map();
    addState(layer, new Array(targetCount).fill(0), 0, 0, 0, 0, chanceOfCount);
    for (let step = 0; step < modsToAdd; step++) {
      const nextLayer = new Map();
      for (const s of layer.values()) {
        const prefixOpen = s.np < freeSlots.p;
        const suffixOpen = s.ns < freeSlots.s;
        const isOpen = k => (targetSide[k] === 'p' ? prefixOpen : suffixOpen);
        const junkPrefixChoices = prefixOpen ? junkChoices(junk.p, s.jp, s.tp) : [];
        const junkSuffixChoices = suffixOpen ? junkChoices(junk.s, s.js, s.ts) : [];
        let totalWeight = sumOfChoiceWeights(junkPrefixChoices) + sumOfChoiceWeights(junkSuffixChoices);
        for (let k = 0; k < targetCount; k++) {
          if (s.st[k] === 0 && isOpen(k)) {
            totalWeight += hitWeight[k] + deadWeight[k];
          }
        }
        if (totalWeight <= 0) {
          addState(nextLayer, s.st, s.np, s.ns, s.jp, s.js, s.p, s.tp, s.ts);
          continue;
        }
        for (let k = 0; k < targetCount; k++) {
          if (s.st[k] !== 0 || !isOpen(k)) {
            continue;
          }
          const prefixesAfter = s.np + (targetSide[k] === 'p');
          const suffixesAfter = s.ns + (targetSide[k] === 's');
          if (hitWeight[k]) {
            const hitState = s.st.slice();
            hitState[k] = 1;
            addState(nextLayer, hitState, prefixesAfter, suffixesAfter, s.jp, s.js, s.p * hitWeight[k] / totalWeight, s.tp, s.ts);
          }
          if (deadWeight[k]) {
            const deadState = s.st.slice();
            deadState[k] = 2;
            addState(nextLayer, deadState, prefixesAfter, suffixesAfter, s.jp, s.js, s.p * deadWeight[k] / totalWeight, s.tp, s.ts);
          }
        }
        for (const choice of junkPrefixChoices) {
          addState(nextLayer, s.st, s.np + 1, s.ns, s.jp + 1, s.js, s.p * choice.w / totalWeight, choice.taken, s.ts);
        }
        for (const choice of junkSuffixChoices) {
          addState(nextLayer, s.st, s.np, s.ns + 1, s.jp, s.js + 1, s.p * choice.w / totalWeight, s.tp, choice.taken);
        }
      }
      layer = nextLayer;
    }
    for (const s of layer.values()) {
      addState(finalStates, s.st, s.np, s.ns, 0, 0, s.p);
    }
  }
  return [...finalStates.values()];
}

// ---------- linear solvers ----------
// The planner's expected costs satisfy x_i = c_i + Σ_j a_ij x_j: the cost of state i is the
// cost of its move plus the chance-weighted costs of where the move leads. rows: one per
// state, {c, a: [[j, a_ij], ...]}.

function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

// Solve x_i - Σ_j a_ij x_j = c_i by BiCGSTAB, starting from the guess x0.
// Returns null when it doesn't converge.
function solveLinear(rows, x0) {
  const N = rows.length;
  // out = (I - A) v
  const multiply = (v, out) => {
    for (let i = 0; i < N; i++) {
      let sum = v[i];
      for (const [j, a] of rows[i].a) {
        sum -= a * v[j];
      }
      out[i] = sum;
    }
    return out;
  };
  const b = Float64Array.from(rows, row => row.c);
  const x = Float64Array.from(x0);
  const residual = new Float64Array(N);
  const scratch = new Float64Array(N);
  multiply(x, scratch);
  for (let i = 0; i < N; i++) {
    residual[i] = b[i] - scratch[i];
  }
  const shadowResidual = Float64Array.from(residual);
  const p = new Float64Array(N);
  const v = new Float64Array(N);
  const s = new Float64Array(N);
  const t = new Float64Array(N);
  let rho = 1;
  let alpha = 1;
  let omega = 1;
  const bNorm = Math.sqrt(dotProduct(b, b)) || 1;
  for (let iteration = 0; iteration < 4000; iteration++) {
    const rhoNext = dotProduct(shadowResidual, residual);
    if (!isFinite(rhoNext) || rhoNext === 0) {
      break;
    }
    const beta = (rhoNext / rho) * (alpha / omega);
    for (let i = 0; i < N; i++) {
      p[i] = residual[i] + beta * (p[i] - omega * v[i]);
    }
    multiply(p, v);
    alpha = rhoNext / dotProduct(shadowResidual, v);
    for (let i = 0; i < N; i++) {
      s[i] = residual[i] - alpha * v[i];
    }
    if (Math.sqrt(dotProduct(s, s)) / bNorm < 1e-9) {
      for (let i = 0; i < N; i++) {
        x[i] += alpha * p[i];
      }
      return x;
    }
    multiply(s, t);
    omega = dotProduct(t, s) / dotProduct(t, t);
    for (let i = 0; i < N; i++) {
      x[i] += alpha * p[i] + omega * s[i];
      residual[i] = s[i] - omega * t[i];
    }
    rho = rhoNext;
    if (Math.sqrt(dotProduct(residual, residual)) / bNorm < 1e-9) {
      return x;
    }
    if (!isFinite(omega) || omega === 0) {
      break;
    }
  }
  return null;
}

// A binary min-heap of [priority, value] pairs.
function heapPush(heap, priority, value) {
  heap.push([priority, value]);
  let k = heap.length - 1;
  while (k > 0) {
    const parent = (k - 1) >> 1;
    if (heap[parent][0] <= heap[k][0]) {
      break;
    }
    [heap[parent], heap[k]] = [heap[k], heap[parent]];
    k = parent;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let k = 0;
    for (;;) {
      const left = 2 * k + 1;
      const right = left + 1;
      let smallest = k;
      if (left < heap.length && heap[left][0] < heap[smallest][0]) {
        smallest = left;
      }
      if (right < heap.length && heap[right][0] < heap[smallest][0]) {
        smallest = right;
      }
      if (smallest === k) {
        break;
      }
      [heap[smallest], heap[k]] = [heap[k], heap[smallest]];
      k = smallest;
    }
  }
  return top;
}

// Direct solve of x_i = c_i + Σ a_ij x_j (a substochastic, proper) by
// eliminating states one at a time, cheapest first (Markowitz order), then
// back-substituting. Stable here because I - A is diagonally dominant.
// Returns null when fill-in grows too large.
function solveDirect(rows, maxFill = 4e6) {
  const N = rows.length;
  // links[i]: Map(j -> a_ij); constant[i]: c_i; pointedFrom[j]: the rows i with a_ij.
  const links = [];
  for (const row of rows) {
    const rowLinks = new Map();
    for (const [j, a] of row.a) {
      rowLinks.set(j, (rowLinks.get(j) ?? 0) + a);
    }
    links.push(rowLinks);
  }
  const constant = Float64Array.from(rows, row => row.c);
  const pointedFrom = [];
  for (let i = 0; i < N; i++) {
    pointedFrom.push(new Set());
  }
  // A state's link to itself is divided out: x_i = (c_i + Σ_{j≠i} a_ij x_j) / (1 - a_ii).
  for (let i = 0; i < N; i++) {
    const selfLink = links[i].get(i);
    if (selfLink) {
      links[i].delete(i);
      const divisor = 1 - selfLink;
      constant[i] /= divisor;
      for (const [j, a] of links[i]) {
        links[i].set(j, a / divisor);
      }
    }
    for (const j of links[i].keys()) {
      pointedFrom[j].add(i);
    }
  }

  const eliminated = new Uint8Array(N);
  const eliminationOrder = [];
  let fill = 0;
  for (const row of rows) {
    fill += row.a.length;
  }
  // Elimination cost = rows pointing at it × its own links (a lazily refreshed min-heap).
  const eliminationCost = i => pointedFrom[i].size * Math.max(1, links[i].size);
  const heap = [];
  for (let i = 0; i < N; i++) {
    heapPush(heap, eliminationCost(i), i);
  }
  while (heap.length) {
    const [costWhenQueued, v] = heapPop(heap);
    if (eliminated[v]) {
      continue;
    }
    if (costWhenQueued !== eliminationCost(v)) {
      heapPush(heap, eliminationCost(v), v);
      continue;
    }
    eliminated[v] = 1;
    eliminationOrder.push(v);
    // Substitute row v into every row that points at v.
    for (const u of pointedFrom[v]) {
      if (eliminated[u]) {
        continue;
      }
      const aUV = links[u].get(v);
      if (aUV === undefined) {
        continue;
      }
      links[u].delete(v);
      constant[u] += aUV * constant[v];
      for (const [w, aVW] of links[v]) {
        if (w === u) {
          continue;
        }
        const existing = links[u].get(w);
        links[u].set(w, (existing ?? 0) + aUV * aVW);
        if (existing === undefined) {
          pointedFrom[w].add(u);
          fill++;
        }
      }
      // Row v pointed back at u: u now points at itself; divide that out.
      const aVU = links[v].get(u);
      if (aVU !== undefined) {
        const divisor = 1 - aUV * aVU;
        if (divisor <= 1e-300) {
          return null;
        }
        constant[u] /= divisor;
        for (const [w, a] of links[u]) {
          links[u].set(w, a / divisor);
        }
      }
      if (fill > maxFill) {
        return null;
      }
    }
    for (const w of links[v].keys()) {
      pointedFrom[w].delete(v);
    }
  }

  // Back-substitute: each row now only refers to rows eliminated after it.
  const x = new Float64Array(N);
  for (let position = eliminationOrder.length - 1; position >= 0; position--) {
    const v = eliminationOrder[position];
    let total = constant[v];
    for (const [w, a] of links[v]) {
      total += a * x[w];
    }
    x[v] = total;
  }
  return x;
}

// Plain fixed-point iteration, the fallback when the others fail.
function gaussSeidel(rows, x0, sweeps = 20000) {
  const x = Float64Array.from(x0);
  for (let sweep = 0; sweep < sweeps; sweep++) {
    let biggestChange = 0;
    for (let i = 0; i < rows.length; i++) {
      let total = rows[i].c;
      for (const [j, a] of rows[i].a) {
        total += a * x[j];
      }
      biggestChange = Math.max(biggestChange, Math.abs(total - x[i]) / Math.max(1, total));
      x[i] = total;
    }
    if (biggestChange < 1e-10) {
      return x;
    }
  }
  return x;
}

// The pool of a new rare item of the base.
function freshRarePool(B, ilvl, infl) {
  return pool(newItem(B, { ilvl, infl, rarity: 'rare' }));
}

// Solve R = c + Σ p_d · min(A_d, R): the value of "repeat this until it's
// worth stopping" (optimal stopping). outs: [{p, A}], A = the value of stopping at
// that result. Returns {R, stop: P(stop per try), kept: the outs stopped at (the same objects)}.
function stopValue(costPerTry, outs) {
  const usable = outs.filter(o => o.p > 0 && isFinite(o.A)).sort((a, b) => a.A - b.A);
  let stopChance = 0;
  let stopValueSum = 0;
  let R = Infinity;
  const kept = [];
  for (const o of usable) {
    if (o.A >= R) {
      break;
    }
    stopChance += o.p;
    stopValueSum += o.p * o.A;
    R = (costPerTry + stopValueSum) / stopChance;
    kept.push(o);
  }
  return { R, stop: stopChance, kept };
}

/*
 * plan(B, spec, price, index, onProgress) -> [{key, name, ok, cost, steps, notes}]
 * spec: {ilvl, infl, targets: [{m, minTier, crafted?, frac?}], useFractured}
 * price(name) -> chaos (NaN when unknown).
 */

function sortPlansBestFirst(plans) {
  return plans.sort((a, b) => {
    if (a.ok === b.ok) {
      return a.cost - b.cost;
    }
    return a.ok ? -1 : 1;
  });
}

function noWayPlan(why) {
  return { key: 'none', name: 'No way found', ok: false, cost: Infinity, steps: [], notes: [], why };
}

// Ruthless: no Harvest crafts either (reforges and swaps are gone; without lifeforce prices the
// planner leaves out the rest), and no Matron: its wrong metamods come off at the bench.
function ruthlessPrices(price) {
  return name => {
    if (RUTHLESS_BANNED.has(name) || /Crystallised (Lifeforce|Rancour)$/.test(name)) {
      return NaN;
    }
    return price(name);
  };
}

// Items that aren't bought on the exchange, so the supply check leaves them alone.
function hasNoSupplyCap(name) {
  return name in FARMED_PRICES || name === ELD_VALUE || name === DONOR_VALUE;
}

// Bulk items are used by the hundred per craft: their time is in the craft that uses them.
function isBulkItem(name) {
  return hasNoSupplyCap(name) || name === SULPHUR || /Lifeforce$/.test(name);
}

// Prices that follow supply: the cheapest plan at market prices can lean on something bought
// a thousand times (beasts, one essence) that nobody can actually get. So: plan, count what
// the best plan needs, price up whatever it needs beyond what the market supplies, and plan
// again, so the planner looks for another route. Optionally each currency also carries the
// time it takes to use (opt.timeValue chaos per hour).
function makeSupplyPricing(basePrice, supply, opt) {
  const haveMarket = Object.keys(supply).length > 0;
  const multiplier = new Map(); // name -> price multiplier
  const reasons = new Map(); // name -> {need, cap, onExchange}

  // What one craft can buy: a share of a day of the whole exchange (or what's listed, if more);
  // items not on the exchange (beasts, Hinekora's recipe) are bought one at a time from players.
  const supplyCapOf = name => {
    if (hasNoSupplyCap(name) || !isFinite(basePrice(name))) {
      return null;
    }
    const market = supply[name];
    if (!market) {
      return opt.playerSupply;
    }
    const dayOfTrade = Math.max(market.stock ?? 0, market.perHour * 24);
    return Math.max(1, dayOfTrade * opt.supplyShare / 100);
  };
  // Seconds to buy and use one.
  const secondsPerUse = name => {
    if (isBulkItem(name)) {
      return 0;
    }
    return !haveMarket || supply[name] ? 2 : 60;
  };
  const chaosPerSecond = Math.max(0, +opt.timeValue || 0) / 3600;
  const price = name => {
    const value = basePrice(name);
    if (!isFinite(value)) {
      return value;
    }
    return value * (multiplier.get(name) ?? 1) + secondsPerUse(name) * chaosPerSecond;
  };
  // After a round: price up what the best plan needs beyond supply. Returns true if anything changed.
  const priceUpShortages = bestPlan => {
    let changed = false;
    for (const used of bestPlan?.usage?.items ?? []) {
      const cap = supplyCapOf(used.name);
      if (cap == null || !(used.q66 > cap * 1.05)) {
        continue;
      }
      multiplier.set(used.name, Math.min(500, (multiplier.get(used.name) ?? 1) * used.q66 / cap));
      reasons.set(used.name, { need: used.q66, cap, onExchange: !!supply[used.name] });
      changed = true;
    }
    return changed;
  };
  return { price, priceUpShortages, multiplier, reasons, rounds: opt.supplyCheck && haveMarket ? 4 : 1 };
}

function addSupplyNotes(plans, pricing) {
  if (!pricing.reasons.size) {
    return;
  }
  const parts = [];
  for (const [name, reason] of pricing.reasons) {
    const howMany = reason.onExchange
      ? `about ${fmtN(reason.cap)} can be bought for one craft`
      : `bought from players, about ${fmtN(reason.cap)} for one craft`;
    parts.push(`${name} ×${fmtN(pricing.multiplier.get(name))} (a cheaper-looking plan needed about ${fmtN(reason.need)}; ${howMany})`);
  }
  for (const plan of plans) {
    if (plan.ok) {
      plan.notes.push(`Priced up for limited supply, so the planner looked for other routes: ${parts.join('; ')}. Costs here use those prices.`);
    }
  }
}

// The fossil phase also shows the fossil plan with the fewest clicks, and one between that and
// the cheapest fossil plan.
function addFewestClickPlans(plans, B, spec, basePrice, index, onProgress, opt) {
  const fewest = fewestClicks(B, spec, basePrice, index, onProgress, opt);
  if (fewest) {
    plans.push(fewest);
  }
  // Between the cheapest fossil plan and the fewest clicks: each click priced at what a click
  // of the cheapest fossil plan costs on average, so time and currency weigh the same.
  const cheapest = plans.find(p => p.key === 'Fossils' && p.ok && p.clicks > 0);
  if (cheapest && fewest && fewest.clicksExact < cheapest.clicks * 0.8) {
    const balanced = fewestClicks(B, spec, basePrice, index, onProgress, opt, cheapest.cost / cheapest.clicks);
    // (Only when no other plan is both cheaper and needs fewer clicks.)
    const beaten = balanced && plans.some(p => p.ok && p.clicks > 0 && p.cost <= balanced.cost && p.clicks <= balanced.clicksExact);
    if (balanced && !beaten && balanced.cost < fewest.cost) {
      plans.push(balanced);
    }
  }
  sortPlansBestFirst(plans);
}

// ---------- which wanted mod is hardest ----------
//
// The mod to buy fractured, or to plan the craft around, is the one that costs most to get later,
// and that is not always the rarest one. A rare mod that a craft can aim at is easy later: on a wand
// Chaos Damage over Time Multiplier is weight 150 of about 66,000 suffix weight, but it's the only
// chaos suffix, so Harvest "add a chaos mod" lands it every time (only its tier is luck).
// rankModDifficulty works it out explicitly for each wanted mod, in this order:
//  1. Its weight: its share of its side's pool at the wanted tier or better, and the chance one
//     Chaos Orb rolls it.
//  2. Crafts that aim at it: an essence or bench craft that always gives it; Harvest "add a mod of
//     a type" for each of its types (counted on its own side: with the other side full or locked,
//     the add lands there); Harvest reforge with each of its types (its share of that type on both
//     sides, the guaranteed mod only).
//  3. Shared types: the other wanted mods with the same type (one Harvest add can land either, so it
//     doesn't force either), and how many unwanted mods on its side have it.
// Each way has a chance per pick: a random roll is the mod's share of its side's pool; a craft
// that aims is its share of what that craft can give. A mod's chance is its best way's; the hardest
// mod is the one with the lowest. Chances only, so the answer doesn't depend on prices (each way's
// cost per hit is shown beside it). Tiers count: a forced type still has to roll a good enough tier.
// It's a rule of thumb, mod by mod: it doesn't see what fossils give together or what the later
// steps make free (on a wand, Aetheric + Corroded + Metallic + Shuddering gives both +1 gem
// prefixes and a locked Veiled Chaos the veiled prefix, so the mod to fracture is the one nothing
// forces). The full plans ("Fractured base and side order") price every method.

// The Harvest types a mod can be aimed at with: the add types, then the reforge types.
function harvestTypesOf(mod) {
  const types = [];
  for (const tag of mod.tags) {
    if (HARVEST_ADD[tag] || HARVEST_REFORGE[tag]) {
      types.push(tag);
    }
  }
  return types;
}

// Sum of the pool weight of the entries for which keep(entry) is true.
function poolWeight(entries, keep) {
  let total = 0;
  for (const entry of entries) {
    if (keep(entry)) {
      total += entry.w;
    }
  }
  return total;
}

// One way to get a mod: {name, chance (per try), cost (per try, chaos), perHit, forced}.
function difficultyWay(name, chance, cost, forced = false) {
  let perHit = Infinity;
  if (chance > 0 && isFinite(cost)) {
    perHit = cost / chance;
  }
  return { name, chance, cost, perHit, forced };
}

// Every way to get one wanted mod, with the facts behind them (see rankModDifficulty).
function waysToGetMod(B, T, others, entries, sideWeight, options) {
  const { infl, price, essenceLevels } = options;
  const side = T.m.affix;
  const hitWeight = poolWeight(entries, entry => meets(T, entry.m, entry.t));
  const modWeight = poolWeight(entries, entry => entry.m === T.m);
  const ways = [];

  if (T.crafted) {
    ways.push(difficultyWay('Bench craft', 1, 0, true));
  }
  if (T.m.src === 'veiled') {
    // A Veiled Chaos Orb puts a veiled mod on a random open side (one of two), then unveiling
    // offers three by weight.
    const unveilChance = unveilOdds(B, T.m);
    ways.push(difficultyWay('Veiled Chaos Orb, then unveil', unveilChance / 2, price(CUR.vchaos)));
  }
  for (const essenceMod of essenceModsFor(B, T)) {
    for (let tier = essenceMod.tiers.length - 1; tier >= 0; tier--) {
      if (!essenceTierReaches(essenceMod, tier, T)) {
        continue;
      }
      const name = essenceName(essenceMod, tier, essenceLevels ?? []);
      ways.push(difficultyWay(name, 1, price(name), true));
      break; // (the cheapest essence level that reaches the tier)
    }
  }
  // A random roll (a reforge or a slam): its share of its side. (One Chaos Orb rolls several
  // mods, so its chance per orb is higher: chaosChance, shown beside it.)
  let chaosChance = 0;
  if (hitWeight > 0) {
    chaosChance = odds(newItem(B, { ilvl: options.ilvl, infl, rarity: 'rare' }), [T], RARE_COUNTS[B.slots] ?? RARE_COUNTS[6]);
    const randomRoll = difficultyWay('Random roll', hitWeight / sideWeight[side], NaN);
    // (Its cost per hit: Chaos Orbs, each rolling the item once.)
    if (chaosChance > 0) {
      randomRoll.perHit = price(CUR.chaos) / chaosChance;
    }
    ways.push(randomRoll);
  }

  const shared = [];
  for (const tag of harvestTypesOf(T.m)) {
    const sameSideTagWeight = poolWeight(entries, entry => entry.m.affix === side && entry.m.tags.includes(tag));
    const bothSidesTagWeight = poolWeight(entries, entry => entry.m.tags.includes(tag));
    const otherModsOnSide = new Set();
    const otherModsAnySide = new Set();
    for (const entry of entries) {
      if (entry.m.tags.includes(tag) && entry.m !== T.m) {
        otherModsAnySide.add(entry.m);
        if (entry.m.affix === side) {
          otherModsOnSide.add(entry.m);
        }
      }
    }
    const wantedWithTag = [];
    for (const other of others) {
      if (other.m.tags.includes(tag)) {
        wantedWithTag.push(other);
      }
    }
    shared.push({ tag, otherModsOnSide: otherModsOnSide.size, otherModsAnySide: otherModsAnySide.size, wanted: wantedWithTag });
    if (hitWeight <= 0) {
      continue;
    }
    // Harvest "add": the only mod of the type on its side means the add always lands this mod.
    if (HARVEST_ADD[tag] && !infl.length) {
      const [colour, amount] = HARVEST_ADD[tag];
      const addCost = amount * price(lifeforce(colour)) + price(SACRED);
      const onlyOneOfType = otherModsOnSide.size === 0;
      ways.push(difficultyWay(`Harvest: add a ${tag} mod`, hitWeight / sameSideTagWeight, addCost, onlyOneOfType));
    }
    if (HARVEST_REFORGE[tag]) {
      ways.push(difficultyWay(`Harvest reforge with a ${tag} mod`, hitWeight / bothSidesTagWeight, harvestCost(tag, price)));
    }
  }
  return {
    side,
    hitWeight,
    sideWeight: sideWeight[side] ?? 0,
    weightShare: sideWeight[side] ? hitWeight / sideWeight[side] : 0,
    tierShare: modWeight ? hitWeight / modWeight : 0,
    chaosChance,
    chaosPerHit: chaosChance > 0 ? price(CUR.chaos) / chaosChance : Infinity,
    ways,
    shared,
  };
}

// The way with the best chance per pick (a forced craft before a Harvest one at equal chance).
function likeliestWay(ways) {
  let best = null;
  for (const way of ways) {
    if (!best || way.chance > best.chance || (way.chance === best.chance && way.forced && !best.forced)) {
      best = way;
    }
  }
  return best;
}

// The reason for a mod's place, in a sentence.
function difficultyReason(row) {
  const best = row.best;
  if (!best || best.chance <= 0) {
    return 'Nothing on this base rolls it at that tier.';
  }
  if (best.forced && best.chance >= 1) {
    return `${best.name} always gives it: no luck needed.`;
  }
  if (row.target.m.src === 'veiled') {
    return `Only from a veiled mod: it lands on its side about half the time, and unveiling offers it ${pctText(best.chance * 2)} of the time.`;
  }
  const forcedAdd = row.ways.find(way => way.forced && way.chance < 1);
  if (forcedAdd) {
    const tag = harvestTagOfWay(forcedAdd);
    return `The only ${tag} ${SIDE_NAME[row.side]}: ${forcedAdd.name} always adds it, and ${pctText(forcedAdd.chance)} of the time at the wanted tier.`;
  }
  const harvestTag = harvestTagOfWay(best);
  if (harvestTag) {
    const share = row.shared.find(x => x.tag === harvestTag);
    // (An add lands on the mod's side; a reforge's guaranteed mod can be on either side.)
    const isReforge = best.name.startsWith('Harvest reforge');
    const wantedHere = share.wanted.filter(other => isReforge || other.m.affix === row.side);
    const wantedNames = wantedHere.map(other => modText(other.m, other.minTier)).join(', ');
    const wantedText = wantedNames ? ` (also wanted: ${wantedNames})` : '';
    const otherCount = isReforge ? share.otherModsAnySide : share.otherModsOnSide;
    const otherText = isReforge ? `${otherCount} other mod${otherCount === 1 ? '' : 's'} on either side` : `${otherCount} other ${SIDE_NAME[row.side]}${otherCount === 1 ? '' : 'es'}`;
    return `Its ${harvestTag} type is shared with ${otherText}${wantedText}: ${best.name} lands it ${pctText(best.chance)} of the time (a random roll: ${pctText(row.weightShare)}).`;
  }
  const typeTexts = [];
  for (const share of row.shared) {
    typeTexts.push(`${share.tag} with ${share.otherModsOnSide} other ${SIDE_NAME[row.side]}${share.otherModsOnSide === 1 ? '' : 'es'}`);
  }
  if (typeTexts.length) {
    return `Weight ${pctText(row.weightShare)} of the ${SIDE_NAME[row.side]}es, and its types are too common for a Harvest craft to beat that (${typeTexts.join('; ')}).`;
  }
  return `Weight ${pctText(row.weightShare)} of the ${SIDE_NAME[row.side]}es, and it has no type a Harvest craft can aim at: only random rolls.`;
}

// The Harvest type a way aims with ("Harvest: add a chaos mod" -> "chaos"), or null.
function harvestTagOfWay(way) {
  const match = /^Harvest(?:: add an?| reforge with an?) (\w+) mod$/.exec(way.name);
  return match ? match[1] : null;
}

// Every wanted mod with what it takes to get it, hardest first (see the comment above).
// targets: [{m, minTier, crafted?}]. options: {ilvl, infl, price(name), essenceLevels}.
// Returns [{target, label, side, weightShare, tierShare, chaosChance, chaosPerHit, ways, shared,
// best, reason, hardest, canFracture}]; hardest is true on the first row that can be bought fractured.
export function rankModDifficulty(B, targets, options = {}) {
  const settings = { ilvl: options.ilvl ?? 86, infl: options.infl ?? [], price: options.price ?? (() => NaN), essenceLevels: options.essenceLevels };
  const entries = pool(newItem(B, { ilvl: settings.ilvl, infl: settings.infl, rarity: 'rare' }));
  const sideWeight = { p: 0, s: 0 };
  for (const entry of entries) {
    sideWeight[entry.m.affix] += entry.w;
  }
  const rows = [];
  for (const T of targets) {
    if (T.m.affix !== 'p' && T.m.affix !== 's') {
      continue; // (implicits: Eldritch currency, planned on their own)
    }
    // (Only mods that roll share a type with it: a Harvest craft can't give a veiled or bench mod.)
    const others = targets.filter(other => other !== T && !other.crafted && other.m.src !== 'veiled');
    const facts = waysToGetMod(B, T, others, entries, sideWeight, settings);
    const row = { target: T, label: modText(T.m, T.minTier), ...facts };
    row.best = likeliestWay(row.ways);
    row.reason = difficultyReason(row);
    row.canFracture = !settings.infl.length && !T.crafted && T.m.src !== 'veiled';
    rows.push(row);
  }
  const bestChance = row => (row.best ? row.best.chance : 0);
  rows.sort((a, b) => bestChance(a) - bestChance(b));
  const hardest = rows.find(row => row.canFracture);
  if (hardest) {
    hardest.hardest = true;
  }
  return rows;
}

// A plan as it can leave the worker before it is finished: without the solve it came from (the
// graph and currency count come with the finished plan).
const SOLVE_ONLY_FIELDS = ['sol', 'extra', 'startOuts', 'startSol', 'opening', 'pasteSim', 'makeGraph', 'makeUsage'];
export function planPreview(plan) {
  const preview = { ...plan, preview: true };
  for (const field of SOLVE_ONLY_FIELDS) {
    delete preview[field];
  }
  if (plan.steps) {
    preview.steps = plan.steps.map(step => {
      const copy = { ...step };
      delete copy.simKey;
      return copy;
    });
  }
  if (plan.notes) {
    preview.notes = [...plan.notes];
  }
  return preview;
}

// onPlan (optional): called with a preview of each plan (planPreview) as soon as it is made, before
// the rest are worked out; the returned list has the finished plans.
export function plan(B, spec, basePrice, index, onProgress = () => {}, onPlan = null) {
  const opt = { ...DEFAULT_OPTIONS, ...(spec.options ?? {}) };
  // An item has either an influence or Eldritch (Exarch / Eater) implicits, never both.
  const wantsEldritch = spec.targets.some(t => t.m.affix === 'r' || t.m.affix === 'b');
  if (spec.infl?.length && wantsEldritch) {
    return [noWayPlan(`An influenced item can't have Searing Exarch or Eater of Worlds implicits. Untick the Eldritch implicits, or remove the ${spec.infl.join(' + ')} influence.`)];
  }
  if (opt.ruthless) {
    basePrice = ruthlessPrices(basePrice);
    Object.assign(opt, RUTHLESS_FORCED);
    spec = { ...spec, options: { ...spec.options, ...RUTHLESS_FORCED } };
  }

  const pricing = makeSupplyPricing(basePrice, spec.supply ?? {}, opt);
  let plans;
  for (let round = 0; ; round++) {
    const isLastRound = round === pricing.rounds - 1;
    const roundProgress = round ? step => onProgress(`${step} (re-planned for supply, round ${round + 1})`) : onProgress;
    plans = planRound(B, spec, pricing.price, index, roundProgress, !isLastRound, onPlan);
    if (isLastRound) {
      break;
    }
    const best = plans.find(p => p.ok);
    if (!pricing.priceUpShortages(best)) {
      finishPlans(plans, onProgress);
      break;
    }
  }
  addSupplyNotes(plans, pricing);

  if (Array.isArray(plans)) {
    for (const p of plans) {
      if (p.usage) {
        p.clicks = clicksOf(p.usage.items, opt);
      }
    }
  }
  if (spec.phase === 'fossil' && Array.isArray(plans)) {
    addFewestClickPlans(plans, B, spec, basePrice, index, onProgress, opt);
  }
  return plans;
}

// Clicks: every currency, fossil, resonator, beast or bench craft used is one click; bulk
// payments (Thaumaturgic Dust, gold, Sulphur, lifeforce) are not, but one recombine is.
const BULK_RE = /Lifeforce$/;

function clicksOf(items, opt) {
  let clicks = 0;
  for (const x of items ?? []) {
    if (x.name === DUST) {
      clicks += x.mean / Math.max(1, opt.recombDust);
    } else if (x.name === GOLD || x.name === SULPHUR || x.name === ELD_VALUE || x.name === DONOR_VALUE || BULK_RE.test(x.name)) {
      continue;
    } else {
      clicks += x.mean;
    }
  }
  return clicks;
}

// The fossil plan with the fewest clicks: the same solve with every click priced at 1 (Harvest
// and the Allflame bench left out: they're paid in bulk), then its chaos cost from simulated
// crafts at the real prices.
// clickValue: price each click at that many chaos on top of the currency (a balanced plan).
function fewestClicks(B, spec, basePrice, index, onProgress, opt, clickValue = null) {
  const balanced = clickValue != null;
  onProgress(balanced ? 'Fossils, balancing cost and clicks' : 'Fossils, fewest clicks');
  const clickPrice = name => {
    const value = basePrice(name);
    if (!isFinite(value) || name === SULPHUR || BULK_RE.test(name) || /Crystallised Rancour$/.test(name)) {
      return NaN;
    }
    if (name === DUST || name === GOLD || name === ELD_VALUE || name === DONOR_VALUE) {
      return balanced ? value : 0;
    }
    return balanced ? value + clickValue : 1;
  };
  let solved;
  try {
    solved = planOnce(B, { ...spec, phase: 'clicks', clickValue }, clickPrice, index, () => {}, null, { sub: true });
  } catch (e) {
    if (SOLVER.debug) {
      SOLVER.debug('clicks: ' + e.message);
    }
    return null;
  }
  const result = solved?.results?.[0];
  if (!result?.makeUsage) {
    return null;
  }
  const used = result.makeUsage();
  let chaos = 0;
  for (const x of used.items) {
    const unitPrice = x.name === ELD_VALUE || x.name === DONOR_VALUE ? 1 : basePrice(x.name) || 0;
    chaos = chaos + x.mean * unitPrice;
  }
  const clicks = clicksOf(used.items, opt);
  for (const step of result.steps) {
    delete step.simKey;
    if (balanced) {
      continue; // (a balanced plan's values are chaos plus clicks: leave them out)
    }
    step.clicksLeft = step.rem;
    delete step.rem;
    delete step.cost;
  }
  if (balanced) {
    for (const step of result.steps) {
      delete step.rem;
      delete step.cost;
    }
  }
  const common = { ok: true, cost: chaos, steps: result.steps, usage: { items: used.items, runs: used.runs, unfinished: used.unfinished } };
  if (balanced) {
    return {
      ...common,
      key: 'fosbalanced',
      name: 'Fossils, cost and clicks balanced',
      clicksExact: clicks,
      notes: [`A fossil plan that counts each click as ${fmtC(clickValue)} on top of the currency (what a click of the cheapest fossil plan costs on average), so it trades some chaos for far fewer clicks. Cost and clicks are counted from ${used.runs} simulated crafts at today's prices.`],
    };
  }
  return {
    ...common,
    key: 'fosclicks',
    name: 'Fossils, fewest clicks',
    clicksExact: result.cost,
    notes: [`The fossil plan that needs the fewest clicks (each fossil, resonator, orb, beast or bench craft is one; about ${fmtN(result.cost)} on average), whatever it costs. Its cost is counted from ${used.runs} simulated crafts at today's prices, so it moves a little between runs.`],
  };
}

// Harvest swaps (resistances, and damage with Rancour) cost a fixed amount each time a
// target lands in the wrong element; whether that beats rolling for the right element
// depends on prices, so solve with and without each swap and keep the cheaper plan.
function planRound(B, spec, price, index, onProgress, quick, onPlan = null) {
  const first = planOnce(B, spec, price, index, onProgress, null, { quick, onPlan });
  if (!first.swappable) {
    return first;
  }
  const swapIds = first.swappable.map(x => x.id);
  // Every subset of the swaps but "all of them" (that was the first pass); with more than 3
  // swaps, only "none".
  const subsets = [];
  if (swapIds.length <= 3) {
    for (let mask = 0; mask < (1 << swapIds.length) - 1; mask++) {
      subsets.push(new Set(swapIds.filter((x, i) => mask & (1 << i))));
    }
  } else {
    subsets.push(new Set());
  }
  // The extra passes only re-solve Best mix, from the first pass's strategy and fossil choices.
  // The cheapest version of each plan is kept as each pass finishes (a beaten one, and the solve
  // it holds, can go right away).
  const bestByName = new Map();
  const keepCheapest = pass => {
    for (const p of pass.results) {
      if (!bestByName.has(p.name) || p.cost < bestByName.get(p.name).cost) {
        bestByName.set(p.name, p);
      }
    }
  };
  keepCheapest(first);
  for (let i = 0; i < subsets.length; i++) {
    onProgress(`Without some swaps (${i + 1} of ${subsets.length})`);
    keepCheapest(planOnce(B, spec, price, index, () => {}, subsets[i], { bestOnly: true, warm: first.bestSol, fossilCombos: first.fossilCombos }));
  }
  const sorted = sortPlansBestFirst([...bestByName.values()]);
  for (const p of sorted) {
    if (!p.ok) {
      continue;
    }
    const unused = first.swappable.filter(x => !p.swapsUsed?.has(x.id));
    if (unused.length) {
      const list = unused.map(x => `a wrong-element ${x.label} (${fmtC(x.cost)} a swap)`).join('; ');
      p.notes.push(`Not worth swapping at these prices: ${list}. This plan rolls for the right element instead.`);
    }
  }
  return finishPlans(sorted, onProgress, quick);
}

// Each step's expected cost left from there (fromHere) and spent to get there (spent = the
// plan's total minus that). A state step's rem covers the rest of the main craft; steps after
// the last one (swaps, Eldritch implicits, the bench) and before the first (influence,
// implicits, the Recombinator) add their own cost.
function costsAlong(plan) {
  if (!plan.ok || !plan.steps?.length || plan.costMode === 'own' || !plan.steps.some(s => s.rem != null)) {
    return;
  }
  const ownCost = step => step.own ?? step.cost ?? 0;
  const isStateStep = step => step.rem != null;
  const steps = plan.steps;
  const lastStateStep = steps.map(isStateStep).lastIndexOf(true);
  let tailCost = 0;
  for (const step of steps.slice(lastStateStep + 1)) {
    tailCost = tailCost + ownCost(step);
  }
  let fromHere = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    fromHere = isStateStep(step) ? step.rem + tailCost : ownCost(step) + fromHere;
    step.fromHere = fromHere;
  }
  // (The likeliest path can land on a state worse than the average result, where more is
  // left than before; what's been spent never goes down.)
  // Before the first state step (influence, an opening's items), spent is what those steps cost.
  const firstStateStep = steps.findIndex(isStateStep);
  let spent = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (i >= firstStateStep) {
      spent = Math.max(spent, plan.cost - step.fromHere);
    }
    step.spent = spent;
    if (i < firstStateStep) {
      spent += ownCost(step);
    }
  }
}

// Runs fn, logging (not throwing) a failure under the label.
function tryOrLog(label, fn) {
  try {
    fn();
  } catch (e) {
    if (SOLVER.debug) {
      SOLVER.debug(label + ': ' + e.message);
    }
  }
}

function countCurrency(plan) {
  tryOrLog('usage', () => {
    plan.usage = plan.makeUsage();
    delete plan.usage.raw;
  });
}

// quick: only count the best plan's currency (for the supply check); a later full call finishes.
function finishPlans(sorted, onProgress, quick = false) {
  if (quick) {
    onProgress('Checking supply');
    const best = sorted.find(p => p.ok && p.makeUsage);
    if (best) {
      countCurrency(best);
    }
    return sorted;
  }
  // State graphs for the three best plans (the simulation is the slow part).
  onProgress('Drawing the state graph');
  for (const p of sorted.filter(x => x.makeGraph).slice(0, 3)) {
    tryOrLog('graph', () => {
      p.graph = p.makeGraph();
      delete p.graph.used;
    });
  }
  // Currency used: a simulation of its own that lets long crafts run to the end.
  onProgress('Counting currency');
  for (const p of sorted) {
    if (p.makeUsage && !p.usage) {
      countCurrency(p);
    }
  }
  for (const p of sorted) {
    for (const step of p.steps ?? []) {
      const runs = step.simKey && p.usage?.stepRuns?.get(step.simKey);
      if (runs) {
        step.runs = runs;
      }
      delete step.simKey;
    }
    if (p.usage) {
      delete p.usage.stepRuns;
    }
  }
  // Other starting points: their own graphs (the fossil plans only), and costs along their steps.
  for (const p of sorted) {
    if (!p.ok) {
      continue;
    }
    for (const start of p.starts ?? []) {
      if (start.makeGraph) {
        tryOrLog('start graph', () => {
          start.graph = start.makeGraph();
          delete start.graph.used;
        });
      }
      delete start.makeGraph;
      costsAlong({ ok: true, cost: p.cost, steps: start.steps });
    }
  }
  for (const p of sorted) {
    delete p.makeGraph;
    delete p.makeUsage;
    delete p.swapsUsed;
    costsAlong(p);
  }
  return sorted;
}

// ---------- planOnce setup helpers ----------

// What kind of roll a target needs: 'veiled' (unveiled from a veiled mod), 'essence' (only an
// essence gives it) or 'roll' (it rolls normally).
function targetKindOf(mod) {
  if (mod.src === 'veiled') {
    return 'veiled';
  }
  if (mod.src === 'essence') {
    return 'essence';
  }
  return 'roll';
}

// Sorts the picked targets: Eldritch implicits (planned on their own), explicit mods, bench
// crafts (added last), the fractured pick, and the rolled targets the main solve works on.
function splitTargets(spec) {
  const eldritch = spec.targets.filter(t => t.m.affix === 'r' || t.m.affix === 'b');
  const explicit = spec.targets.filter(t => t.m.affix === 'p' || t.m.affix === 's');
  const bench = explicit.filter(t => t.crafted);
  const presetFractured = spec.useFractured ? explicit.find(t => t.frac && !t.crafted) : null;
  const rolled = [];
  for (const t of explicit) {
    if (!t.crafted) {
      rolled.push({ ...t, side: t.m.affix, kind: targetKindOf(t.m) });
    }
  }
  return { eldritch, explicit, bench, presetFractured, rolled };
}

function sumWeightsWhere(entries, test) {
  let total = 0;
  for (const entry of entries) {
    if (test(entry)) {
      total += entry.w;
    }
  }
  return total;
}

// Harvest resistance swap: a fire/cold/lightning resistance target is also met by the
// other elements at a similar tier, then swapped (500 lifeforce).
// With Crystallised Rancour, a fire/cold/lightning damage target works the same way.
// Sets target.alts on the targets that can be swapped. Returns {swaps, swappable}:
// swappable lists every target that could be (for the notes), swaps the ones allowed by swapIds.
function planHarvestSwaps(B, targets, opt, P, swapIds, ilvl, infl) {
  const swaps = [];
  const swappable = [];
  const rancourOn = opt.rancour && isFinite(P(RANCOUR));
  for (const t of targets) {
    if (t.kind !== 'roll' || opt.ruthless) {
      continue; // (no Harvest swaps in Ruthless)
    }
    const resistanceMatch = t.m.src === 'base' && t.m.text.match(RES_RE);
    let element = null;
    if (resistanceMatch) {
      element = resistanceMatch[1];
    } else if (rancourOn && ELEMENTS.some(e => damageSwap(B, t.m, e))) {
      element = singleElementOf(t.m);
    }
    if (!element) {
      continue;
    }
    const entry = { id: t.m.id, label: resistanceMatch ? `${element} resistance` : `"${t.m.text}"` };
    swappable.push(entry);
    if (swapIds && !swapIds.has(t.m.id)) {
      continue;
    }
    let others;
    if (resistanceMatch) {
      others = B.mods.filter(m => m !== t.m && m.src === 'base' && m.affix === t.side && RES_RE.test(m.text));
    } else {
      others = ELEMENTS.map(e => damageSwap(B, t.m, e)).filter(Boolean);
    }
    const alts = [];
    for (const m of others) {
      if (!targets.some(o => o.m === m)) {
        alts.push({ m, minTier: swapTier(t.m, t.minTier, m) });
      }
    }
    if (!alts.length) {
      continue;
    }
    t.alts = alts;
    const fresh = freshRarePool(B, ilvl, infl);
    const ownWeight = sumWeightsWhere(fresh, e => e.m === t.m && e.t >= t.minTier);
    const otherWeight = sumWeightsWhere(fresh, e => alts.some(a => a.m === e.m && e.t >= a.minTier));
    const colour = RES_SWAP[element];
    const rancourCost = resistanceMatch ? 0 : DMG_SWAP_RANCOUR * P(RANCOUR);
    const cost = RES_SWAP_AMOUNT * P(lifeforce(colour)) + rancourCost;
    swaps.push({
      t,
      share: otherWeight / Math.max(1e-9, ownWeight + otherWeight),
      cost,
      colour,
      element,
      what: resistanceMatch ? 'resistance' : `damage mod ("${t.m.text}")`,
      rancour: !resistanceMatch,
    });
    entry.cost = cost;
  }
  return { swaps, swappable };
}

// The Harvest swap steps that come at the end of a plan.
function harvestSwapSteps(swaps) {
  const steps = [];
  for (const swap of swaps) {
    if (!(swap.share > 0.01 && isFinite(swap.cost))) {
      continue;
    }
    const rancour = swap.rancour ? ` + ${DMG_SWAP_RANCOUR} Crystallised Rancour` : '';
    steps.push({
      text: `Harvest: if the ${swap.element} ${swap.what} rolled as another element (about ${pctText(swap.share)} of the time), change it to ${swap.element} (${RES_SWAP_AMOUNT} ${swap.colour} Lifeforce${rancour}).`,
      p: 1,
      cost: swap.share * swap.cost,
      how: 'Harvest swap',
    });
  }
  return steps;
}

// Getting the influences onto the base: Harvest randomise influence (1 in 6 for the one
// you want), and Awakener's Orb with a cheap item of the other influence for a second.
function influenceSetup(B, infl, ilvl, opt, P) {
  const steps = [];
  let cost = 0;
  if (!infl.length || !opt.influenceSetup || B.innateInfl) {
    return { steps, cost };
  }
  const randomiseCost = INFLUENCE_RANDOMISE[1] * P(lifeforce(INFLUENCE_RANDOMISE[0]));
  if (isFinite(randomiseCost)) {
    cost += 6 * randomiseCost;
    steps.push({
      text: `Start from any influenced ${B.name} at item level ${ilvl}+, and use the Harvest craft "randomise influence" (${INFLUENCE_RANDOMISE[1]} ${INFLUENCE_RANDOMISE[0]} Lifeforce) until it is ${infl[0]}: 1 in 6, about 6 crafts. (Or buy the base with that influence.)`,
      p: 1 / 6,
      cost: 6 * randomiseCost,
      how: 'Influence',
    });
  }
  if (infl.length > 1 && isFinite(P(AWAKENER))) {
    cost += P(AWAKENER) + 2;
    steps.push({
      text: `Buy any cheap item with ${infl[1]} influence and use an Awakener's Orb: the ${infl[1]} item is destroyed and your base becomes ${infl[0]} + ${infl[1]} (use your base second).`,
      p: 1,
      cost: P(AWAKENER) + 2,
      how: 'Influence',
    });
  }
  return { steps, cost };
}

function impossiblePlan(key, name, why) {
  return { key, name, ok: false, cost: Infinity, steps: [], notes: [], why };
}

// Picks that can't all be on one item. Returns a "no plan" result, or null when they fit.
function checkTargetsFit(B, picked, infl) {
  // Fractured and influenced don't mix: a Fracturing Orb needs a non-influenced item, and
  // influenced Exalted Orbs, the Awakener's Orb and Harvest influence crafts refuse fractured ones.
  if (picked.presetFractured && infl.length) {
    return [impossiblePlan('fracinfl', 'Fractured and influenced',
      `A fractured base can't be ${infl.join(' + ')}-influenced: influenced Exalted Orbs, the Awakener's Orb and Harvest influence crafts don't work on fractured items, and Fracturing Orbs don't work on influenced ones. Untick "fractured" or remove the influence.`)];
  }
  // Two picks from one mod group can't both be on an item (base and essence Life, a rolled
  // and a bench-crafted Dexterity, Shaper's and Redeemer's copy of a mod).
  const explicit = picked.explicit;
  for (let i = 0; i < explicit.length; i++) {
    for (let j = i + 1; j < explicit.length; j++) {
      const a = explicit[i];
      const b = explicit[j];
      if (a.m.groups.some(g => b.m.groups.includes(g))) {
        const aText = `"${modText(a.m, a.minTier)}"${a.crafted ? ' (bench)' : ''}`;
        const bText = `"${modText(b.m, b.minTier)}"${b.crafted ? ' (bench)' : ''}`;
        return [impossiblePlan('group', 'Mutually exclusive mods',
          `${aText} and ${bText} are the same kind of mod (one mod group): an item can only have one of them. Untick one.`)];
      }
    }
  }
  if (picked.rolled.length > 8) {
    return [{ key: 'too', name: 'Too many mods', ok: false, cost: Infinity, why: 'Pick at most 8 mods to roll (bench crafts don\'t count).', steps: [] }];
  }
  for (const side of ['p', 's']) {
    let onSide = explicit.filter(t => t.m.affix === side).length;
    if (side === 's' && picked.bench.length > 1) {
      onSide += 1; // "Can have up to 3 Crafted Modifiers"
    }
    if (onSide > B.max[side]) {
      return [impossiblePlan('full', 'Too many ' + SIDE_NAME[side] + 'es',
        `${onSide} of the ticked mods are ${SIDE_NAME[side]}es, but this base holds ${B.max[side]}. Untick one.`)];
    }
  }
  return null;
}

// One planning pass. swapIds: the target mod ids whose Harvest swap may be used (null: all).
// Returns a finished plan list when there is nothing to swap, else {results, swappable}.
// ctx.sub: a helper solve (no graphs, raw results); ctx.reserve: extra slots ({p, s}) to leave open.
//
// Names used all through planOnce:
//   P(name)  the price of a currency in chaos (NaN if unknown)
//   T        the rolled targets, T[k] = {m, minTier, side, kind, alts?}; K = T.length
//   a state  (F, st, jp, js): F = the fractured target's index (-1 none, -2 ruined: a junk mod
//            fractured, -3/-4 a junk prefix/suffix fractured on a pasted item); st[k] = 0 missing,
//            1 on the item, 2 dead (a wrong tier of its mod group blocks it); jp/js = junk
//            prefixes/suffixes on the item. enc() turns it into a key.
function planOnce(B, spec, price, index, onProgress, swapIds, ctx = {}) {
  const { ilvl, infl } = spec;
  const opt = { ...DEFAULT_OPTIONS, ...(spec.options ?? {}) };
  const P = name => {
    const value = price(name);
    return isFinite(value) ? value : NaN;
  };
  // spec.phase splits the work so the page can show plans early: 'base' leaves fossils out,
  // 'fossil' adds them (fossil plans, Best mix and the Recombinators with fossils), 'clicks'
  // prices every currency used at 1 to find the fossil plan with the fewest clicks.
  const phase = spec.phase ?? null;
  // (spec.clickValue: chaos per click, for a plan that weighs both; then only Harvest's and the
  // Allflame bench's bulk payments are left out, and prices stay real.)
  if (phase === 'clicks' && spec.clickValue == null) {
    P.clicks = true;
  }
  if (phase === 'clicks' && spec.clickValue != null) {
    P.clickValue = spec.clickValue;
  }
  // Ruthless: no bench crafts, and Harvest's randomise-influence is a reforge (those are gone).
  if (opt.ruthless) {
    P.noBench = true;
    opt.influenceSetup = false;
  }

  const picked = splitTargets(spec);
  const eldT = picked.eldritch;
  const benchT = picked.bench;
  const presetF = picked.presetFractured;
  const T = picked.rolled;
  const rancourOn = opt.rancour && isFinite(P(RANCOUR));
  const { swaps, swappable } = planHarvestSwaps(B, T, opt, P, swapIds, ilvl, infl);
  let swapCostTotal = 0;
  for (const swap of swaps) {
    swapCostTotal = swapCostTotal + (isFinite(swap.cost) ? swap.share * swap.cost : 0);
  }

  // Eldritch implicit targets: Embers/Ichors, and Orbs of Conflict for the top tiers.
  const eldSteps = [];
  let eldTargetCost = 0;
  if (eldT.length) {
    const want = {};
    for (const t of eldT) {
      want[t.m.affix] = { m: t.m, tier: t.minTier };
    }
    const eldritch = eldritchPlan(B, want, P);
    eldTargetCost = eldritch.cost;
    eldSteps.push(...eldritch.steps);
  }
  const influence = influenceSetup(B, infl, ilvl, opt, P);
  const inflSteps = influence.steps;
  const inflCost = influence.cost;
  const extraTotal = swapCostTotal + eldTargetCost + inflCost;
  // The steps after the main craft: Harvest swaps, then the Eldritch implicits.
  const finalSteps = (swapsUsed = swaps) => [...harvestSwapSteps(swapsUsed), ...eldSteps];
  const K = T.length;

  const doesNotFit = checkTargetsFit(B, picked, infl);
  if (doesNotFit) {
    return doesNotFit;
  }
  const fixedF = picked.presetFractured ? T.findIndex(t => t.m === picked.presetFractured.m) : -1;

  // Slots the bench crafts need at the end ("Can have up to 3 Crafted Modifiers" is a suffix).
  const reserve = { p: benchT.filter(t => t.m.affix === 'p').length, s: benchT.filter(t => t.m.affix === 's').length };
  if (benchT.length > 1) {
    reserve.s++;
  }
  if (ctx.reserve) {
    reserve.p += ctx.reserve.p;
    reserve.s += ctx.reserve.s;
  }
  let benchCostTotal = 0;
  for (const t of benchT) {
    benchCostTotal = benchCostTotal + (benchCost(t.m, t.minTier, P) ?? 0);
  }
  benchCostTotal = benchCostTotal + (benchT.length > 1 ? (benchCost(findMetamod(B, 'mul_mods'), 0, P) ?? 0) : 0);

  // A target's short text, by index.
  const label = k => shortMod(T[k].m, T[k].minTier);
  // One clean Recombinator input, for the recipe cards: Alteration until it shows exactly the core,
  // then (maybe) a Regal for one more.
  const recHalf = (ks, input) => ({
    mods: ks.map(k => ({ text: label(k), side: T[k].side, regal: k === input.rest })),
    alt: { mods: input.core.map(label), p: input.pAlt, aug: input.core.length === 2 },
    regal: input.rest >= 0 ? { mod: label(input.rest), p: input.pr, imprint: input.useImp } : null,
    cost: input.cost,
  });
  // What an Alteration can aim for: one or two of these targets that a magic item of this base
  // can hold together (one prefix and one suffix normally; two suffixes on a Helical Ring,
  // nothing at all on a Focused or Simplex Amulet, where Alterations add no mods).
  const magicMax = B.magicMax ?? { p: 1, s: 1 };
  const magicCores = ks => {
    const fitsMagicItem = core => ['p', 's'].every(side => core.filter(k => T[k].side === side).length <= magicMax[side]);
    const cores = ks.map(k => [k]).filter(fitsMagicItem);
    for (let i = 0; i < ks.length; i++) {
      for (let j = i + 1; j < ks.length; j++) {
        if (fitsMagicItem([ks[i], ks[j]])) {
          cores.push([ks[i], ks[j]]);
        }
      }
    }
    return cores;
  };
  const veiledK = T.findIndex(t => t.kind === 'veiled');
  // Stand-ins for "a wrong tier of target k" on example items: they only block k's groups.
  const deadMods = T.map(t => ({ id: -1, text: '', affix: t.side, src: 'junk', groups: t.m.groups, tags: [], tiers: [{ ilvl: 0, w: 0, values: [] }] }));
  const max = B.max;
  // A metamod ("Prefixes/Suffixes Cannot Be Changed", "Cannot roll Attack Modifiers", ...): the
  // bench, or a Wild Bristle Matron, which adds a random metamod that fits an open side. On
  // these bases that's 1 prefix metamod and 4 suffix ones, so with only a suffix open it's
  // 1 in 4. A wrong one costs an Orb of Scouring to remove at the bench, then try again: on
  // average N Matrons and N - 1 Scourings. prefixCount/suffixCount: mods on each side before it.
  const metas = B.mods.filter(m => m.meta && m.src === 'bench');
  function lockPrice(lock, prefixCount, suffixCount) {
    const benchPrice = benchCost(lock, 0, P);
    let best = { cost: benchPrice ?? Infinity, via: 'bench', bill: benchBill(lock, 0) };
    if (opt.matron && isFinite(P(MATRON))) {
      const fitting = metas.filter(m => (m.affix === 'p' ? prefixCount < max.p : suffixCount < max.s));
      if (fitting.includes(lock)) {
        const scourCost = fitting.length > 1 ? (fitting.length - 1) * P(CUR.scour) : 0;
        const matronCost = fitting.length * P(MATRON) + scourCost;
        if (matronCost < best.cost) {
          const via = fitting.length === 1
            ? 'Wild Bristle Matron'
            : `Wild Bristle Matron (1 in ${fitting.length}; remove a wrong one at the bench for an Orb of Scouring)`;
          const bill = combineBills(billOf(MATRON, fitting.length), fitting.length > 1 ? billOf(CUR.scour, fitting.length - 1) : null);
          best = { cost: matronCost, via, bill };
        }
      }
    }
    return best;
  }
  const lockName = (lock, lockPriceInfo) => `"${lock.text}"${lockPriceInfo.via === 'bench' ? '' : ` via ${lockPriceInfo.via}`}`;
  // Allflame bench: the same currency shows several outcomes and you keep the best.
  const sulphur = isFinite(P(SULPHUR)) ? P(SULPHUR) : NaN;
  const afK = Math.max(1, Math.min(4, opt.allflameK | 0));
  const afOn = opt.allflame && isFinite(sulphur) && afK > 1;
  // Each Allflame craft adds Intangibility to the item (5-20%, allflameIntang on average): the
  // chance a later craft shows just one outcome. The planner counts the crafts per item (a new
  // base starts again at 0) and stops at allflameUses.
  const afUses = Math.max(1, Math.min(6, opt.allflameUses | 0 || 2));
  const afStep = Math.max(0, Math.min(100, +opt.allflameIntang || 0)) / 100;
  const afShow = craftsSoFar => Math.max(0, 1 - craftsSoFar * afStep); // chance the next craft shows its outcomes
  // The reforges and moves the Allflame bench can do.
  const AF_REF = family => family === 'chaos' || family.startsWith('essence') || family === 'fossil' || family === 'vchaos' || family === 'lockchaos';
  const AF_MOVE = new Set(['exalt', 'block', 'meta', 'multimeta', 'annul', 'lockannul', 'typeannul', 'fracture', 'vexalt']);
  // Hinekora's Lock: one look at what the next currency will do; apply it only if the result
  // is good. Changing the item in any way ends the foresight, so a bad preview can't be
  // rerolled: that Lock is spent. On a magic item the Bestiary recipe (Craicic Croaker + Black
  // Mórrigan) gives it; a rare item needs the Hinekora's Lock currency itself (hundreds of
  // divines), so it only pays off on the last mods of a very expensive item.
  const hkMagicOn = opt.hinekora && HK_SETUP.every(n => isFinite(P(n)));
  const hkOn = opt.hinekora && isFinite(P(HK_LOCK));
  let hkSetup = 0;
  for (const name of HK_SETUP) {
    hkSetup = hkSetup + P(name);
  }
  const hkLock = P(HK_LOCK);


  // ----- states -----
  // A state's key: "F|st|jp js".
  const enc = (F, st, jp, js) => `${F}|${st.join('')}|${jp}${js}`;

  // How many targets in state `value` (1 on the item, 2 dead) are on a side.
  const targetsOnSide = (st, side, value) => {
    let n = 0;
    for (let k = 0; k < st.length; k++) {
      if (st[k] === value && T[k].side === side) {
        n++;
      }
    }
    return n;
  };
  // Wanted mods on a side.
  const sideCount = (st, side) => targetsOnSide(st, side, 1);

  // An example item in a state (wanted mods, stand-ins for dead and junk mods, plus `extra`),
  // for the pool and odds functions. jp/js count the dead targets too.
  function itemFor(F, st, jp, js, extra = []) {
    const item = newItem(B, { ilvl, infl, rarity: 'rare' });
    for (let k = 0; k < st.length; k++) {
      if (st[k] === 1) {
        item.mods.push({ m: T[k].m, t: T[k].minTier, side: T[k].side, frac: F === k });
      } else if (st[k] === 2) {
        item.mods.push({ m: deadMods[k], t: 0, side: T[k].side, filler: true });
      }
    }
    const junkPrefixes = jp - targetsOnSide(st, 'p', 2);
    const junkSuffixes = js - targetsOnSide(st, 's', 2);
    for (let i = 0; i < junkPrefixes; i++) {
      item.mods.push({ m: null, t: 0, side: 'p', filler: true });
    }
    for (let i = 0; i < junkSuffixes; i++) {
      item.mods.push({ m: null, t: 0, side: 's', filler: true });
    }
    for (const x of extra) {
      item.mods.push(x);
    }
    return item;
  }

  // Your own item (pasted from the game) as a state: wanted mods it has, wrong tiers of them
  // (they block that mod group), junk on each side, and what is fractured. Crafted mods are
  // left out (the bench removes them for free). {why} when it can't be crafted on.
  function pastedState(start) {
    if (!start || start.rarity === 'normal') {
      return null;
    }
    const st = new Array(K).fill(0);
    const exact = new Set(); // targets the item has exactly
    const swapped = new Set(); // targets it has in another element (a Harvest swap away)
    let jp = 0;
    let js = 0;
    let F = -1;
    let why = null;
    for (const x of start.mods ?? []) {
      if (x.crafted || (x.side !== 'p' && x.side !== 's')) {
        continue;
      }
      const mod = B.byId.get(x.id);
      // The wanted mod itself, or another element of it at a tier worth a Harvest swap.
      let k = mod ? T.findIndex(t => sameMod(t.m, mod)) : -1;
      let isHit = k >= 0 && meets(T[k], mod, x.tier);
      if (isHit) {
        exact.add(k);
      }
      if (!isHit && k < 0 && mod) {
        const swapK = T.findIndex((t, j) => st[j] === 0 && t.alts?.some(alt => alt.m === mod && x.tier >= alt.minTier));
        if (swapK >= 0) {
          k = swapK;
          isHit = true;
          swapped.add(swapK);
        }
      }
      // Otherwise a mod of the same group (a lower tier) blocks it.
      if (!isHit && k < 0 && mod) {
        k = T.findIndex(t => t.m.groups.some(g => mod.groups.includes(g)));
      }
      if (k >= 0 && st[k] === 0) {
        st[k] = isHit ? 1 : 2;
      }
      if (!(k >= 0 && isHit)) {
        if (x.side === 'p') {
          jp++;
        } else {
          js++;
        }
      }
      if (x.frac) {
        if (k >= 0 && isHit) {
          F = k;
        } else if (k >= 0) {
          why = `"${shortMod(T[k].m, x.tier)}" is fractured at a lower tier than you want, so that mod can never be right on this item.`;
        } else {
          F = x.side === 'p' ? -3 : -4;
        }
      }
    }
    jp += start.unknown?.p ?? 0;
    js += start.unknown?.s ?? 0;
    // (Lines it couldn't read take the free slots, prefixes first.)
    for (let unread = start.unknown?.any ?? 0; unread > 0; unread--) {
      if (sideCount(st, 'p') + jp < max.p) {
        jp++;
      } else {
        js++;
      }
    }
    jp = Math.min(jp, max.p - sideCount(st, 'p'));
    js = Math.min(js, max.s - sideCount(st, 's'));
    if (fixedF >= 0 && F !== fixedF) {
      why ??= 'Untick "fractured" on the targets: your item decides what is fractured.';
    }
    jp = Math.max(0, jp);
    js = Math.max(0, js);
    return { F, st, jp, js, key: enc(F, st, jp, js), magic: start.rarity === 'magic', why, exact, swapped };
  }

  // Finished: every target on the item, and room left for the bench crafts.
  const isDone = (st, jp, js) => {
    if (!st.every(x => x === 1)) {
      return false;
    }
    return sideCount(st, 'p') + jp + reserve.p <= max.p && sideCount(st, 's') + js + reserve.s <= max.s;
  };

  // Map roll outcomes (from rollOutcomes over the targets rolledTargets) on top of a kept
  // state into states. extra: a last change to each resulting state.
  function mapRoll(F, keptSt, keptJp, keptJs, rolledTargets, outs, pScale = 1, extra = null) {
    return outs.map(outcome => {
      let st = keptSt.slice();
      let hitPrefixes = 0;
      let hitSuffixes = 0;
      for (let i = 0; i < rolledTargets.length; i++) {
        const k = rolledTargets[i];
        st[k] = outcome.st[i];
        if (outcome.st[i] === 1) {
          if (T[k].side === 'p') {
            hitPrefixes++;
          } else {
            hitSuffixes++;
          }
        }
      }
      // New mods that aren't hits are junk (dead targets count as junk too).
      let jp = keptJp + outcome.np - hitPrefixes;
      let js = keptJs + outcome.ns - hitSuffixes;
      if (extra) {
        ({ st, jp, js } = extra(st, jp, js));
      }
      return { key: enc(F, st, jp, js), F, st, jp, js, p: outcome.p * pScale };
    });
  }

  // The missing targets that roll normally (optionally only those passing filter).
  const missingRollable = (st, filter = () => true) => {
    const missing = [];
    for (let k = 0; k < st.length; k++) {
      if (st[k] === 0 && T[k].kind === 'roll' && filter(k)) {
        missing.push(k);
      }
    }
    return missing;
  };

  // A fractured junk mod (F = -3 on prefixes, -4 on suffixes) is counted in jp/js but never
  // leaves: removals skip it and reforges keep it.
  const fjP = F => (F === -3 ? 1 : 0);
  const fjS = F => (F === -4 ? 1 : 0);

  // Removal: one random non-fractured mod (optionally on one side). keep: a mod that can't go,
  // {k} for a target (or dead target) index, {side} for a junk mod on that side.
  // Returns the resulting states [{st, jp, js, w, p}].
  // protectedTag: an Annul under "Cannot roll Caster/Attack Modifiers" can't take a wanted mod
  // with that tag. (Junk is taken as removable: when an unveil misses, pick a mod without it.)
  function removeOne(F, st, jp, js, side = null, keep = null, protectedTag = null) {
    const options = [];
    for (let k = 0; k < st.length; k++) {
      if (keep?.k === k) {
        continue;
      }
      const isRemovable = (st[k] === 1 && k !== F) || st[k] === 2;
      if (!isRemovable) {
        continue;
      }
      if (protectedTag && st[k] === 1 && T[k].m.tags.includes(protectedTag)) {
        continue;
      }
      if (side && T[k].side !== side) {
        continue;
      }
      const after = st.slice();
      after[k] = 0;
      const wasDead = st[k] === 2;
      options.push({ st: after, jp: jp - (wasDead && T[k].side === 'p'), js: js - (wasDead && T[k].side === 's'), w: 1 });
    }
    const removableJunk = {
      p: jp - targetsOnSide(st, 'p', 2) - (keep?.side === 'p') - fjP(F),
      s: js - targetsOnSide(st, 's', 2) - (keep?.side === 's') - fjS(F),
    };
    if (removableJunk.p > 0 && side !== 's') {
      options.push({ st, jp: jp - 1, js, w: removableJunk.p });
    }
    if (removableJunk.s > 0 && side !== 'p') {
      options.push({ st, jp, js: js - 1, w: removableJunk.s });
    }
    let totalWeight = 0;
    for (const option of options) {
      totalWeight += option.w;
    }
    if (!totalWeight) {
      return [];
    }
    return options.map(option => ({ ...option, p: option.w / totalWeight }));
  }

  // ----- reforges (depend only on what they keep) -----
  // A reforge: {rkey, name, family, cost, outs: [states with p], bill}. They are made once per
  // key and shared by every state that keeps the same mods.
  const reforges = new Map();
  function reforge(rkey, make) {
    if (!reforges.has(rkey)) {
      const made = make();
      if (made && isFinite(made.cost) && made.outs.length) {
        reforges.set(rkey, { ...made, rkey });
      } else {
        reforges.set(rkey, null);
      }
    }
    return reforges.get(rkey);
  }
  // Which reforge families a run may use (restrict is set per run).
  let restrict = null;
  const allowed = family => {
    if (restrict && !restrict(family)) {
      return false;
    }
    if (opt.ruthless && (family === 'harvest' || family === 'vchaos')) {
      return false; // (Ruthless has no Harvest reforges and no Veiled Chaos Orbs.)
    }
    if (phase === 'base' && family === 'fossil') {
      return false;
    }
    return true;
  };

  // The state a full reforge keeps: only the fractured target (and a forced target).
  const keptByFullReforge = (F, forced = -1) => {
    const st = new Array(K).fill(0);
    if (F >= 0) {
      st[F] = 1;
    }
    if (forced >= 0) {
      st[forced] = 1;
    }
    return st;
  };

  // Full reforge keeping only the fractured target (Chaos, fossils) or also forcing an essence mod.
  function fullReforge(F, family, name, cost, opts = {}, forced = -1, forcedMod = null) {
    const keptSt = keptByFullReforge(F, forced);
    const item = itemFor(F, keptSt, fjP(F), fjS(F));
    if (forcedMod) {
      item.mods = item.mods.filter(x => x.m !== T[forced].m);
      item.mods.push({ m: forcedMod.m, t: forcedMod.t, side: forcedMod.m.affix });
      const levelCap = ESSENCE_MOD_LEVEL[forcedMod.m.essence];
      if (levelCap) {
        item.ilvl = Math.min(item.ilvl, levelCap); // the other mods roll as if the item were this level
      }
    }
    const rolled = missingRollable(keptSt);
    const outcomes = rollOutcomes(item, rolled.map(k => T[k]), rerollDist(B, item.mods.length), opts);
    return { name, family, cost, outs: mapRoll(F, keptSt, fjP(F), fjS(F), rolled, outcomes) };
  }

  // Ruthless: essences and fossils only work on a normal item (no Chaotic Resonators), so every
  // reforge with them scours the item first, and fossils go in an Alchemical Resonator.
  const reset = opt.ruthless ? P(CUR.scour) : 0;
  const resName = fossilCount => (opt.ruthless ? ALCH_RESONATORS : RESONATORS)[fossilCount - 1];
  const resetBill = () => (opt.ruthless ? billOf(CUR.scour) : null);
  const resonator = fossilCount => P(resName(fossilCount)) + reset;

  // Harvest types worth reforging for: the tags of the targets that roll.
  const harvestTags = [];
  for (const tag of Object.keys(HARVEST_REFORGE)) {
    const needsRancour = !!HARVEST_REFORGE[tag][2];
    if ((rancourOn || !needsRancour) && T.some(t => t.kind === 'roll' && t.m.tags.includes(tag))) {
      harvestTags.push(tag);
    }
  }
  // Candidate essences (each forces one target): {k, m, t, name}.
  const essences = [];
  for (let k = 0; k < T.length; k++) {
    for (const essenceMod of essenceModsFor(B, T[k])) {
      // The two highest essence levels (Deafening, Shrieking), or only the highest when asked:
      // it rolls the best tier, on some mods a tier above what the mod can roll normally.
      const lowestTier = Math.max(0, essenceMod.tiers.length - (opt.topEssence ? 1 : 2));
      for (let tier = essenceMod.tiers.length - 1; tier >= lowestTier; tier--) {
        if (!essenceTierReaches(essenceMod, tier, T[k])) {
          continue;
        }
        const name = essenceName(essenceMod, tier, index.essenceLevels);
        if (isFinite(P(name))) {
          essences.push({ k, m: essenceMod, t: tier, name });
        }
      }
    }
  }
  let fossilCombos = [];
  // Hollow Fossil: forces an Abyssal Socket (a suffix); other fossils can join it.
  const hollow = index.fossils?.find(f => f.forces);
  const hollowK = hollow ? T.findIndex(t => t.m.id === hollow.forces) : -1;

  const fossilBill = combo => combineBills(...combo.map(f => billOf(f.name)), billOf(resName(combo.length)), resetBill());

  // A two-part roll: one mod from firstOpts (Harvest's guaranteed mod), then the rest with
  // restOpts, the count from restDist(item after the first mod).
  function guaranteedThenRest(F, keptSt, keptJp, keptJs, firstOpts, restDist, restOpts) {
    const firstItem = itemFor(F, keptSt, keptJp, keptJs);
    const firstRolled = missingRollable(keptSt);
    const outs = [];
    for (const first of rollOutcomes(firstItem, firstRolled.map(k => T[k]), [[1, 1]], firstOpts)) {
      const [afterFirst] = mapRoll(F, keptSt, keptJp, keptJs, firstRolled, [first]);
      const item = itemFor(F, afterFirst.st, afterFirst.jp, afterFirst.js);
      const rolled = missingRollable(afterFirst.st);
      const rest = rollOutcomes(item, rolled.map(k => T[k]), restDist(item), restOpts);
      outs.push(...mapRoll(F, afterFirst.st, afterFirst.jp, afterFirst.js, rolled, rest, first.p));
    }
    return outs;
  }
  // The rest of a Harvest reforge after its guaranteed mod.
  const harvestRestDist = item => rerollDist(B, 0).map(([n, p]) => [Math.max(0, n - item.mods.length), p]);

  // A state change that puts the veiled target on the item.
  const withVeiledHit = (st, jp, js) => {
    const after = st.slice();
    after[veiledK] = 1;
    return { st: after, jp, js };
  };

  // Chaos, essences, fossils and Hollow Fossil combos.
  function addCurrencyReforges(list, F) {
    if (allowed('chaos')) {
      list.push(reforge(`chaos|${F}`, () => ({ ...fullReforge(F, 'chaos', 'Chaos Orb', P(CUR.chaos)), bill: billOf(CUR.chaos) })));
    }
    for (const essence of essences) {
      if (F === essence.k || !allowed('essence:' + essence.name)) {
        continue;
      }
      list.push(reforge(`ess:${essence.name}|${F}`, () => ({
        ...fullReforge(F, 'essence:' + essence.name, essence.name, P(essence.name) + reset, {}, essence.k, { m: essence.m, t: essence.t }),
        bill: combineBills(billOf(essence.name), resetBill()),
      })));
    }
    if (allowed('fossil')) {
      for (const fc of fossilCombos) {
        list.push(reforge(`fos:${fc.key}|${F}`, () => ({ ...fullReforge(F, 'fossil', fc.name, fc.cost, { fossils: fc.combo }), bill: fossilBill(fc.combo) })));
      }
    }
    if (hollowK >= 0 && F !== hollowK && allowed('fossil') && isFinite(P(hollow.name))) {
      const companions = [[], ...fossilCombos.filter(fc => fc.combo.length < 4).map(fc => fc.combo)];
      for (const extra of companions) {
        const combo = [hollow, ...extra];
        let cost = 0;
        for (const fossil of combo) {
          cost = cost + P(fossil.name);
        }
        cost = cost + resonator(combo.length);
        const name = combo.map(f => f.name).join(' + ');
        list.push(reforge(`hollow:${extra.map(f => f.id).join('-')}|${F}`, () => ({
          ...fullReforge(F, 'fossil', name, cost, { fossils: extra }, hollowK, { m: T[hollowK].m, t: 0 }),
          bill: fossilBill(combo),
        })));
      }
    }
  }

  // Harvest reforges: with a type, with an influenced mod, and "more likely the same types".
  function addHarvestReforges(list, F, st) {
    if (!allowed('harvest')) {
      return;
    }
    // Reforge with a type: first a mod of that type, then the rest with the type ×10.
    for (const tag of harvestTags) {
      const cost = harvestCost(tag, P);
      if (!isFinite(cost)) {
        continue;
      }
      list.push(reforge(`harv:${tag}|${F}`, () => {
        const keptSt = keptByFullReforge(F);
        const outs = guaranteedThenRest(F, keptSt, fjP(F), fjS(F), { tagOnly: tag }, harvestRestDist, { tagMult: tag });
        return { name: `Harvest reforge with a ${tag} mod (${harvestText(tag)})`, family: 'harvest', cost, outs, bill: harvestBill(tag) };
      }));
    }
    // Influenced items: reforge with at least one influenced mod (5000 Primal + 1 Sacred).
    const influencedCost = HARVEST_INFLUENCE[1] * P(lifeforce(HARVEST_INFLUENCE[0])) + P(SACRED);
    if (infl.length && isFinite(influencedCost) && T.some(t => t.kind === 'roll' && infl.includes(t.m.src))) {
      list.push(reforge(`hinfl|${F}`, () => {
        const keptSt = keptByFullReforge(F);
        const outs = guaranteedThenRest(F, keptSt, fjP(F), fjS(F), { src: infl }, harvestRestDist, undefined);
        return {
          name: `Harvest reforge with an influenced mod (${HARVEST_INFLUENCE[1]} ${HARVEST_INFLUENCE[0]} Lifeforce + 1 Sacred)`,
          family: 'harvest',
          cost: influencedCost,
          outs,
          bill: combineBills(billOf(lifeforce(HARVEST_INFLUENCE[0]), HARVEST_INFLUENCE[1]), billOf(SACRED)),
        };
      }));
    }
    // "More likely to receive the same modifier types": targets already on the item are ×10.
    const onItem = [];
    for (let k = 0; k < st.length; k++) {
      if (st[k] === 1 && k !== F) {
        onItem.push(k);
      }
    }
    const moreLikelyCost = HARVEST_MORE_LIKELY[1] * P(lifeforce(HARVEST_MORE_LIKELY[0]));
    if (onItem.length && isFinite(moreLikelyCost)) {
      list.push(reforge(`hmore:${onItem.join('.')}|${F}`, () => {
        const keptSt = keptByFullReforge(F);
        const item = itemFor(F, keptSt, fjP(F), fjS(F));
        const rolled = missingRollable(keptSt);
        const boost = new Set(onItem.map(k => T[k].m));
        const outcomes = rollOutcomes(item, rolled.map(k => T[k]), rerollDist(B, item.mods.length), { boost });
        return {
          name: `Harvest reforge more likely to keep the same types (${HARVEST_MORE_LIKELY[1]} ${HARVEST_MORE_LIKELY[0]} Lifeforce)`,
          family: 'harvest',
          cost: moreLikelyCost,
          outs: mapRoll(F, keptSt, fjP(F), fjS(F), rolled, outcomes),
          bill: billOf(lifeforce(HARVEST_MORE_LIKELY[0]), HARVEST_MORE_LIKELY[1]),
        };
      }));
    }
  }

  // Veiled Chaos: one veiled mod on a random open side, then the rest.
  function addVeiledChaosReforge(list, F) {
    if (veiledK < 0 || !allowed('vchaos') || F === veiledK) {
      return;
    }
    list.push(reforge(`vchaos|${F}`, () => {
      const veiled = T[veiledK];
      const keptSt = keptByFullReforge(F);
      const unveilChance = unveilOdds(B, veiled.m);
      const outs = [];
      for (const veiledSide of ['p', 's']) {
        const item = itemFor(F, keptSt, fjP(F), fjS(F), [{ m: null, t: 0, side: veiledSide, veiled: true }]);
        const rolled = missingRollable(keptSt);
        const outcomes = rollOutcomes(item, rolled.map(k => T[k]), rerollDist(B, item.mods.length));
        const results = veiledSide === veiled.side ? [true, false] : [false];
        for (const unveilsTarget of results) {
          let chance;
          if (veiledSide === veiled.side) {
            chance = 0.5 * (unveilsTarget ? unveilChance : 1 - unveilChance);
          } else {
            chance = 0.5 * 1;
          }
          const junkPrefix = veiledSide === 'p' && !unveilsTarget ? 1 : 0;
          const junkSuffix = veiledSide === 's' && !unveilsTarget ? 1 : 0;
          outs.push(...mapRoll(F, keptSt, junkPrefix, junkSuffix, rolled, outcomes, chance, unveilsTarget ? withVeiledHit : null));
        }
      }
      return { name: CUR.vchaos, family: 'vchaos', cost: P(CUR.vchaos), outs, bill: billOf(CUR.vchaos) };
    }));
  }

  // One-side rerolls of `side`: Eldritch Chaos on the dominant side, or lock the other side and
  // Chaos / Veiled Chaos / Harvest.
  function addOneSideReforges(list, F, st, jp, js, variant, side) {
    const other = side === 'p' ? 's' : 'p';
    // What survives: the other side's mods and the fractured one.
    const keepSt = st.map((x, k) => (T[k].side === other || k === F ? x : 0));
    const keepJ = { p: side === 'p' ? fjP(F) : jp, s: side === 's' ? fjS(F) : js };
    const cfg = `${F}|${keepSt.join('')}|${keepJ.p}${keepJ.s}`;
    const sideIsNotFull = sideCount(st, side) + (side === 'p' ? jp : js) < max[side];
    const otherSideHasRoom = sideCount(keepSt, other) + keepJ[other] < max[other];

    // Only `side` rerolls (Eldritch Chaos).
    const rerollOnlyThisSide = (family, name, cost, bill) => () => {
      const item = itemFor(F, keepSt, keepJ.p, keepJ.s);
      const rolled = missingRollable(keepSt, k => T[k].side === side);
      const capOnSide = max[side] - count(item, side);
      const outcomes = rollOutcomes(item, rolled.map(k => T[k]), rerollDist(B, item.mods.length, capOnSide), { side });
      return { name, family, cost, outs: mapRoll(F, keepSt, keepJ.p, keepJ.s, rolled, outcomes), bill };
    };
    // Behind a lock the other side keeps its mods, but new ones can land in its free slots
    // (e.g. two life prefixes, "Prefixes Cannot Be Changed" + a crit reforge for a crit prefix).
    const rerollBehindLock = (family, name, cost, bill) => () => {
      const item = itemFor(F, keepSt, keepJ.p, keepJ.s);
      const rolled = missingRollable(keepSt);
      const outcomes = rollOutcomes(item, rolled.map(k => T[k]), rerollDist(B, item.mods.length));
      return { name, family, cost, outs: mapRoll(F, keepSt, keepJ.p, keepJ.s, rolled, outcomes), bill };
    };

    if (variant === side && allowed('eldritch')) {
      list.push(reforge(`echaos:${side}|${cfg}`, rerollOnlyThisSide('eldritch', CUR.echaos, P(CUR.echaos), billOf(CUR.echaos))));
    }
    const lock = findMetamod(B, side === 'p' ? 'nchg_suf' : 'nchg_pre');
    const prefixesNow = sideCount(st, 'p') + jp;
    const suffixesNow = sideCount(st, 's') + js;
    const lp = lock ? lockPrice(lock, prefixesNow, suffixesNow) : null;

    // The lock sits on the side being rerolled, so it needs a free slot there.
    if (lock && allowed('lockchaos') && sideIsNotFull && isFinite(lp.cost)) {
      list.push(reforge(`lock:${side}:${lp.via}|${cfg}`, rerollBehindLock('lockchaos', `${lockName(lock, lp)} + Chaos Orb`, P(CUR.chaos) + lp.cost, combineBills(lp.bill, billOf(CUR.chaos)))));
    }

    const veiledMissing = veiledK >= 0 && keepSt[veiledK] !== 1;
    const veiledChaosUsable = allowed('vchaos') && isFinite(P(CUR.vchaos));
    // Lock + Veiled Chaos: the unlocked side rerolls with the veiled mod on it.
    if (lock && veiledMissing && T[veiledK].side === side && veiledChaosUsable && sideIsNotFull && isFinite(lp.cost)) {
      list.push(reforge(`lockv:${side}:${lp.via}|${cfg}`, () => {
        // The veiled mod lands on a random side with room: the locked side too, if it has a free slot.
        const unveilChance = unveilOdds(B, T[veiledK].m);
        const rolled = missingRollable(keepSt);
        const veiledSides = otherSideHasRoom ? [[side, 0.5], [other, 0.5]] : [[side, 1]];
        const outs = [];
        for (const [veiledSide, chance] of veiledSides) {
          const item = itemFor(F, keepSt, keepJ.p, keepJ.s, [{ m: null, t: 0, side: veiledSide, veiled: true }]);
          const outcomes = rollOutcomes(item, rolled.map(k => T[k]), rerollDist(B, item.mods.length));
          if (veiledSide === side) {
            outs.push(...mapRoll(F, keepSt, keepJ.p, keepJ.s, rolled, outcomes, chance * unveilChance, withVeiledHit));
          }
          const missChance = veiledSide === side ? chance * (1 - unveilChance) : chance;
          outs.push(...mapRoll(F, keepSt, keepJ.p + (veiledSide === 'p'), keepJ.s + (veiledSide === 's'), rolled, outcomes, missChance));
        }
        return { name: `${lockName(lock, lp)} + Veiled Chaos Orb`, family: 'vchaos', cost: P(CUR.vchaos) + lp.cost, outs, bill: combineBills(lp.bill, billOf(CUR.vchaos)) };
      }));
    }
    // Lock + Veiled Chaos with the veiled target on the locked side: the locked side keeps its
    // mods, and the veiled mod lands on a random side with room, so with a free slot there it
    // can land among the kept mods (half the time when both sides are open). E.g. two gem
    // prefixes and a free prefix slot: "Prefixes Cannot Be Changed" + Veiled Chaos.
    if (lock && veiledMissing && T[veiledK].side === other && veiledChaosUsable && isFinite(lp.cost) && sideIsNotFull && otherSideHasRoom) {
      list.push(reforge(`lockvo:${side}:${lp.via}|${cfg}`, () => {
        const unveilChance = unveilOdds(B, T[veiledK].m, modGroupsOn(itemFor(F, keepSt, keepJ.p, keepJ.s)));
        const rolled = missingRollable(keepSt);
        const outs = [];
        // The veiled mod on the locked side (a free slot there), or on the side being rerolled.
        for (const [veiledSide, chance] of [[other, 0.5], [side, 0.5]]) {
          const item = itemFor(F, keepSt, keepJ.p, keepJ.s, [{ m: null, t: 0, side: veiledSide, veiled: true }]);
          const outcomes = rollOutcomes(item, rolled.map(k => T[k]), rerollDist(B, item.mods.length));
          if (veiledSide === other) {
            outs.push(...mapRoll(F, keepSt, keepJ.p, keepJ.s, rolled, outcomes, chance * unveilChance, withVeiledHit));
            outs.push(...mapRoll(F, keepSt, keepJ.p + (other === 'p'), keepJ.s + (other === 's'), rolled, outcomes, chance * (1 - unveilChance)));
          } else {
            outs.push(...mapRoll(F, keepSt, keepJ.p + (side === 'p'), keepJ.s + (side === 's'), rolled, outcomes, chance));
          }
        }
        return {
          name: `${lockName(lock, lp)} + Veiled Chaos Orb (the veiled mod can land on the locked side)`,
          family: 'vchaos',
          lockedSide: other,
          cost: P(CUR.vchaos) + lp.cost,
          outs,
          bill: combineBills(lp.bill, billOf(CUR.vchaos)),
        };
      }));
    }
    // Harvest reforges respect the lock too: today's "reforge keeping prefixes/suffixes".
    if (lock && allowed('harvest') && sideIsNotFull && isFinite(lp.cost)) {
      for (const tag of harvestTags) {
        const canLand = k => T[k].m.tags.includes(tag) && (T[k].side === side || otherSideHasRoom);
        if (!missingRollable(keepSt, canLand).length) {
          continue;
        }
        const cost = harvestCost(tag, P) + lp.cost;
        if (!isFinite(cost)) {
          continue;
        }
        list.push(reforge(`lockharv:${side}:${tag}:${lp.via}|${cfg}`, () => {
          // (The guaranteed mod and the rest can also land in the locked side's free slots.)
          const restDist = item => rerollDist(B, item.mods.length);
          const outs = guaranteedThenRest(F, keepSt, keepJ.p, keepJ.s, { tagOnly: tag }, restDist, { tagMult: tag });
          return {
            name: `${lockName(lock, lp)} + Harvest reforge with a ${tag} mod (${harvestText(tag)})`,
            family: 'harvest',
            cost,
            outs,
            bill: combineBills(lp.bill, harvestBill(tag)),
          };
        }));
      }
    }
  }

  // Every reforge from a state (variant: the dominant side for Eldritch Chaos, if any).
  function reforgesFor(F, st, jp, js, variant) {
    const list = [];
    if (F === -2) {
      return list;
    }
    addCurrencyReforges(list, F);
    addHarvestReforges(list, F, st);
    addVeiledChaosReforge(list, F);
    for (const side of ['p', 's']) {
      addOneSideReforges(list, F, st, jp, js, variant, side);
    }
    const found = list.filter(Boolean);
    // The Allflame bench version of each reforge it can do: see afK outcomes, keep the best.
    if (afOn) {
      for (const r of [...found]) {
        if (!AF_REF(r.family)) {
          continue;
        }
        found.push(reforge(`af|${r.rkey}`, () => ({
          ...r,
          name: `Allflame bench (best of ${afK}): ${r.name}`,
          cost: r.cost + opt.sulphur * sulphur,
          bestOf: afK,
          bill: combineBills(r.bill, billOf(SULPHUR, opt.sulphur)),
        })));
      }
    }
    return found.filter(Boolean);
  }

  // ----- the Recombinator bench -----
  const recBill = combineBills(billOf(DUST, opt.recombDust), billOf(GOLD, opt.recombGold));
  let recClickCost = 0;
  if (P.clicks) {
    recClickCost = 1;
  } else {
    recClickCost = P.clickValue ?? 0;
  }
  const recCost = opt.recombDust * P(DUST) + opt.recombGold * P(GOLD) + recClickCost;
  // (Ruthless lost unpredictable mode in 3.26.0, and predictable mode's chance isn't published.)
  const recOn = !!B.info.recomb && !presetF && !opt.noAlt && !opt.ruthless && isFinite(recCost);
  const magic = newItem(B, { ilvl, infl, rarity: 'magic' });
  const chanceOfOneModAlt = MAGIC_COUNTS.find(([n]) => n === 1)[1];

  // Chance per Alteration that a magic item shows exactly the core and nothing else, and what
  // one try costs. With two core mods, an Alteration that shows one of them alone gets an
  // Augment for the other. Returns {chance, costPerTry, augmentShare}.
  function cleanAlterationOdds(core) {
    const coreTargets = core.map(k => T[k]);
    let chance = 0;
    for (const outcome of rollOutcomes(magic, coreTargets, MAGIC_COUNTS)) {
      if (outcome.st.every(x => x === 1) && outcome.np + outcome.ns === core.length) {
        chance = chance + outcome.p;
      }
    }
    let costPerTry = P(CUR.alt);
    let augmentShare = 0;
    if (core.length === 2) {
      for (let i = 0; i < coreTargets.length; i++) {
        const target = coreTargets[i];
        const onlyThisOne = odds(magic, [target], [[1, 1]]) * chanceOfOneModAlt;
        const withIt = newItem(B, { ilvl, infl, rarity: 'magic' });
        withIt.mods.push({ m: target.m, t: target.minTier, side: target.side });
        chance += onlyThisOne * odds(withIt, [coreTargets[1 - i]], [[1, 1]]);
        costPerTry += onlyThisOne * P(CUR.aug);
        augmentShare += onlyThisOne;
      }
    }
    return { chance, costPerTry, augmentShare };
  }

  const itemMemo = new Map();
  // Cheapest way to make a clean item holding exactly these targets (or null):
  // {cost, text, pAlt, augPer, rest, pr, useImp, core}.
  function itemCost(ks) {
    const memoKey = ks.join('.');
    if (itemMemo.has(memoKey)) {
      return itemMemo.get(memoKey);
    }
    let best = null;
    for (const core of magicCores(ks)) {
      const rest = ks.filter(k => !core.includes(k));
      if (rest.length > 1) {
        continue;
      }
      // The half goes into the Recombinator whole, so it must be clean: an Alteration that shows
      // exactly the core and nothing else (or one of two alone, then an Augment adds the other).
      const alteration = cleanAlterationOdds(core);
      const pAlt = alteration.chance;
      if (!(pAlt > 0)) {
        continue;
      }
      const altCost = alteration.costPerTry / pAlt + P(CUR.transmute);
      let cost = altCost;
      let regalChance = 0;
      let useImprint = false;
      const augmentNote = core.length === 2 ? ' (Augment when only one shows, alone)' : '';
      let text = `Alteration spam a magic ${B.name} until it shows ${core.map(label).join(' and ')} and nothing else${augmentNote} (${pctText(pAlt)} per alteration)`;
      if (rest.length) {
        // Then a Regal for the last one; with an imprint, a bad Regal costs only the imprint.
        const rare = newItem(B, { ilvl, infl, rarity: 'rare' });
        for (const k of core) {
          rare.mods.push({ m: T[k].m, t: T[k].minTier, side: T[k].side });
        }
        regalChance = odds(rare, [T[rest[0]]], [[1, 1]]);
        if (!(regalChance > 0)) {
          continue;
        }
        const withImprint = opt.beasts ? (P(CUR.regal) + P(CUR.imprint)) / regalChance + P(CUR.imprint) : Infinity;
        const withoutImprint = (P(CUR.regal) + (1 - regalChance) * altCost) / regalChance;
        useImprint = isFinite(withImprint) && withImprint < withoutImprint;
        cost += Math.min(isFinite(withImprint) ? withImprint : Infinity, withoutImprint);
        text += `, then ${useImprint ? 'imprint it and ' : ''}Regal until it adds ${label(rest[0])} (${pctText(regalChance)})`;
      }
      if (!best || cost < best.cost) {
        best = { cost, text, pAlt, augPer: alteration.augmentShare, rest: rest[0] ?? -1, pr: regalChance, useImp: useImprint, core };
      }
    }
    itemMemo.set(memoKey, best);
    return best;
  }

  // Every way to pick `size` of the list, in order.
  function subsetsOfSize(list, size) {
    const subsets = [];
    const build = (from, current) => {
      if (current.length === size) {
        subsets.push(current);
        return;
      }
      for (let j = from; j < list.length; j++) {
        build(j + 1, [...current, list[j]]);
      }
    };
    build(0, []);
    return subsets;
  }

  // A recombine of clean items holding the targets S between them: each side keeps a number of
  // its pool (the table), which ones at random. -> [{st, p, full}]
  function recombStates(S) {
    // What one side keeps: [{keep: [targets], p}].
    const sideOutcomes = ks => {
      if (!ks.length) {
        return [{ keep: [], p: 1 }];
      }
      const outcomes = [];
      for (const [countText, chanceOfCount] of Object.entries(RECOMB_COUNTS[Math.min(8, ks.length)])) {
        const keptCount = Math.min(+countText, ks.length);
        const subsets = subsetsOfSize(ks, keptCount);
        for (const subset of subsets) {
          outcomes.push({ keep: subset, p: chanceOfCount / subsets.length });
        }
      }
      return outcomes;
    };
    const results = [];
    const prefixOutcomes = sideOutcomes(S.filter(k => T[k].side === 'p'));
    const suffixOutcomes = sideOutcomes(S.filter(k => T[k].side === 's'));
    for (const prefixes of prefixOutcomes) {
      for (const suffixes of suffixOutcomes) {
        const st = new Array(K).fill(0);
        for (const k of [...prefixes.keep, ...suffixes.keep]) {
          st[k] = 1;
        }
        results.push({ st, p: prefixes.p * suffixes.p, full: prefixes.keep.length + suffixes.keep.length === S.length });
      }
    }
    return results;
  }

  // ----- moves that keep progress -----
  // A move: {name, how, cost, outs: [{key, F, st, jp, js, p}], bill}. Unlike a reforge it
  // depends on the whole state.

  // A state as a move outcome.
  const outcomeOf = (F, st, jp, js, p) => ({ key: enc(F, st, jp, js), F, st, jp, js, p });

  // Wanted mods (not the fractured one) and junk on a side: what a removal there can take.
  const removableOnSide = (F, st, jp, js, side) => {
    let n = side === 'p' ? jp : js;
    for (let k = 0; k < st.length; k++) {
      if (st[k] === 1 && k !== F && T[k].side === side) {
        n++;
      }
    }
    return n;
  };

  const blockedTagFor = metaFlag => (metaFlag === 'no_attack' ? 'attack' : 'caster');

  // How many mods an Annul can take (both sides), with wanted mods of protectedTag kept.
  const countRemovable = (F, st, jp, js, protectedTag) => {
    let n = jp + js - fjP(F) - fjS(F);
    for (let k = 0; k < st.length; k++) {
      if (st[k] === 1 && k !== F && !T[k].m.tags.includes(protectedTag)) {
        n++;
      }
    }
    return n;
  };

  function moves(F, st, jp, js, variant) {
    const out = [];
    if (F === -2) {
      return out;
    }
    const item = itemFor(F, st, jp, js);
    const prefixCount = count(item, 'p');
    const suffixCount = count(item, 's');
    const totalMods = prefixCount + suffixCount;
    const hasRoom = { p: prefixCount < max.p, s: suffixCount < max.s };

    // One added mod (an Exalt or similar) on `onItem`, as a move.
    const addSlam = (name, cost, onItem, opts, how, bill) => {
      const rolled = missingRollable(st);
      const outcomes = rollOutcomes(onItem, rolled.map(k => T[k]), [[1, 1]], opts);
      if (!outcomes.length) {
        return;
      }
      out.push({ name, how, cost, outs: mapRoll(F, st, jp, js, rolled, outcomes), bill });
    };

    // Exalted Orb: plain, with a bench blocker on the other side, or under "Cannot roll
    // Attack/Caster Modifiers".
    function addExaltSlams() {
      if (!isFinite(P(CUR.exalt))) {
        return;
      }
      if (hasRoom.p || hasRoom.s) {
        addSlam('Exalted Orb', P(CUR.exalt), item, {}, 'exalt', billOf(CUR.exalt));
      }
      for (const [blockSide, slamSide] of [['s', 'p'], ['p', 's']]) {
        if (!hasRoom[blockSide] || !hasRoom[slamSide] || !missingRollable(st, k => T[k].side === slamSide).length) {
          continue;
        }
        const blocker = cheapestBlocker(B, item, blockSide, P);
        if (!blocker) {
          continue;
        }
        const blocked = clone(item);
        blocked.mods.push({ m: blocker.m, t: blocker.t, side: blockSide, crafted: true });
        addSlam(`Bench "${modText(blocker.m, blocker.t)}", then Exalted Orb`, P(CUR.exalt) + blocker.cost, blocked, {}, 'block', combineBills(billOf(CUR.exalt), blocker.bill));
      }
      for (const metaFlag of ['no_attack', 'no_caster']) {
        const metamod = findMetamod(B, metaFlag);
        if (!metamod || !hasRoom[metamod.affix]) {
          continue;
        }
        const rolled = missingRollable(st);
        if (!rolled.length || rolled.some(k => T[k].m.tags.includes(blockedTagFor(metaFlag)))) {
          continue;
        }
        const withMetamod = clone(item);
        withMetamod.mods.push({ m: metamod, t: 0, side: metamod.affix, crafted: true });
        const lp = lockPrice(metamod, count(item, 'p'), count(item, 's'));
        if (isFinite(lp.cost)) {
          addSlam(`${lp.via === 'bench' ? 'Bench ' : ''}${lockName(metamod, lp)}, then Exalted Orb`, P(CUR.exalt) + lp.cost, withMetamod, {}, 'meta', combineBills(billOf(CUR.exalt), lp.bill));
        }
      }
    }

    // "Can have up to 3 Crafted Modifiers": a metamod and a blocker together, so one Exalt
    // goes to one side with attack or caster mods out of the pool.
    function addMultimodSlams() {
      const multimod = findMetamod(B, 'mul_mods');
      if (!multimod || !isFinite(P(CUR.exalt))) {
        return;
      }
      for (const metaFlag of ['no_attack', 'no_caster']) {
        const metamod = findMetamod(B, metaFlag);
        const rolled = missingRollable(st);
        if (!metamod || !rolled.length || rolled.some(k => T[k].m.tags.includes(blockedTagFor(metaFlag)))) {
          continue;
        }
        for (const slamSide of ['p', 's']) {
          if (!missingRollable(st, k => T[k].side === slamSide).length) {
            continue;
          }
          const other = slamSide === 'p' ? 's' : 'p';
          const prepared = clone(item);
          prepared.mods.push({ m: multimod, t: 0, side: multimod.affix, crafted: true }, { m: metamod, t: 0, side: metamod.affix, crafted: true });
          let extraCost = benchCost(multimod, 0, P) + benchCost(metamod, 0, P);
          let extraBill = combineBills(benchBill(multimod, 0), benchBill(metamod, 0));
          if (count(prepared, slamSide) >= max[slamSide] || count(prepared, multimod.affix) > max[multimod.affix] || count(prepared, metamod.affix) > max[metamod.affix]) {
            continue;
          }
          if (count(prepared, other) < max[other]) {
            const blocker = cheapestBlocker(B, prepared, other, P);
            if (!blocker) {
              continue;
            }
            prepared.mods.push({ m: blocker.m, t: blocker.t, side: other, crafted: true });
            extraCost += blocker.cost;
            extraBill = combineBills(extraBill, blocker.bill);
          }
          if (count(prepared, other) < max[other]) {
            continue;
          }
          const blockerNote = count(item, other) < max[other] ? ' + a blocker' : '';
          addSlam(`Bench "${multimod.text}" + "${metamod.text}"${blockerNote}, then Exalted Orb`, P(CUR.exalt) + extraCost, prepared, {}, 'multimeta', combineBills(billOf(CUR.exalt), extraBill));
        }
      }
    }

    // Annulment (and Eldritch Annulment on the dominant side).
    function addRemovals() {
      const addRemoval = (name, cost, side, how) => {
        const results = removeOne(F, st, jp, js, side);
        if (results.length) {
          out.push({ name, how, cost, bill: billOf(name), outs: results.map(r => outcomeOf(F, r.st, r.jp, r.js, r.p)) });
        }
      };
      if (totalMods) {
        addRemoval(CUR.annul, P(CUR.annul), null, 'annul');
      }
      if (variant && totalMods) {
        addRemoval(CUR.eannul, P(CUR.eannul), variant, 'eannul');
      }
    }

    // "Cannot roll Caster Modifiers" (or Attack), then Annul: the Annul can't take a mod of that
    // type, so wanted caster mods are safe while junk goes (+1 gem prefixes stay while a wrongly
    // unveiled prefix is annulled). The metamod can eat the Annul itself.
    function addBlockedTypeAnnul() {
      if (!totalMods) {
        return;
      }
      for (const flag of ['no_caster', 'no_attack']) {
        const metamod = findMetamod(B, flag);
        if (!metamod || !hasRoom[metamod.affix]) {
          continue;
        }
        const tag = blockedTagFor(flag);
        let protectedCount = 0;
        for (let k = 0; k < st.length; k++) {
          if (st[k] === 1 && k !== F && T[k].m.tags.includes(tag)) {
            protectedCount++;
          }
        }
        if (!protectedCount) {
          continue; // (nothing to protect: a plain Annul does the same for less)
        }
        const results = removeOne(F, st, jp, js, null, null, tag);
        if (!results.length) {
          continue;
        }
        const removable = countRemovable(F, st, jp, js, tag);
        const outs = results.map(r => outcomeOf(F, r.st, r.jp, r.js, r.p * removable / (removable + 1)));
        outs.push(outcomeOf(F, st, jp, js, 1 / (removable + 1))); // the Annul took the metamod
        const metamodCost = benchCost(metamod, 0, P);
        if (metamodCost == null || !isFinite(metamodCost)) {
          continue;
        }
        out.push({
          name: `Bench "${metamod.text}" + ${CUR.annul}`,
          how: 'typeannul',
          tag,
          cost: metamodCost + P(CUR.annul),
          outs,
          bill: combineBills(benchBill(metamod, 0), billOf(CUR.annul)),
        });
      }
    }

    // Lock one side, then Annul: only the other side can lose a mod (the
    // metamod sits on that side too, so it can eat the Annul).
    function addLockAndAnnul() {
      for (const side of ['p', 's']) {
        const lock = findMetamod(B, side === 's' ? 'nchg_pre' : 'nchg_suf');
        if (!lock || lock.affix !== side || !hasRoom[side]) {
          continue;
        }
        const results = removeOne(F, st, jp, js, side);
        if (!results.length) {
          continue;
        }
        const removable = removableOnSide(F, st, jp, js, side);
        const outs = results.map(r => outcomeOf(F, r.st, r.jp, r.js, r.p * removable / (removable + 1)));
        outs.push(outcomeOf(F, st, jp, js, 1 / (removable + 1))); // the Annul took the metamod
        const lp = lockPrice(lock, prefixCount, suffixCount);
        out.push({ name: `${lockName(lock, lp)} + ${CUR.annul}`, how: 'lockannul', side, cost: lp.cost + P(CUR.annul), outs, bill: combineBills(lp.bill, billOf(CUR.annul)) });
      }
    }

    // Lock the other side, then Scour: this side is wiped.
    function addLockAndScour() {
      for (const side of ['p', 's']) {
        const lock = findMetamod(B, side === 'p' ? 'nchg_suf' : 'nchg_pre');
        const onSide = removableOnSide(F, st, jp, js, side);
        if (!lock || !hasRoom[side] || !onSide) {
          continue;
        }
        const after = st.map((x, k) => (T[k].side === side && k !== F ? 0 : x));
        const jpAfter = side === 'p' ? fjP(F) : jp;
        const jsAfter = side === 's' ? fjS(F) : js;
        const lp = lockPrice(lock, prefixCount, suffixCount);
        out.push({
          name: `${lockName(lock, lp)} + ${CUR.scour}`,
          how: 'scour',
          cost: lp.cost + P(CUR.scour),
          bill: combineBills(lp.bill, billOf(CUR.scour)),
          outs: [outcomeOf(F, after, jpAfter, jsAfter, 1)],
        });
      }
    }

    // Fracturing Orb: locks a random mod (rare, 4+ mods, not influenced, not already fractured).
    // A junk mod fractured only costs its slot; the base is ruined only when that side then
    // can't hold its targets, or when it's a wrong tier of a target (that mod group is stuck).
    // (Nor before an influenced Exalted Orb: those don't work on fractured items.)
    function addFracture() {
      if (!(F === -1 && fixedF < 0 && !infl.length && !ctx.noFracture && totalMods >= 4 && isFinite(P(FRACTURE)))) {
        return;
      }
      const outs = [];
      for (let k = 0; k < st.length; k++) {
        if (st[k] === 1) {
          outs.push(outcomeOf(k, st, jp, js, 1 / totalMods));
        }
      }
      const deadCount = st.filter(x => x === 2).length;
      let ruinChance = deadCount / totalMods;
      for (const [side, junkFractured] of [['p', -3], ['s', -4]]) {
        const junk = (side === 'p' ? jp : js) - targetsOnSide(st, side, 2);
        if (junk <= 0) {
          continue;
        }
        const slotsNeeded = T.filter(t => t.side === side).length + reserve[side];
        if (slotsNeeded + 1 <= max[side]) {
          outs.push(outcomeOf(junkFractured, st, jp, js, junk / totalMods));
        } else {
          ruinChance += junk / totalMods;
        }
      }
      if (ruinChance > 0) {
        outs.push({ key: 'ruined', F: -2, st, jp, js, p: ruinChance });
      }
      out.push({ name: FRACTURE, how: 'fracture', cost: P(FRACTURE), outs, bill: billOf(FRACTURE) });
    }

    // Veiled Exalted Orb: adds a veiled mod on a random open side, then removes another random
    // mod (never the veiled one). It needs an open slot and never adds to the mod count, so it
    // can't be the step that fills the item.
    function addVeiledExalt() {
      if (!(veiledK >= 0 && st[veiledK] === 0 && totalMods && isFinite(P(CUR.vexalt)))) {
        return;
      }
      const prefixesNow = sideCount(st, 'p') + jp;
      const suffixesNow = sideCount(st, 's') + js;
      const openSides = [];
      for (const side of ['p', 's']) {
        const modsOnSide = side === 'p' ? prefixesNow : suffixesNow;
        if (modsOnSide < max[side]) {
          openSides.push(side);
        }
      }
      // The veiled mod isn't in the state yet, so these are exactly the other mods it can remove.
      const removals = removeOne(F, st, jp, js);
      if (!openSides.length || !removals.length) {
        return;
      }
      const unveilChance = unveilOdds(B, T[veiledK].m, modGroupsOn(item));
      const outs = [];
      for (const removed of removals) {
        for (const side of openSides) {
          const chance = removed.p / openSides.length;
          const asJunk = outcomeOf(F, removed.st, removed.jp + (side === 'p'), removed.js + (side === 's'), 0);
          if (side === T[veiledK].side) {
            const hit = removed.st.slice();
            hit[veiledK] = 1;
            outs.push(outcomeOf(F, hit, removed.jp, removed.js, chance * unveilChance));
            outs.push({ ...asJunk, p: chance * (1 - unveilChance) });
          } else {
            outs.push({ ...asJunk, p: chance });
          }
        }
      }
      if (outs.length) {
        out.push({ name: CUR.vexalt, how: 'vexalt', cost: P(CUR.vexalt), outs, bill: billOf(CUR.vexalt) });
      }
    }

    const harvestAddTags = harvestTags.filter(tag => HARVEST_ADD[tag]);
    const wantsTag = tag => missingRollable(st, k => T[k].m.tags.includes(tag)).length > 0;
    const totalChance = outcomes => {
      let total = 0;
      for (const o of outcomes) {
        total = total + o.p;
      }
      return total;
    };

    // Harvest "add a mod of a type" (removes another random mod; non-influenced items).
    function addHarvestAdds() {
      if (infl.length || !isFinite(P(SACRED))) {
        return;
      }
      for (const tag of harvestAddTags) {
        if (!wantsTag(tag)) {
          continue;
        }
        const [colour, amount] = HARVEST_ADD[tag];
        const cost = amount * P(lifeforce(colour)) + P(SACRED);
        if (!isFinite(cost)) {
          continue;
        }
        // The new mod goes on first, then another random mod (never the new one) is removed.
        // The craft needs an empty slot for the new mod: with no room for a mod of the type it
        // can't be used, so it never adds to the mod count and can't be the step that fills the item.
        const outs = [];
        const rolled = missingRollable(st);
        const added = mapRoll(F, st, jp, js, rolled, rollOutcomes(itemFor(F, st, jp, js), rolled.map(k => T[k]), [[1, 1]], { tagOnly: tag }));
        if (totalChance(added) <= 1e-9) {
          continue;
        }
        for (const a of added) {
          const newTarget = a.st.findIndex((x, i) => x !== st[i]);
          const keep = newTarget >= 0 ? { k: newTarget } : { side: a.jp > jp ? 'p' : 's' };
          const removals = removeOne(F, a.st, a.jp, a.js, null, keep);
          const results = removals.length ? removals : [{ st: a.st, jp: a.jp, js: a.js, p: 1 }];
          for (const r of results) {
            outs.push(outcomeOf(F, r.st, r.jp, r.js, a.p * r.p));
          }
        }
        if (outs.length) {
          out.push({ name: `Harvest: add a ${tag} mod`, how: 'hadd', cost, outs, bill: combineBills(billOf(lifeforce(colour), amount), billOf(SACRED)) });
        }
      }
    }

    // A side lock, then Harvest "add a mod of a type": the locked side keeps its mods, so the
    // removal can only hit the other side (or the metamod itself, which then just goes). With the
    // locked side full, the new mod lands on the open side: "Prefixes Cannot Be Changed" + add a
    // chaos mod to give a suffix without risking the prefixes.
    function addLockedHarvestAdds() {
      if (infl.length || !isFinite(P(SACRED))) {
        return;
      }
      for (const tag of harvestAddTags) {
        if (!wantsTag(tag)) {
          continue;
        }
        const [colour, amount] = HARVEST_ADD[tag];
        // Optionally also "Cannot roll Attack/Caster Modifiers" (with "Can have up to 3 Crafted
        // Modifiers" so both metamods fit), when none of the wanted mods has that tag: the add then
        // can't land e.g. "Adds # to # Chaos Damage" (an attack mod) instead of a wanted chaos mod.
        const blockers = [null];
        for (const flag of ['no_attack', 'no_caster']) {
          if (findMetamod(B, flag) && findMetamod(B, 'mul_mods') && !T.some(t => t.m.tags.includes(blockedTagFor(flag)))) {
            blockers.push(flag);
          }
        }
        for (const keepSide of ['p', 's']) {
          for (const blockerFlag of blockers) {
            addOneLockedHarvestAdd(tag, colour, amount, keepSide, blockerFlag);
          }
        }
      }
    }

    function addOneLockedHarvestAdd(tag, colour, amount, keepSide, blockerFlag) {
      const lock = findMetamod(B, keepSide === 'p' ? 'nchg_pre' : 'nchg_suf');
      if (!lock || lock.affix === keepSide) {
        return;
      }
      const openSide = lock.affix; // the metamod sits on the side that can change
      const metas = blockerFlag ? [findMetamod(B, 'mul_mods'), lock, findMetamod(B, blockerFlag)] : [lock];
      const roomLeft = { p: max.p - prefixCount, s: max.s - suffixCount };
      for (const meta of metas) {
        roomLeft[meta.affix]--;
      }
      if (roomLeft.p < 0 || roomLeft.s < 0) {
        return; // the metamods need their slots (the new mod's room is checked below)
      }
      const lp = lockPrice(lock, prefixCount, suffixCount);
      const extraCost = blockerFlag ? (benchCost(metas[0], 0, P) ?? Infinity) + (benchCost(metas[2], 0, P) ?? Infinity) : 0;
      const lockCost = blockerFlag ? (benchCost(lock, 0, P) ?? Infinity) : lp.cost;
      const cost = lockCost + extraCost + amount * P(lifeforce(colour)) + P(SACRED);
      if (!isFinite(cost)) {
        return;
      }
      const metaMods = metas.map(meta => ({ m: meta, t: 0, side: meta.affix, crafted: true }));
      const rolled = missingRollable(st);
      const added = mapRoll(F, st, jp, js, rolled, rollOutcomes(itemFor(F, st, jp, js, metaMods), rolled.map(k => T[k]), [[1, 1]], { tagOnly: tag }));
      if (totalChance(added) < 1e-9) {
        return;
      }
      const outs = [];
      for (const a of added) {
        // The removal: a mod on the open side other than the new one, or the metamod.
        const newTarget = a.st.findIndex((x, i) => x !== st[i]);
        const keep = newTarget >= 0 ? { k: newTarget } : { side: a.jp > jp ? 'p' : 's' };
        const removals = removeOne(F, a.st, a.jp, a.js, openSide, keep);
        let removableCount = openSide === 'p' ? a.jp : a.js;
        for (let i = 0; i < a.st.length; i++) {
          const isOnItem = (a.st[i] === 1 && i !== F) || a.st[i] === 2;
          removableCount = removableCount + (isOnItem ? T[i].side === openSide : 0);
        }
        removableCount -= 1; // not the new mod
        const metaCount = metaMods.filter(x => x.side === openSide).length;
        const metaTakesIt = metaCount / (Math.max(0, removableCount) + metaCount);
        outs.push(outcomeOf(F, a.st, a.jp, a.js, a.p * (removals.length ? metaTakesIt : 1)));
        for (const r of removals) {
          outs.push(outcomeOf(F, r.st, r.jp, r.js, a.p * (1 - metaTakesIt) * r.p));
        }
      }
      let name;
      let lockBill;
      if (blockerFlag) {
        name = `Bench "${metas[0].text}" + "${lock.text}" + "${metas[2].text}", then Harvest: add a ${tag} mod`;
        lockBill = combineBills(benchBill(metas[0], 0), benchBill(lock, 0), benchBill(metas[2], 0));
      } else {
        name = `${lockName(lock, lp)} + Harvest: add a ${tag} mod`;
        lockBill = lp.bill;
      }
      out.push({ name, how: 'lockhadd', cost, outs, bill: combineBills(lockBill, billOf(lifeforce(colour), amount), billOf(SACRED)) });
    }

    // Farric Wolf Alpha (prefix -> suffix) and Lynx Alpha (suffix -> prefix).
    function addFarricBeasts() {
      for (const [from, to, beast] of [['p', 's', CUR.wolf], ['s', 'p', CUR.lynx]]) {
        if (!opt.beasts || !hasRoom[to] || !isFinite(P(beast)) || !missingRollable(st, k => T[k].side === to).length) {
          continue;
        }
        const outs = [];
        for (const removed of removeOne(F, st, jp, js, from)) {
          const after = itemFor(F, removed.st, removed.jp, removed.js);
          const rolled = missingRollable(removed.st);
          const outcomes = rollOutcomes(after, rolled.map(k => T[k]), [[1, 1]], { side: to });
          outs.push(...mapRoll(F, removed.st, removed.jp, removed.js, rolled, outcomes, removed.p));
        }
        if (outs.length) {
          out.push({ name: beast, how: 'beast', cost: P(beast), outs, bill: billOf(beast) });
        }
      }
    }

    // Recombine again: the item holds only wanted mods (no junk, no wrong tier, nothing fractured),
    // so it can go into the Recombinator with a new clean item carrying some missing ones. Each
    // result is a clean item with the survivors; the strategy takes it from there.
    function addRecombineAgain() {
      const isClean = F === -1 && jp === 0 && js === 0 && st.some(x => x === 1) && !st.some(x => x === 2);
      if (!recOn || !isClean) {
        return;
      }
      const onItem = [];
      for (let k = 0; k < st.length; k++) {
        if (st[k] === 1) {
          onItem.push(k);
        }
      }
      const missing = missingRollable(st).filter(k => T[k].kind === 'roll');
      for (let mask = 1; mask < 1 << missing.length; mask++) {
        const added = missing.filter((k, i) => mask & (1 << i));
        if (added.length > 3) {
          continue;
        }
        const together = [...onItem, ...added];
        if (together.filter(k => T[k].side === 'p').length > max.p || together.filter(k => T[k].side === 's').length > max.s) {
          continue;
        }
        const newItemPlan = itemCost(added);
        if (!newItemPlan) {
          continue;
        }
        const outs = recombStates(together).map(o => outcomeOf(-1, o.st, 0, 0, o.p));
        // (The new item's currency, on average: Alterations until it shows, and the Regal if any.)
        const ic = newItemPlan;
        let regalBill = null;
        if (ic.rest >= 0) {
          if (ic.useImp) {
            regalBill = combineBills(billOf(CUR.imprint, 1 / ic.pr), billOf(CUR.regal, 1 / ic.pr));
          } else {
            regalBill = combineBills(billOf(CUR.regal, 1 / ic.pr), billOf(CUR.alt, (1 / ic.pr - 1) / ic.pAlt));
          }
        }
        const itemBill = combineBills(billOf(CUR.transmute), billOf(CUR.alt, 1 / ic.pAlt), ic.augPer ? billOf(CUR.aug, ic.augPer / ic.pAlt) : null, regalBill);
        out.push({
          name: `Recombinator with a new clean item carrying ${added.map(label).join(' and ')}`,
          how: 'recomb',
          cost: ic.cost + recCost,
          outs,
          bill: combineBills(itemBill, recBill),
          recItem: ic,
          recAdd: added,
        });
      }
    }

    addExaltSlams();
    addMultimodSlams();
    if (variant && hasRoom[variant] && isFinite(P(CUR.eexalt))) {
      addSlam(CUR.eexalt, P(CUR.eexalt), item, { side: variant }, 'eexalt', billOf(CUR.eexalt));
    }
    addRemovals();
    addLockAndAnnul();
    addBlockedTypeAnnul();
    addLockAndScour();
    // With a junk mod fractured, starting a new base is always an option.
    if (F === -3 || F === -4) {
      out.push({ name: 'Start a new base', how: 'restart', cost: 0, bill: {}, outs: [{ key: 'ruined', F: -2, st, jp, js, p: 1 }] });
    }
    addFracture();
    addVeiledExalt();
    addHarvestAdds();
    addLockedHarvestAdds();
    addFarricBeasts();
    addRecombineAgain();

    // The Allflame bench and Hinekora's Lock versions of the moves.
    const extra = [];
    const onlyOneMissing = st.filter(x => x !== 1).length === 1;
    for (const m of out) {
      if (afOn && AF_MOVE.has(m.how)) {
        const sulphurAmount = m.how === 'fracture' ? opt.sulphurFracture : opt.sulphur;
        extra.push({ ...m, name: `Allflame bench (best of ${afK}): ${m.name}`, cost: m.cost + sulphurAmount * sulphur, bestOf: afK, bill: combineBills(m.bill, billOf(SULPHUR, sulphurAmount)) });
      }
      // The Hinekora's Lock currency only on the last mod: one wanted mod missing, and only a
      // preview that finishes the item counts as good.
      const isSlam = m.how === 'exalt' || m.how === 'block' || m.how === 'meta' || m.how === 'eexalt';
      if (hkOn && onlyOneMissing && isSlam) {
        extra.push({ ...m, name: `${HK_LOCK} + ${m.name}`, how: 'hk', curCost: m.cost, cost: m.cost + hkLock, foresee: true, bill: billOf(HK_LOCK), curBill: m.bill });
      }
    }
    return [...out, ...extra].filter(m => isFinite(m.cost));
  }

  // ----- solver nodes -----
  // A node is a state in one solve: {key, F, st, jp, js, done, V (expected cost to finish),
  // moves, refs (reforges), pol (the chosen action: {move} or {ref}), dist, a (Allflame crafts
  // done on this item)}. A reforge copy in a solve has R (expected cost to finish after taking
  // it) and nodes (its outcomes as nodes).

  // The expected cost after an outcome (0 when it finishes the item).
  const valueOf = o => (o.n.done ? 0 : o.n.V);
  // The expected cost from a node: 0 when it finishes the item; for the end of a phase (see
  // solve's phaseGoal), what finishing from there costs (term).
  const valueAfter = n => {
    if (n.done) {
      return n.term ?? 0;
    }
    return n.V;
  };

  // Outcome distribution when you see k outcomes and keep the best one.
  // pShow: the chance the bench shows the k outcomes at all (Intangibility); otherwise just one.
  function bestOf(outs, k, pShow = 1) {
    const merged = new Map();
    for (const o of outs) {
      merged.set(o.n, (merged.get(o.n) ?? 0) + o.p);
    }
    const sorted = [...merged].map(([n, p]) => ({ n, p, v: valueAfter(n) })).sort((a, b) => a.v - b.v);
    // tail: the chance that one outcome is this one or worse. The best of k is this one when
    // all k are this or worse, and not all are worse.
    let tail = 0;
    for (const x of sorted) {
      tail = tail + x.p;
    }
    const result = [];
    for (const x of sorted) {
      const worseThanThis = Math.max(0, tail - x.p);
      const bestIsThis = tail ** k - worseThanThis ** k;
      tail = worseThanThis;
      const p = pShow * bestIsThis + (1 - pShow) * x.p;
      if (p > 0) {
        result.push({ n: x.n, p });
      }
    }
    return result;
  }

  // Re-derive the outcome lists that depend on current values (Allflame, Hinekora).
  function refreshDynamic(nodes, refs) {
    for (const n of nodes) {
      for (const m of n.moves ?? []) {
        if (m.bestOf) {
          m.outs = bestOf(m.baseOuts, m.bestOf, m.pShow);
        } else if (m.foresee) {
          // A good preview (pA): apply the currency. A bad one: the Lock is spent, the item unchanged.
          const good = m.baseOuts.filter(o => o.n.done);
          let goodChance = 0;
          for (const o of good) {
            goodChance = goodChance + o.p;
          }
          if (goodChance > 1e-12) {
            m.outs = [...good, { p: 1 - goodChance, n }];
            m.cost = hkLock + goodChance * m.curCost;
            m.pA = goodChance;
          } else {
            m.outs = m.baseOuts;
            m.cost = Infinity;
            m.pA = 0;
          }
        }
      }
    }
    for (const r of refs) {
      if (r.bestOf) {
        r.nodes = bestOf(r.baseNodes, r.bestOf, r.pShow);
      }
    }
  }

  const paste = ctx.sub ? null : pastedState(spec.start);

  // The expected cost of a move: its cost plus the chance-weighted costs after it.
  const qMove = m => {
    let total = m.cost;
    for (const o of m.outs) {
      total = total + o.p * valueAfter(o.n);
    }
    return total;
  };

  // ----- the solver -----
  const moveCache = new Map(); // moves don't depend on which reforges a run allows
  let seedStates = []; // extra states to solve too (the results a recombine can land on): [{st, jp, js}]

  // Solves one run: explores every state reachable from a fresh base (and your item), then finds
  // the cheapest strategy by policy iteration. variant: the dominant Eldritch side, if any.
  // warm: another solve whose strategy to start from.
  // phaseGoal (optional): {reached(st), finishValue(nodeKey), allows(st, outs)}. Solves only up
  // to the states where reached(st) is true, each costing finishValue (what finishing from there
  // costs, from another solve) instead of 0. allows says whether a move or reforge from st, with
  // these outcomes, may be used in the phase. Used for "prefixes first, then suffixes" and the
  // reverse (see planSideOrders).
  function solve(variant, label0, warm = null, phaseGoal = null) {
    const states = new Map(); // key -> node
    const wraps = new Map(); // reforge key -> this solve's copy (R, links to nodes)
    const queue = []; // nodes still to explore

    // (A reforge's copy is per Allflame count a: its results keep the item's count, one more
    // when it's done at the Allflame bench.)
    const wrap = (r, craftsSoFar = 0) => {
      const wrapKey = craftsSoFar ? `${r.rkey}~a${craftsSoFar}` : r.rkey;
      let wrapped = wraps.get(wrapKey);
      if (!wrapped) {
        wrapped = { ...r, R: Infinity, stop: 0, a: craftsSoFar, pShow: r.bestOf ? afShow(craftsSoFar) : 1 };
        wraps.set(wrapKey, wrapped);
      }
      return wrapped;
    };
    const linkRef = wrapped => {
      if (wrapped.linked) {
        return;
      }
      wrapped.linked = true;
      const craftsAfter = wrapped.a + (wrapped.bestOf ? 1 : 0);
      wrapped.nodes = wrapped.outs.map(o => ({ p: o.p, n: node(o.key, o.F, o.st, o.jp, o.js, craftsAfter) }));
      wrapped.baseNodes = wrapped.nodes;
    };
    // The node for a state (made and queued the first time). craftsSoFar: Allflame crafts
    // already done on this item (finished items don't care).
    const node = (key, F, st, jp, js, craftsSoFar = 0) => {
      let done = F !== -2 && isDone(st, jp, js);
      if (done || key === 'ruined') {
        craftsSoFar = 0;
      }
      const nodeKey = craftsSoFar ? `${key}~a${craftsSoFar}` : key;
      // The end of the phase: done here, at what finishing from it costs (if that is known).
      let term = null;
      if (phaseGoal && !done && F !== -2 && key !== 'ruined' && phaseGoal.reached(st)) {
        const finishValue = phaseGoal.finishValue(nodeKey);
        if (isFinite(finishValue)) {
          done = true;
          term = finishValue;
        }
      }
      let n = states.get(nodeKey);
      if (!n) {
        n = { key: nodeKey, bkey: key, a: craftsSoFar, F, st, jp, js, done, term, V: 0, W: Infinity, best: null };
        states.set(nodeKey, n);
        queue.push(n);
      }
      return n;
    };

    const st0 = new Array(K).fill(0);
    if (fixedF >= 0) {
      st0[fixedF] = 1;
    }
    const F0 = fixedF;
    const start = { key: 'start', F: F0, st: st0, jp: 0, js: 0, start: true, V: 0, W: Infinity };
    states.set('start', start);
    const ruined = node('ruined', -2, st0, 0, 0);
    const pasted = pastedStartNodes(node);
    for (const x of seedStates) {
      node(enc(F0, x.st, x.jp, x.js), F0, x.st, x.jp, x.js);
    }
    // Start moves: reforges from a fresh base, Alteration/Regal composites.
    start.refs = reforgesFor(F0, st0, 0, 0, variant).filter(r => r.family !== 'eldritch' && r.family !== 'lockchaos').map(r => wrap(r, 0));
    // (Harvest "more likely" needs mods on the item, so it never shows up here.)
    start.alts = fixedF < 0 && allowed('alt') && !opt.noAlt && isFinite(P(CUR.alt)) ? alterationStarts(st0, node) : [];
    for (const r of start.refs) {
      linkRef(r);
    }

    // Explore everything reachable.
    let explored = 0;
    const exploreStart = Date.now();
    while (queue.length) {
      const n = queue.shift();
      if (n.F === -2 || n.done) {
        n.moves = [];
        n.refs = [];
        continue;
      }
      const cacheKey = (variant ?? '') + '|' + n.bkey;
      if (!moveCache.has(cacheKey)) {
        moveCache.set(cacheKey, moves(n.F, n.st, n.jp, n.js, variant));
      }
      const usableHere = m => !m.bestOf || n.a < afUses;
      // A phase only uses what works on its own side (see phaseGoal.allows).
      const allowedInPhase = action => {
        if (!phaseGoal) {
          return true;
        }
        return phaseGoal.allows(n.st, action.outs);
      };
      n.moves = moveCache.get(cacheKey).filter(usableHere).filter(allowedInPhase).map(m => {
        const craftsAfter = n.a + (m.bestOf ? 1 : 0);
        const outs = m.outs.map(o => ({ p: o.p, n: o.key === 'ruined' ? ruined : node(o.key, o.F, o.st, o.jp, o.js, craftsAfter) }));
        const allflame = m.bestOf ? { pShow: afShow(n.a), afUse: n.a + 1 } : {};
        return { ...m, outs, baseOuts: outs, ...allflame };
      });
      n.refs = reforgesFor(n.F, n.st, n.jp, n.js, variant).filter(usableHere).filter(allowedInPhase).map(r => wrap(r, n.a));
      for (const r of n.refs) {
        linkRef(r);
      }
      explored++;
      if (explored > 40000) {
        break;
      }
    }
    SOLVER.tExplore += Date.now() - exploreStart;
    SOLVER.states = Math.max(SOLVER.states, states.size);

    const solveStart = Date.now();
    const nodes = [...states.values()].filter(n => !n.start);
    const refsAll = [...new Set(nodes.flatMap(n => n.refs ?? []).concat(start.refs))];
    const startChoice = () => chooseStart(start);

    findFirstStrategy(nodes, refsAll, ruined);
    // States that can't finish, and actions that can land in them, are out.
    const canFinish = n => n.done || (n === ruined ? true : isFinite(n.dist));
    dropDeadEnds(nodes, ruined, canFinish);
    const live = nodes.filter(n => !n.done && n !== ruined && isFinite(n.dist));
    const liveSet = new Set(live);
    const liveRefs = refsAll.filter(r => r.nodes.every(o => canFinish(o.n)));
    const liveRefSet = new Set(liveRefs);
    for (const n of nodes) {
      if (!n.done && !liveSet.has(n)) {
        n.V = Infinity;
      }
    }
    for (const r of refsAll) {
      r.R = Infinity;
    }
    // First start: the live start reforge closest to done.
    start.best = null;
    let bestDistance = Infinity;
    for (const r of start.refs) {
      if (liveRefSet.has(r) && r.dist < bestDistance) {
        bestDistance = r.dist;
        start.best = { ref: r, c0: r.family === 'chaos' ? P(CUR.alch) : 0 };
      }
    }
    // Warm start: begin from another solve's strategy (a family's), where it's usable here.
    // Policy iteration only improves on its starting strategy, so the result can't be worse.
    // If the borrowed strategy can't be evaluated here (it can loop without finishing), the
    // solve falls back to the usual starting strategy.
    const cold = { pols: new Map(live.map(n => [n, n.pol])), best: start.best };
    if (warm) {
      borrowStrategy(warm, live, start, liveRefSet, canFinish);
    }

    // Policy iteration. Start from a strategy that is sure to finish (always
    // take a move with a chance to get one step closer to done), solve its
    // expected costs exactly as a linear system, switch each state to its
    // cheapest move, and repeat until nothing changes.
    const ruinedLive = nodes.includes(ruined);
    let startV = Infinity;
    let warmed = !!warm;
    for (let round = 0; round < 40; round++) {
      start.V = startV;
      refreshDynamic(live, liveRefs);
      let solution = evaluate(live, liveRefs, ruinedLive ? ruined : null, start);
      if (warmed && round === 0 && (!solution || !(start.V < 1e17))) {
        for (const [n, pol] of cold.pols) {
          n.pol = pol;
        }
        start.best = cold.best;
        start.V = startV = Infinity;
        warmed = false;
        for (const r of liveRefs) {
          r.R = Infinity;
        }
        solution = evaluate(live, liveRefs, ruinedLive ? ruined : null, start);
        if (SOLVER.debug) {
          SOLVER.debug(`${label0}: the borrowed strategy didn't evaluate; started fresh`);
        }
      }
      if (!solution) {
        break;
      }
      let changed = improveStrategy(live);
      const previousStart = start.best;
      const evaluatedStartValue = start.V;
      startV = startChoice();
      if (start.best?.ref !== previousStart?.ref || start.best?.alt !== previousStart?.alt) {
        changed++;
      }
      // The same Alteration start with a better keep rule (which Regal results to keep) for the
      // new values: an improvement like any other, so another round.
      const startImproved = startV < evaluatedStartValue * (1 - 1e-9) - 1e-9;
      if (!changed && start.best?.alt && startImproved) {
        changed++;
      }
      SOLVER.iters = round;
      if (!changed) {
        break;
      }
    }
    refreshDynamic(live, liveRefs);
    startV = startChoice();
    ruined.V = startV;
    // What the trace and texts read.
    for (const n of live) {
      n.bestRef = n.pol?.ref ?? null;
      n.bestMove = n.pol?.move ?? null;
      n.W = n.bestMove ? qMove(n.bestMove) : Infinity;
      for (const m of n.moves) {
        const v = qMove(m);
        if (v < n.W && !n.bestMove) {
          n.W = v;
        }
      }
    }
    if (SOLVER.debug && SOLVER.verbose) {
      logMoveUsage(live);
    }
    // A reforge's stop chance: how often its result is kept (not reforged again).
    for (const r of liveRefs) {
      let stop = 0;
      for (const o of r.nodes) {
        stop = stop + (o.n.done || o.n.pol?.ref !== r ? o.p : 0);
      }
      r.stop = stop;
    }
    SOLVER.tSolve += Date.now() - solveStart;
    // (A phase solve keeps what phaseCostWithEnds needs.)
    const phaseParts = phaseGoal ? { live, liveRefs, ruined: ruinedLive ? ruined : null } : null;
    return { start, startV, states, variant, label0, pasted, phaseParts };
  }

  // A phase solve's strategy, kept as it is, priced with each phase end worth endValue(node)
  // (planSideOrders: what finishing from there really costs). It changes the solve's values, so it
  // runs last (after the trace). A bricked item starts over, so with an Alteration start (whose
  // value isn't one of the linear unknowns) it repeats until the start's value settles; that
  // start's stopping rule is picked again for these values.
  function phaseCostWithEnds(sol, endValue) {
    const { live, liveRefs, ruined } = sol.phaseParts;
    const start = sol.start;
    const chosenStart = start.best;
    for (const n of sol.states.values()) {
      if (n.term != null) {
        n.term = endValue(n);
      }
    }
    if (chosenStart?.ref) {
      if (!evaluate(live, liveRefs, ruined, start)) {
        return null;
      }
      return chosenStart.c0 + chosenStart.ref.R;
    }
    if (!chosenStart?.alt) {
      return null;
    }
    for (let round = 0; round < 200; round++) {
      if (!evaluate(live, liveRefs, ruined, start)) {
        return null;
      }
      chooseStart(start);
      start.best = chosenStart;
      const startValue = chosenStart.alt.V;
      const settled = Math.abs(startValue - start.V) <= 1e-9 * Math.max(1, startValue);
      start.V = startValue;
      if (settled) {
        break;
      }
    }
    return start.V;
  }

  // Your item: its node (a rare), or the results of the Regal that makes a magic one rare.
  function pastedStartNodes(node) {
    if (!paste || paste.why) {
      return null;
    }
    if (!paste.magic) {
      return { n: node(paste.key, paste.F, paste.st, paste.jp, paste.js) };
    }
    const rolled = missingRollable(paste.st);
    const outcomes = rollOutcomes(itemFor(paste.F, paste.st, paste.jp, paste.js), rolled.map(k => T[k]), [[1, 1]]);
    const regal = mapRoll(paste.F, paste.st, paste.jp, paste.js, rolled, outcomes).map(o => ({ p: o.p, n: node(o.key, o.F, o.st, o.jp, o.js) }));
    return { regal };
  }

  // Alteration starts: Alteration until a magic item shows a core of targets (an Augment for
  // a second one), then a Regal (maybe with an imprint). One entry per core:
  // {core, p, altCost, augPer, outs (after the Regal), parts (per kind of magic item)}.
  function alterationStarts(st0, node) {
    const starts = [];
    const magicItem = newItem(B, { ilvl, infl, rarity: 'magic' });
    const rolled = missingRollable(st0);
    // Every Alteration result, as wanted mods (aimed for or a bonus), wrong tiers and junk.
    const altRolls = rollOutcomes(magicItem, rolled.map(k => T[k]), MAGIC_COUNTS);
    for (const core of magicCores(rolled)) {
      const coreTargets = core.map(k => T[k]);
      const coreIndexes = core.map(k => rolled.indexOf(k));
      // Results that show the core; a second mod that isn't one of them is junk the Regal keeps.
      const shown = altRolls.filter(o => coreIndexes.every(i => o.st[i] === 1));
      const parts = mapRoll(-1, st0, 0, 0, rolled, shown);
      let p = 0;
      for (const o of shown) {
        p = p + o.p;
      }
      let perTry = P(CUR.alt);
      let augPer = 0;
      if (core.length === 2) {
        // Only one of the two, alone: an Augment can add the other.
        const bothSt = st0.slice();
        for (const k of core) {
          bothSt[k] = 1;
        }
        for (let i = 0; i < coreTargets.length; i++) {
          const target = coreTargets[i];
          const onlyThisOne = odds(magicItem, [target], [[1, 1]]) * MAGIC_COUNTS.find(([n]) => n === 1)[1];
          const withIt = newItem(B, { ilvl, infl, rarity: 'magic' });
          withIt.mods.push({ m: target.m, t: target.minTier, side: target.side });
          const augmentHits = odds(withIt, [coreTargets[1 - i]], [[1, 1]]);
          p += onlyThisOne * augmentHits;
          perTry += onlyThisOne * P(CUR.aug);
          augPer += onlyThisOne;
          if (onlyThisOne * augmentHits > 0) {
            parts.push({ key: enc(-1, bothSt, 0, 0), F: -1, st: bothSt, jp: 0, js: 0, p: onlyThisOne * augmentHits });
          }
        }
      }
      if (!(p > 0)) {
        continue;
      }
      // The Regal adds one mod to whichever of those the magic item is.
      // An imprint brings back that same magic item (junk and all), so each kind of magic
      // item keeps its own Regal results.
      const merged = new Map();
      const byPart = new Map();
      for (const part of parts) {
        const regalRolled = missingRollable(part.st);
        const regalOutcomes = rollOutcomes(itemFor(-1, part.st, part.jp, part.js), regalRolled.map(k => T[k]), [[1, 1]]);
        const entry = byPart.get(part.key) ?? {
          share: 0,
          outs: mapRoll(-1, part.st, part.jp, part.js, regalRolled, regalOutcomes).map(o => ({ ...o, n: node(o.key, o.F, o.st, o.jp, o.js) })),
        };
        entry.share += part.p / p;
        byPart.set(part.key, entry);
        for (const o of mapRoll(-1, part.st, part.jp, part.js, regalRolled, regalOutcomes, part.p / p)) {
          const existing = merged.get(o.key);
          if (existing) {
            existing.p += o.p;
          } else {
            merged.set(o.key, o);
          }
        }
      }
      const outs = [...merged.values()].map(o => ({ ...o, n: node(o.key, o.F, o.st, o.jp, o.js) }));
      starts.push({ core, p, altCost: perTry / p + P(CUR.transmute), augPer, outs, parts: [...byPart.values()] });
    }
    return starts;
  }

  // The best way to start, from the current values: a reforge from a fresh base (Alchemy first
  // for Chaos and Harvest), or Alterations and a Regal (with an imprint or Hinekora's Lock).
  // Sets start.best and returns its value.
  // An Alteration start as a linear equation, for evaluate: with the Regal results it keeps fixed,
  // its value is c + Σ p · (value after outcome n), over outs [{p, n}]. (A ruined item starts over:
  // that outcome links back to the start itself.) Without this the start's value would be a number
  // carried over from the round before, and every state that can ruin the item would be priced with
  // a starting-over cost that is out of date.
  // keptRow: "Regal, keep a result in kept, otherwise alterations again": R = (cost + Σ kept p·A) / P(kept).
  function keptRow(costPerTry, stopping) {
    let keptChance = 0;
    for (const o of stopping.kept) {
      keptChance = keptChance + o.p;
    }
    if (!(keptChance > 0)) {
      return null;
    }
    const outs = [];
    for (const o of stopping.kept) {
      outs.push({ p: o.p / keptChance, n: o.n });
    }
    return { c: costPerTry / keptChance, outs };
  }
  // With an imprint: the Alterations once, then per kind of magic item (its share) its own
  // "Regal, keep or restore the imprint" loop.
  function imprintRow(a, imprint) {
    let c = a.altCost;
    const outs = [];
    for (const part of imprint.parts) {
      if (!(part.share > 0)) {
        continue;
      }
      const partRow = keptRow(part.costPerTry, part.value);
      if (!partRow) {
        return null;
      }
      c = c + part.share * partRow.c;
      for (const o of partRow.outs) {
        outs.push({ p: part.share * o.p, n: o.n });
      }
    }
    return { c, outs };
  }
  // Hinekora's Lock: each look costs the Alterations and the Lock; a Regal only on the accepted ones.
  function hinekoraRow(a, hinekora) {
    const acceptChance = hinekora.stop;
    if (!(acceptChance > 0)) {
      return null;
    }
    const outs = [];
    for (const o of hinekora.kept) {
      outs.push({ p: o.p / acceptChance, n: o.n });
    }
    return { c: (a.altCost + hkSetup) / acceptChance + P(CUR.regal), outs };
  }

  function chooseStart(start) {
    let bestValue = Infinity;
    let best = null;
    for (const r of start.refs) {
      const firstCost = r.family === 'chaos' || r.family === 'lockchaos' || r.family === 'harvest' ? P(CUR.alch) : 0;
      if (r.R + firstCost < bestValue) {
        bestValue = r.R + firstCost;
        best = { ref: r, c0: firstCost };
      }
    }
    for (const a of start.alts) {
      const outs = a.outs.map(o => ({ p: o.p, A: valueAfter(o.n), n: o.n }));
      const noImprint = stopValue(a.altCost + P(CUR.regal), outs);
      let imprint = { R: Infinity };
      if (opt.beasts && isFinite(P(CUR.imprint))) {
        imprint = { R: 0, stop: 0, parts: [] };
        for (const part of a.parts) {
          const partValue = stopValue(P(CUR.regal) + P(CUR.imprint), part.outs.map(o => ({ p: o.p, A: valueAfter(o.n), n: o.n })));
          imprint.R += part.share * partValue.R;
          imprint.stop += part.share * (partValue.stop ?? 0);
          imprint.parts.push({ share: part.share, costPerTry: P(CUR.regal) + P(CUR.imprint), value: partValue });
        }
      }
      // Hinekora's Lock on the magic item (beast recipe): one look at the Regal; regal only a good
      // one, otherwise the Lock is spent and it's back to alterations for a new magic item.
      let hinekora = { R: Infinity };
      if (hkMagicOn) {
        const sorted = outs.filter(o => isFinite(o.A)).sort((x, y) => x.A - y.A);
        let acceptChance = 0;
        let acceptValueSum = 0;
        const accepted = [];
        for (const o of sorted) {
          acceptChance += o.p;
          acceptValueSum += o.p * o.A;
          accepted.push(o);
          const R = (a.altCost + hkSetup + acceptChance * P(CUR.regal) + acceptValueSum) / acceptChance;
          if (R < hinekora.R) {
            hinekora = { R, stop: acceptChance, cut: o.A, kept: accepted.slice() };
          }
        }
      }
      const value = Math.min(noImprint.R, a.altCost + imprint.R, hinekora.R);
      a.V = value;
      a.hk = hinekora.R === value ? hinekora : null;
      a.imp = !a.hk && a.altCost + imprint.R < noImprint.R;
      if (a.hk) {
        a.stop = hinekora.stop;
        a.row = hinekoraRow(a, hinekora);
      } else if (a.imp) {
        a.stop = imprint.stop;
        a.row = imprintRow(a, imprint);
      } else {
        a.stop = noImprint.stop;
        a.row = keptRow(a.altCost + P(CUR.regal), noImprint);
      }
      if (value < bestValue) {
        bestValue = value;
        best = { alt: a };
      }
    }
    start.best = best;
    return bestValue;
  }

  // The fewest steps to done through an action's best outcome.
  const stepsThroughMove = m => 1 + Math.min(...m.outs.map(o => o.n.dist));

  // Steps-to-done distances (optimistic), over moves and reforges; each node's pol becomes
  // the action closest to done (a strategy that is sure to finish).
  function findFirstStrategy(nodes, refsAll, ruined) {
    for (const n of nodes) {
      n.dist = n.done ? 0 : Infinity;
    }
    for (const r of refsAll) {
      r.dist = Infinity;
    }
    let changed = true;
    for (let guard = 0; changed && guard < 200; guard++) {
      changed = false;
      for (const r of refsAll) {
        const d = 1 + Math.min(...r.nodes.map(o => o.n.dist));
        if (d < r.dist) {
          r.dist = d;
          changed = true;
        }
      }
      for (const n of nodes) {
        if (n.done || n === ruined) {
          continue;
        }
        let best = Infinity;
        let pick = null;
        for (const m of n.moves) {
          const d = stepsThroughMove(m);
          if (d < best) {
            best = d;
            pick = { move: m };
          }
        }
        for (const r of n.refs) {
          if (r.dist < best) {
            best = r.dist;
            pick = { ref: r };
          }
        }
        if (best < n.dist) {
          n.dist = best;
          n.pol = pick;
          changed = true;
        }
      }
    }
  }

  // An action is usable when every outcome can still finish.
  const actionIsUsable = (action, canFinish) => {
    if (action.move) {
      return action.move.outs.every(o => canFinish(o.n));
    }
    return action.ref.nodes.every(o => canFinish(o.n));
  };

  // Nodes whose every action can land somewhere that can't finish are dropped (dist = Infinity),
  // until nothing changes; the others switch to a usable action.
  function dropDeadEnds(nodes, ruined, canFinish) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of nodes) {
        if (n.done || n === ruined || !isFinite(n.dist)) {
          continue;
        }
        if (n.pol && actionIsUsable(n.pol, canFinish)) {
          continue;
        }
        let replacement = null;
        let best = Infinity;
        for (const m of n.moves) {
          if (m.outs.every(o => canFinish(o.n))) {
            const d = stepsThroughMove(m);
            if (d < best) {
              best = d;
              replacement = { move: m };
            }
          }
        }
        for (const r of n.refs) {
          if (r.nodes.every(o => canFinish(o.n)) && r.dist < best) {
            best = r.dist;
            replacement = { ref: r };
          }
        }
        if (replacement) {
          n.pol = replacement;
        } else {
          n.dist = Infinity;
          n.pol = null;
          changed = true;
        }
      }
    }
  }

  // Takes each state's action from another solve, where the same action exists and is usable.
  function borrowStrategy(warm, live, start, liveRefSet, canFinish) {
    for (const n of live) {
      const borrowed = warm.states.get(n.key)?.pol;
      if (!borrowed) {
        continue;
      }
      let action = null;
      if (borrowed.ref) {
        const r = n.refs.find(x => x.rkey === borrowed.ref.rkey);
        action = r && { ref: r };
      } else {
        const m = n.moves.find(x => x.name === borrowed.move.name && x.how === borrowed.move.how);
        action = m && { move: m };
      }
      if (action && actionIsUsable(action, canFinish)) {
        n.pol = action;
      }
    }
    const borrowedStart = warm.start.best;
    if (borrowedStart?.ref) {
      const r = start.refs.find(x => x.rkey === borrowedStart.ref.rkey);
      if (r && liveRefSet.has(r)) {
        start.best = { ref: r, c0: borrowedStart.c0 };
      }
    }
  }

  // Switches every state to its cheapest action (by a margin); returns how many changed.
  function improveStrategy(live) {
    let changed = 0;
    const clearlyBelow = (v, best) => v < best * (1 - 1e-9) - 1e-9;
    for (const n of live) {
      let best = Infinity;
      if (n.pol?.move) {
        best = qMove(n.pol.move);
      } else if (n.pol?.ref) {
        best = n.pol.ref.R;
      }
      let pick = n.pol;
      for (const m of n.moves) {
        const v = qMove(m);
        if (clearlyBelow(v, best)) {
          best = v;
          pick = { move: m };
        }
      }
      for (const r of n.refs) {
        if (clearlyBelow(r.R, best)) {
          best = r.R;
          pick = { ref: r };
        }
      }
      if (pick !== n.pol) {
        n.pol = pick;
        changed++;
      }
    }
    return changed;
  }

  function logMoveUsage(live) {
    const available = {};
    const used = {};
    for (const n of live) {
      for (const m of n.moves) {
        available[m.how] = (available[m.how] ?? 0) + 1;
      }
      const how = n.pol?.move?.how ?? (n.pol?.ref ? 'ref:' + n.pol.ref.family : 'none');
      used[how] = (used[how] ?? 0) + 1;
    }
    SOLVER.debug('available ' + JSON.stringify(available) + ' used ' + JSON.stringify(used));
  }

  // Expected cost of the current strategy for every state: x_i = c_i + Σ p_ij x_j.
  // States that just take a reforge are aliases of it; a reforge's repeats
  // into itself are divided out (they make the system nearly singular).
  // Sets r.R, n.V and start.V; returns the solution, or null.
  function evaluate(live, refs, ruined, start) {
    const DONE = -1;
    const UNKNOWN = -2;
    const BIG = 1e18;
    // One unknown per reforge, one for the start, one per state that doesn't just take a reforge.
    const column = new Map();
    let unknowns = 0;
    for (const r of refs) {
      column.set(r, unknowns++);
    }
    const startColumn = unknowns++;
    for (const n of live) {
      if (!n.pol?.ref) {
        column.set(n, unknowns++);
      }
    }
    const columnOf = n => {
      if (n.done) {
        return DONE;
      }
      if (n.pol?.ref) {
        return column.get(n.pol.ref) ?? UNKNOWN;
      }
      if (n === ruined) {
        return startColumn;
      }
      return column.get(n) ?? UNKNOWN;
    };
    // The equation for unknown i: cost c and outcomes (a self-loop is divided out).
    const equation = (i, cost, outs) => {
      const links = new Map();
      let diagonal = 1;
      let leadsNowhere = false;
      for (const o of outs) {
        const j = columnOf(o.n);
        if (j === DONE) {
          if (o.n.term != null) {
            cost = cost + o.p * o.n.term; // the end of a phase: what finishing from there costs
          }
          continue;
        }
        if (j === UNKNOWN) {
          leadsNowhere = true;
          break;
        }
        if (j === i) {
          diagonal -= o.p;
        } else {
          links.set(j, (links.get(j) ?? 0) + o.p);
        }
      }
      if (leadsNowhere || diagonal <= 1e-15 || !isFinite(cost)) {
        return { c: BIG, a: [] };
      }
      return { c: cost / diagonal, a: [...links].map(([j, p]) => [j, p / diagonal]) };
    };
    const rows = new Array(unknowns);
    for (const r of refs) {
      rows[column.get(r)] = equation(column.get(r), r.cost, r.nodes);
    }
    const startBest = start.best;
    if (startBest?.ref && column.has(startBest.ref)) {
      rows[startColumn] = { c: startBest.c0, a: [[column.get(startBest.ref), 1]] };
    } else if (startBest?.alt?.row) {
      // An Alteration start with its keep rule (see keptRow): solved with everything else.
      rows[startColumn] = equation(startColumn, startBest.alt.row.c, startBest.alt.row.outs);
    } else {
      rows[startColumn] = { c: isFinite(start.V) ? start.V : BIG, a: [] };
    }
    for (const n of live) {
      if (n.pol?.ref) {
        continue;
      }
      rows[column.get(n)] = n.pol?.move ? equation(column.get(n), n.pol.move.cost, n.pol.move.outs) : { c: BIG, a: [] };
    }
    // The starting guess: the values from the last round.
    const guess = new Float64Array(unknowns);
    for (const r of refs) {
      guess[column.get(r)] = isFinite(r.R) ? r.R : 0;
    }
    guess[startColumn] = isFinite(start.V) ? start.V : 0;
    for (const n of live) {
      if (!n.pol?.ref) {
        guess[column.get(n)] = isFinite(n.V) ? n.V : 0;
      }
    }
    const x = solveDirect(rows) ?? solveLinear(rows, guess) ?? gaussSeidel(rows, guess);
    if (!x) {
      return null;
    }
    const valueAt = i => (x[i] >= 1e17 ? Infinity : x[i]);
    for (const r of refs) {
      r.R = valueAt(column.get(r));
    }
    start.V = x[startColumn];
    for (const n of live) {
      n.V = n.pol?.ref ? n.pol.ref.R : valueAt(column.get(n));
    }
    if (ruined) {
      ruined.V = start.V;
    }
    return x;
  }

  // The best value among a node's other reforges.
  function bestOtherRef(n, self) {
    let best = Infinity;
    for (const r of n.refs ?? []) {
      if (r !== self && r.R < best) {
        best = r.R;
      }
    }
    return best;
  }

  // ----- describing a solution as steps -----
  // ess: the essence a reforge used ({k, m, t}): its mod is that essence's tier, not just the wanted one.
  const essLabel = (k, ess) => (ess && ess.k === k ? shortMod(ess.m, ess.t) : label(k));
  // The essence a reforge uses, or null.
  const essOf = r => {
    if (!r.family.startsWith('essence:')) {
      return null;
    }
    return essences.find(e => 'essence:' + e.name === r.family) ?? null;
  };
  const hasFracturedJunk = n => n.F === -3 || n.F === -4;

  // A state in words: "has X, Y (fractured); a wrong tier of Z; 2 other mods".
  const stateText = (n, ess = null) => {
    const has = [];
    const dead = [];
    for (let k = 0; k < n.st.length; k++) {
      if (n.st[k] === 1) {
        has.push(essLabel(k, ess) + (n.F === k ? ' (fractured)' : ''));
      } else if (n.st[k] === 2) {
        dead.push(label(k));
      }
    }
    if (hasFracturedJunk(n)) {
      has.push(`a fractured junk ${SIDE_NAME[n.F === -3 ? 'p' : 's']}`);
    }
    const junk = n.jp + n.js - dead.length - (hasFracturedJunk(n) ? 1 : 0);
    const parts = [has.length ? `has ${has.join(', ')}` : 'has none of the targets'];
    if (dead.length) {
      parts.push(`a wrong tier of ${dead.join(', ')}`);
    }
    if (junk > 0) {
      parts.push(`${junk} other mod${junk > 1 ? 's' : ''}`);
    }
    return parts.join('; ');
  };

  // An example item for a planner state: its targets (at their lowest wanted tier), a wrong tier
  // where one is blocked, the fractured mod, and filler junk: the base's commonest mods that fit.
  const junkPool = (() => {
    const byMod = new Map();
    for (const entry of freshRarePool(B, ilvl, infl)) {
      const row = byMod.get(entry.m) ?? { m: entry.m, w: 0, ts: [] };
      row.w += entry.w;
      row.ts.push(entry.t);
      byMod.set(entry.m, row);
    }
    return [...byMod.values()].sort((a, b) => b.w - a.w);
  })();

  function exampleItem(n, ess = null) {
    if (!n || n.F === -2 || !n.st) {
      return null;
    }
    const example = { p: [], s: [] };
    const groupsUsed = new Set(T.flatMap(t => t.m.groups));
    for (let k = 0; k < T.length; k++) {
      const t = T[k];
      if (n.st[k] === 1) {
        const text = ess?.k === k ? modText(ess.m, ess.t) : modText(t.m, t.minTier);
        example[t.side].push({ text, kind: 'hit', frac: n.F === k });
      } else if (n.st[k] === 2) {
        example[t.side].push({ text: modText(t.m, Math.max(0, t.minTier - 1)), kind: 'dead' });
      }
    }
    for (const side of ['p', 's']) {
      let junkLeft = (side === 'p' ? n.jp : n.js) - targetsOnSide(n.st, side, 2);
      let fractured = (side === 'p' && n.F === -3) || (side === 's' && n.F === -4);
      for (const row of junkPool) {
        if (junkLeft <= 0) {
          break;
        }
        if (row.m.affix !== side || row.m.groups.some(g => groupsUsed.has(g))) {
          continue;
        }
        const typicalTier = row.ts[Math.floor(row.ts.length * 0.6)] ?? 0;
        example[side].push({ text: modText(row.m, typicalTier), kind: 'junk', frac: fractured });
        for (const group of row.m.groups) {
          groupsUsed.add(group);
        }
        fractured = false;
        junkLeft--;
      }
    }
    if (n.magic) {
      example.magic = true;
    }
    return example;
  }

  // The magic item an Alteration step aims for: just its core targets.
  const magicExample = core => {
    const example = { p: [], s: [], magic: true };
    for (const k of core) {
      example[T[k].side].push({ text: modText(T[k].m, T[k].minTier), kind: 'hit' });
    }
    return example;
  };

  // Other moves from a state that cost within 1% of the chosen one (the plan picks one; these are
  // as good in practice). -> " About as good: …" or ''.
  const aboutAsGood = (n, chosen) => {
    const best = n.V;
    if (!isFinite(best) || best <= 0) {
      return '';
    }
    const options = [];
    for (const m of n.moves ?? []) {
      options.push({ name: m.bestOf ? `Allflame ${m.name}` : m.name, v: qMove(m), x: m });
    }
    for (const r of n.refs ?? []) {
      options.push({ name: r.name, v: r.R, x: r });
    }
    const names = new Set();
    for (const option of options.sort((a, b) => a.v - b.v)) {
      if (option.x === chosen || option.name === chosen?.name || !(option.v <= best * 1.01)) {
        continue;
      }
      names.add(option.name);
      if (names.size >= 2) {
        break;
      }
    }
    return names.size ? ` About as good (within 1%): ${[...names].join('; ')}.` : '';
  };

  // The steps before the main craft on a fresh base: a bought fractured base, influence, and
  // the Eldritch implicits that make one side dominant.
  function openingSteps(sol) {
    const steps = [];
    if (presetF) {
      steps.push({ text: `Start from a base with "${modText(presetF.m, presetF.minTier)}" fractured (bought; its price isn't counted).`, p: 1, cost: 0, how: 'Fractured base' });
    }
    steps.push(...inflSteps);
    if (sol.variant) {
      const tierCount = B.mods.find(m => m.affix === 'r')?.tiers.length ?? 4;
      const high = Math.min(2, tierCount - 1);
      const exarchTier = sol.variant === 'p' ? high : 0;
      const eaterTier = sol.variant === 'p' ? 0 : high;
      const otherSide = sol.variant === 'p' ? 's' : 'p';
      const flipOrbs = fmtN(conflictCost(exarchTier, eaterTier, tierCount, otherSide));
      steps.push({
        text: `First apply ${ELDRITCH_TIERS[exarchTier]} Eldritch Ember and ${ELDRITCH_TIERS[eaterTier]} Eldritch Ichor so the ${eldritchSideName(sol.variant === 'p' ? 'r' : 'b')} implicit is stronger: Eldritch currency then works on ${SIDE_NAME[sol.variant]}es. (An Orb of Conflict flips dominance in about ${flipOrbs} orbs if needed.)`,
        p: 1,
        cost: eldCost(sol.variant),
        how: 'Eldritch implicits',
      });
    }
    return steps;
  }

  // The Alteration and Regal steps of an Alteration start.
  function alterationSteps(steps, a) {
    const core = a.core.map(label).join(' and ');
    const alterationIndex = steps.length;
    // A failed Augment leaves a magic item with the wrong second mod: alterate again.
    const againNote = a.core.length === 2 ? 'wrong mods (or a failed Augment)' : 'wrong mods';
    const augmentNote = a.core.length === 2 ? ' (Augment when only one shows)' : '';
    steps.push({
      flow: [{ kind: 'on', p: a.p }, { kind: 'again', p: 1 - a.p, note: againNote }],
      ex: magicExample(a.core),
      text: `Orb of Transmutation, then Orb of Alteration until the magic item shows ${core}${augmentNote}: ${pctText(a.p)} per alteration, about ${fmtN(tries(a.p))}.`,
      p: a.p,
      cost: a.altCost,
      rem: a.V,
      how: 'Alteration',
    });
    const regalCost = a.V - a.altCost;
    let regalStep;
    if (a.hk) {
      regalStep = {
        text: `While it's still magic, give it Hinekora's Lock with the Bestiary recipe (${HK_SETUP.join(' + ')}): it shows what the Regal Orb will do. Regal only if the result is good (${pctText(a.stop)} of the time); otherwise the Lock is spent, so alterate a new magic item and lock it again (about ${fmtN(tries(a.stop))} Locks).`,
        p: a.stop,
        cost: regalCost,
        rem: regalCost,
        how: "Hinekora's Lock + Regal",
      };
    } else {
      const imprintFirst = a.imp ? 'Imprint it (Craicic Chimeral), then ' : '';
      const otherwise = a.imp ? '; otherwise restore the imprint and regal again' : '; otherwise go back to alterations';
      regalStep = {
        text: `${imprintFirst}Regal Orb. Keep the result ${pctText(a.stop)} of the time${otherwise}.`,
        p: a.stop,
        cost: regalCost,
        rem: regalCost,
        how: a.imp ? 'Regal + Imprint' : 'Regal',
      };
    }
    const missChance = 1 - a.stop;
    let missFlow;
    if (a.imp && !a.hk) {
      missFlow = { kind: 'again', p: missChance, note: 'bad Regal: restore the imprint' };
    } else {
      missFlow = { kind: 'back', p: missChance, to: alterationIndex, note: a.hk ? 'bad look (the Lock is spent)' : 'bad Regal' };
    }
    regalStep.flow = [{ kind: 'on', p: a.stop }, missFlow];
    steps.push(regalStep);
  }

  // The likeliest walk through a solution, as steps. start: where it begins (sol.start.best by
  // default; {node, pre, paste?, swaps?} for a plan from a given state).
  function trace(sol, start = sol.start.best) {
    const steps = [];
    // A plan from a given state (Recombinator, your own item) brings its own first steps.
    const fromFreshBase = !start?.node;
    if (fromFreshBase) {
      steps.push(...openingSteps(sol));
    }
    let current;
    // The steps so far, so a move that sets the item back can say "back to step N".
    const path = []; // {idx, node (the state the step starts from), ref (its reforge, if any)}
    // A bricked item means a new base, and every step so far (buying a fractured base,
    // influence, Eldritch implicits, recombining) is per base: a new base starts at step 1.
    if (start?.node) {
      steps.push(...start.pre);
      current = start.node;
    } else if (start?.ref) {
      const r = start.ref;
      const firstStep = refStep(r, true);
      current = likelyStop(r.nodes, r.R);
      path.push({ idx: steps.length, node: null, ref: r });
      steps.push({ ...firstStep, flow: refFlow(r), ex: exampleItem(current, essOf(r)), simKey: r, bill: r.bill ?? billOf(r.name) });
    } else if (start?.alt) {
      alterationSteps(steps, start.alt);
      current = likelyStop(start.alt.outs, Infinity);
      steps[steps.length - 1].ex = exampleItem(current);
    }

    for (let i = 0; current && !current.done && i < 14; i++) {
      if (current === sol.states.get('ruined')) {
        break;
      }
      const reforgeIsBest = current.bestRef && current.bestRef.R <= current.W;
      if (reforgeIsBest) {
        const before = current;
        const r = before.bestRef;
        current = likelyStop(r.nodes, r.R);
        path.push({ idx: steps.length, node: before, ref: r });
        const step = refStep(r, false, before);
        step.text += aboutAsGood(before, r);
        steps.push({ ...step, flow: refFlow(r, before), from: stateText(before), exFrom: exampleItem(before), ex: exampleItem(current, essOf(r)), simKey: r, bill: r.bill ?? billOf(r.name) });
        continue;
      }
      const m = current.bestMove;
      if (!m) {
        break;
      }
      const good = m.outs.filter(o => o.n.V < current.V - 1e-9 || o.n.done);
      let goodChance = 0;
      for (const o of good) {
        goodChance = goodChance + o.p;
      }
      // (Both sorts are in place, likeliest first; m.outs keeps that order from here on.)
      const next = good.sort((a, b) => b.p - a.p)[0] ?? m.outs.sort((a, b) => b.p - a.p)[0];
      const flow = stepFlow(m, current, good, path, start?.paste ? null : 0);
      path.push({ idx: steps.length, node: current, ref: null });
      let text = '';
      if (m.bestOf) {
        text = `At the Allflame bench (Allflame craft ${m.afUse} of at most ${afUses} on this item; ${pctText(m.pShow)} chance it still shows ${m.bestOf} outcomes to keep the best of, otherwise just one): `;
      }
      text += moveText(m, current, goodChance).replace(/^Allflame bench \(best of \d\): /, '') + aboutAsGood(current, m);
      let recipe = null;
      if (m.how === 'recomb') {
        const yourMods = [];
        for (let k = 0; k < current.st.length; k++) {
          if (current.st[k] === 1) {
            yourMods.push({ text: label(k), side: T[k].side });
          }
        }
        recipe = { halves: [{ yours: true, mods: yourMods, junk: current.jp + current.js }, recHalf(m.recAdd, m.recItem)], benchCost: recCost, pGood: goodChance };
      }
      steps.push({
        from: stateText(current),
        exFrom: exampleItem(current),
        ex: exampleItem(next?.n),
        flow,
        simKey: current,
        bill: m.bill ?? billOf(m.name),
        text,
        p: goodChance,
        cost: current.V,
        rem: current.V,
        how: m.bestOf ? 'Allflame ' + m.how : m.how,
        recipe,
        avoid: m.how === 'typeannul' ? avoidLists([m.tag]) : null,
      });
      current = next?.n;
    }
    for (const step of steps) {
      if (step.flow) {
        step.flow = step.flow.filter(f => f.p > 1e-4);
      }
    }
    steps.push(...finalSteps(start?.swaps));
    if (benchT.length) {
      const multimod = benchT.length > 1 ? '"Can have up to 3 Crafted Modifiers", then ' : '';
      const crafts = benchT.map(t => `"${modText(t.m, t.minTier)}"`).join(' and ');
      steps.push({ text: `Bench-craft ${multimod}${crafts}.`, p: 1, cost: benchCostTotal, how: 'Crafting bench' });
    }
    return steps;
  }

  // Targets that changed between two states.
  const targetsLost = (from, to) => {
    const lost = [];
    for (let k = 0; k < from.st.length; k++) {
      if (from.st[k] === 1 && to.st[k] !== 1) {
        lost.push(k);
      }
    }
    return lost;
  };
  const targetsNowDead = (from, to, lost) => {
    const dead = [];
    for (let k = 0; k < to.st.length; k++) {
      if (to.st[k] === 2 && from.st[k] !== 2 && !lost.includes(k)) {
        dead.push(k);
      }
    }
    return dead;
  };
  const targetsFreed = (from, to) => {
    const freed = [];
    for (let k = 0; k < from.st.length; k++) {
      if (from.st[k] === 2 && to.st[k] === 0) {
        freed.push(k);
      }
    }
    return freed;
  };

  // Where a move's outcomes lead, in terms of the listed steps: on (a good result), again (the
  // item is unchanged), back to an earlier step (the same reforge, or the same wanted mods as
  // then), a new base, or elsewhere (a state the likeliest path doesn't pass).
  // Returns [{kind, p, note?, to?, next?, back?, chg?, ex?}].
  function stepFlow(m, current, good, path, restartTo = 0) {
    // From a result off the path, the plan's likeliest moves (up to four) until it is back on a
    // listed step: {names, to: step index, 'self' (this step again) or 'done'}.
    const followPlan = startNode => {
      const names = [];
      let n = startNode;
      for (let hop = 0; hop < 4 && n && !n.done; hop++) {
        const ref = n.pol?.ref;
        const move = n.pol?.move;
        if (!ref && !move) {
          break;
        }
        names.push(ref ? ref.name : move.name);
        if (ref) {
          n = likelyStop(ref.nodes, ref.R);
        } else {
          n = [...move.outs].sort((a, b) => b.p - a.p)[0]?.n;
        }
        if (!n) {
          break;
        }
        if (n === current) {
          return { names, to: 'self' };
        }
        const onPath = path.findLast(x => x.node === n || (x.ref && n.pol?.ref === x.ref));
        if (onPath) {
          return { names, to: onPath.idx };
        }
        if (n.done) {
          return { names, to: 'done' };
        }
      }
      return names.length ? { names, to: '' } : null;
    };
    const goodSet = new Set(good);

    // What a result did to the item: wanted mods it took away, wrong tiers it rolled.
    const whatChanged = n => {
      // (The ruined state has no mods of its own to compare: say why the base is lost.)
      if (n.key === 'ruined') {
        return m.how === 'fracture' ? 'a junk mod fractured where the targets need the slot' : '';
      }
      const lost = targetsLost(current, n);
      const dead = targetsNowDead(current, n, lost);
      const freed = targetsFreed(current, n);
      const parts = [];
      if (lost.length) {
        parts.push(`loses ${lost.map(label).join(' and ')}`);
      }
      if (freed.length) {
        parts.push(`clears the lower tier of ${freed.map(label).join(' and ')}`);
      }
      if (dead.length) {
        parts.push(`rolls a lower tier of ${dead.map(label).join(' and ')}`);
      }
      if (hasFracturedJunk(n)) {
        parts.push('junk fractured');
      }
      if (!parts.length && n.F === current.F && n.st.every((x, k) => x === current.st[k])) {
        parts.push('only junk changes');
      }
      return parts.join(', ').replace(/\|/g, '/');
    };

    // A key for where a result goes: 'again', 'new|note', 'back:N|note[|reforge]', 'else|note|next[|to]'.
    const whereItGoes = n => {
      if (n === current) {
        return 'again';
      }
      const note = whatChanged(n);
      if (n.F === -2 || n.key === 'ruined') {
        return `new|${note === 'only junk changes' ? '' : note}`;
      }
      for (let i = path.length - 1; i >= 0; i--) {
        const entry = path[i];
        // "Back to step N" only when it really is that step again: the same reforge (it rerolls
        // everything), or exactly the item that step started from.
        if (entry.ref && n.pol?.ref === entry.ref) {
          return `back:${entry.idx}|${note}|reforge`;
        }
        if (entry.node && n === entry.node) {
          return `back:${entry.idx}|${note}`;
        }
      }
      // Off the path: what happened, what the plan does next, and where that leads.
      if (n.pol?.move?.how === 'restart') {
        return `new|${note}`;
      }
      const followed = followPlan(n);
      if (followed) {
        return `else|${note}|${followed.names.join(' → ')}|${followed.to}`;
      }
      // The same move next, on a changed item (a beast moved a junk mod across): not "again" from
      // here, since the item isn't the same (each beast use fills a slot on the other side).
      if (n.pol?.move && n.pol.move.how === m.how && n.pol.move.name === m.name) {
        return `else|${note}|${m.name} again`;
      }
      const next = n.done ? '' : n.pol?.ref?.name ?? n.pol?.move?.name ?? '';
      return `else|${note}|${next}`;
    };

    const chanceByKey = new Map();
    const likeliestByKey = new Map();
    for (const o of m.outs) {
      const key = goodSet.has(o) ? 'on' : whereItGoes(o.n);
      chanceByKey.set(key, (chanceByKey.get(key) ?? 0) + o.p);
      if (!likeliestByKey.has(key) || o.p > likeliestByKey.get(key).p) {
        likeliestByKey.set(key, o);
      }
    }

    // What a result did, for the page's pop-up: the wanted mods lost (shown struck out on the
    // item), lower tiers rolled or cleared, and the item afterwards.
    const changeDetails = key => {
      const n = likeliestByKey.get(key)?.n;
      if (!n || !n.st || n.key === 'ruined' || key === 'on' || key === 'again') {
        return {};
      }
      const fullText = k => modText(T[k].m, T[k].minTier);
      const lost = targetsLost(current, n);
      const dead = targetsNowDead(current, n, lost);
      const freed = targetsFreed(current, n);
      const chg = { lost: lost.map(fullText), dead: dead.map(fullText), freed: freed.map(fullText), junkFrac: hasFracturedJunk(n) };
      if (!chg.lost.length && !chg.dead.length && !chg.freed.length && !chg.junkFrac) {
        return {};
      }
      const ex = n.F === -2 ? null : exampleItem(n);
      if (ex) {
        for (const k of lost) {
          ex[T[k].side].unshift({ text: fullText(k), kind: 'lost' });
        }
      }
      return { chg, ex };
    };

    const kindOrder = key => {
      if (key === 'on') {
        return 0;
      }
      if (key === 'again') {
        return 1;
      }
      if (key.startsWith('back')) {
        return 2;
      }
      if (key.startsWith('new')) {
        return 3;
      }
      return 4;
    };
    // Rare results (under 1%, past the first four) are folded together.
    const all = [...chanceByKey].filter(([, p]) => p > 1e-4).sort((a, b) => kindOrder(a[0]) - kindOrder(b[0]) || b[1] - a[1]);
    const shown = all.filter(([key, p], i) => key === 'on' || i < 4 || p >= 0.01);
    let foldedChance = 0;
    for (const entry of all) {
      if (!shown.includes(entry)) {
        foldedChance = foldedChance + entry[1];
      }
    }
    if (foldedChance > 1e-4) {
      shown.push(['else|other results|', foldedChance]);
    }
    return shown.map(([key, p]) => ({ ...flowEntryOf(key, p, restartTo), ...changeDetails(key) }));
  }

  // A flow entry from a whereItGoes key.
  function flowEntryOf(key, p, restartTo) {
    if (key.startsWith('back:')) {
      const [to, note, how] = key.slice(5).split('|');
      return { kind: 'back', to: +to, p, note: note || undefined, reforge: how === 'reforge' };
    }
    if (key.startsWith('else|')) {
      const [, note, next, to] = key.split('|');
      let back;
      if (to === 'self' || to === 'done') {
        back = to;
      } else if (to !== '' && to != null) {
        back = +to;
      } else {
        back = null;
      }
      return { kind: 'else', p, note, next, back };
    }
    if (key.startsWith('new|')) {
      return { kind: 'new', p, note: key.slice(4) || 'bricked', to: restartTo };
    }
    if (key === 'again') {
      return { kind: 'again', p, note: 'nothing changes' };
    }
    return { kind: key, p };
  }

  // A Recombinator half: Alterations until it shows its mods (then a Regal, if it needs one).
  const halfFlow = input => [{ kind: 'on', p: input.pAlt }, { kind: 'again', p: 1 - input.pAlt, note: 'wrong or extra mods' }];
  // How many targets a node has.
  const hitsOf = n => {
    if (!n?.st) {
      return fixedF >= 0 ? 1 : 0;
    }
    return n.st.filter(x => x === 1).length;
  };
  // An Allflame reforge's good results: those that add a wanted mod.
  const afGood = (r, from) => r.nodes.filter(o => o.n.done || hitsOf(o.n) > hitsOf(from));
  // A repeated reforge: it moves on when it stops, anything else is the next try.
  const refFlow = (r, from = null) => {
    if (r.bestOf) {
      let goodChance = 0;
      for (const o of afGood(r, from)) {
        goodChance = goodChance + o.p;
      }
      const flow = [{ kind: 'on', p: goodChance }];
      if (goodChance < 1 - 1e-4) {
        flow.push({ kind: 'else', p: 1 - goodChance, note: 'no wanted mod added', next: 'the plan carries on from the item it left' });
      }
      return flow;
    }
    const flow = [{ kind: 'on', p: r.stop }];
    if (r.stop < 1 - 1e-4) {
      flow.push({ kind: 'again', p: 1 - r.stop, note: 'nothing worth keeping (it rerolls again)' });
    }
    return flow;
  };
  // The likeliest result where a reforge worth R stops (or the likeliest result at all).
  // (The fallback sorts `nodes` in place, likeliest first.)
  const likelyStop = (nodes, R) => {
    const stops = nodes.filter(o => o.n.done || Math.min(o.n.W, o.n.V) < R - 1e-9);
    const likeliest = stops.sort((a, b) => b.p - a.p)[0] ?? nodes.sort((a, b) => b.p - a.p)[0];
    return likeliest?.n;
  };

  // The veiled mods of a type on this base (their texts). When an unveil misses, the mod kept must
  // not have that type: an Annul under "Cannot roll Caster Modifiers" (or Attack) couldn't remove it.
  function veiledModsWithType(tag) {
    const names = [];
    for (const mod of B.mods) {
      if (mod.src === 'veiled' && mod.tags.includes(tag) && !names.includes(mod.text)) {
        names.push(mod.text);
      }
    }
    return names;
  }

  // The warning for a type an Annul will have to keep: don't pick such a mod when unveiling. The
  // mods themselves go with the step as `avoid` (the page lists them in a popup, see avoidLists),
  // a link at the end of the step's line. A base with no veiled mod of that type has nothing to
  // avoid (and no list to point at), so there is no warning.
  function dontPickTypeText(tag) {
    const mods = veiledModsWithType(tag);
    if (!mods.length) {
      return '';
    }
    const listLink = `"${mods.length} ${tag}-tagged mod${mods.length === 1 ? '' : 's'} not to pick"`;
    return `When an unveil misses, don't pick a ${tag}-tagged mod (the ${listLink} link at the end of this step lists them): "Cannot roll ${tag === 'caster' ? 'Caster' : 'Attack'} Modifiers" + Orb of Annulment can't remove it, so it would stay stuck next to your ${tag} mods. Pick any other one.`;
  }

  // A step's lists of mods not to pick: [{tag, mods: [texts]}], one per type (null when none).
  function avoidLists(tags) {
    const lists = [];
    for (const tag of tags) {
      const mods = veiledModsWithType(tag);
      if (mods.length) {
        lists.push({ tag, mods });
      }
    }
    return lists.length ? lists : null;
  }

  // The types whose wanted mods sit on the locked side of a locked Veiled Chaos: a missed unveil
  // there is cleaned with "Cannot roll <type> Modifiers" + Annul, which keeps those mods.
  function typesToKeepBehindLock(r) {
    const types = [];
    for (const tag of ['caster', 'attack']) {
      if (T.some(t => t.kind === 'roll' && t.side === r.lockedSide && t.m.tags.includes(tag))) {
        types.push(tag);
      }
    }
    return types;
  }

  // A reforge as a step: what it is, how often it stops, and its good results.
  function refStep(r, isFirst, from = null) {
    // (An Allflame reforge is done once: every result moves on, so the good ones are those that
    // add a wanted mod.)
    let stops;
    if (r.bestOf) {
      stops = afGood(r, from);
    } else {
      stops = r.nodes.filter(o => o.n.done || Math.min(o.n.W, bestOtherRef(o.n, r)) < r.R - 1e-9);
    }
    stops = stops.sort((a, b) => b.p - a.p);
    // States that read the same (they differ only in which side the junk is on) are merged.
    const byText = new Map();
    const ess = essOf(r);
    for (const o of stops) {
      const text = stateText(o.n, ess);
      const entry = byText.get(text) ?? { p: 0, n: o.n };
      entry.p += o.p;
      byText.set(text, entry);
    }
    const merged = [...byText].sort((a, b) => b[1].p - a[1].p);
    let what = r.name;
    if (r.family === 'fossil') {
      const fossilCount = r.name.split(' + ').length;
      what = `${opt.ruthless ? 'Scour, then ' : ''}${r.name} in a ${resName(fossilCount)}`;
    }
    // (At the Allflame bench every try is one more Allflame craft on the item.)
    const allflameNote = r.bestOf ? ` (Allflame craft ${r.a + 1} of at most ${afUses} on this item; ${pctText(r.pShow)} chance it still shows ${r.bestOf} outcomes)` : '';
    // The good results (where the strategy moves on) go in a list the page shows on demand.
    const results = merged.slice(0, 8).map(([text, x]) => ({ text, p: x.p, done: !!x.n.done, ex: exampleItem(x.n, ess) }));
    let restChance = 0;
    for (const [, x] of merged.slice(8)) {
      restChance = restChance + x.p;
    }
    // How often it stops with a side already full while a wanted mod for that side is missing:
    // then a slot has to be freed first (an Annul, or a lock + Annul) before anything can add it.
    const blockedSides = n => ['p', 's'].filter(side => {
      const stillWanted = n.st.some((x, k) => x !== 1 && T[k].side === side && T[k].kind === 'roll');
      const full = sideCount(n.st, side) + (side === 'p' ? n.jp : n.js) + reserve[side] >= max[side];
      return stillWanted && full;
    });
    let stopChance = 0;
    for (const o of stops) {
      stopChance = stopChance + o.p;
    }
    const fullBy = { p: 0, s: 0 };
    for (const o of stops) {
      for (const side of blockedSides(o.n)) {
        fullBy[side] += o.p;
      }
    }
    let fullText = '';
    for (const side of ['p', 's']) {
      if (fullBy[side] / Math.max(1e-12, stopChance) > 0.01) {
        fullText += ` ${pctText(fullBy[side] / stopChance)} of those stop with the ${SIDE_NAME[side]}es full while one is still wanted: a slot has to be freed first (an Annul, or a lock + Annul).`;
      }
    }
    const alchemyFirst = isFirst && r.family === 'chaos' ? 'Orb of Alchemy, then ' : '';
    let repeatText;
    if (r.bestOf) {
      repeatText = ', once: keep the best outcome it shows.';
    } else {
      let until;
      if (merged.length === 1 && merged[0][1].n.done) {
        until = 'the item is done';
      } else {
        until = `one of ${merged.length} good result${merged.length === 1 ? '' : 's'}`;
      }
      repeatText = `, repeated until ${until}: ${pctText(r.stop)} per try, about ${fmtN(tries(r.stop))} tries.`;
    }
    let how = r.name;
    if (r.family.startsWith('essence')) {
      how = 'Essence';
    } else if (r.family === 'fossil') {
      how = 'Fossils';
    }
    let unveilText = '';
    let avoid = null;
    if (r.lockedSide) {
      const tags = typesToKeepBehindLock(r);
      for (const tag of tags) {
        const warning = dontPickTypeText(tag);
        if (warning) {
          unveilText += ` ${warning}`;
        }
      }
      avoid = avoidLists(tags);
    }
    return {
      text: `${alchemyFirst}${what}${allflameNote}${repeatText}${fullText}${unveilText}`,
      avoid,
      results,
      resultsRest: restChance,
      p: r.bestOf ? stopChance : r.stop,
      cost: r.R,
      rem: r.R,
      how,
    };
  }

  // The missing targets a move can land, as "A / B / C (or 2 more)" for "<move> for ...". Only the
  // ones its outcomes can add: a bench block on one side leaves the other side's (with no such
  // outcomes, say an Annul, every missing target).
  function landableText(m, n) {
    const missing = [];
    const landable = [];
    for (let k = 0; k < n.st.length; k++) {
      if (n.st[k] !== 0) {
        continue;
      }
      missing.push(k);
      let canLand = false;
      for (const o of m.outs ?? []) {
        if (o.p > 0 && o.n && o.n.F !== -2 && o.n.st[k] === 1) {
          canLand = true;
        }
      }
      if (canLand) {
        landable.push(k);
      }
    }
    let shown = landable;
    if (!landable.length) {
      shown = missing;
    }
    const names = [];
    for (const k of shown.slice(0, 3)) {
      names.push(label(k));
    }
    let text = names.join(' / ');
    if (shown.length > 3) {
      text += ` (or ${shown.length - 3} more)`;
    }
    return text;
  }

  // A move as text. pGood: the chance it moves the craft forward.
  function moveText(m, n, pGood) {
    const firstMissing = landableText(m, n);
    switch (m.how) {
      case 'fracture': {
        const modCount = n.st.filter(x => x === 1).length + n.jp + n.js;
        return `${FRACTURE}: it fractures one of its ${modCount} mods at random, a target ${pctText(pGood)} of the time, and that mod can never be lost. A fractured junk mod just keeps its slot for good (the base is only ruined if the targets need that slot).`;
      }
      case 'restart':
        return `Start a new base: a junk mod fractured where the plan can't use it is cheaper to abandon than to work around.`;
      case 'annul':
        return `Orb of Annulment to clear junk: ${pctText(pGood)} it removes something you don't need.`;
      case 'eannul':
        return `Eldritch Orb of Annulment (removes only from the dominant side): ${pctText(pGood)} it hits junk.`;
      case 'scour':
        return `${m.name}: wipes the other side's junk and keeps this side.`;
      case 'vexalt':
        return `Veiled Exalted Orb: adds a veiled mod (needs an open slot), then removes another random mod; unveil for ${label(veiledK)} (${pctText(pGood)} overall).`;
      case 'typeannul': {
        const metamodTakesIt = m.outs[m.outs.length - 1].p;
        let unveilWarning = dontPickTypeText(m.tag);
        if (unveilWarning) {
          unveilWarning += ' ';
        }
        return `${m.name}: an Annul can't take a ${m.tag} mod while the metamod is on, so the wanted ${m.tag} mods are safe (the metamod itself goes 1 time in ${fmtN(1 / metamodTakesIt)}); ${pctText(pGood)} it removes a mod you don't need. ${unveilWarning}Remove the metamod after.`;
      }
      case 'lockannul': {
        const metamodTakesIt = m.outs[m.outs.length - 1].p;
        return `${m.name}: only ${SIDE_NAME[m.side]}es can go (the metamod itself 1 time in ${fmtN(1 / metamodTakesIt)}); ${pctText(pGood)} it removes a mod you don't need. Remove the metamod after.`;
      }
      case 'multimeta':
        return `${m.name} for ${firstMissing}: ${pctText(pGood)} per try. Remove the crafted mods after.`;
      case 'hk': {
        const goodPreview = m.pA ?? 0;
        return `${m.name}, for the last mod only: the Lock (${fmtC(hkLock)}; the item is rare, so the beast recipe doesn't work) shows one result; apply the currency only if it finishes the item (${pctText(goodPreview)} of the time). A bad preview can't be rerolled (changing the item ends the foresight), so that Lock is spent: about ${fmtN(tries(goodPreview))} Locks on average, ${fmtN(triesAt(goodPreview, 0.9))} for a 90% chance.`;
      }
      case 'hadd':
        return `${m.name} (it also removes a random mod): ${pctText(pGood)} it lands a missing target.`;
      case 'lockhadd':
        return `${m.name}: the new mod goes on, then a random mod on the unlocked side (or the metamod) is removed; the locked side is safe. ${pctText(pGood)} it lands a missing target.`;
      case 'beast': {
        // It removes a random mod from its side first: say how often that's a wanted one.
        let loseChance = 0;
        for (const o of m.outs) {
          if (n.st.some((x, k) => x === 1 && o.n.st[k] !== 1)) {
            loseChance = loseChance + o.p;
          }
        }
        const removes = m.name === CUR.wolf ? 'prefix' : 'suffix';
        const adds = m.name === CUR.wolf ? 'suffix' : 'prefix';
        const loseText = loseChance > 1e-4 ? `, ${pctText(loseChance)} it takes away a wanted mod` : ' (it only removes junk here)';
        return `${m.name}: removes a random ${removes} and adds a ${adds}; ${pctText(pGood)} it lands a missing target${loseText}.`;
      }
      case 'recomb':
        return `Recombine this item with a new clean item carrying ${m.recAdd.map(label).join(' and ')} (the card below shows how): ${pctText(pGood)} of the time it comes out better.`;
      default:
        return `${m.name} for ${firstMissing}: ${pctText(pGood)} per try.`;
    }
  }

  // The Ember and Ichor that make one side dominant (variant 'p': Exarch, 's': Eater).
  const eldCost = variant => {
    const tierCount = B.mods.find(m => m.affix === 'r')?.tiers.length ?? 4;
    const high = Math.min(2, tierCount - 1);
    const emberTier = variant === 'p' ? high : 0;
    const ichorTier = variant === 'p' ? 0 : high;
    return P(`${ELDRITCH_TIERS[emberTier]} Eldritch Ember`) + P(`${ELDRITCH_TIERS[ichorTier]} Eldritch Ichor`);
  };

  // ----- runs -----
  // One solve with every method; each way to begin (Chaos, an essence, fossils,
  // Alteration, Veiled Chaos) is then ranked by its true value with best play
  // after it. Eldritch implicits change which moves exist, so they get their own
  // solves. Fossil combos (up to 4) are scored against a first solve and the
  // best three join the final one ("fossil auto-calculation").
  const results = [];
  // ctx.onPlan: each plan is handed over (as a preview) as soon as it is made.
  let streamedCount = 0;
  const streamNewPlans = () => {
    if (!ctx.onPlan) {
      return;
    }
    while (streamedCount < results.length) {
      ctx.onPlan(planPreview(results[streamedCount]));
      streamedCount++;
    }
  };
  const mirror = P('Mirror of Kalandra');
  const solveTimed = (name, variant, warm) => {
    const startedAt = Date.now();
    const sol = solve(variant, name, warm);
    if (SOLVER.debug) {
      SOLVER.debug(`${name}: ${sol.states.size} states, ${Date.now() - startedAt} ms, ${SOLVER.iters + 1} rounds`);
    }
    return sol;
  };
  // Restricted solves show each method family on its own (with every finishing
  // move still allowed); the unrestricted one is the overall best.
  // (In the order the page shows them as they're ready.)
  const families = [];
  if (essences.length) {
    families.push(['Essence spam', f => f.startsWith('essence:')]);
  }
  if (fixedF < 0 && !opt.noAlt) {
    families.push(['Alteration / Regal', f => f === 'alt']);
  }
  families.push(['Chaos spam', f => f === 'chaos']);
  if (veiledK >= 0) {
    families.push(['Veiled Chaos spam', f => f === 'vchaos']);
  }
  if (harvestTags.length) {
    families.push(['Harvest reforges', f => f === 'harvest']);
  }


  // ----- the state graph: run the strategy many times through the state
  // machine and count which classes of states it passes and how it moves. -----
  const prefixTargets = [];
  const suffixTargets = [];
  for (let k = 0; k < T.length; k++) {
    if (T[k].side === 'p') {
      prefixTargets.push(k);
    } else if (T[k].side === 's') {
      suffixTargets.push(k);
    }
  }

  // The class of a state shown as one box in the graph: wanted count, sides done,
  // fractured, junk and whether the item is full. (A wrong tier counts as junk here; the
  // typical-item text names it.)
  function classOf(n) {
    if (n.done) {
      return { id: 'done', label: 'Done', c: K, done: true };
    }
    if (n.key === 'ruined') {
      return { id: 'ruined', label: 'Ruined (a fracture that blocks a target): new base', c: -1, ruined: true };
    }
    const wanted = n.st.filter(x => x === 1).length;
    const junk = n.jp + n.js;
    const prefixesDone = prefixTargets.length > 0 && prefixTargets.every(k => n.st[k] === 1);
    const suffixesDone = suffixTargets.length > 0 && suffixTargets.every(k => n.st[k] === 1);
    const full = wanted + junk >= B.slots;
    const fractured = n.F >= 0 || hasFracturedJunk(n);
    const parts = [`${wanted} of ${K} wanted`];
    if (prefixesDone) {
      parts.push('prefixes done');
    }
    if (suffixesDone) {
      parts.push('suffixes done');
    }
    if (fractured) {
      parts.push('1 fractured');
    }
    if (junk) {
      parts.push(full ? `${junk} junk, full` : `${junk} junk`);
    }
    const id = `${wanted}|${prefixesDone ? 1 : 0}${suffixesDone ? 1 : 0}|${fractured ? 1 : 0}|${junk}|${full ? 1 : 0}`;
    return { id, label: parts.join(' · '), c: wanted, junk, frac: fractured, pre: prefixesDone, suf: suffixesDone, full };
  }

  // Graph arrow names; currency names here show as icons.
  const HOW = {
    restart: 'New base', hk: `${HK_LOCK} + ${CUR.exalt}`, exalt: CUR.exalt, block: `Blocker + ${CUR.exalt}`, meta: `Metamod + ${CUR.exalt}`, multimeta: `Multimod + ${CUR.exalt}`,
    eexalt: CUR.eexalt, annul: CUR.annul, eannul: CUR.eannul, lockannul: `Lock + ${CUR.annul}`, scour: `Lock + ${CUR.scour}`, fracture: FRACTURE, vexalt: CUR.vexalt,
    beast: 'Farric beast', hadd: 'Harvest: add a mod', lockhadd: 'Lock + Harvest add', recomb: 'Recombinator',
  };

  // Simulates crafts with a solution's strategy: the state graph (classes of states and the moves
  // between them), the cost spread, and the currency used.
  // extra: chaos every craft also costs. from: start each craft at your own item instead
  // ({n}: its state, {regal}: a magic one's Regal) or at an opening ({enter, label, ...}).
  function simulateGraph(sol, extra, maxRuns = 500, budgetMs = 1200, maxMoves = 4000, minRuns = 50, from = null) {
    const startedAt = Date.now();
    let runs = 0;
    let unfinished = 0;
    const rnd = mulberry32(12345);
    const graphNodes = new Map();
    const edges = new Map();
    const costs = [];

    const graphNode = stateClass => {
      let x = graphNodes.get(stateClass.id);
      if (!x) {
        x = { ...stateClass, visits: 0, runs: 0, lastRun: -1, Vsum: 0, Vn: 0, reps: new Map() };
        graphNodes.set(stateClass.id, x);
      }
      return x;
    };
    const visit = (x, run, n) => {
      x.visits++;
      if (x.lastRun !== run) {
        x.runs++;
        x.lastRun = run;
      }
      if (n && isFinite(n.V) && !n.done) {
        x.Vsum += n.V;
        x.Vn++;
        x.reps.set(n, (x.reps.get(n) ?? 0) + 1);
      }
      if (n?.done) {
        x.doneRep ??= n;
      }
    };
    const addEdge = (a, b, action, tries = 1, cost = 0) => {
      const key = a.id + '>' + b.id + '>' + action;
      const e = edges.get(key) ?? { from: a.id, to: b.id, action, n: 0, tries: 0, cost: 0 };
      e.n++;
      e.tries += tries;
      e.cost += cost;
      edges.set(key, e);
    };
    // One random outcome (only those passing filter, if given).
    const pickOutcome = (outs, filter = null) => {
      let total = 0;
      for (const o of outs) {
        if (!filter || filter(o)) {
          total += o.p;
        }
      }
      let x = rnd() * total;
      for (const o of outs) {
        if (filter && !filter(o)) {
          continue;
        }
        x -= o.p;
        if (x < 0) {
          return o;
        }
      }
      return outs[outs.length - 1];
    };
    const triesUntil = p => triesUntilSuccess(rnd, p);
    let baseLabel;
    if (from?.label) {
      baseLabel = from.label;
    } else if (from) {
      baseLabel = 'Your item';
    } else {
      baseLabel = presetF ? 'Fractured base' : 'Normal base';
    }
    const baseClass = { id: 'base', label: baseLabel, c: presetF ? 1 : 0, start: true };
    const solStart = sol.start;
    // Currency used per craft: name -> count, for each simulated run.
    const usage = [];

    // Once per craft: influence setup, Eldritch implicits, swaps (when the element came out
    // wrong), and the bench crafts at the end.
    const fixedBill = () => {
      const parts = [];
      // (Your own item already has its influence.)
      const setsInfluence = !from || from.infl;
      if (setsInfluence && inflSteps.some(x => /randomise influence/.test(x.text))) {
        parts.push(billOf(lifeforce(INFLUENCE_RANDOMISE[0]), triesUntilSuccess(rnd, 1 / 6) * INFLUENCE_RANDOMISE[1]));
      }
      if (setsInfluence && inflSteps.some(x => /Awakener's Orb/.test(x.text))) {
        parts.push(billOf(AWAKENER));
      }
      if (sol.variant && !eldT.length) {
        const tierCount = B.mods.find(m => m.affix === 'r')?.tiers.length ?? 4;
        const high = Math.min(2, tierCount - 1);
        parts.push(billOf(`${ELDRITCH_TIERS[sol.variant === 'p' ? high : 0]} Eldritch Ember`), billOf(`${ELDRITCH_TIERS[sol.variant === 'p' ? 0 : high]} Eldritch Ichor`));
      }
      if (eldTargetCost > 0) {
        parts.push({ [ELD_VALUE]: eldTargetCost });
      }
      if (!from?.noSwaps) {
        for (const swap of from?.swaps ?? swaps) {
          if (swap.share > 0.01 && isFinite(swap.cost) && rnd() < swap.share) {
            parts.push(billOf(lifeforce(swap.colour), RES_SWAP_AMOUNT), swap.rancour ? billOf(RANCOUR, DMG_SWAP_RANCOUR) : null);
          }
        }
      }
      if (!ctx.sub) {
        for (const t of benchT) {
          parts.push(benchBill(t.m, t.minTier));
        }
      }
      if (!ctx.sub && benchT.length > 1) {
        parts.push(benchBill(findMetamod(B, 'mul_mods'), 0));
      }
      return combineBills(...parts);
    };

    // How many times each step's move runs in each craft (a reforge by its strategy, any other
    // move by the state it's used from), bricked items and loops back included.
    const stepRuns = new Map();
    // This run's state: currency used, chaos spent, step counts.
    let used = null;
    let cost = 0;
    let stepsThisRun = null;
    const countStep = (key, times) => {
      stepsThisRun.set(key, (stepsThisRun.get(key) ?? 0) + times);
    };
    const spend = (bill, times = 1) => {
      if (!bill || !times) {
        return;
      }
      for (const [name, amount] of Object.entries(bill)) {
        used[name] = (used[name] ?? 0) + amount * times;
      }
    };
    // (An opening's currency counts toward the craft's cost too; values like Eldritch implicits
    // are already in chaos.)
    const spendWithCost = (bill, times = 1) => {
      if (!bill || !times) {
        return;
      }
      spend(bill, times);
      for (const [name, amount] of Object.entries(bill)) {
        const unitPrice = name === ELD_VALUE || name === DONOR_VALUE ? 1 : P(name) || 0;
        cost += amount * times * unitPrice;
      }
    };
    const alterationBill = a => combineBills(billOf(CUR.alt), a.augPer ? billOf(CUR.aug, a.augPer) : null);

    // A reforge repeated until it stops: returns the outcome.
    const runReforge = (fromGraphNode, r, firstCost) => {
      const tries = triesUntil(Math.max(r.stop, 1e-12));
      const outcome = pickOutcome(r.nodes, o => o.n.done || o.n.pol?.ref !== r);
      cost += firstCost + tries * r.cost;
      countStep(r, tries);
      return { tries, outcome };
    };

    // Getting onto the state machine from a new base: the start reforge, or Alterations and a Regal.
    const enterFromNewBase = baseNode => {
      const startBest = solStart.best;
      if (startBest?.ref) {
        const r = startBest.ref;
        const { tries, outcome } = runReforge(baseNode, r, startBest.c0);
        if (startBest.c0) {
          spend(billOf(CUR.alch));
        }
        spend(r.bill ?? billOf(r.name), tries);
        addEdge(baseNode, graphNode(classOf(outcome.n)), r.name, tries, tries * r.cost);
        return outcome.n;
      }
      return enterByAlteration(baseNode, startBest.alt);
    };

    const enterByAlteration = (baseNode, a) => {
      const perTry = (a.altCost - P(CUR.transmute)) * a.p;
      const tries = triesUntil(a.p);
      cost += P(CUR.transmute) + tries * perTry;
      spend(billOf(CUR.transmute));
      spend(alterationBill(a), tries);
      const coreLabel = a.core.map(k => label(k)).join(' + ');
      const magicNode = graphNode({ id: 'magic', label: `Magic: ${coreLabel}`, c: a.core.length, magic: true, ex: magicExample(a.core) });
      addEdge(baseNode, magicNode, a.core.length === 2 ? 'Alteration (+Augment)' : 'Alteration', tries, tries * perTry);
      visit(magicNode, runs - 1);
      let regalFrom = magicNode;
      if (a.imp) {
        const imprintNode = graphNode({ id: 'imprint', label: 'Magic, imprint saved', c: a.core.length, magic: true, ex: magicExample(a.core) });
        addEdge(magicNode, imprintNode, 'Imprint (Craicic Chimeral)', 1, P(CUR.imprint));
        cost += P(CUR.imprint);
        spend(billOf(CUR.imprint));
        visit(imprintNode, runs - 1);
        regalFrom = imprintNode;
      }
      if (a.hk) {
        const good = a.outs.filter(o => (o.n.done ? 0 : o.n.V) <= a.hk.cut);
        const outcome = pickOutcome(good);
        const magicItemsMade = triesUntil(a.hk.stop); // each with a fresh Lock
        cost += magicItemsMade * hkSetup + P(CUR.regal) + (magicItemsMade - 1) * a.altCost;
        spend(combineBills(...HK_SETUP.map(x => billOf(x))), magicItemsMade);
        spend(billOf(CUR.regal));
        spend(billOf(CUR.transmute), magicItemsMade - 1);
        spend(alterationBill(a), (magicItemsMade - 1) / Math.max(1e-9, a.p));
        addEdge(regalFrom, graphNode(classOf(outcome.n)), "Hinekora's Lock + Regal", 1, 0);
        return outcome.n;
      }
      // Regal until the result is worth keeping (restoring the imprint, or alterating anew).
      const keepBelow = a.imp ? a.V - a.altCost : a.V;
      for (let i = 0; i < 10000; i++) {
        const outcome = pickOutcome(a.outs);
        cost += P(CUR.regal);
        spend(billOf(CUR.regal));
        const value = outcome.n.done ? 0 : outcome.n.V;
        if (value < keepBelow || i === 9999) {
          addEdge(regalFrom, graphNode(classOf(outcome.n)), 'Regal', 1, P(CUR.regal));
          return outcome.n;
        }
        if (a.imp) {
          cost += P(CUR.imprint);
          spend(billOf(CUR.imprint));
        } else {
          const moreTries = triesUntil(a.p);
          cost += moreTries * perTry + P(CUR.transmute);
          spend(billOf(CUR.transmute));
          spend(alterationBill(a), moreTries);
        }
      }
    };

    // An opening of its own (Recombinator, influenced Exalt, Awakener's Orb), your item, or a new base.
    const beginCraft = baseNode => {
      if (from?.enter) {
        return from.enter(spendWithCost, rnd, pickOutcome);
      }
      if (!from) {
        return enterFromNewBase(baseNode);
      }
      if (from.n) {
        return from.n;
      }
      spendWithCost(billOf(CUR.regal));
      return pickOutcome(from.regal).n;
    };

    // One step of the strategy from state n; returns the next state.
    const takeStep = n => {
      const here = graphNode(classOf(n));
      visit(here, runs - 1, n);
      if (n.key === 'ruined') {
        return { next: null, ruined: true };
      }
      const pol = n.pol;
      if (!pol) {
        return { next: null, stuck: true };
      }
      if (pol.ref) {
        const r = pol.ref;
        const { tries, outcome } = runReforge(here, r, 0);
        spend(r.bill ?? billOf(r.name), tries);
        addEdge(here, graphNode(classOf(outcome.n)), r.name, tries, tries * r.cost);
        return { next: outcome.n };
      }
      const m = pol.move;
      const outcome = pickOutcome(m.outs);
      cost += m.cost;
      countStep(n, 1);
      // (Hinekora's Lock: the Lock always, the currency only when the preview was good.)
      spend(m.bill ?? billOf(m.name));
      if (m.foresee && outcome.n.done) {
        spend(m.curBill);
      }
      addEdge(here, graphNode(classOf(outcome.n)), (m.bestOf ? 'Allflame ' : '') + (HOW[m.how] ?? m.name), 1, m.cost);
      return { next: outcome.n };
    };

    for (let run = 0; run < maxRuns && (run < minRuns || Date.now() - startedAt < budgetMs); run++) {
      runs++;
      used = {};
      usage.push(used);
      stepsThisRun = new Map();
      spend(fixedBill());
      cost = extra;
      const baseNode = graphNode(baseClass);
      visit(baseNode, run);
      let current = beginCraft(baseNode);
      if (from && current?.key) {
        addEdge(baseNode, graphNode(classOf(current)), from.label ?? (from.regal ? 'Regal' : 'Start'), 1, 0);
      }
      let moveCount = 0;
      while (current && !current.done && moveCount++ < maxMoves) {
        const step = takeStep(current);
        if (step.ruined) {
          // A ruined item means a new base.
          current = enterFromNewBase(baseNode);
          continue;
        }
        if (step.stuck) {
          break;
        }
        current = step.next;
      }
      if (current?.done) {
        if (current.key) {
          visit(graphNode(classOf(current)), run, current);
        }
      } else {
        unfinished++;
      }
      costs.push(cost + benchCostTotal);
      for (const [key, times] of stepsThisRun) {
        if (!stepRuns.has(key)) {
          stepRuns.set(key, []);
        }
        stepRuns.get(key).push(times);
      }
    }

    costs.sort((a, b) => a - b);
    const usedSummary = {
      items: usageSummary(usage),
      runs,
      unfinished: unfinished / runs,
      raw: usage,
      stepRuns: new Map([...stepRuns].map(([key, timesRun]) => [key, runsSummary(timesRun, runs)])),
    };
    const boxes = [...graphNodes.values()].map(x => graphBox(x, runs));
    // Keep the states most crafts pass through, and one edge per pair (the commonest move named).
    // (The finished item always has its box, even when few simulated crafts got there.)
    if (!boxes.some(x => x.done)) {
      boxes.push({ id: 'done', label: 'Done', c: K, done: true, share: 0, visits: 0, V: 0, options: [] });
    }
    const kept = new Set(boxes.filter(x => x.start || x.done || x.magic || x.share >= 0.05).sort((a, b) => b.share - a.share).slice(0, 24).map(x => x.id));
    kept.add('done');
    // The ways into Done are spread over many last states, each one rare: keep the two commonest
    // (and the states they come from), so the graph shows how crafts finish.
    const intoDone = new Map();
    for (const e of edges.values()) {
      if (e.to === 'done' && e.from !== 'done') {
        intoDone.set(e.from, (intoDone.get(e.from) ?? 0) + e.n);
      }
    }
    const lastSteps = new Set([...intoDone].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id));
    for (const id of lastSteps) {
      kept.add(id);
    }
    const edgesOut = graphEdges(edges, kept, lastSteps, runs);
    let costSum = 0;
    for (const c of costs) {
      costSum = costSum + c;
    }
    return {
      runs,
      K,
      nodes: boxes.filter(x => kept.has(x.id)),
      used: usedSummary,
      edges: edgesOut,
      cost: { mean: costSum / costs.length, p10: quantileOfSorted(costs, 0.1), p50: quantileOfSorted(costs, 0.5), p90: quantileOfSorted(costs, 0.9) },
      unfinished: unfinished / runs,
    };
  }

  // A graph box: the class, how often crafts pass it, and the decision at its most common
  // concrete state with every option priced.
  function graphBox(x, runs) {
    let rep = null;
    let repCount = 0;
    for (const [n, c] of x.reps) {
      if (c > repCount) {
        repCount = c;
        rep = n;
      }
    }
    const options = rep ? priceOptions(rep) : [];
    let V = null;
    if (rep && isFinite(rep.V)) {
      V = rep.V;
    } else if (x.done) {
      V = 0;
    }
    return {
      id: x.id, label: x.label, c: x.c, junk: x.junk ?? 0, frac: !!x.frac, full: !!x.full, done: !!x.done, magic: !!x.magic, start: !!x.start, ruined: !!x.ruined,
      share: x.runs / runs, visits: x.visits / runs, V,
      desc: rep ? stateText(rep) : null, options: options.slice(0, 12), ex: x.ex ?? exampleItem(rep ?? x.doneRep),
    };
  }

  // Every option from a state, cheapest first: each move, and the best reforge of each kind
  // (reforges throw the item away, so they all cost about the same).
  function priceOptions(rep) {
    const options = [];
    for (const m of rep.moves) {
      const v = qMove(m);
      if (isFinite(v)) {
        options.push({ name: m.name, full: m.name, v, chosen: rep.pol?.move === m });
      }
    }
    const kindOf = r => {
      if (r.family.startsWith('essence')) {
        return 'essence';
      }
      if (r.name.startsWith('"')) {
        return 'lock:' + r.family;
      }
      return r.family;
    };
    const bestOfKind = new Map();
    for (const r of rep.refs) {
      if (isFinite(r.R) && (!bestOfKind.has(kindOf(r)) || r.R < bestOfKind.get(kindOf(r)).R)) {
        bestOfKind.set(kindOf(r), r);
      }
    }
    for (const r of bestOfKind.values()) {
      options.push({ name: r.name, full: r.name, v: r.R, chosen: rep.pol?.ref === r });
    }
    const chosenRef = rep.pol?.ref;
    if (chosenRef && !bestOfKind.has(kindOf(chosenRef))) {
      options.push({ name: chosenRef.name, full: chosenRef.name, v: chosenRef.R, chosen: true });
    }
    options.sort((a, b) => a.v - b.v);
    // Duplicates: keep the cheapest.
    const seen = new Set();
    for (let i = options.length - 1; i >= 0; i--) {
      if (seen.has(options[i].full)) {
        options.splice(i, 1);
      } else {
        seen.add(options[i].full);
      }
    }
    return options;
  }

  // The graph's arrows between kept boxes: one per pair, named by its commonest move.
  function graphEdges(edges, kept, lastSteps, runs) {
    const pairs = new Map();
    for (const e of edges.values()) {
      if (!kept.has(e.from) || !kept.has(e.to) || e.from === e.to) {
        continue;
      }
      const key = e.from + '>' + e.to;
      const pair = pairs.get(key) ?? { from: e.from, to: e.to, n: 0, actions: new Map() };
      pair.n += e.n;
      const action = pair.actions.get(e.action) ?? { n: 0, tries: 0, cost: 0 };
      action.n += e.n;
      action.tries += e.tries;
      action.cost += e.cost;
      pair.actions.set(e.action, action);
      pairs.set(key, pair);
    }
    // Chance of each move from its state: the share of the state's exits that take it.
    const exits = new Map();
    for (const pair of pairs.values()) {
      exits.set(pair.from, (exits.get(pair.from) ?? 0) + pair.n);
    }
    const allEdges = [...pairs.values()].map(pair => {
      const actions = [...pair.actions].sort((a, b) => b[1].n - a[1].n);
      const [topName, top] = actions[0];
      return {
        from: pair.from,
        to: pair.to,
        share: pair.n / runs,
        p: pair.n / exits.get(pair.from),
        action: topName,
        tries: top.tries / top.n,
        others: actions.slice(1, 4).map(([name]) => name),
      };
    });
    // The busiest 70 arrows, plus the ways into Done (taken once per craft, so a busy loop's
    // arrows would always crowd them out).
    const isFinish = e => e.to === 'done' && lastSteps.has(e.from);
    const busiest = allEdges.filter(e => e.share >= 0.02 || e.p >= 0.1).filter(e => !isFinish(e)).sort((a, b) => b.share - a.share).slice(0, 70);
    return [...busiest, ...allEdges.filter(isFinish)];
  }

  const famSols = [];
  // Solves with only one family of reforges allowed (and every finishing move), and adds its plan.
  // warm: a strategy to start from, or a list of them (each tried, the cheapest result kept: the
  // solver can settle on a slightly worse strategy depending on where it starts).
  // A family plan's other starting points, worked out now (the same as at the end of planOnce).
  function familyStartsNow(result) {
    const sol = result.sol;
    try {
      if (sol.start.best?.ref) {
        const ref = sol.start.best.ref;
        result.starts = startsOf(sol, ref.nodes.filter(o => o.n.done || o.n.pol?.ref !== ref), isFossilPlan(result));
      } else if (sol.start.best?.alt) {
        const a = sol.start.best.alt;
        const keepBelow = a.imp ? a.V - a.altCost : a.V;
        result.starts = startsOf(sol, a.outs.filter(o => o.n.done || o.n.V <= keepBelow), isFossilPlan(result));
      }
    } catch (e) {
      if (SOLVER.debug) {
        SOLVER.debug('starts: ' + e.message);
      }
    }
    result.startsDone = true;
  }

  // A finished solve holds a few hundred megabytes on a big craft: every state's moves and every
  // reforge's outcome list. Afterwards only three things are asked of it:
  // - its plan's state graph and currency count, which follow its strategy from the start, so
  //   they need only the states that strategy can reach (with their moves and reforge values,
  //   for the options a graph box lists), and the outcome lists of the reforges it uses;
  // - Best mix's warm start, which borrows each state's chosen action (a reforge's key or a
  //   move's name);
  // - fossil scoring, which reads each state's value.
  // So every other state keeps its value and a light copy of its chosen action, and every other
  // reforge its name, value and family.
  function shrinkSolve(sol) {
    const reachable = new Set();
    const queue = [];
    const reach = n => {
      if (n && !reachable.has(n)) {
        reachable.add(n);
        queue.push(n);
      }
    };
    const startBest = sol.start.best;
    const refsInUse = new Set();
    if (startBest?.ref) {
      refsInUse.add(startBest.ref);
      for (const o of startBest.ref.nodes) {
        reach(o.n);
      }
    }
    for (const a of sol.start.alts ?? []) {
      for (const o of a.outs) {
        reach(o.n);
      }
    }
    reach(sol.states.get('ruined'));
    while (queue.length) {
      const n = queue.pop();
      const action = n.pol;
      if (action?.ref) {
        refsInUse.add(action.ref);
        for (const o of action.ref.nodes) {
          reach(o.n);
        }
      } else if (action?.move) {
        for (const o of action.move.outs) {
          reach(o.n);
        }
      }
    }
    const shrinkRef = r => {
      if (!refsInUse.has(r)) {
        delete r.nodes;
        delete r.baseNodes;
      }
    };
    for (const r of sol.start.refs ?? []) {
      shrinkRef(r);
    }
    for (const n of sol.states.values()) {
      if (reachable.has(n)) {
        for (const r of n.refs ?? []) {
          shrinkRef(r);
        }
        continue;
      }
      if (n.pol?.ref) {
        n.pol = { ref: { rkey: n.pol.ref.rkey } };
      } else if (n.pol?.move) {
        n.pol = { move: { name: n.pol.move.name, how: n.pol.move.how } };
      }
      delete n.moves;
      delete n.refs;
      delete n.bestRef;
      delete n.bestMove;
    }
  }

  const runFamily = (name, family, variant = null, warm = null, silent = false) => {
    onProgress(name);
    restrict = f => f === 'lockchaos' || family(f);
    let sol = null;
    const warmStarts = Array.isArray(warm) ? warm : [warm];
    for (const warmStart of warmStarts) {
      const tried = solveTimed(name, variant, warmStart);
      if (!sol || tried.startV < sol.startV) {
        sol = tried;
      }
    }
    if (isFinite(sol.startV)) {
      famSols.push(sol);
    }
    restrict = null;
    if (!isFinite(sol.startV) || silent) {
      if (name !== 'Best mix of everything') {
        shrinkSolve(sol);
      }
      return sol;
    }
    // Eldritch variants pay for the implicits that set dominance (unless implicits are targets, already counted).
    const dominanceCost = variant && !eldT.length ? eldCost(variant) : 0;
    const extra = dominanceCost + extraTotal;
    const result = { key: name, name, ok: true, cost: sol.startV + extra + benchCostTotal, steps: trace(sol), notes: [], sol, extra };
    results.push(result);
    // Every solve but Best mix (which much else is built on) is shrunk to what is still asked of
    // it once its plan is made: its other starting points are worked out first (they read
    // moves the strategy doesn't take).
    if (name !== 'Best mix of everything') {
      familyStartsNow(result);
      shrinkSolve(sol);
    }
    streamNewPlans();
    return sol;
  };

  let first = null;
  // (The fossil phases only need Chaos spam, to score fossils against; the base phase shows the rest.)
  if (!ctx.bestOnly) {
    const onlyChaos = phase && phase !== 'base';
    for (const [name, family] of families) {
      if (onlyChaos && name !== 'Chaos spam') {
        continue;
      }
      const sol = runFamily(name, family, null, null, onlyChaos);
      if (name === 'Chaos spam') {
        first = sol;
      }
    }
  }

  // How many of a fossil combination's boosted tags the targets have (the fallback ranking).
  const boostedTargetTags = combo => {
    let total = 0;
    for (const fossil of combo) {
      total = total + Object.keys(fossil.more).filter(tag => T.some(t => modHasTag(t.m, tag))).length;
    }
    return total;
  };
  const comboKey = combo => combo.map(f => f.id).join('-');

  // The chance one reforge lands every rolled wanted mod that counts (counts(k)) at once. 0 when
  // none of them is a rolled one.
  function chanceOfAllRolled(outs, counts) {
    const counted = [];
    for (let k = 0; k < K; k++) {
      if (T[k].kind === 'roll' && counts(k)) {
        counted.push(k);
      }
    }
    if (!counted.length) {
      return 0;
    }
    let chance = 0;
    for (const o of outs) {
      if (counted.every(k => o.st[k] === 1)) {
        chance = chance + o.p;
      }
    }
    return chance;
  }

  // Each fossil combination priced as the opening of a craft from start F0 (with the Chaos
  // spam solve's values for where it lands), best first.
  function scoreFossilCombos(combos, F0) {
    const list = [];
    for (const combo of combos) {
      let cost = 0;
      for (const fossil of combo) {
        cost = cost + P(fossil.name);
      }
      cost = cost + resonator(combo.length);
      if (!isFinite(cost)) {
        continue;
      }
      const reforged = fullReforge(F0, 'fossil', '', cost, { fossils: combo });
      const outs = reforged.outs.map(o => {
        const n = first?.states.get(o.key);
        return { p: o.p, A: n ? (n.done ? 0 : n.V) : Infinity };
      });
      // (Unknown outcomes: rank by the chance to land all the missing mods at once, per chaos.
      // Only the mods fossils roll count: a veiled or essence-only mod never comes from them.)
      const allAtOnce = chanceOfAllRolled(reforged.outs, k => true);
      const proxyBySide = {};
      for (const side of ['p', 's']) {
        const sideAtOnce = chanceOfAllRolled(reforged.outs, k => T[k].side === side);
        proxyBySide[side] = sideAtOnce > 0 ? cost / sideAtOnce : Infinity;
      }
      list.push({ combo, cost, R: stopValue(cost, outs).R, proxy: allAtOnce > 0 ? cost / allAtOnce : Infinity, proxyBySide, outs: reforged.outs });
    }
    const anyKnown = list.some(x => isFinite(x.R));
    list.sort((a, b) => (anyKnown ? a.R - b.R : a.proxy - b.proxy) || a.proxy - b.proxy);
    return list;
  }

  let fossilScored = []; // every fossil combination tried, with its reforge results
  if (ctx.bestOnly) {
    fossilCombos = ctx.fossilCombos ?? [];
  } else if (B.info.fossil && index.fossils?.length && phase !== 'base') {
    onProgress('Fossils');
    const scoringStart = Date.now();
    // Fossil-only targets (Faceted Fossil's socketed-gem mods) need their fossil in every combination.
    const needF = new Set(T.filter(t => t.m.src === 'fossil' && t.m.fossil != null).map(t => String(t.m.fossil)));
    // Rank every combination of the usable fossils with a quick score (see rankFossilCombos);
    // the best of them get priced properly below.
    const usableFossils = findUsableFossils(index.fossils, T, needF, P);
    const combos = rankFossilCombos({
      fossils: usableFossils,
      modPool: freshRarePoolWithFossilMods(B, ilvl, infl, usableFossils),
      targets: T,
      fracturedTargetIndex: fixedF,
      requiredFossilIds: needF,
    });
    // Score each combination from a new base, and (when a Fracturing Orb is possible) from each
    // wanted mod fractured: the best fossils once a mod is locked in are often different ones
    // (only the remaining mods' tags need boosting). The best few for each start go into the plans.
    const starts = [fixedF];
    if (fixedF < 0 && !infl.length && isFinite(P(FRACTURE))) {
      for (let k = 0; k < T.length; k++) {
        if (T[k].kind === 'roll') {
          starts.push(k);
        }
      }
    }
    const scoredByStart = new Map();
    for (const F0 of starts) {
      scoredByStart.set(F0, scoreFossilCombos(combos, F0));
    }
    const scored = scoredByStart.get(fixedF);
    if (!scored.some(x => isFinite(x.R))) {
      for (const x of scored) {
        x.R = -boostedTargetTags(x.combo) / x.cost;
      }
    }
    scored.sort((a, b) => a.R - b.R);
    fossilScored = scored;
    const picked = new Map();
    for (const x of scored.slice(0, 3)) {
      picked.set(comboKey(x.combo), x);
    }
    // Also the combinations that hit the wanted mods most cheaply in one reforge (Craft of Exile's
    // "cost efficiency"): when one hard mod dominates the cost, the whole-craft values above barely
    // differ and would only keep single fossils.
    const cheapestFullHits = [...scored].filter(x => isFinite(x.proxy)).sort((a, b) => a.proxy - b.proxy).slice(0, 3);
    for (const x of cheapestFullHits) {
      picked.set(comboKey(x.combo), x);
    }
    // And the cheapest per hit of one side's wanted mods (fossil the gem prefixes, then do the
    // suffixes another way), when that side isn't every rolled mod already.
    for (const side of ['p', 's']) {
      const rolledOnSide = T.filter(t => t.kind === 'roll' && t.side === side).length;
      const rolledInAll = T.filter(t => t.kind === 'roll').length;
      if (!rolledOnSide || rolledOnSide === rolledInAll) {
        continue;
      }
      const cheapestSideHits = [...scored].filter(x => isFinite(x.proxyBySide[side])).sort((a, b) => a.proxyBySide[side] - b.proxyBySide[side]).slice(0, 2);
      for (const x of cheapestSideHits) {
        picked.set(comboKey(x.combo), x);
      }
    }
    for (const F0 of starts.slice(1)) {
      for (const x of scoredByStart.get(F0).slice(0, 2)) {
        picked.set(comboKey(x.combo), x);
      }
    }
    fossilCombos = [...picked].map(([key, x]) => ({ key, combo: x.combo, cost: x.cost, name: x.combo.map(f => f.name).join(' + ') }));
    if (SOLVER.debug) {
      SOLVER.debug(`fossil scoring: ${combos.length} combos from ${starts.length} starts, ${Date.now() - scoringStart} ms; fossils ${usableFossils.map(f => f.name).join(', ')}; kept ${fossilCombos.map(x => x.name).join(' | ')}`);
    }
    if (fossilCombos.length || hollowK >= 0) {
      runFamily('Fossils', f => f === 'fossil');
    }
  }

  // The fewest-clicks solve stops here: its Fossils plan, with a currency count to price it.
  if (phase === 'clicks') {
    const fossilResult = results.find(x => x.key === 'Fossils');
    if (!fossilResult) {
      return { results: [] };
    }
    const { sol, extra } = fossilResult;
    fossilResult.makeUsage = () => simulateGraph(sol, extra, 400, 900, 200000, 25).used;
    delete fossilResult.sol;
    delete fossilResult.extra;
    return { results: [fossilResult] };
  }
  // (ctx.noEld: the plain item an influenced Exalted Orb finishes can't carry Eldritch implicits.)
  if (B.info.eldritch && !infl.length && !ctx.bestOnly && !ctx.noEld && (!phase || phase === 'base')) {
    for (const dominantSide of ['p', 's']) {
      runFamily(`Eldritch currency (${dominantSide === 'p' ? 'Exarch' : 'Eater'} dominant)`, () => true, dominantSide);
    }
  }
  // Side order (see planSideOrders): spec.sideOrder prices both orders as a hidden comparison (the
  // fractured-base table), spec.sidePlans as plans of their own. (Not in the fossil phase.)
  const sideOrderFirsts = [];
  if ((spec.sideOrder || spec.sidePlans) && !ctx.bestOnly && !ctx.sub && K > 1 && (!phase || phase === 'base')) {
    sideOrderFirsts.push('p', 's');
  }
  onProgress('Best mix');
  const plainSolsCheapestFirst = famSols.filter(x => !x.variant).sort((a, b) => a.startV - b.startV);
  const warmFrom = ctx.warm ?? plainSolsCheapestFirst[0] ?? null;
  // (Started from the two cheapest single-method plans and from scratch.)
  const warmTries = ctx.warm ? [ctx.warm] : [...new Set([warmFrom, ...famSols.filter(x => !x.variant).sort((a, b) => a.startV - b.startV).slice(0, 2), null])];
  const bestSol = runFamily('Best mix of everything', () => true, null, warmTries);

  // The best solve's value of a state key (0 when done, Infinity when unknown).
  const bestValueOfKey = key => {
    const n = bestSol.states.get(key);
    if (!n) {
      return Infinity;
    }
    return n.done ? 0 : n.V;
  };
  const rolledTargetIndexes = T.map((t, k) => k).filter(k => T[k].kind === 'roll');

  // Every way to start, compared: each reforge from a new base (Chaos, each essence, each Harvest
  // type, every fossil combination tried), then the best strategy from wherever it stops.
  // cost: per try; stop: chance a try ends the spam; R: the whole craft starting that way.
  function waysToStart() {
    const extra = extraTotal + benchCostTotal;
    const row = (outs, cost, firstCost) => {
      const stopping = stopValue(cost, outs);
      return { cost, stop: stopping.stop, alone: cost / Math.max(1e-12, stopping.stop), R: stopping.R + firstCost + extra };
    };
    // What one try lands: the chance of exactly j wanted mods (j = 0 … all that can roll).
    const rollCount = T.filter(t => t.kind === 'roll').length;
    const hitsSpread = outs => {
      const spread = new Array(rollCount + 1).fill(0);
      for (const o of outs) {
        spread[Math.min(rollCount, o.st.filter(x => x === 1).length)] += o.p;
      }
      return spread;
    };
    // The other way to use a reforge: keep rolling until a chosen set of wanted mods (two or more)
    // lands at once, then finish from there. The whole-craft cost of each set, cheapest first, so
    // "roll until +1 gems and Cast Speed together" can be checked against stopping wherever it pays
    // (which the plans do; it can't come out worse, since it may also stop at exactly that set).
    const goalSets = [];
    for (let mask = 1; mask < 1 << rolledTargetIndexes.length; mask++) {
      const goal = rolledTargetIndexes.filter((k, i) => mask & (1 << i));
      if (goal.length >= 2) {
        goalSets.push(goal);
      }
    }
    const goals = (outs, cost, firstCost) => {
      const found = [];
      for (const goal of goalSets) {
        let chance = 0;
        let valueSum = 0;
        for (const o of outs) {
          if (goal.every(k => o.st[k] === 1)) {
            chance += o.p;
            valueSum += o.p * o.A;
          }
        }
        if (chance > 1e-12 && isFinite(valueSum)) {
          found.push({ mods: goal.map(label), p: chance, R: firstCost + cost / chance + valueSum / chance + extra });
        }
      }
      return found.sort((x, y) => x.R - y.R).slice(0, 5);
    };
    const rows = [];
    for (const r of bestSol.start.refs ?? []) {
      let kind = null;
      if (r.family === 'chaos') {
        kind = 'chaos';
      } else if (r.family.startsWith('essence')) {
        kind = 'essence';
      } else if (r.family === 'harvest') {
        kind = 'harvest';
      }
      if (!kind || !r.nodes) {
        continue;
      }
      const firstCost = kind === 'essence' ? 0 : P(CUR.alch);
      rows.push({
        kind,
        name: r.name,
        hits: hitsSpread(r.nodes.map(o => ({ p: o.p, st: o.n.st }))),
        ...row(r.nodes.map(o => ({ p: o.p, A: o.n.done ? 0 : o.n.V })), r.cost, firstCost),
        goals: goals(r.nodes.map(o => ({ p: o.p, st: o.n.st, A: o.n.done ? 0 : o.n.V })), r.cost, firstCost),
      });
    }
    for (const a of bestSol.start.alts ?? []) {
      if (!isFinite(a.V)) {
        continue;
      }
      let lockOrImprint = '';
      if (a.hk) {
        lockOrImprint = "Hinekora's Lock + ";
      } else if (a.imp) {
        lockOrImprint = 'Imprint + ';
      }
      rows.push({ kind: 'alt', name: `Orb of Alteration for ${a.core.map(label).join(' and ')}, then ${lockOrImprint}Regal Orb`, cost: P(CUR.alt), stop: a.p, alone: a.altCost, R: a.V + extra });
    }
    for (const x of fossilScored) {
      rows.push({
        kind: 'fossil',
        name: x.combo.map(f => f.name).join(' + '),
        fossils: x.combo.map(f => f.name),
        resonator: resName(x.combo.length),
        hits: hitsSpread(x.outs),
        ...row(x.outs.map(o => ({ p: o.p, A: bestValueOfKey(o.key) })), x.cost, 0),
        goals: goals(x.outs.map(o => ({ p: o.p, st: o.st, A: bestValueOfKey(o.key) })), x.cost, 0),
      });
    }
    rows.sort((a, b) => a.R - b.R);
    return rows;
  }
  // The indexes of the targets on one side.
  function targetsOnSideList(side) {
    const list = [];
    for (let k = 0; k < K; k++) {
      if (T[k].side === side) {
        list.push(k);
      }
    }
    return list;
  }

  // How many wanted mods of this side are on the item.
  function wantedOnSide(st, side) {
    let count = 0;
    for (let k = 0; k < K; k++) {
      if (T[k].side === side && st[k] === 1) {
        count++;
      }
    }
    return count;
  }

  // While doing one side, a strategy for "prefixes first" can't aim for suffixes: a move or
  // reforge is allowed when it can add a wanted mod of the first side, or when it adds no wanted
  // mod at all (an Annul, a Fracturing Orb, a lock + Annul to free a slot). A slam or a
  // "keep prefixes" reforge that can only bring suffixes is left for later. (Choosing among the
  // allowed ones only for the first side is planSideOrders' job.)
  function onlyAimsAtOtherSide(firstSide, st, outs) {
    const otherSide = firstSide === 'p' ? 's' : 'p';
    const firstNow = wantedOnSide(st, firstSide);
    const otherNow = wantedOnSide(st, otherSide);
    let addsOther = false;
    for (const o of outs) {
      if (o.key === 'ruined' || o.F === -2) {
        continue;
      }
      if (wantedOnSide(o.st, firstSide) > firstNow) {
        return false;
      }
      if (wantedOnSide(o.st, otherSide) > otherNow) {
        addsOther = true;
      }
    }
    return addsOther;
  }

  // A side order as a plan of its own: the first side's steps, then finishing the other side.
  function sideOrderPlan(order) {
    const firstName = SIDE_NAME[order.first];
    const otherName = SIDE_NAME[order.first === 'p' ? 's' : 'p'];
    const notes = [];
    if (order.fracturedOther) {
      notes.push(`Fracture a wanted ${otherName} first: it can never be lost, so the ${firstName}es can then be worked on without risking it.`);
    }
    notes.push(`Done side by side: every wanted ${firstName} first, each step chosen only for the ${firstName}es (a wanted ${otherName} that lands meanwhile is a bonus, not aimed for; a fractured one is kept for good), then the ${otherName}es with the cheapest strategy from wherever the item is. The cost counts what the ${firstName} steps do to the ${otherName}es.`);
    if (order.firstSideCost != null) {
      notes.push(`The ${firstName}es cost about ${fmtC(order.firstSideCost)} of it, finishing the ${otherName}es the rest.`);
    }
    const name = order.first === 'p' ? 'Prefixes first, then suffixes' : 'Suffixes first, then prefixes';
    return { key: SIDE_WAY[order.first], name, ok: true, cost: order.total, steps: order.steps, notes };
  }

  // A state's key with the other side's wanted mods counted as junk, except a fractured one (it
  // can't be lost, so it stays wanted). Keys are enc(F, st, jp, js), plus "~a<n>" for Allflame crafts.
  function keyWithOtherSideAsJunk(nodeKey, firstSide) {
    const [plainKey, allflameCount] = nodeKey.split('~');
    const [fracturedText, statusText, junkText] = plainKey.split('|');
    const fractured = Number(fracturedText);
    const status = statusText.split('').map(Number);
    let prefixJunk = Number(junkText[0]);
    let suffixJunk = Number(junkText[1]);
    for (let k = 0; k < status.length; k++) {
      const onOtherSide = T[k].side !== firstSide;
      if (status[k] === 1 && onOtherSide && fractured !== k) {
        status[k] = 0;
        if (T[k].side === 'p') {
          prefixJunk++;
        } else {
          suffixJunk++;
        }
      }
    }
    let key = enc(fractured, status, prefixJunk, suffixJunk);
    if (allflameCount) {
      key += '~' + allflameCount;
    }
    return key;
  }

  // Whether a side order's traced steps go through a fractured wanted mod of the other side
  // (read from the steps' states, before their links into the solve are dropped).
  function fracturesOtherSide(steps, firstSide) {
    for (const step of steps) {
      const state = step.simKey;
      if (!state || !state.st || !(state.F >= 0)) {
        continue;
      }
      if (T[state.F].side !== firstSide) {
        return true;
      }
    }
    return false;
  }

  // Side by side: most deterministic crafts finish one side (prefixes or suffixes), then the other,
  // often after fracturing a wanted mod of the other side so the first side can be worked on with a
  // lock ("Prefixes Cannot Be Changed") and nothing on the other side matters until later.
  // For each order, a solve whose goal is the first side complete. Its strategy picks each step only
  // for the first side, as a crafter doing that side does: an end of the phase is worth what the
  // best strategy pays to finish from it with the other side's wanted mods counted as junk, except a
  // fractured one (keyWithOtherSideAsJunk). So a wanted mod of the other side that lands by luck is
  // a bonus it doesn't aim for, but fracturing one is worth aiming for. No move that only aims at
  // the other side is allowed (onlyAimsAtOtherSide). The same strategy is then priced twice: with
  // every end free (what the first side alone costs) and with each end at what finishing really
  // costs from it (the cost of "this side first, then finish", luck and knocked-off mods included).
  // (An end the best solve never reached has no price, so it doesn't end the phase: the phase goes
  // on from it. Seeding those into the best solve grew it by about two thirds for at most 0.06% here.)
  // (spec.sideOrder / spec.sidePlans: asked for, it's two more solves.)
  function planSideOrders(firstSides) {
    const orders = [];
    for (const firstSide of firstSides) {
      const firstTargets = targetsOnSideList(firstSide);
      if (!firstTargets.length || firstTargets.length === K) {
        continue;
      }
      // What finishing from a phase end really costs (Infinity: the best solve never got there).
      const realFinishValue = nodeKey => {
        const finishNode = bestSol.states.get(nodeKey);
        if (!finishNode) {
          return Infinity;
        }
        return finishNode.done ? 0 : finishNode.V;
      };
      const phaseGoal = {
        reached: st => firstTargets.every(k => st[k] === 1),
        allows: (st, outs) => !onlyAimsAtOtherSide(firstSide, st, outs),
        // While choosing the strategy: finishing with the other side's unfractured wanted mods as
        // junk. (If the best solve never saw that state, the real value: rare, none on the test wands.)
        finishValue: nodeKey => {
          const realValue = realFinishValue(nodeKey);
          if (!isFinite(realValue)) {
            return Infinity;
          }
          const valueWithoutLuck = realFinishValue(keyWithOtherSideAsJunk(nodeKey, firstSide));
          if (!isFinite(valueWithoutLuck)) {
            return realValue;
          }
          return valueWithoutLuck;
        },
      };
      onProgress(`${SIDE_NAME[firstSide]}es first`);
      restrict = null;
      const sol = solve(null, `${SIDE_NAME[firstSide]}es first`, bestSol, phaseGoal);
      let total = Infinity;
      let steps = [];
      let firstSideCost = null;
      let fracturedOther = false;
      if (isFinite(sol.startV)) {
        // (Traced before the pricing below changes the solve's values: the steps read as the
        // strategy was chosen.)
        steps = trace(sol);
        fracturedOther = fracturesOtherSide(steps, firstSide);
        for (const step of steps) {
          delete step.simKey; // (a link into the solve: it can't leave the worker)
          // (A step's value here isn't the craft's, so "this step ≈" would mislead.)
          delete step.cost;
          delete step.rem;
        }
        firstSideCost = phaseCostWithEnds(sol, () => 0);
        const withRealEnds = phaseCostWithEnds(sol, n => realFinishValue(n.key));
        if (withRealEnds != null && isFinite(withRealEnds)) {
          total = withRealEnds + extraTotal + benchCostTotal;
          // A side order can't beat the best mix; when it plays the same strategy, rounding can put it
          // a hair below, and it would be listed first.
          const bestMixTotal = bestSol.startV + extraTotal + benchCostTotal;
          if (total < bestMixTotal) {
            total = bestMixTotal;
          }
        }
      }
      if (isFinite(total)) {
        const otherSide = firstSide === 'p' ? 's' : 'p';
        const restCost = firstSideCost != null ? ` (about ${fmtC(total - firstSideCost)} on average, bench crafts and swaps included)` : '';
        steps.push({ text: `Once every wanted ${SIDE_NAME[firstSide]} is on the item, finish the ${SIDE_NAME[otherSide]}es with the cheapest strategy from wherever the item is${restCost}. "Craft from my item" plans that part step by step.`, p: 1, how: 'Other side' });
      }
      orders.push({ first: firstSide, total, firstSideCost, fracturedOther, steps });
    }
    return orders;
  }
  if (sideOrderFirsts.length && bestSol) {
    const bestMixTotal = bestSol.startV + extraTotal + benchCostTotal;
    const orders = planSideOrders(sideOrderFirsts);
    if (spec.sideOrder) {
      results.push({ key: 'sides', name: 'Side order', hidden: true, ok: false, cost: Infinity, steps: [], notes: [], sides: { bestMix: bestMixTotal, orders } });
    }
    for (const order of orders) {
      if (spec.sidePlans && isFinite(order.total)) {
        results.push(sideOrderPlan(order));
      }
    }
    streamNewPlans();
  }
  if (bestSol && !ctx.bestOnly && !ctx.sub && !presetF) {
    const rows = waysToStart();
    if (rows.length) {
      results.push({ key: 'compare', name: 'Ways to start', hidden: true, ok: false, cost: Infinity, steps: [], notes: [], compare: rows.filter(r => isFinite(r.R)) });
      streamNewPlans();
    }
  }

  // Fossil lab (Craft of Exile's fossil calculator, priced by the economy): every combination
  // tried, its chance per wanted mod and for all of them in one reforge, cost and clicks per try
  // and per full hit, and the whole craft when it opens with that combination (best play after,
  // at today's prices). The best of each size by both measures.
  function fossilLab() {
    const labTargets = T.map((t, k) => k).filter(k => T[k].kind === 'roll' && k !== fixedF);
    const rows = fossilScored.map(x => {
      const clicks = x.combo.length + 1 + (opt.ruthless ? 1 : 0); // each fossil socketed, the resonator (and a Scour)
      const chancePerTarget = labTargets.map(k => {
        let chance = 0;
        for (const o of x.outs) {
          chance = chance + (o.st[k] === 1 ? o.p : 0);
        }
        return chance;
      });
      let allAtOnce = 0;
      for (const o of x.outs) {
        allAtOnce = allAtOnce + (labTargets.every(k => o.st[k] === 1) ? o.p : 0);
      }
      const stopping = stopValue(x.cost, x.outs.map(o => ({ p: o.p, A: bestValueOfKey(o.key) })));
      return {
        fossils: x.combo.map(f => f.name),
        resonator: resName(x.combo.length),
        size: x.combo.length,
        cost: x.cost,
        clicks,
        pK: chancePerTarget,
        pAll: allAtOnce,
        perHit: allAtOnce > 0 ? x.cost / allAtOnce : Infinity,
        clicksPerHit: allAtOnce > 0 ? clicks / allAtOnce : Infinity,
        R: stopping.R + extraTotal + benchCostTotal,
        stop: stopping.stop,
      };
    });
    const bestBy = (field, size) => rows.filter(r => r.size === size && isFinite(r[field])).sort((a, b) => a[field] - b[field])[0] ?? null;
    const best = [1, 2, 3, 4].map(size => ({ size, whole: bestBy('R', size), perHit: bestBy('perHit', size), clicks: bestBy('clicksPerHit', size) })).filter(b => b.whole || b.perHit);
    const shown = new Set([...rows].sort((a, b) => a.R - b.R).slice(0, 25));
    for (const b of best) {
      for (const r of [b.whole, b.perHit, b.clicks]) {
        if (r) {
          shown.add(r);
        }
      }
    }
    for (const r of [...rows].filter(r => isFinite(r.perHit)).sort((a, b) => a.perHit - b.perHit).slice(0, 10)) {
      shown.add(r);
    }
    return { targets: labTargets.map(label), rows: [...shown].sort((a, b) => a.R - b.R), best, tried: rows.length, ruthless: !!opt.ruthless };
  }
  if (phase === 'fossil' && bestSol && fossilScored.length && !ctx.bestOnly && !ctx.sub) {
    results.push({ key: 'fossillab', name: 'Fossil lab', hidden: true, ok: false, cost: Infinity, steps: [], notes: [], lab: fossilLab() });
  }

  // The bench-craft step at the end of a plan (no multimod mention).
  const benchStepShort = () => {
    if (!benchT.length) {
      return [];
    }
    return [{ text: `Bench-craft ${benchT.map(t => `"${modText(t.m, t.minTier)}"`).join(' and ')}.`, p: 1, cost: benchCostTotal, how: 'Crafting bench' }];
  };

  // From your own item: the best strategy from its state, next to the plans from a new base.
  function fromYourItem() {
    const pastedNodes = bestSol.pasted;
    // (Influence is already on your item. A resistance it has in the right element needs no
    // swap, one in another element needs it for sure.)
    const pasteSwaps = swaps.map(swap => {
      const k = T.indexOf(swap.t);
      let share = swap.share;
      if (paste.exact.has(k)) {
        share = 0;
      } else if (paste.swapped.has(k)) {
        share = 1;
      }
      return { ...swap, share };
    });
    const valueOfNode = n => (n.done ? 0 : n.V);
    let bench = [];
    if (benchT.length) {
      const multimod = benchT.length > 1 ? '"Can have up to 3 Crafted Modifiers", then ' : '';
      bench = [{ text: `Bench-craft ${multimod}${benchT.map(t => `"${modText(t.m, t.minTier)}"`).join(' and ')}.`, p: 1, cost: benchCostTotal, how: 'Crafting bench' }];
    }
    const intro = n => {
      const removeCrafted = spec.start.crafted ? ' (remove its crafted mods at the bench first; that\'s free)' : '';
      return { text: `Start from your item${removeCrafted}: it ${stateText(n)}.`, p: 1, cost: 0, rem: n.done ? 0 : n.V, how: 'Your item', ex: exampleItem(n) };
    };
    let cost;
    let steps;
    if (pastedNodes.n) {
      cost = valueOfNode(pastedNodes.n);
      if (pastedNodes.n.done) {
        steps = [intro(pastedNodes.n), ...finalSteps(pasteSwaps), ...bench];
      } else {
        steps = trace(bestSol, { node: pastedNodes.n, pre: [intro(pastedNodes.n)], paste: true, swaps: pasteSwaps });
      }
    } else {
      let afterRegal = 0;
      for (const o of pastedNodes.regal) {
        afterRegal = afterRegal + o.p * valueOfNode(o.n);
      }
      cost = P(CUR.regal) + afterRegal;
      const next = pastedNodes.regal.filter(o => isFinite(valueOfNode(o.n))).sort((a, b) => b.p - a.p)[0]?.n;
      const wantedOnIt = paste.st.map((x, k) => (x === 1 ? label(k) : null)).filter(Boolean);
      const hasText = paste.st.some(x => x === 1) ? ` (it has ${wantedOnIt.join(' and ')})` : '';
      const magicIntro = { text: `Start from your magic item${hasText}.`, p: 1, cost: 0, how: 'Your item' };
      const regal = { text: `Regal Orb: it adds one mod and makes the item rare.`, p: 1, cost: P(CUR.regal), rem: cost, how: 'Regal', ex: next ? exampleItem(next) : null };
      if (!next) {
        steps = [];
      } else if (next.done) {
        steps = [magicIntro, regal, ...finalSteps(pasteSwaps), ...bench];
      } else {
        steps = trace(bestSol, { node: next, pre: [magicIntro, regal], paste: true, swaps: pasteSwaps });
      }
    }
    let extra = 0;
    for (const swap of pasteSwaps) {
      extra = extra + (isFinite(swap.cost) ? swap.share * swap.cost : 0);
    }
    extra = extra + eldTargetCost;
    const freshBest = Math.min(...results.filter(r => r.ok && !r.fromItem).map(r => r.cost));
    const total = cost + extra + benchCostTotal;
    if (!isFinite(cost)) {
      return { key: 'paste', name: 'From your item', fromItem: true, ok: false, cost: Infinity, steps: [], notes: [], why: 'No modelled method gets from your item to every ticked mod; a new base works better (see the other plans).' };
    }
    let notes = [];
    if (pastedNodes.n?.done) {
      notes = ['Your item already has every picked mod' + (total > 0 ? '; what\'s left is the bench crafts and swaps.' : '.')];
    } else if (total > freshBest + 1e-6) {
      notes = [`Starting over on a new base is cheaper (about ${fmtC(freshBest)} against ${fmtC(total)}): your item isn't worth building on for these mods.`];
    }
    return { key: 'paste', name: 'From your item', fromItem: true, ok: true, cost: total, steps, pasteSim: { sol: bestSol, from: { ...pastedNodes, swaps: pasteSwaps } }, notes };
  }
  if (paste?.why) {
    results.push({ key: 'paste', name: 'From your item', fromItem: true, ok: false, cost: Infinity, steps: [], notes: [], why: paste.why });
  } else if (paste && bestSol?.pasted && !ctx.bestOnly) {
    results.push(fromYourItem());
  }

  // Why nothing was found, when nothing was.
  function noWayReason() {
    const essenceOnly = T.filter(t => t.kind === 'essence');
    const names = essenceOnly.map(t => `"${t.m.text}"`);
    if (essenceOnly.length > 2) {
      return `${names.join(', ')} only come from essences. An essence forces one mod, and only one other can be kept (fractured), so at most two of them fit. Untick one.`;
    }
    if (essenceOnly.length === 2 && infl.length) {
      return `${names.join(' and ')} only come from essences. Getting both needs the first one fractured, and influenced items can't be fractured. Untick one, or remove the influence.`;
    }
    if (essenceOnly.length === 2) {
      const fractureNote = isFinite(P(FRACTURE))
        ? '; that route found no way here (check the item level and that both essences have prices)'
        : `, but there's no price for the ${FRACTURE}`;
      return `${names.join(' and ')} only come from essences. The way to get both is to fracture the first essence's mod and then use the second essence${fractureNote}.`;
    }
    const unpricedNames = new Set();
    for (const t of essenceOnly) {
      for (const essenceMod of essenceModsFor(B, t)) {
        for (let tier = 0; tier < essenceMod.tiers.length; tier++) {
          unpricedNames.add(essenceName(essenceMod, tier, index.essenceLevels));
        }
      }
    }
    let unpriced = [...unpricedNames].filter(n => !isFinite(P(n)));
    const allPriced = essenceOnly.every(t => essences.some(e => e.k === T.indexOf(t)));
    if (allPriced) {
      unpriced = [];
    }
    if (unpriced.length) {
      const verb = unpriced.length > 1 ? 'have' : 'has';
      const comesFrom = essenceOnly.length > 1 ? 'those mods only come' : 'that mod only comes';
      return `${unpriced.join(', ')} ${verb} no price this hour, and ${comesFrom} from essences. Type a price under "Prices used".`;
    }
    return 'None of the modelled methods can reach every ticked mod (for example a mod only a special currency adds).';
  }
  if (!results.length) {
    results.push({ key: 'none', name: 'No way found', ok: false, cost: Infinity, steps: [], notes: [], why: noWayReason() });
  }

  const recombinatorName = () => `Recombinator bench (${B.info.recomb.toLowerCase()}, unpredictable mode; ${fmtN(opt.recombDust)} ${DUST} + ${fmtN(opt.recombGold)} gold a use)`;

  // Simulates making one clean Alteration item (for the currency count): Alterations until it
  // shows, then the Regal (with an imprint, or alterating again after a bad Regal).
  const simulateCleanItem = input => (spend, rnd) => {
    const alterate = () => {
      spend(billOf(CUR.transmute));
      spend(combineBills(billOf(CUR.alt), input.augPer ? billOf(CUR.aug, input.augPer) : null), triesUntilSuccess(rnd, input.pAlt));
    };
    alterate();
    if (input.rest < 0) {
      return;
    }
    if (input.useImp) {
      spend(billOf(CUR.imprint));
      const regals = triesUntilSuccess(rnd, input.pr);
      spend(billOf(CUR.regal), regals);
      spend(billOf(CUR.imprint), regals - 1);
      return;
    }
    for (;;) {
      spend(billOf(CUR.regal));
      if (rnd() < input.pr) {
        break;
      }
      alterate();
    }
  };

  // An opening that makes two inputs and recombines them until a result in `kept` (whose
  // chances add up to keepChance) is worth keeping; returns that result's node.
  const recombineOpening = (label, makeA, makeB, keepChance, kept) => ({
    infl: true,
    label,
    enter: (spend, rnd) => {
      for (;;) {
        makeA(spend, rnd);
        makeB(spend, rnd);
        spend(recBill);
        let x = rnd();
        if (x >= keepChance) {
          continue; // nothing worth keeping
        }
        for (const o of kept) {
          x -= o.p;
          if (x < 0) {
            return o.done ? { done: true } : o.n;
          }
        }
        const last = kept[kept.length - 1];
        return last.done ? { done: true } : last.n;
      }
    },
  });

  // Recombinator (Settlers): craft two clean items that each carry part of the
  // targets (Alteration/Augment, plus one Regal mod), recombine, then finish with
  // the best strategy from wherever the recombined item lands.
  // (Its two halves are alteration-spammed, so "no alteration spam" leaves it out.)
  function bestCleanRecombine() {
    let best = null;
    const n = rolledTargetIndexes.length;
    for (let mask = 1; mask < 1 << n; mask++) {
      const S = rolledTargetIndexes.filter((k, i) => mask & (1 << i));
      if (S.length < 2) {
        continue;
      }
      const prefixCount = S.filter(k => T[k].side === 'p').length;
      const suffixCount = S.length - prefixCount;
      if (prefixCount > 3 || suffixCount > 3) {
        continue;
      }
      const allSurvive = (prefixCount ? RECOMB_COUNTS[prefixCount][prefixCount] : 1) * (suffixCount ? RECOMB_COUNTS[suffixCount][suffixCount] : 1);
      const st = new Array(K).fill(0);
      for (const k of S) {
        st[k] = 1;
      }
      const nodeAfter = bestSol.states.get(enc(-1, st, 0, 0));
      let after;
      if (isDone(st, 0, 0)) {
        after = 0;
      } else if (nodeAfter && isFinite(nodeAfter.V)) {
        after = nodeAfter.V;
      } else {
        after = Infinity;
      }
      if (!isFinite(after)) {
        continue;
      }
      // Every result: how many of each side survive (the pool table), which ones (at random), and
      // what that item is worth to the strategy. A partial result (one wanted mod lost) is a clean
      // rare with the rest: keep it when finishing it beats two new items.
      const recombined = recombStates(S).map(o => {
        const isFinished = isDone(o.st, 0, 0);
        const resultNode = isFinished ? null : bestSol.states.get(enc(-1, o.st, 0, 0));
        let A;
        if (isFinished) {
          A = 0;
        } else if (o.st.some(x => x === 1) && resultNode && isFinite(resultNode.V)) {
          A = resultNode.V;
        } else {
          A = Infinity;
        }
        return { p: o.p, A, n: resultNode, done: isFinished, full: o.full, st: o.st };
      });
      for (let split = 1; split < (1 << S.length) - 1; split++) {
        const inA = S.filter((k, i) => split & (1 << i));
        const inB = S.filter((k, i) => !(split & (1 << i)));
        if (inA.length > 3 || inB.length > 3 || inA[0] > inB[0]) {
          continue;
        }
        const itemA = itemCost(inA);
        const itemB = itemCost(inB);
        if (!itemA || !itemB) {
          continue;
        }
        // Repeat (two new items each time) until a result worth keeping: optimal stopping.
        const stopping = stopValue(itemA.cost + itemB.cost + recCost, recombined);
        if (!isFinite(stopping.R)) {
          continue;
        }
        const total = stopping.R;
        if (!best || total < best.total) {
          const kept = recombined.filter(o => o.A < stopping.R - 1e-9);
          let partialChance = 0;
          for (const o of kept) {
            if (!o.full) {
              partialChance = partialChance + o.p;
            }
          }
          best = { total, c: total - after, ia: itemA, ib: itemB, A: inA, Bk: inB, S, pRec: allSurvive, pPart: partialChance, kept, stop: stopping.stop, np: prefixCount, ns: suffixCount, node: nodeAfter, after, done: isDone(st, 0, 0) };
        }
      }
    }
    return best;
  }

  function cleanRecombineResult(best) {
    const regalNote = input => (input.rest >= 0 ? ', then a Regal' : '');
    let recombineFlow = null;
    if (best.pRec < 1 - 1e-4) {
      recombineFlow = [{ kind: 'on', p: best.pRec }];
      if (best.pPart > 1e-4) {
        recombineFlow.push({ kind: 'else', p: best.pPart, note: 'a wanted mod is lost, the rest kept', next: 'the plan finishes that item' });
      }
      if (best.stop < 1 - 1e-4) {
        recombineFlow.push({ kind: 'back', p: 1 - best.stop, to: inflSteps.length, note: 'too little survives: two new items' });
      }
    }
    const partialNote = best.pPart > 1e-4 ? `; ${pctText(best.pPart)} of the time some are lost but the rest is worth finishing` : '';
    const retryNote = best.stop < 1 - 1e-4 ? '; otherwise make two new items' : '';
    const pre = [
      // (The recipe card above the steps spells out each item; the steps stay short.)
      { text: `Make Item A (see the card): ${best.A.map(label).join(' + ')}, ${pctText(best.ia.pAlt)} per Alteration${regalNote(best.ia)}.`, p: best.ia.pAlt, cost: best.ia.cost, own: 0, how: 'Alteration', flow: halfFlow(best.ia) },
      { text: `Make Item B (see the card): ${best.Bk.map(label).join(' + ')}, ${pctText(best.ib.pAlt)} per Alteration${regalNote(best.ib)}.`, p: best.ib.pAlt, cost: best.ib.cost, own: 0, how: 'Alteration', flow: halfFlow(best.ib) },
      {
        text: `${recombinatorName()}: put in Items A and B (both are used up). All ${best.S.length} mods survive ${pctText(best.pRec)} of the time${partialNote}${retryNote}.`,
        p: best.pRec,
        cost: best.c,
        how: 'Recombinator',
        bill: recBill,
        flow: recombineFlow,
      },
    ];
    let steps;
    if (best.done) {
      steps = [...inflSteps, ...pre, ...finalSteps(), ...benchStepShort()];
    } else {
      steps = trace(bestSol, { node: best.node, pre: [...inflSteps, ...pre] });
    }
    // The currency count: both items (with their retries) and the Recombinator, then the strategy.
    const opening = recombineOpening('Two clean items, recombined', simulateCleanItem(best.ia), simulateCleanItem(best.ib), best.stop, best.kept);
    // The same plan as a recipe card: what each input item needs, the bench, and what comes out.
    const outs = best.kept.map(o => ({
      p: o.p,
      mods: best.S.filter(k => o.st[k] === 1).map(label),
      lost: best.S.filter(k => o.st[k] !== 1).map(label),
      done: o.done,
      full: o.full,
    })).sort((a, b) => b.full - a.full || b.p - a.p);
    const recipe = {
      halves: [recHalf(best.A, best.ia), recHalf(best.Bk, best.ib)],
      benchCost: recCost,
      outs,
      retry: 1 - best.stop,
      rounds: 1 / best.stop,
      finishAt: best.done ? null : inflSteps.length + pre.length + 1,
      setupSteps: inflSteps.length,
    };
    const startOuts = best.kept.map(o => ({ p: o.p, n: o.done ? { done: true, key: 'done', st: o.st, F: -1, jp: 0, js: 0 } : o.n }));
    return {
      key: 'recomb',
      name: 'Recombinator',
      ok: true,
      opening,
      recipe,
      startOuts,
      cost: best.total + benchCostTotal + extraTotal,
      steps,
      notes: ['Survival odds by pool size are the community-measured table for unpredictable mode (predictable mode\'s odds aren\'t published); both inputs are clean (only wanted mods), so everything that survives is wanted.'],
    };
  }
  if (recOn && bestSol && !ctx.bestOnly) {
    const best = bestCleanRecombine();
    if (best) {
      results.push(cleanRecombineResult(best));
      streamNewPlans();
    }
  }

  // Fossils + Recombinator: two input items that each carry several wanted mods (rolled with
  // fossils until they have them, or a clean alteration item), recombined into one with 4-5.
  // Everything on the inputs goes into the pool: their junk too, and a wanted mod on both items
  // counts twice (only one copy can stay), which raises its chance to survive. The survivors per
  // side follow the same table as above; each survivor is drawn from what's left in the pool.
  // Each input is an exact spread of items (which wanted mods beyond the ones it was rolled for,
  // how much junk on each side), so a lucky extra mod counts as wanted, not as junk.
  function fossilRecombinePlan() {
    const RK = rolledTargetIndexes;
    const bitOf = k => 1 << RK.indexOf(k);
    const targetsInMask = mask => RK.filter(k => mask & bitOf(k));
    const bitCount = x => {
      let n = 0;
      for (; x; x &= x - 1) {
        n++;
      }
      return n;
    };
    // The cheapest way to make an input that carries (at least) a given set of wanted mods.
    const inputs = new Map(); // mask -> {mask, how, cost, outs, combo?, p?, ic?}
    const offerInput = input => {
      const existing = inputs.get(input.mask);
      if (!existing || input.cost < existing.cost) {
        inputs.set(input.mask, input);
      }
    };
    for (const x of fossilScored) {
      const bySet = new Map(); // set it must carry -> {p, outs: Map(mask|jp|js -> p)}
      for (const o of x.outs) {
        if (o.st.some(v => v === 2)) {
          continue; // a wrong tier of a wanted mod: not a usable input
        }
        let has = 0;
        for (const k of RK) {
          if (o.st[k] === 1) {
            has = has | bitOf(k);
          }
        }
        for (let subset = has; subset; subset = (subset - 1) & has) {
          const entry = bySet.get(subset) ?? { p: 0, outs: new Map() };
          const outKey = has + '|' + o.jp + '|' + o.js;
          entry.p += o.p;
          entry.outs.set(outKey, (entry.outs.get(outKey) ?? 0) + o.p);
          bySet.set(subset, entry);
        }
      }
      for (const [mask, entry] of bySet) {
        if (entry.p < 1e-9) {
          continue;
        }
        // (Results under 0.1% of the hits are left out; the rest scaled up to 1.)
        let outs = [...entry.outs].map(([outKey, p]) => {
          const [m, jp, js] = outKey.split('|').map(Number);
          return { mask: m, jp, js, p: p / entry.p };
        }).filter(o => o.p >= 1e-3);
        let kept = 0;
        for (const o of outs) {
          kept = kept + o.p;
        }
        outs = outs.map(o => ({ ...o, p: o.p / kept }));
        offerInput({ mask, how: 'fossil', combo: x.combo, p: entry.p, cost: x.cost / entry.p, outs });
      }
    }
    for (let mask = 1; mask < 1 << RK.length; mask++) {
      if (bitCount(mask) > 3) {
        continue;
      }
      const clean = itemCost(targetsInMask(mask));
      if (clean) {
        offerInput({ mask, how: 'alt', ic: clean, cost: clean.cost, outs: [{ mask, jp: 0, js: 0, p: 1 }] });
      }
    }

    // One side of a recombine: copies of each wanted mod and junk in the pool -> [{mask, j, p}].
    const sideMemo = new Map();
    const sideOutcomes = (copies, junk, cap) => {
      const memoKey = copies.map(([k, c]) => k + 'x' + c).join(',') + '|' + junk + '|' + cap;
      if (sideMemo.has(memoKey)) {
        return sideMemo.get(memoKey);
      }
      let poolTotal = 0;
      for (const [, c] of copies) {
        poolTotal = poolTotal + c;
      }
      poolTotal = poolTotal + junk;
      const results = new Map();
      for (const [countText, chanceOfCount] of Object.entries(poolTotal ? RECOMB_COUNTS[Math.min(8, poolTotal)] : { 0: 1 })) {
        const keepCount = Math.min(+countText, cap);
        const draw = (picked, junkKept, junkLeft, chance) => {
          let weight = junkLeft;
          for (const [k, c] of copies) {
            if (!(picked & bitOf(k))) {
              weight += c;
            }
          }
          if (bitCount(picked) + junkKept >= keepCount || weight === 0) {
            const resultKey = picked + '|' + junkKept;
            results.set(resultKey, (results.get(resultKey) ?? 0) + chance);
            return;
          }
          for (const [k, c] of copies) {
            if (!(picked & bitOf(k))) {
              draw(picked | bitOf(k), junkKept, junkLeft, chance * c / weight);
            }
          }
          if (junkLeft) {
            draw(picked, junkKept + 1, junkLeft - 1, chance * junkLeft / weight);
          }
        };
        draw(0, 0, junk, chanceOfCount);
      }
      const outcomes = [...results].map(([resultKey, p]) => {
        const [m, j] = resultKey.split('|').map(Number);
        return { mask: m, j, p };
      });
      sideMemo.set(memoKey, outcomes);
      return outcomes;
    };
    const sideOf = (maskA, maskB, junk, side) => {
      const copies = [];
      for (const k of RK) {
        if (T[k].side !== side) {
          continue;
        }
        const c = ((maskA & bitOf(k)) ? 1 : 0) + ((maskB & bitOf(k)) ? 1 : 0);
        if (c) {
          copies.push([k, c]);
        }
      }
      return sideOutcomes(copies, junk, max[side]);
    };

    // Every item a recombine can make (a set of wanted mods plus junk on each side) gets its own
    // cost to finish: solve again with those states seeded, warm-started from the best strategy.
    const stateOfMask = mask => T.map((t, k) => (RK.includes(k) && mask & bitOf(k) ? 1 : 0));
    seedStates = [];
    for (let mask = 0; mask < 1 << RK.length; mask++) {
      const st = stateOfMask(mask);
      for (let jp = 0; jp <= max.p - sideCount(st, 'p'); jp++) {
        for (let js = 0; js <= max.s - sideCount(st, 's'); js++) {
          seedStates.push({ st, jp, js });
        }
      }
    }
    restrict = null;
    const solF = solveTimed('Fossils + Recombinator', null, bestSol);
    seedStates = [];
    const valueMemo = new Map();
    const valueOf = (mask, jp, js) => {
      const memoKey = mask + '|' + jp + '|' + js;
      let v = valueMemo.get(memoKey);
      if (!v) {
        const st = stateOfMask(mask);
        if (isDone(st, jp, js)) {
          v = { A: 0, done: true, n: { done: true, key: 'done', st, F: -1, jp, js } };
        } else {
          const n = solF.states.get(enc(-1, st, jp, js));
          v = n && isFinite(n.V) ? { A: n.V, n } : { A: Infinity };
        }
        valueMemo.set(memoKey, v);
      }
      return v;
    };

    // Cheapest inputs first; a pair is only worth pricing when together they carry 3+ wanted mods
    // (and when its two inputs and the bench alone cost less than the best pair so far).
    const list = [...inputs.values()].sort((a, b) => a.cost - b.cost).slice(0, 48);
    let best = null;
    for (let i = 0; i < list.length; i++) {
      for (let j = i; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (bitCount(a.mask | b.mask) < 3 || (a.how === 'alt' && b.how === 'alt')) {
          continue; // (two clean items: the plan above)
        }
        const costPerTry = a.cost + b.cost + recCost;
        if (best && costPerTry >= best.total) {
          continue;
        }
        const byResult = new Map();
        for (const outA of a.outs) {
          for (const outB of b.outs) {
            const pairChance = outA.p * outB.p;
            const prefixes = sideOf(outA.mask, outB.mask, outA.jp + outB.jp, 'p');
            const suffixes = sideOf(outA.mask, outB.mask, outA.js + outB.js, 's');
            for (const op of prefixes) {
              for (const os of suffixes) {
                const resultKey = (op.mask | os.mask) + '|' + op.j + '|' + os.j;
                byResult.set(resultKey, (byResult.get(resultKey) ?? 0) + pairChance * op.p * os.p);
              }
            }
          }
        }
        const outs = [...byResult].map(([resultKey, p]) => {
          const [m, jp, js] = resultKey.split('|').map(Number);
          return { p, mask: m, jp, js, ...valueOf(m, jp, js) };
        });
        const stopping = stopValue(costPerTry, outs);
        if (isFinite(stopping.R) && (!best || stopping.R < best.total)) {
          best = { total: stopping.R, c: costPerTry, a, b, outs, stop: stopping.stop, kept: outs.filter(o => o.A < stopping.R - 1e-9) };
        }
      }
    }
    return best ? { best, solF, targetsInMask, bitOf } : null;
  }

  function fossilRecombineResult({ best, solF, targetsInMask, bitOf }) {
    const { a, b } = best;
    const S = targetsInMask(a.mask | b.mask);
    const fossilName = x => `${x.combo.map(f => f.name).join(' + ')} in a ${resName(x.combo.length)}`;
    const makeStep = (x, name) => {
      if (x.how === 'fossil') {
        return {
          text: `Make Item ${name} (see the card): ${opt.ruthless ? 'Scour, then ' : ''}${fossilName(x)} until it has ${targetsInMask(x.mask).map(label).join(' + ')} (${pctText(x.p)} per try; other mods on it are fine).`,
          p: x.p,
          cost: x.cost,
          own: 0,
          how: 'Fossils',
        };
      }
      return {
        text: `Make Item ${name} (see the card): ${targetsInMask(x.mask).map(label).join(' + ')}, ${pctText(x.ic.pAlt)} per Alteration${x.ic.rest >= 0 ? ', then a Regal' : ''}.`,
        p: x.ic.pAlt,
        cost: x.cost,
        own: 0,
        how: 'Alteration',
        flow: halfFlow(x.ic),
      };
    };
    let keptChance = 0;
    let fullChance = 0;
    let afterSum = 0;
    for (const o of best.kept) {
      keptChance = keptChance + o.p;
    }
    for (const o of best.kept) {
      if (S.every(k => o.mask & bitOf(k))) {
        fullChance = fullChance + o.p;
      }
    }
    for (const o of best.kept) {
      afterSum = afterSum + o.p * o.A;
    }
    const afterAverage = afterSum / Math.max(1e-12, keptChance);
    const retryNote = best.stop < 1 - 1e-4 ? '; otherwise make both items again' : '';
    const pre = [
      makeStep(a, 'A'),
      makeStep(b, 'B'),
      {
        text: `${recombinatorName()}: put in Items A and B (both are used up). All ${S.length} wanted mods survive ${pctText(fullChance)} of the time; ${pctText(keptChance)} of the time the result is worth finishing${retryNote}.`,
        p: keptChance,
        cost: best.total - afterAverage,
        how: 'Recombinator',
        bill: recBill,
        flow: best.stop < 1 - 1e-4 ? [{ kind: 'on', p: keptChance }, { kind: 'back', p: 1 - keptChance, to: inflSteps.length, note: 'too little survives: two new items' }] : null,
      },
    ];
    const likeliest = [...best.kept].sort((x, y) => y.p - x.p)[0];
    const steps = trace(solF, { node: likeliest.n, pre: [...inflSteps, ...pre] });
    // Simulation: both inputs (with their retries) and the recombine, until a result worth keeping.
    const simulateFossilItem = x => (spend, rnd) => {
      const bill = combineBills(...x.combo.map(f => billOf(f.name)), billOf(resName(x.combo.length)), resetBill());
      spend(bill, triesUntilSuccess(rnd, x.p));
    };
    const simulateInput = x => (x.how === 'fossil' ? simulateFossilItem(x) : simulateCleanItem(x.ic));
    const opening = recombineOpening('Two items with several mods each, recombined', simulateInput(a), simulateInput(b), keptChance, best.kept);
    // Recipe card: the two inputs, the bench, what comes out (grouped by the wanted mods kept).
    const bonusChance = x => {
      if (x.how !== 'fossil') {
        return 0;
      }
      let total = 0;
      for (const o of x.outs) {
        if (o.mask !== x.mask) {
          total = total + o.p;
        }
      }
      return total;
    };
    const averageJunk = x => {
      let total = 0;
      for (const o of x.outs) {
        total = total + o.p * (o.jp + o.js);
      }
      return total;
    };
    const half = x => {
      if (x.how !== 'fossil') {
        return recHalf(targetsInMask(x.mask), x.ic);
      }
      return {
        mods: targetsInMask(x.mask).map(k => ({ text: label(k), side: T[k].side })),
        fossil: { names: x.combo.map(f => f.name), resonator: resName(x.combo.length), p: x.p, scour: !!opt.ruthless, bonus: bonusChance(x), junk: averageJunk(x) },
        cost: x.cost,
      };
    };
    const byMods = new Map();
    for (const o of best.kept) {
      const group = byMods.get(o.mask) ?? { p: 0, mask: o.mask, done: false };
      group.p += o.p;
      group.done ||= o.done;
      byMods.set(o.mask, group);
    }
    const outs = [...byMods.values()].map(group => ({
      p: group.p,
      mods: targetsInMask(group.mask).map(label),
      lost: S.filter(k => !(group.mask & bitOf(k))).map(label),
      done: group.done,
      full: S.every(k => group.mask & bitOf(k)),
    })).sort((x, y) => y.full - x.full || y.p - x.p);
    const recipe = {
      halves: [half(a), half(b)],
      benchCost: recCost,
      outs,
      retry: 1 - keptChance,
      rounds: 1 / Math.max(1e-12, keptChance),
      finishAt: inflSteps.length + pre.length + 1,
      setupSteps: inflSteps.length,
    };
    return {
      key: 'fosrecomb',
      name: 'Fossils + Recombinator',
      ok: true,
      opening,
      recipe,
      startOuts: best.kept.map(o => ({ p: o.p, n: o.n })),
      startSol: solF,
      cost: best.total + benchCostTotal + extraTotal,
      steps,
      notes: ['Each input is rolled with fossils until it carries its set of mods (anything else on it goes into the recombine too: junk lowers the odds, a lucky extra wanted mod raises them); a mod on both inputs is twice as likely to survive. Survival counts by pool size are the community-measured table for unpredictable mode. Guides disagree on whether a duplicate mod counts twice in the pool; this plan assumes it does.'],
    };
  }
  if (recOn && bestSol && !ctx.bestOnly && !ctx.sub && fossilScored.length) {
    onProgress('Fossils + Recombinator');
    const found = fossilRecombinePlan();
    // Only worth showing when it isn't just the plain Recombinator (some input is rolled with fossils).
    if (found) {
      results.push(fossilRecombineResult(found));
      streamNewPlans();
    }
  }
  // The value of an outcome state for the best solve (0 when it finishes the item).
  const bestValueOfOutcome = o => (isDone(o.st, o.jp, o.js) ? 0 : bestSol.states.get(o.key)?.V ?? Infinity);
  const bestNodeOfOutcome = o => (isDone(o.st, o.jp, o.js) ? { done: true } : bestSol.states.get(o.key));

  // Influenced Exalted Orb (Crusader's, Hunter's, ...): craft the other mods on a plain item
  // with a slot left open, then exalt for an influenced one. A miss leaves an influenced item:
  // finish it with the influenced plan above when that's cheaper than starting over.
  function influencedExaltRoute(exaltName, influencedTargets) {
    const influencedIds = new Set(influencedTargets.map(k => T[k].m.id));
    const plainTargets = spec.targets.filter(t => !influencedIds.has(t.m.id));
    const open = { p: 0, s: 0 };
    for (const k of influencedTargets) {
      open[T[k].side]++;
    }
    let plainPlan = null;
    let plainCost = P(CUR.alch);
    if (plainTargets.some(t => !t.crafted)) {
      const plainSpec = { ...spec, infl: [], targets: plainTargets, options: { ...opt, influenceSetup: false } };
      const solved = planOnce(B, plainSpec, price, index, () => {}, null, { sub: true, reserve: open, noFracture: true, noEld: true });
      plainPlan = (solved.results ?? solved).filter(r => r.ok).sort((a, b) => a.cost - b.cost)[0] ?? null;
      plainCost = plainPlan ? plainPlan.cost - benchCostTotal : Infinity;
    }
    // The plain item when it's done: the other targets, and (at worst) junk in every slot but the open ones.
    const plainSt = T.map(t => (influencedIds.has(t.m.id) ? 0 : 1));
    const jp = Math.max(0, max.p - sideCount(plainSt, 'p') - reserve.p - open.p);
    const js = Math.max(0, max.s - sideCount(plainSt, 's') - reserve.s - open.s);
    const outcomes = rollOutcomes(itemFor(-1, plainSt, jp, js), influencedTargets.map(k => T[k]), [[1, 1]], { src: [infl[0]] });
    const outs = mapRoll(-1, plainSt, jp, js, influencedTargets, outcomes);
    let stopping = { R: Infinity };
    if (isFinite(plainCost) && outs.length) {
      stopping = stopValue(plainCost + P(exaltName), outs.map(o => ({ p: o.p, A: bestValueOfOutcome(o) })));
    }
    if (!isFinite(stopping.R)) {
      return null;
    }
    let hitChance = 0;
    for (const o of outs) {
      if (influencedTargets.some(k => o.st[k] === 1)) {
        hitChance = hitChance + o.p;
      }
    }
    const fixableChance = Math.max(0, stopping.stop - hitChance);
    const openSlots = ['p', 's'].filter(side => open[side]).map(side => `${open[side]} ${SIDE_NAME[side]}`).join(' and ');
    // The plain item's steps are paid for inside the Exalt step (a miss makes a new one), then
    // the influenced strategy carries on from the likeliest kept result.
    let plainSteps;
    if (plainPlan) {
      plainSteps = plainPlan.steps.filter(x => x.how !== 'Crafting bench');
    } else {
      plainSteps = [{ text: `Orb of Alchemy on a non-influenced ${B.name} (item level ${ilvl}+).`, p: 1, cost: P(CUR.alch), how: 'Alchemy' }];
    }
    plainSteps = plainSteps.map(x => ({ ...x, rem: undefined, own: 0 }));
    const outcomeNodes = outs.map(o => ({ p: o.p, A: bestValueOfOutcome(o), n: bestNodeOfOutcome(o) }));
    const kept = outcomeNodes.filter(o => o.A < stopping.R && o.n);
    const next = kept.sort((a, b) => b.p - a.p)[0]?.n;
    const perKept = (plainCost + P(exaltName)) / stopping.stop;
    let missText;
    if (fixableChance > 1e-4) {
      missText = ` On a miss the item is ${infl[0]}-influenced for good: ${pctText(fixableChance)} of the time it's still worth finishing with the influenced plan (Annul, Exalt, ...); otherwise start a new item.`;
    } else {
      missText = ` On a miss, start a new item (about ${fmtN(tries(hitChance))} items in all).`;
    }
    const exaltStep = {
      text: `Keep ${openSlots} slot open, then ${exaltName}: it adds ${infl[0]} influence and one ${infl[0]} mod, ${pctText(hitChance)} of the time ${influencedTargets.map(label).join(' or ')}.` + missText,
      p: stopping.stop,
      cost: perKept,
      own: perKept,
      how: 'Influenced Exalt',
      ex: next?.key ? exampleItem(next) : null,
      flow: stopping.stop < 1 - 1e-4 ? [{ kind: 'on', p: stopping.stop }, { kind: 'new', p: 1 - stopping.stop, note: 'not worth finishing', to: 0 }] : null,
    };
    let steps;
    if (!next || next.done) {
      steps = [...plainSteps, exaltStep, ...benchStepShort()];
    } else {
      steps = trace(bestSol, { node: next, pre: [...plainSteps, exaltStep], swaps: [] });
    }
    // The currency count: a plain item (a sampled run of its own plan) and the Exalt until one is kept.
    let plainRuns = null;
    const opening = {
      noSwaps: true,
      label: `Plain item, then ${exaltName}`,
      enter: (spend, rnd, pickOutcome) => {
        for (;;) {
          if (plainPlan?.makeUsage) {
            plainRuns ??= plainPlan.makeUsage().raw;
            spend(plainRuns[Math.floor(rnd() * plainRuns.length)]);
          } else {
            spend(billOf(CUR.alch));
          }
          spend(billOf(exaltName));
          const o = pickOutcome(outcomeNodes);
          if (o.A < stopping.R && o.n) {
            return o.n;
          }
        }
      },
    };
    const sideNote = SIDE_NAME[influencedTargets.length ? T[influencedTargets[0]].side : 'p'];
    return {
      key: 'iexalt',
      name: `${exaltName} at the end`,
      ok: true,
      opening,
      cost: stopping.R + benchCostTotal,
      steps,
      notes: [`The plain item's cost (${plainPlan ? plainPlan.name : 'Alchemy'}) is paid again for each new item. Its ${sideNote} side is assumed full apart from the open slot, which slightly undercounts how often an Exalt can fix a miss.`],
    };
  }
  const exaltName = infl.length === 1 ? influenceExalt(infl[0]) : null;
  const influencedTargets = T.map((t, k) => k).filter(k => T[k].kind === 'roll' && T[k].m.src === infl[0]);
  const influencedExaltApplies = exaltName && opt.influenceExalt && (!phase || phase === 'base') && !ctx.sub && !ctx.bestOnly && !presetF && bestSol;
  if (influencedExaltApplies && influencedTargets.length && isFinite(P(exaltName))) {
    onProgress(`${exaltName} route`);
    const route = influencedExaltRoute(exaltName, influencedTargets);
    if (route) {
      results.push(route);
      streamNewPlans();
    }
  }

  // Awakener's Orb (two influences): two items of the same class, each with exactly one
  // influenced mod (an influenced Exalted Orb on a plain rare gives that), merged: the result
  // keeps both influences and one influenced mod from each, and every other mod is rerolled.
  // From there the influenced plan above finishes the item (or you start over).
  function awakenerRoute() {
    const plainRare = newItem(B, { ilvl, infl: [], rarity: 'rare' });
    // One donor: a plain rare + that influence's Exalted Orb until it adds target k (or any mod if k < 0).
    const donor = (influence, k) => {
      const exaltPrice = P(influenceExalt(influence));
      if (k < 0) {
        return { cost: AWAKEN_DONOR, p: 1, text: `any cheap ${B.name} with ${influence} influence (about ${fmtC(AWAKEN_DONOR)}; its ${influence} mod is random)` };
      }
      const outcomes = rollOutcomes(plainRare, [T[k]], [[1, 1]], { src: [influence] });
      let hitChance = 0;
      for (const o of outcomes) {
        if (o.st[0] === 1) {
          hitChance = hitChance + o.p;
        }
      }
      if (!(hitChance > 0) || !isFinite(exaltPrice)) {
        return null;
      }
      return {
        cost: (P(CUR.alch) + exaltPrice) / hitChance,
        p: hitChance,
        text: `a plain rare ${B.name} (Orb of Alchemy) and ${influenceExalt(influence)} until it adds ${label(k)} (${pctText(hitChance)} per try; a miss means a new rare)`,
      };
    };
    const targetsByInfluence = infl.map(influence => T.map((t, k) => k).filter(k => T[k].kind === 'roll' && T[k].m.src === influence));
    let best = null;
    for (const a of [-1, ...targetsByInfluence[0]]) {
      for (const b of [-1, ...targetsByInfluence[1]]) {
        if (a < 0 && b < 0) {
          continue;
        }
        if (a >= 0 && b >= 0 && T[a].m.groups.some(g => T[b].m.groups.includes(g))) {
          continue;
        }
        const donorA = donor(infl[0], a);
        const donorB = donor(infl[1], b);
        if (!donorA || !donorB) {
          continue;
        }
        // The merged item: the kept influenced mods, then a reforge of the rest.
        const mergedSt = new Array(K).fill(0);
        for (const k of [a, b]) {
          if (k >= 0) {
            mergedSt[k] = 1;
          }
        }
        let merged = [{ st: mergedSt, jp: 0, js: 0, p: 1 }];
        for (const [k, influence] of [[a, infl[0]], [b, infl[1]]]) {
          if (k >= 0) {
            continue;
          }
          // A random influenced mod from a bought donor.
          const next = [];
          for (const o of merged) {
            const rolled = missingRollable(o.st);
            const influenced = rollOutcomes(itemFor(-1, o.st, o.jp, o.js), rolled.map(j => T[j]), [[1, 1]], { src: [influence] });
            next.push(...mapRoll(-1, o.st, o.jp, o.js, rolled, influenced, o.p));
          }
          merged = next;
        }
        const reforged = [];
        for (const o of merged) {
          const item = itemFor(-1, o.st, o.jp, o.js);
          const rolled = missingRollable(o.st);
          reforged.push(...mapRoll(-1, o.st, o.jp, o.js, rolled, rollOutcomes(item, rolled.map(j => T[j]), rerollDist(B, item.mods.length)), o.p));
        }
        const costPerTry = donorA.cost + donorB.cost + P(AWAKENER);
        const stopping = stopValue(costPerTry, reforged.map(o => ({ p: o.p, A: bestValueOfOutcome(o) })));
        if (isFinite(stopping.R) && (!best || stopping.R < best.R)) {
          let doneChance = 0;
          for (const o of reforged) {
            if (isDone(o.st, o.jp, o.js)) {
              doneChance = doneChance + o.p;
            }
          }
          best = {
            R: stopping.R,
            stop: stopping.stop,
            a,
            b,
            da: donorA,
            db: donorB,
            c: costPerTry,
            fin: reforged.map(o => ({ p: o.p, A: bestValueOfOutcome(o), n: bestNodeOfOutcome(o) })),
            pDone: doneChance,
          };
        }
      }
    }
    if (!best) {
      return null;
    }
    const { a, b, da, db } = best;
    const keptText = [a, b].filter(k => k >= 0).map(label).join(' and ');
    const donorFlow = d => (d.p < 1 - 1e-4 ? [{ kind: 'on', p: d.p }, { kind: 'again', p: 1 - d.p, note: 'missed: a new plain rare' }] : null);
    const next = best.fin.filter(o => o.A < best.R && o.n).sort((x, y) => y.p - x.p)[0]?.n;
    let awakenText = `Awakener's Orb: destroy one, the other becomes ${infl.join(' + ')} and keeps ${keptText} (each item's only influenced mod); every other mod is rerolled.`;
    if (best.pDone > 1e-4) {
      awakenText += ` ${pctText(best.pDone)} of the time that already finishes the item.`;
    }
    if (best.stop < 1 - 1e-4) {
      awakenText += ` ${pctText(best.stop)} of results are worth finishing with the influenced plan (Exalt, Annul, ...); otherwise make two new items.`;
    } else {
      awakenText += ' Finish it with the influenced plan (Exalt, Annul, ...).';
    }
    const pre = [
      { text: `Item 1 (${infl[0]}): ${da.text}.`, p: da.p, cost: da.cost, own: 0, how: 'Influenced Exalt', flow: donorFlow(da) },
      { text: `Item 2 (${infl[1]}): ${db.text}.`, p: db.p, cost: db.cost, own: 0, how: 'Influenced Exalt', flow: donorFlow(db) },
      {
        text: awakenText,
        p: best.stop,
        cost: best.c / best.stop,
        own: best.c / best.stop,
        how: "Awakener's Orb",
        ex: next?.key ? exampleItem(next) : null,
        flow: best.stop < 1 - 1e-4 ? [{ kind: 'on', p: best.stop }, { kind: 'new', p: 1 - best.stop, note: 'not worth finishing: two new items', to: 0 }] : null,
      },
    ];
    let steps;
    if (!next || next.done) {
      steps = [...pre, ...finalSteps(), ...benchStepShort()];
    } else {
      steps = trace(bestSol, { node: next, pre });
    }
    // The currency count: both items (a bought one, or Alchemy + influenced Exalts until it
    // adds the mod), the Awakener's Orb, again until a result is worth finishing.
    const simulateDonor = (d, k, influence, spend, rnd) => {
      if (k < 0) {
        spend({ [DONOR_VALUE]: AWAKEN_DONOR });
        return;
      }
      const triesNeeded = triesUntilSuccess(rnd, d.p);
      spend(billOf(CUR.alch), triesNeeded);
      spend(billOf(influenceExalt(influence)), triesNeeded);
    };
    const opening = {
      label: "Two influenced items, Awakener's Orb",
      enter: (spend, rnd, pickOutcome) => {
        for (;;) {
          simulateDonor(da, a, infl[0], spend, rnd);
          simulateDonor(db, b, infl[1], spend, rnd);
          spend(billOf(AWAKENER));
          const o = pickOutcome(best.fin);
          if (o.A < best.R && o.n) {
            return o.n;
          }
        }
      },
    };
    return {
      key: 'awaken',
      name: "Awakener's Orb",
      ok: true,
      opening,
      cost: best.R + benchCostTotal + swapCostTotal,
      steps,
      notes: ['Each item gets its influenced mod from an influenced Exalted Orb, so it has exactly one and the Awakener\'s Orb keeps it for certain. Both items must be the same item class; the plain rares\' other mods don\'t matter.'],
    };
  }
  if (infl.length === 2 && opt.awakener && (!phase || phase === 'base') && !ctx.sub && !ctx.bestOnly && !presetF && bestSol && isFinite(P(AWAKENER))) {
    onProgress("Awakener's Orb route");
    const route = awakenerRoute();
    if (route) {
      results.push(route);
      streamNewPlans();
    }
  }

  // Orb of Dominance: a note where it applies (influenced targets one tier short).
  const dominanceNotes = [];
  if (infl.length && DOMINANCE_GROUPS.has(B.info.group) && T.some(t => infl.includes(t.m.src))) {
    dominanceNotes.push(`Orb of Dominance (${fmtC(P(CUR.dominance))}, body armours, boots, gloves and helmets): on a rare with two or more influenced mods it upgrades one at random a tier (a top tier becomes Elevated) and removes another. With exactly two, that's the one you want half the time, at the cost of the other; the planner doesn't build that route because it can't tell which junk mods are influenced.`);
  }
  for (const r of results) {
    if (isFinite(mirror) && r.cost > mirror) {
      r.notes.push(`This costs more than a Mirror of Kalandra (${fmtC(mirror)}): buying a mirrored copy of a finished item is cheaper.`);
    }
    r.notes.push(...dominanceNotes);
  }

  // Other places the opening can leave the item, not just the likeliest one: each with its chance
  // and its own steps from there (and, for the fossil plans, its own state graph).
  function startsOf(sol, outs, withGraphs) {
    const byState = new Map();
    for (const o of outs) {
      if (!o.n || o.n.key === 'ruined' || (!o.n.done && !isFinite(o.n.V))) {
        continue;
      }
      const key = o.n.done ? 'done' : o.n.key;
      const entry = byState.get(key) ?? { p: 0, n: o.n };
      entry.p += o.p;
      byState.set(key, entry);
    }
    let total = 0;
    for (const entry of byState.values()) {
      total = total + entry.p;
    }
    if (byState.size < 2 || !(total > 0)) {
      return null;
    }
    const likeliest = [...byState.values()].sort((a, b) => b.p - a.p).slice(0, 6);
    return likeliest.map((entry, i) => {
      const steps = trace(sol, { node: entry.n, pre: [] });
      for (const step of steps) {
        delete step.simKey;
      }
      const start = {
        p: entry.p / total,
        done: !!entry.n.done,
        text: entry.n.done ? 'has every wanted mod' : stateText(entry.n),
        rem: entry.n.done ? 0 : entry.n.V,
        ex: exampleItem(entry.n),
        steps,
      };
      if (withGraphs && i < 3 && !entry.n.done) {
        start.makeGraph = () => simulateGraph(sol, 0, 250, 450, 200000, 25, { n: entry.n, label: 'Start: ' + start.text });
      }
      return start;
    });
  }
  function isFossilPlan(r) {
    return phase === 'fossil' && (r.key === 'Fossils' || r.key === 'fosrecomb' || r.key === 'Best mix of everything');
  }
  for (const r of results) {
    if (r.startsDone) {
      delete r.startsDone;
      continue;
    }
    try {
      if (r.startOuts) {
        r.starts = startsOf(r.startSol ?? bestSol, r.startOuts, isFossilPlan(r));
      } else if (r.sol?.start?.best?.ref) {
        const ref = r.sol.start.best.ref;
        r.starts = startsOf(r.sol, ref.nodes.filter(o => o.n.done || o.n.pol?.ref !== ref), isFossilPlan(r));
      } else if (r.sol?.start?.best?.alt) {
        const a = r.sol.start.best.alt;
        const keepBelow = a.imp ? a.V - a.altCost : a.V;
        r.starts = startsOf(r.sol, a.outs.filter(o => o.n.done || o.n.V <= keepBelow), isFossilPlan(r));
      }
    } catch (e) {
      if (SOLVER.debug) {
        SOLVER.debug('starts: ' + e.message);
      }
    }
    delete r.startOuts;
    delete r.startSol;
  }
  // The graph and currency count of each plan run later (finishPlans), from these.
  for (const r of results) {
    if (r.sol) {
      const { sol, extra } = r;
      r.makeGraph = () => simulateGraph(sol, extra, 500, 1500, 200000, 25);
      r.makeUsage = () => simulateGraph(sol, extra, 400, 700, 200000, 25).used;
    }
    // (Plans that start from your item or an opening of their own get a graph too.)
    if (r.pasteSim) {
      const { sol, from } = r.pasteSim;
      r.makeGraph = () => simulateGraph(sol, 0, 500, 1500, 200000, 25, from);
      r.makeUsage = () => simulateGraph(sol, 0, 400, 700, 200000, 25, from).used;
      delete r.pasteSim;
    }
    if (r.opening) {
      const opening = r.opening;
      r.makeGraph = () => simulateGraph(bestSol, 0, 500, 1500, 200000, 25, opening);
      r.makeUsage = () => simulateGraph(bestSol, 0, 400, 700, 200000, 25, opening).used;
      delete r.opening;
    }
    delete r.sol;
    delete r.extra;
    // Which swaps this plan pays for (the Recombinator's finishing steps use them too).
    r.swapsUsed = new Set(swaps.filter(x => x.share > 0.01 && isFinite(x.cost)).map(x => x.t.m.id));
  }
  if (ctx.sub) {
    return { results };
  }
  if (swapIds === null && !swappable.some(x => isFinite(x.cost))) {
    // Nothing to swap: this pass is the whole answer (the cheapest version of each plan).
    const bestByName = new Map();
    for (const r of results) {
      if (!bestByName.has(r.name) || r.cost < bestByName.get(r.name).cost) {
        bestByName.set(r.name, r);
      }
    }
    return finishPlans(sortPlansBestFirst([...bestByName.values()]), onProgress, ctx.quick);
  }
  return { results, swappable: swappable.filter(x => isFinite(x.cost)), bestSol, fossilCombos };
}

// ---------- text ----------

// A mod's text at a tier, cut to 48 characters.
function shortMod(mod, tierIndex) {
  const text = modText(mod, tierIndex);
  if (text.length > 48) {
    return text.slice(0, 46) + '…';
  }
  return text;
}

// A chance as text: "100%", "37%", "1.2%", "1 in 2,345".
export function pctText(p) {
  if (!(p > 0)) {
    return '0%';
  }
  if (p >= 0.995) {
    return '100%';
  }
  if (p >= 0.1) {
    return (p * 100).toFixed(0) + '%';
  }
  if (p >= 0.001) {
    return (p * 100).toPrecision(2) + '%';
  }
  return '1 in ' + fmtN(1 / p);
}

// A number as short text: "12k", "3.45M", "1,234", "0.52".
export function fmtN(x) {
  if (!isFinite(x)) {
    return '∞';
  }
  if (x >= 1e12) {
    return '10^' + Math.floor(Math.log10(x));
  }
  if (x >= 1e9) {
    return (x / 1e9).toPrecision(3) + 'B';
  }
  if (x >= 1e6) {
    return (x / 1e6).toPrecision(3) + 'M';
  }
  if (x >= 1e4) {
    return Math.round(x / 1e3) + 'k';
  }
  if (x >= 100) {
    return Math.round(x).toLocaleString('en-US');
  }
  return x.toPrecision(2).replace(/\.0+$/, '');
}

// A chaos amount as text: "1,234c" (or "?" when unknown).
function fmtC(chaos) {
  return isFinite(chaos) ? fmtN(chaos) + 'c' : '?';
}
