// The Build maker's "Our ideas" view: builds the generator (public/buildgen.js, run offline by
// scripts/generate_builds.mjs) composed from the game's mechanics, each checked against how many characters
// play its ascendancy and main skill on poe.ninja. A build nobody plays is shown as untested (maybe a mistake in
// our reasoning, maybe a find); one played by a few dozen is a working niche, which is what this view hunts for.
import { IDEA_QUESTION_IDS, ideaTraits, matchesAnswer } from './builds.js';
import { PLAYER_BANDS, prepareMechanics, rebuildFromNames, evaluateBuild, pieceGains, describeEffect, typesWithSupports, plannedTreeOf, attachPrices } from './buildgen.js';
import { slotOptions, jewelOptions, setComparison } from './buildrevisit.js';
import { revisitSection } from './buildrevisitview.js';
import { treeView } from './buildtreeview.js';
import { scoreFunctionFor } from './buildstages.js';
import { GEAR_LEVELS, DEFAULT_GEAR_LEVEL, gearItemLabel, craftQuery, rebuildGear, compactGear } from './buildgear.js';
import { iconLine } from './buildicons.js';
import { fetchBuildFile } from './builddata.js';
import { loadCraftGear } from './craftdata.js';

const FIRST_IDEAS = 12;
const MORE_IDEAS = 24;
const DEFAULT_BANDS = ['niche', 'experimental'];
const WHEEL_IDEAS = 12;
const WHEEL_POOL = 60; // the wheel spins over the best few dozen ideas that fit, not the whole list

let X; // helpers from buildmaker.js: el, rerender, store, chip, plural, percent, leagueUrl, withTradeLinks
const I = {
  status: 'idle', // idle -> loading -> ready | failed
  generated: null, index: null, game: null,
  bands: null, // which player bands are shown
  plan: null, // 'power' (pieces chosen for power alone) or 'value' (chosen for power over price)
  shown: FIRST_IDEAS,
  open: new Set(), // ideas whose "why" is unfolded
  traits: new Map(),
  rebuilt: new Map(), // an open "why"'s build, rebuilt once (its tree takes a few seconds to plan)
  rebuilding: new Set(), // the "why"s whose build is being rebuilt
  plannedTrees: new Map(), // a rebuilt build's planned tree (plannedTreeOf), handed to the worker by "Revisit gear"
  revisitOpen: new Set(), // cards whose "Revisit gear" is unfolded
};

// ---------- loading ----------

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
    const [generated, index] = await Promise.all([fetchBuildFile('generated-poe1.json'), loadIndex()]);
    expandStoredGear(generated, index);
    I.generated = generated;
    I.status = 'ready';
  } catch (error) {
    I.status = 'failed';
    I.error = error.message;
  }
  X.rerender();
}

