// Revisiting a build's gear: a character is geared bit by bit, and what is worth buying changes with the economy.
// For one build (a Build maker card, rebuilt with its planned tree) this answers three questions with today's prices:
//   slotOptions:     what can go in one slot within a budget: uniques that fit it, and rare items at each gear level
//                    (each rare is priced by the Crafting tab's planner on the page, public/rareprice.js);
//   jewelOptions:    which unique jewel gains the most for its price;
//   setComparison:   every rare slot swapped for its best unique under a price cap, against the rares as they are.
// When a unique takes a rare item's slot, the rares left are solved again (public/buildgear.js), so the resistances
// and attributes that rare carried are made up elsewhere, as a player would. Scores are the build's own score
// function (the card's stage weights); prices are poe.ninja's (attachPrices), in Divines.
import { gearEngineFor, canAddUnique, grantsMainSkill, UNPRICED_UNIQUE_DIVINES } from './buildgen.js';
import { solveGear, solveFreedSlots, compactGear, GEAR_LEVELS } from './buildgear.js';

// The slots a revisit offers, as the gear solver names them.
export const REVISIT_SLOTS = ['body', 'helmet', 'gloves', 'boots', 'belt', 'amulet', 'ring', 'offhand', 'quiver'];
// Candidates scored in full (with the rares solved again) after a quick ranking without that: solving the gear takes
// a while, and a unique that ranks low without it doesn't climb to the top with it.
const FULL_CHECKS = 8;
// The cheap-unique set tries this many uniques a slot with the gear solved again (a slot at a time, so fewer).
const SET_FULL_CHECKS = 3;
// Uniques for the jewel sockets. Abyss jewels need an abyssal socket the generator doesn't plan.
const JEWEL_CATEGORY = 'Jewel';

// ---------- prices ----------
// A unique's price in Divines: poe.ninja's, UNPRICED_UNIQUE_DIVINES when it lists none, null without any prices.
export function uniquePriceOf(unique) {
  if (unique.price === undefined) {
    return null;
  }
  if (unique.price === null) {
    return UNPRICED_UNIQUE_DIVINES;
  }
  return unique.price;
}

function withinBudget(unique, budget) {
  const price = uniquePriceOf(unique);
  if (price === null) {
    return budget === null;
  }
  return budget === null || price <= budget;
}

// ---------- slots ----------
// The gear solver's slot for a unique: its own, except that a quiver and a shield share the off hand.
function revisitSlotOf(unique) {
  if (unique.category === 'Quiver') {
    return 'quiver';
  }
  return unique.slot;
}

// The engine's slot names for a revisit slot: a quiver is an off-hand unique.
function engineSlotOf(slot) {
  return slot === 'quiver' ? 'offhand' : slot;
}

function rareItemsIn(build, slot) {
  const items = [];
  for (const item of build.gear?.items || []) {
    if (item.slot === slot) {
      items.push(item);
    }
  }
  return items;
}

function uniquesIn(build, slot) {
  const uniques = [];
  for (const unique of build.uniques) {
    if (revisitSlotOf(unique) === slot) {
      uniques.push(unique);
    }
  }
  return uniques;
}

// The slots this build has something in: a rare item or a unique (weapons and flasks aren't revisited).
export function slotsOf(build) {
  const slots = [];
  for (const slot of REVISIT_SLOTS) {
    if (rareItemsIn(build, slot).length > 0 || uniquesIn(build, slot).length > 0) {
      slots.push(slot);
    }
  }
  return slots;
}

// ---------- trials ----------
function withoutUnique(build, unique) {
  return { ...build, uniques: build.uniques.filter(other => other !== unique) };
}

// The build with one rare item of the slot taken out (the first; for rings either is the same kind of item).
function withoutRareIn(build, slot) {
  if (!build.gear) {
    return build;
  }
  const items = [...build.gear.items];
  const position = items.findIndex(item => item.slot === slot);
  if (position < 0) {
    return build;
  }
  items.splice(position, 1);
  return { ...build, gear: { ...build.gear, items } };
}

// The attribute stats an affix can give (as the gear solver reads them, buildgear.js coverage).
const ATTRIBUTE_STATS = new Set(['attributes', 'strength', 'dexterity', 'intelligence']);

