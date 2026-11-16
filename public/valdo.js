// Valdo's maps tab: every Valdo's map poe.ninja lists, its asking price, the unique it rewards and that
// unique's price, so a player can see which maps are worth buying to run and which are worth more sold.
//
// poe.ninja lists each Valdo's map under its own name (type ValdoMap), with the reward as the line's
// variant: "Foil Mageblood". The reward's price comes from poe.ninja's unique lists. Everything goes
// through the site's /api/ninja proxy, which caches each list for half an hour and falls back to a
// day-old copy when poe.ninja is slow or rate-limiting.

import { allModCategories, modCategoryOf } from './valdomods.js';

let X; // helpers from app.js: el, fmt, store, rerender, realm, league, exchangePrice, table

const VALDO_TYPE = 'ValdoMap';
// Where a reward's price can be. Unique maps are in the list because some Valdo's maps reward one
// (Whakawairua Tuahu).
const REWARD_TYPES = ['UniqueAccessory', 'UniqueJewel', 'UniqueArmour', 'UniqueWeapon', 'UniqueFlask', 'UniqueMap'];
// The reward is named after this word in the map's variant.
const FOIL_PREFIX = 'Foil ';
// A failed request is tried once more after this pause. The proxy answers from its stale copy when
// it has one, so a second failure means poe.ninja has been unreachable for a while: stop there.
const RETRY_PAUSE_MILLISECONDS = 4000;
// The same rule the Farming tab uses: links never make a unique worth less, so an unlinked copy
// listed over 10 times its cheapest linked copy is a few absurd listings, and that linked copy
// stands for the item instead.
const PLAIN_PRICE_SUSPECT_RATIO = 10;
// "Players who Die in area are sent to the Void": one death and the map and its reward are gone.
// Until a viewer sets their own modifier rules, every modifier with these words starts out
// excluded (matched loosely, so a reworded copy of the mod is caught too).
const VOID_MOD_WORDS = 'sent to the void';
// A modifier rule: a map must have a required modifier, and must not have an excluded one.
const REQUIRE = 'require';
const EXCLUDE = 'exclude';
// A price backed by this many listings or fewer is one or two sellers' asking prices, so it gets a
// "thin" badge: it may not be what the item actually sells for.
const THIN_LISTINGS = 2;
// A reward whose dearest variant is this many times its cheapest gets a "varies" badge: the drop's
// roll decides most of its worth, and the busiest variant's price is only the usual case.
const VARIES_RATIO = 5;
// Foil premium: poe.ninja merges foil and plain copies of a unique, so the reward is priced as the
// plain one. A viewer who knows foils sell for more can scale the reward by their own factor.
const DEFAULT_FOIL_PREMIUM = 1;
const MAX_FOIL_PREMIUM = 10;
// poe.ninja's page for each list, for the links beside every map and reward.
const NINJA_PAGE = 'https://poe.ninja/poe1/economy/';
const NINJA_PAGE_CATEGORY = {
  ValdoMap: 'valdo-maps',
  UniqueAccessory: 'unique-accessories',
  UniqueJewel: 'unique-jewels',
  UniqueArmour: 'unique-armours',
  UniqueWeapon: 'unique-weapons',
  UniqueFlask: 'unique-flasks',
  UniqueMap: 'unique-maps',
};
const MOD_SORTS = [
  { id: 'count', label: 'Most maps', title: 'Modifiers on the most maps first' },
  { id: 'name', label: 'A–Z', title: 'Alphabetical' },
];
const VIEWS = [
  { id: 'maps', label: 'Every map', title: 'One row per Valdo\'s map' },
  { id: 'rewards', label: 'Cheapest map per reward', title: 'One row per reward, priced with the cheapest map that gives it' },
];

const S = {
  league: null,
  status: 'idle', // idle → loading → ready | failed
  error: null,
  maps: [], // poe.ninja's Valdo's map lines
  rewardPrices: new Map(), // reward name → { chaos, listings, low, high, variantCount, icon }
  rewardTypesLoaded: 0,
  rewardTypesFailed: 0,
  anyStale: false,
  // The modifier list's open state and its own search. Kept here rather than in storage: they only
  // need to survive the redraw that follows a click on Require or Exclude.
  modListOpen: false,
  modListSearch: '',
  modListCategory: null, // a category id: the list shows only that category's modifiers
};

// ---------- loading ----------
// poe.ninja only covers GGG's public PC leagues.
function ninjaCoversLeague() {
  const realm = X.realm();
  if (realm === 'xbox' || realm === 'sony' || realm === 'poe2') {
    return false;
  }
  const league = X.league();
  if (!league || /\(PL\d+\)\s*$/.test(league)) {
    return false;
  }
  return true;
}

