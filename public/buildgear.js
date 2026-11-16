// The Build maker's gear solver: fills a build's rare slots (body armour, helmet, gloves, boots, belt, amulet, two
// rings, a shield or quiver, and the weapons) with real affixes from the Crafting tab's modifier data
// (public/data/craft/gear-poe1.json, scripts/build_gear_mods.py), the way a player would gear it:
//   1. cap fire, cold and lightning resistance (the -60% the campaign leaves on every character included),
//   2. meet the attribute requirements of the build's gems, uniques and the item bases themselves,
//   3. then spend the affixes left on whatever raises the build's score most (life, energy shield, defences,
//      damage, chaos resistance).
// Up to three prefixes and three suffixes an item, one affix per modifier group. Every hand holds something: a spell
// build's weapon is a caster base (a wand, rune dagger, sceptre or staff, its spell lines only: CASTER_WEAPONS in
// scripts/build_gear_mods.py), an attack build's the endgame base of its weapon type, whose physical damage, attack
// speed and crit the engine compares with its reference rare (solvedWeaponFactors). A one-handed build without a
// shield dual wields; a staff or bow, or a two-handed unique, fills both hands, and a bow has a quiver. Without the
// gear data the engine keeps its fixed gear figures. Our estimates throughout, not Path of Building's numbers.

//
// Every source of affixes the Crafting tab knows is used (2026-11-27), with the limits a crafter meets: influenced
// mods of at most maxInfluences influences an item (two with an Awakener's Orb; every one on an Astrolabe Amulet),
// one Searing Exarch and one Eater of Worlds implicit on an armour piece but never beside an influence, and one bench
// craft, one essence mod, one veiled mod and one beast craft an item. Each slot can be any base item of its kind
// (the wiki's implicit and defences; an Experimented base's prefix and suffix counts and larger values; a base whose
// implicit stops mods rolling, by the Crafting tab's own rule, baseBlocks in public/craft.js).
import { baseBlocks } from './craft.js';

// How good the items are: how many tiers below the best one each affix rolls (the best tier an item level 84 base can
// roll counts as 0), how many influences an item has, and how many mods a crafter places on it (maxPlaced: bench,
// essence, veiled and beast mods together; our estimate of what each level pays for: a budget item one bench craft
// or essence, an endgame one two, a near-perfect one all four). The build planner offers these; the generator and
// its calibration use "endgame".
export const GEAR_LEVELS = {
  budget: { label: 'Budget', tiersBelowTop: 3, maxInfluences: 1, maxPlaced: 1 },
  endgame: { label: 'Endgame', tiersBelowTop: 1, maxInfluences: 2, maxPlaced: 2 },
  nearPerfect: { label: 'Near-perfect', tiersBelowTop: 0, maxInfluences: 2, maxPlaced: 4 },
};
const INFLUENCE_SOURCES = new Set(['shaper', 'elder', 'crusader', 'hunter', 'redeemer', 'warlord']);
// Sources an item holds one mod of at most: a bench craft, an essence's mod, an unveiled mod, a beast craft.
const ONE_EACH_SOURCES = new Set(['bench', 'essence', 'veiled', 'beast']);
// Mods that roll by spawn weight (a weight of 0 means they don't roll there); the others are placed by the crafter.
const ROLLING_SOURCES = new Set(['base', ...INFLUENCE_SOURCES]);
// The eldritch implicits: one of each on an armour piece.
const ELDRITCH_SIDES = new Set(['r', 'b']);
export const DEFAULT_GEAR_LEVEL = 'endgame';
const ITEM_LEVEL = 84;
const MAX_PREFIXES = 3;
const MAX_SUFFIXES = 3;
const QUALITY = 20; // % increased defences from quality on every armour piece, and physical damage on a weapon
// The rare weapon the engine's attack damage is measured against (public/buildgen.js, the sheet DPS and the bare
// skill), our estimates of a good endgame rare: 170% increased physical damage, flat physical damage of about 32 on a
// one-handed weapon and half again on a two-handed one, 20% increased attack speed and 20% quality. A solved weapon
// counts as the share of this reference it reaches.
export const REFERENCE_RARE_WEAPON = { increasedPhysical: 170, flatPhysical: 32, twoHandedFlatFactor: 1.5, attackSpeed: 20,
  quality: QUALITY };
// What a hand counts as when nothing in it is solved or read (the fixed gear figures' rare weapon): the reference
// itself.
const REFERENCE_HAND = { damage: 1, speed: 1, critIncreased: 0, critFlat: 0 };
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
const RARE_SLOT_NAMES = new Set([...ARMOUR_SLOTS, 'belt', 'amulet', 'ring', 'offhand', 'quiver', 'weapon']);
// What each slot is called on the build cards (public/buildideas.js, public/buildrevisitview.js).
export const GEAR_SLOT_WORDS = { body: 'Body armour', helmet: 'Helmet', gloves: 'Gloves', boots: 'Boots', belt: 'Belt',
  amulet: 'Amulet', ring: 'Ring', offhand: 'Shield', quiver: 'Quiver', weapon: 'Weapon' };