function coversNeeds(affix) {
  for (const effect of affix.effects || []) {
    if (effect.kind === 'resistance' && effect.stat === 'resistance' && !effect.condition) {
      return true;
    }
    if (effect.kind === 'flat' && ATTRIBUTE_STATS.has(effect.stat)) {
      return true;
    }
  }
  return false;
}

// For the quick ranking: the displaced rare keeps only its resistances and attributes, as a stand-in for what the
// other rares make up once solved again. Without it every unique that takes a resistance rare's slot leaves the build
// uncapped and scores nothing, so the ranking said nothing.
function withNeedsKeptFor(build, slot) {
  const item = rareItemsIn(build, slot)[0];
  if (!item) {
    return build;
  }
  const standIn = { ...item, slot: 'standIn', prefixes: item.prefixes.filter(coversNeeds), suffixes: item.suffixes.filter(coversNeeds),
    implicits: (item.implicits || []).filter(coversNeeds) };
  const taken = withoutRareIn(build, slot);
  return { ...taken, gear: { ...taken.gear, items: [...taken.gear.items, standIn] } };
}

// The build without the stand-in, for the full re-solve.
function withoutStandIn(build) {
  if (!build.gear) {
    return build;
  }
  return { ...build, gear: { ...build.gear, items: build.gear.items.filter(item => item.slot !== 'standIn') } };
}

// The ways a unique can go into its slot: added when there is room (taking a rare item's place), or in place of
// a unique already there. A unique that gives the build its main skill stays. Each way is a build whose gear still
// has to be solved again (regear).
function placementsOf(build, unique) {
  const slot = revisitSlotOf(unique);
  const placements = [];
  if (canAddUnique(build, unique)) {
    const rareTaken = withNeedsKeptFor(build, slot);
    placements.push({ build: { ...rareTaken, uniques: [...rareTaken.uniques, unique] }, replaces: rareTaken === build ? null : 'rare' });
    return placements;
  }
  for (const occupant of uniquesIn(build, slot)) {
    if (grantsMainSkill(build, occupant)) {
      continue;
    }
    const without = withoutUnique(build, occupant);
    if (canAddUnique(without, unique)) {
      placements.push({ build: { ...without, uniques: [...without.uniques, unique] }, replaces: occupant.name });
    }
  }
  return placements;
}

// The rare items solved again around the build's uniques, at the gear level they had.
function regear(build, index, scoreOf) {
  if (!build.gear || !index.gear) {
    return withoutStandIn(build);
  }
  return solveGear({ ...build, gear: undefined }, index.gear, gearEngineFor(scoreOf), build.gear.level);
}

// A unique's best placement: each scored quickly (the rares as they are, less the one it displaced), then the best
// few in full. Returns [{ unique, replaces, quickScore, build }] sorted by the quick score.
function quickPlacements(build, uniques, scoreOf) {
  const ranked = [];
  for (const unique of uniques) {
    let best = null;
    for (const placement of placementsOf(build, unique)) {
      const quickScore = scoreOf(placement.build);
      if (best === null || quickScore > best.quickScore) {
        best = { unique, replaces: placement.replaces, quickScore, build: placement.build };
      }
    }
    if (best !== null) {
      ranked.push(best);
    }
  }
  ranked.sort((first, second) => second.quickScore - first.quickScore);
  return ranked;
}

// A unique's placement with the rares solved again where it took a rare's place: { build, score }.
function solvedPlacement(entry, index, scoreOf) {
  const solved = entry.replaces === null || entry.replaces === 'rare' ? regear(entry.build, index, scoreOf) : entry.build;
  return { build: solved, score: scoreOf(solved) };
}

function uniqueOption(entry, build, index, scoreOf, baseScore) {
  const { score } = solvedPlacement(entry, index, scoreOf);
  return {
    kind: 'unique', name: entry.unique.name, replaces: entry.replaces, score, change: score / baseScore - 1,
    price: uniquePriceOf(entry.unique), listed: entry.unique.price !== null && entry.unique.price !== undefined,
  };
}

