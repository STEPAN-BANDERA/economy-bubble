// Same-origin proxy for poe.ninja's item prices, used by the Farming tab to price
// drops the Currency Exchange doesn't trade (uniques, beasts, Wombgifts, corpse items, Nightmare Maps).
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
]);
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
  const cacheKey = new Request(new URL(request.url).origin + '/api/ninja/' + encodeURIComponent(league) + '/' + itemType);
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
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok) {
      return errorResponse('poe.ninja answered ' + upstream.status, 502, 60);
    }
    upstreamBody = await upstream.json();
  } catch {
    return errorResponse('poe.ninja is slow or unreachable, try again', 504, 0);
  }

  const response = new Response(JSON.stringify({ lines: slimLines(upstreamBody.lines || []) }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=' + CACHE_SECONDS,
    },
  });
  waitUntil(cache.put(cacheKey, response.clone()));
  return response;
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
// (which Forbidden jewel a notable's line is) and the icon.
function slimLines(lines) {
  const slim = [];
  for (const line of lines) {
    slim.push({
      name: line.name,
      chaos: line.chaosValue,
      listings: line.listingCount,
      links: line.links ?? null,
      variant: line.variant ?? null,
      icon: line.icon,
    });
  }
  return slim;
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
