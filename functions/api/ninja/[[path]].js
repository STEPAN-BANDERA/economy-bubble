// Same-origin proxy for poe.ninja's item prices, used by the Farming tab to price
// drops the Currency Exchange doesn't trade (uniques, beasts, Wombgifts, corpse items, Nightmare Maps),
// and by the Valdo's maps tab (each Valdo's map and the unique it rewards).
// poe.ninja sends no CORS header, so the browser can't call it directly.
//
//   /api/ninja/<league>/<type>    for example /api/ninja/Allflame/UniqueJewel
//
// Prices change slowly and poe.ninja itself caches for 30 minutes, so this does too:
// however many people open the tab, poe.ninja sees about one request per league and
// type every half hour from each Cloudflare data centre with visitors (the cache is per
// data centre). A cached answer carries an Age header; cf-cache-status says DYNAMIC either
// way, because the function does the caching rather than Cloudflare's page cache. Only the fields the tab reads are passed on, which turns a
// megabyte of armour listings into a small fraction of that.
const UPSTREAM = 'https://poe.ninja/poe1/api/economy/stash/current/item/overview';
const CACHE_SECONDS = 1800;
// A second copy of every good answer is kept for a day. When poe.ninja is slow, down or
// rate-limiting (HTTP 429), that copy is served instead of an error: prices a few hours old
// beat no prices, and retrying straight away would only add to the load that caused it.
const STALE_CACHE_SECONDS = 86400;
// The Valdo's map list is poe.ninja's biggest answer (half a megabyte, with every map's
// modifiers), so it gets longer than the default before giving up.
const UPSTREAM_TIMEOUT_MILLISECONDS = 20000;
const SLOW_TYPE_TIMEOUT_MILLISECONDS = 28000;
const SLOW_TYPES = new Set(['ValdoMap']);
const ALLOWED_TYPES = new Set([
  'UniqueWeapon',
  'UniqueArmour',
  'UniqueAccessory',
  'UniqueFlask',
  'UniqueJewel',
  'Beast',
  'Wombgift',
  'ForbiddenJewel',
  'Corpse',
  'Map',
  'UniqueMap',
  'ValdoMap',
]);
// Valdo's maps keep their modifier lines: they say what the map asks of the player.
const TYPES_WITH_MODIFIERS = new Set(['ValdoMap']);
const LEAGUE_NAME = /^[A-Za-z0-9 _'-]{1,60}$/;

export async function onRequestGet({ params, request, waitUntil }) {
  const pathParts = params.path || [];
  if (pathParts.length !== 2) {
    return errorResponse('Expected /api/ninja/<league>/<type>', 400, 3600);
  }
  const league = decodedPathPart(pathParts[0]);
  const itemType = pathParts[1];
  if (league === null || !LEAGUE_NAME.test(league) || !ALLOWED_TYPES.has(itemType)) {
    return errorResponse('Unknown league or item type', 400, 3600);
  }

  const cache = caches.default;
  const cachePath = encodeURIComponent(league) + '/' + itemType;
  const cacheKey = new Request(new URL(request.url).origin + '/api/ninja/' + cachePath);
  const staleCacheKey = new Request(new URL(request.url).origin + '/api/ninja-stale/' + cachePath);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const upstreamUrl = UPSTREAM + '?league=' + encodeURIComponent(league) + '&type=' + itemType;
  let upstreamBody;
  try {
    const upstream = await fetch(upstreamUrl, {
      // poe.ninja's API docs ask for a User-Agent that names the app and a contact.
      headers: { 'User-Agent': 'faustus-ledger (+https://github.com/STEPAN-BANDERA/economy-bubble)' },
      signal: AbortSignal.timeout(upstreamTimeoutFor(itemType)),
    });
    if (!upstream.ok) {
      return (await staleCopy(cache, staleCacheKey)) ?? errorResponse('poe.ninja answered ' + upstream.status, 502, 60);
    }
    upstreamBody = await upstream.json();
  } catch {
    return (await staleCopy(cache, staleCacheKey)) ?? errorResponse('poe.ninja is slow or unreachable, try again', 504, 0);
  }

  const slimBody = JSON.stringify({ lines: slimLines(upstreamBody.lines || [], itemType) });
  const response = jsonResponse(slimBody, CACHE_SECONDS);
  waitUntil(cache.put(cacheKey, response.clone()));
  waitUntil(cache.put(staleCacheKey, jsonResponse(slimBody, STALE_CACHE_SECONDS)));
  return response;
}

function upstreamTimeoutFor(itemType) {
  if (SLOW_TYPES.has(itemType)) {
    return SLOW_TYPE_TIMEOUT_MILLISECONDS;
  }
  return UPSTREAM_TIMEOUT_MILLISECONDS;
}

// The day-old copy, marked so the page can say its prices may be a few hours behind. It is
// cached for a minute only, so poe.ninja is asked again soon but not on every visit.
async function staleCopy(cache, staleCacheKey) {
  const stale = await cache.match(staleCacheKey);
  if (!stale) {
    return null;
  }
  const body = await stale.text();
  const response = jsonResponse(body, 60);
  response.headers.set('X-Ninja-Stale', '1');
  return response;
}

function jsonResponse(body, maxAgeSeconds) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + maxAgeSeconds,
    },
  });
}

// Cloudflare hands over path segments still URL-encoded, so "Hardcore Allflame" arrives as
// "Hardcore%20Allflame". Null for a malformed one, which then counts as an unknown league.
function decodedPathPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

// Only what the tab reads: the name to match on, the price, how many listings back
// it, links (a 6-link and an unlinked copy of one unique are separate lines), the variant
// (which Forbidden jewel a notable's line is, which unique a Valdo's map rewards), the
// icon and poe.ninja's id for the item's own page, plus a Valdo's map's modifier lines.
function slimLines(lines, itemType) {
  const slim = [];
  for (const line of lines) {
    const slimLine = {
      name: line.name,
      chaos: line.chaosValue,
      listings: line.listingCount,
      links: line.links ?? null,
      variant: line.variant ?? null,
      icon: line.icon,
      detailsId: line.detailsId ?? null,
    };
    if (TYPES_WITH_MODIFIERS.has(itemType)) {
      slimLine.mods = modifierTexts(line.explicitModifiers);
    }
    slim.push(slimLine);
  }
  return slim;
}

function modifierTexts(modifiers) {
  const texts = [];
  for (const modifier of modifiers || []) {
    if (modifier && typeof modifier.text === 'string') {
      texts.push(modifier.text);
    }
  }
  return texts;
}

function errorResponse(message, status, maxAgeSeconds) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + maxAgeSeconds,
    },
  });
}
