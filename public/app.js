// Faustus Ledger UI: loads GGG's hourly Currency Exchange digests through the
// same-origin /api/cx proxy and renders the analyses from model.js.
import {
  CUR, CHAOS, DIVINE, EXALT, compact, leaguesOf, isPrivate, buildModel, rate, price, priceSeries,
  flips, spreads, oddTrades, prices, recipeRows, toRatio, routes, wholeUnits, routeHours, DEFAULTS, withDefaults,
  permanentLeagueOf, leagueEndRows, luggagePlan,
} from './model.js';
import { FORMULAS, PARAMS, PRESETS, LABS } from './formulas.js';
import { buildRecipes } from './recipes.js';
import { craftPanel } from './crafting.js';

const API = '/api/cx';
const HOUR = 3600;
const ROW_LIMIT = 100;
const TABS = ['picks', 'flips', 'routes', 'recipes', 'prices', 'spreads', 'odd', 'craft', 'craftr', 'leagueend', 'lab', 'guide'];
const ALCH = CUR + 'CurrencyUpgradeToRare';

const $ = (s, root = document) => root.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
};

// ---------- per-viewer settings ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('faustus:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('faustus:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Tunable coefficients (see DEFAULTS in model.js and the Formulas panel).
let P = withDefaults(store.get('params', {}));
function setParam(key, value) {
  setParams({ [key]: value });
}
// Change several coefficients at once (a preset), recalculating the page only once.
function setParams(values) {
  P = { ...P, ...values };
  const changed = Object.fromEntries(Object.entries(P).filter(([k, v]) => v !== DEFAULTS[k]));
  store.set('params', changed);
  hist = null; routeCache = null;
  if (state.pages.length) rebuild();
  // Keep the Formulas panel in step (its "default"/"reset" labels), without losing the scroll position.
  if (drawer().open && $('#drawer-title')?.textContent === 'Formulas and tuning') {
    const top = drawer().scrollTop, focusId = document.activeElement?.id;
    openFormulas();
    drawer().scrollTop = top;
    if (focusId) document.getElementById(focusId)?.focus();
  }
}

const state = {
  realm: store.get('realm', ''),
  window: store.get('hours', 1),
  tab: TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : store.get('tab', 'picks'),
  showPrivate: store.get('showPrivate', false),
  league: null, items: {}, recipes: [], pages: [], latest: null, m: null,
};
const gameOf = realm => realm === 'poe2' ? 'poe2' : 'poe1';
// Ruthless leagues (and private ones built on Ruthless, spotted by Alchemy being the busiest
// currency) trade in Orbs of Alchemy: Chaos and Divines barely trade there.
const RUTHLESS = /ruthless/i;
const alchLeague = () => RUTHLESS.test(state.league ?? '') || state.m?.hubs?.[0] === ALCH;
const defaultBases = realm => realm === 'poe2' ? [EXALT, DIVINE] : alchLeague() ? [ALCH, CHAOS] : [CHAOS, DIVINE];

const ui = store.get('ui', {});
const uiGet = (k, d) => ui[state.realm + ':' + k] ?? ui[k] ?? d;
const uiSet = (k, v, perRealm = false) => { ui[(perRealm ? state.realm + ':' : '') + k] = v; store.set('ui', ui); renderPanel(); };
// Volume filters for Alchemy (Ruthless) leagues: kept apart and much lower by default, since
// a busy Ruthless market trades a few Alchemy an hour in a few hours of the day.
const ALCH_DEFAULTS = { minVol: 1, minActive: 10, minHeld: 30, minRouteProfit: 1, minValue: 0.5, minOdd: 2 };
const fGet = (k, d) => alchLeague() ? uiGet(k + ':alch', ALCH_DEFAULTS[k] ?? d) : uiGet(k, d);
const fSet = (k, v) => uiSet(alchLeague() ? k + ':alch' : k, v);

// Starred items, per game.
const starKey = () => 'stars:' + gameOf(state.realm);
let stars = new Set(store.get(starKey(), []));
const toggleStar = id => { stars.has(id) ? stars.delete(id) : stars.add(id); store.set(starKey(), [...stars]); renderPanel(); };

// "New" badges: what wasn't on the list the last time this view was opened.
const prevSeen = new Map();
function newSince(key, ids) {
  if (!prevSeen.has(key)) {
    const before = store.get('seen:' + key, null);
    prevSeen.set(key, before ? new Set(before) : null);
    store.set('seen:' + key, ids);
  }
  return prevSeen.get(key);
}

// ---------- formatting ----------
function fmt(x) {
  if (x == null || !isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a >= 1000) return Math.round(x).toLocaleString('en-US');
  if (a >= 100) return x.toFixed(0);
  if (a >= 10) return x.toFixed(1);
  if (a >= 1) return x.toFixed(2);
  if (a === 0) return '0';
  return x.toPrecision(2);
}
const int = x => Math.round(x).toLocaleString('en-US');
const pct = x => x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : '') + (x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0) + '%';
const hourLabel = t => new Date(t * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const name = id => state.items[id]?.name ?? id.split('/').pop();
const short = id => name(id).replace(/ Orb$/, '').replace(/^Orb of /, '');
const goldFee = f => f == null ? '–' : f < 1 ? `1 per ${Math.round(1 / f)}` : fmt(f);
const wiki = id => (gameOf(state.realm) === 'poe2' ? 'https://www.poe2wiki.net/wiki/' : 'https://www.poewiki.net/wiki/') + encodeURIComponent(name(id).replace(/ /g, '_'));

function icon(id, size) {
  const it = state.items[id];
  const label = it?.name ?? name(id);
  if (it?.icon) return el('img', { src: it.icon, alt: label, title: label, loading: 'lazy', width: size, height: size, referrerpolicy: 'no-referrer' });
  return el('span', { class: 'ph', role: 'img', 'aria-label': label, title: label }, label[0]);
}
function itemCell(id, badges = []) {
  return el('span', { class: 'item' }, icon(id, 26),
    el('span', {}, el('span', { class: 'name', title: name(id) }, name(id), ...badges), el('small', {}, state.items[id]?.cat ?? '')));
}
const cur = id => el('span', { class: 'dir' }, icon(id, 18), ' ', short(id));
const badge = (text, cls, title) => el('span', { class: 'badge ' + cls, title }, text);
function starButton(id) {
  const on = stars.has(id);
  return el('button', { class: 'star' + (on ? ' on' : ''), 'aria-pressed': String(on), 'aria-label': (on ? 'Unstar ' : 'Star ') + name(id), title: on ? 'Starred' : 'Star this item',
    onclick: e => { e.stopPropagation(); toggleStar(id); } }, on ? '★' : '☆');
}
// "give 10 Chaos, get 1 Alteration": a price as the whole numbers you'd enter in game.
function ratioText(p, payId, getId) {
  const r = toRatio(p);
  if (!r) return '–';
  return `give ${r[0].toLocaleString('en-US')} ${short(payId)}, get ${r[1].toLocaleString('en-US')} ${short(getId)}`;
}

// ---------- fetching ----------
const cache = new Map();
function getHour(realm, t) {
  const key = (realm ? realm + '/' : '') + t;
  if (cache.has(key)) return cache.get(key);
  const once = () => fetch(`${API}/${key}`, { signal: AbortSignal.timeout(45000) }).then(async r => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Exchange API answered ${r.status} for hour ${t}`);
    return { t, markets: compact((await r.json()).markets || []) };
  });
  // Old hours can be slow the first time anyone asks for them; give each two tries.
  const p = once().catch(() => once());
  cache.set(key, p);
  p.then(v => { if (v === null) cache.delete(key); }, () => cache.delete(key));
  return p;
}
async function findLatest(realm) {
  // Hour H is published once it has ended: usually the previous hour, or the one
  // before right after the turn of the hour.
  const now = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  for (let t = now - HOUR; t >= now - 6 * HOUR; t -= HOUR) {
    // A just-published hour can be slow to serve. If it doesn't answer within a few
    // seconds, show the hour before; auto-update picks the new one up when it lands.
    const slow = t === now - HOUR ? new Promise(r => setTimeout(() => r('slow'), 6000)) : null;
    const got = await (slow ? Promise.race([getHour(realm, t), slow]) : getHour(realm, t)).catch(() => null);
    if (got && got !== 'slow') return t;
  }
  throw new Error('No exchange data published in the last six hours.');
}
async function loadPages(realm, latest, n, onProgress) {
  const ts = Array.from({ length: n }, (_, i) => latest - (n - 1 - i) * HOUR);
  const out = new Array(n); let done = 0, next = 0, failed = 0;
  // An hour that still fails after its retry is skipped rather than sinking the whole load.
  const worker = async () => { while (next < ts.length) { const i = next++; out[i] = await getHour(realm, ts[i]).catch(() => { failed++; return null; }); onProgress(++done, n); } };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (failed === n) throw new Error('every hour failed to load');
  return { pages: out.filter(Boolean), failed };
}
async function loadItems(game) {
  const r = await fetch(`data/items-${game}.json`);
  if (!r.ok) throw new Error(`Missing data/items-${game}.json (run npm run items:build).`);
  return (await r.json()).items;
}

// ---------- shared bits ----------
function table(cols, rows, sortKey, onSort, onRow) {
  cols = cols.filter(Boolean);
  const [key, dir] = sortKey;
  const col = cols.find(c => c.key === key) || cols[0];
  const sv = col.sort || (r => r[col.key]);
  rows = rows.slice().sort((a, b) => {
    const x = sv(a), y = sv(b);
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * (dir === 'asc' ? 1 : -1);
  });
  const head = el('tr', {}, cols.map(c => el('th', {
    class: c.cls, scope: 'col', tabindex: c.label ? 0 : null, title: c.title,
    'aria-sort': c.key === col.key ? (dir === 'asc' ? 'ascending' : 'descending') : null,
    onclick: () => c.label && onSort([c.key, c.key === col.key && dir === 'desc' ? 'asc' : 'desc']),
    onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.target.click(); } },
  }, c.label, c.f && infoButton(c.f))));
  const tbody = el('tbody');
  let shown = 0;
  const more = el('button', { class: 'ghost', onclick: () => addRows() });
  const addRows = () => {
    for (const r of rows.slice(shown, shown + ROW_LIMIT)) {
      tbody.append(el('tr', onRow ? { class: 'click', tabindex: 0, onclick: () => onRow(r), onkeydown: e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onRow(r); } } } : {},
        cols.map(c => el('td', { class: c.cls }, c.cell(r)))));
    }
    shown += ROW_LIMIT;
    more.textContent = `Show more (${rows.length - shown} left)`;
    more.hidden = shown >= rows.length;
  };
  addRows();
  if (!rows.length) return el('p', { class: 'empty' }, 'Nothing matches these filters. Try lowering the numbers under "More filters".');
  return el('div', {}, el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, head), tbody)), el('div', { class: 'more' }, more));
}

function spark(series, w = 90, h = 22) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  if (series.length < 2) return svg;
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const vs = series.map(s => s.v), min = Math.min(...vs), span = Math.max(...vs) - min || 1;
  const p = document.createElementNS(svg.namespaceURI, 'path');
  p.setAttribute('d', 'M' + series.map(s => `${((s.t - t0) / (t1 - t0 || 1)) * (w - 2) + 1},${h - 2 - ((s.v - min) / span) * (h - 4)}`).join('L'));
  svg.append(p);
  return svg;
}

// A small line chart with a value axis and start/end times. lines: [{label, cls, points:[{t,v}], band?}]
function chart(lines, unit) {
  const W = 640, H = 200, L = 56, R = 10, T = 10, B = 26;
  const pts = lines.flatMap(l => l.points.flatMap(p => [p.v, ...(l.band && p.lo != null ? [p.lo, p.hi] : [])])).filter(isFinite);
  const ts = lines.flatMap(l => l.points.map(p => p.t));
  const wrap = el('figure', { class: 'chart' });
  if (pts.length < 2) { wrap.append(el('p', { class: 'muted' }, 'Not enough hours traded to draw a chart.')); return wrap; }
  let min = Math.min(...pts), max = Math.max(...pts);
  if (min === max) { min *= 0.95; max *= 1.05; }
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const X = t => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R), Y = v => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Hourly price in ${unit}`);
  const add = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text != null) n.textContent = text; svg.append(n); return n; };
  for (const v of [min, (min + max) / 2, max]) {
    add('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: 'grid' });
    add('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'axis' }, fmt(v));
  }
  add('text', { x: L, y: H - 6, class: 'axis' }, hourLabel(t0));
  add('text', { x: W - R, y: H - 6, 'text-anchor': 'end', class: 'axis' }, hourLabel(t1));
  for (const l of lines) {
    if (l.band) {
      const b = l.points.filter(p => p.lo != null);
      if (b.length > 1) add('path', { class: 'band', d: 'M' + b.map(p => `${X(p.t)},${Y(Math.min(max, p.hi))}`).join('L') + 'L' + b.slice().reverse().map(p => `${X(p.t)},${Y(Math.max(min, p.lo))}`).join('L') + 'Z' });
    }
    if (l.points.length) add('path', { class: 'line ' + l.cls, d: 'M' + l.points.map(p => `${X(p.t)},${Y(p.v)}`).join('L') });
  }
  wrap.append(svg);
  if (lines.length > 1 || lines[0].label) {
    wrap.append(el('figcaption', { class: 'legend' }, lines.map(l => el('span', {}, el('i', { class: 'key ' + l.cls }), l.label))));
  }
  return wrap;
}

function select(id, options, value, onchange) {
  return el('select', { id, onchange: e => onchange(e.target.value) },
    options.map(([v, label]) => el('option', { value: v, selected: v === value }, label)));
}
const hubOptions = M => M.hubs.map(h => [h, name(h)]);
function categoryFilter(ids, value) {
  const cats = [...new Set(ids.map(id => state.items[id]?.cat).filter(Boolean))].sort();
  return el('label', {}, 'Category', select('cat', [['', 'All'], ...cats.map(c => [c, c])], value, v => uiSet('cat', v)));
}
function searchBox(value) {
  const inp = el('input', { type: 'search', placeholder: 'Item name', value, 'aria-label': 'Search items' });
  let t; inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => uiSet('q', inp.value), 250); });
  return el('label', {}, 'Search', inp);
}
function numberBox(label, value, onchange, title) {
  const inp = el('input', { type: 'number', min: 0, value, title });
  inp.addEventListener('change', () => onchange(Number(inp.value) || 0));
  return el('label', {}, label, inp);
}
const starredOnly = f => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: f.starred, onchange: e => uiSet('starred', e.target.checked) }), 'Starred only');
function moreFilters(...kids) {
  const d = el('details', { class: 'morefilters', open: uiGet('moreOpen', false) }, el('summary', {}, 'More filters'), el('div', { class: 'filters' }, kids));
  d.addEventListener('toggle', () => { ui.moreOpen = d.open; store.set('ui', ui); });
  return d;
}
// The suggested luggage list, folded away when the reader closes it; open or closed is remembered.
function luggageSection(luggage) {
  const section = el('details', { class: 'luggage-section', open: uiGet('luggageOpen', true) },
    el('summary', {}, el('h3', {}, 'Suggested luggage')),
    luggage);
  section.addEventListener('toggle', () => {
    ui.luggageOpen = section.open;
    store.set('ui', ui);
  });
  return section;
}
const baseFilters = () => ({ cat: uiGet('cat', ''), q: uiGet('q', ''), starred: uiGet('starred', false) });
const matches = (id, f) => (!f.cat || state.items[id]?.cat === f.cat) && (!f.q || name(id).toLowerCase().includes(f.q.toLowerCase())) && (!f.starred || stars.has(id));