// The mechanics and the tree, prepared once: the ideas view and the build planner (public/buildplanner.js) share
// them, the planner without the precomputed ideas.
let indexLoading = null;
function loadIndex() {
  if (indexLoading === null) {
    indexLoading = Promise.all([fetchBuildFile('mechanics-poe1.json'), fetchBuildFile('tree-poe1.json'), loadCraftGear()]).then(([mechanics, tree, gear]) => {
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
  const weaponText = weaponWordsOf(idea);
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
  facts.push(dpsChip(idea));
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
    defenceLine(idea),
    iconLine(X, 'Supports', supportPieces(idea.supports)),
    iconLine(X, 'Ascendancy', namedPieces(idea.notables), { kind: 'passive' }),
    iconLine(X, 'Keystones', namedPieces(idea.keystones), { kind: 'passive', shape: 'round' }),
    treeLine(idea),
    masteryLine(idea),
    iconLine(X, 'Jewels', namedPieces(idea.treeJewels)),
    iconLine(X, 'Uniques', X.withTradeLinks(namedPieces(idea.uniques))),
    gearSection(idea),
    iconLine(X, 'Auras, curse, Offerings', namedPieces(idea.buffs)),
    pieceLine('Corpses', corpseGemOf(idea)),
    pieceLine('Stacks', idea.stacking ? [STACKING_WORDS[idea.stacking] || idea.stacking] : null),
    reservedLine(idea),
    iconLine(X, 'Flasks', namedPieces(idea.flasks)),
    ...extraSections,
    X.el('button', { type: 'button', class: 'linklike bm-why-toggle', 'aria-expanded': open ? 'true' : 'false', onclick: () => toggleOpen(key) },
      open ? 'Hide why' : 'Why these pieces'),
    open ? whySection(idea) : null,
    X.el('button', { type: 'button', class: 'linklike bm-why-toggle', 'aria-expanded': I.revisitOpen.has(key) ? 'true' : 'false', onclick: () => toggleRevisit(key) },
      I.revisitOpen.has(key) ? 'Hide revisit' : 'Revisit gear'),
    I.revisitOpen.has(key) ? revisitPanel(idea, key) : null,
    X.el('a', { class: 'bm-link-out', href: ninjaLink(idea), target: '_blank', rel: 'noopener' }, 'Check on poe.ninja ↗'));
}


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
      affixes.push(X.el('li', {}, affix.text, X.el('span', { class: 'muted' }, ' T' + affix.tier + affixSourceText(affix))));
    }
    rows.push(X.el('div', { class: 'bm-gear-item' },
      X.el('div', { class: 'bm-gear-head' },
        X.el('strong', {}, gearItemLabel(item)),
        X.el('a', { class: 'linklike', href: craftQuery(item), title: 'Open the Crafting tab with these affixes as targets' }, 'Craft it')),
      X.el('ul', { class: 'bm-gear-affixes' }, affixes)));
  }
  return X.el('details', { class: 'bm-gear' },
    X.el('summary', {}, X.el('span', { class: 'bm-list-label' }, 'Rare gear'), ' ', idea.gear.items.length + ' items, ' + gearLevelLabel(idea.gear.level)),
    X.el('div', { class: 'bm-gear-grid' }, rows));
}

// Where an affix comes from, when a crafter has to do something for it: an influence, an essence, a bench craft...
const AFFIX_SOURCE_WORDS = { shaper: 'Shaper', elder: 'Elder', crusader: 'Crusader', hunter: 'Hunter', redeemer: 'Redeemer',
  warlord: 'Warlord', essence: 'essence', veiled: 'veiled', bench: 'bench craft', beast: 'beast craft', fossil: 'fossil' };
function affixSourceText(affix) {
  if (affix.affix === 'r') {
    return ' · Searing Exarch implicit';
  }
  if (affix.affix === 'b') {
    return ' · Eater of Worlds implicit';
  }
  const words = AFFIX_SOURCE_WORDS[affix.source];
  return words ? ' · ' + words : '';
}

function gearLevelLabel(level) {
  return (GEAR_LEVELS[level] || GEAR_LEVELS[DEFAULT_GEAR_LEVEL]).label.toLowerCase() + ' affixes';
}

const WEAPON_WORDS = { staff: 'Staff', wand: 'Wand', bow: 'Bow', sword: 'Sword', axe: 'Axe', mace: 'Mace or sceptre', claw: 'Claw', dagger: 'Dagger', shield: 'Shield',
  twoHandSword: 'Two-handed sword', twoHandAxe: 'Two-handed axe', twoHandMace: 'Two-handed mace' };
// A one-handed weapon without a shield is held twice (public/buildgear.js, dualWields), unless a two-handed unique
// takes both hands.
const DUAL_WIELD_WORDS = { sword: 'Two swords', axe: 'Two axes', mace: 'Two maces or sceptres', claw: 'Two claws', dagger: 'Two daggers', wand: 'Two wands' };
const TWO_HANDED_WORDS = { sword: 'Two-handed sword', axe: 'Two-handed axe', mace: 'Two-handed mace' };

// How the card names the build's weapons.
function weaponWordsOf(idea) {
  if (!idea.weapon || idea.weapon === 'none') {
    return null;
  }
  if (!DUAL_WIELD_WORDS[idea.weapon]) {
    return WEAPON_WORDS[idea.weapon] ?? idea.weapon;
  }
  for (const name of idea.uniques || []) {
    const unique = I.index?.uniques.find(entry => entry.name === name);
    if (unique && unique.slot === 'weapon' && unique.twoHanded) {
      return TWO_HANDED_WORDS[idea.weapon] ?? WEAPON_WORDS[idea.weapon];
    }
  }
  return DUAL_WIELD_WORDS[idea.weapon];
}

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

