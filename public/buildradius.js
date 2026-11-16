// Unique jewels that work on the passives in their radius, as the tree planner (public/buildtree.js) places them.
// The rules come from scripts/radius_jewels.py, which reads each jewel's radius lines; this file applies them to the
// passives inside a socketed jewel's area. Pure functions, run in Node and the browser.
//
// A jewel in a socket is a placement: {socket, choice, area}, where area is the set of node ids it reaches. The
// tree's effects are a list of effect lists, one per allocated node (the node's own effects array, so the node is
// known by it) plus jewels and mastery options; effectListsWithRadius gives the same list as the placements make it:
// each covered passive's effects changed by the rules, and what a jewel adds on its own (Unnatural Instinct's
// unallocated small passives, Transcendent Flesh's per-Strength lines).
//
// Areas: a size's radius round the socket (Small 960, Medium 1,440, Large 1,800 tree units, the game files' radii at
// the tree export's scale), a ring (Thread of Hope: between its inner and outer radius), or a size round a keystone
// (Impossible Escape). Small passives, notables and keystones count; jewel sockets and class starts don't. A rule
// changes small passives and notables only, as its wording says; keystones are reached only by free allocation.
//
// Timeless jewels are placements too, with one rule, "conquer" (scripts/timeless_conquest.py): each small passive
// and notable in their Large radius becomes what the conqueror makes it, for a typical seed. A conquered passive is
// the timeless jewel's alone: no other jewel's rule changes it (The Light of Meaning's "also grant", Might of the
// Meek, a transform), whichever was socketed first. Free allocation still reaches it, and Unnatural Instinct grants
// it as conquered. The keystone a timeless jewel conquers is the planner's (public/buildtree.js).

const PASSIVE_KINDS = new Set(['small', 'notable', 'keystone']);
const CHANGED_BY_DEFAULT = ['small', 'notable'];
const ATTRIBUTE_STATS = new Set(['strength', 'dexterity', 'intelligence']);

// ---------- the choices ----------
// The radius jewels a tree can hold, from the mechanics file's uniques: one choice per version, with its own lines
// (effects), its rules and its area. Impossible Escape's versions whose keystone isn't on the tree are left out.
export function radiusJewelChoices(uniques, tree, jewelRadii) {
  const choices = [];
  if (!tree || !jewelRadii) {
    return choices;
  }
  for (const unique of uniques) {
    if (!unique.radius || !unique.radius.rules || unique.radius.rules.length === 0) {
      continue;
    }
    const area = areaSpecOf(unique.radius, tree, jewelRadii);
    if (area === null) {
      continue;
    }
    choices.push({
      key: 'radius:' + unique.name, kind: 'radius', name: unique.name, baseName: unique.baseName || unique.name,
      effects: unique.effects || [], rules: unique.radius.rules, area, limit: unique.limit ?? null, points: 0,
      free: unique.radius.rules.some(rule => rule.rule === 'free'),
    });
  }
  return choices;
}

// {inner, outer, around}: the distances from the centre that count (inner excluded, outer included), and the
// keystone node at the centre when it isn't the socket. Null when the size or the keystone is unknown.
function areaSpecOf(radius, tree, jewelRadii) {
  if (radius.ring) {
    const ring = jewelRadii[radius.ring];
    return ring ? { inner: ring.ringInner, outer: ring.ringOuter, around: null } : null;
  }
  const size = jewelRadii[radius.size];
  if (!size) {
    return null;
  }
  if (radius.around) {
    const keystoneId = keystoneIdNamed(tree, radius.around);
    return keystoneId === null ? null : { inner: -1, outer: size.radius, around: keystoneId };
  }
  return { inner: -1, outer: size.radius, around: null };
}

function keystoneIdNamed(tree, name) {
  for (const [id, node] of tree.nodes) {
    if (node.kind === 'keystone' && node.name === name) {
      return id;
    }
  }
  return null;
}

// ---------- areas ----------
// The passives a choice reaches from a socket, kept per tree (sockets and sizes repeat across every plan).
export function areaOf(tree, socketId, choice) {
  const centreId = choice.area.around || socketId;
  const key = centreId + '|' + choice.area.inner + '|' + choice.area.outer;
  tree.radiusAreas ??= new Map();
  if (!tree.radiusAreas.has(key)) {
    tree.radiusAreas.set(key, nodesBetween(tree, tree.nodes.get(centreId), choice.area.inner, choice.area.outer));
  }
  return tree.radiusAreas.get(key);
}