// ---------- history, loaded only when asked for ----------
// The tables use the chosen window (the last hour by default). Charts and the
// odd-trade scan need a day of history, fetched the first time something asks.
let hist = null;
function historyModel() {
  if (state.window >= 24) return Promise.resolve(state.m);
  const key = `${state.realm}|${state.league}|${state.latest}`;
  if (hist?.key !== key) {
    hist = { key, p: loadPages(state.realm, state.latest, 24, () => {}).then(({ pages }) => (hist.model = buildModel(pages, state.league, state.items, P))) };
    hist.p.catch(() => { hist = null; });
  }
  return hist.p;
}
// The day of history if it's already loaded, else null.
const loadedHistory = () => state.window >= 24 ? state.m : hist?.key === `${state.realm}|${state.league}|${state.latest}` ? hist.model ?? null : null;

function withHistory(title, show) {
  openDrawer(title, el('p', { class: 'muted' }, 'Loading the last 24 hours…'));
  historyModel().then(H => {
    if (drawer().open && $('#drawer-title')?.textContent === title) show(H);
  }, e => $('#drawer-body').append(el('p', { class: 'status err' }, `Couldn't load the last 24 hours: ${e.message}`)));
}

// ---------- formulas: "?" popovers, the Formulas panel, worked examples ----------
function formulaBlock(key) {
  const F = FORMULAS[key];
  return el('div', { class: 'formula' }, el('b', {}, F.title), el('pre', {}, F.formula), el('p', {}, F.text),
    F.rows && el('table', { class: 'mini' }, el('thead', {}, el('tr', {}, ['Price', 'Book', 'Likely meaning'].map(t => el('th', { scope: 'col' }, t)))),
      el('tbody', {}, F.rows.map(r => el('tr', {}, r.map(c => el('td', {}, c)))))),
    F.note && el('p', { class: 'note' }, F.note));
}
function infoButton(key) {
  const id = 'pop-' + key;
  if (!document.getElementById(id)) {
    document.body.append(el('div', { id, popover: '', class: 'pop', role: 'dialog', 'aria-label': FORMULAS[key].title },
      formulaBlock(key),
      el('button', { class: 'ghost', onclick: () => { document.getElementById(id).hidePopover(); openFormulas(key); } }, 'Change the numbers behind it')));
  }
  // Clicking "?" must not also sort the column.
  return el('button', { class: 'info', type: 'button', popovertarget: id, 'aria-label': `How ${FORMULAS[key].title} is calculated`, onclick: e => e.stopPropagation(), onkeydown: e => e.stopPropagation() }, '?');
}
// Worked arithmetic for a detail panel: [label, formula with numbers, result].
const worked = rows => el('details', { class: 'worked' }, el('summary', {}, 'How these numbers were calculated'),
  el('dl', {}, rows.flatMap(([label, expr, result]) => [el('dt', {}, label), el('dd', {}, el('code', {}, expr), ' = ', el('b', {}, result))])));

function paramInput(def) {
  const v = P[def.key];
  if (def.type === 'select') return select('param-' + def.key, def.options, v, val => setParam(def.key, val));
  const inp = el('input', { type: 'number', id: 'param-' + def.key, value: v, step: def.step ?? 1, min: def.min ?? 0, max: def.max });
  inp.addEventListener('change', () => { const n = Number(inp.value); setParam(def.key, isFinite(n) ? n : DEFAULTS[def.key]); });
  return inp;
}
// The preset whose every value matches the current coefficients, or null when they were tuned by hand.
function activePreset() {
  for (const preset of PRESETS) {
    let allMatch = true;
    for (const [key, value] of Object.entries(preset.values)) {
      if (P[key] !== value) {
        allMatch = false;
      }
    }
    if (allMatch) {
      return preset;
    }
  }
  return null;
}
// One button per preset; the one in use is marked. onApplied runs after a preset is applied.
function presetPicker(onApplied) {
  const current = activePreset();
  const buttons = [];
  for (const preset of PRESETS) {
    const isCurrent = current === preset;
    const button = el('button', {
      class: isCurrent ? 'ghost preset current' : 'ghost preset',
      title: preset.help,
      'aria-pressed': isCurrent ? 'true' : 'false',
      onclick: () => {
        setParams(preset.values);
        onApplied();
      },
    }, preset.label);
    buttons.push(button);
  }
  const description = current ? current.help : 'Your own values (no preset matches them).';
  return el('div', { class: 'presets' },
    el('span', { class: 'presets-label' }, 'Presets'),
    buttons,
    el('small', { class: 'muted' }, description));
}
function openFormulas(focusKey) {
  const groups = Object.keys(FORMULAS).map(k => {
    const params = PARAMS.filter(d => d.formula === k);
    return el('section', { class: 'fgroup', id: 'f-' + k }, formulaBlock(k),
      params.map(d => el('div', { class: 'param' },
        el('label', { for: 'param-' + d.key }, d.label),
        el('span', { class: 'unit' }, paramInput(d), d.unit ?? ''),
        P[d.key] !== DEFAULTS[d.key] ? el('button', { class: 'linklike', onclick: () => { setParam(d.key, DEFAULTS[d.key]); openFormulas(k); } }, `Reset to ${DEFAULTS[d.key]}`) : el('span', { class: 'muted' }, 'default'),
        d.help && el('small', {}, d.help))));
  });
  openDrawer('Formulas and tuning',
    el('p', { class: 'lede' }, 'Every number on the page comes from these formulas. Change a value and the whole page recalculates. Your values are saved in this browser only.'),
    el('p', {}, el('button', { class: 'ghost', onclick: () => { for (const d of PARAMS) P[d.key] = DEFAULTS[d.key]; setParam('haircut', DEFAULTS.haircut); openFormulas(); } }, 'Reset everything'),
      ' ', el('button', { class: 'ghost', onclick: () => { drawer().close(); state.tab = 'lab'; renderPanel(); } }, 'Try them in the Lab')),
    presetPicker(() => openFormulas()),
    ...groups);
  if (focusKey) $('#f-' + focusKey)?.scrollIntoView({ block: 'start' });
}

// ---------- detail drawer ----------
const drawer = () => $('#drawer');
let returnFocus = null;
function openDrawer(title, ...kids) {
  const d = drawer();
  if (!d.open) returnFocus = document.activeElement;
  $('#drawer-body').replaceChildren(el('h2', { id: 'drawer-title' }, title), ...kids);
  if (!d.open) d.showModal();
}

