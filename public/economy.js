// The Economy area's API for every other tab (Crafting, Farming, Build maker, Valdo).
// A tab outside the exchange never reads a market model itself: it asks one of these
// objects, so an item's price is worked out the same way wherever it is shown.
//
//   price(name)    typical price of 1 item, by its in-game name, in this economy's unit;
//                  null when the exchange has no trustworthy price (see trustedHours)
//   volume(name)   { perHour, stock }: units traded per hour over the loaded hours (every
//                  market the item is in) and what's listed in the newest hour; null when
//                  it isn't on the exchange
//   divine()       the Divine Orb's price in this economy's unit (for showing big amounts)
//   window()       which hours the prices come from ('hour', 'day', 'stage'), for labels
//   ready()        whether a market model is loaded
//
// app.js owns the market models (the picked window, a day of history, the Ruthless league,
// a farming league stage) and makes one of these per model with economyApi().
import { price as marketPrice, CHAOS, DIVINE } from './model.js';

// A price from a market that traded in only a few hours of the day isn't a market price.
// Someone paid 61 Divines for 34 Alchemy Shards to move wealth between accounts, and with
// two hours of trades the median can't filter that out: Harbinger read 288 Divines an hour.
// So over a day of data, an item must trade in at least this share of the hours. Fewer
// hours than HOURS_NEEDED_TO_JUDGE (before the day has loaded) can't be judged this way and pass.
const MIN_SHARE_OF_HOURS_TRADED = 0.25;
const HOURS_NEEDED_TO_JUDGE = 12;

// economyApi({ model, unit, items, window }):
//   model    () => the market model to price from (or null while it loads)
//   unit     the item id prices are given in (Chaos, or Alchemy for Ruthless)
//   items    () => the item table (id -> { name, ... })
//   window   () => 'hour' | 'day' | 'stage'
export function economyApi({ model, unit = CHAOS, items, window = () => 'hour' }) {
  const api = {
    unit,
    ready: () => !!model(),
    window,
    idOf: name => itemIdByName(items(), name),
    price: name => trustedPrice(model(), items(), name, unit),
    volume: name => volumeOf(model(), items(), name),
    divine: () => {
      const M = model();
      if (!M) {
        return null;
      }
      if (DIVINE === unit) {
        return 1;
      }
      return trustedPriceOfId(M, DIVINE, unit);
    },
  };
  return api;
}

// Item ids by in-game name, built once per item table.
let namesIndex = null;
export function itemIdByName(items, name) {
  if (!items) {
    return null;
  }
  if (namesIndex?.items !== items) {
    const map = new Map();
    for (const [id, item] of Object.entries(items)) {
      map.set(item.name, id);
    }
    namesIndex = { items, map };
  }
  return namesIndex.map.get(name) ?? null;
}

function trustedPrice(M, items, name, unit) {
  if (!M) {
    return null;
  }
  const id = itemIdByName(items, name);
  if (!id) {
    return null;
  }
  return trustedPriceOfId(M, id, unit);
}

function trustedPriceOfId(M, id, unit) {
  if (id === unit) {
    return 1;
  }
  if (M.hours >= HOURS_NEEDED_TO_JUDGE && hoursItemTraded(M, id) < M.hours * MIN_SHARE_OF_HOURS_TRADED) {
    return null;
  }
  return marketPrice(M, id, unit)?.v || null;
}

// How many hours each item traded in, worked out once per model: a redraw prices hundreds
// of lines, and scanning every market's every hour for each of them froze the page.
function hoursEachItemTraded(M) {
  if (M.hoursTradedByItem) {
    return M.hoursTradedByItem;
  }
  const hoursByItem = new Map();
  const addHour = (itemId, hour) => {
    if (!hoursByItem.has(itemId)) {
      hoursByItem.set(itemId, new Set());
    }
    hoursByItem.get(itemId).add(hour);
  };
  for (const market of M.markets) {
    for (const hour of market.hours) {
      if (hour.va > 0 && hour.vb > 0) {
        addHour(market.a, hour.t);
        addHour(market.b, hour.t);
      }
    }
  }
  M.hoursTradedByItem = hoursByItem;
  return hoursByItem;
}

function hoursItemTraded(M, itemId) {
  const hours = hoursEachItemTraded(M).get(itemId);
  if (!hours) {
    return 0;
  }
  return hours.size;
}

function volumeOf(M, items, name) {
  if (!M) {
    return null;
  }
  const id = itemIdByName(items, name);
  if (!id) {
    return null;
  }
  let traded = 0;
  let stock = 0;
  // What's listed now: only markets seen in the newest hour (over a day, a market's last hour can be old).
  M.tEnd ??= newestHour(M);
  for (const market of M.markets) {
    if (market.a !== id && market.b !== id) {
      continue;
    }
    const isA = market.a === id;
    traded += isA ? market.va : market.vb;
    const last = market.hours[market.hours.length - 1];
    if (last?.t !== M.tEnd) {
      continue;
    }
    const listed = isA ? last?.stockA : last?.stockB;
    if (isFinite(listed) && listed > 0) {
      stock += listed;
    }
  }
  return { perHour: traded / Math.max(1, M.hours), stock };
}

function newestHour(M) {
  let newest = 0;
  for (const market of M.markets) {
    const t = market.hours[market.hours.length - 1]?.t ?? 0;
    if (t > newest) {
      newest = t;
    }
  }
  return newest;
}
