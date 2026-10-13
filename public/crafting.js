// The Crafting tab: plans for items worn by popular builds (poe.ninja), any
// base you pick, and a workbench to try currencies one click at a time.
// The maths is in craft.js; this file is only the interface.
import * as C from './craft.js';
import { parseItemText, matchItem } from './itemtext.js';

let X; // helpers from app.js: el, fmt, store, rerender, exchangePrice, realm, items
const S = {
  index: null, targets: null, loading: null, error: null, bases: new Map(), ready: new Map(),
  mode: null, arch: 0, item: 0, spec: null, plans: null, planKey: '', busy: false,
  any: null, wb: null, overrides: null,
};
const SRC_LABEL = { base: 'Base', essence: 'Essence', veiled: 'Veiled', bench: 'Bench', fossil: 'Fossil', beast: 'Beast',
  shaper: 'Shaper', elder: 'Elder', crusader: 'Crusader', hunter: 'Hunter', warlord: 'Warlord', redeemer: 'Redeemer' };
const SIDE = { p: 'Prefix', s: 'Suffix', r: 'Exarch implicit', b: 'Eater implicit' };

// ---------- data ----------
function ensureData() {
  if (S.index || S.loading) return;
  S.loading = Promise.all(['index-poe1', 'targets-poe1'].map(f => fetch(`data/craft/${f}.json`).then(r => {
    if (!r.ok) throw new Error(`data/craft/${f}.json is missing (run the craft data scripts)`);
    return r.json();
  }))).then(([index, targets]) => { S.index = index; S.targets = targets; }, e => { S.error = e.message; })
    .finally(() => { S.loading = null; X.rerender(); });
}
function base(id) {
  if (!S.bases.has(id)) {
    S.bases.set(id, fetch(`data/craft/base-${id}.json`).then(r => r.json()).then(raw => {
      const B = C.prepareBase(raw, S.index);
      S.ready.set(id, B);
      return B;
    }));
  }
  return S.bases.get(id);
}
const baseNow = id => S.ready.get(id) ?? null;
// An experimented base item (Helical Ring, ...) is its own base: other affix limits and values.
const exp = name => (name && S.index.experimented?.[name]) || null;
const itemBase = (B, name) => (B ? C.forBaseItem(B, name, S.index) : null);
// Builder picks are remembered per base (or experimented base item) and influence.
const anyKey = (A, infl = A.infl) => `a:${A.base}${exp(A.bitem) ? '~' + A.bitem : ''}:${infl.join('+')}`;

// ---------- prices ----------
function priceInfo(name) {
  S.overrides ??= X.store.get('craftPrices', {});
  // 'off': you'd rather not use it (too scarce, or you don't want to): the planner leaves it out.
  if (S.overrides[name] === 'off') return { v: NaN, src: 'not used' };
  if (S.overrides[name] != null) return { v: S.overrides[name], src: 'yours' };
  if (name === C.CUR.chaos) return { v: 1, src: 'exchange' };
  const ex = X.realm() !== 'poe2' ? X.exchangePrice(name) : null;
  if (ex) return { v: ex, src: 'exchange' };
  const fb = C.FARMED_PRICES[name] ?? S.index?.fallbackPrices?.[name];
  if (fb != null) return { v: fb, src: 'estimate' };
  return { v: NaN, src: 'unknown' };
}
const price = name => priceInfo(name).v;
function money(c) {
  if (!isFinite(c)) return '–';
  const div = price(C.CUR.divine);
  if (isFinite(div) && c >= div * 2) return `${C.fmtN(c / div)} div`;
  return `${C.fmtN(c)}c`;
}

// ---------- target specs ----------
function specFromNinja(arch, item, B) {
  const targets = [...item.mods, ...(item.eldritch ?? [])].filter(m => m.id && B.byId.get(m.id)).map(m => ({
    m: B.byId.get(m.id), minTier: m.tier, orig: m.tier, crafted: !!m.crafted, frac: !!m.fractured, on: true, text: m.text,
  }));
  return { key: `n:${S.arch}:${S.item}`, B, ilvl: item.ilvl ?? 84, infl: [...(B.innateInfl ?? item.influences ?? [])], targets,
    // (Fractured influenced items only came from Necropolis crafting; plans can't start from one.)
    useFractured: !item.influences?.length,
    label: `${item.name} (${item.baseType})`, unmatched: item.mods.filter(m => !m.id).map(m => m.text), eldritch: [] };
}
const activeTargets = spec => spec.targets.filter(T => T.on);
// Every price the planner might ask for, looked up once and sent to the worker.
function priceSnapshot(B) {
  const names = new Set([...Object.keys(S.index.fallbackPrices ?? {}), ...Object.values(C.CUR), ...C.RESONATORS, C.FRACTURE, 'Mirror of Kalandra',
    ...S.index.fossils.map(f => f.name), C.DUST, C.GOLD]);
  for (const t of C.ELDRITCH_TIERS) { names.add(`${t} Eldritch Ember`); names.add(`${t} Eldritch Ichor`); }
  for (const c of ['Wild', 'Vivid', 'Primal']) names.add(C.lifeforce(c));
  for (const n of [...C.INFLUENCES.map(C.influenceExalt), C.HK_LOCK, C.SACRED, C.RANCOUR, C.SULPHUR, C.MATRON, C.AWAKENER, ...C.HK_SETUP]) names.add(n);
  const L = S.index.essenceLevels;
  for (const m of B.mods) if (m.src === 'essence' && m.essence) {
    m.tiers.forEach((_, t) => names.add(C.essenceName(m, t, L)));
  }
  const out = {}, supply = {};
  for (const n of names) {
    const v = price(n);
    if (!isFinite(v)) continue;
    out[n] = v;
    // How much the exchange trades (an hour) and lists: the planner prices up what a plan needs beyond it.
    const vol = X.realm() !== 'poe2' ? X.exchangeVolume?.(n) : null;
    if (vol && vol.perHour > 0) supply[n] = { perHour: vol.perHour, stock: vol.stock };
  }
  return { prices: out, supply };
}
let worker = null, jobId = 0;
const planOptions = () => ({ ...C.DEFAULT_OPTIONS, ...X.store.get('craftOptions', {}) });
function planFor(spec) {
  S.overrides ??= X.store.get('craftPrices', {});
  const key = spec.key + '|' + spec.ilvl + '|' + spec.useFractured + '|' + JSON.stringify(spec.start ?? null) + '|' + spec.targets.map(T => (T.on ? T.m.id + ':' + T.minTier : '')).join(',') + '|' + JSON.stringify(S.overrides ?? {}) + '|' + X.realm() + '|' + JSON.stringify(planOptions());
  if (S.planKey === key) return S.plans;
  if (S.busy === key) return null;
  // A new question cancels the old one: the worker solves one plan at a time.
  if (S.busy && worker) { worker.terminate(); worker = null; }
  S.busy = key; S.progress = 'Starting';
  const id = ++jobId;
  worker ??= new Worker('craft-worker.js', { type: 'module' });
  worker.onmessage = e => {
    const d = e.data;
    if (d.id !== jobId) return; // an older request
    if (d.progress) { S.progress = d.progress; const n = document.getElementById('craft-progress'); if (n) n.textContent = `Working out the best strategy: ${d.progress}…`; return; }
    S.plans = d.error ? { error: d.error } : d.plans;
    S.planKey = key; S.busy = false; X.rerender();
  };
  worker.onerror = e => { S.plans = { error: e.message || 'The planner crashed' }; S.planKey = key; S.busy = false; X.rerender(); };
  worker.postMessage({ id, baseId: spec.B.id, bitem: spec.B.item ?? null, ilvl: spec.ilvl, infl: spec.infl, useFractured: spec.useFractured, start: spec.start ?? null, ...priceSnapshot(spec.B), options: planOptions(),
    targets: activeTargets(spec).map(T => ({ id: T.m.id, minTier: T.minTier, crafted: !!T.crafted, frac: !!T.frac })) });
  return null;
}

// ---------- views ----------
export function craftPanel(helpers) {
  X = helpers;
  const { el } = X;
  ensureData();
  if (S.error) return [el('p', { class: 'status err' }, `Couldn't load crafting data: ${S.error}.`)];
  if (!S.index) return [el('p', { class: 'muted' }, 'Loading crafting data…')];
  if (hasItemLink()) S.mode = 'any';
  S.mode ??= X.store.get('craftMode', 'builds');
  const setMode = m => { S.mode = m; X.store.set('craftMode', m); X.rerender(); };
  const modeBtn = (m, label) => el('button', { class: 'seg' + (S.mode === m ? ' on' : ''), 'aria-pressed': String(S.mode === m), onclick: () => setMode(m) }, label);
  const out = [
    el('p', { class: 'lede' }, 'Step-by-step ways to craft an item, ranked by expected cost at today\'s exchange prices. ',
      'Each plan rolls the hard mods together and finishes with slams, beasts, veiled orbs or the bench. The odds are exact, and the Workbench can check them by simulation.'),
    X.realm() === 'poe2' ? el('p', { class: 'status err' }, 'Crafting covers PoE 1 only. Prices below are estimates; switch the realm to a PoE 1 one for live prices.') : null,
    el('div', { class: 'segs', role: 'group', 'aria-label': 'Crafting view' }, modeBtn('builds', 'Popular builds'), modeBtn('any', 'Item builder'), modeBtn('bench', 'Workbench')),
  ];
  if (S.mode === 'builds') out.push(...buildsView());
  else if (S.mode === 'any') out.push(...anyView());
  else out.push(...benchView());
  out.push(sourcesNote());
  return out.filter(Boolean);
}

function buildsView() {
  const { el } = X;
  const A = S.targets.archetypes;
  if (!A.length) return [el('p', { class: 'empty' }, 'No build data.')];
  S.arch = Math.min(S.arch, A.length - 1);
  const arch = A[S.arch];
  S.item = Math.min(S.item, Math.max(0, arch.items.length - 1));
  const out = [
    el('div', { class: 'filters' },
      el('label', {}, 'Build', el('select', { onchange: e => { S.arch = +e.target.value; S.item = 0; S.spec = null; X.rerender(); } },
        A.map((a, i) => el('option', { value: i, selected: i === S.arch }, `${a.skill} ${a.class} (${a.share}% of characters)`)))),
      el('span', { class: 'muted' }, `poe.ninja, ${S.targets.league} league, ${S.targets.built}`)),
    el('div', { class: 'cards' }, arch.items.map((it, i) => el('button', {
      class: 'card' + (i === S.item ? ' on' : ''), 'aria-pressed': String(i === S.item),
      onclick: () => { S.item = i; S.spec = null; X.rerender(); },
    }, el('b', {}, it.slot), el('span', { class: 'name' }, it.name), el('small', {}, `${it.baseType}, item level ${it.ilvl}`),
      it.influences.length ? el('small', { class: 'infl' }, it.influences.join(' + ')) : null,
      el('small', { class: 'muted' }, `${it.mods.filter(m => m.id).length} mods · ${it.from}`)))),
  ];
  const item = arch.items[S.item];
  if (!item) return out;
  const B = itemBase(baseNow(item.base), item.baseType);
  if (!B) { base(item.base).then(() => X.rerender()); out.push(el('p', { class: 'muted' }, 'Loading mods for this base…')); return out; }
  if (!S.spec || S.spec.key !== `n:${S.arch}:${S.item}`) S.spec = specFromNinja(arch, item, B);
  out.push(...specView(S.spec));
  return out;
}

