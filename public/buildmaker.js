// Build maker tab: a chain of questions (class, ascendancy, damage, hit or DoT, playstyle, defences, budget)
// that narrows poe.ninja's real archetypes down and ranks what's left, plus a spin wheel for a niche but
// playable random build. The maths is in builds.js; this file loads the data and draws the tab.
import {
  QUESTIONS, PLAYSTYLE_LABELS, IDEA_QUESTION_IDS, questionById, buildArchetypes, priceArchetypes, remainingArchetypes,
  optionsFor, consistentAnswers, rankArchetypes, spinWheel, mulberry32, encodeAnswers, decodeAnswers,
} from './builds.js';
import { ideasView, ideaCard, ideaWheelCandidates, ideasReady } from './buildideas.js';

const DATA = 'data/builds/';
// The poe.ninja proxy (functions/api/ninja) serves these; together they hold every wearable unique.
const UNIQUE_TYPES = ['UniqueWeapon', 'UniqueArmour', 'UniqueAccessory', 'UniqueFlask', 'UniqueJewel'];
const SKIPPED = '*';
const FIRST_RESULTS = 12;
const MORE_RESULTS = 24;
const CARD_UNIQUES = 6;
const CARD_SUPPORTS = 6;
const WHEEL_SPIN_MILLISECONDS = 4500;
const WHEEL_FULL_TURNS = 6;
// Fast at first, then a long slow-down, so the last slices creep past the pointer like a real wheel.
const WHEEL_EASING = 'cubic-bezier(0.12, 0.6, 0.18, 1)';
const URL_PARAMETER = 'b';

let X; // helpers from app.js: el, store, rerender, exchangePrice
const S = {
  status: 'idle', // idle → loading → ready | failed
  game: null, current: null, past: [], archetypes: [],
  prices: { status: 'idle', byName: new Map() },
  answers: null, // {questionId: value or SKIPPED}
  editing: null, // a question reopened from the chain
  shown: FIRST_RESULTS,
  wheel: null, // { candidates, winnerIndex, nicheOnly, startAngle, angle, startedAt, landed }
  wheelRestingAngle: 0, // where the last spin stopped, so the next one turns on from there
  view: null, // 'ideas' (the generator's builds) or 'played' (poe.ninja's archetypes)
};
const VIEWS = [
  { id: 'ideas', label: 'Our ideas', title: 'Builds our generator composes from the game\'s mechanics, checked against poe.ninja' },
  { id: 'played', label: 'What people play', title: 'poe.ninja\'s archetypes, narrowed down by your answers' },
];

// ---------- loading ----------
async function fetchJson(path) {
  const response = await fetch(DATA + path);
  if (!response.ok) {
    throw new Error(path + ' answered ' + response.status);
  }
  return response.json();
}

async function loadData() {
  S.status = 'loading';
  try {
    const leagues = await fetchJson('leagues-poe1.json');
    const game = await fetchJson('game-poe1.json');
    let currentLeague = null;
    const pastLeagues = [];
    for (const league of leagues.leagues) {
      if (league.current) {
        currentLeague = league;
      } else {
        pastLeagues.push(league);
      }
    }
    if (!currentLeague) {
      throw new Error('no running league in leagues-poe1.json');
    }
    const current = await fetchJson(currentLeague.file);
    const past = [];
    for (const league of pastLeagues) {
      past.push(await fetchJson(league.file));
    }
    S.game = game;
    S.current = current;
    S.past = past;
    S.archetypes = buildArchetypes(game, current, past);
    S.status = 'ready';
    loadPrices();
  } catch (error) {
    S.status = 'failed';
    S.error = error.message;
  }
  X.rerender();
}