function openFlip(r, H) {
  const M = state.m, { x, A, B } = r;
  const h = flips(H, A, B).find(f => f.x === x) ?? r; // the same flip over the last 24 hours
  const sA = rate(H, x, A)?.series ?? [];
  const bSeries = new Map((rate(H, x, B)?.series ?? []).map(s => [s.t, s.v]));
  const conv = new Map((rate(H, B, A)?.series ?? []).map(s => [s.t, s.v]));
  const viaB = [...bSeries].map(([t, v]) => ({ t, v: v * (conv.get(t) ?? r.conv) }));
  const [buyIn, sellFor] = r.buyWithA ? [A, B] : [B, A];

  // Calculator: typical prices, editable with what the exchange shows right now.
  const f = {
    budget: el('input', { type: 'number', min: 0, value: Math.round(r.buyWithA ? Math.max(r.pA * 10, rate(M, DIVINE, A)?.med ?? 100) : r.conv * Math.max(1, Math.ceil(r.rateB * 10))) }),
    buy: el('input', { type: 'number', min: 0, step: 'any', value: +(r.buyWithA ? r.pA : r.rateB).toPrecision(4) }),
    sell: el('input', { type: 'number', min: 0, step: 'any', value: +(r.buyWithA ? r.rateB : r.pA).toPrecision(4) }),
    conv: el('input', { type: 'number', min: 0, step: 'any', value: +r.conv.toPrecision(4) }),
  };
  const out = el('div', { class: 'calc-out', 'aria-live': 'polite' });
  const fee = id => state.items[id]?.fee ?? 0;
  function calc() {
    const budget = +f.budget.value, buy = +f.buy.value, sell = +f.sell.value, cv = +f.conv.value;
    if (!(budget > 0 && buy > 0 && sell > 0 && cv > 0)) { out.replaceChildren(el('p', { class: 'muted' }, 'Fill in all four numbers.')); return; }
    let steps, spent, back, gold;
    if (r.buyWithA) {
      const n = Math.floor(budget / buy);              // items bought with A
      const gotB = Math.floor(n * sell);                // whole B from selling them
      back = Math.floor(gotB * cv);                     // whole A from converting B
      spent = n * buy;
      gold = n * fee(x) + gotB * fee(B) + back * fee(A);
      steps = [
        `Buy ${int(n)} ${name(x)} for ${int(spent)} ${short(A)} (${ratioText(buy, A, x)}).`,
        `Sell them for ${int(gotB)} ${short(B)} (${ratioText(1 / sell, x, B)}).`,
        `Convert ${int(gotB)} ${short(B)} back to ${int(back)} ${short(A)}.`,
      ];
    } else {
      const gotB = Math.floor(budget / cv);             // B bought with A
      const n = Math.floor(gotB / buy);                 // items bought with B
      back = Math.floor(n * sell);                      // whole A from selling them
      spent = gotB * cv;
      gold = gotB * fee(B) + n * fee(x) + back * fee(A);
      steps = [
        `Convert ${int(spent)} ${short(A)} into ${int(gotB)} ${short(B)}.`,
        `Buy ${int(n)} ${name(x)} with them (${ratioText(buy, B, x)}).`,
        `Sell them for ${int(back)} ${short(A)} (${ratioText(1 / sell, x, A)}).`,
      ];
    }
    const profit = back - spent;
    out.replaceChildren(...[
      el('ol', { class: 'steps' }, steps.map(s => el('li', {}, s))),
      el('p', { class: 'result' }, 'Result: ', el('b', { class: profit > 0 ? 'up' : 'down' }, `${profit > 0 ? '+' : ''}${fmt(profit)} ${short(A)}`),
        ` (${pct(profit / spent)}), paying `, el('b', { class: 'gold' }, `${fmt(gold)} gold`), '.'),
      profit <= 0 && el('p', { class: 'muted' }, 'Not profitable at these prices. Whole-unit rounding eats small gaps on small budgets, so try a bigger budget.'),
    ].filter(Boolean));
  }
  for (const i of Object.values(f)) i.addEventListener('input', calc);
  calc();
  const fld = (label, input, unit) => el('label', {}, label, el('span', { class: 'unit' }, input, unit));

  openDrawer(name(x),
    el('p', { class: 'lede' }, `Buy with ${name(buyIn)}, sell for ${name(sellFor)}. Over the last ${H.hours} hours the gap pointed this way in ${h.held} of ${h.both} hours.`,
      h.jump > P.jumpy / 100 ? ' Prices jump around a lot from hour to hour, so check the live ratio first.' : ''),
    chart([{ label: `In its ${short(A)} market`, cls: 'a', points: sA }, { label: `In its ${short(B)} market, converted`, cls: 'b', points: viaB }], short(A)),
    el('dl', { class: 'facts' },
      el('dt', {}, `Typical, in ${short(A)} market`), el('dd', {}, `${fmt(r.pA)} ${short(A)}`),
      el('dt', {}, `Typical, in ${short(B)} market`), el('dd', {}, `${fmt(r.rateB)} ${short(B)} = ${fmt(r.pB)} ${short(A)}`),
      el('dt', {}, 'Traded per hour'), el('dd', {}, `${fmt(r.volA / M.hours)} for ${short(A)}, ${fmt(r.volB / M.hours)} for ${short(B)}`),
      el('dt', {}, 'Gold fee per unit'), el('dd', {}, `${short(x)} ${goldFee(state.items[x]?.fee)}, ${short(A)} ${goldFee(state.items[A]?.fee)}, ${short(B)} ${goldFee(state.items[B]?.fee)}`)),
    worked([
      ['Value via B', `${fmt(r.rateB)} × ${fmt(r.conv)}`, `${fmt(r.pB)} ${short(A)}`],
      ['Gap', `${fmt(Math.max(r.pA, r.pB))} ÷ ${fmt(Math.min(r.pA, r.pB))} − 1`, pct(r.roi)],
      ['Net per item', `${fmt(Math.max(r.pA, r.pB))} × (1 − ${P.haircut / 100})³ − ${fmt(Math.min(r.pA, r.pB))}${P.goldValue ? ` − ${fmt(r.gold)} × ${P.goldValue} ÷ 100,000` : ''}`, `${fmt(r.net)} ${short(A)}`],
      ['Items per hour', `min(${fmt(r.volA / M.hours)}, ${fmt(r.volB / M.hours)})`, fmt(r.thin)],
      ['Profit per hour', `max(0, ${fmt(r.net)}) × ${fmt(r.thin)}`, `${fmt(r.perHour)} ${short(A)}`],
      ['Gold per item', 'fees on everything received', fmt(r.gold)],
      ['Held', `${r.held} ÷ ${r.both} hours`, r.both ? pct(r.held / r.both).replace('+', '') : '–'],
    ]),
    el('h3', {}, 'Trade calculator'),
    el('p', { class: 'muted' }, 'Prefilled with typical prices. In game, hold Alt on the exchange to see the live ratios and type them in here.'),
    el('div', { class: 'calc' },
      fld('Budget', f.budget, short(A)),
      fld(`1 ${short(x)} costs`, f.buy, short(buyIn)),
      fld(`1 ${short(x)} sells for`, f.sell, short(sellFor)),
      fld(`1 ${short(B)} is worth`, f.conv, short(A))),
    out,
    el('p', { class: 'links' }, starButton(x), ' ', el('a', { href: wiki(x), target: '_blank', rel: 'noopener' }, 'Wiki page')),
  );
}

function openItem(id, base, H) {
  const p = price(state.m, id, base);
  const series = priceSeries(H, id, base);
  const d = !p.via && rate(H, id, base);
  openDrawer(name(id),
    el('p', { class: 'lede' }, `Typically ${fmt(p.v)} ${short(base)}`, p.via ? ` (priced through ${name(p.via)})` : '', '. ',
      d ? `In game: ${ratioText(p.v, base, id)}.` : ''),
    chart([{ label: d ? 'Hourly average, with low–high band' : '', cls: 'a', points: d ? d.series : series, band: !!d }], short(base)),
    el('dl', { class: 'facts' },
      el('dt', {}, 'Category'), el('dd', {}, state.items[id]?.cat ?? '–'),
      el('dt', {}, 'Gold fee'), el('dd', {}, goldFee(state.items[id]?.fee) + ' per unit received'),
      d && el('dt', {}, 'Stock now'), d && el('dd', {}, d.stockX ? `${fmt(d.stockX[1])} offered, ${fmt(d.stockY[1])} ${short(base)} bid` : '–')),
    el('p', { class: 'links' }, starButton(id), ' ', el('a', { href: wiki(id), target: '_blank', rel: 'noopener' }, 'Wiki page')),
  );
}

function openSpread(r, H) {
  const s = rate(H, r.x, r.y) ?? { series: [] };
  openDrawer(`${name(r.x)} in ${name(r.y)}`,
    el('p', { class: 'lede' }, `In a typical hour this market traded between ${fmt(r.buyAt)} and ${fmt(r.sellAt)} ${short(r.y)}. Post both orders and keep the difference.`),
    chart([{ label: 'Hourly average, with low–high band', cls: 'a', points: s.series, band: true }], short(r.y)),
    el('ol', { class: 'steps' },
      el('li', {}, `Buy order: ${ratioText(r.buyAt, r.y, r.x)}.`),
      el('li', {}, `Sell order: ${ratioText(1 / r.sellAt, r.x, r.y)}.`),
      el('li', {}, 'Leave both up. Check back, collect fills, repost.')),
    el('p', { class: 'muted' }, 'If one side fills in minutes, you priced it too generously. If it sits for hours, you were too greedy.'),
  );
}

function openRecipe(r, H) {
  const base = r.base;
  openDrawer(`${r.n} × ${name(r.from)} → ${name(r.to)}`,
    el('ol', { class: 'steps' },
      el('li', {}, `Buy ${r.n} ${name(r.from)} for about ${fmt(r.cost)} ${short(base)} (${ratioText(r.pin, base, r.from)}).`),
      el('li', {}, `${r.how}.`),
      el('li', {}, `Sell 1 ${name(r.to)} for about ${fmt(r.revenue)} ${short(base)}.`)),
    el('p', { class: 'result' }, 'Per craft: ', el('b', { class: r.profit > 0 ? 'up' : 'down' }, `${r.profit > 0 ? '+' : ''}${fmt(r.profit)} ${short(base)}`),
      ` (${pct(r.roi)}), `, el('b', { class: 'gold' }, `${fmt(r.gold)} gold`), ' in exchange fees.'),
    chart([{ label: `${r.n} × ${short(r.from)}`, cls: 'a', points: priceSeries(H, r.from, base).map(p => ({ t: p.t, v: p.v * r.n })) },
      { label: `1 × ${short(r.to)}`, cls: 'b', points: priceSeries(H, r.to, base) }], short(base)),
    worked([
      ['Cost', `${r.n} × ${fmt(r.pin)}`, `${fmt(r.cost)} ${short(base)}`],
      ['Revenue after margin', `${fmt(r.pout)} × (1 − ${P.haircut / 100})²`, `${fmt(r.revenue)} ${short(base)}`],
      ['Profit', `${fmt(r.revenue)} − ${fmt(r.cost)}${P.goldValue ? ` − gold × ${P.goldValue} ÷ 100,000` : ''}`, `${fmt(r.profit)} ${short(base)}`],
      ['Crafts per hour', 'min(inputs traded ÷ n, outputs traded)', fmt(r.cap)],
    ]),
    el('p', { class: 'muted' }, 'Recipes come from the game rules, not from the exchange. Check one craft in game before doing a hundred.'),
  );
}

// ---------- routes ----------
const routeOpts = () => ({ maxLegs: uiGet('maxLegs', 4), share: P.share / 100, haircut: P.haircut / 100 });
let routeCache = null;
function routeRows(M, start) {
  const o = routeOpts(), key = [M.hours, state.latest, state.league, start, o.maxLegs, JSON.stringify(P)].join('|');
  if (routeCache?.key !== key || routeCache.M !== M) routeCache = { key, M, rows: routes(M, start, o) };
  return routeCache.rows;
}
const routeChain = r => el('span', { class: 'chain' }, [...r.legs.map(l => l.from), r.legs[0].from].flatMap((id, i) => i ? [el('span', { class: 'muted' }, ' → '), cur(id)] : [cur(id)]));

