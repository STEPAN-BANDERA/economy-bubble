// The build planner's stages: single-target damage, area damage, item rarity, effective HP and speed. Each stage
// is an agent with its own measure of a build. They are weighed into one score, and then take turns proposing one
// change each (swap a support, a unique, an aura...). A change goes through only when the total score rises and
// every earlier stage keeps nearly all it had: a later stage consults the earlier ones before it trades their value
// for its own. That is how the plan settles on its ratio of attack to defence.
//
// The stage weights are the planner's choice of what matters. Their defaults (single target 0.5, area 0.15, EHP 0.5,
// rarity and speed 0) are the power score's own weights, so with them the total is the power score exactly
// (evaluateBuild in buildgen.js): calibration still measures the same thing. Prices never enter a stage; the value
// plan divides the total by the price penalty afterwards, as it divides the power score.
import { evaluateBuild, moveCandidates, POWER_SCORE_WEIGHTS } from './buildgen.js';

// In the order the agents take turns, which is also the order of who consults whom: area consults single target,
// EHP consults both damage stages and rarity, speed consults all.
export const STAGES = [
  { id: 'singleTarget', label: 'Single target', title: 'How far the pieces scale the bare skill against one enemy (the offence index)' },
  { id: 'aoe', label: 'Area', title: 'Clear: area, projectiles, chains and pierce (the clear index)' },
  { id: 'rarity', label: 'Rarity', title: 'Increased rarity and quantity of items found' },
  { id: 'ehp', label: 'EHP', title: 'Effective HP against a pinnacle boss hit: the largest hit taken plus a second of recovery (the defence index)' },
  { id: 'speed', label: 'Speed', title: 'Movement speed, flasks included at their uptime' },
];

export const DEFAULT_WEIGHTS = {
  singleTarget: POWER_SCORE_WEIGHTS.offence,
  aoe: POWER_SCORE_WEIGHTS.clear,
  rarity: 0,
  ehp: POWER_SCORE_WEIGHTS.defence,
  speed: 0,
};

// How much of its value an earlier stage lets a later one take, our estimate of a trade players accept: 5% of the
// damage for much more defence is a good deal, a third of it isn't.
export const DEFAULT_TOLERANCE = 0.05;
// A change has to raise the total by this much to be worth making (the composer's own threshold is 1.5%; the
// agents fine-tune, so they take smaller steps).
const MIN_TOTAL_GAIN = 0.005;
// The agents stop when a whole round changes nothing, or after this many rounds.
const MAX_ROUNDS = 6;

// A stage's value for an evaluated build: always positive, 1 meaning "nothing", so weights are exponents.
export function stageValue(stageId, evaluation) {
  if (stageId === 'singleTarget') {
    return evaluation.scaling;
  }
  if (stageId === 'aoe') {
    return evaluation.clear;
  }
  if (stageId === 'rarity') {
    // Quantity brings more items, rarity better ones; both multiply what a map gives.
    return Math.max(0.1, 1 + evaluation.itemRarity / 100) * Math.max(0.1, 1 + evaluation.itemQuantity / 100);
  }
  if (stageId === 'ehp') {
    return evaluation.defence;
  }
  if (stageId === 'speed') {
    return Math.max(0.1, 1 + evaluation.movementSpeed / 100);
  }
  throw new Error('unknown stage ' + stageId);
}

export function stageValues(evaluation) {
  const values = {};
  for (const stage of STAGES) {
    values[stage.id] = stageValue(stage.id, evaluation);
  }
  return values;
}

// The weighted total. With DEFAULT_WEIGHTS it equals evaluation.score bit for bit: the factors are multiplied in the
// power score's order (offence, defence, clear), and a weight of 0 multiplies by exactly 1.
export function totalOf(evaluation, weights) {
  if (evaluation.problems.length > 0) {
    return 0;
  }
  const values = stageValues(evaluation);
  let total = Math.pow(values.singleTarget, weights.singleTarget) * Math.pow(values.ehp, weights.ehp)
    * Math.pow(values.aoe, weights.aoe);
  total = total * Math.pow(values.speed, weights.speed);
  total = total * Math.pow(values.rarity, weights.rarity);
  return total * evaluation.attributes;
}

