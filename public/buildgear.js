// The Build maker's gear solver: fills a build's rare slots (body armour, helmet, gloves, boots, belt, amulet, two
// rings, and a shield or quiver) with real affixes from the Crafting tab's modifier data
// (public/data/craft/gear-poe1.json, scripts/build_gear_mods.py), the way a player would gear it:
//   1. cap fire, cold and lightning resistance (the -60% the campaign leaves on every character included),
//   2. meet the attribute requirements of the build's gems, uniques and the item bases themselves,
//   3. then spend the affixes left on whatever raises the build's score most (life, energy shield, defences,
//      damage, chaos resistance).
// Up to three prefixes and three suffixes an item, one affix per modifier group. The weapon isn't solved: its
// damage is the engine's weapon model (public/buildgen.js). Without the gear data the engine keeps its fixed gear
// figures. Our estimates throughout, not Path of Building's numbers.

// How good the items are: how many tiers below the best one each affix rolls (the best tier an item level 84 base can
// roll counts as 0). The build planner offers these; the generator and its calibration use "endgame".
export const GEAR_LEVELS = {
  budget: { label: 'Budget', tiersBelowTop: 3 },
  endgame: { label: 'Endgame', tiersBelowTop: 1 },
  nearPerfect: { label: 'Near-perfect', tiersBelowTop: 0 },
};
export const DEFAULT_GEAR_LEVEL = 'endgame';
const ITEM_LEVEL = 84;
const MAX_PREFIXES = 3;
const MAX_SUFFIXES = 3;
const QUALITY = 20; // % increased defences from quality on every armour piece
// A fill step must raise the score by at least this share, or the affix slot is left for something else.
const MIN_FILL_GAIN = 0.002;

// Typical endgame bases, our approximate figures: their defences before quality and their attribute requirements.
// Hybrid bases split the rating and ask for some of each attribute.
const ARMOUR_BASES = {
  body: {
    str: { armour: 553, requirements: { str: 191 } },
    dex: { evasion: 737, requirements: { dex: 183 } },
    int: { energyShield: 175, requirements: { int: 194 } },
    str_dex: { armour: 290, evasion: 290, requirements: { str: 95, dex: 95 } },
    str_int: { armour: 290, energyShield: 90, requirements: { str: 95, int: 95 } },
    dex_int: { evasion: 290, energyShield: 90, requirements: { dex: 95, int: 95 } },
  },
  helmet: {
    str: { armour: 280, requirements: { str: 138 } },
    dex: { evasion: 285, requirements: { dex: 150 } },
    int: { energyShield: 100, requirements: { int: 154 } },
    str_dex: { armour: 160, evasion: 160, requirements: { str: 75, dex: 75 } },
    str_int: { armour: 160, energyShield: 55, requirements: { str: 75, int: 75 } },
    dex_int: { evasion: 160, energyShield: 55, requirements: { dex: 75, int: 75 } },
  },
  gloves: {
    str: { armour: 200, requirements: { str: 98 } },
    dex: { evasion: 200, requirements: { dex: 98 } },
    int: { energyShield: 70, requirements: { int: 98 } },
    str_dex: { armour: 110, evasion: 110, requirements: { str: 50, dex: 50 } },
    str_int: { armour: 110, energyShield: 40, requirements: { str: 50, int: 50 } },
    dex_int: { evasion: 110, energyShield: 40, requirements: { dex: 50, int: 50 } },
  },
  boots: {
    str: { armour: 200, requirements: { str: 120 } },
    dex: { evasion: 200, requirements: { dex: 120 } },
    int: { energyShield: 65, requirements: { int: 120 } },
    str_dex: { armour: 110, evasion: 110, requirements: { str: 60, dex: 60 } },
    str_int: { armour: 110, energyShield: 35, requirements: { str: 60, int: 60 } },
    dex_int: { evasion: 110, energyShield: 35, requirements: { dex: 60, int: 60 } },
  },
  offhand: {
    str: { armour: 400, requirements: { str: 159 } },
    dex: { evasion: 400, requirements: { dex: 159 } },
    int: { energyShield: 120, requirements: { int: 159 } },
    str_dex: { armour: 220, evasion: 220, requirements: { str: 85, dex: 85 } },
    str_int: { armour: 220, energyShield: 65, requirements: { str: 85, int: 85 } },
    dex_int: { evasion: 220, energyShield: 65, requirements: { dex: 85, int: 85 } },
  },
};
const ARMOUR_SLOTS = ['body', 'helmet', 'gloves', 'boots'];
// The defence types the solver tries: all six are ranked by their bare bases, the best three filled.
export const DEFENCE_TYPES = ['str', 'dex', 'int', 'str_dex', 'str_int', 'dex_int'];
const DEFENCE_TYPES_FILLED = 3;