function openRoute(r, H) {
  const o = routeOpts(), start = r.legs[0].from;
  const hours = H ? routeHours(H, r, o.haircut) : [];
  const traded = hours.filter(h => h.traded), paid = traded.filter(h => h.roi > 0 && h.demand);
  const startIn = el('input', { type: 'number', min: 1, value: Math.max(1, Math.floor(r.size)) });
  const rateIns = r.legs.map(l => el('input', { type: 'number', min: 0, step: 'any', value: +l.rate.toPrecision(4), 'aria-label': `${short(l.to)} per ${short(l.from)}` }));
  const out = el('div', { class: 'calc-out', 'aria-live': 'polite' });
  const fee = id => state.items[id]?.fee ?? 0;
  function calc() {
    const plan = wholeUnits(r.legs, Math.floor(+startIn.value || 0), o.haircut, rateIns.map(i => +i.value));
    const gold = plan.steps.reduce((g, s) => g + s.got * fee(s.to), 0);
    const over = plan.steps.map((s, i) => s.give > r.legs[i].cap ? i : -1).filter(i => i >= 0);
    out.replaceChildren(...[
      el('ol', { class: 'steps' }, plan.steps.map((s, i) => el('li', {},
        `Sell ${int(s.give)} ${short(s.from)} for ${int(s.got)} ${short(s.to)} (${ratioText(1 / (+rateIns[i].value || r.legs[i].rate), s.from, s.to)}).`,
        s.left >= 1 ? el('span', { class: 'muted' }, ` About ${int(s.left)} ${short(s.from)} left over from rounding, not counted.`) : '',
        over.includes(i) ? el('span', { class: 'gold' }, ` More than this market showed demand for (${fmt(r.legs[i].cap)} ${short(s.from)}/h at your share).`) : ''))),
      el('p', { class: 'result' }, 'Result: ', el('b', { class: plan.profit > 0 ? 'up' : 'down' }, `${plan.profit > 0 ? '+' : ''}${int(plan.profit)} ${short(start)}`),
        ` (${pct(plan.profit / plan.start)}), paying `, el('b', { class: 'gold' }, `${fmt(gold)} gold`), '.'),
      plan.profit <= 0 && el('p', { class: 'muted' }, 'Rounding to whole units eats this route at that size. Try a larger start, within the demand limits above.'),
    ].filter(Boolean));
  }
  [startIn, ...rateIns].forEach(i => i.addEventListener('input', calc));
  calc();
  openDrawer(r.legs.map(l => short(l.from)).concat(short(start)).join(' → '),
    el('p', { class: 'lede' }, `${pct(r.roi)} per loop at last hour's average fills, after a ${fmt(o.haircut * 100)}% safety margin on every step. At the hour's worst ratios: ${pct(r.worstRoi)}.`),
    el('h3', {}, 'Demand at each step'),
    el('ol', { class: 'demand' }, r.legs.map((l, i) => el('li', { class: i === r.limit ? 'limit' : '' },
      el('b', {}, `${short(l.from)} → ${short(l.to)}`), i === r.limit ? badge('Limit', 'warn', 'This step caps the route') : '',
      el('span', { class: 'desc' }, `1 ${short(l.from)} = ${fmt(l.rate)} ${short(l.to)}. Traded ${fmt(l.traded)} ${short(l.from)} last hour, buyers had ${fmt(l.bid)} ${short(l.to)} waiting. Your max: ${fmt(l.cap)} ${short(l.from)} per hour.`)))),
    el('p', { class: 'muted' }, `"Buyers waiting" is the least that was on offer at any point in the hour. "Your max" is ${fmt(o.share * 100)}% of what really traded or of what buyers had waiting, whichever is smaller.`),
    H && el('p', { class: 'lede' }, traded.length ? `Over the last ${H.hours} hours every step traded in ${traded.length} hours, and the loop paid with buyers waiting in ${paid.length} of them.` : 'This loop did not trade end to end in the last 24 hours.'),
    H && chart([{ label: 'Return per loop, by hour (%)', cls: 'a', points: traded.map(h => ({ t: h.t, v: h.roi * 100 })) }], '%'),
    worked([
      ...r.legs.map((l, i) => [`Step ${i + 1} cap`, `${P.share}% × min(${fmt(l.traded)}, ${fmt(l.bid)} ÷ ${fmt(l.rate)})`, `${fmt(l.cap)} ${short(l.from)}/h`]),
      ['Return', r.legs.map(l => `${fmt(l.rate)}×${1 - o.haircut}`).join(' × ') + ' − 1', pct(r.roi)],
      ['Worst case', r.legs.map(l => fmt(l.worst)).join(' × ') + ' − 1', pct(r.worstRoi)],
      ['Verified size', `step ${r.limit + 1} limits it`, `${fmt(r.size)} ${short(start)}/h`],
      ['Profit per hour', `${fmt(r.size)} × ${pct(r.roi)}`, `${fmt(r.perHour)} ${short(start)}`],
    ]),
    el('h3', {}, 'Plan in whole units'),
    el('p', { class: 'muted' }, 'Prefilled with last hour\'s average rates. Type the live ratios from the exchange to recheck.'),
    el('div', { class: 'calc' },
      el('label', {}, 'Start with', el('span', { class: 'unit' }, startIn, short(start))),
      ...r.legs.map((l, i) => el('label', {}, `1 ${short(l.from)} sells for`, el('span', { class: 'unit' }, rateIns[i], short(l.to))))),
    out,
  );
}

// ---------- top picks ----------
// Quick: what pays most per hour in the newest hour. Steady: what held all day.
function pickRows(M, steady) {
  const [A, B] = defaultBases(state.realm);
  const needH = steady ? Math.max(1, M.hours * 0.75) : 1;
  const f = flips(M, A, B)
    .filter(r => r.volA >= 10 && r.volB >= 10 && r.active >= needH && (!steady || (r.both >= needH && r.held / r.both >= P.steadyHeld / 100)))
    .map(r => ({ kind: 'Flip', key: 'f:' + r.x, x: r.x, roi: r.roi, perHour: r.perHour, goldPer: r.goldPer, row: r,
      what: `Buy with ${short(r.buyWithA ? A : B)}, sell for ${short(r.buyWithA ? B : A)}`,
      open: () => withHistory(name(r.x), H => openFlip(r, H)) }));
  const rc = recipeRows(M, state.recipes, A).map(r => ({ ...r, base: A }))
    .filter(r => r.profit > 0 && r.cap >= 0.5 && r.active >= needH)
    .map(r => ({ kind: 'Recipe', key: 'r:' + r.id, x: r.to, roi: r.roi, perHour: r.perHour, goldPer: r.goldPer, row: r,
      what: `${r.n} × ${name(r.from)} → 1`,
      open: () => withHistory(`${r.n} × ${name(r.from)} → ${name(r.to)}`, H => openRecipe(r, H)) }));
  const ro = steady ? [] : routeRows(M, A).filter(r => r.plan.profit > 0 && r.worstRoi > 0)
    .map(r => ({ kind: 'Route', key: 'ro:' + r.id, x: r.legs[1].from, roi: r.roi, perHour: r.perHour, goldPer: r.goldPer, row: r,
      what: r.legs.map(l => short(l.from)).concat(short(A)).join(' → '),
      open: () => withHistory(r.legs.map(l => short(l.from)).concat(short(A)).join(' → '), H => openRoute(r, H)) }));
  return [...f, ...rc, ...ro].filter(p => p.perHour > 0 && (p.goldPer == null || p.goldPer <= 600))
    .sort((a, b) => b.perHour - a.perHour).slice(0, 10);
}

function pickList(picks, H) {
  const [A, B] = defaultBases(state.realm);
  const day = H && H.hours > 1 ? new Map(flips(H, A, B).map(r => [r.x, r])) : null;
  if (!picks.length) return el('p', { class: 'empty' }, 'Nothing worth doing passed the filters. Check back after the next hour.');
  return el('ol', { class: 'picks' }, picks.map(p => {
    const d = p.kind === 'Flip' && day?.get(p.x);
    const held = d && d.both ? d.held / d.both : null;
    return el('li', {}, el('button', { class: 'pick', onclick: p.open },
      icon(p.x, 32),
      el('span', { class: 'pick-main' }, el('b', {}, name(p.x)), el('small', {}, `${p.kind}: ${p.what}`)),
      el('span', { class: 'pick-num' }, el('b', { class: 'up' }, pct(p.roi)), el('small', {}, `~${fmt(p.perHour)} ${short(A)}/h`)),
      el('span', { class: 'pick-num' }, el('b', { class: 'gold' }, fmt(p.goldPer)), el('small', {}, `gold per ${short(A)}`)),
      held == null ? el('span', { class: 'pick-tag' }) :
        held >= P.spikeHeld / 100 ? el('span', { class: 'pick-tag ok' }, `Held ${d.held}/${d.both} h`) : el('span', { class: 'pick-tag warn' }, `Spike: ${d.held}/${d.both} h`)));
  }));
}

// ---------- live updates and alerts ----------
const live = { auto: store.get('auto', true), sound: store.get('sound', false), desktop: store.get('desktop', false), minAlert: store.get('minAlert', 1000), lastPicks: null, checking: false };
let audio;
function chime() {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    for (const [i, f] of [880, 1320].entries()) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.connect(g); g.connect(audio.destination);
      g.gain.setValueAtTime(0.0001, t + i * 0.16); g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.3);
      o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.32);
    }
  } catch { /* no audio available */ }
}
// Browsers only allow sound after the person has interacted with the page.
addEventListener('pointerdown', () => { try { audio ??= new AudioContext(); audio.resume(); } catch {} }, { once: true });

function toast(title, lines = [], onclick) {
  const t = el('div', { class: 'toast', role: 'status' },
    el('button', { class: 'toast-body', onclick: () => { onclick?.(); t.remove(); } }, el('b', {}, title), lines.map(l => el('span', {}, l))),
    el('button', { class: 'close', 'aria-label': 'Dismiss', onclick: () => t.remove() }, '×'));
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 20000);
}
let unseen = 0;
const baseTitle = document.title;
function badgeTitle(n) { unseen = n; document.title = n ? `(${n}) ${baseTitle}` : baseTitle; }
addEventListener('focus', () => badgeTitle(0));

// Called after every automatic update: tell the person what's new.
function announce() {
  const picks = pickRows(state.m, false);
  const before = live.lastPicks;
  live.lastPicks = new Set(picks.map(p => p.key));
  if (!before) return; // first load: nothing to compare with
  const fresh = picks.filter(p => !before.has(p.key) && p.perHour >= live.minAlert);
  const [A] = defaultBases(state.realm);
  const lines = fresh.slice(0, 3).map(p => `${name(p.x)}: ${pct(p.roi)}, ~${fmt(p.perHour)} ${short(A)}/h`);
  toast(`Updated to ${hourLabel(state.latest + HOUR)}`, fresh.length ? [`${fresh.length} new pick${fresh.length > 1 ? 's' : ''}:`, ...lines] : ['No new picks above your alert level.'],
    () => { state.tab = 'picks'; renderPanel(); });
  if (!fresh.length) return;
  if (live.sound) chime();
  if (document.hidden || !document.hasFocus()) badgeTitle(unseen + fresh.length);
  if (live.desktop && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`Faustus Ledger: ${fresh.length} new pick${fresh.length > 1 ? 's' : ''}`, { body: lines.join('\n'), tag: 'faustus' });
    n.onclick = () => { focus(); state.tab = 'picks'; renderPanel(); n.close(); };
  }
}

// The digest for hour H appears a few minutes after H ends. Once that time has
// passed, check every 30 seconds until it's there.
async function checkForNewHour() {
  if (!live.auto || !state.latest || live.checking) return;
  const next = state.latest + HOUR;
  if (Date.now() / 1000 < next + HOUR + 15) return;
  live.checking = true;
  try {
    if (await getHour(state.realm, next).catch(() => null)) { await load({ quiet: true }); announce(); }
  } finally { live.checking = false; }
  renderLive();
}

function renderLive() {
  const box = $('#live'); if (!box || !state.latest) return;
  const next = state.latest + 2 * HOUR; // when the next digest is due
  const mins = Math.max(0, Math.ceil((next - Date.now() / 1000) / 60));
  const chk = (key, label, onchange) => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: live[key], onchange: e => { live[key] = e.target.checked; store.set(key, live[key]); onchange?.(e); } }), label);
  box.replaceChildren(
    el('span', { class: 'next' }, !live.auto ? 'Auto-update is off.' : mins > 0 ? `Next hour due in about ${mins} min.` : 'Waiting for GGG to publish the next hour…'),
    chk('auto', 'Update as soon as the next hour is out', () => { checkForNewHour(); renderLive(); }),
    chk('sound', 'Sound', e => { if (e.target.checked) chime(); }),
    chk('desktop', 'Desktop alerts', async e => {
      if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') { live.desktop = false; store.set('desktop', false); e.target.checked = false; toast('Desktop alerts are blocked', ['Allow notifications for this site in your browser settings.']); }
      }
    }),
    el('label', { class: 'inline' }, 'Alert from', el('input', { type: 'number', min: 0, value: live.minAlert, onchange: e => { live.minAlert = Number(e.target.value) || 0; store.set('minAlert', live.minAlert); } }), `${short(defaultBases(state.realm)[0])}/h`),
  );
}