function nodesBetween(tree, centre, inner, outer) {
  const ids = new Set();
  if (!centre || !centre.position) {
    return ids;
  }
  for (const node of tree.nodes.values()) {
    if (!PASSIVE_KINDS.has(node.kind) || !node.position) {
      continue;
    }
    const distance = Math.hypot(node.position.x - centre.position.x, node.position.y - centre.position.y);
    if (distance > inner && distance <= outer) {
      ids.add(node.id);
    }
  }
  return ids;
}

export function placementOf(tree, socketId, choice) {
  return { socket: socketId, choice, area: areaOf(tree, socketId, choice) };
}

// ---------- the tree's effects with the placements ----------
// Which node an effect list belongs to: the planner keeps each allocated node's own effects array.
function ownerOf(tree, effects) {
  if (!tree.ownerOfEffects) {
    tree.ownerOfEffects = new Map();
    for (const node of tree.nodes.values()) {
      tree.ownerOfEffects.set(node.effects, node);
    }
  }
  return tree.ownerOfEffects.get(effects) || null;
}

// The effect lists as the placements make them. allocated: the ids of the allocated nodes (for the jewels that count
// what is, or isn't, allocated in their area).
export function effectListsWithRadius(tree, effectLists, allocated, placements) {
  if (!placements || placements.length === 0) {
    return effectLists;
  }
  const adjusted = [];
  for (const effects of effectLists) {
    const node = ownerOf(tree, effects);
    if (node === null) {
      adjusted.push(effects);
      continue;
    }
    adjusted.push(nodeEffectsWith(node, placements));
  }
  for (const placement of placements) {
    const added = jewelAdditions(tree, placement, allocated, placements);
    if (added.length > 0) {
      adjusted.push(added);
    }
  }
  return adjusted;
}

// What one allocated node gives under the placements whose area covers it, in the order they were placed; a
// conquered node gives what its timeless jewel makes it, and nothing else changes it.
export function nodeEffectsWith(node, placements) {
  const conquest = conquestOver(node, placements);
  if (conquest !== null) {
    return conqueredEffects(node, conquest);
  }
  let effects = node.effects;
  for (const placement of placements) {
    if (!placement.area.has(node.id)) {
      continue;
    }
    for (const rule of placement.choice.rules) {
      effects = applyRule(rule, node, effects);
    }
  }
  return effects;
}

// The planner's estimate of what allocating a node adds under the placements: what it gives allocated, less what it
// gave unallocated (a small passive inside Unnatural Instinct's area gives its bonus only while unallocated, so
// taking it loses that bonus).
export function nodeGainEffects(node, placements) {
  const given = nodeEffectsWith(node, placements);
  for (const placement of placements) {
    if (!placement.area.has(node.id)) {
      continue;
    }
    for (const rule of placement.choice.rules) {
      if (rule.rule === 'unallocated' && rule.nodes.includes(node.kind)) {
        return [...given, ...negated(unallocatedEffects(node, placements))];
      }
    }
  }
  return given;
}

// What an unallocated passive gives a jewel that grants it (Unnatural Instinct): its own effects, or the conquered
// ones under a timeless jewel.
function unallocatedEffects(node, placements) {
  const conquest = conquestOver(node, placements);
  return conquest === null ? node.effects : conqueredEffects(node, conquest);
}

// ---------- timeless jewels: conquered passives ----------
// The conquer rule of the timeless jewel whose area covers this small passive or notable, or null.
export function conquestOver(node, placements) {
  if (node.kind !== 'small' && node.kind !== 'notable') {
    return null;
  }
  for (const placement of placements) {
    if (!placement.area.has(node.id)) {
      continue;
    }
    for (const rule of placement.choice.rules) {
      if (rule.rule === 'conquer') {
        return rule;
      }
    }
  }
  return null;
}

// A conquered passive's effects, kept per rule (every plan asks for the same passives again):
// - a small passive: a "+X to an attribute" one (small attribute) or another, each either replaced by the
//   conqueror's typical small passive or keeping its stats with the typical additions (Lethal Pride's +4 Strength);
// - a notable: replaced at the conqueror's share (Glorious Vanity always, Militant Faith one in five), otherwise
//   kept with the typical addition. A share is counted as a share of each number; a rule without a number stays
//   while the notable is usually kept.
const conquestCache = new WeakMap();

