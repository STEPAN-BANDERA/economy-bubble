// The maths behind every number on the page, in words, and the tunable
// parameters. Shown in the "?" popovers, the Formulas panel and the Lab.

export const FORMULAS = {
  typical: {
    title: 'Typical price',
    formula: 'hourly average = B traded ÷ A traded\ntypical = median(hourly averages)   or   VWAP = Σ B traded ÷ Σ A traded',
    text: 'Every hour GGG reports how much of each side changed hands. The median ignores one freak hour (a transfer, a fat finger). VWAP lets busy hours count more. Pick one under Formulas.',
  },
  gap: {
    title: 'Gap',
    formula: 'value in A market = typical price of the item in A\nvalue via B = typical price in B × (A per B)\ngap = higher ÷ lower − 1',
    text: 'How much more the item is worth on the side you sell it. Before the safety margin and gold.',
  },
  net: {
    title: 'Net profit per item',
    formula: 'net = higher × (1 − margin)³ − lower − gold × goldValue ÷ 100,000',
    text: 'A flip has three trades (buy, sell, convert back), each assumed to fill a little worse than average by the safety margin. Gold counts only if you give it a value.',
  },
  perHour: {
    title: 'Profit per hour',
    formula: 'items/h = min(items traded per hour in A market, in B market)\nprofit/h = max(0, net) × items/h',
    text: 'A ceiling: it assumes you take every item the thinner market traded. Routes use a stricter, demand-checked size.',
  },
  goldPer: {
    title: 'Gold per unit of profit',
    formula: 'gold = Σ fee(what you receive) × amount received\ngold per = gold ÷ profit',
    text: 'The exchange charges a fixed gold fee per unit received, set per item in the game files (Chaos 15, Divine 250 in PoE 1).',
  },
  held: {
    title: 'Held',
    formula: 'held = hours where the gap pointed this way ÷ hours where both markets traded',
    text: 'One hour of gap is noise. A gap that held most hours is a pattern.',
  },
  score: {
    title: 'Score',
    formula: 'raw = log10(1 + profit/h) × held^p × active^q × 1 ÷ (1 + gold per ÷ g)\nscore = raw ÷ best raw in the list × 100',
    text: 'Profit per hour on a log scale, so big markets don\'t drown out everything, then discounted for gaps that come and go, quiet markets and gold cost. p, q and g are under Formulas.',
  },
  jumpy: {
    title: 'Jumpy',
    formula: 'jump = median over hours of |hourly average ÷ typical − 1|\njumpy when jump > threshold',
    text: 'A market whose price swings a lot from hour to hour. Check the live ratio before trusting it.',
  },
  routeReturn: {
    title: 'Route return',
    formula: 'return = Π (rateᵢ × (1 − margin)) − 1 − gold × goldValue ÷ 100,000',
    text: 'Multiply each step\'s rate, minus the safety margin, around the loop. Above 0 means you end with more than you started.',
  },
  routeWorst: {
    title: 'Worst case',
    formula: 'worst = Π (lowest rate seen in the hour)ᵢ − 1',
    text: 'The loop if every step filled at the worst ratio anyone got that hour.',
  },
  routeSize: {
    title: 'Verified size',
    formula: 'capᵢ = share × min(tradedᵢ, buyers waitingᵢ ÷ rateᵢ)\nneedᵢ = units entering step i per 1 start unit\nsize = minᵢ (capᵢ ÷ needᵢ)    profit/h = size × return',
    text: '"Buyers waiting" is the least the other side had on offer at any point in the hour. A step with nobody waiting is dropped. The smallest step limits the whole route.',
  },
  recipe: {
    title: 'Recipe profit',
    formula: 'profit = output price × (1 − margin)² − n × input price − gold × goldValue ÷ 100,000\ncrafts/h = min(input traded/h ÷ n, output traded/h)',
    text: 'Buy n inputs, upgrade them, sell one output. Two trades, so the margin is applied twice.',
  },
  spread: {
    title: 'Margin (spread)',
    formula: 'margin = median over hours of (hour\'s highest ratio ÷ lowest − 1)\nroom/h = margin × traded value per hour',
    text: 'How far apart the best and worst trades in the same hour were: roughly what a buy order at the low end and a sell order at the high end could keep.',
  },
  odd: {
    title: 'Odd trade',
    formula: 'normal = typical value of A ÷ typical value of B (from their most liquid markets)\noff by = hour\'s average ÷ normal − 1\nmoved = |B traded − A traded × normal| × value of B',
    text: 'Hours more than the threshold away from normal. "Instant" means more traded than was ever on offer, on both sides: the orders met as soon as they were placed.',
  },
  book: {
    title: 'Book: Instant or Resting',
    formula: 'Instant  when  traded A ≥ most A ever on offer that hour\n         and  traded B ≥ most B ever on offer that hour\nResting  otherwise',
    text: 'Instant: nothing waited in the market long enough to be seen. One order went up and was filled straight away by the other side. In a dead market at an absurd price, that is the mark of two accounts moving wealth (RMT delivery, mules). Resting: orders sat in the market and anyone could have filled them, so an off price is more likely a fat finger, a bait order that got filled, or a real move.',
    rows: [
      ['Absurd price, dead market', 'Instant', 'Account-to-account transfer'],
      ['Way off, once', 'Resting', 'Fat finger or bait order a stranger filled'],
      ['Off several hours in a row', 'Resting', 'The price really moved'],
    ],
    note: 'Example: 1,555 Divines paid for 14 Blighted Delirium Orbs worth about 11 Chaos each, with at most 0 Divines and 1 orb on offer that hour: Instant. A hint, not proof: thin markets can look Instant by chance.',
  },
  change: {
    title: 'Change',
    formula: 'change = median(last quarter of hours) ÷ median(first quarter) − 1',
    text: 'Needs at least 4 hours in the window.',
  },
};

