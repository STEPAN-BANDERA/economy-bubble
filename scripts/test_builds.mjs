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

  // Reservation: auras take their share of mana after reservation efficiency, Blood Magic takes it from life, and
  // Mind over Matter only has the unreserved mana to draw on.
  const wrath = named(index.buffs, 'Wrath');
  const reserving = { ...firstArc.build, buffs: [wrath], keystones: [], uniques: [] };
  const reservingEvaluation = generator.evaluateBuild(reserving);
  check('reservation: an aura leaves less mana unreserved', reservingEvaluation.unreservedMana < reservingEvaluation.mana * 0.6,
    `${Math.round(reservingEvaluation.unreservedMana)} of ${Math.round(reservingEvaluation.mana)}`);
  const efficient = { ...reserving, uniques: [named(index.uniques, "Alpha's Howl")] };
  check('reservation: efficiency frees mana', generator.evaluateBuild(efficient).unreservedMana > reservingEvaluation.unreservedMana);
  const bloodMagic = named(index.keystones, 'Blood Magic');
  const onLife = generator.evaluateBuild({ ...reserving, keystones: [bloodMagic] });
  const onLifeNoAura = generator.evaluateBuild({ ...reserving, keystones: [bloodMagic], buffs: [] });
  check('reservation: Blood Magic reserves life and has no mana', onLife.mana === 0 && onLife.life < onLifeNoAura.life * 0.6,
    `${Math.round(onLife.life)} with Wrath, ${Math.round(onLifeNoAura.life)} without`);
  // Eternal Blessing: one aura with no reservation; beside it, only buffs that reserve life.
  const blessedWrath = named(index.buffs, 'Wrath (Eternal Blessing)');
  const herald = named(index.buffs, 'Herald of Thunder');
  const petrified = named(index.buffs, 'Petrified Blood');
  check('blessing: Eternal Blessing aura reserves nothing', Boolean(blessedWrath) && blessedWrath.reservation === 0 && blessedWrath.sockets === 2);
  const blessed = { ...reserving, buffs: [blessedWrath] };
  check('blessing: no mana-reserving buff beside it', !generator.canAddBuff(blessed, herald));
  check('blessing: Petrified Blood (life) beside it', generator.canAddBuff(blessed, petrified));
  check('blessing: not beside the same aura reserved', !generator.canAddBuff({ ...reserving, buffs: [wrath] }, blessedWrath));
  check('blessing: with Blood Magic a herald reserves life beside it', generator.canAddBuff({ ...blessed, keystones: [bloodMagic] }, herald));
  // Flat reservations and Arrogance: Precision reserves a flat amount of mana; on Arrogance it reserves twice that
  // much life instead, so it fits beside an Eternal Blessing aura.
  const precision = named(index.buffs, 'Precision');
  const precisionOnLife = named(index.buffs, 'Precision (Arrogance)');
  check('flat reservation: Precision is offered and reserves flat mana', Boolean(precision) && precision.reservationFlat > 100 && !precision.reservation,
    precision && precision.reservationFlat);
  const withPrecision = generator.evaluateBuild({ ...reserving, buffs: [precision] });
  const withoutAuras = generator.evaluateBuild({ ...reserving, buffs: [] });
  const flatManaTaken = withoutAuras.unreservedMana - withPrecision.unreservedMana;
  check('flat reservation: Precision takes about its flat mana', flatManaTaken > precision.reservationFlat * 0.8 && flatManaTaken <= precision.reservationFlat,
    Math.round(flatManaTaken) + ' mana');
  check('arrogance: Precision on Arrogance reserves life at about twice the amount', Boolean(precisionOnLife) && precisionOnLife.reservesLife
    && Math.abs(precisionOnLife.reservationFlat / precision.reservationFlat - 2.01) < 0.05 && precisionOnLife.sockets === 2);
  check('arrogance: fits beside an Eternal Blessing aura', generator.canAddBuff(blessed, precisionOnLife));
  check('arrogance: the plain Precision does not', !generator.canAddBuff(blessed, precision));
  const precisionLife = generator.evaluateBuild({ ...reserving, buffs: [precisionOnLife] });
  check('arrogance: life goes down, mana stays', precisionLife.life < withoutAuras.life && Math.round(precisionLife.unreservedMana) === Math.round(withoutAuras.unreservedMana),
    `${Math.round(precisionLife.life)} of ${Math.round(withoutAuras.life)} life`);
  // Petrified Blood: life reserved, the rest held at low life, the lower half protected.
  const withPetrified = generator.evaluateBuild({ ...reserving, buffs: [petrified] });
  const withoutBuffs = generator.evaluateBuild({ ...reserving, buffs: [] });
  check('petrified blood: life held at low life', withPetrified.life < withoutBuffs.life * 0.8 && withPetrified.life > withoutBuffs.life * 0.5,
    `${Math.round(withPetrified.life)} of ${Math.round(withoutBuffs.life)}`);

  // Cloudflare Pages takes files up to 25 MiB; the deploy fails on a bigger generated file.
  const generatedBytes = fs.statSync(generatedFile).size;
  check('generator: the generated file fits Cloudflare Pages (25 MiB)', generatedBytes < 25 * 1024 * 1024, generatedBytes + ' bytes');

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
    let curses = 0;
    for (const buff of build.buffs) {
      if (buff.kind === 'curse') {
        curses += 1;
      }
    }
    // The share after reservation efficiency, stored with the build (public/buildgen.js, RESERVABLE_MANA_PERCENT 100 and
    // RESERVABLE_LIFE_PERCENT 90).
    if ((stored.reserved ?? 0) > 100.05 || (stored.reservedLife ?? 0) > 90.05) {
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
  // Mana upkeep: a use costs the gem's cost times each support's multiplier, less with Inspiration; Lifetap pays it
  // with life; a build that reserves the mana one use needs can't use its skill.
  const upkeepArcSkill = named(index.skills, 'Arc');
  const upkeepSupport = name => ({ support: named(index.supports, name) });
  const upkeepArc = { skill: upkeepArcSkill, ascendancy: { name: 'None', baseClass: 'Witch', notables: [] }, weapon: 'none',
    supports: [], notables: [], keystones: [], uniques: [], buffs: [], flasks: [] };
  const upkeepOf = build => generator.evaluateBuild(build).upkeep;
  const bareCost = upkeepOf(upkeepArc).costPerUse;
  const focusedCost = upkeepOf({ ...upkeepArc, supports: [upkeepSupport('Elemental Focus Support')] }).costPerUse;
  const inspiredCost = upkeepOf({ ...upkeepArc, supports: [upkeepSupport('Inspiration Support')] }).costPerUse;
  check('upkeep: Arc costs its gem cost', Math.abs(bareCost - upkeepArcSkill.cost.amount) < 0.01, bareCost.toFixed(1) + ' for ' + upkeepArcSkill.cost.amount);
  check('upkeep: a support multiplies the cost (Elemental Focus 130%)', Math.abs(focusedCost / bareCost - 1.3) < 0.01, (focusedCost / bareCost).toFixed(3));
  check('upkeep: Inspiration costs less than its multiplier alone', inspiredCost < bareCost * 1.2 * 0.8, (inspiredCost / bareCost).toFixed(3));
  check('upkeep: Lifetap pays with life', upkeepOf({ ...upkeepArc, supports: [upkeepSupport('Lifetap Support')] }).paidWith === 'life');
  const upkeepReservedArc = { ...upkeepArc, buffs: index.buffs.filter(buff => ['Hatred', 'Wrath'].includes(buff.name)) };
  upkeepReservedArc.buffs.push({ name: 'Test aura', kind: 'aura', reservation: 20, effects: [] });
  check('upkeep: a skill whose one use costs more than the unreserved mana can\'t be used', upkeepOf(upkeepReservedArc).share < 0.05,
    upkeepOf(upkeepReservedArc).share.toFixed(3));
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

// ---------- the build planner: tags, stages, limits, agents (public/buildtags.js, buildstages.js, buildsearch.js) ----------
const plannerMechanicsFile = path.join(buildsDirectory, 'mechanics-poe1.json');
const plannerTreeFile = path.join(buildsDirectory, 'tree-poe1.json');
if (fs.existsSync(plannerMechanicsFile) && fs.existsSync(plannerTreeFile)) {
  const tags = await import(pathToFileURL(path.join(root, 'public', 'buildtags.js')).href);
  const stages = await import(pathToFileURL(path.join(root, 'public', 'buildstages.js')).href);
  const search = await import(pathToFileURL(path.join(root, 'public', 'buildsearch.js')).href);
  const mechanics = JSON.parse(fs.readFileSync(plannerMechanicsFile, 'utf8'));
  const quickIndex = generator.prepareMechanics(mechanics);
  const fullIndex = generator.prepareMechanics(mechanics, JSON.parse(fs.readFileSync(plannerTreeFile, 'utf8')));
  const named = (list, name) => list.find(entry => entry.name === name);
  const fireball = named(quickIndex.skills, 'Fireball');
  const elementalist = named(quickIndex.ascendancies, 'Elementalist');

  // Tags: from our own reading of each piece's effects; a piece fits when one of its effects can matter.
  const coldSpells = { name: 'test cold', effects: [{ kind: 'increased', stat: 'damage', tags: ['cold', 'spell'], value: 40 }] };
  const plainLife = { name: 'test life', effects: [{ kind: 'flat', stat: 'life', value: 50 }] };
  const axeAttacks = { name: 'test axe', effects: [{ kind: 'increased', stat: 'damage', tags: ['attack', 'axe'], value: 20 }] };
  check('tags: a piece is tagged from its effects', JSON.stringify(tags.tagsOfPiece(coldSpells)) === '["cold","spell"]' && JSON.stringify(tags.tagsOfPiece(plainLife)) === '["generic"]');
  const fireballBuild = generator.bestBuildFor(fireball, elementalist, quickIndex).build;
  const fireballContext = generator.buildContext(fireballBuild);
  check('tags: cold spell damage does not fit a fire spell', !tags.pieceFits(coldSpells, fireballContext));
  check('tags: axe attack damage does not fit a spell', !tags.pieceFits(axeAttacks, fireballContext));
  check('tags: life fits any build', tags.pieceFits(plainLife, fireballContext));
  // A skipped piece must add nothing: the tags only spare the planner work, they never change a plan. Its score
  // stays the same, or drops to 0 when the piece can't be used at all (a wand on a shield build).
  let skippedThatMattered = 0;
  const fireballScore = generator.evaluateBuild(fireballBuild).score;
  for (const unique of quickIndex.uniques) {
    if (tags.pieceFits(unique, fireballContext)) {
      continue;
    }
    const withUnique = generator.evaluateBuild({ ...fireballBuild, uniques: [...fireballBuild.uniques, unique] });
    const unusable = withUnique.problems.length > 0;
    if (withUnique.score !== fireballScore && !unusable) {
      skippedThatMattered += 1;
    }
  }
  check('tags: a unique the tags skip never changes the score of a build that can use it', skippedThatMattered === 0, skippedThatMattered + ' did');
  tags.tagIndex(fullIndex);
  check('tags: every tree node and unique is tagged', [...fullIndex.tree.nodes.values()].every(node => Array.isArray(node.tags)) && fullIndex.uniques.every(unique => Array.isArray(unique.tags)));

  // Buff effect: "Hatred has 30% increased Aura Effect" scales Hatred's lines, and only Hatred's; "while affected by
  // Hatred" holds only when the build runs Hatred.
  const hatred = quickIndex.buffs.find(buff => buff.name === 'Hatred');
  const anger = quickIndex.buffs.find(buff => buff.name === 'Anger');
  // Hatred adds cold damage as extra damage from physical, so a physical attack shows it.
  const coldSkill = named(quickIndex.skills, 'Cyclone');
  const coldBase = { skill: coldSkill, ascendancy: elementalist, weapon: 'sword', ailment: null, supports: [], notables: [], keystones: [], uniques: [], buffs: [hatred], flasks: [] };
  const hatredEffect = { name: 'test hatred effect', effects: [{ kind: 'increased', stat: 'effect:aura', skill: 'Hatred', value: 30 }] };
  const angerEffect = { name: 'test anger effect', effects: [{ kind: 'increased', stat: 'effect:aura', skill: 'Anger', value: 30 }] };
  const plainHatred = generator.evaluateBuild(coldBase).scaling;
  check('buffs: an aura\'s own effect lines scale it', generator.evaluateBuild({ ...coldBase, notables: [hatredEffect] }).scaling > plainHatred);
  check('buffs: another aura\'s effect lines do nothing', generator.evaluateBuild({ ...coldBase, notables: [angerEffect] }).scaling === plainHatred);
  const whileHatred = { name: 'test while hatred', effects: [{ kind: 'increased', stat: 'damage', tags: [], value: 40, condition: 'affectedBy:Hatred' }] };
  check('conditions: "while affected by Hatred" holds with Hatred', generator.evaluateBuild({ ...coldBase, notables: [whileHatred] }).scaling > plainHatred);
  check('conditions: and not without it', generator.evaluateBuild({ ...coldBase, buffs: [anger], notables: [whileHatred] }).scaling
    === generator.evaluateBuild({ ...coldBase, buffs: [anger] }).scaling);

  // Timeless jewels: the keystones they grant come from our own reading; a socket reaches the keystones in a Large
  // radius (1,500 game units, 1,800 on the tree); a planned tree holds at most one, and its keystone list shows the
  // conqueror's keystone, not the one it replaced.
  check('timeless: conqueror keystones are read', fullIndex.timeless.length >= 15 && fullIndex.timeless.some(choice => choice.keystone === 'Strength of Blood'),
    String(fullIndex.timeless.length));
  check('timeless: most sockets reach a keystone', fullIndex.tree.keystonesNearSocket.size >= 10, String(fullIndex.tree.keystonesNearSocket.size));
  // Planned without bloodlines: with them the build spends its points on Oath of the Maji and its tree no longer
  // wants Inner Conviction, which says nothing about whether timeless jewels are planned right.
  const withoutBloodlines = { ...fullIndex, bloodlineNotables: [] };
  const timelessFireball = generator.finalizeTree(generator.bestBuildFor(named(fullIndex.skills, 'Fireball'), named(fullIndex.ascendancies, 'Elementalist'), withoutBloodlines).build, withoutBloodlines);
  const timelessJewels = (timelessFireball.tree.jewels || []).filter(jewel => jewel.kind === 'timeless');
  check('timeless: a Fireball Elementalist takes one, and only one', timelessJewels.length === 1, (timelessFireball.tree.jewels || []).map(jewel => jewel.name).join(' | '));
  if (timelessJewels.length === 1) {
    check('timeless: the conquered keystone shows as the conqueror\'s', timelessFireball.tree.keystones.includes(timelessJewels[0].keystone)
      && !timelessFireball.tree.keystones.includes(timelessJewels[0].conquers), timelessFireball.tree.keystones.join(', '));  }

  // Stages: the default weights are the power score, bit for bit.
  let mismatches = 0;
  for (const skillName of ['Fireball', 'Cyclone', 'Raise Spectre', 'Toxic Rain']) {
    const build = generator.bestBuildFor(named(quickIndex.skills, skillName), elementalist, quickIndex).build;
    const evaluation = generator.evaluateBuild(build);
    if (stages.totalOf(evaluation, stages.DEFAULT_WEIGHTS) !== evaluation.score) {
      mismatches += 1;
    }
  }
  check('stages: the default total is the power score exactly', mismatches === 0, mismatches + ' builds differ');
  const defaultScored = generator.bestBuildFor(fireball, elementalist, quickIndex, { scoreOf: stages.scoreFunctionFor(stages.DEFAULT_WEIGHTS) });
  const plainNames = build => JSON.stringify([build.supports.map(entry => entry.support.name), build.notables.map(n => n.name), build.uniques.map(u => u.name), build.buffs.map(b => b.name)]);
  check('stages: planning by the default weights gives the generator\'s plan', plainNames(defaultScored.build) === plainNames(fireballBuild));
  const rarityWeights = { ...stages.DEFAULT_WEIGHTS, rarity: 0.5 };
  const rarityPlan = generator.bestBuildFor(fireball, elementalist, quickIndex, { scoreOf: stages.scoreFunctionFor(rarityWeights) });
  check('stages: weighing rarity buys rarity', rarityPlan.evaluation.itemRarity > generator.evaluateBuild(fireballBuild).itemRarity,
    rarityPlan.evaluation.itemRarity + ' vs ' + generator.evaluateBuild(fireballBuild).itemRarity);

  // Agents: they never lower the total, and an earlier stage never loses more than the tolerance.
  const agentWeights = { ...stages.DEFAULT_WEIGHTS, speed: 0.2 };
  const agentPlan = generator.planSkill(fireball, quickIndex, { scoreOf: stages.scoreFunctionFor(agentWeights) });
  const agentStart = generator.composeForAscendancy(agentPlan, elementalist, quickIndex, { scoreOf: stages.scoreFunctionFor(agentWeights) }).build;
  const settled = stages.negotiate(agentStart, { weights: agentWeights, tolerance: 0.05, uniques: agentPlan.plans[0].uniques, index: quickIndex });
  const startTotal = stages.totalOf(generator.evaluateBuild(agentStart), agentWeights);
  check('agents: the total never falls', stages.totalOf(settled.evaluation, agentWeights) >= startTotal);
  check('agents: single target keeps at least 95% while later stages trade', settled.after.singleTarget >= settled.before.singleTarget * 0.95,
    settled.after.singleTarget.toFixed(1) + ' vs ' + settled.before.singleTarget.toFixed(1));
  check('agents: every swap is logged with its stage', settled.log.every(entry => stages.STAGES.some(stage => stage.id === entry.agent) && (entry.added || entry.removed)));

  // Limits: at least two, class and ascendancy counting once; playstyles pick and seed the right skills.
  check('limits: an ascendancy counts as two, alone enough to plan', search.limitCount({ ascendancy: 'Elementalist' }) === 2
    && search.limitCount({ class: 'Witch', ascendancy: 'Elementalist' }) === 2);
  check('limits: a class alone is one, not enough', search.limitCount({ class: 'Witch' }) === 1);
  check('limits: class and damage are two', search.limitCount({ class: 'Witch', damage: 'fire' }) === 2);
  const totemVariants = search.skillVariants(quickIndex, { playstyle: 'totem', damage: 'fire' }, false);
  check('limits: Fireball is planned as a totem with Spell Totem', totemVariants.some(variant => variant.skill === 'Fireball' && variant.seedSupports.includes('Spell Totem Support')));
  check('limits: Holy Flame Totem is a totem as it is', totemVariants.some(variant => variant.skill === 'Holy Flame Totem' && variant.seedSupports.length === 0));
  const hitVariants = search.skillVariants(quickIndex, { playstyle: 'hit', damage: 'fire' }, false);
  check('limits: a hit build has no minion or totem skills', !hitVariants.some(variant => ['Raise Zombie', 'Holy Flame Totem', 'Summon Raging Spirit'].includes(variant.skill)));
  const staffVariants = search.skillVariants(quickIndex, { weapon: 'staff', damage: 'physical' }, false);
  check('limits: a weapon limit plans only that weapon', staffVariants.length > 0 && staffVariants.every(variant => JSON.stringify(variant.weapons) === '["staff"]'));
  check('limits: a wide search plans more skills', search.skillVariants(quickIndex, { class: 'Witch', damage: 'fire' }, true).length
    > search.skillVariants(quickIndex, { class: 'Witch', damage: 'fire' }, false).length);
  const fireballTotem = totemVariants.find(variant => variant.skill === 'Fireball' && variant.seedSupports.includes('Spell Totem Support'));
  const totemQuick = search.quickPlans(fireballTotem, quickIndex, ['Hierophant'], { limits: { playstyle: 'totem', damage: 'fire' } });
  check('limits: a seeded totem plan is scored', totemQuick.length === 1 && totemQuick[0].total > 0);
  const totemCard = search.fullPlan(fireballTotem, 'Hierophant', fullIndex, { limits: { playstyle: 'totem', damage: 'fire' } });
  check('planner: a full plan keeps its seeded support', totemCard && totemCard.supports.includes('Spell Totem Support'), totemCard && totemCard.supports.join(', '));
  check('planner: a full plan has a tree, stages and a tag report', totemCard && totemCard.treePoints > 0 && totemCard.stages.ehp > 0 && totemCard.tagsSkipped.length > 0);
  check('planner: a damage type limit holds on the finished build', totemCard && search.keepsLimits(generator.evaluateBuild(generator.rebuildFromNames(totemCard, fullIndex)), { damage: 'fire' }));
} else {
  console.log('(no mechanics or tree data: run npm run builds:build for the planner checks)');
}

// Rare gear solved from the Crafting tab's data (public/buildgear.js): resistances capped, attribute shortfalls made
// up where an item can, at most three prefixes and three suffixes an item with one affix per group, nothing in a
// unique's slot, and the same gear back from a stored build.
const gearFile = path.join(root, 'public', 'data', 'craft', 'gear-poe1.json');
if (fs.existsSync(plannerMechanicsFile) && fs.existsSync(plannerTreeFile) && fs.existsSync(gearFile)) {
  const mechanics = JSON.parse(fs.readFileSync(plannerMechanicsFile, 'utf8'));
  const named = (list, name) => list.find(entry => entry.name === name);
  const gearIndex = generator.prepareMechanics(mechanics, JSON.parse(fs.readFileSync(plannerTreeFile, 'utf8')),
    JSON.parse(fs.readFileSync(gearFile, 'utf8')));
  const geared = generator.bestBuildFor(named(gearIndex.skills, 'Boneshatter of Complex Trauma'), named(gearIndex.ascendancies, 'Juggernaut'), gearIndex).build;
  const needs = generator.gearNeedsOf(geared);
  check('gear: resistances are capped', Object.values(needs.resistanceShort).every(short => short <= 0), JSON.stringify(needs.resistanceShort));
  const items = geared.gear ? geared.gear.items : [];
  check('gear: rare items are filled', items.length >= 5 && items.every(item => item.prefixes.length + item.suffixes.length > 0), String(items.length));
  check('gear: at most three prefixes and three suffixes', items.every(item => item.prefixes.length <= 3 && item.suffixes.length <= 3));
  check('gear: one affix per modifier group', items.every(item => {
    const groups = [...item.prefixes, ...item.suffixes].flatMap(affix => affix.groups || []);
    return new Set(groups).size === groups.length;
  }));
  const uniqueSlots = new Set(geared.uniques.filter(unique => unique.slot !== 'ring').map(unique => unique.slot));
  check('gear: no rare in a unique\'s slot', items.every(item => !uniqueSlots.has(item.slot)));
  const stored = generator.compactBuild(geared, generator.evaluateBuild(geared));
  const rebuilt = generator.rebuildFromNames(stored, gearIndex);
  // The items, affix by affix (a rebuilt build's tree is planned again, so its score is compared elsewhere).
  const affixIds = gear => (gear ? gear.items : []).map(item => item.key + ':' + [...item.prefixes, ...item.suffixes].map(affix => affix.id).join(','));
  // The generated file keeps gear short (storeGear) and the page expands it: the same items come back.
  const gearModule = await import(pathToFileURL(path.join(root, 'public', 'buildgear.js')).href);
  const shortForm = gearModule.storeGear(stored.gear);
  const expanded = gearModule.compactGear(gearModule.rebuildGear(shortForm, gearIndex.gear));
  check('gear: the short stored form expands to the same items', JSON.stringify(expanded) === JSON.stringify(stored.gear));
  check('gear: a stored build gets its gear back', rebuilt && JSON.stringify(affixIds(rebuilt.gear)) === JSON.stringify(affixIds(geared.gear)));
  // Uniques are weighed against the rare that would take their slot: a rare spell shield (+1 to lightning spell gems,
  // lightning damage, spell critical strike chance) beats Rathpith Globe for a Spark of the Nova Hierophant.
  const caster = generator.bestBuildFor(named(gearIndex.skills, 'Spark of the Nova'), named(gearIndex.ascendancies, 'Hierophant'), gearIndex).build;
  const casterShield = (caster.gear ? caster.gear.items : []).find(item => item.slot === 'offhand');
  check('gear: a rare shield replaces a weaker unique shield', !caster.uniques.some(unique => unique.name === 'Rathpith Globe') && Boolean(casterShield),
    caster.uniques.map(unique => unique.name).join(', '));
  // A stacking commitment chosen early: Spark of the Nova on Hierophant commits to mana. It took Archmage while
  // Archmage's own cost (5% of unreserved mana per use, before the supports' multipliers) went unread; paying for it
  // now leaves it short of mana, so the test asks that the mana it stacks keeps its skill going.
  const casterUpkeep = generator.evaluateBuild(caster).upkeep;
  check('stacking: Spark Hierophant stacks mana and pays for its skill', caster.stacking === 'mana' && casterUpkeep.share >= 0.9,
    String(caster.stacking) + ', upkeep ' + casterUpkeep.share.toFixed(2) + ': ' + caster.supports.map(entry => entry.support.name).join(', '));
} else {
  console.log('(no gear data: run npm run craft:build and scripts/build_gear_mods.py for the gear checks)');
}

if (failures.length > 0) {
  console.log('\n' + failures.length + ' failed.');
  process.exit(1);
}
console.log('\nAll passed.');
