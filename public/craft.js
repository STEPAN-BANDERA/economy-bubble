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
// Mods only one of which survives a recombine.
const recombExclusive = x => !!(x.essence || x.crafted || x.veiled || x.elevated || x.m?.meta || x.m?.src === 'essence' || x.m?.src === 'veiled' || x.m?.src === 'bench' || x.m?.src === 'aspect');
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
export const ASPECTS = { 'Farrul, First of the Plains': 'Cat', 'Saqawal, First of the Sky': 'Avian', 'Fenumus, First of the Night': 'Spider', 'Craiceann, First of the Deep': 'Crab' };
const SIDE_NAME = { p: 'prefix', s: 'suffix' };

// ---------- data ----------
const localDefence = m => m.groups.some(g => /^(DefencesPercent|BaseLocalDefences)/.test(g));
const defenceKind = m => ['armour', 'evasion', 'energy_shield'].filter(t => m.tags.includes(t)).join('+');
export function prepareBase(raw, index) {
  const info = index.bases[raw.id];
  const half = index.groups[info.group].maxAffix / 2;
  let mods = raw.mods.map(([id, text, affix, src, groups, tags, tiers, x]) => ({
    id, text, affix, src, groups, tags, ...x,
    tiers: tiers.map(([ilvl, w, values]) => ({ ilvl, w, values })),
  }));
  // Local defence mods (flat or % Armour / Evasion / Energy Shield, and their hybrids) only go on
  // a base with those defences: the data lists every kind of bench craft and essence mod on every
  // armour base. Keep the kinds the base's own mods roll (a STR/INT base: Armour, Energy Shield,
  // Armour and Energy Shield).
  const kinds = new Set(mods.filter(m => m.src === 'base' && localDefence(m)).map(defenceKind));
  if (kinds.size) mods = mods.filter(m => m.src === 'base' || !localDefence(m) || kinds.has(defenceKind(m)));
  return { id: raw.id, name: info.name, info, max: { p: half, s: half }, slots: half * 2, mods, byId: new Map(mods.map(m => [m.id, m])) };
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
export const baseBlocks = (B, m) => {
  const L = B.limit;
  if (!L || m.src === 'bench') return false;
  if (L.noTag && m.tags.includes(L.noTag)) return true;
  return !!L.onlyDamage && m.tags.includes('damage') && DAMAGE_TYPES.some(d => d !== L.onlyDamage && m.tags.includes(d));
};
export function forBaseItem(B, name, index) {
  const x0 = name ? index.experimented?.[name] : null;
  const limit = name ? index.limits?.[name] ?? null : null;
  if (!x0 && !limit) return B;
  const x = x0 ?? { p: 0, s: 0 };
  B.variants ??= new Map();
  if (B.variants.has(name)) return B.variants.get(name);
  const max = { p: Math.max(0, B.max.p + x.p), s: Math.max(0, B.max.s + x.s) };
  const mul = side => 1 + (x.mag?.[side] ?? 0) / 100;
  const scale = v => (Array.isArray(v) ? v.map(scale) : typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  const mods = B.mods.map(m => {
    const f = m.affix === 'p' || m.affix === 's' ? mul(m.affix) : 1;
    if (f === 1) return m;
    const by = v => (Array.isArray(v) ? v.map(by) : typeof v === 'number' ? (Number.isInteger(v) ? Math.trunc(v * f) : v * f) : v);
    return { ...m, tiers: m.tiers.map(t => ({ ...t, values: scale(t.values.map(by)) })) };
  });
  const V = { ...B, name, item: name, exp: x0, max, magicMax: { p: Math.max(0, 1 + x.p), s: Math.max(0, 1 + x.s) },
    slots: max.p + max.s, mods, byId: new Map(mods.map(m => [m.id, m])), innateInfl: x.allInfl ? [...INFLUENCES] : null, limit };
  delete V.variants;
  B.variants.set(name, V);
  return V;
}

// A mod's text with a tier's numbers filled in: "+(80-89) to maximum Life".
export function modText(m, t) {
  const vals = (m.tiers[t] ?? m.tiers[m.tiers.length - 1]).values;
  let i = 0;
  return m.text.replace(/#/g, () => {
    const v = vals[i++];
    return v == null ? '#' : Array.isArray(v) ? (v[0] === v[1] ? v[0] : `(${v[0]}-${v[1]})`) : v;
  });
}
// In-game tier name: T1 is the best tier that can roll at this item level.
export function tierLabel(m, t, ilvl = 100) {
  const top = m.tiers.reduce((k, x, i) => (x.ilvl <= ilvl ? i : k), 0);
  return 'T' + (top - t + 1);
}

// ---------- items ----------
export function newItem(B, { ilvl = 86, infl = [], rarity = 'normal' } = {}) {
  return { B, ilvl, infl: [...infl], rarity, mods: [], eld: null, imprint: null, veilOptions: null };
}
export const clone = it => ({ ...it, infl: [...it.infl], mods: it.mods.map(x => ({ ...x })), eld: it.eld && { ...it.eld } });
const maxAff = it => (it.rarity === 'magic' ? it.B.magicMax ?? { p: 1, s: 1 } : it.B.max);
export const count = (it, side) => it.mods.reduce((n, x) => n + (x.side === side), 0);
export function metaFlags(it) {
  const f = {};
  for (const x of it.mods) if (x.m?.meta) f[x.m.meta] = true;
  return f;
}
const locked = (it, side) => { const f = metaFlags(it); return side === 'p' ? !!f.nchg_pre : !!f.nchg_suf; };
const benchCount = it => it.mods.filter(x => x.crafted).length;
const groupsOf = it => new Set(it.mods.flatMap(x => x.m?.groups ?? []));
// Dominant eldritch side: Searing Exarch (red) rules prefixes, Eater of Worlds (blue) suffixes.
export function dominance(it) {
  const e = it.eld;
  if (!e || (!e.r && !e.b)) return null;
  const r = e.r ? e.r.t + 1 : 0, b = e.b ? e.b.t + 1 : 0;
  return r === b ? null : r > b ? 'p' : 's';
}

function fossilWeights(fossils) {
  if (!fossils?.length) return null;
  const F = { more: {}, less: {}, block: new Set(), ids: new Set() };
  for (const f of fossils) {
    F.ids.add(String(f.id));
    for (const [k, v] of Object.entries(f.more)) F.more[k] = (F.more[k] ?? 1) * v;
    for (const [k, v] of Object.entries(f.less)) F.less[k] = (F.less[k] ?? 1) * v;
    for (const k of f.block) F.block.add(k);
  }
  return F;
}
const tagHit = (m, k) => k.split('+').every(t => m.tags.includes(t));
function fossilMult(m, F) {
  if (!m.tags.length) return F.ids.has('23') ? 0 : 1; // Opulent: untagged mods can't roll
  for (const k of F.block) if (tagHit(m, k)) return 0;
  let mult = 1;
  for (const [k, v] of Object.entries(F.more)) if (tagHit(m, k)) mult *= v;
  for (const [k, v] of Object.entries(F.less)) if (tagHit(m, k)) mult *= v;
  return mult;
}

// Everything that can roll right now: [{m, t, w}]. opts: {fossils, side, src}
export function pool(it, opts = {}) {
  const max = maxAff(it), blocked = groupsOf(it), meta = metaFlags(it);
  const open = { p: count(it, 'p') < max.p, s: count(it, 's') < max.s };
  const srcs = new Set(opts.src ?? ['base', ...it.infl]);
  const F = fossilWeights(opts.fossils);
  if (F) srcs.add('fossil');
  const out = [];
  for (const m of it.B.mods) {
    if (!srcs.has(m.src) || (m.affix !== 'p' && m.affix !== 's') || !open[m.affix]) continue;
    if (opts.side && m.affix !== opts.side) continue;
    if (m.src === 'fossil' && !(F && F.ids.has(String(m.fossil)))) continue;
    if (m.groups.some(g => blocked.has(g))) continue;
    if ((meta.no_attack && m.tags.includes('attack')) || (meta.no_caster && m.tags.includes('caster'))) continue;
    if (baseBlocks(it.B, m)) continue;
    if (opts.tagOnly && !m.tags.includes(opts.tagOnly)) continue;
    let mult = F && m.src !== 'veiled' ? fossilMult(m, F) : 1;
    if (opts.tagMult && m.tags.includes(opts.tagMult)) mult *= 10; // Harvest: that type is more common
    if (opts.boost?.has(m)) mult *= 10; // Harvest "more likely": the same mod types as before
    if (!mult) continue;
    m.tiers.forEach((tr, t) => { if (tr.ilvl <= it.ilvl && tr.w > 0) out.push({ m, t, w: tr.w * mult }); });
  }
  return out;
}

function pick(entries, rnd) {
  let total = 0;
  for (const e of entries) total += e.w;
  let x = rnd() * total;
  for (const e of entries) if ((x -= e.w) < 0) return e;
  return entries[entries.length - 1];
}
const pickN = (dist, rnd) => { let x = rnd(); for (const [n, p] of dist) if ((x -= p) < 0) return n; return dist[dist.length - 1][0]; };

function addRandom(it, n, opts, rnd) {
  const got = [];
  for (let i = 0; i < n; i++) {
    const es = pool(it, opts);
    if (!es.length) break;
    const e = pick(es, rnd);
    const x = { m: e.m, t: e.t, side: e.m.affix };
    it.mods.push(x);
    got.push(x);
  }
  return got;
}
const removable = (it, side) => it.mods.filter(x => !x.frac && (!side || x.side === side) && !locked(it, x.side));
function removeRandom(it, rnd, side) {
  const xs = removable(it, side);
  if (!xs.length) return null;
  const x = xs[Math.floor(rnd() * xs.length)];
  it.mods.splice(it.mods.indexOf(x), 1);
  return x;
}
// Reroll everything that isn't fractured or protected by a bench metamod.
function reroll(it, keepFilter = () => false) {
  it.mods = it.mods.filter(x => x.frac || locked(it, x.side) || keepFilter(x));
}
const rareCount = (it, rnd) => pickN(RARE_COUNTS[it.B.slots] ?? RARE_COUNTS[6], rnd);

// One currency on an item, like the game. Returns {ok, msg, spent: {name: n}}.
// it is changed in place; pass clone(item) to keep the original.
export function apply(it, action, arg, rnd = Math.random) {
  const spent = {};
  const pay = (name, n = 1) => { spent[name] = (spent[name] ?? 0) + n; };
  const fail = msg => ({ ok: false, msg, spent: {} });
  const hasVeiled = () => it.mods.some(x => x.veiled);
  const metaOtherThanMulti = () => it.mods.some(x => x.m?.meta && x.m.meta !== 'mul_mods');
  const done = msg => ({ ok: true, msg, spent });
  switch (action) {
    case 'transmute': {
      if (it.rarity !== 'normal') return fail('Needs a normal item');
      it.rarity = 'magic'; addRandom(it, 1, {}, rnd); pay(CUR.transmute); return done('Now magic');
    }
    case 'alt': {
      if (it.rarity !== 'magic') return fail('Needs a magic item');
      reroll(it); addRandom(it, pickN(MAGIC_COUNTS, rnd), {}, rnd); pay(CUR.alt); return done('Rerolled the magic mods');
    }
    case 'aug': {
      if (it.rarity !== 'magic' || it.mods.length >= 2) return fail('Needs a magic item with one mod');
      addRandom(it, 1, {}, rnd); pay(CUR.aug); return done('Added a mod');
    }
    case 'regal': {
      if (it.rarity !== 'magic') return fail('Needs a magic item');
      it.rarity = 'rare'; addRandom(it, 1, {}, rnd); pay(CUR.regal); return done('Now rare, one mod added');
    }
    case 'alch': {
      if (it.rarity !== 'normal') return fail('Needs a normal item');
      it.rarity = 'rare'; addRandom(it, rareCount(it, rnd), {}, rnd); pay(CUR.alch); return done('Now rare');
    }
    case 'chaos': {
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      // A locked side keeps its mods, but new ones can still land in its free slots.
      reroll(it);
      addRandom(it, Math.max(0, rareCount(it, rnd) - it.mods.length), {}, rnd);
      pay(CUR.chaos); return done('Rerolled');
    }
    case 'exalt': {
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (!addRandom(it, 1, {}, rnd).length) return fail('No room for another mod');
      pay(CUR.exalt); return done('Added a mod');
    }
    case 'annul': {
      if (it.rarity === 'normal') return fail('Needs a magic or rare item');
      if (!removeRandom(it, rnd)) return fail('Nothing that can be removed');
      pay(CUR.annul); return done('Removed a random mod');
    }
    case 'matron': { // Wild Bristle Matron: a random craftable metamod that fits
      const f = metaFlags(it);
      if (it.rarity === 'normal') return fail('Needs a magic or rare item');
      if (benchCount(it) >= (f.mul_mods ? 3 : 1)) return fail('Already has a crafted mod');
      const fits = it.B.mods.filter(m => m.meta && m.src === 'bench' && !f[m.meta] && count(it, m.affix) < maxAff(it)[m.affix]);
      if (!fits.length) return fail('No metamod fits');
      const m = fits[Math.floor(rnd() * fits.length)];
      it.mods.push({ m, t: 0, side: m.affix, crafted: true });
      pay(MATRON); return done('Matron added "' + m.text + '"');
    }
    case 'hswap': { // Harvest: change a resistance into another element (arg: Fire/Cold/Lightning)
      const x = it.mods.find(y => y.m && !y.frac && y.m.src === 'base' && RES_RE.test(y.m.text) && !y.m.text.includes(arg));
      if (!x) return fail(`No other single resistance to change into ${arg}`);
      const to = it.B.mods.find(m => m.src === 'base' && m.affix === x.m.affix && m.text === `+#% to ${arg} Resistance`);
      if (!to || it.mods.some(y => y.m === to)) return fail(`Already has ${arg} resistance`);
      const fromTop = x.m.tiers.length - x.t;
      x.m = to; x.t = Math.max(0, to.tiers.length - fromTop);
      pay(lifeforce(RES_SWAP[arg]), RES_SWAP_AMOUNT); return done(`Changed to ${arg} resistance`);
    }
    case 'hdswap': { // Harvest + Rancour: change a fire/cold/lightning damage mod into arg's element
      const x = it.mods.find(y => y.m && !y.frac && damageSwap(it.B, y.m, arg) && !it.mods.some(z => z.m === damageSwap(it.B, y.m, arg)));
      if (!x) return fail(`No other elemental damage mod to change into ${arg}`);
      const to = damageSwap(it.B, x.m, arg);
      x.t = swapTier(x.m, x.t, to); x.m = to;
      pay(lifeforce(RES_SWAP[arg]), RES_SWAP_AMOUNT); pay(RANCOUR, DMG_SWAP_RANCOUR); return done(`Changed to ${arg} damage: ${modText(x.m, x.t)}`);
    }
    case 'fracture': {
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (it.mods.some(x => x.frac)) return fail('Already fractured');
      if (it.infl.length) return fail("Fracturing Orbs can't be used on influenced items");
      const xs = it.mods.filter(x => x.m && !x.crafted && !x.veiled);
      if (xs.length < 4) return fail('Needs at least 4 mods');
      const x = xs[Math.floor(rnd() * xs.length)];
      x.frac = true;
      pay('Fracturing Orb'); return done('Fractured: ' + modText(x.m, x.t));
    }
    case 'harvest': { // arg: tag. Reforge with one guaranteed mod of that type; the type is more common.
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (!HARVEST_REFORGE[arg]) return fail('Unknown type');
      // Harvest respects "Prefixes/Suffixes Cannot Be Changed": the locked side stays.
      // (New mods, the guaranteed one too, can also land in the locked side's free slots.)
      reroll(it);
      const n = rareCount(it, rnd);
      if (!addRandom(it, 1, { tagOnly: arg }, rnd).length) return fail('No mod of that type can roll');
      addRandom(it, Math.max(0, n - it.mods.length), { tagMult: arg }, rnd);
      const [c, amt, rc] = HARVEST_REFORGE[arg];
      pay(lifeforce(c), amt); if (rc) pay(RANCOUR, rc); return done(`Harvest reforge (${arg})`);
    }
    case 'hadd': { // Harvest: add a new mod of a type (arg: tag) and remove another random mod
      if (it.rarity === 'normal') return fail('Needs a magic or rare item');
      if (it.infl.length) return fail('Only works on non-influenced items');
      if (!HARVEST_ADD[arg]) return fail('No add craft for that type');
      // The new mod goes on first, then another random mod goes (never the new one).
      // With no room for a mod of the type, the removal comes first to make some.
      const before = it.mods.slice();
      let gone;
      const [nx] = addRandom(it, 1, { tagOnly: arg }, rnd);
      if (nx) {
        const newMod = it.mods[it.mods.length - 1];
        it.mods.splice(it.mods.length - 1, 1);
        gone = removeRandom(it, rnd);
        it.mods.push(newMod);
        if (!gone) { it.mods = before; return fail('Nothing else that can be removed'); }
      } else {
        gone = removeRandom(it, rnd);
        if (!gone) return fail('Nothing that can be removed');
        if (!addRandom(it, 1, { tagOnly: arg }, rnd).length) { it.mods = before; return fail(`No ${arg} mod can roll here`); }
      }
      const [c, amt] = HARVEST_ADD[arg];
      pay(lifeforce(c), amt); pay(SACRED);
      return done(`Harvest: added a ${arg} mod, removed "${gone.veiled ? 'veiled mod' : modText(gone.m, gone.t)}"`);
    }
    case 'iexalt': { // Crusader's/Hunter's/... Exalted Orb (arg: influence): adds the influence and one of its mods
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (it.infl.length) return fail('Only works on non-influenced items');
      if (it.mods.some(x => x.frac)) return fail("Influenced Exalted Orbs don't work on fractured items");
      const before = it.infl;
      it.infl = [arg];
      if (!addRandom(it, 1, { src: [arg] }, rnd).length) { it.infl = before; return fail(`No ${arg} mod fits`); }
      pay(influenceExalt(arg)); return done(`Added ${arg} influence and an influenced mod`);
    }
    case 'hinfl': { // Harvest: randomise the influence types, and reforge the item
      if (!it.infl.length) return fail('Needs an influenced item');
      const pool6 = INFLUENCES.slice();
      const n = it.infl.length;
      it.infl = [];
      while (it.infl.length < n) it.infl.push(pool6.splice(Math.floor(rnd() * pool6.length), 1)[0]);
      if (it.rarity !== 'normal') {
        it.mods = it.mods.filter(x => x.frac);
        addRandom(it, it.rarity === 'magic' ? Math.max(0, pickN(MAGIC_COUNTS, rnd) - it.mods.length) : Math.max(0, rareCount(it, rnd) - it.mods.length), {}, rnd);
      }
      pay(lifeforce(INFLUENCE_RANDOMISE[0]), INFLUENCE_RANDOMISE[1]); return done(`Influence is now ${it.infl.join(' + ')}${it.rarity === 'normal' ? '' : ', mods reforged'}`);
    }
    case 'hinflref': { // Harvest: reforge an influenced rare, with at least one influenced mod
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (!it.infl.length) return fail('Needs an influenced item');
      const hl = locked(it, 'p') ? 'p' : locked(it, 's') ? 's' : null;
      const hside = hl ? (hl === 'p' ? 's' : 'p') : undefined;
      const before = it.mods.slice();
      reroll(it);
      const n = rareCount(it, rnd);
      if (!addRandom(it, 1, { src: it.infl, side: hside }, rnd).length) { it.mods = before; return fail('No influenced mod can roll'); }
      addRandom(it, Math.max(0, n - it.mods.length), { side: hside }, rnd);
      pay(lifeforce(HARVEST_INFLUENCE[0]), HARVEST_INFLUENCE[1]); pay(SACRED); return done('Harvest reforge with an influenced mod');
    }
    case 'awaken': { // Awakener's Orb with another item. arg: influence, or {infl, mod, tier} for that item's influenced mod
      const inf = typeof arg === 'string' ? arg : arg.infl;
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (it.infl.length !== 1) return fail('Needs an item with exactly one influence');
      if (it.infl.includes(inf)) return fail(`Already ${inf}-influenced`);
      if (it.mods.some(x => x.frac)) return fail("The Awakener's Orb doesn't work on fractured items");
      // One influenced mod from each item (random if an item has several).
      const own = it.mods.filter(x => x.m && it.infl.includes(x.m.src));
      const keep = own.length ? [own[Math.floor(rnd() * own.length)]] : [];
      it.infl = [it.infl[0], inf];
      it.mods = [...it.mods.filter(x => x.frac && !keep.includes(x)), ...keep];
      let theirs = null;
      if (arg.mod) theirs = { m: arg.mod, t: arg.tier ?? 0, side: arg.mod.affix };
      else { const [x] = addRandom(it, 1, { src: [inf] }, rnd); if (x) { it.mods.pop(); theirs = x; } }
      // Two kept mods of the same mod group: one of them is dropped at random.
      if (theirs && keep.length && theirs.m.groups.some(g => keep[0].m.groups.includes(g))) { if (rnd() < 0.5) it.mods = it.mods.filter(x => x !== keep[0]); else theirs = null; }
      if (theirs) it.mods.push(theirs);
      addRandom(it, Math.max(0, rareCount(it, rnd) - it.mods.length), {}, rnd);
      pay(AWAKENER);
      const names = [...keep, theirs].filter(x => x && it.mods.includes(x)).map(x => `"${modText(x.m, x.t)}"`);
      return done(`Now ${it.infl.join(' + ')}: kept ${names.length ? names.join(' and ') : 'no influenced mod'}; the rest reforged`);
    }
    case 'hmore': { // Harvest: reforge, much more likely to get the same mod types
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      const boost = new Set(it.mods.filter(x => x.m && !x.frac).map(x => x.m));
      const ml = locked(it, 'p') ? 'p' : locked(it, 's') ? 's' : null;
      reroll(it);
      addRandom(it, Math.max(0, rareCount(it, rnd) - it.mods.length), { boost, side: ml ? (ml === 'p' ? 's' : 'p') : undefined }, rnd);
      pay(lifeforce(HARVEST_MORE_LIKELY[0]), HARVEST_MORE_LIKELY[1]); return done('Harvest reforge, more likely the same types');
    }
    case 'scour': {
      if (it.rarity === 'normal') return fail('Already normal');
      reroll(it, () => false);
      if (!it.mods.length) it.rarity = 'normal';
      pay(CUR.scour); return done(it.mods.length ? 'Removed the unprotected side' : 'Now normal');
    }
    case 'essence': { // arg: {mod, tier, name}
      if (metaOtherThanMulti()) return fail('Essences can\'t be used on an item with a metamod');
      if (it.rarity === 'magic') return fail('Needs a normal or rare item');
      reroll(it, () => false);
      it.mods = it.mods.filter(x => x.frac);
      if (it.mods.some(x => x.m.groups.some(g => arg.mod.groups.includes(g)))) return fail('A fractured mod blocks this essence');
      it.rarity = 'rare';
      it.mods.push({ m: arg.mod, t: arg.tier, side: arg.mod.affix, essence: true });
      const cap = ESSENCE_MOD_LEVEL[arg.mod.essence], ilvl0 = it.ilvl;
      if (cap) it.ilvl = Math.min(it.ilvl, cap); // the other mods roll as if the item were this level
      addRandom(it, Math.max(0, rareCount(it, rnd) - it.mods.length), {}, rnd);
      it.ilvl = ilvl0;
      pay(arg.name); return done(cap ? `Reforged with the essence mod (other mods level ${cap} and below)` : 'Reforged with the essence mod');
    }
    case 'fossil': { // arg: [fossils]
      if (metaOtherThanMulti()) return fail('Fossils can\'t be used on an item with a metamod');
      if (it.rarity === 'magic') return fail('Needs a normal or rare item');
      it.rarity = 'rare';
      it.mods = it.mods.filter(x => x.frac);
      addRandom(it, Math.max(0, rareCount(it, rnd) - it.mods.length), { fossils: arg }, rnd);
      for (const f of arg) pay(f.name);
      if (arg.length > 0) pay(RESONATORS[arg.length - 1]);
      return done('Reforged with fossils');
    }
    case 'vchaos': {
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (hasVeiled()) return fail('Unveil the veiled mod first');
      reroll(it);
      const open = ['p', 's'].filter(s => count(it, s) < it.B.max[s]);
      if (!open.length) return fail('No room for a veiled mod');
      const side = open[Math.floor(rnd() * open.length)];
      it.mods.push({ m: null, t: 0, side, veiled: true });
      addRandom(it, Math.max(0, rareCount(it, rnd) - it.mods.length), {}, rnd);
      pay(CUR.vchaos); return done(`Rerolled with a veiled ${SIDE_NAME[side]}`);
    }
    case 'vexalt': {
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (hasVeiled()) return fail('Unveil the veiled mod first');
      if (!removeRandom(it, rnd)) return fail('Nothing that can be removed');
      const open = ['p', 's'].filter(s => count(it, s) < it.B.max[s]);
      const side = open[Math.floor(rnd() * open.length)];
      it.mods.push({ m: null, t: 0, side, veiled: true });
      pay(CUR.vexalt); return done(`Removed a mod, added a veiled ${SIDE_NAME[side]}`);
    }
    case 'unveil': { // offers 3 veiled mods for the veiled slot
      const v = it.mods.find(x => x.veiled);
      if (!v) return fail('No veiled mod');
      const blocked = groupsOf(it);
      let es = it.B.mods.filter(m => m.src === 'veiled' && m.affix === v.side && !m.groups.some(g => blocked.has(g)) && !baseBlocks(it.B, m))
        .map(m => ({ m, t: 0, w: m.tiers[0].w })).filter(e => e.w > 0);
      const offers = [];
      while (offers.length < 3 && es.length) { const e = pick(es, rnd); offers.push(e.m); es = es.filter(x => x.m !== e.m); }
      it.veilOptions = offers;
      return done('Pick one of the offered mods');
    }
    case 'unveilPick': {
      const v = it.mods.find(x => x.veiled), m = it.veilOptions?.[arg];
      if (!v || !m) return fail('Unveil first');
      Object.assign(v, { m, t: 0, veiled: false, unveiled: true });
      it.veilOptions = null;
      return done('Unveiled');
    }
    case 'ember': case 'ichor': { // arg: tier index
      if (it.infl.length) return fail('Influenced items can\'t take eldritch implicits');
      if (!it.B.info.eldritch) return fail('Only body armours, helmets, gloves and boots');
      const key = action === 'ember' ? 'r' : 'b';
      if (arg > EMBER_MAX_TIER) return fail('Embers and Ichors go up to Exceptional; higher tiers come from Orbs of Conflict');
      const es = it.B.mods.filter(m => m.affix === key && m.tiers[arg] && m.tiers[arg].w > 0).map(m => ({ m, t: arg, w: m.tiers[arg].w }));
      if (!es.length) return fail('No eldritch implicit of that tier for this base');
      const e = pick(es, rnd);
      it.eld = { ...(it.eld ?? {}), [key]: { m: e.m, t: arg } };
      pay(`${ELDRITCH_TIERS[arg]} Eldritch ${action === 'ember' ? 'Ember' : 'Ichor'}`);
      return done(`${action === 'ember' ? 'Searing Exarch' : 'Eater of Worlds'} implicit set`);
    }
    case 'echaos': case 'eexalt': case 'eannul': {
      const side = dominance(it);
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (!side) return fail('Needs a dominant eldritch implicit (one stronger than the other)');
      if (action === 'echaos') {
        it.mods = it.mods.filter(x => x.frac || x.side !== side);
        const n = Math.min(it.B.max[side], Math.max(0, rareCount(it, rnd) - it.mods.length));
        addRandom(it, n, { side }, rnd);
        pay(CUR.echaos); return done(`Rerolled the ${SIDE_NAME[side]}es`);
      }
      if (action === 'eexalt') {
        if (!addRandom(it, 1, { side }, rnd).length) return fail(`No room for another ${SIDE_NAME[side]}`);
        pay(CUR.eexalt); return done(`Added a ${SIDE_NAME[side]}`);
      }
      if (!removeRandom(it, rnd, side)) return fail(`No ${SIDE_NAME[side]} to remove`);
      pay(CUR.eannul); return done(`Removed a random ${SIDE_NAME[side]}`);
    }
    case 'conflict': {
      const e = it.eld;
      if (!e?.r || !e?.b) return fail('Needs both eldritch implicits');
      const [up, down] = rnd() < conflictUp(e.r.t, e.b.t) ? ['r', 'b'] : ['b', 'r'];
      const n = it.B.mods.find(m => m === e[up].m).tiers.length;
      if (e[up].t < n - 1) e[up] = { ...e[up], t: e[up].t + 1 };
      if (e[down].t === 0) e[down] = null; else e[down] = { ...e[down], t: e[down].t - 1 };
      pay(CUR.conflict);
      return done(`${up === 'r' ? 'Exarch' : 'Eater'} implicit up a tier, the other down`);
    }
    case 'dominance': {
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (!DOMINANCE_GROUPS.has(it.B.info.group)) return fail('Only works on body armours, boots, gloves and helmets');
      const xs = it.mods.filter(x => x.m && it.infl.includes(x.m.src) && !locked(it, x.side));
      if (xs.length < 2) return fail('Needs at least two influenced mods');
      const rem = xs.splice(Math.floor(rnd() * xs.length), 1)[0];
      const up = xs[Math.floor(rnd() * xs.length)];
      it.mods.splice(it.mods.indexOf(rem), 1);
      if (up.t < up.m.tiers.length - 1) up.t++; else up.elevated = true;
      pay(CUR.dominance);
      return done(`Removed ${rem.m.text.replace(/#/g, 'X')}; upgraded ${up.m.text.replace(/#/g, 'X')}`);
    }
    case 'bench': { // arg: {mod, tier}
      const m = arg.mod, f = metaFlags(it);
      if (it.rarity === 'normal') return fail('Needs a magic or rare item');
      if (benchCount(it) >= (f.mul_mods ? 3 : 1) && m.meta !== 'mul_mods') return fail('Already has a crafted mod');
      if (count(it, m.affix) >= maxAff(it)[m.affix]) return fail(`No room for a ${SIDE_NAME[m.affix]}`);
      if (m.groups.some(g => groupsOf(it).has(g))) return fail('The item already has a mod of this kind');
      it.mods.push({ m, t: arg.tier, side: m.affix, crafted: true });
      for (const [k, v] of Object.entries(m.cost?.[arg.tier] ?? {})) pay(k, v);
      return done('Crafted');
    }
    case 'unbench': {
      const before = it.mods.length;
      it.mods = it.mods.filter(x => !x.crafted);
      return before === it.mods.length ? fail('No crafted mods') : done('Removed crafted mods');
    }
    case 'imprint': {
      if (it.rarity !== 'magic') return fail('Imprints only work on magic items');
      it.imprint = clone({ ...it, imprint: null });
      pay(CUR.imprint); return done('Imprint saved');
    }
    case 'restore': {
      if (!it.imprint) return fail('No imprint');
      const saved = it.imprint;
      Object.assign(it, clone(saved), { imprint: null });
      return done('Restored the imprint');
    }
    case 'wolf': case 'lynx': { // wolf: prefix -> suffix, lynx: suffix -> prefix
      const [from, to] = action === 'wolf' ? ['p', 's'] : ['s', 'p'];
      if (it.rarity !== 'rare') return fail('Needs a rare item');
      if (count(it, to) >= it.B.max[to]) return fail(`No room for a ${SIDE_NAME[to]}`);
      if (!removeRandom(it, rnd, from)) return fail(`No ${SIDE_NAME[from]} to remove`);
      addRandom(it, 1, { side: to }, rnd);
      pay(action === 'wolf' ? CUR.wolf : CUR.lynx);
      return done(`Swapped a ${SIDE_NAME[from]} for a ${SIDE_NAME[to]}`);
    }
    case 'aspect': { // arg: beast name
      if (!it.B.info.recomb || it.B.info.group === 1) return fail('Aspects go on armour and weapons');
      if (count(it, 's') >= it.B.max.s) return fail('No room for a suffix');
      const m = it.B.mods.find(x => x.src === 'beast' && x.text.includes(ASPECTS[arg]));
      if (!m) return fail('No aspect for this base');
      if (it.mods.some(x => x.m?.src === 'beast')) return fail('Already has an aspect');
      it.mods.push({ m, t: 0, side: 's', beast: true });
      pay(arg); return done('Aspect added');
    }
    case 'recombine': { // arg: {other, dust, gold}: the other item (same type). Both are consumed.
      const o = arg.other ?? arg;
      if (!it.B.info.recomb || o.B.info.recomb !== it.B.info.recomb) return fail('Needs two items of the same recombinator type');
      const infl = rnd() < 0.5 ? it.infl : o.infl;
      // Item level: the average plus 2, never above the higher one.
      const res = newItem(it.B, { ilvl: Math.min(Math.max(it.ilvl, o.ilvl), Math.floor((it.ilvl + o.ilvl) / 2 + 2)), infl, rarity: 'rare' });
      for (const side of ['p', 's']) {
        let cand = [...it.mods, ...o.mods].filter(x => x.side === side && x.m && (!['shaper', 'elder', 'crusader', 'hunter', 'warlord', 'redeemer'].includes(x.m.src) || infl.includes(x.m.src)));
        const k = pickN(Object.entries(RECOMB_COUNTS[Math.min(8, cand.length)]).map(([n, p]) => [+n, p]), rnd);
        while (res.mods.filter(x => x.side === side).length < Math.min(k, it.B.max[side]) && cand.length) {
          const x = cand.splice(Math.floor(rnd() * cand.length), 1)[0];
          if (recombExclusive(x) && res.mods.some(recombExclusive)) continue; // only one exclusive mod
          if (!x.m.groups.some(g => groupsOf(res).has(g))) res.mods.push({ ...x });
        }
      }
      Object.assign(it, res);
      pay(DUST, arg.dust ?? DEFAULT_OPTIONS.recombDust); pay(GOLD, arg.gold ?? DEFAULT_OPTIONS.recombGold);
      return done('Recombined (unpredictable mode)');
    }
  }
  return fail('Unknown action');
}

// ---------- odds ----------
// A target: {m, minTier} (that mod at this tier or better), or a class:
// {any: entry => bool, label} (any one mod matching).
// The same mod can come from several sources (base, an influence, an essence, the bench):
// Craft of Exile lists each separately, in one mod group, so an item has only one of them.
// A copy with the same text and side meets a target when its values are at least as high.
export const sameMod = (a, b) => a === b || (!!a && !!b && a.text === b.text && a.affix === b.affix);
// "This tier or better" for a mod that isn't the target's own (an essence's copy, another source):
// every number's lowest roll is at least the wanted tier's lowest roll, so no roll of it is worse
// (Deafening Zeal's 17-18% counts for a 17-19% tier; "Adds 1 to 14-15" doesn't for "1-2 to 22-23").
const lowOf = v => Math.abs(Array.isArray(v) ? v[0] : v ?? 0);
const lowsReach = (a = [], b = []) => a.length === b.length && a.every((v, i) => lowOf(v) >= lowOf(b[i]));
export const meets = (T, m, t) => (m === T.m ? t >= T.minTier : sameMod(m, T.m) && lowsReach(m.tiers[t]?.values, T.m.tiers[T.minTier]?.values));
const hitBy = (T, e) => (T.any ? T.any(e) : meets(T, e.m, e.t));
const satisfied = (T, x) => x.m && (T.any ? T.any(x) : meets(T, x.m, x.t));

// Chance that adding n random mods (n drawn from dist) to `it` ends with every
// target on the item. Exact over slot limits and mod groups, with one
// approximation: a non-target pick removes the average weight of one
// non-target group on its side (instead of its own).
export function odds(it, targets, dist, opts = {}) {
  const es = pool(it, opts);
  const max = maxAff(it);
  const cap = { p: max.p - count(it, 'p'), s: max.s - count(it, 's') };
  if (opts.side) cap[opts.side === 'p' ? 's' : 'p'] = 0;
  // opts.room: slots that must stay free for later steps ({p, s}).
  const room = opts.room ?? { p: 0, s: 0 };
  const fits = (np, ns) => np <= cap.p - room.p && ns <= cap.s - room.s;
  const K = targets.length;
  const st0 = targets.map(T => (it.mods.some(x => satisfied(T, x)) ? 1 : 0));
  // Per open target: the weight that completes it and the weight that kills it
  // (same mod group, wrong tier or wrong mod).
  const hitW = new Array(K).fill(0), deadW = new Array(K).fill(0), side = targets.map(T => T.m?.affix ?? T.side);
  const other = { p: 0, s: 0 }, otherGroups = { p: new Set(), s: new Set() };
  const tGroups = targets.map(T => new Set(T.m?.groups ?? []));
  for (const e of es) {
    let used = false;
    for (let k = 0; k < K && !used; k++) {
      if (st0[k]) continue;
      if (hitBy(targets[k], e)) { hitW[k] += e.w; used = true; } else if (!targets[k].any && e.m.groups.some(g => tGroups[k].has(g))) { deadW[k] += e.w; used = true; }
    }
    if (!used) { other[e.m.affix] += e.w; e.m.groups.forEach(g => otherGroups[e.m.affix].add(g)); }
  }
  // An open target whose side is already full can't happen.
  for (let k = 0; k < K; k++) if (!st0[k] && (cap[side[k]] <= 0 || hitW[k] === 0)) return 0;
  const G = { p: Math.max(1, otherGroups.p.size), s: Math.max(1, otherGroups.s.size) };
  const memo = new Map();
  function f(st, np, ns, jp, js, left) {
    if (st.includes(2)) return 0;
    if (left === 0) return st.every(x => x === 1) && fits(np, ns) ? 1 : 0;
    const key = st.join('') + '|' + np + ns + jp + js + left;
    if (memo.has(key)) return memo.get(key);
    const pOpen = np < cap.p, sOpen = ns < cap.s;
    const Wp = pOpen ? other.p * Math.max(0, 1 - jp / G.p) : 0, Ws = sOpen ? other.s * Math.max(0, 1 - js / G.s) : 0;
    let W = Wp + Ws;
    for (let k = 0; k < K; k++) if (st[k] === 0 && (side[k] === 'p' ? pOpen : sOpen)) W += hitW[k] + deadW[k];
    let r;
    if (W <= 0) r = st.every(x => x === 1) && fits(np, ns) ? 1 : 0;
    else {
      r = 0;
      for (let k = 0; k < K; k++) {
        if (st[k] !== 0 || !(side[k] === 'p' ? pOpen : sOpen)) continue;
        const np2 = np + (side[k] === 'p'), ns2 = ns + (side[k] === 's');
        if (hitW[k]) { const s2 = st.slice(); s2[k] = 1; r += (hitW[k] / W) * f(s2, np2, ns2, jp, js, left - 1); }
        if (deadW[k]) { const s2 = st.slice(); s2[k] = 2; r += (deadW[k] / W) * f(s2, np2, ns2, jp, js, left - 1); }
      }
      if (Wp) r += (Wp / W) * f(st, np + 1, ns, jp + 1, js, left - 1);
      if (Ws) r += (Ws / W) * f(st, np, ns + 1, jp, js + 1, left - 1);
    }
    memo.set(key, r);
    return r;
  }
  let total = 0;
  for (const [n, p] of dist) total += p * f(st0, 0, 0, 0, 0, Math.max(0, n));
  return total;
}
// Mod count distribution for a reforge that keeps `kept` mods.
export function rerollDist(B, kept, sideCap = null) {
  return (RARE_COUNTS[B.slots] ?? RARE_COUNTS[6]).map(([n, p]) => [sideCap == null ? Math.max(0, n - kept) : Math.min(sideCap, Math.max(0, n - kept)), p]);
}

// Chance that the target veiled mod is among the 3 offered when unveiling.
export function unveilOdds(B, target, blockedGroups = new Set()) {
  const es = B.mods.filter(m => m.src === 'veiled' && m.affix === target.affix && !m.groups.some(g => blockedGroups.has(g)) && !baseBlocks(B, m)).map(m => ({ m, w: m.tiers[0].w })).filter(e => e.w > 0);
  const W = es.reduce((a, e) => a + e.w, 0), wt = es.find(e => e.m === target)?.w ?? 0;
  if (!wt) return 0;
  let p = wt / W;
  for (const a of es) {
    if (a.m === target) continue;
    const pa = a.w / W, W1 = W - a.w;
    p += pa * (wt / W1);
    for (const b of es) {
      if (b.m === target || b === a) continue;
      p += pa * (b.w / W1) * (wt / (W1 - b.w));
    }
  }
  return Math.min(1, p);
}

// Monte Carlo check of a single method: hit rate over n tries.
export function simulate(start, action, arg, targets, n = 20000, rnd = Math.random) {
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const it = clone(start);
    apply(it, action, typeof arg === 'function' ? arg(it) : arg, rnd);
    if (targets.every(T => it.mods.some(x => satisfied(T, x)))) hits++;
  }
  const p = hits / n;
  return { n, hits, p, ci: 1.96 * Math.sqrt(Math.max(p * (1 - p), 1 / n) / n) };
}
// Seeded random numbers, so simulations can be repeated.
export function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
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
export const tries = p => (p > 0 ? 1 / p : Infinity);
export const triesAt = (p, q) => (p >= 1 ? 1 : p > 0 ? Math.ceil(Math.log(1 - q) / Math.log(1 - p)) : Infinity);
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
// Lifeforce (and Rancour) a Harvest reforge with this type costs, in chaos.
export const harvestBill = tag => { const [c, amt, r = 0] = HARVEST_REFORGE[tag]; return bill(one(lifeforce(c), amt), r ? one(RANCOUR, r) : null); };
export const harvestCost = (tag, P) => { const [c, amt, r = 0] = HARVEST_REFORGE[tag]; return amt * P(lifeforce(c)) + (r ? r * P(RANCOUR) : 0); };
export const harvestText = tag => { const [c, amt, r = 0] = HARVEST_REFORGE[tag]; return `${amt} ${c} Lifeforce${r ? ` + ${r} Crystallised Rancour` : ''}`; };
export const HARVEST_MORE_LIKELY = ['Wild', 200];
// Add a mod of a type, removing another random mod (non-influenced items only).
export const HARVEST_ADD = {
  fire: ['Wild', 15000], cold: ['Vivid', 15000], lightning: ['Primal', 15000], physical: ['Vivid', 15000], life: ['Wild', 17500],
  defences: ['Primal', 17500], chaos: ['Vivid', 17500], attack: ['Wild', 17500], caster: ['Primal', 17500], speed: ['Vivid', 20000], critical: ['Primal', 20000],
};
export const lifeforce = colour => `${colour} Crystallised Lifeforce`;
// Harvest "change a resistance": 500 lifeforce of the target element's colour (Maxroll, 3.24).
export const RES_SWAP = { Fire: 'Wild', Cold: 'Vivid', Lightning: 'Primal' };
export const RES_SWAP_AMOUNT = 500;
export const RES_RE = /^\+#% to (Fire|Cold|Lightning) Resistance$/;
// Rancour crafts: change a fire/cold/lightning damage mod into a similar-tier one of another
// element (500 lifeforce of the new element's colour + 1 Rancour).
export const DMG_SWAP_RANCOUR = 1;
const ELEMENTS = ['Fire', 'Cold', 'Lightning'];
const elementOf = m => { const es = ELEMENTS.filter(e => new RegExp(`\\b${e}\\b`).test(m.text)); return es.length === 1 ? es[0] : null; };
/** The same damage mod with another element (or null): same side, source and wording. */
export function damageSwap(B, m, to) {
  const from = elementOf(m);
  if (!from || from === to || !m.tags.includes('damage') || m.tags.includes('resistance')) return null;
  const text = m.text.replace(new RegExp(`\\b${from}\\b`), to);
  return B.mods.find(x => x !== m && x.text === text && x.affix === m.affix && x.src === m.src) ?? null;
}
export const swapTier = (from, t, to) => Math.max(0, to.tiers.length - (from.tiers.length - t));
export const MATRON = 'Wild Bristle Matron'; // beast: adds a random craftable metamod that fits
export const SULPHUR = "Dead Man's Sulphur"; // Allflame bench fuel
export const HK_SETUP = ['Craicic Croaker', 'Black Mórrigan']; // Bestiary recipe: Hinekora's Lock on a magic item only
export const HK_LOCK = "Hinekora's Lock"; // the currency item, for rare items (exchange price)
export const INFLUENCE_RANDOMISE = ['Primal', 1000]; // Harvest: randomise influence types and reforge
export const AWAKENER = "Awakener's Orb";
const AWAKEN_DONOR = 5; // a cheap bought item with the other influence (chaos, rough)
export const INFLUENCES = ['shaper', 'elder', 'crusader', 'hunter', 'redeemer', 'warlord'];
export const influenceExalt = inf => `${inf[0].toUpperCase()}${inf.slice(1)}'s Exalted Orb`;
// Harvest: reforge an influenced rare with at least one influenced mod (+ 1 Sacred Lifeforce; poedb).
export const HARVEST_INFLUENCE = ['Primal', 5000];
export const DEFAULT_OPTIONS = { allflame: true, allflameK: 3, allflameUses: 2, allflameIntang: 12.5, supplyCheck: true, supplyShare: 10, playerSupply: 20, timeValue: 0, recombDust: 100000, recombGold: 50000, sulphur: 2000, sulphurFracture: 50000, hinekora: true, matron: true, beasts: true, topEssence: true, influenceSetup: true, influenceExalt: true, awakener: true, rancour: true, noAlt: false };
export const SACRED = 'Sacred Crystallised Lifeforce';
export const SOLVER = { maxIter: 400, iters: 0, states: 0, tExplore: 0, tSolve: 0 };

