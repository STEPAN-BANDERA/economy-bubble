// The Build maker's "Plan a build" view: the build planner. Choose at least two hard limits (class, ascendancy,
// damage type, weapon, weapon type, playstyle) and it plans the builds that fit, now, in the browser, the way the
// Crafting tab plans an item: workers (public/build-worker.js) run the search in public/buildsearch.js, a quick
// pass over every skill and ascendancy the limits leave, then full plans with the tree and the stage agents
// (public/buildstages.js) for the best few. Cards appear as they are finished.
//
// poe.ninja only reviews the result (how many characters play the pairing) and prices the value plan; it never
// steers the power plan or a stage. Path of Building is the same kind of consultant: scripts can check our numbers
// against it, nothing here reads from it.
import { verifyBuild } from './buildgen.js';
import { STAGES, DEFAULT_WEIGHTS, DEFAULT_TOLERANCE, weightsAreDefault } from './buildstages.js';
import { MIN_LIMITS, LIMIT_IDS, DAMAGE_TYPES, WEAPONS, WEAPON_TYPES, PLAYSTYLES, FULL_PLANS, limitCount, searchSize,
  chooseForFullPlans, classesOf } from './buildsearch.js';
import { sharedIndex, ideaCard, ideaPlan, chooseIdeaPlan } from './buildideas.js';
import { GEAR_LEVELS, DEFAULT_GEAR_LEVEL } from './buildgear.js';

const MAX_WORKERS = 6;
const REDRAW_MILLISECONDS = 300; // progress redraws at most this often: hundreds of quick results arrive a second
const TOLERANCE_CHOICES = [0, 0.02, 0.05, 0.1, 0.2];
const WEIGHT_STEP = 0.05;
const WEIGHT_MAX = 1;
const LIMIT_LABELS = { class: 'Class', ascendancy: 'Ascendancy', damage: 'Damage type', weapon: 'Weapon', weaponType: 'Weapon type', playstyle: 'Playstyle' };

let X; // helpers from buildmaker.js
const P = {
  status: 'idle', // idle -> loading -> ready | failed
  index: null,
  limits: null, wide: false, weights: null, tolerance: null, gearLevel: null,
  job: null,
  workers: [],
  redrawTimer: null,
};
let jobCounter = 0;

// ---------- saved choices ----------
function loadChoices() {
  if (P.limits !== null) {
    return;
  }
  const saved = X.store.get('buildPlanner', {});
  P.limits = {};
  for (const id of LIMIT_IDS) {
    P.limits[id] = typeof saved.limits?.[id] === 'string' ? saved.limits[id] : null;
  }
  P.wide = saved.wide === true;
  P.weights = { ...DEFAULT_WEIGHTS };
  for (const stage of STAGES) {
    const weight = saved.weights?.[stage.id];
    if (typeof weight === 'number' && weight >= 0 && weight <= WEIGHT_MAX) {
      P.weights[stage.id] = weight;
    }
  }
  P.tolerance = TOLERANCE_CHOICES.includes(saved.tolerance) ? saved.tolerance : DEFAULT_TOLERANCE;
  P.gearLevel = GEAR_LEVELS[saved.gearLevel] ? saved.gearLevel : DEFAULT_GEAR_LEVEL;
}

function saveChoices() {
  X.store.set('buildPlanner', { limits: P.limits, wide: P.wide, weights: P.weights, tolerance: P.tolerance, gearLevel: P.gearLevel });
}

function setLimit(id, value) {
  P.limits[id] = value || null;
  if (id === 'class' && value && P.limits.ascendancy && !ascendancyIsOfClass(P.limits.ascendancy, value)) {
    P.limits.ascendancy = null;
  }
  if (id === 'ascendancy' && value) {
    P.limits.class = classOfAscendancy(value);
  }
  saveChoices();
  X.rerender();
}

function ascendancyIsOfClass(ascendancyName, className) {
  return classOfAscendancy(ascendancyName) === className;
}

function classOfAscendancy(ascendancyName) {
  const ascendancy = P.index.ascendancies.find(entry => entry.name === ascendancyName);
  return ascendancy ? ascendancy.baseClass : null;
}