// Parameters people can tune. Keys match DEFAULTS in model.js.
export const PARAMS = [
  { key: 'priceMethod', label: 'Typical price', type: 'select', options: [['median', 'Median of hourly averages'], ['vwap', 'Volume-weighted (VWAP)']], formula: 'typical' },
  { key: 'haircut', label: 'Safety margin per trade', unit: '%', step: 0.5, formula: 'net', help: 'Every trade is assumed to fill this much worse than average.' },
  { key: 'share', label: 'Your share of demand', unit: '%', step: 5, min: 1, max: 100, formula: 'routeSize', help: 'How much of each market\'s hourly trading you expect to win (routes).' },
  { key: 'goldValue', label: 'Value of 100,000 gold', unit: 'main currency', step: 1, formula: 'net', help: '0 ignores gold. Otherwise gold fees are taken off the profit.' },
  { key: 'heldPow', label: 'Score: weight of "held" (p)', step: 0.5, formula: 'score' },
  { key: 'activePow', label: 'Score: weight of "active" (q)', step: 0.5, formula: 'score' },
  { key: 'goldRef', label: 'Score: gold per unit that halves the score (g)', step: 50, min: 1, formula: 'score' },
  { key: 'jumpy', label: 'Jumpy above', unit: '%', step: 1, formula: 'jumpy' },
  { key: 'oddDev', label: 'Odd trade: off by at least', unit: '%', step: 5, formula: 'odd' },
  { key: 'steadyHeld', label: 'Steady pick: held at least', unit: '%', step: 5, max: 100, formula: 'held' },
  { key: 'spikeHeld', label: 'Quick pick is a spike below', unit: '%', step: 5, max: 100, formula: 'held' },
];

// Ready-made sets of the two coefficients that depend on how you trade. A preset only sets the
// keys it lists; every other coefficient keeps the value the visitor gave it.
// - Optimized: the defaults, a middle way between taking orders and placing them.
// - Instant: you fill the orders already on the exchange, so each trade lands further from the
//   average rate (bigger safety margin), but you can take more of the market (bigger share).
// - Patient: you place your own orders and wait for them to fill, so each trade lands close to the
//   average (small safety margin), but only some of the market comes to you (small share).
export const PRESETS = [
  {
    id: 'optimized', label: 'Optimized',
    help: 'The defaults: 3% margin per trade, 25% of the demand.',
    values: { haircut: 3, share: 25 },
  },
  {
    id: 'instant', label: 'Instant sell (lowest margin)',
    help: 'Take the orders already there and don\'t wait: 5% margin per trade, 50% of the demand.',
    values: { haircut: 5, share: 50 },
  },
  {
    id: 'patient', label: 'Patient (highest margin)',
    help: 'Place your own orders and wait for them to fill: 1% margin per trade, 10% of the demand.',
    values: { haircut: 1, share: 10 },
  },
];

