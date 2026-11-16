// The "Revisit gear" panel on a Build maker card (public/buildideas.js): a character is geared bit by bit, so this
// asks the card's build three questions with today's prices (public/buildrevisit.js does the work, in the build
// worker): what to put in one slot for a budget, which unique jewel to socket, and whether cheap uniques in every
// rare slot are worth as much as the rares. Rares are priced by the Crafting tab's planner (public/rareprice.js),
// half a minute or more each, so their prices fill in as they come.
import { REVISIT_SLOTS } from './buildrevisit.js';
import { GEAR_SLOT_WORDS } from './buildgear.js';
import { rarePrice, rarePricesPending, useRarePriceHelpers } from './rareprice.js';

const SLOT_WORDS = GEAR_SLOT_WORDS;
const QUESTIONS = [
  { id: 'slot', label: 'Upgrade a slot', title: 'What fits one slot for a budget: uniques, and rares at each gear level' },
  { id: 'jewels', label: 'Unique jewels', title: 'Which unique jewel gains the most for its price' },
  { id: 'set', label: 'Uniques vs rares', title: 'Every rare slot on its best cheap unique, against the rares as they are' },
];
const DEFAULT_SLOT_BUDGET = 1; // Divines
const DEFAULT_JEWEL_BUDGET = 5; // Divines
const DEFAULT_SET_CAP_CHAOS = 5; // "cheap": a unique at most this many Chaos Orbs

let X = null; // helpers from buildmaker.js (el, rerender, store, prices, divineChaos, economy)
const V = new Map(); // card key -> the panel's state

function stateOf(key) {
  if (!V.has(key)) {
    V.set(key, { question: 'slot', slot: null, budget: DEFAULT_SLOT_BUDGET, jewelBudget: DEFAULT_JEWEL_BUDGET,
      capChaos: DEFAULT_SET_CAP_CHAOS, answers: new Map(), asking: null, error: null });
  }
  return V.get(key);
}

// The slots this card can revisit: the armour pieces, belt, amulet, rings, and the off hand its weapon carries.
function slotsOfIdea(idea) {
  const slots = [];
  for (const slot of REVISIT_SLOTS) {
    if (slot === 'offhand' && idea.weapon !== 'shield') {
      continue;
    }
    if (slot === 'quiver' && idea.weapon !== 'bow') {
      continue;
    }
    slots.push(slot);
  }
  return slots;
}