function benchCost(m, t, price) {
  const c = m.cost?.[Math.min(t, (m.cost?.length ?? 1) - 1)];
  if (!c) return null;
  return Object.entries(c).reduce((a, [k, v]) => a + v * price(k), 0);
}
// Currency bills: {currency name: how many}, for the "currency used" summary of a plan.
// Tries until a success at chance p (geometric), with the generator r.
const geomR = (r, p) => (p >= 1 ? 1 : 1 + Math.floor(Math.log(1 - r()) / Math.log(1 - p)));
// Eldritch target implicits are a mix of Embers, Ichors and Orbs of Conflict: counted by value.
export const ELD_VALUE = 'Eldritch implicits (chaos value)';
// Bought donor items for the Awakener's Orb: counted by value too.
export const DONOR_VALUE = 'Bought influenced items (chaos value)';
// Per currency over the simulated crafts: average, and the counts that cover 66% and 90% of them.
function usageSummary(runs) {
  const names = new Set(runs.flatMap(u => Object.keys(u)));
  return [...names].map(name => {
    const xs = runs.map(u => u[name] ?? 0).sort((a, b) => a - b);
    const q = f => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))];
    return { name, mean: xs.reduce((a, b) => a + b, 0) / xs.length, q66: q(0.66), q90: q(0.9) };
  }).filter(x => x.mean > 0);
}
// How many times a step ran per craft (crafts that never reached it count 0): average and the
// counts that cover 66% and 90% of crafts.
function runsSummary(xs, runs) {
  const all = [...xs, ...new Array(Math.max(0, runs - xs.length)).fill(0)].sort((a, b) => a - b);
  const q = f => all[Math.min(all.length - 1, Math.floor(f * all.length))];
  return { mean: all.reduce((a, b) => a + b, 0) / all.length, q66: q(0.66), q90: q(0.9), reached: xs.length / runs };
}
const bill = (...parts) => { const b = {}; for (const x of parts) if (x) for (const [k, v] of Object.entries(x)) b[k] = (b[k] ?? 0) + v; return b; };
const one = (name, n = 1) => ({ [name]: n });
const benchBill = (m, t) => ({ ...(m?.cost?.[Math.min(t, (m.cost?.length ?? 1) - 1)] ?? {}) });
// Cheapest bench craft on a side that doesn't clash with the item (a "blocker").
function cheapestBlocker(B, it, side, price) {
  const blocked = groupsOf(it);
  let best = null;
  for (const m of B.mods) {
    if (m.src !== 'bench' || m.affix !== side || m.meta || m.groups.some(g => blocked.has(g))) continue;
    m.tiers.forEach((t, i) => {
      if (t.ilvl > it.ilvl) return;
      const c = benchCost(m, i, price);
      if (c != null && isFinite(c) && (!best || c < best.cost)) best = { m, t: i, cost: c, bill: benchBill(m, i) };
    });
  }
  return best;
}
const metaMod = (B, meta) => B.mods.find(m => m.meta === meta);
const essencesFor = (B, T) => B.mods.filter(m => m.src === 'essence' && m.affix === T.m.affix && m.text === T.m.text);
// Special essences (Hysteria, Insanity, Horror, Delirium, Desolation) come in one version
// with no level in the name; the data marks the first four and gives Desolation one tier.
// Essences whose other mods are "restricted to level N and below" (Mirage, poedb).
export const ESSENCE_MOD_LEVEL = { Desolation: 15 };
export function essenceName(m, t, levels) {
  if (m.corrupt || m.tiers.length === 1) return `Essence of ${m.essence}`;
  return `${levels[levels.length - m.tiers.length + t] ?? 'Deafening'} Essence of ${m.essence}`;
}
// Does essence tier t reach the target tier? The same rule as meets().
const reaches = (m, t, T) => lowsReach(m.tiers[t].values, T.m.tiers[T.minTier].values);

// Orb of Conflict: one Eldritch implicit goes up a tier, the other down (a Lesser one going down
// is lost). The lower one is more likely to go up: 50% at equal tiers, about 11 points per tier
// of difference (one community measurement; 5 vs 3 gives the 5 a 28% chance). The two top tiers
// (Exquisite, Perfect) only come from Conflict; Embers and Ichors give Lesser to Exceptional.
export const CONFLICT_STEP = 0.11;
// Orb of Dominance works on these item classes only (poedb): body armours, boots, helmets, gloves.
export const DOMINANCE_GROUPS = new Set([2, 3, 4, 5]);
export const EMBER_MAX_TIER = 3;
export const conflictUp = (mine, other) => Math.min(0.98, Math.max(0.02, 0.5 + CONFLICT_STEP * (other - mine)));
/**
 * Cheapest way to the wanted Eldritch implicits. want: {r?: {m, tier}, b?: {m, tier}} (r: Searing
 * Exarch, b: Eater of Worlds). An optimal policy over the two tiers: apply an Ember or Ichor of a tier
 * (until it's the wanted mod, for a wanted side), or use an Orb of Conflict. Returns {cost, steps}.
 */
export function eldritchPlan(B, want, P) {
  const N = 6, sides = ['r', 'b'];
  const name = (s, k) => `${ELDRITCH_TIERS[k]} Eldritch ${s === 'r' ? 'Ember' : 'Ichor'}`;
  // Cost of one successful apply of tier k on side s (repeated until the wanted mod, if any).
  const apply = (s, k) => {
    const c = P(name(s, k));
    if (!isFinite(c)) return { c: Infinity, p: 0 };
    if (!want[s]) return { c, p: 1 };
    const pool = B.mods.filter(m => m.affix === s && m.tiers[k]?.w > 0);
    const W = pool.reduce((a, m) => a + m.tiers[k].w, 0), w = want[s].m.tiers[k]?.w ?? 0;
    const p = W ? w / W : 0;
    return { c: p > 0 ? c / p : Infinity, p };
  };
  const A = { r: [], b: [] };
  for (const s of sides) for (let k = 0; k <= EMBER_MAX_TIER; k++) A[s][k] = apply(s, k);
  const conflict = P(CUR.conflict);
  const key = (a, b) => (a + 1) * (N + 1) + (b + 1);
  const done = (a, b) => (!want.r || a >= want.r.tier) && (!want.b || b >= want.b.tier);
  // A wanted mod can't go past its own top tier (some stop at Exquisite).
  const top = { r: (want.r?.m.tiers.length ?? N) - 1, b: (want.b?.m.tiers.length ?? N) - 1 };
  const conflictOuts = (a, b) => {
    const u = conflictUp(a, b);
    return [
      { p: u, a: Math.min(top.r, a + 1), b: b - 1 },
      { p: 1 - u, a: a - 1, b: Math.min(top.b, b + 1) },
    ];
  };
  // Value iteration over (a, b), tiers -1 (none) to 5.
  const V = new Float64Array((N + 1) * (N + 1)).fill(0), pol = new Array(V.length);
  for (let a = -1; a < N; a++) for (let b = -1; b < N; b++) V[key(a, b)] = done(a, b) ? 0 : 1e12;
  for (let it = 0; it < 2000; it++) {
    let delta = 0;
    for (let a = -1; a < N; a++) for (let b = -1; b < N; b++) {
      if (done(a, b)) continue;
      let best = Infinity, act = null;
      for (let k = 0; k <= EMBER_MAX_TIER; k++) {
        if (a !== k && A.r[k].c + V[key(k, b)] < best) { best = A.r[k].c + V[key(k, b)]; act = { s: 'r', k }; }
        if (b !== k && A.b[k].c + V[key(a, k)] < best) { best = A.b[k].c + V[key(a, k)]; act = { s: 'b', k }; }
      }
      if (a >= 0 && b >= 0 && isFinite(conflict)) {
        const v = conflict + conflictOuts(a, b).reduce((x, o) => x + o.p * V[key(o.a, o.b)], 0);
        if (v < best) { best = v; act = { conflict: true }; }
      }
      delta = Math.max(delta, Math.abs(V[key(a, b)] - best));
      V[key(a, b)] = best; pol[key(a, b)] = act;
    }
    if (delta < 1e-7) break;
  }
  const cost = V[key(-1, -1)];
  if (!(cost < 1e11)) return { cost: Infinity, steps: [] };
  // Expected uses of each action under that policy.
  const counts = new Map();
  const labelOf = act => (act.conflict ? CUR.conflict : name(act.s, act.k));
  const E = new Map();
  for (let it = 0; it < 3000; it++) {
    let delta = 0;
    for (let a = -1; a < N; a++) for (let b = -1; b < N; b++) {
      if (done(a, b)) continue;
      const act = pol[key(a, b)];
      const outs = act.conflict ? conflictOuts(a, b) : [{ p: 1, a: act.s === 'r' ? act.k : a, b: act.s === 'b' ? act.k : b }];
      const tries = act.conflict ? 1 : 1 / (A[act.s][act.k].p || 1);
      const prev = E.get(key(a, b)) ?? new Map();
      const next = new Map([[labelOf(act), tries]]);
      for (const o of outs) for (const [l, n] of E.get(key(o.a, o.b)) ?? []) next.set(l, (next.get(l) ?? 0) + o.p * n);
      for (const [l, n] of next) delta = Math.max(delta, Math.abs(n - (prev.get(l) ?? 0)));
      E.set(key(a, b), next);
    }
    if (delta < 1e-6) break;
  }
  for (const [l, n] of E.get(key(-1, -1)) ?? []) counts.set(l, n);
  // The first applies, then the Conflict phase, as text.
  const steps = [];
  let a = -1, b = -1;
  for (let i = 0; i < 4 && !done(a, b); i++) {
    const act = pol[key(a, b)];
    if (act.conflict) break;
    const x = A[act.s][act.k];
    const what = act.s === 'r' ? 'Searing Exarch' : 'Eater of Worlds';
    steps.push({ text: want[act.s] ? `${name(act.s, act.k)} until the ${what} implicit is "${modText(want[act.s].m, act.k)}": ${pctText(x.p)} per try, about ${fmtN(tries(x.p))}.`
      : `${name(act.s, act.k)} for any ${what} implicit (it only steers the Orbs of Conflict).`, p: x.p, cost: x.c, how: 'Eldritch implicits' });
    if (act.s === 'r') a = act.k; else b = act.k;
  }
  if (!done(a, b)) {
    const goal = sides.filter(s => want[s]).map(s => `the ${s === 'r' ? 'Searing Exarch' : 'Eater of Worlds'} implicit is ${ELDRITCH_TIERS[want[s].tier]}`).join(' and ');
    const re = [...counts].filter(([l, n]) => l !== CUR.conflict && n > 0.05).map(([l, n]) => `${fmtN(n)} ${l}`);
    steps.push({ text: `Orbs of Conflict until ${goal}: about ${fmtN(counts.get(CUR.conflict) ?? 0)} in all. Each raises one implicit and lowers the other (a Lesser one is lost); the lower one is more likely to go up. When an implicit drops too low (or is lost), apply a fresh Ember or Ichor. On average, in all: ${re.join(', ') || 'no more Embers or Ichors'}.`,
      p: 1, cost: V[key(a, b)], how: 'Orb of Conflict' });
  }
  return { cost, steps, counts };
}

// Mean number of Orbs of Conflict to make `want` ('p' or 's') dominant, by simulation.
export function conflictCost(rT, bT, nTiers, want, runs = 4000) {
  const rnd = mulberry32(7);
  let total = 0, ok = 0;
  for (let i = 0; i < runs; i++) {
    let r = rT, b = bT, k = 0;
    while (k < 60 && !((want === 'p' && r > b) || (want === 's' && b > r))) {
      if (r < 0 || b < 0) break;
      if (rnd() < conflictUp(r, b)) { r = Math.min(nTiers - 1, r + 1); b -= 1; } else { b = Math.min(nTiers - 1, b + 1); r -= 1; }
      k++;
    }
    if ((want === 'p' && r > b && b >= 0) || (want === 's' && b > r && r >= 0)) { total += k; ok++; }
  }
  return ok ? total / ok : Infinity;
}

/*
 * Where n random mods (n drawn from dist) can leave the item: every end
 * state with its chance. tg: the targets still missing, [{k, m, minTier}].
 * Returns [{st (0 missing, 1 hit, 2 dead per tg), np, ns, p}], np/ns = new
 * mods on each side. Same weights and group rules as odds().
 */
export function rollOutcomes(it, tg, dist, opts = {}) {
  const es = pool(it, opts);
  const max = maxAff(it);
  const cap = { p: max.p - count(it, 'p'), s: max.s - count(it, 's') };
  if (opts.side) cap[opts.side === 'p' ? 's' : 'p'] = 0;
  const K = tg.length;
  const hitW = new Array(K).fill(0), deadW = new Array(K).fill(0), side = tg.map(T => T.m.affix);
  const other = { p: 0, s: 0 }, otherGroups = { p: new Set(), s: new Set() };
  const tGroups = tg.map(T => new Set(T.m.groups));
  for (const e of es) {
    let used = false;
    for (let k = 0; k < K && !used; k++) {
      if (meets(tg[k], e.m, e.t) || tg[k].alts?.some(a => a.m === e.m && e.t >= a.minTier)) { hitW[k] += e.w; used = true; } else if (e.m.groups.some(g => tGroups[k].has(g))) { deadW[k] += e.w; used = true; }
    }
    if (!used) { other[e.m.affix] += e.w; e.m.groups.forEach(g => otherGroups[e.m.affix].add(g)); }
  }
  const G = { p: Math.max(1, otherGroups.p.size), s: Math.max(1, otherGroups.s.size) };
  const final = new Map();
  const add = (map, st, np, ns, jp, js, p) => {
    const key = st.join('') + '|' + np + ns + jp + js;
    const cur = map.get(key);
    if (cur) cur.p += p; else map.set(key, { st, np, ns, jp, js, p });
  };
  for (const [n, pn] of dist) {
    let layer = new Map();
    add(layer, new Array(K).fill(0), 0, 0, 0, 0, pn);
    for (let step = 0; step < n; step++) {
      const next = new Map();
      for (const s of layer.values()) {
        const pOpen = s.np < cap.p, sOpen = s.ns < cap.s;
        const Wp = pOpen ? other.p * Math.max(0, 1 - s.jp / G.p) : 0, Ws = sOpen ? other.s * Math.max(0, 1 - s.js / G.s) : 0;
        let W = Wp + Ws;
        for (let k = 0; k < K; k++) if (s.st[k] === 0 && (side[k] === 'p' ? pOpen : sOpen)) W += hitW[k] + deadW[k];
        if (W <= 0) { add(next, s.st, s.np, s.ns, s.jp, s.js, s.p); continue; }
        for (let k = 0; k < K; k++) {
          if (s.st[k] !== 0 || !(side[k] === 'p' ? pOpen : sOpen)) continue;
          const np = s.np + (side[k] === 'p'), ns = s.ns + (side[k] === 's');
          if (hitW[k]) { const st = s.st.slice(); st[k] = 1; add(next, st, np, ns, s.jp, s.js, s.p * hitW[k] / W); }
          if (deadW[k]) { const st = s.st.slice(); st[k] = 2; add(next, st, np, ns, s.jp, s.js, s.p * deadW[k] / W); }
        }
        if (Wp) add(next, s.st, s.np + 1, s.ns, s.jp + 1, s.js, s.p * Wp / W);
        if (Ws) add(next, s.st, s.np, s.ns + 1, s.jp, s.js + 1, s.p * Ws / W);
      }
      layer = next;
    }
    for (const s of layer.values()) add(final, s.st, s.np, s.ns, 0, 0, s.p);
  }
  return [...final.values()];
}

