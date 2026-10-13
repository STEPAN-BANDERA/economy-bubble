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
  // The Ruthless tab's builds come from poe.ninja's Ruthless league; without that file it shows the main league's.
  fetch('data/craft/targets-poe1-ruthless.json').then(r => (r.ok ? r.json() : null)).then(t => { S.targetsR = t; if (t && R()) { S.spec = null; X.rerender(); } }, () => {});
}
const targets = () => (R() && S.targetsR) || S.targets;
// Build picks are remembered per tab: the two lists differ.
const ninjaKey = () => `n${R() && S.targetsR ? 'r' : ''}:${S.arch}:${S.item}`;
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
// The Ruthless tab plans with Ruthless rules and prices (in Orbs of Alchemy, Ruthless's main
// currency), and keeps its own prices and options: the two economies have nothing in common.
const R = () => !!X.ruthless;
const K = key => (R() ? key + 'Ruthless' : key);
const unit = () => (R() ? C.CUR.alch : C.CUR.chaos);
function ovr() {
  if (S.ovMode !== R()) { S.ovMode = R(); S.overrides = X.store.get(K('craftPrices'), {}); }
  return S.overrides;
}
function priceInfo(name) {
  ovr();
  // 'off': you'd rather not use it (too scarce, or you don't want to): the planner leaves it out.
  if (S.overrides[name] === 'off') return { v: NaN, src: 'not used' };
  if (S.overrides[name] != null) return { v: S.overrides[name], src: 'yours' };
  if (name === unit()) return { v: 1, src: 'exchange' };
  const ex = X.realm() !== 'poe2' ? X.exchangePrice(name) : null;
  if (ex) return { v: ex, src: 'exchange' };
  // Estimates are in chaos; on the Ruthless tab they're converted at Ruthless's Chaos price.
  const fb = C.FARMED_PRICES[name] ?? S.index?.fallbackPrices?.[name];
  if (fb != null) return { v: fb * (R() ? X.exchangePrice(C.CUR.chaos) ?? 1 / 3 : 1), src: 'estimate' };
  return { v: NaN, src: 'unknown' };
}
const price = name => priceInfo(name).v;
function money(c) {
  if (!isFinite(c)) return '–';
  if (R()) return `${C.fmtN(c)} alch`;
  const div = price(C.CUR.divine);
  if (isFinite(div) && c >= div * 2) return `${C.fmtN(c / div)} div`;
  return `${C.fmtN(c)}c`;
}