// ---------- currency icons ----------
// Currency names in plan text become small icons (the name shows on hover and to screen
// readers), so "Orb of Alteration ... Exalted Orb ... Exalted Orb" reads at a glance.
const ICON_SKIP = new Set(['Divination Cards', 'Scarabs', 'Tattoos', 'Runegrafts', 'Fragments']);
let ICONS = null;
// Copies of PoE Wiki images (beasts and Recombinators aren't on the exchange), served from here
// because the wiki doesn't reliably serve images to other sites. A captured beast's Bestiary Orb
// stands in where the wiki has no picture of that beast.
const WIKI = 'img/wiki/';
const BESTIARY_ORB = WIKI + 'bestiary-orb.png';
const WIKI_ICONS = {
  'Craicic Croaker': WIKI + 'craicic-croaker.png', 'Black Mórrigan': WIKI + 'black-morrigan.png',
  'Wild Bristle Matron': WIKI + 'wild-bristle-matron.png', 'Farric Lynx Alpha': WIKI + 'farric-lynx-alpha.png',
  'Farric Wolf Alpha': BESTIARY_ORB, 'Craicic Chimeral': BESTIARY_ORB,
  'Farrul, First of the Plains': BESTIARY_ORB, 'Saqawal, First of the Sky': BESTIARY_ORB, 'Fenumus, First of the Night': BESTIARY_ORB, 'Craiceann, First of the Deep': BESTIARY_ORB,
  'Armour Recombinator': WIKI + 'armour-recombinator.png', 'Weapon Recombinator': WIKI + 'weapon-recombinator.png',
  'Jewellery Recombinator': WIKI + 'jewellery-recombinator.png',
};
function iconIndex() {
  const items = X.items?.() ?? {};
  if (ICONS?.items === items) return ICONS;
  const map = new Map();
  for (const it of Object.values(items)) if (it.icon && !ICON_SKIP.has(it.cat)) map.set(it.name, it.icon);
  // Beasts and Recombinators aren't on the exchange: icons from the PoE Wiki (a captured beast's
  // Bestiary Orb where the wiki has no picture of that beast).
  for (const [n, src] of Object.entries(WIKI_ICONS)) map.set(n, src);
  // Short forms the plans use: "500 Wild Lifeforce", "3 Rancour".
  for (const c of ['Wild', 'Vivid', 'Primal', 'Sacred']) if (map.has(`${c} Crystallised Lifeforce`)) map.set(`${c} Lifeforce`, map.get(`${c} Crystallised Lifeforce`));
  const names = [...map.keys()].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  ICONS = { items, map, re: names.length ? new RegExp(`(?<![\\w'])(${names.join('|')})(?![\\w'])`, 'g') : null };
  return ICONS;
}
const curIcon = (name, label = name) => {
  const src = iconIndex().map.get(name);
  return src ? X.el('img', { class: 'cicon', src, alt: label, title: label, loading: 'lazy', referrerpolicy: 'no-referrer' }) : null;
};
// An icon in running text: a larger hover area and an instant name pop-up (also on keyboard focus).
const textIcon = name => {
  const img = curIcon(name);
  img?.removeAttribute('title'); // the pop-up replaces the slow browser tooltip
  return img ? X.el('span', { class: 'cwrap', tabindex: 0, 'data-name': name }, img) : name;
};
// Text with each currency name replaced by its icon.
function richText(text) {
  const I = iconIndex();
  if (!I.re || !text) return [text];
  const out = [];
  let last = 0;
  for (const m of text.matchAll(I.re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(textIcon(m[1]));
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------- mod categories ----------
// Each mod gets categories from its tags (a mod can have several), shown as coloured chips
// and used by the category filter.
const CATS = [
  ['life', 'Life', ['life']], ['mana', 'Mana', ['mana']], ['defence', 'Defence', ['defences', 'armour', 'evasion', 'energy_shield']],
  ['resist', 'Resistance', ['resistance']], ['attr', 'Attribute', ['attribute']],
  ['fire', 'Fire', ['fire']], ['cold', 'Cold', ['cold']], ['lightning', 'Lightning', ['lightning']], ['chaos', 'Chaos', ['chaos']], ['phys', 'Physical', ['physical']],
  ['attack', 'Attack', ['attack']], ['caster', 'Caster', ['caster']], ['speed', 'Speed', ['speed']], ['crit', 'Critical', ['critical']],
  ['ailment', 'Ailment', ['ailment', 'bleed', 'poison']], ['minion', 'Minion', ['minion']], ['aura', 'Aura & curse', ['aura', 'curse']], ['gem', 'Gem levels', ['gem']],
];
const CAT_LABEL = Object.fromEntries(CATS.map(([k, l]) => [k, l]));
const modCats = m => { const c = CATS.filter(([, , tags]) => tags.some(t => m.tags?.includes(t))).map(([k]) => k); return c.length ? c : ['other']; };
CAT_LABEL.other = 'Other';
const catChips = (m, max = 4) => X.el('span', { class: 'cats' }, modCats(m).slice(0, max).map(k => X.el('span', { class: 'cat c-' + k }, CAT_LABEL[k])));

// ---------- example items ----------
// A concrete item for a planner state, prefixes and suffixes side by side.
function exampleCard(ex, title) {
  const { el } = X;
  if (!ex) return null;
  const line = x => el('li', { class: 'k-' + x.kind + (x.frac ? ' frac' : '') }, x.text,
    x.frac ? el('small', {}, ' fractured') : null, x.kind === 'dead' ? el('small', {}, ' wrong tier') : null, x.kind === 'lost' ? el('small', {}, ' lost') : null);
  return el('div', { class: 'excard' },
    title ? el('b', {}, title, ex.magic ? el('small', { class: 'muted' }, ' (magic item)') : null) : ex.magic ? el('small', { class: 'muted' }, 'Magic item') : null,
    el('div', { class: 'excols' }, ['p', 's'].map(side => el('div', {},
      el('small', { class: 'muted' }, `${SIDE[side]}es`),
      el('ul', {}, ex[side].length ? ex[side].map(line) : el('li', { class: 'k-none' }, 'none'))))));
}
// Where a step's outcomes lead: "60% moves on · 30% try again · 6% back to step 2".
const planId = p => 'plan-' + p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
function flowLine(flow, i, pid) {
  const { el } = X;
  const note = f => (f.chg ? [' ', changeNote(f), ':'] : f.note ? ` ${f.note}:` : '');
  // "step N" jumps to that step and flashes it.
  const ref = to => el('button', { type: 'button', class: 'linklike stepref', onclick: () => {
    const li = document.getElementById(`${pid}-s${to + 1}`);
    if (!li) return;
    li.scrollIntoView({ behavior: 'smooth', block: 'center' });
    li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
  } }, `step ${to + 1}`);
  const part = f => {
    const pct = el('b', {}, C.pctText(f.p));
    if (f.kind === 'on') return el('span', { class: 'flow on' }, pct, ' moves on');
    if (f.kind === 'again') return el('span', { class: 'flow again' }, pct, note(f), ' try again');
    // (Back to a reforge step: that reforge again, which rerolls the item.)
    if (f.kind === 'back') return el('span', { class: 'flow back' }, pct, note(f), ...(f.to === i ? [' try this step again'] : [' back to ', ref(f.to), f.reforge ? ' (reforge)' : '']));
    if (f.kind === 'new') return el('span', { class: 'flow back' }, pct, note(f), ' new base', ...(f.to != null && f.to !== i ? [', back to ', ref(f.to)] : []));
    // Off the likeliest path: what happened, the plan's next moves from there, and where they lead
    // back onto the listed steps.
    const back = f.back === 'self' ? [', back to this step'] : f.back === 'done' ? [', done'] : typeof f.back === 'number' ? (f.back === i ? [', back to this step'] : [', back to ', ref(f.back)]) : [];
    const moves = (f.next ?? '').split(' → ').filter(Boolean);
    // Only the next move is spelled out; the rest of the chain is in the tooltip.
    const shown = moves.length > 1 ? [moves[0], '…'] : moves;
    return el('span', { class: 'flow else' + (f.back != null && f.back !== 'done' ? ' back' : ''), title: moves.length > 1 ? moves.join(' → ') : null },
      pct, f.chg ? [' ', changeNote(f)] : f.note ? ` ${f.note}` : '', ...(shown.length ? [f.note ? ', then ' : ' then ', ...richText(shown.join(' → '))] : f.note ? [] : [' a different state']), ...back);
  };
  return el('span', { class: 'flows' }, flow.flatMap((f, j) => (j ? [el('span', { class: 'sep' }, ' · '), part(f)] : [part(f)])));
}
// A result that changes wanted mods, kept short ("loses 1 · 1 lower tier"); the pop-up shows the
// item afterwards with the lost mods struck out.
function changeNote(f) {
  const { el } = X;
  const c = f.chg, parts = [];
  if (c.lost.length) parts.push(`loses ${c.lost.length}`);
  if (c.dead.length) parts.push(`${c.dead.length} lower tier`);
  if (c.freed.length) parts.push(`clears ${c.freed.length} lower tier`);
  if (c.junkFrac) parts.push('junk fractured');
  const list = (label, xs, cls) => (xs.length ? el('p', { class: 'small' }, el('span', { class: cls }, label), ' ', xs.join('; ')) : null);
  return popWrap(
    el('button', { class: 'linklike exbtn chg', type: 'button' }, parts.join(', ')),
    el('div', { class: 'expop', role: 'tooltip' },
      list('Loses:', c.lost, 'down'), list('Rolls a lower tier of:', c.dead, 'gold'), list('Clears the lower tier of:', c.freed, 'up'),
      c.junkFrac ? el('p', { class: 'small' }, 'A junk mod gets fractured (it keeps its slot for good).') : null,
      f.ex ? exampleCard(f.ex, 'The item afterwards') : null,
      el('p', { class: 'muted small' }, 'Struck out in red: wanted mods this result takes away.')));
}
// Hover/focus pop-ups open below and to the right; nudge them back inside the window.
function placePop(e) {
  const pop = e.currentTarget.querySelector(':scope > .expop');
  if (!pop) return;
  pop.classList.remove('up'); pop.style.left = '';
  const r = pop.getBoundingClientRect();
  if (!r.width) return;
  const over = r.right - (innerWidth - 12);
  if (over > 0) pop.style.left = `${-Math.min(over, r.left - 12)}px`;
  if (r.bottom > innerHeight - 8 && e.currentTarget.getBoundingClientRect().top - r.height > 8) pop.classList.add('up');
}
const popWrap = (...kids) => X.el('span', { class: 'exwrap', onmouseenter: placePop, onfocusin: placePop }, ...kids);
// "N good results" link: a popup listing where a repeated reforge stops, each with its chance
// and an example item.
function resultsTrigger(s) {
  const { el } = X;
  if (!s.results?.length) return null;
  return popWrap(
    el('button', { class: 'linklike exbtn', type: 'button' }, `${s.results.length + (s.resultsRest > 0 ? '+' : '')} good result${s.results.length === 1 ? '' : 's'}`),
    el('div', { class: 'expop results', role: 'tooltip' },
      el('b', {}, 'Stop when the item is one of these'),
      el('ol', { class: 'reslist' }, s.results.map(r => el('li', {},
        el('div', { class: 'reshead' }, el('span', { class: 'gold' }, C.pctText(r.p)), ' ', r.done ? el('b', { class: 'up' }, 'done: ') : null, r.text),
        exampleCard(r.ex)))),
      s.resultsRest > 0 ? el('p', { class: 'muted small' }, `…and rarer ones, ${C.pctText(s.resultsRest)} together.`) : null,
      el('p', { class: 'muted small' }, 'Chances are per try. Anything else: try again.')));
}
// "Example item" link that opens a popup with the item before and after a step.
function exampleTrigger(before, after) {
  const { el } = X;
  if (!before && !after) return null;
  return popWrap(
    el('button', { class: 'linklike exbtn', type: 'button' }, 'example item'),
    el('div', { class: 'expop', role: 'tooltip' },
      before ? exampleCard(before, after ? 'Before' : 'Example') : null,
      after ? exampleCard(after, before ? 'After (the likeliest good result)' : 'Typical result') : null,
      el('p', { class: 'muted small' }, 'Wanted mods are blue with a ✓; grey ones are filler (the base\'s common mods). Actual rolls vary.')));
}

// ---------- item builder ----------
// Pick a base, then mods from the full list (like Craft of Exile): the item card shows
// what you're building, the planner prices it below.
const ELD = m => m.affix === 'r' || m.affix === 'b';
const SRC_FILTERS = [['', 'All'], ['base', 'Base'], ['infl', 'Influence'], ['essence', 'Essence'], ['fossil', 'Fossil'], ['veiled', 'Veiled'], ['bench', 'Bench']];
// The fossil a fossil-only mod needs (Faceted for socketed-gem levels, Hollow for the Abyssal Socket).
const fossilFor = m => S.index.fossils.find(f => String(f.id) === String(m.fossil) || f.forces === m.id);
// A built item as a URL: ?item=<base>~<item level>~<influences>~<mods>~<item name>#craft,
// mods as <id>.<tier> plus c (bench), f (fractured), x (unused), joined by _.
function itemLink(A, spec) {
  const mods = spec.targets.map(T => `${T.m.id}.${T.minTier}${T.crafted ? 'c' : ''}${T.frac ? 'f' : ''}${T.on ? '' : 'x'}`).join('_');
  const v = [A.base, A.ilvl, A.infl.join('+'), mods, A.bitem ?? ''].map(x => encodeURIComponent(String(x))).join('~');
  return `${location.origin}${location.pathname}?item=${v}#craft`;
}
function readItemLink(A) {
  const v = new URLSearchParams(location.search).get('item');
  if (!v) return false;
  const [base, ilvl, infl, mods, bitem] = v.split('~').map(decodeURIComponent);
  if (!S.index.bases[base]) return false;
  A.base = base; A.ilvl = Math.max(1, Math.min(100, +ilvl || 86));
  A.infl = (infl ? infl.split('+') : []).filter(n => S.index.influences.includes(n)).slice(0, 2);
  A.bitem = bitem && S.index.bitems[bitem] != null ? bitem : '';
  const picks = (mods ? mods.split('_') : []).map(x => x.match(/^(\d+)\.(\d+)([cfx]*)$/)).filter(Boolean)
    .map(([, id, t, fl]) => ({ id: +id, minTier: +t, crafted: fl.includes('c'), frac: fl.includes('f'), on: !fl.includes('x') }));
  A.picks = { ...(A.picks ?? {}), [anyKey(A)]: picks };
  // Opened once: later edits are the viewer's own, so the link leaves the address bar.
  history.replaceState(null, '', location.pathname + location.hash);
  return true;
}
export const hasItemLink = () => new URLSearchParams(location.search).has('item');

const anyState = () => (S.any ??= X.store.get('craftAny', { base: '45', ilvl: 86, infl: [], q: '', side: '' }));
function anyView() {
  const { el } = X;
  const I = S.index;
  anyState();
  const save = () => X.store.set('craftAny', S.any);
  const A = S.any;
  if (readItemLink(A)) { S.spec = null; save(); }
  const groups = Object.entries(I.groups);
  const bases = Object.entries(I.bases).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const B = itemBase(baseNow(+A.base), A.bitem);
  // Base search: an item's own name (Vaal Regalia) or its base type (Body Armour (INT)).
  const names = [...Object.keys(I.bitems), ...bases.map(([, b]) => b.name)];
  const baseSearch = el('input', { type: 'search', list: 'craft-bitems', placeholder: 'e.g. Vaal Regalia', value: A.bitem ?? '', 'aria-label': 'Search base items' });
  baseSearch.addEventListener('change', () => {
    const q = baseSearch.value.trim().toLowerCase();
    const hit = Object.keys(I.bitems).find(n => n.toLowerCase() === q);
    const type = bases.find(([, b]) => b.name.toLowerCase() === q);
    if (hit) { A.base = String(I.bitems[hit]); A.bitem = hit; } else if (type) { A.base = type[0]; A.bitem = ''; } else return;
    A.start = null;
    if (!I.bases[A.base]?.influence || exp(A.bitem)?.allInfl) A.infl = [];
    S.spec = null; save(); X.rerender();
  });
  const filters = el('div', { class: 'filters' },
    el('label', {}, 'Base item', baseSearch, el('datalist', { id: 'craft-bitems' }, names.map(n => el('option', { value: n })))),
    el('label', {}, 'Base type', el('select', { onchange: e => { A.base = e.target.value; A.bitem = ''; A.start = null; if (!I.bases[A.base]?.influence) A.infl = []; S.spec = null; save(); X.rerender(); } },
      groups.map(([g, G]) => el('optgroup', { label: G.name }, bases.filter(([, b]) => String(b.group) === g).map(([id, b]) => el('option', { value: id, selected: id === String(A.base) }, b.name)))))),
    el('label', {}, 'Item level', numberInput(A.ilvl, v => { A.ilvl = Math.max(1, Math.min(100, v || 86)); if (S.spec) S.spec.ilvl = A.ilvl; save(); X.rerender(); })),
    I.bases[A.base]?.influence && !exp(A.bitem)?.allInfl ? el('label', { title: 'An influenced item can\'t be fractured: adding an influence unticks "fractured"' }, 'Influences (up to 2)', el('span', { class: 'chips' }, I.influences.map(n => el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: A.infl.includes(n), onchange: e => {
        const infl = e.target.checked ? [...A.infl, n].slice(-2) : A.infl.filter(x => x !== n);
        // Keep the picks that still fit (not another influence's mods, no Eldritch implicits on
        // an influenced item), unless this combination already has picks of its own.
        const to = anyKey(A, infl);
        if (S.spec?.key === anyKey(A) && !(A.picks ?? {})[to]?.length) {
          const fits = T => (!C.INFLUENCES.includes(T.m.src) || infl.includes(T.m.src)) && !(infl.length && ELD(T.m));
          A.picks = { ...(A.picks ?? {}), [to]: S.spec.targets.filter(fits).map(T => ({ id: T.m.id, minTier: T.minTier, crafted: !!T.crafted, frac: !!T.frac && !infl.length, on: T.on })) };
        }
        A.infl = infl; A.start = null; S.spec = null; save(); X.rerender();
      } }), n)))) : null,
    el('button', { type: 'button', class: 'ghost', onclick: () => openPaste() }, 'Paste item from game'),
  );
  if (!B) { base(+A.base).then(() => X.rerender()); return [filters, el('p', { class: 'muted' }, 'Loading mods…')]; }
  const key = anyKey(A);
  if (!S.spec || S.spec.key !== key) {
    // Picks are remembered per base and influence.
    const saved = (A.picks ?? {})[key] ?? [];
    // Tiers are clamped: a hand-edited or stale link can name a tier the mod doesn't have.
    const targets = saved.map(p => ({ m: B.byId.get(p.id), p })).filter(x => x.m).map(({ m, p }) => {
      const t = Math.max(0, Math.min(p.minTier | 0, m.tiers.length - 1));
      return { m, minTier: t, orig: t, on: p.on !== false, crafted: !!p.crafted, frac: !!p.frac };
    });
    S.spec = { key, B, ilvl: A.ilvl, infl: [...(B.innateInfl ?? A.infl)], targets, useFractured: targets.some(T => T.frac), label: A.bitem || B.name, unmatched: [], eldritch: [] };
  }
  const spec = S.spec;
  spec.ilvl = A.ilvl;
  spec.label = A.bitem || B.name;
  // Your item from the game as the starting point (it decides what is fractured).
  const yours = A.start ? readStart(A.start.text, B) : null;
  if (A.start && !yours) { A.start = null; save(); }
  spec.start = yours?.start ?? null;
  if (yours) {
    spec.useFractured = false;
    // Pasted with nothing picked yet: its own mods are the first picks.
    if (A.start.seed) {
      if (!spec.targets.length) spec.targets = yours.match.mods.filter(x => !x.crafted).map(x => ({ m: B.byId.get(x.id), minTier: x.tier, orig: x.tier, on: true, crafted: false, frac: false }));
      delete A.start.seed; save();
    }
  }
  const picks = spec.targets.map(T => ({ id: T.m.id, minTier: T.minTier, crafted: !!T.crafted, frac: !!T.frac, on: T.on }));
  if (JSON.stringify(picks) !== JSON.stringify((A.picks ?? {})[key] ?? [])) { A.picks = { ...(A.picks ?? {}), [key]: picks }; save(); }
  return [filters,
    pasteBox(),
    yours ? yourItemCard(B, spec, yours) : null,
    el('div', { class: 'builder' }, itemCard(B, spec), modBrowser(B, spec, A, save)),
    ...(spec.targets.length ? specView(spec, { builder: true }) : [el('p', { class: 'muted' }, 'Add mods from the lists: click a mod to see its tiers, then click the lowest tier you\'d accept.')])];
}

