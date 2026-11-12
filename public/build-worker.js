// Runs the build planner's search (public/buildsearch.js) off the main thread; the page (public/buildplanner.js)
// starts several of these and hands each the next task.
// Message in: {id, task}, task one of
//   {type: 'quick', variant, ascendancies: [names], limits, weights, wide}
//   {type: 'full', variant, ascendancy, limits, weights, tolerance, wide, gearLevel, prices: {chaosByName, divineChaos, key} | null}
// Messages out: {id, progress: {done, total}} during a quick task, then {id, result} (a quick task's list, a full
// task's card or null) or {id, error}.
import { prepareMechanics, attachPrices } from './buildgen.js';
import { quickPlans, fullPlan } from './buildsearch.js';

const DATA = 'data/builds/';
let quickIndex = null; // without the tree: the quick pass composes without one
let fullIndex = null;
let pricesKey = null;

async function fetchJson(name) {
  const response = await fetch(DATA + name);
  if (!response.ok) {
    throw new Error(name + ' answered ' + response.status);
  }
  return response.json();
}

// The rare-gear affixes (public/data/craft/gear-poe1.json), when the crafting data was built for this site; the full
// plans solve gear with them, and without them use the engine's fixed gear figures.
async function fetchGear() {
  try {
    const response = await fetch('data/craft/gear-poe1.json');
    return response.ok ? await response.json() : null;
  } catch (error) {
    return null;
  }
}

async function loadIndexes() {
  if (quickIndex !== null) {
    return;
  }
  const [mechanics, tree, gear] = await Promise.all([fetchJson('mechanics-poe1.json'), fetchJson('tree-poe1.json'), fetchGear()]);
  quickIndex = prepareMechanics(mechanics);
  fullIndex = prepareMechanics(mechanics, tree, gear);
}

// Prices reach only the full plans' value plan; the power plan and every stage stay price-blind.
function usePrices(prices) {
  if (!prices || prices.key === pricesKey) {
    return;
  }
  attachPrices(fullIndex, prices.chaosByName, prices.divineChaos);
  pricesKey = prices.key;
}

self.onmessage = async event => {
  const { id, task } = event.data;
  try {
    await loadIndexes();
    if (task.type === 'quick') {
      const onProgress = (done, total) => self.postMessage({ id, progress: { done, total } });
      const result = quickPlans(task.variant, quickIndex, task.ascendancies, { limits: task.limits, weights: task.weights, wide: task.wide, onProgress });
      self.postMessage({ id, result });
      return;
    }
    usePrices(task.prices);
    const result = fullPlan(task.variant, task.ascendancy, fullIndex, {
      limits: task.limits, weights: task.weights, tolerance: task.tolerance, wide: task.wide, gearLevel: task.gearLevel });
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