// ---------- panels ----------
// Typical price of an item by its in-game name, for the Crafting tabs: in Chaos from the
// picked league, or (Ruthless tab) in Alchemy from a day of the Ruthless league.
let byName = null;
const idOf = n => {
  if (byName?.items !== state.items) byName = { items: state.items, map: new Map(Object.entries(state.items).map(([id, it]) => [it.name, id])) };
  return byName.map.get(n);
};
const exchangePriceIn = (getM, unit) => n => {
  const M = getM(), id = idOf(n);
  if (!M || !id) return null;
  if (id === unit) return 1;
  return price(M, id, unit)?.v || null;
};
const exchangePrice = exchangePriceIn(() => state.m, CHAOS);

// How much of an item the exchange trades: units per hour over the loaded hours (every market
// it's in), and what's listed right now. null when it isn't on the exchange.
const exchangeVolume = n => volumeIn(state.m, n);
function volumeIn(M, n) {
  if (!M) return null;
  const id = idOf(n);
  if (!id) return null;
  let vol = 0, stock = 0;
  // What's listed now: only markets seen in the newest hour (over a day, a market's last hour can be old).
  M.tEnd ??= Math.max(0, ...M.markets.map(e => e.hours[e.hours.length - 1]?.t ?? 0));
  for (const e of M.markets) {
    if (e.a !== id && e.b !== id) continue;
    const a = e.a === id;
    vol += a ? e.va : e.vb;
    const last = e.hours[e.hours.length - 1];
    if (last?.t !== M.tEnd) continue;
    const st = a ? last?.stockA : last?.stockB;
    if (isFinite(st) && st > 0) stock += st;
  }
  return { perHour: vol / Math.max(1, M.hours), stock };
}

// The Ruthless crafting tab: a day of the Ruthless league, whichever league is picked above
// (the picked one if it's Ruthless-like, else the busiest league named Ruthless, softcore first).
let rcraft = null;
function ruthlessModel() {
  const key = `${state.realm}|${state.latest}|${state.league}`;
  if (rcraft?.key !== key && state.latest) {
    const r = rcraft = { key, model: null, league: null, done: false };
    loadPages(state.realm, state.latest, 24, () => {}).then(({ pages }) => {
      const all = [...leaguesOf(pages)].sort((a, b) => isPrivate(a) - isPrivate(b)); // GGG's own Ruthless before private ones
      r.league = alchLeague() ? state.league : all.find(l => /^Ruthless /.test(l)) ?? all.find(l => RUTHLESS.test(l)) ?? null;
      r.model = r.league ? buildModel(pages, r.league, state.items, P) : null;
      r.done = true;
      if (rcraft === r && state.tab === 'craftr') renderPanel();
    }).catch(() => { if (rcraft === r) rcraft = null; });
  }
  return rcraft;
}
const ruthlessPrice = exchangePriceIn(() => rcraft?.model, ALCH);

// ---------- league-end flip: the chosen league against the permanent league it ends in ----------
// A day of both leagues, loaded when the tab is opened (one load per realm, hour and league).
let leagueEnd = null;
function leagueEndModels() {
  const target = permanentLeagueOf(state.league);
  const key = `${state.realm}|${state.latest}|${state.league}`;
  if (target && leagueEnd?.key !== key && state.latest) {
    const loading = { key, target, league: null, standard: null, done: false, error: null };
    leagueEnd = loading;
    loadPages(state.realm, state.latest, 24, () => {}).then(({ pages }) => {
      loading.league = buildModel(pages, state.league, state.items, P);
      if (leaguesOf(pages).includes(target)) {
        loading.standard = buildModel(pages, target, state.items, P);
      }
      loading.done = true;
      if (leagueEnd === loading && state.tab === 'leagueend') {
        renderPanel();
      }
    }).catch(error => {
      loading.error = error.message;
      loading.done = true;
      if (leagueEnd === loading && state.tab === 'leagueend') {
        renderPanel();
      }
    });
  }
  return { target, loaded: leagueEnd?.key === key ? leagueEnd : null };
}

// The warning before the tab opens. onYes runs when they go ahead; onNo when they back out.
// Shown until a visitor proceeds once; after that the choice is saved and the tab opens straight away.
function confirmLeagueEnd(onYes, onNo) {
  if (store.get('leagueEndWarned', false)) {
    onYes();
    return;
  }
  const dialog = el('dialog', { class: 'warn-dialog', 'aria-labelledby': 'warn-title' },
    el('h2', { id: 'warn-title' }, '⚠ Danger'),
    el('p', {}, 'Generational wealth ahead. Sure you want to proceed?'),
    el('p', { class: 'muted small' }, 'Prices from past trades, not advice: everyone carries the same luggage, so the permanent league\'s prices can drop when the league ends.'));
  const close = proceed => {
    dialog.close();
    dialog.remove();
    if (proceed) {
      store.set('leagueEndWarned', true);
      onYes();
    } else {
      onNo();
    }
  };
  const yes = el('button', { class: 'ghost', onclick: () => close(true) }, 'Proceed');
  const no = el('button', { class: 'ghost', onclick: () => close(false) }, 'Back to safety');
  dialog.append(el('div', { class: 'warn-buttons' }, no, yes));
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close(false);
  });
  document.body.append(dialog);
  dialog.showModal();
  no.focus();
}

// A Lab calculator's starting numbers: its example values, except the safety margin and the share,
// which start at the page's coefficients so a preset shows up in the calculators too.
const LAB_FIELDS_FROM_PARAMS = { margin: 'haircut', share: 'share' };
function labFieldDefaults(lab) {
  const defaults = {};
  for (const [fieldKey, , exampleValue] of lab.fields) {
    const paramKey = LAB_FIELDS_FROM_PARAMS[fieldKey];
    if (paramKey) {
      defaults[fieldKey] = P[paramKey];
    } else {
      defaults[fieldKey] = exampleValue;
    }
  }
  return defaults;
}