// ---------- your item, pasted from the game ----------
// Opens the paste box (on the builder), reading the clipboard when the browser allows it.
async function openPaste(mode) {
  S.pasting = true;
  if (mode) { S.mode = mode; X.store.set('craftMode', mode); }
  X.rerender();
  try {
    const t = await navigator.clipboard?.readText?.();
    if (t && /^Rarity: /m.test(t) && t !== S.pasteText) { S.pasteText = t; X.rerender(); }
  } catch { /* no clipboard access: paste by hand */ }
}
// The parsed item and its mods on base B (null when it isn't this base or can't be read).
function readStart(text, B) {
  const it = parseItemText(text, S.index);
  // (An experimented base item is its own base: a Helical Ring isn't a plain ring.)
  const expName = S.index.experimented?.[it.bitem] ? it.bitem : undefined;
  if (it.error || it.base !== B.id || expName !== B.item) return null;
  const match = matchItem(B, it);
  return { it, match, start: { rarity: it.rarity, mods: match.mods.map(x => ({ id: x.id, tier: x.tier, side: x.side, crafted: x.crafted, frac: x.frac })), unknown: match.unknown, crafted: match.mods.some(x => x.crafted) } };
}
// Why an item can't be a starting point, if it can't.
const startProblem = it => it.error ?? (it.corrupted ? 'It\'s corrupted: currency can\'t change it any more.' : it.mirrored ? 'It\'s mirrored: it can\'t be changed.' : null);
function pasteBox() {
  const { el } = X;
  if (!S.pasting) return null;
  const ta = el('textarea', { class: 'pastetext', rows: 7, spellcheck: 'false', 'aria-label': 'Item text from the game',
    placeholder: 'In the game, hover the item and press Ctrl+Alt+C (or Ctrl+C), then paste it here with Ctrl+V.' });
  ta.value = S.pasteText ?? '';
  const prev = el('div', { class: 'pasteprev', 'aria-live': 'polite' });
  const show = () => { S.pasteText = ta.value; prev.replaceChildren(...pastePreview(ta.value)); };
  ta.addEventListener('input', show);
  show();
  if (!ta.value) setTimeout(() => ta.focus(), 0);
  return el('section', { class: 'pastebox', 'aria-label': 'Start from your item' },
    el('h4', {}, 'Start from an item you have'),
    el('p', { class: 'muted small' }, 'Ctrl+Alt+C copies each mod with its prefix/suffix and tier, which reads more reliably than Ctrl+C (that merges lines with the same stat). Crafted mods are left out: the bench removes them for free.'),
    ta, prev,
    el('div', { class: 'cardbtns' }, el('button', { class: 'ghost', onclick: () => { S.pasting = false; S.carry = null; X.rerender(); } }, 'Cancel')));
}
function pastePreview(text) {
  const { el } = X;
  if (!text.trim()) return [];
  const it = parseItemText(text, S.index);
  const bad = startProblem(it);
  if (bad) return [el('p', { class: 'status err' }, bad)];
  const B0 = baseNow(it.base);
  if (!B0) { base(it.base).then(() => { if (S.pasting) X.rerender(); }); return [el('p', { class: 'muted' }, 'Reading the mods…')]; }
  const B = itemBase(B0, it.bitem);
  const r = matchItem(B, it);
  return [
    el('p', {}, el('b', {}, it.bitem), ` (${it.rarity}${it.ilvl ? `, item level ${it.ilvl}` : ''}${it.infl.length ? ', ' + it.infl.join(' + ') : ''})`),
    r.mods.length || r.unread.length ? el('ul', { class: 'mods pastemods' },
      r.mods.map(x => el('li', { class: x.crafted ? 'muted' : '' }, C.modText(B.byId.get(x.id), x.tier), ' ',
        el('small', { class: 'muted' }, `${C.tierLabel(B.byId.get(x.id), x.tier, it.ilvl ?? 100)} ${x.side === 'p' ? 'prefix' : 'suffix'}${x.frac ? ', fractured' : ''}${x.crafted ? ', crafted: left out' : ''}`))),
      r.unread.map(t => el('li', { class: 'down' }, t.replace('\n', ' / '), ' ', el('small', {}, 'not recognised: counted as a junk mod'))),
      r.unknown.p + r.unknown.s - r.unread.length > 0 ? el('li', { class: 'muted' }, 'veiled mods: counted as junk') : null)
      : el('p', { class: 'muted' }, it.rarity === 'normal' ? 'A normal item: the plans start from it like a new base.' : 'No mods.'),
    el('button', { onclick: () => usePasted(it) }, 'Craft from this item'),
  ];
}
// Switch the builder to the pasted item's base and plan from it. The mods picked so far
// come along (from a popular build, too); with none, the item's own mods become the picks.
function usePasted(it) {
  const A = anyState();
  const prev = (S.carry ?? S.spec?.targets ?? []).filter(T => !(it.infl.length && ELD(T.m)));
  A.base = String(it.base); A.bitem = it.bitem; if (it.ilvl) A.ilvl = it.ilvl;
  A.infl = S.index.experimented?.[it.bitem]?.allInfl ? [] : it.infl.slice(0, 2);
  // (Picks that don't exist on this base drop out; if none are left, the item's own mods are picked.)
  A.start = { text: S.pasteText, seed: true };
  if (prev.length) A.picks = { ...(A.picks ?? {}), [anyKey(A)]: prev.map(T => ({ id: T.m.id, minTier: T.minTier, crafted: !!T.crafted, frac: false, on: T.on })) };
  S.carry = null; S.pasting = false; S.spec = null; S.mode = 'any';
  X.store.set('craftMode', 'any'); X.store.set('craftAny', A); X.rerender();
}
// The pasted item, each mod marked against the picks: wanted, a wrong tier of one, or junk.
function yourItemCard(B, spec, yours) {
  const { el } = X;
  const on = spec.targets.filter(T => T.on && !T.crafted);
  const status = x => {
    const m = B.byId.get(x.id);
    if (x.crafted) return ['muted', 'crafted: left out'];
    const T = on.find(T => C.sameMod(T.m, m));
    if (T) return C.meets(T, m, x.tier) ? ['up', 'wanted'] : ['down', 'wanted, but a lower tier'];
    const g = on.find(T => T.m.groups.some(gg => m.groups.includes(gg)));
    return g ? ['down', `blocks "${g.m.text}"`] : ['muted', 'junk'];
  };
  const { it, match } = yours;
  return el('section', { class: 'youritem', 'aria-label': 'Your item' },
    el('header', {}, el('b', {}, 'Starting from your item'), el('small', { class: 'muted' }, ` ${it.rarity} ${it.bitem}, item level ${it.ilvl ?? '?'}`),
      el('span', { class: 'cardbtns' },
        el('button', { class: 'ghost small', onclick: () => openPaste() }, 'Paste another'),
        el('button', { class: 'ghost small', onclick: () => { anyState().start = null; X.store.set('craftAny', S.any); X.rerender(); } }, 'Back to a new base'))),
    el('ul', { class: 'mods' },
      match.mods.map(x => { const [cls, why] = status(x); return el('li', {}, el('span', { class: cls === 'up' ? 'up' : '' }, C.modText(B.byId.get(x.id), x.tier)), ' ', el('small', { class: cls }, why + (x.frac ? ', fractured' : ''))); }),
      match.unread.map(t => el('li', {}, t.replace('\n', ' / '), ' ', el('small', { class: 'down' }, 'not recognised: counted as junk'))),
      !match.mods.length && !match.unread.length ? el('li', { class: 'muted' }, 'no mods') : null),
    el('p', { class: 'muted small' }, 'The plan marked "from your item" starts here; the others start from a new base, for comparison.'));
}

// The item being built: prefixes and suffixes with their slots, each pick editable.
function itemCard(B, spec) {
  const { el } = X;
  const on = spec.targets.filter(T => T.on);
  const bench = on.filter(T => T.crafted && !ELD(T.m));
  const used = side => on.filter(T => T.m.affix === side).length + (side === 's' && bench.length > 1 ? 1 : 0);
  const plans = on.length ? planFor(spec) : null;
  const best = Array.isArray(plans) ? plans.find(p => p.ok) : null;
  const setFrac = (T, v) => { for (const x of spec.targets) x.frac = false; T.frac = v; spec.useFractured = v; X.rerender(); };
  const row = T => el('li', { class: T.on ? '' : 'off' },
    el('span', { class: 'mt' }, C.modText(T.m, T.minTier), T.text && T.text !== C.modText(T.m, T.minTier) ? el('small', { class: 'muted' }, ` on the original: ${T.text.replace('\n', ' / ')}`) : null, ' ', catChips(T.m, 3)),
    el('span', { class: 'mctl' },
      T.crafted ? badge('Bench', 'Crafted at the bench last') : badge(ELD(T.m) ? 'Eldritch' : T.m.src === 'fossil' ? fossilFor(T.m)?.name ?? 'Fossil' : SRC_LABEL[T.m.src] ?? T.m.src),
      tierSelect(spec, T),
      !T.crafted && !ELD(T.m) ? el('label', { class: 'check' + (spec.infl.length ? ' off' : ''), title: spec.infl.length ? 'Influenced items can\'t be fractured' : 'Start from a base you buy with this mod fractured (its price isn\'t counted)' },
        el('input', { type: 'checkbox', checked: !!T.frac && !spec.infl.length, disabled: !!spec.infl.length, onchange: e => setFrac(T, e.target.checked) }), 'fractured') : null,
      el('label', { class: 'check', title: 'Leave it out of the plan without removing it' }, el('input', { type: 'checkbox', checked: T.on, onchange: e => { T.on = e.target.checked; X.rerender(); } }), 'use'),
      el('button', { class: 'linklike', 'aria-label': 'Remove ' + T.m.text, onclick: () => { spec.targets = spec.targets.filter(x => x !== T); if (T.frac) spec.useFractured = false; X.rerender(); } }, '✕')));
  const side = s => {
    const ts = spec.targets.filter(T => T.m.affix === s);
    const n = used(s), max = B.max[s];
    const empty = Math.max(0, max - n);
    return el('div', { class: 'slots' },
      el('h4', { class: n > max ? 'over' : '' }, `${SIDE[s]}es ${n}/${max}`, n > max ? ' — too many' : ''),
      el('ul', { class: 'mods' }, ts.map(row),
        s === 's' && bench.length > 1 ? el('li', { class: 'auto' }, el('span', { class: 'mt' }, 'Can have up to 3 Crafted Modifiers'), el('span', { class: 'mctl' }, badge('Bench', 'Needed for more than one bench craft'))) : null,
        Array.from({ length: empty }, () => el('li', { class: 'empty' }, `any ${SIDE[s].toLowerCase()}`))));
  };
  const eld = spec.targets.filter(T => ELD(T.m));
  return el('section', { class: 'itemcard', 'aria-label': 'Item being built' },
    el('header', {},
      el('b', { class: 'iname' }, spec.label),
      el('small', {}, `${B.name}, item level ${spec.ilvl}${spec.infl.length && !B.innateInfl ? ', ' + spec.infl.join(' + ') : ''}`),
      B.exp ? el('small', { class: 'expimp', title: 'Experimented base (Heist): its implicits can\'t be changed. Mod values shown include the magnitude bonus.' }, B.exp.implicits.join(' · ')) : null,
      el('span', { class: 'iprice' }, !on.length ? '' : best ? ['≈ ', el('b', { class: 'gold' }, money(best.cost)), el('small', { class: 'muted' }, ` ${best.name}`)]
        : plans?.error ? el('small', { class: 'down' }, 'planner error') : Array.isArray(plans) ? el('small', { class: 'down' }, 'no way found') : el('small', { class: 'working' }, 'working out the cost…'))),
    el('div', { class: 'sides' }, side('p'), side('s')),
    eld.length ? el('div', { class: 'slots' }, el('h4', {}, 'Eldritch implicits'), el('ul', { class: 'mods' }, eld.map(row))) : null,
    el('div', { class: 'cardbtns' },
      spec.targets.length ? linkButton() : null,
      spec.targets.length ? el('button', { class: 'ghost', onclick: () => { spec.targets = []; spec.useFractured = false; X.rerender(); } }, 'Clear all') : null));
}
function linkButton() {
  const { el } = X;
  const status = el('span', { class: 'muted small', role: 'status' });
  const btn = el('button', { class: 'ghost', onclick: async () => {
    const url = itemLink(S.any, S.spec);
    try { await navigator.clipboard.writeText(url); status.textContent = 'Link copied.'; }
    catch { const box = el('input', { type: 'text', value: url, readonly: true, 'aria-label': 'Link to this item', class: 'linkbox' }); status.replaceChildren(box); box.select(); }
  } }, 'Copy link to this item');
  return el('span', { class: 'linkwrap' }, btn, status);
}