// How much of mana and life its buffs reserve, after reservation efficiency, and what is left paying for the skill.
function reservedLine(idea) {
  const parts = [];
  if (idea.reserved > 0) {
    parts.push(Math.round(idea.reserved) + '% of mana');
  }
  if (idea.reservedLife > 0) {
    parts.push(Math.round(idea.reservedLife) + '% of life');
  }
  if (idea.reservedManaFlat > 0) {
    parts.push(idea.reservedManaFlat + ' mana');
  }
  if (idea.reservedLifeFlat > 0) {
    parts.push(idea.reservedLifeFlat + ' life');
  }
  const upkeep = upkeepText(idea.upkeep);
  if (upkeep) {
    parts.push(upkeep);
  }
  return parts.length > 0 ? pieceLine('Reserved', parts) : null;
}

// "skill 61 mana a use, pays for itself" or "skill 154 mana a use, casts 64% of a fight": the main skill's cost, and
// whether what isn't reserved and what comes back keep it going (public/buildgen.js, manaUpkeepOf).
function upkeepText(upkeep) {
  if (!upkeep) {
    return null;
  }
  const lasting = upkeep.share >= 0.995 ? 'pays for itself' : 'casts ' + Math.round(upkeep.share * 100) + '% of a fight';
  return X.el('span', { title: 'Spends about ' + upkeep.spent + ' ' + upkeep.paidWith + ' a second and gets ' + upkeep.regained
    + ' back (regeneration, leech, on hit and on kill), over a 20-second fight with what isn’t reserved as a buffer' },
    'skill ' + upkeep.cost + ' ' + upkeep.paidWith + ' a use, ' + lasting);
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

// Names as icon pieces (public/buildicons.js): each shows its picture, and its name in the pop-up.
// An Offering consumes a corpse, and a boss leaves none: the generator counts a socket for a gem that makes them
// (OFFERING_CORPSE_GEM_SOCKETS in buildgen.js), named here.
function corpseGemOf(idea) {
  for (const name of idea.buffs || []) {
    if (name.endsWith(' Offering')) {
      return ['Desecrate or Unearth, to make corpses for the Offerings'];
    }
  }
  return null;
}

function namedPieces(names) {
  if (!names) {
    return null;
  }
  const pieces = [];
  for (const name of names) {
    pieces.push({ name });
  }
  return pieces;
}

// A support's picture is found by its full name; the pop-up drops the word "Support".
function supportPieces(supports) {
  const pieces = [];
  for (const name of supports ?? []) {
    pieces.push({ name, label: name.replace(/ Support$/, '') });
  }
  return pieces;
}

// The planned tree's notables, all of them: as icons they take a line or two.
function treeLine(idea) {
  return iconLine(X, 'Tree', namedPieces(idea.treeNotables),
    { kind: 'passive', title: 'Notables on the planned passive tree (' + idea.treePoints + ' points)' });
}

// The planned tree's masteries: each icon's pop-up says the option the planner chose.
function masteryLine(idea) {
  return iconLine(X, 'Masteries', namedPieces(idea.treeMasteries), { kind: 'passive' });
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
// Planning the tree again takes a few seconds, so a worker (public/build-worker.js) does it while the card says so,
// and the page puts the build back together from the tree it sends.
function rebuildKeyOf(idea) {
  return JSON.stringify([idea.ascendancy, idea.skill, idea.weapon, idea.supports, idea.notables, idea.uniques, idea.buffs, idea.flasks, idea.weights || null, Boolean(idea.wide)]);
}

function rebuildOptionsOf(idea) {
  const options = {};
  if (idea.planned && idea.weights) {
    options.scoreOf = scoreFunctionFor(idea.weights);
  }
  if (idea.planned && idea.wide) {
    options.wide = true;
  }
  return options;
}

let whyWorker = null;
let whyTaskCount = 0;
const whyTasks = new Map(); // task id -> what to do with the worker's answer

function startWhyWorker() {
  if (whyWorker !== null || typeof Worker === 'undefined') {
    return whyWorker;
  }
  try {
    whyWorker = new Worker('build-worker.js', { type: 'module' });
  } catch (error) {
    return null;
  }
  whyWorker.onmessage = event => {
    const task = whyTasks.get(event.data.id);
    if (!task) {
      return;
    }
    whyTasks.delete(event.data.id);
    if (event.data.error !== undefined) {
      task.failed();
      return;
    }
    task.done(event.data.result);
  };
  whyWorker.onerror = () => {
    // The worker can't run here (an old browser, a blocked module): every waiting card is rebuilt on the page.
    const waiting = [...whyTasks.values()];
    whyTasks.clear();
    whyWorker = null;
    for (const task of waiting) {
      task.failed();
    }
  };
  return whyWorker;
}

function finishRebuild(key, build, plannedTree = null) {
  I.rebuilt.set(key, build);
  if (build) {
    I.plannedTrees.set(key, plannedTree || plannedTreeOf(build));
  }
  I.rebuilding.delete(key);
  X.rerender();
}

// Without a worker the build is rebuilt on the page, after the "working out" line has been drawn.
function rebuildOnPage(idea, key) {
  setTimeout(() => finishRebuild(key, rebuildFromNames(idea, I.index, rebuildOptionsOf(idea))), 50);
}

function startRebuild(idea, key) {
  if (I.rebuilding.has(key)) {
    return;
  }
  I.rebuilding.add(key);
  const worker = startWhyWorker();
  if (!worker) {
    rebuildOnPage(idea, key);
    return;
  }
  whyTaskCount += 1;
  const id = whyTaskCount;
  whyTasks.set(id, {
    done: plannedTree => {
      if (!plannedTree) {
        finishRebuild(key, null);
        return;
      }
      finishRebuild(key, rebuildFromNames(idea, I.index, { ...rebuildOptionsOf(idea), plannedTree }), plannedTree);
    },
    failed: () => rebuildOnPage(idea, key),
  });
  try {
    worker.postMessage({ id, task: { type: 'why', idea, weights: idea.planned ? idea.weights || null : null, wide: Boolean(idea.planned && idea.wide) } });
  } catch (error) {
    whyTasks.delete(id);
    rebuildOnPage(idea, key);
  }
}

function whySection(idea) {
  const key = rebuildKeyOf(idea);
  if (!I.rebuilt.has(key)) {
    startRebuild(idea, key);
    return X.el('div', { class: 'bm-why' },
      X.el('p', { class: 'working', role: 'status' }, 'Working out why these pieces… (planning the passive tree again, a few seconds)'));
  }
  const build = I.rebuilt.get(key);
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
    // The tree's keystones, notables and masteries as icons (their names and wording in the pop-ups).
    const treeIcons = [];
    if (gain.field === 'tree') {
      treeIcons.push(
        iconLine(X, 'Keystones', namedPieces(gain.keystones), { kind: 'passive', shape: 'round' }),
        iconLine(X, gain.notables.length + ' notables', namedPieces(gain.notables), { kind: 'passive' }),
        iconLine(X, 'Masteries', gain.masteries.map(mastery => ({ name: mastery.name, note: mastery.text.split('\n').join('; ') })), { kind: 'passive' }));
    }
    rows.push(X.el('li', {},
      X.el('span', { class: 'bm-why-gain' }, '+' + Math.round(gain.gain * 100) + '%'), ' ',
      X.el('strong', {}, gain.name.replace(/ Support$/, '')),
      reasons.length ? X.el('span', { class: 'muted' }, ': ' + reasons.join('; ')) : null,
      ...treeIcons));
  }
  return X.el('div', { class: 'bm-why' },
    X.el('p', { class: 'muted' },
      'Pieces scale the bare skill ', evaluation.scaling.toFixed(0), '×; effective HP about ', Math.round(evaluation.ehp / 100) * 100,
      ' against a 10,000 pinnacle boss hit (', evaluation.defence.toFixed(1), '× a character with nothing defensive but gear).',
      evaluation.dps ? ' Attack DPS about ' + dpsText(evaluation.dps) + ' on the sheet, with the card’s rare weapon (a good rare one without gear data) and rare gear and nothing else: no jewels, unique weapon or mirror-tier gear, so a well-geared character does several times more.' : '',
      ' Each line: how much lower the score would be without that piece.'),
    X.el('ul', {}, rows),
    build.tree?.nodes && I.index.tree ? treeView(X, I.index.tree, build.tree, idea.ascendancy + '|' + idea.skill + '|' + (I.plan || 'power'), describeEffect) : null);
}

function dpsText(dps) {
  return shortNumber(dps);
}

// 950, 1.2k, 15k, 320k, 1.4M, 12M: a number as the card shows it.
function shortNumber(value) {
  const size = Math.abs(value);
  if (size >= 1e7) {
    return Math.round(value / 1e6) + 'M';
  }
  if (size >= 1e6) {
    return (value / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (size >= 1e4) {
    return Math.round(value / 1e3) + 'k';
  }
  if (size >= 1e3) {
    return (value / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return String(Math.round(value));
}

// The sheet DPS the generator works out: a weapon attack's, before enemy resistances, as poe.ninja shows it. Spells,
// minions and damage over time have no absolute figure in our model (only how much the pieces scale the bare skill).
function dpsChip(idea) {
  if (idea.dps) {
    return X.el('span', { class: 'bm-trait', title: 'Attack DPS on the character sheet, before enemy resistances, with the card’s rare weapon and rare gear: no jewels, unique weapon or mirror-tier gear' },
      'DPS ' + shortNumber(idea.dps));
  }
  return X.el('span', { class: 'bm-trait muted', title: 'Only weapon attacks get an absolute DPS; for spells, minions and damage over time the model measures how much the pieces scale the bare skill' },
    'scales skill ' + Math.round(idea.scaling) + '×');
}

// The defences the effective HP was measured with (public/buildgen.js, defenceSheetOf): pools, armour and evasion,
// avoidance, resistances, damage taken and "taken as" lines. Cards made before these were stored show the EHP only.
const DAMAGE_TYPE_WORDS = { physical: 'physical', fire: 'fire', cold: 'cold', lightning: 'lightning', chaos: 'chaos',
  elemental: 'elemental', nonChaos: 'non-chaos' };

function defenceLine(idea) {
  const parts = [];
  if (idea.ehp) {
    parts.push(X.el('span', { title: 'Effective HP against a 10,000 pinnacle boss hit' }, X.el('strong', {}, 'EHP ' + shortNumber(idea.ehp))));
  }
  const sheet = idea.sheet;
  if (sheet) {
    parts.push(...poolParts(sheet), ...ratingParts(sheet), ...avoidanceParts(sheet));
    const res = sheet.resistances;
    parts.push(X.el('span', { title: 'Fire / cold / lightning / chaos resistance' }, 'Res ' + [res.fire, res.cold, res.lightning, res.chaos].join(' / ')));
    if (sheet.damageTaken !== 0) {
      parts.push(X.el('span', { title: 'More and less damage taken lines, over the hit’s damage types' },
        Math.abs(sheet.damageTaken) + '% ' + (sheet.damageTaken < 0 ? 'less' : 'more') + ' damage taken'));
    }
    for (const line of sheet.takenAs || []) {
      parts.push(X.el('span', { title: 'Not yet counted in the effective HP' }, line.value + '% of ' + typeWords(line.from) + ' taken as ' + typeWords(line.to)));
    }
  }
  return parts.length > 0 ? pieceLine('Defences', parts) : null;
}

function poolParts(sheet) {
  const parts = [];
  if (sheet.life > 1) {
    parts.push('Life ' + shortNumber(sheet.life));
  }
  if (sheet.energyShield > 0) {
    parts.push('ES ' + shortNumber(sheet.energyShield));
  }
  return parts;
}

function ratingParts(sheet) {
  const parts = [];
  if (sheet.armour > 0) {
    parts.push(X.el('span', { title: 'Physical damage reduction against the reference hit’s physical part, with endurance charges and other reductions' },
      'Armour ' + shortNumber(sheet.armour) + ' (' + sheet.physicalReduction + '% phys)'));
  } else if (sheet.physicalReduction > 0) {
    parts.push(sheet.physicalReduction + '% phys reduction');
  }
  if (sheet.evasion > 0) {
    parts.push(X.el('span', { title: 'Chance to evade a pinnacle boss’s attack' }, 'Evasion ' + shortNumber(sheet.evasion) + ' (' + sheet.evade + '% evade)'));
  }
  return parts;
}

function avoidanceParts(sheet) {
  const parts = [];
  if (sheet.block > 0 || sheet.spellBlock > 0) {
    parts.push('Block ' + sheet.block + '% / spell ' + sheet.spellBlock + '%');
  }
  if (sheet.suppress > 0) {
    parts.push('Suppress ' + sheet.suppress + '%');
  }
  return parts;
}

function typeWords(types) {
  if (!types || types.length === 0) {
    return 'damage';
  }
  return types.map(type => DAMAGE_TYPE_WORDS[type] || type).join(' and ');
}

function ninjaLink(idea) {
  const query = new URLSearchParams({ class: idea.ascendancy, skills: idea.skill });
  const leagueUrl = idea.leagueUrl || I.generated.leagueUrl;
  return 'https://poe.ninja/poe1/builds/' + encodeURIComponent(leagueUrl) + '?' + query.toString();
}

// ---------- revisit ----------
function toggleRevisit(key) {
  if (I.revisitOpen.has(key)) {
    I.revisitOpen.delete(key);
  } else {
    I.revisitOpen.add(key);
  }
  X.rerender();
}

// "Revisit gear" needs the card's build with its tree, like "Why these pieces": the same rebuild, then the panel.
function revisitPanel(idea, cardKey) {
  const key = rebuildKeyOf(idea);
  if (!I.rebuilt.has(key)) {
    startRebuild(idea, key);
    return X.el('div', { class: 'bm-revisit' },
      X.el('p', { class: 'working', role: 'status' }, 'Getting the build ready… (planning the passive tree again, a few seconds)'));
  }
  if (!I.rebuilt.get(key)) {
    return X.el('p', { class: 'muted' }, 'This build names a piece the current game data no longer has; rebuild the data.');
  }
  return revisitSection(X, { key: cardKey, idea, plannedTree: I.plannedTrees.get(key) }, askBuildWorker);
}

// A task for the build worker, as a promise of its answer. Without a worker the revisit is worked out here.
function askBuildWorker(task) {
  const worker = startWhyWorker();
  if (!worker) {
    return new Promise(resolve => setTimeout(() => resolve(revisitOnPage(task)), 50));
  }
  return new Promise((resolve, reject) => {
    whyTaskCount += 1;
    const id = whyTaskCount;
    whyTasks.set(id, { done: resolve, failed: () => resolve(revisitOnPage(task)) });
    try {
      worker.postMessage({ id, task });
    } catch (error) {
      whyTasks.delete(id);
      reject(error);
    }
  });
}

// The worker's revisitAnswer (public/build-worker.js), on the page's index.
function revisitOnPage(task) {
  if (task.prices) {
    attachPrices(I.index, task.prices.chaosByName, task.prices.divineChaos);
  }
  const scoreOf = task.weights ? scoreFunctionFor(task.weights) : build => evaluateBuild(build).score;
  const options = { scoreOf, plannedTree: task.plannedTree };
  if (task.wide) {
    options.wide = true;
  }
  const build = rebuildFromNames(task.idea, I.index, options);
  if (!build) {
    return null;
  }
  const question = task.question;
  if (question.kind === 'slot') {
    return slotOptions(build, I.index, question.slot, question.budget, { scoreOf });
  }
  if (question.kind === 'jewels') {
    return jewelOptions(build, I.index, question.budget, { scoreOf });
  }
  return setComparison(build, I.index, question.priceCap, { scoreOf });
}
