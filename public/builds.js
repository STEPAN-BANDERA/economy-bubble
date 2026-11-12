// Build maker engine: turns poe.ninja's archetypes (public/data/builds/meta-poe1-*.json, from
// scripts/fetch_build_meta.py) and the game knowledge (game-poe1.json, from scripts/build_game_data.py)
// into a chain of questions, the archetypes each answer leaves, a ranking, and the spin wheel's niche picks.
// Pure functions with no page access, so it runs in Node too (scripts/test_builds.mjs).
//
// An archetype is an ascendancy plus a main skill, as poe.ninja pairs them. Its traits are read from what its
// players actually run where poe.ninja measured it (damage split, hit or damage over time, life and energy
// shield), and from the skill's tags where it didn't.

// ---------- what each trait means, in numbers ----------
// A damage type counts when it's at least this share of the skill's DPS (median over the top characters).
const DAMAGE_TYPE_FLOOR_PERCENT = 25;
// poe.ninja marks each character's main skill as a hit or damage over time; the majority decides.
const HIT_SHARE_FOR_HIT = 0.5;
// Energy shield's share of life + energy shield: from 70% it's an energy shield build (CI, low life, Eldritch
// Battery), under 30% a life build, and in between a hybrid.
const ENERGY_SHIELD_POOL_SHARE = 0.7;
const LIFE_POOL_SHARE = 0.3;
// A defence layer counts when the sampled characters' median reaches it: roughly where each one starts to
// carry a build at endgame (capped suppression, a block build's 50%+, a dedicated armour or evasion stack).
const LAYER_THRESHOLDS = { armour: 20000, evasion: 20000, suppression: 90, block: 50 };
// Budget bands from the share-weighted price of the uniques an archetype's players wear, in Divines.
const CHEAP_DIVINES = 5;
const MID_DIVINES = 30;
// Past leagues where the same ascendancy and skill was played add weight: proven builds rank higher.
const PROVEN_LEAGUE_BONUS = 0.25;
// The spin wheel's niche: outside the most played, but with enough finished characters to call it playable.
const NICHE_OUTSIDE_TOP = 20;
const PLAYABLE_LEVEL_MEDIAN = 95;
const PLAYABLE_EHP_MEDIAN = 40000;
const PLAYABLE_CHARACTERS = 40;
const WHEEL_SLOTS = 12;

export const PLAYSTYLE_LABELS = {
  spell: 'Self-cast spells',
  'attack-melee': 'Melee attacks',
  'attack-bow': 'Bow attacks',
  'attack-projectile': 'Other ranged attacks',
  'attack-other': 'Other attacks',
  totem: 'Totems',
  mine: 'Mines',
  trap: 'Traps',
  brand: 'Brands',
  minion: 'Minions',
  trigger: 'Triggered skills',
};
const DAMAGE_TYPE_LABELS = { physical: 'Physical', fire: 'Fire', cold: 'Cold', lightning: 'Lightning', chaos: 'Chaos' };
const HIT_OR_DOT_LABELS = { hit: 'Hits', dot: 'Damage over time' };
const POOL_LABELS = { life: 'Life', hybrid: 'Life and energy shield', es: 'Energy shield' };
const LAYER_LABELS = { armour: 'Armour', evasion: 'Evasion', suppression: 'Spell suppression', block: 'Block', none: 'None of these stands out' };
const BUDGET_LABELS = { cheap: `Cheap (under ${CHEAP_DIVINES} Divines of uniques)`, mid: `Medium (${CHEAP_DIVINES}–${MID_DIVINES} Divines)`, expensive: `Expensive (over ${MID_DIVINES} Divines)`, unpriced: 'Not priced yet' };

