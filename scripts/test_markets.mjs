// Tests for the exchange analyses (public/model.js) and the area APIs other tabs price
// through (public/economy.js, public/craftdata.js). Synthetic hours, built from the real
// Covens hour that showed the problems: one Divine sold for 1 Chaos among 86,724, and a
// Breach Thread market that filled anywhere from 1 to 4 threads per Chaos.
//   npm run test:markets
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = name => import(pathToFileURL(path.join(root, 'public', name)).href);
const model = await load('model.js');
const { economyApi } = await load('economy.js');
const { craftPriceInfo, craftOverrides } = await load('craftdata.js');

const CUR = 'Metadata/Items/Currency/';
const CHAOS = model.CHAOS, DIVINE = model.DIVINE;
const THREAD = 'Metadata/Items/Threads/ThreadBreach';
const ALT = CUR + 'CurrencyRerollMagic';
const ITEMS = {
  [CHAOS]: { name: 'Chaos Orb', fee: 0 },
  [DIVINE]: { name: 'Divine Orb', fee: 0 },
  [THREAD]: { name: 'Breach Thread', fee: 0 },
  [ALT]: { name: 'Orb of Alteration', fee: 0 },
};

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log('ok   ' + label);
  } else {
    failures++;
    console.log('FAIL ' + label + (detail ? ': ' + detail : ''));
  }
}
const near = (value, expected, tolerance) => value != null && Math.abs(value / expected - 1) <= tolerance;

// One market of a digest, as GGG publishes it: ratios are [A amount, B amount] pairs.
function market(a, b, volumeA, volumeB, lowest, highest, stockA, stockB) {
  return {
    league: 'Covens', market_id: a + '|' + b, market_pair: [a, b],
    volume_traded: { [a]: volumeA, [b]: volumeB },
    lowest_ratio: { [a]: lowest[0], [b]: lowest[1] }, highest_ratio: { [a]: highest[0], [b]: highest[1] },
    lowest_stock: { [a]: stockA, [b]: stockB }, highest_stock: { [a]: stockA * 2, [b]: stockB * 2 },
  };
}

function covensHour() {
  return [
    // 174.5 Chaos a Divine, but one trade at 1:1 and the top at 180:1.
    market(CHAOS, DIVINE, 15133913, 86724, [1, 1], [180, 1], 436967, 2822),
    // 0.46 Chaos a thread on average, filled from 1:1 to 4 threads a Chaos.
    market(THREAD, CHAOS, 44604, 20422, [1, 1], [4, 1], 35465, 2526),
    // 185 threads a Divine, filled from 150 to 345.
    market(THREAD, DIVINE, 6651, 36, [150, 1], [345, 1], 2538, 18),
    // A narrow market: 5.6 alts a Chaos, between 5 and 6.5.
    market(CHAOS, ALT, 130499, 735145, [2, 13], [1, 5], 24130, 90491),
    market(DIVINE, ALT, 1067, 704334, [1, 870], [1, 600], 305, 67855),
  ];
}

const pages = [{ t: 0, markets: model.compact(covensHour()) }];
const M = model.buildModel(pages, 'Covens', ITEMS, {});

// ---------- mistaken trades ----------
const divineInChaos = model.rate(M, DIVINE, CHAOS);
check('a 1:1 Divine trade is not the low: mirrored from the 180 high', near(divineInChaos.lo, 174.5 ** 2 / 180, 0.01), String(divineInChaos.lo));
check('the raw low is kept for reference', near(divineInChaos.series[0].rawLo, 1, 0.001), String(divineInChaos.series[0].rawLo));
const divineQuote = model.quote(M, DIVINE, CHAOS);
check('Divine in Chaos is a narrow market', divineQuote && !divineQuote.wide, JSON.stringify(divineQuote));
check('Divine sells at its average', divineQuote && near(divineQuote.sell, 174.5, 0.01), String(divineQuote?.sell));

// ---------- wide markets ----------
const threadQuote = model.quote(M, CHAOS, THREAD);
check('Chaos to Breach Thread (1 to 4 a Chaos) is wide', threadQuote && threadQuote.wide, JSON.stringify(threadQuote));
check('a wide market sells at its low, not its average', threadQuote && threadQuote.sell < threadQuote.average, JSON.stringify(threadQuote));
check('a wide market buys at its high', threadQuote && threadQuote.buy > threadQuote.average, JSON.stringify(threadQuote));

// ---------- spreads ----------
const spreadRows = model.spreads(M, CHAOS);
const divineSpread = spreadRows.find(r => r.x === DIVINE && r.y === CHAOS);
check('Divine in Chaos margin is a few percent, not 17,900%', divineSpread && divineSpread.med < 0.1, String(divineSpread?.med));

// ---------- flips ----------
const flipRows = model.flips(M, CHAOS, DIVINE);
const threadFlip = flipRows.find(r => r.x === THREAD);
check('the Breach Thread flip loses once its wide markets count at their bad end', threadFlip && threadFlip.roi < 0, String(threadFlip?.roi));
const altFlip = flipRows.find(r => r.x === ALT);
check('the Alteration flip (narrow markets) still shows its gap', altFlip && altFlip.roi > 0.3, String(altFlip?.roi));

// ---------- routes ----------
const found = model.routes(M, CHAOS, { maxLegs: 3 });
const viaThread = found.find(r => r.legs.some(l => l.to === THREAD));
check('no profitable route through Breach Thread', !viaThread, viaThread ? String(viaThread.roi) : '');
const viaAlt = found.find(r => r.legs.some(l => l.to === ALT));
check('the Alteration route is found', !!viaAlt);
check('its worst case is read, not -100%', viaAlt && viaAlt.worstRoi != null && viaAlt.worstRoi > -0.2, String(viaAlt?.worstRoi));

// ---------- the Economy API ----------
const economy = economyApi({ model: () => M, unit: CHAOS, items: () => ITEMS });
check('price by name', near(economy.price('Orb of Alteration'), 1 / 5.633, 0.01), String(economy.price('Orb of Alteration')));
check('the unit is 1', economy.price('Chaos Orb') === 1);
check('divine() is the Divine Orb price', near(economy.divine(), 174.5, 0.01), String(economy.divine()));
check('an unknown name has no price', economy.price('Mirror of Kalandra') === null);
check('nothing loaded, nothing priced', economyApi({ model: () => null, unit: CHAOS, items: () => ITEMS }).price('Divine Orb') === null);

// ---------- the Crafting API's prices ----------
function memoryStore(initial) {
  const values = { ...initial };
  return { get: (key, fallback) => (key in values ? values[key] : fallback), set: (key, value) => { values[key] = value; } };
}
const store = memoryStore({ craftPrices: { 'Orb of Alteration': 0.5, 'Orb of Scouring': 'off' } });
const context = { store, ruthless: false, economy, realm: '' };
check('your own price comes first', craftPriceInfo('Orb of Alteration', context).src === 'yours');
check('"off" leaves a currency out', craftPriceInfo('Orb of Scouring', context).src === 'not used');
check('the exchange comes next', craftPriceInfo('Divine Orb', context).src === 'exchange');
check('the overrides object is shared and live', craftOverrides(store, false) === craftOverrides(store, false));
check('PoE 2 never prices from this exchange', craftPriceInfo('Divine Orb', { ...context, realm: 'poe2' }).src !== 'exchange');

if (failures > 0) {
  console.log(`\n${failures} failed.`);
  process.exit(1);
}
console.log('\nAll passed.');
