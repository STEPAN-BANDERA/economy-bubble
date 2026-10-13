// Runs the crafting planner off the main thread. Message in:
// {id, baseId, ilvl, infl, targets: [{id, minTier, crafted, frac}], useFractured, prices: {name: chaos}}
// Messages out: {id, progress} while working, then {id, plans} or {id, error}.
import { prepareBase, forBaseItem, plan } from './craft.js';

let index = null;
const bases = new Map();

self.onmessage = async e => {
  const { id, baseId, bitem, ilvl, infl, targets, useFractured, prices, supply, options, start } = e.data;
  try {
    index ??= await fetch('data/craft/index-poe1.json').then(r => r.json());
    if (!bases.has(baseId)) bases.set(baseId, await fetch(`data/craft/base-${baseId}.json`).then(r => r.json()).then(raw => prepareBase(raw, index)));
    const B = forBaseItem(bases.get(baseId), bitem, index);
    const spec = {
      ilvl, infl, useFractured, options, start, supply: supply ?? {},
      targets: targets.map(t => ({ m: B.byId.get(t.id), minTier: t.minTier, crafted: t.crafted, frac: t.frac })).filter(t => t.m),
    };
    const price = n => (n in prices ? prices[n] : NaN);
    const plans = plan(B, spec, price, index, step => self.postMessage({ id, progress: step }));
    self.postMessage({ id, plans });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
