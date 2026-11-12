// The Build maker's "Our ideas" view: builds the generator (public/buildgen.js, run offline by
// scripts/generate_builds.mjs) composed from the game's mechanics, each checked against how many characters
// play its ascendancy and main skill on poe.ninja. A build nobody plays is shown as untested (maybe a mistake in
// our reasoning, maybe a find); one played by a few dozen is a working niche, which is what this view hunts for.
import { IDEA_QUESTION_IDS, ideaTraits, matchesAnswer } from './builds.js';
import { PLAYER_BANDS, prepareMechanics, rebuildFromNames, evaluateBuild, pieceGains, describeEffect, typesWithSupports } from './buildgen.js';
import { treeView } from './buildtreeview.js';
import { scoreFunctionFor } from './buildstages.js';
import { GEAR_LEVELS, DEFAULT_GEAR_LEVEL, craftQuery, rebuildGear, compactGear } from './buildgear.js';

const DATA = 'data/builds/';
const FIRST_IDEAS = 12;
const MORE_IDEAS = 24;
const DEFAULT_BANDS = ['niche', 'experimental'];
const WHEEL_IDEAS = 12;
const WHEEL_POOL = 60; // the wheel spins over the best few dozen ideas that fit, not the whole list

let X; // helpers from buildmaker.js: el, rerender, store, chip, plural, percent, leagueUrl
const I = {
  status: 'idle', // idle -> loading -> ready | failed
  generated: null, index: null, game: null,
  bands: null, // which player bands are shown
  plan: null, // 'power' (pieces chosen for power alone) or 'value' (chosen for power over price)
  shown: FIRST_IDEAS,
  open: new Set(), // ideas whose "why" is unfolded
  traits: new Map(),
  rebuilt: new Map(), // an open "why"'s build, rebuilt once (its tree takes about a second to plan)
};

// ---------- loading ----------
async function fetchJson(path) {
  const response = await fetch(DATA + path);
  if (!response.ok) {
    throw new Error(path + ' answered ' + response.status);
  }
  return response.json();
}

// The generated file keeps each rare item as its base and affix ids (storeGear); the cards want the affixes' text and
// tiers, which come back from the gear data. Without the gear data the cards show no rare items.
function expandStoredGear(generated, index) {
  for (const build of generated.builds) {
    if (!build.gear) {
      continue;
    }
    build.gear = index.gear ? compactGear(rebuildGear(build.gear, index.gear)) : null;
  }
}

async function load() {
  I.status = 'loading';
  try {
    const [generated, index] = await Promise.all([fetchJson('generated-poe1.json'), loadIndex()]);
    expandStoredGear(generated, index);
    I.generated = generated;
    I.status = 'ready';
  } catch (error) {
    I.status = 'failed';
    I.error = error.message;
  }
  X.rerender();
}

// The rare-gear affixes from the crafting data (public/data/craft/gear-poe1.json), or null where the site was built
// without it: cards then show no rare items, and the engine uses its fixed gear figures.
async function fetchGear() {
  try {
    const response = await fetch('data/craft/gear-poe1.json');
    return response.ok ? await response.json() : null;
  } catch (error) {
    return null;
  }
}

// The mechanics and the tree, prepared once: the ideas view and the build planner (public/buildplanner.js) share
// them, the planner without the precomputed ideas.
let indexLoading = null;
function loadIndex() {
  if (indexLoading === null) {
    indexLoading = Promise.all([fetchJson('mechanics-poe1.json'), fetchJson('tree-poe1.json'), fetchGear()]).then(([mechanics, tree, gear]) => {
      I.index = prepareMechanics(mechanics, tree, gear);
      return I.index;
    });
    indexLoading.catch(() => {
      indexLoading = null; // a later call tries again
    });
  }
  return indexLoading;
}

// For the build planner: the prepared index, loading it if needed (a promise).
export function sharedIndex(helpers) {
  X = helpers;
  return loadIndex();
}

// The plan the cards show, 'power' or 'value', and switching it (the planner has its own switch).
export function ideaPlan() {
  if (I.plan === null) {
    I.plan = savedPlan();
  }
  return I.plan;
}