// A solved weapon's kind, from its key (weapon:mace, weapon:attack-sword): what to craft it on.
const WEAPON_KIND_WORDS = { wand: 'Wand', dagger: 'Rune Dagger', mace: 'Sceptre', staff: 'Staff',
  'attack-sword': 'Sword', 'attack-axe': 'Axe', 'attack-mace': 'Mace', 'attack-claw': 'Claw', 'attack-dagger': 'Dagger',
  'attack-wand': 'Wand', 'attack-staff': 'Staff', 'attack-bow': 'Bow', 'attack-twoHandSword': 'Two-handed sword',
  'attack-twoHandAxe': 'Two-handed axe', 'attack-twoHandMace': 'Two-handed mace' };

// What a gear item is called on a card: its slot, for a weapon its kind ("Weapon: Sceptre"), and its base item and
// influences when the solver chose them ("Ring: Vermillion Ring, Shaper and Elder").
export function gearItemLabel(item) {
  const slotWord = GEAR_SLOT_WORDS[item.slot] || item.slot;
  let label = slotWord;
  if (item.slot === 'weapon') {
    const kind = WEAPON_KIND_WORDS[(item.key || '').split(':')[1]];
    label = kind ? slotWord + ': ' + kind : slotWord;
  }
  const details = [];
  if (item.baseName) {
    details.push(item.baseName);
  }
  const influences = [...new Set((item.affixes || []).map(affix => affix.source).filter(source => INFLUENCE_SOURCES.has(source)))];
  if (influences.length > 0) {
    details.push(influences.map(name => name[0].toUpperCase() + name.slice(1)).join(' and '));
  }
  return details.length > 0 ? label + ' (' + details.join(', ') + ')' : label;
}
// A spell build's weapon, by the weapon it is planned with: its own kind, or with a shield one of the one-handed
// caster weapons (the solver keeps whichever scores best).
const CASTER_WEAPON_KEYS = { wand: ['weapon:wand'], dagger: ['weapon:dagger'], mace: ['weapon:mace'], staff: ['weapon:staff'],
  shield: ['weapon:wand', 'weapon:dagger', 'weapon:mace'] };
// An attack build's weapon: its weapon type's endgame base, or with a shield whichever one-handed melee base scores
// best.
const ATTACK_WEAPON_KEYS = { sword: ['weapon:attack-sword'], axe: ['weapon:attack-axe'], mace: ['weapon:attack-mace'],
  claw: ['weapon:attack-claw'], dagger: ['weapon:attack-dagger'], wand: ['weapon:attack-wand'], staff: ['weapon:attack-staff'],
  bow: ['weapon:attack-bow'], twoHandSword: ['weapon:attack-twoHandSword'], twoHandAxe: ['weapon:attack-twoHandAxe'],
  twoHandMace: ['weapon:attack-twoHandMace'],
  shield: ['weapon:attack-sword', 'weapon:attack-axe', 'weapon:attack-mace', 'weapon:attack-claw', 'weapon:attack-dagger'] };
// The one-handed weapon types: held without a shield, the build holds two (dual wielding) rather than an empty
// off-hand.
const ONE_HANDED_WEAPONS = new Set(['sword', 'axe', 'mace', 'claw', 'dagger', 'wand']);
// The two-handed weapon kinds: they take both hands, so no shield, no second weapon (a bow still has its quiver).
const TWO_HANDED_WEAPONS = new Set(['staff', 'bow', 'twoHandSword', 'twoHandAxe', 'twoHandMace']);
// A two-handed sword, axe or mace is planned as a kind of its own but is still a sword, axe or mace: the tree's sword
// lines, a sword unique and a sword-only support take it.
const WEAPON_FAMILY = { twoHandSword: 'sword', twoHandAxe: 'axe', twoHandMace: 'mace' };

// The weapon family a planned weapon kind belongs to (twoHandSword: sword); other kinds are their own family.
export function weaponFamilyOf(weapon) {
  return WEAPON_FAMILY[weapon] || weapon;
}

// Whether a planned weapon kind takes both hands.
export function isTwoHandedWeapon(weapon) {
  return TWO_HANDED_WEAPONS.has(weapon);
}
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
    bases[key] = { ...base, byLevel, baseItems: base.baseItems || [] };
  }
  return { bases };
}

// Each affix at the tier a gear level uses: the best tier an item level 84 base can roll, less tiersBelowTop. Mods
// a crafter places (bench, essence, veiled, beast and fossil ones) have no spawn weight to need.
function affixesAtLevel(mods, tiersBelowTop) {
  const affixes = [];
  for (const mod of mods) {
    const source = mod.source || 'base';
    const rolls = ROLLING_SOURCES.has(source);
    const rollable = mod.tiers.filter(tier => tier[0] <= ITEM_LEVEL && (!rolls || tier[1] > 0));
    if (rollable.length === 0) {
      continue;
    }
    const position = Math.max(0, rollable.length - 1 - tiersBelowTop);
    const [itemLevel, weight, effects, tierIndex, shown] = rollable[position];
    affixes.push({
      id: mod.id, text: mod.text, shown: shown || mod.text, affix: mod.affix, groups: mod.groups, effects, itemLevel, weight,
      tier: rollable.length - position, tierIndex, source, tags: mod.tags || [],
    });
  }
  return affixes;
}

