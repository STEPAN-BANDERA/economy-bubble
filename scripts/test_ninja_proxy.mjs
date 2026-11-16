// Tests the poe.ninja proxy (functions/api/ninja/[[path]].js) with no network: Cloudflare's
// cache and poe.ninja are stubbed. Run with `npm run test:proxy`.
//
// Cloudflare passes path segments still URL-encoded, so a league with a space in its name
// arrives as "Hardcore%20Allflame". That once made every Hardcore request a 400, and only
// leagues without a space had been tried, hence the cases here.
import { onRequestGet } from '../functions/api/ninja/[[path]].js';

const NINJA_ANSWER = {
  lines: [{
    name: 'Nimis', chaosValue: 100, listingCount: 5, links: null, icon: 'x.png', extra: 'dropped', detailsId: 'nimis-topaz-ring',
    variant: 'Foil Mageblood', explicitModifiers: [{ text: 'Players cannot Block', optional: false }],
  }],
};

// upstream: 'ok' answers NINJA_ANSWER, 'rateLimited' answers 429, 'timeout' throws as an aborted fetch does.
function stubEnvironment() {
  const stub = { upstreamUrls: [], cache: new Map(), upstream: 'ok' };
  globalThis.caches = {
    default: {
      match: async request => stub.cache.get(request.url)?.clone(),
      put: async (request, response) => { stub.cache.set(request.url, response); },
    },
  };
  globalThis.fetch = async url => {
    stub.upstreamUrls.push(url);
    if (stub.upstream === 'rateLimited') {
      return new Response('slow down', { status: 429 });
    }
    if (stub.upstream === 'timeout') {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    return new Response(JSON.stringify(NINJA_ANSWER), { status: 200 });
  };
  return stub;
}

async function callProxy(pathParts) {
  const waited = [];
  const urlPath = pathParts.join('/');
  const response = await onRequestGet({
    params: { path: pathParts },
    request: new Request('https://example.test/api/ninja/' + urlPath),
    waitUntil: promise => waited.push(promise),
  });
  await Promise.all(waited);
  return response;
}

const failures = [];
function check(label, passed, detail = '') {
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${label}${passed ? '' : ' ' + detail}`);
  if (!passed) {
    failures.push(label);
  }
}

async function expectAccepted(label, pathParts, expectedLeagueQuery) {
  const stub = stubEnvironment();
  const response = await callProxy(pathParts);
  check(`${label}: answers 200`, response.status === 200, `got ${response.status}`);
  const upstream = stub.upstreamUrls[0] ?? '';
  check(`${label}: asks poe.ninja for the right league`, upstream.includes('league=' + expectedLeagueQuery + '&'), upstream);
}

async function expectRejected(label, pathParts) {
  const stub = stubEnvironment();
  const response = await callProxy(pathParts);
  check(`${label}: answers 400`, response.status === 400, `got ${response.status}`);
  check(`${label}: doesn't contact poe.ninja`, stub.upstreamUrls.length === 0);
}

await expectAccepted('plain league', ['Allflame', 'Beast'], 'Allflame');
await expectAccepted('Wombgift type', ['Allflame', 'Wombgift'], 'Allflame');
await expectAccepted('Forbidden jewel type', ['Allflame', 'ForbiddenJewel'], 'Allflame');
await expectAccepted('Corpse type', ['Allflame', 'Corpse'], 'Allflame');
await expectAccepted('Valdo map type', ['Allflame', 'ValdoMap'], 'Allflame');
await expectAccepted('unique map type', ['Allflame', 'UniqueMap'], 'Allflame');
await expectAccepted('encoded space', ['Hardcore%20Allflame', 'Beast'], 'Hardcore%20Allflame');
await expectAccepted('already decoded space', ['Hardcore Allflame', 'Beast'], 'Hardcore%20Allflame');
await expectAccepted('apostrophe', ['Kirac%27s%20League', 'Beast'], "Kirac's%20League");

await expectRejected('type not on the list', ['Allflame', 'SkillGem']);
await expectRejected('malformed encoding', ['Hardcore%ZZAllflame', 'Beast']);
await expectRejected('encoded slash', ['..%2F..%2Fetc', 'Beast']);
await expectRejected('wrong path length', ['Allflame']);

// Only the fields the tab reads go out, and a second request comes from the cache.
{
  const stub = stubEnvironment();
  const first = await callProxy(['Hardcore%20Allflame', 'Beast']);
  const body = await first.json();
  check('trims each line', body.lines[0].name === 'Nimis' && body.lines[0].chaos === 100 && body.lines[0].extra === undefined);
  check('keeps the poe.ninja page id', body.lines[0].detailsId === 'nimis-topaz-ring');
  const second = await callProxy(['Hardcore%20Allflame', 'Beast']);
  check('second request served from the cache', second.status === 200 && stub.upstreamUrls.length === 1, `upstream calls: ${stub.upstreamUrls.length}`);
  const decodedSpelling = await callProxy(['Hardcore Allflame', 'Beast']);
  check('both spellings share one cache entry', decodedSpelling.status === 200 && stub.upstreamUrls.length === 1, `upstream calls: ${stub.upstreamUrls.length}`);
}

// Valdo's maps keep their modifier lines; other types don't carry them.
{
  stubEnvironment();
  const valdo = await (await callProxy(['Allflame', 'ValdoMap'])).json();
  check('Valdo map keeps its reward variant', valdo.lines[0].variant === 'Foil Mageblood');
  check('Valdo map keeps its modifiers', JSON.stringify(valdo.lines[0].mods) === '["Players cannot Block"]', JSON.stringify(valdo.lines[0].mods));
  const beast = await (await callProxy(['Allflame', 'Beast'])).json();
  check('other types leave modifiers out', beast.lines[0].mods === undefined);
}

// When poe.ninja times out or rate-limits, the day-old copy is served, marked stale.
for (const failure of ['timeout', 'rateLimited']) {
  const stub = stubEnvironment();
  await callProxy(['Allflame', 'ValdoMap']);
  stub.cache.delete('https://example.test/api/ninja/Allflame/ValdoMap'); // the half-hour copy has expired
  stub.upstream = failure;
  const fallback = await callProxy(['Allflame', 'ValdoMap']);
  check(`${failure}: serves the stale copy`, fallback.status === 200 && fallback.headers.get('X-Ninja-Stale') === '1', `got ${fallback.status}`);
  const fallbackBody = await fallback.json();
  check(`${failure}: stale copy has the lines`, fallbackBody.lines?.[0]?.name === 'Nimis');
}
for (const [failure, expectedStatus] of [['timeout', 504], ['rateLimited', 502]]) {
  const stub = stubEnvironment();
  stub.upstream = failure;
  const response = await callProxy(['Allflame', 'ValdoMap']);
  check(`${failure} with nothing cached: answers ${expectedStatus}`, response.status === expectedStatus, `got ${response.status}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log('\nAll passed.');