// The gear data, prepared once: each slot base with its affixes at every gear level.
export function prepareGear(data) {
  if (!data || !data.bases) {
    return null;
  }
  const bases = {};
  for (const [key, base] of Object.entries(data.bases)) {
    const byLevel = {};
    for (const [levelName, level] of Object.entries(GEAR_LEVELS)) {
      byLevel[levelName] = affixesAtLevel(base.mods, level.tiersBelowTop);
    }
    bases[key] = { ...base, byLevel };
  }
  return { bases };
}

// Each affix at the tier a gear level uses: the best tier an item level 84 base can roll, less tiersBelowTop.
function affixesAtLevel(mods, tiersBelowTop) {
  const affixes = [];
  for (const mod of mods) {
    const rollable = mod.tiers.filter(tier => tier[0] <= ITEM_LEVEL && tier[1] > 0);
    if (rollable.length === 0) {
      continue;
    }
    const position = Math.max(0, rollable.length - 1 - tiersBelowTop);
    const [itemLevel, weight, effects, tierIndex, shown] = rollable[position];
    affixes.push({
      id: mod.id, text: mod.text, shown: shown || mod.text, affix: mod.affix, groups: mod.groups, effects, itemLevel, weight,
      tier: rollable.length - position, tierIndex,
    });
  }
  return affixes;
}

// ---------- items ----------
function newItem(slot, key, gear, defenceType) {
  const base = gear.bases[key];
  if (!base) {
    return null;
  }
  const baseItem = ARMOUR_BASES[slot] && defenceType ? ARMOUR_BASES[slot][defenceType] : null;
  return { slot, key, defenceType, craftBase: base.craftBase, baseItem, prefixes: [], suffixes: [], groups: new Set() };
}

function canTake(item, affix) {
  const list = affix.affix === 'p' ? item.prefixes : item.suffixes;
  const limit = affix.affix === 'p' ? MAX_PREFIXES : MAX_SUFFIXES;
  if (list.length >= limit) {
    return false;
  }
  for (const group of affix.groups || []) {
    if (item.groups.has(group)) {
      return false;
    }
  }
  return true;
}

function place(item, affix) {
  const copy = { ...item, prefixes: [...item.prefixes], suffixes: [...item.suffixes], groups: new Set(item.groups) };
  (affix.affix === 'p' ? copy.prefixes : copy.suffixes).push(affix);
  for (const group of affix.groups || []) {
    copy.groups.add(group);
  }
  return copy;
}

// What an item adds to the build: its affixes' lines, with the local defence lines applied to its base (flat added,
// then local increases and quality), given as flat armour, evasion and energy shield.
export function itemEffects(item) {
  const effects = [];
  const local = { armour: { flat: 0, increased: QUALITY }, evasion: { flat: 0, increased: QUALITY },
    energyShield: { flat: 0, increased: QUALITY } };
  for (const affix of [...item.prefixes, ...item.suffixes]) {
    for (const effect of affix.effects) {
      if (!effect.local) {
        effects.push(effect);
        continue;
      }
      const ratings = effect.stat === 'defences' ? ['armour', 'evasion', 'energyShield'] : [effect.stat];
      for (const rating of ratings) {
        local[rating][effect.kind === 'flat' ? 'flat' : 'increased'] += effect.value || 0;
      }
    }
  }
  const base = item.baseItem || {};
  for (const rating of ['armour', 'evasion', 'energyShield']) {
    const total = ((base[rating] || 0) + local[rating].flat) * (1 + local[rating].increased / 100);
    if (total > 0) {
      effects.push({ kind: 'flat', stat: rating, value: Math.round(total) });
    }
  }
  return effects;
}

export function gearEffects(gear) {
  const effects = [];
  for (const item of gear.items) {
    effects.push(...itemEffects(item));
  }
  return effects;
}

// The attribute requirements of the item bases.
export function gearRequirements(gear) {
  const requirements = { str: 0, dex: 0, int: 0 };
  for (const item of gear.items) {
    for (const [attribute, amount] of Object.entries(item.baseItem?.requirements || {})) {
      requirements[attribute] = Math.max(requirements[attribute], amount);
    }
  }
  return requirements;
}