// ---------- items ----------
// A new, empty item of a slot pool (key), on a named base item of that pool (baseName; the pool's default without
// one). levelName sets how many influences it may take.
function newItem(slot, key, gear, givenDefenceType, baseName = null, levelName = DEFAULT_GEAR_LEVEL) {
  let defenceType = givenDefenceType;
  const base = gear.bases[key];
  if (!base) {
    return null;
  }
  const chosen = baseName ? base.baseItems.find(entry => entry.name === baseName) || null : null;
  let baseItem = armourBaseItem(slot, defenceType, base, chosen);
  if (slot === 'weapon') {
    baseItem = weaponBaseItem(base, chosen);
    defenceType = null; // a weapon's key names its kind (weapon:wand), not a defence type
  } else if (!baseItem) {
    baseItem = jewelleryBaseItem(chosen);
  }
  const level = GEAR_LEVELS[levelName] || GEAR_LEVELS[DEFAULT_GEAR_LEVEL];
  return { slot, key, defenceType, craftBase: base.craftBase, baseItem, maxInfluences: level.maxInfluences,
    maxPlaced: level.maxPlaced, prefixes: [], suffixes: [],
    implicits: [], groups: new Set() };
}

// What every base item carries: its implicit lines, requirements, an Experimented base's changes and a limit.
function commonBaseFields(chosen) {
  if (!chosen) {
    return { name: null, implicit: [], requirements: {}, exp: null, limit: null };
  }
  return { name: chosen.name, implicit: chosen.implicit || [], requirements: chosen.requirements || {},
    exp: chosen.exp || null, limit: chosen.limit || null };
}

// An armour piece or shield: the chosen base's own defences, or the pool's best base (the first, best defences),
// or without base data the fixed figures (ARMOUR_BASES).
function armourBaseItem(slot, defenceType, base, chosen) {
  if (!ARMOUR_BASES[slot] || !defenceType) {
    return null;
  }
  const picked = chosen || base.baseItems.find(entry => !entry.exp && !entry.limit && entry.implicit.length === 0) || null;
  if (!picked || !(picked.armour || picked.evasion || picked.energyShield)) {
    return { ...ARMOUR_BASES[slot][defenceType], ...(chosen ? commonBaseFields(chosen) : {}) };
  }
  return { ...commonBaseFields(picked), armour: picked.armour || 0, evasion: picked.evasion || 0,
    energyShield: picked.energyShield || 0 };
}

// A ring, amulet, belt or quiver: the chosen base, or a plain one (no implicit).
function jewelleryBaseItem(chosen) {
  return commonBaseFields(chosen);
}

// A weapon: the pool's endgame base (the engine's reference for its kind), or another base of the pool, whose damage
// is then measured against that reference.
function weaponBaseItem(base, chosen) {
  const reference = { physicalMin: base.physicalMin || 0, physicalMax: base.physicalMax || 0,
    attackSpeed: base.attackSpeed || 0, crit: base.crit || 0 };
  const fields = chosen ? commonBaseFields(chosen)
    : { name: base.baseName, implicit: base.implicit || [], requirements: base.requirements || {}, exp: null, limit: null };
  const own = chosen && chosen.physicalMax ? chosen : base;
  return { ...fields, attack: Boolean(base.attack), twoHanded: Boolean(base.twoHanded) || base.type === 'staff',
    physicalMin: own.physicalMin || 0, physicalMax: own.physicalMax || 0, attackSpeed: own.attackSpeed || 0,
    crit: own.crit || 0, reference };
}

// How many prefixes and suffixes the item's base allows (an Experimented base moves them).
function sideLimit(item, side) {
  if (ELDRITCH_SIDES.has(side)) {
    return 1;
  }
  const change = item.baseItem?.exp?.[side] || 0;
  return Math.max(0, (side === 'p' ? MAX_PREFIXES : MAX_SUFFIXES) + change);
}

function listOf(item, side) {
  if (side === 'p') {
    return item.prefixes;
  }
  if (side === 's') {
    return item.suffixes;
  }
  return item.implicits;
}

function allAffixesOf(item) {
  return [...item.prefixes, ...item.suffixes, ...item.implicits];
}

function canTake(item, affix) {
  const side = affix.affix;
  if (listOf(item, side).filter(entry => entry.affix === side).length >= sideLimit(item, side)) {
    return false;
  }
  for (const group of affix.groups || []) {
    if (item.groups.has(group)) {
      return false;
    }
  }
  if (item.baseItem?.limit && baseBlocks(item.baseItem, { src: affix.source, tags: affix.tags || [] })) {
    return false;
  }
  return sourceAllowed(item, affix);
}