// Solve x_i - Σ_j a_ij x_j = c_i (rows: {c, a: [[j, a_ij]]}) by BiCGSTAB.
// Returns null when it doesn't converge.
function solveLinear(rows, x0) {
  const N = rows.length;
  const mul = (v, out) => {
    for (let i = 0; i < N; i++) {
      let s = v[i];
      for (const [j, a] of rows[i].a) s -= a * v[j];
      out[i] = s;
    }
    return out;
  };
  const b = Float64Array.from(rows, r => r.c);
  const x = Float64Array.from(x0);
  const r = new Float64Array(N), tmp = new Float64Array(N);
  mul(x, tmp);
  for (let i = 0; i < N; i++) r[i] = b[i] - tmp[i];
  const r0 = Float64Array.from(r);
  const p = new Float64Array(N), v = new Float64Array(N), s = new Float64Array(N), t = new Float64Array(N);
  let rho = 1, alpha = 1, omega = 1;
  const dot = (a, c) => { let z = 0; for (let i = 0; i < N; i++) z += a[i] * c[i]; return z; };
  const bn = Math.sqrt(dot(b, b)) || 1;
  for (let it = 0; it < 4000; it++) {
    const rho1 = dot(r0, r);
    if (!isFinite(rho1) || rho1 === 0) break;
    const beta = (rho1 / rho) * (alpha / omega);
    for (let i = 0; i < N; i++) p[i] = r[i] + beta * (p[i] - omega * v[i]);
    mul(p, v);
    alpha = rho1 / dot(r0, v);
    for (let i = 0; i < N; i++) s[i] = r[i] - alpha * v[i];
    if (Math.sqrt(dot(s, s)) / bn < 1e-9) { for (let i = 0; i < N; i++) x[i] += alpha * p[i]; return x; }
    mul(s, t);
    omega = dot(t, s) / dot(t, t);
    for (let i = 0; i < N; i++) { x[i] += alpha * p[i] + omega * s[i]; r[i] = s[i] - omega * t[i]; }
    rho = rho1;
    if (Math.sqrt(dot(r, r)) / bn < 1e-9) return x;
    if (!isFinite(omega) || omega === 0) break;
  }
  return null;
}