// A rare item for the slot at a gear level, in place of what is there now: the slot's item is solved again at that
// level (solveFreedSlots), the build's other rares as they are. Its compact form is what the Crafting planner prices.
function rareOption(build, slot, levelName, index, scoreOf, baseScore) {
  const solved = solvedRare(build, slot, levelName, index, scoreOf);
  if (solved === null) {
    return null;
  }
  return { kind: 'rare', name: GEAR_LEVELS[levelName].label + ' rare', level: levelName, replaces: solved.replaces,
    score: solved.score, change: solved.score / baseScore - 1, item: solved.item, price: null };
}

// The build with the slot's item solved again as a rare at a gear level: { build, score, replaces, item } or null.
function solvedRare(build, slot, levelName, index, scoreOf) {
  let trial = build;
  let replaces = null;
  const occupants = uniquesIn(build, slot);
  if (rareItemsIn(build, slot).length > 0) {
    trial = withoutRareIn(trial, slot);
    replaces = 'rare';
  } else if (occupants.length > 0) {
    const occupant = occupants.find(unique => !grantsMainSkill(build, unique));
    if (!occupant) {
      return null;
    }
    trial = withoutUnique(trial, occupant);
    replaces = occupant.name;
  } else {
    return null;
  }
  const level = trial.gear ? trial.gear.level : levelName;
  const atLevel = { ...trial, gear: { level: levelName, items: trial.gear ? trial.gear.items : [] } };
  const solved = solveFreedSlots(atLevel, index.gear, gearEngineFor(scoreOf));
  const keptItems = new Set(atLevel.gear.items);
  const newItem = (solved.gear?.items || []).find(item => item.slot === slot && !keptItems.has(item));
  if (!newItem) {
    return null;
  }
  const solvedBuild = { ...solved, gear: { ...solved.gear, level } };
  const score = scoreOf(solvedBuild);
  const compact = compactGear({ level: levelName, items: [newItem] }).items[0];
  return { build: solvedBuild, score, replaces, item: compact };
}

// ---------- the three questions ----------
// What can go in one slot within a budget (Divines; null for any price): the uniques that fit it, best first, and a
// rare item at each gear level. options.scoreOf: the build's score function. Returns { slot, current, options }.
export function slotOptions(build, index, slot, budget, options) {
  const scoreOf = options.scoreOf;
  const baseScore = scoreOf(build);
  const engineSlot = engineSlotOf(slot);
  const candidates = [];
  for (const unique of index.uniques) {
    if (unique.slot !== engineSlot || revisitSlotOf(unique) !== slot) {
      continue;
    }
    if (build.uniques.some(chosen => chosen.name === unique.name) || !withinBudget(unique, budget)) {
      continue;
    }
    candidates.push(unique);
  }
  const results = [];
  for (const entry of quickPlacements(build, candidates, scoreOf).slice(0, FULL_CHECKS)) {
    results.push(uniqueOption(entry, build, index, scoreOf, baseScore));
  }
  if (index.gear) {
    for (const levelName of Object.keys(GEAR_LEVELS)) {
      const option = rareOption(build, slot, levelName, index, scoreOf, baseScore);
      if (option !== null) {
        results.push(option);
      }
    }
  }
  results.sort((first, second) => second.score - first.score);
  return { slot, current: currentOf(build, slot), score: baseScore, options: results };
}

// What the slot holds now, in words the page shows: the uniques' names and the rare items' affix count.
function currentOf(build, slot) {
  const current = [];
  for (const unique of uniquesIn(build, slot)) {
    current.push({ kind: 'unique', name: unique.name, price: uniquePriceOf(unique) });
  }
  for (const item of rareItemsIn(build, slot)) {
    current.push({ kind: 'rare', name: GEAR_LEVELS[build.gear.level].label + ' rare', item: compactGear({ level: build.gear.level, items: [item] }).items[0] });
  }
  return current;
}