// Every mod the base can have, prefixes and suffixes side by side; each opens to its tiers.
function modBrowser(B, spec, A, save) {
  const { el } = X;
  const it = C.newItem(B, { ilvl: spec.ilvl, infl: spec.infl, rarity: 'rare' });
  const pool = C.pool(it);
  const sideW = { p: 0, s: 0 };
  for (const e of pool) sideW[e.m.affix] += e.w;
  const wOf = new Map();
  for (const e of pool) { const r = wOf.get(e.m) ?? new Map(); r.set(e.t, e.w); wOf.set(e.m, r); }
  const mods = [...wOf.keys(),
    ...B.mods.filter(m => (m.src === 'essence' || m.src === 'veiled' || m.src === 'fossil' || (m.src === 'bench' && !m.meta)) && (m.affix === 'p' || m.affix === 's') && !wOf.has(m) && !C.baseBlocks(B, m))];
  // Influenced mods of the influences the item doesn't have yet (while it has room for one
  // more): picking one adds that influence.
  const canInfl = !!S.index.bases[A.base]?.influence;
  const INF = C.INFLUENCES;
  const newInfl = m => INF.includes(m.src) && !spec.infl.includes(m.src);
  if (canInfl && spec.infl.length < 2) mods.push(...B.mods.filter(m => newInfl(m) && (m.affix === 'p' || m.affix === 's') && m.tiers.some(t => t.w > 0)));
  const eldOk = B.info.eldritch && !spec.infl.length;
  if (eldOk) mods.push(...B.mods.filter(m => ELD(m) && m.tiers[0]?.w > 0));
  const chosen = new Map(spec.targets.map(T => [T.m, T]));
  const groupsTaken = new Map();
  for (const T of spec.targets) if (T.on) for (const g of T.m.groups) groupsTaken.set(g, T);
  const on = spec.targets.filter(T => T.on && !ELD(T.m));
  const full = s => on.filter(T => T.m.affix === s).length + (s === 's' && on.filter(T => T.crafted).length > 1 ? 1 : 0) >= B.max[s];
  const total = m => [...(wOf.get(m)?.values() ?? [])].reduce((a, w) => a + w, 0);
  const pick = (m, t) => {
    if (newInfl(m)) {
      // A new influence is a new spec: carry the picks over (Eldritch implicits can't stay,
      // influenced items don't get them).
      const infl = [...spec.infl, m.src];
      const keep = spec.targets.filter(T => !ELD(T.m)).map(T => ({ id: T.m.id, minTier: T.minTier, crafted: !!T.crafted, frac: false, on: T.on }));
      A.infl = infl;
      A.picks = { ...(A.picks ?? {}), [anyKey(A, infl)]: [...keep, { id: m.id, minTier: t, crafted: false, frac: false, on: true }] };
      S.spec = null; save(); X.rerender();
      return;
    }
    const T = chosen.get(m);
    if (T) { T.minTier = t; T.orig = t; T.on = true; } else spec.targets.push({ m, minTier: t, orig: t, on: true, crafted: m.src === 'bench' });
    X.rerender();
  };
  const srcKind = m => (INF.includes(m.src) ? 'infl' : m.src);
  const top = m => (ELD(m) ? 0 : topTier(m, spec.ilvl));
  const chanceText = m => {
    if (m.src === 'bench') { const c = m.cost?.[0]; return c ? Object.entries(c).map(([k, v]) => `${v} ${k.replace(/^Orb of /, '').replace(/ Orb$/, '')}`).join(', ') : 'bench'; }
    if (m.src === 'essence') return `essence (${m.essence})`;
    if (m.src === 'veiled') return 'veiled orbs';
    if (m.src === 'fossil') return fossilFor(m)?.name ?? 'fossil';
    if (newInfl(m)) return `adds ${SRC_LABEL[m.src]}`;
    const w = total(m);
    if (!w) return '–';
    return C.pctText(ELD(m) ? w / (sideW[m.affix] || 1) : w / sideW[m.affix] / 2);
  };
  const tierTable = m => {
    const tTop = top(m);
    const rows = m.tiers.map((tr, t) => ({ tr, t })).filter(({ t }) => !ELD(m) || m.tiers[t].w > 0).reverse();
    const sideTotal = (sideW[m.affix] || 1) * (ELD(m) ? 1 : 2);
    let acc = 0;
    const cum = new Map();
    for (const { t } of rows) { acc += wOf.get(m)?.get(t) ?? 0; cum.set(t, acc); }
    return el('div', { class: 'scroll' }, el('table', { class: 'tiers' },
      el('thead', {}, el('tr', {}, ['Tier', 'Values', 'Item level', m.src === 'bench' ? 'Bench cost' : 'This tier or better', ''].map(h => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, rows.map(({ tr, t }) => {
        const tooHigh = !ELD(m) && tr.ilvl > spec.ilvl;
        const T = chosen.get(m);
        const cur = T && T.minTier === t;
        const extra = m.src === 'bench' ? Object.entries(m.cost?.[Math.min(t, (m.cost?.length ?? 1) - 1)] ?? {}).map(([k, v]) => `${v} ${k}`).join(', ')
          : m.src === 'essence' ? (() => { const n = C.essenceName(m, t, S.index.essenceLevels); const v = price(n); const cap = C.ESSENCE_MOD_LEVEL[m.essence]; return `${n} (${isFinite(v) ? money(v) : 'no price'})${cap ? `; other mods level ${cap} and below` : ''}`; })()
          : m.src === 'fossil' ? `with ${fossilFor(m)?.name ?? 'a fossil'}`
          : newInfl(m) ? `picking it makes the item ${SRC_LABEL[m.src]}`
          : cum.get(t) ? C.pctText(cum.get(t) / sideTotal) : '–';
        return el('tr', { class: (cur ? 'cur ' : '') + (tooHigh ? 'off' : '') },
          el('td', {}, ELD(m) ? C.ELDRITCH_TIERS[t] : tooHigh ? '—' : C.tierLabel(m, t, spec.ilvl)),
          el('td', { class: 'l' }, C.modText(m, t)),
          el('td', {}, tr.ilvl),
          el('td', {}, extra),
          el('td', {}, tooHigh ? el('small', { class: 'muted' }, `item level ${tr.ilvl}+`)
            : el('button', { class: 'ghost small', 'aria-label': `Use ${C.modText(m, t)}${ELD(m) ? '' : ' or better'}`, onclick: () => pick(m, t) }, cur ? '✓ picked' : ELD(m) || m.src === 'bench' ? 'pick' : 'this or better')));
      }))));
  };
  const modRow = m => {
    const T = chosen.get(m);
    const clash = !T && m.groups.map(g => groupsTaken.get(g)).find(Boolean);
    const noRoom = !T && !ELD(m) && full(m.affix);
    const why = clash ? `Same mod group as "${clash.m.text}"` : noRoom ? `No ${SIDE[m.affix].toLowerCase()} slot left` : '';
    const drops = [spec.targets.some(x => ELD(x.m)) ? 'the Eldritch implicits' : '', spec.useFractured ? 'the fractured base' : ''].filter(Boolean);
    const note = !T && newInfl(m) ? `Picking it makes the item ${[...spec.infl, m.src].map(n => SRC_LABEL[n]).join(' + ')}-influenced${drops.length ? ` and drops ${drops.join(' and ')} (influenced items can't have ${drops.length > 1 ? 'either' : 'that'})` : ''}.` : '';
    S.openMods ??= new Set();
    return el('details', { class: 'mrow' + (T ? ' on' : '') + (why ? ' blocked' : ''), 'data-q': m.text.toLowerCase(), 'data-src': ELD(m) ? 'eld' : srcKind(m), 'data-inf': INF.includes(m.src) ? m.src : null, 'data-cats': modCats(m).join(' '), title: why || null,
      open: S.openMods.has(m.id), ontoggle: e => {
        const d = e.target;
        if (d.open) { S.openMods.add(m.id); if (!d.querySelector('table.tiers')) d.append(tierTable(m)); } else S.openMods.delete(m.id);
      } },
      el('summary', {},
        el('span', { class: 'mt' }, T ? '✓ ' : '', C.modText(m, top(m))),
        catChips(m, 3),
        el('span', { class: 'msrc' }, ELD(m) ? 'Eldritch' : SRC_LABEL[m.src] ?? m.src),
        el('span', { class: 'mch' }, chanceText(m))),
      why ? el('p', { class: 'muted small' }, why + '. You can still pick it; the planner will say it doesn\'t fit.') : null,
      note ? el('p', { class: 'muted small' }, note) : null,
      S.openMods.has(m.id) ? tierTable(m) : null);
  };
  const sortW = (a, b) => (b.src === 'base' || spec.infl.includes(b.src) ? 1 : 0) - (a.src === 'base' || spec.infl.includes(a.src) ? 1 : 0) || total(b) - total(a) || a.text.localeCompare(b.text);
  // Prefixes and suffixes always side by side; Eldritch implicits get their own row below.
  const col = ([s, title]) => {
    const ms = mods.filter(m => m.affix === s).sort(sortW);
    return el('div', { class: 'mcol' }, el('h4', {}, `${title} `, el('small', { class: 'muted', 'data-count': s }, `${ms.length}`)), ms.map(modRow));
  };
  const box = el('div', {},
    el('div', { class: 'mcols' }, [['p', 'Prefixes'], ['s', 'Suffixes']].map(col)),
    eldOk ? el('div', { class: 'mcols eld' }, [['r', 'Searing Exarch implicit (Embers)'], ['b', 'Eater of Worlds implicit (Ichors)']].map(col)) : null);
  // Filtering hides rows in place, so the search box keeps focus while typing.
  // Categories narrow down together: a mod must have every selected one.
  A.cats ??= [];
  const apply = () => {
    const q = (A.q ?? '').toLowerCase().trim(), src = A.src ?? '', cats = A.cats ?? [];
    for (const r of box.querySelectorAll('.mrow')) {
      const mc = r.dataset.cats.split(' ');
      r.hidden = (q && !r.dataset.q.includes(q)) || (src && (INF.includes(src) ? r.dataset.inf !== src : r.dataset.src !== src)) || !cats.every(c => mc.includes(c));
    }
    for (const c of box.querySelectorAll('[data-count]')) c.textContent = String(c.closest('.mcol').querySelectorAll('.mrow:not([hidden])').length);
  };
  const present = new Set(mods.flatMap(modCats));
  const catBar = el('div', { class: 'catbar', role: 'group', 'aria-label': 'Mod categories' },
    [...CATS.map(([k]) => k), 'other'].filter(k => present.has(k)).map(k => {
      const b = el('button', { type: 'button', class: 'cat c-' + k, 'aria-pressed': String(A.cats.includes(k)), onclick: () => {
        A.cats = A.cats.includes(k) ? A.cats.filter(x => x !== k) : [...A.cats, k];
        b.setAttribute('aria-pressed', String(A.cats.includes(k))); save(); apply();
      } }, CAT_LABEL[k]);
      return b;
    }),
    el('button', { type: 'button', class: 'linklike small', onclick: () => { A.cats = []; for (const b of catBar.querySelectorAll('button.cat')) b.setAttribute('aria-pressed', 'false'); save(); apply(); } }, 'clear'));
  const search = el('input', { type: 'search', placeholder: 'Filter mods', value: A.q ?? '', 'aria-label': 'Filter mods' });
  search.addEventListener('input', () => { A.q = search.value; save(); apply(); });
  const srcSel = el('select', { 'aria-label': 'Mod source', onchange: e => { A.src = e.target.value; save(); apply(); } },
    [...SRC_FILTERS.filter(([v]) => v !== 'infl' || canInfl), ...(canInfl ? INF.map(n => [n, `\u00a0\u00a0${SRC_LABEL[n]}`]) : [])]
      .map(([v, l]) => el('option', { value: v, selected: v === (A.src ?? '') }, l)));
  apply();
  return el('section', { class: 'browser', 'aria-label': 'All mods for this base' },
    el('div', { class: 'filters' }, el('label', {}, 'Search', search), el('label', {}, 'Source', srcSel)),
    catBar,
    box,
    el('p', { class: 'muted small' }, 'Chance: how likely one new random mod is this one at any tier the item level allows (its weight over its side\'s total, halved because a new mod is a prefix or a suffix about half the time). Open a mod for its tiers.'));
}
const topTier = (m, ilvl) => m.tiers.reduce((k, t, i) => (t.ilvl <= ilvl ? i : k), 0);

function numberInput(value, onchange) {
  const inp = X.el('input', { type: 'number', min: 1, max: 100, value });
  inp.addEventListener('change', () => onchange(Number(inp.value)));
  return inp;
}

// Tier picker for one target: "T2 or better", or an Eldritch tier.
function tierSelectFor(spec, T) {
  const { el } = X;
  const top = topTier(T.m, spec.ilvl);
  const opts = [];
  if (T.m.affix === 'r' || T.m.affix === 'b') {
    const ts = T.m.tiers.map((x, t) => t).filter(t => T.m.tiers[t].w > 0);
    return el('select', { 'aria-label': 'Eldritch tier for ' + T.m.text, onchange: e => { T.minTier = +e.target.value; X.rerender(); } },
      ts.map(t => el('option', { value: t, selected: t === T.minTier }, `${C.ELDRITCH_TIERS[t]}: ${C.modText(T.m, t).slice(0, 34)}`)));
  }
  for (let t = top; t >= 0; t--) opts.push(el('option', { value: t, selected: t === T.minTier }, `${C.tierLabel(T.m, t, spec.ilvl)} ${t < top ? 'or better' : ''} ${C.modText(T.m, t).replace(T.m.text.split('#')[0], '').slice(0, 26)}`));
  return el('select', { 'aria-label': 'Lowest tier for ' + T.m.text, onchange: e => { T.minTier = +e.target.value; X.rerender(); } }, opts);
}
const tierSelect = (spec, T) => (T.crafted ? badge(C.tierLabel(T.m, T.minTier, 100)) : tierSelectFor(spec, T));

// Targets, options and the ranked plans for a spec.
function specView(spec, view = {}) {
  const { el } = X;
  const B = spec.B;
  const tierSelect = T => tierSelectFor(spec, T);
  const setTolerance = d => { for (const T of spec.targets) T.minTier = d === 'any' ? 0 : Math.max(0, (T.orig ?? T.minTier) - d); X.rerender(); };
  const row = T => el('tr', { class: T.on ? '' : 'off' },
    el('td', {}, el('input', { type: 'checkbox', checked: T.on, 'aria-label': 'Include ' + T.m.text, onchange: e => { T.on = e.target.checked; X.rerender(); } })),
    el('td', { class: 'l' }, T.text ? el('span', {}, T.text.split('\n').flatMap((l, i) => (i ? [el('br'), l] : [l]))) : C.modText(T.m, T.minTier),
      el('small', { class: 'muted' }, ' ', C.modText(T.m, T.minTier)), catChips(T.m, 3)),
    el('td', {}, T.crafted ? badge('Bench', 'Crafted at the bench') : T.frac ? badge('Fractured', 'Fractured on the original') : badge(SRC_LABEL[T.m.src] ?? T.m.src)),
    el('td', {}, T.crafted ? C.tierLabel(T.m, T.minTier, 100) : tierSelect(T)));
  // Prefixes and suffixes side by side; Eldritch implicits underneath.
  const sideTable = (title, ts) => el('div', { class: 'scroll' }, el('table', { class: 'targets' },
    el('caption', {}, `${title} (${ts.length})`),
    el('thead', {}, el('tr', {}, ['Use', 'Mod (as on the item, then the tier\'s range)', 'Source', 'Lowest tier'].map(h => el('th', { scope: 'col', class: h.startsWith('Mod') ? 'l' : '' }, h)))),
    el('tbody', {}, ts.length ? ts.map(row) : el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'none')))));
  const eldTs = spec.targets.filter(T => T.m.affix === 'r' || T.m.affix === 'b');
  const rows = [el('div', { class: 'targets2' }, sideTable('Prefixes', spec.targets.filter(T => T.m.affix === 'p')), sideTable('Suffixes', spec.targets.filter(T => T.m.affix === 's'))),
    eldTs.length ? sideTable('Eldritch implicits', eldTs) : null];
  const out = [
    view.builder ? el('h3', { class: 'craft-h' }, 'How to craft it') : el('h2', { class: 'craft-h' }, spec.label),
    ...(view.builder ? [] : rows),
    spec.unmatched?.length ? el('p', { class: 'muted' }, 'Not craftable this way (drop-only, legacy or unknown): ', spec.unmatched.map(t => t.replace('\n', ' / ')).join('; '), '.') : null,
    spec.eldritch?.length ? el('p', { class: 'muted' }, 'Eldritch implicits on the original: ', spec.eldritch.map(e => e.text).join('; '), '.') : null,
    el('div', { class: 'filters' },
      view.builder ? null : el('label', {}, 'Item level', numberInput(spec.ilvl, v => { spec.ilvl = Math.max(1, Math.min(100, v || spec.ilvl)); if (S.any && spec.key.startsWith('a:')) { S.any.ilvl = spec.ilvl; X.store.set('craftAny', S.any); } X.rerender(); })),
      !view.builder && spec.targets.some(T => T.frac) && spec.infl.length ? el('small', { class: 'muted' }, 'The original has a fractured mod, but influenced items can\'t be fractured now: planned without it.') : null,
      !view.builder && spec.targets.some(T => T.frac) && !spec.infl.length ? el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: spec.useFractured, onchange: e => { spec.useFractured = e.target.checked; X.rerender(); } }), 'Start from a fractured base') : null,
      el('span', { class: 'segs small', role: 'group', 'aria-label': 'Tier tolerance' }, el('span', { class: 'muted' }, 'Tiers: '),
        el('button', { class: 'seg', onclick: () => setTolerance(0) }, 'As listed'),
        el('button', { class: 'seg', onclick: () => setTolerance(1) }, 'One lower OK'),
        el('button', { class: 'seg', onclick: () => setTolerance('any') }, 'Any tier')),
      el('button', { class: 'ghost', onclick: () => openInBench(spec) }, 'Open in the workbench'),
      view.builder ? null : el('button', { class: 'ghost', title: 'Paste an item you have (Ctrl+C in the game) and plan these mods from it', onclick: () => { S.carry = spec.targets; openPaste('any'); } }, 'Craft from my item')),
    optionsView(spec),
  ];
  if (!activeTargets(spec).length) { out.push(el('p', { class: 'muted' }, 'Pick at least one mod.')); return out; }
  const plans = planFor(spec);
  if (!plans) { out.push(el('p', { class: 'working', id: 'craft-progress', 'aria-live': 'polite' }, `Working out the best strategy: ${S.progress ?? ''}…`)); return out; }
  if (plans.error) { out.push(el('p', { class: 'status err' }, plans.error)); return out; }
  out.push(plansView(plans));
  out.push(pricesUsed(plans, spec));
  return out;
}
const badge = (t, title) => X.el('span', { class: 'badge', title }, t);

function plansView(plans) {
  const { el } = X;
  const ok = plans.filter(p => p.ok), bad = plans.filter(p => !p.ok && !p.hidden);
  const compare = plans.find(p => p.key === 'compare')?.compare;
  if (!ok.length) return el('div', {}, el('p', { class: 'empty' }, 'No method reaches all of these mods. Loosen a tier or untick a mod.'),
    bad.length ? el('ul', {}, bad.map(p => el('li', {}, `${p.name}: ${p.why}`))) : null);
  const best = ok[0].cost;
  const mirror = price('Mirror of Kalandra');
  const yoursBad = bad.find(p => p.fromItem);
  return el('div', { class: 'plans' },
    el('h3', {}, 'Ways to craft it, cheapest first'),
    yoursBad ? el('p', { class: 'status err' }, `From your item: ${yoursBad.why}`) : null,
    isFinite(mirror) ? el('p', { class: 'muted' }, `For scale: a Mirror of Kalandra is ${money(mirror)}. Anything costing more than that is cheaper to buy as a mirrored copy.`) : null,
    ok.slice(0, 10).map((p, i) => el('details', { class: 'plan', open: i === 0 },
      el('summary', {}, el('span', { class: 'rank' }, `${i + 1}`), el('b', {}, p.name),
        el('span', { class: 'cost' }, '≈ ', el('b', { class: 'gold' }, money(p.cost))),
        i ? el('small', { class: 'muted' }, best > 0 ? `${C.fmtN(p.cost / best)}× the first` : `${money(p.cost)} more`) : el('small', { class: 'badge new' }, 'cheapest'),
        p.fromItem ? el('small', { class: 'badge' }, 'from your item') : null,
        isFinite(mirror) && p.cost > mirror ? el('small', { class: 'badge warn' }, `${C.fmtN(p.cost / mirror)} mirrors`) : null),
      el('ol', { class: 'steps' }, p.steps.map((s, i) => el('li', { id: `${planId(p)}-s${i + 1}` },
        s.from ? el('small', { class: 'from' }, `When the item ${s.from}:`) : null,
        el('span', { class: 'steptext' }, richText(s.text)), ' ', resultsTrigger(s), s.results ? ' · ' : null, exampleTrigger(s.exFrom, s.ex),
        el('div', { class: 'stepnum' }, s.flow ? flowLine(s.flow, i, planId(p)) : s.p < 1 ? el('span', {}, `${C.pctText(s.p)} chance it moves on`) : null,
          // Confidence (as Craft of Exile shows it): the tries for a 66% and a 90% chance, 1 - (1 - P)^N.
          // Only for a step you actually repeat: its misses come back to it (a reforge, Alterations,
          // a slam that leaves the item as it was). A one-off move (a beast, a Fracturing Orb) that
          // hands a miss to another move isn't tried again and again.
          s.p > 0 && s.p < 0.5 && repeats(s, i) ? el('span', { title: 'Chance to have succeeded within N tries: 1 - (1 - P)^N. The average number of tries only gives about 63%.' },
            `66% sure in ${C.fmtN(C.triesAt(s.p, 0.66))} tries, 90% in ${C.fmtN(C.triesAt(s.p, 0.9))}`) : null,
          // Spent to get here and left from here (expected, so they add up to the plan's cost).
          s.fromHere != null ? el('span', { class: 'along', title: 'Expected costs: spent getting to this step, and still to pay from here (this step included). They add up to the plan\'s total.' },
            s.spent > 0.5 ? [el('span', {}, 'spent to get here ≈ ', el('b', {}, money(s.spent))), ' · '] : null,
            el('span', {}, 'from here ≈ ', el('b', { class: 'gold' }, money(s.fromHere))))
            : s.cost ? el('span', {}, `this step ≈ ${money(s.cost)}`) : null),
        stepCounts(s, i)))),
      el('p', { class: 'muted' }, 'This is the likeliest path. Each step is the cheapest move from that state, so a different roll just means following the strategy from wherever the item ends up.'),
      p.usage ? usageView(p.usage) : null,
      p.graph ? graphSection(p.graph, p.cost) : null,
      p.notes?.length ? el('p', { class: 'muted' }, p.notes.join(' ')) : null)),
    compare?.length ? compareView(compare) : null,
    bad.length ? el('details', { class: 'morefilters' }, el('summary', {}, `${bad.length} methods that don't fit`),
      el('ul', {}, bad.map(p => el('li', {}, `${p.name}: ${p.why}`)))) : null,
    el('details', { class: 'worked' }, el('summary', {}, 'How the costs are worked out'),
      el('ul', {},
        el('li', {}, 'The craft is a game of states: which wanted mods are on the item, which are blocked by a wrong tier of the same mod, how many junk mods sit on each side, and which mod (if any) is fractured. From every state the planner knows each move and where it can lead: reforges (Chaos, essences, fossils, Veiled Chaos, Eldritch Chaos, lock a side and Chaos), Fracturing Orb, slams (Exalt with a bench blocker or a metamod, Eldritch Exalt, Veiled Exalt), removals (Annul, Eldritch Annul, lock a side and Annul or Scour) and Farric beasts. Metamods: lock a side and Chaos or Harvest-reforge the other, "Cannot roll Attack/Caster" before a slam, and the multimod so a blocker and that metamod share one slam.'),
        el('li', {}, 'It then finds the cheapest strategy from every state at once (policy iteration on a Markov decision process: guess a strategy, solve its expected costs exactly, switch every state to its cheapest move, repeat). Progress is kept: an Annul that takes a wanted mod costs that mod, not the whole craft.'),
        el('li', {}, 'A reforge rolls 4 mods 8 times in 12, 5 mods 3 in 12 and 6 mods 1 in 12; each mod is drawn by weight from what can still roll (item level, free slot, no clashing mod group, fossil and metamod filters). Fossil combinations of up to four are scored by what their results are worth and the best three are tried.'),
        el('li', {}, 'Weights come from Craft of Exile\'s data (game files plus community-measured weights for veiled mods and Eldritch implicits). Prices are this hour\'s exchange prices; beasts aren\'t on the exchange, so they use editable estimates, and the Recombinator bench\'s gold and Thaumaturgic Dust are counted at editable values (dust is nearly free, gold free by default).'),
        el('li', {}, 'Harvest (lifeforce costs from Maxroll\'s 3.24 guide): reforge with a type (one guaranteed mod of that type, the type ten times as common), reforge more likely to keep the same types, and add a mod of a type (it removes another). Reforge keeping prefixes or suffixes is no longer in the game. Resistance swaps (500 lifeforce) are counted when a resistance rolls as the wrong element. Crystallised Rancour (Mirage) adds reforges with a minion, elemental, attribute, mana or drop mod, and fire/cold/lightning damage swaps; untick it under "Methods the planner may use" to leave it out.'))));
}