// ---------- the view ----------
export function plannerView(helpers) {
  X = helpers;
  if (P.status === 'idle') {
    P.status = 'loading';
    sharedIndex(helpers).then(index => {
      P.index = index;
      P.status = 'ready';
      X.rerender();
    }, error => {
      P.status = 'failed';
      P.error = error.message;
      X.rerender();
    });
  }
  if (P.status === 'loading') {
    return [X.el('p', { class: 'muted' }, 'Loading the game\'s mechanics…')];
  }
  if (P.status === 'failed') {
    return [X.el('p', { class: 'empty' }, 'The mechanics didn\'t load (' + P.error + '). Run npm run builds:build.')];
  }
  loadChoices();
  return [plannerIntro(), limitsSection(), stagesSection(), startSection(), resultsSection()];
}

function plannerIntro() {
  return X.el('div', { class: 'bm-intro' },
    X.el('p', {},
      'Pick at least ', String(MIN_LIMITS), ' limits and the planner composes the builds that fit, now: every skill and ascendancy they leave is planned ',
      'quickly, then the best ', String(FULL_PLANS), ' get a passive tree and a round of trades between the stages below. Pieces whose tags can\'t reach a build ',
      '(cold lines on a fire build, axe lines on a staff) are skipped rather than measured.'),
    X.el('p', { class: 'muted' },
      'Scores compare builds; they are not DPS. poe.ninja only says how many play each result and prices the value plan.'));
}

function limitsSection() {
  const index = P.index;
  const ascendancyOptions = [];
  for (const ascendancy of index.ascendancies) {
    if (!P.limits.class || ascendancy.baseClass === P.limits.class) {
      ascendancyOptions.push({ id: ascendancy.name, label: ascendancy.name });
    }
  }
  const classOptions = classesOf(index).map(name => ({ id: name, label: name }));
  const pickers = [
    limitPicker('class', classOptions),
    limitPicker('ascendancy', ascendancyOptions),
    limitPicker('damage', DAMAGE_TYPES),
    limitPicker('weapon', WEAPONS),
    limitPicker('weaponType', WEAPON_TYPES),
    limitPicker('playstyle', PLAYSTYLES),
  ];
  return X.el('section', { class: 'bm-planner-limits', 'aria-label': 'Hard limits' },
    X.el('h3', {}, 'Limits'),
    X.el('div', { class: 'bm-planner-grid' }, pickers),
    X.el('label', { class: 'check', title: 'Ignore the tags: plan skills that reach the damage type or playstyle only through conversion or an ailment, try every unique on each ascendancy\'s build, and measure every tree node. Several times slower.' },
      X.el('input', { type: 'checkbox', checked: P.wide, onchange: event => { P.wide = event.target.checked; saveChoices(); X.rerender(); } }),
      'Wide search (ignore the tags, much slower)'));
}

function limitPicker(id, options) {
  const choices = [X.el('option', { value: '', selected: !P.limits[id] }, 'Any')];
  for (const option of options) {
    choices.push(X.el('option', { value: option.id, selected: P.limits[id] === option.id }, option.label));
  }
  return X.el('label', { class: 'bm-planner-limit' },
    X.el('span', { class: 'bm-list-label' }, LIMIT_LABELS[id]),
    X.el('select', { onchange: event => setLimit(id, event.target.value) }, choices));
}