// ---------- the questions, in the order they're asked ----------
// Each question reads one trait; valuesOf returns a list because an archetype can deal two damage types or
// stack two defence layers, and it then matches either answer.
export const QUESTIONS = [
  { id: 'class', label: 'Which class?', valuesOf: archetype => [archetype.baseClass], labelOf: value => value },
  { id: 'ascendancy', label: 'Which ascendancy?', valuesOf: archetype => [archetype.ascendancy], labelOf: value => value },
  { id: 'damage', label: 'Which damage type?', valuesOf: archetype => archetype.traits.damageTypes, labelOf: value => DAMAGE_TYPE_LABELS[value] ?? value },
  { id: 'hitdot', label: 'Hits or damage over time?', valuesOf: archetype => [archetype.traits.hitOrDot], labelOf: value => HIT_OR_DOT_LABELS[value] ?? value },
  { id: 'playstyle', label: 'How do you want to deal it?', valuesOf: archetype => [archetype.traits.playstyle], labelOf: value => PLAYSTYLE_LABELS[value] ?? value },
  { id: 'pool', label: 'Life or energy shield?', valuesOf: archetype => [archetype.traits.pool], labelOf: value => POOL_LABELS[value] ?? value },
  { id: 'layer', label: 'Which defence do you want to lean on?', valuesOf: archetype => archetype.traits.layers, labelOf: value => LAYER_LABELS[value] ?? value },
  { id: 'budget', label: 'What budget?', valuesOf: archetype => [archetype.traits.budget], labelOf: value => BUDGET_LABELS[value] ?? value },
];

export function questionById(questionId) {
  for (const question of QUESTIONS) {
    if (question.id === questionId) {
      return question;
    }
  }
  return null;
}

// ---------- archetypes from the data files ----------
function archetypeId(ascendancy, skill) {
  return ascendancy + ' / ' + skill;
}

function damageTypesOf(record, skill) {
  const types = [];
  const split = record.damageSplit ?? {};
  for (const [damageType, percent] of Object.entries(split)) {
    if (percent >= DAMAGE_TYPE_FLOOR_PERCENT) {
      types.push(damageType);
    }
  }
  if (types.length > 0) {
    return types.sort();
  }
  // poe.ninja had no damage numbers (minions often): fall back to the skill's tags.
  return [...(skill?.damageTypes ?? [])].sort();
}

function hitOrDotOf(record, skill) {
  if (record.hitShare != null) {
    if (record.hitShare >= HIT_SHARE_FOR_HIT) {
      return 'hit';
    }
    return 'dot';
  }
  return skill?.hitOrDotGuess ?? 'hit';
}

function playstyleOf(skill) {
  if (!skill) {
    return 'spell';
  }
  if (skill.delivery === 'attack') {
    return 'attack-' + (skill.weapon ?? 'other');
  }
  return skill.delivery;
}

// The questions a generated build (public/buildgen.js) can answer: it has a class, ascendancy and skill but no
// players' medians, so pool, defence layer and budget don't apply to it.
export const IDEA_QUESTION_IDS = ['class', 'ascendancy', 'damage', 'hitdot', 'playstyle'];

// Traits of one of the generator's own builds, so the same questions filter it. A support can change how it is
// delivered (Spell Totem makes a spell a totem build), so the skill types its supports add are passed in.
export function ideaTraits(gameSkill, addedTypes) {
  let playstyle = playstyleOf(gameSkill);
  if (addedTypes.has('SummonsTotem')) {
    playstyle = 'totem';
  } else if (addedTypes.has('Trapped')) {
    playstyle = 'trap';
  } else if (addedTypes.has('RemoteMined')) {
    playstyle = 'mine';
  }
  return {
    damageTypes: [...(gameSkill?.damageTypes ?? [])].sort(),
    hitOrDot: gameSkill?.hitOrDotGuess ?? 'hit',
    playstyle, pool: null, layers: [], budget: null,
  };
}

function poolOf(record) {
  const life = record.lifeMedian ?? 0;
  const energyShield = record.energyShieldMedian ?? 0;
  if (life + energyShield <= 0) {
    return 'life';
  }
  const energyShieldShare = energyShield / (life + energyShield);
  if (energyShieldShare >= ENERGY_SHIELD_POOL_SHARE) {
    return 'es';
  }
  if (energyShieldShare <= LIFE_POOL_SHARE) {
    return 'life';
  }
  return 'hybrid';
}

function layersOf(record) {
  const defences = record.defences;
  if (!defences || !defences.sampled) {
    return ['none'];
  }
  const layers = [];
  if ((defences.armour ?? 0) >= LAYER_THRESHOLDS.armour) {
    layers.push('armour');
  }
  if ((defences.evasionRating ?? 0) >= LAYER_THRESHOLDS.evasion) {
    layers.push('evasion');
  }
  if ((defences.spellSuppressionChance ?? 0) >= LAYER_THRESHOLDS.suppression) {
    layers.push('suppression');
  }
  if ((defences.blockChance ?? 0) >= LAYER_THRESHOLDS.block) {
    layers.push('block');
  }
  if (layers.length === 0) {
    layers.push('none');
  }
  return layers;
}