// Direct solve of x_i = c_i + Σ a_ij x_j (a substochastic, proper) by
// eliminating states one at a time, cheapest first (Markowitz order), then
// back-substituting. Stable here because I - A is diagonally dominant.
// Returns null when fill-in grows too large.
function solveDirect(rows, maxFill = 4e6) {
  const N = rows.length;
  const out = rows.map(r => {
    const m = new Map();
    for (const [j, a] of r.a) m.set(j, (m.get(j) ?? 0) + a);
    return m;
  });
  const c = Float64Array.from(rows, r => r.c);
  const preds = Array.from({ length: N }, () => new Set());
  for (let i = 0; i < N; i++) {
    const self = out[i].get(i);
    if (self) { out[i].delete(i); const d = 1 - self; c[i] /= d; for (const [j, a] of out[i]) out[i].set(j, a / d); }
    for (const j of out[i].keys()) preds[j].add(i);
  }
  const done = new Uint8Array(N), order = [];
  let fill = rows.reduce((a, r) => a + r.a.length, 0);
  // Bucketed min-cost queue (cost = preds × outs), lazily refreshed.
  const cost = i => preds[i].size * Math.max(1, out[i].size);
  const heap = [];
  const push = i => { heap.push([cost(i), i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
  for (let i = 0; i < N; i++) push(i);
  while (heap.length) {
    const [k, v] = pop();
    if (done[v]) continue;
    if (k !== cost(v)) { push(v); continue; }
    done[v] = 1; order.push(v);
    // Substitute row v into every row that points at v.
    for (const u of preds[v]) {
      if (done[u]) continue;
      const auv = out[u].get(v);
      if (auv === undefined) continue;
      out[u].delete(v);
      c[u] += auv * c[v];
      for (const [w, avw] of out[v]) {
        if (w === u) continue;
        const had = out[u].get(w);
        out[u].set(w, (had ?? 0) + auv * avw);
        if (had === undefined) { preds[w].add(u); fill++; }
      }
      const self = out[v].get(u);
      if (self !== undefined) {
        const d = 1 - auv * self;
        if (d <= 1e-300) return null;
        c[u] /= d;
        for (const [w, a] of out[u]) out[u].set(w, a / d);
      }
      if (fill > maxFill) return null;
    }
    for (const w of out[v].keys()) preds[w].delete(v);
  }
  // Back-substitute: each row now only refers to rows eliminated after it.
  const x = new Float64Array(N);
  for (let t = order.length - 1; t >= 0; t--) {
    const v = order[t];
    let val = c[v];
    for (const [w, a] of out[v]) val += a * x[w];
    x[v] = val;
  }
  return x;
}

function gaussSeidel(rows, x0, sweeps = 20000) {
  const x = Float64Array.from(x0);
  for (let it = 0; it < sweeps; it++) {
    let ch = 0;
    for (let i = 0; i < rows.length; i++) {
      let v = rows[i].c;
      for (const [j, a] of rows[i].a) v += a * x[j];
      ch = Math.max(ch, Math.abs(v - x[i]) / Math.max(1, v));
      x[i] = v;
    }
    if (ch < 1e-10) return x;
  }
  return x;
}

const C_pool = (B, ilvl, infl) => pool(newItem(B, { ilvl, infl, rarity: 'rare' }));

// Solve R = c + Σ p_d · min(A_d, R): the value of "repeat this until it's
// worth stopping" (optimal stopping). Returns {R, stop: P(stop per try)}.
function stopValue(c, outs) {
  const xs = outs.filter(o => o.p > 0 && isFinite(o.A)).sort((a, b) => a.A - b.A);
  let P = 0, PA = 0, R = Infinity;
  for (const o of xs) {
    if (o.A >= R) break;
    P += o.p; PA += o.p * o.A;
    R = (c + PA) / P;
  }
  return { R, stop: P };
}

/*
 * plan(B, spec, price, index, onProgress) -> [{key, name, ok, cost, steps, notes}]
 * spec: {ilvl, infl, targets: [{m, minTier, crafted?, frac?}], useFractured}
 * price(name) -> chaos (NaN when unknown).
 */
export function plan(B, spec, price0, index, onProgress = () => {}) {
  // Prices that follow supply: the cheapest plan at market prices can lean on something bought
  // a thousand times (beasts, one essence) that nobody can actually get. So: plan, count what
  // the best plan needs, price up whatever it needs beyond what the market supplies, and plan
  // again, so the planner looks for another route. Optionally each currency also carries the
  // time it takes to use (opt.timeValue chaos per hour).
  const opt = { ...DEFAULT_OPTIONS, ...(spec.options ?? {}) };
  const supply = spec.supply ?? {};
  const haveMarket = Object.keys(supply).length > 0;
  const noCap = n => n in FARMED_PRICES || n === ELD_VALUE || n === DONOR_VALUE;
  // (Bulk items are used by the hundred per craft: their time is in the craft that uses them.)
  const bulk = n => noCap(n) || n === SULPHUR || /Lifeforce$/.test(n);
  // What one craft can buy: a share of a day of the whole exchange (or what's listed, if more);
  // items not on the exchange (beasts, Hinekora's recipe) are bought one at a time from players.
  const capOf = n => {
    if (noCap(n) || !isFinite(price0(n))) return null;
    const v = supply[n];
    return v ? Math.max(1, Math.max(v.stock ?? 0, v.perHour * 24) * opt.supplyShare / 100) : opt.playerSupply;
  };
  const secs = n => (bulk(n) ? 0 : !haveMarket || supply[n] ? 2 : 60);
  const tv = Math.max(0, +opt.timeValue || 0) / 3600;
  const mult = new Map(), why = new Map();
  const price = n => { const v = price0(n); return isFinite(v) ? v * (mult.get(n) ?? 1) + secs(n) * tv : v; };
  const rounds = opt.supplyCheck && haveMarket ? 4 : 1;
  let res;
  for (let round = 0; ; round++) {
    const last = round === rounds - 1;
    res = planRound(B, spec, price, index, round ? s => onProgress(`${s} (re-planned for supply, round ${round + 1})`) : onProgress, !last);
    if (last) break;
    const best = res.find(r => r.ok);
    let changed = false;
    for (const x of best?.usage?.items ?? []) {
      const cap = capOf(x.name);
      if (cap == null || !(x.q66 > cap * 1.05)) continue;
      mult.set(x.name, Math.min(500, (mult.get(x.name) ?? 1) * x.q66 / cap));
      why.set(x.name, { need: x.q66, cap, onExchange: !!supply[x.name] });
      changed = true;
    }
    if (!changed) { finishPlans(res, onProgress); break; }
  }
  if (why.size) {
    const list = [...why].map(([n, w]) => `${n} ×${fmtN(mult.get(n))} (a cheaper-looking plan needed about ${fmtN(w.need)}; ${w.onExchange ? `about ${fmtN(w.cap)} can be bought for one craft` : `bought from players, about ${fmtN(w.cap)} for one craft`})`);
    for (const r of res.filter(x => x.ok)) r.notes.push(`Priced up for limited supply, so the planner looked for other routes: ${list.join('; ')}. Costs here use those prices.`);
  }
  return res;
}

function planRound(B, spec, price, index, onProgress, quick) {
  // Harvest swaps (resistances, and damage with Rancour) cost a fixed amount each time a
  // target lands in the wrong element; whether that beats rolling for the right element
  // depends on prices, so solve with and without each swap and keep the cheaper plan.
  const first = planOnce(B, spec, price, index, onProgress, null, { quick });
  if (!first.swappable) return first;
  const ids = first.swappable.map(x => x.id);
  const subsets = [];
  if (ids.length <= 3) for (let mask = 0; mask < (1 << ids.length) - 1; mask++) subsets.push(new Set(ids.filter((x, i) => mask & (1 << i))));
  else subsets.push(new Set());
  // The extra passes only re-solve Best mix, from the first pass's strategy and fossil choices.
  const runs = [first, ...subsets.map((set, i) => { onProgress(`Without some swaps (${i + 1} of ${subsets.length})`); return planOnce(B, spec, price, index, () => {}, set, { bestOnly: true, warm: first.bestSol, fossilCombos: first.fossilCombos }); })];
  const best = new Map();
  for (const run of runs) for (const r of run.results) if (!best.has(r.name) || r.cost < best.get(r.name).cost) best.set(r.name, r);
  const sorted = [...best.values()].sort((a, b) => (a.ok === b.ok ? a.cost - b.cost : a.ok ? -1 : 1));
  for (const r of sorted.filter(x => x.ok)) {
    const off = first.swappable.filter(x => !r.swapsUsed?.has(x.id));
    if (off.length) r.notes.push(`Not worth swapping at these prices: ${off.map(x => `a wrong-element ${x.label} (${fmtC(x.cost)} a swap)`).join('; ')}. This plan rolls for the right element instead.`);
  }
  return finishPlans(sorted, onProgress, quick);
}

// Each step's expected cost left from there (fromHere) and spent to get there (spent = the
// plan's total minus that). A state step's rem covers the rest of the main craft; steps after
// the last one (swaps, Eldritch implicits, the bench) and before the first (influence,
// implicits, the Recombinator) add their own cost.
function costsAlong(r) {
  if (!r.ok || !r.steps?.length || r.costMode === 'own' || !r.steps.some(s => s.rem != null)) return;
  const own = s => (s.own ?? s.cost ?? 0);
  const last = r.steps.map(s => s.rem != null).lastIndexOf(true);
  const tail = r.steps.slice(last + 1).reduce((a, s) => a + own(s), 0);
  let acc = 0;
  for (let i = r.steps.length - 1; i >= 0; i--) {
    const s = r.steps[i];
    acc = s.rem != null ? s.rem + tail : own(s) + acc;
    s.fromHere = acc;
  }
  // (The likeliest path can land on a state worse than the average result, where more is
  // left than before; what's been spent never goes down.)
  // Before the first state step (influence, an opening's items), spent is what those steps cost.
  const first = r.steps.findIndex(s => s.rem != null);
  let spent = 0;
  r.steps.forEach((s, i) => {
    if (i >= first) spent = Math.max(spent, r.cost - s.fromHere);
    s.spent = spent;
    if (i < first) spent += own(s);
  });
}

// quick: only count the best plan's currency (for the supply check); a later full call finishes.
function finishPlans(sorted, onProgress, quick = false) {
  if (quick) {
    onProgress('Checking supply');
    const r = sorted.find(x => x.ok && x.makeUsage);
    if (r) { try { r.usage = r.makeUsage(); delete r.usage.raw; } catch (e) { if (SOLVER.debug) SOLVER.debug('usage: ' + e.message); } }
    return sorted;
  }
  // State graphs for the three best plans (the simulation is the slow part).
  onProgress('Drawing the state graph');
  for (const r of sorted.filter(x => x.makeGraph).slice(0, 3)) {
    try { r.graph = r.makeGraph(); delete r.graph.used; } catch (e) { if (SOLVER.debug) SOLVER.debug('graph: ' + e.message); }
  }
  // Currency used: a simulation of its own that lets long crafts run to the end.
  onProgress('Counting currency');
  for (const r of sorted) if (r.makeUsage && !r.usage) { try { r.usage = r.makeUsage(); delete r.usage.raw; } catch (e) { if (SOLVER.debug) SOLVER.debug('usage: ' + e.message); } }
  for (const r of sorted) {
    for (const s of r.steps ?? []) { const x = s.simKey && r.usage?.stepRuns?.get(s.simKey); if (x) s.runs = x; delete s.simKey; }
    if (r.usage) delete r.usage.stepRuns;
  }
  for (const r of sorted) { delete r.makeGraph; delete r.makeUsage; delete r.swapsUsed; costsAlong(r); }
  return sorted;
}

// One planning pass. swapIds: the target mod ids whose Harvest swap may be used (null: all).
// Returns a finished plan list when there is nothing to swap, else {results, swappable}.
// ctx.sub: a helper solve (no graphs, raw results); ctx.reserve: extra slots ({p, s}) to leave open.
function planOnce(B, spec, price, index, onProgress, swapIds, ctx = {}) {
  const { ilvl, infl } = spec;
  const opt = { ...DEFAULT_OPTIONS, ...(spec.options ?? {}) };
  const P = name => { const v = price(name); return isFinite(v) ? v : NaN; };
  // Eldritch implicits are planned on their own (Embers and Ichors don't touch explicit mods).
  const eldT = spec.targets.filter(t => t.m.affix === 'r' || t.m.affix === 'b');
  const explicitT = spec.targets.filter(t => t.m.affix === 'p' || t.m.affix === 's');
  const benchT = explicitT.filter(T => T.crafted);
  const presetF = spec.useFractured ? explicitT.find(T => T.frac && !T.crafted) : null;
  const T = explicitT.filter(T => !T.crafted).map(t => ({ ...t, side: t.m.affix, kind: t.m.src === 'veiled' ? 'veiled' : t.m.src === 'essence' ? 'essence' : 'roll' }));
  // Harvest resistance swap: a fire/cold/lightning resistance target is also met by the
  // other elements at a similar tier, then swapped (500 lifeforce).
  // With Crystallised Rancour, a fire/cold/lightning damage target works the same way.
  const swaps = [], swappable = [];
  const rancourOn = opt.rancour && isFinite(P(RANCOUR));
  for (const t of T) {
    if (t.kind !== 'roll') continue;
    const mm = t.m.src === 'base' && t.m.text.match(RES_RE);
    const element = mm ? mm[1] : rancourOn && ELEMENTS.some(e => damageSwap(B, t.m, e)) ? elementOf(t.m) : null;
    if (!element) continue;
    swappable.push({ id: t.m.id, label: mm ? `${element} resistance` : `"${t.m.text}"` });
    if (swapIds && !swapIds.has(t.m.id)) continue;
    const others = mm ? B.mods.filter(m => m !== t.m && m.src === 'base' && m.affix === t.side && RES_RE.test(m.text))
      : ELEMENTS.map(e => damageSwap(B, t.m, e)).filter(Boolean);
    const alts = others.filter(m => !T.some(o => o.m === m)).map(m => ({ m, minTier: swapTier(t.m, t.minTier, m) }));
    if (!alts.length) continue;
    t.alts = alts;
    const fresh = C_pool(B, ilvl, infl);
    const own = fresh.filter(e => e.m === t.m && e.t >= t.minTier).reduce((a, e) => a + e.w, 0);
    const other = fresh.filter(e => alts.some(a => a.m === e.m && e.t >= a.minTier)).reduce((a, e) => a + e.w, 0);
    const colour = RES_SWAP[element];
    const cost = RES_SWAP_AMOUNT * P(lifeforce(colour)) + (mm ? 0 : DMG_SWAP_RANCOUR * P(RANCOUR));
    swaps.push({ t, share: other / Math.max(1e-9, own + other), cost, colour, element, what: mm ? 'resistance' : `damage mod ("${t.m.text}")`, rancour: !mm });
    swappable[swappable.length - 1].cost = cost;
  }
  const swapCostTotal = swaps.reduce((a, x) => a + (isFinite(x.cost) ? x.share * x.cost : 0), 0);
  // Eldritch implicit targets: Embers/Ichors, and Orbs of Conflict for the top tiers.
  const eldSteps = [];
  let eldTargetCost = 0;
  if (eldT.length) {
    const want = {};
    for (const t of eldT) want[t.m.affix] = { m: t.m, tier: t.minTier };
    const ep = eldritchPlan(B, want, P);
    eldTargetCost = ep.cost;
    eldSteps.push(...ep.steps);
  }
  // Getting the influences onto the base: Harvest randomise influence (1 in 6 for the one
  // you want), and Awakener's Orb with a cheap item of the other influence for a second.
  const inflSteps = [];
  let inflCost = 0;
  if (infl.length && opt.influenceSetup && !B.innateInfl) {
    const rnd = INFLUENCE_RANDOMISE[1] * P(lifeforce(INFLUENCE_RANDOMISE[0]));
    if (isFinite(rnd)) {
      inflCost += 6 * rnd;
      inflSteps.push({ text: `Start from any influenced ${B.name} at item level ${ilvl}+, and use the Harvest craft "randomise influence" (${INFLUENCE_RANDOMISE[1]} ${INFLUENCE_RANDOMISE[0]} Lifeforce) until it is ${infl[0]}: 1 in 6, about 6 crafts. (Or buy the base with that influence.)`, p: 1 / 6, cost: 6 * rnd, how: 'Influence' });
    }
    if (infl.length > 1 && isFinite(P(AWAKENER))) {
      inflCost += P(AWAKENER) + 2;
      inflSteps.push({ text: `Buy any cheap item with ${infl[1]} influence and use an Awakener's Orb: the ${infl[1]} item is destroyed and your base becomes ${infl[0]} + ${infl[1]} (use your base second).`, p: 1, cost: P(AWAKENER) + 2, how: 'Influence' });
    }
  }
  const extraTotal = swapCostTotal + eldTargetCost + inflCost;
  const finalSteps = (sw = swaps) => [
    ...sw.filter(x => x.share > 0.01 && isFinite(x.cost)).map(x => ({ text: `Harvest: if the ${x.element} ${x.what} rolled as another element (about ${pctText(x.share)} of the time), change it to ${x.element} (${RES_SWAP_AMOUNT} ${x.colour} Lifeforce${x.rancour ? ` + ${DMG_SWAP_RANCOUR} Crystallised Rancour` : ''}).`, p: 1, cost: x.share * x.cost, how: 'Harvest swap' })),
    ...eldSteps,
  ];
  const K = T.length;
  // Fractured and influenced don't mix: a Fracturing Orb needs a non-influenced item, and
  // influenced Exalted Orbs, the Awakener's Orb and Harvest influence crafts refuse fractured ones.
  if (presetF && infl.length) return [{ key: 'fracinfl', name: 'Fractured and influenced', ok: false, cost: Infinity, steps: [], notes: [],
    why: `A fractured base can't be ${infl.join(' + ')}-influenced: influenced Exalted Orbs, the Awakener's Orb and Harvest influence crafts don't work on fractured items, and Fracturing Orbs don't work on influenced ones. Untick "fractured" or remove the influence.` }];
  // Two picks from one mod group can't both be on an item (base and essence Life, a rolled
  // and a bench-crafted Dexterity, Shaper's and Redeemer's copy of a mod).
  for (let i = 0; i < explicitT.length; i++) for (let j = i + 1; j < explicitT.length; j++) {
    const a = explicitT[i], b = explicitT[j];
    if (a.m.groups.some(g => b.m.groups.includes(g))) return [{ key: 'group', name: 'Mutually exclusive mods', ok: false, cost: Infinity, steps: [], notes: [],
      why: `"${modText(a.m, a.minTier)}"${a.crafted ? ' (bench)' : ''} and "${modText(b.m, b.minTier)}"${b.crafted ? ' (bench)' : ''} are the same kind of mod (one mod group): an item can only have one of them. Untick one.` }];
  }
  if (K > 8) return [{ key: 'too', name: 'Too many mods', ok: false, cost: Infinity, why: 'Pick at most 8 mods to roll (bench crafts don\'t count).', steps: [] }];
  const fixedF = presetF ? T.findIndex(t => t.m === presetF.m) : -1;
  for (const side of ['p', 's']) {
    const n = explicitT.filter(t => t.m.affix === side).length + (side === 's' && benchT.length > 1 ? 1 : 0);
    if (n > B.max[side]) return [{ key: 'full', name: 'Too many ' + SIDE_NAME[side] + 'es', ok: false, cost: Infinity, why: `${n} of the ticked mods are ${SIDE_NAME[side]}es, but this base holds ${B.max[side]}. Untick one.`, steps: [], notes: [] }];
  }
  const reserve = { p: benchT.filter(t => t.m.affix === 'p').length, s: benchT.filter(t => t.m.affix === 's').length };
  if (benchT.length > 1) reserve.s++; // "Can have up to 3 Crafted Modifiers" is a suffix
  if (ctx.reserve) { reserve.p += ctx.reserve.p; reserve.s += ctx.reserve.s; }
  const benchCostTotal = benchT.reduce((a, t) => a + (benchCost(t.m, t.minTier, P) ?? 0), 0)
    + (benchT.length > 1 ? (benchCost(metaMod(B, 'mul_mods'), 0, P) ?? 0) : 0);
  const label = k => shortMod(T[k].m, T[k].minTier);
  // What an Alteration can aim for: one or two of these targets that a magic item of this base
  // can hold together (one prefix and one suffix normally; two suffixes on a Helical Ring,
  // nothing at all on a Focused or Simplex Amulet, where Alterations add no mods).
  const magicMax = B.magicMax ?? { p: 1, s: 1 };
  const magicCores = ks => {
    const fit = c => ['p', 's'].every(side => c.filter(k => T[k].side === side).length <= magicMax[side]);
    const out = ks.map(k => [k]).filter(fit);
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) if (fit([ks[i], ks[j]])) out.push([ks[i], ks[j]]);
    return out;
  };
  const veiledK = T.findIndex(t => t.kind === 'veiled');
  const deadMods = T.map(t => ({ id: -1, text: '', affix: t.side, src: 'junk', groups: t.m.groups, tags: [], tiers: [{ ilvl: 0, w: 0, values: [] }] }));
  const max = B.max;
  // A metamod ("Prefixes/Suffixes Cannot Be Changed", "Cannot roll Attack Modifiers", ...): the
  // bench, or a Wild Bristle Matron, which adds a random metamod that fits an open side. On
  // these bases that's 1 prefix metamod and 4 suffix ones, so with only a suffix open it's
  // 1 in 4. A wrong one costs an Orb of Scouring to remove at the bench, then try again: on
  // average N Matrons and N - 1 Scourings. nP/nS: mods on each side before it.
  const metas = B.mods.filter(m => m.meta && m.src === 'bench');
  function lockPrice(lock, nP, nS) {
    const bench = benchCost(lock, 0, P);
    let best = { cost: bench ?? Infinity, via: 'bench', bill: benchBill(lock, 0) };
    if (opt.matron && isFinite(P(MATRON))) {
      const fits = metas.filter(m => (m.affix === 'p' ? nP < max.p : nS < max.s));
      if (fits.includes(lock)) {
        const c = fits.length * P(MATRON) + (fits.length > 1 ? (fits.length - 1) * P(CUR.scour) : 0);
        if (c < best.cost) best = { cost: c, via: fits.length === 1 ? 'Wild Bristle Matron' : `Wild Bristle Matron (1 in ${fits.length}; remove a wrong one at the bench for an Orb of Scouring)`,
          bill: bill(one(MATRON, fits.length), fits.length > 1 ? one(CUR.scour, fits.length - 1) : null) };
      }
    }
    return best;
  }
  const lockName = (lock, lp) => `"${lock.text}"${lp.via === 'bench' ? '' : ` via ${lp.via}`}`;
  // Allflame bench: the same currency shows several outcomes and you keep the best.
  const sulphur = isFinite(P(SULPHUR)) ? P(SULPHUR) : NaN;
  const afK = Math.max(1, Math.min(4, opt.allflameK | 0));
  const afOn = opt.allflame && isFinite(sulphur) && afK > 1;
  // Each Allflame craft adds Intangibility to the item (5-20%, allflameIntang on average): the
  // chance a later craft shows just one outcome. The planner counts the crafts per item (a new
  // base starts again at 0) and stops at allflameUses.
  const afUses = Math.max(1, Math.min(6, opt.allflameUses | 0 || 2));
  const afStep = Math.max(0, Math.min(100, +opt.allflameIntang || 0)) / 100;
  const afShow = a => Math.max(0, 1 - a * afStep); // chance craft number a+1 shows its outcomes
  const AF_REF = f => f === 'chaos' || f.startsWith('essence') || f === 'fossil' || f === 'vchaos' || f === 'lockchaos';
  const AF_MOVE = new Set(['exalt', 'block', 'meta', 'multimeta', 'annul', 'lockannul', 'fracture', 'vexalt']);
  // Hinekora's Lock: one look at what the next currency will do; apply it only if the result
  // is good. Changing the item in any way ends the foresight, so a bad preview can't be
  // rerolled: that Lock is spent. On a magic item the Bestiary recipe (Craicic Croaker + Black
  // Mórrigan) gives it; a rare item needs the Hinekora's Lock currency itself (hundreds of
  // divines), so it only pays off on the last mods of a very expensive item.
  const hkMagicOn = opt.hinekora && HK_SETUP.every(n => isFinite(P(n)));
  const hkOn = opt.hinekora && isFinite(P(HK_LOCK));
  const hkSetup = HK_SETUP.reduce((a, n) => a + P(n), 0);
  const hkLock = P(HK_LOCK);

  // ----- states -----
  // key "F|st|jp js" with F = fractured target index (-1 none, -2 ruined: junk fractured).
  const enc = (F, st, jp, js) => `${F}|${st.join('')}|${jp}${js}`;
  const sideCount = (st, side) => st.reduce((a, x, k) => a + (x === 1 && T[k].side === side), 0);
  function itemFor(F, st, jp, js, extra = []) {
    const it = newItem(B, { ilvl, infl, rarity: 'rare' });
    st.forEach((x, k) => {
      if (x === 1) it.mods.push({ m: T[k].m, t: T[k].minTier, side: T[k].side, frac: F === k });
      else if (x === 2) it.mods.push({ m: deadMods[k], t: 0, side: T[k].side, filler: true });
    });
    const dead = side => st.reduce((a, x, k) => a + (x === 2 && T[k].side === side), 0);
    for (let i = 0; i < jp - dead('p'); i++) it.mods.push({ m: null, t: 0, side: 'p', filler: true });
    for (let i = 0; i < js - dead('s'); i++) it.mods.push({ m: null, t: 0, side: 's', filler: true });
    for (const x of extra) it.mods.push(x);
    return it;
  }
  // Your own item (pasted from the game) as a state: wanted mods it has, wrong tiers of them
  // (they block that mod group), junk on each side, and what is fractured. Crafted mods are
  // left out (the bench removes them for free). {why} when it can't be crafted on.
  function pastedState(start) {
    if (!start || start.rarity === 'normal') return null;
    const st = new Array(K).fill(0), exact = new Set(), swapped = new Set();
    let jp = 0, js = 0, F = -1, why = null;
    for (const x of start.mods ?? []) {
      if (x.crafted || (x.side !== 'p' && x.side !== 's')) continue;
      const m = B.byId.get(x.id);
      // The wanted mod itself, or another element of it at a tier worth a Harvest swap.
      let k = m ? T.findIndex(t => sameMod(t.m, m)) : -1;
      let hit = k >= 0 && meets(T[k], m, x.tier);
      if (hit) exact.add(k);
      if (!hit && k < 0 && m) {
        const ka = T.findIndex((t, j) => st[j] === 0 && t.alts?.some(a => a.m === m && x.tier >= a.minTier));
        if (ka >= 0) { k = ka; hit = true; swapped.add(ka); }
      }
      // Otherwise a mod of the same group (a lower tier) blocks it.
      if (!hit && k < 0 && m) k = T.findIndex(t => t.m.groups.some(g => m.groups.includes(g)));
      if (k >= 0 && st[k] === 0) st[k] = hit ? 1 : 2;
      if (!(k >= 0 && hit)) { if (x.side === 'p') jp++; else js++; }
      if (x.frac) {
        if (k >= 0 && hit) F = k;
        else if (k >= 0) why = `"${shortMod(T[k].m, x.tier)}" is fractured at a lower tier than you want, so that mod can never be right on this item.`;
        else F = x.side === 'p' ? -3 : -4;
      }
    }
    jp += start.unknown?.p ?? 0; js += start.unknown?.s ?? 0;
    // (Lines it couldn't read take the free slots, prefixes first.)
    for (let u = start.unknown?.any ?? 0; u > 0; u--) { if (sideCount(st, 'p') + jp < max.p) jp++; else js++; }
    jp = Math.min(jp, max.p - sideCount(st, 'p')); js = Math.min(js, max.s - sideCount(st, 's'));
    if (fixedF >= 0 && F !== fixedF) why ??= 'Untick "fractured" on the targets: your item decides what is fractured.';
    return { F, st, jp: Math.max(0, jp), js: Math.max(0, js), key: enc(F, st, Math.max(0, jp), Math.max(0, js)), magic: start.rarity === 'magic', why, exact, swapped };
  }
  const isDone = (st, jp, js) => st.every(x => x === 1) && sideCount(st, 'p') + jp + reserve.p <= max.p && sideCount(st, 's') + js + reserve.s <= max.s;

  // Map roll outcomes on top of a kept state into states.
  function mapRoll(F, st0, jp0, js0, tgIdx, outs, pScale = 1, extra = null) {
    return outs.map(o => {
      let st = st0.slice();
      let hp = 0, hs = 0;
      tgIdx.forEach((k, i) => { st[k] = o.st[i]; if (o.st[i] === 1) { if (T[k].side === 'p') hp++; else hs++; } });
      let jp = jp0 + o.np - hp, js = js0 + o.ns - hs;
      if (extra) ({ st, jp, js } = extra(st, jp, js));
      return { key: enc(F, st, jp, js), F, st, jp, js, p: o.p * pScale };
    });
  }
  const missingRollable = (st, filter = () => true) => st.map((x, k) => k).filter(k => st[k] === 0 && T[k].kind === 'roll' && filter(k));

  // A fractured junk mod (F = -3 on prefixes, -4 on suffixes) is counted in jp/js but never
  // leaves: removals skip it and reforges keep it.
  const fjP = F => (F === -3 ? 1 : 0), fjS = F => (F === -4 ? 1 : 0);
  // Removal: one random non-fractured mod (optionally one side). keep: a mod that can't go,
  // {k} for a target (or dead target) index, {side} for a junk mod on that side.
  function removeOne(F, st, jp, js, side = null, keep = null) {
    const opts = [];
    const deadOn = s => st.reduce((a, x, k) => a + (x === 2 && T[k].side === s), 0);
    st.forEach((x, k) => {
      if (keep?.k === k) return;
      if ((x === 1 && k !== F) || x === 2) {
        if (side && T[k].side !== side) return;
        const st2 = st.slice(); st2[k] = 0;
        opts.push({ st: st2, jp: jp - (x === 2 && T[k].side === 'p'), js: js - (x === 2 && T[k].side === 's'), w: 1 });
      }
    });
    const oj = { p: jp - deadOn('p') - (keep?.side === 'p') - fjP(F), s: js - deadOn('s') - (keep?.side === 's') - fjS(F) };
    if (oj.p > 0 && side !== 's') opts.push({ st, jp: jp - 1, js, w: oj.p });
    if (oj.s > 0 && side !== 'p') opts.push({ st, jp, js: js - 1, w: oj.s });
    const W = opts.reduce((a, o) => a + o.w, 0);
    return W ? opts.map(o => ({ ...o, p: o.w / W })) : [];
  }

  // ----- reforges (depend only on what they keep) -----
  const reforges = new Map(); // key -> {name, family, cost, outs, R, stop}
  function reforge(rkey, make) {
    if (!reforges.has(rkey)) {
      const r = make();
      if (r && isFinite(r.cost) && r.outs.length) reforges.set(rkey, { ...r, rkey });
      else reforges.set(rkey, null);
    }
    return reforges.get(rkey);
  }
  const allowed = fam => !restrict || restrict(fam);
  let restrict = null;

  // Full reforge keeping only the fractured target (Chaos, fossils) or also forcing an essence mod.
  function fullReforge(F, family, name, cost, opts = {}, forced = -1, forcedMod = null) {
    const st0 = new Array(K).fill(0);
    if (F >= 0) st0[F] = 1;
    if (forced >= 0) st0[forced] = 1;
    const kept = [];
    const it = itemFor(F, st0, fjP(F), fjS(F));
    if (forcedMod) {
      it.mods = it.mods.filter(x => x.m !== T[forced].m); it.mods.push({ m: forcedMod.m, t: forcedMod.t, side: forcedMod.m.affix });
      const cap = ESSENCE_MOD_LEVEL[forcedMod.m.essence];
      if (cap) it.ilvl = Math.min(it.ilvl, cap); // the other mods roll as if the item were this level
    }
    const tg = missingRollable(st0);
    const outs = rollOutcomes(it, tg.map(k => T[k]), rerollDist(B, it.mods.length), opts);
    void kept;
    return { name, family, cost, outs: mapRoll(F, st0, fjP(F), fjS(F), tg, outs) };
  }
  const resonator = n => P(RESONATORS[n - 1]);
  // Candidate essences (they force one target).
  const essences = [];
  // Harvest types worth reforging for: the tags of the targets that roll.
  const harvestTags = Object.keys(HARVEST_REFORGE).filter(tag => (rancourOn || !HARVEST_REFORGE[tag][2]) && T.some(t => t.kind === 'roll' && t.m.tags.includes(tag)));
  T.forEach((t, k) => {
    for (const em of essencesFor(B, t)) {
      // The two highest essence levels (Deafening, Shrieking), or only the highest when asked:
      // it rolls the best tier, on some mods a tier above what the mod can roll normally.
      for (let tt = em.tiers.length - 1; tt >= Math.max(0, em.tiers.length - (opt.topEssence ? 1 : 2)); tt--) {
        if (!reaches(em, tt, t)) continue;
        const name = essenceName(em, tt, index.essenceLevels);
        if (isFinite(P(name))) essences.push({ k, m: em, t: tt, name });
      }
    }
  });
  let fossilCombos = [];
  // Hollow Fossil: forces an Abyssal Socket (a suffix); other fossils can join it.
  const hollow = index.fossils?.find(f => f.forces);
  const hollowK = hollow ? T.findIndex(t => t.m.id === hollow.forces) : -1;

  function reforgesFor(F, st, jp, js, variant) {
    const list = [];
    if (F === -2) return list;
    if (allowed('chaos')) list.push(reforge(`chaos|${F}`, () => ({ ...fullReforge(F, 'chaos', 'Chaos Orb', P(CUR.chaos)), bill: one(CUR.chaos) })));
    for (const e of essences) {
      if (F === e.k || !allowed('essence:' + e.name)) continue;
      list.push(reforge(`ess:${e.name}|${F}`, () => ({ ...fullReforge(F, 'essence:' + e.name, e.name, P(e.name), {}, e.k, { m: e.m, t: e.t }), bill: one(e.name) })));
    }
    const fossilBill = combo => bill(...combo.map(f => one(f.name)), one(RESONATORS[combo.length - 1]));
    if (allowed('fossil')) for (const fc of fossilCombos) list.push(reforge(`fos:${fc.key}|${F}`, () => ({ ...fullReforge(F, 'fossil', fc.name, fc.cost, { fossils: fc.combo }), bill: fossilBill(fc.combo) })));
    if (hollowK >= 0 && F !== hollowK && allowed('fossil') && isFinite(P(hollow.name))) {
      for (const extra of [[], ...fossilCombos.filter(fc => fc.combo.length < 4).map(fc => fc.combo)]) {
        const combo = [hollow, ...extra];
        const cost = combo.reduce((a, f) => a + P(f.name), 0) + resonator(combo.length);
        list.push(reforge(`hollow:${extra.map(f => f.id).join('-')}|${F}`, () => ({ ...fullReforge(F, 'fossil', combo.map(f => f.name).join(' + '), cost, { fossils: extra }, hollowK, { m: T[hollowK].m, t: 0 }), bill: fossilBill(combo) })));
      }
    }
    // Harvest reforge with a type: first a mod of that type, then the rest with the type ×10.
    if (allowed('harvest')) {
      for (const tag of harvestTags) {
        const cost = harvestCost(tag, P);
        if (!isFinite(cost)) continue;
        list.push(reforge(`harv:${tag}|${F}`, () => {
          const st0 = new Array(K).fill(0);
          if (F >= 0) st0[F] = 1;
          const it0 = itemFor(F, st0, fjP(F), fjS(F));
          const tg0 = missingRollable(st0);
          const firstOuts = rollOutcomes(it0, tg0.map(k => T[k]), [[1, 1]], { tagOnly: tag });
          const outs = [];
          for (const o of firstOuts) {
            const [s1] = mapRoll(F, st0, fjP(F), fjS(F), tg0, [o]);
            const it1 = itemFor(F, s1.st, s1.jp, s1.js);
            const tg1 = missingRollable(s1.st);
            const rest = rerollDist(B, 0).map(([n, p]) => [Math.max(0, n - it1.mods.length), p]);
            outs.push(...mapRoll(F, s1.st, s1.jp, s1.js, tg1, rollOutcomes(it1, tg1.map(k => T[k]), rest, { tagMult: tag }), o.p));
          }
          return { name: `Harvest reforge with a ${tag} mod (${harvestText(tag)})`, family: 'harvest', cost, outs, bill: harvestBill(tag) };
        }));
      }
      // Influenced items: reforge with at least one influenced mod (5000 Primal + 1 Sacred).
      const inflCost = HARVEST_INFLUENCE[1] * P(lifeforce(HARVEST_INFLUENCE[0])) + P(SACRED);
      if (infl.length && isFinite(inflCost) && T.some(t => t.kind === 'roll' && infl.includes(t.m.src))) {
        list.push(reforge(`hinfl|${F}`, () => {
          const st0 = new Array(K).fill(0);
          if (F >= 0) st0[F] = 1;
          const it0 = itemFor(F, st0, fjP(F), fjS(F));
          const tg0 = missingRollable(st0);
          const outs = [];
          for (const o of rollOutcomes(it0, tg0.map(k => T[k]), [[1, 1]], { src: infl })) {
            const [s1] = mapRoll(F, st0, fjP(F), fjS(F), tg0, [o]);
            const it1 = itemFor(F, s1.st, s1.jp, s1.js);
            const tg1 = missingRollable(s1.st);
            const rest = rerollDist(B, 0).map(([n, p]) => [Math.max(0, n - it1.mods.length), p]);
            outs.push(...mapRoll(F, s1.st, s1.jp, s1.js, tg1, rollOutcomes(it1, tg1.map(k => T[k]), rest), o.p));
          }
          return { name: `Harvest reforge with an influenced mod (${HARVEST_INFLUENCE[1]} ${HARVEST_INFLUENCE[0]} Lifeforce + 1 Sacred)`, family: 'harvest', cost: inflCost, outs, bill: bill(one(lifeforce(HARVEST_INFLUENCE[0]), HARVEST_INFLUENCE[1]), one(SACRED)) };
        }));
      }
      // "More likely to receive the same modifier types": targets already on the item are ×10.
      const have = st.map((x, k) => (x === 1 && k !== F ? k : -1)).filter(k => k >= 0);
      const cost = HARVEST_MORE_LIKELY[1] * P(lifeforce(HARVEST_MORE_LIKELY[0]));
      if (have.length && isFinite(cost)) {
        list.push(reforge(`hmore:${have.join('.')}|${F}`, () => {
          const st0 = new Array(K).fill(0);
          if (F >= 0) st0[F] = 1;
          const it0 = itemFor(F, st0, fjP(F), fjS(F));
          const tg = missingRollable(st0);
          const ro = rollOutcomes(it0, tg.map(k => T[k]), rerollDist(B, it0.mods.length), { boost: new Set(have.map(k => T[k].m)) });
          return { name: `Harvest reforge more likely to keep the same types (${HARVEST_MORE_LIKELY[1]} ${HARVEST_MORE_LIKELY[0]} Lifeforce)`, family: 'harvest', cost, outs: mapRoll(F, st0, fjP(F), fjS(F), tg, ro), bill: one(lifeforce(HARVEST_MORE_LIKELY[0]), HARVEST_MORE_LIKELY[1]) };
        }));
      }
    }
    // Veiled Chaos: one veiled mod on a random open side, then the rest.
    if (veiledK >= 0 && allowed('vchaos') && F !== veiledK) {
      list.push(reforge(`vchaos|${F}`, () => {
        const V = T[veiledK], st0 = new Array(K).fill(0);
        if (F >= 0) st0[F] = 1;
        const q = unveilOdds(B, V.m);
        const outs = [];
        for (const sideV of ['p', 's']) {
          const it = itemFor(F, st0, fjP(F), fjS(F), [{ m: null, t: 0, side: sideV, veiled: true }]);
          const tg = missingRollable(st0);
          const ro = rollOutcomes(it, tg.map(k => T[k]), rerollDist(B, it.mods.length));
          for (const hit of sideV === V.side ? [true, false] : [false]) {
            const pv = 0.5 * (sideV === V.side ? (hit ? q : 1 - q) : 1);
            outs.push(...mapRoll(F, st0, sideV === 'p' && !hit ? 1 : 0, sideV === 's' && !hit ? 1 : 0, tg, ro, pv, hit ? (s2, a, b) => { const st = s2.slice(); st[veiledK] = 1; return { st, jp: a, js: b }; } : null));
          }
        }
        return { name: CUR.vchaos, family: 'vchaos', cost: P(CUR.vchaos), outs, bill: one(CUR.vchaos) };
      }));
    }
    // One-side rerolls: Eldritch Chaos on the dominant side, or lock the other side and Chaos.
    for (const side of ['p', 's']) {
      const other = side === 'p' ? 's' : 'p';
      const keepSt = st.map((x, k) => (T[k].side === other || k === F ? x : 0));
      const keepJ = { p: side === 'p' ? fjP(F) : jp, s: side === 's' ? fjS(F) : js };
      const cfg = `${F}|${keepSt.join('')}|${keepJ.p}${keepJ.s}`;
      const mk = (family, name, cost, b) => () => {
        const it = itemFor(F, keepSt, keepJ.p, keepJ.s);
        const tg = missingRollable(keepSt, k => T[k].side === side);
        const capSide = max[side] - count(it, side);
        const ro = rollOutcomes(it, tg.map(k => T[k]), rerollDist(B, it.mods.length, capSide), { side });
        return { name, family, cost, outs: mapRoll(F, keepSt, keepJ.p, keepJ.s, tg, ro), bill: b };
      };
      // Behind a lock the other side keeps its mods, but new ones can land in its free slots
      // (e.g. two life prefixes, "Prefixes Cannot Be Changed" + a crit reforge for a crit prefix).
      const mkLock = (family, name, cost, b) => () => {
        const it = itemFor(F, keepSt, keepJ.p, keepJ.s);
        const tg = missingRollable(keepSt);
        const ro = rollOutcomes(it, tg.map(k => T[k]), rerollDist(B, it.mods.length));
        return { name, family, cost, outs: mapRoll(F, keepSt, keepJ.p, keepJ.s, tg, ro), bill: b };
      };
      if (variant === side && allowed('eldritch')) list.push(reforge(`echaos:${side}|${cfg}`, mk('eldritch', CUR.echaos, P(CUR.echaos), one(CUR.echaos))));
      const lock = metaMod(B, side === 'p' ? 'nchg_suf' : 'nchg_pre');
      const nowP = sideCount(st, 'p') + jp, nowS = sideCount(st, 's') + js;
      const lp = lock ? lockPrice(lock, nowP, nowS) : null;
      // The lock sits on the side being rerolled, so it needs a free slot there.
      if (lock && allowed('lockchaos') && sideCount(st, side) + (side === 'p' ? jp : js) < max[side] && isFinite(lp.cost)) {
        list.push(reforge(`lock:${side}:${lp.via}|${cfg}`, mkLock('lockchaos', `${lockName(lock, lp)} + Chaos Orb`, P(CUR.chaos) + lp.cost, bill(lp.bill, one(CUR.chaos)))));
      }
      // Lock + Veiled Chaos: the unlocked side rerolls with the veiled mod on it.
      if (lock && veiledK >= 0 && T[veiledK].side === side && keepSt[veiledK] !== 1 && allowed('vchaos') && sideCount(st, side) + (side === 'p' ? jp : js) < max[side] && isFinite(lp.cost) && isFinite(P(CUR.vchaos))) {
        list.push(reforge(`lockv:${side}:${lp.via}|${cfg}`, () => {
          // The veiled mod lands on a random side with room: the locked side too, if it has a free slot.
          const q = unveilOdds(B, T[veiledK].m);
          const tg = missingRollable(keepSt);
          const lockedRoom = sideCount(keepSt, other) + keepJ[other] < max[other];
          const outs = [];
          for (const [vSide, pv] of lockedRoom ? [[side, 0.5], [other, 0.5]] : [[side, 1]]) {
            const it = itemFor(F, keepSt, keepJ.p, keepJ.s, [{ m: null, t: 0, side: vSide, veiled: true }]);
            const ro = rollOutcomes(it, tg.map(k => T[k]), rerollDist(B, it.mods.length));
            if (vSide === side) outs.push(...mapRoll(F, keepSt, keepJ.p, keepJ.s, tg, ro, pv * q, (s2, a, b) => { const st2 = s2.slice(); st2[veiledK] = 1; return { st: st2, jp: a, js: b }; }));
            outs.push(...mapRoll(F, keepSt, keepJ.p + (vSide === 'p'), keepJ.s + (vSide === 's'), tg, ro, vSide === side ? pv * (1 - q) : pv));
          }
          return { name: `${lockName(lock, lp)} + Veiled Chaos Orb`, family: 'vchaos', cost: P(CUR.vchaos) + lp.cost, outs, bill: bill(lp.bill, one(CUR.vchaos)) };
        }));
      }
      // Lock + Veiled Chaos with the veiled target on the locked side: the locked side keeps its
      // mods, and the veiled mod lands on a random side with room, so with a free slot there it
      // can land among the kept mods (half the time when both sides are open). E.g. two gem
      // prefixes and a free prefix slot: "Prefixes Cannot Be Changed" + Veiled Chaos.
      if (lock && veiledK >= 0 && T[veiledK].side === other && keepSt[veiledK] !== 1 && allowed('vchaos') && isFinite(lp.cost) && isFinite(P(CUR.vchaos))
        && sideCount(st, side) + (side === 'p' ? jp : js) < max[side] && sideCount(keepSt, other) + keepJ[other] < max[other]) {
        list.push(reforge(`lockvo:${side}:${lp.via}|${cfg}`, () => {
          const q = unveilOdds(B, T[veiledK].m, groupsOf(itemFor(F, keepSt, keepJ.p, keepJ.s)));
          const tg = missingRollable(keepSt);
          const outs = [];
          // The veiled mod on the locked side (a free slot there), or on the side being rerolled.
          for (const [vSide, pv] of [[other, 0.5], [side, 0.5]]) {
            const it = itemFor(F, keepSt, keepJ.p, keepJ.s, [{ m: null, t: 0, side: vSide, veiled: true }]);
            const ro = rollOutcomes(it, tg.map(k => T[k]), rerollDist(B, it.mods.length));
            if (vSide === other) {
              outs.push(...mapRoll(F, keepSt, keepJ.p, keepJ.s, tg, ro, pv * q, (s2, a, b) => { const st2 = s2.slice(); st2[veiledK] = 1; return { st: st2, jp: a, js: b }; }));
              outs.push(...mapRoll(F, keepSt, keepJ.p + (other === 'p'), keepJ.s + (other === 's'), tg, ro, pv * (1 - q)));
            } else outs.push(...mapRoll(F, keepSt, keepJ.p + (side === 'p'), keepJ.s + (side === 's'), tg, ro, pv));
          }
          return { name: `${lockName(lock, lp)} + Veiled Chaos Orb (the veiled mod can land on the locked side)`, family: 'vchaos', cost: P(CUR.vchaos) + lp.cost, outs, bill: bill(lp.bill, one(CUR.vchaos)) };
        }));
      }
      // Harvest reforges respect the lock too: today's "reforge keeping prefixes/suffixes".
      if (lock && allowed('harvest') && sideCount(st, side) + (side === 'p' ? jp : js) < max[side] && isFinite(lp.cost)) {
        for (const tag of harvestTags) {
          if (!missingRollable(keepSt, k => T[k].m.tags.includes(tag) && (T[k].side === side || sideCount(keepSt, other) + keepJ[other] < max[other])).length) continue;
          const cost = harvestCost(tag, P) + lp.cost;
          if (!isFinite(cost)) continue;
          list.push(reforge(`lockharv:${side}:${tag}:${lp.via}|${cfg}`, () => {
            // (The guaranteed mod and the rest can also land in the locked side's free slots.)
            const it0 = itemFor(F, keepSt, keepJ.p, keepJ.s);
            const tg0 = missingRollable(keepSt);
            const outs = [];
            for (const o of rollOutcomes(it0, tg0.map(k => T[k]), [[1, 1]], { tagOnly: tag })) {
              const [s1] = mapRoll(F, keepSt, keepJ.p, keepJ.s, tg0, [o]);
              const it1 = itemFor(F, s1.st, s1.jp, s1.js);
              const tg1 = missingRollable(s1.st);
              const rest = rerollDist(B, it1.mods.length);
              outs.push(...mapRoll(F, s1.st, s1.jp, s1.js, tg1, rollOutcomes(it1, tg1.map(k => T[k]), rest, { tagMult: tag }), o.p));
            }
            return { name: `${lockName(lock, lp)} + Harvest reforge with a ${tag} mod (${harvestText(tag)})`, family: 'harvest', cost, outs, bill: bill(lp.bill, harvestBill(tag)) };
          }));
        }
      }
    }
    const out = list.filter(Boolean);
    if (afOn) {
      for (const r of [...out]) {
        if (!AF_REF(r.family)) continue;
        out.push(reforge(`af|${r.rkey}`, () => ({ ...r, name: `Allflame bench (best of ${afK}): ${r.name}`, cost: r.cost + opt.sulphur * sulphur, bestOf: afK, bill: bill(r.bill, one(SULPHUR, opt.sulphur)) })));
      }
    }
    return out.filter(Boolean);
  }

  // ----- the Recombinator bench -----
  const recBill = bill(one(DUST, opt.recombDust), one(GOLD, opt.recombGold));
  const recCost = opt.recombDust * P(DUST) + opt.recombGold * P(GOLD);
  const recOn = !!B.info.recomb && !presetF && !opt.noAlt && isFinite(recCost);
  const magic = newItem(B, { ilvl, infl, rarity: 'magic' });
  const itemMemo = new Map();
  // Cheapest way to make a clean item holding exactly these targets (or null).
  function itemCost(ks) {
    const key = ks.join('.');
    if (itemMemo.has(key)) return itemMemo.get(key);
    let best = null;
    for (const core of magicCores(ks)) {
      const rest = ks.filter(k => !core.includes(k));
      if (rest.length > 1) continue;
      // The half goes into the Recombinator whole, so it must be clean: an Alteration that shows
      // exactly the core and nothing else (or one of two alone, then an Augment adds the other).
      const ct = core.map(k => T[k]);
      let pAlt = rollOutcomes(magic, ct, MAGIC_COUNTS).filter(o => o.st.every(x => x === 1) && o.np + o.ns === core.length).reduce((a, o) => a + o.p, 0);
      let perAlt = P(CUR.alt), augPer = 0;
      if (core.length === 2) ct.forEach((t, i) => {
        const only = odds(magic, [t], [[1, 1]]) * MAGIC_COUNTS.find(([n]) => n === 1)[1];
        const m1 = newItem(B, { ilvl, infl, rarity: 'magic' });
        m1.mods.push({ m: t.m, t: t.minTier, side: t.side });
        pAlt += only * odds(m1, [ct[1 - i]], [[1, 1]]); perAlt += only * P(CUR.aug); augPer += only;
      });
      if (!(pAlt > 0)) continue;
      const altCost = perAlt / pAlt + P(CUR.transmute);
      let cost = altCost, pr = 0, useImp = false, text = `Alteration spam a magic ${B.name} until it shows ${core.map(label).join(' and ')} and nothing else${core.length === 2 ? ' (Augment when only one shows, alone)' : ''} (${pctText(pAlt)} per alteration)`;
      if (rest.length) {
        const it = newItem(B, { ilvl, infl, rarity: 'rare' });
        for (const k of core) it.mods.push({ m: T[k].m, t: T[k].minTier, side: T[k].side });
        pr = odds(it, [T[rest[0]]], [[1, 1]]);
        if (!(pr > 0)) continue;
        const imp = opt.beasts ? (P(CUR.regal) + P(CUR.imprint)) / pr + P(CUR.imprint) : Infinity;
        const plain = (P(CUR.regal) + (1 - pr) * altCost) / pr;
        useImp = isFinite(imp) && imp < plain;
        cost += Math.min(isFinite(imp) ? imp : Infinity, plain);
        text += `, then ${useImp ? 'imprint it and ' : ''}Regal until it adds ${label(rest[0])} (${pctText(pr)})`;
      }
      if (!best || cost < best.cost) best = { cost, text, pAlt, augPer, rest: rest[0] ?? -1, pr, useImp };
    }
    itemMemo.set(key, best);
    return best;
  }
  // A recombine of clean items holding the targets S between them: each side keeps a number of
  // its pool (the table), which ones at random. -> [{st, p, full}]
  function recombStates(S) {
    const sideOuts = ks => {
      if (!ks.length) return [{ keep: [], p: 1 }];
      const out = [];
      for (const [kStr, pk] of Object.entries(RECOMB_COUNTS[Math.min(8, ks.length)])) {
        const k = Math.min(+kStr, ks.length), subs = [];
        const pickSub = (i, cur) => { if (cur.length === k) { subs.push(cur); return; } for (let j = i; j < ks.length; j++) pickSub(j + 1, [...cur, ks[j]]); };
        pickSub(0, []);
        for (const sub of subs) out.push({ keep: sub, p: pk / subs.length });
      }
      return out;
    };
    const out = [];
    for (const a of sideOuts(S.filter(k => T[k].side === 'p'))) for (const b of sideOuts(S.filter(k => T[k].side === 's'))) {
      const st2 = new Array(K).fill(0);
      [...a.keep, ...b.keep].forEach(k => { st2[k] = 1; });
      out.push({ st: st2, p: a.p * b.p, full: a.keep.length + b.keep.length === S.length });
    }
    return out;
  }

  // ----- moves that keep progress -----
  function moves(F, st, jp, js, variant) {
    const out = [];
    if (F === -2) return out;
    const it = itemFor(F, st, jp, js);
    const nP = count(it, 'p'), nS = count(it, 's');
    const total = nP + nS;
    const room = { p: nP < max.p, s: nS < max.s };
    const slam = (name, cost, base, opts, how, b) => {
      const tg = missingRollable(st);
      const ro = rollOutcomes(base, tg.map(k => T[k]), [[1, 1]], opts);
      if (!ro.length) return;
      out.push({ name, how, cost, outs: mapRoll(F, st, jp, js, tg, ro), bill: b });
    };
    if (isFinite(P(CUR.exalt))) {
      if (room.p || room.s) slam('Exalted Orb', P(CUR.exalt), it, {}, 'exalt', one(CUR.exalt));
      for (const [blockSide, slamSide] of [['s', 'p'], ['p', 's']]) {
        if (!room[blockSide] || !room[slamSide] || !missingRollable(st, k => T[k].side === slamSide).length) continue;
        const b = cheapestBlocker(B, it, blockSide, P);
        if (!b) continue;
        const it2 = clone(it); it2.mods.push({ m: b.m, t: b.t, side: blockSide, crafted: true });
        slam(`Bench "${modText(b.m, b.t)}", then Exalted Orb`, P(CUR.exalt) + b.cost, it2, {}, 'block', bill(one(CUR.exalt), b.bill));
      }
      for (const meta of ['no_attack', 'no_caster']) {
        const mm = metaMod(B, meta);
        if (!mm || !room[mm.affix]) continue;
        const tg = missingRollable(st);
        if (!tg.length || tg.some(k => T[k].m.tags.includes(meta === 'no_attack' ? 'attack' : 'caster'))) continue;
        const it3 = clone(it); it3.mods.push({ m: mm, t: 0, side: mm.affix, crafted: true });
        const lp = lockPrice(mm, count(it, 'p'), count(it, 's'));
        if (isFinite(lp.cost)) slam(`${lp.via === 'bench' ? 'Bench ' : ''}${lockName(mm, lp)}, then Exalted Orb`, P(CUR.exalt) + lp.cost, it3, {}, 'meta', bill(one(CUR.exalt), lp.bill));
      }
    }
    // "Can have up to 3 Crafted Modifiers": a metamod and a blocker together, so one Exalt
    // goes to one side with attack or caster mods out of the pool.
    const multi = metaMod(B, 'mul_mods');
    if (multi && isFinite(P(CUR.exalt))) {
      for (const meta of ['no_attack', 'no_caster']) {
        const mm = metaMod(B, meta);
        const tg = missingRollable(st);
        if (!mm || !tg.length || tg.some(k => T[k].m.tags.includes(meta === 'no_attack' ? 'attack' : 'caster'))) continue;
        for (const slamSide of ['p', 's']) {
          if (!missingRollable(st, k => T[k].side === slamSide).length) continue;
          const other = slamSide === 'p' ? 's' : 'p';
          const it4 = clone(it);
          it4.mods.push({ m: multi, t: 0, side: multi.affix, crafted: true }, { m: mm, t: 0, side: mm.affix, crafted: true });
          let extra = benchCost(multi, 0, P) + benchCost(mm, 0, P), mb = bill(benchBill(multi, 0), benchBill(mm, 0));
          if (count(it4, slamSide) >= max[slamSide] || count(it4, multi.affix) > max[multi.affix] || count(it4, mm.affix) > max[mm.affix]) continue;
          if (count(it4, other) < max[other]) {
            const b = cheapestBlocker(B, it4, other, P);
            if (!b) continue;
            it4.mods.push({ m: b.m, t: b.t, side: other, crafted: true });
            extra += b.cost; mb = bill(mb, b.bill);
          }
          if (count(it4, other) < max[other]) continue;
          slam(`Bench "${multi.text}" + "${mm.text}"${count(it, other) < max[other] ? ' + a blocker' : ''}, then Exalted Orb`, P(CUR.exalt) + extra, it4, {}, 'multimeta', bill(one(CUR.exalt), mb));
        }
      }
    }
    if (variant && room[variant] && isFinite(P(CUR.eexalt))) slam(CUR.eexalt, P(CUR.eexalt), it, { side: variant }, 'eexalt', one(CUR.eexalt));
    // Removals.
    const rem = (name, cost, side, how) => {
      const r = removeOne(F, st, jp, js, side);
      if (r.length) out.push({ name, how, cost, bill: one(name), outs: r.map(o => ({ key: enc(F, o.st, o.jp, o.js), F, st: o.st, jp: o.jp, js: o.js, p: o.p })) });
    };
    if (total) rem(CUR.annul, P(CUR.annul), null, 'annul');
    if (variant && total) rem(CUR.eannul, P(CUR.eannul), variant, 'eannul');
    // Lock one side, then Annul: only the other side can lose a mod (the
    // metamod sits on that side too, so it can eat the Annul).
    for (const side of ['p', 's']) {
      const lock = metaMod(B, side === 's' ? 'nchg_pre' : 'nchg_suf');
      if (!lock || lock.affix !== side || !room[side]) continue;
      const r = removeOne(F, st, jp, js, side);
      if (!r.length) continue;
      const n = (side === 'p' ? jp : js) + st.reduce((a, x, k) => a + (x === 1 && k !== F && T[k].side === side), 0);
      const outs = r.map(o => ({ key: enc(F, o.st, o.jp, o.js), F, st: o.st, jp: o.jp, js: o.js, p: o.p * n / (n + 1) }));
      outs.push({ key: enc(F, st, jp, js), F, st, jp, js, p: 1 / (n + 1) });
      const lp = lockPrice(lock, nP, nS);
      out.push({ name: `${lockName(lock, lp)} + ${CUR.annul}`, how: 'lockannul', side, cost: lp.cost + P(CUR.annul), outs, bill: bill(lp.bill, one(CUR.annul)) });
    }
    for (const side of ['p', 's']) {
      const lock = metaMod(B, side === 'p' ? 'nchg_suf' : 'nchg_pre');
      const onSide = (side === 'p' ? jp : js) + st.reduce((a, x, k) => a + (x === 1 && k !== F && T[k].side === side), 0);
      if (!lock || !room[side] || !onSide) continue;
      const st2 = st.map((x, k) => (T[k].side === side && k !== F ? 0 : x));
      const lp = lockPrice(lock, nP, nS);
      out.push({ name: `${lockName(lock, lp)} + ${CUR.scour}`, how: 'scour', cost: lp.cost + P(CUR.scour), bill: bill(lp.bill, one(CUR.scour)),
        outs: [{ key: enc(F, st2, side === 'p' ? fjP(F) : jp, side === 's' ? fjS(F) : js), F, st: st2, jp: side === 'p' ? fjP(F) : jp, js: side === 's' ? fjS(F) : js, p: 1 }] });
    }
    // With a junk mod fractured, starting a new base is always an option.
    if (F === -3 || F === -4) out.push({ name: 'Start a new base', how: 'restart', cost: 0, bill: {}, outs: [{ key: 'ruined', F: -2, st, jp, js, p: 1 }] });
    // Fracturing Orb: locks a random mod (rare, 4+ mods, not influenced, not already fractured).
    // A junk mod fractured only costs its slot; the base is ruined only when that side then
    // can't hold its targets, or when it's a wrong tier of a target (that mod group is stuck).
    // (Nor before an influenced Exalted Orb: those don't work on fractured items.)
    if (F === -1 && fixedF < 0 && !infl.length && !ctx.noFracture && total >= 4 && isFinite(P(FRACTURE))) {
      const outs = [];
      st.forEach((x, k) => { if (x === 1) outs.push({ key: enc(k, st, jp, js), F: k, st, jp, js, p: 1 / total }); });
      const deadN = st.filter(x => x === 2).length;
      let bad = deadN / total;
      for (const [side, Fj] of [['p', -3], ['s', -4]]) {
        const junk = (side === 'p' ? jp : js) - st.reduce((a, x, k) => a + (x === 2 && T[k].side === side), 0);
        if (junk <= 0) continue;
        const need = T.filter(t => t.side === side).length + reserve[side];
        if (need + 1 <= max[side]) outs.push({ key: enc(Fj, st, jp, js), F: Fj, st, jp, js, p: junk / total });
        else bad += junk / total;
      }
      if (bad > 0) outs.push({ key: 'ruined', F: -2, st, jp, js, p: bad });
      out.push({ name: FRACTURE, how: 'fracture', cost: P(FRACTURE), outs, bill: one(FRACTURE) });
    }
    // Veiled Exalted Orb: removes a random mod, adds a veiled one.
    if (veiledK >= 0 && st[veiledK] === 0 && total && isFinite(P(CUR.vexalt))) {
      const q = unveilOdds(B, T[veiledK].m, groupsOf(it));
      const outs = [];
      for (const r of removeOne(F, st, jp, js)) {
        const cp = sideCount(r.st, 'p') + r.jp, cs = sideCount(r.st, 's') + r.js;
        const open = ['p', 's'].filter(s => (s === 'p' ? cp : cs) < max[s]);
        for (const s of open) {
          const ps = r.p / open.length;
          if (s === T[veiledK].side) {
            const st2 = r.st.slice(); st2[veiledK] = 1;
            outs.push({ key: enc(F, st2, r.jp, r.js), F, st: st2, jp: r.jp, js: r.js, p: ps * q });
            outs.push({ key: enc(F, r.st, r.jp + (s === 'p'), r.js + (s === 's')), F, st: r.st, jp: r.jp + (s === 'p'), js: r.js + (s === 's'), p: ps * (1 - q) });
          } else outs.push({ key: enc(F, r.st, r.jp + (s === 'p'), r.js + (s === 's')), F, st: r.st, jp: r.jp + (s === 'p'), js: r.js + (s === 's'), p: ps });
        }
      }
      if (outs.length) out.push({ name: CUR.vexalt, how: 'vexalt', cost: P(CUR.vexalt), outs, bill: one(CUR.vexalt) });
    }
    // Harvest "add a mod of a type" (removes another random mod; non-influenced items).
    if (!infl.length && isFinite(P(SACRED))) {
      for (const tag of harvestTags.filter(x => HARVEST_ADD[x])) {
        if (!missingRollable(st, k => T[k].m.tags.includes(tag)).length) continue;
        const [col, amt] = HARVEST_ADD[tag];
        const cost = amt * P(lifeforce(col)) + P(SACRED);
        if (!isFinite(cost)) continue;
        // The new mod goes on first, then another random mod (never the new one) is removed.
        // With no room for a mod of the type, the removal comes first to make some.
        const outs = [];
        const tg0 = missingRollable(st);
        const added = mapRoll(F, st, jp, js, tg0, rollOutcomes(itemFor(F, st, jp, js), tg0.map(k => T[k]), [[1, 1]], { tagOnly: tag }));
        if (added.reduce((a, o) => a + o.p, 0) > 1e-9) {
          for (const a of added) {
            const k = a.st.findIndex((x, i) => x !== st[i]);
            const keep = k >= 0 ? { k } : { side: a.jp > jp ? 'p' : 's' };
            const rs = removeOne(F, a.st, a.jp, a.js, null, keep);
            for (const r of rs.length ? rs : [{ st: a.st, jp: a.jp, js: a.js, p: 1 }]) outs.push({ key: enc(F, r.st, r.jp, r.js), F, st: r.st, jp: r.jp, js: r.js, p: a.p * r.p });
          }
        } else {
          for (const r of total ? removeOne(F, st, jp, js) : []) {
            const tg = missingRollable(r.st);
            outs.push(...mapRoll(F, r.st, r.jp, r.js, tg, rollOutcomes(itemFor(F, r.st, r.jp, r.js), tg.map(k => T[k]), [[1, 1]], { tagOnly: tag }), r.p));
          }
        }
        if (outs.length) out.push({ name: `Harvest: add a ${tag} mod`, how: 'hadd', cost, outs, bill: bill(one(lifeforce(col), amt), one(SACRED)) });
      }
    }
    // A side lock, then Harvest "add a mod of a type": the locked side keeps its mods, so the
    // removal can only hit the other side (or the metamod itself, which then just goes). With the
    // locked side full, the new mod lands on the open side: "Prefixes Cannot Be Changed" + add a
    // chaos mod to give a suffix without risking the prefixes.
    if (!infl.length && isFinite(P(SACRED))) {
      for (const tag of harvestTags.filter(x => HARVEST_ADD[x])) {
        if (!missingRollable(st, k => T[k].m.tags.includes(tag)).length) continue;
        const [col, amt] = HARVEST_ADD[tag];
        // Optionally also "Cannot roll Attack/Caster Modifiers" (with "Can have up to 3 Crafted
        // Modifiers" so both metamods fit), when none of the wanted mods has that tag: the add then
        // can't land e.g. "Adds # to # Chaos Damage" (an attack mod) instead of a wanted chaos mod.
        const blockers = [null, ...['no_attack', 'no_caster'].filter(b => metaMod(B, b) && metaMod(B, 'mul_mods') && !T.some(t => t.m.tags.includes(b === 'no_attack' ? 'attack' : 'caster')))];
        for (const keepSide of ['p', 's']) for (const blk of blockers) {
          const lock = metaMod(B, keepSide === 'p' ? 'nchg_pre' : 'nchg_suf');
          if (!lock || lock.affix === keepSide) continue;
          const open = lock.affix; // the metamod sits on the side that can change
          const metas = blk ? [metaMod(B, 'mul_mods'), lock, metaMod(B, blk)] : [lock];
          const room2 = { p: max.p - nP, s: max.s - nS };
          for (const x of metas) room2[x.affix]--;
          if (room2.p < 0 || room2.s < 0) continue; // the metamods need their slots (the new mod's room is checked below)
          const lp = lockPrice(lock, nP, nS);
          const extraCost = blk ? (benchCost(metas[0], 0, P) ?? Infinity) + (benchCost(metas[2], 0, P) ?? Infinity) : 0;
          const cost = (blk ? (benchCost(lock, 0, P) ?? Infinity) : lp.cost) + extraCost + amt * P(lifeforce(col)) + P(SACRED);
          if (!isFinite(cost)) continue;
          const metaMods = metas.map(x => ({ m: x, t: 0, side: x.affix, crafted: true }));
          const tg0 = missingRollable(st);
          const added = mapRoll(F, st, jp, js, tg0, rollOutcomes(itemFor(F, st, jp, js, metaMods), tg0.map(k => T[k]), [[1, 1]], { tagOnly: tag }));
          if (added.reduce((a, o) => a + o.p, 0) < 1e-9) continue;
          const outs = [];
          for (const a of added) {
            // The removal: a mod on the open side other than the new one, or the metamod.
            const k = a.st.findIndex((x, i) => x !== st[i]);
            const keep = k >= 0 ? { k } : { side: a.jp > jp ? 'p' : 's' };
            const rs = removeOne(F, a.st, a.jp, a.js, open, keep);
            const nRem = (open === 'p' ? a.jp : a.js) + a.st.reduce((x, v, i) => x + ((v === 1 && i !== F) || v === 2 ? T[i].side === open : 0), 0) - 1;
            const nMeta = metaMods.filter(x => x.side === open).length;
            const pMeta = nMeta / (Math.max(0, nRem) + nMeta);
            outs.push({ key: enc(F, a.st, a.jp, a.js), F, st: a.st, jp: a.jp, js: a.js, p: a.p * (rs.length ? pMeta : 1) });
            for (const r of rs) outs.push({ key: enc(F, r.st, r.jp, r.js), F, st: r.st, jp: r.jp, js: r.js, p: a.p * (1 - pMeta) * r.p });
          }
          out.push({ name: blk ? `Bench "${metas[0].text}" + "${lock.text}" + "${metas[2].text}", then Harvest: add a ${tag} mod` : `${lockName(lock, lp)} + Harvest: add a ${tag} mod`, how: 'lockhadd', cost, outs,
            bill: bill(blk ? bill(benchBill(metas[0], 0), benchBill(lock, 0), benchBill(metas[2], 0)) : lp.bill, one(lifeforce(col), amt), one(SACRED)) });
        }
      }
    }
    // Farric Wolf Alpha (prefix -> suffix) and Lynx Alpha (suffix -> prefix).
    for (const [from, to, beast] of [['p', 's', CUR.wolf], ['s', 'p', CUR.lynx]]) {
      if (!opt.beasts || !room[to] || !isFinite(P(beast)) || !missingRollable(st, k => T[k].side === to).length) continue;
      const outs = [];
      for (const r of removeOne(F, st, jp, js, from)) {
        const it2 = itemFor(F, r.st, r.jp, r.js);
        const tg = missingRollable(r.st);
        const ro = rollOutcomes(it2, tg.map(k => T[k]), [[1, 1]], { side: to });
        outs.push(...mapRoll(F, r.st, r.jp, r.js, tg, ro, r.p));
      }
      if (outs.length) out.push({ name: beast, how: 'beast', cost: P(beast), outs, bill: one(beast) });
    }
    // Recombine again: the item holds only wanted mods (no junk, no wrong tier, nothing fractured),
    // so it can go into the Recombinator with a new clean item carrying some missing ones. Each
    // result is a clean item with the survivors; the strategy takes it from there.
    if (recOn && F === -1 && jp === 0 && js === 0 && st.some(x => x === 1) && !st.some(x => x === 2)) {
      const have = st.map((x, k) => (x === 1 ? k : -1)).filter(k => k >= 0);
      const miss = missingRollable(st).filter(k => T[k].kind === 'roll');
      for (let mask = 1; mask < 1 << miss.length; mask++) {
        const M = miss.filter((k, i) => mask & (1 << i));
        if (M.length > 3) continue;
        const S = [...have, ...M];
        if (S.filter(k => T[k].side === 'p').length > max.p || S.filter(k => T[k].side === 's').length > max.s) continue;
        const ic = itemCost(M);
        if (!ic) continue;
        const outs = recombStates(S).map(o => ({ key: enc(-1, o.st, 0, 0), F: -1, st: o.st, jp: 0, js: 0, p: o.p }));
        // (The new item's currency, on average: Alterations until it shows, and the Regal if any.)
        const itemBill = bill(one(CUR.transmute), one(CUR.alt, 1 / ic.pAlt), ic.augPer ? one(CUR.aug, ic.augPer / ic.pAlt) : null,
          ic.rest >= 0 ? (ic.useImp ? bill(one(CUR.imprint, 1 / ic.pr), one(CUR.regal, 1 / ic.pr)) : bill(one(CUR.regal, 1 / ic.pr), one(CUR.alt, (1 / ic.pr - 1) / ic.pAlt))) : null);
        out.push({ name: `Recombinator with a new clean item carrying ${M.map(label).join(' and ')}`, how: 'recomb', cost: ic.cost + recCost, outs, bill: bill(itemBill, recBill), recItem: ic, recAdd: M });
      }
    }
    const extra = [];
    const lastMod = st.filter(x => x !== 1).length === 1;
    for (const m of out) {
      if (afOn && AF_MOVE.has(m.how)) {
        const sul = (m.how === 'fracture' ? opt.sulphurFracture : opt.sulphur) * sulphur;
        extra.push({ ...m, name: `Allflame bench (best of ${afK}): ${m.name}`, cost: m.cost + sul, bestOf: afK, bill: bill(m.bill, one(SULPHUR, m.how === 'fracture' ? opt.sulphurFracture : opt.sulphur)) });
      }
      // The Hinekora's Lock currency only on the last mod: one wanted mod missing, and only a
      // preview that finishes the item counts as good.
      if (hkOn && lastMod && (m.how === 'exalt' || m.how === 'block' || m.how === 'meta' || m.how === 'eexalt')) {
        extra.push({ ...m, name: `${HK_LOCK} + ${m.name}`, how: 'hk', curCost: m.cost, cost: m.cost + hkLock, foresee: true, bill: one(HK_LOCK), curBill: m.bill });
      }
    }
    return [...out, ...extra].filter(m => isFinite(m.cost));
  }

  // Outcome distribution when you see k outcomes and keep the best one.
  const valueOf = o => (o.n.done ? 0 : o.n.V);
  // pShow: the chance the bench shows the k outcomes at all (Intangibility); otherwise just one.
  function bestOf(outs, k, pShow = 1) {
    const merged = new Map();
    for (const o of outs) merged.set(o.n, (merged.get(o.n) ?? 0) + o.p);
    const xs = [...merged].map(([n, p]) => ({ n, p, v: n.done ? 0 : n.V })).sort((a, b) => a.v - b.v);
    let tail = xs.reduce((a, x) => a + x.p, 0);
    return xs.map(x => { const next = Math.max(0, tail - x.p); const p = tail ** k - next ** k; tail = next; return { n: x.n, p: pShow * p + (1 - pShow) * x.p }; }).filter(o => o.p > 0);
  }
  // Re-derive the outcome lists that depend on current values (Allflame, Hinekora).
  function refreshDynamic(nodes, refs) {
    for (const n of nodes) {
      for (const m of n.moves ?? []) {
        if (m.bestOf) m.outs = bestOf(m.baseOuts, m.bestOf, m.pShow);
        else if (m.foresee) {
          // A good preview (pA): apply the currency. A bad one: the Lock is spent, the item unchanged.
          const good = m.baseOuts.filter(o => o.n.done);
          const pA = good.reduce((a, o) => a + o.p, 0);
          if (pA > 1e-12) { m.outs = [...good, { p: 1 - pA, n }]; m.cost = hkLock + pA * m.curCost; m.pA = pA; }
          else { m.outs = m.baseOuts; m.cost = Infinity; m.pA = 0; }
        }
      }
    }
    for (const r of refs) if (r.bestOf) r.nodes = bestOf(r.baseNodes, r.bestOf, r.pShow);
  }

  const paste = ctx.sub ? null : pastedState(spec.start);
  // ----- the solver -----
  const moveCache = new Map(); // moves don't depend on which reforges a run allows
  function solve(variant, label0, warm = null) {
    const states = new Map(); // key -> node
    const wraps = new Map(); // reforge key -> this solve's copy (R, links to nodes)
    // (A reforge's copy is per Allflame count a: its results keep the item's count, one more
    // when it's done at the Allflame bench.)
    const wrap = (r, a = 0) => {
      const wk = a ? `${r.rkey}~a${a}` : r.rkey;
      let w = wraps.get(wk);
      if (!w) { w = { ...r, R: Infinity, stop: 0, a, pShow: r.bestOf ? afShow(a) : 1 }; wraps.set(wk, w); }
      return w;
    };
    const linkRef = w => { if (w.linked) return; w.linked = true; const a2 = w.a + (w.bestOf ? 1 : 0); w.nodes = w.outs.map(o => ({ p: o.p, n: node(o.key, o.F, o.st, o.jp, o.js, a2) })); w.baseNodes = w.nodes; };
    const startKey = 'start';
    // a: Allflame crafts already done on this item (finished items don't care).
    const node = (key, F, st, jp, js, a = 0) => {
      const done = F !== -2 && isDone(st, jp, js);
      if (done || key === 'ruined') a = 0;
      const k2 = a ? `${key}~a${a}` : key;
      let n = states.get(k2);
      if (!n) {
        n = { key: k2, bkey: key, a, F, st, jp, js, done, V: 0, W: Infinity, best: null };
        states.set(k2, n);
        queue.push(n);
      }
      return n;
    };
    const queue = [];
    const st0 = new Array(K).fill(0);
    if (fixedF >= 0) st0[fixedF] = 1;
    const F0 = fixedF;
    const start = { key: startKey, F: F0, st: st0, jp: 0, js: 0, start: true, V: 0, W: Infinity };
    states.set(startKey, start);
    const ruined = node('ruined', -2, st0, 0, 0);
    // Your item: its state (a rare), or the results of the Regal that makes a magic one rare.
    let pasted = null;
    if (paste && !paste.why) {
      if (!paste.magic) pasted = { n: node(paste.key, paste.F, paste.st, paste.jp, paste.js) };
      else {
        const tgR = missingRollable(paste.st);
        const ro = rollOutcomes(itemFor(paste.F, paste.st, paste.jp, paste.js), tgR.map(k => T[k]), [[1, 1]]);
        pasted = { regal: mapRoll(paste.F, paste.st, paste.jp, paste.js, tgR, ro).map(o => ({ p: o.p, n: node(o.key, o.F, o.st, o.jp, o.js) })) };
      }
    }
    // Start moves: reforges from a fresh base, Alteration/Regal composites.
    start.refs = reforgesFor(F0, st0, 0, 0, variant).filter(r => r.family !== 'eldritch' && r.family !== 'lockchaos').map(r => wrap(r, 0));
    // (Harvest "more likely" needs mods on the item, so it never shows up here.)
    start.alts = [];
    if (fixedF < 0 && allowed('alt') && !opt.noAlt && isFinite(P(CUR.alt))) {
      const magic = newItem(B, { ilvl, infl, rarity: 'magic' });
      const tg = missingRollable(st0);
      // Every Alteration result, as wanted mods (aimed for or a bonus), wrong tiers and junk.
      const altRolls = rollOutcomes(magic, tg.map(k => T[k]), MAGIC_COUNTS);
      for (const core of magicCores(tg)) {
        const ct = core.map(k => T[k]), ci = core.map(k => tg.indexOf(k));
        // Results that show the core; a second mod that isn't one of them is junk the Regal keeps.
        const shown = altRolls.filter(o => ci.every(i => o.st[i] === 1));
        const parts = mapRoll(-1, st0, 0, 0, tg, shown);
        let p = shown.reduce((a, o) => a + o.p, 0), perTry = P(CUR.alt), augPer = 0;
        if (core.length === 2) {
          // Only one of the two, alone: an Augment can add the other.
          const stM = st0.slice(); core.forEach(k => { stM[k] = 1; });
          ct.forEach((t, i) => {
            const only = odds(magic, [t], [[1, 1]]) * MAGIC_COUNTS.find(([n]) => n === 1)[1];
            const m1 = newItem(B, { ilvl, infl, rarity: 'magic' });
            m1.mods.push({ m: t.m, t: t.minTier, side: t.side });
            const aug = odds(m1, [ct[1 - i]], [[1, 1]]);
            p += only * aug; perTry += only * P(CUR.aug); augPer += only;
            if (only * aug > 0) parts.push({ key: enc(-1, stM, 0, 0), F: -1, st: stM, jp: 0, js: 0, p: only * aug });
          });
        }
        if (!(p > 0)) continue;
        // The Regal adds one mod to whichever of those the magic item is.
        // An imprint brings back that same magic item (junk and all), so each kind of magic
        // item keeps its own Regal results.
        const merged = new Map(), byPart = new Map();
        for (const pt of parts) {
          const tgR = missingRollable(pt.st);
          const ro = rollOutcomes(itemFor(-1, pt.st, pt.jp, pt.js), tgR.map(k => T[k]), [[1, 1]]);
          const part = byPart.get(pt.key) ?? { share: 0, outs: mapRoll(-1, pt.st, pt.jp, pt.js, tgR, ro).map(o => ({ ...o, n: node(o.key, o.F, o.st, o.jp, o.js) })) };
          part.share += pt.p / p;
          byPart.set(pt.key, part);
          for (const o of mapRoll(-1, pt.st, pt.jp, pt.js, tgR, ro, pt.p / p)) {
            const x = merged.get(o.key);
            if (x) x.p += o.p; else merged.set(o.key, o);
          }
        }
        const outs = [...merged.values()].map(o => ({ ...o, n: node(o.key, o.F, o.st, o.jp, o.js) }));
        start.alts.push({ core, p, altCost: perTry / p + P(CUR.transmute), augPer, outs, parts: [...byPart.values()] });
      }
    }
    for (const r of start.refs) linkRef(r);
    // Explore everything reachable.
    let explored = 0;
    const t0 = Date.now();
    while (queue.length) {
      const n = queue.shift();
      if (n.F === -2 || n.done) { n.moves = []; n.refs = []; continue; }
      const mk = (variant ?? '') + '|' + n.bkey;
      if (!moveCache.has(mk)) moveCache.set(mk, moves(n.F, n.st, n.jp, n.js, variant));
      n.moves = moveCache.get(mk).filter(m => !m.bestOf || n.a < afUses).map(m => {
        const a2 = n.a + (m.bestOf ? 1 : 0);
        const outs = m.outs.map(o => ({ p: o.p, n: o.key === 'ruined' ? ruined : node(o.key, o.F, o.st, o.jp, o.js, a2) }));
        return { ...m, outs, baseOuts: outs, ...(m.bestOf ? { pShow: afShow(n.a), afUse: n.a + 1 } : {}) };
      });
      n.refs = reforgesFor(n.F, n.st, n.jp, n.js, variant).filter(r => !r.bestOf || n.a < afUses).map(r => wrap(r, n.a));
      for (const r of n.refs) linkRef(r);
      if (++explored > 40000) break;
    }

    SOLVER.tExplore += Date.now() - t0; SOLVER.states = Math.max(SOLVER.states, states.size);
    const t1 = Date.now();
    const nodes = [...states.values()].filter(n => !n.start);
    const refsAll = [...new Set(nodes.flatMap(n => n.refs ?? []).concat(start.refs))];
    // Policy iteration. Start from a strategy that is sure to finish (always
    // take a move with a chance to get one step closer to done), solve its
    // expected costs exactly as a linear system, switch each state to its
    // cheapest move, and repeat until nothing changes.
    let startV = Infinity;
    const startChoice = () => {
      let sv = Infinity, sb = null;
      for (const r of start.refs) {
        const c0 = r.family === 'chaos' || r.family === 'lockchaos' || r.family === 'harvest' ? P(CUR.alch) : 0;
        if (r.R + c0 < sv) { sv = r.R + c0; sb = { ref: r, c0 }; }
      }
      for (const a of start.alts) {
        const outs = a.outs.map(o => ({ p: o.p, A: o.n.done ? 0 : o.n.V }));
        const noImp = stopValue(a.altCost + P(CUR.regal), outs);
        let imp = { R: Infinity };
        if (opt.beasts && isFinite(P(CUR.imprint))) {
          imp = { R: 0, stop: 0 };
          for (const pt of a.parts) {
            const sv = stopValue(P(CUR.regal) + P(CUR.imprint), pt.outs.map(o => ({ p: o.p, A: o.n.done ? 0 : o.n.V })));
            imp.R += pt.share * sv.R; imp.stop += pt.share * (sv.stop ?? 0);
          }
        }
        // Hinekora's Lock on the magic item (beast recipe): one look at the Regal; regal only a good
        // one, otherwise the Lock is spent and it's back to alterations for a new magic item.
        let hk = { R: Infinity };
        if (hkMagicOn) {
          const xs = outs.filter(o => isFinite(o.A)).sort((x, y) => x.A - y.A);
          let pA = 0, pAV = 0;
          for (const o of xs) {
            pA += o.p; pAV += o.p * o.A;
            const R = (a.altCost + hkSetup + pA * P(CUR.regal) + pAV) / pA;
            if (R < hk.R) hk = { R, stop: pA, cut: o.A };
          }
        }
        const v = Math.min(noImp.R, a.altCost + imp.R, hk.R);
        a.V = v; a.hk = hk.R === v ? hk : null; a.imp = !a.hk && a.altCost + imp.R < noImp.R; a.stop = a.hk ? hk.stop : a.imp ? imp.stop : noImp.stop;
        if (v < sv) { sv = v; sb = { alt: a }; }
      }
      start.best = sb;
      return sv;
    };
    // Steps-to-done distances (optimistic), over moves and reforges.
    for (const n of nodes) n.dist = n.done ? 0 : Infinity;
    for (const r of refsAll) r.dist = Infinity;
    for (let changed = true, guard = 0; changed && guard < 200; guard++) {
      changed = false;
      for (const r of refsAll) {
        const d = 1 + Math.min(...r.nodes.map(o => o.n.dist));
        if (d < r.dist) { r.dist = d; changed = true; }
      }
      for (const n of nodes) {
        if (n.done || n === ruined) continue;
        let d = Infinity, pick = null;
        for (const m of n.moves) { const x = 1 + Math.min(...m.outs.map(o => o.n.dist)); if (x < d) { d = x; pick = { move: m }; } }
        for (const r of n.refs) if (r.dist < d) { d = r.dist; pick = { ref: r }; }
        if (d < n.dist) { n.dist = d; n.pol = pick; changed = true; }
      }
    }
    // States that can't finish, and actions that can land in them, are out.
    const ok = n => n.done || (n === ruined ? true : isFinite(n.dist));
    for (let changed = true; changed;) {
      changed = false;
      for (const n of nodes) {
        if (n.done || n === ruined || !isFinite(n.dist)) continue;
        const usable = a => (a.move ? a.move.outs.every(o => ok(o.n)) : a.ref.nodes.every(o => ok(o.n)));
        if (n.pol && usable(n.pol)) continue;
        let alt = null, d = Infinity;
        for (const m of n.moves) if (m.outs.every(o => ok(o.n))) { const x = 1 + Math.min(...m.outs.map(o => o.n.dist)); if (x < d) { d = x; alt = { move: m }; } }
        for (const r of n.refs) if (r.nodes.every(o => ok(o.n)) && r.dist < d) { d = r.dist; alt = { ref: r }; }
        if (alt) n.pol = alt; else { n.dist = Infinity; n.pol = null; changed = true; }
      }
    }
    const live = nodes.filter(n => !n.done && n !== ruined && isFinite(n.dist));
    const liveRefs = refsAll.filter(r => r.nodes.every(o => ok(o.n)));
    for (const n of nodes) if (!n.done && !live.includes(n)) n.V = Infinity;
    for (const r of refsAll) r.R = Infinity;
    start.best = (() => {
      let best = null, d = Infinity;
      for (const r of start.refs) if (liveRefs.includes(r) && r.dist < d) { d = r.dist; best = { ref: r, c0: r.family === 'chaos' ? P(CUR.alch) : 0 }; }
      return best;
    })();
    // Warm start: begin from another solve's strategy (a family's), where it's usable here.
    // Policy iteration only improves on its starting strategy, so the result can't be worse.
    // If the borrowed strategy can't be evaluated here (it can loop without finishing), the
    // solve falls back to the usual starting strategy.
    const cold = { pols: new Map(live.map(n => [n, n.pol])), best: start.best };
    if (warm) {
      const usable = a => (a.move ? a.move.outs.every(o => ok(o.n)) : a.ref.nodes.every(o => ok(o.n)));
      for (const n of live) {
        const w = warm.states.get(n.key)?.pol;
        if (!w) continue;
        const a = w.ref ? (() => { const r = n.refs.find(x => x.rkey === w.ref.rkey); return r && { ref: r }; })()
          : (() => { const m = n.moves.find(x => x.name === w.move.name && x.how === w.move.how); return m && { move: m }; })();
        if (a && usable(a)) n.pol = a;
      }
      const wb = warm.start.best;
      if (wb?.ref) { const r = start.refs.find(x => x.rkey === wb.ref.rkey); if (r && liveRefs.includes(r)) start.best = { ref: r, c0: wb.c0 }; }
    }
    const ruinedLive = nodes.includes(ruined);
    let warmed = !!warm;
    for (let round = 0; round < 40; round++) {
      start.V = startV;
      refreshDynamic(live, liveRefs);
      let x = evaluate(live, liveRefs, ruinedLive ? ruined : null, start);
      if (warmed && round === 0 && (!x || !(start.V < 1e17))) {
        for (const [n, p] of cold.pols) n.pol = p;
        start.best = cold.best; start.V = startV = Infinity; warmed = false;
        for (const r of liveRefs) r.R = Infinity;
        x = evaluate(live, liveRefs, ruinedLive ? ruined : null, start);
        if (SOLVER.debug) SOLVER.debug(`${label0}: the borrowed strategy didn't evaluate; started fresh`);
      }
      if (!x) break;
      // Improve.
      let changed = 0;
      for (const n of live) {
        let best = n.pol?.move ? qMove(n.pol.move) : n.pol?.ref ? n.pol.ref.R : Infinity, pick = n.pol;
        for (const m of n.moves) { const v = qMove(m); if (v < best * (1 - 1e-9) - 1e-9) { best = v; pick = { move: m }; } }
        for (const r of n.refs) if (r.R < best * (1 - 1e-9) - 1e-9) { best = r.R; pick = { ref: r }; }
        if (pick !== n.pol) { n.pol = pick; changed++; }
      }
      const prev = start.best;
      startV = startChoice();
      if (start.best?.ref !== prev?.ref || start.best?.alt !== prev?.alt) changed++;
      SOLVER.iters = round;
      if (!changed) break;
    }
    refreshDynamic(live, liveRefs);
    startV = startChoice();
    ruined.V = startV;
    // What the trace and texts read.
    for (const n of live) {
      n.bestRef = n.pol?.ref ?? null; n.bestMove = n.pol?.move ?? null;
      n.W = n.bestMove ? qMove(n.bestMove) : Infinity;
      for (const m of n.moves) { const v = qMove(m); if (v < n.W && !n.bestMove) { n.W = v; } }
    }
    if (SOLVER.debug && SOLVER.verbose) {
      const avail = {}, used = {};
      for (const n of live) { for (const m of n.moves) avail[m.how] = (avail[m.how] ?? 0) + 1; const h = n.pol?.move?.how ?? (n.pol?.ref ? 'ref:' + n.pol.ref.family : 'none'); used[h] = (used[h] ?? 0) + 1; }
      SOLVER.debug('available ' + JSON.stringify(avail) + ' used ' + JSON.stringify(used));
    }
    for (const r of liveRefs) r.stop = r.nodes.reduce((a, o) => a + (o.n.done || o.n.pol?.ref !== r ? o.p : 0), 0);
    SOLVER.tSolve += Date.now() - t1;
    return { start, startV, states, variant, label0, pasted };
  }
  const qMove = m => m.outs.reduce((a, o) => a + o.p * (o.n.done ? 0 : o.n.V), m.cost);
  // Expected cost of the current strategy for every state: x_i = c_i + Σ p_ij x_j.
  // States that just take a reforge are aliases of it; a reforge's repeats
  // into itself are divided out (they make the system nearly singular).
  function evaluate(live, refs, ruined, start) {
    const id = new Map();
    let N = 0;
    for (const r of refs) id.set(r, N++);
    const iStart = N++;
    for (const n of live) if (!n.pol?.ref) id.set(n, N++);
    const col = n => (n.done ? -1 : n.pol?.ref ? id.get(n.pol.ref) ?? -2 : n === ruined ? iStart : id.get(n) ?? -2);
    const rows = new Array(N);
    const build = (i, c, outs) => {
      const acc = new Map();
      let diag = 1, bad = false;
      for (const o of outs) {
        const j = col(o.n);
        if (j === -1) continue;
        if (j === -2) { bad = true; break; }
        if (j === i) diag -= o.p; else acc.set(j, (acc.get(j) ?? 0) + o.p);
      }
      if (bad || diag <= 1e-15 || !isFinite(c)) return { c: 1e18, a: [] };
      return { c: c / diag, a: [...acc].map(([j, p]) => [j, p / diag]) };
    };
    for (const r of refs) rows[id.get(r)] = build(id.get(r), r.cost, r.nodes);
    const sb = start.best;
    rows[iStart] = sb?.ref && id.has(sb.ref) ? { c: sb.c0, a: [[id.get(sb.ref), 1]] } : { c: isFinite(start.V) ? start.V : 1e18, a: [] };
    for (const n of live) if (!n.pol?.ref) rows[id.get(n)] = n.pol?.move ? build(id.get(n), n.pol.move.cost, n.pol.move.outs) : { c: 1e18, a: [] };
    const x0 = new Float64Array(N);
    for (const r of refs) x0[id.get(r)] = isFinite(r.R) ? r.R : 0;
    x0[iStart] = isFinite(start.V) ? start.V : 0;
    for (const n of live) if (!n.pol?.ref) x0[id.get(n)] = isFinite(n.V) ? n.V : 0;
    const x = solveDirect(rows) ?? solveLinear(rows, x0) ?? gaussSeidel(rows, x0);
    if (!x) return null;
    for (const r of refs) r.R = x[id.get(r)] >= 1e17 ? Infinity : x[id.get(r)];
    start.V = x[iStart];
    for (const n of live) n.V = n.pol?.ref ? n.pol.ref.R : x[id.get(n)] >= 1e17 ? Infinity : x[id.get(n)];
    if (ruined) ruined.V = start.V;
    return x;
  }
  function bestOtherRef(n, self) {
    let v = Infinity;
    for (const r of n.refs ?? []) if (r !== self && r.R < v) v = r.R;
    return v;
  }

  // ----- describing a solution as steps -----
  // ess: the essence a reforge used ({k, m, t}): its mod is that essence's tier, not just the wanted one.
  const essLabel = (k, ess) => (ess && ess.k === k ? shortMod(ess.m, ess.t) : label(k));
  const essOf = r => (r.family.startsWith('essence:') ? essences.find(e => 'essence:' + e.name === r.family) ?? null : null);
  const stateText = (n, ess = null) => {
    const have = n.st.map((x, k) => (x === 1 ? essLabel(k, ess) + (n.F === k ? ' (fractured)' : '') : null)).filter(Boolean);
    if (n.F === -3 || n.F === -4) have.push(`a fractured junk ${SIDE_NAME[n.F === -3 ? 'p' : 's']}`);
    const dead = n.st.map((x, k) => (x === 2 ? label(k) : null)).filter(Boolean);
    const junk = n.jp + n.js - dead.length - (n.F === -3 || n.F === -4 ? 1 : 0);
    return [have.length ? `has ${have.join(', ')}` : 'has none of the targets', dead.length ? `a wrong tier of ${dead.join(', ')}` : null, junk > 0 ? `${junk} other mod${junk > 1 ? 's' : ''}` : null].filter(Boolean).join('; ');
  };
  // An example item for a planner state: its targets (at their lowest wanted tier), a wrong tier
  // where one is blocked, the fractured mod, and filler junk: the base's commonest mods that fit.
  const junkPool = (() => {
    const by = new Map();
    for (const e of C_pool(B, ilvl, infl)) { const r = by.get(e.m) ?? { m: e.m, w: 0, ts: [] }; r.w += e.w; r.ts.push(e.t); by.set(e.m, r); }
    return [...by.values()].sort((a, b) => b.w - a.w);
  })();
  function exampleItem(n, ess = null) {
    if (!n || n.F === -2 || !n.st) return null;
    const ex = { p: [], s: [] };
    const used = new Set(T.flatMap(t => t.m.groups));
    T.forEach((t, k) => {
      if (n.st[k] === 1) ex[t.side].push({ text: ess?.k === k ? modText(ess.m, ess.t) : modText(t.m, t.minTier), kind: 'hit', frac: n.F === k });
      else if (n.st[k] === 2) ex[t.side].push({ text: modText(t.m, Math.max(0, t.minTier - 1)), kind: 'dead' });
    });
    for (const side of ['p', 's']) {
      let left = (side === 'p' ? n.jp : n.js) - n.st.filter((x, k) => x === 2 && T[k].side === side).length;
      let fr = (side === 'p' && n.F === -3) || (side === 's' && n.F === -4);
      for (const r of junkPool) {
        if (left <= 0) break;
        if (r.m.affix !== side || r.m.groups.some(g => used.has(g))) continue;
        ex[side].push({ text: modText(r.m, r.ts[Math.floor(r.ts.length * 0.6)] ?? 0), kind: 'junk', frac: fr });
        r.m.groups.forEach(g => used.add(g));
        fr = false; left--;
      }
    }
    if (n.magic) ex.magic = true;
    return ex;
  }
  // The magic item an Alteration step aims for: just its core targets.
  const magicExample = core => { const ex = { p: [], s: [], magic: true }; for (const k of core) ex[T[k].side].push({ text: modText(T[k].m, T[k].minTier), kind: 'hit' }); return ex; };
  // Other moves from a state that cost within 1% of the chosen one (the plan picks one; these are
  // as good in practice). -> " About as good: …" or ''.
  const aboutAsGood = (n, chosen) => {
    const best = n.V;
    if (!isFinite(best) || best <= 0) return '';
    const names = new Set();
    const opts = [...(n.moves ?? []).map(m => ({ name: m.bestOf ? `Allflame ${m.name}` : m.name, v: qMove(m), x: m })), ...(n.refs ?? []).map(r => ({ name: r.name, v: r.R, x: r }))];
    for (const o of opts.sort((a, b) => a.v - b.v)) {
      if (o.x === chosen || o.name === chosen?.name || !(o.v <= best * 1.01)) continue;
      names.add(o.name);
      if (names.size >= 2) break;
    }
    return names.size ? ` About as good (within 1%): ${[...names].join('; ')}.` : '';
  };
  function trace(sol, opt = sol.start.best) {
    const steps = [];
    // A plan from a given state (Recombinator, your own item) brings its own first steps.
    const fresh = !opt?.node;
    if (presetF && fresh) steps.push({ text: `Start from a base with "${modText(presetF.m, presetF.minTier)}" fractured (bought; its price isn't counted).`, p: 1, cost: 0, how: 'Fractured base' });
    if (fresh) steps.push(...inflSteps);
    if (sol.variant && fresh) {
      const nT = B.mods.find(m => m.affix === 'r')?.tiers.length ?? 4;
      const hi = Math.min(2, nT - 1);
      steps.push({ text: `First apply ${ELDRITCH_TIERS[sol.variant === 'p' ? hi : 0]} Eldritch Ember and ${ELDRITCH_TIERS[sol.variant === 'p' ? 0 : hi]} Eldritch Ichor so the ${sol.variant === 'p' ? 'Searing Exarch' : 'Eater of Worlds'} implicit is stronger: Eldritch currency then works on ${SIDE_NAME[sol.variant]}es. (An Orb of Conflict flips dominance in about ${fmtN(conflictCost(sol.variant === 'p' ? hi : 0, sol.variant === 'p' ? 0 : hi, nT, sol.variant === 'p' ? 's' : 'p'))} orbs if needed.)`, p: 1, cost: eldCost(sol.variant), how: 'Eldritch implicits' });
    }
    let cur;
    // The steps so far, so a move that sets the item back can say "back to step N".
    const path = []; // {idx, node (the state the step starts from), ref (its reforge, if any)}
    // A bricked item means a new base, and every step so far (buying a fractured base,
    // influence, Eldritch implicits, recombining) is per base: a new base starts at step 1.
    if (opt?.node) { steps.push(...opt.pre); cur = opt.node; } else if (opt?.ref) {
      const r = opt.ref;
      const st0 = refStep(r, true);
      cur = likelyStop(r.nodes, r.R);
      path.push({ idx: steps.length, node: null, ref: r });
      steps.push({ ...st0, flow: refFlow(r), ex: exampleItem(cur, essOf(r)), simKey: r, bill: r.bill ?? one(r.name) });
    } else if (opt?.alt) {
      const a = opt.alt;
      const core = a.core.map(label).join(' and ');
      const altIdx = steps.length;
      // A failed Augment leaves a magic item with the wrong second mod: alterate again.
      steps.push({ flow: [{ kind: 'on', p: a.p }, { kind: 'again', p: 1 - a.p, note: a.core.length === 2 ? 'wrong mods (or a failed Augment)' : 'wrong mods' }], ex: magicExample(a.core), text: `Orb of Transmutation, then Orb of Alteration until the magic item shows ${core}${a.core.length === 2 ? ' (Augment when only one shows)' : ''}: ${pctText(a.p)} per alteration, about ${fmtN(tries(a.p))}.`, p: a.p, cost: a.altCost, rem: a.V, how: 'Alteration' });
      steps.push(a.hk
        ? { text: `While it's still magic, give it Hinekora's Lock with the Bestiary recipe (${HK_SETUP.join(' + ')}): it shows what the Regal Orb will do. Regal only if the result is good (${pctText(a.stop)} of the time); otherwise the Lock is spent, so alterate a new magic item and lock it again (about ${fmtN(tries(a.stop))} Locks).`, p: a.stop, cost: a.V - a.altCost, rem: a.V - a.altCost, how: "Hinekora's Lock + Regal" }
        : { text: `${a.imp ? 'Imprint it (Craicic Chimeral), then ' : ''}Regal Orb. Keep the result ${pctText(a.stop)} of the time${a.imp ? '; otherwise restore the imprint and regal again' : '; otherwise go back to alterations'}.`, p: a.stop, cost: a.V - a.altCost, rem: a.V - a.altCost, how: a.imp ? 'Regal + Imprint' : 'Regal' });
      const miss = 1 - a.stop;
      steps[steps.length - 1].flow = [{ kind: 'on', p: a.stop }, a.imp && !a.hk
        ? { kind: 'again', p: miss, note: 'bad Regal: restore the imprint' }
        : { kind: 'back', p: miss, to: altIdx, note: a.hk ? 'bad look (the Lock is spent)' : 'bad Regal' }];
      cur = likelyStop(a.outs, Infinity);
      steps[steps.length - 1].ex = exampleItem(cur);
    }
    for (let i = 0; cur && !cur.done && i < 14; i++) {
      if (cur === sol.states.get('ruined')) break;
      const useRef = cur.bestRef && cur.bestRef.R <= cur.W;
      if (useRef) {
        const before = cur;
        cur = likelyStop(cur.bestRef.nodes, cur.bestRef.R);
        path.push({ idx: steps.length, node: before, ref: before.bestRef });
        const st1 = refStep(before.bestRef, false, before);
        st1.text += aboutAsGood(before, before.bestRef);
        steps.push({ ...st1, flow: refFlow(before.bestRef, before), from: stateText(before), exFrom: exampleItem(before), ex: exampleItem(cur, essOf(before.bestRef)), simKey: before.bestRef, bill: before.bestRef.bill ?? one(before.bestRef.name) });
        continue;
      }
      const m = cur.bestMove;
      if (!m) break;
      const good = m.outs.filter(o => o.n.V < cur.V - 1e-9 || o.n.done);
      const pGood = good.reduce((a, o) => a + o.p, 0);
      const nxt = good.sort((a, b) => b.p - a.p)[0] ?? m.outs.sort((a, b) => b.p - a.p)[0];
      const flow = stepFlow(m, cur, good, path, opt?.paste ? null : 0);
      path.push({ idx: steps.length, node: cur, ref: null });
      steps.push({ from: stateText(cur), exFrom: exampleItem(cur), ex: exampleItem(nxt?.n), flow, simKey: cur, bill: m.bill ?? one(m.name), text: (m.bestOf ? `At the Allflame bench (Allflame craft ${m.afUse} of at most ${afUses} on this item; ${pctText(m.pShow)} chance it still shows ${m.bestOf} outcomes to keep the best of, otherwise just one): ` : '') + moveText(m, cur, pGood).replace(/^Allflame bench \(best of \d\): /, '') + aboutAsGood(cur, m), p: pGood, cost: cur.V, rem: cur.V, how: m.bestOf ? 'Allflame ' + m.how : m.how });
      cur = nxt?.n;
    }
    for (const s of steps) if (s.flow) s.flow = s.flow.filter(f => f.p > 1e-4);
    steps.push(...finalSteps(opt?.swaps));
    if (benchT.length) steps.push({ text: `Bench-craft ${benchT.length > 1 ? '"Can have up to 3 Crafted Modifiers", then ' : ''}${benchT.map(t => `"${modText(t.m, t.minTier)}"`).join(' and ')}.`, p: 1, cost: benchCostTotal, how: 'Crafting bench' });
    return steps;
  }
  // Where a move's outcomes lead, in terms of the listed steps: on (a good result), again (the
  // item is unchanged), back to an earlier step (the same reforge, or the same wanted mods as
  // then), a new base, or elsewhere (a state the likeliest path doesn't pass).
  function stepFlow(m, cur, good, path, restartTo = 0) {
    // From a result off the path, the plan's likeliest moves (up to four) until it is back on a
    // listed step: {names, to: step index, 'self' (this step again) or 'done'}.
    const follow = n0 => {
      const names = [];
      let n = n0;
      for (let h = 0; h < 4 && n && !n.done; h++) {
        const ref = n.pol?.ref, mv = n.pol?.move;
        if (!ref && !mv) break;
        names.push(ref ? ref.name : mv.name);
        n = ref ? likelyStop(ref.nodes, ref.R) : [...mv.outs].sort((a, b) => b.p - a.p)[0]?.n;
        if (!n) break;
        if (n === cur) return { names, to: 'self' };
        const e = path.findLast(x => x.node === n || (x.ref && n.pol?.ref === x.ref));
        if (e) return { names, to: e.idx };
        if (n.done) return { names, to: 'done' };
      }
      return names.length ? { names, to: '' } : null;
    };
    const goodSet = new Set(good);
    // What a result did to the item: wanted mods it took away, wrong tiers it rolled.
    const what = n => {
      // (The ruined state has no mods of its own to compare: say why the base is lost.)
      if (n.key === 'ruined') return m.how === 'fracture' ? 'a junk mod fractured where the targets need the slot' : '';
      const lost = cur.st.map((x, k) => (x === 1 && n.st[k] !== 1 ? k : -1)).filter(k => k >= 0);
      const dead = n.st.map((x, k) => (x === 2 && cur.st[k] !== 2 ? k : -1)).filter(k => k >= 0 && !lost.includes(k));
      const freed = cur.st.map((x, k) => (x === 2 && n.st[k] === 0 ? k : -1)).filter(k => k >= 0);
      const parts = [];
      if (lost.length) parts.push(`loses ${lost.map(label).join(' and ')}`);
      if (freed.length) parts.push(`clears the lower tier of ${freed.map(label).join(' and ')}`);
      if (dead.length) parts.push(`rolls a lower tier of ${dead.map(label).join(' and ')}`);
      if (n.F === -3 || n.F === -4) parts.push('junk fractured');
      if (!parts.length && n.F === cur.F && n.st.every((x, k) => x === cur.st[k])) parts.push('only junk changes');
      return parts.join(', ').replace(/\|/g, '/');
    };
    const where = n => {
      if (n === cur) return 'again';
      const note = what(n);
      if (n.F === -2 || n.key === 'ruined') return `new|${note === 'only junk changes' ? '' : note}`;
      for (let i = path.length - 1; i >= 0; i--) {
        const e = path[i];
        // "Back to step N" only when it really is that step again: the same reforge (it rerolls
        // everything), or exactly the item that step started from.
        if (e.ref && n.pol?.ref === e.ref) return `back:${e.idx}|${note}|reforge`;
        if (e.node && n === e.node) return `back:${e.idx}|${note}`;
      }
      // Off the path: what happened, what the plan does next, and where that leads.
      if (n.pol?.move?.how === 'restart') return `new|${note}`;
      const ch = follow(n);
      if (ch) return `else|${note}|${ch.names.join(' → ')}|${ch.to}`;
      // The same move next, on a changed item (a beast moved a junk mod across): not "again" from
      // here, since the item isn't the same (each beast use fills a slot on the other side).
      if (n.pol?.move && n.pol.move.how === m.how && n.pol.move.name === m.name) return `else|${note}|${m.name} again`;
      const next = n.done ? '' : n.pol?.ref?.name ?? n.pol?.move?.name ?? '';
      return `else|${note}|${next}`;
    };
    const acc = new Map(), repOf = new Map();
    for (const o of m.outs) {
      const k = goodSet.has(o) ? 'on' : where(o.n);
      acc.set(k, (acc.get(k) ?? 0) + o.p);
      if (!repOf.has(k) || o.p > repOf.get(k).p) repOf.set(k, o);
    }
    // What a result did, for the page's pop-up: the wanted mods lost (shown struck out on the
    // item), lower tiers rolled or cleared, and the item afterwards.
    const change = k => {
      const n = repOf.get(k)?.n;
      if (!n || !n.st || n.key === 'ruined' || k === 'on' || k === 'again') return {};
      const txt = j => modText(T[j].m, T[j].minTier);
      const lost = cur.st.map((x, j) => (x === 1 && n.st[j] !== 1 ? j : -1)).filter(j => j >= 0);
      const dead = n.st.map((x, j) => (x === 2 && cur.st[j] !== 2 && !lost.includes(j) ? j : -1)).filter(j => j >= 0);
      const freed = cur.st.map((x, j) => (x === 2 && n.st[j] === 0 ? j : -1)).filter(j => j >= 0);
      const chg = { lost: lost.map(txt), dead: dead.map(txt), freed: freed.map(txt), junkFrac: n.F === -3 || n.F === -4 };
      if (!chg.lost.length && !chg.dead.length && !chg.freed.length && !chg.junkFrac) return {};
      const ex = n.F === -2 ? null : exampleItem(n);
      if (ex) for (const j of lost) ex[T[j].side].unshift({ text: txt(j), kind: 'lost' });
      return { chg, ex };
    };
    const order = k => (k === 'on' ? 0 : k === 'again' ? 1 : k.startsWith('back') ? 2 : k.startsWith('new') ? 3 : 4);
    // Rare results (under 1%, past the first four) are folded together.
    const all = [...acc].filter(([, p]) => p > 1e-4).sort((a, b) => order(a[0]) - order(b[0]) || b[1] - a[1]);
    const shown = all.filter(([k, p], i) => k === 'on' || i < 4 || p >= 0.01);
    const restP = all.filter(x => !shown.includes(x)).reduce((a, [, p]) => a + p, 0);
    if (restP > 1e-4) shown.push(['else|other results|', restP]);
    return shown.map(([k, p]) => ({ ...flowOf(k, p), ...change(k) }));
    function flowOf(k, p) {
      if (k.startsWith('back:')) { const [to, note, how] = k.slice(5).split('|'); return { kind: 'back', to: +to, p, note: note || undefined, reforge: how === 'reforge' }; }
      if (k.startsWith('else|')) { const [, note, next, to] = k.split('|'); return { kind: 'else', p, note, next, back: to === 'self' || to === 'done' ? to : to !== '' && to != null ? +to : null }; }
      if (k.startsWith('new|')) return { kind: 'new', p, note: k.slice(4) || 'bricked', to: restartTo };
      if (k === 'again') return { kind: 'again', p, note: 'nothing changes' };
      return { kind: k, p };
    }
  }
  // A Recombinator half: Alterations until it shows its mods (then a Regal, if it needs one).
  const halfFlow = ic => [{ kind: 'on', p: ic.pAlt }, { kind: 'again', p: 1 - ic.pAlt, note: 'wrong or extra mods' }];
  // A repeated reforge: it moves on when it stops, anything else is the next try.
  const hitsOf = n => n?.st ? n.st.filter(x => x === 1).length : (fixedF >= 0 ? 1 : 0);
  const afGood = (r, from) => r.nodes.filter(o => o.n.done || hitsOf(o.n) > hitsOf(from));
  const refFlow = (r, from = null) => {
    if (r.bestOf) {
      const p = afGood(r, from).reduce((a, o) => a + o.p, 0);
      return [{ kind: 'on', p }, ...(p < 1 - 1e-4 ? [{ kind: 'else', p: 1 - p, note: 'no wanted mod added', next: 'the plan carries on from the item it left' }] : [])];
    }
    return [{ kind: 'on', p: r.stop }, ...(r.stop < 1 - 1e-4 ? [{ kind: 'again', p: 1 - r.stop, note: 'nothing worth keeping (it rerolls again)' }] : [])];
  };
  const likelyStop = (nodes, R) => {
    const stops = nodes.filter(o => o.n.done || Math.min(o.n.W, o.n.V) < R - 1e-9);
    return (stops.sort((a, b) => b.p - a.p)[0] ?? nodes.sort((a, b) => b.p - a.p)[0])?.n;
  };
  function refStep(r, first, from = null) {
    // (An Allflame reforge is done once: every result moves on, so the good ones are those that
    // add a wanted mod.)
    const stops = (r.bestOf ? afGood(r, from) : r.nodes.filter(o => o.n.done || Math.min(o.n.W, bestOtherRef(o.n, r)) < r.R - 1e-9)).sort((a, b) => b.p - a.p);
    // States that read the same (they differ only in which side the junk is on) are merged.
    const byText = new Map();
    const ess = essOf(r);
    for (const o of stops) { const t = stateText(o.n, ess); const x = byText.get(t) ?? { p: 0, n: o.n }; x.p += o.p; byText.set(t, x); }
    const merged = [...byText].sort((a, b) => b[1].p - a[1].p);
    const what = r.family === 'fossil' ? `${r.name} in a ${RESONATORS[r.name.split(' + ').length - 1]}` : r.name;
    // (At the Allflame bench every try is one more Allflame craft on the item.)
    const afNote = r.bestOf ? ` (Allflame craft ${r.a + 1} of at most ${afUses} on this item; ${pctText(r.pShow)} chance it still shows ${r.bestOf} outcomes)` : '';
    // The good results (where the strategy moves on) go in a list the page shows on demand.
    const results = merged.slice(0, 8).map(([t, x]) => ({ text: t, p: x.p, done: !!x.n.done, ex: exampleItem(x.n, ess) }));
    const rest = merged.slice(8).reduce((a, [, x]) => a + x.p, 0);
    // How often it stops with a side already full while a wanted mod for that side is missing:
    // then a slot has to be freed first (an Annul, or a lock + Annul) before anything can add it.
    const blocked = n => ['p', 's'].filter(side => n.st.some((x, k) => x !== 1 && T[k].side === side && T[k].kind === 'roll')
      && sideCount(n.st, side) + (side === 'p' ? n.jp : n.js) + reserve[side] >= max[side]);
    const stopP = stops.reduce((a, o) => a + o.p, 0);
    const fullBy = { p: 0, s: 0 };
    for (const o of stops) for (const side of blocked(o.n)) fullBy[side] += o.p;
    const fullText = ['p', 's'].filter(side => fullBy[side] / Math.max(1e-12, stopP) > 0.01)
      .map(side => ` ${pctText(fullBy[side] / stopP)} of those stop with the ${SIDE_NAME[side]}es full while one is still wanted: a slot has to be freed first (an Annul, or a lock + Annul).`).join('');
    return {
      text: `${first && (r.family === 'chaos') ? 'Orb of Alchemy, then ' : ''}${what}${afNote}${r.bestOf ? ', once: keep the best outcome it shows.' : `, repeated until ${merged.length === 1 && merged[0][1].n.done ? 'the item is done' : `one of ${merged.length} good result${merged.length === 1 ? '' : 's'}`}: ${pctText(r.stop)} per try, about ${fmtN(tries(r.stop))} tries.`}${fullText}`,
      results, resultsRest: rest,
      p: r.bestOf ? stopP : r.stop, cost: r.R, rem: r.R, how: r.family.startsWith('essence') ? 'Essence' : r.family === 'fossil' ? 'Fossils' : r.name,
    };
  }
  function moveText(m, n, pGood) {
    const missing = n.st.map((x, k) => (x === 0 ? label(k) : null)).filter(Boolean);
    switch (m.how) {
      case 'fracture': return `${FRACTURE}: it fractures one of its ${n.st.filter(x => x === 1).length + n.jp + n.js} mods at random, a target ${pctText(pGood)} of the time, and that mod can never be lost. A fractured junk mod just keeps its slot for good (the base is only ruined if the targets need that slot).`;
      case 'restart': return `Start a new base: a junk mod fractured where the plan can't use it is cheaper to abandon than to work around.`;
      case 'annul': return `Orb of Annulment to clear junk: ${pctText(pGood)} it removes something you don't need.`;
      case 'eannul': return `Eldritch Orb of Annulment (removes only from the dominant side): ${pctText(pGood)} it hits junk.`;
      case 'scour': return `${m.name}: wipes the other side's junk and keeps this side.`;
      case 'vexalt': return `Veiled Exalted Orb: removes a random mod and adds a veiled one; unveil for ${label(veiledK)} (${pctText(pGood)} overall).`;
      case 'lockannul': return `${m.name}: only ${SIDE_NAME[m.side]}es can go (the metamod itself 1 time in ${fmtN(1 / m.outs[m.outs.length - 1].p)}); ${pctText(pGood)} it removes a mod you don't need. Remove the metamod after.`;
      case 'multimeta': return `${m.name} for ${missing.slice(0, 3).join(' / ')}: ${pctText(pGood)} per try. Remove the crafted mods after.`;
      case 'hk': return `${m.name}, for the last mod only: the Lock (${fmtC(hkLock)}; the item is rare, so the beast recipe doesn't work) shows one result; apply the currency only if it finishes the item (${pctText(m.pA ?? 0)} of the time). A bad preview can't be rerolled (changing the item ends the foresight), so that Lock is spent: about ${fmtN(tries(m.pA ?? 0))} Locks on average, ${fmtN(triesAt(m.pA ?? 0, 0.9))} for a 90% chance.`;
      case 'hadd': return `${m.name} (it also removes a random mod): ${pctText(pGood)} it lands a missing target.`;
      case 'lockhadd': return `${m.name}: the new mod goes on, then a random mod on the unlocked side (or the metamod) is removed; the locked side is safe. ${pctText(pGood)} it lands a missing target.`;
      case 'beast': {
        // It removes a random mod from its side first: say how often that's a wanted one.
        const pLose = m.outs.filter(o => n.st.some((x, k) => x === 1 && o.n.st[k] !== 1)).reduce((a, o) => a + o.p, 0);
        return `${m.name}: removes a random ${m.name === CUR.wolf ? 'prefix' : 'suffix'} and adds a ${m.name === CUR.wolf ? 'suffix' : 'prefix'}; ${pctText(pGood)} it lands a missing target${pLose > 1e-4 ? `, ${pctText(pLose)} it takes away a wanted mod` : ' (it only removes junk here)'}.`;
      }
      case 'recomb': return `Make a clean item with ${m.recAdd.map(label).join(' and ')} (${m.recItem.text.charAt(0).toLowerCase() + m.recItem.text.slice(1)}), then put it and this item in the Recombinator bench (unpredictable mode; ${fmtN(opt.recombDust)} ${DUST} + ${fmtN(opt.recombGold)} gold): ${pctText(pGood)} of the time it comes out better; whatever survives is still a clean item.`;
      default: return `${m.name} for ${missing.slice(0, 3).join(' / ')}: ${pctText(pGood)} per try.`;
    }
  }
  const eldCost = d => {
    const nT = B.mods.find(m => m.affix === 'r')?.tiers.length ?? 4;
    const hi = Math.min(2, nT - 1);
    return P(`${ELDRITCH_TIERS[d === 'p' ? hi : 0]} Eldritch Ember`) + P(`${ELDRITCH_TIERS[d === 'p' ? 0 : hi]} Eldritch Ichor`);
  };

  // ----- runs -----
  // One solve with every method; each way to begin (Chaos, an essence, fossils,
  // Alteration, Veiled Chaos) is then ranked by its true value with best play
  // after it. Eldritch implicits change which moves exist, so they get their own
  // solves. Fossil combos (up to 4) are scored against a first solve and the
  // best three join the final one ("fossil auto-calculation").
  const results = [];
  const mirror = P('Mirror of Kalandra');
  const solveTimed = (name, variant, warm) => {
    const tr = Date.now();
    const sol = solve(variant, name, warm);
    if (SOLVER.debug) SOLVER.debug(`${name}: ${sol.states.size} states, ${Date.now() - tr} ms, ${SOLVER.iters + 1} rounds`);
    return sol;
  };
  // Restricted solves show each method family on its own (with every finishing
  // move still allowed); the unrestricted one is the overall best.
  const families = [
    ['Chaos spam', f => f === 'chaos'],
    ...(essences.length ? [['Essence spam', f => f.startsWith('essence:')]] : []),
    ...(fixedF < 0 && !opt.noAlt ? [['Alteration / Regal', f => f === 'alt']] : []),
    ...(veiledK >= 0 ? [['Veiled Chaos spam', f => f === 'vchaos']] : []),
    ...(harvestTags.length ? [['Harvest reforges', f => f === 'harvest']] : []),
  ];
  // ----- the state graph: run the strategy many times through the state
  // machine and count which classes of states it passes and how it moves. -----
  const prefK = T.map((t, k) => k).filter(k => T[k].side === 'p'), sufK = T.map((t, k) => k).filter(k => T[k].side === 's');
  function classOf(n) {
    if (n.done) return { id: 'done', label: 'Done', c: K, done: true };
    if (n.key === 'ruined') return { id: 'ruined', label: 'Ruined (a fracture that blocks a target): new base', c: -1, ruined: true };
    const c = n.st.filter(x => x === 1).length, dead = n.st.filter(x => x === 2).length;
    const junk = n.jp + n.js;
    const pre = prefK.length > 0 && prefK.every(k => n.st[k] === 1), suf = sufK.length > 0 && sufK.every(k => n.st[k] === 1);
    const full = c + junk >= B.slots;
    const frac = n.F >= 0 || n.F === -3 || n.F === -4;
    const parts = [`${c} of ${K} wanted`];
    if (pre) parts.push('prefixes done');
    if (suf) parts.push('suffixes done');
    if (frac) parts.push('1 fractured');
    if (junk) parts.push(full ? `${junk} junk, full` : `${junk} junk`);
    void dead; // a wrong tier counts as junk here; the typical-item text names it
    return { id: `${c}|${pre ? 1 : 0}${suf ? 1 : 0}|${frac ? 1 : 0}|${junk}|${full ? 1 : 0}`, label: parts.join(' · '), c, junk, frac, pre, suf, full };
  }
  // Graph arrow names; currency names here show as icons.
  const HOW = { restart: 'New base', hk: `${HK_LOCK} + ${CUR.exalt}`, exalt: CUR.exalt, block: `Blocker + ${CUR.exalt}`, meta: `Metamod + ${CUR.exalt}`, multimeta: `Multimod + ${CUR.exalt}`,
    eexalt: CUR.eexalt, annul: CUR.annul, eannul: CUR.eannul, lockannul: `Lock + ${CUR.annul}`, scour: `Lock + ${CUR.scour}`, fracture: FRACTURE, vexalt: CUR.vexalt,
    beast: 'Farric beast', hadd: 'Harvest: add a mod', lockhadd: 'Lock + Harvest add', recomb: 'Recombinator' };
  // from: start each craft at your own item instead ({n}: its state, {regal}: a magic one's Regal).
  function simulateGraph(sol, extra, maxRuns = 500, budgetMs = 1200, maxMoves = 4000, minRuns = 50, from = null) {
    const t0 = Date.now();
    let runs = 0, unfinished = 0;
    const rnd = mulberry32(12345);
    const nodes = new Map(), edges = new Map(), costs = [];
    const node = (cl, n) => {
      let x = nodes.get(cl.id);
      if (!x) { x = { ...cl, visits: 0, runs: 0, lastRun: -1, Vsum: 0, Vn: 0, reps: new Map() }; nodes.set(cl.id, x); }
      return x;
    };
    const visit = (x, run, n) => {
      x.visits++;
      if (x.lastRun !== run) { x.runs++; x.lastRun = run; }
      if (n && isFinite(n.V) && !n.done) { x.Vsum += n.V; x.Vn++; x.reps.set(n, (x.reps.get(n) ?? 0) + 1); }
      if (n?.done) x.doneRep ??= n;
    };
    const edge = (a, b, action, tries = 1, cost = 0) => {
      const k = a.id + '>' + b.id + '>' + action;
      const e = edges.get(k) ?? { from: a.id, to: b.id, action, n: 0, tries: 0, cost: 0 };
      e.n++; e.tries += tries; e.cost += cost;
      edges.set(k, e);
    };
    const pickOut = (outs, filter = null) => {
      let tot = 0;
      for (const o of outs) if (!filter || filter(o)) tot += o.p;
      let x = rnd() * tot;
      for (const o of outs) { if (filter && !filter(o)) continue; if ((x -= o.p) < 0) return o; }
      return outs[outs.length - 1];
    };
    const geom = p => (p >= 1 ? 1 : 1 + Math.floor(Math.log(1 - rnd()) / Math.log(1 - p)));
    const baseCl = { id: 'base', label: from?.label ?? (from ? 'Your item' : presetF ? 'Fractured base' : 'Normal base'), c: presetF ? 1 : 0, start: true };
    const st = sol.start;
    // Currency used per craft: name -> count, for each simulated run.
    const usage = [];
    // Once per craft: influence setup, Eldritch implicits, swaps (when the element came out
    // wrong), and the bench crafts at the end.
    const fixedBill = r => {
      const b = [];
      // (Your own item already has its influence.)
      if ((!from || from.infl) && inflSteps.some(x => /randomise influence/.test(x.text))) b.push(one(lifeforce(INFLUENCE_RANDOMISE[0]), geomR(r, 1 / 6) * INFLUENCE_RANDOMISE[1]));
      if ((!from || from.infl) && inflSteps.some(x => /Awakener's Orb/.test(x.text))) b.push(one(AWAKENER));
      if (sol.variant && !eldT.length) {
        const nT = B.mods.find(m => m.affix === 'r')?.tiers.length ?? 4, hi = Math.min(2, nT - 1);
        b.push(one(`${ELDRITCH_TIERS[sol.variant === 'p' ? hi : 0]} Eldritch Ember`), one(`${ELDRITCH_TIERS[sol.variant === 'p' ? 0 : hi]} Eldritch Ichor`));
      }
      if (eldTargetCost > 0) b.push({ [ELD_VALUE]: eldTargetCost });
      if (!from?.noSwaps) for (const x of from?.swaps ?? swaps) if (x.share > 0.01 && isFinite(x.cost) && r() < x.share) b.push(one(lifeforce(x.colour), RES_SWAP_AMOUNT), x.rancour ? one(RANCOUR, DMG_SWAP_RANCOUR) : null);
      if (!ctx.sub) for (const t of benchT) b.push(benchBill(t.m, t.minTier));
      if (!ctx.sub && benchT.length > 1) b.push(benchBill(metaMod(B, 'mul_mods'), 0));
      return bill(...b);
    };
    let use = null;
    // How many times each step's move runs in each craft (a reforge by its strategy, any other
    // move by the state it's used from), bricked items and loops back included.
    const stepRuns = new Map();
    let ran = null;
    const runStep = (key, n) => { ran.set(key, (ran.get(key) ?? 0) + n); };
    const spend = (b, n = 1) => { if (!b || !n) return; for (const [k, v] of Object.entries(b)) use[k] = (use[k] ?? 0) + v * n; };
    for (let run = 0; run < maxRuns && (run < minRuns || Date.now() - t0 < budgetMs); run++) {
      runs++;
      use = {};
      usage.push(use);
      ran = new Map();
      spend(fixedBill(rnd));
      let cost = extra, cur = null, guard = 0;
      const b = node(baseCl);
      visit(b, run);
      // Getting onto the state machine.
      const enter = () => {
        const sb = st.best;
        if (sb?.ref) {
          const r = sb.ref;
          const t = geom(Math.max(r.stop, 1e-12));
          const o = pickOut(r.nodes, o => o.n.done || o.n.pol?.ref !== r);
          cost += sb.c0 + t * r.cost;
          runStep(r, t);
          if (sb.c0) spend(one(CUR.alch));
          spend(r.bill ?? one(r.name), t);
          const to = node(classOf(o.n));
          edge(b, to, r.name, t, t * r.cost);
          return o.n;
        }
        const a = sb.alt;
        const perTry = (a.altCost - P(CUR.transmute)) * a.p;
        const t = geom(a.p);
        cost += P(CUR.transmute) + t * perTry;
        spend(one(CUR.transmute)); spend(bill(one(CUR.alt), a.augPer ? one(CUR.aug, a.augPer) : null), t);
        const mg = node({ id: 'magic', label: `Magic: ${a.core.map(k => label(k)).join(' + ')}`, c: a.core.length, magic: true, ex: magicExample(a.core) });
        edge(b, mg, a.core.length === 2 ? 'Alteration (+Augment)' : 'Alteration', t, t * perTry);
        visit(mg, run);
        let from = mg;
        if (a.imp) {
          const im = node({ id: 'imprint', label: 'Magic, imprint saved', c: a.core.length, magic: true, ex: magicExample(a.core) });
          edge(mg, im, 'Imprint (Craicic Chimeral)', 1, P(CUR.imprint));
          cost += P(CUR.imprint);
          spend(one(CUR.imprint));
          visit(im, run);
          from = im;
        }
        if (a.hk) {
          const good = a.outs.filter(o => (o.n.done ? 0 : o.n.V) <= a.hk.cut);
          const o = pickOut(good);
          const n = geom(a.hk.stop); // magic items made, each with a fresh Lock
          cost += n * hkSetup + P(CUR.regal) + (n - 1) * a.altCost;
          spend(bill(...HK_SETUP.map(x => one(x))), n); spend(one(CUR.regal));
          spend(one(CUR.transmute), n - 1); spend(bill(one(CUR.alt), a.augPer ? one(CUR.aug, a.augPer) : null), (n - 1) / Math.max(1e-9, a.p));
          const to = node(classOf(o.n));
          edge(from, to, "Hinekora's Lock + Regal", 1, 0);
          return o.n;
        }
        const R = a.imp ? a.V - a.altCost : a.V;
        for (let i = 0; i < 10000; i++) {
          const o = pickOut(a.outs);
          cost += P(CUR.regal);
          spend(one(CUR.regal));
          const v = o.n.done ? 0 : o.n.V;
          if (v < R || i === 9999) { const to = node(classOf(o.n)); edge(from, to, a.imp ? 'Regal' : 'Regal', 1, P(CUR.regal)); return o.n; }
          if (a.imp) { cost += P(CUR.imprint); spend(one(CUR.imprint)); }
          else { const t2 = geom(a.p); cost += t2 * perTry + P(CUR.transmute); spend(one(CUR.transmute)); spend(bill(one(CUR.alt), a.augPer ? one(CUR.aug, a.augPer) : null), t2); }
        }
      };
      // An opening of its own (Recombinator, influenced Exalt, Awakener's Orb), your item, or a new base.
      // (An opening's currency counts toward the craft's cost too; values like Eldritch implicits
      // are already in chaos.)
      const spendCost = (b, k = 1) => { if (!b || !k) return; spend(b, k); for (const [name, v] of Object.entries(b)) cost += v * k * (name === ELD_VALUE || name === DONOR_VALUE ? 1 : P(name) || 0); };
      const begin = () => (from?.enter ? from.enter(spendCost, rnd, pickOut) : !from ? enter() : from.n ?? (spendCost(one(CUR.regal)), pickOut(from.regal).n));
      cur = begin();
      if (from && cur?.key) edge(b, node(classOf(cur)), from.label ?? (from.regal ? 'Regal' : 'Start'), 1, 0);
      while (cur && !cur.done && guard++ < maxMoves) {
        const from = node(classOf(cur));
        visit(from, run, cur);
        if (cur.key === 'ruined') { cur = from?.enter ? begin() : enter(); continue; }
        const pol = cur.pol;
        if (!pol) break;
        if (pol.ref) {
          const r = pol.ref;
          const t = geom(Math.max(r.stop, 1e-12));
          const o = pickOut(r.nodes, o => o.n.done || o.n.pol?.ref !== r);
          cost += t * r.cost;
          runStep(r, t);
          spend(r.bill ?? one(r.name), t);
          edge(from, node(classOf(o.n)), r.name, t, t * r.cost);
          cur = o.n;
        } else {
          const m = pol.move;
          const o = pickOut(m.outs);
          cost += m.cost;
          runStep(cur, 1);
          // (Hinekora's Lock: the Lock always, the currency only when the preview was good.)
          spend(m.bill ?? one(m.name));
          if (m.foresee && o.n.done) spend(m.curBill);
          edge(from, node(classOf(o.n)), (m.bestOf ? 'Allflame ' : '') + (HOW[m.how] ?? m.name), 1, m.cost);
          cur = o.n;
        }
      }
      if (cur?.done) { if (cur.key) visit(node(classOf(cur)), run, cur); } else unfinished++;
      costs.push(cost + benchCostTotal);
      for (const [k, v] of ran) { if (!stepRuns.has(k)) stepRuns.set(k, []); stepRuns.get(k).push(v); }
    }
    costs.sort((a, b) => a - b);
    const q = f => costs[Math.min(costs.length - 1, Math.floor(f * costs.length))];
    const used = { items: usageSummary(usage), runs, unfinished: unfinished / runs, raw: usage, stepRuns: new Map([...stepRuns].map(([k, xs]) => [k, runsSummary(xs, runs)])) };
    // Each class: the decision at its most common concrete state, every move priced.
    const out = [...nodes.values()].map(x => {
      let rep = null, best = 0;
      for (const [n, c] of x.reps) if (c > best) { best = c; rep = n; }
      const options = [];
      if (rep) {
        for (const m of rep.moves) { const v = qMove(m); if (isFinite(v)) options.push({ name: m.name, full: m.name, v, chosen: rep.pol?.move === m }); }
        // Reforges throw the item away, so they all cost about the same; one row per kind.
        const fam = r => (r.family.startsWith('essence') ? 'essence' : r.name.startsWith('"') ? 'lock:' + r.family : r.family);
        const bestRef = new Map();
        for (const r of rep.refs) if (isFinite(r.R) && (!bestRef.has(fam(r)) || r.R < bestRef.get(fam(r)).R)) bestRef.set(fam(r), r);
        for (const r of bestRef.values()) options.push({ name: r.name, full: r.name, v: r.R, chosen: rep.pol?.ref === r });
        const chosenRef = rep.pol?.ref;
        if (chosenRef && !bestRef.has(fam(chosenRef))) options.push({ name: chosenRef.name, full: chosenRef.name, v: chosenRef.R, chosen: true });
        options.sort((a, b) => a.v - b.v);
        const seen = new Set();
        for (let i = options.length - 1; i >= 0; i--) { if (seen.has(options[i].full)) options.splice(i, 1); else seen.add(options[i].full); }
      }
      return {
        id: x.id, label: x.label, c: x.c, junk: x.junk ?? 0, frac: !!x.frac, full: !!x.full, done: !!x.done, magic: !!x.magic, start: !!x.start, ruined: !!x.ruined,
        share: x.runs / runs, visits: x.visits / runs, V: rep && isFinite(rep.V) ? rep.V : x.done ? 0 : null,
        desc: rep ? stateText(rep) : null, options: options.slice(0, 12), ex: x.ex ?? exampleItem(rep ?? x.doneRep),
      };
    });
    // Keep the states most crafts pass through, and one edge per pair (the commonest move named).
    // (The finished item always has its box, even when few simulated crafts got there.)
    if (!out.some(x => x.done)) out.push({ id: 'done', label: 'Done', c: K, done: true, share: 0, visits: 0, V: 0, options: [] });
    const keep = new Set(out.filter(x => x.start || x.done || x.magic || x.share >= 0.05).sort((a, b) => b.share - a.share).slice(0, 24).map(x => x.id));
    keep.add('done');
    // The ways into Done are spread over many last states, each one rare: keep the two commonest
    // (and the states they come from), so the graph shows how crafts finish.
    const intoDone = new Map();
    for (const e of edges.values()) if (e.to === 'done' && e.from !== 'done') intoDone.set(e.from, (intoDone.get(e.from) ?? 0) + e.n);
    const lastSteps = new Set([...intoDone].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => id));
    for (const id of lastSteps) keep.add(id);
    const pairs = new Map();
    for (const e of edges.values()) {
      if (!keep.has(e.from) || !keep.has(e.to) || e.from === e.to) continue;
      const k = e.from + '>' + e.to;
      const pr = pairs.get(k) ?? { from: e.from, to: e.to, n: 0, actions: new Map() };
      pr.n += e.n;
      const a = pr.actions.get(e.action) ?? { n: 0, tries: 0, cost: 0 };
      a.n += e.n; a.tries += e.tries; a.cost += e.cost;
      pr.actions.set(e.action, a);
      pairs.set(k, pr);
    }
    // Chance of each move from its state: the share of the state's exits that take it.
    const exits = new Map();
    for (const pr of pairs.values()) exits.set(pr.from, (exits.get(pr.from) ?? 0) + pr.n);
    const edgesAll = [...pairs.values()].map(pr => {
      const acts = [...pr.actions].sort((a, b) => b[1].n - a[1].n);
      return { from: pr.from, to: pr.to, share: pr.n / runs, p: pr.n / exits.get(pr.from), action: acts[0][0], tries: acts[0][1].tries / acts[0][1].n,
        others: acts.slice(1, 4).map(([a]) => a) };
    });
    // The busiest 70 arrows, plus the ways into Done (taken once per craft, so a busy loop's
    // arrows would always crowd them out).
    const finish = edgesAll => edgesAll.filter(e => e.to === 'done' && lastSteps.has(e.from));
    const edgesOut = [...edgesAll.filter(e => e.share >= 0.02 || e.p >= 0.1).filter(e => !finish([e]).length).sort((a, b) => b.share - a.share).slice(0, 70), ...finish(edgesAll)];
    return {
      runs, K, nodes: out.filter(x => keep.has(x.id)), used,
      edges: edgesOut,
      cost: { mean: costs.reduce((a, b) => a + b, 0) / costs.length, p10: q(0.1), p50: q(0.5), p90: q(0.9) }, unfinished: unfinished / runs,
    };
  }

  const famSols = [];
  // warm: a strategy to start from, or a list of them (each tried, the cheapest result kept: the
  // solver can settle on a slightly worse strategy depending on where it starts).
  const runFamily = (name, fam, variant = null, warm = null) => {
    onProgress(name);
    restrict = f => f === 'lockchaos' || fam(f);
    let sol = null;
    for (const w of Array.isArray(warm) ? warm : [warm]) {
      const x = solveTimed(name, variant, w);
      if (!sol || x.startV < sol.startV) sol = x;
    }
    if (isFinite(sol.startV)) famSols.push(sol);
    restrict = null;
    if (!isFinite(sol.startV)) return sol;
    // Eldritch variants pay for the implicits that set dominance (unless implicits are targets, already counted).
    const extra = (variant && !eldT.length ? eldCost(variant) : 0) + extraTotal;
    results.push({ key: name, name, ok: true, cost: sol.startV + extra + benchCostTotal, steps: trace(sol), notes: [], sol, extra });
    return sol;
  };
  let first = null;
  if (!ctx.bestOnly) for (const [name, fam] of families) { const sol = runFamily(name, fam); if (name === 'Chaos spam') first = sol; }
  let fossilScored = []; // every fossil combination tried, with its reforge results
  if (ctx.bestOnly) fossilCombos = ctx.fossilCombos ?? [];
  else if (B.info.fossil && index.fossils?.length) {
    onProgress('Fossils');
    const tf = Date.now();
    // Fossil-only targets (Faceted Fossil's socketed-gem mods) need their fossil in every combination.
    const needF = new Set(T.filter(t => t.m.src === 'fossil' && t.m.fossil != null).map(t => String(t.m.fossil)));
    const helps = f => Object.keys(f.more).filter(k => T.some(t => tagHit(t.m, k))).length;
    const good = index.fossils.filter(f => !f.forces && isFinite(P(f.name)) && (needF.has(String(f.id)) || (!T.some(t => f.block.some(k => tagHit(t.m, k)))
      && (helps(f) || f.block.length))))
      .sort((a, b) => needF.has(String(b.id)) - needF.has(String(a.id)) || helps(b) - helps(a))
      .slice(0, 9);
    const combos = [];
    const pickC = (from, acc) => {
      if (acc.length) combos.push(acc);
      if (acc.length === (K >= 6 ? 3 : 4)) return;
      for (let i = from; i < good.length; i++) pickC(i + 1, [...acc, good[i]]);
    };
    pickC(0, []);
    if (needF.size) combos.splice(0, combos.length, ...combos.filter(c => [...needF].every(id => c.some(f => String(f.id) === id))));
    // Score each combination from a new base, and (when a Fracturing Orb is possible) from each
    // wanted mod fractured: the best fossils once a mod is locked in are often different ones
    // (only the remaining mods' tags need boosting). The best few for each start go into the plans.
    const starts = [fixedF];
    if (fixedF < 0 && !infl.length && isFinite(P(FRACTURE))) T.forEach((t, k) => { if (t.kind === 'roll') starts.push(k); });
    const scoredBy = new Map();
    for (const F0 of starts) {
      const list = [];
      for (const combo of combos) {
        const cost = combo.reduce((a, f) => a + P(f.name), 0) + resonator(combo.length);
        if (!isFinite(cost)) continue;
        const r = fullReforge(F0, 'fossil', '', cost, { fossils: combo });
        const outs = r.outs.map(o => { const n = first?.states.get(o.key); return { p: o.p, A: n ? (n.done ? 0 : n.V) : Infinity }; });
        // (Unknown outcomes: rank by the chance to land all the missing mods at once, per chaos.)
        const pAll = r.outs.filter(o => o.st.every(x => x === 1)).reduce((a, o) => a + o.p, 0);
        list.push({ combo, cost, R: stopValue(cost, outs).R, proxy: pAll > 0 ? cost / pAll : Infinity, outs: r.outs });
      }
      const known = list.some(x => isFinite(x.R));
      list.sort((a, b) => (known ? a.R - b.R : a.proxy - b.proxy) || a.proxy - b.proxy);
      scoredBy.set(F0, list);
    }
    const scored = scoredBy.get(fixedF);
    if (!scored.some(x => isFinite(x.R))) for (const x of scored) x.R = -x.combo.reduce((a, f) => a + Object.keys(f.more).filter(k => T.some(t => tagHit(t.m, k))).length, 0) / x.cost;
    scored.sort((a, b) => a.R - b.R);
    fossilScored = scored;
    const pickCombos = new Map();
    for (const x of scored.slice(0, 3)) pickCombos.set(x.combo.map(f => f.id).join('-'), x);
    for (const F0 of starts.slice(1)) for (const x of scoredBy.get(F0).slice(0, 2)) pickCombos.set(x.combo.map(f => f.id).join('-'), x);
    fossilCombos = [...pickCombos].map(([key, x]) => ({ key, combo: x.combo, cost: x.cost, name: x.combo.map(f => f.name).join(' + ') }));
    if (SOLVER.debug) SOLVER.debug(`fossil scoring: ${combos.length} combos from ${starts.length} starts, ${Date.now() - tf} ms; fossils ${good.map(f => f.name).join(', ')}; kept ${fossilCombos.map(x => x.name).join(' | ')}`);
    if (fossilCombos.length || hollowK >= 0) runFamily('Fossils', f => f === 'fossil');
  }
  if (B.info.eldritch && !infl.length && !ctx.bestOnly) for (const d of ['p', 's']) runFamily(`Eldritch currency (${d === 'p' ? 'Exarch' : 'Eater'} dominant)`, () => true, d);
  onProgress('Best mix');
  const warmFrom = ctx.warm ?? famSols.filter(x => !x.variant).sort((a, b) => a.startV - b.startV)[0] ?? null;
  // (Started from the two cheapest single-method plans and from scratch.)
  const warmTries = ctx.warm ? [ctx.warm] : [...new Set([warmFrom, ...famSols.filter(x => !x.variant).sort((a, b) => a.startV - b.startV).slice(0, 2), null])];
  const bestSol = runFamily('Best mix of everything', () => true, null, warmTries);
  // Every way to start, compared: each reforge from a new base (Chaos, each essence, each Harvest
  // type, every fossil combination tried), then the best strategy from wherever it stops.
  // cost: per try; stop: chance a try ends the spam; R: the whole craft starting that way.
  if (bestSol && !ctx.bestOnly && !ctx.sub && !presetF) {
    const Vk = key => { const n = bestSol.states.get(key); return n ? (n.done ? 0 : n.V) : Infinity; };
    const extra = extraTotal + benchCostTotal;
    const row = (outs, cost, c0) => { const sv = stopValue(cost, outs); return { cost, stop: sv.stop, alone: cost / Math.max(1e-12, sv.stop), R: sv.R + c0 + extra }; };
    // What one try lands: the chance of exactly j wanted mods (j = 0 … all that can roll).
    const nRoll = T.filter(t => t.kind === 'roll').length;
    const hits = outs => { const d = new Array(nRoll + 1).fill(0); for (const o of outs) d[Math.min(nRoll, o.st.filter(x => x === 1).length)] += o.p; return d; };
    const rows = [];
    for (const r of bestSol.start.refs ?? []) {
      const kind = r.family === 'chaos' ? 'chaos' : r.family.startsWith('essence') ? 'essence' : r.family === 'harvest' ? 'harvest' : null;
      if (!kind || !r.nodes) continue;
      rows.push({ kind, name: r.name, hits: hits(r.nodes.map(o => ({ p: o.p, st: o.n.st }))), ...row(r.nodes.map(o => ({ p: o.p, A: o.n.done ? 0 : o.n.V })), r.cost, kind === 'essence' ? 0 : P(CUR.alch)) });
    }
    for (const a of bestSol.start.alts ?? []) {
      if (!isFinite(a.V)) continue;
      rows.push({ kind: 'alt', name: `Orb of Alteration for ${a.core.map(label).join(' and ')}, then ${a.hk ? "Hinekora's Lock + " : a.imp ? 'Imprint + ' : ''}Regal Orb`,
        cost: P(CUR.alt), stop: a.p, alone: a.altCost, R: a.V + extra });
    }
    for (const x of fossilScored) {
      rows.push({ kind: 'fossil', name: x.combo.map(f => f.name).join(' + '), fossils: x.combo.map(f => f.name), resonator: RESONATORS[x.combo.length - 1], hits: hits(x.outs),
        ...row(x.outs.map(o => ({ p: o.p, A: Vk(o.key) })), x.cost, 0) });
    }
    rows.sort((a, b) => a.R - b.R);
    if (rows.length) results.push({ key: 'compare', name: 'Ways to start', hidden: true, ok: false, cost: Infinity, steps: [], notes: [], compare: rows.filter(r => isFinite(r.R)) });
  }
  // From your own item: the best strategy from its state, next to the plans from a new base.
  if (paste?.why) results.push({ key: 'paste', name: 'From your item', fromItem: true, ok: false, cost: Infinity, steps: [], notes: [], why: paste.why });
  else if (paste && bestSol?.pasted && !ctx.bestOnly) {
    const pz = bestSol.pasted;
    const pasteSwaps = swaps.map(x => { const k = T.indexOf(x.t); return { ...x, share: paste.exact.has(k) ? 0 : paste.swapped.has(k) ? 1 : x.share }; });
    const Vn = n => (n.done ? 0 : n.V);
    const bench = benchT.length ? [{ text: `Bench-craft ${benchT.length > 1 ? '"Can have up to 3 Crafted Modifiers", then ' : ''}${benchT.map(t => `"${modText(t.m, t.minTier)}"`).join(' and ')}.`, p: 1, cost: benchCostTotal, how: 'Crafting bench' }] : [];
    const intro = n => ({ text: `Start from your item${spec.start.crafted ? ' (remove its crafted mods at the bench first; that\'s free)' : ''}: it ${stateText(n)}.`, p: 1, cost: 0, rem: n.done ? 0 : n.V, how: 'Your item', ex: exampleItem(n) });
    let cost, steps;
    if (pz.n) {
      cost = Vn(pz.n);
      steps = pz.n.done ? [intro(pz.n), ...finalSteps(pasteSwaps), ...bench] : trace(bestSol, { node: pz.n, pre: [intro(pz.n)], paste: true, swaps: pasteSwaps });
    } else {
      cost = P(CUR.regal) + pz.regal.reduce((a, o) => a + o.p * Vn(o.n), 0);
      const nxt = pz.regal.filter(o => isFinite(Vn(o.n))).sort((a, b) => b.p - a.p)[0]?.n;
      const magicIntro = { text: `Start from your magic item${paste.st.some(x => x === 1) ? ` (it has ${paste.st.map((x, k) => (x === 1 ? label(k) : null)).filter(Boolean).join(' and ')})` : ''}.`, p: 1, cost: 0, how: 'Your item' };
      const regal = { text: `Regal Orb: it adds one mod and makes the item rare.`, p: 1, cost: P(CUR.regal), rem: cost, how: 'Regal', ex: nxt ? exampleItem(nxt) : null };
      steps = !nxt ? [] : nxt.done ? [magicIntro, regal, ...finalSteps(pasteSwaps), ...bench] : trace(bestSol, { node: nxt, pre: [magicIntro, regal], paste: true, swaps: pasteSwaps });
    }
    // (Influence is already on your item. A resistance it has in the right element needs no
    // swap, one in another element needs it for sure.)
    const extra = pasteSwaps.reduce((a, x) => a + (isFinite(x.cost) ? x.share * x.cost : 0), 0) + eldTargetCost;
    const freshBest = Math.min(...results.filter(r => r.ok && !r.fromItem).map(r => r.cost));
    const total = cost + extra + benchCostTotal;
    if (isFinite(cost)) results.push({ key: 'paste', name: 'From your item', fromItem: true, ok: true, cost: total, steps, pasteSim: { sol: bestSol, from: { ...pz, swaps: pasteSwaps } },
      notes: pz.n?.done ? ['Your item already has every picked mod' + (total > 0 ? '; what\'s left is the bench crafts and swaps.' : '.')] : total > freshBest + 1e-6 ? [`Starting over on a new base is cheaper (about ${fmtC(freshBest)} against ${fmtC(total)}): your item isn't worth building on for these mods.`] : [] });
    else results.push({ key: 'paste', name: 'From your item', fromItem: true, ok: false, cost: Infinity, steps: [], notes: [], why: 'No modelled method gets from your item to every ticked mod; a new base works better (see the other plans).' });
  }
  const essOnly = T.filter(t => t.kind === 'essence');
  const noPriceEss = [...new Set(essOnly.flatMap(t => essencesFor(B, t).flatMap(em => em.tiers.map((x, tt) => essenceName(em, tt, index.essenceLevels)))))].filter(n => !isFinite(P(n)));
  const pricedEss = essOnly.every(t => essences.some(e => e.k === T.indexOf(t)));
  if (pricedEss) noPriceEss.length = 0;
  if (!results.length) results.push({ key: 'none', name: 'No way found', ok: false, cost: Infinity, steps: [], notes: [],
    why: essOnly.length > 2 ? `${essOnly.map(t => `"${t.m.text}"`).join(', ')} only come from essences. An essence forces one mod, and only one other can be kept (fractured), so at most two of them fit. Untick one.`
      : essOnly.length === 2 && infl.length ? `${essOnly.map(t => `"${t.m.text}"`).join(' and ')} only come from essences. Getting both needs the first one fractured, and influenced items can't be fractured. Untick one, or remove the influence.`
      : essOnly.length === 2 ? `${essOnly.map(t => `"${t.m.text}"`).join(' and ')} only come from essences. The way to get both is to fracture the first essence's mod and then use the second essence${isFinite(P(FRACTURE)) ? '; that route found no way here (check the item level and that both essences have prices)' : `, but there's no price for the ${FRACTURE}`}.`
      : noPriceEss.length ? `${noPriceEss.join(', ')} ${noPriceEss.length > 1 ? 'have' : 'has'} no price this hour, and ${essOnly.length > 1 ? 'those mods only come' : 'that mod only comes'} from essences. Type a price under "Prices used".`
      : 'None of the modelled methods can reach every ticked mod (for example a mod only a special currency adds).' });

  // Recombinator (Settlers): craft two clean items that each carry part of the
  // targets (Alteration/Augment, plus one Regal mod), recombine, then finish with
  // the best strategy from wherever the recombined item lands.
  // (Its two halves are alteration-spammed, so "no alteration spam" leaves it out.)
  if (recOn && bestSol && !ctx.bestOnly) {
    const rec = `Recombinator bench (${B.info.recomb.toLowerCase()}, unpredictable mode; ${fmtN(opt.recombDust)} ${DUST} + ${fmtN(opt.recombGold)} gold a use)`;
    const R2 = T.map((t, k) => k).filter(k => T[k].kind === 'roll');
    let bestR = null;
    const n = R2.length;
    for (let mask = 1; mask < 1 << n; mask++) {
      const S = R2.filter((k, i) => mask & (1 << i));
      if (S.length < 2) continue;
      const np = S.filter(k => T[k].side === 'p').length, ns = S.length - np;
      if (np > 3 || ns > 3) continue;
      const pRec = (np ? RECOMB_COUNTS[np][np] : 1) * (ns ? RECOMB_COUNTS[ns][ns] : 1);
      const st = new Array(K).fill(0);
      S.forEach(k => { st[k] = 1; });
      const nodeAfter = bestSol.states.get(enc(-1, st, 0, 0));
      const after = isDone(st, 0, 0) ? 0 : nodeAfter && isFinite(nodeAfter.V) ? nodeAfter.V : Infinity;
      if (!isFinite(after)) continue;
      // Every result: how many of each side survive (the pool table), which ones (at random), and
      // what that item is worth to the strategy. A partial result (one wanted mod lost) is a clean
      // rare with the rest: keep it when finishing it beats two new items.
      const recOuts = recombStates(S).map(o => {
        const done2 = isDone(o.st, 0, 0), n2 = done2 ? null : bestSol.states.get(enc(-1, o.st, 0, 0));
        const A = done2 ? 0 : o.st.some(x => x === 1) && n2 && isFinite(n2.V) ? n2.V : Infinity;
        return { p: o.p, A, n: n2, done: done2, full: o.full };
      });
      for (let split = 1; split < (1 << S.length) - 1; split++) {
        const A = S.filter((k, i) => split & (1 << i)), Bk = S.filter((k, i) => !(split & (1 << i)));
        if (A.length > 3 || Bk.length > 3 || A[0] > Bk[0]) continue;
        const ia = itemCost(A), ib = itemCost(Bk);
        if (!ia || !ib) continue;
        // Repeat (two new items each time) until a result worth keeping: optimal stopping.
        const sv = stopValue(ia.cost + ib.cost + recCost, recOuts);
        if (!isFinite(sv.R)) continue;
        const total = sv.R;
        if (!bestR || total < bestR.total) {
          const kept = recOuts.filter(o => o.A < sv.R - 1e-9);
          const pPart = kept.filter(o => !o.full).reduce((a, o) => a + o.p, 0);
          bestR = { total, c: total - after, ia, ib, pRec, pPart, kept, stop: sv.stop, np, ns, node: nodeAfter, after, done: isDone(st, 0, 0) };
        }
      }
    }
    if (bestR) {
      const pre = [
        { text: `${bestR.ia.text}.`, p: bestR.ia.pAlt, cost: bestR.ia.cost, own: 0, how: 'Alteration', flow: halfFlow(bestR.ia) },
        { text: `Second item: ${bestR.ib.text.charAt(0).toLowerCase() + bestR.ib.text.slice(1)}.`, p: bestR.ib.pAlt, cost: bestR.ib.cost, own: 0, how: 'Alteration', flow: halfFlow(bestR.ib) },
        { text: `${rec}: both go in and are used up. With ${bestR.np} prefix${bestR.np === 1 ? '' : 'es'} and ${bestR.ns} suffix${bestR.ns === 1 ? '' : 'es'} in the pool (no junk), all of them survive ${pctText(bestR.pRec)} of the time${bestR.pPart > 1e-4 ? `; ${pctText(bestR.pPart)} of the time one is lost but the rest is worth keeping: carry on from that item (the plan finishes it like any other)` : ''}; otherwise make two new items.`, p: bestR.pRec, cost: bestR.c, how: 'Recombinator', bill: recBill,
          flow: bestR.pRec < 1 - 1e-4 ? [{ kind: 'on', p: bestR.pRec }, ...(bestR.pPart > 1e-4 ? [{ kind: 'else', p: bestR.pPart, note: 'a wanted mod is lost, the rest kept', next: 'the plan finishes that item' }] : []),
            ...(bestR.stop < 1 - 1e-4 ? [{ kind: 'back', p: 1 - bestR.stop, to: inflSteps.length, note: 'too little survives: two new items' }] : [])] : null },
      ];
      const steps = bestR.done ? [...inflSteps, ...pre, ...finalSteps(), ...(benchT.length ? [{ text: `Bench-craft ${benchT.map(t => `"${modText(t.m, t.minTier)}"`).join(' and ')}.`, p: 1, cost: benchCostTotal, how: 'Crafting bench' }] : [])]
        : trace(bestSol, { node: bestR.node, pre: [...inflSteps, ...pre] });
      // The currency count: both items (with their retries) and the Recombinator, then the strategy.
      const halfOf = ic => (spend, rnd) => {
        const alts = () => { spend(one(CUR.transmute)); spend(bill(one(CUR.alt), ic.augPer ? one(CUR.aug, ic.augPer) : null), geomR(rnd, ic.pAlt)); };
        alts();
        if (ic.rest < 0) return;
        if (ic.useImp) { spend(one(CUR.imprint)); const n = geomR(rnd, ic.pr); spend(one(CUR.regal), n); spend(one(CUR.imprint), n - 1); }
        else for (;;) { spend(one(CUR.regal)); if (rnd() < ic.pr) break; alts(); }
      };
      const ha = halfOf(bestR.ia), hb = halfOf(bestR.ib);
      const opening = { infl: true, label: 'Two clean items, recombined', enter: (spend, rnd) => {
        // Two items and a recombine until a result worth keeping; then the strategy from there.
        for (;;) {
          ha(spend, rnd); hb(spend, rnd); spend(recBill);
          let x = rnd();
          if (x >= bestR.stop) continue; // nothing worth keeping
          for (const o of bestR.kept) { if ((x -= o.p) < 0) return o.done ? { done: true } : o.n; }
          const o = bestR.kept[bestR.kept.length - 1]; return o.done ? { done: true } : o.n;
        }
      } };
      results.push({ key: 'recomb', name: 'Recombinator', ok: true, opening, cost: bestR.total + benchCostTotal + extraTotal, steps,
        notes: ['Survival odds by pool size are the community-measured table for unpredictable mode (predictable mode\'s odds aren\'t published); both inputs are clean (only wanted mods), so everything that survives is wanted.'] });
    }
  }
  // Influenced Exalted Orb (Crusader's, Hunter's, ...): craft the other mods on a plain item
  // with a slot left open, then exalt for an influenced one. A miss leaves an influenced item:
  // finish it with the influenced plan above when that's cheaper than starting over.
  const ixName = infl.length === 1 ? influenceExalt(infl[0]) : null;
  const ixK = T.map((t, k) => k).filter(k => T[k].kind === 'roll' && T[k].m.src === infl[0]);
  if (ixName && opt.influenceExalt && !ctx.sub && !ctx.bestOnly && !presetF && bestSol && ixK.length && isFinite(P(ixName))) {
    onProgress(`${ixName} route`);
    const ixIds = new Set(ixK.map(k => T[k].m.id));
    const subTargets = spec.targets.filter(t => !ixIds.has(t.m.id));
    const open = { p: 0, s: 0 };
    for (const k of ixK) open[T[k].side]++;
    let sub = null, C1 = P(CUR.alch);
    if (subTargets.some(t => !t.crafted)) {
      const out = planOnce(B, { ...spec, infl: [], targets: subTargets, options: { ...opt, influenceSetup: false } }, price, index, () => {}, null, { sub: true, reserve: open, noFracture: true });
      sub = (out.results ?? out).filter(r => r.ok).sort((a, b) => a.cost - b.cost)[0] ?? null;
      C1 = sub ? sub.cost - benchCostTotal : Infinity;
    }
    // The plain item when it's done: the other targets, and (at worst) junk in every slot but the open ones.
    const st0 = T.map((t, k) => (ixIds.has(t.m.id) ? 0 : 1));
    const jp = Math.max(0, max.p - sideCount(st0, 'p') - reserve.p - open.p), js = Math.max(0, max.s - sideCount(st0, 's') - reserve.s - open.s);
    const ro = rollOutcomes(itemFor(-1, st0, jp, js), ixK.map(k => T[k]), [[1, 1]], { src: [infl[0]] });
    const outs = mapRoll(-1, st0, jp, js, ixK, ro);
    const A = o => (isDone(o.st, o.jp, o.js) ? 0 : bestSol.states.get(o.key)?.V ?? Infinity);
    const sv = isFinite(C1) && outs.length ? stopValue(C1 + P(ixName), outs.map(o => ({ p: o.p, A: A(o) }))) : { R: Infinity };
    if (isFinite(sv.R)) {
      const pHit = outs.filter(o => ixK.some(k => o.st[k] === 1)).reduce((a, o) => a + o.p, 0);
      const pFix = Math.max(0, sv.stop - pHit);
      const slots = ['p', 's'].filter(x => open[x]).map(x => `${open[x]} ${SIDE_NAME[x]}`).join(' and ');
      // The plain item's steps are paid for inside the Exalt step (a miss makes a new one), then
      // the influenced strategy carries on from the likeliest kept result.
      const plain = (sub ? sub.steps.filter(x => x.how !== 'Crafting bench') : [{ text: `Orb of Alchemy on a non-influenced ${B.name} (item level ${ilvl}+).`, p: 1, cost: P(CUR.alch), how: 'Alchemy' }])
        .map(x => ({ ...x, rem: undefined, own: 0 }));
      const outsN = outs.map(o => ({ p: o.p, A: A(o), n: isDone(o.st, o.jp, o.js) ? { done: true } : bestSol.states.get(o.key) }));
      const kept = outsN.filter(o => o.A < sv.R && o.n);
      const next = kept.sort((a, b) => b.p - a.p)[0]?.n;
      const ixStep = { text: `Keep ${slots} slot open, then ${ixName}: it adds ${infl[0]} influence and one ${infl[0]} mod, ${pctText(pHit)} of the time ${ixK.map(label).join(' or ')}.`
          + (pFix > 1e-4 ? ` On a miss the item is ${infl[0]}-influenced for good: ${pctText(pFix)} of the time it's still worth finishing with the influenced plan (Annul, Exalt, ...); otherwise start a new item.` : ` On a miss, start a new item (about ${fmtN(tries(pHit))} items in all).`),
        p: sv.stop, cost: (C1 + P(ixName)) / sv.stop, own: (C1 + P(ixName)) / sv.stop, how: 'Influenced Exalt', ex: next?.key ? exampleItem(next) : null,
        flow: sv.stop < 1 - 1e-4 ? [{ kind: 'on', p: sv.stop }, { kind: 'new', p: 1 - sv.stop, note: 'not worth finishing', to: 0 }] : null };
      const bench = benchT.length ? [{ text: `Bench-craft ${benchT.map(t => `"${modText(t.m, t.minTier)}"`).join(' and ')}.`, p: 1, cost: benchCostTotal, how: 'Crafting bench' }] : [];
      const steps = !next || next.done ? [...plain, ixStep, ...bench] : trace(bestSol, { node: next, pre: [...plain, ixStep], swaps: [] });
      // The currency count: a plain item (a sampled run of its own plan) and the Exalt until one is kept.
      let subRaw = null;
      const opening = { noSwaps: true, label: `Plain item, then ${ixName}`, enter: (spend, rnd, pickOut) => {
        for (;;) {
          if (sub?.makeUsage) { subRaw ??= sub.makeUsage().raw; spend(subRaw[Math.floor(rnd() * subRaw.length)]); } else spend(one(CUR.alch));
          spend(one(ixName));
          const o = pickOut(outsN);
          if (o.A < sv.R && o.n) return o.n;
        }
      } };
      results.push({ key: 'iexalt', name: `${ixName} at the end`, ok: true, opening, cost: sv.R + benchCostTotal, steps,
        notes: [`The plain item's cost (${sub ? sub.name : 'Alchemy'}) is paid again for each new item. Its ${SIDE_NAME[ixK.length ? T[ixK[0]].side : 'p']} side is assumed full apart from the open slot, which slightly undercounts how often an Exalt can fix a miss.`] });
    }
  }
  // Awakener's Orb (two influences): two items of the same class, each with exactly one
  // influenced mod (an influenced Exalted Orb on a plain rare gives that), merged: the result
  // keeps both influences and one influenced mod from each, and every other mod is rerolled.
  // From there the influenced plan above finishes the item (or you start over).
  if (infl.length === 2 && opt.awakener && !ctx.sub && !ctx.bestOnly && !presetF && bestSol && isFinite(P(AWAKENER))) {
    onProgress("Awakener's Orb route");
    const plainRare = newItem(B, { ilvl, infl: [], rarity: 'rare' });
    // One donor: a plain rare + that influence's Exalted Orb until it adds target k (or any mod if k < 0).
    const donor = (inf, k) => {
      const ex = P(influenceExalt(inf));
      if (k < 0) return { cost: AWAKEN_DONOR, p: 1, text: `any cheap ${B.name} with ${inf} influence (about ${fmtC(AWAKEN_DONOR)}; its ${inf} mod is random)` };
      const ro = rollOutcomes(plainRare, [T[k]], [[1, 1]], { src: [inf] });
      const p = ro.filter(o => o.st[0] === 1).reduce((a, o) => a + o.p, 0);
      if (!(p > 0) || !isFinite(ex)) return null;
      return { cost: (P(CUR.alch) + ex) / p, p, text: `a plain rare ${B.name} (Orb of Alchemy) and ${influenceExalt(inf)} until it adds ${label(k)} (${pctText(p)} per try; a miss means a new rare)` };
    };
    const ks = infl.map(inf => T.map((t, k) => k).filter(k => T[k].kind === 'roll' && T[k].m.src === inf));
    let bestA = null;
    for (const a of [-1, ...ks[0]]) for (const b of [-1, ...ks[1]]) {
      if (a < 0 && b < 0) continue;
      if (a >= 0 && b >= 0 && T[a].m.groups.some(g => T[b].m.groups.includes(g))) continue;
      const da = donor(infl[0], a), db = donor(infl[1], b);
      if (!da || !db) continue;
      // The merged item: the kept influenced mods, then a reforge of the rest.
      const st0 = new Array(K).fill(0);
      for (const k of [a, b]) if (k >= 0) st0[k] = 1;
      let outs = [{ st: st0, jp: 0, js: 0, p: 1 }];
      for (const [k, inf] of [[a, infl[0]], [b, infl[1]]]) {
        if (k >= 0) continue; // a random influenced mod from a bought donor
        const next = [];
        for (const o of outs) {
          const tg = missingRollable(o.st);
          next.push(...mapRoll(-1, o.st, o.jp, o.js, tg, rollOutcomes(itemFor(-1, o.st, o.jp, o.js), tg.map(j => T[j]), [[1, 1]], { src: [inf] }), o.p));
        }
        outs = next;
      }
      const fin = [];
      for (const o of outs) {
        const it1 = itemFor(-1, o.st, o.jp, o.js);
        const tg = missingRollable(o.st);
        fin.push(...mapRoll(-1, o.st, o.jp, o.js, tg, rollOutcomes(it1, tg.map(j => T[j]), rerollDist(B, it1.mods.length)), o.p));
      }
      const A = o => (isDone(o.st, o.jp, o.js) ? 0 : bestSol.states.get(o.key)?.V ?? Infinity);
      const c = da.cost + db.cost + P(AWAKENER);
      const sv = stopValue(c, fin.map(o => ({ p: o.p, A: A(o) })));
      if (isFinite(sv.R) && (!bestA || sv.R < bestA.R)) bestA = { R: sv.R, stop: sv.stop, a, b, da, db, c, fin: fin.map(o => ({ p: o.p, A: A(o), n: isDone(o.st, o.jp, o.js) ? { done: true } : bestSol.states.get(o.key) })), pDone: fin.filter(o => isDone(o.st, o.jp, o.js)).reduce((x, o) => x + o.p, 0) };
    }
    if (bestA) {
      const { a, b, da, db } = bestA;
      const kept = [a, b].filter(k => k >= 0).map(label).join(' and ');
      const donorFlow = d => (d.p < 1 - 1e-4 ? [{ kind: 'on', p: d.p }, { kind: 'again', p: 1 - d.p, note: 'missed: a new plain rare' }] : null);
      const next = bestA.fin.filter(o => o.A < bestA.R && o.n).sort((x, y) => y.p - x.p)[0]?.n;
      const pre = [
        { text: `Item 1 (${infl[0]}): ${da.text}.`, p: da.p, cost: da.cost, own: 0, how: 'Influenced Exalt', flow: donorFlow(da) },
        { text: `Item 2 (${infl[1]}): ${db.text}.`, p: db.p, cost: db.cost, own: 0, how: 'Influenced Exalt', flow: donorFlow(db) },
        { text: `Awakener's Orb: destroy one, the other becomes ${infl.join(' + ')} and keeps ${kept} (each item's only influenced mod); every other mod is rerolled.`
          + (bestA.pDone > 1e-4 ? ` ${pctText(bestA.pDone)} of the time that already finishes the item.` : '')
          + (bestA.stop < 1 - 1e-4 ? ` ${pctText(bestA.stop)} of results are worth finishing with the influenced plan (Exalt, Annul, ...); otherwise make two new items.` : ' Finish it with the influenced plan (Exalt, Annul, ...).'),
          p: bestA.stop, cost: bestA.c / bestA.stop, own: bestA.c / bestA.stop, how: "Awakener's Orb", ex: next?.key ? exampleItem(next) : null,
          flow: bestA.stop < 1 - 1e-4 ? [{ kind: 'on', p: bestA.stop }, { kind: 'new', p: 1 - bestA.stop, note: 'not worth finishing: two new items', to: 0 }] : null },
      ];
      const bench = benchT.length ? [{ text: `Bench-craft ${benchT.map(t => `"${modText(t.m, t.minTier)}"`).join(' and ')}.`, p: 1, cost: benchCostTotal, how: 'Crafting bench' }] : [];
      const steps = !next || next.done ? [...pre, ...finalSteps(), ...bench] : trace(bestSol, { node: next, pre });
      // The currency count: both items (a bought one, or Alchemy + influenced Exalts until it
      // adds the mod), the Awakener's Orb, again until a result is worth finishing.
      const donorSim = (d, k, inf, spend, rnd) => {
        if (k < 0) { spend({ [DONOR_VALUE]: AWAKEN_DONOR }); return; }
        const n = geomR(rnd, d.p); spend(one(CUR.alch), n); spend(one(influenceExalt(inf)), n);
      };
      const opening = { label: "Two influenced items, Awakener's Orb", enter: (spend, rnd, pickOut) => {
        for (;;) {
          donorSim(da, a, infl[0], spend, rnd); donorSim(db, b, infl[1], spend, rnd); spend(one(AWAKENER));
          const o = pickOut(bestA.fin);
          if (o.A < bestA.R && o.n) return o.n;
        }
      } };
      results.push({ key: 'awaken', name: "Awakener's Orb", ok: true, opening, cost: bestA.R + benchCostTotal + swapCostTotal, steps,
        notes: ['Each item gets its influenced mod from an influenced Exalted Orb, so it has exactly one and the Awakener\'s Orb keeps it for certain. Both items must be the same item class; the plain rares\' other mods don\'t matter.'] });
    }
  }
  // Orb of Dominance: a note where it applies (influenced targets one tier short).
  const domNote = infl.length && DOMINANCE_GROUPS.has(B.info.group) && T.some(t => infl.includes(t.m.src)) ? [`Orb of Dominance (${fmtC(P(CUR.dominance))}, body armours, boots, gloves and helmets): on a rare with two or more influenced mods it upgrades one at random a tier (a top tier becomes Elevated) and removes another. With exactly two, that's the one you want half the time, at the cost of the other; the planner doesn't build that route because it can't tell which junk mods are influenced.`] : [];
  for (const r of results) {
    if (isFinite(mirror) && r.cost > mirror) r.notes.push(`This costs more than a Mirror of Kalandra (${fmtC(mirror)}): buying a mirrored copy of a finished item is cheaper.`);
    r.notes.push(...domNote);
  }
  for (const r of results) {
    if (r.sol) { const { sol, extra } = r; r.makeGraph = () => simulateGraph(sol, extra, 500, 1500, 200000, 25); r.makeUsage = () => simulateGraph(sol, extra, 400, 700, 200000, 25).used; }
    // (Plans that start from your item or an opening of their own get a graph too.)
    if (r.pasteSim) { const { sol, from } = r.pasteSim; r.makeGraph = () => simulateGraph(sol, 0, 500, 1500, 200000, 25, from); r.makeUsage = () => simulateGraph(sol, 0, 400, 700, 200000, 25, from).used; delete r.pasteSim; }
    if (r.opening) { const o = r.opening; r.makeGraph = () => simulateGraph(bestSol, 0, 500, 1500, 200000, 25, o); r.makeUsage = () => simulateGraph(bestSol, 0, 400, 700, 200000, 25, o).used; delete r.opening; }
    delete r.sol; delete r.extra;
    // Which swaps this plan pays for (the Recombinator's finishing steps use them too).
    r.swapsUsed = new Set(swaps.filter(x => x.share > 0.01 && isFinite(x.cost)).map(x => x.t.m.id));
  }
  if (ctx.sub) return { results };
  if (swapIds === null && !swappable.some(x => isFinite(x.cost))) {
    const best = new Map();
    for (const r of results) if (!best.has(r.name) || r.cost < best.get(r.name).cost) best.set(r.name, r);
    return finishPlans([...best.values()].sort((a, b) => (a.ok === b.ok ? a.cost - b.cost : a.ok ? -1 : 1)), onProgress, ctx.quick);
  }
  return { results, swappable: swappable.filter(x => isFinite(x.cost)), bestSol, fossilCombos };
}

const shortMod = (m, t) => { const s = modText(m, t); return s.length > 48 ? s.slice(0, 46) + '…' : s; };

export function pctText(p) {
  if (!(p > 0)) return '0%';
  if (p >= 0.995) return '100%';
  if (p >= 0.1) return (p * 100).toFixed(0) + '%';
  if (p >= 0.001) return (p * 100).toPrecision(2) + '%';
  return '1 in ' + fmtN(1 / p);
}
export function fmtN(x) {
  if (!isFinite(x)) return '∞';
  if (x >= 1e12) return '10^' + Math.floor(Math.log10(x));
  if (x >= 1e9) return (x / 1e9).toPrecision(3) + 'B';
  if (x >= 1e6) return (x / 1e6).toPrecision(3) + 'M';
  if (x >= 1e4) return Math.round(x / 1e3) + 'k';
  if (x >= 100) return Math.round(x).toLocaleString('en-US');
  return x.toPrecision(2).replace(/\.0+$/, '');
}
const fmtC = c => (isFinite(c) ? fmtN(c) + 'c' : '?');