// What one try of a step uses, and how much of it to expect: before it moves on (66% / 90% of
// the time), and over the whole craft (the step comes back after a bricked item or a loop back).
function stepCounts(s, i) {
  const { el } = X;
  const items = Object.entries(s.bill ?? {}).filter(([, v]) => v > 0);
  if (!items.length) return null;
  const n = x => C.fmtN(Math.ceil(x - 1e-9));
  const value = items.reduce((a, [k, v]) => a + v * (price(k) || 0), 0);
  const list = k => items.flatMap(([name, v], j) => [j ? ', ' : '', el('b', {}, n(v * k)), ' ', curIcon(name), ' ', name]);
  const rows = [el('div', {}, el('span', { class: 'muted' }, 'One try: '), list(1), value > 0 ? ` (${money(value)})` : null)];
  if (s.p > 0 && s.p < 0.5 && repeats(s, i)) {
    const t66 = C.triesAt(s.p, 0.66), t90 = C.triesAt(s.p, 0.9);
    rows.push(el('div', {}, el('span', { class: 'muted' }, `Before it moves on, 66% sure in ${n(t66)} tries: `), list(t66),
      el('span', { class: 'muted' }, ` · 90% in ${n(t90)}: `), list(t90)));
  }
  const r = s.runs;
  if (r && r.mean > 0) {
    const again = r.mean > 1.05 * (s.p > 0 && s.p < 1 && repeats(s, i) ? 1 / s.p : 1);
    rows.push(el('div', { title: 'From the simulated crafts: how many times this step runs in a whole craft. That includes coming back to it after a bricked item (new base) or a result that sends the item back here. Crafts that never reach this step count as 0.' },
      el('span', { class: 'muted' }, `Whole craft${again ? ' (it comes back after bricks and set-backs)' : ''}: ${C.fmtN(r.mean)} tries on average${r.reached < 0.99 ? `, reached in ${C.pctText(r.reached)} of crafts` : ''}${r.q66 > 0 ? `; 66% of crafts need at most ${n(r.q66)}: ` : r.q90 > 0 ? '' : '.'}`), r.q66 > 0 ? list(r.q66) : null,
      r.q90 > 0 ? [el('span', { class: 'muted' }, ` · 90% at most ${n(r.q90)}: `), ...list(r.q90)] : null));
  }
  return el('div', { class: 'stepcounts' }, rows);
}
// Whether a step is tried again after a miss (most of its misses lead back to it).
function repeats(s, i) {
  if (!s.flow) return true;
  const miss = 1 - s.flow.filter(f => f.kind === 'on').reduce((a, f) => a + f.p, 0);
  const back = s.flow.filter(f => f.kind === 'again' || (f.kind === 'back' && f.to === i) || (f.kind === 'else' && (f.back === 'self' || f.back === i))).reduce((a, f) => a + f.p, 0);
  return miss > 0 && back >= 0.9 * miss;
}
// "2+: 12% · all 3: 0.4% (250 clicks)" from the chance of exactly j wanted mods per try.
function landsText(d) {
  if (!d || d.length < 2) return '';
  const n = d.length - 1, atLeast = j => d.slice(j).reduce((a, x) => a + x, 0);
  const parts = [];
  for (let j = Math.max(1, n - 2); j < n; j++) if (atLeast(j) > 1e-4) parts.push(`${j}+: ${C.pctText(atLeast(j))}`);
  const pAll = C.pctText(d[n]);
  parts.push(d[n] > 1e-6 ? `all ${n}: ${pAll}${pAll.startsWith('1 in') ? '' : ` (${C.fmtN(1 / d[n])} clicks)`}` : `all ${n}: never in one try`);
  return parts.join(' · ');
}
// A currency name in a table: its icon and the name ("Scorched + Prismatic" for fossils).
const nameWithIcons = r => (r.fossils ? r.fossils : [r.name]).flatMap((n, i) => [i ? ' + ' : '', curIcon(n), ' ', r.fossils ? n.replace(/ Fossil$/, '') : n]);
// Every way to start the craft, compared (the planner scores each against its final strategy):
// the best fossil combination of each size and the best overall, with what the fossils do to
// the picked mods, then essences, Harvest reforges and Chaos. Fossils you own count as free.
function compareView(rows) {
  const { el } = X;
  const spec = S.spec;
  const targets = (spec?.targets ?? []).filter(T => T.on && !T.crafted && (T.m.affix === 'p' || T.m.affix === 's'));
  const tagHit = (m, k) => k.split('+').every(t => m.tags.includes(t));
  const fossilInfo = name => S.index.fossils.find(f => f.name === name);
  const wants = k => targets.filter(T => tagHit(T.m, k));
  // What a fossil combination does here: boosts and blocks, good (green) or not (red).
  const effects = names => {
    const more = new Map(), less = new Map(), block = new Set();
    for (const f of names.map(fossilInfo).filter(Boolean)) {
      for (const [k, v] of Object.entries(f.more)) more.set(k, (more.get(k) ?? 1) * v);
      for (const [k, v] of Object.entries(f.less)) less.set(k, (less.get(k) ?? 1) * v);
      for (const k of f.block) block.add(k);
    }
    const tag = k => k.replace('+', ' ');
    const out = [];
    for (const [k, v] of more) { const w = wants(k); out.push(el('span', { class: w.length ? 'up' : 'down', title: w.length ? `Your ${w.map(T => `"${T.m.text}"`).join(', ')}` : 'None of your mods have this tag: more junk of it' }, `↑${tag(k)} ×${C.fmtN(v)}`)); }
    for (const k of block) { const w = wants(k); out.push(el('span', { class: w.length ? 'down' : 'up', title: w.length ? `Blocks your ${w.map(T => `"${T.m.text}"`).join(', ')}` : 'Junk of this tag can\'t roll' }, `✕${tag(k)}`)); }
    for (const [k, v] of less) { const w = wants(k); out.push(el('span', { class: w.length ? 'down' : 'up' }, `↓${tag(k)} ×${C.fmtN(v)}`)); }
    return out.flatMap((x, i) => (i ? [' ', x] : [x]));
  };
  const fos = rows.filter(r => r.kind === 'fossil');
  const bySize = [1, 2, 3, 4].map(n => fos.find(r => r.fossils.length === n)).filter(Boolean);
  const fossilRows = [...new Set([...fos.slice(0, 5), ...bySize])].sort((a, b) => a.R - b.R);
  const best = rows[0];
  const tr = (r, what) => el('tr', { class: r === best ? 'cur' : '' },
    el('td', { class: 'l' }, nameWithIcons(r), r.resonator ? el('small', { class: 'muted' }, ` in a ${r.resonator.replace(' Chaotic Resonator', '')} resonator`) : null,
      r.kind === 'fossil' && bySize.includes(r) ? el('small', { class: 'badge' }, `best with ${r.fossils.length}`) : null, r === best ? el('small', { class: 'badge new' }, 'cheapest start') : null),
    el('td', {}, money(r.cost)),
    el('td', { class: 'l small' }, landsText(r.hits)),
    // Only a reforge the plan keeps spamming has a stopping point worth showing.
    r.stop < 0.999 ? el('td', {}, `${C.fmtN(1 / Math.max(1e-12, r.stop))} (${C.pctText(r.stop)})`) : el('td', { class: 'muted', title: 'The plan does one of these, then moves on to whatever is cheapest from the result' }, 'once'),
    el('td', {}, r.stop < 0.999 ? money(r.alone) : '–'),
    el('td', {}, el('b', { class: 'gold' }, money(r.R))),
    el('td', { class: 'l small' }, what ?? ''));
  const group = (title, rs, what) => (rs.length ? [el('tr', { class: 'grp' }, el('th', { colspan: 7, scope: 'colgroup', class: 'l' }, title)), ...rs.map(r => tr(r, what?.(r)))] : []);
  const kinds = k => rows.filter(r => r.kind === k).slice(0, 6);
  // Fossils in the shown combinations: tick the ones you have.
  S.overrides ??= X.store.get('craftPrices', {});
  const shownFossils = [...new Set(fossilRows.flatMap(r => r.fossils))];
  const have = name => S.overrides[name] === 0;
  return el('details', { class: 'worked compare' },
    el('summary', {}, 'Ways to start, compared', best ? el('small', { class: 'muted' }, ` — cheapest: ${best.name}, ${money(best.R)} for the whole craft`) : null),
    el('p', { class: 'muted small' }, '"One try lands": the chance a single try rolls at least that many of your mods (and the clicks to get all of them at once). "Clicks": how many tries the plan spams it before moving on, with the chance per try; "once" means one try, then the cheapest move from whatever it rolled. "Whole craft": starting this way, then the cheapest strategy, comparable with the plans above (the Eldritch plans are separate).'),
    el('div', { class: 'scroll' }, el('table', { class: 'cmp' },
      el('thead', {}, el('tr', {}, ['Start with', 'Per try', 'One try lands', 'Clicks (good per try)', 'Spam until it stops', 'Whole craft', 'What it does'].map((h, i) => el('th', { scope: 'col', class: i === 0 || i === 2 || i === 6 ? 'l' : '' }, h)))),
      el('tbody', {},
        group('Fossils (best of each size, and the best overall)', fossilRows, r => effects(r.fossils)),
        group('Essences', kinds('essence'), () => 'forces its mod, the rest is random'),
        group('Harvest reforges', kinds('harvest'), () => 'one mod of the type for sure, that type ×10 more likely'),
        group('Chaos', kinds('chaos'), () => 'plain reroll'),
        group('Alteration and Regal', kinds('alt'), () => 'magic item with the core mods, then one more mod')))),
    shownFossils.length ? el('div', { class: 'havefossils' }, el('span', { class: 'muted small' }, 'Fossils you already have (counted free, so the plans re-rank): '),
      shownFossils.map(n => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: have(n), onchange: e => {
        if (e.target.checked) S.overrides[n] = 0; else delete S.overrides[n];
        X.store.set('craftPrices', S.overrides); X.rerender();
      } }), curIcon(n), ' ', n.replace(' Fossil', '')))) : null);
}

// Currency used by the plan, from simulated crafts that follow it: per currency the average,
// and how many cover 66% and 90% of crafts (each count on its own), most valuable first.
function usageView(u) {
  const { el } = X;
  const valueOnly = x => x.name === C.ELD_VALUE || x.name === C.DONOR_VALUE;
  const value = x => (valueOnly(x) ? 1 : price(x.name));
  const items = [...u.items].sort((a, b) => b.mean * (value(b) || 0) - a.mean * (value(a) || 0));
  if (!items.length) return null;
  const n = x => C.fmtN(Math.ceil(x));
  const eld = valueOnly;
  const line = items.filter(x => !eld(x) && x.q66 > 0).slice(0, 6).map(x => [el('b', {}, n(x.q66)), ' ', curIcon(x.name), ' ', x.name]);
  // Can the market supply it? Exchange items: compared with a day of all trading. Others (beasts,
  // Recombinators, ...) are bought one at a time from players: hundreds is a lot.
  const vol = x => (eld(x) ? null : X.exchangeVolume?.(x.name));
  const scarce = x => { if (eld(x) || x.name in C.FARMED_PRICES) return null; const v = vol(x); return v ? (x.q66 > 24 * v.perHour ? `more than a day of the whole exchange (${C.fmtN(v.perHour)} traded an hour)` : null) : x.q66 >= 100 ? 'not on the Currency Exchange: bought one at a time from players' : null; };
  const short = items.filter(scarce);
  return el('section', { class: 'usage' },
    el('h4', {}, 'Currency used'),
    line.length ? el('p', {}, '66% of crafts following this plan need at most ', line.flatMap((x, i) => (i ? [', ', ...x] : x)), items.length > 6 ? ', and a few more below.' : '.') : null,
    short.length ? el('p', { class: 'status err wide' }, 'Hard to get this many: ', short.flatMap((x, i) => [i ? '; ' : '', el('b', {}, n(x.q66)), ' ', curIcon(x.name), ' ', x.name, ` (${scarce(x)})`]), '.',
      short.some(x => /Farric|Craicic/.test(x.name)) ? ' Switch off "Farric beasts" above to plan without them.' : '', ' "Avoid" in the table re-plans without a currency.') : null,
    el('div', { class: 'scroll' }, el('table', { class: 'cmp' },
      el('thead', {}, el('tr', {}, ['Currency', 'Average', '66% need at most', '90% need at most', 'Average value', 'On the exchange', ''].map((h, i) => el('th', { scope: 'col', class: i ? '' : 'l' }, h)))),
      el('tbody', {}, items.map(x => el('tr', {},
        el('td', { class: 'l' }, eld(x) ? x.name : [curIcon(x.name), ' ', x.name]),
        el('td', {}, eld(x) ? '' : C.fmtN(x.mean)),
        el('td', {}, eld(x) ? '' : n(x.q66)),
        el('td', {}, eld(x) ? '' : n(x.q90)),
        el('td', {}, isFinite(value(x)) ? money(x.mean * value(x)) : '?'),
        el('td', { class: scarce(x) ? 'down' : 'muted' }, eld(x) ? '' : (v => (v ? `${C.fmtN(v.perHour)}/hour${isFinite(v.stock) && v.stock > 0 ? `, ${C.fmtN(v.stock)} listed` : ''}` : 'not listed'))(vol(x))),
        el('td', {}, eld(x) || x.name === C.CUR.chaos ? '' : el('button', { type: 'button', class: 'linklike small', title: 'Plan again without this currency (undo under "Prices used")',
          onclick: () => { S.overrides ??= X.store.get('craftPrices', {}); S.overrides[x.name] = 'off'; X.store.set('craftPrices', S.overrides); X.rerender(); } }, 'avoid'))))))),
    el('p', { class: 'muted small' }, `From ${u.runs} simulated crafts that follow this plan; each column counts that currency on its own, so the 66% figures together cover somewhat fewer than 66% of crafts.`,
      u.unfinished > 0.005 ? ` ${C.pctText(u.unfinished)} of them were still going after 200,000 moves, so the counts are a bit low.` : ''));
}