const panels = {
  picks() {
    const H = loadedHistory();
    const [A] = defaultBases(state.realm);
    const quick = pickRows(state.m, false);
    const steady = H && H.hours >= 12 ? pickRows(H, true) : null;
    const loadBtn = el('button', { class: 'ghost', onclick: () => {
      loadBtn.disabled = true; loadBtn.textContent = 'Loading the last 24 hours…';
      historyModel().then(renderPanel, e => { loadBtn.disabled = false; loadBtn.textContent = `Couldn't load: ${e.message}. Try again`; });
    } }, 'Find steady picks (loads the last 24 hours)');
    return [
      el('div', { class: 'picks-grid' },
        el('section', {},
          el('h2', {}, 'Quick: right now'),
          el('p', { class: 'lede' }, `The biggest earners in the newest hour, by ${short(A)} per hour. Fast money, but check the live ratio first: one hour can be a fluke.`,
            H ? ' "Spike" means the gap did not hold over the day.' : ''),
          pickList(quick, H)),
        el('section', {},
          el('h2', {}, 'Steady: held all day'),
          el('p', { class: 'lede' }, 'Gaps that pointed the same way in 90% or more of the last 24 hours, and recipes that paid all day. Slower, but you can leave orders up and come back.'),
          steady ? pickList(steady, H) : loadBtn)),
    ];
  },

  flips() {
    const M = state.m, [dA, dB] = defaultBases(state.realm);
    let A = uiGet('flipA', dA), B = uiGet('flipB', dB);
    if (!M.ids.includes(A)) A = dA; if (!M.ids.includes(B) || B === A) B = A === dB ? dA : dB;
    const f = { ...baseFilters(), minVol: fGet('minVol', 20), minActive: fGet('minActive', 50), minHeld: fGet('minHeld', 60), maxGold: uiGet('maxGold', 0) };
    const BA = rate(M, B, A);
    if (!BA?.med) return [el('p', { class: 'lede' }, `${name(A)} and ${name(B)} didn't trade against each other in this window. Pick another pair.`)];
    const all = flips(M, A, B).filter(r => r.volA >= f.minVol && r.volB >= f.minVol && r.active / M.hours * 100 >= f.minActive
      && (M.hours === 1 || r.both === 0 || r.held / r.both * 100 >= f.minHeld) && (!f.maxGold || (r.goldPer ?? Infinity) <= f.maxGold));
    const seen = newSince(`${state.realm}:${state.league}:${A}:${B}`, all.map(r => r.x));
    const rows = all.filter(r => matches(r.x, f));
    const cols = [
      { key: 'star', label: '', cell: r => starButton(r.x) },
      { key: 'name', label: 'Item', cls: 'l', sort: r => name(r.x), cell: r => itemCell(r.x, [
        seen && !seen.has(r.x) && badge('New', 'new', 'Not on this list last time you looked'),
        r.jump > P.jumpy / 100 && badge('Jumpy', 'warn', 'The hourly price swings a lot'),
      ]) },
      { key: 'how', label: 'Buy → sell', cls: 'l', sort: r => r.buyWithA ? 0 : 1, cell: r => el('span', {}, cur(r.buyWithA ? A : B), ' → ', cur(r.buyWithA ? B : A)) },
      { key: 'roi', label: 'Gap', f: 'gap', title: 'How much more the item is worth on the selling side', cell: r => el('span', { class: 'up' }, pct(r.roi)) },
      { key: 'perHour', label: `${short(A)} / h`, f: 'perHour', title: `Upper bound: profit per item × hourly volume of the thinner market, in ${name(A)}`, cell: r => fmt(r.perHour) },
      { key: 'goldPer', label: `Gold per ${short(A)}`, f: 'goldPer', title: `Gold fees per 1 ${name(A)} of profit`, cell: r => el('span', { class: 'gold' }, fmt(r.goldPer)) },
      M.hours > 1 && { key: 'held', label: 'Held', f: 'held', title: 'Hours in which the gap pointed the same way', sort: r => r.both ? r.held / r.both : null, cell: r => r.both ? `${r.held}/${r.both} h` : '–' },
      { key: 'score', label: 'Score', f: 'score', title: 'Profit per hour, discounted for gaps that come and go, quiet markets and gold cost', cell: r => el('span', { class: 'score' }, el('i', { style: `--w:${r.score}%` }), r.score) },
    ];
    return [
      el('p', { class: 'lede' }, 'Items priced differently in their ', el('b', {}, short(A)), ' and ', el('b', {}, short(B)), ' markets. Buy on the cheap side, sell on the dear side, convert back at ',
        el('b', {}, `1 ${short(B)} = ${fmt(BA.med)} ${short(A)}`), '. Click a row for the steps and a calculator.'),
      el('div', { class: 'filters' },
        el('label', {}, 'Currency A', select('flipA', hubOptions(M), A, v => uiSet('flipA', v, true))),
        el('label', {}, 'Currency B', select('flipB', hubOptions(M).filter(([v]) => v !== A), B, v => uiSet('flipB', v, true))),
        searchBox(f.q), categoryFilter(M.ids, f.cat), starredOnly(f),
        el('span', { class: 'count' }, `${rows.length} items`)),
      moreFilters(
        numberBox('Min volume', f.minVol, v => fSet('minVol', v), 'Minimum items traded in each market over the window'),
        numberBox('Active in %', f.minActive, v => fSet('minActive', v), 'Both markets must have traded in at least this share of hours'),
        numberBox('Held in %', f.minHeld, v => fSet('minHeld', v), 'Hide gaps that held in fewer than this share of hours'),
        numberBox(`Max gold per ${short(A)}`, f.maxGold, v => uiSet('maxGold', v), '0 means no limit')),
      table(cols, rows, uiGet('sortFlips', ['score', 'desc']), s => uiSet('sortFlips', s), r => withHistory(name(r.x), H => openFlip(r, H))),
    ];
  },

  routes() {
    const M = state.m, [b0] = defaultBases(state.realm);
    let start = uiGet('routeStart', b0); if (!M.hubs.includes(start)) start = b0;
    const o = routeOpts();
    const f = { ...baseFilters(), safe: uiGet('safe', true), minProfit: fGet('minRouteProfit', 50) };
    const rows = routeRows(M, start).filter(r => r.plan.profit > 0 && (!f.safe || r.worstRoi > 0) && r.perHour >= f.minProfit
      && (!f.q && !f.cat && !f.starred || r.legs.some(l => matches(l.to, f))));
    const cols = [
      { key: 'route', label: 'Route', cls: 'l', sort: r => r.legs.length, cell: r => routeChain(r) },
      { key: 'roi', label: 'Return', f: 'routeReturn', title: 'Per loop, at last hour\'s average fills, after the safety margin', cell: r => el('span', { class: 'up' }, pct(r.roi)) },
      { key: 'worstRoi', label: 'Worst', f: 'routeWorst', title: 'Per loop at the hour\'s worst ratio on every step', cell: r => el('span', { class: r.worstRoi > 0 ? 'up' : 'down' }, pct(r.worstRoi)) },
      { key: 'size', label: `${short(start)} / h`, f: 'routeSize', title: 'How much you could put through per hour before some step runs out of demand', cell: r => fmt(r.size) },
      { key: 'perHour', label: 'Profit / h', title: `Verified size × return, in ${name(start)}`, cell: r => fmt(r.perHour) },
      { key: 'goldPer', label: `Gold per ${short(start)}`, cell: r => el('span', { class: 'gold' }, fmt(r.goldPer)) },
      { key: 'limit', label: 'Limited by', cls: 'l', sort: r => r.limit, cell: r => el('span', { class: 'muted' }, `${short(r.legs[r.limit].from)} → ${short(r.legs[r.limit].to)}`) },
    ];
    return [
      el('p', { class: 'lede' }, 'Loops through several markets that end with more than they started. Every step is checked against real demand: what actually traded last hour, and what buyers had waiting all hour. ',
        'The route is only as big as its tightest step. Click one for the step-by-step plan.'),
      el('div', { class: 'filters' },
        el('label', {}, 'Start and end in', select('routeStart', hubOptions(M), start, v => uiSet('routeStart', v, true))),
        el('label', {}, 'Steps', select('maxLegs', [['3', 'Up to 3'], ['4', 'Up to 4']], String(o.maxLegs), v => uiSet('maxLegs', Number(v)))),
        searchBox(f.q), starredOnly(f),
        el('label', { class: 'check', title: 'Only routes that would still pay if every step filled at the hour\'s worst ratio' }, el('input', { type: 'checkbox', checked: f.safe, onchange: e => uiSet('safe', e.target.checked) }), 'Pays even at worst prices'),
        el('span', { class: 'count' }, `${rows.length} routes`)),
      moreFilters(
        numberBox('Your share of demand %', P.share, v => setParam('share', Math.min(100, Math.max(1, v))), 'How much of each market\'s hourly trading you expect to win'),
        numberBox('Safety margin per step %', P.haircut, v => setParam('haircut', v), 'Knocked off every step\'s rate, since you rarely get the average'),
        numberBox(`Min profit / h`, f.minProfit, v => fSet('minRouteProfit', v), `In ${name(start)}`)),
      table(cols, rows, uiGet('sortRoutes', ['perHour', 'desc']), s => uiSet('sortRoutes', s), r => withHistory(r.legs.map(l => short(l.from)).concat(short(start)).join(' → '), H => openRoute(r, H))),
    ];
  },

  recipes() {
    const M = state.m, base = defaultBases(state.realm)[0];
    const f = { ...baseFilters(), minActive: fGet('minActive', 50) };
    if (!state.recipes.length) return [el('p', { class: 'lede' }, 'No recipes known for this game yet.')];
    const rows = recipeRows(M, state.recipes, base).map(r => ({ ...r, base }))
      .filter(r => (matches(r.from, f) || matches(r.to, f)) && r.active / M.hours * 100 >= f.minActive);
    const cols = [
      { key: 'star', label: '', cell: r => starButton(r.to) },
      { key: 'name', label: 'Recipe', cls: 'l', sort: r => name(r.to), cell: r => el('span', { class: 'recipe' }, el('span', { class: 'muted' }, `${r.n} ×`), itemCell(r.from), el('span', { class: 'muted' }, '→'), itemCell(r.to)) },
      { key: 'cost', label: 'Cost', title: `Buying the inputs, in ${name(base)}`, cell: r => fmt(r.cost) },
      { key: 'revenue', label: 'Sells for', cell: r => fmt(r.revenue) },
      { key: 'roi', label: 'Return', f: 'recipe', cell: r => el('span', { class: r.roi > 0 ? 'up' : 'down' }, pct(r.roi)) },
      { key: 'perHour', label: `${short(base)} / h`, title: 'Profit per craft × crafts per hour the market could absorb', cell: r => fmt(r.perHour) },
      { key: 'goldPer', label: `Gold per ${short(base)}`, cell: r => el('span', { class: 'gold' }, fmt(r.goldPer)) },
    ];
    return [
      el('p', { class: 'lede' }, 'Buy cheap ingredients, upgrade them at a vendor or bench, sell the result. Fixed recipes only, nothing random. Click a row for the steps.'),
      el('div', { class: 'filters' }, searchBox(f.q), categoryFilter(M.ids, f.cat), starredOnly(f), el('span', { class: 'count' }, `${rows.length} recipes`)),
      moreFilters(numberBox('Active in %', f.minActive, v => fSet('minActive', v), 'Both items must have traded in at least this share of hours')),
      table(cols, rows, uiGet('sortRecipes', ['perHour', 'desc']), s => uiSet('sortRecipes', s), r => withHistory(`${r.n} × ${name(r.from)} → ${name(r.to)}`, H => openRecipe(r, H))),
    ];
  },

  prices() {
    const M = state.m, [b0] = defaultBases(state.realm);
    let base = uiGet('base', b0); if (!M.ids.includes(base)) base = b0;
    const alt = base === DIVINE ? b0 : DIVINE, altV = price(M, alt, base).v;
    const f = baseFilters();
    const rows = prices(M, base).filter(r => matches(r.id, f));
    const cols = [
      { key: 'star', label: '', cell: r => starButton(r.id) },
      { key: 'name', label: 'Item', cls: 'l', sort: r => name(r.id), cell: r => itemCell(r.id) },
      { key: 'v', label: short(base), f: 'typical', cell: r => el('span', { title: r.via ? `Priced through ${name(r.via)}` : null }, fmt(r.v), r.via ? el('span', { class: 'muted' }, ' *') : '') },
      { key: 'alt', label: short(alt), sort: r => r.v / altV, cell: r => fmt(altV ? r.v / altV : null) },
      M.hours >= 4 && { key: 'change', label: 'Change', f: 'change', title: 'Last quarter of the window against the first', cell: r => el('span', { class: r.change > 0 ? 'up' : r.change < 0 ? 'down' : '' }, pct(r.change)) },
      M.hours >= 4 && { key: 'trend', label: 'Trend', sort: r => r.change, cell: r => spark(r.series) },
      { key: 'value', label: `${short(base)} traded / h`, cell: r => fmt(r.value) },
      { key: 'fee', label: 'Gold fee', cell: r => el('span', { class: 'gold' }, goldFee(r.fee)) },
    ];
    return [
      el('p', { class: 'lede' }, 'What everything is worth: the typical hour in the window. Sort by Change to see what is moving. An asterisk means it is priced through another currency.'),
      el('div', { class: 'filters' },
        el('label', {}, 'Price in', select('base', hubOptions(M), base, v => uiSet('base', v, true))),
        searchBox(f.q), categoryFilter(M.ids, f.cat), starredOnly(f), el('span', { class: 'count' }, `${rows.length} items`)),
      table(cols, rows, uiGet('sortPrices', ['value', 'desc']), s => uiSet('sortPrices', s), r => withHistory(name(r.id), H => openItem(r.id, base, H))),
    ];
  },

  spreads() {
    const M = state.m, base = defaultBases(state.realm)[0];
    const f = { ...baseFilters(), minValue: fGet('minValue', 50), minActive: fGet('minActive', 50) };
    const rows = spreads(M, base).filter(r => matches(r.x, f) && (r.value ?? 0) >= f.minValue && r.active / M.hours * 100 >= f.minActive);
    const cols = [
      { key: 'name', label: 'Item', cls: 'l', sort: r => name(r.x), cell: r => itemCell(r.x) },
      { key: 'in', label: 'Priced in', cls: 'l', sort: r => name(r.y), cell: r => cur(r.y) },
      { key: 'buyAt', label: 'Buy at', title: 'Typical hourly low', cell: r => fmt(r.buyAt) },
      { key: 'sellAt', label: 'Sell at', title: 'Typical hourly high', cell: r => fmt(r.sellAt) },
      { key: 'med', label: 'Margin', f: 'spread', title: 'Typical gap between the hour\'s low and high', cell: r => el('span', { class: 'up' }, pct(r.med)) },
      { key: 'value', label: `${short(base)} traded / h`, cell: r => fmt(r.value) },
      { key: 'edge', label: `Room / h`, title: `Margin × hourly value, in ${name(base)}`, cell: r => fmt(r.edge) },
    ];
    return [
      el('p', { class: 'lede' }, 'Market making in one pair: a buy order at the low end, a sell order at the high end, keep the difference. Click a row for the exact orders.'),
      el('div', { class: 'filters' }, searchBox(f.q), categoryFilter(M.ids, f.cat), starredOnly(f), el('span', { class: 'count' }, `${rows.length} markets`)),
      moreFilters(
        numberBox(`Min ${short(base)} / h`, f.minValue, v => fSet('minValue', v), 'Hide markets with less hourly traded value'),
        numberBox('Active in %', f.minActive, v => fSet('minActive', v), 'Hide markets that traded in fewer than this share of hours')),
      table(cols, rows, uiGet('sortSpreads', ['edge', 'desc']), s => uiSet('sortSpreads', s), r => withHistory(`${name(r.x)} in ${name(r.y)}`, H => openSpread(r, H))),
    ];
  },

  odd() {
    const base = defaultBases(state.realm)[0];
    const f = { ...baseFilters(), minValue: fGet('minOdd', 100) };
    const M = state.m.hours >= 6 ? state.m : loadedHistory();
    if (!M) {
      const btn = el('button', { class: 'ghost', onclick: () => {
        btn.disabled = true; btn.textContent = 'Loading the last 24 hours…';
        historyModel().then(renderPanel, e => { btn.textContent = `Couldn't load: ${e.message}. Try again`; btn.disabled = false; });
      } }, 'Scan the last 24 hours');
      return [el('p', { class: 'lede' }, 'Odd trades compare each hour with a normal price, so they need a day of history (24 hourly digests).'), btn];
    }
    return panels.oddWith(M, base, f);
  },

  oddWith(M, base, f) {
    const rows = oddTrades(M, base).filter(r => matches(r.x, f) && (r.value ?? 0) >= f.minValue);
    const cols = [
      { key: 't', label: 'Hour', cls: 'l', cell: r => hourLabel(r.t) },
      { key: 'name', label: 'Item', cls: 'l', sort: r => name(r.x), cell: r => itemCell(r.x) },
      { key: 'trade', label: 'What traded', cls: 'l', sort: r => r.qx, cell: r => el('span', {}, `${fmt(r.qx)} for ${fmt(r.qy)} `, cur(r.y)) },
      { key: 'dev', label: 'Off by', f: 'odd', sort: r => Math.abs(r.dev), cell: r => el('span', { class: r.dev > 0 ? 'up' : 'down' }, pct(r.dev)) },
      { key: 'instant', label: 'Book', f: 'book', title: 'Instant: more traded than was ever on offer, so the orders met the moment they were placed', sort: r => r.instant ? 1 : 0, cell: r => r.instant ? badge('Instant', 'warn') : el('span', { class: 'muted' }, 'Resting') },
      { key: 'value', label: `${short(base)} moved`, title: `Value that changed hands because of the off-market price`, cell: r => fmt(r.value) },
    ];
    return [
      el('p', { class: 'lede' }, 'Hours that traded 30% or more away from the normal price. Fat fingers, bait orders, and ',
        el('b', {}, 'Instant'), ' trades in dead markets: two accounts moving wealth (RMT, mules). Several hours in a row in the same direction is more likely a real price move.'),
      el('div', { class: 'filters' }, searchBox(f.q), categoryFilter(M.ids, f.cat),
        el('button', { class: 'ghost', type: 'button', popovertarget: (infoButton('book'), 'pop-book') }, 'What Instant and Resting mean'),
        el('span', { class: 'count' }, `${rows.length} hours`)),
      moreFilters(numberBox(`Min ${short(base)}`, f.minValue, v => fSet('minOdd', v), 'Hide trades that moved less value than this')),
      table(cols, rows, uiGet('sortOdd', ['value', 'desc']), s => uiSet('sortOdd', s)),
    ];
  },

  craft() {
    // How much the exchange supplies is measured over a day: one quiet hour can trade none of
    // something with thousands listed. Plans made before the day loads are redone once it has.
    if (!loadedHistory() && state.latest) historyModel().then(() => { if (state.tab === 'craft') renderPanel(); }, () => {});
    return craftPanel({ el, fmt, store, rerender: renderPanel, realm: () => state.realm, exchangePrice, items: () => state.items,
      exchangeVolume: n => volumeIn(loadedHistory() ?? state.m, n), supplyKey: () => (loadedHistory() ? 'day' : 'window'),
      // (The planner waits for the day while it loads, rather than plan twice.)
      supplyLoading: () => !loadedHistory() && !!hist && !hist.model });
  },

  craftr() {
    if (gameOf(state.realm) === 'poe2') return [el('p', { class: 'empty' }, 'Ruthless crafting is for PoE 1. Switch the realm to a PoE 1 one.')];
    const r = ruthlessModel();
    if (!r?.done) return [el('p', { class: 'muted' }, 'Loading a day of the Ruthless league…')];
    if (!r.model) return [el('p', { class: 'empty' }, 'No Ruthless league traded on the exchange in the last 24 hours.')];
    return craftPanel({ el, fmt, store, rerender: renderPanel, realm: () => state.realm, items: () => state.items,
      ruthless: true, ruthlessLeague: () => rcraft.league, exchangePrice: ruthlessPrice, exchangeVolume: n => volumeIn(rcraft.model, n) });
  },

  leagueend() {
    const { target, loaded } = leagueEndModels();
    if (!target) {
      return [el('p', { class: 'empty' }, `${state.league ?? 'This league'} is a permanent league. Pick a challenge league in the League menu: this tab compares it with the league its characters move to when it ends.`)];
    }
    if (!loaded?.done) {
      return [el('p', { class: 'muted' }, `Loading a day of ${state.league} and ${target}…`)];
    }
    if (loaded.error) {
      return [el('p', { class: 'status err' }, `Couldn't load the last 24 hours: ${loaded.error}`)];
    }
    if (!loaded.standard) {
      return [el('p', { class: 'empty' }, `Nothing traded in ${target} on the exchange in the last 24 hours, so there is nothing to compare with.`)];
    }
    const L = loaded.league;
    const S = loaded.standard;
    const carryOptions = L.hubs.filter(id => S.ids.includes(id)).map(id => [id, name(id)]);
    let carry = uiGet('leagueEndCarry', DIVINE);
    if (!carryOptions.some(([id]) => id === carry)) {
      carry = carryOptions[0]?.[0];
    }
    if (!carry) {
      return [el('p', { class: 'empty' }, `No currency trades in both ${state.league} and ${target}.`)];
    }
    const budget = uiGet('leagueEndBudget', 100);
    const days = uiGet('leagueEndDays', 7);
    const minActive = uiGet('leagueEndActive', 50);
    const rows = leagueEndRows(L, S, carry);
    const plan = luggagePlan(rows, budget, { days, share: P.share, minActive: minActive / 100 });
    const carryName = short(carry);

    const luggageLine = line => el('li', {},
      `Buy ${fmt(line.units)} × `, el('b', {}, name(line.row.id)), ` at ${fmt(line.row.leaguePrice)} ${carryName} (${fmt(line.spend)} ${carryName}); `,
      `in ${target} about ${fmt(line.worth)} ${carryName} (×${line.row.multiplier.toFixed(2)}). `,
      el('small', { class: 'muted' }, `${target} trades about ${fmt(line.row.standardUnitsPerDay)} a day.`));
    const luggage = plan.lines.length
      ? [
        el('ol', { class: 'luggage' }, plan.lines.map(luggageLine)),
        el('p', {}, `Keep ${fmt(plan.keptInCarry)} ${carryName} as it is. `,
          el('b', { class: 'gold' }, `${fmt(budget)} ${carryName} here ≈ ${fmt(plan.worth)} ${carryName} in ${target} (×${plan.multiplier.toFixed(2)})`), '.'),
      ]
      : [el('p', { class: 'muted' }, `Nothing beats keeping ${carryName} by 5% with enough trade on both sides: carry ${carryName}.`)];

    const cols = [
      { key: 'star', label: '', cell: r => starButton(r.id) },
      { key: 'name', label: 'Item', cls: 'l', sort: r => name(r.id), cell: r => itemCell(r.id) },
      { key: 'leaguePrice', label: `${state.league} (${carryName})`, cell: r => el('span', { title: r.via ? `Priced through ${name(r.via)}` : null }, fmt(r.leaguePrice), r.via ? el('span', { class: 'muted' }, ' *') : '') },
      { key: 'standardPrice', label: `${target} (${carryName})`, cell: r => fmt(r.standardPrice) },
      { key: 'multiplier', label: '×', title: `${carryName} in ${target} per ${carryName} spent here, after the safety margin on both trades`, cell: r => el('span', { class: r.multiplier > 1 ? 'up' : 'down' }, '×' + r.multiplier.toFixed(2)) },
      { key: 'standardValuePerDay', label: `${target} ${carryName} / day`, title: `How much of it trades a day in ${target}, in ${carryName}: what you can sell`, cell: r => fmt(r.standardValuePerDay) },
      { key: 'standardActiveShare', label: `${target} active`, title: `Share of the day's hours it traded in ${target}`, cell: r => `${Math.round(r.standardActiveShare * 100)}%` },
      { key: 'leagueUnitsPerDay', label: `${state.league} / day`, title: `Units traded a day in ${state.league}: what you can buy`, cell: r => fmt(r.leagueUnitsPerDay) },
    ];
    const shownRows = rows.filter(r => r.standardActiveShare * 100 >= minActive);
    return [
      el('p', { class: 'lede' }, `When ${state.league} ends, everything in it moves to ${target} and is worth ${target}'s prices. `,
        `This compares the two over the last 24 hours, priced in ${carryName}: an item at ×1.5 turns 1 ${carryName} spent here into 1.5 ${carryName} there. `,
        `Buy the luggage before the end, sell it in ${target} after.`),
      el('div', { class: 'filters' },
        el('label', {}, 'Carry', select('leagueEndCarry', carryOptions, carry, v => uiSet('leagueEndCarry', v))),
        numberBox(`Wealth to move (${carryName})`, budget, v => uiSet('leagueEndBudget', v)),
        numberBox('Days to sell', days, v => uiSet('leagueEndDays', Math.max(1, v)), `Each item is capped at your share (${P.share}%, Formulas) of this many days of its trade on both sides`),
        numberBox(`Min. ${target} active %`, minActive, v => uiSet('leagueEndActive', v), `Leave out items that traded in fewer of ${target}'s hours`)),
      luggageSection(luggage),
      el('p', { class: 'muted small' },
        `Each item is capped at ${P.share}% of ${days} days of its trade, in ${state.league} (to buy) and in ${target} (to sell); the ×s include the ${P.haircut}% safety margin on both trades. `,
        `Prices are the typical hour of the last day, not a forecast: near the end a league's prices sink, and when it ends everyone's luggage lands in ${target} at once and pushes its prices down. Gold fees aren't counted.`),
      el('h3', {}, `Every item, best × first (${shownRows.length})`),
      table(cols, shownRows, uiGet('sortLeagueEnd', ['multiplier', 'desc']), s => uiSet('sortLeagueEnd', s), r => withHistory(name(r.id), H => openItem(r.id, carry, H))),
    ];
  },

  lab() {
    const saved = store.get('lab', {});
    return [
      el('p', { class: 'lede' }, 'Calculators with the formulas the page uses. Type any numbers: real ones from the exchange, or made up to see what matters. ',
        'The defaults are taken from a real flip and route; the safety margin and share follow the coefficients the page uses. To change those, pick a preset or open ', el('button', { class: 'linklike', onclick: () => openFormulas() }, 'Formulas'), '.'),
      presetPicker(() => renderPanel()),
      el('div', { class: 'labs' }, LABS.map(L => {
        const vals = { ...labFieldDefaults(L), ...(saved[L.id] || {}) };
        const out = el('dl', { class: 'lab-out', 'aria-live': 'polite' });
        const run = () => out.replaceChildren(...L.compute(vals).flatMap(([label, expr, res]) => [el('dt', {}, label), el('dd', {}, el('code', {}, expr), ' = ', el('b', {}, res))]));
        const inputs = L.fields.map(([k, label]) => {
          const inp = el('input', { type: 'number', step: 'any', value: vals[k] });
          inp.addEventListener('input', () => { vals[k] = Number(inp.value) || 0; saved[L.id] = { ...(saved[L.id] || {}), [k]: vals[k] }; store.set('lab', saved); run(); });
          return el('label', {}, label, inp);
        });
        run();
        return el('section', { class: 'lab' },
          el('h2', {}, L.title, ' ', L.formulas.map(k => infoButton(k))),
          el('div', { class: 'lab-in' }, inputs), out,
          el('button', { class: 'linklike', onclick: () => { delete saved[L.id]; store.set('lab', saved); renderPanel(); } }, 'Back to the example numbers'));
      })),
    ];
  },

  guide() {
    const poe2 = state.realm === 'poe2';
    const code = t => el('code', {}, t);
    return [el('div', { class: 'about' },
      el('h2', {}, 'Your first flip'),
      el('ol', {},
        el('li', {}, 'On ', el('b', {}, 'Flips'), ', pick a row with a high score that held most hours. Star it so you can find it again.'),
        el('li', {}, 'Every column with a ', el('b', {}, '?'), ' explains its formula. ', el('b', {}, 'Formulas'), ' (top right) lets you change the numbers behind them, and the ', el('b', {}, 'Lab'), ' tab has calculators to try your own values.'),
        el('li', {}, 'Or try ', el('b', {}, 'Routes'), ' for loops through several markets. Each one is sized by how much the market really bought last hour, so start with the size it suggests.'),
        el('li', {}, `In game, open the Currency Exchange (${poe2 ? 'Alva' : 'Faustus in Kingsmarch'}). Pick the item and currency, then hold Alt to see the live ratios and how much is on offer.`),
        el('li', {}, 'Click the row here and type the live ratios into the calculator. It tells you what to buy, what to sell, and what you end up with in whole units.'),
        el('li', {}, 'Place the buy order. When it fills, place the sell order. Then convert back if the flip ends in the other currency.'),
        el('li', {}, 'Be patient. An order that fills in minutes was priced too generously. One that sits for hours was too greedy.')),
      el('h2', {}, 'Rules of thumb'),
      el('ul', {},
        el('li', {}, 'A gap that held 20+ of 24 hours is a pattern. A gap from one or two hours is usually a single odd trade.'),
        el('li', {}, '"Profit / h" assumes you take the whole market. Nobody does, so treat it as a ceiling.'),
        el('li', {}, 'Gold is the real cost. Cheap items in bulk eat gold fast, so watch "Gold per" and set a limit under More filters.'),
        el('li', {}, 'Stay away from markets flagged Instant on Odd trades. Those prices are transfers, not a market.'),
        el('li', {}, 'Ratios are whole numbers on both sides, so small budgets lose a few percent to rounding. The calculator shows it.')),
      el('h2', {}, 'Ruthless and private leagues'),
      el('ul', {},
        el('li', {}, 'Ruthless trades in Orbs of Alchemy: in a Ruthless league (or a private one trading mostly in Alchemy) every price is in Alchemy, and the volume filters start much lower. Expect few trades: a busy Ruthless market changes hands a few times a day.'),
        el('li', {}, 'A small private league may not have traded in the window. Type its name or PL number under ', el('b', {}, 'Private league'), ': the page looks back up to a week and widens the window to reach it.'),
        el('li', {}, el('b', {}, 'Crafting (Ruthless)'), ' plans with Ruthless rules and prices, and Ruthless builds from poe.ninja.')),
      el('h2', {}, 'Where the numbers come from'),
      el('p', {}, 'GGG publishes a digest of every exchange market for each finished hour (', code('web.poecdn.com/api/currency-exchange'), '). For each market it shows how much of each side traded, the lowest and highest ratio, and the stock on each side. ',
        'There is no live order book, so everything here is at least an hour old. A typical price is the median of the hourly averages, so one freak hour can\'t drag it.'),
      el('p', {}, 'Gold fees come from the game files: a fixed amount per unit you receive (Chaos 15, Divine 250, Mirror 25,000 in PoE 1). Item names, categories and fees update with each patch.'),
      el('h2', {}, 'About and privacy'),
      el('ul', {},
        el('li', {}, 'A free fan project. Not affiliated with or endorsed by Grinding Gear Games. Path of Exile, its item names, icons and game data belong to Grinding Gear Games.'),
        el('li', {}, 'No ads, no accounts, no cookies, no analytics. Nothing about you is collected or sent anywhere.'),
        el('li', {}, 'Your settings, stars and alert choices are saved in your own browser (local storage) and never leave it. Clearing site data removes them.'),
        el('li', {}, 'Item icons load straight from GGG\'s image server (web.poecdn.com), and exchange data comes through this site\'s proxy from GGG\'s public API. The hosting provider may keep ordinary request logs, as every website does.'),
        el('li', {}, 'Numbers are estimates from past trades, not financial advice. What you trade is up to you. Check the live ratio in game first.'),
        el('li', {}, el('a', { href: 'https://github.com/STEPAN-BANDERA/economy-bubble', target: '_blank', rel: 'noopener' }, 'Open source'), ' under the MIT license. Bugs and ideas welcome as GitHub issues.')),
      el('p', { class: 'muted' }, 'Ideas borrowed with thanks from Divine Tendies, Path of Stonks, timeolord\'s poe-arbitrage and Maxroll\'s flipping guide. Crafting data and rules from Craft of Exile (with weights measured by the Prohibited Library community); build items from poe.ninja; some rules from poedb; Harvest costs from Maxroll; beast and Recombinator icons from the PoE Wiki (CC BY-NC-SA 3.0); game data from the game files via pathofexile-dat.'),
    )];
  },
};

