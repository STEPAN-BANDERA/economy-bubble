// Tests the Build maker engine (public/builds.js) offline: `npm run test:builds`.
// A small hand-made league checks every rule against answers worked out by hand; then, when the real data
// files exist (npm run builds:build), a smoke check runs every question over them.
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const engine = await import(pathToFileURL(path.join(root, 'public', 'builds.js')).href);
const craftEngine = await import(pathToFileURL(path.join(root, 'public', 'craft.js')).href);

const failures = [];
function check(label, passed, detail = '') {
  console.log((passed ? 'ok   ' : 'FAIL ') + label + (passed ? '' : ' ' + detail));
  if (!passed) {
    failures.push(label);
  }
}

// ---------- a hand-made league ----------
const game = {
  classes: { Witch: ['Elementalist', 'Occultist'], Templar: ['Hierophant'] },
  skills: {
    'Winter Orb': { tags: ['Cold', 'Spell'], delivery: 'spell', weapon: null, damageTypes: ['cold'], hitOrDotGuess: 'hit' },
    'Righteous Fire': { tags: ['Spell', 'Fire'], delivery: 'spell', weapon: null, damageTypes: ['fire'], hitOrDotGuess: 'dot' },
    'Holy Flame Totem': { tags: ['Totem', 'Spell', 'Fire', 'Physical'], delivery: 'totem', weapon: null, damageTypes: ['fire', 'physical'], hitOrDotGuess: 'hit' },
    'Raise Spectre': { tags: ['Minion'], delivery: 'minion', weapon: null, damageTypes: [], hitOrDotGuess: 'hit' },
  },
};

function record(ascendancy, baseClass, skill, characters, extra) {
  return { baseClass, ascendancy, skill, characters, shareOfLeague: characters / 10000, levelMedian: 97, lifeMedian: 6000,
    energyShieldMedian: 200, ehpMedian: 80000, uniques: [], ...extra };
}

// The first 20 rank positions are filled with undetailed records (no levelMedian), so the detailed ones below
// sit outside the top 20 and can be niche, the way most real archetypes are.
const filler = [];
for (let index = 0; index < 20; index += 1) {
  filler.push({ baseClass: 'Witch', ascendancy: 'Occultist', skill: 'Filler ' + index, characters: 5000 - index, shareOfLeague: 0.5 });
}
const current = {
  league: 'Testflame', characters: 10000,
  archetypes: [
    ...filler,
    record('Occultist', 'Witch', 'Winter Orb', 900, { damageSplit: { cold: 100 }, hitShare: 1, energyShieldMedian: 9000, lifeMedian: 1,
      defences: { sampled: 5, armour: 3000, evasionRating: 25000, spellSuppressionChance: 100, blockChance: 10 },
      uniques: [['Mageblood', 0.5], ['Unpriced Thing', 0.2]] }),
    record('Elementalist', 'Witch', 'Winter Orb', 600, { damageSplit: { cold: 95 }, hitShare: 0.9,
      defences: { sampled: 5, armour: 40000, evasionRating: 1000, spellSuppressionChance: 20, blockChance: 60 },
      uniques: [['Cheap Ring', 1]] }),
    record('Hierophant', 'Templar', 'Holy Flame Totem', 300, { damageSplit: { fire: 60, physical: 40 }, hitShare: 1, energyShieldMedian: 3000 }),
    record('Elementalist', 'Witch', 'Righteous Fire', 200, { damageSplit: { fire: 100 }, hitShare: 0, ehpMedian: 20000 }),
    record('Occultist', 'Witch', 'Raise Spectre', 100, { hitShare: null, damageSplit: {} }),
  ],
};
const past = [{ league: 'Oldleague', archetypes: [{ ascendancy: 'Hierophant', skill: 'Holy Flame Totem', characters: 500 }] }];
const archetypes = engine.buildArchetypes(game, current, past);
const byId = new Map(archetypes.map(archetype => [archetype.id, archetype]));
const occultistOrb = byId.get('Occultist / Winter Orb');
const elementalistOrb = byId.get('Elementalist / Winter Orb');
const totem = byId.get('Hierophant / Holy Flame Totem');
const righteousFire = byId.get('Elementalist / Righteous Fire');
const spectre = byId.get('Occultist / Raise Spectre');

