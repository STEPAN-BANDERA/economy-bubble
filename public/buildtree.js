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
//
// Radius jewels (public/buildradius.js): a unique jewel that changes the passives in its area (Might of the Meek,
// Healthy Mind, Fortress Covenant...) is worth what it does at that socket, scored exactly with the passives already
// allocated there; once placed, every passive in its area is valued as the jewel makes it, so the tree grows towards
// the passives it improves and away from those it spoils. Free-allocation jewels (Intuitive Leap, Thread of Hope,
// Impossible Escape) are worth the best passives in their area, taken in the same step without a path; those
// passives don't connect the tree to anything else. A rare jewel already socketed can give its socket to one.
//
// Timeless jewels are placed the same way: a socket's timeless jewel conquers the small passives and notables in its
// Large radius (for a typical seed), and may conquer a keystone there too. One per tree; its radius holds no other
// allocated keystone, and the other keystones in it are left alone once it is placed.

import { effectListsWithRadius, nodeEffectsWith, nodeGainEffects, jewelAdditions, placementOf, freeTargets, areaOf } from './buildradius.js';

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
      // Where a large cluster jewel's passives are drawn: [centre x, centre y, radius, entrance angle] (drawing only).
      clusterRing: node.cr || null,
      // GGG's wording of the node, one stat line per line, for the drawn tree's hover text (not used in planning).
      text: node.s || '',
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
// Shortest paths from every allocated node at once (the tree's edges all cost one point). A node allocated without
// a path (floating: through a free-allocation jewel) leads nowhere: the game doesn't connect the tree through it.
function pathsFrom(tree, allocated, forbidden, floating = null) {
  const parent = new Map();
  const distance = new Map();
  let frontier = [];
  for (const id of allocated) {
    distance.set(id, 0);
    if (floating === null || !floating.has(id)) {
      frontier.push(id);
    }
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

// Gains of the effect groups and keystones reachable now, measured against the build as it stands. effectsOf(node)
// is what allocating the node adds (its effects as the radius jewels placed make them); the gains keep it, so
// nodeValue reads the same.
function measureGains(tree, reachable, evaluateWith, effectMatters, baseScore, effectsOf = node => node.effects) {
  const groupGain = new Map();
  const keystoneGain = new Map();
  for (const id of reachable) {
    const node = tree.nodes.get(id);
    if (node.kind === 'keystone') {
      if (!keystoneGain.has(id)) {
        const score = evaluateWith(effectsOf(node));
        keystoneGain.set(id, baseScore > 0 ? score / baseScore - 1 : 0);
      }
      continue;
    }
    for (const effect of effectsOf(node)) {
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
  return { groupGain, keystoneGain, optionGain: new Map(), effectsOf };
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
  const effects = gains.effectsOf ? gains.effectsOf(node) : node.effects;
  for (const effect of effects) {
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
// options.forbiddenKeystones: keystone node ids never taken (the build holds those keystones another way).
// options.seed: a tree to grow from instead of the class start alone ({nodes, masteries, jewels} as a planned tree
// gives them): its nodes still joined to the start are kept, its masteries while one of their notables is, and its
// jewel sockets get this build's best jewel of the same kind; the points left are planned as usual. The gear presets
// use it to keep a build's tree when only its weapon-specific nodes go (public/buildgen.js, gearPresetVariant).
export function planTree(tree, className, evaluate, effectMatters, options = {}) {
  const budget = options.budget ?? tree.budget;
  const jewels = options.jewels || null;
  const forbiddenKeystones = options.forbiddenKeystones || new Set();
  const seed = options.seed || null;
  let best = planOneTree(tree, className, evaluate, effectMatters, budget, new Set(forbiddenKeystones), jewels, seed);
  if (!options.tryWithoutKeystones) {
    return best;
  }
  let bestScore = evaluate(best.effects);
  for (const keystoneId of keystoneIdsOf(tree, best.nodes)) {
    const alternative = planOneTree(tree, className, evaluate, effectMatters, budget, new Set([...forbiddenKeystones, keystoneId]), jewels, seed);
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

function planOneTree(tree, className, evaluate, effectMatters, budget, forbidden, jewels, seed = null) {
  const start = tree.starts[className];
  const allocated = new Set([start]);
  const allocatedEffects = [];
  const takenMasteries = new Map(); // mastery id -> chosen option
  const usedOptions = new Set();
  const socketed = []; // {socket, kind: 'rare' | 'cluster' | 'timeless' | 'radius', name}
  let clustersUsed = 0;
  let timelessUsed = false;
  const conquered = new Map(); // keystone node id -> the timeless keystone it became
  const socketEffects = new Map(); // socket id -> the effects of the jewel in it (to swap a rare jewel out)
  const placements = []; // the radius jewels in their sockets (public/buildradius.js)
  const floating = new Set(); // nodes allocated through a free-allocation jewel, without a path
  // The tree's score with these effect lists, allocated nodes and radius jewels (by default the plan as it stands).
  const scoreWith = (lists, ids = allocated, placed = placements) => evaluate(mergeEffects(effectListsWithRadius(tree, lists, ids, placed)));
  // What allocating a node adds, as the radius jewels placed make it.
  const effectsOf = node => (placements.length === 0 ? node.effects : nodeGainEffects(node, placements));
  let valueOfJewel = null;
  let valueOfRadius = null;
  let radiusSwap = null; // the best radius jewel to put in a rare jewel's socket, found at each measuring
  let timelessSwap = null; // the same for a timeless jewel
  // Radius jewels at sockets whose exact gain fell far below the estimate, set aside until the next step is taken
  // (not the next measuring: measuring again after a stale estimate would bring the same jewel straight back).
  const rejectedRadius = new Set();
  let points = 0;
  let gains = null;
  let pointsAtMeasure = -Infinity;
  let valueOfOption = null;
  if (seed !== null) {
    const state = { allocated, allocatedEffects, takenMasteries, usedOptions, socketed, socketEffects, conquered, placements, floating };
    const seeded = seedTree(tree, start, seed, jewels, forbidden, state);
    points = seeded.points;
    clustersUsed = seeded.clustersUsed;
    timelessUsed = seeded.timelessUsed;
  }
  while (points < budget) {
    const { distance, parent } = pathsFrom(tree, allocated, forbidden, floating);
    const reachable = [];
    for (const id of distance.keys()) {
      if (!allocated.has(id)) {
        reachable.push(id);
      }
    }
    const free = freeTargets(placements, allocated, forbidden);
    let measuredNow = false;
    if (gains === null || points - pointsAtMeasure >= REFRESH_EVERY_POINTS) {
      measuredNow = true;
      const current = mergeEffects(effectListsWithRadius(tree, allocatedEffects, allocated, placements));
      const baseScore = evaluate(current);
      const evaluateWith = extra => evaluate(mergeEffects([current, extra]));
      const measured = measureGains(tree, reachable, evaluateWith, effectMatters, baseScore, effectsOf);
      // Kept for the radius estimates, which measure a stat this measuring didn't meet when they need it.
      Object.assign(measured, { evaluateWith, effectMatters, baseScore });
      gains = measured;
      valueOfOption = option => optionValue(option, measured, evaluateWith, effectMatters, baseScore);
      const jewelGains = new Map();
      valueOfJewel = choice => {
        if (!jewelGains.has(choice.key)) {
          jewelGains.set(choice.key, baseScore > 0 ? evaluateWith(choice.effects) / baseScore - 1 : 0);
        }
        return jewelGains.get(choice.key);
      };
      // A radius jewel's estimated worth at a socket: its own lines and what it does to the passives allocated in
      // its area, from the measured gains like any node (the step chosen is then measured exactly).
      const radiusGains = new Map();
      valueOfRadius = (socketId, choice) => {
        const key = socketId + '|' + choice.key;
        if (!radiusGains.has(key)) {
          radiusGains.set(key, valueOfJewel(choice) + radiusEffectOnArea(tree, socketId, choice, placements, allocated, measured));
        }
        return radiusGains.get(key);
      };
      pointsAtMeasure = points;
    }
    const radiusContext = { gains, valueOfRadius, valueOfJewel, placements, allocated, forbidden, rejected: rejectedRadius,
      pointsLeft: budget - points };
    if (measuredNow) {
      radiusSwap = radiusSwapCandidate(tree, socketed, jewels, radiusContext);
      // Scored exactly, so found only at each measuring, like the radius swap.
      timelessSwap = jewels && !timelessUsed
        ? timelessSwapCandidate(tree, socketed, socketEffects, parent, allocated, allocatedEffects, jewels, scoreWith, placements)
        : null;
    }
    let best = null;
    for (const id of reachable) {
      const node = tree.nodes.get(id);
      if (node.kind === 'jewel' && jewels) {
        const candidate = jewelCandidate(tree, node, parent, allocated, gains, jewels, clustersUsed, valueOfJewel, timelessUsed, radiusContext);
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
    // Passives a free-allocation jewel lets the tree take without a path (one already a point away is taken as usual).
    if (points + 1 <= budget) {
      for (const id of free) {
        if (distance.get(id) === 1) {
          continue;
        }
        const value = measuredNodeValue(tree.nodes.get(id), gains);
        if (value > 0 && (best === null || value > best.perPoint)) {
          best = { perPoint: value, path: [id], mastery: null, choice: null, floating: [id] };
        }
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
    if (timelessSwap !== null && !timelessUsed && timelessSwapStillOpen(tree, timelessSwap, socketed, allocated)
      && points + timelessSwap.path.length <= budget && (best === null || timelessSwap.perPoint > best.perPoint)) {
      best = timelessSwap;
    }
    if (radiusSwap !== null && swapStillOpen(radiusSwap, socketed, allocated, placements) && points + radiusSwap.path.length <= budget
      && (best === null || radiusSwap.perPoint > best.perPoint)) {
      best = radiusSwap;
    }
    if (best === null || best.perPoint < MIN_GAIN_PER_POINT) {
      break;
    }
    // Lazy greedy: the estimates may be up to REFRESH_EVERY_POINTS old, so the chosen step's real gain is measured
    // before it's taken. Far below its estimate, everything is measured again and the choice made again.
    const exact = exactGainPerPoint(best, allocatedEffects, scoreWith, tree, allocated, placements);
    const placesRadius = best.choice && (best.choice.kind === 'radius' || best.choice.kind === 'timeless');
    if (placesRadius && exact < best.perPoint * STALE_ESTIMATE_SHARE) {
      // A radius or timeless jewel's estimate can be far off (its rules move whole stats): set it aside and choose again.
      rejectedRadius.add(best.socket + '|' + best.choice.key);
      if (best === radiusSwap) {
        radiusSwap = null;
      }
      if (best === timelessSwap) {
        timelessSwap = null;
      }
      continue;
    }
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
    for (const id of best.floating || []) {
      floating.add(id);
    }
    rejectedRadius.clear(); // the tree changed: a jewel set aside may be worth its estimate now
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
        entry.clusterType = best.choice.clusterType;
        entry.notables = best.choice.notables;
        entry.smallEffects = best.choice.smallEffects;
      }
      if (best.choice.kind === 'timeless') {
        timelessUsed = true;
        const conqueredName = best.conquered ? tree.nodes.get(best.conquered).name : null;
        if (best.conquered) {
          conquered.set(best.conquered, best.choice.keystone);
        }
        Object.assign(entry, placeTimeless(tree, best.choice, best.socket, conqueredName, placements, forbidden));
        pointsAtMeasure = -Infinity; // a new keystone, and conquered passives, change how everything else is worth
        radiusSwap = null;
      }
      if (best.choice.kind === 'radius') {
        placements.push(placementOf(tree, best.socket, best.choice));
        Object.assign(entry, radiusEntryFields(best.choice, best.socket));
        pointsAtMeasure = -Infinity; // the passives in its area are worth something else now
        radiusSwap = null;
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
  const finalEffects = effectListsWithRadius(tree, allocatedEffects, allocated, placements);
  const summary = summarise(tree, allocated, finalEffects, points, takenMasteries, conquered);
  summary.jewels = socketed;
  if (floating.size > 0) {
    summary.floating = [...floating];
  }
  return summary;
}

// A timeless jewel put in its socket: its placement (the passives it conquers), the other keystones in its radius
// forbidden (the game would turn them into the same conqueror's keystone, which the build holds already or doesn't
// want), and what the card and the drawn tree show of it.
function placeTimeless(tree, choice, socketId, conqueredName, placements, forbidden) {
  const placement = placementOf(tree, socketId, choice);
  placements.push(placement);
  for (const id of placement.area) {
    if (tree.nodes.get(id).kind === 'keystone' && tree.nodes.get(id).name !== conqueredName) {
      forbidden.add(id);
    }
  }
  const fields = { ...radiusEntryFields(choice, socketId), jewel: choice.jewel, baseName: choice.jewel, keystone: choice.keystone };
  if (conqueredName) {
    fields.conquers = conqueredName;
    fields.name = choice.name + ' (conquers ' + conqueredName + '; passives in radius for a typical seed)';
  } else {
    fields.name = choice.name + ' (passives in radius for a typical seed)';
  }
  return fields;
}

// A timeless jewel may go where its radius holds no allocated keystone but the one it conquers: any other would be
// conquered too.
function timelessFitsSocket(tree, socketId, choice, allocated, conqueredId) {
  for (const id of areaOf(tree, socketId, choice)) {
    if (id !== conqueredId && allocated.has(id) && tree.nodes.get(id).kind === 'keystone') {
      return false;
    }
  }
  return true;
}

// What the card and the drawn tree show of a radius jewel: its item name and its area (centre node, inner and outer
// distance in tree units).
function radiusEntryFields(choice, socketId) {
  return { baseName: choice.baseName, free: choice.free,
    area: { centre: choice.area.around || socketId, inner: Math.max(0, choice.area.inner), outer: choice.area.outer } };
}

// The seed's part of a tree put in place (planTree's options.seed): its nodes joined to the class start through other
// seed nodes (a node whose link to the start was taken out goes too), its jewels refilled with this build's choice of
// the same kind (none when this build has no such choice), and its masteries while a notable unlocking them stays.
// Seed nodes inside a kept free-allocation jewel's area stay too, unconnected as they were.
// Returns the points spent and the jewels used.
function seedTree(tree, start, seed, jewels, forbidden, state) {
  const seedNodes = new Set(seed.nodes || []);
  const kept = new Set([start]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next = [];
    for (const id of frontier) {
      for (const neighbour of tree.nodes.get(id).neighbours) {
        if (seedNodes.has(neighbour) && !kept.has(neighbour) && !forbidden.has(neighbour)) {
          kept.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }
  let points = 0;
  let clustersUsed = 0;
  let timelessUsed = false;
  // Jewels first: a timeless jewel decides what its conquered keystone gives.
  const conqueredKeystones = new Set();
  for (const entry of seed.jewels || []) {
    if (!kept.has(entry.socket) || !jewels) {
      continue;
    }
    const choice = seedJewelChoice(entry, jewels, timelessUsed, state.placements);
    if (choice === null) {
      continue;
    }
    let conqueredId = null;
    if (choice.kind === 'timeless') {
      if (choice.keystone !== null) {
        conqueredId = keystoneNamed(tree, entry.socket, entry.conquers);
        if (conqueredId === null || !kept.has(conqueredId)) {
          continue;
        }
      }
      if (!timelessFitsSocket(tree, entry.socket, choice, kept, conqueredId)) {
        continue;
      }
    }
    state.allocatedEffects.push(choice.effects);
    state.socketEffects.set(entry.socket, choice.effects);
    points += choice.points;
    const socketedEntry = { socket: entry.socket, kind: choice.kind, name: choice.name };
    if (choice.kind === 'cluster') {
      clustersUsed += 1;
      socketedEntry.clusterType = choice.clusterType;
      socketedEntry.notables = choice.notables;
      socketedEntry.smallEffects = choice.smallEffects;
    }
    if (choice.kind === 'timeless') {
      timelessUsed = true;
      if (conqueredId !== null) {
        conqueredKeystones.add(conqueredId);
        state.conquered.set(conqueredId, choice.keystone);
      }
      Object.assign(socketedEntry, placeTimeless(tree, choice, entry.socket, conqueredId === null ? null : entry.conquers,
        state.placements, forbidden));
    }
    if (choice.kind === 'radius') {
      const placement = placementOf(tree, entry.socket, choice);
      state.placements.push(placement);
      Object.assign(socketedEntry, radiusEntryFields(choice, entry.socket));
      if (choice.free) {
        for (const id of seedNodes) {
          if (!kept.has(id) && placement.area.has(id) && !forbidden.has(id)) {
            kept.add(id);
            state.floating.add(id);
          }
        }
      }
    }
    state.socketed.push(socketedEntry);
  }
  for (const id of kept) {
    if (id === start) {
      continue;
    }
    state.allocated.add(id);
    points += 1;
    if (!conqueredKeystones.has(id)) {
      state.allocatedEffects.push(tree.nodes.get(id).effects);
    }
  }
  for (const taken of seed.masteries || []) {
    const mastery = tree.masteries.find(entry => entry.id === taken.id);
    if (!mastery || !mastery.unlockedBy.some(id => kept.has(id)) || state.takenMasteries.has(mastery.id)) {
      continue;
    }
    const option = mastery.options.find(entry => entry.text === taken.text);
    if (!option || state.usedOptions.has(option.id)) {
      continue;
    }
    state.takenMasteries.set(mastery.id, option);
    state.usedOptions.add(option.id);
    state.allocatedEffects.push(option.effects);
    points += 1;
  }
  return { points, clustersUsed, timelessUsed };
}

// This build's jewel of the seed entry's kind: the rare jewel, the large cluster of the same type, the timeless
// keystone of the same name (or the same timeless jewel without one), or the same radius jewel; null when it has
// none of that kind.
function seedJewelChoice(entry, jewels, timelessUsed, placements) {
  if (entry.kind === 'rare') {
    return jewels.rare || null;
  }
  if (entry.kind === 'cluster') {
    return (jewels.clusters || []).find(choice => choice.clusterType === entry.clusterType) || null;
  }
  if (entry.kind === 'timeless' && !timelessUsed) {
    const keystone = entry.keystone || null;
    return (jewels.timeless || []).find(choice => choice.keystone === keystone
      && (keystone !== null || choice.jewel === entry.jewel)) || null;
  }
  if (entry.kind === 'radius') {
    const choice = (jewels.radius || []).find(candidate => candidate.name === entry.name) || null;
    return choice !== null && radiusChoiceAllowed(choice, placements) ? choice : null;
  }
  return null;
}

// The keystone of this name in a socket's timeless radius, or null.
function keystoneNamed(tree, socketId, name) {
  for (const id of tree.keystonesNearSocket?.get(socketId) || []) {
    if (tree.nodes.get(id).name === name) {
      return id;
    }
  }
  return null;
}

// A jewel socket as a target: the path to it, then the best of what can go in it (the rare jewel anywhere, a large
// cluster jewel in an outer socket while fewer than the allowed number are used, a timeless jewel while none is used
// yet, a radius jewel).
function jewelCandidate(tree, node, parent, allocated, gains, jewels, clustersUsed, valueOfJewel, timelessUsed, radiusContext) {
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
    const timeless = timelessCandidate(tree, node, path, parent, allocated, gains, jewels, radiusContext);
    if (timeless !== null && (best === null || timeless.perPoint > best.perPoint)) {
      best = timeless;
    }
  }
  const radius = radiusCandidate(tree, node.id, path, valueOfPath, jewels.radius || [], radiusContext);
  if (radius !== null && (best === null || radius.perPoint > best.perPoint)) {
    best = radius;
  }
  return best;
}

// One of an item unless its limit allows more ("Limited to: 2"); the game allows any number of an item without a
// limit, but one is what a build plans for.
function radiusChoiceAllowed(choice, placements) {
  let placed = 0;
  for (const placement of placements) {
    if (placement.choice.baseName === choice.baseName) {
      placed += 1;
    }
  }
  return placed < (choice.limit ?? 1);
}

// The best radius jewel for this socket, reached by socketPath (empty when the socket holds a jewel already and this
// is a swap). A jewel that changes passives is worth its exact gain there; a free-allocation jewel is worth that and
// the best passives of its area, taken in the same step.
function radiusCandidate(tree, socketId, socketPath, valueOfPath, choices, context) {
  let best = null;
  for (const choice of choices) {
    if (!radiusChoiceAllowed(choice, context.placements) || context.rejected.has(socketId + '|' + choice.key)) {
      continue;
    }
    const own = context.valueOfRadius(socketId, choice);
    let candidate = null;
    if (!choice.free) {
      if (socketPath.length === 0) {
        candidate = { perPoint: own, path: [], choice, socket: socketId };
      } else {
        candidate = { perPoint: (valueOfPath + own) / socketPath.length, path: socketPath, choice, socket: socketId };
      }
    } else {
      const picked = bestFreePassives(tree, areaOf(tree, socketId, choice), context, socketPath, valueOfPath + own);
      if (picked !== null) {
        candidate = { perPoint: picked.perPoint, path: unionOfPaths(socketPath, picked.nodes), choice, socket: socketId,
          floating: picked.nodes.filter(id => !socketPath.includes(id)) };
      }
    }
    if (candidate !== null && (best === null || candidate.perPoint > best.perPoint)) {
      best = { mastery: null, ...candidate };
    }
  }
  return best;
}

// The passives of a free-allocation area worth taking now, best first, as many as give the best value per point with
// the jewel's path and own worth; null when none helps.
function bestFreePassives(tree, area, context, socketPath, baseValue) {
  const values = [];
  for (const id of area) {
    if (context.allocated.has(id) || context.forbidden.has(id) || socketPath.includes(id)) {
      continue;
    }
    const value = measuredNodeValue(tree.nodes.get(id), context.gains);
    if (value > 0) {
      values.push({ id, value });
    }
  }
  if (values.length === 0) {
    return null;
  }
  values.sort((first, second) => second.value - first.value);
  let total = baseValue;
  let best = null;
  const room = context.pointsLeft - socketPath.length;
  for (let count = 1; count <= values.length && count <= room; count += 1) {
    total += values[count - 1].value;
    const perPoint = total / (socketPath.length + count);
    if (best === null || perPoint > best.perPoint) {
      best = { perPoint, nodes: values.slice(0, count).map(entry => entry.id) };
    }
  }
  return best;
}

// A radius jewel's estimated effect on its area at this socket: what each allocated passive there gives with it less
// what it gives now, and what the jewel adds from its area as a whole (public/buildradius.js), valued with the gains.
function radiusEffectOnArea(tree, socketId, choice, placements, allocated, gains) {
  const placement = placementOf(tree, socketId, choice);
  const after = [...placements, placement];
  let value = 0;
  for (const id of placement.area) {
    const node = tree.nodes.get(id);
    if (!allocated.has(id) || node.kind === 'keystone') {
      continue; // the rules change small passives and notables
    }
    value += measuredEffectsValue(nodeEffectsWith(node, after), gains) - measuredEffectsValue(nodeEffectsWith(node, placements), gains);
  }
  // What the jewels add from their areas, with this one and without (a timeless jewel changes what Unnatural
  // Instinct grants of the passives it conquers).
  return value + additionsValue(tree, after, allocated, gains) - additionsValue(tree, placements, allocated, gains);
}

function additionsValue(tree, placements, allocated, gains) {
  let value = 0;
  for (const placement of placements) {
    value += measuredEffectsValue(jewelAdditions(tree, placement, allocated, placements), gains);
  }
  return value;
}

// nodeValue for the radius estimates: a stat group or keystone the last measuring didn't meet (a passive no path
// reaches yet, or a stat a radius jewel turns another into) is measured now and kept until the next measuring.
function measuredNodeValue(node, gains) {
  const effects = gains.effectsOf ? gains.effectsOf(node) : node.effects;
  if (node.kind === 'keystone') {
    if (!gains.keystoneGain.has(node.id)) {
      gains.keystoneGain.set(node.id, gains.baseScore > 0 ? gains.evaluateWith(effects) / gains.baseScore - 1 : 0);
    }
    return gains.keystoneGain.get(node.id);
  }
  return measuredEffectsValue(effects, gains);
}

function measuredEffectsValue(effects, gains) {
  let value = 0;
  for (const effect of effects) {
    if (typeof effect.value !== 'number' || effect.value === 0) {
      continue; // as in measureGains: a rule without a number is worth nothing here
    }
    const key = groupKey(effect);
    if (!gains.groupGain.has(key)) {
      let perUnit = 0;
      if (gains.baseScore > 0 && gains.effectMatters(effect)) {
        perUnit = (gains.evaluateWith([effect]) / gains.baseScore - 1) / effect.value;
      }
      gains.groupGain.set(key, perUnit);
    }
    value += gains.groupGain.get(key) * effect.value;
  }
  return value;
}

// A rare jewel already socketed swapped for a radius jewel: rare jewels fill the sockets early, before the passives
// round a socket are known. Estimated as the radius jewel's worth there less the rare jewel's; a free-allocation
// jewel takes its best passives in the same step. The step chosen is measured exactly.
function radiusSwapCandidate(tree, socketed, jewels, context) {
  if (!jewels || !jewels.radius || jewels.radius.length === 0 || !jewels.rare) {
    return null;
  }
  const rareWorth = context.valueOfJewel(jewels.rare);
  let best = null;
  for (const entry of socketed) {
    if (entry.kind !== 'rare') {
      continue;
    }
    for (const choice of jewels.radius) {
      if (!radiusChoiceAllowed(choice, context.placements) || context.rejected.has(entry.socket + '|' + choice.key)) {
        continue;
      }
      const gain = context.valueOfRadius(entry.socket, choice) - rareWorth;
      let candidate = { perPoint: gain, path: [] };
      if (choice.free) {
        const picked = bestFreePassives(tree, areaOf(tree, entry.socket, choice), context, [], gain);
        if (picked === null) {
          continue;
        }
        candidate = { perPoint: picked.perPoint, path: picked.nodes, floating: picked.nodes };
      }
      if (best === null || candidate.perPoint > best.perPoint) {
        best = { ...candidate, mastery: null, choice, socket: entry.socket, replaces: { entry, effects: jewels.rare.effects } };
      }
    }
  }
  return best;
}

// A swap found at the last measuring is still possible: its rare jewel is still there, its item not yet placed, and
// none of the passives it takes allocated since.
function swapStillOpen(swap, socketed, allocated, placements) {
  return socketed.includes(swap.replaces.entry) && radiusChoiceAllowed(swap.choice, placements)
    && swap.path.every(id => !allocated.has(id));
}

// A timeless swap found at the last measuring is still possible: its rare jewel is still there, none of the passives
// on its path allocated since, and its radius still holds no other allocated keystone.
function timelessSwapStillOpen(tree, swap, socketed, allocated) {
  return socketed.includes(swap.replaces.entry) && swap.path.every(id => !allocated.has(id))
    && timelessFitsSocket(tree, swap.socket, swap.choice, allocated, swap.conquered ?? null);
}

// The list without the first occurrence of one item: every socket's rare jewel is the same effects array, so taking
// one out must leave the others.
function withoutOne(list, item) {
  const index = list.indexOf(item);
  if (index < 0) {
    return list;
  }
  return [...list.slice(0, index), ...list.slice(index + 1)];
}

// A timeless jewel in this socket conquers the small passives and notables in its radius (public/buildradius.js),
// worth what that does to the passives already allocated there, estimated like a radius jewel; the tree then grows
// towards the passives it makes better. With a keystone, it also conquers a keystone in its radius: that keystone
// becomes one of the jewel's conquerors' keystones (Lethal Pride's Strength of Blood). The keystone must be
// allocated, so its path is part of the cost, and its own effect is replaced, so it isn't counted. Only one timeless
// jewel fits a build (they are "Historic", limited to one), and its radius may hold no other allocated keystone.
function timelessCandidate(tree, socket, socketPath, parent, allocated, gains, jewels, context) {
  if (!jewels.timeless || jewels.timeless.length === 0) {
    return null;
  }
  let best = null;
  const keep = candidate => {
    if (best === null || candidate.perPoint > best.perPoint) {
      best = candidate;
    }
  };
  const valueOfSocketPath = pathValue(tree, socketPath, gains);
  for (const choice of jewels.timeless) {
    if (choice.keystone !== null || context.rejected.has(socket.id + '|' + choice.key)
      || !timelessFitsSocket(tree, socket.id, choice, allocated, null)) {
      continue;
    }
    keep({ perPoint: (valueOfSocketPath + context.valueOfRadius(socket.id, choice)) / socketPath.length,
      path: socketPath, mastery: null, choice, socket: socket.id });
  }
  for (const keystoneId of tree.keystonesNearSocket?.get(socket.id) || []) {
    if (allocated.has(keystoneId) || !parent.has(keystoneId)) {
      continue; // a keystone already taken keeps its own effect; one out of reach waits
    }
    const path = unionOfPaths(socketPath, pathTo(keystoneId, parent, allocated));
    const pathWithoutKeystone = path.filter(id => id !== keystoneId);
    const valueOfPath = pathValue(tree, pathWithoutKeystone, gains);
    for (const choice of jewels.timeless) {
      if (choice.keystone === null || context.rejected.has(socket.id + '|' + choice.key)
        || !timelessFitsSocket(tree, socket.id, choice, allocated, keystoneId)) {
        continue;
      }
      keep({ perPoint: (valueOfPath + context.valueOfRadius(socket.id, choice)) / (path.length + choice.points),
        path, mastery: null, choice, socket: socket.id, conquered: keystoneId });
    }
  }
  return best;
}

// A rare jewel already socketed swapped for a timeless jewel: the planner fills sockets with rare jewels early, and
// an allocated socket isn't a target again, so the timeless jewel is weighed here as a replacement. Its cost is the
// path to the keystone it conquers (none without a keystone); its gain is measured exactly, with the passives it
// conquers, without the rare jewel and its keystone's own effect.
function timelessSwapCandidate(tree, socketed, socketEffects, parent, allocated, allocatedEffects, jewels, scoreWith, placements) {
  if (!jewels.timeless || jewels.timeless.length === 0) {
    return null;
  }
  const base = scoreWith(allocatedEffects);
  if (!(base > 0)) {
    return null;
  }
  let best = null;
  const keep = candidate => {
    if (best === null || candidate.perPoint > best.perPoint) {
      best = candidate;
    }
  };
  for (const entry of socketed) {
    if (entry.kind !== 'rare') {
      continue;
    }
    const rareEffects = socketEffects.get(entry.socket);
    const withoutRare = withoutOne(allocatedEffects, rareEffects);
    for (const choice of jewels.timeless) {
      if (choice.keystone !== null || !timelessFitsSocket(tree, entry.socket, choice, allocated, null)) {
        continue;
      }
      const placed = [...placements, placementOf(tree, entry.socket, choice)];
      const score = scoreWith([...withoutRare, choice.effects], allocated, placed);
      keep({ perPoint: score / base - 1, path: [], mastery: null, choice, socket: entry.socket,
        replaces: { entry, effects: rareEffects } });
    }
    for (const keystoneId of tree.keystonesNearSocket?.get(entry.socket) || []) {
      const alreadyTaken = allocated.has(keystoneId);
      if (!alreadyTaken && !parent.has(keystoneId)) {
        continue;
      }
      // A keystone the tree already holds can be conquered too: its own effect goes, the conqueror's comes.
      const keystoneEffects = tree.nodes.get(keystoneId).effects;
      const kept = withoutRare.filter(effects => !(alreadyTaken && effects === keystoneEffects));
      const path = alreadyTaken ? [] : pathTo(keystoneId, parent, allocated);
      const pathEffects = [];
      for (const id of path) {
        if (id !== keystoneId) {
          pathEffects.push(tree.nodes.get(id).effects);
        }
      }
      const ids = new Set([...allocated, ...path]);
      for (const choice of jewels.timeless) {
        if (choice.keystone === null || !timelessFitsSocket(tree, entry.socket, choice, ids, keystoneId)) {
          continue;
        }
        const placed = [...placements, placementOf(tree, entry.socket, choice)];
        const score = scoreWith([...kept, ...pathEffects, choice.effects], ids, placed);
        keep({ perPoint: (score / base - 1) / Math.max(1, path.length), path, mastery: null, choice, socket: entry.socket,
          conquered: keystoneId, replaces: { entry, effects: rareEffects } });
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

// The score gain per point of taking the step (its path, and its mastery option if any), measured exactly, with the
// radius jewels placed and the one the step places.
function exactGainPerPoint(step, allocatedEffects, scoreWith, tree, allocated, placements) {
  const before = scoreWith(allocatedEffects);
  if (before <= 0) {
    return 0;
  }
  const conqueredEffects = step.conquered ? tree.nodes.get(step.conquered).effects : null;
  let kept = allocatedEffects;
  if (step.replaces) {
    kept = withoutOne(kept, step.replaces.effects);
  }
  const added = [];
  for (const effects of kept) {
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
  let placed = placements;
  if (step.choice) {
    added.push(step.choice.effects);
    points += step.choice.points;
    if (step.choice.kind === 'radius' || step.choice.kind === 'timeless') {
      placed = [...placements, placementOf(tree, step.socket, step.choice)];
    }
  }
  const ids = step.path.length === 0 ? allocated : new Set([...allocated, ...step.path]);
  // A swap that conquers a keystone already on the tree costs no point; it is measured as one.
  return (scoreWith(added, ids, placed) / before - 1) / Math.max(1, points);
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