// ---------- target specs ----------
function specFromNinja(arch, item, B) {
  const targets = [...item.mods, ...(item.eldritch ?? [])].filter(m => m.id && B.byId.get(m.id)).map(m => ({
    m: B.byId.get(m.id), minTier: m.tier, orig: m.tier, crafted: !!m.crafted, frac: !!m.fractured, on: true, text: m.text,
  }));
  return { key: ninjaKey(), B, ilvl: item.ilvl ?? 84, infl: [...(B.innateInfl ?? item.influences ?? [])], targets,
    // (Fractured influenced items only came from Necropolis crafting; plans can't start from one.)
    useFractured: !item.influences?.length,
    label: `${item.name} (${item.baseType})`, unmatched: item.mods.filter(m => !m.id).map(m => m.text), eldritch: [] };
}
const activeTargets = spec => spec.targets.filter(T => T.on);
// Every price the planner might ask for, looked up once and sent to the worker.
function priceSnapshot(B) {
  const names = new Set([...Object.keys(S.index.fallbackPrices ?? {}), ...Object.values(C.CUR), ...C.RESONATORS, ...C.ALCH_RESONATORS, C.FRACTURE, 'Mirror of Kalandra',
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
let jobId = 0;
const planOptions = () => (R() ? { ...C.DEFAULT_OPTIONS, ...C.RUTHLESS_DEFAULTS, ...X.store.get(K('craftOptions'), {}), ...C.RUTHLESS_FORCED, ruthless: true }
  : { ...C.DEFAULT_OPTIONS, ...X.store.get(K('craftOptions'), {}), ruthless: false });
// Ruthless has no crafting bench: bench-crafted targets are left out of its plans.
const plannedTargets = spec => activeTargets(spec).filter(T => !(R() && T.crafted));
// ---------- the overseer ----------
// Two workers plan side by side: one every way without fossils, in the order the list fills
// (Essence spam, Alteration / Regal, Chaos spam, Veiled Chaos, Harvest, Eldritch currency, Best
// mix, prefixes first, suffixes first, the Recombinator), and one the fossil plans (Fossils, the
// fossil-aware Best mix and Recombinators, Fossils + Recombinator), which take longest. Each
// worker hands over every plan as soon as it is made (a preview: no graph or currency count yet)
// and the list re-sorts as they arrive; its finished list then replaces its previews.
// (Two, not more: one worker can hold gigabytes of planner state on a big craft.)
let workers = [];

// While a plan (or the fractured-base comparison) is being worked out, the item's mods and
// settings are locked: a change would stop the workers mid-run and start new ones, and on a big
// craft (gigabytes of planner state per worker) that can freeze the page.
function planningBusy() {
  const mainBusy = S.job && !S.job.done;
  const rankBusy = S.fracRank && !S.fracRank.done;
  return !!(mainBusy || rankBusy);
}

// Wraps editing controls: disabled (inert) while the planner is busy. withNote: say why, once.
function lockWhileBusy(withNote, ...children) {
  const { el } = X;
  const busy = planningBusy();
  return el('div', { class: busy ? 'lockable locked' : 'lockable' },
    busy && withNote ? el('p', { class: 'muted small locknote' }, 'Locked while the plan is worked out; you can change the item again once it is done.') : null,
    el('div', { inert: busy }, children));
}

// Everything a plan depends on, as one string.
function planKey(spec) {
  ovr();
  return R() + '|' + spec.key + '|' + spec.ilvl + '|' + spec.useFractured + '|' + JSON.stringify(spec.start ?? null) + '|' + spec.targets.map(T => (T.on ? T.m.id + ':' + T.minTier + (T.frac ? 'f' : '') : '')).join(',') + '|' + JSON.stringify(S.overrides ?? {}) + '|' + X.realm() + '|' + (X.supplyKey?.() ?? '') + '|' + JSON.stringify(planOptions());
}

// planFor's answer when planning waits for the "Start computing" button.
const NOT_STARTED = { notStarted: true };

// Plans run only when asked, in the item builder and on popular builds alike: with three or four
// mods a plan takes 10-20 seconds, too long to run after every pick or on every item opened.
// A finished (or running) plan for the same item still shows.
function startComputing(spec) {
  S.requestedKey = planKey(spec);
  X.rerender();
}

// Waits for startComputing (the "Start computing" button) before planning a new question.
function planFor(spec) {
  const key = planKey(spec);
  if (S.job?.key === key) {
    return S.job.view;
  }
  if (S.requestedKey !== key) {
    return NOT_STARTED;
  }
  // A different question while one is being worked out (the controls are locked, but switching
  // views can still ask): it starts when the current one is done (settleJob redraws then).
  if (S.job && !S.job.done) {
    S.waitingKey = key;
    return null;
  }
  S.waitingKey = null;
  // The exchange's supply is measured over a day, loaded on opening the tab: plan once it's in
  // (the page redraws then), not before and again after.
  if (X.supplyLoading?.()) {
    S.waitingForSupply = true;
    return null;
  }
  S.waitingForSupply = false;
  const wantFossils = !!(spec.B.info?.fossil && S.index?.fossils?.length);
  const parts = [{ label: 'Without fossils', phase: wantFossils ? 'base' : null }];
  if (wantFossils) {
    parts.push({ label: 'Fossils', phase: 'fossil' });
  }
  for (const part of parts) {
    Object.assign(part, { id: ++jobId, previews: new Map(), plans: null, error: null, finished: false, progress: 'Starting' });
  }
  const job = { key, parts, view: null, done: false };
  S.job = job;
  const message = { baseId: spec.B.id, bitem: spec.B.item ?? null, ilvl: spec.ilvl, infl: spec.infl, useFractured: spec.useFractured, start: spec.start ?? null, ...priceSnapshot(spec.B), options: planOptions(),
    targets: plannedTargets(spec).map(T => ({ id: T.m.id, minTier: T.minTier, crafted: !!T.crafted, frac: !!T.frac })) };
  for (let i = 0; i < parts.length; i++) {
    workers[i] ??= new Worker('craft-worker.js', { type: 'module' });
    runPart(job, parts[i], workers[i], message);
  }
  return null;
}

function runPart(job, part, worker, message) {
  worker.onmessage = e => {
    const data = e.data;
    if (data.id !== part.id) {
      return; // an older request
    }
    if (data.progress) {
      part.progress = data.progress;
      showProgress(job);
      return;
    }
    if (data.plan) {
      part.previews.set(data.plan.key, data.plan);
      settleJob(job);
      return;
    }
    part.finished = true;
    if (data.error) {
      part.error = data.error;
    } else {
      part.plans = data.plans;
    }
    settleJob(job);
  };
  worker.onerror = e => {
    part.finished = true;
    part.error = e.message || 'The planner crashed';
    settleJob(job);
  };
  // (The worker without fossils also plans "prefixes first" and "suffixes first".)
  worker.postMessage({ ...message, id: part.id, phase: part.phase, sidePlans: part.phase !== 'fossil' });
}

// New plans (or a finished list): merge everything so far into the list and redraw.
function settleJob(job) {
  let allFinished = true;
  let anyPlans = false;
  for (const part of job.parts) {
    if (!part.finished) {
      allFinished = false;
    }
    if (part.plans || part.previews.size) {
      anyPlans = true;
    }
  }
  job.done = allFinished;
  job.view = anyPlans || allFinished ? mergeParts(job) : null;
  if (S.job === job && job.view) {
    X.rerender();
  }
}

// What is still being worked out, in words.
function pendingText(job) {
  const working = [];
  for (const part of job.parts) {
    const heldBack = part.phase === 'fossil' && !otherWorkersDone(job, part);
    if (heldBack && part.finished) {
      working.push('fossils: ready, shown once the rest is done');
    } else if (!part.finished) {
      working.push(`${part.label.toLowerCase()}: ${part.progress}`);
    }
  }
  if (!working.length) {
    return '';
  }
  return `Working out (${working.join('; ')})…`;
}

function showProgress(job) {
  if (S.job !== job) {
    return;
  }
  const line = document.getElementById('craft-progress');
  if (line) {
    line.textContent = pendingText(job);
  }
}

// A worker's plans so far: its finished list, or the previews it has sent. The fossil plans are
// held back until the other worker is done, so they come last (they're worked out alongside).
function plansOfPart(part, job) {
  if (part.phase === 'fossil' && !otherWorkersDone(job, part)) {
    return [];
  }
  if (Array.isArray(part.plans)) {
    return part.plans;
  }
  return [...part.previews.values()];
}

function otherWorkersDone(job, part) {
  for (const other of job.parts) {
    if (other !== part && !other.finished) {
      return false;
    }
  }
  return true;
}

// Every worker's plans so far in one list. The same plan from both workers (with and without
// fossils): the cheaper one; a hidden table (Ways to start, ...): the fossil worker's, which also
// scores fossils. 'No way found' only once both are done and neither found a way.
function mergeParts(job) {
  const byKey = new Map();
  // (Plans only the fossil jobs found get a "fossils" badge.)
  const fromBasePhase = new Set();
  for (const part of job.parts) {
    if (part.phase !== 'fossil') {
      for (const plan of plansOfPart(part, job)) {
        fromBasePhase.add(plan.key);
      }
    }
  }
  let noWay = null;
  const errors = [];
  for (const part of job.parts) {
    if (part.error) {
      errors.push(`${part.label}: ${part.error}`);
    }
    for (const plan of plansOfPart(part, job)) {
      if (plan.key === 'none') {
        noWay = plan;
        continue;
      }
      const old = byKey.get(plan.key);
      if (!old) {
        const isNewFromFossils = part.phase === 'fossil' && !fromBasePhase.has(plan.key);
        byKey.set(plan.key, isNewFromFossils ? { ...plan, fossilNew: true } : plan);
        continue;
      }
      const fossilTable = plan.hidden && part.phase === 'fossil';
      const cheaper = plan.ok && (!old.ok || plan.cost < old.cost - 1e-9);
      if (fossilTable || cheaper) {
        byKey.set(plan.key, plan);
      }
    }
  }
  const list = [...byKey.values()].sort((a, b) => (a.ok === b.ok ? a.cost - b.cost : a.ok ? -1 : 1));
  const anyWorks = list.some(p => p.ok);
  if (job.done && !anyWorks && noWay) {
    list.push(noWay);
  }
  list.pending = !job.done;
  list.errors = errors;
  return list;
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
    R() ? ruthlessNote() : null,
    X.realm() === 'poe2' ? el('p', { class: 'status err' }, 'Crafting covers PoE 1 only. Prices below are estimates; switch the realm to a PoE 1 one for live prices.') : null,
    el('div', { class: 'segs', role: 'group', 'aria-label': 'Crafting view' }, modeBtn('builds', 'Popular builds'), modeBtn('any', 'Item builder'), modeBtn('bench', 'Workbench')),
  ];
  if (S.mode === 'builds') out.push(...buildsView());
  else if (S.mode === 'any') out.push(...anyView());
  else out.push(...benchView());
  out.push(sourcesNote());
  return out.filter(Boolean);
}

// Ruthless: thousands of Alchemy is more than most players ever hold (a Divine is about ten), so a
// plan that costs that much is a sign to aim lower.
const RUTHLESS_DEAR = 1000;
function ruthlessCostWarning(cost, spec) {
  if (!R() || !(cost >= RUTHLESS_DEAR)) return null;
  const { el } = X;
  const n = activeTargets(spec).length, frac = spec.useFractured && spec.targets.some(T => T.on && T.frac);
  return el('div', { class: 'status warnbox', role: 'note' },
    el('b', {}, `Reconsider crafting this: about ${money(cost)}. `),
    'In Ruthless that is a fortune. Prefer a fractured base over a clean start',
    frac ? ' (this plan already starts from one)' : S.mode === 'any' ? ' (tick "fractured" on the hardest mod you can find on a base)' : ' (in the Item builder, tick "fractured" on the hardest mod you can find on a base)',
    n > 2 ? `, and choose fewer mods: ${n} are picked, and every one you untick makes it much cheaper.` : '.');
}

function ruthlessNote() {
  const { el } = X;
  return el('div', { class: 'status' },
    el('p', {}, el('b', {}, `Ruthless rules, ${X.ruthlessLeague?.() ?? 'no Ruthless league in the loaded data'}. `),
      'Prices are in Orbs of Alchemy from the last 24 hours of that league (most items trade a few times a day there, so treat them as rough; "estimate" prices are Standard-league defaults converted at Ruthless\'s Chaos price). The planner leaves out what Ruthless doesn\'t have:'),
    el('ul', {},
      el('li', {}, 'the crafting bench (no bench crafts, metamods or blockers; bench-crafted mods of a build are dropped);'),
      el('li', {}, 'Harvest crafts and Crystallised Rancour, Bestiary crafting (Farric beasts, Craicic imprints, Wild Bristle Matron, Aspects), Veiled Chaos Orbs, Orbs of Binding, Orbs of Dominance, influenced Exalted Orbs and Awakener\'s Orbs;'),
      el('li', {}, 'Chaotic Resonators, and essences on rares: an essence or fossil reforge scours the item first, and fossils go in an Alchemical Resonator.')),
    el('p', { class: 'muted small' }, `Not modelled: a reforged influenced item loses its influence in Ruthless. Ruthless lost unpredictable recombination in 3.26.0, so its plans have no Recombinator routes (the Workbench still has predictable mode). Popular builds are ${S.targetsR ? `Ruthless characters (poe.ninja, ${S.targetsR.league}, ${S.targetsR.built})` : 'from the main league (no Ruthless snapshot loaded)'}.`));
}

function buildsView() {
  const { el } = X;
  const A = targets().archetypes;
  if (!A.length) return [el('p', { class: 'empty' }, 'No build data.')];
  S.arch = Math.min(S.arch, A.length - 1);
  const arch = A[S.arch];
  S.item = Math.min(S.item, Math.max(0, arch.items.length - 1));
  const out = [lockWhileBusy(true,
    el('div', { class: 'filters' },
      el('label', {}, 'Build', el('select', { onchange: e => { S.arch = +e.target.value; S.item = 0; S.spec = null; X.rerender(); } },
        A.map((a, i) => el('option', { value: i, selected: i === S.arch }, `${a.skill} ${a.class} (${a.share}% of characters)`)))),
      el('span', { class: 'muted' }, `poe.ninja, ${targets().league} league, ${targets().built}`)),
    el('div', { class: 'cards' }, arch.items.map((it, i) => el('button', {
      class: 'card' + (i === S.item ? ' on' : ''), 'aria-pressed': String(i === S.item),
      onclick: () => { S.item = i; S.spec = null; X.rerender(); },
    }, el('b', {}, it.slot), el('span', { class: 'name' }, it.name), el('small', {}, `${it.baseType}, item level ${it.ilvl}`),
      it.influences.length ? el('small', { class: 'infl' }, it.influences.join(' + ')) : null,
      el('small', { class: 'muted' }, `${it.mods.filter(m => m.id).length} mods · ${it.from}`))))),
  ];
  const item = arch.items[S.item];
  if (!item) return out;
  const B = itemBase(baseNow(item.base), item.baseType);
  if (!B) { base(item.base).then(() => X.rerender()); out.push(el('p', { class: 'muted' }, 'Loading mods for this base…')); return out; }
  if (!S.spec || S.spec.key !== ninjaKey()) S.spec = specFromNinja(arch, item, B);
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
  return src ? X.el('img', { class: 'cicon', src, alt: label, title: label || null, loading: 'lazy', referrerpolicy: 'no-referrer' }) : null;
};
// An icon right before the item's name: decorative (empty alt), so copied text doesn't say the name twice.
const nameIcon = name => curIcon(name, '');
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
// "N caster-tagged mods" link: a popup listing the mods not to pick when an unveil misses (a step's
// `avoid`: [{tag, mods}]), so the step's sentence stays short.
function avoidTrigger(s) {
  const { el } = X;
  if (!s.avoid?.length) return null;
  return s.avoid.map(list => popWrap(
    el('button', { class: 'linklike exbtn', type: 'button' }, `${list.mods.length} ${list.tag}-tagged mod${list.mods.length === 1 ? '' : 's'} not to pick`),
    el('div', { class: 'expop results', role: 'tooltip' },
      el('b', {}, `When an unveil misses, don't keep these (${list.tag})`),
      el('ul', { class: 'reslist' }, list.mods.map(text => el('li', {}, text))),
      el('p', { class: 'muted small' }, `"Cannot roll ${list.tag === 'caster' ? 'Caster' : 'Attack'} Modifiers" + Orb of Annulment can't remove them. Any other mod is fine.`))));
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
    // (An influenced item can't have Eldritch implicits: older saved picks or links may still list them.)
    const inflNow = B.innateInfl ?? A.infl;
    const targets = saved.map(p => ({ m: B.byId.get(p.id), p })).filter(x => x.m && !(inflNow.length && ELD(x.m))).map(({ m, p }) => {
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
  return [lockWhileBusy(true, filters,
    pasteBox(),
    yours ? yourItemCard(B, spec, yours) : null,
    el('div', { class: 'builder' }, itemCard(B, spec), modBrowser(B, spec, A, save))),
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
    el('span', { class: 'mt s-' + (T.crafted ? 'bench' : srcKindOf(T.m)) }, C.modText(T.m, T.minTier), T.text && T.text !== C.modText(T.m, T.minTier) ? el('small', { class: 'muted' }, ` on the original: ${T.text.replace('\n', ' / ')}`) : null, ' ', catChips(T.m, 3)),
    el('span', { class: 'mctl' },
      T.crafted ? srcTag({ src: 'bench' }, 'Bench', 'Crafted at the bench last') : srcTag(T.m, T.m.src === 'fossil' ? fossilFor(T.m)?.name ?? 'Fossil' : undefined),
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
      el('span', { class: 'iprice' }, !on.length ? '' : plans === NOT_STARTED ? el('small', { class: 'muted' }, 'not computed yet') : best ? ['≈ ', el('b', { class: 'gold' }, money(best.cost)), el('small', { class: 'muted' }, ` ${best.name}${plans.pending ? ' (so far)' : ''}`)]
        : plans?.error ? el('small', { class: 'down' }, 'planner error') : Array.isArray(plans) && !plans.pending ? el('small', { class: 'down' }, 'no way found') : el('small', { class: 'working' }, 'working out the cost…'))),
    ruthlessCostWarning(best?.cost, spec),
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
    ...B.mods.filter(m => (m.src === 'essence' || m.src === 'veiled' || m.src === 'fossil' || (m.src === 'bench' && !m.meta && !R())) && (m.affix === 'p' || m.affix === 's') && !wOf.has(m) && !C.baseBlocks(B, m))]; // (no bench in Ruthless)
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
        el('span', { class: 'mt s-' + srcKindOf(m) }, T ? '✓ ' : '', C.modText(m, top(m))),
        catChips(m, 3),
        srcTag(m),
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
  // The list is long: it can be folded away (remembered with the builder's other settings).
  const body = el('div', { class: 'panel-body', id: 'modbrowser-body', hidden: !!A.browserFolded },
    el('div', { class: 'filters' }, el('label', {}, 'Search', search), el('label', {}, 'Source', srcSel)),
    catBar,
    box,
    el('p', { class: 'muted small' }, 'Chance: how likely one new random mod is this one at any tier the item level allows (its weight over its side\'s total, halved because a new mod is a prefix or a suffix about half the time). Open a mod for its tiers.'));
  const foldButton = el('button', { type: 'button', class: 'ghost small fold', 'aria-controls': 'modbrowser-body', 'aria-expanded': String(!A.browserFolded) }, A.browserFolded ? 'Show ▾' : 'Hide ▴');
  foldButton.addEventListener('click', () => {
    A.browserFolded = !A.browserFolded;
    save();
    body.hidden = A.browserFolded;
    foldButton.setAttribute('aria-expanded', String(!A.browserFolded));
    foldButton.textContent = A.browserFolded ? 'Show ▾' : 'Hide ▴';
  });
  return el('section', { class: 'browser panel', 'aria-label': 'All mods for this base' },
    el('div', { class: 'panel-head' }, el('h4', {}, `All mods for this base (${mods.length})`), foldButton),
    body);
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
    el('td', { class: 'l' }, T.text ? el('span', { class: 'mt s-' + (T.crafted ? 'bench' : srcKindOf(T.m)) }, T.text.split('\n').flatMap((l, i) => (i ? [el('br'), l] : [l]))) : C.modText(T.m, T.minTier),
      el('small', { class: 'muted' }, ' ', C.modText(T.m, T.minTier)), catChips(T.m, 3)),
    el('td', {}, T.crafted ? srcTag({ src: 'bench' }, 'Bench', 'Crafted at the bench') : srcTag(T.m), T.frac ? badge('Fractured', 'Fractured on the original') : null),
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
    lockWhileBusy(false,
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
    optionsView(spec)),
  ];
  if (!activeTargets(spec).length) { out.push(el('p', { class: 'muted' }, 'Pick at least one mod.')); return out; }
  const plans = planFor(spec);
  if (plans === NOT_STARTED) {
    out.push(el('div', { class: 'startbox' },
      el('button', { class: 'primary', onclick: () => startComputing(spec) }, 'Start computing'),
      el('small', { class: 'muted' }, ' Plans every way to craft these mods. With three or more mods it can take 10–20 seconds; pick the mods you want first.')));
    return out;
  }
  if (!plans && S.waitingKey && S.job && !S.job.done) {
    out.push(el('p', { class: 'working' }, 'Waiting for the plan of the previous item to finish; this one starts right after.'));
    return out;
  }
  if (!plans && S.waitingForSupply) {
    out.push(el('p', { class: 'working' }, 'Loading the last 24 hours of trades first (what the exchange can supply)…'));
    return out;
  }
  if (!plans) { out.push(el('p', { class: 'working', id: 'craft-progress', 'aria-live': 'polite' }, S.job ? pendingText(S.job) : 'Starting…')); return out; }
  if (plans.error) { out.push(el('p', { class: 'status err' }, plans.error)); return out; }
  out.push(plansView(plans));
  out.push(hardestModView(spec, view));
  out.push(fractureRankView(spec, view));
  out.push(pricesUsed(plans, spec));
  return out;
}

// ---------- fractured base and side order ----------
// Runs the planner once with nothing fractured, then once per wanted mod starting from a base
// with that mod already fractured (bought; its price isn't counted). The cheaper the rest of the
// craft, the better that mod is to buy fractured. This measures how hard each mod really is to
// get later with every method, not just its weight: a rare mod that a Harvest reforge or add can
// force (when few mods share its type) is easy later, so fracturing it wastes the one fracture.
// Each run also prices doing one side first, then the other (spec.sideOrder in craft.js): the way
// deterministic crafts are done, e.g. fracture a suffix, do the prefixes, then finish the suffixes.
// It has its own worker, so the plans above aren't held up; a full plan per mod can take minutes.
let rankWorker = null;

// The mods a bought base could have fractured: the planned ones, not crafted, not Eldritch.
function fractureCandidates(spec) {
  const candidates = [];
  for (const T of plannedTargets(spec)) {
    if (T.crafted || ELD(T.m)) {
      continue;
    }
    candidates.push(T);
  }
  return candidates;
}

// Everything the ranking depends on (which mod is ticked fractured doesn't matter: it tries each).
function fractureRankKey(spec) {
  ovr();
  const targetParts = [];
  for (const T of plannedTargets(spec)) {
    targetParts.push(T.m.id + ':' + T.minTier + (T.crafted ? 'c' : ''));
  }
  const parts = [R(), spec.key, spec.ilvl, targetParts.join(','), JSON.stringify(S.overrides ?? {}), X.realm(), X.supplyKey?.() ?? '', JSON.stringify(planOptions())];
  return parts.join('|');
}

function stopFractureRank() {
  if (rankWorker) {
    rankWorker.terminate();
    rankWorker = null;
  }
  S.fracRank = null;
}

// The cheapest plan that works, or null.
function cheapestWorkingPlan(plans) {
  let cheapest = null;
  for (const plan of plans) {
    if (!plan.ok) {
      continue;
    }
    if (!cheapest || plan.cost < cheapest.cost) {
      cheapest = plan;
    }
  }
  return cheapest;
}

function startFractureRank(spec) {
  stopFractureRank();
  const runs = [{ label: 'Nothing fractured (the plans may still use a Fracturing Orb)', targetId: null }];
  for (const T of fractureCandidates(spec)) {
    runs.push({ label: C.modText(T.m, T.minTier), targetId: T.m.id });
  }
  const rank = { key: fractureRankKey(spec), runs, next: 0, progress: 'Starting', done: false };
  S.fracRank = rank;
  rankWorker = new Worker('craft-worker.js', { type: 'module' });
  const worker = rankWorker;
  const common = { baseId: spec.B.id, bitem: spec.B.item ?? null, ilvl: spec.ilvl, infl: spec.infl, start: null, ...priceSnapshot(spec.B), options: planOptions() };
  const targetsFor = fracturedId => {
    const targets = [];
    for (const T of plannedTargets(spec)) {
      targets.push({ id: T.m.id, minTier: T.minTier, crafted: !!T.crafted, frac: T.m.id === fracturedId });
    }
    return targets;
  };
  const finishRun = (run, result) => {
    if (result.error) {
      run.error = result.error;
    } else {
      const cheapest = cheapestWorkingPlan(result.plans);
      run.cost = cheapest ? cheapest.cost : Infinity;
      run.planName = cheapest ? cheapest.name : 'no way found';
      run.sides = result.plans.find(p => p.key === 'sides')?.sides ?? null;
    }
    run.finished = true;
    rank.next++;
    rank.progress = 'Starting';
    runNext();
    X.rerender();
  };
  const runNext = () => {
    if (S.fracRank !== rank) {
      return;
    }
    if (rank.next >= runs.length) {
      rank.done = true;
      worker.terminate();
      if (rankWorker === worker) {
        rankWorker = null;
      }
      return;
    }
    const run = runs[rank.next];
    const id = ++jobId;
    worker.onmessage = e => {
      const message = e.data;
      if (message.id !== id || S.fracRank !== rank) {
        return;
      }
      if (message.progress) {
        rank.progress = message.progress;
        const line = document.getElementById('fracrank-progress');
        if (line) {
          line.textContent = fractureRankProgressText(rank);
        }
        return;
      }
      finishRun(run, message.error ? { error: message.error } : { plans: message.plans });
    };
    worker.onerror = e => {
      if (S.fracRank === rank) {
        finishRun(run, { error: e.message || 'The planner crashed' });
      }
    };
    worker.postMessage({ ...common, id, sideOrder: true, useFractured: run.targetId != null, targets: targetsFor(run.targetId) });
  };
  runNext();
}

function fractureRankProgressText(rank) {
  return `Planning ${rank.next + 1} of ${rank.runs.length}: ${rank.runs[rank.next]?.label ?? ''} (${rank.progress})…`;
}

// The cheapest "one side first" option among the finished runs: {run, order}, or null.
function cheapestSideOrder(runs) {
  let best = null;
  for (const run of runs) {
    for (const order of run.sides?.orders ?? []) {
      if (!isFinite(order.total)) {
        continue;
      }
      if (!best || order.total < best.order.total) {
        best = { run, order };
      }
    }
  }
  return best;
}

// "Use this": ticks the target as the one fractured on the bought base ("ticked" once it is).
function useFracturedButton(spec, target) {
  const { el } = X;
  if (target.frac) {
    return el('small', { class: 'muted' }, 'ticked');
  }
  const tick = () => {
    for (const T of spec.targets) {
      T.frac = false;
    }
    target.frac = true;
    spec.useFractured = true;
    X.rerender();
  };
  return el('button', { class: 'linklike', onclick: tick }, 'Use this');
}

// ---------- the hardest mod ----------
// Which wanted mod is hardest to get, and why (C.rankModDifficulty): its weight, the crafts that
// aim at it, and whether its types are shared. The hardest one is the mod to buy fractured.
// Instant (no planning), so it's always shown; the full plans under "Fractured base and side
// order" check it with every method and price.
function hardestModView(spec, view) {
  const { el } = X;
  const rows = C.rankModDifficulty(spec.B, plannedTargets(spec), { ilvl: spec.ilvl, infl: spec.infl, price, essenceLevels: S.index?.essenceLevels });
  if (rows.length < 2) {
    return null;
  }
  const hardest = rows.find(row => row.hardest);
  const chanceText = p => (p > 0 ? C.pctText(p) : '–');
  const perHitText = way => (way && isFinite(way.perHit) ? money(way.perHit) : '–');
  const typesCell = row => {
    if (!row.shared.length) {
      return el('td', { class: 'l muted' }, 'none Harvest can aim at');
    }
    const lines = [];
    for (const share of row.shared) {
      const wanted = share.wanted.length ? `, ${share.wanted.length} wanted` : '';
      lines.push(el('div', { title: `${share.otherModsAnySide} other mods with this type on either side` }, `${share.tag}: ${share.otherModsOnSide} other ${SIDE[row.side].toLowerCase()}${share.otherModsOnSide === 1 ? '' : 'es'}${wanted}`));
    }
    return el('td', { class: 'l' }, lines);
  };
  const bestCell = row => {
    if (!row.best || row.best.chance <= 0) {
      return el('td', { class: 'l muted' }, 'can\'t roll');
    }
    const forcedNote = row.best.forced ? ' (forced)' : '';
    return el('td', { class: 'l' }, el('b', {}, chanceText(row.best.chance)), ' ', row.best.name, forcedNote,
      el('br'), el('small', { class: 'muted' }, `≈ ${perHitText(row.best)} per hit`));
  };
  const tableRows = rows.map((row, index) => el('tr', { class: row.hardest ? 'cur' : '' },
    el('td', {}, String(index + 1)),
    el('td', { class: 'l' }, row.hardest ? el('b', { class: 'gold' }, row.label) : row.label),
    el('td', {}, SIDE[row.side]),
    el('td', {}, chanceText(row.weightShare), el('br'), el('small', { class: 'muted' }, `tier ${chanceText(row.tierShare)}`)),
    el('td', {}, chanceText(row.chaosChance), el('br'), el('small', { class: 'muted' }, isFinite(row.chaosPerHit) ? `≈ ${money(row.chaosPerHit)} per hit` : '')),
    bestCell(row),
    typesCell(row),
    el('td', { class: 'l small' }, row.reason),
    view.builder ? el('td', {}, row.canFracture ? useFracturedButton(spec, row.target) : el('small', { class: 'muted' }, 'can\'t be fractured')) : null));
  const headers = ['#', 'Wanted mod', 'Side', 'Random pick (share of side)', 'One Chaos Orb', 'Best way to aim at it', 'Harvest types shared', 'Why'];
  if (view.builder) {
    headers.push('');
  }
  let verdict;
  if (hardest) {
    verdict = el('p', {}, 'Hardest on its own: ', el('b', { class: 'gold' }, hardest.label), `. ${hardest.reason} A rule of thumb for which mod to buy fractured: what fossils give together and what later steps make free can change it, so check with "Compare fractured bases" below.`);
  } else if (spec.infl.length) {
    verdict = el('p', { class: 'muted' }, 'Influenced items can\'t be fractured: the order still shows which mod to plan around.');
  } else {
    verdict = el('p', { class: 'muted' }, 'None of the wanted mods can be bought fractured (bench and veiled mods).');
  }
  return el('details', { class: 'worked compare', open: S.hardestOpen ?? true, ontoggle: e => { S.hardestOpen = e.target.open; } },
    el('summary', {}, 'Hardest mod'),
    el('p', { class: 'muted small' },
      'Each wanted mod, hardest first, by its best chance per pick: a random roll (its share of its side\'s pool at the wanted tier or better), ',
      'or a craft that aims at it: an essence or bench craft (always), Harvest "add a mod of a type" (its share of that type on its side: the only mod of a type is always added, only the tier is luck), ',
      'Harvest reforge with a type, or a veiled mod and unveiling. A type shared with other mods makes those crafts less sure. ',
      'Chances only, so prices don\'t change the order; the cost per hit is shown beside each. The full plans below check it with every method.'),
    verdict,
    el('div', { class: 'scroll' }, el('table', { class: 'cmp' },
      el('thead', {}, el('tr', {}, headers.map((h, i) => el('th', { scope: 'col', class: i === 1 || i >= 5 ? 'l' : '' }, h)))),
      el('tbody', {}, tableRows))));
}

function fractureRankView(spec, view) {
  const { el } = X;
  // Influenced items can't be fractured, and your own item already decides what is fractured.
  if (spec.infl.length || spec.start) {
    return null;
  }
  const candidates = fractureCandidates(spec);
  if (!candidates.length) {
    return null;
  }
  // A changed item or price makes an old ranking wrong: drop it (and stop it if it's running).
  if (S.fracRank && S.fracRank.key !== fractureRankKey(spec)) {
    stopFractureRank();
  }
  const rank = S.fracRank;
  const intro = el('p', { class: 'muted small' },
    'Plans the whole craft once with nothing fractured, then once per mod starting from a base you buy with that mod fractured (its price isn\'t counted). ',
    'The cheaper the rest, the better that mod is to buy fractured: it is the mod that is hardest to get later with every method, which is not always the rarest one (a rare mod that a Harvest reforge or add can force is easy later). ',
    'A mod costing more than "nothing fractured" is worse than no fractured base at all: it uses up the one fracture an item can have. ',
    'Each is also priced side by side: all the prefixes first (nothing aims only at suffixes until then, but wanted suffixes that land are kept and losing one counts), then the suffixes, and the reverse. The cost of the first side is shown under each; the rest is finishing the other side. ',
    `It runs ${candidates.length + 1} full plans, one after another, so it can take a few minutes.`);
  const summary = el('summary', {}, 'Fractured base and side order');
  // (The page is redrawn after each plan: keep it open or closed as the visitor left it.)
  const detailsAttributes = { class: 'worked compare', open: S.fracRankOpen ?? !!rank, ontoggle: e => { S.fracRankOpen = e.target.open; } };
  if (!rank) {
    const mainBusy = S.job && !S.job.done;
    return el('details', detailsAttributes, summary, intro,
      el('button', { class: 'ghost', disabled: !!mainBusy, title: mainBusy ? 'Once the plans above are done' : null, onclick: () => { startFractureRank(spec); X.rerender(); } }, 'Compare fractured bases and side order'),
      mainBusy ? el('small', { class: 'muted' }, ' (once the plans above are done)') : null);
  }
  let baseline = null;
  const finishedRuns = [];
  const others = [];
  for (const run of rank.runs) {
    if (!run.finished) {
      continue;
    }
    finishedRuns.push(run);
    if (run.targetId == null) {
      baseline = run;
    } else {
      others.push(run);
    }
  }
  others.sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity));
  const bestSideOrder = cheapestSideOrder(finishedRuns);

  const useButton = run => {
    const target = spec.targets.find(T => T.m.id === run.targetId);
    if (!target) {
      return null;
    }
    return useFracturedButton(spec, target);
  };
  const costCell = run => {
    if (run.error) {
      return el('td', { class: 'down' }, 'planner error');
    }
    if (!isFinite(run.cost)) {
      return el('td', { class: 'muted' }, 'no way found');
    }
    return el('td', { title: run.planName }, el('b', { class: 'gold' }, money(run.cost)), el('br'), el('small', { class: 'muted' }, run.planName));
  };
  const compareCell = run => {
    if (!baseline || !isFinite(baseline.cost) || !isFinite(run.cost ?? NaN) || run === baseline) {
      return el('td', { class: 'muted' }, '–');
    }
    const ratio = run.cost / baseline.cost;
    const cheaper = ratio < 1;
    return el('td', { class: cheaper ? 'up' : 'down' }, cheaper ? `${C.fmtN((1 - ratio) * 100)}% cheaper` : `${C.fmtN(ratio)}× the cost`);
  };
  const orderCell = (run, firstSide) => {
    const order = run.sides?.orders?.find(o => o.first === firstSide);
    if (!order || !isFinite(order.total)) {
      return el('td', { class: 'muted' }, '–');
    }
    const isCheapest = bestSideOrder && bestSideOrder.order === order;
    const firstSideText = order.firstSideCost != null ? `${SIDE[firstSide].toLowerCase()}es ≈ ${money(order.firstSideCost)}` : '';
    return el('td', { class: isCheapest ? 'best' : '' },
      isCheapest ? el('b', { class: 'gold' }, money(order.total)) : money(order.total),
      el('br'), el('small', { class: 'muted' }, firstSideText));
  };
  const row = run => el('tr', {},
    el('td', { class: 'l' }, run.label),
    costCell(run),
    orderCell(run, 'p'),
    orderCell(run, 's'),
    compareCell(run),
    view.builder ? el('td', {}, run.targetId == null ? null : useButton(run)) : null);
  const headers = ['Bought base', 'Cheapest plan (any order)', 'Prefixes first, then suffixes', 'Suffixes first, then prefixes', 'Cheapest plan against nothing fractured'];
  if (view.builder) {
    headers.push('');
  }
  const rows = [];
  if (baseline) {
    rows.push(row(baseline));
  }
  for (const run of others) {
    rows.push(row(run));
  }
  return el('details', detailsAttributes, summary, intro,
    rank.done ? null : el('p', { class: 'working', id: 'fracrank-progress', 'aria-live': 'polite' }, fractureRankProgressText(rank)),
    bestSideOrder ? sideOrderAdvice(bestSideOrder, baseline, rank.done) : null,
    rows.length ? el('div', { class: 'scroll' }, el('table', { class: 'cmp' },
      el('thead', {}, el('tr', {}, headers.map((h, i) => el('th', { scope: 'col', class: i === 0 ? 'l' : '' }, h)))),
      el('tbody', {}, rows))) : null,
    el('button', { class: 'ghost', onclick: () => { startFractureRank(spec); X.rerender(); } }, rank.done ? 'Compare again' : 'Restart'));
}

// The cheapest side-by-side way, in words, with the steps of its first side.
function sideOrderAdvice(best, baseline, allDone) {
  const { el } = X;
  const { run, order } = best;
  const firstName = SIDE[order.first].toLowerCase() + 'es';
  const otherName = SIDE[order.first === 'p' ? 's' : 'p'].toLowerCase() + 'es';
  let baseText = 'Start from a normal base';
  if (run.targetId != null) {
    baseText = `Buy a base with ${run.label} fractured`;
  }
  const firstCost = order.firstSideCost != null ? ` (≈ ${money(order.firstSideCost)})` : '';
  const restCost = order.firstSideCost != null ? ` (≈ ${money(order.total - order.firstSideCost)})` : '';
  const anyOrder = baseline && isFinite(baseline.cost) ? ` The cheapest plan with no fixed order, from a normal base, is ≈ ${money(baseline.cost)}.` : '';
  // The other order on the same base, when it's about as good (within 2%).
  let otherOrderText = '';
  const otherOrder = run.sides.orders.find(o => o !== order);
  if (otherOrder && isFinite(otherOrder.total) && otherOrder.total <= order.total * 1.02) {
    otherOrderText = ` The other way round (${otherName} first) is about as good: ≈ ${money(otherOrder.total)}.`;
  }
  const soFar = allDone ? '' : ' (so far)';
  return el('div', { class: 'sideadvice' },
    el('p', {}, el('b', {}, `Cheapest side by side${soFar}: `),
      `${baseText}, do the ${firstName} first${firstCost}, then finish the ${otherName}${restCost}: ≈ `, el('b', { class: 'gold' }, money(order.total)), ' in all.', otherOrderText, anyOrder),
    order.steps?.length ? el('details', {}, el('summary', {}, `How to do the ${firstName} (until they are all on the item)`),
      stepsOl(order.steps, 'sideorder')) : null);
}
const badge = (t, title) => X.el('span', { class: 'badge', title }, t);
// Where a mod comes from, as a coloured tag with a glyph: the same text often exists as a base
// mod, an essence mod and a veiled mod, and only the tag tells them apart at a glance.
const SRC_GLYPH = { base: '', essence: '◆', veiled: '◐', bench: '⚒', fossil: '◈', beast: '❖', infl: '✦', eld: '✶' };
const srcKindOf = m => (ELD(m) ? 'eld' : C.INFLUENCES.includes(m.src) ? 'infl' : m.src);
function srcTag(m, label, title) {
  const k = srcKindOf(m);
  return X.el('span', { class: 'srctag s-' + k, title }, SRC_GLYPH[k] ? SRC_GLYPH[k] + ' ' : '', label ?? (ELD(m) ? 'Eldritch' : SRC_LABEL[m.src] ?? m.src));
}

function plansView(plans) {
  const { el } = X;
  const ok = plans.filter(p => p.ok), bad = plans.filter(p => !p.ok && !p.hidden);
  const compare = plans.find(p => p.key === 'compare')?.compare;
  const lab = plans.find(p => p.key === 'fossillab')?.lab;
  if (!ok.length && plans.pending) {
    return el('div', {}, el('p', { class: 'working', id: 'craft-progress', 'aria-live': 'polite' }, pendingText(S.job)));
  }
  if (!ok.length) return el('div', {}, el('p', { class: 'empty' }, 'No method reaches all of these mods. Loosen a tier or untick a mod.'),
    bad.length ? el('ul', {}, bad.map(p => el('li', {}, `${p.name}: ${p.why}`))) : null);
  const best = ok[0].cost;
  const mirror = price('Mirror of Kalandra');
  const yoursBad = bad.find(p => p.fromItem);
  return el('div', { class: 'plans' },
    el('h3', {}, 'Ways to craft it, cheapest first'),
    S.spec && S.mode !== 'any' ? ruthlessCostWarning(best, S.spec) : null, // (the item builder shows it on the item card)
    yoursBad ? el('p', { class: 'status err' }, `From your item: ${yoursBad.why}`) : null,
    plans.pending ? el('p', { class: 'working', id: 'craft-progress', 'aria-live': 'polite' }, pendingText(S.job), ' Each way shows up here as soon as it is worked out.') : null,
    plans.errors?.length ? el('p', { class: 'status err' }, `Some ways failed: ${plans.errors.join('; ')}`) : null,
    isFinite(mirror) ? el('p', { class: 'muted' }, `For scale: a Mirror of Kalandra is ${money(mirror)}. Anything costing more than that is cheaper to buy as a mirrored copy.`) : null,
    ok.slice(0, 10).map((p, i) => el('details', { class: 'plan', open: i === 0 },
      el('summary', {}, el('span', { class: 'rank' }, `${i + 1}`), el('b', {}, p.name),
        el('span', { class: 'cost' }, '≈ ', el('b', { class: 'gold' }, money(p.cost))),
        i ? el('small', { class: 'muted' }, best > 0 ? `${C.fmtN(p.cost / best)}× the first` : `${money(p.cost)} more`) : el('small', { class: 'badge new' }, 'cheapest'),
        p.fromItem ? el('small', { class: 'badge' }, 'from your item') : null,
        p.fossilNew ? el('small', { class: 'badge', title: 'Worked out on the fossil thread' }, 'fossils') : null,
        p.clicksExact ?? p.clicks ? el('small', { class: 'muted', title: 'Clicks per craft on average: each fossil, resonator, orb, beast or bench craft used is one (dust, gold, lifeforce and sulphur are not)' }, `≈ ${C.fmtN(p.clicksExact ?? p.clicks)} clicks`) : null,
        isFinite(mirror) && p.cost > mirror ? el('small', { class: 'badge warn' }, `${C.fmtN(p.cost / mirror)} mirrors`) : null),
      p.recipe ? recipeView(p.recipe, planId(p)) : null,
      stepsOl(p.steps, planId(p)),
      startsView(p),
      el('p', { class: 'muted' }, 'This is the likeliest path. Each step is the cheapest move from that state, so a different roll just means following the strategy from wherever the item ends up.'),
      p.usage ? usageView(p.usage) : null,
      p.graph ? graphSection(p.graph, p.cost) : null,
      p.notes?.length ? el('p', { class: 'muted' }, p.notes.join(' ')) : null)),
    lab ? fossilLabView(lab) : null,
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

// A plan's steps as a numbered list (pid: the id prefix the "back to step N" links use).
function stepsOl(steps, pid) {
  const { el } = X;
  return el('ol', { class: 'steps' }, steps.map((s, i) => el('li', { id: `${pid}-s${i + 1}` },
        s.from ? el('small', { class: 'from' }, `When the item ${s.from}:`) : null,
        el('span', { class: 'steptext' }, richText(s.text)), ' ', resultsTrigger(s), s.results ? ' · ' : null, s.avoid ? [avoidTrigger(s), ' · '] : null, exampleTrigger(s.exFrom, s.ex),
        el('div', { class: 'stepnum' }, s.flow ? flowLine(s.flow, i, pid) : s.p < 1 ? el('span', {}, `${C.pctText(s.p)} chance it moves on`) : null,
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
            : s.clicksLeft != null ? el('span', { class: 'along' }, 'clicks left from here ≈ ', el('b', {}, C.fmtN(s.clicksLeft)))
            : s.cost ? el('span', {}, `this step ≈ ${money(s.cost)}`) : null),
        s.recipe ? recipeView(s.recipe, pid) : null,
        stepCounts(s, i))));
}
// Other starting points: where the opening (the first spam, the recombine, ...) can leave the item
// besides the likeliest result the steps above follow, and the plan from each, with its own state
// graph for the fossil plans.
function startsView(p) {
  const { el } = X;
  if (!p.starts || p.starts.length < 2) return null;
  const box = el('div', { class: 'altstart' });
  const btns = p.starts.map((st, i) => el('button', { type: 'button', class: 'seg', 'aria-pressed': 'false', onclick: e => {
    for (const b of btns) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }
    e.currentTarget.classList.add('on'); e.currentTarget.setAttribute('aria-pressed', 'true');
    const pid = `${planId(p)}-a${i}`;
    box.replaceChildren(
      el('p', { class: 'muted small' }, `${C.pctText(st.p)} of the results worth keeping: the item ${st.text}. `, st.done ? 'Nothing left to roll.' : ['From here the plan expects about ', el('b', { class: 'gold' }, p.key === 'fosclicks' ? `${C.fmtN(st.rem)} clicks` : money(st.rem)), ' more.']),
      st.ex ? exampleCard(st.ex, 'The item at this point') : null,
      stepsOl(st.steps, pid),
      st.graph ? graphSection(st.graph, st.rem) : null);
  } }, el('b', {}, C.pctText(st.p)), ' ', st.done ? 'done' : st.text.replace(/^has /, '')));
  return el('details', { class: 'worked starts' },
    el('summary', {}, 'Other starting points', el('small', { class: 'muted' }, ` — the steps follow the likeliest result; ${p.starts.length} ways the opening can land, and the plan from each`)),
    el('div', { class: 'segs wrap' }, btns), box);
}
// A recombination as a recipe card: the two inputs side by side (what to do to each, what it
// must show), the bench, and a table of what comes out and what to do next.
const sideTag = side => X.el('span', { class: 'sidetag' }, side === 'p' ? 'P' : 'S');
function recipeView(r, pid) {
  const { el } = X;
  const stepLink = n => el('a', { href: `#${pid}-s${n}` }, `step ${n}`);
  const input = (h, i) => el('div', { class: 'rcard' },
    el('header', {}, el('b', {}, h.yours ? 'Item A: this item' : `Item ${'AB'[i]}`), el('small', { class: 'muted' }, h.yours ? ' as it is now' : h.fossil ? ' new base → rare, with fossils' : h.regal ? ' new base → magic → rare' : ' new base → magic')),
    el('ul', { class: 'rmods' }, h.mods.map(x => el('li', {}, sideTag(x.side), ' ', x.text, x.regal ? el('small', { class: 'muted' }, ' (Regal)') : null)),
      h.junk ? el('li', { class: 'muted' }, `+ ${h.junk} junk mod${h.junk > 1 ? 's' : ''}`) : null),
    h.fossil ? el('ol', { class: 'rhow' },
      el('li', {}, h.fossil.scour ? 'Scour it, then ' : '', el('b', {}, h.fossil.names.join(' + ')), ` in a ${h.fossil.resonator}, until it has `, h.mods.map(x => x.text).join(' + '),
        el('small', { class: 'muted' }, ` · ${C.pctText(h.fossil.p)} per try, about ${C.fmtN(1 / h.fossil.p)}`)),
      el('li', { class: 'muted' }, 'Keep whatever else it rolled: it all goes into the recombine',
        h.fossil.junk != null ? ` (about ${C.fmtN(h.fossil.junk)} junk mods on average${h.fossil.bonus > 0.005 ? `; ${C.pctText(h.fossil.bonus)} of the time an extra wanted mod too` : ''})` : '', '.'))
    : h.yours ? null : el('ol', { class: 'rhow' },
      el('li', {}, 'Orb of Transmutation, then ', el('b', {}, 'Alteration'), ' until it shows exactly ', h.alt.mods.join(' + '), ' and nothing else',
        h.alt.aug ? ' (Augment when one of them shows alone)' : '', el('small', { class: 'muted' }, ` · ${C.pctText(h.alt.p)} per Alteration, about ${C.fmtN(1 / h.alt.p)}`)),
      h.regal ? el('li', {}, h.regal.imprint ? 'Imprint it (Craicic Chimeral), then ' : '', el('b', {}, 'Regal'), ` until it adds ${h.regal.mod}`,
        el('small', { class: 'muted' }, ` · ${C.pctText(h.regal.p)} per Regal${h.regal.imprint ? ', restore the imprint on a miss' : ', a miss means Alterations again'}`)) : null),
    h.yours ? null : el('p', { class: 'rcost' }, '≈ ', el('b', { class: 'gold' }, money(h.cost)), h.fossil ? ' per item' : ' per clean item'));
  const outs = r.outs ? el('table', { class: 'mini rout' },
    el('thead', {}, el('tr', {}, el('th', { class: 'l' }, 'Comes out with'), el('th', {}, 'Chance'), el('th', { class: 'l' }, 'Then'))),
    el('tbody', {},
      r.outs.slice(0, 5).map(o => el('tr', { class: o.full ? 'best' : '' },
        el('td', { class: 'l' }, o.full ? `all ${o.mods.length} mods` : [`${o.mods.length} of ${o.mods.length + o.lost.length}, lost `, el('span', { class: 'down' }, o.lost.join(', '))]),
        el('td', {}, C.pctText(o.p)),
        // (The steps follow the likeliest result, all mods kept; a partial one is finished by the same strategy.)
        el('td', { class: 'l' }, o.done ? 'done' : o.full && r.finishAt ? ['keep it, finish from ', stepLink(r.finishAt)] : 'keep it; the plan finishes it from there'))),
      r.outs.length > 5 ? el('tr', {}, el('td', { class: 'l muted' }, `${r.outs.length - 5} other partial results`), el('td', {}, C.pctText(r.outs.slice(5).reduce((a, o) => a + o.p, 0))), el('td', { class: 'l' }, 'keep and finish')) : null,
      r.retry > 1e-4 ? el('tr', {}, el('td', { class: 'l' }, 'too little'), el('td', {}, C.pctText(r.retry)), el('td', { class: 'l' }, 'throw it away, make Items A and B again')) : null)) : null;
  return el('div', { class: 'recomb' },
    el('div', { class: 'rins' }, r.halves.map(input).flatMap((c, i) => (i ? [el('span', { class: 'rplus', 'aria-hidden': 'true' }, '+'), c] : [c]))),
    el('div', { class: 'rbench' }, el('span', { class: 'rarrow', 'aria-hidden': 'true' }, '↓'), ' ', el('b', {}, 'Recombinator, unpredictable mode'),
      el('small', { class: 'muted' }, ` · ${money(r.benchCost)} of dust and gold a use · both inputs are used up`)),
    outs ?? el('p', { class: 'muted small' }, `${C.pctText(r.pGood)} of the time it comes out better than this item; whatever survives is still a clean item.`),
    r.rounds > 1.05 ? el('p', { class: 'muted small' }, `About ${C.fmtN(r.rounds)} recombines on average, each with a new Item A and Item B.`) : null);
}

// What one try of a step uses, and how much of it to expect: before it moves on (66% / 90% of
// the time), and over the whole craft (the step comes back after a bricked item or a loop back).
function stepCounts(s, i) {
  const { el } = X;
  const items = Object.entries(s.bill ?? {}).filter(([, v]) => v > 0);
  if (!items.length) return null;
  const n = x => C.fmtN(Math.ceil(x - 1e-9));
  const value = items.reduce((a, [k, v]) => a + v * (price(k) || 0), 0);
  const list = k => items.flatMap(([name, v], j) => [j ? ', ' : '', el('b', {}, n(v * k)), ' ', nameIcon(name), ' ', name]);
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
// Fossil lab: Craft of Exile's fossil calculator, judged by today's prices. The best combination
// of each size three ways (whole craft with best play after it, cost to land every mod in one
// reforge, clicks for that), and every combination tried with its chance per mod.
function fossilLabView(lab) {
  const { el } = X;
  const fos = r => [el('span', {}, nameWithIcons(r)), el('small', { class: 'muted' }, ` · ${r.resonator.replace(/ (Chaotic|Alchemical) Resonator$/, '')}`)];
  const hit = (r, f, fmt) => (r && isFinite(r[f]) ? [fos(r), el('br'), el('b', { class: f === 'R' ? 'gold' : '' }, fmt(r[f]))] : el('span', { class: 'muted' }, '–'));
  const bestTable = el('table', { class: 'cmp' },
    el('thead', {}, el('tr', {}, ['Fossils', 'Cheapest whole craft', 'Cheapest to land all at once', 'Fewest clicks to land all at once'].map((h, i) => el('th', { scope: 'col', class: i ? 'l' : '' }, h)))),
    el('tbody', {}, lab.best.map(b => el('tr', {},
      el('td', {}, `${b.size}`),
      el('td', { class: 'l' }, hit(b.whole, 'R', money)),
      el('td', { class: 'l' }, hit(b.perHit, 'perHit', v => `${money(v)} (${C.pctText(b.perHit.pAll)} a try)`)),
      el('td', { class: 'l' }, hit(b.clicks, 'clicksPerHit', v => `${C.fmtN(v)} clicks`))))));
  const sorts = { R: 'Whole craft', perHit: 'Cost per full hit', clicksPerHit: 'Clicks per full hit' };
  let by = 'R';
  const tbody = el('tbody');
  const fill = () => tbody.replaceChildren(...[...lab.rows].sort((a, b) => a[by] - b[by]).slice(0, 30).map(r => el('tr', {},
    el('td', { class: 'l' }, fos(r)),
    el('td', {}, money(r.cost), el('br'), el('small', { class: 'muted' }, `${r.clicks} clicks`)),
    ...r.pK.map(p => el('td', { class: p > 0.2 ? 'up' : p < 0.02 ? 'down' : '' }, C.pctText(p))),
    el('td', {}, r.pAll > 0 ? C.pctText(r.pAll) : '–'),
    el('td', {}, isFinite(r.perHit) ? money(r.perHit) : '–'),
    el('td', {}, isFinite(r.clicksPerHit) ? C.fmtN(r.clicksPerHit) : '–'),
    el('td', {}, el('b', { class: 'gold' }, money(r.R))))));
  fill();
  const btns = Object.entries(sorts).map(([k, label]) => el('button', { type: 'button', class: 'seg' + (k === by ? ' on' : ''), 'aria-pressed': String(k === by), onclick: e => {
    by = k; for (const b of btns) { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); }
    e.currentTarget.classList.add('on'); e.currentTarget.setAttribute('aria-pressed', 'true'); fill();
  } }, label));
  return el('details', { class: 'worked compare fossillab' },
    el('summary', {}, 'Fossil lab', el('small', { class: 'muted' }, ` — ${lab.tried} combinations of up to four fossils, the best of each size`)),
    el('p', { class: 'muted small' }, 'Like Craft of Exile\'s fossil calculator, plus what only today\'s prices can tell: "Whole craft" opens with that combination and then follows the cheapest strategy (slams, annuls, bench, other reforges) at this hour\'s prices. "Land all at once" is rolling until every wanted mod shows up in one reforge (the classic fossil calculator number), in chaos and in clicks (each fossil socketed and the resonator applied count as clicks', lab.ruthless ? ', and the Scour before each' : '', ').'),
    el('div', { class: 'scroll' }, bestTable),
    el('div', { class: 'segs', role: 'group', 'aria-label': 'Sort the combinations by' }, el('span', { class: 'muted small' }, 'All combinations, by: '), btns),
    el('div', { class: 'scroll' }, el('table', { class: 'cmp' },
      el('thead', {}, el('tr', {}, ['Fossils', 'Per try', ...lab.targets, 'All at once', 'Cost per full hit', 'Clicks per full hit', 'Whole craft'].map((h, i) => el('th', { scope: 'col', class: i === 0 ? 'l' : '', title: i >= 2 && i < 2 + lab.targets.length ? `Chance one reforge rolls ${h}` : null }, i >= 2 && i < 2 + lab.targets.length ? (h.length > 22 ? h.slice(0, 20) + '…' : h) : h)))),
      tbody)));
}

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
    goalCell(r),
    el('td', { class: 'l small' }, what ?? ''));
  // Rolling until a chosen set of mods lands at once, then finishing: the cheapest set, and the
  // next few on hover. Never cheaper than "Whole craft", which may also stop at exactly that set.
  function goalCell(r) {
    const g = r.goals?.[0];
    if (!g) return el('td', { class: 'muted' }, '–');
    const line = x => `${x.mods.join(' + ')}: ${C.pctText(x.p)} a try, whole craft ${money(x.R)}`;
    return el('td', { class: 'l small', title: r.goals.map(line).join('\n') },
      g.mods.join(' + '), el('br'), el('span', { class: 'muted' }, `${C.pctText(g.p)} a try → `), el('b', {}, money(g.R)),
      r.R > 0 ? el('span', { class: 'muted' }, ` (+${C.fmtN(Math.max(0, g.R / r.R - 1) * 100)}%)`) : null);
  }
  const group = (title, rs, what) => (rs.length ? [el('tr', { class: 'grp' }, el('th', { colspan: 8, scope: 'colgroup', class: 'l' }, title)), ...rs.map(r => tr(r, what?.(r)))] : []);
  const kinds = k => rows.filter(r => r.kind === k).slice(0, 6);
  // Fossils in the shown combinations: tick the ones you have.
  ovr();
  const shownFossils = [...new Set(fossilRows.flatMap(r => r.fossils))];
  const have = name => S.overrides[name] === 0;
  return el('details', { class: 'worked compare' },
    el('summary', {}, 'Ways to start, compared', best ? el('small', { class: 'muted' }, ` — cheapest: ${best.name}, ${money(best.R)} for the whole craft`) : null),
    el('p', { class: 'muted small' }, '"One try lands": the chance a single try rolls at least that many of your mods (and the clicks to get all of them at once). "Clicks": how many tries the plan spams it before moving on, with the chance per try; "once" means one try, then the cheapest move from whatever it rolled. "Whole craft": starting this way, then the cheapest strategy, comparable with the plans above (the Eldritch plans are separate). "Or roll until these land together": the alternative of spamming it until that set of your mods is on the item at once, then finishing; the cheapest set is shown (hover for more). It can\'t beat "Whole craft", which stops at that set too when that pays, and also at the results worth more than the extra tries.'),
    el('div', { class: 'scroll' }, el('table', { class: 'cmp' },
      el('thead', {}, el('tr', {}, ['Start with', 'Per try', 'One try lands', 'Clicks (good per try)', 'Spam until it stops', 'Whole craft', 'Or roll until these land together', 'What it does'].map((h, i) => el('th', { scope: 'col', class: i === 0 || i === 2 || i >= 6 ? 'l' : '' }, h)))),
      el('tbody', {},
        group('Fossils (best of each size, and the best overall)', fossilRows, r => effects(r.fossils)),
        group('Essences', kinds('essence'), () => 'forces its mod, the rest is random'),
        group('Harvest reforges', kinds('harvest'), () => 'one mod of the type for sure, that type ×10 more likely'),
        group('Chaos', kinds('chaos'), () => 'plain reroll'),
        group('Alteration and Regal', kinds('alt'), () => 'magic item with the core mods, then one more mod')))),
    shownFossils.length ? el('div', { class: 'havefossils' }, el('span', { class: 'muted small' }, 'Fossils you already have (counted free, so the plans re-rank): '),
      shownFossils.map(n => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: have(n), onchange: e => {
        if (e.target.checked) S.overrides[n] = 0; else delete S.overrides[n];
        X.store.set(K('craftPrices'), S.overrides); X.rerender();
      } }), nameIcon(n), ' ', n.replace(' Fossil', '')))) : null);
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
  const line = items.filter(x => !eld(x) && x.q66 > 0).slice(0, 6).map(x => [el('b', {}, n(x.q66)), ' ', nameIcon(x.name), ' ', x.name]);
  // Can the market supply it? Exchange items: compared with a day of all trading. Others (beasts,
  // Recombinators, ...) are bought one at a time from players: hundreds is a lot.
  const vol = x => (eld(x) ? null : X.exchangeVolume?.(x.name));
  // Trading rate in words: thin markets (Ruthless) trade less than one an hour.
  const rate = v => (v.perHour >= 1 ? `${C.fmtN(v.perHour)} an hour` : v.perHour * 24 >= 1 ? `${C.fmtN(v.perHour * 24)} a day` : v.perHour > 0 ? 'less than one a day' : 'none traded');
  // (Like the planner: a day of trading or what's listed, whichever is more.)
  const scarce = x => { if (eld(x) || x.name in C.FARMED_PRICES) return null; const v = vol(x); return v ? (x.q66 <= Math.max(24 * v.perHour, v.stock || 0) ? null : !(v.perHour > 0) && !(v.stock > 0) ? 'none traded or listed on the exchange' : `more than a day of the whole exchange: ${rate(v)}${v.stock > 0 ? `, ${C.fmtN(v.stock)} listed` : ''}`) : x.q66 >= 100 ? 'not on the Currency Exchange: bought one at a time from players' : null; };
  const short = items.filter(scarce);
  return el('section', { class: 'usage' },
    el('h4', {}, 'Currency used'),
    line.length ? el('p', {}, '66% of crafts following this plan need at most ', line.flatMap((x, i) => (i ? [', ', ...x] : x)), items.length > 6 ? ', and a few more below.' : '.') : null,
    short.length ? el('p', { class: 'status err wide' }, 'Hard to get this many: ', short.flatMap((x, i) => [i ? '; ' : '', el('b', {}, n(x.q66)), ' ', nameIcon(x.name), ' ', x.name, ` (${scarce(x)})`]), '.',
      short.some(x => /Farric|Craicic/.test(x.name)) ? ' Switch off "Farric beasts" above to plan without them.' : '', ' To plan without one, click "avoid" on its row in the table below.') : null,
    el('div', { class: 'scroll' }, el('table', { class: 'cmp' },
      el('thead', {}, el('tr', {}, ['Currency', 'Average', '66% need at most', '90% need at most', 'Average value', 'On the exchange', ''].map((h, i) => el('th', { scope: 'col', class: i ? '' : 'l' }, h)))),
      el('tbody', {}, items.map(x => el('tr', {},
        el('td', { class: 'l' }, eld(x) ? x.name : [nameIcon(x.name), ' ', x.name]),
        el('td', {}, eld(x) ? '' : C.fmtN(x.mean)),
        el('td', {}, eld(x) ? '' : n(x.q66)),
        el('td', {}, eld(x) ? '' : n(x.q90)),
        el('td', {}, isFinite(value(x)) ? money(x.mean * value(x)) : '?'),
        el('td', { class: scarce(x) ? 'down' : 'muted' }, eld(x) ? '' : (v => (v ? `${rate(v)}${isFinite(v.stock) && v.stock > 0 ? `, ${C.fmtN(v.stock)} listed` : ''}` : 'not listed'))(vol(x))),
        el('td', {}, eld(x) || x.name === unit() ? '' : el('button', { type: 'button', class: 'linklike small', title: 'Plan again without this currency (undo under "Prices used")',
          onclick: () => { ovr(); S.overrides[x.name] = 'off'; X.store.set(K('craftPrices'), S.overrides); X.rerender(); } }, 'avoid'))))))),
    el('p', { class: 'muted small' }, `From ${u.runs} simulated crafts that follow this plan; each column counts that currency on its own, so the 66% figures together cover somewhat fewer than 66% of crafts.`,
      u.unfinished > 0.005 ? ` ${C.pctText(u.unfinished)} of them were still going after 200,000 moves, so the counts are a bit low.` : ''));
}