function renderPanel() {
  for (const b of document.querySelectorAll('#tabs button')) {
    const on = b.dataset.tab === state.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1; // roving tabindex: Tab enters the tab list once, arrows move inside it
  }
  $('#panel').setAttribute('aria-labelledby', 'tab-' + state.tab);
  const panel = $('#panel');
  if (!state.m) { panel.replaceChildren(); return; }
  const focused = document.activeElement?.closest('#panel') && document.activeElement.type === 'search';
  panel.replaceChildren(...panels[state.tab]());
  if (focused) { const n = $('#panel input[type=search]'); n?.focus(); n?.setSelectionRange(n.value.length, n.value.length); }
}

function renderHero() {
  const M = state.m, hero = $('#hero'), [base] = defaultBases(state.realm);
  const r = rate(M, DIVINE, base);
  const kids = [];
  const age = Date.now() / 1000 - (state.latest + HOUR);
  if (state.failed) kids.push(el('p', { class: 'status err' }, `${state.failed} of the ${state.window} hours couldn't be loaded and are left out. Reload to try again.`));
  if (age > 3 * HOUR) kids.push(el('p', { class: 'status err' }, `The newest data is ${Math.floor(age / HOUR)} hours old. GGG's feed may be behind.`));
  if (r?.med) {
    kids.push(el('p', { class: 'rate' },
      el('span', { class: 'side' }, icon(DIVINE, 48), '1 ' + short(DIVINE)), el('span', { class: 'eq' }, '='),
      el('span', { class: 'side' }, icon(base, 48), el('span', { class: 'num' }, fmt(r.med)), ' ' + short(base))));
    const vs = r.series.map(x => x.v);
    const sub = [
      vs.length > 1 && el('span', {}, 'Hourly ', el('b', {}, `${fmt(Math.min(...vs))} – ${fmt(Math.max(...vs))}`)),
      el('span', {}, el('b', {}, fmt(r.volX)), ' Divines traded'),
    ];
    if (state.realm === 'poe2') { const c = price(M, CHAOS, EXALT).v; if (c) sub.push(el('span', {}, '1 Chaos = ', el('b', {}, fmt(c)), ' Exalted')); }
    sub.push(el('span', {}, `${M.markets.filter(e => e.va > 0).length} markets, ${M.hours} h, data through ${hourLabel(state.latest + HOUR)}`));
    kids.push(el('div', { class: 'sub' }, sub));
    if (r.series.length > 1) { const c = chart([{ cls: 'a', points: r.series, band: true }], short(base)); c.classList.add('hero-chart'); kids.push(c); }
  } else {
    kids.push(el('p', { class: 'status' }, `No Divine/${name(base)} trades in ${state.league} during this window.`));
  }
  kids.push(el('div', { class: 'live', id: 'live' }));
  hero.replaceChildren(...kids);
  renderLive();
}