check('only detailed archetypes are offered', archetypes.length === 5, 'got ' + archetypes.length);
check('rank counts the undetailed ones too', occultistOrb.rank === 21, 'got ' + occultistOrb.rank);
check('energy shield pool from the medians', occultistOrb.traits.pool === 'es' && elementalistOrb.traits.pool === 'life' && totem.traits.pool === 'hybrid',
  [occultistOrb.traits.pool, elementalistOrb.traits.pool, totem.traits.pool].join());
check('layers from the sampled defences', occultistOrb.traits.layers.join() === 'evasion,suppression' && elementalistOrb.traits.layers.join() === 'armour,block',
  occultistOrb.traits.layers.join() + ' / ' + elementalistOrb.traits.layers.join());
check('no sample means no layer', totem.traits.layers.join() === 'none');
check('damage types over the 25% floor', totem.traits.damageTypes.join() === 'fire,physical');
check('damage types fall back to the skill\'s tags', spectre.traits.damageTypes.length === 0);
check('measured hit share decides hit or DoT', righteousFire.traits.hitOrDot === 'dot' && occultistOrb.traits.hitOrDot === 'hit');
check('no measurement falls back to the skill\'s guess', spectre.traits.hitOrDot === 'hit');
check('playstyle from the skill', totem.traits.playstyle === 'totem' && spectre.traits.playstyle === 'minion');
check('proven in a past league', totem.provenLeagues.join() === 'Oldleague' && occultistOrb.provenLeagues.length === 0);

// ---------- answering ----------
check('no answers keep every archetype', engine.remainingArchetypes(archetypes, {}).length === 5);
const witchCold = engine.remainingArchetypes(archetypes, { class: 'Witch', damage: 'cold' });
check('answers filter together', witchCold.length === 2 && witchCold.every(archetype => archetype.skill === 'Winter Orb'));
const ascendancyOptions = engine.optionsFor('ascendancy', archetypes, { class: 'Witch' });
const hierophantOption = ascendancyOptions.find(option => option.value === 'Hierophant');
check('a ruled-out option stays listed with nothing left', hierophantOption && hierophantOption.archetypes === 0);
let optionCharacters = 0;
for (const option of ascendancyOptions) {
  optionCharacters += option.characters;
}
check('single-valued options add up to the remaining players', optionCharacters === 900 + 600 + 200 + 100, 'got ' + optionCharacters);
check('options are sorted by players', ascendancyOptions[0].value === 'Occultist', ascendancyOptions[0].value);
check('a question ignores its own answer when listing options',
  engine.optionsFor('class', archetypes, { class: 'Witch' }).find(option => option.value === 'Templar').archetypes === 1);
const kept = engine.consistentAnswers(archetypes, { class: 'Templar', ascendancy: 'Occultist', damage: 'fire' });
check('answers that no longer fit are dropped, later ones kept', kept.class === 'Templar' && kept.ascendancy === undefined && kept.damage === 'fire',
  JSON.stringify(kept));
check('next question skips answered ones', engine.nextQuestion({ class: 'Witch' }).id === 'ascendancy');

// ---------- ranking ----------
const ranked = engine.rankArchetypes(archetypes);
check('ranking by share', ranked[0].id === 'Occultist / Winter Orb', ranked[0].id);
check('a proven league adds a quarter', Math.abs(engine.scoreOf(totem) - 0.03 * 1.25) < 1e-12);
const rankedAgain = engine.rankArchetypes([...archetypes].reverse());
check('ranking is stable whatever the input order', ranked.map(archetype => archetype.id).join() === rankedAgain.map(archetype => archetype.id).join());

// ---------- prices ----------
const prices = { Mageblood: 30000, 'Cheap Ring': 50 };
engine.priceArchetypes(archetypes, name => prices[name] ?? null, 200);
check('cost is price times share', occultistOrb.cost.chaos === 15000 && occultistOrb.cost.divines === 75, JSON.stringify(occultistOrb.cost));
check('unpriced uniques are counted as unpriced', occultistOrb.cost.unpricedUniques === 1);
check('budget bands', occultistOrb.traits.budget === 'expensive' && elementalistOrb.traits.budget === 'cheap', occultistOrb.traits.budget + ' ' + elementalistOrb.traits.budget);
check('no uniques costs nothing', totem.cost.chaos === 0 && totem.traits.budget === 'cheap');