// ---------- the solver ----------
// The rare slots a build has: armour pieces, belt, amulet and rings not taken by a unique, and a shield or quiver
// when its weapon carries one.
// Whether taking this unique out of the build would leave a slot for a rare item (weapons, flasks and jewels don't).
export function freesRareSlot(build, unique) {
  const without = { ...build, uniques: build.uniques.filter(other => other !== unique) };
  return rareSlots(without).length > rareSlots(build).length;
}

function rareSlots(build) {
  const taken = { ring: 0 };
  for (const unique of build.uniques) {
    if (unique.slot === 'ring') {
      taken.ring += 1;
    } else {
      taken[unique.slot] = true;
    }
  }
  const slots = [];
  for (const slot of [...ARMOUR_SLOTS, 'belt', 'amulet']) {
    if (!taken[slot]) {
      slots.push(slot);
    }
  }
  for (let ring = taken.ring; ring < 2; ring += 1) {
    slots.push('ring');
  }
  if (!taken.offhand) {
    if (build.weapon === 'shield') {
      slots.push('offhand');
    } else if (build.weapon === 'bow') {
      slots.push('quiver');
    }
  }
  return slots;
}

function itemsFor(build, gear, defenceType) {
  const items = [];
  for (const slot of rareSlots(build)) {
    const isArmour = ARMOUR_SLOTS.includes(slot) || slot === 'offhand';
    const key = isArmour ? `${slot}:${defenceType}` : slot;
    const item = newItem(slot, key, gear, isArmour ? defenceType : null);
    if (item) {
      items.push(item);
    }
  }
  return items;
}

// Fills a build's rare slots. engine: { evaluate(build) -> score, needsOf(build) -> { resistanceShort: {fire, cold,
// lightning}, attributeShort: {str, dex, int} } }, both reading build.gear. Returns the build with .gear set.
export function solveGear(build, gear, engine, levelName = DEFAULT_GEAR_LEVEL) {
  if (!gear) {
    return build;
  }
  const level = GEAR_LEVELS[levelName] ? levelName : DEFAULT_GEAR_LEVEL;
  // Which defence type: the bare bases rank them, then the best few are filled for real and the best finished set
  // kept. Bare bases alone misjudge it: local increases and attributes decide (a Deadeye looked best in energy
  // shield bases it couldn't meet the intelligence for).
  const ranked = [];
  for (const defenceType of DEFENCE_TYPES) {
    const trial = { ...build, gear: { level, items: itemsFor(build, gear, defenceType) } };
    ranked.push({ defenceType, score: engine.evaluate(trial) });
  }
  ranked.sort((first, second) => second.score - first.score);
  let best = null;
  let bestScore = -Infinity;
  for (const { defenceType } of ranked.slice(0, DEFENCE_TYPES_FILLED)) {
    let current = { ...build, gear: { level, items: itemsFor(build, gear, defenceType) } };
    current = meetNeeds(current, gear, engine, 'resistance');
    current = meetNeeds(current, gear, engine, 'attribute');
    current = tradeSpareResistance(current, gear, engine);
    current = fillByScore(current, gear, engine);
    const score = engine.evaluate(current);
    if (score > bestScore) {
      best = current;
      bestScore = score;
    }
  }
  return best;
}

// A quick re-solve after a unique left the build: the solved items stay as they are, the slots it freed get new
// items of the same defence type, and only those are filled. A trial for comparing uniques with rare items; the build
// that is kept gets a full solveGear() again.
export function solveFreedSlots(build, gear, engine) {
  if (!gear || !build.gear) {
    return build;
  }
  const kept = build.gear.items;
  let defenceType = null;
  for (const item of kept) {
    if (item.defenceType && defenceType === null) {
      defenceType = item.defenceType;
    }
  }
  if (defenceType === null) {
    return solveGear(build, gear, engine, build.gear.level);
  }
  const keptCount = {};
  for (const item of kept) {
    keptCount[item.slot] = (keptCount[item.slot] || 0) + 1;
  }
  const items = [...kept];
  for (const item of itemsFor(build, gear, defenceType)) {
    if ((keptCount[item.slot] || 0) > 0) {
      keptCount[item.slot] -= 1;
    } else {
      items.push(item);
    }
  }
  let current = { ...build, gear: { ...build.gear, items } };
  current = meetNeeds(current, gear, engine, 'resistance');
  current = meetNeeds(current, gear, engine, 'attribute');
  current = fillByScore(current, gear, engine);
  return current;
}

