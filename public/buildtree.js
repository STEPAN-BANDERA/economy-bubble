// The Build maker's passive tree planner: from a class's start node, it allocates the tree a build would take,
// within a point budget, valuing every node by what it does for that build. Pure functions over
// public/data/builds/tree-poe1.json (scripts/build_mechanics.py), run in Node and the browser.
//
// The method is the usual one for tree optimisers: repeatedly take the target (a notable, a keystone or a small
// node) with the best value per point, counting the small nodes on the path to it, until the budget is spent or
// nothing left is worth a point. A node's value is what the build's score gains from its effects, measured with
// the generator's own scoring (public/buildgen.js), so a tree follows the skill: a cold spell build reaches for cold
// and spell clusters, a minion build for minion wheels.
//
// Speed: effects are grouped by everything except their number ("10% increased Spell Damage" and "12% increased
// Spell Damage" are one group), each group's gain is measured once and scaled by the number, and the gains are
// measured again only every few allocations. Keystones change rules rather than numbers, so each is scored exactly.
//
// Masteries: a mastery costs one point once a notable of its cluster is taken, and offers a choice of effects (each
// effect once per tree). Each mastery is a target too, reached through its nearest unlocking notable, so a notable
// that unlocks a strong mastery is worth the pair. Its options are scored exactly, like keystones, but only those
// that can change the score at all.
//
// Jewel sockets: a socket is a target worth what goes in it (options.jewels): the build's rare jewel, or, in an
// outer socket, a large cluster jewel, which also costs the points spent inside it. Both are scored exactly.

const REFRESH_EVERY_POINTS = 10; // measure the gains again after this many points
const SEARCH_DEPTH = 14; // the farthest a single step reaches for a target
const MIN_GAIN_PER_POINT = 0.0004; // below this, a point isn't worth spending
const STALE_ESTIMATE_SHARE = 0.7; // a step really worth under 70% of its estimate means the estimates are stale

export function prepareTree(data) {
  const nodes = new Map();
  for (const [id, node] of Object.entries(data.nodes)) {
    nodes.set(id, {
      id, name: node.n || '', kind: KIND_NAMES[node.t] || 'small', effects: node.e || [], neighbours: node.l || [],
      largeCluster: Boolean(node.c),
      // Where it is drawn (public/buildtreeview.js): x, y, its group and its orbit.
      position: node.p ? { x: node.p[0], y: node.p[1], group: node.p[2], orbit: node.p[3] } : null,
    });
  }
  return { budget: data.budget, starts: data.starts, nodes, masteries: prepareMasteries(data),
    groups: data.groups || {}, orbitRadii: data.orbitRadii || [] };
}

function prepareMasteries(data) {
  const masteries = [];
  const optionsOfType = data.masteryOptions || {};
  for (const [id, mastery] of Object.entries(data.masteries || {})) {
    const options = [];
    for (const option of optionsOfType[mastery.n] || []) {
      options.push({ id: option.i, text: option.s, effects: option.e });
    }
    if (options.length > 0) {
      masteries.push({ id, name: mastery.n, unlockedBy: mastery.on, options, position: mastery.p ? { x: mastery.p[0], y: mastery.p[1] } : null });
    }
  }
  return masteries;
}

const KIND_NAMES = { s: 'small', n: 'notable', k: 'keystone', j: 'jewel', c: 'start' };

// ---------- effects, grouped ----------
function groupKey(effect) {
  return [effect.kind, effect.stat, (effect.tags || []).join('+'), effect.subject || '', effect.condition || '',
    (effect.requires || []).join('+'), effect.skill || '', (effect.from || []).join('+')].join('|');
}

// The allocated nodes' effects merged by group, values summed: the tree as one piece of the build.
export function mergeEffects(effectLists) {
  const merged = new Map();
  for (const effects of effectLists) {
    for (const effect of effects) {
      if (effect.kind === 'flag' || effect.value === undefined || effect.value === null) {
        merged.set(groupKey(effect) + '|' + merged.size, effect);
        continue;
      }
      const key = groupKey(effect);
      const existing = merged.get(key);
      if (existing) {
        merged.set(key, { ...existing, value: existing.value + effect.value });
      } else {
        merged.set(key, { ...effect });
      }
    }
  }
  return [...merged.values()];
}