// ---------- the spin wheel ----------
const firstSpin = engine.spinWheel(archetypes, {}, engine.mulberry32(42));
const secondSpin = engine.spinWheel(archetypes, {}, engine.mulberry32(42));
check('a seeded spin repeats', firstSpin.candidates.map(archetype => archetype.id).join() === secondSpin.candidates.map(archetype => archetype.id).join()
  && firstSpin.winnerIndex === secondSpin.winnerIndex);
check('the wheel holds only niche, playable builds', firstSpin.nicheOnly && firstSpin.candidates.every(engine.isNicheButPlayable));
check('a low-EHP build is not playable', !engine.isNicheButPlayable(righteousFire));
check('the winner is one of the candidates', firstSpin.winnerIndex >= 0 && firstSpin.winnerIndex < firstSpin.candidates.length);
const noNiche = engine.spinWheel(archetypes, { ascendancy: 'Elementalist', damage: 'fire' }, engine.mulberry32(1));
check('with no niche build the wheel falls back and says so', !noNiche.nicheOnly && noNiche.candidates.length === 1);
const nothing = engine.spinWheel(archetypes, { class: 'Templar', damage: 'cold' }, engine.mulberry32(1));
check('answers that leave nothing give an empty wheel', nothing.candidates.length === 0 && nothing.winnerIndex === -1);

// ---------- links and the random generator ----------
const answers = { class: 'Witch', damage: 'cold', ascendancy: 'Occultist' };
const encoded = engine.encodeAnswers(answers);
check('answers encode in question order', encoded === 'class:Witch,ascendancy:Occultist,damage:cold', encoded);
check('answers decode back', JSON.stringify(engine.decodeAnswers(encoded)) === JSON.stringify({ class: 'Witch', ascendancy: 'Occultist', damage: 'cold' }));
check('unknown questions in a link are ignored', Object.keys(engine.decodeAnswers('nonsense:1,class:Witch')).join() === 'class');
check('a name with a comma survives', engine.decodeAnswers(engine.encodeAnswers({ ascendancy: 'A, B' })).ascendancy === 'A, B');
const ours = engine.mulberry32(12345);
const crafts = craftEngine.mulberry32(12345);
let sameNumbers = true;
for (let index = 0; index < 1000; index += 1) {
  if (ours() !== crafts()) {
    sameNumbers = false;
  }
}
check('mulberry32 matches public/craft.js', sameNumbers);

// ---------- the real data, when built ----------
const buildsDirectory = path.join(root, 'public', 'data', 'builds');
const leaguesFile = path.join(buildsDirectory, 'leagues-poe1.json');
if (fs.existsSync(leaguesFile)) {
  const leagues = JSON.parse(fs.readFileSync(leaguesFile, 'utf8')).leagues;
  const realGame = JSON.parse(fs.readFileSync(path.join(buildsDirectory, 'game-poe1.json'), 'utf8'));
  const currentLeague = leagues.find(league => league.current);
  check('the real data has a running league', !!currentLeague);
  if (currentLeague) {
    const realCurrent = JSON.parse(fs.readFileSync(path.join(buildsDirectory, currentLeague.file), 'utf8'));
    const realPast = [];
    for (const league of leagues) {
      if (!league.current) {
        realPast.push(JSON.parse(fs.readFileSync(path.join(buildsDirectory, league.file), 'utf8')));
      }
    }
    const realArchetypes = engine.buildArchetypes(realGame, realCurrent, realPast);
    check('real: archetypes to offer', realArchetypes.length >= 50, 'got ' + realArchetypes.length);
    const defencesSampled = realArchetypes.some(archetype => archetype.defences && archetype.defences.sampled);
    for (const question of engine.QUESTIONS) {
      if (question.id === 'budget') {
        continue; // priced in the browser
      }
      if (question.id === 'layer' && !defencesSampled) {
        // Defence layers need characters opened (off by default, poe.ninja rate limits it); the tab skips the question.
        check('real: no defences sampled, so the layer question is skipped', engine.optionsFor('layer', realArchetypes, {}).length < 2);
        continue;
      }
      const options = engine.optionsFor(question.id, realArchetypes, {});
      check('real: ' + question.id + ' has a choice', options.length >= 2, 'got ' + options.map(option => option.value).join());
    }
    const realSpin = engine.spinWheel(realArchetypes, {}, engine.mulberry32(7));
    check('real: the wheel finds niche builds', realSpin.nicheOnly && realSpin.candidates.length > 0, 'got ' + realSpin.candidates.length);
  }
} else {
  console.log('(no public/data/builds yet: run npm run builds:build for the real-data checks)');
}