// The score function the planner composes with (planSkill, composeForAscendancy, finalizeTree take it as scoreOf).
export function scoreFunctionFor(weights) {
  return build => totalOf(evaluateBuild(build), weights);
}

export function weightsAreDefault(weights) {
  for (const stage of STAGES) {
    if (weights[stage.id] !== DEFAULT_WEIGHTS[stage.id]) {
      return false;
    }
  }
  return true;
}

// Stages with no weight don't take turns: nobody asked for them.
function activeStages(weights) {
  const active = [];
  for (const stage of STAGES) {
    if (weights[stage.id] > 0) {
      active.push(stage);
    }
  }
  return active;
}

// The agents' rounds. Returns the improved build, its evaluation, the stage values before and after, and a log of
// each accepted change: which agent proposed it and what it did to every stage.
// options: weights, tolerance, uniques (the unique candidates), locked (supports that can't move), index.
export function negotiate(build, options) {
  const weights = options.weights;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const agents = activeStages(weights);
  let current = build;
  let currentEvaluation = evaluateBuild(current);
  const startValues = stageValues(currentEvaluation);
  const log = [];
  let evaluatedMoves = null;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    let changedThisRound = false;
    for (let agentPosition = 0; agentPosition < agents.length; agentPosition += 1) {
      if (evaluatedMoves === null) {
        evaluatedMoves = evaluateMoves(current, options);
      }
      const earlier = agents.slice(0, agentPosition);
      const proposal = bestProposal(agents[agentPosition], earlier, current, currentEvaluation, evaluatedMoves, startValues, weights, tolerance);
      if (proposal === null) {
        continue;
      }
      log.push(logEntry(round, agents[agentPosition], proposal, currentEvaluation));
      current = proposal.move.build;
      currentEvaluation = proposal.evaluation;
      evaluatedMoves = null;
      changedThisRound = true;
    }
    if (!changedThisRound) {
      break;
    }
  }
  return { build: current, evaluation: currentEvaluation, before: startValues, after: stageValues(currentEvaluation), log };
}

function evaluateMoves(build, options) {
  const evaluated = [];
  for (const move of moveCandidates(build, options.index, { uniques: options.uniques || [] }, options.locked || [])) {
    evaluated.push({ move, evaluation: evaluateBuild(move.build) });
  }
  return evaluated;
}

// The change that helps this agent's stage most, among those that raise the total and that every earlier stage
// accepts (it keeps at least 1 - tolerance of its value when the rounds began). null when there is none.
function bestProposal(agent, earlier, current, currentEvaluation, evaluatedMoves, startValues, weights, tolerance) {
  const currentTotal = totalOf(currentEvaluation, weights);
  const currentValue = stageValue(agent.id, currentEvaluation);
  let best = null;
  let bestGain = 1;
  let bestTotal = 0;
  for (const entry of evaluatedMoves) {
    const total = totalOf(entry.evaluation, weights);
    if (!(total > currentTotal * (1 + MIN_TOTAL_GAIN))) {
      continue;
    }
    if (!earlierStagesAccept(earlier, entry.evaluation, startValues, tolerance)) {
      continue;
    }
    const gain = stageValue(agent.id, entry.evaluation) / currentValue;
    if (gain > bestGain || (gain === bestGain && best !== null && total > bestTotal)) {
      best = entry;
      bestGain = gain;
      bestTotal = total;
    }
  }
  return best;
}

function earlierStagesAccept(earlier, evaluation, startValues, tolerance) {
  for (const stage of earlier) {
    if (stageValue(stage.id, evaluation) < startValues[stage.id] * (1 - tolerance)) {
      return false;
    }
  }
  return true;
}

// What a change did, for the card's "how the stages agreed" list: each stage's value after over before.
function logEntry(round, agent, proposal, previousEvaluation) {
  const changes = {};
  for (const stage of STAGES) {
    changes[stage.id] = stageValue(stage.id, proposal.evaluation) / stageValue(stage.id, previousEvaluation);
  }
  return { round, agent: agent.id, field: proposal.move.field, removed: proposal.move.removed, added: proposal.move.added, changes };
}
