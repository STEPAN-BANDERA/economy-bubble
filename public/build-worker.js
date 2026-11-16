// Runs the build planner's search (public/buildsearch.js) off the main thread; the page (public/buildplanner.js)
// starts several of these and hands each the next task.
// Message in: {id, task}, task one of
//   {type: 'quick', variant, ascendancies: [names], limits, weights, wide}
//   {type: 'full', variant, ascendancy, limits, weights, tolerance, wide, gearLevel, prices: {chaosByName, divineChaos, key} | null}
//   {type: 'why', idea, weights, wide}: a card's build rebuilt from its names, for "Why these pieces"
//     (public/buildideas.js); the result is its planned tree and buffs (plannedTreeOf), or null
//   {type: 'revisit', idea, weights, wide, plannedTree, prices, question}: a card's gear revisited with today's
//     prices (public/buildrevisit.js); question is {kind: 'slot', slot, budget}, {kind: 'jewels', budget} or
//     {kind: 'set', priceCap}, budgets in Divines (null for any price); the result is that function's answer
// Messages out: {id, progress: {done, total}} during a quick task, then {id, result} (a quick task's list, a full
// task's card or null) or {id, error}.
import { prepareMechanics, attachPrices, rebuildFromNames, plannedTreeOf, evaluateBuild } from './buildgen.js';
import { slotOptions, jewelOptions, setComparison } from './buildrevisit.js';
import { quickPlans, fullPlan } from './buildsearch.js';
import { scoreFunctionFor } from './buildstages.js';
import { fetchBuildFile } from './builddata.js';
import { loadCraftGear } from './craftdata.js';

let quickIndex = null; // without the tree: the quick pass composes without one
let fullIndex = null;
let pricesKey = null;

async function loadIndexes() {
  if (quickIndex !== null) {
    return;
  }
  const [mechanics, tree, gear] = await Promise.all([fetchBuildFile('mechanics-poe1.json'), fetchBuildFile('tree-poe1.json'), loadCraftGear()]);
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

// Planning the tree again is what takes seconds; the page puts the rest of the build back together itself.
function plannedTreeForWhy(task) {
  const options = {};
  if (task.weights) {
    options.scoreOf = scoreFunctionFor(task.weights);
  }
  if (task.wide) {
    options.wide = true;
  }
  const build = rebuildFromNames(task.idea, fullIndex, options);
  if (!build) {
    return null;
  }
  return plannedTreeOf(build);
}

// A card's build put back together from its names and the tree the page already has, then the revisit question.
function revisitAnswer(task) {
  const scoreOf = task.weights ? scoreFunctionFor(task.weights) : build => evaluateBuild(build).score;
  const options = { scoreOf };
  if (task.wide) {
    options.wide = true;
  }
  const build = rebuildFromNames(task.idea, fullIndex, { ...options, plannedTree: task.plannedTree });
  if (!build) {
    return null;
  }
  const question = task.question;
  if (question.kind === 'slot') {
    return slotOptions(build, fullIndex, question.slot, question.budget, { scoreOf });
  }
  if (question.kind === 'jewels') {
    return jewelOptions(build, fullIndex, question.budget, { scoreOf });
  }
  return setComparison(build, fullIndex, question.priceCap, { scoreOf });
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
    if (task.type === 'why') {
      self.postMessage({ id, result: plannedTreeForWhy(task) });
      return;
    }
    usePrices(task.prices);
    if (task.type === 'revisit') {
      self.postMessage({ id, result: revisitAnswer(task) });
      return;
    }
    const result = fullPlan(task.variant, task.ascendancy, fullIndex, {
      limits: task.limits, weights: task.weights, tolerance: task.tolerance, wide: task.wide, gearLevel: task.gearLevel });
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