// ---------- the generator (public/buildgen.js) ----------
const generator = await import(pathToFileURL(path.join(root, 'public', 'buildgen.js')).href);

// Support rules: GGG's postfix expressions, the way Path of Building reads them.
const spellAndTotemable = ['Spell', 'Totemable', 'AND'];
check('rules: AND needs both types', generator.typeExpressionMatches(spellAndTotemable, new Set(['Spell', 'Totemable'])));
check('rules: AND fails with one type', !generator.typeExpressionMatches(spellAndTotemable, new Set(['Spell'])));
check('rules: a plain list means any of them', generator.typeExpressionMatches(['Attack', 'Spell'], new Set(['Spell'])));
check('rules: NOT flips a match', !generator.typeExpressionMatches(['Spell', 'NOT'], new Set(['Spell'])));

function supportFixture(name, allowed, added = [], excluded = [], extra = {}) {
  return { name, allowed, added, excluded, addedMinion: [], gemsOnly: false, ignoreMinionTypes: false, weapons: [], effects: [], ...extra };
}
const spellTotem = supportFixture('Spell Totem Support', spellAndTotemable, ['SummonsTotem']);
const multipleTotems = supportFixture('Multiple Totems Support', ['SummonsTotem']);
const meleeOnly = supportFixture('Melee Physical Damage Support', ['Melee']);
const fixtureSpell = { name: 'Fixture Bolt', types: ['Spell', 'Totemable', 'Damage'], minionTypes: [] };
check('rules: Multiple Totems does not fit a plain spell',
  generator.supportFits(multipleTotems, generator.typesWithSupports(fixtureSpell, []), new Set(), true) === null);
check('rules: Spell Totem makes the spell a totem skill, so Multiple Totems fits',
  generator.supportFits(multipleTotems, generator.typesWithSupports(fixtureSpell, [spellTotem]), new Set(), true) === 'skill');
check('rules: a melee support reaches a summoner\'s minions only',
  generator.supportFits(meleeOnly, new Set(['Spell', 'CreatesMinion']), new Set(['Attack', 'Melee']), true) === 'minion');
check('rules: excluded types win over allowed ones',
  generator.supportFits(supportFixture('Echo', ['Spell'], [], ['SummonsTotem']), new Set(['Spell', 'SummonsTotem']), new Set(), true) === null);

