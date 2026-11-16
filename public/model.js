// Market model and analyses. Pure functions over GGG's hourly Currency
// Exchange digests, with no DOM, so they can be tested in Node.
//
// Field semantics, checked against real data: for market_pair [A, B],
//   volume_traded[A] : volume_traded[B]   = total A and B that changed hands that hour,
//                                           so vB / vA is the hour's average price of A in B;
//   lowest_ratio / highest_ratio          = min / max of A:B over the hour's trades
//                                           (the average always falls inside);
//   lowest_stock / highest_stock          = min / max quantity offered on each side.
// GGG's reference defines none of the ratio or stock fields, so these are readings of the data.
// Digests are history: no open orders, no order book, nothing from the current hour.

export const CUR = 'Metadata/Items/Currency/';
export const CHAOS = CUR + 'CurrencyRerollRare', DIVINE = CUR + 'CurrencyModValues', EXALT = CUR + 'CurrencyAddModToRare';

// Every coefficient the analyses use, in one place. The page lets people change
// them ("Formulas" panel) and everything is recomputed with their values.
export const DEFAULTS = {
  priceMethod: 'median',  // 'median' of hourly averages, or 'vwap' (total traded / total traded)
  haircut: 3,             // % knocked off every trade's rate as a safety margin
  share: 25,              // % of a market's hourly demand you expect to win
  goldValue: 0,           // what 100,000 gold is worth to you, in the main currency (0 = ignore gold)
  heldPow: 2,             // score: weight of "gap held" (exponent)
  activePow: 1,           // score: weight of "market traded every hour" (exponent)
  goldRef: 300,           // score: gold per unit of profit at which the score halves
  jumpy: 15,              // % typical hourly move above which a market is flagged jumpy
  oddDev: 30,             // % off the normal price for an hour to count as an odd trade
  steadyHeld: 90,         // % of hours a gap must hold to count as steady
  spikeHeld: 75,          // % of hours below which a quick pick is flagged as a spike
  junkTrade: 50,          // % away from the hour's average beyond which a lowest/highest trade is a mistake, not a price
  wideStep: 50,           // % between an hour's low and high above which a route step is counted at its low end
};
export const withDefaults = P => ({ ...DEFAULTS, ...(P || {}) });

export const median = xs => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Shrink one hour's markets to the fields used here (a week of PoE2 is ~470k markets).
export function compact(markets) {
  return markets.map(m => {
    const [a, b] = m.market_pair;
    const r1 = m.lowest_ratio[a] && m.lowest_ratio[b] ? m.lowest_ratio[b] / m.lowest_ratio[a] : null;
    const r2 = m.highest_ratio[a] && m.highest_ratio[b] ? m.highest_ratio[b] / m.highest_ratio[a] : null;
    return {
      league: m.league, id: m.market_id, a, b, va: m.volume_traded[a] || 0, vb: m.volume_traded[b] || 0,
      lo: r1 && r2 ? Math.min(r1, r2) : null, hi: r1 && r2 ? Math.max(r1, r2) : null, // B per A
      stockA: [m.lowest_stock[a], m.highest_stock[a]], stockB: [m.lowest_stock[b], m.highest_stock[b]],
    };
  });
}