// Which unique jewel gains the most: each one the build hasn't got, in a free jewel socket or in place of a unique
// jewel it has (two, SLOT_COUNT in buildgen.js), within the budget. Jewels that work on the passives in their radius
// aren't among index.uniques: the tree planner places them (public/buildradius.js).
export function jewelOptions(build, index, budget, options) {
  const scoreOf = options.scoreOf;
  const baseScore = scoreOf(build);
  const candidates = [];
  for (const unique of index.uniques) {
    if (unique.category !== JEWEL_CATEGORY || build.uniques.some(chosen => chosen.name === unique.name)) {
      continue;
    }
    if (!withinBudget(unique, budget)) {
      continue;
    }
    candidates.push(unique);
  }
  const results = [];
  for (const entry of quickPlacements(build, candidates, scoreOf)) {
    if (entry.quickScore <= baseScore) {
      break;
    }
    results.push({ kind: 'unique', name: entry.unique.name, replaces: entry.replaces, score: entry.quickScore,
      change: entry.quickScore / baseScore - 1, price: uniquePriceOf(entry.unique),
      listed: entry.unique.price !== null && entry.unique.price !== undefined });
  }
  return { score: baseScore, options: results.slice(0, FULL_CHECKS * 2) };
}

// Every rare slot in turn given the unique that scores best there at no more than priceCap Divines each (a slot
// with none keeps its rare), then the rares left solved again: the build "on cheap uniques" against the build as
// it is. Returns each slot's pair and both sides' scores; the rares' crafting cost comes from the page.
export function setComparison(build, index, priceCap, options) {
  const scoreOf = options.scoreOf;
  const baseScore = scoreOf(build);
  const slots = [];
  let trial = build;
  const rareSlots = (build.gear?.items || []).map(item => item.slot);
  for (const slot of rareSlots) {
    const rareItem = rareItemsIn(trial, slot)[0];
    if (!rareItem) {
      continue;
    }
    const engineSlot = engineSlotOf(slot);
    const candidates = index.uniques.filter(unique => unique.slot === engineSlot && revisitSlotOf(unique) === slot
      && !trial.uniques.some(chosen => chosen.name === unique.name) && unique.price !== null && unique.price !== undefined
      && unique.price <= priceCap);
    const placed = quickPlacements(trial, candidates, scoreOf).filter(entry => entry.replaces === 'rare');
    const rare = compactGear({ level: build.gear.level, items: [rareItem] }).items[0];
    // The best few, each with the rares left solved again: the swap is taken only where the build still works
    // (resistances capped, attributes met), which a cheap unique in every slot can't always manage.
    let chosen = null;
    for (const entry of placed.slice(0, SET_FULL_CHECKS)) {
      const solved = regear(entry.build, index, scoreOf);
      const score = scoreOf(solved);
      if (score > 0 && (chosen === null || score > chosen.score)) {
        chosen = { entry, solved, score };
      }
    }
    if (chosen === null) {
      slots.push({ slot, rare, unique: null, reason: placed.length === 0 ? 'none' : 'breaks' });
      continue;
    }
    trial = chosen.solved;
    slots.push({ slot, rare, unique: { name: chosen.entry.unique.name, price: uniquePriceOf(chosen.entry.unique) } });
  }
  const swappedScore = scoreOf(trial);
  let uniquesCost = 0;
  for (const entry of slots) {
    if (entry.unique) {
      uniquesCost += entry.unique.price;
    }
  }
  return { score: baseScore, swappedScore, change: swappedScore / baseScore - 1, priceCap, slots, uniquesCost };
}

// ---------- the planner's gear rounds ----------
// After the build planner's agents settle (public/buildsearch.js, settle), its gear is revisited the way the panel
// above revisits a card: each slot in turn, every unique that fits it (price-blind: this is the power plan) with the
// rares left solved again, and a rare item at the build's gear level in place of a unique. The agents only swap
// uniques from the skill's shortlist and never solve the rares again, so a unique the set made worth it, or a rare
// that now beats a unique, went unseen. The best change of a slot is taken when it raises the score by at least
// GEAR_ROUND_MIN_GAIN and options.accept(build) agrees (the planner's limits and stage tolerance); the rounds stop
// when one changes nothing, or after GEAR_ROUNDS.
export const GEAR_ROUNDS = 3;
const GEAR_ROUND_MIN_GAIN = 0.005; // the agents' own threshold (MIN_TOTAL_GAIN in public/buildstages.js)
// Placements per slot scored in full after the quick ranking: the best one only. Solving the rares again is nearly all
// of the rounds' time; on four test plans (2026-11-23) three a slot took a full plan from 1.5 to 3.7 times as long,
// and one gave the same totals (one higher) at 1.3 to 1.7 times.
const GEAR_ROUND_FULL_CHECKS = 1;
// The jewel sockets, revisited like a slot (unique jewels only; the tree plans the rare ones).
const JEWEL_SLOT = 'jewel';

