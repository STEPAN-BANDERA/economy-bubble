// Crafting regression test: plans a fixed set of crafts (scripts/craft-regression/items.json) at
// frozen prices (prices.json) and compares every plan's cost with the saved baseline
// (baseline.json). Run it after every change to the crafting engine (public/craft.js,
// public/craft-worker.js):
//
//   npm run test:craft            compare with the baseline (exit code 1 on any difference)
//   npm run test:craft -- --update  save the current costs as the new baseline
//
// A plan that got dearer, disappeared or stopped working fails the test. A plan that got cheaper
// fails it too: an engine change that makes a craft cheaper is either a real improvement (check
// the steps, then --update) or a bug that dropped a failure case (an add that "can't" remove a
// wanted mod looks 100% safe). Differences under TOLERANCE are rounding.
//
// It plans the way the page does: one run without fossils (with "prefixes first" and "suffixes
// first" as plans) and one with fossils, keeping the cheaper copy of a plan both make.
// The crafting data (public/data/craft/) is generated locally and not committed: the baseline
// records the data's build date, and a rebuilt data set is reported (costs can move with it).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const fixtureDir = path.join(here, 'craft-regression');
const baselinePath = path.join(fixtureDir, 'baseline.json');
const TOLERANCE = 0.005; // 0.5%

const { prepareBase, forBaseItem, plan } = await import(path.join(root, 'public', 'craft.js'));

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// simulateGraph stops on a time budget: a frozen clock makes every run identical.
Date.now = () => 0;

const index = readJson(path.join(root, 'public', 'data', 'craft', 'index-poe1.json'));
const { items } = readJson(path.join(fixtureDir, 'items.json'));
const frozenPrices = readJson(path.join(fixtureDir, 'prices.json')).prices;
const price = name => {
  if (name in frozenPrices) {
    return frozenPrices[name];
  }
  return NaN;
};

const preparedBases = new Map();
function baseFor(item) {
  if (!preparedBases.has(item.baseId)) {
    const raw = readJson(path.join(root, 'public', 'data', 'craft', `base-${item.baseId}.json`));
    preparedBases.set(item.baseId, prepareBase(raw, index));
  }
  return forBaseItem(preparedBases.get(item.baseId), item.baseItem, index);
}

// The targets of an item, as the planner takes them.
function targetsFor(B, item) {
  const targets = [];
  for (const [modId, minTier, how] of item.targets) {
    const mod = B.byId.get(modId);
    if (!mod) {
      throw new Error(`${item.name}: mod ${modId} is not in the data for base ${item.baseId}`);
    }
    targets.push({ m: mod, minTier, crafted: how === 'bench', frac: how === 'fractured' });
  }
  return targets;
}

// Every plan's cost for one item: {plan key: {name, cost}}, the cheaper copy when both runs make it.
function planCosts(item) {
  const B = baseFor(item);
  const costs = {};
  const runs = [{ phase: 'base', sidePlans: true }, { phase: 'fossil', sidePlans: false }];
  for (const run of runs) {
    const spec = {
      ilvl: item.ilvl,
      infl: [],
      targets: targetsFor(B, item),
      useFractured: item.targets.some(target => target[2] === 'fractured'),
      supply: {},
      options: {},
      phase: run.phase,
      sidePlans: run.sidePlans,
    };
    for (const result of plan(B, spec, price, index)) {
      if (result.hidden) {
        continue;
      }
      const cost = result.ok && isFinite(result.cost) ? result.cost : null;
      const previous = costs[result.key];
      if (!previous || (cost != null && (previous.cost == null || cost < previous.cost))) {
        costs[result.key] = { name: result.name, cost };
      }
    }
  }
  return costs;
}

function costText(cost) {
  if (cost == null) {
    return 'no plan';
  }
  return `${Math.round(cost).toLocaleString('en-US')}c`;
}

// Compares one item's plans with its baseline: a list of problems (empty when it matches).
function compareItem(itemName, current, saved) {
  const problems = [];
  for (const [key, before] of Object.entries(saved)) {
    const now = current[key];
    if (!now) {
      problems.push(`"${before.name}" is gone (was ${costText(before.cost)})`);
      continue;
    }
    if (before.cost == null && now.cost == null) {
      continue;
    }
    if (now.cost == null) {
      problems.push(`"${before.name}" no longer works (was ${costText(before.cost)})`);
      continue;
    }
    if (before.cost == null) {
      problems.push(`"${now.name}" works now (${costText(now.cost)}; it had no plan)`);
      continue;
    }
    const change = now.cost / before.cost - 1;
    if (change > TOLERANCE) {
      problems.push(`PRICIER: "${now.name}" ${costText(before.cost)} -> ${costText(now.cost)} (+${(change * 100).toFixed(1)}%)`);
    } else if (change < -TOLERANCE) {
      problems.push(`cheaper: "${now.name}" ${costText(before.cost)} -> ${costText(now.cost)} (${(change * 100).toFixed(1)}%): check its steps, then --update`);
    }
  }
  for (const [key, now] of Object.entries(current)) {
    if (!saved[key]) {
      problems.push(`new plan "${now.name}" (${costText(now.cost)}): --update to keep it`);
    }
  }
  return problems;
}

// The cheapest working plan of an item.
function cheapestPlan(costs) {
  let best = null;
  for (const entry of Object.values(costs)) {
    if (entry.cost != null && (!best || entry.cost < best.cost)) {
      best = entry;
    }
  }
  return best;
}

const update = process.argv.includes('--update');
const baseline = fs.existsSync(baselinePath) ? readJson(baselinePath) : null;
const results = {};
let failed = false;

for (const item of items) {
  const started = performance.now();
  const costs = planCosts(item);
  results[item.name] = costs;
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  const best = cheapestPlan(costs);
  console.log(`${item.name}\n  cheapest: ${best ? `${best.name}, ${costText(best.cost)}` : 'none'} (${Object.keys(costs).length} plans, ${seconds} s)`);
  if (update) {
    continue;
  }
  const saved = baseline?.items?.[item.name];
  if (!saved) {
    console.log('  no baseline for this item: run with --update');
    failed = true;
    continue;
  }
  const problems = compareItem(item.name, costs, saved);
  if (problems.length) {
    failed = true;
    for (const problem of problems) {
      console.log(`  ${problem}`);
    }
  } else {
    console.log('  ok: every plan within 0.5% of the baseline');
  }
}

if (baseline && baseline.dataBuilt !== index.built) {
  console.log(`\nNote: the crafting data was built ${index.built}, the baseline on data built ${baseline.dataBuilt}. Costs can move with new data; if the engine didn't change, --update.`);
}

if (update) {
  const saved = { note: 'Plan costs (chaos) at the frozen prices. Written by scripts/craft_regression.mjs --update.', dataBuilt: index.built, items: results };
  fs.writeFileSync(baselinePath, JSON.stringify(saved, null, 1) + '\n');
  console.log(`\nSaved the baseline (${baselinePath}).`);
} else if (failed) {
  console.log('\nFAILED: the crafting engine gives different costs than the baseline.');
  process.exit(1);
} else {
  console.log('\nPassed.');
}