// The affixes each item can still take, at the gear level.
function candidatesFor(item, gear, level) {
  return gear.bases[item.key].byLevel[level].filter(affix => canTake(item, affix));
}

// How much of a shortfall an affix covers: resistance or attribute points that go where they are still missing.
function coverage(affix, short, kind) {
  let covered = 0;
  for (const effect of affix.effects) {
    if (kind === 'resistance' && effect.kind === 'resistance' && effect.stat === 'resistance' && !effect.condition) {
      const tags = effect.tags || [];
      const elements = tags.includes('elemental') ? ['fire', 'cold', 'lightning'] : tags.filter(tag => tag in short);
      for (const element of elements) {
        covered += Math.min(effect.value || 0, Math.max(0, short[element]));
      }
    }
    if (kind === 'attribute' && effect.kind === 'flat') {
      const attributes = effect.stat === 'attributes' ? ['str', 'dex', 'int']
        : { strength: ['str'], dexterity: ['dex'], intelligence: ['int'] }[effect.stat] || [];
      for (const attribute of attributes) {
        covered += Math.min(effect.value || 0, Math.max(0, short[attribute]));
      }
    }
  }
  return covered;
}

// Places the affix that covers most of the shortfall, again and again, until nothing is short or nothing helps.
function meetNeeds(build, gear, engine, kind) {
  let current = build;
  for (let step = 0; step < 40; step += 1) {
    const needs = engine.needsOf(current);
    const short = kind === 'resistance' ? needs.resistanceShort : needs.attributeShort;
    if (Object.values(short).every(amount => amount <= 0)) {
      break;
    }
    let best = null;
    for (let position = 0; position < current.gear.items.length; position += 1) {
      const item = current.gear.items[position];
      for (const affix of candidatesFor(item, gear, current.gear.level)) {
        const covered = coverage(affix, short, kind);
        if (covered > 0 && (!best || covered > best.covered)) {
          best = { position, affix, covered };
        }
      }
    }
    if (!best) {
      break;
    }
    current = withAffix(current, best.position, best.affix);
  }
  return current;
}

// Attributes still short while resistances are over the cap: a resistance suffix the cap can do without makes way
// for an attribute affix on the same item, again while that keeps resistances capped and covers some shortfall.
function tradeSpareResistance(build, gear, engine) {
  let current = build;
  for (let step = 0; step < 12; step += 1) {
    const short = engine.needsOf(current).attributeShort;
    if (Object.values(short).every(amount => amount <= 0)) {
      break;
    }
    const trade = bestTrade(current, gear, engine, short);
    if (!trade) {
      break;
    }
    current = trade;
  }
  return current;
}

function bestTrade(build, gear, engine, short) {
  let best = null;
  for (let position = 0; position < build.gear.items.length; position += 1) {
    const item = build.gear.items[position];
    for (const suffix of item.suffixes) {
      if (coverage(suffix, { fire: 1000, cold: 1000, lightning: 1000 }, 'resistance') === 0) {
        continue; // not a resistance affix
      }
      const without = withoutAffix(build, position, suffix);
      const stillCapped = Object.values(engine.needsOf(without).resistanceShort).every(amount => amount <= 0);
      if (!stillCapped) {
        continue;
      }
      for (const affix of candidatesFor(without.gear.items[position], gear, without.gear.level)) {
        const covered = coverage(affix, short, 'attribute');
        if (covered > 0 && (!best || covered > best.covered)) {
          best = { covered, build: withAffix(without, position, affix) };
        }
      }
    }
  }
  return best ? best.build : null;
}

function withoutAffix(build, position, affix) {
  const items = [...build.gear.items];
  const item = items[position];
  const groups = new Set(item.groups);
  for (const group of affix.groups || []) {
    groups.delete(group);
  }
  items[position] = { ...item, prefixes: item.prefixes.filter(entry => entry !== affix), suffixes: item.suffixes.filter(entry => entry !== affix), groups };
  return { ...build, gear: { ...build.gear, items } };
}

function withAffix(build, position, affix) {
  const items = [...build.gear.items];
  items[position] = place(items[position], affix);
  return { ...build, gear: { ...build.gear, items } };
}