export function chooseIdeaPlan(plan) {
  choosePlan(plan);
}

function savedPlan() {
  return X.store.get('buildIdeaPlan', 'power') === 'value' ? 'value' : 'power';
}

function choosePlan(plan) {
  I.plan = plan;
  X.store.set('buildIdeaPlan', plan);
  X.rerender();
}

// The idea as the chosen plan has it: the power plan is the idea itself, the value plan replaces its pieces.
function planOf(idea) {
  if (I.plan === 'value' && idea.value) {
    return { ...idea, ...idea.value, powerPlanScore: idea.score };
  }
  return idea;
}

function savedBands() {
  const saved = X.store.get('buildIdeaBands', null);
  if (Array.isArray(saved) && saved.length > 0) {
    return new Set(saved);
  }
  return new Set(DEFAULT_BANDS);
}

function toggleBand(bandId) {
  if (I.bands.has(bandId)) {
    I.bands.delete(bandId);
  } else {
    I.bands.add(bandId);
  }
  X.store.set('buildIdeaBands', [...I.bands]);
  I.shown = FIRST_IDEAS;
  X.rerender();
}

// ---------- filtering by the questionnaire's answers ----------
function traitsOf(idea, game) {
  const key = idea.ascendancy + '|' + idea.skill;
  if (I.traits.has(key)) {
    return I.traits.get(key);
  }
  const supports = [];
  for (const name of idea.supports) {
    const support = I.index.supports.find(entry => entry.name === name);
    if (support) {
      supports.push(support);
    }
  }
  const skill = I.index.skills.find(entry => entry.name === idea.skill);
  const traits = ideaTraits(game.skills[idea.skill], supportAddedTypes(skill, supports));
  I.traits.set(key, traits);
  return traits;
}

// The skill types the build's supports add on top of the skill's own.
function supportAddedTypes(skill, supports) {
  if (!skill) {
    return new Set();
  }
  const own = new Set(skill.types);
  const all = typesWithSupports(skill, supports);
  const added = new Set();
  for (const type of all) {
    if (!own.has(type)) {
      added.add(type);
    }
  }
  return added;
}

function matchesIdea(idea, answers, game) {
  const archetypeLike = { baseClass: idea.baseClass, ascendancy: idea.ascendancy, skill: idea.skill, traits: traitsOf(idea, game) };
  for (const questionId of IDEA_QUESTION_IDS) {
    const answer = answers[questionId];
    if (answer == null) {
      continue;
    }
    if (!matchesAnswer(archetypeLike, questionId, answer)) {
      return false;
    }
  }
  return true;
}

export function ideasFitting(answers, game) {
  const fitting = [];
  for (const idea of I.generated.builds) {
    if (!I.bands.has(idea.band)) {
      continue;
    }
    if (matchesIdea(idea, answers, game)) {
      fitting.push(idea);
    }
  }
  return fitting;
}

// For the spin wheel: a dozen ideas drawn from the best that fit.
export function ideaWheelCandidates(answers, game, randomNumber) {
  if (I.status !== 'ready') {
    return [];
  }
  const pool = ideasFitting(answers, game).slice(0, WHEEL_POOL);
  const picked = [];
  const remaining = [...pool];
  while (picked.length < WHEEL_IDEAS && remaining.length > 0) {
    const position = Math.floor(randomNumber() * remaining.length);
    picked.push(remaining.splice(position, 1)[0]);
  }
  return picked;
}

export function ideasReady() {
  return I.status === 'ready';
}

// ---------- the view ----------
export function ideasView(helpers, answers, game) {
  X = helpers;
  if (I.bands === null) {
    I.bands = savedBands();
  }
  if (I.plan === null) {
    I.plan = savedPlan();
  }
  if (I.status === 'idle') {
    load();
  }
  if (I.status === 'loading' || I.status === 'idle') {
    return [X.el('p', { class: 'muted' }, 'Loading the generator\'s builds…')];
  }
  if (I.status === 'failed') {
    return [X.el('p', { class: 'empty' }, 'The generated builds didn\'t load (' + I.error + '). Run npm run builds:build.')];
  }
  const fitting = ideasFitting(answers, game);
  return [ideasIntro(), bandFilter(), planToggle(), ideasList(fitting)];
}

