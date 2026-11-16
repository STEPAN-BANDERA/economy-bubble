// Tags: what every piece the build planner knows is about, so a search can skip what can't help a build instead of
// measuring it. Every support, ascendancy notable, keystone, unique, aura, curse, flask, jewel modifier, cluster
// notable, tree node and mastery option is tagged from its own effects, as scripts/mechanics_vocabulary.py read
// them: "40% increased Cold Damage with Spells" is tagged cold and spell, "+50 to maximum Life" is generic.
//
// The tags are ours. Path of Building marks its mods the same way (two bit masks: how the damage is dealt, which
// must all match, and keywords, any of which match), which is where the idea is checked, but nothing here is
// read from it.
//
// Whether a tagged piece fits a build is decided by the engine's own rule (effectCanMatter in buildgen.js), so a
// skipped piece is exactly one whose every effect would add nothing: the tags never change a plan, they only
// spare the planner the work and say what was skipped. The "wide search" ignores them and measures everything.
import { effectCanMatter } from './buildgen.js';

// The tags shown for each group, in display order. A tag outside these groups (a skill name, a rare scope) is
// listed under "other".
export const TAG_GROUPS = [
  { id: 'damage', label: 'Damage type', tags: ['physical', 'fire', 'cold', 'lightning', 'chaos', 'elemental', 'nonChaos'] },
  { id: 'delivery', label: 'How it hits', tags: ['attack', 'spell', 'melee', 'projectile', 'area', 'dot', 'ailment', 'ignite', 'bleed', 'poison', 'chain', 'channel', 'strike', 'slam'] },
  { id: 'playstyle', label: 'Playstyle', tags: ['minion', 'totem', 'trap', 'mine', 'brand'] },
  { id: 'weapon', label: 'Weapon', tags: ['sword', 'axe', 'mace', 'claw', 'dagger', 'staff', 'bow', 'wand', 'shield', 'oneHand', 'twoHand', 'dualWield'] },
  { id: 'generic', label: 'Generic', tags: ['generic'] },
];

// Who an effect is for, as a tag: lines about minions and totems only help builds that have them.
const SUBJECT_TAGS = { minion: 'minion', totem: 'totem' };

// The tags of one effect: its scope tags, the tags it requires, its subject when that is a minion or a totem, and
// the skill it names. An effect with none of these applies to any build: "generic".
export function tagsOfEffect(effect) {
  const tags = new Set();
  for (const tag of effect.tags || []) {
    tags.add(tag);
  }
  for (const tag of effect.requires || []) {
    tags.add(tag);
  }
  const subjectTag = SUBJECT_TAGS[effect.subject || 'self'];
  if (subjectTag) {
    tags.add(subjectTag);
  }
  if (effect.skill) {
    tags.add('skill:' + effect.skill);
  }
  if (tags.size === 0) {
    tags.add('generic');
  }
  return tags;
}

// The tags of a piece: every tag of every effect, sorted.
export function tagsOfPiece(piece) {
  const tags = new Set();
  for (const effect of piece.effects || []) {
    for (const tag of tagsOfEffect(effect)) {
      tags.add(tag);
    }
  }
  return [...tags].sort();
}

// Gives every piece of a prepared index (prepareMechanics) its tags, once. Returns the index.
export function tagIndex(index) {
  if (index.tagged) {
    return index;
  }
  for (const list of [index.supports, index.uniques, index.keystones, index.buffs, index.flasks, index.jewelMods]) {
    for (const piece of list || []) {
      piece.tags = tagsOfPiece(piece);
    }
  }
  for (const ascendancy of index.ascendancies || []) {
    for (const notable of ascendancy.notables) {
      notable.tags = tagsOfPiece(notable);
    }
  }
  for (const notable of index.bloodlineNotables || []) {
    notable.tags = tagsOfPiece(notable);
  }
  for (const cluster of index.largeClusters || []) {
    cluster.tags = tagsOfPiece({ effects: cluster.small });
    for (const notable of cluster.notables || []) {
      notable.tags = tagsOfPiece(notable);
    }
  }
  if (index.tree) {
    for (const node of index.tree.nodes.values()) {
      node.tags = tagsOfPiece(node);
    }
    for (const mastery of index.tree.masteries) {
      for (const option of mastery.options) {
        option.tags = tagsOfPiece(option);
      }
    }
  }
  index.tagged = true;
  return index;
}

// Whether a piece can help a build in this context (buildContext in buildgen.js): one of its effects can matter.
export function pieceFits(piece, context) {
  for (const effect of piece.effects || []) {
    if (effectCanMatter(effect, context)) {
      return true;
    }
  }
  return false;
}

// The pieces of a list that fit, and how many were skipped. A wide search keeps them all.
export function fittingPieces(pieces, context, wide) {
  if (wide) {
    return { kept: [...pieces], skipped: 0 };
  }
  const kept = [];
  let skipped = 0;
  for (const piece of pieces) {
    if (pieceFits(piece, context)) {
      kept.push(piece);
    } else {
      skipped += 1;
    }
  }
  return { kept, skipped };
}

// How many pieces of each kind the tags keep and skip for a build: what the planner reports with each plan.
export function tagReport(index, context) {
  const lists = [
    ['supports', index.supports], ['uniques', index.uniques], ['keystones', index.keystones], ['auras and curses', index.buffs],
    ['flasks', index.flasks], ['jewel modifiers', index.jewelMods],
  ];
  if (index.tree) {
    lists.push(['tree nodes', [...index.tree.nodes.values()].filter(node => node.effects.length > 0)]);
  }
  const report = [];
  for (const [kind, pieces] of lists) {
    const { kept, skipped } = fittingPieces(pieces || [], context, false);
    report.push({ kind, kept: kept.length, skipped });
  }
  return report;
}

// Which group a tag belongs to, for display.
export function groupOfTag(tag) {
  for (const group of TAG_GROUPS) {
    if (group.tags.includes(tag)) {
      return group.id;
    }
  }
  return 'other';
}