function stagesSection() {
  const rows = [];
  for (const stage of STAGES) {
    const weight = P.weights[stage.id];
    rows.push(X.el('label', { class: 'bm-planner-stage', title: stage.title },
      X.el('span', { class: 'bm-list-label' }, stage.label),
      X.el('input', { type: 'range', min: '0', max: String(WEIGHT_MAX), step: String(WEIGHT_STEP), value: String(weight),
        'aria-label': stage.label + ' weight', onchange: event => { P.weights[stage.id] = Number(event.target.value); saveChoices(); X.rerender(); } }),
      X.el('span', { class: 'bm-planner-weight' }, weight.toFixed(2))));
  }
  const toleranceChoices = [];
  for (const tolerance of TOLERANCE_CHOICES) {
    toleranceChoices.push(X.el('option', { value: String(tolerance), selected: tolerance === P.tolerance }, Math.round(tolerance * 100) + '%'));
  }
  const reset = weightsAreDefault(P.weights)
    ? X.el('span', { class: 'muted' }, 'These are the power score\'s own weights.')
    : X.el('button', { type: 'button', class: 'linklike', onclick: () => { P.weights = { ...DEFAULT_WEIGHTS }; saveChoices(); X.rerender(); } }, 'Back to the power score\'s weights');
  return X.el('section', { class: 'bm-planner-stages', 'aria-label': 'Stages' },
    X.el('h3', {}, 'Stages'),
    X.el('p', { class: 'muted' },
      'Each stage is an agent with its own measure; the weights say how much each counts in the total. After the plan is composed the agents take turns, ',
      'in this order, proposing one swap each (a support, a unique, an aura, a flask). A swap goes through when the total rises and every earlier stage keeps ',
      'at least its share below of what it had.'),
    X.el('div', { class: 'bm-planner-grid' }, rows),
    X.el('label', { class: 'bm-planner-limit' },
      X.el('span', { class: 'bm-list-label' }, 'An earlier stage may lose'),
      X.el('select', { onchange: event => { P.tolerance = Number(event.target.value); saveChoices(); X.rerender(); } }, toleranceChoices)),
    gearLevelChoice(),
    reset);
}

// How good the solved rare items are: their affixes' tiers below the best an item level 84 base rolls. The generated
// ideas are planned at Endgame.
function gearLevelChoice() {
  const options = [];
  for (const [id, level] of Object.entries(GEAR_LEVELS)) {
    const below = level.tiersBelowTop === 0 ? 'top tier' : level.tiersBelowTop + ' below the top tier';
    options.push(X.el('option', { value: id, selected: id === P.gearLevel }, level.label + ' (' + below + ')'));
  }
  return X.el('label', { class: 'bm-planner-limit', title: 'Rare items are filled affix by affix from the Crafting tab’s modifiers: resistances capped, attribute requirements met, then whatever helps most' },
    X.el('span', { class: 'bm-list-label' }, 'Rare gear'),
    X.el('select', { onchange: event => { P.gearLevel = event.target.value; saveChoices(); X.rerender(); } }, options));
}

function startSection() {
  const count = limitCount(P.limits);
  const size = searchSize(P.index, P.limits, P.wide);
  const running = P.job && !P.job.finished;
  const enough = count >= MIN_LIMITS;
  let note;
  if (!enough) {
    note = 'Choose ' + (MIN_LIMITS - count) + ' more limit' + (MIN_LIMITS - count === 1 ? '' : 's') + ' to start (an ascendancy counts as two: it names the class too; a weapon and its weapon type count once).';
  } else if (size.pairs === 0) {
    note = 'Nothing fits these limits' + (P.wide ? '.' : '; the wide search also tries skills that only reach them through conversion or an ailment.');
  } else {
    note = X.plural(size.variants.length, 'skill variant') + ' × ' + size.ascendancies.length + (size.ascendancies.length === 1 ? ' ascendancy' : ' ascendancies') + ' = ' + size.pairs.toLocaleString() + ' quick plans.';
  }
  const startButton = X.el('button', { type: 'button', class: 'primary', disabled: !enough || size.pairs === 0 || running, onclick: () => startJob(size) }, 'Plan builds');
  const stopButton = running ? X.el('button', { type: 'button', class: 'ghost', onclick: stopJob }, 'Stop') : null;
  return X.el('div', { class: 'bm-planner-start' }, startButton, stopButton, X.el('span', { class: 'muted' }, ' ', note));
}

function resultsSection() {
  const job = P.job;
  if (!job) {
    return null;
  }
  const nodes = [X.el('p', { class: 'muted', id: 'bm-planner-progress' }, progressText(job))];
  if (job.error) {
    nodes.push(X.el('p', { class: 'empty' }, 'The planner failed: ' + job.error));
  }
  if (job.anyPriced) {
    nodes.push(planSwitch());
  }
  const cards = [];
  const showingValue = ideaPlan() === 'value';
  for (const card of job.cards) {
    const sections = [stagesBlock(card), agentsBlock(card), tagsBlock(card)];
    if (showingValue && card.value && !card.value.sameAsPower) {
      sections.unshift(X.el('p', { class: 'muted bm-planner-tags' }, 'The stages and agents below describe the power plan; the value plan above swapped uniques for cheaper ones.'));
    }
    cards.push(ideaCard(card, 'bm-planned', sections));
  }
  if (job.finished && job.cards.length === 0 && !job.error) {
    nodes.push(X.el('p', { class: 'empty' }, 'No build kept these limits (a damage type needs a quarter of the finished build\'s damage).'));
  }
  return X.el('section', { class: 'bm-results', 'aria-label': 'Planned builds' },
    X.el('h3', {}, job.finished ? X.plural(job.cards.length, 'planned build') : 'Planning…'), nodes,
    X.el('div', { class: 'bm-cards' }, cards));
}