// Planner options: which extra methods it may use, saved in this browser.
function optionsView(spec) {
  const { el } = X;
  const o = planOptions();
  const set = (k, v) => { X.store.set('craftOptions', { ...X.store.get('craftOptions', {}), [k]: v }); X.rerender(); };
  // A switch: lit when the planner may use it. noAlt reads the other way round ("no ... spam").
  const sw = (k, label, title, icon = null) => {
    const on = !!o[k];
    return el('button', { type: 'button', class: 'seg sw' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(on), title, onclick: () => set(k, !on) },
      el('span', { class: 'dot', 'aria-hidden': 'true' }), icon ? curIcon(icon) : null, ' ', label);
  };
  // A value you set for a farmed resource (dust, gold), typed per 100k, saved with the prices.
  const per100k = (name, label) => {
    const inp = el('input', { type: 'number', min: 0, step: 0.5, value: isFinite(price(name)) ? +(price(name) * 1e5).toFixed(2) : '' });
    inp.addEventListener('change', () => {
      S.overrides ??= X.store.get('craftPrices', {});
      const v = Number(inp.value);
      if (inp.value === '' || !isFinite(v)) delete S.overrides[name]; else S.overrides[name] = Math.max(0, v) / 1e5;
      X.store.set('craftPrices', S.overrides); X.rerender();
    });
    return el('label', {}, label, inp);
  };
  const num = (k, label, step = 100) => { const inp = el('input', { type: 'number', min: 0, step, value: o[k] }); inp.addEventListener('change', () => set(k, Math.max(0, Number(inp.value) || 0))); return el('label', {}, label, inp); };
  return el('section', { class: 'methods', 'aria-label': 'Methods the planner may use' },
    el('span', { class: 'muted small' }, 'Methods the planner may use:'),
    el('div', { class: 'switches' },
      sw('hinekora', "Hinekora's Lock", 'One look at what the next currency will do; apply it only if good (a bad look spends the Lock). Magic items: the Craicic Croaker + Black Mórrigan recipe; rare items: the Hinekora\'s Lock currency, hundreds of divines', C.HK_LOCK),
      sw('matron', 'Wild Bristle Matron', 'Metamods from the Matron: a random one that fits an open side (1 prefix metamod, 4 suffix ones); a wrong one costs an Orb of Scouring to remove. Cheap when only the one you want fits', C.MATRON),
      sw('rancour', 'Crystallised Rancour', 'Harvest reforges with a minion, elemental, attribute, mana or drop mod, and fire/cold/lightning damage swaps (Mirage league)', C.RANCOUR),
      sw('beasts', 'Farric beasts', 'Farric Wolf / Lynx Alpha (move a mod to the other side) and Craicic Chimeral imprints. Beasts aren\'t on the Currency Exchange: they\'re caught or bought one at a time, so plans that need hundreds are hard to supply', C.CUR.wolf),
      sw('topEssence', 'Highest-tier essences only', 'Only the top essence level (Deafening; Shrieking for the few that stop there): it rolls the best tier, on some mods above what the mod can roll normally. Off: the planner may pick the level below when it\'s cheaper and still meets your tier', 'Deafening Essence of Greed'),
      sw('noAlt', 'No Alteration spam', 'Leave out plans that alterate a magic item (Alteration / Regal, Recombinator halves): usually costs more, with far fewer clicks', C.CUR.alt),
      sw('allflame', 'Allflame bench (Vesper)', 'Each currency shows several outcomes and you keep the best one; costs Dead Man\'s Sulphur'),
      spec.infl?.length === 2 ? sw('awakener', "Awakener's Orb route", 'Make one item per influence with the wanted influenced mod (influenced Exalted Orbs), then merge them', C.AWAKENER) : null,
      spec.infl?.length === 1 ? sw('influenceExalt', 'Influenced Exalted Orb at the end', 'Craft the other mods on a plain item, then add the influence and an influenced mod with a Crusader\'s/Hunter\'s/... Exalted Orb', C.influenceExalt(spec.infl[0])) : null,
      spec.infl?.length ? sw('influenceSetup', 'Count getting the influence', 'Add the cost of Harvest "randomise influence" (and an Awakener\'s Orb for two) to plans on a new base') : null),
    el('div', { class: 'filters' },
      sw('supplyCheck', 'Respect market supply', 'When the cheapest plan needs more of something than the market supplies (a share of a day of the whole Currency Exchange; for beasts and other items bought from players, a fixed number), price it up and plan again, so the planner finds another route instead of 1,500 beasts'),
      o.supplyCheck ? num('supplyShare', '% of a day of the exchange one craft can buy', 1) : null,
      o.supplyCheck ? num('playerSupply', 'Items bought from players, per craft', 5) : null,
      num('timeValue', 'Your time, chaos per hour', 10),
      el('p', { class: 'muted small' }, 'Time: about 2 seconds per currency used and a minute per item bought from a player (beasts), counted at your rate; 0 leaves time out.')),
    o.allflame ? el('div', { class: 'filters' },
      el('label', {}, 'Allflame outcomes you see', el('select', { onchange: e => set('allflameK', +e.target.value) }, [2, 3, 4].map(k => el('option', { value: k, selected: k === o.allflameK }, String(k))))),
      el('label', {}, 'Allflame crafts per item', el('select', { onchange: e => set('allflameUses', +e.target.value) }, [1, 2, 3, 4, 5, 6].map(k => el('option', { value: k, selected: k === o.allflameUses }, String(k))))),
      num('allflameIntang', 'Intangibility per craft (%)', 0.5),
      num('sulphur', 'Sulphur per craft'),
      num('sulphurFracture', 'Sulphur per fracture'),
      el('p', { class: 'muted small' }, 'Each Allflame craft adds 5-20% "Intangibility" to the item: the chance a later craft shows only one outcome. So the planner counts the Allflame crafts on each item (a new base starts again at 0): the second craft shows its outcomes 87.5% of the time at 12.5% per craft, the third 75%, and so on, up to the number of crafts set here. It saves them for the steps where a choice is worth the Sulphur. Sulphur grows with item level and currency (about 1,000-2,000 for most crafts, 50,000+ for a Fracturing Orb).')) : null,
    spec.B?.info?.recomb && !o.noAlt ? el('div', { class: 'filters' },
      el('span', { class: 'muted small' }, 'Recombinator bench, per use:'),
      num('recombDust', `${C.DUST}`, 10000),
      num('recombGold', 'Gold', 5000),
      per100k(C.DUST, 'Chaos per 100k dust'),
      per100k(C.GOLD, 'Chaos per 100k gold'),
      el('p', { class: 'muted small' }, `The bench (Kingsmarch, or in your hideout) takes gold and ${C.DUST}, about 100,000 dust and 50,000 gold a use for items with several mods; it grows with item level. Neither is on the exchange. Buying the uniques to disenchant is cheap (100,000+ dust a Chaos), but disenchanting takes time and the disenchanter's gold, and gold itself only comes from playing: put what that's worth to you into the two values (by default dust counts only the uniques, ${C.fmtN(C.FARMED_PRICES[C.DUST] * 1e5)}c per 100k, and gold nothing). Plans use unpredictable mode (predictable mode's odds aren't published).`)) : null);
}

// ---------- the state graph ----------
// The craft as a state machine: each box is a class of item states (how many
// wanted mods, prefixes/suffixes done, fractured, junk), each arrow a move the
// strategy makes, thicker when crafts take it more often.
function graphSection(g, exact) {
  const { el } = X;
  const det = el('details', { class: 'graph' }, el('summary', {}, 'State graph'));
  det.addEventListener('toggle', () => {
    if (!det.open || det.dataset.drawn) return;
    det.dataset.drawn = '1';
    det.append(
      el('p', { class: 'muted' }, `The craft as a state machine, from ${g.runs} simulated crafts that follow this strategy. Left to right: more wanted mods on the item. `,
        'Arrows are the moves the strategy makes; thicker ones happen more often per craft, and arrows that bend back are setbacks (an Annul that took a wanted mod, a slam that added junk). ',
        'Click a state to see every move from it and its expected cost to finish: the strategy simply takes the cheapest. With unlimited currency most moves get there; price decides which one.'),
      g.unfinished > 0.05
        ? el('p', { class: 'muted' }, `${C.pctText(g.unfinished)} of the simulated crafts were still going after 200,000 moves, so the graph shows where long crafts spend their time; the exact average is ${money(exact)}.`)
        : el('dl', { class: 'facts' },
          el('dt', {}, 'Simulated cost'), el('dd', {}, `median ${money(g.cost.p50)}; 1 in 10 crafts under ${money(g.cost.p10)}; 9 in 10 under ${money(g.cost.p90)}`),
          el('dt', {}, 'Average'), el('dd', {}, `${money(g.cost.mean)} simulated, ${money(exact)} exact`)),
      drawGraph(g));
  });
  return det;
}

function drawGraph(g) {
  const { el } = X;
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v); if (text != null) n.textContent = text; return n; };
  const W = 214, H = 70, PAD = 14;
  // Columns: base, magic stages, then by number of wanted mods, then done.
  const colOf = n => (n.start ? 0 : n.magic ? 1 : n.done ? g.K + 3 : n.ruined ? 0 : 2 + Math.max(0, n.c));
  const cols = new Map();
  for (const n of g.nodes) { const c = colOf(n); if (!cols.has(c)) cols.set(c, []); cols.get(c).push(n); }
  const usedCols = [...cols.keys()].sort((a, b) => a - b);
  for (const c of usedCols) cols.get(c).sort((a, b) => (a.ruined - b.ruined) || (b.frac - a.frac) || (a.junk - b.junk) || (b.share - a.share));
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const maxShare = Math.max(...g.edges.map(e => e.share), 0.01);
  const detail = el('div', { class: 'graphdetail', 'aria-live': 'polite' }, el('p', { class: 'muted' }, 'Click a state for its moves and costs.'));
  const hover = el('div', { class: 'expop graphhover', hidden: true, role: 'tooltip' });
  const tip = el('div', { class: 'graphtip', hidden: true, role: 'tooltip' });
  const svg = svgEl('svg', { role: 'group', 'aria-label': 'State graph of the craft', class: 'stategraph' });
  const view = el('div', { class: 'graphview' }, svg);
  const wrap = el('div', { class: 'graphwrap' }, view, hover, tip);
  let size = { w: 0, h: 0 }, vb = null;

  // Lay the graph out with the gaps between states multiplied by `spread`: more room for
  // arrows and labels, and more arrows get a label.
  function layout(spread) {
    const GX = 74 * spread + 60 * (spread - 1), GY = 14 + 26 * (spread - 1);
    const pos = new Map();
    let maxRows = 0;
    usedCols.forEach((c, ci) => {
      const list = cols.get(c);
      maxRows = Math.max(maxRows, list.length);
      list.forEach((n, ri) => pos.set(n.id, { x: PAD + ci * (W + GX), y: PAD + 22 + ri * (H + GY), col: ci }));
    });
    size = { w: PAD * 2 + usedCols.length * (W + GX) - GX, h: PAD * 2 + 22 + maxRows * (H + GY) + 40 + 30 * (spread - 1) };
    svg.replaceChildren();
    const defs = svgEl('defs');
    const marker = svgEl('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' });
    marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'arrowhead' }));
    defs.append(marker);
    svg.append(defs);
    usedCols.forEach((c, ci) => {
      const t = c === 0 ? 'Start' : c === 1 ? 'Magic' : c === g.K + 3 ? 'Finished' : `${c - 2} of ${g.K} wanted`;
      svg.append(svgEl('text', { x: PAD + ci * (W + GX) + W / 2, y: PAD + 8, 'text-anchor': 'middle', class: 'colhead' }, t));
    });
    // Edges first, under the boxes; labels on top of the edges.
    const eLayer = svgEl('g'), lLayer = svgEl('g');
    // An arrow's label: a currency becomes its icon (name on hover), the rest stays text.
    const labelAt = (x, y, text, anchor = 'middle') => {
      const I = iconIndex();
      const m = I.re ? [...text.matchAll(I.re)] : [];
      if (!m.length) { lLayer.append(svgEl('text', { x, y, 'text-anchor': anchor, class: 'elabel' }, text.length > 26 ? text.slice(0, 25) + '…' : text)); return; }
      const rest = text.replace(I.re, '').replace(/^[\s+,]+|[\s+,]+$/g, '').replace(/\s+/g, ' ');
      const iw = 18 * m.length, tw = rest ? rest.length * 6 + 3 : 0, total = iw + tw;
      const x0 = anchor === 'start' ? x : anchor === 'end' ? x - total : x - total / 2;
      const g2 = svgEl('g', { class: 'elabel-g' });
      // A padded, invisible hit area, so the pop-up is easy to trigger.
      g2.append(svgEl('rect', { x: x0 - 5, y: y - 17, width: total + 10, height: 25, rx: 3, class: 'elabel-hit' }));
      m.forEach((mm, i) => g2.append(svgEl('image', { href: I.map.get(mm[1]), x: x0 + i * 18, y: y - 13, width: 17, height: 17 })));
      if (rest) g2.append(svgEl('text', { x: x0 + iw + 3, y, 'text-anchor': 'start', class: 'elabel' }, rest.slice(0, 22)));
      g2.addEventListener('mouseenter', () => {
        tip.textContent = text;
        const r = g2.getBoundingClientRect(), w = wrap.getBoundingClientRect();
        tip.style.left = `${r.left - w.left + r.width / 2}px`; tip.style.top = `${r.top - w.top - 4}px`;
        tip.hidden = false;
      });
      g2.addEventListener('mouseleave', () => { tip.hidden = true; });
      lLayer.append(g2);
    };
    for (const e of g.edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const backward = b.col <= a.col;
      if (backward && e.share < maxShare * 0.08 / spread) continue; // the common setbacks (more when spread)
      const w = (backward ? 0.8 : 1) + (backward ? 2.5 : 5) * Math.sqrt(e.share / maxShare);
      let d, lx, ly, anchor = 'middle';
      if (b.col === a.col) {
        // Within a column: down along the right side, up along the left, so the two directions
        // (and their labels) never sit on top of each other.
        const down = b.y > a.y, bulge = (34 + 0.12 * Math.abs(b.y - a.y)) * spread;
        const x = down ? a.x + W : a.x, y1 = a.y + H / 2 + (down ? 8 : -8), y2 = b.y + H / 2 + (down ? -8 : 8);
        const cx = down ? x + bulge : x - bulge;
        d = `M${x},${y1} C${cx},${y1} ${cx},${y2} ${x + (down ? 2 : -2)},${y2}`;
        lx = down ? x + bulge * 0.75 + 4 : x - bulge * 0.75 - 4; ly = (y1 + y2) / 2 + 4; anchor = down ? 'start' : 'end';
      } else if (!backward) {
        const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2, mx = (x1 + x2) / 2;
        d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
        lx = mx; ly = (y1 + y2) / 2 - 5;
      } else {
        // Same column or backwards: an arc under the boxes.
        const x1 = a.x + W * 0.4, y1 = a.y + H, x2 = b.x + W * 0.6, y2 = b.y + H + 2;
        const dip = Math.max(y1, y2) + (26 + 10 * Math.abs(a.col - b.col)) * spread;
        d = `M${x1},${y1} C${x1},${dip} ${x2},${dip} ${x2},${y2}`;
        lx = (x1 + x2) / 2; ly = (y1 + 6 * dip + y2) / 8 + 12;
      }
      const path = svgEl('path', { d, class: 'edge' + (backward ? ' back' : ''), 'stroke-width': w.toFixed(1), 'marker-end': 'url(#arrow)' });
      path.append(svgEl('title', {}, `${e.action}${e.tries > 1.5 ? ` (about ${C.fmtN(e.tries)} tries)` : ''}: ${byId.get(e.from)?.label} → ${byId.get(e.to)?.label}. Taken ${C.pctText(e.p)} of the time from there, ${e.share.toFixed(2)} times per craft.${e.others.length ? ' Also: ' + e.others.join(', ') + '.' : ''}`));
      eLayer.append(path);
      // Name the busier moves on the arrow itself; spreading out names more of them.
      if (e.share >= maxShare * (backward ? 0.6 : 0.25) / (spread * spread)) labelAt(lx, ly, `${e.action}${e.tries > 1.5 ? ` ×${C.fmtN(e.tries)}` : ''}`, anchor);
    }
    svg.append(eLayer, lLayer);
    for (const n of g.nodes) svg.append(nodeBox(n, pos.get(n.id)));
  }

  function nodeBox(n, p) {
    const box = svgEl('g', { class: 'snode' + (n.done ? ' done' : n.ruined ? ' ruined' : n.start || n.magic ? ' start' : ''), transform: `translate(${p.x},${p.y})`, tabindex: 0, role: 'button', 'aria-label': `${n.label}. ${n.V != null ? 'About ' + money(n.V) + ' to finish.' : ''}` });
    box.append(svgEl('rect', { width: W, height: H, rx: 4 }));
    const parts = n.label.split(' · ');
    box.append(svgEl('text', { x: 8, y: 16, class: 'l1' }, parts[0].length > 32 ? parts[0].slice(0, 31) + '…' : parts[0]));
    // Details over up to two lines.
    const lines = [''];
    for (const t of parts.slice(1)) {
      const cur = lines[lines.length - 1];
      if (cur && (cur + ' · ' + t).length > 34) lines.push(t); else lines[lines.length - 1] = cur ? cur + ' · ' + t : t;
    }
    lines.slice(0, 2).forEach((t, i) => box.append(svgEl('text', { x: 8, y: 31 + i * 13, class: 'l2' }, t)));
    box.append(svgEl('text', { x: 8, y: 62, class: 'l3' }, n.done ? 'done' : `${n.V != null ? '≈ ' + money(n.V) + ' left' : ''}${n.share < 1 ? ` · ${C.pctText(n.share)} of crafts` : ''}`));
    box.append(svgEl('title', {}, n.label));
    const show = () => {
      for (const x of svg.querySelectorAll('.snode.sel')) x.classList.remove('sel');
      box.classList.add('sel');
      detail.replaceChildren(
        el('b', {}, n.label),
        n.desc ? el('p', { class: 'muted' }, `Typical item here: ${n.desc}.`) : null,
        exampleCard(n.ex, 'Example item in this state'),
        el('p', {}, n.done ? 'Finished.' : `${C.pctText(n.share)} of crafts pass through here, ${n.visits.toFixed(1)} times on average.${n.V != null ? ` Expected cost from here: ${money(n.V)}.` : ''}`),
        n.options?.length ? el('table', { class: 'mini' },
          el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'l' }, 'Move from here'), el('th', { scope: 'col' }, 'Expected cost to finish'), el('th', { scope: 'col' }, 'vs ✓'))),
          el('tbody', {}, n.options.slice(0, 10).map(o => {
            const base = (n.options.find(x => x.chosen) ?? n.options[0]).v;
            return el('tr', { class: o.chosen ? 'best' : '' }, el('td', { class: 'l', title: o.full }, richText(o.name), o.chosen ? ' ✓' : ''), el('td', {}, money(o.v)),
              el('td', {}, o.chosen ? '' : `+${C.fmtN(Math.max(0, o.v - base))}c`));
          }))) : null,
        n.options?.length ? el('p', { class: 'muted' }, 'Each cost is "do this now, then play the best strategy". The ✓ is what the strategy does.') : null);
    };
    box.addEventListener('click', ev => { if (!dragged) show(); ev.stopPropagation(); });
    box.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); show(); } });
    // Hover: the example item next to the state.
    box.addEventListener('mouseenter', () => {
      if (!n.ex || drag) return;
      hover.replaceChildren(el('b', {}, n.label), exampleCard(n.ex));
      const r = box.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      hover.style.left = `${Math.min(w.width - 580, Math.max(0, r.right - w.left + 8))}px`;
      hover.style.top = `${Math.max(0, r.top - w.top)}px`;
      hover.hidden = false;
    });
    box.addEventListener('mouseleave', () => { hover.hidden = true; });
    return box;
  }

  // ----- zoom and pan, inside the graph's own area -----
  const setVB = v => { vb = v; svg.setAttribute('viewBox', `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.w.toFixed(1)} ${v.h.toFixed(1)}`); };
  const area = () => { const r = view.getBoundingClientRect(); return { w: r.width || 1200, h: r.height || 520 }; };
  // Fit: the whole graph in view (zoomed out as far as needed).
  const fit = () => { const a = area(), k = Math.max(size.w / a.w, size.h / a.h, 0.5); setVB({ x: (size.w - a.w * k) / 2, y: (size.h - a.h * k) / 2, w: a.w * k, h: a.h * k }); };
  // Actual size, from the top left.
  const actual = () => { const a = area(); setVB({ x: 0, y: 0, w: a.w, h: a.h }); };
  const zoom = (f, cx = 0.5, cy = 0.5) => {
    if (!vb) fit();
    const w = Math.min(size.w * 4, Math.max(200, vb.w / f)), h = w * vb.h / vb.w;
    setVB({ x: vb.x + (vb.w - w) * cx, y: vb.y + (vb.h - h) * cy, w, h });
  };
  view.addEventListener('wheel', ev => {
    if (!ev.ctrlKey && !ev.metaKey) return; // a plain wheel scrolls the page
    ev.preventDefault();
    const r = view.getBoundingClientRect();
    zoom(ev.deltaY < 0 ? 1.15 : 1 / 1.15, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
  }, { passive: false });
  let drag = null, dragged = false;
  view.addEventListener('pointerdown', ev => { if (ev.button !== 0) return; drag = { x: ev.clientX, y: ev.clientY, vb: { ...vb }, id: ev.pointerId }; dragged = false; });
  view.addEventListener('pointermove', ev => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) { dragged = true; view.classList.add('panning'); hover.hidden = true; view.setPointerCapture(drag.id); }
    const a = area(), k = Math.max(drag.vb.w / a.w, drag.vb.h / a.h);
    setVB({ ...drag.vb, x: drag.vb.x - dx * k, y: drag.vb.y - dy * k });
  });
  const endDrag = () => { if (drag) { drag = null; view.classList.remove('panning'); setTimeout(() => { dragged = false; }, 0); } };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);

  S.graphSpread ??= X.store.get('graphSpread', 1.5);
  const spreadIn = el('input', { type: 'range', min: 1, max: 3, step: 0.25, value: S.graphSpread, 'aria-label': 'Spread the states apart' });
  spreadIn.addEventListener('input', () => { S.graphSpread = +spreadIn.value; X.store.set('graphSpread', S.graphSpread); layout(S.graphSpread); fit(); });
  const b = (label, title, fn) => el('button', { type: 'button', class: 'ghost small', title, onclick: fn }, label);
  const controls = el('div', { class: 'graphctl' },
    b('−', 'Zoom out', () => zoom(1 / 1.3)), b('+', 'Zoom in', () => zoom(1.3)), b('Fit', 'The whole graph', fit), b('1:1', 'Actual size', actual),
    el('label', {}, 'Spread ', spreadIn),
    el('small', { class: 'muted' }, 'Drag to move, Ctrl + wheel to zoom. Spreading out separates arrows and names more of them.'));
  layout(S.graphSpread);
  view.style.height = `${Math.round(Math.min(640, Math.max(380, size.h * 0.75)))}px`;
  // Once the area has a size: the whole graph if it's readable that way, otherwise actual size.
  requestAnimationFrame(() => { const a = area(); if (Math.max(size.w / a.w, size.h / a.h) <= 1.6) fit(); else actual(); });
  return el('div', {}, controls, wrap, detail);
}