// Predictable recombination: pick the mods to keep from both items; the game shows the
// success chance (lower with more and higher-tier mods; GGG hasn't published the formula),
// so it's typed in here. A failure destroys both items.
function predictableView(it, run) {
  const { el } = X, W = S.wb;
  const all = [...it.mods.map((x, i) => ({ x, key: 'a' + i, from: 'yours' })), ...W.other.mods.map((x, i) => ({ x, key: 'b' + i, from: '2nd' }))].filter(e => e.x.m);
  W.keep ??= [];
  W.recChance ??= 30;
  const o = planOptions();
  const inputs = price(C.DUST) * o.recombDust + price(C.GOLD) * o.recombGold;
  const p = W.recChance / 100;
  const pick = e => el('label', { class: 'check' },
    el('input', { type: 'checkbox', checked: W.keep.includes(e.key), onchange: ev => { W.keep = ev.target.checked ? [...W.keep, e.key] : W.keep.filter(k => k !== e.key); X.rerender(); } }),
    sideTag(e.x.side), ' ', C.modText(e.x.m, e.x.t), ' ', el('small', { class: 'muted' }, C.tierLabel(e.x.m, e.x.t, it.ilvl)));
  const col = from => el('div', { class: 'rcard' }, el('header', {}, el('b', {}, from === 'yours' ? 'Item A: this item' : 'Item B: the saved one')),
    el('ul', { class: 'rmods' }, all.filter(e => e.from === from).map(e => el('li', {}, pick(e)))));
  const kept = all.filter(e => W.keep.includes(e.key));
  // The same checks the bench makes, shown before you press the button.
  const seen = new Set();
  const clash = kept.find(e => { const hit = e.x.m.groups.some(g => seen.has(g)); e.x.m.groups.forEach(g => seen.add(g)); return hit; });
  const over = ['p', 's'].find(sd => kept.filter(e => e.x.side === sd).length > it.B.max[sd]);
  const problem = clash ? `Two picked mods are the same kind ("${clash.x.m.text}"): an item can only have one.`
    : over ? `More ${over === 'p' ? 'prefixes' : 'suffixes'} than this base can hold (${it.B.max[over]}).` : null;
  return el('div', { class: 'predict recomb' },
    el('p', { class: 'muted small' }, 'Predictable mode: tick the mods to keep. It gives exactly those, or destroys both items.'),
    el('div', { class: 'rins' }, col('yours'), el('span', { class: 'rplus', 'aria-hidden': 'true' }, '+'), col('2nd')),
    el('div', { class: 'rbench' }, el('span', { class: 'rarrow', 'aria-hidden': 'true' }, '↓'), ' ', el('b', {}, 'Recombinator, predictable mode')),
    el('table', { class: 'mini rout' }, el('tbody', {},
      problem ? el('tr', {}, el('td', { class: 'l down' }, problem), el('td', {}, '')) : el('tr', { class: 'best' }, el('td', { class: 'l' }, kept.length ? kept.map((e, i) => [i ? ', ' : '', sideTag(e.x.side), ' ', C.modText(e.x.m, e.x.t)]) : el('span', { class: 'muted' }, 'nothing picked yet')), el('td', {}, `${W.recChance}%`)),
      el('tr', {}, el('td', { class: 'l down' }, 'both items destroyed'), el('td', {}, `${100 - W.recChance}%`)))),
    el('label', {}, 'Success chance the game shows (%) ', (() => { const inp = el('input', { type: 'number', min: 0, max: 100, step: 1, value: W.recChance }); inp.addEventListener('change', () => { W.recChance = Math.min(100, Math.max(0, Number(inp.value) || 0)); X.rerender(); }); return inp; })()),
    el('p', { class: 'muted small' }, p > 0 ? `About ${C.fmtN(1 / p)} pairs of items per success; the bench alone costs ${money(inputs / p)} per success, plus whatever the two items are worth each try.` : 'At 0% it never works.'),
    el('button', { class: 'ghost', disabled: !W.keep.length || !!problem, onclick: () => {
      const keep = all.filter(e => W.keep.includes(e.key)).map(e => e.x);
      const before = W.other; W.other = null; W.keep = null;
      run('recombinePredictable', { other: before, keep, chance: p, dust: o.recombDust, gold: o.recombGold });
    } }, 'Recombine (predictable)'));
}

