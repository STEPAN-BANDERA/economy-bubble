// poe.ninja's price lists, for every tab that uses them (Farming, Valdo, Build maker), through
// the site's /api/ninja proxy (functions/api/ninja). One list is fetched once per page visit
// and league, whichever tab asks first, so two tabs never hold two different copies of the
// same prices. What a tab does with the lines (which of several variants stands for an item,
// and so on) stays in that tab: README's "Items with many prices".
//
//   ninjaLines(league, itemType) -> Promise of { lines, stale } or null when it didn't load.
//   `stale` means the proxy served its last good copy because poe.ninja didn't answer.

// A failed request is tried once more after this pause: poe.ninja sometimes refuses a burst
// of requests (HTTP 429) and answers a moment later.
const RETRY_PAUSE_MILLISECONDS = 4000;

const loaded = new Map(); // league|itemType -> promise of { lines, stale } or null

export function ninjaLines(league, itemType) {
  const key = league + '|' + itemType;
  if (!loaded.has(key)) {
    const loading = fetchWithRetry(league, itemType).then(result => {
      // A list that didn't load isn't kept, so a later visit to the tab asks again.
      if (result === null) {
        loaded.delete(key);
      }
      return result;
    });
    loaded.set(key, loading);
  }
  return loaded.get(key);
}

async function fetchWithRetry(league, itemType) {
  const first = await fetchOnce(league, itemType);
  if (first.result || !first.worthRetrying) {
    return first.result;
  }
  await pause(RETRY_PAUSE_MILLISECONDS);
  const second = await fetchOnce(league, itemType);
  return second.result;
}

async function fetchOnce(league, itemType) {
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