export function conqueredEffects(node, rule) {
  if (!conquestCache.has(rule)) {
    conquestCache.set(rule, new Map());
  }
  const cache = conquestCache.get(rule);
  if (!cache.has(node.id)) {
    cache.set(node.id, node.kind === 'notable' ? conqueredNotable(node, rule.notable) : conqueredSmall(node, rule));
  }
  return cache.get(node.id);
}

function conqueredSmall(node, rule) {
  const part = isAttributePassive(node) ? rule.smallAttribute : rule.small;
  if (part.replaced) {
    return part.effects;
  }
  return [...node.effects, ...part.effects];
}

function conqueredNotable(node, notable) {
  const replacedShare = notable.replacedShare;
  if (replacedShare >= 1) {
    return notable.replacement;
  }
  const keptShare = 1 - replacedShare;
  const effects = [];
  for (const effect of node.effects) {
    if (typeof effect.value === 'number') {
      effects.push({ ...effect, value: effect.value * keptShare });
    } else if (keptShare >= 0.5) {
      effects.push(effect);
    }
  }
  for (const effect of notable.addition) {
    effects.push({ ...effect, value: effect.value * keptShare });
  }
  for (const effect of notable.replacement) {
    effects.push({ ...effect, value: effect.value * replacedShare });
  }
  return effects;
}

// "+10 to Strength", "+10 to Dexterity", "+10 to Intelligence": the game's small attribute passives, which the
// conquerors treat apart from the other small passives.
function isAttributePassive(node) {
  if (node.kind !== 'small' || node.effects.length === 0) {
    return false;
  }
  return node.effects.every(effect => effect.kind === 'flat' && (ATTRIBUTE_STATS.has(effect.stat) || effect.stat === 'attributes')
    && (effect.subject || 'self') === 'self' && !effect.condition);
}

function applyRule(rule, node, effects) {
  const kinds = rule.nodes || CHANGED_BY_DEFAULT;
  if (!kinds.includes(node.kind)) {
    return effects;
  }
  if (rule.rule === 'nothing') {
    return [];
  }
  if (rule.rule === 'instead') {
    return rule.effects;
  }
  if (rule.rule === 'scale') {
    return effects.map(effect => scaled(effect, rule.factor));
  }
  if (rule.rule === 'transform') {
    return transformed(effects, rule);
  }
  if (rule.rule === 'retag') {
    return effects.map(effect => retagged(effect, rule));
  }
  if (rule.rule === 'also') {
    return [...effects, ...rule.effects];
  }
  if (rule.rule === 'alsoFromResistance') {
    return withResistanceBonus(effects, rule);
  }
  return effects; // free, unallocated, perAttribute and threshold work on the jewel's area as a whole; conquer
  // comes before every rule (nodeEffectsWith)
}

function scaled(effect, factor) {
  if (effect.value === undefined || effect.value === null || effect.kind === 'flag') {
    return effect;
  }
  return { ...effect, value: effect.value * factor };
}

function negated(effects) {
  const result = [];
  for (const effect of effects) {
    if (effect.value === undefined || effect.value === null || effect.kind === 'flag') {
      continue; // a rule with no number can't be taken away in an estimate; the exact score sees it
    }
    result.push({ ...effect, value: -effect.value });
  }
  return result;
}

// "Increases and Reductions to Life in Radius are Transformed to apply to Energy Shield": the character's own
// increased Life (not a minion's or a golem's) becomes increased Energy Shield. "Strength from Passives in Radius is
// Transformed to Intelligence": the Strength, and the Strength share of "+X to all Attributes".
function transformed(effects, rule) {
  const result = [];
  for (const effect of effects) {
    if (isOwnUntagged(effect) && effect.kind === rule.from.kind && effect.stat === rule.from.stat) {
      result.push({ ...effect, stat: rule.to, value: effect.value * rule.factor });
      continue;
    }
    result.push(effect);
    if (ATTRIBUTE_STATS.has(rule.from.stat) && isOwnUntagged(effect) && effect.kind === 'flat' && effect.stat === 'attributes') {
      result.push({ kind: 'flat', stat: rule.from.stat, value: -effect.value });
      result.push({ kind: 'flat', stat: rule.to, value: effect.value * rule.factor });
    }
  }
  return result;
}