// The rest by score: each step tries every distinct affix that still fits somewhere (in the first item that takes
// it, or for local defences the item where it adds most) and keeps the best, while it raises the score.
function fillByScore(build, gear, engine) {
  let current = build;
  let currentScore = engine.evaluate(current);
  const mayMatter = engine.affixFilterFor ? engine.affixFilterFor(build) : () => true;
  for (let step = 0; step < 60; step += 1) {
    let best = null;
    const tried = new Set();
    for (let position = 0; position < current.gear.items.length; position += 1) {
      const item = current.gear.items[position];
      for (const affix of candidatesFor(item, gear, current.gear.level)) {
        if (!mayMatter(affix)) {
          continue;
        }
        const isLocal = affix.effects.some(effect => effect.local);
        const key = isLocal ? `${affix.id}@${position}` : `${affix.id}`;
        if (tried.has(key)) {
          continue;
        }
        tried.add(key);
        const trial = withAffix(current, position, affix);
        const score = engine.evaluate(trial);
        if (!best || score > best.score) {
          best = { score, trial };
        }
      }
    }
    if (!best || best.score < currentScore * (1 + MIN_FILL_GAIN)) {
      break;
    }
    current = best.trial;
    currentScore = best.score;
  }
  return current;
}

// What a generated build keeps of its gear: each item's slot, base and affixes (text, tier), for the cards and the
// Crafting tab link.
export function compactGear(gear) {
  if (!gear) {
    return null;
  }
  return {
    level: gear.level,
    items: gear.items.map(item => ({
      slot: item.slot, key: item.key, craftBase: item.craftBase,
      affixes: [...item.prefixes, ...item.suffixes].map(affix => ({ id: affix.id, text: affix.shown, affix: affix.affix, tier: affix.tier,
        tierIndex: affix.tierIndex })),
    })),
  };
}

// The generated file's short form of compactGear: each item as [base key, [affix ids]]. The text, tiers and craft
// base come back from the gear data (rebuildGear, then compactGear); the full form made the file too big to deploy
// (Cloudflare Pages takes files up to 25 MiB).
export function storeGear(compact) {
  if (!compact) {
    return null;
  }
  const items = [];
  for (const item of compact.items) {
    items.push([item.key, item.affixes.map(affix => affix.id)]);
  }
  return { level: compact.level, items };
}

// One stored item in the long form: compactGear's object, or storeGear's [key, ids].
function storedItemOf(storedItem) {
  if (!Array.isArray(storedItem)) {
    return storedItem;
  }
  const [key, ids] = storedItem;
  return { key, slot: key.split(':')[0], affixes: ids.map(id => ({ id })) };
}

// A stored build's gear (compactGear or storeGear) back as items, from the same gear data. An affix the data no
// longer has is left out; without the gear data there is no gear (the engine's fixed figures).
export function rebuildGear(stored, gear) {
  if (!stored || !gear) {
    return null;
  }
  const level = GEAR_LEVELS[stored.level] ? stored.level : DEFAULT_GEAR_LEVEL;
  const items = [];
  for (const entry of stored.items || []) {
    const storedItem = storedItemOf(entry);
    const defenceType = storedItem.key.includes(':') ? storedItem.key.split(':')[1] : null;
    let item = newItem(storedItem.slot, storedItem.key, gear, defenceType);
    if (!item) {
      continue;
    }
    const pool = gear.bases[storedItem.key].byLevel[level];
    for (const storedAffix of storedItem.affixes || []) {
      const affix = pool.find(candidate => candidate.id === storedAffix.id);
      if (affix && canTake(item, affix)) {
        item = place(item, affix);
      }
    }
    items.push(item);
  }
  return { level, items };
}

// The Crafting tab's link for a stored item (crafting.js, readItemLink): ?item=<base>~<item level>~<influences>~<mods>~,
// each mod as <id>.<lowest tier index> joined by "_", opened on the #craft tab. It plans and prices the item there.
export const CRAFT_ITEM_LEVEL = 86;
export function craftQuery(storedItem) {
  const mods = (storedItem.affixes || []).filter(affix => affix.tierIndex !== undefined)
    .map(affix => `${affix.id}.${affix.tierIndex}`).join('_');
  const parts = [storedItem.craftBase, CRAFT_ITEM_LEVEL, '', mods, ''].map(part => encodeURIComponent(String(part)));
  return `?item=${parts.join('~')}#craft`;
}