function progressText(job) {
  const seconds = Math.round(((job.finishedAt || Date.now()) - job.started) / 1000);
  if (job.stopped) {
    return 'Stopped after ' + seconds + ' s.';
  }
  if (job.phase === 'quick') {
    return 'Quick pass: ' + job.quickDone.toLocaleString() + ' of ' + job.quickTotal.toLocaleString() + ' plans (' + seconds + ' s, ' + X.plural(job.workerCount, 'worker') + ')…';
  }
  if (!job.finished) {
    return 'Full plans with tree and stage agents: ' + job.fullDone + ' of ' + job.fullTotal + ' (' + seconds + ' s)…';
  }
  return 'Planned ' + job.quickDone.toLocaleString() + ' quick plans and ' + job.fullTotal + ' full plans in ' + seconds + ' s.';
}

function planSwitch() {
  const current = ideaPlan();
  const buttons = [];
  for (const choice of [{ id: 'power', label: 'Power plan', title: 'Pieces chosen by the stages alone; prices never weighed' },
    { id: 'value', label: 'Value plan', title: 'Uniques chosen for their gain over their poe.ninja price' }]) {
    const on = current === choice.id;
    buttons.push(X.el('button', { type: 'button', class: 'bm-band-toggle' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', title: choice.title, onclick: () => chooseIdeaPlan(choice.id) }, choice.label));
  }
  return X.el('div', { class: 'bm-bands', role: 'group', 'aria-label': 'Which plan the cards show' }, buttons);
}

// Each stage's value on the finished build, and how the agents moved it.
function stagesBlock(card) {
  const items = [];
  for (const stage of STAGES) {
    const value = card.stages[stage.id];
    const before = card.stagesBefore?.[stage.id];
    const moved = before ? value / before : 1;
    const change = Math.abs(moved - 1) >= 0.005 ? ' (' + signedPercent(moved) + ')' : '';
    items.push(X.el('li', { title: stage.title + (card.weights[stage.id] > 0 ? '' : '; weight 0, so it only watches') },
      stage.label + ' ' + stageText(stage.id, value, card) + change));
  }
  return X.el('div', { class: 'bm-list' }, X.el('span', { class: 'bm-list-label' }, 'Stages'), X.el('ul', {}, items));
}

function stageText(stageId, value, card) {
  if (stageId === 'ehp') {
    return value.toFixed(1) + '× (max hit ' + Math.round(card.maxHit / 100) * 100 + ', +' + card.recovery.toLocaleString() + '/s)';
  }
  if (stageId === 'rarity') {
    return '+' + card.itemRarity + '% rarity' + (card.itemQuantity ? ', +' + card.itemQuantity + '% quantity' : '');
  }
  if (stageId === 'speed') {
    return '+' + card.movementSpeed + '% movement';
  }
  return value.toFixed(value >= 10 ? 0 : 2) + '×';
}

function signedPercent(ratio) {
  const percent = Math.round((ratio - 1) * 100);
  return (percent >= 0 ? '+' : '') + percent + '%';
}

const FIELD_WORDS = { supports: 'support', notables: 'ascendancy notable', uniques: 'unique', buffs: 'aura or curse', flasks: 'flask' };

// The agents' accepted swaps, in order.
function agentsBlock(card) {
  if (!card.negotiation || card.negotiation.length === 0) {
    return X.el('div', { class: 'bm-list' }, X.el('span', { class: 'bm-list-label' }, 'Agents'), X.el('ul', {}, X.el('li', { class: 'muted' }, 'no swap raised the total')));
  }
  const items = [];
  for (const entry of card.negotiation) {
    const stage = STAGES.find(candidate => candidate.id === entry.agent);
    const what = swapText(entry);
    const effects = [];
    for (const other of STAGES) {
      const ratio = entry.changes[other.id];
      if (Math.abs(ratio - 1) >= 0.005) {
        effects.push(other.label.toLowerCase() + ' ' + signedPercent(ratio));
      }
    }
    items.push(X.el('li', {}, X.el('strong', {}, stage ? stage.label : entry.agent), ': ', what, effects.length ? X.el('span', { class: 'muted' }, ' (' + effects.join(', ') + ')') : null));
  }
  return X.el('div', { class: 'bm-list', title: 'Swaps the stage agents agreed on, in order' }, X.el('span', { class: 'bm-list-label' }, 'Agents'), X.el('ul', {}, items));
}

function swapText(entry) {
  const word = FIELD_WORDS[entry.field] || entry.field;
  const removed = entry.removed ? entry.removed.replace(/ Support$/, '') : null;
  const added = entry.added ? entry.added.replace(/ Support$/, '') : null;
  if (removed && added) {
    return added + ' for ' + removed;
  }
  if (added) {
    return added + ' (' + word + ' added)';
  }
  return removed + ' dropped';
}

function tagsBlock(card) {
  if (!card.tagsSkipped) {
    return null;
  }
  if (card.wide) {
    return X.el('p', { class: 'muted bm-planner-tags' }, 'Wide search: nothing was skipped by tags.');
  }
  const parts = [];
  for (const entry of card.tagsSkipped) {
    if (entry.skipped > 0) {
      parts.push(entry.skipped.toLocaleString() + ' of ' + (entry.kept + entry.skipped).toLocaleString() + ' ' + entry.kind);
    }
  }
  return X.el('p', { class: 'muted bm-planner-tags', title: 'Pieces none of whose effects could reach this build, so the planner never measured them' },
    'Skipped by tags: ' + parts.join(', ') + '.');
}

// ---------- running a search ----------
function workerCount() {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}

function ensureWorkers(count) {
  while (P.workers.length < count) {
    P.workers.push({ worker: new Worker('build-worker.js', { type: 'module' }), busy: false });
  }
}

function stopWorkers() {
  for (const entry of P.workers) {
    entry.worker.terminate();
  }
  P.workers = [];
}

// The unique prices the buildmaker loaded, for the value plan, or null when there are none.
function pricesForWorkers() {
  const prices = X.prices?.();
  const divineChaos = X.divineChaos?.();
  if (!prices || prices.size === 0 || !divineChaos) {
    return null;
  }
  const chaosByName = {};
  for (const [name, entry] of prices) {
    chaosByName[name] = entry.chaos;
  }
  return { chaosByName, divineChaos, key: prices.size + '|' + divineChaos };
}

function startJob(size) {
  stopWorkers();
  const count = workerCount();
  ensureWorkers(count);
  jobCounter += 1;
  const limits = { ...P.limits };
  const job = {
    id: jobCounter, limits, wide: P.wide, weights: { ...P.weights }, tolerance: P.tolerance, gearLevel: P.gearLevel,
    variants: new Map(size.variants.map(variant => [variant.key, variant])),
    ascendancies: size.ascendancies.map(ascendancy => ascendancy.name),
    queue: [], phase: 'quick', quickResults: [], quickDone: 0, quickTotal: size.pairs, partialDone: new Map(),
    fullDone: 0, fullTotal: 0, cards: [], started: Date.now(), finished: false, stopped: false, error: null,
    workerCount: count, prices: pricesForWorkers(), anyPriced: false, inFlight: 0,
  };
  for (const variant of size.variants) {
    job.queue.push({ type: 'quick', variant, ascendancies: job.ascendancies, limits, weights: job.weights, wide: job.wide });
  }
  P.job = job;
  for (const entry of P.workers) {
    feedWorker(job, entry);
  }
  X.rerender();
}

function stopJob() {
  const job = P.job;
  if (!job) {
    return;
  }
  job.stopped = true;
  job.finished = true;
  job.finishedAt = Date.now();
  stopWorkers();
  X.rerender();
}

let taskCounter = 0;
function feedWorker(job, entry) {
  if (job.finished || P.job !== job) {
    return;
  }
  const task = job.queue.shift();
  if (!task) {
    entry.busy = false;
    maybeNextPhase(job);
    return;
  }
  taskCounter += 1;
  const taskId = taskCounter;
  entry.busy = true;
  job.inFlight += 1;
  entry.worker.onmessage = event => onWorkerMessage(job, entry, task, taskId, event.data);
  entry.worker.onerror = event => {
    job.inFlight -= 1;
    job.error = event.message || 'a planner worker crashed';
    feedWorker(job, entry);
    scheduleRedraw();
  };
  entry.worker.postMessage({ id: taskId, task });
}

function onWorkerMessage(job, entry, task, taskId, data) {
  if (data.id !== taskId || P.job !== job) {
    return;
  }
  if (data.progress) {
    job.partialDone.set(taskId, data.progress.done);
    updateQuickDone(job);
    scheduleRedraw();
    return;
  }
  job.inFlight -= 1;
  job.partialDone.delete(taskId);
  if (data.error) {
    job.error = data.error;
  } else if (task.type === 'quick') {
    job.quickResults.push(...data.result);
    job.finishedQuick = (job.finishedQuick || 0) + task.ascendancies.length;
  } else if (data.result) {
    addCard(job, data.result);
  }
  if (task.type === 'full') {
    job.fullDone += 1;
  }
  updateQuickDone(job);
  feedWorker(job, entry);
  scheduleRedraw();
}

function updateQuickDone(job) {
  let partial = 0;
  for (const done of job.partialDone.values()) {
    partial += done;
  }
  job.quickDone = Math.min(job.quickTotal, (job.finishedQuick || 0) + (job.phase === 'quick' ? partial : 0));
}

// When the quick pass is done, the best few get full plans; when those are done, the search is.
function maybeNextPhase(job) {
  if (job.queue.length > 0 || job.inFlight > 0 || job.finished) {
    return;
  }
  if (job.phase === 'quick') {
    job.phase = 'full';
    const chosen = chooseForFullPlans(job.quickResults, FULL_PLANS);
    job.fullTotal = chosen.length;
    for (const pick of chosen) {
      job.queue.push({ type: 'full', variant: job.variants.get(pick.variantKey), ascendancy: pick.ascendancy, limits: job.limits,
        weights: job.weights, tolerance: job.tolerance, wide: job.wide, gearLevel: job.gearLevel, prices: job.prices });
    }
    if (chosen.length > 0) {
      for (const entry of P.workers) {
        if (!entry.busy) {
          feedWorker(job, entry);
        }
      }
      return;
    }
  }
  job.finished = true;
  job.finishedAt = Date.now();
  scheduleRedraw();
}

// A finished full plan as a card: poe.ninja's player count for its pairing, and the planner's settings so its
// "why" plans the same tree.
function addCard(job, result) {
  const verdict = verifyBuild(result.ascendancy, result.skill, X.populations?.() || {});
  const card = {
    ...result, planned: true, weights: job.weights, wide: job.wide, variantKey: result.variant.key,
    ailment: result.variant.ailment || null, players: verdict.players, band: verdict.band.id, pastPlayers: 0,
    leagueUrl: X.leagueUrl?.() || '',
  };
  // The card's score is the planner's total, so the value plan's "share of full power" compares like with like.
  card.score = result.total;
  if (result.value) {
    card.value = { ...result.value, score: result.value.total };
    job.anyPriced = true;
  }
  job.cards.push(card);
  job.cards.sort((first, second) => second.total - first.total || first.ascendancy.localeCompare(second.ascendancy) || first.skill.localeCompare(second.skill));
}

function scheduleRedraw() {
  if (P.redrawTimer !== null) {
    return;
  }
  P.redrawTimer = setTimeout(() => {
    P.redrawTimer = null;
    if (P.job && !P.job.finished) {
      const line = typeof document !== 'undefined' ? document.getElementById('bm-planner-progress') : null;
      if (line && P.job.phase === 'quick') {
        line.textContent = progressText(P.job); // the quick pass only moves the progress line
        return;
      }
    }
    X.rerender();
  }, REDRAW_MILLISECONDS);
}