function pricesUsed(plans, spec) {
  const { el } = X;
  const names = new Set();
  const words = /(Orb of [A-Z][a-z]+|[A-Z][a-z']+ (?:Orb|Bauble|Prism|Scrap)|(?:Deafening|Shrieking|Screaming) Essence of [A-Z][a-z]+|Essence of [A-Z][a-z]+|[A-Z][a-z]+ Fossil|[A-Z][a-z]+ Chaotic Resonator|[A-Z][a-z]+ Eldritch (?:Ember|Ichor)|Eldritch [A-Z][a-z]+ Orb|Eldritch Orb of Annulment|Craicic Chimeral|Farric (?:Wolf|Lynx) Alpha|[A-Z][a-z]+ Recombinator|Veiled (?:Chaos|Exalted) Orb|Fracturing Orb|Mirror of Kalandra)/g;
  for (const p of plans.filter(x => x.ok).slice(0, 10)) for (const s of p.steps) for (const m of s.text.matchAll(words)) names.add(m[1]);
  for (const n of [C.CUR.exalt, C.CUR.annul, C.CUR.divine, C.FRACTURE, 'Mirror of Kalandra']) names.add(n);
  if (plans.some(p => p.steps?.some(s => /Harvest/.test(s.text)))) for (const c of ['Wild', 'Vivid', 'Primal']) names.add(C.lifeforce(c)), names.add(C.SACRED);
  if (plans.some(p => p.steps?.some(s => /Rancour/.test(s.text)))) names.add(C.RANCOUR);
  if (plans.some(p => p.steps?.some(s => /Hinekora/.test(s.text)))) { names.add(C.HK_LOCK); for (const n of C.HK_SETUP) names.add(n); }
  for (const n of C.INFLUENCES.map(C.influenceExalt)) if (plans.some(p => p.steps?.some(s => s.text.includes(n)))) names.add(n);
  // Essences for essence-only targets, so a missing price can be typed in.
  for (const T of spec?.targets ?? []) if (T.on && T.m.src === 'essence') T.m.tiers.forEach((x, t) => { if (t >= T.minTier) names.add(C.essenceName(T.m, t, S.index.essenceLevels)); });
  const list = [...names].filter(n => !isNaN(price(n)) || priceInfo(n).src === 'unknown' || n.includes('Essence of')).sort();
  S.overrides ??= X.store.get('craftPrices', {});
  return el('details', { class: 'morefilters' }, el('summary', {}, 'Prices used (chaos)'),
    el('div', { class: 'prices' }, list.map(n => {
      const info = priceInfo(n);
      const inp = el('input', { type: 'number', min: 0, step: 'any', value: isFinite(info.v) ? +info.v.toPrecision(4) : '', 'aria-label': n });
      inp.addEventListener('change', () => {
        if (inp.value === '') delete S.overrides[n]; else S.overrides[n] = Number(inp.value);
        X.store.set('craftPrices', S.overrides); X.rerender();
      });
      return el('label', {}, el('span', {}, curIcon(n), ' ', n, ' ', el('small', { class: info.src === 'not used' ? 'down' : 'muted' }, info.src),
        info.src === 'not used' ? [' ', el('button', { type: 'button', class: 'linklike small', onclick: e => { e.preventDefault(); delete S.overrides[n]; X.store.set('craftPrices', S.overrides); X.rerender(); } }, 'use again')] : null), inp);
    })),
    el('p', { class: 'muted' }, '"exchange" is this hour\'s typical price; "estimate" is a rough default for things the exchange doesn\'t list; type your own to override (clear the box to undo). "not used": you told the planner to avoid it.'));
}

function sourcesNote() {
  return X.el('p', { class: 'muted small' }, `Mod weights and tiers: ${S.index.source}, built ${S.index.built}. Builds: poe.ninja. `,
    'The planner reads community-measured rules for the Recombinator bench (unpredictable mode) and Craft of Exile\'s for Orb of Dominance, eldritch dominance and veiled orbs; costs are expectations, so real crafts land above or below them.');
}

// ---------- workbench (emulator + simulator) ----------
function makeBench(spec) {
  S.wb = { B: spec.B, spec, item: C.newItem(spec.B, { ilvl: spec.ilvl, infl: spec.infl }), log: [], spent: {}, other: null, sim: null };
  if (spec.useFractured) for (const T of spec.targets.filter(t => t.frac && t.on)) S.wb.item.mods.push({ m: T.m, t: T.minTier, side: T.m.affix, frac: true });
}
function openInBench(spec) {
  makeBench(spec);
  S.mode = 'bench'; X.store.set('craftMode', 'bench'); X.rerender();
}

function benchView() {
  const { el } = X;
  if (!S.wb || (S.spec && S.wb.spec !== S.spec && !S.wb.log.length)) {
    if (S.spec) makeBench(S.spec);
    else return [el('p', { class: 'muted' }, 'Pick an item on "Popular builds" or a base on "Any base" first, then open it here.')];
  }
  const W = S.wb, it = W.item, B = W.B;
  const targets = activeTargets(W.spec);
  // What a currency can roll: bench crafts and fractured mods are added separately.
  const rollable = targets.filter(T => !T.crafted && !(T.frac && W.spec.useFractured));
  // Allflame bench: the currency shows up to k outcomes; you keep one (paid once, plus sulphur).
  const AF_OK = new Set(['alt', 'aug', 'regal', 'alch', 'chaos', 'exalt', 'annul', 'scour', 'essence', 'fossil', 'vchaos', 'vexalt', 'fracture', 'wolf', 'lynx']);
  const run = (action, arg) => {
    if (W.allflame && AF_OK.has(action)) {
      const k = Math.max(2, Math.min(4, W.afK ?? 3));
      const tries = Array.from({ length: k }, () => { const c = C.clone(it); return { item: c, res: C.apply(c, action, arg) }; }).filter(t => t.res.ok);
      if (!tries.length) { W.log.unshift({ action, ok: false, msg: C.apply(C.clone(it), action, arg).msg, cost: 0 }); X.rerender(); return; }
      const sul = (action === 'fracture' ? W.afSulFr ?? 50000 : W.afSul ?? 2000);
      const spent = { ...tries[0].res.spent, [C.SULPHUR]: sul };
      for (const [k2, v] of Object.entries(spent)) W.spent[k2] = (W.spent[k2] ?? 0) + v;
      W.log.unshift({ action, ok: true, msg: `Allflame bench: ${tries.length} outcomes to choose from`, cost: Object.entries(spent).reduce((a, [k2, v]) => a + v * price(k2), 0) });
      W.choices = tries;
      X.rerender();
      return;
    }
    const res = C.apply(it, action, arg);
    for (const [k, v] of Object.entries(res.spent)) W.spent[k] = (W.spent[k] ?? 0) + v;
    W.log.unshift({ action, ok: res.ok, msg: res.msg, cost: Object.entries(res.spent).reduce((a, [k, v]) => a + v * price(k), 0) });
    W.log.length = Math.min(W.log.length, 40);
    X.rerender();
  };
  const BTN_CUR = { transmute: C.CUR.transmute, alt: C.CUR.alt, aug: C.CUR.aug, regal: C.CUR.regal, alch: C.CUR.alch, chaos: C.CUR.chaos, exalt: C.CUR.exalt,
    annul: C.CUR.annul, scour: C.CUR.scour, fracture: C.FRACTURE, vchaos: C.CUR.vchaos, vexalt: C.CUR.vexalt, echaos: C.CUR.echaos, eexalt: C.CUR.eexalt,
    eannul: C.CUR.eannul, conflict: C.CUR.conflict, dominance: C.CUR.dominance, awaken: C.AWAKENER, harvest: 'Primal Crystallised Lifeforce', hmore: 'Wild Crystallised Lifeforce',
    hadd: 'Sacred Crystallised Lifeforce', hinfl: 'Primal Crystallised Lifeforce', hinflref: 'Sacred Crystallised Lifeforce',
    imprint: C.CUR.imprint, wolf: C.CUR.wolf, lynx: C.CUR.lynx, matron: C.MATRON };
  const btnCur = (action, arg) => (action === 'iexalt' && typeof arg === 'string' ? C.influenceExalt(arg) : BTN_CUR[action]);
  const btn = (label, action, arg, title) => el('button', { class: 'ghost', title: title ?? btnCur(action, arg), onclick: () => run(action, typeof arg === 'function' ? arg() : arg) },
    btnCur(action, arg) ? curIcon(btnCur(action, arg), label) : null, label);
  const total = Object.entries(W.spent).reduce((a, [k, v]) => a + v * price(k), 0);
  const hit = x => targets.some(T => C.meets(T, x.m, x.t));

  // Item card.
  const modLine = x => el('li', { class: (x.m && hit(x) ? 'hit' : '') + (x.crafted ? ' crafted' : '') + (x.frac ? ' frac' : '') },
    x.veiled ? el('i', {}, `Veiled ${x.side === 'p' ? 'prefix' : 'suffix'}`) : C.modText(x.m, x.t),
    el('small', { class: 'muted' }, ' ', x.veiled ? '' : `${C.tierLabel(x.m, x.t, it.ilvl)} ${SRC_LABEL[x.m.src] ?? x.m.src}${x.crafted ? ', crafted' : ''}${x.frac ? ', fractured' : ''}${x.elevated ? ', elevated' : ''}`));
  const dom = C.dominance(it);
  const card = el('div', { class: 'itemcard ' + it.rarity },
    el('b', {}, `${B.name}`), el('small', {}, ` ${it.rarity}, item level ${it.ilvl}${it.infl.length ? ', ' + it.infl.join(' + ') : ''}${it.imprint ? ', imprint saved' : ''}`),
    it.eld ? el('ul', { class: 'impl' }, ['r', 'b'].filter(k => it.eld[k]).map(k => el('li', {}, `${k === 'r' ? 'Searing Exarch' : 'Eater of Worlds'} (${C.ELDRITCH_TIERS[it.eld[k].t]}): ${C.modText(it.eld[k].m, it.eld[k].t)}`)),
      el('li', { class: 'muted' }, dom ? `Dominant: ${dom === 'p' ? 'prefixes (Exarch)' : 'suffixes (Eater)'}` : 'No dominance')) : null,
    el('div', { class: 'sides' }, ['p', 's'].map(side => el('div', {}, el('small', { class: 'muted' }, `${SIDE[side]}es ${C.count(it, side)}/${it.rarity === 'magic' ? 1 : B.max[side]}`),
      el('ul', { class: 'mods' }, it.mods.filter(x => x.side === side).map(modLine))))),
    it.veilOptions ? el('div', { class: 'veil' }, el('small', {}, 'Pick one:'), it.veilOptions.map((m, i) => el('button', { class: 'ghost', onclick: () => run('unveilPick', i) }, C.modText(m, 0)))) : null,
    targets.length ? el('p', { class: targets.every(T => it.mods.some(x => x.m === T.m && x.t >= T.minTier)) ? 'up' : 'muted' },
      `${targets.filter(T => it.mods.some(x => x.m === T.m && x.t >= T.minTier)).length} of ${targets.length} target mods`) : null);

  // Currency groups.
  const ess = B.mods.filter(m => m.src === 'essence' && m.essence);
  const essOpts = ess.flatMap(m => (m.corrupt || m.tiers.length === 1 ? [m.tiers.length - 1] : [m.tiers.length - 1, m.tiers.length - 2].filter(t => t >= 0)).map(t => ({ m, t, name: C.essenceName(m, t, S.index.essenceLevels) })));
  W.ess = Math.min(W.ess ?? 0, essOpts.length - 1);
  W.fossils ??= [];
  const benchMods = B.mods.filter(m => m.src === 'bench').flatMap(m => m.tiers.map((t, i) => ({ m, t: i })).filter(x => x.m.tiers[x.t].ilvl <= it.ilvl));
  W.benchSel = Math.min(W.benchSel ?? 0, benchMods.length - 1);
  W.eTier ??= 2;
  const fossils = S.index.fossils;
  const group = (title, ...kids) => el('fieldset', { class: 'cur' }, el('legend', {}, title), kids);
  const choiceView = W.choices ? el('div', { class: 'choices' }, el('b', {}, 'Allflame bench: keep one'),
    W.choices.map((c, i) => el('div', { class: 'choice' },
      el('ul', { class: 'mods' }, c.item.mods.map(x => el('li', { class: x.m && hit(x) ? 'hit' : '' }, x.veiled ? `Veiled ${x.side === 'p' ? 'prefix' : 'suffix'}` : C.modText(x.m, x.t), x.frac ? ' (fractured)' : ''))),
      el('button', { class: 'ghost', onclick: () => { W.item = c.item; W.choices = null; W.log.unshift({ ok: true, msg: `Kept outcome ${i + 1}`, cost: 0 }); X.rerender(); } }, `Keep ${i + 1}`)))) : null;
  const controls = el('div', { class: 'curgrid' },
    group('Options',
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: !!W.allflame, onchange: e => { W.allflame = e.target.checked; X.rerender(); } }), 'Allflame bench'),
      W.allflame ? el('select', { 'aria-label': 'Outcomes shown', onchange: e => { W.afK = +e.target.value; } }, [2, 3, 4].map(k => el('option', { value: k, selected: k === (W.afK ?? 3) }, `${k} outcomes`))) : null),
    group('Basic',
      btn('Transmute', 'transmute'), btn('Alteration', 'alt'), btn('Augment', 'aug'), btn('Regal', 'regal'), btn('Alchemy', 'alch'),
      btn('Chaos', 'chaos'), btn('Exalted', 'exalt'), btn('Annul', 'annul'), btn('Scour', 'scour'), btn('Fracture', 'fracture', null, 'Fracturing Orb: locks a random mod'),
      el('button', { class: 'ghost', onclick: () => { W.item = C.newItem(B, { ilvl: it.ilvl, infl: W.spec.infl }); W.log.unshift({ msg: 'New normal item', ok: true, cost: 0 }); X.rerender(); } }, 'New base')),
    essOpts.length ? group('Essence',
      el('select', { 'aria-label': 'Essence', onchange: e => { W.ess = +e.target.value; } }, essOpts.map((o, i) => el('option', { value: i, selected: i === W.ess }, `${o.name}: ${C.modText(o.m, o.t)}`))),
      el('button', { class: 'ghost', onclick: () => { const o = essOpts[W.ess]; run('essence', { mod: o.m, tier: o.t, name: o.name }); } }, 'Use')) : null,
    B.info.fossil ? group('Fossils (up to 4)',
      el('div', { class: 'chips' }, fossils.map(f => el('label', { class: 'check', title: describe(f) },
        el('input', { type: 'checkbox', checked: W.fossils.includes(f.name), onchange: e => { W.fossils = e.target.checked ? [...W.fossils, f.name].slice(-4) : W.fossils.filter(n => n !== f.name); X.rerender(); } }),
        f.name.replace(' Fossil', '')))),
      el('button', { class: 'ghost', disabled: !W.fossils.length, onclick: () => run('fossil', fossils.filter(f => W.fossils.includes(f.name))) }, 'Reforge')) : null,
    group('Veiled', btn('Veiled Chaos', 'vchaos'), btn('Veiled Exalt', 'vexalt'), btn('Unveil', 'unveil')),
    group('Harvest',
      el('select', { 'aria-label': 'Harvest type', onchange: e => { W.htag = e.target.value; } }, Object.keys(C.HARVEST_REFORGE).map(t => el('option', { value: t, selected: t === (W.htag ?? 'life') }, `${t} (${C.harvestText(t)})`))),
      btn('Harvest reforge', 'harvest', () => W.htag ?? 'life', 'Reforge with a guaranteed mod of this type; the type is more common'),
      btn('Add (removes another)', 'hadd', () => W.htag ?? 'life', 'Add a new mod of the chosen type and remove another random mod (non-influenced items; Sacred Lifeforce)'),
      btn('Reforge more likely', 'hmore', null, 'Reforge, much more likely to get the same mod types again (200 Wild)'),
      ...['Fire', 'Cold', 'Lightning'].map(e => btn(`Res → ${e}`, 'hswap', e, `Change another single resistance into ${e} (${C.RES_SWAP_AMOUNT} ${C.RES_SWAP[e]} Lifeforce)`)),
      ...['Fire', 'Cold', 'Lightning'].map(e => btn(`Damage → ${e}`, 'hdswap', e, `Change a fire/cold/lightning damage mod into a similar-tier ${e} one (${C.RES_SWAP_AMOUNT} ${C.RES_SWAP[e]} Lifeforce + ${C.DMG_SWAP_RANCOUR} Crystallised Rancour)`))),
    B.info.eldritch ? group('Eldritch',
      el('select', { 'aria-label': 'Ember and Ichor tier', onchange: e => { W.eTier = +e.target.value; } }, C.ELDRITCH_TIERS.slice(0, C.EMBER_MAX_TIER + 1).map((n, i) => el('option', { value: i, selected: i === W.eTier }, n))),
      btn('Ember', 'ember', () => W.eTier, 'Searing Exarch implicit (prefix side)'), btn('Ichor', 'ichor', () => W.eTier, 'Eater of Worlds implicit (suffix side)'),
      btn('Eldritch Chaos', 'echaos'), btn('Eldritch Exalt', 'eexalt'), btn('Eldritch Annul', 'eannul'), btn('Conflict', 'conflict')) : null,
    group('Influence',
      ...(it.infl.length ? [] : C.INFLUENCES.map(n => btn(C.influenceExalt(n).replace(' Exalted Orb', ' Exalt'), 'iexalt', n, `${C.influenceExalt(n)}: adds ${n} influence and one ${n} mod to a non-influenced rare`))),
      it.infl.length ? btn('Randomise influence', 'hinfl', null, `Harvest: new random influence types, and the item is reforged (${C.INFLUENCE_RANDOMISE[1]} ${C.INFLUENCE_RANDOMISE[0]} Lifeforce)`) : null,
      it.infl.length ? btn('Reforge with influenced mod', 'hinflref', null, `Harvest: reforge with at least one influenced mod (${C.HARVEST_INFLUENCE[1]} ${C.HARVEST_INFLUENCE[0]} Lifeforce + 1 Sacred)`) : null,
      it.infl.length === 1 ? el('select', { 'aria-label': 'Influence to awaken with', onchange: e => { W.awk = e.target.value; W.awkMod = ''; X.rerender(); } }, C.INFLUENCES.filter(n => !it.infl.includes(n)).map(n => el('option', { value: n, selected: n === W.awk }, `with a ${n} item`))) : null,
      ...(it.infl.length === 1 ? (() => {
        // The other item's influenced mod: random (a bought item) or the one you made on it.
        const inf = W.awk && !it.infl.includes(W.awk) ? W.awk : C.INFLUENCES.find(n => !it.infl.includes(n));
        const theirs = B.mods.filter(m => m.src === inf && (m.affix === 'p' || m.affix === 's'));
        return [
          el('select', { 'aria-label': "The other item's influenced mod", onchange: e => { W.awkMod = e.target.value; } },
            el('option', { value: '' }, 'its mod: random'), theirs.map(m => el('option', { value: m.id, selected: String(m.id) === String(W.awkMod) }, C.modText(m, topTier(m, it.ilvl)).slice(0, 60)))),
          btn("Awakener's Orb", 'awaken', () => { const m = theirs.find(x => String(x.id) === String(W.awkMod)); return m ? { infl: inf, mod: m, tier: topTier(m, it.ilvl) } : inf; },
            "Destroys the other item; yours becomes both influences, keeps one influenced mod from each item, and the rest is reforged"),
        ];
      })() : []),
      it.infl.length ? btn('Orb of Dominance', 'dominance') : null),
    group('Crafting bench',
      el('select', { 'aria-label': 'Bench craft', onchange: e => { W.benchSel = +e.target.value; } }, benchMods.map((b, i) => el('option', { value: i, selected: i === W.benchSel }, `${b.m.meta ? '★ ' : ''}${C.modText(b.m, b.t)} (${b.m.affix === 'p' ? 'prefix' : 'suffix'})`))),
      el('button', { class: 'ghost', onclick: () => run('bench', { mod: benchMods[W.benchSel].m, tier: benchMods[W.benchSel].t }) }, 'Craft'),
      btn('Remove crafted', 'unbench')),
    group('Beasts',
      btn('Imprint', 'imprint', null, 'Craicic Chimeral: save a magic item'), btn('Restore', 'restore'),
      btn('Prefix → suffix', 'wolf', null, 'Farric Wolf Alpha'), btn('Suffix → prefix', 'lynx', null, 'Farric Lynx Alpha'),
      btn('Wild Bristle Matron', 'matron', null, 'Adds a random craftable metamod that fits'),
      B.info.group !== 1 ? el('select', { 'aria-label': 'Aspect', onchange: e => { W.aspect = e.target.value; } }, Object.keys(C.ASPECTS).map(n => el('option', { value: n, selected: n === W.aspect }, `Aspect of the ${C.ASPECTS[n]}`))) : null,
      B.info.group !== 1 ? el('button', { class: 'ghost', onclick: () => run('aspect', W.aspect ?? Object.keys(C.ASPECTS)[0]) }, 'Add aspect') : null),
    B.info.recomb ? group(`Recombinator bench (${B.info.recomb.toLowerCase()}, unpredictable)`,
      el('button', { class: 'ghost', onclick: () => { W.other = C.clone(it); W.log.unshift({ msg: 'Saved this item as the second input', ok: true, cost: 0 }); X.rerender(); } }, 'Keep as 2nd item'),
      el('button', { class: 'ghost', disabled: !W.other, onclick: () => { const o = planOptions(); run('recombine', { other: W.other, dust: o.recombDust, gold: o.recombGold }); W.other = null; } }, 'Recombine with it')) : null,
  );

  // Simulator: hit rate of one action from the current item, against the exact odds.
  const simActions = [['chaos', 'Chaos Orb'], ['alt', 'Alteration'], ['vchaos', 'Veiled Chaos'], ['echaos', 'Eldritch Chaos'], ['exalt', 'Exalted Orb'],
    ...(essOpts.length ? [['essence', 'Selected essence']] : []), ...(W.fossils.length ? [['fossil', 'Selected fossils']] : [])];
  W.simAction ??= 'chaos';
  const simArg = a => (a === 'essence' ? (() => { const o = essOpts[W.ess]; return { mod: o.m, tier: o.t, name: o.name }; })() : a === 'fossil' ? fossils.filter(f => W.fossils.includes(f.name)) : null);
  const exactFor = a => {
    const T = rollable;
    if (!T.length) return null;
    try {
      if (a === 'chaos') { const s = C.clone(it); s.mods = s.mods.filter(x => x.frac); return C.odds(s, T, C.rerollDist(B, s.mods.length)); }
      if (a === 'alt') { const s = C.newItem(B, { ilvl: it.ilvl, infl: it.infl, rarity: 'magic' }); return C.odds(s, T, C.MAGIC_COUNTS); }
      if (a === 'exalt') return C.odds(it, T, [[1, 1]]);
      if (a === 'fossil') { const s = C.clone(it); s.mods = s.mods.filter(x => x.frac); s.rarity = 'rare'; return C.odds(s, T, C.rerollDist(B, s.mods.length), { fossils: simArg('fossil') }); }
      if (a === 'essence') { const o = essOpts[W.ess]; const s = C.clone(it); s.rarity = 'rare'; s.mods = [...s.mods.filter(x => x.frac), { m: o.m, t: o.t, side: o.m.affix }]; return C.odds(s, T, C.rerollDist(B, s.mods.length)); }
    } catch { return null; }
    return null;
  };
  const sim = el('div', { class: 'sim' },
    el('h3', {}, 'Simulator'),
    el('p', { class: 'muted' }, 'Applies one currency to copies of the current item many times and counts how often all the ticked target mods it can roll appear (bench crafts and the fractured mod left out), then compares with the exact odds.'),
    el('div', { class: 'filters' },
      el('label', {}, 'Currency', el('select', { onchange: e => { W.simAction = e.target.value; } }, simActions.map(([v, l]) => el('option', { value: v, selected: v === W.simAction }, l)))),
      el('button', { class: 'ghost', disabled: !rollable.length, onclick: () => {
        const a = W.simAction;
        const start = C.clone(it);
        if (a === 'chaos' || a === 'vchaos' || a === 'echaos' || a === 'exalt') start.rarity = start.rarity === 'normal' ? 'rare' : start.rarity;
        if (a === 'alt') { start.rarity = 'magic'; start.mods = []; }
        W.sim = { busy: true };
        X.rerender();
        setTimeout(() => {
          const t0 = performance.now();
          const r = C.simulate(start, a, simArg(a), rollable, 20000);
          W.sim = { ...r, exact: exactFor(a), action: a, ms: performance.now() - t0 };
          X.rerender();
        }, 20);
      } }, 'Simulate 20,000')),
    !targets.length ? el('p', { class: 'muted' }, 'Tick target mods first.') : null,
    W.sim?.busy ? el('p', { class: 'muted' }, 'Rolling…') : W.sim ? el('dl', { class: 'facts' },
      el('dt', {}, 'Hits'), el('dd', {}, `${W.sim.hits.toLocaleString('en-US')} of ${W.sim.n.toLocaleString('en-US')} (${C.pctText(W.sim.p)} ± ${C.pctText(W.sim.ci)})`),
      W.sim.exact != null ? [el('dt', {}, 'Exact odds'), el('dd', {}, C.pctText(W.sim.exact))] : null,
      el('dt', {}, 'Expected tries'), el('dd', {}, W.sim.p > 0 ? C.fmtN(1 / W.sim.p) : 'more than ' + C.fmtN(W.sim.n))) : null);

  return [
    el('div', { class: 'bench' }, card,
      el('div', {}, choiceView, controls,
        el('p', {}, 'Spent: ', el('b', { class: 'gold' }, money(total)), ' ', el('button', { class: 'linklike', onclick: () => { W.spent = {}; W.log = []; X.rerender(); } }, 'reset'),
          el('small', { class: 'muted' }, ' ', Object.entries(W.spent).map(([k, v]) => `${v} × ${k}`).join(', '))),
        el('ol', { class: 'log', reversed: true }, W.log.map(l => el('li', { class: l.ok ? '' : 'muted' }, l.msg, l.cost ? el('small', { class: 'muted' }, ` (${money(l.cost)})`) : null))))),
    sim,
  ];
}
function describe(f) {
  const parts = [];
  for (const [k, v] of Object.entries(f.more)) parts.push(`${k.replace('+', ' & ')} ×${v}`);
  for (const [k, v] of Object.entries(f.less)) parts.push(`${k.replace('+', ' & ')} ×${v}`);
  if (f.block.length) parts.push('no ' + f.block.join(', ').replace(/\+/g, ' & '));
  return parts.join('; ');
}