// A unique listed several times (by links, or by variant) is priced as its unlinked line with the most
// listings: the copy most players buy. Watcher's Eye and other uniques whose mods decide the price then read
// as their common, cheap roll, which undercounts builds that need a specific one.
function rememberCheapestCommonLine(byName, line) {
  if (line.chaos == null || !(line.chaos > 0)) {
    return;
  }
  const isLinked = line.links != null && line.links > 0;
  const held = byName.get(line.name);
  if (!held) {
    byName.set(line.name, { chaos: line.chaos, listings: line.listings ?? 0, linked: isLinked, icon: line.icon });
    return;
  }
  const replacesLinkedWithPlain = held.linked && !isLinked;
  const busierOfSameKind = held.linked === isLinked && (line.listings ?? 0) > held.listings;
  if (replacesLinkedWithPlain || busierOfSameKind) {
    byName.set(line.name, { chaos: line.chaos, listings: line.listings ?? 0, linked: isLinked, icon: line.icon });
  }
}

async function loadPrices() {
  S.prices.status = 'loading';
  const byName = new Map();
  const league = S.current.league;
  const requests = [];
  for (const itemType of UNIQUE_TYPES) {
    requests.push(loadPriceType(league, itemType, byName));
  }
  const loaded = await Promise.all(requests);
  S.prices.byName = byName;
  S.prices.status = loaded.includes(true) ? 'ready' : 'failed';
  priceArchetypes(S.archetypes, uniqueName => byName.get(uniqueName)?.chaos ?? null, divineChaos());
  X.rerender();
}

async function loadPriceType(league, itemType, byName) {
  try {
    const response = await fetch('/api/ninja/' + encodeURIComponent(league) + '/' + itemType);
    if (!response.ok) {
      return false;
    }
    const body = await response.json();
    for (const line of body.lines || []) {
      rememberCheapestCommonLine(byName, line);
    }
    return true;
  } catch {
    return false; // that type stays unpriced; the others still count
  }
}

function divineChaos() {
  const price = X.exchangePrice?.('Divine Orb');
  if (price == null || !isFinite(price) || price <= 0) {
    return null;
  }
  return price;
}

// ---------- the chain's state, in the link and in storage ----------
function readSavedAnswers() {
  const fromLink = new URLSearchParams(location.search).get(URL_PARAMETER);
  if (fromLink) {
    return decodeAnswers(fromLink);
  }
  return decodeAnswers(X.store.get('buildAnswers', ''));
}

function saveAnswers() {
  const encoded = encodeAnswers(S.answers);
  X.store.set('buildAnswers', encoded);
  const url = new URL(location.href);
  if (encoded) {
    url.searchParams.set(URL_PARAMETER, encoded);
  } else {
    url.searchParams.delete(URL_PARAMETER);
  }
  history.replaceState(history.state, '', url);
}

// The engine filters on real answers only; a skipped question is "any".
function filteringAnswers() {
  const answers = {};
  for (const [questionId, value] of Object.entries(S.answers)) {
    if (value !== SKIPPED) {
      answers[questionId] = value;
    }
  }
  return answers;
}

function setAnswer(questionId, value) {
  const updated = { ...S.answers, [questionId]: value };
  const kept = consistentAnswers(S.archetypes, withoutSkipped(updated));
  for (const [id, answer] of Object.entries(updated)) {
    if (answer === SKIPPED) {
      kept[id] = SKIPPED;
    }
  }
  S.answers = kept;
  S.editing = null;
  S.shown = FIRST_RESULTS;
  S.wheel = null;
  saveAnswers();
  X.rerender();
}

function withoutSkipped(answers) {
  const real = {};
  for (const [id, value] of Object.entries(answers)) {
    if (value !== SKIPPED) {
      real[id] = value;
    }
  }
  return real;
}

function clearAnswer(questionId) {
  const updated = { ...S.answers };
  delete updated[questionId];
  S.answers = updated;
  S.editing = null;
  S.wheel = null;
  saveAnswers();
  X.rerender();
}

function startOver() {
  S.answers = {};
  S.editing = null;
  S.shown = FIRST_RESULTS;
  S.wheel = null;
  saveAnswers();
  X.rerender();
}