function ideasIntro() {
  const calibration = I.generated.calibration;
  return X.el('div', { class: 'bm-intro' },
    X.el('p', {},
      'These builds come from our own generator, not from what people play: it reads every skill, support, ascendancy notable, keystone and unique, ',
      'works out which of them reach a skill and how much they scale it, and keeps the pieces that help most. Only then does it ask poe.ninja how many characters in ',
      I.generated.league, ' play that ascendancy and skill. Nobody: maybe our mistake, maybe a find. A few dozen: a working niche.'),
    X.el('p', { class: 'muted' },
      'Ranked by how much better the ascendancy suits the skill than a typical one. Check: for ',
      Math.round(calibration.favouriteAscendancyInTop3 * 100), '% of ', calibration.skillsTested,
      ' much-played skills, players\' favourite ascendancy is among the generator\'s three best (random picks: 14%). Scores compare builds; they are not DPS.'));
}

function bandFilter() {
  const buttons = [];
  for (const band of PLAYER_BANDS) {
    const on = I.bands.has(band.id);
    buttons.push(X.el('button', { type: 'button', class: 'bm-band-toggle bm-band-' + band.id + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', onclick: () => toggleBand(band.id) },
      band.label, X.el('span', { class: 'muted' }, ' ' + bandRange(band))));
  }
  return X.el('div', { class: 'bm-bands', role: 'group', 'aria-label': 'Show builds played by' }, buttons);
}

// Two scores per build: the power plan never sees a price; the value plan picks each unique for its gain over
// its price. Shown only when the ideas were generated with prices.
function planToggle() {
  const prices = I.generated.prices;
  if (!prices) {
    return null;
  }
  const choices = [
    { id: 'power', label: 'Power plan', title: 'Pieces chosen for power alone; prices never weighed' },
    { id: 'value', label: 'Value plan', title: 'Uniques chosen for their gain over their price (poe.ninja, ' + prices.from + ', ' + prices.fetched.slice(0, 10) + ')' },
  ];
  const buttons = [];
  for (const choice of choices) {
    const on = I.plan === choice.id;
    buttons.push(X.el('button', { type: 'button', class: 'bm-band-toggle' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', title: choice.title, onclick: () => choosePlan(choice.id) }, choice.label));
  }
  return X.el('div', { class: 'bm-bands', role: 'group', 'aria-label': 'Which plan the cards show' }, buttons);
}

function bandRange(band) {
  const index = PLAYER_BANDS.indexOf(band);
  const low = index === 0 ? 0 : PLAYER_BANDS[index - 1].max + 1;
  if (band.max === 0) {
    return '(0)';
  }
  if (band.max === Infinity) {
    return '(' + low + '+)';
  }
  return '(' + low + '–' + band.max + ')';
}

function ideasList(fitting) {
  if (fitting.length === 0) {
    return X.el('p', { class: 'empty' }, 'No generated build fits these answers and player bands. Clear an answer or show more bands.');
  }
  const cards = [];
  for (const idea of fitting.slice(0, I.shown)) {
    cards.push(ideaCard(idea));
  }
  const more = fitting.length > I.shown
    ? X.el('button', { type: 'button', class: 'ghost bm-more', onclick: () => { I.shown += MORE_IDEAS; X.rerender(); } }, 'Show more (' + (fitting.length - I.shown) + ' left)')
    : null;
  return X.el('section', { class: 'bm-results', 'aria-label': 'Generated builds' },
    X.el('h3', {}, X.plural(fitting.length, 'idea') + ' fit'),
    X.el('div', { class: 'bm-cards' }, cards), more);
}

// extraSections are shown above "Why these pieces" (the build planner adds its stages there). A planned card
// (idea.planned) has no fit, since nothing was precomputed to compare it with.
export function ideaCard(storedIdea, extraClass = '', extraSections = []) {
  const idea = planOf(storedIdea);
  const key = (idea.planned ? 'planned|' : '') + idea.ascendancy + '|' + idea.skill + (idea.variantKey ? '|' + idea.variantKey : '');
  const open = I.open.has(key);
  const band = PLAYER_BANDS.find(entry => entry.id === idea.band) ?? PLAYER_BANDS[0];
  const weaponText = idea.weapon && idea.weapon !== 'none' ? WEAPON_WORDS[idea.weapon] ?? idea.weapon : null;
  const facts = [];
  facts.push(X.el('span', { class: 'bm-trait bm-band-' + band.id, title: band.label }, playersText(idea)));
  if (idea.pastPlayers > 0) {
    facts.push(X.el('span', { class: 'bm-trait proven', title: 'Characters with this ascendancy and skill in past leagues' }, X.plural(idea.pastPlayers, 'player') + ' last league'));
  }
  if (typeof idea.fit === 'number') {
    facts.push(X.el('span', { class: 'bm-trait', title: 'Score of this build over the median score of the same skill across all ascendancies' }, 'fits ' + idea.fit.toFixed(2) + '× better'));
  }
  if (weaponText) {
    facts.push(X.chip(weaponText));
  }
  facts.push(X.chip(idea.crit ? 'Crit' : 'No crit'));
  if (typeof idea.cost === 'number') {
    facts.push(X.el('span', { class: 'bm-trait', title: costTitle(idea) }, 'uniques ' + costText(idea.cost)));
  }
  if (idea.powerPlanScore) {
    facts.push(X.el('span', { class: 'bm-trait', title: 'The value plan’s power over the power plan’s' },
      Math.round(100 * idea.score / idea.powerPlanScore) + '% of full power'));
  }
  return X.el('article', { class: 'bm-card bm-idea ' + extraClass },
    X.el('header', {},
      X.el('h4', {}, idea.ascendancy, X.el('span', { class: 'muted' }, ' · '), idea.skill),
      X.el('span', { class: 'bm-share' }, idea.baseClass)),
    X.el('div', { class: 'bm-traits' }, facts),
    pieceLine('Supports', idea.supports.map(name => name.replace(/ Support$/, ''))),
    pieceLine('Ascendancy', idea.notables),
    pieceLine('Keystones', idea.keystones),
    treeLine(idea),
    masteryLine(idea),
    pieceLine('Jewels', idea.treeJewels),
    pieceLine('Uniques', idea.uniques),
    gearSection(idea),
    pieceLine('Auras, curse', idea.buffs),
    pieceLine('Stacks', idea.stacking ? [STACKING_WORDS[idea.stacking] || idea.stacking] : null),
    reservedLine(idea),
    pieceLine('Flasks', idea.flasks),
    ...extraSections,
    X.el('button', { type: 'button', class: 'linklike bm-why-toggle', 'aria-expanded': open ? 'true' : 'false', onclick: () => toggleOpen(key) },
      open ? 'Hide why' : 'Why these pieces'),
    open ? whySection(idea) : null,
    X.el('a', { class: 'bm-link-out', href: ninjaLink(idea), target: '_blank', rel: 'noopener' }, 'Check on poe.ninja ↗'));
}

const SLOT_WORDS = { body: 'Body armour', helmet: 'Helmet', gloves: 'Gloves', boots: 'Boots', belt: 'Belt', amulet: 'Amulet',
  ring: 'Ring', offhand: 'Shield', quiver: 'Quiver' };

// The solved rare items: each slot with its affixes (tier 1 is the best an item level 84 base rolls), and a link
// that opens the Crafting tab with them as targets to plan and price the craft there.
function gearSection(idea) {
  if (!idea.gear || !idea.gear.items || idea.gear.items.length === 0) {
    return null;
  }
  const rows = [];
  for (const item of idea.gear.items) {
    const affixes = [];
    for (const affix of item.affixes) {
      affixes.push(X.el('li', {}, affix.text, X.el('span', { class: 'muted' }, ' T' + affix.tier)));
    }
    rows.push(X.el('div', { class: 'bm-gear-item' },
      X.el('div', { class: 'bm-gear-head' },
        X.el('strong', {}, SLOT_WORDS[item.slot] || item.slot),
        X.el('a', { class: 'linklike', href: craftQuery(item), title: 'Open the Crafting tab with these affixes as targets' }, 'Craft it')),
      X.el('ul', { class: 'bm-gear-affixes' }, affixes)));
  }
  return X.el('details', { class: 'bm-gear' },
    X.el('summary', {}, X.el('span', { class: 'bm-list-label' }, 'Rare gear'), ' ', idea.gear.items.length + ' items, ' + gearLevelLabel(idea.gear.level)),
    X.el('div', { class: 'bm-gear-grid' }, rows));
}

function gearLevelLabel(level) {
  return (GEAR_LEVELS[level] || GEAR_LEVELS[DEFAULT_GEAR_LEVEL]).label.toLowerCase() + ' affixes';
}

const WEAPON_WORDS = { staff: 'Staff', wand: 'Wand', bow: 'Bow', sword: 'Sword', axe: 'Axe', mace: 'Mace or sceptre', claw: 'Claw', dagger: 'Dagger', shield: 'Shield' };

// The uniques' cost when the ideas were generated, which is also what the generator weighed them by.
function costText(divines) {
  if (divines < 0.5) {
    return 'under 1 div';
  }
  return '≈ ' + Math.round(divines) + ' div';
}

function costTitle(idea) {
  if (idea.planned) {
    return 'What the uniques cost now (poe.ninja); a unique poe.ninja does not list counts as 20 Divines. The value plan picks each unique for its gain over its price; the power plan never weighs prices.';
  }
  const prices = I.generated.prices;
  const source = prices ? ' (poe.ninja, ' + prices.from + ', ' + prices.fetched.slice(0, 10) + ')' : '';
  return 'What the uniques cost when these ideas were made' + source + '; a unique poe.ninja does not list counts as 20 Divines. The value plan picks each unique for its gain over its price; the power plan never weighs prices.';
}

function playersText(idea) {
  if (idea.players === 0) {
    return 'Nobody plays it';
  }
  return X.plural(idea.players, 'player') + ' now';
}

// The stat a build committed to stacking from the start (public/buildgen.js, STACKING_EXTRA).
const STACKING_WORDS = { mana: 'mana', life: 'life', energyShield: 'energy shield', armour: 'armour', evasion: 'evasion' };

// How much of mana and life its buffs reserve, after reservation efficiency.
function reservedLine(idea) {
  const parts = [];
  if (idea.reserved > 0) {
    parts.push(Math.round(idea.reserved) + '% of mana');
  }
  if (idea.reservedLife > 0) {
    parts.push(Math.round(idea.reservedLife) + '% of life');
  }
  return parts.length > 0 ? pieceLine('Reserved', parts) : null;
}

function pieceLine(label, names) {
  if (!names || names.length === 0) {
    return null;
  }
  const items = [];
  for (const name of names) {
    items.push(X.el('li', {}, name));
  }
  return X.el('div', { class: 'bm-list' }, X.el('span', { class: 'bm-list-label' }, label), X.el('ul', {}, items));
}

const CARD_TREE_NOTABLES = 8;

// The planned tree's notables, the first few on the card; "Why these pieces" lists them all.
function treeLine(idea) {
  if (!idea.treeNotables || idea.treeNotables.length === 0) {
    return null;
  }
  const items = [];
  for (const name of idea.treeNotables.slice(0, CARD_TREE_NOTABLES)) {
    items.push(X.el('li', {}, name));
  }
  const hidden = idea.treeNotables.length - CARD_TREE_NOTABLES;
  if (hidden > 0) {
    items.push(X.el('li', { class: 'muted' }, '+' + hidden + ' more'));
  }
  return X.el('div', { class: 'bm-list', title: 'Notables on the planned passive tree (' + idea.treePoints + ' points)' },
    X.el('span', { class: 'bm-list-label' }, 'Tree'), X.el('ul', {}, items));
}

// The planned tree's masteries, each with the option the planner chose.
function masteryLine(idea) {
  if (!idea.treeMasteries || idea.treeMasteries.length === 0) {
    return null;
  }
  const items = [];
  for (const line of idea.treeMasteries) {
    items.push(X.el('li', {}, line));
  }
  return X.el('div', { class: 'bm-list', title: 'Masteries on the planned passive tree, with the chosen option' },
    X.el('span', { class: 'bm-list-label' }, 'Masteries'), X.el('ul', {}, items));
}

function toggleOpen(key) {
  if (I.open.has(key)) {
    I.open.delete(key);
  } else {
    I.open.add(key);
  }
  X.rerender();
}

// What each piece adds, worked out again here with the same engine that chose it.
// The build behind a card, rebuilt from its names once. A build planner card plans its tree by its own stage weights.
function rebuiltBuild(idea) {
  const key = JSON.stringify([idea.ascendancy, idea.skill, idea.weapon, idea.supports, idea.notables, idea.uniques, idea.buffs, idea.flasks, idea.weights || null, Boolean(idea.wide)]);
  if (!I.rebuilt.has(key)) {
    const options = {};
    if (idea.planned && idea.weights) {
      options.scoreOf = scoreFunctionFor(idea.weights);
    }
    if (idea.planned && idea.wide) {
      options.wide = true;
    }
    I.rebuilt.set(key, rebuildFromNames(idea, I.index, options));
  }
  return I.rebuilt.get(key);
}

function whySection(idea) {
  const build = rebuiltBuild(idea);
  if (!build) {
    return X.el('p', { class: 'muted' }, 'This build names a piece the current game data no longer has; rebuild the data.');
  }
  const evaluation = evaluateBuild(build);
  const rows = [];
  const gains = pieceGains(build).sort((first, second) => second.gain - first.gain);
  for (const gain of gains) {
    const reasons = [];
    for (const effect of gain.effects.slice(0, 3)) {
      reasons.push(describeEffect(effect));
    }
    if (gain.field === 'tree') {
      if (gain.keystones.length > 0) {
        reasons.push('keystones ' + gain.keystones.join(', '));
      }
      reasons.push(gain.notables.length + ' notables: ' + gain.notables.join(', '));
      if (gain.masteries.length > 0) {
        reasons.push('masteries: ' + gain.masteries.map(mastery => mastery.name + ' (' + mastery.text.split('\n').join('; ') + ')').join(', '));
      }
    }
    rows.push(X.el('li', {},
      X.el('span', { class: 'bm-why-gain' }, '+' + Math.round(gain.gain * 100) + '%'), ' ',
      X.el('strong', {}, gain.name.replace(/ Support$/, '')),
      reasons.length ? X.el('span', { class: 'muted' }, ': ' + reasons.join('; ')) : null));
  }
  return X.el('div', { class: 'bm-why' },
    X.el('p', { class: 'muted' },
      'Pieces scale the bare skill ', evaluation.scaling.toFixed(0), '×; effective HP about ', Math.round(evaluation.ehp / 100) * 100,
      ' against a 10,000 pinnacle boss hit (', evaluation.defence.toFixed(1), '× a character with nothing defensive but gear).',
      evaluation.dps ? ' Attack DPS about ' + dpsText(evaluation.dps) + ' on the sheet, with a good rare weapon and rare gear and nothing else: no jewels, unique weapon or mirror-tier gear, so a well-geared character does several times more.' : '',
      ' Each line: how much lower the score would be without that piece.'),
    X.el('ul', {}, rows),
    build.tree?.nodes && I.index.tree ? treeView(X, I.index.tree, build.tree, idea.ascendancy + '|' + idea.skill + '|' + (I.plan || 'power'), describeEffect) : null);
}

function dpsText(dps) {
  if (dps >= 1e6) {
    return (dps / 1e6).toFixed(1) + ' million';
  }
  return Math.round(dps / 1000) + ',000';
}

function ninjaLink(idea) {
  const query = new URLSearchParams({ class: idea.ascendancy, skills: idea.skill });
  const leagueUrl = idea.leagueUrl || I.generated.leagueUrl;
  return 'https://poe.ninja/poe1/builds/' + encodeURIComponent(leagueUrl) + '?' + query.toString();
}