function isOwnUntagged(effect) {
  return (effect.subject || 'self') === 'self' && (!effect.tags || effect.tags.length === 0) && !effect.condition
    && typeof effect.value === 'number';
}

// Lioneye's Fall: a melee or melee weapon tag, as a scope or a requirement, becomes the bow tag.
function retagged(effect, rule) {
  const tags = retaggedList(effect.tags, rule);
  const requires = retaggedList(effect.requires, rule);
  if (tags === effect.tags && requires === effect.requires) {
    return effect;
  }
  const changed = { ...effect };
  if (tags !== undefined) {
    changed.tags = tags;
  }
  if (requires !== undefined) {
    changed.requires = requires;
  }
  return changed;
}

function retaggedList(list, rule) {
  if (!list || !list.some(tag => rule.from.includes(tag))) {
    return list;
  }
  const result = [];
  for (const tag of list) {
    const replaced = rule.from.includes(tag) ? rule.to : tag;
    if (!result.includes(replaced)) {
      result.push(replaced);
    }
  }
  return result;
}

// The Nightmares and Dreams: a passive with a resistance of the named elements ("Fire Resistance or all Elemental
// Resistances") also gives the rule's effects, valued at that resistance times the rule's factor.
function withResistanceBonus(effects, rule) {
  let resistance = 0;
  for (const effect of effects) {
    if (effect.kind !== 'resistance' || effect.stat !== 'resistance' || (effect.subject || 'self') !== 'self') {
      continue;
    }
    if (effect.condition || !(effect.tags || []).some(tag => rule.resistances.includes(tag))) {
      continue;
    }
    resistance += effect.value || 0;
  }
  if (resistance <= 0) {
    return effects;
  }
  const bonus = rule.effects.map(effect => ({ ...effect, value: effect.value * resistance * rule.factor }));
  return [...effects, ...bonus];
}

// What a jewel adds from its area as a whole: the unallocated small passives' bonuses (Unnatural Instinct), its
// lines per 10 of an attribute on allocated or unallocated passives (Transcendent Flesh), and its lines once the
// allocated passives give enough of an attribute ("With at least 40 Intelligence in Radius"). Attributes are
// counted on the passives' own lines, before any rule changes them, as the game counts them. placements: all the
// jewels socketed (with this one), so a conquered passive is granted as conquered.
export function jewelAdditions(tree, placement, allocated, placements = [placement]) {
  const added = [];
  for (const rule of placement.choice.rules) {
    if (rule.rule === 'unallocated') {
      for (const id of placement.area) {
        const node = tree.nodes.get(id);
        if (!allocated.has(id) && rule.nodes.includes(node.kind)) {
          added.push(...unallocatedEffects(node, placements));
        }
      }
    } else if (rule.rule === 'perAttribute') {
      const amount = attributeInArea(tree, placement.area, allocated, rule.attributes, rule.on === 'allocated');
      const times = Math.floor(amount / rule.per);
      if (times > 0) {
        for (const effect of rule.effects) {
          added.push(scaled(effect, times));
        }
      }
    } else if (rule.rule === 'threshold') {
      if (attributeInArea(tree, placement.area, allocated, rule.attributes, true) >= rule.amount) {
        added.push(...rule.effects);
      }
    }
  }
  return added;
}

function attributeInArea(tree, area, allocated, attributes, onAllocated) {
  let amount = 0;
  for (const id of area) {
    if (allocated.has(id) !== onAllocated) {
      continue;
    }
    for (const effect of tree.nodes.get(id).effects) {
      if (effect.kind !== 'flat' || (effect.subject || 'self') !== 'self' || effect.condition) {
        continue;
      }
      if (attributes.includes(effect.stat)) {
        amount += effect.value || 0;
      } else if (effect.stat === 'attributes') {
        amount += (effect.value || 0) * attributes.length;
      }
    }
  }
  return amount;
}

// ---------- free allocation ----------
// The passives a placed free-allocation jewel (Intuitive Leap, Thread of Hope, Impossible Escape) lets the tree take
// without a path: every one in its area not yet allocated.
export function freeTargets(placements, allocated, forbidden) {
  const targets = new Set();
  for (const placement of placements) {
    if (!placement.choice.free) {
      continue;
    }
    for (const id of placement.area) {
      if (!allocated.has(id) && !forbidden.has(id)) {
        targets.add(id);
      }
    }
  }
  return targets;
}