// Which past leagues had the same ascendancy and skill with enough players to be listed.
function provenLeaguesOf(ascendancy, skill, pastMetas) {
  const leagues = [];
  for (const meta of pastMetas) {
    for (const record of meta.archetypes) {
      if (record.ascendancy === ascendancy && record.skill === skill) {
        leagues.push(meta.league);
        break;
      }
    }
  }
  return leagues;
}

// Only archetypes poe.ninja was asked about in detail are offered: the others have a population but no
// damage, defence or item figures, so most questions couldn't place them.
export function buildArchetypes(game, currentMeta, pastMetas) {
  const archetypes = [];
  let rank = 0;
  for (const record of currentMeta.archetypes) {
    rank += 1;
    if (record.levelMedian == null) {
      continue;
    }
    const skill = game.skills[record.skill];
    archetypes.push({
      ...record,
      id: archetypeId(record.ascendancy, record.skill),
      rank,
      skillInfo: skill ?? null,
      provenLeagues: provenLeaguesOf(record.ascendancy, record.skill, pastMetas),
      traits: {
        damageTypes: damageTypesOf(record, skill),
        hitOrDot: hitOrDotOf(record, skill),
        playstyle: playstyleOf(skill),
        pool: poolOf(record),
        layers: layersOf(record),
        budget: 'unpriced',
      },
      cost: null,
    });
  }
  return archetypes;
}

// ---------- prices ----------
// Expected spend on uniques: each unique's price times the share of the archetype's players wearing it. A
// build that every player runs with Mageblood costs a Mageblood; one where a third do costs a third of one.
export function priceArchetypes(archetypes, chaosPriceOf, divineChaos) {
  for (const archetype of archetypes) {
    let costChaos = 0;
    let pricedUniques = 0;
    let unpricedUniques = 0;
    for (const [uniqueName, share] of archetype.uniques ?? []) {
      const chaos = chaosPriceOf(uniqueName);
      if (chaos == null) {
        unpricedUniques += 1;
        continue;
      }
      pricedUniques += 1;
      costChaos += chaos * share;
    }
    if (pricedUniques === 0 && unpricedUniques > 0) {
      archetype.cost = null;
      archetype.traits.budget = 'unpriced';
      continue;
    }
    archetype.cost = { chaos: costChaos, divines: divineChaos ? costChaos / divineChaos : null, pricedUniques, unpricedUniques };
    archetype.traits.budget = budgetBandOf(archetype.cost.divines);
  }
}

function budgetBandOf(divines) {
  if (divines == null) {
    return 'unpriced';
  }
  if (divines < CHEAP_DIVINES) {
    return 'cheap';
  }
  if (divines < MID_DIVINES) {
    return 'mid';
  }
  return 'expensive';
}

// ---------- answering ----------
export function matchesAnswer(archetype, questionId, answer) {
  const question = questionById(questionId);
  if (!question) {
    return true;
  }
  return question.valuesOf(archetype).includes(answer);
}

export function remainingArchetypes(archetypes, answers, skipQuestionId = null) {
  const remaining = [];
  for (const archetype of archetypes) {
    let keep = true;
    for (const [questionId, answer] of Object.entries(answers)) {
      if (questionId === skipQuestionId || answer == null) {
        continue;
      }
      if (!matchesAnswer(archetype, questionId, answer)) {
        keep = false;
        break;
      }
    }
    if (keep) {
      remaining.push(archetype);
    }
  }
  return remaining;
}

// The first question not answered yet, or null when every one is.
export function nextQuestion(answers) {
  for (const question of QUESTIONS) {
    if (answers[question.id] == null) {
      return question;
    }
  }
  return null;
}

// One question's options given the other answers: every value any archetype has, with how many archetypes
// and players each would leave. Values that would leave none stay listed (shown disabled), so a viewer sees
// what their earlier answers ruled out.
export function optionsFor(questionId, archetypes, answers) {
  const question = questionById(questionId);
  const everyValue = new Set();
  for (const archetype of archetypes) {
    for (const value of question.valuesOf(archetype)) {
      everyValue.add(value);
    }
  }
  const candidates = remainingArchetypes(archetypes, answers, questionId);
  const byValue = new Map();
  for (const value of everyValue) {
    byValue.set(value, { value, label: question.labelOf(value), archetypes: 0, characters: 0 });
  }
  for (const archetype of candidates) {
    for (const value of new Set(question.valuesOf(archetype))) {
      const option = byValue.get(value);
      option.archetypes += 1;
      option.characters += archetype.characters;
    }
  }
  const options = [...byValue.values()];
  options.sort(compareOptions);
  return options;
}