// The crafter's limits on where an affix comes from: influences (no more than maxInfluences, every one on an
// Astrolabe Amulet), no eldritch implicit beside an influence, one bench craft, essence, veiled and beast mod, and
// no more of those together than the gear level's maxPlaced.
function sourceAllowed(item, affix) {
  const source = affix.source || 'base';
  const held = allAffixesOf(item);
  const influences = new Set(held.map(entry => entry.source).filter(name => INFLUENCE_SOURCES.has(name)));
  const allInfluences = Boolean(item.baseItem?.exp?.allInfl);
  if (INFLUENCE_SOURCES.has(source)) {
    if (held.some(entry => ELDRITCH_SIDES.has(entry.affix))) {
      return false;
    }
    if (!allInfluences && !influences.has(source) && influences.size >= (item.maxInfluences ?? 2)) {
      return false;
    }
  }
  if (ELDRITCH_SIDES.has(affix.affix) && (influences.size > 0 || allInfluences)) {
    return false;
  }
  if (ONE_EACH_SOURCES.has(source)) {
    if (held.some(entry => entry.source === source)) {
      return false;
    }
    if (held.filter(entry => ONE_EACH_SOURCES.has(entry.source)).length >= (item.maxPlaced ?? ONE_EACH_SOURCES.size)) {
      return false;
    }
  }
  return true;
}

function place(item, affix) {
  const copy = { ...item, prefixes: [...item.prefixes], suffixes: [...item.suffixes], implicits: [...(item.implicits || [])],
    groups: new Set(item.groups) };
  listOf(copy, affix.affix).push(affix);
  for (const group of affix.groups || []) {
    copy.groups.add(group);
  }
  return copy;
}

// The same affixes on another base item of the slot: each kept while the new base allows it, in the order placed.
function onBaseItem(item, gear, baseName, levelName) {
  let moved = newItem(item.slot, item.key, gear, item.defenceType, baseName, levelName);
  if (!moved) {
    return null;
  }
  for (const affix of allAffixesOf(item)) {
    if (canTake(moved, affix)) {
      moved = place(moved, affix);
    }
  }
  return moved;
}

// An Experimented base's larger values ("50% increased Suffix Modifier magnitudes"): the affix's numbers on that
// side scaled, as the Crafting tab scales the mod's values (forBaseItem in public/craft.js).
const scaledAffixEffects = new WeakMap();
function affixEffectsOn(item, affix) {
  const magnitude = item.baseItem?.exp?.mag?.[affix.affix] || 0;
  if (magnitude === 0) {
    return affix.effects;
  }
  if (!scaledAffixEffects.has(affix)) {
    scaledAffixEffects.set(affix, new Map());
  }
  const byMagnitude = scaledAffixEffects.get(affix);
  if (!byMagnitude.has(magnitude)) {
    byMagnitude.set(magnitude, affix.effects.map(effect => (typeof effect.value === 'number'
      ? { ...effect, value: effect.value * (1 + magnitude / 100) } : effect)));
  }
  return byMagnitude.get(magnitude);
}

// What an item adds to the build: its affixes' lines, with the local defence lines applied to its base (flat added,
// then local increases and quality), given as flat armour, evasion and energy shield. An attack weapon's own physical
// damage, speed and crit are the engine's (solvedWeaponFactors), not lines; its flat elemental damage hits only with
// that weapon, so it counts for handShare of the hits (half, dual wielding). Lines about socketed gems reach the main
// skill only from a six-link: a body armour or a two-handed weapon.
// Items are never changed once made (place and withoutAffix copy them), so each item's lines are worked out once per
// hand share and kept.
const itemEffectsCache = new WeakMap();
export function itemEffects(item, handShare = 1) {
  if (!itemEffectsCache.has(item)) {
    itemEffectsCache.set(item, new Map());
  }
  const byShare = itemEffectsCache.get(item);
  if (!byShare.has(handShare)) {
    byShare.set(handShare, workOutItemEffects(item, handShare));
  }
  return byShare.get(handShare);
}

