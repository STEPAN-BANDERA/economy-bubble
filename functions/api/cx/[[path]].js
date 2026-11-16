// Same-origin proxy for GGG's Currency Exchange history API.
// web.poecdn.com sends no CORS headers, so the browser can't call it directly.
//
//   /api/cx/<id>          PoE1 PC realm, hour <id> (unix seconds, on the hour)
//   /api/cx/<realm>/<id>  realm = poe2 | xbox | sony
//
// A finished hour never changes, so a 200 is cached for a year (at Cloudflare's
// edge and in the browser). A 404 means "that hour isn't published yet" and is
// only cached for a minute.
const UPSTREAM = 'https://web.poecdn.com/api/currency-exchange';
const PATH = /^(?:(poe2|xbox|sony)\/)?(\d{10})$/;

export async function onRequestGet({ params, request, waitUntil }) {
  const path = (params.path || []).join('/');
  const m = path.match(PATH);
  if (!m || Number(m[2]) % 3600 !== 0) {
    return json({ error: 'Expected /api/cx/[poe2|xbox|sony/]<unix hour>' }, 400, 3600);
  }

  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + '/api/cx/' + path);
  const hit = await cache.match(key);
  if (hit) return hit;

  // A freshly published hour can take a while on GGG's side; give up after 25 s
  // so the page can retry or fall back to the previous hour.
  let up, body;
  try {
    up = await fetch(`${UPSTREAM}/${path}`, {
      headers: { 'User-Agent': 'faustus-ledger (currency exchange viewer)' },
      signal: AbortSignal.timeout(25000),
    });
    // Read the whole body before answering: a streamed response that gets cut off
    // would otherwise be cached for a year. A complete digest ends with "}".
    body = await up.arrayBuffer();
  } catch {
    return json({ error: 'Upstream is slow, try again' }, 504, 0);
  }
  const bytes = new Uint8Array(body);
  let end = bytes.length - 1;
  while (end >= 0 && bytes[end] <= 32) end--;
  if (up.status === 200 && bytes[end] !== 0x7d) return json({ error: 'Upstream response was cut off, try again' }, 502, 0);
  const ok = up.status === 200;
  const res = new Response(body, {
    status: up.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': ok ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
    },
  });
  if (ok || up.status === 404) waitUntil(cache.put(key, res.clone()));
  return res;
}

function json(body, status, maxAge) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` },
  });
}