export function leaguesOf(pages) {
  const n = new Map();
  for (const p of pages) for (const m of p.markets) n.set(m.league, (n.get(m.league) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
}
export const isPrivate = l => /\(PL\d+\)\s*$/.test(l);

// pages: [{t, markets: compact(...)}], oldest first. P: parameters (see DEFAULTS).
export function buildModel(pages, league, items, P) {
  const markets = new Map();
  for (const p of pages) for (const m of p.markets) {
    if (m.league !== league) continue;
    let e = markets.get(m.id);
    if (!e) markets.set(m.id, e = { a: m.a, b: m.b, va: 0, vb: 0, hours: [] });
    e.va += m.va; e.vb += m.vb;
    e.hours.push({ t: p.t, va: m.va, vb: m.vb, lo: m.lo, hi: m.hi, stockA: m.stockA, stockB: m.stockB });
  }
  const byPair = new Map();
  for (const e of markets.values()) { byPair.set(e.a + '|' + e.b, e); byPair.set(e.b + '|' + e.a, e); }
  const ids = new Set(); for (const e of markets.values()) { ids.add(e.a); ids.add(e.b); }
  const M = { markets: [...markets.values()], byPair, ids: [...ids], hours: pages.length, items, P: withDefaults(P), rateCache: new Map(), priceCache: new Map() };
  M.hubs = topHubs(M);
  return M;
}

// Price of 1 x in y over the window, plus everything about that market.
// Every hour's low and high are the believable ones (see believableLow): the raw extremes
// are single trades, and one mistake among thousands sets them. `rawLo`/`rawHi` keep them.
export function rate(M, x, y) {
  const k = x + '|' + y;
  if (M.rateCache.has(k)) return M.rateCache.get(k);
  const e = M.byPair.get(k);
  let r = null;
  if (e) {
    const junkLimit = M.P.junkTrade / 100;
    const fwd = e.a === x;
    const volX = fwd ? e.va : e.vb, volY = fwd ? e.vb : e.va;
    const series = [];
    let lo = Infinity, hi = -Infinity;
    let unreadHours = 0;
    let mirroredHours = 0;
    for (const h of e.hours) {
      const hx = fwd ? h.va : h.vb, hy = fwd ? h.vb : h.va;
      const rawLo = h.lo == null ? null : fwd ? h.lo : 1 / h.hi;
      const rawHi = h.hi == null ? null : fwd ? h.hi : 1 / h.lo;
      if (hx > 0 && hy > 0) {
        const average = hy / hx;
        const low = believableLow(average, rawLo, rawHi, junkLimit);
        const high = believableHigh(average, rawLo, rawHi, junkLimit);
        series.push({ t: h.t, v: average, lo: low.value, hi: high.value, rawLo, rawHi, vx: hx, vy: hy });
        if (low.mirrored || high.mirrored) {
          mirroredHours++;
        }
        if (low.value == null || high.value == null) {
          unreadHours++;
        } else {
          lo = Math.min(lo, low.value);
          hi = Math.max(hi, high.value);
        }
      }
    }
    const last = e.hours[e.hours.length - 1];
    const vwap = volX > 0 && volY > 0 ? volY / volX : null;
    const mid = median(series.map(s => s.v));
    // `med` is the typical price used everywhere: the median of the hourly averages
    // by default, or the volume-weighted average if the parameters say so.
    const med = M.P.priceMethod === 'vwap' ? vwap : mid;
    // How jumpy the hourly price is: median absolute deviation, relative to the median.
    const jump = med ? median(series.map(s => Math.abs(s.v / med - 1))) : null;
    r = {
      v: vwap, med, median: mid, jump, volX, volY, active: series.length, series,
      lo: isFinite(lo) ? lo : null, hi: isFinite(hi) ? hi : null,
      medLo: median(series.filter(s => s.lo != null).map(s => s.lo)),
      medHi: median(series.filter(s => s.hi != null).map(s => s.hi)),
      spread: typicalSpread(series),
      unreadHours, mirroredHours,
      stockX: last && (fwd ? last.stockA : last.stockB), stockY: last && (fwd ? last.stockB : last.stockA),
    };
  }
  M.rateCache.set(k, r);
  return r;
}

// An hour's lowest and highest trades are single trades, and one mistake sets them: in a
// Covens hour where Divines traded at 174.5 Chaos on average over 86,724 of them, the lowest
// ratio was 1 Chaos for 1 Divine. An end further than `junkLimit` from the hour's average
// is taken for such a mistake. Its place is taken by the other end mirrored around the
// average (low = average² ÷ high), on the reading that real fills spread about as far
// either way; with both ends mistaken (or missing) the hour's range is unknown (null).
function believableLow(average, rawLo, rawHi, junkLimit) {
  const lowIsBelievable = rawLo != null && rawLo >= average * (1 - junkLimit);
  const highIsBelievable = rawHi != null && rawHi <= average / (1 - junkLimit);
  if (lowIsBelievable) {
    return { value: rawLo, mirrored: false };
  }
  if (highIsBelievable) {
    return { value: average * average / rawHi, mirrored: true };
  }
  return { value: null, mirrored: false };
}

function believableHigh(average, rawLo, rawHi, junkLimit) {
  const lowIsBelievable = rawLo != null && rawLo >= average * (1 - junkLimit);
  const highIsBelievable = rawHi != null && rawHi <= average / (1 - junkLimit);
  if (highIsBelievable) {
    return { value: rawHi, mirrored: false };
  }
  if (lowIsBelievable) {
    return { value: average * average / rawLo, mirrored: true };
  }
  return { value: null, mirrored: false };
}

// How far apart fills were in a typical hour: the median of the hours' high ÷ low − 1
// (null when no hour's range could be read).
function typicalSpread(series) {
  const spreads = [];
  for (const hour of series) {
    if (hour.lo != null && hour.hi != null && hour.lo > 0) {
      spreads.push(hour.hi / hour.lo - 1);
    }
  }
  return median(spreads);
}

// ---------- quotes: the one answer to "what does this market pay" ----------
// Every tab that trades (routes, flips, recipes, spreads) prices a trade with a quote, so
// one market reads the same everywhere. For selling 1 x and receiving y:
//   average   the typical price (`med`, by the Typical price setting)
//   low/high  the typical hour's believable low and high fills
//   worst     the lowest believable fill of any hour; null when some hour can't be read
//   spread    how far apart fills were in a typical hour (high ÷ low − 1)
//   wide      the spread is above the wide limit, or unknown: the average then says little
//             about any one fill, so trades are counted at the bad end instead:
//   sell      y you get for 1 x: the average, or the typical low when wide
//   buy       y you pay for 1 x: the average, or the typical high when wide
//   via       the hub currency it was priced through, if the direct market didn't trade
// null when the market didn't trade (or, wide, its bad end can't be read).
export function quote(M, x, y) {
  if (x === y) {
    return unitQuote();
  }
  const key = x + '|' + y;
  M.quoteCache ??= new Map();
  if (M.quoteCache.has(key)) {
    return M.quoteCache.get(key);
  }
  const result = directQuote(M, x, y);
  M.quoteCache.set(key, result);
  return result;
}

function unitQuote() {
  return { average: 1, low: 1, high: 1, worst: 1, spread: 0, wide: false, sell: 1, buy: 1, via: null, mirrored: false, active: Infinity };
}

function directQuote(M, x, y) {
  const r = rate(M, x, y);
  if (!r?.med || !(r.volX > 0 && r.volY > 0)) {
    return null;
  }
  const wideLimit = M.P.wideStep / 100;
  const wide = r.spread == null || r.spread > wideLimit;
  let sell = r.med;
  let buy = r.med;
  if (wide) {
    if (r.medLo == null || r.medHi == null) {
      return null;
    }
    sell = Math.min(r.med, r.medLo);
    buy = Math.max(r.med, r.medHi);
  }
  return {
    average: r.med, low: r.medLo, high: r.medHi,
    worst: r.unreadHours > 0 ? null : r.lo,
    spread: r.spread, wide, sell, buy, via: null,
    mirrored: r.mirroredHours > 0, active: r.active,
  };
}

// A quote of x in `base` through the hub currency x trades most against, when the direct
// market didn't trade: both trades happen, so their prices multiply and either one being
// wide makes the pair wide.
export function quoteVia(M, x, base) {
  const direct = quote(M, x, base);
  if (direct) {
    return direct;
  }
  const hub = price(M, x, base).via;
  if (!hub) {
    return null;
  }
  const toHub = quote(M, x, hub);
  const hubToBase = quote(M, hub, base);
  if (!toHub || !hubToBase) {
    return null;
  }
  return {
    average: toHub.average * hubToBase.average,
    low: toHub.low * hubToBase.low,
    high: toHub.high * hubToBase.high,
    worst: toHub.worst == null || hubToBase.worst == null ? null : toHub.worst * hubToBase.worst,
    spread: null,
    wide: toHub.wide || hubToBase.wide,
    sell: toHub.sell * hubToBase.sell,
    buy: toHub.buy * hubToBase.buy,
    via: hub,
    mirrored: toHub.mirrored || hubToBase.mirrored,
    active: Math.min(toHub.active, hubToBase.active),
  };
}

// The most-traded currencies, measured by how many other items trade against them.
function topHubs(M) {
  const n = new Map();
  for (const e of M.markets) if (e.va > 0 && e.vb > 0) { n.set(e.a, (n.get(e.a) || 0) + 1); n.set(e.b, (n.get(e.b) || 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
}

// Typical value of 1 x in `base`: the direct market if it traded, otherwise
// through whichever hub currency x traded most against.
export function price(M, x, base) {
  if (x === base) return { v: 1, via: null, active: Infinity };
  const k = x + '>' + base;
  if (M.priceCache.has(k)) return M.priceCache.get(k);
  M.priceCache.set(k, { v: null, via: null, active: 0 }); // guards against cycles
  let out = { v: null, via: null, active: 0 };
  const d = rate(M, x, base);
  if (d?.med) out = { v: d.med, via: null, active: d.active };
  else {
    let best = 0;
    for (const h of M.hubs) {
      if (h === x || h === base) continue;
      const r = rate(M, x, h), hb = rate(M, h, base);
      if (r?.med && hb?.med && r.volX > best) { best = r.volX; out = { v: r.med * hb.med, via: h, active: r.active }; }
    }
  }
  M.priceCache.set(k, out);
  return out;
}

const fee = (M, id) => M.items[id]?.fee ?? null;

// Hourly series of 1 x valued in base, from its direct market or through its hub.
export function priceSeries(M, x, base) {
  const p = price(M, x, base);
  if (p.v == null || x === base) return [];
  if (!p.via) return rate(M, x, base).series;
  const hb = new Map(rate(M, p.via, base).series.map(s => [s.t, s.v]));
  const hbMed = rate(M, p.via, base).med;
  return rate(M, x, p.via).series.map(s => ({ t: s.t, v: s.v * (hb.get(s.t) ?? hbMed) }));
}

// Same item, two currencies: buy where it's cheap, sell where it's dear, convert back.
// Every trade is priced by its market's quote, so a wide market (fills far apart within
// the hour) counts at its bad end: you buy at its typical high and sell at its typical low.
// Two averages from markets that spread 2-4x disagree by chance, not because the gap is
// there to take.
export function flips(M, A, B) {
  const BA = rate(M, B, A);
  const quoteBA = quote(M, B, A);
  if (!BA?.med || !quoteBA) {
    return [];
  }
  const rows = [];
  for (const x of M.ids) {
    if (x === A || x === B) {
      continue;
    }
    const rA = rate(M, x, A);
    const rB = rate(M, x, B);
    const quoteXA = quote(M, x, A);
    const quoteXB = quote(M, x, B);
    if (!rA?.med || !rB?.med || !quoteXA || !quoteXB) {
      continue;
    }
    const trade = bestFlipDirection(quoteXA, quoteXB, quoteBA);
    const { buyWithA, cost, revenue, pA, rateB, conv } = trade;
    const roi = revenue / cost - 1;
    const profit = revenue - cost; // A per x, per round trip
    // Gold is charged on what you receive: x on the buy, B (or A) on the sell, then the conversion.
    const fx = fee(M, x), fa = fee(M, A), fb = fee(M, B);
    let gold = null;
    if (fx != null && fa != null && fb != null) {
      if (buyWithA) {
        gold = fx + fb * rateB + fa * revenue;
      } else {
        gold = fb * rateB + fx + fa * revenue;
      }
    }
    const { both, held } = hoursTheGapHeld(rA, rB, BA, buyWithA);
    const thin = Math.min(rA.volX, rB.volX) / M.hours;
    // Net of the safety margin on each of the 3 trades, and of gold if it has a value.
    const h = M.P.haircut / 100;
    const net = revenue * (1 - h) ** 3 - cost - (gold ?? 0) * M.P.goldValue / 1e5;
    rows.push({
      x, A, B, buyWithA, roi, netRoi: net / cost, profit, net, gold, goldPer: gold != null && profit > 0 ? gold / profit : null,
      pA, pB: rateB * conv, rateB, conv, thin, perHour: Math.max(0, net) * thin, both, held,
      wide: quoteXA.wide || quoteXB.wide || quoteBA.wide,
      averageA: quoteXA.average, averageB: quoteXB.average * quoteBA.average,
      volA: rA.volX, volB: rB.volX, active: Math.min(rA.active, rB.active),
      jump: Math.max(rA.jump ?? 0, rB.jump ?? 0),
    });
  }
  score(rows, M.hours, M.P);
  return rows;
}

// The two ways round a flip, each priced at what the trades would really fill at:
//   buy with A: pay x's buy price in A, sell x for B, sell B for A;
//   buy with B: buy B with A, pay x's buy price in B, sell x for A.
// The one that returns more is kept. The calculator fields mean what they did: `pA` is
// x's price in A (paid or received), `rateB` x's price in B, `conv` B's price in A.
function bestFlipDirection(quoteXA, quoteXB, quoteBA) {
  const withA = {
    buyWithA: true,
    cost: quoteXA.buy,
    revenue: quoteXB.sell * quoteBA.sell,
    pA: quoteXA.buy, rateB: quoteXB.sell, conv: quoteBA.sell,
  };
  const withB = {
    buyWithA: false,
    cost: quoteXB.buy * quoteBA.buy,
    revenue: quoteXA.sell,
    pA: quoteXA.sell, rateB: quoteXB.buy, conv: quoteBA.buy,
  };
  if (withA.revenue / withA.cost >= withB.revenue / withB.cost) {
    return withA;
  }
  return withB;
}

// Hours in which both legs traded and the averages pointed the same way as the flip.
function hoursTheGapHeld(rA, rB, BA, buyWithA) {
  const bHours = new Map(rB.series.map(s => [s.t, s.v]));
  const baHours = new Map(BA.series.map(s => [s.t, s.v]));
  let both = 0;
  let held = 0;
  for (const s of rA.series) {
    const vb = bHours.get(s.t);
    const ba = baHours.get(s.t) ?? BA.med;
    if (vb == null) {
      continue;
    }
    both++;
    if ((vb * ba > s.v) === buyWithA) {
      held++;
    }
  }
  return { both, held };
}

// One 0-100 number to sort by: how much it pays per hour (log scale), discounted
// by how reliably the gap held, how often both markets traded, and gold cost.
export function scoreRaw(r, hours, P) {
  const held = r.both ? r.held / r.both : 0;
  const active = Math.min(1, r.active / hours);
  const gold = r.goldPer == null ? 0.5 : 1 / (1 + r.goldPer / P.goldRef);
  return Math.log10(1 + r.perHour) * held ** P.heldPow * active ** P.activePow * gold;
}
function score(rows, hours, P) {
  const raw = rows.map(r => scoreRaw(r, hours, P));
  const max = Math.max(...raw, 1e-9);
  rows.forEach((r, i) => { r.score = Math.round(raw[i] / max * 100); });
}

// Market making in one pair: the typical hour's believable low and high (rate() drops
// trades that were plainly mistakes, so one Divine sold for 1 Chaos is no 17,900% margin).
// A market with no hour whose range could be read is left out.
export function spreads(M, base) {
  const rows = [];
  for (const e of M.markets) {
    if (!(e.va > 0 && e.vb > 0)) {
      continue;
    }
    // Show the pair as "item priced in currency": the side that is the bigger hub is the currency.
    const ia = M.hubs.indexOf(e.a), ib = M.hubs.indexOf(e.b);
    const [x, y] = ia !== -1 && (ib === -1 || ia < ib) ? [e.b, e.a] : [e.a, e.b];
    const r = rate(M, x, y);
    if (r.spread == null) {
      continue;
    }
    const readableHours = r.series.filter(hour => hour.lo != null && hour.hi != null).length;
    const pa = price(M, e.a, base).v;
    const value = pa != null ? e.va * pa / M.hours : null;
    rows.push({ x, y, med: r.spread, active: readableHours, lo: r.lo, hi: r.hi, v: r.med, buyAt: r.medLo, sellAt: r.medHi,
      mirrored: r.mirroredHours > 0, value, edge: value != null ? value * r.spread : null, stockX: r.stockX, stockY: r.stockY });
  }
  return rows;
}

export function oddTrades(M, base) {
  // "Normal" is each side's typical value from its own most liquid market, so a
  // dead market that only ever traded at an absurd price still stands out.
  const need = Math.max(6, M.hours / 4);
  const typical = id => {
    const p = price(M, id, base);
    return p.v != null && p.active >= need ? p.v : null;
  };
  const rows = [];
  for (const e of M.markets) {
    if (!(e.va > 0 && e.vb > 0)) continue;
    const pa = typical(e.a), pb = typical(e.b);
    if (pa == null || pb == null) continue;
    const normal = pa / pb; // B per A
    for (const h of e.hours) {
      if (!(h.va > 0 && h.vb > 0)) continue;
      const dev = (h.vb / h.va) / normal - 1;
      if (Math.abs(dev) < M.P.oddDev / 100) continue;
      const value = Math.abs(h.vb - h.va * normal) * pb;
      const xIsA = M.hubs.indexOf(e.a) === -1 || (M.hubs.indexOf(e.b) !== -1 && M.hubs.indexOf(e.b) < M.hubs.indexOf(e.a));
      const [x, y, qx, qy, nrm] = xIsA ? [e.a, e.b, h.va, h.vb, normal] : [e.b, e.a, h.vb, h.va, 1 / normal];
      // More changed hands than was ever on offer at once: the orders met as soon as
      // they were placed, which is what a transfer between two cooperating accounts looks like.
      const instant = h.stockA[1] <= h.va && h.stockB[1] <= h.vb;
      rows.push({ t: h.t, x, y, qx, qy, at: qy / qx, normal: nrm, dev: (qy / qx) / nrm - 1, value, instant });
    }
  }
  return rows;
}

// Price rows with "movers": the last quarter of the window against the first.
export function prices(M, base) {
  const vol = new Map();
  for (const e of M.markets) { vol.set(e.a, (vol.get(e.a) || 0) + e.va); vol.set(e.b, (vol.get(e.b) || 0) + e.vb); }
  return M.ids.filter(id => id !== base).map(id => {
    const p = price(M, id, base);
    if (p.v == null) return null;
    const d = p.via ? null : rate(M, id, base);
    const series = priceSeries(M, id, base);
    const q = Math.max(1, Math.floor(series.length / 4));
    const first = median(series.slice(0, q).map(s => s.v)), last = median(series.slice(-q).map(s => s.v));
    const units = (vol.get(id) || 0) / M.hours;
    return { id, v: p.v, via: p.via, units, value: units * p.v, lo: d?.lo, hi: d?.hi, series,
      change: series.length >= 4 && first ? last / first - 1 : null, fee: M.items[id]?.fee };
  }).filter(Boolean);
}

// Recipes: n of one item become 1 of another. Bought and sold on the exchange in `base`.
// Inputs are bought at their quote's buy price and the output sold at its sell price, so a
// wide market counts at its bad end (see quote): an essence whose hour spread 3x can't back
// a 40% recipe at its average.
export function recipeRows(M, recipes, base) {
  const rows = [];
  for (const r of recipes) {
    const pin = price(M, r.from, base), pout = price(M, r.to, base);
    const quoteIn = quoteVia(M, r.from, base);
    const quoteOut = quoteVia(M, r.to, base);
    if (pin.v == null || pout.v == null || !quoteIn || !quoteOut) {
      continue;
    }
    const cost = r.n * quoteIn.buy;
    const revenue = quoteOut.sell * (1 - M.P.haircut / 100) ** 2;
    const fin = fee(M, r.from), fb = fee(M, base);
    const gold = fin == null || fb == null ? null : r.n * fin + fb * revenue;
    const profit = revenue - cost - (gold ?? 0) * M.P.goldValue / 1e5;
    // Crafts per hour the market could absorb: inputs available, and outputs it buys.
    const perHourCap = Math.min(unitsTradedPerHour(M, r.from) / r.n, unitsTradedPerHour(M, r.to));
    rows.push({ ...r, pin: quoteIn.buy, pout: quoteOut.sell, wideIn: quoteIn.wide, wideOut: quoteOut.wide,
      averageIn: quoteIn.average, averageOut: quoteOut.average, cost, revenue, profit, roi: profit / cost, gold,
      goldPer: gold != null && profit > 0 ? gold / profit : null, cap: perHourCap, perHour: Math.max(0, profit) * perHourCap,
      active: Math.min(pin.active, pout.active) });
  }
  return rows;
}

// Units of an item that changed hands per hour, over every market it trades in.
function unitsTradedPerHour(M, id) {
  let units = 0;
  for (const e of M.markets) {
    if (e.a === id) {
      units += e.va;
    } else if (e.b === id) {
      units += e.vb;
    }
  }
  return units / M.hours;
}

// The receiving currency buyers had waiting all hour in a market: the last hour's lowest
// stock of y. Nobody waiting means the prices came from trades that met at once, which is
// what a transfer between two cooperating accounts looks like.
export function buyersWaiting(r) {
  return r?.stockY?.[0] ?? 0;
}

// A price as the whole-number ratio you'd type in game: 0.1 -> [10, 1] ("give 10, get 1").
export function toRatio(p, maxDen = 2000) {
  if (!(p > 0) || !isFinite(p)) return null;
  // Best rational approximation by continued fractions.
  let [h0, h1, k0, k1, x] = [0, 1, 1, 0, p];
  for (let i = 0; i < 30; i++) {
    const a = Math.floor(x);
    const [h2, k2] = [a * h1 + h0, a * k1 + k0];
    if (k2 > maxDen) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (Math.abs(h1 / k1 - p) / p < 0.005) break;
    x = 1 / (x - a);
    if (!isFinite(x)) break;
  }
  return [h1, k1]; // p ≈ h1 / k1
}

// ---------- multi-step routes ----------
// Loops like Chaos -> Divine -> Essence -> Chaos. Every step is a market sale of
// `from` for `to`, and is only trusted as far as the market showed demand for it:
//   traded   what actually changed hands per hour in that market (units of `from`), and
//   bid      the receiving currency buyers had waiting all hour (that hour's *lowest*
//            stock of `to`), converted to units of `from`.
// A step with no buyers waiting is dropped; that alone removes the fake prices from
// account-to-account transfers. You only get `share` of what the market absorbed.
//
// A step is priced by its market's quote (see quote above): `rate` is what selling 1 `from`
// pays (the average, or the low end in a wide market), `worst` the worst believable fill.
// A market whose quote can't be read is no step.
function edges(M, share) {
  const out = new Map();
  const add = (from, to, e, fwd) => {
    const r = rate(M, from, to);
    const q = quote(M, from, to);
    if (!r || !q) {
      return;
    }
    const bid = buyersWaiting(r);
    if (!(bid > 0)) {
      return;
    }
    const traded = r.volX / M.hours;
    const bidInFrom = bid / q.average;
    const cap = share * Math.min(traded, bidInFrom);
    if (!(cap > 0)) {
      return;
    }
    if (!out.has(from)) {
      out.set(from, []);
    }
    out.get(from).push({ from, to, rate: q.sell, average: q.average, wide: q.wide, spread: q.spread,
      worst: q.worst, worstMirrored: q.mirrored, traded, bid, cap, fee: M.items[to]?.fee ?? null });
  };
  for (const e of M.markets) {
    add(e.a, e.b, e, true);
    add(e.b, e.a, e, false);
  }
  return out;
}

// Search loops from `start` of 3..maxLegs steps, with at most one step through an
// item that isn't one of the big trading currencies (that keeps the search small and
// the routes doable). `haircut` is knocked off every step's rate as a safety margin.
export function routes(M, start, { maxLegs = 4 } = {}) {
  const share = M.P.share / 100, haircut = M.P.haircut / 100, goldValue = M.P.goldValue;
  const E = edges(M, share);
  const hubs = new Set(M.hubs);
  const found = [];
  const path = [start];
  const legs = [];
  const walk = (node, depth, items) => {
    for (const e of E.get(node) || []) {
      const isHub = hubs.has(e.to);
      if (e.to === start) { if (depth + 1 >= 3) found.push(evaluate([...legs, e], haircut, goldValue)); continue; }
      if (depth + 1 >= maxLegs || path.includes(e.to)) continue;
      if (!isHub && items >= 1) continue;
      path.push(e.to); legs.push(e);
      walk(e.to, depth + 1, items + (isHub ? 0 : 1));
      path.pop(); legs.pop();
    }
  };
  walk(start, 0, 0);
  return found.filter(r => r.roi > 0);
}

function evaluate(legs, haircut, goldValue = 0) {
  let amt = 1, worst = 1, gold = 0, size = Infinity, limit = 0, goldKnown = true;
  let worstKnown = true;
  for (const [i, l] of legs.entries()) {
    // `amt` units of l.from go into this step per 1 unit of the start currency.
    const through = l.cap / amt;
    if (through < size) { size = through; limit = i; }
    amt *= l.rate * (1 - haircut);
    if (l.worst == null) {
      worstKnown = false;
    } else {
      worst *= l.worst;
    }
    if (l.fee == null) goldKnown = false; else gold += l.fee * amt;
  }
  // Gold, if it has a value, is paid in the start currency per loop.
  const roi = amt - 1 - (goldKnown ? gold * goldValue / 1e5 : 0);
  // A step whose range couldn't be read leaves the worst case unknown, not −100%.
  const worstRoi = worstKnown ? worst - 1 : null;
  const r = { legs, roi, worstRoi, size, limit, perHour: size * roi,
    goldPerStart: goldKnown ? gold : null, goldPer: goldKnown && roi > 0 ? gold / roi : null };
  r.plan = wholeUnits(legs, Math.floor(size), haircut);
  r.id = legs.map(l => l.from).join('>');
  return r;
}

// Run the route with whole units, the way the exchange does it: each step gives
// floor(amount x rate). Returns what you'd hand over and get back at each step.
export function wholeUnits(legs, startAmount, haircut = 0, rates = null) {
  let x = startAmount;
  const steps = legs.map((l, i) => {
    const give = x;
    const eff = (rates?.[i] ?? l.rate) * (1 - haircut);
    const got = Math.floor(give * eff + 1e-9);
    x = got;
    // What's left of `give` after paying for `got` whole units: kept, but not counted.
    return { from: l.from, to: l.to, give, got, left: eff > 0 ? give - Math.ceil(got / eff - 1e-9) : 0 };
  });
  return { start: startAmount, end: x, profit: x - startAmount, steps };
}

// The same route hour by hour in a longer model: did it pay, and was there demand?
export function routeHours(H, route, haircut = 0.03) {
  const rows = [];
  const series = route.legs.map(l => {
    const e = H.byPair.get(l.from + '|' + l.to);
    if (!e) return new Map();
    const fwd = e.a === l.from;
    return new Map(e.hours.filter(h => h.va > 0 && h.vb > 0).map(h => [h.t, {
      rate: fwd ? h.vb / h.va : h.va / h.vb, bid: (fwd ? h.stockB : h.stockA)?.[0] ?? 0 }]));
  });
  const ts = [...new Set(series.flatMap(s => [...s.keys()]))].sort((a, b) => a - b);
  for (const t of ts) {
    const hs = series.map(s => s.get(t));
    if (hs.some(h => !h)) { rows.push({ t, traded: false }); continue; }
    const prod = hs.reduce((p, h) => p * h.rate * (1 - haircut), 1);
    rows.push({ t, traded: true, roi: prod - 1, demand: hs.every(h => h.bid > 0) });
  }
  return rows;
}

// ---------- league-end flip ----------
// When a challenge league ends, its characters and stashes move to a permanent league: Standard,
// or Hardcore, Ruthless, Hardcore Ruthless for those kinds of league. Whatever you hold then is
// worth the permanent league's prices. Some items are cheap in the dying league and dear in the
// permanent one: buying them before the end and selling them after multiplies what you bring.

const PERMANENT_LEAGUES = ['Standard', 'Hardcore', 'Ruthless', 'Hardcore Ruthless', 'Solo Self-Found', 'Hardcore SSF', 'SSF Standard', 'SSF Hardcore'];

export function isPermanentLeague(league) {
  return PERMANENT_LEAGUES.includes(league);
}

// The permanent league a league's characters move to when it ends (null for a permanent one).
export function permanentLeagueOf(league) {
  if (!league || isPermanentLeague(league)) {
    return null;
  }
  const hardcore = /hardcore|\bHC\b/i.test(league);
  const ruthless = /ruthless/i.test(league);
  if (ruthless && hardcore) {
    return 'Hardcore Ruthless';
  }
  if (ruthless) {
    return 'Ruthless';
  }
  if (hardcore) {
    return 'Hardcore';
  }
  return 'Standard';
}

// Every item priced in both leagues, in `carry` (the currency you'd otherwise move): its price in
// the ending league (L) and in the permanent one (S), and what each carry unit spent on it is worth
// there: multiplier = S price / L price, less the safety margin on the buy and on the sale.
// Per item also how much of it trades a day on each side. Best multiplier first.
export function leagueEndRows(L, S, carry) {
  const leagueRows = new Map();
  for (const row of prices(L, carry)) {
    leagueRows.set(row.id, row);
  }
  const keep = 1 - L.P.haircut / 100;
  const rows = [];
  for (const standardRow of prices(S, carry)) {
    const leagueRow = leagueRows.get(standardRow.id);
    if (!leagueRow || !(leagueRow.v > 0) || !(standardRow.v > 0)) {
      continue;
    }
    const standardActive = price(S, standardRow.id, carry).active;
    rows.push({
      id: standardRow.id,
      leaguePrice: leagueRow.v,
      standardPrice: standardRow.v,
      multiplier: (standardRow.v / leagueRow.v) * keep * keep,
      leagueUnitsPerDay: leagueRow.units * 24,
      standardUnitsPerDay: standardRow.units * 24,
      standardValuePerDay: standardRow.units * 24 * standardRow.v,
      standardActiveShare: S.hours ? standardActive / S.hours : 0,
      via: leagueRow.via || standardRow.via,
    });
  }
  rows.sort((a, b) => b.multiplier - a.multiplier);
  return rows;
}

// The luggage for `budget` carry units: best multiplier first, each item up to what you can buy in
// the ending league and sell in the permanent one over `days` days at your share of their daily
// trade (P.share). The rest stays in the carry currency (x1). Rows below minMultiplier or traded in
// fewer than minActive of the permanent league's hours are skipped.
export function luggagePlan(rows, budget, { days = 7, share = 25, minMultiplier = 1.05, minActive = 0.5 } = {}) {
  const lines = [];
  let left = budget;
  for (const row of rows) {
    if (left <= 0) {
      break;
    }
    if (row.multiplier < minMultiplier || row.standardActiveShare < minActive) {
      continue;
    }
    const sellableUnits = row.standardUnitsPerDay * days * share / 100;
    const buyableUnits = row.leagueUnitsPerDay * days * share / 100;
    const maxUnits = Math.min(sellableUnits, buyableUnits);
    const units = Math.floor(Math.min(maxUnits, left / row.leaguePrice));
    if (units < 1) {
      continue;
    }
    const spend = units * row.leaguePrice;
    left -= spend;
    lines.push({ row, units, spend, worth: spend * row.multiplier });
  }
  let worth = left;
  for (const line of lines) {
    worth += line.worth;
  }
  return { lines, keptInCarry: left, worth, multiplier: budget > 0 ? worth / budget : 1 };
}
