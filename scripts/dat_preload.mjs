// Preloaded into the pathofexile-dat CLI (see export() in fetch_exchange_items.py).
// 1. PoE2's patch server reports "0.x" versions, but the library only treats
//    "4.x" as PoE2 -- we hand it "4.x" and retry a CDN 404 as "0.x" here.
// 2. Unnamed schema columns can't be selected for export, so give every
//    nameless column a positional name ("Unk<index>").
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url;
  const res = await realFetch(input, init);
  const m = url?.match(/^(https:\/\/patch-poe2\.poecdn\.com\/)4\.(.*)$/);
  if (res.status === 404 && m) return realFetch(`${m[1]}0.${m[2]}`, init);
  if (url?.includes('dat-schema') && res.ok) {
    const schema = await res.json();
    for (const t of schema.tables) t.columns.forEach((c, i) => { if (!c.name) c.name = `Unk${i}`; });
    return new Response(JSON.stringify(schema), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return res;
};