// The unique prices for the worker (as the build planner sends them), or null when poe.ninja's haven't loaded.
function pricesForWorker() {
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

function questionKey(state) {
  if (state.question === 'slot') {
    return 'slot|' + state.slot + '|' + state.budget;
  }
  if (state.question === 'jewels') {
    return 'jewels|' + state.jewelBudget;
  }
  return 'set|' + state.capChaos;
}

function questionOf(state) {
  if (state.question === 'slot') {
    return { kind: 'slot', slot: state.slot, budget: state.budget };
  }
  if (state.question === 'jewels') {
    return { kind: 'jewels', budget: state.jewelBudget };
  }
  const divineChaos = X.divineChaos?.() || null;
  return { kind: 'set', priceCap: divineChaos ? state.capChaos / divineChaos : 0 };
}

// card: { key, idea, plannedTree } once the card's build is rebuilt; ask(task) -> Promise of the worker's answer.
function askQuestion(state, card, ask) {
  const asked = questionKey(state);
  state.asking = asked;
  state.error = null;
  X.rerender();
  const task = { type: 'revisit', idea: card.idea, weights: card.idea.planned ? card.idea.weights || null : null,
    wide: Boolean(card.idea.planned && card.idea.wide), plannedTree: card.plannedTree, prices: pricesForWorker(),
    question: questionOf(state) };
  ask(task).then(answer => {
    state.answers.set(asked, answer);
    if (state.asking === asked) {
      state.asking = null;
    }
    X.rerender();
  }, error => {
    state.error = String(error?.message ?? error);
    state.asking = null;
    X.rerender();
  });
}

// ---------- money ----------
function divineChaos() {
  return X.divineChaos?.() || null;
}

function divinesText(divines) {
  if (divines === null || divines === undefined) {
    return '–';
  }
  const rate = divineChaos();
  if (rate && divines * rate < rate / 2) {
    return Math.max(1, Math.round(divines * rate)) + 'c';
  }
  return (divines < 10 ? divines.toFixed(1) : Math.round(divines)) + ' div';
}

function chaosText(chaos) {
  const rate = divineChaos();
  if (rate && chaos >= rate / 2) {
    return divinesText(chaos / rate);
  }
  return Math.round(chaos) + 'c';
}

// A rare item's craft price, in words, and in Divines when known.
function rareCost(item) {
  const price = rarePrice(item);
  if (price.status === 'ready') {
    const rate = divineChaos();
    return { text: chaosText(price.chaos), divines: rate ? price.chaos / rate : null, title: 'Cheapest plan: ' + price.plan };
  }
  if (price.status === 'failed') {
    return { text: 'no price', divines: null, title: price.error || '' };
  }
  return { text: price.status === 'pricing' ? 'pricing…' : 'queued', divines: null, title: 'The Crafting tab\'s planner is working out the cheapest craft' };
}

function changeText(change) {
  const percent = change * 100;
  if (Math.abs(percent) < 0.05) {
    return '±0%';
  }
  return (percent > 0 ? '+' : '') + percent.toFixed(1) + '%';
}

function changeClass(change) {
  if (change > 0.0005) {
    return 'bm-revisit-up';
  }
  if (change < -0.0005) {
    return 'bm-revisit-down';
  }
  return 'muted';
}

// ---------- the panel ----------
export function revisitSection(helpers, card, ask) {
  X = helpers;
  useRarePriceHelpers(helpers);
  const state = stateOf(card.key);
  if (state.slot === null) {
    state.slot = slotsOfIdea(card.idea)[0];
  }
  const buttons = [];
  for (const question of QUESTIONS) {
    const on = state.question === question.id;
    buttons.push(X.el('button', { type: 'button', class: 'bm-band-toggle' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false',
      title: question.title, onclick: () => { state.question = question.id; X.rerender(); } }, question.label));
  }
  const pricesMissing = pricesForWorker() === null
    ? X.el('p', { class: 'muted' }, 'poe.ninja\'s unique prices haven\'t loaded, so uniques can\'t be weighed against a budget yet.')
    : null;
  const asked = questionKey(state);
  const answer = state.answers.get(asked);
  let body = null;
  if (state.error) {
    body = X.el('p', { class: 'muted' }, 'The revisit failed: ' + state.error);
  } else if (state.asking === asked) {
    body = X.el('p', { class: 'working', role: 'status' }, 'Trying the pieces, with the rare gear solved again for each… (a few seconds)');
  } else if (answer === null) {
    body = X.el('p', { class: 'muted' }, 'This build names a piece the current game data no longer has; rebuild the data.');
  } else if (answer) {
    body = answerView(state, answer);
  }
  return X.el('div', { class: 'bm-revisit' },
    X.el('p', { class: 'muted' }, 'What to change with today\'s prices. Uniques at poe.ninja\'s price; rares at what the Crafting tab\'s planner says the cheapest craft costs (worked out one item at a time, half a minute or more each). Scores are this card\'s.'),
    X.el('div', { class: 'bm-bands', role: 'group', 'aria-label': 'Revisit question' }, buttons),
    questionForm(state, card, ask),
    pricesMissing,
    body,
    pendingLine());
}

function pendingLine() {
  const pending = rarePricesPending();
  if (pending === 0) {
    return null;
  }
  return X.el('p', { class: 'working', role: 'status' }, 'Pricing ' + pending + ' rare ' + (pending === 1 ? 'item' : 'items') + ' with the crafting planner…');
}

function numberInput(label, value, step, onValue) {
  return X.el('label', { class: 'inline' }, label + ' ',
    X.el('input', { type: 'number', min: 0, step, value, class: 'bm-revisit-number',
      onchange: event => { const parsed = Number(event.target.value); onValue(isFinite(parsed) && parsed >= 0 ? parsed : 0); } }));
}

function questionForm(state, card, ask) {
  const fields = [];
  if (state.question === 'slot') {
    const options = [];
    for (const slot of slotsOfIdea(card.idea)) {
      options.push(X.el('option', { value: slot, selected: slot === state.slot }, SLOT_WORDS[slot]));
    }
    fields.push(X.el('label', { class: 'inline' }, 'Slot ', X.el('select', { onchange: event => { state.slot = event.target.value; X.rerender(); } }, options)));
    fields.push(numberInput('budget (div)', state.budget, 0.1, value => { state.budget = value; X.rerender(); }));
  } else if (state.question === 'jewels') {
    fields.push(numberInput('budget (div)', state.jewelBudget, 0.5, value => { state.jewelBudget = value; X.rerender(); }));
  } else {
    fields.push(numberInput('a unique at most (chaos)', state.capChaos, 1, value => { state.capChaos = value; X.rerender(); }));
  }
  fields.push(X.el('button', { type: 'button', disabled: state.asking !== null, onclick: () => askQuestion(state, card, ask) }, 'Check'));
  return X.el('div', { class: 'bm-revisit-form' }, fields);
}

function answerView(state, answer) {
  if (state.question === 'slot') {
    return slotAnswer(answer);
  }
  if (state.question === 'jewels') {
    return jewelAnswer(answer);
  }
  return setAnswer(answer);
}

// Score gained per Divine spent, when both are known and the change is a gain.
function perDivineText(change, divines) {
  if (!(change > 0) || divines === null || !(divines > 0)) {
    return '';
  }
  return (change * 100 / divines).toFixed(1) + '% per div';
}

function optionRow(option) {
  let cost;
  if (option.kind === 'rare') {
    cost = rareCost(option.item);
  } else {
    cost = { text: option.listed ? divinesText(option.price) : 'not listed', divines: option.listed ? option.price : null,
      title: option.listed ? 'poe.ninja' : 'poe.ninja lists no price; counted at 20 Divines' };
  }
  const replaces = option.replaces && option.replaces !== 'rare' ? ' (in place of ' + option.replaces + ')' : '';
  return X.el('tr', {},
    X.el('td', {}, X.el('strong', {}, option.name), X.el('span', { class: 'muted' }, replaces)),
    X.el('td', { class: changeClass(option.change) }, changeText(option.change)),
    X.el('td', { title: cost.title }, cost.text),
    X.el('td', { class: 'muted' }, perDivineText(option.change, cost.divines)));
}

function table(rows, headings) {
  const head = [];
  for (const heading of headings) {
    head.push(X.el('th', {}, heading));
  }
  return X.el('table', { class: 'bm-revisit-table' }, X.el('thead', {}, X.el('tr', {}, head)), X.el('tbody', {}, rows));
}

function slotAnswer(answer) {
  const now = [];
  for (const piece of answer.current) {
    if (piece.kind === 'rare') {
      const cost = rareCost(piece.item);
      now.push(piece.name + ' (craft ' + cost.text + ')');
    } else {
      now.push(piece.name + ' (' + divinesText(piece.price) + ')');
    }
  }
  const rows = [];
  for (const option of answer.options) {
    rows.push(optionRow(option));
  }
  if (rows.length === 0) {
    return X.el('p', { class: 'muted' }, 'Nothing fits this slot within the budget.');
  }
  return X.el('div', {},
    X.el('p', {}, SLOT_WORDS[answer.slot] + ' now: ' + (now.join(', ') || 'nothing')),
    table(rows, ['Instead', 'Score', 'Cost', 'Value']),
    X.el('p', { class: 'muted' }, 'A unique that takes a rare\'s place has the other rares solved again, so their resistances and attributes are made up elsewhere. A rare at a gear level is that slot solved again on its own, the other items as they are.'));
}

function jewelAnswer(answer) {
  if (answer.options.length === 0) {
    return X.el('p', { class: 'muted' }, 'No unique jewel within the budget adds to this build.');
  }
  const rows = [];
  for (const option of answer.options) {
    rows.push(optionRow(option));
  }
  return X.el('div', {},
    table(rows, ['Jewel', 'Score', 'Cost', 'Value']),
    X.el('p', { class: 'muted' }, 'In any free jewel socket (the build has room for two unique jewels). Jewels that change the passives in their radius count only their own lines, so they are underrated here.'));
}

function setAnswer(answer) {
  const swapped = answer.slots.filter(entry => entry.unique !== null);
  const rows = [];
  let raresChaos = 0;
  let raresPriced = 0;
  for (const entry of answer.slots) {
    // Only the rares a unique would replace are priced: each takes the planner a while.
    let asItIs = 'rare, kept';
    let title = '';
    if (entry.unique) {
      const cost = rareCost(entry.rare);
      const price = rarePrice(entry.rare);
      if (price.status === 'ready') {
        raresChaos += price.chaos;
        raresPriced += 1;
      }
      asItIs = 'rare, craft ' + cost.text;
      title = cost.title;
    }
    rows.push(X.el('tr', {},
      X.el('td', {}, SLOT_WORDS[entry.slot] || entry.slot),
      X.el('td', { title }, asItIs),
      X.el('td', {}, entry.unique ? entry.unique.name + ' (' + divinesText(entry.unique.price) + ')' : X.el('span', { class: 'muted' }, entry.reason === 'breaks' ? 'keeps the rare: no unique this cheap leaves resistances and attributes met' : 'keeps the rare: no unique this cheap fits'))));
  }
  const note = X.el('p', { class: 'muted' }, 'Each slot takes the unique that scores best there, in turn; the rares left are then solved again. Ask "Upgrade a slot" to weigh one slot on its own.');
  if (swapped.length === 0) {
    return X.el('div', {}, table(rows, ['Slot', 'As it is', 'On a cheap unique']),
      X.el('p', {}, 'No unique at or under this price takes a rare item\'s place here' + (pricesForWorker() === null ? ' (no unique prices loaded).' : '.')), note);
  }
  const raresText = raresPriced === swapped.length
    ? chaosText(raresChaos)
    : raresPriced + ' of ' + swapped.length + ' priced so far' + (raresPriced > 0 ? ' (' + chaosText(raresChaos) + ')' : '');
  return X.el('div', {},
    table(rows, ['Slot', 'As it is', 'On a cheap unique']),
    X.el('p', {},
      'With ' + swapped.length + (swapped.length === 1 ? ' unique' : ' uniques') + ' the build scores ', X.el('strong', { class: changeClass(answer.change) }, changeText(answer.change)),
      ' against its rares. The uniques cost ', X.el('strong', {}, divinesText(answer.uniquesCost)),
      '; the rares they replace cost ', X.el('strong', {}, raresText), ' to craft.'),
    note);
}
