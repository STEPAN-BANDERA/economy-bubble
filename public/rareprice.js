// What a solved rare item costs to craft, for the Build maker's revisit panel (public/buildrevisitview.js): the
// Crafting tab's planner (public/craft.js, run in public/craft-worker.js) plans the item's affixes as targets and the
// cheapest plan's cost is the item's price. Data and prices come from the Crafting area's API (craftdata.js), the
// same the Crafting tab plans with: your own overrides there, the exchange (with its supply), then its estimates.
// One item takes the planner half a minute to a minute, so items wait in a queue, one at a time, and each
// finished price is kept for a day (the economy moves) in the browser's storage.
import { cheapestCraftPlan } from './craftdata.js';

const STORE_KEY = 'rareCraftPrices';
const KEEP_HOURS = 24;
const ITEM_LEVEL = 86; // the Crafting tab link's item level (CRAFT_ITEM_LEVEL in public/buildgear.js)

let X = null; // helpers from buildmaker.js: store, rerender, economy (the Economy API, economy.js), realm
const R = {
  results: new Map(), // item key -> { status: 'waiting' | 'pricing' | 'ready' | 'failed', chaos, plan, error }
  queue: [], // item keys waiting, in order
  items: new Map(), // item key -> the compact item
  running: null, // the key being priced
};

export function useRarePriceHelpers(helpers) {
  X = helpers;
}

// The key a rare item's price is kept under: its base and each affix at its tier.
export function rareItemKey(item) {
  const parts = [];
  for (const affix of item.affixes || []) {
    if (affix.tierIndex !== undefined) {
      parts.push(affix.id + '.' + affix.tierIndex);
    }
  }
  parts.sort();
  return item.craftBase + '|' + parts.join('_');
}

function savedPrices() {
  const saved = X.store.get(STORE_KEY, {});
  return saved && typeof saved === 'object' ? saved : {};
}

function savedPriceOf(key) {
  const entry = savedPrices()[key];
  if (!entry || !(Date.now() - entry.at < KEEP_HOURS * 3600 * 1000)) {
    return null;
  }
  return entry;
}

function savePrice(key, chaos, plan) {
  const saved = savedPrices();
  // Old prices go when new ones are kept, so the storage doesn't grow without end.
  for (const [otherKey, entry] of Object.entries(saved)) {
    if (!(Date.now() - entry.at < KEEP_HOURS * 3600 * 1000)) {
      delete saved[otherKey];
    }
  }
  saved[key] = { chaos, plan, at: Date.now() };
  X.store.set(STORE_KEY, saved);
}

// A rare item's craft price: { status, chaos, plan }. A price not worked out yet is queued (status 'waiting' or
// 'pricing'); the page is drawn again when it is ready.
export function rarePrice(item) {
  if (!item || !item.craftBase) {
    return { status: 'failed', error: 'no crafting base for this item' };
  }
  const key = rareItemKey(item);
  if (R.results.has(key)) {
    return R.results.get(key);
  }
  const saved = savedPriceOf(key);
  if (saved !== null) {
    const result = { status: 'ready', chaos: saved.chaos, plan: saved.plan };
    R.results.set(key, result);
    return result;
  }
  const result = { status: 'waiting' };
  R.results.set(key, result);
  R.items.set(key, item);
  R.queue.push(key);
  startNext();
  return result;
}

// How many items are still waiting or being priced.
export function rarePricesPending() {
  return R.queue.length + (R.running !== null ? 1 : 0);
}

// ---------- the planner ----------
// The Crafting area plans the item (craftdata.js, cheapestCraftPlan); this file only queues
// items and keeps their prices.
function finish(key, result) {
  R.results.set(key, result);
  R.running = null;
  R.items.delete(key);
  if (result.status === 'ready') {
    savePrice(key, result.chaos, result.plan);
  }
  X.rerender();
  startNext();
}

async function startNext() {
  if (R.running !== null || R.queue.length === 0) {
    return;
  }
  const key = R.queue.shift();
  const item = R.items.get(key);
  R.running = key;
  R.results.set(key, { status: 'pricing' });
  X.rerender();
  const affixes = [];
  for (const affix of item.affixes) {
    if (affix.tierIndex !== undefined) {
      affixes.push({ id: affix.id, minTier: affix.tierIndex });
    }
  }
  const context = { store: X.store, ruthless: false, economy: X.economy, realm: X.realm ? X.realm() : '' };
  try {
    const best = await cheapestCraftPlan({ baseId: item.craftBase, affixes, ilvl: ITEM_LEVEL }, context);
    finish(key, { status: 'ready', chaos: best.cost, plan: best.name });
  } catch (error) {
    finish(key, { status: 'failed', error: error.message });
  }
}