// options: scoreOf (the planner's stage total), accept (build -> whether the planner keeps it; defaults to yes),
// rounds. Returns { build, log }, the log one entry per change: { round, slot, added, removed, change }.
export function improveGear(build, index, options) {
  const scoreOf = options.scoreOf;
  const accept = options.accept || (() => true);
  const rounds = options.rounds ?? GEAR_ROUNDS;
  let current = build;
  let currentScore = scoreOf(current);
  const log = [];
  for (let round = 1; round <= rounds; round += 1) {
    let changedThisRound = false;
    for (const slot of [...slotsOf(current), JEWEL_SLOT]) {
      const best = bestChangeIn(current, index, slot, scoreOf, currentScore, accept);
      if (best === null) {
        continue;
      }
      log.push({ round, slot, added: best.added, removed: best.removed, change: best.score / currentScore - 1 });
      current = best.build;
      currentScore = best.score;
      changedThisRound = true;
    }
    if (!changedThisRound) {
      break;
    }
  }
  return { build: current, log };
}

// The best accepted change for one slot, or null: { build, score, added, removed }.
function bestChangeIn(build, index, slot, scoreOf, currentScore, accept) {
  const wanted = currentScore * (1 + GEAR_ROUND_MIN_GAIN);
  let best = null;
  for (const candidate of slotCandidates(build, index, slot, scoreOf)) {
    if (!(candidate.score > wanted) || (best !== null && candidate.score <= best.score)) {
      continue;
    }
    if (!accept(candidate.build)) {
      continue;
    }
    best = candidate;
  }
  return best;
}

// Every change worth scoring in full for a slot: the best few unique placements, and a rare at the gear level. Solving
// the rares again is what takes the time, so a placement is solved only when its quick score (the displaced rare's
// resistances and attributes kept) already beats the build: one that loses before the rares are solved rarely wins
// after, and checking every one tripled a full plan's time.
function slotCandidates(build, index, slot, scoreOf) {
  const candidates = [];
  const currentScore = scoreOf(build);
  for (const entry of quickPlacements(build, uniquesForSlot(build, index, slot), scoreOf).slice(0, GEAR_ROUND_FULL_CHECKS)) {
    if (!(entry.quickScore > currentScore)) {
      break; // sorted best first
    }
    const solved = slot === JEWEL_SLOT ? { build: entry.build, score: entry.quickScore } : solvedPlacement(entry, index, scoreOf);
    candidates.push({ build: solved.build, score: solved.score, added: entry.unique.name,
      removed: entry.replaces === null ? null : (entry.replaces === 'rare' ? 'rare ' + slot : entry.replaces) });
  }
  if (slot !== JEWEL_SLOT && index.gear && build.gear && uniquesIn(build, slot).length > 0) {
    const rare = solvedRare(build, slot, build.gear.level, index, scoreOf);
    if (rare !== null) {
      candidates.push({ build: rare.build, score: rare.score, added: 'rare ' + slot, removed: rare.replaces });
    }
  }
  return candidates;
}

// The uniques the build hasn't got that go in this slot (or a jewel socket), whatever they cost.
function uniquesForSlot(build, index, slot) {
  const uniques = [];
  for (const unique of index.uniques) {
    if (build.uniques.some(chosen => chosen.name === unique.name)) {
      continue;
    }
    if (slot === JEWEL_SLOT) {
      if (unique.category === JEWEL_CATEGORY) {
        uniques.push(unique);
      }
      continue;
    }
    if (unique.slot === engineSlotOf(slot) && revisitSlotOf(unique) === slot) {
      uniques.push(unique);
    }
  }
  return uniques;
}