// ---------- the search ----------
// Shortest paths from every allocated node at once (the tree's edges all cost one point).
function pathsFrom(tree, allocated, forbidden) {
  const parent = new Map();
  const distance = new Map();
  let frontier = [];
  for (const id of allocated) {
    distance.set(id, 0);
    frontier.push(id);
  }
  for (let depth = 1; depth <= SEARCH_DEPTH && frontier.length > 0; depth += 1) {
    const next = [];
    for (const id of frontier) {
      for (const neighbour of tree.nodes.get(id).neighbours) {
        if (distance.has(neighbour)) {
          continue;
        }
        const node = tree.nodes.get(neighbour);
        if (!node || node.kind === 'start') {
          continue; // another class's start can't be walked through
        }
        if (forbidden.has(neighbour)) {
          continue;
        }
        distance.set(neighbour, depth);
        parent.set(neighbour, id);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return { distance, parent };
}

function pathTo(target, parent, allocated) {
  const path = [];
  let current = target;
  while (current !== undefined && !allocated.has(current)) {
    path.push(current);
    current = parent.get(current);
  }
  return path;
}

// Gains of the effect groups and keystones reachable now, measured against the build as it stands.
function measureGains(tree, reachable, evaluateWith, effectMatters, baseScore) {
  const groupGain = new Map();
  const keystoneGain = new Map();
  for (const id of reachable) {
    const node = tree.nodes.get(id);
    if (node.kind === 'keystone') {
      if (!keystoneGain.has(id)) {
        const score = evaluateWith(node.effects);
        keystoneGain.set(id, baseScore > 0 ? score / baseScore - 1 : 0);
      }
      continue;
    }
    for (const effect of node.effects) {
      const key = groupKey(effect);
      if (groupGain.has(key)) {
        continue;
      }
      if (!effectMatters(effect) || !effect.value) {
        groupGain.set(key, 0);
        continue;
      }
      const score = evaluateWith([effect]);
      groupGain.set(key, baseScore > 0 ? (score / baseScore - 1) / effect.value : 0);
    }
  }
  return { groupGain, keystoneGain, optionGain: new Map() };
}

// A mastery option's gain, measured exactly the first time it's asked for after each measuring.
function optionValue(option, gains, evaluateWith, effectMatters, baseScore) {
  if (gains.optionGain.has(option.id)) {
    return gains.optionGain.get(option.id);
  }
  let gain = 0;
  if (baseScore > 0 && option.effects.some(effect => effectMatters(effect))) {
    gain = evaluateWith(option.effects) / baseScore - 1;
  }
  gains.optionGain.set(option.id, gain);
  return gain;
}

// The mastery's best option not yet taken elsewhere in the tree.
function bestOption(mastery, usedOptions, value) {
  let best = null;
  for (const option of mastery.options) {
    if (usedOptions.has(option.id)) {
      continue;
    }
    const gain = value(option);
    if (best === null || gain > best.gain) {
      best = { option, gain };
    }
  }
  return best;
}

// The unlocking notable closest to the tree as it stands (allocated ones are at distance 0).
function nearestUnlock(mastery, distance) {
  let nearest = null;
  for (const id of mastery.unlockedBy) {
    if (distance.has(id) && (nearest === null || distance.get(id) < distance.get(nearest))) {
      nearest = id;
    }
  }
  return nearest;
}

function pathValue(tree, path, gains) {
  let value = 0;
  for (const step of path) {
    value += nodeValue(tree.nodes.get(step), gains);
  }
  return value;
}

function nodeValue(node, gains) {
  if (node.kind === 'keystone') {
    return gains.keystoneGain.get(node.id) ?? 0;
  }
  let value = 0;
  for (const effect of node.effects) {
    const perUnit = gains.groupGain.get(groupKey(effect));
    if (perUnit) {
      value += perUnit * effect.value;
    }
  }
  return value;
}

// Plans a tree for a build. evaluate(effects) scores the build with the given tree effects; effectMatters(effect)
// says whether an effect can change the score at all. Returns the allocated node ids and what they add up to.
//
// A keystone changes how everything after it is worth (Elemental Overload turns a crit build into a non-crit one),
// so a greedy plan that took one early can end up below the plan that never took it. Each keystone the plan took
// can be tried away once each (tryWithoutKeystones), and the better tree kept. That plans the tree up to four
// times, so the generator does it only for the trees it keeps.
export function planTree(tree, className, evaluate, effectMatters, options = {}) {
  const budget = options.budget ?? tree.budget;
  const jewels = options.jewels || null;
  let best = planOneTree(tree, className, evaluate, effectMatters, budget, new Set(), jewels);
  if (!options.tryWithoutKeystones) {
    return best;
  }
  let bestScore = evaluate(best.effects);
  for (const keystoneId of keystoneIdsOf(tree, best.nodes)) {
    const alternative = planOneTree(tree, className, evaluate, effectMatters, budget, new Set([keystoneId]), jewels);
    const alternativeScore = evaluate(alternative.effects);
    if (alternativeScore > bestScore) {
      best = alternative;
      bestScore = alternativeScore;
    }
  }
  return best;
}

function keystoneIdsOf(tree, nodeIds) {
  const keystones = [];
  for (const id of nodeIds) {
    if (tree.nodes.get(id).kind === 'keystone') {
      keystones.push(id);
    }
  }
  return keystones;
}

function planOneTree(tree, className, evaluate, effectMatters, budget, forbidden, jewels) {
  const start = tree.starts[className];
  const allocated = new Set([start]);
  const allocatedEffects = [];
  const takenMasteries = new Map(); // mastery id -> chosen option
  const usedOptions = new Set();
  const socketed = []; // {socket, kind: 'rare' | 'cluster', name}
  let clustersUsed = 0;
  let timelessUsed = false;
  const conquered = new Map(); // keystone node id -> the timeless keystone it became
  const socketEffects = new Map(); // socket id -> the effects of the jewel in it (to swap a rare jewel out)
  let valueOfJewel = null;
  let points = 0;
  let gains = null;
  let pointsAtMeasure = -Infinity;
  let valueOfOption = null;
  while (points < budget) {
    const { distance, parent } = pathsFrom(tree, allocated, forbidden);
    const reachable = [];
    for (const id of distance.keys()) {
      if (!allocated.has(id)) {
        reachable.push(id);
      }
    }
    let measuredNow = false;
    if (gains === null || points - pointsAtMeasure >= REFRESH_EVERY_POINTS) {
      measuredNow = true;
      const current = mergeEffects(allocatedEffects);
      const baseScore = evaluate(current);
      const evaluateWith = extra => evaluate(mergeEffects([current, extra]));
      const measured = measureGains(tree, reachable, evaluateWith, effectMatters, baseScore);
      gains = measured;
      valueOfOption = option => optionValue(option, measured, evaluateWith, effectMatters, baseScore);
      const jewelGains = new Map();
      valueOfJewel = choice => {
        if (!jewelGains.has(choice.key)) {
          jewelGains.set(choice.key, baseScore > 0 ? evaluateWith(choice.effects) / baseScore - 1 : 0);
        }
        return jewelGains.get(choice.key);
      };
      pointsAtMeasure = points;
    }
    let best = null;
    for (const id of reachable) {
      const node = tree.nodes.get(id);
      if (node.kind === 'jewel' && jewels) {
        const candidate = jewelCandidate(tree, node, parent, allocated, gains, jewels, clustersUsed, valueOfJewel, timelessUsed);
        if (candidate && points + candidate.path.length + candidate.choice.points <= budget
          && (best === null || candidate.perPoint > best.perPoint)) {
          best = candidate;
        }
        continue;
      }
      if (node.kind === 'small' && nodeValue(node, gains) <= 0) {
        continue; // a lone small node is a target only when it helps; paths still pass through others
      }
      const path = pathTo(id, parent, allocated);
      if (path.length === 0 || points + path.length > budget) {
        continue;
      }
      const perPoint = pathValue(tree, path, gains) / path.length;
      if (best === null || perPoint > best.perPoint) {
        best = { perPoint, path, mastery: null, choice: null };
      }
    }
    for (const mastery of tree.masteries) {
      const candidate = masteryCandidate(tree, mastery, distance, parent, allocated, takenMasteries, usedOptions, gains, valueOfOption);
      if (candidate === null || points + candidate.path.length + 1 > budget) {
        continue;
      }
      if (best === null || candidate.perPoint > best.perPoint) {
        best = candidate;
      }
    }
    if (jewels && !timelessUsed) {
      const swap = timelessSwapCandidate(tree, socketed, socketEffects, parent, allocated, allocatedEffects, jewels, evaluate);
      if (swap !== null && points + swap.path.length <= budget && (best === null || swap.perPoint > best.perPoint)) {
        best = swap;
      }
    }
    if (best === null || best.perPoint < MIN_GAIN_PER_POINT) {
      break;
    }
    // Lazy greedy: the estimates may be up to REFRESH_EVERY_POINTS old, so the chosen step's real gain is measured
    // before it's taken. Far below its estimate, everything is measured again and the choice made again.
    const exact = exactGainPerPoint(best, allocatedEffects, evaluate, tree);
    if (exact < best.perPoint * STALE_ESTIMATE_SHARE && !measuredNow) {
      pointsAtMeasure = -Infinity;
      continue;
    }
    if (exact < MIN_GAIN_PER_POINT) {
      break;
    }
    for (const step of best.path) {
      allocated.add(step);
      if (step !== best.conquered) {
        allocatedEffects.push(tree.nodes.get(step).effects); // a conquered keystone gives the timeless keystone instead
      }
      if (tree.nodes.get(step).kind === 'keystone') {
        pointsAtMeasure = -Infinity; // a keystone changes how everything else is worth: measure again
      }
    }
    points += best.path.length;
    if (best.conquered && allocatedEffects.includes(tree.nodes.get(best.conquered).effects)) {
      allocatedEffects.splice(allocatedEffects.indexOf(tree.nodes.get(best.conquered).effects), 1);
    }
    if (best.replaces) {
      allocatedEffects.splice(allocatedEffects.indexOf(best.replaces.effects), 1);
      socketed.splice(socketed.indexOf(best.replaces.entry), 1);
    }
    if (best.choice) {
      allocatedEffects.push(best.choice.effects);
      socketEffects.set(best.socket, best.choice.effects);
      points += best.choice.points;
      const entry = { socket: best.socket, kind: best.choice.kind, name: best.choice.name };
      if (best.choice.kind === 'cluster') {
        clustersUsed += 1;
      }
      if (best.choice.kind === 'timeless') {
        timelessUsed = true;
        conquered.set(best.conquered, best.choice.keystone);
        entry.conquers = tree.nodes.get(best.conquered).name;
        entry.keystone = best.choice.keystone;
        entry.name = best.choice.name + ' (conquers ' + entry.conquers + '; seed effects on other passives not planned)';
        pointsAtMeasure = -Infinity; // a new keystone changes how everything else is worth
      }
      socketed.push(entry);
    }
    if (best.mastery !== null) {
      takenMasteries.set(best.mastery.id, best.option);
      usedOptions.add(best.option.id);
      allocatedEffects.push(best.option.effects);
      points += 1;
      if (best.option.effects.some(effect => effect.kind === 'flag')) {
        pointsAtMeasure = -Infinity; // a rule-changing option, like a keystone
      }
    }
  }
  const summary = summarise(tree, allocated, allocatedEffects, points, takenMasteries, conquered);
  summary.jewels = socketed;
  return summary;
}

// A jewel socket as a target: the path to it, then the best of what can go in it (the rare jewel anywhere, a large
// cluster jewel in an outer socket while fewer than the allowed number are used, a timeless jewel where a keystone is
// in its radius and none is used yet).
function jewelCandidate(tree, node, parent, allocated, gains, jewels, clustersUsed, valueOfJewel, timelessUsed) {
  const path = pathTo(node.id, parent, allocated);
  if (path.length === 0) {
    return null;
  }
  const choices = [];
  if (jewels.rare) {
    choices.push(jewels.rare);
  }
  if (node.largeCluster && clustersUsed < (jewels.maxClusters ?? 0)) {
    choices.push(...(jewels.clusters || []));
  }
  let best = null;
  const valueOfPath = pathValue(tree, path, gains);
  for (const choice of choices) {
    const perPoint = (valueOfPath + valueOfJewel(choice)) / (path.length + choice.points);
    if (best === null || perPoint > best.perPoint) {
      best = { perPoint, path, mastery: null, choice, socket: node.id };
    }
  }
  if (!timelessUsed) {
    const timeless = timelessCandidate(tree, node, path, parent, allocated, gains, jewels, valueOfJewel);
    if (timeless !== null && (best === null || timeless.perPoint > best.perPoint)) {
      best = timeless;
    }
  }
  return best;
}

// A timeless jewel in this socket conquers a keystone in its radius: that keystone becomes one of the jewel's
// conquerors' keystones (Lethal Pride's Strength of Blood). The keystone must be allocated, so its path is part of
// the cost, and its own effect is replaced, so it isn't counted. Only one timeless jewel fits a build (they are
// "Historic", limited to one). What the jewel does to the other passives in its radius depends on its seed and isn't
// modelled: this is the keystone alone.
function timelessCandidate(tree, socket, socketPath, parent, allocated, gains, jewels, valueOfJewel) {
  const nearby = tree.keystonesNearSocket?.get(socket.id);
  if (!jewels.timeless || jewels.timeless.length === 0 || !nearby) {
    return null;
  }
  let best = null;
  for (const keystoneId of nearby) {
    if (allocated.has(keystoneId) || !parent.has(keystoneId)) {
      continue; // a keystone already taken keeps its own effect; one out of reach waits
    }
    const path = unionOfPaths(socketPath, pathTo(keystoneId, parent, allocated));
    const pathWithoutKeystone = path.filter(id => id !== keystoneId);
    const valueOfPath = pathValue(tree, pathWithoutKeystone, gains);
    for (const choice of jewels.timeless) {
      const perPoint = (valueOfPath + valueOfJewel(choice)) / (path.length + choice.points);
      if (best === null || perPoint > best.perPoint) {
        best = { perPoint, path, mastery: null, choice, socket: socket.id, conquered: keystoneId };
      }
    }
  }
  return best;
}

// A rare jewel already socketed swapped for a timeless jewel: the planner fills sockets with rare jewels early, and
// an allocated socket isn't a target again, so the timeless jewel is weighed here as a replacement. Its cost is the
// path to the keystone it conquers; its gain is measured exactly, without the rare jewel and its keystone's own effect.
function timelessSwapCandidate(tree, socketed, socketEffects, parent, allocated, allocatedEffects, jewels, evaluate) {
  if (!jewels.timeless || jewels.timeless.length === 0 || !tree.keystonesNearSocket) {
    return null;
  }
  const base = evaluate(mergeEffects(allocatedEffects));
  if (!(base > 0)) {
    return null;
  }
  let best = null;
  for (const entry of socketed) {
    const nearby = tree.keystonesNearSocket.get(entry.socket);
    if (entry.kind !== 'rare' || !nearby) {
      continue;
    }
    const rareEffects = socketEffects.get(entry.socket);
    for (const keystoneId of nearby) {
      const alreadyTaken = allocated.has(keystoneId);
      if (!alreadyTaken && !parent.has(keystoneId)) {
        continue;
      }
      // A keystone the tree already holds can be conquered too: its own effect goes, the conqueror's comes.
      const keystoneEffects = tree.nodes.get(keystoneId).effects;
      const withoutRare = allocatedEffects.filter(effects => effects !== rareEffects && !(alreadyTaken && effects === keystoneEffects));
      const path = alreadyTaken ? [] : pathTo(keystoneId, parent, allocated);
      const pathEffects = [];
      for (const id of path) {
        if (id !== keystoneId) {
          pathEffects.push(tree.nodes.get(id).effects);
        }
      }
      for (const choice of jewels.timeless) {
        const score = evaluate(mergeEffects([...withoutRare, ...pathEffects, choice.effects]));
        const perPoint = (score / base - 1) / Math.max(1, path.length);
        if (best === null || perPoint > best.perPoint) {
          best = { perPoint, path, mastery: null, choice, socket: entry.socket, conquered: keystoneId,
            replaces: { entry, effects: rareEffects } };
        }
      }
    }
  }
  return best;
}

function unionOfPaths(first, second) {
  const union = [...first];
  for (const id of second) {
    if (!union.includes(id)) {
      union.push(id);
    }
  }
  return union;
}

// The score gain per point of taking the step (its path, and its mastery option if any), measured exactly.
function exactGainPerPoint(step, allocatedEffects, evaluate, tree) {
  const before = evaluate(mergeEffects(allocatedEffects));
  if (before <= 0) {
    return 0;
  }
  const added = [];
  const conqueredEffects = step.conquered ? tree.nodes.get(step.conquered).effects : null;
  for (const effects of allocatedEffects) {
    if (step.replaces && effects === step.replaces.effects) {
      continue;
    }
    if (effects === conqueredEffects) {
      continue; // a conquered keystone already on the tree gives the timeless keystone instead
    }
    added.push(effects);
  }
  for (const id of step.path) {
    if (id !== step.conquered) {
      added.push(tree.nodes.get(id).effects);
    }
  }
  let points = step.path.length;
  if (step.mastery !== null) {
    added.push(step.option.effects);
    points += 1;
  }
  if (step.choice) {
    added.push(step.choice.effects);
    points += step.choice.points;
  }
  // A swap that conquers a keystone already on the tree costs no point; it is measured as one.
  return (evaluate(mergeEffects(added)) / before - 1) / Math.max(1, points);
}

// A mastery as a target: the path to its nearest unlocking notable (empty when one is taken), then the mastery's
// own point with its best free option.
function masteryCandidate(tree, mastery, distance, parent, allocated, takenMasteries, usedOptions, gains, valueOfOption) {
  if (takenMasteries.has(mastery.id)) {
    return null;
  }
  const unlock = nearestUnlock(mastery, distance);
  if (unlock === null) {
    return null;
  }
  const choice = bestOption(mastery, usedOptions, valueOfOption);
  if (choice === null || choice.gain <= 0) {
    return null;
  }
  const path = pathTo(unlock, parent, allocated);
  const perPoint = (pathValue(tree, path, gains) + choice.gain) / (path.length + 1);
  return { perPoint, path, mastery, option: choice.option, choice: null };
}

function summarise(tree, allocated, allocatedEffects, points, takenMasteries, conquered = new Map()) {
  const keystones = [];
  const notables = [];
  for (const id of allocated) {
    const node = tree.nodes.get(id);
    if (node.kind === 'keystone') {
      keystones.push(conquered.get(id) || node.name);
    } else if (node.kind === 'notable') {
      notables.push(node.name);
    }
  }
  const masteries = [];
  for (const [id, option] of takenMasteries) {
    const mastery = tree.masteries.find(entry => entry.id === id);
    masteries.push({ id, name: mastery.name, text: option.text });
  }
  return { nodes: [...allocated], points, effects: mergeEffects(allocatedEffects), keystones, notables, masteries };
}