const mechanicsFile = path.join(buildsDirectory, 'mechanics-poe1.json');
const generatedFile = path.join(buildsDirectory, 'generated-poe1.json');
if (fs.existsSync(mechanicsFile) && fs.existsSync(generatedFile)) {
  const index = generator.prepareMechanics(JSON.parse(fs.readFileSync(mechanicsFile, 'utf8')));
  const generated = JSON.parse(fs.readFileSync(generatedFile, 'utf8'));
  const named = (list, name) => list.find(entry => entry.name === name);

  // The same question twice gives the same build.
  const arc = named(index.skills, 'Arc');
  const elementalist = named(index.ascendancies, 'Elementalist');
  const firstArc = generator.bestBuildFor(arc, elementalist, index);
  const secondArc = generator.bestBuildFor(arc, elementalist, index);
  const namesOf = result => JSON.stringify([result.build.supports.map(entry => entry.support.name), result.build.notables.map(n => n.name), result.build.uniques.map(u => u.name)]);
  check('generator: deterministic', namesOf(firstArc) === namesOf(secondArc));
  const arcSupports = firstArc.build.supports.map(entry => entry.support.name);
  check('generator: Arc gets lightning supports', arcSupports.some(name => /Lightning/.test(name)), arcSupports.join(', '));

  // Every stored build is one a character could actually wear.
  let duplicates = 0;
  let impossibleHands = 0;
  let triggerSupports = 0;
  let borrowedTooMany = 0;
  let overReserved = 0;
  let twoCurses = 0;
  let unreadable = 0;
  for (const stored of generated.builds) {
    for (const field of ['supports', 'notables', 'keystones', 'uniques', 'buffs', 'flasks']) {
      if (new Set(stored[field] || []).size !== (stored[field] || []).length) {
        duplicates += 1;
      }
    }
    const build = generator.rebuildFromNames(stored, index);
    if (!build) {
      unreadable += 1;
      continue;
    }
    if (stored.value && !generator.rebuildFromNames({ ...stored, ...stored.value }, index)) {
      unreadable += 1;
    }
    const twoHanded = build.uniques.some(unique => unique.twoHanded);
    const shield = build.uniques.some(unique => unique.category === 'Shield');
    if (twoHanded && shield) {
      impossibleHands += 1;
    }
    if (build.supports.some(entry => entry.support.trigger)) {
      triggerSupports += 1;
    }
    if (build.ascendancy.notables.length > 12 && build.notables.length > 2) {
      borrowedTooMany += 1;
    }
    let reserved = 0;
    let curses = 0;
    for (const buff of build.buffs) {
      reserved += buff.reservation;
      if (buff.kind === 'curse') {
        curses += 1;
      }
    }
    if (reserved > 100) {
      overReserved += 1;
    }
    if (curses > 1) {
      twoCurses += 1;
    }
  }
  check('generator: every stored build rebuilds from the mechanics file', unreadable === 0, unreadable + ' did not');
  check('generator: no piece twice in a build', duplicates === 0, duplicates + ' builds');
  check('generator: no two-handed weapon with a shield', impossibleHands === 0, impossibleHands + ' builds');
  check('generator: no trigger supports (not modelled yet)', triggerSupports === 0, triggerSupports + ' builds');
  check('generator: Ascendant and Reliquarian take at most two notables', borrowedTooMany === 0, borrowedTooMany + ' builds');
  check('generator: auras and heralds within the reservation budget', overReserved === 0, overReserved + ' builds');
  check('generator: at most one curse', twoCurses === 0, twoCurses + ' builds');
  // Auras and curses: a fire spell is helped by Flammability, a physical attack by an aura that adds damage to it.
  const fireball = generator.bestBuildFor(named(index.skills, 'Fireball'), named(index.ascendancies, 'Elementalist'), index);
  const fireballBuffs = fireball.build.buffs.map(buff => buff.name);
  check('buffs: Fireball curses with Flammability or Elemental Weakness',
    fireballBuffs.includes('Flammability') || fireballBuffs.includes('Elemental Weakness'), fireballBuffs.join(', '));
  // Weapons: a skill usable with many weapons gets only the held weapon's tree lines (a staff block line does
  // nothing for a sword Cyclone).
  const cyclone = generator.bestBuildFor(named(index.skills, 'Cyclone'), named(index.ascendancies, 'Gladiator'), index).build;
  const otherWeapon = cyclone.weapon === 'staff' ? 'sword' : 'staff';
  const staffBlock = { name: 'Test staff block', effects: [{ kind: 'flat', stat: 'block', value: 30, requires: [otherWeapon] }] };
  const withStaffBlock = { ...cyclone, notables: [...cyclone.notables, staffBlock] };
  check('weapons: another weapon\'s lines do nothing', generator.evaluateBuild(withStaffBlock).ehp === generator.evaluateBuild(cyclone).ehp,
    cyclone.weapon + ' build, ' + otherWeapon + ' line');
  const auraOnMinions = index.buffs.find(buff => buff.name === 'Hatred');
  check('buffs: an aura reaches minions too', auraOnMinions && auraOnMinions.effects.some(effect => effect.subject === 'minion'));
  // Two scores. With every unique made very dear, the power plan is unchanged (it never sees a price) and the value
  // plan buys none; both report the build's power.
  const pricedIndex = generator.prepareMechanics(JSON.parse(fs.readFileSync(mechanicsFile, 'utf8')));
  const dearPrices = {};
  for (const unique of pricedIndex.uniques) {
    dearPrices[unique.name] = 1e9;
  }
  generator.attachPrices(pricedIndex, dearPrices, 1);
  const fireballSkill = named(pricedIndex.skills, 'Fireball');
  const fireballAscendancy = named(pricedIndex.ascendancies, 'Elementalist');
  const powerFireball = generator.bestBuildFor(fireballSkill, fireballAscendancy, pricedIndex);
  const blindFireball = generator.bestBuildFor(named(index.skills, 'Fireball'), named(index.ascendancies, 'Elementalist'), index);
  check('prices: the power plan never sees a price', namesOf(powerFireball) === namesOf(blindFireball));
  const valueFireball = generator.bestBuildFor(fireballSkill, fireballAscendancy, pricedIndex, { priced: true });
  check('prices: the value plan buys nothing when every unique is priceless', valueFireball.build.uniques.length === 0, valueFireball.build.uniques.map(u => u.name).join(', '));
  check('prices: the value plan reports its power', Math.abs(valueFireball.evaluation.score - generator.evaluateBuild(valueFireball.build).score) < 1e-9);
  check('prices: value is power over the price penalty', generator.valueScore(powerFireball.build) < powerFireball.evaluation.score);
  const unlisted = { ...named(pricedIndex.uniques, 'Goldrim'), price: null };
  check('prices: an unlisted unique counts as 20 Divines', generator.costOf({ uniques: [unlisted] }) === 20);
  check('prices: without prices there is no cost', generator.costOf({ uniques: [named(index.uniques, 'Goldrim')] }) === null);
  // Effective HP: nothing defensive is the index's 1; armour, a shield's block and endurance charges each raise it.
  const bareArc = { skill: arc, ascendancy: named(index.ascendancies, 'Elementalist'), weapon: 'staff', ailment: null,
    supports: [], notables: [], keystones: [], uniques: [], buffs: [], flasks: [] };
  const bareDefence = generator.evaluateBuild(bareArc).defence;
  check('defence: a build with nothing defensive is about 1', Math.abs(bareDefence - 1) < 0.05, bareDefence.toFixed(3));
  const withDetermination = generator.evaluateBuild({ ...bareArc, buffs: [index.buffs.find(buff => buff.name === 'Determination')] }).defence;
  check('defence: Determination raises effective HP', withDetermination > bareDefence * 1.05, withDetermination.toFixed(2));
  const withShield = generator.evaluateBuild({ ...bareArc, weapon: 'shield' }).defence;
  check('defence: a shield’s block raises effective HP', withShield > bareDefence * 1.1, withShield.toFixed(2));
  const juggernaut = named(index.ascendancies, 'Juggernaut');
  const unflinching = juggernaut.notables.find(notable => notable.name === 'Unflinching');
  const withCharges = generator.evaluateBuild({ ...bareArc, ascendancy: juggernaut, notables: [unflinching] }).defence;
  check('defence: endurance charges raise effective HP', withCharges > bareDefence * 1.05, withCharges.toFixed(2));
  // Flasks: a Granite Flask's armour helps at its uptime, flask duration raises it; ES recharge helps an ES build.
  const granite = index.flasks.find(flask => flask.name === 'Granite Flask');
  check('flasks: the data has utility flasks with their buffs', granite && granite.effects.some(effect => effect.stat === 'armour'));
  const withGranite = generator.evaluateBuild({ ...bareArc, flasks: [granite] }).defence;
  check('flasks: a Granite Flask raises effective HP', withGranite > bareDefence * 1.01, withGranite.toFixed(3));
  const longerFlasks = { name: 'test', effects: [{ kind: 'increased', stat: 'flaskDuration', value: 100 }] };
  const withLongerGranite = generator.evaluateBuild({ ...bareArc, flasks: [granite], notables: [longerFlasks] }).defence;
  check('flasks: longer flask duration means more uptime', withLongerGranite > withGranite, withLongerGranite.toFixed(3));
  const esBuild = { name: 'test', effects: [{ kind: 'flat', stat: 'energyShield', value: 3000 }] };
  const rechargeRate = { name: 'test rate', effects: [{ kind: 'increased', stat: 'esRecharge', value: 100 }] };
  const esOnly = generator.evaluateBuild({ ...bareArc, notables: [esBuild] }).defence;
  const esWithRecharge = generator.evaluateBuild({ ...bareArc, notables: [esBuild, rechargeRate] }).defence;
  check('defence: faster energy shield recharge raises effective HP', esWithRecharge > esOnly, esWithRecharge.toFixed(3) + ' vs ' + esOnly.toFixed(3));
  // Ready-build rules: capped suppression is worth more than twice half of it; a guard-only defence counts for less
  // than the same always on; a build far under 3,000 life is cut hard.
  const line = (stat, value, extra = {}) => ({ name: stat + value, effects: [{ kind: 'flat', stat, value, ...extra }] });
  const defenceWith = notables => generator.evaluateBuild({ ...bareArc, notables }).defence;
  const halfSuppress = defenceWith([line('suppress', 50)]) - bareDefence;
  const fullSuppress = defenceWith([line('suppress', 100)]) - bareDefence;
  check('ready: capped suppression is worth more than twice half of it', fullSuppress > 2.5 * halfSuppress, fullSuppress.toFixed(3) + ' vs ' + halfSuppress.toFixed(3));
  const alwaysReduction = defenceWith([line('physicalReduction', 20)]);
  const guardReduction = defenceWith([line('physicalReduction', 20, { condition: 'guard' })]);
  const guardAtUptimeOnly = 1 + (alwaysReduction - 1) * 0.35;
  check('ready: a guard-only defence counts for less than its uptime', guardReduction < guardAtUptimeOnly, guardReduction.toFixed(3) + ' vs ' + guardAtUptimeOnly.toFixed(3));
  const lessLife = { name: 'less life', effects: [{ kind: 'more', stat: 'life', value: -60 }] };
  const lowLifeEvaluation = generator.evaluateBuild({ ...bareArc, notables: [lessLife] });
  check('ready: a build far under 3,000 life loses most of its effective HP', lowLifeEvaluation.defence < 0.3, lowLifeEvaluation.defence.toFixed(3) + ' at ' + Math.round(lowLifeEvaluation.life) + ' life');
  // Weapon rules come from the game files: Lightning Arrow is a bow skill, a transfigured Kinetic Blast a wand one.
  // (The item class lookup used plural display names and matched nothing, so every weapon was guessed.)
  check('weapons: Lightning Arrow needs a bow', JSON.stringify(named(index.skills, 'Lightning Arrow').weapons) === '["bow"]');
  check('weapons: Kinetic Blast of Clustering needs a wand', named(index.skills, 'Kinetic Blast of Clustering').weapons.includes('wand'));
  // Attack DPS: an attack gets a sheet figure from its weapon, a spell doesn't.
  const lightningArrow = generator.bestBuildFor(named(index.skills, 'Lightning Arrow'), named(index.ascendancies, 'Deadeye'), index);
  check('dps: an attack build has a sheet DPS', lightningArrow.evaluation.dps > 10000, String(Math.round(lightningArrow.evaluation.dps)));
  check('dps: a spell build has none', firstArc.evaluation.dps == null);
  // Jewels: the data has rare jewel modifiers and large cluster types with notables.
  check('jewels: rare jewel modifiers are read', (index.jewelMods || []).length > 100, String((index.jewelMods || []).length));
  check('jewels: large cluster types have notables', (index.largeClusters || []).length >= 15 && index.largeClusters.every(type => type.notables.length > 0));
  const heraldOfIce = index.buffs.find(buff => buff.name === 'Herald of Ice');
  check('buffs: a herald reserves 25%', heraldOfIce && heraldOfIce.reservation === 25, heraldOfIce && heraldOfIce.reservation);
  // The passive tree planner, on a real build: a connected tree from the class's start, within the budget.
  const treeFile = path.join(buildsDirectory, 'tree-poe1.json');
  if (fs.existsSync(treeFile)) {
    const treeIndex = generator.prepareMechanics(JSON.parse(fs.readFileSync(mechanicsFile, 'utf8')), JSON.parse(fs.readFileSync(treeFile, 'utf8')));
    const treeArc = named(treeIndex.skills, 'Arc');
    const treeElementalist = named(treeIndex.ascendancies, 'Elementalist');
    const planned = generator.finalizeTree(generator.bestBuildFor(treeArc, treeElementalist, treeIndex).build, treeIndex);
  const socketed = planned.tree.jewels || [];
  check('jewels: an Arc tree socket holds a jewel', socketed.length > 0, socketed.map(jewel => jewel.name).join(' | '));
  check('jewels: no more than two large cluster jewels', socketed.filter(jewel => jewel.kind === 'cluster').length <= 2);
  check('jewels: each sits on an allocated jewel socket', socketed.every(jewel => planned.tree.nodes.includes(jewel.socket) && treeIndex.tree.nodes.get(jewel.socket).kind === 'jewel'),
    socketed.map(jewel => jewel.socket).join(','));
  check('jewels: large clusters only in outer sockets', socketed.filter(jewel => jewel.kind === 'cluster').every(jewel => treeIndex.tree.nodes.get(jewel.socket).largeCluster));
  check('tree view: most nodes have a position to draw', [...treeIndex.tree.nodes.values()].filter(node => node.position).length > 1900);
    const allocated = new Set(planned.tree.nodes);
    const start = treeIndex.tree.starts.Witch;
    let disconnected = 0;
    for (const id of allocated) {
      if (id === start) {
        continue;
      }
      if (!treeIndex.tree.nodes.get(id).neighbours.some(neighbour => allocated.has(neighbour))) {
        disconnected += 1;
      }
    }
    check('tree: starts at the class\'s start node', allocated.has(start));
    check('tree: every node touches the rest of the tree', disconnected === 0, disconnected + ' loose nodes');
    const masteries = planned.tree.masteries;
    // Points: one per node past the start, one per mastery, and the points spent inside large cluster jewels (8 each).
    const clusterPoints = (planned.tree.jewels || []).filter(jewel => jewel.kind === 'cluster').length * 8;
    check('tree: within the point budget', planned.tree.points <= treeIndex.tree.budget
      && planned.tree.points === allocated.size - 1 + masteries.length + clusterPoints,
      planned.tree.points + ' points, ' + allocated.size + ' nodes, ' + masteries.length + ' masteries, ' + clusterPoints + ' in clusters');
    let lockedMasteries = 0;
    const optionTexts = new Set();
    for (const chosen of masteries) {
      const mastery = treeIndex.tree.masteries.find(entry => entry.id === chosen.id);
      if (!mastery.unlockedBy.some(id => allocated.has(id))) {
        lockedMasteries += 1;
      }
      optionTexts.add(chosen.name + '|' + chosen.text);
    }
    check('tree: takes masteries', masteries.length > 0);
    check('tree: each mastery sits beside a taken notable of its cluster', lockedMasteries === 0, lockedMasteries + ' without one');
    check('tree: no mastery option taken twice', optionTexts.size === masteries.length);
    const replanned = generator.finalizeTree(planned, treeIndex);
    check('tree: the same tree every time', JSON.stringify(replanned.tree.nodes) === JSON.stringify(planned.tree.nodes));
    check('tree: an Arc build takes lightning notables', planned.tree.notables.some(name => /Thunder|Lightning|Storm/.test(name)),
      planned.tree.notables.join(', '));
  }

  // Calibration: the generator picks players' favourite ascendancy far more often than chance (3 in 21).
  const calibration = generated.calibration.favouriteAscendancyInTop3;
  check('generator: favourite ascendancy in its top 3 for at least 25% of skills', calibration >= 0.25, 'got ' + calibration);
} else {
  console.log('(no generated builds yet: run npm run builds:build for the generator checks)');
}

if (failures.length > 0) {
  console.log('\n' + failures.length + ' failed.');
  process.exit(1);
}
console.log('\nAll passed.');