function questionToAsk() {
  if (S.editing) {
    return questionById(S.editing);
  }
  for (const question of QUESTIONS) {
    if (S.view === 'ideas' && !IDEA_QUESTION_IDS.includes(question.id)) {
      continue; // a generated build has no players' medians to answer pool, defence or budget with
    }
    if (S.answers[question.id] != null) {
      continue;
    }
    // A question the data can't answer (defence layers when no characters were opened) isn't asked.
    if (optionsFor(question.id, S.archetypes, {}).length < 2) {
      continue;
    }
    return question;
  }
  return null;
}

function setView(viewId) {
  S.view = viewId;
  S.wheel = null;
  S.editing = null;
  X.store.set('buildView', viewId);
  X.rerender();
}

function viewSwitch() {
  const buttons = [];
  for (const view of VIEWS) {
    const on = S.view === view.id;
    buttons.push(X.el('button', { type: 'button', class: 'bm-view' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', title: view.title, onclick: () => setView(view.id) }, view.label));
  }
  return X.el('div', { class: 'bm-views', role: 'group', 'aria-label': 'Which builds' }, buttons);
}

function ideaHelpers() {
  return { el: X.el, rerender: X.rerender, store: X.store, chip, plural, percent };
}

// ---------- the panel ----------
export function buildMakerPanel(helpers) {
  X = helpers;
  if (X.realm() === 'poe2') {
    return [X.el('p', { class: 'empty' }, 'The Build maker covers Path of Exile 1: its archetypes come from poe.ninja\'s PoE 1 ladder. Switch the realm to a PoE 1 one.')];
  }
  if (S.status === 'idle') {
    loadData();
  }
  if (S.status === 'loading' || S.status === 'idle') {
    return [X.el('p', { class: 'muted' }, 'Loading builds…')];
  }
  if (S.status === 'failed') {
    return [X.el('p', { class: 'empty' }, 'The build data didn\'t load (' + S.error + '). Run npm run builds:build, or try again later.')];
  }
  if (S.answers == null) {
    S.answers = consistentAnswers(S.archetypes, withoutSkipped(readSavedAnswers()));
  }
  if (S.view == null) {
    S.view = X.store.get('buildView', 'ideas') === 'played' ? 'played' : 'ideas';
  }

  const answers = filteringAnswers();
  const nodes = [viewSwitch()];
  if (S.view === 'played') {
    nodes.push(intro());
  }
  nodes.push(chain(), controls());
  if (S.wheel) {
    nodes.push(wheelSection());
  }
  const question = questionToAsk();
  if (question) {
    nodes.push(questionSection(question, answers));
  }
  if (S.view === 'ideas') {
    for (const node of ideasView(ideaHelpers(), answers, S.game)) {
      nodes.push(node);
    }
    return nodes;
  }
  const remaining = rankArchetypes(remainingArchetypes(S.archetypes, answers));
  nodes.push(resultsSection(remaining));
  return nodes;
}

function intro() {
  const past = [];
  for (const meta of S.past) {
    past.push(meta.league);
  }
  const provenText = past.length ? ' "Proven" marks builds also played in ' + past.join(' and ') + '.' : '';
  return X.el('div', { class: 'bm-intro' },
    X.el('p', {},
      'Answer as many questions as you like, in any order: each answer narrows down what ',
      S.current.characters.toLocaleString(), ' characters in ', S.current.league,
      ' actually play (poe.ninja, ', S.current.built, '). Skip a question to keep every option open.' + provenText),
    X.el('p', { class: 'muted' },
      'Figures are medians over each build\'s highest-level characters, so they describe finished builds. Budgets are what those players\' uniques cost today, weighted by how many wear each one.'));
}

function chain() {
  const items = [];
  for (const question of QUESTIONS) {
    const value = S.answers[question.id];
    if (value == null) {
      continue;
    }
    const answerText = value === SKIPPED ? 'any' : question.labelOf(value);
    items.push(X.el('li', { class: 'bm-link' + (S.editing === question.id ? ' editing' : '') },
      X.el('button', { type: 'button', class: 'bm-chip', title: 'Change: ' + question.label, onclick: () => { S.editing = question.id; X.rerender(); } },
        X.el('span', { class: 'bm-chip-question' }, shortQuestionName(question.id)), ' ', answerText),
      X.el('button', { type: 'button', class: 'bm-clear', 'aria-label': 'Clear ' + shortQuestionName(question.id), title: 'Clear this answer', onclick: () => clearAnswer(question.id) }, '×')));
  }
  if (items.length === 0) {
    return X.el('p', { class: 'bm-chain muted' }, 'No answers yet.');
  }
  return X.el('ol', { class: 'bm-chain', 'aria-label': 'Your answers' }, items);
}

const SHORT_QUESTION_NAMES = { class: 'Class', ascendancy: 'Ascendancy', damage: 'Damage', hitdot: 'Hit / DoT', playstyle: 'Playstyle', pool: 'Pool', layer: 'Defence', budget: 'Budget' };
function shortQuestionName(questionId) {
  return SHORT_QUESTION_NAMES[questionId] ?? questionId;
}

function controls() {
  return X.el('div', { class: 'bm-controls' },
    X.el('button', { type: 'button', class: 'ghost', onclick: spin, title: S.view === 'ideas'
      ? 'Pick one of the generator\'s best ideas that fit your answers'
      : 'Pick a random build outside the 20 most played, among those whose top characters reach level 95 with a sturdy EHP, that fits your answers' }, 'Spin the wheel'),
    X.el('button', { type: 'button', class: 'ghost', onclick: startOver, disabled: Object.keys(S.answers).length === 0 }, 'Start over'));
}

function questionSection(question, answers) {
  const options = optionsFor(question.id, S.archetypes, answers);
  let totalCharacters = 0;
  for (const archetype of remainingArchetypes(S.archetypes, answers, question.id)) {
    totalCharacters += archetype.characters;
  }
  const buttons = [];
  for (const option of options) {
    const share = totalCharacters > 0 ? option.characters / totalCharacters : 0;
    const current = S.answers[question.id] === option.value;
    if (S.view === 'ideas') {
      // The counts describe what people play, not the generator's ideas, so the ideas view shows plain choices.
      buttons.push(X.el('button', { type: 'button', class: 'bm-option' + (current ? ' on' : ''), 'aria-pressed': current ? 'true' : 'false', onclick: () => setAnswer(question.id, option.value) },
        X.el('span', { class: 'bm-option-label' }, option.label)));
      continue;
    }
    buttons.push(X.el('button', {
      type: 'button', class: 'bm-option' + (current ? ' on' : ''), disabled: option.archetypes === 0,
      'aria-pressed': current ? 'true' : 'false', onclick: () => setAnswer(question.id, option.value),
      title: option.archetypes === 0 ? 'No build fits this together with your other answers' : '',
    },
      X.el('span', { class: 'bm-option-label' }, option.label),
      X.el('span', { class: 'bm-option-count' }, option.archetypes === 0 ? 'none left' : plural(option.archetypes, 'build') + ' · ' + percent(share) + ' of players'),
      X.el('span', { class: 'bm-bar', 'aria-hidden': 'true' }, X.el('span', { style: 'width:' + Math.round(share * 100) + '%' }))));
  }
  return X.el('section', { class: 'bm-question', 'aria-labelledby': 'bm-question-title' },
    X.el('h3', { id: 'bm-question-title' }, question.label),
    budgetNote(question),
    X.el('div', { class: 'bm-options' }, buttons),
    X.el('button', { type: 'button', class: 'linklike', onclick: () => setAnswer(question.id, SKIPPED) }, 'Skip: any is fine'));
}

function budgetNote(question) {
  if (question.id !== 'budget') {
    return null;
  }
  if (S.prices.status === 'loading') {
    return X.el('p', { class: 'muted' }, 'Pricing uniques on poe.ninja…');
  }
  if (S.prices.status === 'failed') {
    return X.el('p', { class: 'muted' }, 'poe.ninja\'s prices didn\'t load, so budgets are unknown. This needs the site\'s /api/ninja proxy (npm run dev, or the deployed site).');
  }
  return null;
}

// ---------- results ----------
function resultsSection(ranked) {
  if (ranked.length === 0) {
    return X.el('p', { class: 'empty' }, 'No build fits all of these answers. Clear one in the chain above.');
  }
  const cards = [];
  for (const archetype of ranked.slice(0, S.shown)) {
    cards.push(archetypeCard(archetype));
  }
  const more = ranked.length > S.shown
    ? X.el('button', { type: 'button', class: 'ghost bm-more', onclick: () => { S.shown += MORE_RESULTS; X.rerender(); } }, 'Show more (' + (ranked.length - S.shown) + ' left)')
    : null;
  return X.el('section', { class: 'bm-results', 'aria-label': 'Matching builds' },
    X.el('h3', {}, plural(ranked.length, 'build') + ' fit'),
    X.el('div', { class: 'bm-cards' }, cards), more);
}

function archetypeCard(archetype, extraClass = '') {
  const traits = archetype.traits;
  const traitChips = [];
  for (const damageType of traits.damageTypes) {
    traitChips.push(chip(questionById('damage').labelOf(damageType)));
  }
  traitChips.push(chip(questionById('hitdot').labelOf(traits.hitOrDot)));
  traitChips.push(chip(PLAYSTYLE_LABELS[traits.playstyle] ?? traits.playstyle));
  traitChips.push(chip(questionById('pool').labelOf(traits.pool)));
  for (const layer of traits.layers) {
    if (layer !== 'none') {
      traitChips.push(chip(questionById('layer').labelOf(layer)));
    }
  }
  if (archetype.provenLeagues.length > 0) {
    traitChips.push(X.el('span', { class: 'bm-trait proven', title: 'Also played in ' + archetype.provenLeagues.join(', ') }, 'Proven'));
  }
  return X.el('article', { class: 'bm-card ' + extraClass },
    X.el('header', {},
      X.el('h4', {}, archetype.ascendancy, X.el('span', { class: 'muted' }, ' · '), archetype.skill),
      X.el('span', { class: 'bm-share' }, percent(archetype.shareOfLeague), ' of the league · #', archetype.rank)),
    X.el('div', { class: 'bm-traits' }, traitChips),
    statsLine(archetype),
    costLine(archetype),
    listLine('Uniques', archetype.uniques, CARD_UNIQUES),
    listLine('Supports', supportsWithoutWord(archetype.supports), CARD_SUPPORTS),
    listLine('Keystones', archetype.keystones, 6),
    aurasLine(archetype),
    listLine('Bloodline', archetype.bloodlines, 2),
    X.el('a', { class: 'bm-link-out', href: ninjaLink(archetype), target: '_blank', rel: 'noopener' }, 'See these characters on poe.ninja ↗'));
}

function chip(text) {
  return X.el('span', { class: 'bm-trait' }, text);
}

function statsLine(archetype) {
  const parts = [];
  parts.push(statBlock('Level', archetype.levelMedian));
  parts.push(statBlock('Life', archetype.lifeMedian));
  parts.push(statBlock('ES', archetype.energyShieldMedian));
  parts.push(statBlock('EHP', archetype.ehpMedian, 'Effective health pool from Path of Building'));
  parts.push(statBlock('DPS', archetype.dpsMedian, 'Main skill DPS from Path of Building'));
  const defences = archetype.defences;
  if (defences && defences.sampled) {
    parts.push(statBlock('Max hit', defences.lowestMaximumHitTaken, 'The smallest of the maximum hits it survives, by damage type (median of ' + defences.sampled + ' characters)'));
    parts.push(statBlock('Suppress', defences.spellSuppressionChance == null ? null : defences.spellSuppressionChance + '%'));
    parts.push(statBlock('Block', defences.blockChance == null ? null : defences.blockChance + '%'));
  }
  return X.el('dl', { class: 'bm-stats' }, parts);
}

function statBlock(label, value, title) {
  return X.el('div', { title: title ?? null },
    X.el('dt', {}, label),
    X.el('dd', {}, value == null ? '—' : typeof value === 'number' ? shortNumber(value) : value));
}

function costLine(archetype) {
  if (!archetype.cost) {
    if (S.prices.status === 'loading') {
      return X.el('p', { class: 'bm-cost muted' }, 'Pricing uniques…');
    }
    return null;
  }
  const amount = archetype.cost.divines != null
    ? '~' + shortNumber(archetype.cost.divines) + ' Divines'
    : '~' + shortNumber(archetype.cost.chaos) + ' Chaos';
  const unpriced = archetype.cost.unpricedUniques > 0 ? ' (' + plural(archetype.cost.unpricedUniques, 'unique') + ' unpriced)' : '';
  return X.el('p', { class: 'bm-cost', title: 'Each unique\'s poe.ninja price times the share of these players wearing it' },
    'Uniques cost ', X.el('strong', {}, amount), ' on average', unpriced);
}

function listLine(label, entries, limit) {
  if (!entries || entries.length === 0) {
    return null;
  }
  const items = [];
  for (const [name, share] of entries.slice(0, limit)) {
    items.push(X.el('li', {}, name, X.el('span', { class: 'muted' }, ' ' + percent(share))));
  }
  return X.el('div', { class: 'bm-list' }, X.el('span', { class: 'bm-list-label' }, label), X.el('ul', {}, items));
}

function supportsWithoutWord(supports) {
  const shortened = [];
  for (const [name, share] of supports ?? []) {
    shortened.push([name.replace(/ Support$/, ''), share]);
  }
  return shortened;
}

function aurasLine(archetype) {
  if (!archetype.auras || archetype.auras.length === 0) {
    return null;
  }
  const line = listLine('Auras', archetype.auras, 5);
  line.append(X.el('span', { class: 'muted bm-aura-count' }, ' ' + archetype.auraCountAverage + ' on average'));
  return line;
}

function ninjaLink(archetype) {
  const query = new URLSearchParams({ class: archetype.ascendancy, skills: archetype.skill });
  return 'https://poe.ninja/poe1/builds/' + encodeURIComponent(S.current.leagueUrl) + '?' + query.toString();
}

// ---------- the spin wheel ----------
// In the ideas view the wheel spins over the generator's best ideas that fit; otherwise over niche archetypes.
function wheelResult(randomNumber) {
  if (S.view === 'ideas' && ideasReady()) {
    const candidates = ideaWheelCandidates(filteringAnswers(), S.game, randomNumber);
    const winnerIndex = candidates.length > 0 ? Math.floor(randomNumber() * candidates.length) : 0;
    return { candidates, winnerIndex, nicheOnly: true, ideas: true };
  }
  return spinWheel(S.archetypes, filteringAnswers(), randomNumber);
}

function spin() {
  const randomNumber = mulberry32(Date.now() ^ Math.floor(Math.random() * 4294967296));
  const result = wheelResult(randomNumber);
  if (result.candidates.length === 0) {
    S.wheel = { ...result, startAngle: 0, angle: 0, startedAt: 0, landed: true };
    X.rerender();
    return;
  }
  const startAngle = S.wheelRestingAngle;
  const angle = landingAngle(startAngle, result.winnerIndex, result.candidates.length, randomNumber);
  S.wheelRestingAngle = angle % 360;
  const reducedMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const canAnimate = typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
  const landedAlready = reducedMotion || !canAnimate;
  S.wheel = { ...result, startAngle, angle, startedAt: performance.now(), landed: landedAlready };
  X.rerender();
  if (!landedAlready) {
    setTimeout(() => {
      if (S.wheel && S.wheel.angle === angle) {
        S.wheel.landed = true;
        X.rerender();
      }
    }, WHEEL_SPIN_MILLISECONDS);
  }
}

// The pointer is at the top. The wheel turns clockwise from where it rests, at least WHEEL_FULL_TURNS full
// times, and stops with the pointer somewhere inside the winner's slice (not always its middle, which would
// look rigged), kept away from the slice's edges so it never seems to stop on a line.
function landingAngle(startAngle, winnerIndex, candidateCount, randomNumber) {
  const slice = 360 / candidateCount;
  const insideSlice = slice * (0.2 + 0.6 * randomNumber());
  const pointAtPointer = winnerIndex * slice + insideSlice;
  const finalRest = (360 - pointAtPointer) % 360;
  let turn = finalRest - (startAngle % 360);
  if (turn < 0) {
    turn += 360;
  }
  return startAngle + WHEEL_FULL_TURNS * 360 + turn;
}

// Runs the spin on a freshly drawn disc. A panel redraw mid-spin draws a new disc, so the animation resumes
// at the time already spent instead of starting over.
function animateDisc(disc, wheel) {
  const elapsed = performance.now() - wheel.startedAt;
  if (elapsed >= WHEEL_SPIN_MILLISECONDS) {
    disc.style.transform = 'rotate(' + wheel.angle + 'deg)';
    return;
  }
  const animation = disc.animate(
    [{ transform: 'rotate(' + wheel.startAngle + 'deg)' }, { transform: 'rotate(' + wheel.angle + 'deg)' }],
    { duration: WHEEL_SPIN_MILLISECONDS, easing: WHEEL_EASING, fill: 'forwards' });
  animation.currentTime = elapsed;
}

function wheelSection() {
  const wheel = S.wheel;
  if (wheel.candidates.length === 0) {
    return X.el('section', { class: 'bm-wheel' }, X.el('p', { class: 'empty' }, 'No build fits your answers, so there\'s nothing to spin. Clear an answer first.'));
  }
  const winner = wheel.candidates[wheel.winnerIndex];
  let note = 'No niche build fits your answers, so the wheel holds every build that does.';
  if (wheel.ideas) {
    note = 'A dozen of the generator\'s best ideas that fit your answers and the player bands you show.';
  } else if (wheel.nicheOnly) {
    note = 'Niche picks: outside the 20 most played, with top characters at level 95+ and a sturdy EHP.';
  }
  return X.el('section', { class: 'bm-wheel', 'aria-label': 'Spin the wheel' },
    X.el('div', { class: 'bm-wheel-row' },
      wheelSvg(wheel),
      X.el('div', { class: 'bm-wheel-side' },
        X.el('p', { class: 'muted' }, note),
        wheel.landed
          ? X.el('div', { 'aria-live': 'polite' }, X.el('p', { class: 'bm-wheel-result' }, 'The wheel says: ', X.el('strong', {}, winner.ascendancy + ' · ' + winner.skill)),
            X.el('button', { type: 'button', class: 'ghost', onclick: spin }, 'Spin again'),
            X.el('button', { type: 'button', class: 'linklike', onclick: () => { S.wheel = null; X.rerender(); } }, 'Close'))
          : X.el('p', { class: 'muted', 'aria-live': 'polite' }, 'Spinning…'))),
    wheel.landed ? (wheel.ideas ? ideaCard(winner, 'bm-winner') : archetypeCard(winner, 'bm-winner')) : null);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attributes, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child != null) {
      node.append(child);
    }
  }
  return node;
}

function wheelSvg(wheel) {
  const radius = 140;
  const centre = 150;
  const slice = 360 / wheel.candidates.length;
  const slices = [];
  for (let index = 0; index < wheel.candidates.length; index += 1) {
    const candidate = wheel.candidates[index];
    const startAngle = index * slice;
    const endAngle = startAngle + slice;
    const path = slicePath(centre, radius, startAngle, endAngle);
    const labelAngle = startAngle + slice / 2;
    const isWinner = wheel.landed && index === wheel.winnerIndex;
    slices.push(svg('g', {},
      svg('path', { d: path, class: 'bm-slice ' + (index % 2 === 0 ? 'even' : 'odd') + (isWinner ? ' winner' : '') }),
      // Along the slice's radius, from the hub outwards: a twelfth of the rim is too narrow for a name across it.
      svg('text', { x: centre + 26, y: centre + 4, transform: 'rotate(' + (labelAngle - 90) + ' ' + centre + ' ' + centre + ')', class: 'bm-slice-label', 'text-anchor': 'start' },
        shortenLabel(candidate.skill))));
  }
  // A landed wheel is drawn already turned; a spinning one starts where the last spin stopped and animates.
  const drawnAngle = wheel.landed ? wheel.angle : wheel.startAngle;
  const disc = svg('g', { class: 'bm-wheel-disc', style: 'transform:rotate(' + drawnAngle + 'deg);transform-origin:150px 150px' }, ...slices);
  if (!wheel.landed) {
    animateDisc(disc, wheel);
  }
  return svg('svg', { viewBox: '0 0 300 300', class: 'bm-wheel-svg', role: 'img', 'aria-label': 'Spin wheel of ' + wheel.candidates.length + ' builds' },
    disc,
    svg('circle', { cx: centre, cy: centre, r: 18, class: 'bm-hub' }),
    svg('path', { d: 'M150 2 L141 22 L159 22 Z', class: 'bm-pointer' }));
}

function slicePath(centre, radius, startAngle, endAngle) {
  // A lone candidate fills the whole wheel. One 360° arc starts and ends on the same point, which SVG draws as
  // nothing, so the full circle is drawn as two half arcs.
  if (endAngle - startAngle >= 360) {
    const top = pointOnCircle(centre, radius, startAngle);
    const bottom = pointOnCircle(centre, radius, startAngle + 180);
    return 'M' + top.x + ' ' + top.y + ' A' + radius + ' ' + radius + ' 0 1 1 ' + bottom.x + ' ' + bottom.y +
      ' A' + radius + ' ' + radius + ' 0 1 1 ' + top.x + ' ' + top.y + ' Z';
  }
  const start = pointOnCircle(centre, radius, startAngle);
  const end = pointOnCircle(centre, radius, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return 'M' + centre + ' ' + centre + ' L' + start.x + ' ' + start.y + ' A' + radius + ' ' + radius + ' 0 ' + largeArc + ' 1 ' + end.x + ' ' + end.y + ' Z';
}

// Angles are clockwise from the top, like the pointer.
function pointOnCircle(centre, radius, angleDegrees) {
  const radians = (angleDegrees - 90) * Math.PI / 180;
  return { x: (centre + radius * Math.cos(radians)).toFixed(2), y: (centre + radius * Math.sin(radians)).toFixed(2) };
}

function shortenLabel(text) {
  const limit = 16;
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, limit - 1) + '…';
}

// ---------- number formatting ----------
function percent(share) {
  const value = share * 100;
  if (value >= 10) {
    return Math.round(value) + '%';
  }
  if (value >= 1) {
    return value.toFixed(1) + '%';
  }
  return value.toFixed(2) + '%';
}

function shortNumber(value) {
  if (value >= 1e9) {
    return (value / 1e9).toFixed(1) + 'B';
  }
  if (value >= 1e6) {
    return (value / 1e6).toFixed(1) + 'M';
  }
  if (value >= 1e4) {
    return Math.round(value / 1e3) + 'k';
  }
  if (value >= 100) {
    return Math.round(value).toLocaleString();
  }
  return String(Math.round(value * 10) / 10);
}

function plural(count, word) {
  return count + ' ' + word + (count === 1 ? '' : 's');
}
