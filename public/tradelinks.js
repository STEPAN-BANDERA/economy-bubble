// Links to GGG's trade site for items the Currency Exchange doesn't trade (uniques, Valdo's maps, beasts,
// Wombgifts). The link carries the search itself, as the trade site's own "?q=" address does, so opening
// it runs the search there: nothing is fetched from GGG or poe.ninja to build it.
//
// The queries follow what poe.ninja's "go to trade" button sends for the same kind of item (read from its
// page code on 2026-11-16): a unique by name, with the "uniquefoil" rarity for a foil copy and the
// Foulborn filter for a Foulborn one; a beast or a Wombgift by type; a Valdo's map by its name as a
// search term, limited to maps. Status "securable" is the trade site's default: instant buyout or in person.

const TRADE_SEARCH = 'https://www.pathofexile.com/trade/search/';
const FOULBORN_PREFIX = 'Foulborn ';

// Only PoE 1 on PC's public leagues: the console realms and PoE 2 have trade sites at other addresses,
// and how the trade site names a private league ("Name (PL12345)" on the exchange) isn't checked.
// The realm is the page's Realm menu value, where PoE 1 PC is the empty string.
export function tradeLinksAvailable(realm, league) {
  if (realm === 'xbox' || realm === 'sony' || realm === 'poe2') {
    return false;
  }
  if (!league || /\(PL\d+\)\s*$/.test(league)) {
    return false;
  }
  return true;
}

export function tradeSearchUrl(league, query) {
  return TRADE_SEARCH + encodeURIComponent(league) + '?q=' + encodeURIComponent(JSON.stringify(query));
}

function baseQuery() {
  return { query: { status: { option: 'securable' }, filters: {} } };
}

// A unique by name. A Foulborn copy is searched as its plain name plus the Foulborn filter, since the
// trade site names the item without the word; every other search asks for non-Foulborn copies.
export function uniqueTradeQuery(uniqueName, { foil = false } = {}) {
  const search = baseQuery();
  let name = uniqueName;
  let foulborn = false;
  if (name.startsWith(FOULBORN_PREFIX)) {
    name = name.slice(FOULBORN_PREFIX.length);
    foulborn = true;
  }
  search.query.name = name;
  search.query.filters.type_filters = { filters: {} };
  if (foil) {
    search.query.filters.type_filters.filters.rarity = { option: 'uniquefoil' };
  }
  search.query.filters.misc_filters = { filters: { foulborn_item: { option: foulborn ? 'true' : 'false' } } };
  return search;
}

// Items the trade site knows by their base type: beasts (as monsters) and Wombgifts.
export function typeTradeQuery(typeName) {
  const search = baseQuery();
  search.query.type = typeName;
  return search;
}

// A free-text search limited to one category: how poe.ninja finds a Valdo's map, whose name the
// trade site matches as text.
export function termTradeQuery(term, category) {
  const search = baseQuery();
  search.query.term = term;
  search.query.filters.type_filters = { filters: { category: { option: category } } };
  return search;
}

// The query for a Farming card line priced on poe.ninja, by its poe.ninja type. Null where one search
// can't stand for the line: "Corpse items" is every corpse monster at once.
export function tradeQueryForNinjaType(ninjaType, itemName) {
  if (ninjaType === 'Beast' || ninjaType === 'Wombgift') {
    return typeTradeQuery(itemName);
  }
  if (ninjaType === 'Map') {
    return termTradeQuery(itemName, 'map');
  }
  if (ninjaType === 'Corpse') {
    return null;
  }
  // The unique types, Forbidden jewels and unique maps: all searched by name.
  return uniqueTradeQuery(itemName);
}

// The small "trade" link shown beside an item. el is the page's element helper.
export function tradeLink(el, league, query, itemLabel) {
  if (!query) {
    return null;
  }
  return el('a', {
    class: 'trade-link',
    href: tradeSearchUrl(league, query),
    target: '_blank',
    rel: 'noopener noreferrer',
    title: 'Search ' + itemLabel + ' on the official trade site (' + league + ')',
    'aria-label': 'Search ' + itemLabel + ' on the trade site',
    // Inside a <summary> or a clickable row a click would otherwise also open, close or select it.
    onclick: event => event.stopPropagation(),
  }, 'trade');
}