const setStatus = (text, err = false) => $('#hero').replaceChildren(el('p', { class: 'status' + (err ? ' err' : '') }, text));

// ---------- wiring ----------
async function load({ quiet = false } = {}) {
  const realm = state.realm, n = state.window;
  try {
    if (!quiet) setStatus('Loading exchange data…');
    const [items, latest] = await Promise.all([loadItems(gameOf(realm)), findLatest(realm)]);
    const { pages, failed } = await loadPages(realm, latest, n, (d, t) => !quiet && t > 1 && setStatus(`Loading hour ${d} of ${t}…`));
    // Forget hours that have fallen out of every window we might show.
    for (const k of cache.keys()) if (Number(k.split('/').pop()) < latest - 200 * HOUR) cache.delete(k);
    if (realm !== state.realm || n !== state.window) return; // settings changed mid-load
    Object.assign(state, { items, pages, failed, latest, recipes: buildRecipes(gameOf(realm), items) });
    stars = new Set(store.get(starKey(), []));
    fillLeagues();
    rebuild();
  } catch (e) {
    console.error(e);
    setStatus(`Couldn't load exchange data: ${e.message}. The page needs its /api/cx proxy. Run it with "npm run dev" (Cloudflare Pages), not by opening the file directly.`, true);
    state.m = null; renderPanel();
  }
}

function fillLeagues() {
  const list = leaguesOf(state.pages).filter(l => state.showPrivate || !isPrivate(l));
  const saved = store.get('league:' + state.realm, null);
  state.league = list.includes(saved) ? saved : list[0]; // busiest public league = current challenge league
  $('#league').replaceChildren(...list.map(l => el('option', { value: l, selected: l === state.league }, l)));
}

// A private league typed by name or PL number. A small one may not have traded in the window
// (or the last week), so look back hour by hour and widen the window until it's in.
const WINDOWS = [1, 6, 24, 72, 168];
async function findLeague(q) {
  const want = q.trim().toLowerCase();
  if (!want || !state.latest) return;
  const hit = ls => ls.find(l => l.toLowerCase() === want) ?? ls.find(l => l.toLowerCase().includes(want));
  const realm = state.realm, latest = state.latest;
  for (let i = 0; i < 168; i++) {
    setStatus(`Looking for "${q.trim()}": hour ${i + 1} of up to 168…`);
    const page = await getHour(realm, latest - i * HOUR).catch(() => null);
    if (realm !== state.realm) return;
    const found = page && hit([...new Set(page.markets.map(m => m.league))]);
    if (!found) continue;
    if (isPrivate(found) && !state.showPrivate) { state.showPrivate = true; $('#showPrivate').checked = true; store.set('showPrivate', true); }
    store.set('league:' + realm, found);
    const w = WINDOWS.find(x => x > i);
    if (w > state.window) { state.window = w; $('#window').value = String(w); store.set('hours', w); await load(); }
    else { fillLeagues(); rebuild(); }
    return;
  }
  setStatus(`No league matching "${q.trim()}" traded on the exchange in the last 7 days.`, true);
}

function rebuild() {
  if (!state.league) { setStatus('No leagues traded in this window.'); state.m = null; renderPanel(); return; }
  state.m = buildModel(state.pages, state.league, state.items, P);
  renderHero();
  renderPanel();
}

function init() {
  $('#realm').value = state.realm;
  $('#window').value = String(state.window);
  $('#showPrivate').checked = state.showPrivate;
  $('#realm').addEventListener('change', e => { state.realm = e.target.value; store.set('realm', state.realm); load(); });
  $('#window').addEventListener('change', e => { state.window = Number(e.target.value); store.set('hours', state.window); load(); });
  $('#league').addEventListener('change', e => { state.league = e.target.value; store.set('league:' + state.realm, state.league); rebuild(); });
  $('#plName').addEventListener('change', e => findLeague(e.target.value));
  $('#showPrivate').addEventListener('change', e => { state.showPrivate = e.target.checked; store.set('showPrivate', state.showPrivate); fillLeagues(); rebuild(); });
  const showTab = tab => { state.tab = tab; store.set('tab', tab); history.replaceState(null, '', '#' + tab); renderPanel(); };
  // The league-end flip tab asks first, until the visitor has proceeded once.
  const selectTab = tab => {
    if (tab === 'leagueend' && state.tab !== 'leagueend') {
      confirmLeagueEnd(() => showTab(tab), () => $('#tab-' + state.tab)?.focus());
      return;
    }
    showTab(tab);
  };
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) selectTab(b.dataset.tab); });
  $('#tabs').addEventListener('keydown', e => {
    const i = TABS.indexOf(state.tab);
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key];
    if (j == null) return;
    e.preventDefault();
    selectTab(TABS[(j + TABS.length) % TABS.length]);
    $('#tab-' + state.tab).focus();
  });
  $('#drawer-close').addEventListener('click', () => drawer().close());
  $('#open-formulas').addEventListener('click', () => openFormulas());
  drawer().addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus(); returnFocus = null; });
  drawer().addEventListener('click', e => { if (e.target === drawer()) drawer().close(); }); // click on the backdrop
  setInterval(checkForNewHour, 30 * 1000);
  setInterval(renderLive, 60 * 1000);
  // Opened straight on the league-end flip (a link or the last tab): ask first, from Top picks,
  // unless the visitor already went ahead once.
  if (state.tab === 'leagueend') {
    state.tab = 'picks';
    confirmLeagueEnd(() => showTab('leagueend'), () => showTab('picks'));
  }
  renderPanel();
  load().then(() => { if (state.m) live.lastPicks = new Set(pickRows(state.m, false).map(p => p.key)); });
}
init();