function compareOptions(first, second) {
  if (second.characters !== first.characters) {
    return second.characters - first.characters;
  }
  return first.label.localeCompare(second.label);
}

// Answers that no longer fit are dropped from the end of the chain: changing the class clears an ascendancy
// of another class, but keeps "Cold" if a cold build of the new class exists.
export function consistentAnswers(archetypes, answers) {
  const kept = {};
  for (const question of QUESTIONS) {
    const answer = answers[question.id];
    if (answer == null) {
      continue;
    }
    const withThis = { ...kept, [question.id]: answer };
    if (remainingArchetypes(archetypes, withThis).length > 0) {
      kept[question.id] = answer;
    }
  }
  return kept;
}

// ---------- ranking ----------
export function scoreOf(archetype) {
  return archetype.shareOfLeague * (1 + PROVEN_LEAGUE_BONUS * archetype.provenLeagues.length);
}

export function rankArchetypes(archetypes) {
  const ranked = [...archetypes];
  ranked.sort((first, second) => {
    const difference = scoreOf(second) - scoreOf(first);
    if (difference !== 0) {
      return difference;
    }
    return first.id.localeCompare(second.id);
  });
  return ranked;
}

// ---------- the spin wheel ----------
export function isNicheButPlayable(archetype) {
  if (archetype.rank <= NICHE_OUTSIDE_TOP) {
    return false;
  }
  if (archetype.characters < PLAYABLE_CHARACTERS) {
    return false;
  }
  if ((archetype.levelMedian ?? 0) < PLAYABLE_LEVEL_MEDIAN) {
    return false;
  }
  return (archetype.ehpMedian ?? 0) >= PLAYABLE_EHP_MEDIAN;
}

// Up to twelve niche archetypes that fit the answers so far, shuffled, and which one the wheel lands on.
// randomNumber returns [0, 1) and is passed in, so a seeded one (mulberry32) gives the same spin every time.
// With no niche archetype left it falls back to every remaining one, and says so.
export function spinWheel(archetypes, answers, randomNumber) {
  const remaining = remainingArchetypes(archetypes, answers);
  const niche = [];
  for (const archetype of remaining) {
    if (isNicheButPlayable(archetype)) {
      niche.push(archetype);
    }
  }
  const nicheOnly = niche.length > 0;
  const pool = nicheOnly ? niche : remaining;
  if (pool.length === 0) {
    return { candidates: [], winnerIndex: -1, nicheOnly: false };
  }
  const shuffled = shuffle(pool, randomNumber);
  const candidates = shuffled.slice(0, WHEEL_SLOTS);
  const winnerIndex = Math.floor(randomNumber() * candidates.length);
  return { candidates, winnerIndex, nicheOnly };
}

function shuffle(items, randomNumber) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(randomNumber() * (index + 1));
    const held = shuffled[index];
    shuffled[index] = shuffled[swapWith];
    shuffled[swapWith] = held;
  }
  return shuffled;
}

// The same small seeded generator as mulberry32 in public/craft.js (copied, so this module doesn't load the
// whole crafting engine); scripts/test_builds.mjs checks the two give the same numbers.
export function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- the chain in a link ----------
// "class:Witch,ascendancy:Elementalist,damage:cold" — answers in question order, so a shared link reads the
// same way the chain does.
export function encodeAnswers(answers) {
  const parts = [];
  for (const question of QUESTIONS) {
    const answer = answers[question.id];
    if (answer != null) {
      parts.push(question.id + ':' + encodeURIComponent(answer));
    }
  }
  return parts.join(',');
}

export function decodeAnswers(text) {
  const answers = {};
  if (!text) {
    return answers;
  }
  for (const part of text.split(',')) {
    const separator = part.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const questionId = part.slice(0, separator);
    if (!questionById(questionId)) {
      continue;
    }
    try {
      answers[questionId] = decodeURIComponent(part.slice(separator + 1));
    } catch {
      // A hand-edited link with a broken escape drops that answer only.
    }
  }
  return answers;
}
