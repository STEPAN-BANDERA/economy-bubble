// The Crafting area's API: its data (mod index, prepared bases) and its prices, for the
// Crafting tab (crafting.js) and for every other area that prices a craft (the Build
// maker's rare items, rareprice.js). Each base is fetched and prepared once, and a
// currency's crafting price is worked out in one place, so a plan costs the same whichever
// tab asked for it. The planning itself is craft.js (run in craft-worker.js).
import * as C from './craft.js';

const DATA = 'data/craft/';

const D = {
  index: null, indexLoading: null,
  bases: new Map(),   // base id -> promise of the prepared base
  ready: new Map(),   // base id -> the prepared base, once loaded
  overrides: new Map(), // 'main' | 'ruthless' -> the visitor's price overrides (live object)
};

// ---------- data ----------
export function loadCraftIndex() {
  if (D.indexLoading === null) {
    D.indexLoading = fetch(DATA + 'index-poe1.json').then(response => {
      if (!response.ok) {
        throw new Error(DATA + 'index-poe1.json is missing (run the craft data scripts: npm run craft:build)');
      }
      return response.json();
    }).then(index => {
      D.index = index;
      return index;
    });
    // A failed load can be tried again on the next call.
    D.indexLoading.catch(() => {
      D.indexLoading = null;
    });
  }
  return D.indexLoading;
}

export function craftIndexNow() {
  return D.index;
}

// A base's mods, prepared for the planner (C.prepareBase), fetched once for every tab.
export function loadCraftBase(baseId) {
  if (!D.bases.has(baseId)) {
    const loading = loadCraftIndex().then(index => {
      return fetch(DATA + 'base-' + baseId + '.json').then(response => response.json()).then(raw => {
        const prepared = C.prepareBase(raw, index);
        D.ready.set(baseId, prepared);
        return prepared;
      });
    });
    D.bases.set(baseId, loading);
  }
  return D.bases.get(baseId);
}

export function craftBaseNow(baseId) {
  return D.ready.get(baseId) ?? null;
}

// The rare-gear affixes the Build maker's gear solver uses (data/craft/gear-poe1.json, made
// from this area's mod data by scripts/build_gear_mods.py), or null where the site was built
// without the crafting data: the builds then use the engine's fixed gear figures.
export async function loadCraftGear() {
  try {
    const response = await fetch(DATA + 'gear-poe1.json');
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    return null;
  }
}

// ---------- prices ----------
// The visitor's own prices from the Crafting tab, one set per economy (main, Ruthless):
// a number, or 'off' for a currency they'd rather not use. The object is shared and live,
// so a price typed on the Crafting tab reaches the Build maker straight away; whoever
// changes it saves it with saveCraftOverrides.
const storeKeyOf = ruthless => (ruthless ? 'craftPricesRuthless' : 'craftPrices');

export function craftOverrides(store, ruthless) {
  const mode = ruthless ? 'ruthless' : 'main';
  if (!D.overrides.has(mode)) {
    const saved = store.get(storeKeyOf(ruthless), {});
    D.overrides.set(mode, saved && typeof saved === 'object' ? saved : {});
  }
  return D.overrides.get(mode);
}

export function saveCraftOverrides(store, ruthless) {
  store.set(storeKeyOf(ruthless), craftOverrides(store, ruthless));
}

// A currency's crafting price and where it came from ({ v, src }), in the economy's unit
// (Chaos, or Alchemy on the Ruthless tab). In order: the visitor's own price ('off' leaves
// the currency out of plans), the unit itself, the exchange, then the tab's estimates
// (in Chaos; converted at the economy's Chaos price on Ruthless).
//   context: { store, ruthless, economy (the Economy API, economy.js), realm }
export function craftPriceInfo(name, context) {
  const overrides = craftOverrides(context.store, context.ruthless);
  if (overrides[name] === 'off') {
    return { v: NaN, src: 'not used' };
  }
  if (overrides[name] != null) {
    return { v: overrides[name], src: 'yours' };
  }
  const unit = context.ruthless ? C.CUR.alch : C.CUR.chaos;
  if (name === unit) {
    return { v: 1, src: 'exchange' };
  }
  const exchangeKnown = context.economy && context.realm !== 'poe2';
  const exchange = exchangeKnown ? context.economy.price(name) : null;
  if (exchange) {
    return { v: exchange, src: 'exchange' };
  }
  const estimate = C.FARMED_PRICES[name] ?? D.index?.fallbackPrices?.[name];
  if (estimate != null) {
    let chaosInUnit = 1;
    if (context.ruthless) {
      chaosInUnit = context.economy?.price(C.CUR.chaos) ?? 1 / 3;
    }
    return { v: estimate * chaosInUnit, src: 'estimate' };
  }
  return { v: NaN, src: 'unknown' };
}