function ensureLoaded() {
  const league = X.league();
  if (S.league === league) {
    return;
  }
  S.league = league;
  S.status = 'loading';
  S.error = null;
  S.maps = [];
  S.rewardPrices = new Map();
  S.rewardTypesLoaded = 0;
  S.rewardTypesFailed = 0;
  S.anyStale = false;
  loadEverything(league);
}

// The map list first, so the table can draw; then the unique lists one at a time rather than all
// at once. On a cold cache each of these is a request to poe.ninja, and seven together is the kind
// of burst that earns an HTTP 429 or times out.
async function loadEverything(league) {
  const valdo = await fetchNinjaTypeWithRetry(league, VALDO_TYPE);
  if (S.league !== league) {
    return; // the viewer changed league while this was loading
  }
  if (!valdo) {
    S.status = 'failed';
    S.error = 'poe.ninja\'s Valdo\'s map list didn\'t load.';
    X.rerender();
    return;
  }
  S.maps = valdo.lines;
  if (valdo.stale) {
    S.anyStale = true;
  }
  S.status = 'ready';
  X.rerender();

  const linesByReward = new Map();
  for (const itemType of REWARD_TYPES) {
    const loaded = await fetchNinjaTypeWithRetry(league, itemType);
    if (S.league !== league) {
      return;
    }
    if (loaded) {
      collectLinesByName(linesByReward, loaded.lines, rewardNamesWanted(), itemType);
      if (loaded.stale) {
        S.anyStale = true;
      }
      S.rewardTypesLoaded += 1;
    } else {
      S.rewardTypesFailed += 1;
    }
    S.rewardPrices = rewardPricesFrom(linesByReward);
    X.rerender();
  }
}

async function fetchNinjaTypeWithRetry(league, itemType) {
  const first = await fetchNinjaType(league, itemType);
  if (first.result || !first.worthRetrying) {
    return first.result;
  }
  await pause(RETRY_PAUSE_MILLISECONDS);
  const second = await fetchNinjaType(league, itemType);
  return second.result;
}

async function fetchNinjaType(league, itemType) {
  try {
    const response = await fetch('/api/ninja/' + encodeURIComponent(league) + '/' + itemType);
    if (!response.ok) {
      // 400 is an unknown league or type, which asking again won't change.
      return { result: null, worthRetrying: response.status !== 400 };
    }
    const body = await response.json();
    const stale = response.headers.get('X-Ninja-Stale') === '1';
    return { result: { lines: body.lines || [], stale }, worthRetrying: false };
  } catch {
    return { result: null, worthRetrying: true };
  }
}