// Free calculators for the Lab. compute(v) returns lines: [label, worked formula, result].
const f = (x, d = 4) => x == null || !isFinite(x) ? '–' : Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : +x.toPrecision(d) + '';
const p = x => isFinite(x) ? (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%' : '–';

export const LABS = [
  {
    id: 'flip', title: 'Flip', formulas: ['gap', 'net', 'perHour', 'goldPer'],
    fields: [
      ['pA', 'Item price in its A market (A)', 213], ['pBraw', 'Item price in its B market (B)', 0.82], ['conv', 'A per 1 B', 358],
      ['feeX', 'Gold fee: item', 250], ['feeA', 'Gold fee: A', 15], ['feeB', 'Gold fee: B', 250],
      ['margin', 'Safety margin %', 3], ['goldValue', 'Value of 100k gold (A)', 0], ['thin', 'Items/h, thinner market', 150],
    ],
    compute(v) {
      const pB = v.pBraw * v.conv, hi = Math.max(v.pA, pB), lo = Math.min(v.pA, pB), buyA = pB > v.pA;
      const gap = hi / lo - 1, h = v.margin / 100;
      const gold = buyA ? v.feeX + v.feeB * v.pBraw + v.feeA * pB : v.feeB * v.pBraw + v.feeX + v.feeA * v.pA;
      const net = hi * (1 - h) ** 3 - lo - gold * v.goldValue / 1e5;
      return [
        ['Value via B', `${f(v.pBraw)} × ${f(v.conv)}`, `${f(pB)} A`],
        ['Direction', buyA ? 'via B is dearer' : 'A market is dearer', buyA ? 'buy with A, sell for B' : 'buy with B, sell for A'],
        ['Gap', `${f(hi)} ÷ ${f(lo)} − 1`, p(gap)],
        ['Gold per item', buyA ? `${f(v.feeX)} + ${f(v.feeB)} × ${f(v.pBraw)} + ${f(v.feeA)} × ${f(pB)}` : `${f(v.feeB)} × ${f(v.pBraw)} + ${f(v.feeX)} + ${f(v.feeA)} × ${f(v.pA)}`, f(gold)],
        ['Net per item', `${f(hi)} × (1 − ${h})³ − ${f(lo)} − ${f(gold)} × ${f(v.goldValue)} ÷ 100,000`, `${f(net)} A`],
        ['Profit per hour', `max(0, ${f(net)}) × ${f(v.thin)}`, `${f(Math.max(0, net) * v.thin)} A`],
        ['Gold per A of profit', `${f(gold)} ÷ ${f(hi - lo)}`, f(gold / (hi - lo))],
      ];
    },
  },
  {
    id: 'route', title: 'Route (up to 4 steps)', formulas: ['routeReturn', 'routeSize'],
    fields: [
      ['r1', 'Step 1 rate (out per in)', 9.03], ['t1', 'Step 1 traded/h (in)', 4036], ['b1', 'Step 1 buyers waiting (out)', 45056],
      ['r2', 'Step 2 rate', 0.00052], ['t2', 'Step 2 traded/h', 26940], ['b2', 'Step 2 buyers waiting', 124],
      ['r3', 'Step 3 rate', 53.6], ['t3', 'Step 3 traded/h', 8], ['b3', 'Step 3 buyers waiting', 3439],
      ['r4', 'Step 4 rate (0 = no step)', 14], ['t4', 'Step 4 traded/h', 254], ['b4', 'Step 4 buyers waiting', 10805],
      ['share', 'Your share %', 25], ['margin', 'Safety margin %', 3], ['start', 'Start amount (whole units)', 276],
    ],
    compute(v) {
      const legs = [1, 2, 3, 4].map(i => ({ rate: v['r' + i], traded: v['t' + i], bid: v['b' + i] })).filter(l => l.rate > 0);
      const h = v.margin / 100, s = v.share / 100;
      const lines = [];
      let need = 1, size = Infinity, limit = 0, x = Math.floor(v.start);
      legs.forEach((l, i) => {
        const cap = s * Math.min(l.traded, l.bid / l.rate);
        lines.push([`Step ${i + 1} cap`, `${v.share}% × min(${f(l.traded)}, ${f(l.bid)} ÷ ${f(l.rate)})`, f(cap)]);
        if (cap / need < size) { size = cap / need; limit = i + 1; }
        need *= l.rate * (1 - h);
      });
      const roi = need - 1;
      legs.forEach(l => { x = Math.floor(x * l.rate * (1 - h) + 1e-9); });
      return [
        ...lines,
        ['Return per loop', legs.map(l => `${f(l.rate)}×${1 - h}`).join(' × ') + ' − 1', p(roi)],
        ['Verified size', `min over steps of cap ÷ units needed (step ${limit} limits)`, `${f(size)} start/h`],
        ['Profit per hour', `${f(size)} × ${p(roi)}`, f(size * roi)],
        ['Whole-unit run', `start ${Math.floor(v.start)}, floor at every step`, `${x} back, ${x - Math.floor(v.start) >= 0 ? '+' : ''}${x - Math.floor(v.start)}`],
      ];
    },
  },
  {
    id: 'score', title: 'Score', formulas: ['score'],
    fields: [
      ['perHour', 'Profit per hour', 12000], ['held', 'Hours the gap held', 24], ['both', 'Hours both markets traded', 24],
      ['active', 'Hours active', 24], ['hours', 'Hours in window', 24], ['goldPer', 'Gold per unit of profit', 60],
      ['heldPow', 'p (held weight)', 2], ['activePow', 'q (active weight)', 1], ['goldRef', 'g (gold reference)', 300],
    ],
    compute(v) {
      const held = v.both ? v.held / v.both : 0, active = Math.min(1, v.active / v.hours);
      const parts = [Math.log10(1 + v.perHour), held ** v.heldPow, active ** v.activePow, 1 / (1 + v.goldPer / v.goldRef)];
      return [
        ['Size term', `log10(1 + ${f(v.perHour)})`, f(parts[0])],
        ['Held term', `(${v.held} ÷ ${v.both})^${v.heldPow}`, f(parts[1])],
        ['Active term', `(${v.active} ÷ ${v.hours})^${v.activePow}`, f(parts[2])],
        ['Gold term', `1 ÷ (1 + ${f(v.goldPer)} ÷ ${f(v.goldRef)})`, f(parts[3])],
        ['Raw score', 'product of the four', f(parts.reduce((a, b) => a * b, 1))],
        ['Shown score', 'raw ÷ best raw in the list × 100', 'depends on the list'],
      ];
    },
  },
  {
    id: 'ratio', title: 'Price ↔ in-game ratio', formulas: [],
    fields: [['price', 'Price (what you get per 1 given)', 0.00052], ['maxDen', 'Largest number you\'ll type', 2000]],
    compute(v) {
      // Continued fraction, the same as the page uses.
      let [h0, h1, k0, k1, x] = [0, 1, 1, 0, v.price];
      for (let i = 0; i < 30 && v.price > 0; i++) {
        const a = Math.floor(x); const [h2, k2] = [a * h1 + h0, a * k1 + k0];
        if (k2 > v.maxDen) break;
        [h0, h1, k0, k1] = [h1, h2, k1, k2];
        if (Math.abs(h1 / k1 - v.price) / v.price < 0.005) break;
        x = 1 / (x - a); if (!isFinite(x)) break;
      }
      return [
        ['Ratio', 'best whole-number fraction close to the price', `get ${h1} for ${k1}`],
        ['Error', `${h1} ÷ ${k1} ÷ ${f(v.price)} − 1`, p(h1 / k1 / v.price - 1)],
      ];
    },
  },
];