function workOutItemEffects(item, handShare) {
  const effects = [];
  for (const effect of item.baseItem?.implicit || []) {
    if (reachesFromItem(effect, item)) {
      effects.push(effect);
    }
  }
  const local = { armour: { flat: 0, increased: QUALITY }, evasion: { flat: 0, increased: QUALITY },
    energyShield: { flat: 0, increased: QUALITY } };
  for (const affix of allAffixesOf(item)) {
    for (const effect of affixEffectsOn(item, affix)) {
      if (!reachesFromItem(effect, item)) {
        continue;
      }
      if (effect.weaponHand) {
        effects.push(handShare === 1 ? effect : { ...effect, value: (effect.value || 0) * handShare });
        continue;
      }
      if (!effect.local) {
        effects.push(effect);
        continue;
      }
      if (WEAPON_STATS.has(effect.stat)) {
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

// The weapon's own stats, which solvedWeaponFactors reads.
const WEAPON_STATS = new Set(['weaponPhysical', 'weaponAttackSpeed', 'weaponCrit']);

// Whether a line of the item reaches the build: socketed-gem lines only from a six-link item.
function reachesFromItem(effect, item) {
  if (!effect.socketed) {
    return true;
  }
  return item.slot === 'body' || (item.slot === 'weapon' && Boolean(item.baseItem?.twoHanded));
}

// Every item's lines. handShare: the share of hits each held weapon makes (weaponShareOf).
export function gearEffects(gear, handShare = 1) {
  const effects = [];
  for (const item of gear.items) {
    effects.push(...itemEffects(item, handShare));
  }
  return effects;
}

// ---------- hands ----------
// A two-handed unique weapon (Starforge on a two-handed sword build) fills both hands.
export function holdsTwoHandedUnique(build) {
  for (const unique of build.uniques || []) {
    if (unique.slot === 'weapon' && unique.twoHanded) {
      return true;
    }
  }
  return false;
}

// A one-handed weapon held without a shield is held twice: dual wielding, for attacks and spells alike (a caster
// wand or sceptre carries its spell lines in either hand). Not with a two-handed unique.
export function dualWields(build) {
  return ONE_HANDED_WEAPONS.has(build.weapon) && !holdsTwoHandedUnique(build);
}

// How many weapons the build holds: two dual wielding, otherwise one.
export function weaponsHeld(build) {
  return dualWields(build) ? 2 : 1;
}

// The share of the hits each held weapon makes: attacks alternate hands when dual wielding.
export function weaponShareOf(build) {
  return 1 / weaponsHeld(build);
}

// An attack build's solved weapons against the reference rare (REFERENCE_RARE_WEAPON), averaged over the hands
// (a unique weapon in a hand counts as the reference): damage, the weapon's physical hit over the reference's; speed,
// its attack speed over the reference's; and its local crit chance, increased and flat. null when no rare attack
// weapon is worn, so the engine keeps its model.
export function solvedWeaponFactors(build, referenceBase = null) {
  const hands = [];
  if (build.gear) {
    for (const item of wornGearItems(build)) {
      if (item.slot === 'weapon' && item.baseItem?.attack) {
        hands.push(weaponFactorsOf(item));
      }
    }
  }
  for (const unique of build.uniques || []) {
    if (unique.slot === 'weapon' && unique.weaponHand) {
      hands.push(uniqueWeaponFactorsOf(unique, referenceBase));
    }
  }
  if (hands.length === 0) {
    return null;
  }
  while (hands.length < weaponsHeld(build)) {
    hands.push(REFERENCE_HAND);
  }
  const average = { damage: 0, speed: 0, critIncreased: 0, critFlat: 0 };
  for (const hand of hands) {
    average.damage += hand.damage / hands.length;
    average.speed += hand.speed / hands.length;
    average.critIncreased += hand.critIncreased / hands.length;
    average.critFlat += hand.critFlat / hands.length;
  }
  return average;
}

// A unique weapon's factors (its hand from scripts/build_mechanics.py: its base's damage, speed and crit with its
// local lines) against the reference rare on the planned weapon's base (referenceBase; its own base without one).
// Its base's crit chance over the reference base's counts as flat crit.
function uniqueWeaponFactorsOf(unique, referenceBase) {
  const hand = unique.weaponHand;
  const reference = referenceBase || hand;
  const local = { physicalFlat: hand.physicalFlat, physicalIncreased: hand.physicalIncreased,
    attackSpeed: hand.attackSpeedIncreased, critIncreased: hand.critIncreased,
    critFlat: hand.critFlat + (hand.crit || 0) - (reference.crit || hand.crit || 0) };
  return handFactors(hand, local, Boolean(unique.twoHanded), reference);
}

// One rare attack weapon's factors: (base physical + its flat) x (1 + its increased physical and quality), over the
// reference rare on the same base; (1 + its attack speed) over the reference's 20%.
function weaponFactorsOf(item) {
  const base = item.baseItem;
  // Another base of the weapon's kind is measured against the kind's endgame base (the engine's reference), its
  // crit chance over the reference's as flat crit.
  const reference = base.reference || base;
  const local = { physicalFlat: 0, physicalIncreased: 0, attackSpeed: 0, critIncreased: 0,
    critFlat: (base.crit || 0) - (reference.crit || base.crit || 0) };
  for (const affix of allAffixesOf(item)) {
    for (const effect of affixEffectsOn(item, affix)) {
      if (effect.stat === 'weaponPhysical' && effect.kind === 'flat') {
        local.physicalFlat += effect.value || 0;
      } else if (effect.stat === 'weaponPhysical' && effect.kind === 'increased') {
        local.physicalIncreased += effect.value || 0;
      } else if (effect.stat === 'weaponAttackSpeed') {
        local.attackSpeed += effect.value || 0;
      } else if (effect.stat === 'weaponCrit' && effect.kind === 'increased') {
        local.critIncreased += effect.value || 0;
      } else if (effect.stat === 'weaponCrit' && effect.kind === 'flat') {
        local.critFlat += effect.value || 0;
      }
    }
  }
  return handFactors(base, local, Boolean(base.twoHanded), reference);
}

// A weapon's hit and speed over the reference rare's on the reference base: (base physical + flat) x (1 + increased
// physical and quality), and base attack speed x (1 + increased attack speed).
function handFactors(base, local, twoHanded, referenceBase) {
  const reference = REFERENCE_RARE_WEAPON;
  const baseAverage = (base.physicalMin + base.physicalMax) / 2;
  const referenceAverage = (referenceBase.physicalMin + referenceBase.physicalMax) / 2;
  const referenceFlat = reference.flatPhysical * (twoHanded ? reference.twoHandedFlatFactor : 1);
  const referenceHit = (referenceAverage + referenceFlat) * (1 + (reference.increasedPhysical + reference.quality) / 100);
  const hit = (baseAverage + local.physicalFlat) * (1 + (local.physicalIncreased + QUALITY) / 100);
  const speed = (base.attackSpeed || 1) * (1 + local.attackSpeed / 100);
  const referenceSpeed = (referenceBase.attackSpeed || base.attackSpeed || 1) * (1 + reference.attackSpeed / 100);
  return {
    damage: referenceHit > 0 ? hit / referenceHit : 1,
    speed: speed / referenceSpeed,
    critIncreased: local.critIncreased,
    critFlat: local.critFlat,
  };
}

// The solved items the build still wears: a unique added after the gear was solved (the build planner's agents add
// The Pariah or an amulet that way) takes its slot, so the rare item there no longer counts. Rings go first-solved
// first; items outside the rare slots (the revisit panel's stand-in) are kept.
export function wornGearItems(build) {
  if (!build.gear) {
    return [];
  }
  const free = new Map();
  for (const slot of rareSlots(build)) {
    free.set(slot, (free.get(slot) || 0) + 1);
  }
  const worn = [];
  for (const item of build.gear.items) {
    if (!RARE_SLOT_NAMES.has(item.slot)) {
      worn.push(item);
      continue;
    }
    const left = free.get(item.slot) || 0;
    if (left > 0) {
      free.set(item.slot, left - 1);
      worn.push(item);
    }
  }
  return worn;
}

// The build's solved gear as it is worn (wornGearItems): what scoring, requirements and the stored build use.
export function wornGear(build) {
  if (!build.gear) {
    return null;
  }
  return { ...build.gear, items: wornGearItems(build) };
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
// The rare slots a build has: armour pieces, belt, amulet and rings not taken by a unique, a shield or quiver when
// its weapon carries one, and every hand a unique weapon doesn't hold.
// Whether taking this unique out of the build would leave a slot for a rare item (weapons, flasks and jewels don't).
export function freesRareSlot(build, unique) {
  const without = { ...build, uniques: build.uniques.filter(other => other !== unique) };
  return rareSlots(without).length > rareSlots(build).length;
}

function rareSlots(build) {
  const taken = { ring: 0, weapon: 0 };
  for (const unique of build.uniques) {
    if (unique.slot === 'ring') {
      taken.ring += 1;
    } else if (unique.slot === 'weapon') {
      taken.weapon += 1;
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
  if (weaponKeysOf(build).length > 0 && !holdsTwoHandedUnique(build)) {
    for (let weapon = taken.weapon; weapon < weaponsHeld(build); weapon += 1) {
      slots.push('weapon');
    }
  }
  return slots;
}

// The weapon bases a build's hands can be solved on: an attack build's weapon type (its local damage counts), or a
// caster base for any other (it doesn't attack, so only the weapon's spell lines count).
function weaponKeysOf(build) {
  const types = build.skill?.types || [];
  if (types.includes('Attack')) {
    return ATTACK_WEAPON_KEYS[build.weapon] || [];
  }
  return CASTER_WEAPON_KEYS[build.weapon] || [];
}

function itemsFor(build, gear, defenceType, weaponKey, levelName = DEFAULT_GEAR_LEVEL) {
  const items = [];
  for (const slot of rareSlots(build)) {
    const isArmour = ARMOUR_SLOTS.includes(slot) || slot === 'offhand';
    let key = isArmour ? `${slot}:${defenceType}` : slot;
    if (slot === 'weapon') {
      key = weaponKey || weaponKeysOf(build)[0];
    }
    const item = newItem(slot, key, gear, isArmour ? defenceType : null, null, levelName);
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
  const weaponKey = bestWeaponKey(build, gear, engine, level);
  const ranked = [];
  for (const defenceType of DEFENCE_TYPES) {
    const trial = { ...build, gear: { level, items: itemsFor(build, gear, defenceType, weaponKey, level) } };
    ranked.push({ defenceType, score: engine.evaluate(trial) });
  }
  ranked.sort((first, second) => second.score - first.score);
  let best = null;
  let bestScore = -Infinity;
  const measured = { groups: new Map(), bound: new Map() };
  for (const { defenceType } of ranked.slice(0, DEFENCE_TYPES_FILLED)) {
    let current = { ...build, gear: { level, items: itemsFor(build, gear, defenceType, weaponKey, level) } };
    current = meetNeeds(current, gear, engine, 'resistance');
    current = meetNeeds(current, gear, engine, 'attribute');
    current = tradeSpareResistance(current, gear, engine);
    current = fillByScore(current, gear, engine, measured);
    const score = engine.evaluate(current);
    if (score > bestScore) {
      best = current;
      bestScore = score;
    }
  }
  return best ? withBestBaseItems(best, gear, engine, measured) : best;
}

// Each item's base item, chosen on the finished set: every base of its slot is tried with the item's affixes (those
// the base allows), the best kept while it raises the score, then the set is completed again (an Experimented base
// may take more affixes, another may have dropped some). Bases first ranked bare misjudge it, as the defence types do.
function withBestBaseItems(build, gear, engine, measured) {
  let current = build;
  let currentScore = engine.evaluate(current);
  let changed = false;
  for (let position = 0; position < current.gear.items.length; position += 1) {
    const item = current.gear.items[position];
    let best = null;
    for (const candidate of gear.bases[item.key]?.baseItems || []) {
      if (candidate.name === item.baseItem?.name) {
        continue;
      }
      const moved = onBaseItem(item, gear, candidate.name, current.gear.level);
      if (!moved) {
        continue;
      }
      const items = [...current.gear.items];
      items[position] = moved;
      const trial = { ...current, gear: { ...current.gear, items } };
      const score = engine.evaluate(trial);
      if (score > currentScore * (1 + MIN_FILL_GAIN) && (!best || score > best.score)) {
        best = { score, trial };
      }
    }
    if (best) {
      current = best.trial;
      currentScore = best.score;
      changed = true;
    }
  }
  if (!changed) {
    return current;
  }
  current = meetNeeds(current, gear, engine, 'resistance');
  current = meetNeeds(current, gear, engine, 'attribute');
  current = tradeSpareResistance(current, gear, engine);
  return fillByScore(current, gear, engine, { groups: new Map(measured.groups), bound: new Map() });
}

// Which weapon base the build holds (with a shield: a wand, rune dagger or sceptre for spells, a one-handed melee base
// for attacks), chosen by the bare bases, the way the defence types are first ranked. null when no hand is solved.
function bestWeaponKey(build, gear, engine, level) {
  const keys = weaponKeysOf(build).filter(key => gear.bases[key]);
  if (keys.length <= 1) {
    return keys[0] || null;
  }
  let best = null;
  let bestScore = -Infinity;
  for (const key of keys) {
    const items = itemsFor(build, gear, 'int', key, level);
    const score = engine.evaluate({ ...build, gear: { level, items } });
    if (score > bestScore) {
      best = key;
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
  // The weapon base it already holds, or the best one when a unique weapon left.
  const heldWeapon = kept.find(item => item.slot === 'weapon');
  const weaponKey = heldWeapon ? heldWeapon.key : bestWeaponKey(build, gear, engine, build.gear.level);
  for (const item of itemsFor(build, gear, defenceType, weaponKey, build.gear.level)) {
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
  items[position] = { ...item, prefixes: item.prefixes.filter(entry => entry !== affix), suffixes: item.suffixes.filter(entry => entry !== affix),
    implicits: (item.implicits || []).filter(entry => entry !== affix), groups };
  return { ...build, gear: { ...build.gear, items } };
}

function withAffix(build, position, affix) {
  const items = [...build.gear.items];
  items[position] = place(items[position], affix);
  return { ...build, gear: { ...build.gear, items } };
}

// The rest by score: each step tries every distinct affix that still fits somewhere (in the first item that takes
// it, or for local defences the item where it adds most) and keeps the best, while it raises the score.
//
// Estimate first (2026-11-27, when every mod source made the pools ten times larger): at each measuring (every
// FILL_REFRESH_STEPS steps) every stat group the candidates carry is measured once on the build as it stands (one
// trial per group, scaled by the number, as the tree planner does), and each affix is estimated as the sum of its
// lines. An affix whose lines belong to its own item (local defences, a weapon's own damage, lines for socketed
// gems), which no group trial can measure, is scored exactly at each measuring, and that gain stands as its estimate
// until the next. Only the FILL_EXACT_TRIALS best estimates are scored exactly at each step.
const FILL_REFRESH_STEPS = 12;
const FILL_EXACT_TRIALS = 12;

// measured: the gains measured so far in this solve ({groups, bound}), shared by its fills: the defence types'
// sets and the refill after the bases differ little, so a fill starts from the last measuring and measures again
// after FILL_REFRESH_STEPS steps; what was never measured is measured when first met.
function fillByScore(build, gear, engine, measured = { groups: new Map(), bound: new Map() }) {
  let current = build;
  let currentScore = engine.evaluate(current);
  const mayMatter = engine.affixFilterFor ? engine.affixFilterFor(build) : () => true;
  let groupGains = measured.groups;
  let boundGains = measured.bound;
  for (let step = 0; step < 60; step += 1) {
    const candidates = fillCandidates(current, gear, mayMatter);
    if (step > 0 && step % FILL_REFRESH_STEPS === 0) {
      groupGains = new Map();
      boundGains = new Map();
    }
    measureGroups(current, currentScore, candidates, engine, groupGains);
    measureBound(current, currentScore, candidates, engine, boundGains);
    const estimated = [];
    for (const candidate of candidates) {
      const estimate = candidate.itemBound ? boundGains.get(candidate.key) : estimateOf(candidate, groupGains);
      if (estimate > 0) {
        estimated.push({ ...candidate, estimate });
      }
    }
    estimated.sort((first, second) => second.estimate - first.estimate);
    const exact = estimated.slice(0, FILL_EXACT_TRIALS);
    let best = null;
    for (const candidate of exact) {
      const trial = withAffix(current, candidate.position, candidate.affix);
      const score = engine.evaluate(trial);
      if (!best || score > best.score) {
        best = { score, trial };
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

// Every distinct affix that still fits somewhere (in the first item that takes it, or, for one bound to its item,
// each item), with its lines as that item gives them.
function fillCandidates(build, gear, mayMatter) {
  const candidates = [];
  const seen = new Set();
  for (let position = 0; position < build.gear.items.length; position += 1) {
    const item = build.gear.items[position];
    for (const affix of candidatesFor(item, gear, build.gear.level)) {
      if (!mayMatter(affix)) {
        continue;
      }
      const effects = affixEffectsOn(item, affix);
      const itemBound = effects.some(effect => effect.local || effect.weaponHand || effect.socketed || typeof effect.value !== 'number');
      const magnitude = item.baseItem?.exp?.mag?.[affix.affix] || 0;
      const key = itemBound || magnitude ? `${affix.id}@${position}` : `${affix.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({ key, position, affix, effects, itemBound });
    }
  }
  return candidates;
}

function groupOf(effect) {
  return [effect.kind, effect.stat, (effect.tags || []).join('+'), effect.subject || '', effect.condition || '',
    (effect.requires || []).join('+'), effect.skill || ''].join('|');
}

// Each stat group's gain per unit on the build as it stands, for the groups not measured yet (into gains): one trial
// with the group's line on a stand-in item.
function measureGroups(build, score, candidates, engine, gains) {
  for (const candidate of candidates) {
    if (candidate.itemBound) {
      continue;
    }
    for (const effect of candidate.effects) {
      const group = groupOf(effect);
      if (gains.has(group) || effect.value === 0) {
        continue;
      }
      const standIn = { slot: 'standIn', key: 'standIn', baseItem: null, prefixes: [{ effects: [effect] }], suffixes: [],
        implicits: [], groups: new Set() };
      const trial = { ...build, gear: { ...build.gear, items: [...build.gear.items, standIn] } };
      gains.set(group, (engine.evaluate(trial) / score - 1) / effect.value);
    }
  }
}

// The item-bound affixes' gains not measured yet (into gains), each scored exactly on the build as it stands.
function measureBound(build, score, candidates, engine, gains) {
  for (const candidate of candidates) {
    if (candidate.itemBound && !gains.has(candidate.key)) {
      gains.set(candidate.key, engine.evaluate(withAffix(build, candidate.position, candidate.affix)) / score - 1);
    }
  }
}

function estimateOf(candidate, gains) {
  let estimate = 0;
  for (const effect of candidate.effects) {
    estimate += (gains.get(groupOf(effect)) || 0) * effect.value;
  }
  return estimate;
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
      slot: item.slot, key: item.key, craftBase: item.craftBase, baseName: item.baseItem?.name || null,
      affixes: allAffixesOf(item).map(affix => ({ id: affix.id, text: affix.shown, affix: affix.affix, tier: affix.tier,
        tierIndex: affix.tierIndex, source: affix.source })),
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
    const stored = [item.key, item.affixes.map(affix => affix.id)];
    if (item.baseName) {
      stored.push(item.baseName);
    }
    items.push(stored);
  }
  return { level: compact.level, items };
}

// One stored item in the long form: compactGear's object, or storeGear's [key, ids].
function storedItemOf(storedItem) {
  if (!Array.isArray(storedItem)) {
    return storedItem;
  }
  const [key, ids, baseName] = storedItem;
  return { key, slot: key.split(':')[0], affixes: ids.map(id => ({ id })), baseName: baseName || null };
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
    let item = newItem(storedItem.slot, storedItem.key, gear, defenceType, storedItem.baseName || null, level);
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
  const explicit = (storedItem.affixes || []).filter(affix => affix.tierIndex !== undefined && (affix.affix === 'p' || affix.affix === 's'));
  const mods = explicit.map(affix => `${affix.id}.${affix.tierIndex}${affix.source === 'bench' ? 'c' : ''}`).join('_');
  const influences = [...new Set(explicit.map(affix => affix.source).filter(source => INFLUENCE_SOURCES.has(source)))].join('+');
  const parts = [storedItem.craftBase, CRAFT_ITEM_LEVEL, influences, mods, storedItem.baseName || '']
    .map(part => encodeURIComponent(String(part)));
  return `?item=${parts.join('~')}#craft`;
}