// Every currency and item name the planner might ask a price for, on this base.
export function plannerPriceNames(B, index) {
  const names = new Set([...Object.keys(index.fallbackPrices ?? {}), ...Object.values(C.CUR), ...C.RESONATORS, ...C.ALCH_RESONATORS, C.FRACTURE, 'Mirror of Kalandra',
    ...index.fossils.map(f => f.name), C.DUST, C.GOLD]);
  for (const t of C.ELDRITCH_TIERS) {
    names.add(`${t} Eldritch Ember`);
    names.add(`${t} Eldritch Ichor`);
  }
  for (const c of ['Wild', 'Vivid', 'Primal']) {
    names.add(C.lifeforce(c));
  }
  for (const n of [...C.INFLUENCES.map(C.influenceExalt), C.HK_LOCK, C.SACRED, C.RANCOUR, C.SULPHUR, C.MATRON, C.AWAKENER, ...C.HK_SETUP]) {
    names.add(n);
  }
  const L = index.essenceLevels;
  for (const m of B.mods) {
    if (m.src === 'essence' && m.essence) {
      m.tiers.forEach((_, t) => names.add(C.essenceName(m, t, L)));
    }
  }
  return names;
}

// Every price the planner might ask for, looked up once and sent to the worker, with how
// much the exchange trades (an hour) and lists: the planner prices up what a plan needs
// beyond it.
export function plannerPriceSnapshot(B, context) {
  const prices = {};
  const supply = {};
  for (const name of plannerPriceNames(B, D.index)) {
    const value = craftPriceInfo(name, context).v;
    if (!isFinite(value)) {
      continue;
    }
    prices[name] = value;
    const exchangeKnown = context.economy && context.realm !== 'poe2';
    const traded = exchangeKnown ? context.economy.volume(name) : null;
    if (traded && traded.perHour > 0) {
      supply[name] = { perHour: traded.perHour, stock: traded.stock };
    }
  }
  return { prices, supply };
}

// ---------- planning for other areas ----------
// The cheapest plan that reaches these affixes on a base, planned by the Crafting tab's
// planner (craft.js in craft-worker.js) with the Crafting tab's prices and options:
// resolves to { cost, name } (cost in Chaos), or rejects with why there is none. The
// planner runs without fossils (the Crafting tab's "Without fossils" half, "prefixes first"
// and "suffixes first"): on the endgame rares tried, a plan with fossils never came out
// cheaper, and it takes longer. One plan at a time; the caller queues.
//   request: { baseId, affixes: [{ id, minTier }], ilvl }
//   context: as craftPriceInfo's (main economy only)
const planner = { worker: null, jobId: 0 };

export async function cheapestCraftPlan(request, context) {
  const index = await loadCraftIndex();
  const B = C.forBaseItem(await loadCraftBase(request.baseId), null, index);
  const targets = [];
  for (const affix of request.affixes) {
    if (B.byId.get(affix.id)) {
      targets.push({ id: affix.id, minTier: affix.minTier, crafted: false, frac: false });
    }
  }
  const savedOptions = context.store.get('craftOptions', {}) || {};
  const message = {
    baseId: request.baseId, bitem: null, ilvl: request.ilvl, infl: [], useFractured: true, start: null,
    ...plannerPriceSnapshot(B, context), options: { ...C.DEFAULT_OPTIONS, ...savedOptions, ruthless: false },
    targets, phase: 'base', sideOrder: false, sidePlans: true,
  };
  const plans = await runPlanner(message);
  const best = cheapestWorkingPlan(plans);
  if (!best) {
    throw new Error('no plan reaches these affixes');
  }
  return { cost: best.cost, name: best.name };
}

function runPlanner(message) {
  planner.worker ??= new Worker('craft-worker.js', { type: 'module' });
  planner.jobId += 1;
  const id = planner.jobId;
  return new Promise((resolve, reject) => {
    planner.worker.onmessage = event => {
      const data = event.data;
      if (data.id !== id || data.progress || data.plan) {
        return; // progress and previews: only the finished list counts
      }
      if (data.error) {
        reject(new Error(data.error));
        return;
      }
      resolve(data.plans);
    };
    planner.worker.onerror = event => {
      planner.worker = null;
      reject(new Error(event.message || 'the crafting planner crashed'));
    };
    planner.worker.postMessage({ id, ...message });
  });
}

// The cheapest plan that works, from the worker's finished list.
function cheapestWorkingPlan(plans) {
  let best = null;
  for (const plan of plans || []) {
    if (plan.hidden || !plan.ok || !isFinite(plan.cost)) {
      continue;
    }
    if (best === null || plan.cost < best.cost) {
      best = plan;
    }
  }
  return best;
}
