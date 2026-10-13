// Reads an item copied in Path of Exile (Ctrl+C, or Ctrl+Alt+C for the advanced text that
// names each mod's prefix/suffix and tier), and matches its mods to a base's modifier list.

const NUM = '([+-]?\\d+(?:\\.\\d+)?)';
const INFL = { Shaper: 'shaper', Elder: 'elder', Crusader: 'crusader', Hunter: 'hunter', Redeemer: 'redeemer', Warlord: 'warlord' };
// Lines that aren't mods: item flags, influence and notes.
const META_RE = /^(Corrupted|Mirrored|Split|Unidentified|Synthesised Item|Fractured Item|Searing Exarch Item|Eater of Worlds Item|(Shaper|Elder|Crusader|Hunter|Redeemer|Warlord) Item|Note: .*|Unmodifiable|Foulborn)$/;

/**
 * parseItemText(text, index) -> {error} or
 * {rarity, bitem, base, ilvl, infl, corrupted, mirrored, advanced, mods: [{text, side?, crafted, frac, veiled}]}
 * side is known for the advanced copy (and veiled mods); otherwise the match decides it.
 */
export function parseItemText(text, index) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n').map(l => l.trim());
  const secs = [[]];
  for (const l of lines) { if (/^-{4,}$/.test(l)) secs.push([]); else if (l) secs[secs.length - 1].push(l); }
  const head = secs[0];
  const rarityLine = head.find(l => l.startsWith('Rarity: '));
  if (!rarityLine) return { error: 'That doesn\'t look like an item: in the game, hover the item and press Ctrl+C (or Ctrl+Alt+C), then paste here.' };
  const rarity = rarityLine.slice(8).toLowerCase();
  if (!['normal', 'magic', 'rare'].includes(rarity)) return { error: `A ${rarity} item can't be crafted on here: use a normal, magic or rare one.` };
  const names = head.slice(head.indexOf(rarityLine) + 1);
  const all = lines.filter(Boolean);
  if (all.includes('Unidentified')) return { error: 'Identify the item first: its mods are hidden.' };
  // The base item: the second name line of a rare, the only line of a normal item, and the
  // longest known base name inside a magic item's name.
  const clean = n => n.replace(/^(Superior|Synthesised) /, '').replace(/^(Superior|Synthesised) /, '');
  let bitem = null;
  if (rarity === 'rare') bitem = clean(names[names.length - 1] ?? '');
  else if (rarity === 'normal') bitem = clean(names[0] ?? '');
  else bitem = Object.keys(index.bitems).filter(n => (names[0] ?? '').includes(n)).sort((a, b) => b.length - a.length)[0] ?? null;
  const base = bitem != null ? index.bitems[bitem] : undefined;
  if (base == null) return { error: `Unknown base item${bitem ? ` "${bitem}"` : ''}: the crafting data covers jewellery, armour, weapons and off-hands.` };
  const ilvl = +(all.find(l => l.startsWith('Item Level: '))?.slice(12) ?? 0) || null;
  const infl = all.map(l => l.match(/^(Shaper|Elder|Crusader|Hunter|Redeemer|Warlord) Item$/)?.[1]).filter(Boolean).map(n => INFL[n]);
  const advanced = all.some(l => /^\{ .*Modifier/.test(l));
  const mods = [];
  // A value line: the advanced copy's ranges "(60-69)" and the "(crafted)" style tags removed.
  const value = l => l.replace(new RegExp(`${NUM}\\(${NUM}-${NUM}\\)`, 'g'), '$1')
    .replace(/ \((crafted|fractured|implicit|enchant|scourge|veiled)\)$/, '').trim();
  const reminder = l => /^\(.*\)$/.test(l);
  const iSec = secs.findIndex(s => s.some(l => l.startsWith('Item Level: ')));
  if (advanced) {
    let cur = null;
    for (const s of secs.slice(Math.max(1, iSec + 1))) {
      cur = null;
      for (const l of s) {
        const h = l.match(/^\{ (.*?)(Prefix|Suffix|Implicit|Unique|Enchant)?\s*Modifier/);
        if (h) {
          cur = null;
          if (h[2] === 'Prefix' || h[2] === 'Suffix') {
            cur = { lines: [], side: h[2] === 'Prefix' ? 'p' : 's', crafted: /Crafted/.test(h[1]), frac: /Fractured/.test(h[1]), veiled: /Veiled/.test(l) };
            mods.push(cur);
          }
          continue;
        }
        if (!cur || reminder(l) || META_RE.test(l)) continue;
        if (/ \(crafted\)$/.test(l)) cur.crafted = true;
        if (/ \(fractured\)$/.test(l)) cur.frac = true;
        cur.lines.push(value(l));
      }
    }
    for (const m of mods) m.text = m.lines.join('\n');
  } else {
    // The explicit mods: the first section after the item level that isn't implicits,
    // enchants or item flags.
    const isOther = l => / \((implicit|enchant|scourge)\)$/.test(l) || META_RE.test(l) || reminder(l);
    const sec = secs.slice(iSec + 1).find(s => s.some(l => !isOther(l) && !/^[A-Z][A-Za-z ]+: /.test(l)));
    for (const l of sec ?? []) {
      if (isOther(l)) continue;
      const vm = l.match(/^Veiled (Prefix|Suffix)$/);
      if (vm) { mods.push({ text: l, lines: [l], side: vm[1] === 'Prefix' ? 'p' : 's', veiled: true }); continue; }
      mods.push({ text: value(l), lines: [value(l)], crafted: / \(crafted\)$/.test(l), frac: / \(fractured\)$/.test(l) });
    }
  }
  return { rarity, bitem, base, ilvl, infl, corrupted: all.includes('Corrupted'), mirrored: all.includes('Mirrored'), advanced, mods };
}

// Template regex per mod text ("+# to maximum Life"), cached per base. (Not on the base
// object: an experimented base is a copy of it with its own scaled mods.)
const TPL = new WeakMap();
function templates(B) {
  if (TPL.has(B)) return TPL.get(B);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tpl = B.mods.filter(m => m.affix === 'p' || m.affix === 's').map(m => {
    // ("+#" also matches a number shown without its plus sign.)
    const src = '^' + m.text.split('#').map(esc).join(NUM).split('\\+' + NUM).join('\\+?' + NUM) + '$';
    return { m, re: new RegExp(src, 'i') };
  });
  TPL.set(B, tpl);
  return tpl;
}
// The tier whose ranges hold the numbers (the best one if several), else the closest.
function pickTier(m, nums) {
  let best = 0, bestD = null;
  m.tiers.forEach((t, i) => {
    const rs = t.values.map(v => (Array.isArray(v) ? v : [v, v]));
    if (rs.length !== nums.length) return;
    const d = nums.reduce((a, n, j) => { const [lo, hi] = rs[j]; return a + (lo <= n && n <= hi ? 0 : Math.min(Math.abs(n - lo), Math.abs(n - hi))); }, 0);
    if (bestD == null || d < bestD || (d === bestD && d === 0)) { best = i; bestD = d; }
  });
  return { tier: best, d: bestD ?? 1e9 };
}

/**
 * matchItem(B, item) -> {mods: [{id, tier, side, crafted, frac, text}], unknown: {p, s, any}, unread: [text]}
 * Mods are matched against B (an experimented base's B has its scaled values). Hybrid mods
 * (two lines, not always next to each other in the plain copy) are paired.
 */
export function matchItem(B, item) {
  const tpl = templates(B);
  const used = new Set();
  const srcFor = x => (x.crafted ? ['bench'] : ['base', ...item.infl, 'essence', 'veiled', 'fossil', 'beast']);
  const match = (text, x, side) => {
    const hits = [];
    const srcs = srcFor(x);
    for (const { m, re } of tpl) {
      if (!srcs.includes(m.src) || used.has(m.id) || (side && m.affix !== side)) continue;
      const mm = text.match(re);
      if (!mm) continue;
      const { tier, d } = pickTier(m, mm.slice(1).map(Number));
      hits.push({ m, tier, d, o: srcs.indexOf(m.src) });
    }
    hits.sort((a, b) => (a.d > 0) - (b.d > 0) || a.o - b.o || a.d - b.d);
    return hits[0] ?? null;
  };
  const out = [], unknown = { p: 0, s: 0, any: 0 }, unread = [];
  const take = (x, h, text) => { used.add(h.m.id); out.push({ id: h.m.id, tier: h.tier, side: h.m.affix, crafted: !!x.crafted, frac: !!x.frac, text }); };
  const miss = x => { if (x.side) unknown[x.side]++; else unknown.any++; if (!x.veiled) unread.push(x.text); };
  if (item.advanced) {
    for (const x of item.mods) {
      if (x.veiled) { miss(x); continue; }
      const h = match(x.lines.join(', '), x, x.side) ?? (x.lines.length === 2 ? match(`${x.lines[1]}, ${x.lines[0]}`, x, x.side) : null);
      if (h) take(x, h, x.text); else miss(x);
    }
    return { mods: out, unknown, unread };
  }
  // Plain copy: single lines that fit a mod exactly first, then pairs (hybrids), then the rest.
  const xs = item.mods.filter(x => { if (x.veiled) { miss(x); return false; } return true; });
  const done = new Set();
  xs.forEach((x, i) => { const h = match(x.text, x); if (h && h.d === 0) { take(x, h, x.text); done.add(i); } });
  xs.forEach((a, i) => {
    if (done.has(i)) return;
    for (let j = 0; j < xs.length; j++) {
      if (j === i || done.has(j) || !!xs[j].crafted !== !!a.crafted) continue;
      const h = match(`${a.text}, ${xs[j].text}`, a) ?? match(`${xs[j].text}, ${a.text}`, a);
      if (h && h.d === 0) { take({ ...a, frac: a.frac || xs[j].frac }, h, `${a.text}\n${xs[j].text}`); done.add(i); done.add(j); return; }
    }
  });
  xs.forEach((x, i) => { if (done.has(i)) return; const h = match(x.text, x); if (h) take(x, h, x.text); else miss(x); });
  return { mods: out, unknown, unread };
}