// Planner options: which extra methods it may use, saved in this browser.
function optionsView(spec) {
  const { el } = X;
  const o = planOptions();
  const set = (k, v) => { X.store.set(K('craftOptions'), { ...X.store.get(K('craftOptions'), {}), [k]: v }); X.rerender(); };
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
      ovr();
      const v = Number(inp.value);
      if (inp.value === '' || !isFinite(v)) delete S.overrides[name]; else S.overrides[name] = Math.max(0, v) / 1e5;
      X.store.set(K('craftPrices'), S.overrides); X.rerender();
    });
    return el('label', {}, label, inp);
  };
  const num = (k, label, step = 100) => { const inp = el('input', { type: 'number', min: 0, step, value: o[k] }); inp.addEventListener('change', () => set(k, Math.max(0, Number(inp.value) || 0))); return el('label', {}, label, inp); };
  return el('section', { class: 'methods', 'aria-label': 'Methods the planner may use' },
    el('span', { class: 'muted small' }, 'Methods the planner may use:'),
    el('div', { class: 'switches' },
      sw('hinekora', "Hinekora's Lock", R() ? 'The Hinekora\'s Lock currency: one look at what the next currency will do on a rare. Off by default here: Ruthless sees a handful a league (and no beast recipe for magic items)' : 'One look at what the next currency will do; apply it only if good (a bad look spends the Lock). Magic items: the Craicic Croaker + Black Mórrigan recipe; rare items: the Hinekora\'s Lock currency, hundreds of divines', C.HK_LOCK),
      R() ? null : sw('matron', 'Wild Bristle Matron', 'Metamods from the Matron: a random one that fits an open side (1 prefix metamod, 4 suffix ones); a wrong one costs an Orb of Scouring to remove. Cheap when only the one you want fits', C.MATRON),
      R() ? null : sw('rancour', 'Crystallised Rancour', 'Harvest reforges with a minion, elemental, attribute, mana or drop mod, and fire/cold/lightning damage swaps (Mirage league)', C.RANCOUR),
      R() ? null : sw('beasts', 'Farric beasts', 'Farric Wolf / Lynx Alpha (move a mod to the other side) and Craicic Chimeral imprints. Beasts aren\'t on the Currency Exchange: they\'re caught or bought one at a time, so plans that need hundreds are hard to supply', C.CUR.wolf),
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
              el('td', {}, o.chosen ? '' : `+${money(Math.max(0, o.v - base))}`));
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
  ovr();
  return el('details', { class: 'morefilters' }, el('summary', {}, `Prices used (${R() ? 'Orbs of Alchemy' : 'chaos'})`),
    el('div', { class: 'prices' }, list.map(n => {
      const info = priceInfo(n);
      const inp = el('input', { type: 'number', min: 0, step: 'any', value: isFinite(info.v) ? +info.v.toPrecision(4) : '', 'aria-label': n });
      inp.addEventListener('change', () => {
        if (inp.value === '') delete S.overrides[n]; else S.overrides[n] = Number(inp.value);
        X.store.set(K('craftPrices'), S.overrides); X.rerender();
      });
      return el('label', {}, el('span', {}, nameIcon(n), ' ', n, ' ', el('small', { class: info.src === 'not used' ? 'down' : 'muted' }, info.src),
        info.src === 'not used' ? [' ', el('button', { type: 'button', class: 'linklike small', onclick: e => { e.preventDefault(); delete S.overrides[n]; X.store.set(K('craftPrices'), S.overrides); X.rerender(); } }, 'use again')] : null), inp);
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
  // Ruthless has no Veiled Chaos, influence Exalts, Awakener's or Dominance: their buttons are left out.
  const notInThisGame = (action, arg) => {
    if (!R()) {
      return false;
    }
    return C.RUTHLESS_BANNED.has(btnCur(action, arg));
  };
  const btn = (label, action, arg, title) => notInThisGame(action, arg) ? null : el('button', { class: 'ghost', title: title ?? btnCur(action, arg), onclick: () => run(action, typeof arg === 'function' ? arg() : arg) },
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
      el('button', { class: 'ghost', disabled: !W.fossils.length, onclick: () => run('fossil', { fossils: fossils.filter(f => W.fossils.includes(f.name)), ruthless: R() }) }, 'Reforge')) : null,
    group('Veiled', btn('Veiled Chaos', 'vchaos'), btn('Veiled Exalt', 'vexalt'), btn('Unveil', 'unveil')),
    R() ? null : group('Harvest',
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
    // Ruthless: every influence method here is gone (influence Exalts, Awakener's, Dominance) or Harvest.
    R() ? null : group('Influence',
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
    R() ? null : group('Crafting bench',
      el('select', { 'aria-label': 'Bench craft', onchange: e => { W.benchSel = +e.target.value; } }, benchMods.map((b, i) => el('option', { value: i, selected: i === W.benchSel }, `${b.m.meta ? '★ ' : ''}${C.modText(b.m, b.t)} (${b.m.affix === 'p' ? 'prefix' : 'suffix'})`))),
      el('button', { class: 'ghost', onclick: () => run('bench', { mod: benchMods[W.benchSel].m, tier: benchMods[W.benchSel].t }) }, 'Craft'),
      btn('Remove crafted', 'unbench')),
    R() ? null : group('Beasts',
      btn('Imprint', 'imprint', null, 'Craicic Chimeral: save a magic item'), btn('Restore', 'restore'),
      btn('Prefix → suffix', 'wolf', null, 'Farric Wolf Alpha'), btn('Suffix → prefix', 'lynx', null, 'Farric Lynx Alpha'),
      btn('Wild Bristle Matron', 'matron', null, 'Adds a random craftable metamod that fits'),
      B.info.group !== 1 ? el('select', { 'aria-label': 'Aspect', onchange: e => { W.aspect = e.target.value; } }, Object.keys(C.ASPECTS).map(n => el('option', { value: n, selected: n === W.aspect }, `Aspect of the ${C.ASPECTS[n]}`))) : null,
      B.info.group !== 1 ? el('button', { class: 'ghost', onclick: () => run('aspect', W.aspect ?? Object.keys(C.ASPECTS)[0]) }, 'Add aspect') : null),
    B.info.recomb ? group(`Recombinator bench (${B.info.recomb.toLowerCase()})`,
      el('button', { class: 'ghost', onclick: () => { W.other = C.clone(it); W.keep = null; W.log.unshift({ msg: 'Saved this item as the second input', ok: true, cost: 0 }); X.rerender(); } }, 'Keep as 2nd item'),
      R() ? null : el('button', { class: 'ghost', disabled: !W.other, title: 'Unpredictable mode: a random share of both items\' mods; nothing is lost', onclick: () => { const o = planOptions(); run('recombine', { other: W.other, dust: o.recombDust, gold: o.recombGold }); W.other = null; } }, 'Recombine (unpredictable)'),
      W.other ? predictableView(it, run) : null) : null,
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