function pause(milliseconds) {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

// ---------- pricing ----------
function rewardNameOf(mapLine) {
  const variant = mapLine.variant || '';
  if (variant.startsWith(FOIL_PREFIX)) {
    return variant.slice(FOIL_PREFIX.length);
  }
  return variant;
}

function rewardNamesWanted() {
  const names = new Set();
  for (const mapLine of S.maps) {
    names.add(rewardNameOf(mapLine));
  }
  return names;
}

// Each kept line remembers which poe.ninja list it came from, for the link to its page.
function collectLinesByName(linesByName, lines, wantedNames, itemType) {
  for (const line of lines) {
    if (!wantedNames.has(line.name)) {
      continue;
    }
    if (line.chaos == null || !(line.chaos > 0)) {
      continue;
    }
    if (!linesByName.has(line.name)) {
      linesByName.set(line.name, []);
    }
    linesByName.get(line.name).push({ ...line, itemType });
  }
}

function isLinked(line) {
  return line.links != null && line.links > 0;
}

// The reward drops with random links and a random variant (Mageblood's flask count, Voices' passive
// count, Precursor's Emblem's ring), so it is priced as the unlinked line with the most listings: the
// copy a drop most often is. The low and high across the unlinked lines show how far a lucky or
// unlucky roll moves it.
function rewardPriceFrom(lines) {
  const unlinked = [];
  const linked = [];
  for (const line of lines) {
    if (isLinked(line)) {
      linked.push(line);
    } else {
      unlinked.push(line);
    }
  }
  if (unlinked.length === 0) {
    return priceFromLine(cheapestLine(linked), linked);
  }
  const busiest = busiestLine(unlinked);
  if (linked.length > 0) {
    const cheapestLinked = cheapestLine(linked);
    if (busiest.chaos > PLAIN_PRICE_SUSPECT_RATIO * cheapestLinked.chaos) {
      return priceFromLine(cheapestLinked, [cheapestLinked]);
    }
  }
  return priceFromLine(busiest, unlinked);
}

function priceFromLine(chosenLine, variantLines) {
  let low = chosenLine.chaos;
  let high = chosenLine.chaos;
  for (const line of variantLines) {
    if (line.chaos < low) {
      low = line.chaos;
    }
    if (line.chaos > high) {
      high = line.chaos;
    }
  }
  return {
    chaos: chosenLine.chaos,
    listings: chosenLine.listings ?? 0,
    low,
    high,
    variantCount: variantLines.length,
    icon: chosenLine.icon,
    detailsId: chosenLine.detailsId ?? null,
    itemType: chosenLine.itemType,
  };
}

function busiestLine(lines) {
  let busiest = lines[0];
  for (const line of lines) {
    if ((line.listings ?? 0) > (busiest.listings ?? 0)) {
      busiest = line;
    }
  }
  return busiest;
}

function cheapestLine(lines) {
  let cheapest = lines[0];
  for (const line of lines) {
    if (line.chaos < cheapest.chaos) {
      cheapest = line;
    }
  }
  return cheapest;
}

function rewardPricesFrom(linesByReward) {
  const prices = new Map();
  for (const [rewardName, lines] of linesByReward) {
    prices.set(rewardName, rewardPriceFrom(lines));
  }
  return prices;
}

// The reward's worth after the viewer's foil premium; null when poe.ninja has no price for it.
function rewardValue(reward, foilPremium) {
  if (!reward) {
    return null;
  }
  return reward.chaos * foilPremium;
}

function mapRows(settings) {
  const rows = [];
  for (const mapLine of S.maps) {
    const rewardName = rewardNameOf(mapLine);
    const reward = S.rewardPrices.get(rewardName) || null;
    const mapChaos = mapLine.chaos > 0 ? mapLine.chaos : null;
    const rewardChaos = rewardValue(reward, settings.foilPremium);
    let gain = null;
    if (rewardChaos != null && mapChaos != null) {
      gain = rewardChaos - mapChaos;
    }
    const mods = mapLine.mods || [];
    rows.push({
      mapName: mapLine.name,
      mapIcon: mapLine.icon,
      mapDetailsId: mapLine.detailsId ?? null,
      mapChaos,
      mapListings: mapLine.listings ?? 0,
      mods,
      modCount: mods.length,
      rewardName,
      reward,
      rewardChaos,
      gain,
      otherMapCount: 0,
    });
  }
  return rows;
}

// One row per reward: the cheapest map that gives it, and how many other maps give it too.
function cheapestMapPerReward(rows) {
  const rowsByReward = new Map();
  for (const row of rows) {
    if (!rowsByReward.has(row.rewardName)) {
      rowsByReward.set(row.rewardName, []);
    }
    rowsByReward.get(row.rewardName).push(row);
  }
  const cheapestRows = [];
  for (const rewardRows of rowsByReward.values()) {
    let cheapest = rewardRows[0];
    for (const row of rewardRows) {
      if (cheapest.mapChaos == null || (row.mapChaos != null && row.mapChaos < cheapest.mapChaos)) {
        cheapest = row;
      }
    }
    cheapestRows.push({ ...cheapest, otherMapCount: rewardRows.length - 1 });
  }
  return cheapestRows;
}

// ---------- filters ----------
function filterSettings() {
  return {
    view: X.store.get('valdoView', 'maps'),
    search: X.store.get('valdoSearch', ''),
    minimumListings: X.store.get('valdoMinListings', 1),
    onlyGains: X.store.get('valdoOnlyGains', false),
    modRules: modRules(),
    modSort: X.store.get('valdoModSort', 'count'),
    minimumRewardChaos: X.store.get('valdoMinRewardChaos', 0),
    foilPremium: X.store.get('valdoFoilPremium', DEFAULT_FOIL_PREMIUM),
  };
}

// ---------- modifier rules ----------
// { modifier text: REQUIRE or EXCLUDE }. Until the viewer changes one, the Void modifier is excluded.
function modRules() {
  const saved = X.store.get('valdoModRules', null);
  if (saved && typeof saved === 'object') {
    return saved;
  }
  const defaults = {};
  for (const mod of allMods()) {
    if (mod.toLowerCase().includes(VOID_MOD_WORDS)) {
      defaults[mod] = EXCLUDE;
    }
  }
  return defaults;
}

// Clicking the rule a modifier already has clears it; clicking the other one switches to it.
function toggleModRule(mod, rule) {
  const rules = { ...modRules() };
  if (rules[mod] === rule) {
    delete rules[mod];
  } else {
    rules[mod] = rule;
  }
  setFilter('valdoModRules', rules);
}

function clearModRules() {
  setFilter('valdoModRules', {});
}

function modsInCategory(categoryId) {
  const mods = [];
  for (const mod of allMods()) {
    if (modCategoryOf(mod).id === categoryId) {
      mods.push(mod);
    }
  }
  return mods;
}

function categoryFullyExcluded(categoryId, rules) {
  const mods = modsInCategory(categoryId);
  if (mods.length === 0) {
    return false;
  }
  for (const mod of mods) {
    if (rules[mod] !== EXCLUDE) {
      return false;
    }
  }
  return true;
}

// Excludes every modifier of the category; when all of them already are, allows them all again.
function toggleCategoryExcluded(categoryId) {
  const rules = { ...modRules() };
  const allExcluded = categoryFullyExcluded(categoryId, rules);
  for (const mod of modsInCategory(categoryId)) {
    if (allExcluded) {
      delete rules[mod];
    } else {
      rules[mod] = EXCLUDE;
    }
  }
  setFilter('valdoModRules', rules);
}

function allMods() {
  const mods = new Set();
  for (const mapLine of S.maps) {
    for (const mod of mapLine.mods || []) {
      mods.add(mod);
    }
  }
  return mods;
}

function rowPassesModRules(row, rules) {
  const modsOnMap = new Set(row.mods);
  for (const [mod, rule] of Object.entries(rules)) {
    if (rule === REQUIRE && !modsOnMap.has(mod)) {
      return false;
    }
    if (rule === EXCLUDE && modsOnMap.has(mod)) {
      return false;
    }
  }
  return true;
}

function countRules(rules, wantedRule) {
  let count = 0;
  for (const rule of Object.values(rules)) {
    if (rule === wantedRule) {
      count += 1;
    }
  }
  return count;
}

function setFilter(key, value) {
  X.store.set(key, value);
  X.rerender();
}

function rowMatchesSearch(row, search) {
  const wanted = search.trim().toLowerCase();
  if (!wanted) {
    return true;
  }
  if (row.mapName.toLowerCase().includes(wanted) || row.rewardName.toLowerCase().includes(wanted)) {
    return true;
  }
  for (const mod of row.mods) {
    if (mod.toLowerCase().includes(wanted)) {
      return true;
    }
  }
  return false;
}

// The maps that pass the search and listings filters, before the modifier rules: the modifier
// list counts these, so its numbers say what a rule would remove from what is on screen.
function rowsBeforeModRules(settings) {
  const kept = [];
  for (const row of mapRows(settings)) {
    if (row.mapListings < settings.minimumListings) {
      continue;
    }
    // A minimum reward price also hides rewards with no price, which can't be shown to clear it.
    if (settings.minimumRewardChaos > 0 && (row.rewardChaos == null || row.rewardChaos < settings.minimumRewardChaos)) {
      continue;
    }
    if (!rowMatchesSearch(row, settings.search)) {
      continue;
    }
    kept.push(row);
  }
  return kept;
}

function filteredRows(settings, candidateRows) {
  let rows = [];
  for (const row of candidateRows) {
    // Before the cheapest-map-per-reward step, so that view never picks an excluded map either.
    if (rowPassesModRules(row, settings.modRules)) {
      rows.push(row);
    }
  }
  if (settings.view === 'rewards') {
    rows = cheapestMapPerReward(rows);
  }
  if (settings.onlyGains) {
    const gaining = [];
    for (const row of rows) {
      if (row.gain != null && row.gain > 0) {
        gaining.push(row);
      }
    }
    rows = gaining;
  }
  return rows;
}

// ---------- formatting ----------
function divineChaos() {
  const price = X.exchangePrice?.('Divine Orb');
  if (price == null || !isFinite(price) || price <= 0) {
    return null;
  }
  return price;
}

// "12.3 div" for big amounts, "840 c" for small ones, like the Farming tab.
function money(chaos) {
  if (chaos == null || !isFinite(chaos)) {
    return '–';
  }
  const divine = divineChaos();
  if (divine && Math.abs(chaos) >= divine * 0.5) {
    return X.fmt(chaos / divine) + ' div';
  }
  return X.fmt(chaos) + ' c';
}

function itemIcon(iconUrl, label) {
  if (!iconUrl) {
    return null;
  }
  // Height only: a belt or a two-handed weapon icon is wider or taller than a ring, and a fixed
  // square would squash it. The stylesheet keeps the width in bounds.
  return X.el('img', { class: 'valdo-icon', src: iconUrl, alt: '', title: label, loading: 'lazy', referrerpolicy: 'no-referrer' });
}

// poe.ninja's league part of a page address: "Covens" → "covens", "Hardcore Covens" → "covenshc",
// "Standard" and "Hardcore" as they are. Checked against poe.ninja's index-state on 2026-11-16.
function ninjaLeagueSlug(league) {
  const hardcorePrefix = 'Hardcore ';
  if (league.startsWith(hardcorePrefix)) {
    return league.slice(hardcorePrefix.length).toLowerCase().replace(/\s+/g, '') + 'hc';
  }
  return league.toLowerCase().replace(/\s+/g, '');
}

function ninjaLink(itemType, detailsId, label) {
  const category = NINJA_PAGE_CATEGORY[itemType];
  if (!category || !detailsId || !S.league) {
    return null;
  }
  const url = NINJA_PAGE + ninjaLeagueSlug(S.league) + '/' + category + '/' + encodeURIComponent(detailsId);
  return X.el('a', {
    class: 'valdo-ninja',
    href: url,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: label + ' on poe.ninja (price history)',
    'aria-label': label + ' on poe.ninja',
    // Inside a map's summary a click would otherwise also open or close its modifier list.
    onclick: event => event.stopPropagation(),
  }, '↗');
}

function thinBadge(listings) {
  if (listings > THIN_LISTINGS) {
    return null;
  }
  return X.el('span', { class: 'badge warn', title: 'Only ' + listingsNote(listings) + ': one or two sellers\' asking prices, which may not be what it sells for' }, 'thin');
}

function variesBadge(reward) {
  if (!reward || reward.variantCount < 2 || !(reward.low > 0) || reward.high / reward.low < VARIES_RATIO) {
    return null;
  }
  return X.el('span', { class: 'badge warn', title: 'Its variants run from ' + money(reward.low) + ' to ' + money(reward.high) + ' (plain copies, before any foil premium): the drop\'s roll decides most of its worth' }, 'varies');
}

function listingsNote(listings) {
  if (listings === 1) {
    return '1 listing';
  }
  return listings + ' listings';
}

function mapCell(row) {
  const rules = modRules();
  const modList = X.el('ul', { class: 'valdo-mods' });
  for (const mod of row.mods) {
    modList.append(X.el('li', { class: 'valdo-modrow' }, modRuleButtons(mod, rules[mod]), X.el('span', { class: 'valdo-modtext' }, mod)));
  }
  const name = X.el('span', { class: 'item' }, itemIcon(row.mapIcon, row.mapName), row.mapName, ninjaLink('ValdoMap', row.mapDetailsId, row.mapName));
  if (row.mods.length === 0) {
    return name;
  }
  return X.el('details', { class: 'valdo-map' }, X.el('summary', {}, name), modList);
}

function mapPriceCell(row) {
  return X.el('span', { title: listingsNote(row.mapListings) }, money(row.mapChaos),
    X.el('span', { class: 'muted small' }, ' (' + row.mapListings + ')'), thinBadge(row.mapListings));
}

function rewardCell(row) {
  const kids = [itemIcon(row.reward?.icon, row.rewardName), row.rewardName];
  if (row.reward) {
    kids.push(ninjaLink(row.reward.itemType, row.reward.detailsId, row.rewardName));
  }
  if (row.otherMapCount > 0) {
    kids.push(X.el('span', { class: 'muted small' }, ' +' + row.otherMapCount + ' more ' + (row.otherMapCount === 1 ? 'map' : 'maps')));
  }
  return X.el('span', { class: 'item' }, kids);
}

function rewardPriceCell(row) {
  if (!row.reward) {
    if (rewardsStillLoading()) {
      return X.el('span', { class: 'muted' }, '…');
    }
    return X.el('span', { class: 'muted', title: 'poe.ninja has no price line for this unique' }, 'not listed');
  }
  const reward = row.reward;
  const premium = filterSettings().foilPremium;
  const kids = [money(row.rewardChaos), X.el('span', { class: 'muted small' }, ' (' + reward.listings + ')'), thinBadge(reward.listings), variesBadge(reward)];
  let title = listingsNote(reward.listings);
  if (premium !== 1) {
    title += '; plain copy ' + money(reward.chaos) + ' × your foil premium of ' + premium;
  }
  if (reward.variantCount > 1 && reward.high > reward.low) {
    kids.push(X.el('div', { class: 'muted small' }, money(reward.low * premium) + ' – ' + money(reward.high * premium)));
    title += '; ' + reward.variantCount + ' variants on poe.ninja, priced as the one with the most listings';
  }
  return X.el('span', { title }, kids);
}

function gainCell(row) {
  if (row.gain == null) {
    return X.el('span', { class: 'muted' }, '–');
  }
  const sign = row.gain > 0 ? '+' : '';
  return X.el('span', { class: row.gain > 0 ? 'up' : 'down' }, sign + money(row.gain));
}

function rewardsStillLoading() {
  return S.rewardTypesLoaded + S.rewardTypesFailed < REWARD_TYPES.length;
}

// ---------- drawing ----------
function modRuleButtons(mod, currentRule) {
  const requireOn = currentRule === REQUIRE;
  const excludeOn = currentRule === EXCLUDE;
  return X.el('span', { class: 'valdo-rulebuttons' },
    X.el('button', {
      class: 'valdo-rule require' + (requireOn ? ' on' : ''),
      type: 'button',
      title: requireOn ? 'Required: click to stop requiring it' : 'Show only maps with this modifier',
      'aria-pressed': String(requireOn),
      'aria-label': 'Require: ' + mod,
      onclick: event => {
        event.preventDefault();
        toggleModRule(mod, REQUIRE);
      },
    }, '✓'),
    X.el('button', {
      class: 'valdo-rule exclude' + (excludeOn ? ' on' : ''),
      type: 'button',
      title: excludeOn ? 'Excluded: click to allow it again' : 'Hide maps with this modifier',
      'aria-pressed': String(excludeOn),
      'aria-label': 'Exclude: ' + mod,
      onclick: event => {
        event.preventDefault();
        toggleModRule(mod, EXCLUDE);
      },
    }, '✕'));
}

// How many of the candidate maps carry each modifier.
function modCounts(candidateRows) {
  const counts = new Map();
  for (const mod of allMods()) {
    counts.set(mod, 0);
  }
  for (const row of candidateRows) {
    for (const mod of row.mods) {
      counts.set(mod, (counts.get(mod) ?? 0) + 1);
    }
  }
  return counts;
}

function sortedModEntries(counts, rules, modSort) {
  const entries = [...counts.entries()];
  entries.sort((first, second) => {
    // Modifiers with a rule come first, so what is filtering the table is always in view.
    const firstHasRule = rules[first[0]] ? 1 : 0;
    const secondHasRule = rules[second[0]] ? 1 : 0;
    if (firstHasRule !== secondHasRule) {
      return secondHasRule - firstHasRule;
    }
    if (modSort === 'count' && first[1] !== second[1]) {
      return second[1] - first[1];
    }
    return first[0].localeCompare(second[0]);
  });
  return entries;
}

// The list's own search hides rows in place, without a redraw, so typing keeps its focus.
function applyModListSearch(list, searchText) {
  const wanted = searchText.trim().toLowerCase();
  for (const item of list.children) {
    const text = item.dataset.mod || '';
    const outsideCategory = S.modListCategory !== null && item.dataset.category !== S.modListCategory;
    item.hidden = outsideCategory || (wanted !== '' && !text.includes(wanted));
  }
}

// One chip per category: its name narrows the list to it, and ✕ excludes all of its modifiers.
function categoryChips(rules, counts) {
  const chips = [];
  for (const category of allModCategories()) {
    const mods = modsInCategory(category.id);
    if (mods.length === 0) {
      continue;
    }
    let mapsWithAny = 0;
    for (const mod of mods) {
      mapsWithAny = Math.max(mapsWithAny, counts.get(mod) ?? 0);
    }
    const shown = S.modListCategory === category.id;
    const excluded = categoryFullyExcluded(category.id, rules);
    chips.push(X.el('span', { class: 'valdo-catchip' + (excluded ? ' excluded' : '') },
      X.el('button', {
        class: 'seg' + (shown ? ' on' : ''),
        type: 'button',
        title: category.title + '. Click to list only these ' + mods.length + ' modifiers.',
        'aria-pressed': String(shown),
        onclick: () => {
          S.modListCategory = shown ? null : category.id;
          X.rerender();
        },
      }, category.label + ' (' + mods.length + ')'),
      X.el('button', {
        class: 'valdo-rule exclude' + (excluded ? ' on' : ''),
        type: 'button',
        title: excluded ? 'All excluded: click to allow them again' : 'Exclude every modifier in "' + category.label + '"',
        'aria-pressed': String(excluded),
        'aria-label': 'Exclude category: ' + category.label,
        onclick: () => toggleCategoryExcluded(category.id),
      }, '✕')));
  }
  return X.el('div', { class: 'valdo-catchips' }, chips);
}

function modListPanel(settings, candidateRows) {
  const rules = settings.modRules;
  const counts = modCounts(candidateRows);
  const list = X.el('ul', { class: 'valdo-modlist' });
  for (const [mod, count] of sortedModEntries(counts, rules, settings.modSort)) {
    const category = modCategoryOf(mod);
    const item = X.el('li', { class: 'valdo-modrow' + (rules[mod] ? ' ruled' : '') },
      modRuleButtons(mod, rules[mod]),
      X.el('span', { class: 'valdo-modtext' }, mod),
      X.el('span', { class: 'muted small valdo-modcat' }, category.label),
      X.el('span', { class: 'muted small valdo-modcount', title: 'Maps with this modifier among those the search and listings filters leave' }, String(count)));
    item.dataset.mod = mod.toLowerCase();
    item.dataset.category = category.id;
    list.append(item);
  }
  applyModListSearch(list, S.modListSearch);

  const listSearch = X.el('input', { type: 'text', placeholder: 'Find a modifier', value: S.modListSearch, 'aria-label': 'Find a modifier in the list' });
  listSearch.addEventListener('input', () => {
    S.modListSearch = listSearch.value;
    applyModListSearch(list, S.modListSearch);
  });
  const sortButtons = [];
  for (const sort of MOD_SORTS) {
    const selected = settings.modSort === sort.id;
    sortButtons.push(X.el('button', {
      class: 'seg' + (selected ? ' on' : ''),
      type: 'button',
      title: sort.title,
      'aria-pressed': String(selected),
      onclick: () => setFilter('valdoModSort', sort.id),
    }, sort.label));
  }
  const requiredCount = countRules(rules, REQUIRE);
  const excludedCount = countRules(rules, EXCLUDE);
  let summaryText = 'All modifiers (' + counts.size + ')';
  if (requiredCount + excludedCount > 0) {
    summaryText += ': ' + requiredCount + ' required, ' + excludedCount + ' excluded';
  }
  const details = X.el('details', { class: 'morefilters valdo-modpanel', open: S.modListOpen },
    X.el('summary', {}, summaryText),
    X.el('p', { class: 'muted small' }, '✓ shows only maps with that modifier, ✕ hides maps with it; click again to undo. The number is how many maps on screen have it. A category\'s ✕ excludes all of its modifiers at once; its name lists only them. The categories are our own grouping.'),
    categoryChips(rules, counts),
    X.el('div', { class: 'filters' },
      X.el('label', {}, 'Find', listSearch),
      X.el('div', { class: 'segs small' }, sortButtons),
      X.el('button', { class: 'ghost', type: 'button', disabled: requiredCount + excludedCount === 0, onclick: clearModRules }, 'Clear rules')),
    list);
  details.addEventListener('toggle', () => {
    S.modListOpen = details.open;
  });
  return details;
}

function viewButtons(settings) {
  const buttons = [];
  for (const view of VIEWS) {
    const selected = settings.view === view.id;
    buttons.push(X.el('button', {
      class: 'seg' + (selected ? ' on' : ''),
      type: 'button',
      title: view.title,
      'aria-pressed': String(selected),
      onclick: () => setFilter('valdoView', view.id),
    }, view.label));
  }
  return X.el('div', { class: 'segs' }, buttons);
}

function filterBar(settings, rowCount) {
  const searchInput = X.el('input', { type: 'search', placeholder: 'Map, reward or modifier', value: settings.search, 'aria-label': 'Search Valdo\'s maps' });
  searchInput.addEventListener('input', () => {
    X.store.set('valdoSearch', searchInput.value);
    X.rerender();
  });
  const listingsInput = X.el('input', { type: 'number', min: 1, step: 1, value: settings.minimumListings, title: 'Hide maps with fewer listings than this: one listing is one seller\'s asking price' });
  listingsInput.addEventListener('change', () => {
    const value = Math.max(1, Math.floor(Number(listingsInput.value) || 1));
    setFilter('valdoMinListings', value);
  });
  const minimumRewardInput = X.el('input', { type: 'number', min: 0, step: 'any', value: settings.minimumRewardChaos, title: 'Hide maps whose reward is worth less than this many Chaos (after the foil premium), and rewards with no price' });
  minimumRewardInput.addEventListener('change', () => {
    setFilter('valdoMinRewardChaos', Math.max(0, Number(minimumRewardInput.value) || 0));
  });
  const foilPremiumInput = X.el('input', { type: 'number', min: 1, max: MAX_FOIL_PREMIUM, step: 0.05, value: settings.foilPremium, title: 'Your own estimate: a foil reward is worth this many times the plain unique. poe.ninja doesn\'t price foils apart. 1 leaves prices as they are.' });
  foilPremiumInput.addEventListener('change', () => {
    const value = Number(foilPremiumInput.value);
    const clamped = isFinite(value) ? Math.min(MAX_FOIL_PREMIUM, Math.max(1, value)) : DEFAULT_FOIL_PREMIUM;
    setFilter('valdoFoilPremium', clamped);
  });
  const gainsBox = X.el('input', { type: 'checkbox', checked: settings.onlyGains, onchange: event => setFilter('valdoOnlyGains', event.target.checked) });
  const divine = divineChaos();
  const minimumRewardLabel = divine ? 'Min reward (c, 1 div = ' + X.fmt(divine) + ')' : 'Min reward (c)';
  return X.el('div', { class: 'filters' },
    X.el('label', {}, 'Search', searchInput),
    X.el('label', {}, 'Min map listings', listingsInput),
    X.el('label', {}, minimumRewardLabel, minimumRewardInput),
    X.el('label', {}, 'Foil premium ×', foilPremiumInput),
    X.el('label', { class: 'check' }, gainsBox, 'Only rewards worth more than the map'),
    X.el('span', { class: 'count' }, rowCount + (settings.view === 'rewards' ? ' rewards' : ' maps')));
}

function statusLine() {
  const parts = [];
  if (rewardsStillLoading()) {
    const done = S.rewardTypesLoaded + S.rewardTypesFailed;
    parts.push('Loading reward prices from poe.ninja (' + done + ' of ' + REWARD_TYPES.length + ' lists)…');
  } else if (S.rewardTypesFailed > 0) {
    parts.push(S.rewardTypesFailed + ' of poe.ninja\'s ' + REWARD_TYPES.length + ' unique lists didn\'t load, so some rewards show as not listed. Reload to try again.');
  }
  if (S.anyStale) {
    parts.push('poe.ninja was slow or busy, so some prices are from a copy up to a day old.');
  }
  if (parts.length === 0) {
    return null;
  }
  return X.el('p', { class: 'muted small' }, parts.join(' '));
}

function columns() {
  return [
    { key: 'map', label: 'Valdo\'s map', cls: 'l valdo-mapcol', sort: row => row.mapName, cell: mapCell },
    { key: 'modCount', label: 'Mods', title: 'How many modifiers the map has: more usually means harder', sort: row => row.modCount, cell: row => String(row.modCount) },
    { key: 'mapPrice', label: 'Map price', title: 'poe.ninja\'s asking price for the map, with its number of listings', sort: row => row.mapChaos, cell: mapPriceCell },
    { key: 'reward', label: 'Reward', cls: 'l', sort: row => row.rewardName, cell: rewardCell },
    { key: 'rewardPrice', label: 'Reward price', title: 'poe.ninja\'s price for the unique, with its number of listings; a range when it has variants', sort: row => row.reward?.chaos ?? null, cell: rewardPriceCell },
    { key: 'gain', label: 'Reward − map', title: 'What running the map gains over selling it, before the cost of running it', sort: row => row.gain, cell: gainCell },
  ];
}

function lede() {
  return X.el('p', { class: 'lede' },
    'Every Valdo\'s map on poe.ninja, its asking price and the unique it rewards. A positive ',
    X.el('b', {}, 'Reward − map'),
    ' means buying the map and running it beats its price; a negative one means the map is worth more sold. Click a map for its modifiers, and require or exclude modifiers under "All modifiers" (maps that send the dead to the Void start out excluded).');
}

function caveats() {
  return X.el('details', { class: 'morefilters' },
    X.el('summary', {}, 'How these prices are read'),
    X.el('ul', { class: 'steps muted small' },
      X.el('li', {}, 'Map prices are asking prices, and most maps have a single listing: one seller\'s hope, not a sale. Raise "Min map listings" to see only maps with a market.'),
      X.el('li', {}, 'The reward is priced as the ordinary unique. poe.ninja doesn\'t list foil copies separately, and a foil usually sells for more, so the gain can be higher than shown. "Foil premium" scales every reward by your own estimate; it is yours, not a measured price.'),
      X.el('li', {}, '"thin" marks a price backed by ' + THIN_LISTINGS + ' listings or fewer. "varies" marks a reward whose dearest variant is ' + VARIES_RATIO + ' or more times its cheapest. ↗ opens the item on poe.ninja, with its price history.'),
      X.el('li', {}, 'A unique with variants that are rolled on the drop (Mageblood\'s flasks, Voices\' passives) is priced as the variant with the most listings, with the cheapest and dearest variants beneath it. A unique listed by links is priced as its unlinked copy.'),
      X.el('li', {}, 'Rewards drop unidentified (since 3.30), and the map has to be completed with all its modifiers, so weigh what the map asks of your build.'),
      X.el('li', {}, 'Prices come from poe.ninja, refreshed every half hour.')));
}

export function valdoPanel(helpers) {
  X = helpers;
  if (!ninjaCoversLeague()) {
    return [X.el('p', { class: 'empty' }, 'Valdo\'s maps are priced from poe.ninja, which covers PoE 1\'s public PC leagues only. Pick one in the Realm and League menus.')];
  }
  ensureLoaded();
  if (S.status === 'loading') {
    return [lede(), X.el('p', { class: 'muted' }, 'Loading Valdo\'s maps from poe.ninja…')];
  }
  if (S.status === 'failed') {
    return [lede(), X.el('p', { class: 'status err' }, S.error + ' poe.ninja may be slow or busy; reload in a minute.')];
  }
  if (S.maps.length === 0) {
    return [lede(), X.el('p', { class: 'empty' }, 'poe.ninja lists no Valdo\'s maps in ' + S.league + '.')];
  }
  const settings = filterSettings();
  const candidateRows = rowsBeforeModRules(settings);
  const rows = filteredRows(settings, candidateRows);
  const sortKey = X.store.get('valdoSort', ['gain', 'desc']);
  const parts = [lede(), viewButtons(settings), filterBar(settings, rows.length), modListPanel(settings, candidateRows), caveats()];
  const status = statusLine();
  if (status) {
    parts.push(status);
  }
  // The shared table's own empty message points at a "More filters" section this tab doesn't have.
  if (rows.length === 0) {
    parts.push(X.el('p', { class: 'empty' }, 'No Valdo\'s maps match. Clear the search, lower "Min map listings" or "Min reward", untick "Only rewards worth more than the map", or loosen the rules under "All modifiers".'));
    return parts;
  }
  parts.push(X.table(columns(), rows, sortKey, newSortKey => {
    X.store.set('valdoSort', newSortKey);
    X.rerender();
  }));
  return parts;
}
