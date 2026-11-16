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

  // Affliction's Wildwood ascendancies (back in the Phrecia event) sit in the tree export beside the bloodlines but
  // were only playable in those leagues (LEAGUE_ONLY_ALTERNATE_ASCENDANCIES in scripts/build_sources.py).
  const leagueOnly = ['Warden of the Maji', 'Warlock of the Mists', 'Wildwood Primalist'];
  const rawMechanics = JSON.parse(fs.readFileSync(mechanicsFile, 'utf8'));
  const leagueOnlyInData = leagueOnly.filter(name => rawMechanics.bloodlines && rawMechanics.bloodlines[name]);
  check('data: no league-only alternate ascendancy is a bloodline', leagueOnlyInData.length === 0, leagueOnlyInData.join(', '));
  const buildsWithLeagueOnly = generated.builds.filter(build => leagueOnly.includes(build.bloodline));
  check('generator: no build takes a league-only alternate ascendancy', buildsWithLeagueOnly.length === 0,
    `${buildsWithLeagueOnly.length} builds, e.g. ${buildsWithLeagueOnly[0]?.skill} ${buildsWithLeagueOnly[0]?.ascendancy} with ${buildsWithLeagueOnly[0]?.bloodline}`);

  // Dance with Death makes enemies' crits lucky; a build takes it only beside immunity to extra crit damage.
  const critImmune = new Set(index.uniques.filter(unique => unique.effects.some(effect => effect.stat === 'noExtraCritDamage')).map(unique => unique.name));
  check('data: The Brass Dome reads as immune to extra crit damage', critImmune.has('The Brass Dome'), [...critImmune].join(', '));
  const takesDanceWithDeath = build => (build.keystones || []).includes('Dance with Death')
    || (build.treeJewels || []).some(jewel => jewel.includes('Dance with Death'));
  // The other answer: an Animated Guardian in Garb of the Ephemeral (Nearby Enemies cannot deal Critical Strikes).
  const guardianBuff = index.buffs.find(buff => buff.kind === 'guardian');
  check('data: the Animated Guardian in Garb of the Ephemeral is a buff', guardianBuff && guardianBuff.effects.some(effect => effect.stat === 'neverCrit' && effect.subject === 'enemy'));
  const garb = index.uniques.find(unique => unique.name === 'Garb of the Ephemeral');
  check('data: Garb of the Ephemeral worn needs its +600 Strength and Intelligence', garb && garb.requirements.str >= 600 && garb.requirements.int >= 600, JSON.stringify(garb?.requirements));
  const guarded = build => (build.buffs || []).some(name => name.startsWith('Animate Guardian ('));
  const unprotected = generated.builds.filter(build => takesDanceWithDeath(build) && !build.uniques.some(name => critImmune.has(name)) && !guarded(build));
  check('generator: Dance with Death only with immunity to enemy crits', unprotected.length === 0,
    `${unprotected.length} builds, e.g. ${unprotected[0]?.skill} ${unprotected[0]?.ascendancy}`);

  // A unique added after the gear was solved takes its slot: the rare item there no longer counts (wornGearItems).
  const gearModuleForSlots = await import(pathToFileURL(path.join(root, 'public', 'buildgear.js')).href);
  const rareItem = slot => ({ slot, key: slot, prefixes: [], suffixes: [] });
  const solvedWithPariah = { weapon: 'shield', uniques: [{ name: 'The Pariah', slot: 'ring' }, { name: 'Haunting Memories', slot: 'amulet' }],
    gear: { level: 'endgame', items: ['helmet', 'amulet', 'ring', 'ring', 'offhand'].map(rareItem) } };
  const wornSlots = gearModuleForSlots.wornGearItems(solvedWithPariah).map(item => item.slot);
  check('gear: a unique ring and amulet push out a rare ring and the rare amulet', JSON.stringify(wornSlots) === JSON.stringify(['helmet', 'ring', 'offhand']), wornSlots.join(', '));
  const slotOfUnique = name => index.uniques.find(unique => unique.name === name)?.slot;
  const doubled = generated.builds.filter(build => {
    const rings = build.uniques.filter(name => slotOfUnique(name) === 'ring').length + (build.gear?.items || []).filter(item => item.slot === 'ring').length;
    const amulets = build.uniques.filter(name => slotOfUnique(name) === 'amulet').length + (build.gear?.items || []).filter(item => item.slot === 'amulet').length;
    return rings > 2 || amulets > 1;
  });
  check('generator: no build wears more than two rings or one amulet', doubled.length === 0, `${doubled.length} builds, e.g. ${doubled[0]?.skill} ${doubled[0]?.ascendancy}`);

  // Every hand is solved: a spell build's on a caster weapon (its spell lines only), an attack build's on its weapon
  // type's endgame base (its local damage, speed and crit as weapon stats).
  const gearFileForWeapons = path.join(root, 'public', 'data', 'craft', 'gear-poe1.json');
  if (fs.existsSync(gearFileForWeapons)) {
    const gearData = JSON.parse(fs.readFileSync(gearFileForWeapons, 'utf8'));
    const weaponBases = Object.entries(gearData.bases).filter(([key]) => key.startsWith('weapon:') && !key.startsWith('weapon:attack-'));
    check('gear data: caster weapons for wand, rune dagger, sceptre and staff', weaponBases.length === 4, weaponBases.map(([key]) => key).join(', '));
    const attackBases = Object.entries(gearData.bases).filter(([key]) => key.startsWith('weapon:attack-'));
    const attackTypes = attackBases.map(([, base]) => base.type).sort().join(', ');
    check('gear data: an attack weapon for every weapon type', attackTypes === 'axe, bow, claw, dagger, mace, staff, sword, twoHandAxe, twoHandMace, twoHandSword, wand', attackTypes);
    const weaponStats = new Set();
    for (const [, base] of attackBases) {
      for (const mod of base.mods) {
        for (const effect of mod.tiers[mod.tiers.length - 1][2]) {
          if (effect.local) {
            weaponStats.add(effect.stat + ' ' + effect.kind);
          }
        }
      }
    }
    check('gear data: attack weapons keep their physical damage, speed and crit', ['weaponPhysical increased', 'weaponPhysical flat', 'weaponAttackSpeed increased', 'weaponCrit increased'].every(stat => weaponStats.has(stat)),
      [...weaponStats].join(', '));
    const attackLines = [];
    for (const [, base] of weaponBases) {
      for (const mod of base.mods) {
        // A mod that is only the weapon's own attack line is left out; a hybrid (an essence's "Socketed Gems are
        // Supported by ..., #% increased Physical Damage") keeps its other line, never the attack one.
        const onlyAttackLine = !mod.text.includes(', ')
          && /increased Physical Damage$|increased Attack Speed$|Life per Enemy Hit$|^\+# to Accuracy Rating$/.test(mod.text);
        const attackEffect = mod.tiers.some(tier => tier[2].some(effect => !effect.subject && !effect.condition
          && ((effect.stat === 'attackSpeed' && !(effect.tags || []).length) || (effect.stat === 'damage' && (effect.tags || []).join() === 'physical' && effect.kind === 'increased'))
          && /increased (Physical Damage|Attack Speed)(,|$)/.test(mod.text) && !/Global/.test(mod.text)));
        if ((onlyAttackLine && mod.tiers.length > 0) || attackEffect) {
          attackLines.push(mod.text);
        }
      }
    }
    check('gear data: caster weapons leave out their own attacks\' lines', attackLines.length === 0, attackLines.join(' | '));
    const gearIndex = generator.prepareMechanics(JSON.parse(fs.readFileSync(mechanicsFile, 'utf8')), null, gearData);
    const scoreOf = build => generator.evaluateBuild(build).score;
    const caster = generator.bestBuildFor(named(gearIndex.skills, 'Arc'), named(gearIndex.ascendancies, 'Elementalist'), gearIndex);
    const casterShield = { ...caster.build, weapon: 'shield', uniques: caster.build.uniques.filter(unique => unique.slot !== 'weapon' && unique.slot !== 'offhand') };
    const solvedCaster = gearModuleForSlots.solveGear({ ...casterShield, gear: undefined }, gearIndex.gear, generator.gearEngineFor(scoreOf), 'endgame');
    const casterWeapon = solvedCaster.gear.items.find(item => item.slot === 'weapon');
    check('gear: a spell build with a shield gets a caster weapon', Boolean(casterWeapon), solvedCaster.gear.items.map(item => item.slot).join(', '));
    check('gear: the weapon is labelled by its kind', casterWeapon && /^Weapon: (Wand|Rune Dagger|Sceptre)$/.test(gearModuleForSlots.gearItemLabel(casterWeapon)), casterWeapon && gearModuleForSlots.gearItemLabel(casterWeapon));
    // Planned with wands, a spell build dual wields two caster wands (and counts as dual wielding).
    const casterWands = { ...casterShield, weapon: 'wand' };
    const solvedWands = gearModuleForSlots.solveGear({ ...casterWands, gear: undefined }, gearIndex.gear, generator.gearEngineFor(scoreOf), 'endgame');
    const wands = solvedWands.gear.items.filter(item => item.slot === 'weapon');
    check('gear: a spell build with wands dual wields two caster wands', wands.length === 2 && wands.every(item => item.key === 'weapon:wand'),
      solvedWands.gear.items.map(item => item.key).join(', '));
    check('gear: and no shield', !solvedWands.gear.items.some(item => item.slot === 'offhand'));
    check('generator: dual wands count as dual wielding', generator.evaluateBuild(solvedWands).tags.includes('dualWield'));
    // An attack build holds rare attack weapons in every hand; a better weapon scores better.
    const attacker = generator.bestBuildFor(named(gearIndex.skills, 'Cyclone'), named(gearIndex.ascendancies, 'Slayer'), gearIndex);
    const attackerBuild = { ...attacker.build, weapon: 'sword', uniques: attacker.build.uniques.filter(unique => unique.slot !== 'weapon' && unique.slot !== 'offhand'), gear: undefined };
    const solvedAttacker = gearModuleForSlots.solveGear(attackerBuild, gearIndex.gear, generator.gearEngineFor(scoreOf), 'endgame');
    const swords = solvedAttacker.gear.items.filter(item => item.slot === 'weapon');
    check('gear: a one-handed attack build dual wields two rare swords', swords.length === 2 && swords.every(item => item.key === 'weapon:attack-sword'),
      solvedAttacker.gear.items.map(item => item.key).join(', '));
    check('gear: an attack weapon is labelled by its kind', swords.length > 0 && gearModuleForSlots.gearItemLabel(swords[0]) === 'Weapon: Sword', swords[0] && gearModuleForSlots.gearItemLabel(swords[0]));
    const factors = gearModuleForSlots.solvedWeaponFactors(solvedAttacker);
    check('gear: solved swords are weighed against the reference rare', factors && factors.damage > 0.5 && factors.damage < 3, JSON.stringify(factors));
    const bareSwords = { ...solvedAttacker, gear: { ...solvedAttacker.gear, items: solvedAttacker.gear.items.map(item => (item.slot === 'weapon' ? { ...item, prefixes: [], suffixes: [], groups: new Set() } : item)) } };
    check('gear: a bare weapon scores below a solved one', scoreOf(bareSwords) < scoreOf(solvedAttacker), `${scoreOf(bareSwords)} vs ${scoreOf(solvedAttacker)}`);
    // Every mod source and base item (2026-11-27): the crafter's limits hold on every solved item.
    const influenceSources = new Set(['shaper', 'elder', 'crusader', 'hunter', 'redeemer', 'warlord']);
    const placedSources = new Set(['bench', 'essence', 'veiled', 'beast']);
    const limitProblems = [];
    for (const item of [...solvedCaster.gear.items, ...solvedAttacker.gear.items, ...solvedWands.gear.items]) {
      const affixes = [...item.prefixes, ...item.suffixes, ...(item.implicits || [])];
      const influences = new Set(affixes.map(affix => affix.source).filter(source => influenceSources.has(source)));
      const eldritch = affixes.filter(affix => affix.affix === 'r' || affix.affix === 'b');
      const placed = affixes.filter(affix => placedSources.has(affix.source));
      const exp = item.baseItem?.exp || {};
      if (influences.size > 2 && !exp.allInfl) {
        limitProblems.push(item.slot + ': ' + [...influences].join('+'));
      }
      if (eldritch.length > 0 && influences.size > 0) {
        limitProblems.push(item.slot + ': eldritch beside ' + [...influences].join('+'));
      }
      if (placed.length > 2 || new Set(placed.map(affix => affix.source)).size !== placed.length) {
        limitProblems.push(item.slot + ': placed ' + placed.map(affix => affix.source).join(', '));
      }
      if (item.prefixes.length > 3 + (exp.p || 0) || item.suffixes.length > 3 + (exp.s || 0)) {
        limitProblems.push(item.slot + ': ' + item.prefixes.length + ' prefixes, ' + item.suffixes.length + ' suffixes on ' + item.baseItem?.name);
      }
    }
    check('gear: influences, eldritch implicits and crafted mods within the crafter\'s limits', limitProblems.length === 0, limitProblems.join(' | '));
    const stored = gearModuleForSlots.storeGear(gearModuleForSlots.compactGear(solvedCaster.gear));
    const rebuilt = gearModuleForSlots.rebuildGear(stored, gearIndex.gear);
    check('gear: a stored item keeps its base item and scores the same rebuilt',
      rebuilt.items.every((item, position) => item.baseItem?.name === solvedCaster.gear.items[position].baseItem?.name)
      && Math.abs(scoreOf({ ...solvedCaster, gear: rebuilt }) - scoreOf(solvedCaster)) < 1e-9,
      rebuilt.items.map(item => item.baseItem?.name).join(', '));
    const spectreLevel = Object.values(gearData.bases).flatMap(base => base.mods).find(mod => /Level of all Raise Spectre Gems/.test(mod.text));
    check('gear data: "+1 to Level of all Raise Spectre Gems" keeps its skill', !spectreLevel || spectreLevel.tiers.every(tier => tier[2].every(effect => effect.skill === 'Raise Spectre')),
      spectreLevel && JSON.stringify(spectreLevel.tiers[0][2]));
    const solvedBow = gearModuleForSlots.solveGear({ ...attackerBuild, weapon: 'bow' }, gearIndex.gear, generator.gearEngineFor(scoreOf), 'endgame');
    const bowSlots = solvedBow.gear.items.map(item => item.slot).sort().join(', ');
    check('gear: a bow build holds one bow and a quiver', solvedBow.gear.items.filter(item => item.slot === 'weapon').length === 1 && bowSlots.includes('quiver'), bowSlots);
    // A two-handed sword build holds one rare two-handed sword and nothing in the off-hand.
    const twoHandSwordBuild = { ...attackerBuild, weapon: 'twoHandSword' };
    const solvedTwoHander = gearModuleForSlots.solveGear(twoHandSwordBuild, gearIndex.gear, generator.gearEngineFor(scoreOf), 'endgame');
    const twoHandWeapons = solvedTwoHander.gear.items.filter(item => item.slot === 'weapon');
    check('gear: a two-handed sword build holds one rare two-handed sword and no off-hand',
      twoHandWeapons.length === 1 && twoHandWeapons[0].key === 'weapon:attack-twoHandSword' && !solvedTwoHander.gear.items.some(item => item.slot === 'offhand'),
      solvedTwoHander.gear.items.map(item => item.key).join(', '));
    check('generator: a two-handed sword is a sword held in both hands', ['sword', 'twoHand'].every(tag => generator.evaluateBuild(solvedTwoHander).tags.includes(tag))
      && !generator.evaluateBuild(solvedTwoHander).tags.includes('dualWield'));
    // A two-handed unique fills both hands: no rare weapon and no off-hand. (No sword unique had a slot before the
    // wiki's "Two-Handed Sword" category was read as GGG's "Two Hand Sword", so this check was skipped, 2026-11-25.)
    const twoHandedUnique = gearIndex.uniques.find(unique => unique.name === 'Starforge');
    check('uniques: Starforge is a two-handed sword with its own hand', Boolean(twoHandedUnique) && twoHandedUnique.slot === 'weapon' && twoHandedUnique.twoHanded
      && twoHandedUnique.weapon === 'sword' && twoHandedUnique.weaponHand?.physicalIncreased > 300,
      twoHandedUnique && JSON.stringify(twoHandedUnique.weaponHand));
    check('uniques: Starforge\'s increased physical damage is its own, not the character\'s', Boolean(twoHandedUnique) && !twoHandedUnique.effects.some(effect => effect.stat === 'damage' && (effect.value || 0) > 300));
    if (twoHandedUnique) {
      const withTwoHander = gearModuleForSlots.solveGear({ ...twoHandSwordBuild, uniques: [...attackerBuild.uniques, twoHandedUnique] }, gearIndex.gear, generator.gearEngineFor(scoreOf), 'endgame');
      check('gear: a two-handed unique leaves no rare weapon or off-hand', !withTwoHander.gear.items.some(item => item.slot === 'weapon' || item.slot === 'offhand'),
        withTwoHander.gear.items.map(item => item.slot).join(', '));
    }
    // A unique weapon is weighed by its own base and local lines: The Grey Spire has no physical damage lines, so it
    // hits well below the reference rare (it counted as one, with its 350% global damage on top).
    const greySpire = gearIndex.uniques.find(unique => unique.name === 'The Grey Spire');
    const greySpireFactors = greySpire && gearModuleForSlots.solvedWeaponFactors({ ...attackerBuild, weapon: 'staff', uniques: [greySpire] }, null);
    check('uniques: The Grey Spire hits below the reference rare', Boolean(greySpireFactors) && greySpireFactors.damage < 0.6, JSON.stringify(greySpireFactors));
    check('uniques: The Grey Spire\'s implicit block is doubled', Boolean(greySpire) && greySpire.effects.some(effect => effect.stat === 'block' && effect.value === 50));
  }
  // Melee skills plan two-handed swords, axes and maces too, where their weapon rules allow them, and the best
  // two-handed plan reaches the ascendancies even when one-handers lead before the tree.
  const boneshatter = named(index.skills, 'Boneshatter');
  check('generator: Boneshatter may hold two-handed axes and maces', ['twoHandAxe', 'twoHandMace'].every(weapon => generator.weaponChoicesOf(boneshatter).includes(weapon)),
    generator.weaponChoicesOf(boneshatter).join(', '));
  // The weapon base's damage counts: a Karui Chopper out-damages an Imperial Staff, which out-damages a one-handed
  // axe (each weapon was measured against its own bare skill, so every base counted the same, 2026-11-25).
  const offenceWith = weapon => generator.evaluateBuild(generator.planSkill(boneshatter, index, { weapons: [weapon], noStacking: true }).plans[0].build).offence;
  check('generator: a two-handed axe out-damages a staff, and a staff a one-handed axe', offenceWith('twoHandAxe') > offenceWith('staff') && offenceWith('staff') > offenceWith('axe'),
    ['twoHandAxe', 'staff', 'axe'].map(weapon => weapon + ' ' + offenceWith(weapon).toFixed(1)).join(', '));
  const boneshatterPlans = generator.planSkill(boneshatter, index, { noStacking: true }).plans.map(plan => plan.weapon);
  check('generator: a two-handed plan and a one-handed plan are both kept', boneshatterPlans.some(weapon => ['staff', 'twoHandAxe', 'twoHandMace'].includes(weapon))
    && boneshatterPlans.some(weapon => ['axe', 'mace'].includes(weapon)), boneshatterPlans.join(', '));

  // Hidden Potential counts magic items worn; the builds wear none, so it is never worth a jewel socket.
  const withHiddenPotential = generated.builds.filter(build => build.uniques.includes('Hidden Potential'));
  check('generator: no build takes Hidden Potential', withHiddenPotential.length === 0, `${withHiddenPotential.length} builds`);

  // The same question twice gives the same build.
  const arc = named(index.skills, 'Arc');
  const elementalist = named(index.ascendancies, 'Elementalist');
  const firstArc = generator.bestBuildFor(arc, elementalist, index);
  const secondArc = generator.bestBuildFor(arc, elementalist, index);
  const namesOf = result => JSON.stringify([result.build.supports.map(entry => entry.support.name), result.build.notables.map(n => n.name), result.build.uniques.map(u => u.name)]);
  check('generator: deterministic', namesOf(firstArc) === namesOf(secondArc));
  const arcSupports = firstArc.build.supports.map(entry => entry.support.name);
  check('generator: Arc gets lightning supports', arcSupports.some(name => /Lightning/.test(name)), arcSupports.join(', '));

  // Ailments from hits: the ailment's part is the offence with it less the offence without it.
  const ailmentPartOf = build => generator.evaluateBuild(build).offence - generator.evaluateBuild({ ...build, ailment: null }).offence;
  const ignitingFireball = generator.bestBuildFor(named(index.skills, 'Fireball'), elementalist, index, { ailment: 'ignite' }).build;
  const moreCritMultiplier = { name: 'Test crit multiplier', effects: [{ kind: 'flat', stat: 'critMulti', value: 100 }] };
  const igniteBefore = ailmentPartOf(ignitingFireball);
  const igniteAfter = ailmentPartOf({ ...ignitingFireball, keystones: [...ignitingFireball.keystones, moreCritMultiplier] });
  check('ailments: an ignite adds damage to its hit', igniteBefore > 0, String(igniteBefore));
  check('ailments: crit multiplier does not reach the ignite', Math.abs(igniteAfter - igniteBefore) < 1e-9 * igniteBefore,
    `${igniteBefore} before, ${igniteAfter} after`);
  const lacerate = generator.bestBuildFor(named(index.skills, 'Lacerate'), named(index.ascendancies, 'Champion'), index, { ailment: 'bleed' }).build;
  const resolute = named(index.keystones, 'Resolute Technique');
  const perfectAgony = named(index.keystones, 'Perfect Agony');
  check('ailments: Perfect Agony inflicts none without crits', Math.abs(ailmentPartOf({ ...lacerate, keystones: [resolute, perfectAgony] })) < 1e-9);
  const crimsonDance = named(index.keystones, 'Crimson Dance');
  const bleedAlone = ailmentPartOf({ ...lacerate, keystones: [] });
  const bleedsDancing = ailmentPartOf({ ...lacerate, keystones: [crimsonDance] });
  // At most 8 bleeds, 60% of them kept, each at 50% less: never more than 2.4 times one bleed.
  check('ailments: Crimson Dance counts the bleeds kept, no more', bleedsDancing <= bleedAlone * 8 * 0.6 * 0.5 + 1e-9,
    `${(bleedsDancing / bleedAlone).toFixed(2)} times one bleed`);

  // "Deal no Elemental Damage" (Brutality): fire gained as extra is lost, so Added Fire adds nothing beside it.
  const plainLacerate = { ...lacerate, ailment: null, keystones: [], supports: [] };
  const brutality = { support: named(index.supports, 'Brutality Support'), via: 'skill' };
  const addedFire = { support: named(index.supports, 'Added Fire Damage Support'), via: 'skill' };
  const brutalOnly = generator.evaluateBuild({ ...plainLacerate, supports: [brutality] }).offence;
  const brutalWithFire = generator.evaluateBuild({ ...plainLacerate, supports: [brutality, addedFire] }).offence;
  check('damage types: Brutality stops the fire Added Fire gives', Math.abs(brutalWithFire - brutalOnly) < 1e-9 * brutalOnly,
    `${brutalOnly} alone, ${brutalWithFire} with Added Fire`);
  check('damage types: Added Fire still helps without Brutality',
    generator.evaluateBuild({ ...plainLacerate, supports: [addedFire] }).offence > generator.evaluateBuild(plainLacerate).offence);

  // Minions: Offerings are buffs on the minions at a share of a fight, minion cast speed reaches only minions that
  // cast, and a spectre is planned as one kind of monster, never with attack and spell supports together.
  const necromancer = named(index.ascendancies, 'Necromancer');
  const fleshOffering = named(index.buffs, 'Flesh Offering');
  const offeringSpeed = fleshOffering && fleshOffering.effects.find(effect => effect.stat === 'attackSpeed');
  check('minions: Flesh Offering is offered as a buff on the minions', Boolean(offeringSpeed) && fleshOffering.kind === 'offering'
    && offeringSpeed.subject === 'minion' && offeringSpeed.value < 30, JSON.stringify(offeringSpeed));
  const zombies = { ...generator.bestBuildFor(named(index.skills, 'Raise Zombie'), necromancer, index).build, buffs: [] };
  check('minions: Flesh Offering speeds up zombies',
    generator.evaluateBuild({ ...zombies, buffs: [fleshOffering] }).offence > generator.evaluateBuild(zombies).offence);
  const minionCastSpeed = { name: 'Test minion cast speed', effects: [{ kind: 'increased', stat: 'castSpeed', value: 50, subject: 'minion' }] };
  const mages = { ...generator.bestBuildFor(named(index.skills, 'Summon Skeletons of Mages'), necromancer, index).build, buffs: [] };
  check('minions: minion cast speed reaches Skeleton Mages',
    generator.evaluateBuild({ ...mages, keystones: [...mages.keystones, minionCastSpeed] }).offence > generator.evaluateBuild(mages).offence);
  check('minions: minion cast speed does not reach zombies',
    generator.evaluateBuild({ ...zombies, keystones: [...zombies.keystones, minionCastSpeed] }).offence === generator.evaluateBuild(zombies).offence);
  const spectre = generator.bestBuildFor(named(index.skills, 'Raise Spectre'), necromancer, index).build;
  const attackSpectreTypes = new Set(['Attack', 'Melee', 'MeleeSingleTarget', 'Damage', 'Area', 'Projectile']);
  const spellSpectreTypes = new Set(['Spell', 'Damage', 'Area', 'Projectile']);
  let attackOnlySupports = 0;
  let spellOnlySupports = 0;
  for (const entry of spectre.supports) {
    if (entry.via !== 'minion') {
      continue;
    }
    const fitsAttack = generator.supportFits(entry.support, new Set(), attackSpectreTypes, true) !== null;
    const fitsSpell = generator.supportFits(entry.support, new Set(), spellSpectreTypes, true) !== null;
    if (fitsAttack && !fitsSpell) {
      attackOnlySupports += 1;
    }
    if (fitsSpell && !fitsAttack) {
      spellOnlySupports += 1;
    }
  }
  check('minions: a spectre has attack supports or spell supports, not both', attackOnlySupports === 0 || spellOnlySupports === 0,
    spectre.supports.map(entry => entry.support.name).join(', '));

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
  // A skill a unique gives (Soulwrest's Phantasms): every build wears the unique, the supports are its six-link, and
  // gem levels don't reach the skill.
  const phantasm = named(index.skills, 'Summon Phantasm (Soulwrest)');
  check('unique skill: Soulwrest\'s Phantasms are a main skill', Boolean(phantasm && phantasm.main && phantasm.grantingUnique));
  if (phantasm) {
    const necromancer = named(index.ascendancies, 'Necromancer');
    const phantasmBuild = generator.bestBuildFor(phantasm, necromancer, index).build;
    check('unique skill: the build wears Soulwrest', phantasmBuild.uniques.some(unique => unique.name === 'Soulwrest'),
      phantasmBuild.uniques.map(unique => unique.name).join(', '));
    check('unique skill: five supports in the staff', phantasmBuild.weapon === 'staff' && generator.linkedSupports(phantasmBuild).length === 5,
      phantasmBuild.weapon + ', ' + generator.linkedSupports(phantasmBuild).length);
    const levelLine = { name: 'Test gem levels', effects: [{ kind: 'level', stat: 'gemLevel', value: 3, subject: 'minion', tags: ['minion'] }] };
    check('unique skill: gem levels don\'t reach it',
      generator.evaluateBuild({ ...phantasmBuild, notables: [...phantasmBuild.notables, levelLine] }).offence === generator.evaluateBuild(phantasmBuild).offence);
    const rebuilt = generator.rebuildFromNames({ skill: phantasm.name, ascendancy: 'Necromancer', weapon: 'staff',
      supports: [], notables: [], keystones: [], uniques: ['Soulwrest'] }, index);
    check('unique skill: a stored build keeps one Soulwrest', rebuilt.uniques.filter(unique => unique.name === 'Soulwrest').length === 1);
    // Unholy Might is one buff: Command of the Pit's chance to gain it adds nothing beside Unnatural Strength.
    const commandOfThePit = named(index.uniques, 'Command of the Pit');
    const unnaturalStrength = named(necromancer.notables, 'Unnatural Strength');
    const bare = { ...phantasmBuild, supports: [], uniques: [phantasm.grantingUnique], notables: [] };
    const withStrength = { ...bare, notables: [unnaturalStrength] };
    const withBoth = { ...withStrength, uniques: [...bare.uniques, commandOfThePit] };
    // 85%: each Phantasm has the buff that share of the time (minionUnholyMightOnHit).
    check('unholy might: Phantasms (spells) convert to chaos with Command of the Pit',
      Math.abs(generator.evaluateBuild({ ...bare, uniques: [...bare.uniques, commandOfThePit] }).shares.chaos - 0.85) < 1e-9);
    check('unholy might: a chance to gain it adds nothing when minions always have it',
      Math.abs(generator.evaluateBuild(withBoth).offence / generator.evaluateBuild(withStrength).offence - 1) < 1e-9,
      generator.evaluateBuild(withBoth).offence + ' vs ' + generator.evaluateBuild(withStrength).offence);
    const raiseZombie = named(index.skills, 'Raise Zombie');
    if (raiseZombie) {
      const zombies = { ...bare, skill: raiseZombie, weapon: 'none', uniques: [commandOfThePit] };
      check('unholy might: Command of the Pit doesn\'t reach minions that attack', generator.evaluateBuild(zombies).shares.chaos === 0);
    }
  }
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
  // Jewels on a Spark Inquisitor's tree: a rare jewel, a large cluster and a timeless jewel. (Arc's tree held them only
  // while Haunting Memories and The Pariah were misread as huge defences; Fireball's went when it took The Grey Spire,
  // whose doubled implicit block is now read, 2026-11-25.)
  const jewelPlan = generator.finalizeTree(generator.bestBuildFor(named(treeIndex.skills, 'Spark'), named(treeIndex.ascendancies, 'Inquisitor'), treeIndex).build, treeIndex);
  const socketed = jewelPlan.tree.jewels || [];
  check('jewels: a Spark tree socket holds a jewel', socketed.length > 0, socketed.map(jewel => jewel.name).join(' | '));
  check('jewels: no more than two large cluster jewels', socketed.filter(jewel => jewel.kind === 'cluster').length <= 2);
  check('jewels: each sits on an allocated jewel socket', socketed.every(jewel => jewelPlan.tree.nodes.includes(jewel.socket) && treeIndex.tree.nodes.get(jewel.socket).kind === 'jewel'),
    socketed.map(jewel => jewel.socket).join(','));
  check('jewels: large clusters only in outer sockets', socketed.filter(jewel => jewel.kind === 'cluster').every(jewel => treeIndex.tree.nodes.get(jewel.socket).largeCluster));
  // The tree view draws a socketed large cluster's passives on its socket's ring, so the cluster names them.
  const largeSockets = [...treeIndex.tree.nodes.values()].filter(node => node.largeCluster);
  check('tree view: every outer socket has a ring to draw a cluster on', largeSockets.length > 0 && largeSockets.every(node => Array.isArray(node.clusterRing) && node.clusterRing.length === 4),
    largeSockets.length + ' outer sockets');
  const plannedClusters = socketed.filter(jewel => jewel.kind === 'cluster');
  check('tree view: a socketed cluster names its notables for the drawing', plannedClusters.every(jewel => (jewel.notables || []).length >= 1 && jewel.clusterType),
    JSON.stringify(plannedClusters.map(jewel => jewel.notables)));
  check('tree view: most nodes have a position to draw', [...treeIndex.tree.nodes.values()].filter(node => node.position).length > 1900);
    // "Why these pieces": the worker plans a card's tree and the page rebuilds the card from it; both builds match.
    const storedArc = generated.builds.find(build => build.skill === 'Arc') || generated.builds[0];
    const rebuiltHere = generator.rebuildFromNames(storedArc, treeIndex);
    const handedOver = structuredClone(generator.plannedTreeOf(rebuiltHere));
    const rebuiltFromTree = generator.rebuildFromNames(storedArc, treeIndex, { plannedTree: handedOver });
    check('why: a handed-over tree gives the same build', JSON.stringify(generator.pieceGains(rebuiltFromTree)) === JSON.stringify(generator.pieceGains(rebuiltHere))
      && generator.evaluateBuild(rebuiltFromTree).score === generator.evaluateBuild(rebuiltHere).score);
    const allocated = new Set(planned.tree.nodes);
    const start = treeIndex.tree.starts.Witch;
    let disconnected = 0;
    // A passive taken through a free-allocation jewel (Thread of Hope) stands alone; the radius checks cover those.
    const takenWithoutPath = new Set(planned.tree.floating || []);
    for (const id of allocated) {
      if (id === start || takenWithoutPath.has(id)) {
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
    // Planning the same build again gives the same tree. Finalizing a finalized build may find a better one (its buffs
    // chosen again, then a tree for them: finalizeTree's "the greedy planner can miss a tree it kept before"), never
    // a worse one. With radius jewels Arc's does (2026-11-26).
    const plannedAgain = generator.finalizeTree(generator.bestBuildFor(treeArc, treeElementalist, treeIndex).build, treeIndex);
    check('tree: the same tree every time', JSON.stringify(plannedAgain.tree.nodes) === JSON.stringify(planned.tree.nodes));
    const replanned = generator.finalizeTree(planned, treeIndex);
    check('tree: planning a finished tree again never lowers it', generator.evaluateBuild(replanned).score >= generator.evaluateBuild(planned).score);
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
  // Skin of the Lords is left out for the same reason: since it comes in one version per keystone (2026-11-23) the
  // build wears it with Iron Will, and its tree no longer wants a timeless keystone.
  withoutBloodlines.uniques = fullIndex.uniques.filter(unique => !unique.baseName);
  // And the radius jewels (2026-11-26): Unnatural Instinct and The Red Dream take the sockets near its keystones.
  withoutBloodlines.radiusJewels = [];
  const timelessFireball = generator.finalizeTree(generator.bestBuildFor(named(fullIndex.skills, 'Fireball'), named(fullIndex.ascendancies, 'Elementalist'), withoutBloodlines).build, withoutBloodlines);
  const timelessJewels = (timelessFireball.tree.jewels || []).filter(jewel => jewel.kind === 'timeless');
  // Since timeless jewels pay for what they conquer (2026-11-27) this Fireball may take none; it never takes two,
  // and across the generated builds they are used, one at most each.
  check('timeless: a Fireball Elementalist takes one at most', timelessJewels.length <= 1, (timelessFireball.tree.jewels || []).map(jewel => jewel.name).join(' | '));
  const timelessNames = /^(Lethal Pride|Brutal Restraint|Glorious Vanity|Elegant Hubris|Militant Faith|Heroic Tragedy)\b/;
  const generatedBuilds = JSON.parse(fs.readFileSync(path.join(buildsDirectory, 'generated-poe1.json'), 'utf8')).builds;
  const timelessCounts = generatedBuilds.map(build => (build.treeJewels || []).filter(name => timelessNames.test(name)).length);
  check('timeless: generated builds hold them, never two', timelessCounts.some(count => count === 1) && timelessCounts.every(count => count <= 1),
    timelessCounts.filter(count => count > 0).length + ' builds');
  // A keystone held through an item (a version of Skin of the Lords) isn't allocated again in the tree, and an item
  // comes in one version per keystone, priced as the item.
  const skinVersions = fullIndex.uniques.filter(unique => unique.baseName === 'Skin of the Lords');
  check('keystones: Skin of the Lords comes in one version per keystone', skinVersions.length > 20
    && skinVersions.every(unique => unique.name === 'Skin of the Lords (' + unique.variant + ')'), String(skinVersions.length));
  const heldFireball = generator.bestBuildFor(named(fullIndex.skills, 'Fireball'), named(fullIndex.ascendancies, 'Elementalist'), fullIndex).build;
  const held = generator.keystonesHeldBy(heldFireball);
  const heldTree = generator.finalizeTree(heldFireball, fullIndex);
  const heldTwice = heldTree.tree.nodes.filter(id => fullIndex.tree.nodes.get(id).kind === 'keystone' && held.has(fullIndex.tree.nodes.get(id).name));
  check('keystones: one held through an item is not taken in the tree', heldTwice.length === 0, [...held].join(', '));
  // "with Claws or Daggers" is either weapon ("claw|dagger"), not both.
  const eitherWeapon = { kind: 'increased', stat: 'damage', tags: ['claw|dagger'], value: 10, subject: 'self', condition: null };
  const contextWith = weapon => ({ isMinion: false, tags: new Set([weapon, 'attack']), skill: { name: 'test' }, minionTypes: new Set(), shares: {} });
  check('tags: an any-of tag reaches either weapon', generator.effectReaches(eitherWeapon, contextWith('dagger'))
    && generator.effectReaches(eitherWeapon, contextWith('claw')) && !generator.effectReaches(eitherWeapon, contextWith('sword')));
  // Lone Messenger disables auras: a build with Wrath loses Wrath's damage when it takes the keystone.
  const wrathBuild = { ...heldFireball, buffs: heldFireball.buffs.filter(buff => buff.kind === 'aura') };
  if (wrathBuild.buffs.length > 0) {
    const loneMessenger = named(fullIndex.keystones, 'Lone Messenger');
    const withKeystone = { ...wrathBuild, keystones: [...wrathBuild.keystones, loneMessenger] };
    const withoutAuras = { ...withKeystone, buffs: [] };
    check('keystones: Lone Messenger disables the build auras',generator.evaluateBuild(withKeystone).scaling === generator.evaluateBuild(withoutAuras).scaling,
      generator.evaluateBuild(withKeystone).scaling.toFixed(3) + ' vs ' + generator.evaluateBuild(withoutAuras).scaling.toFixed(3));
  }
  if (timelessJewels.length === 1) {
    check('timeless: the conquered keystone shows as the conqueror\'s', timelessFireball.tree.keystones.includes(timelessJewels[0].keystone)
      && !timelessFireball.tree.keystones.includes(timelessJewels[0].conquers), timelessFireball.tree.keystones.join(', '));  }

  // Radius jewels (public/buildradius.js): each rule on the real tree, then a planned tree that holds them.
  const radiusModule = await import(pathToFileURL(path.join(root, 'public', 'buildradius.js')).href);
  const passiveTree = fullIndex.tree;
  const radiusChoice = name => fullIndex.radiusJewels.find(choice => choice.name === name);
  check('radius: radius jewels are tree choices, not worn uniques', fullIndex.radiusJewels.length >= 30
    && !fullIndex.uniques.some(unique => unique.name === 'Might of the Meek' || unique.name === 'Fortress Covenant'),
    String(fullIndex.radiusJewels.length));
  // The socket with the most notables and small passives in a Large radius, for the rules below.
  let busiestSocket = null;
  let busiestCount = -1;
  for (const node of passiveTree.nodes.values()) {
    if (node.kind !== 'jewel' || !node.position || node.largeCluster) {
      continue;
    }
    const count = radiusModule.areaOf(passiveTree, node.id, radiusChoice('Might of the Meek')).size;
    if (count > busiestCount) {
      busiestSocket = node.id;
      busiestCount = count;
    }
  }
  const placedAt = name => radiusModule.placementOf(passiveTree, busiestSocket, radiusChoice(name));
  const meek = placedAt('Might of the Meek');
  const inArea = kind => [...meek.area].map(id => passiveTree.nodes.get(id)).find(node => node.kind === kind && node.effects.some(effect => typeof effect.value === 'number'));
  const areaSmall = inArea('small');
  const areaNotable = inArea('notable');
  const meekSmall = radiusModule.nodeEffectsWith(areaSmall, [meek]);
  check('radius: Might of the Meek raises a small passive by half and empties a notable',
    meekSmall.every((effect, index) => typeof effect.value !== 'number' || Math.abs(effect.value - areaSmall.effects[index].value * 1.5) < 1e-9)
    && radiusModule.nodeEffectsWith(areaNotable, [meek]).length === 0, areaSmall.name + ' / ' + areaNotable.name);
  // Healthy Mind: increased Life in its area becomes increased Mana at twice the value.
  const lifeNode = [...passiveTree.nodes.values()].find(node => node.kind === 'small' && node.effects.length === 1
    && node.effects[0].kind === 'increased' && node.effects[0].stat === 'life' && !node.effects[0].subject && !(node.effects[0].tags || []).length);
  const healthy = { socket: 'test', choice: radiusChoice('Healthy Mind'), area: new Set([lifeNode.id]) };
  const healthyEffects = radiusModule.nodeEffectsWith(lifeNode, [healthy]);
  check('radius: Healthy Mind turns increased Life into twice the increased Mana',
    healthyEffects.length === 1 && healthyEffects[0].stat === 'mana' && healthyEffects[0].value === lifeNode.effects[0].value * 2,
    JSON.stringify(healthyEffects));
  // Brute Force Solution: a Strength passive gives Intelligence; "+X to all Attributes" moves its Strength share.
  const strengthNode = [...passiveTree.nodes.values()].find(node => node.kind === 'small' && node.effects.length === 1
    && node.effects[0].kind === 'flat' && node.effects[0].stat === 'strength');
  const bruteForce = { socket: 'test', choice: radiusChoice('Brute Force Solution'), area: new Set([strengthNode.id]) };
  const bruteEffects = radiusModule.nodeEffectsWith(strengthNode, [bruteForce]);
  check('radius: Brute Force Solution turns Strength into Intelligence', bruteEffects.length === 1 && bruteEffects[0].stat === 'intelligence',
    JSON.stringify(bruteEffects));
  // Unnatural Instinct: allocated small passives give nothing; the unallocated ones give their bonuses.
  const instinct = placedAt('Unnatural Instinct');
  const instinctSmalls = [...instinct.area].filter(id => passiveTree.nodes.get(id).kind === 'small');
  const oneAllocated = new Set([instinctSmalls[0]]);
  const instinctAdded = radiusModule.jewelAdditions(passiveTree, instinct, oneAllocated);
  const expectedCount = instinctSmalls.slice(1).reduce((total, id) => total + passiveTree.nodes.get(id).effects.length, 0);
  check('radius: Unnatural Instinct grants the unallocated small passives and empties the allocated one',
    instinctSmalls.length > 1 && instinctAdded.length === expectedCount
    && radiusModule.nodeEffectsWith(passiveTree.nodes.get(instinctSmalls[0]), [instinct]).length === 0,
    instinctSmalls.length + ' smalls, ' + instinctAdded.length + ' effects');
  // Transcendent Flesh: its lines count per 10 Strength on allocated or unallocated passives in its area.
  const flesh = { socket: 'test', choice: radiusChoice('Transcendent Flesh'), area: new Set([strengthNode.id]) };
  const fleshAllocated = radiusModule.jewelAdditions(passiveTree, flesh, new Set([strengthNode.id]));
  const fleshUnallocated = radiusModule.jewelAdditions(passiveTree, flesh, new Set());
  check('radius: Transcendent Flesh counts Strength on allocated and unallocated passives',
    fleshAllocated.some(effect => effect.stat === 'strength' && effect.value === -strengthNode.effects[0].value)
    && fleshUnallocated.some(effect => effect.stat === 'critMulti' && effect.value === 7 * Math.floor(strengthNode.effects[0].value / 10)),
    JSON.stringify(fleshAllocated) + ' | ' + JSON.stringify(fleshUnallocated));
  // Thread of Hope's ring leaves out the passives inside it; Impossible Escape's area is round its keystone.
  const ringChoice = radiusChoice('Thread of Hope (Large Ring)');
  const ring = radiusModule.areaOf(passiveTree, busiestSocket, ringChoice);
  const socketPosition = passiveTree.nodes.get(busiestSocket).position;
  const ringDistances = [...ring].map(id => Math.hypot(passiveTree.nodes.get(id).position.x - socketPosition.x, passiveTree.nodes.get(id).position.y - socketPosition.y));
  check('radius: Thread of Hope reaches only its ring', ring.size > 0
    && ringDistances.every(distance => distance > ringChoice.area.inner && distance <= ringChoice.area.outer), String(ring.size));
  // A typical seed's few hundredths of a percent of "chance to gain an Endurance Charge" keep no charges.
  // (on the quick index: the full one's tree already gives this build its charges)
  const plainIndex = generator.prepareMechanics(JSON.parse(fs.readFileSync(path.join(buildsDirectory, 'mechanics-poe1.json'), 'utf8')));
  const enduranceTrial = { ...generator.bestBuildFor(named(plainIndex.skills, 'Fireball'), named(plainIndex.ascendancies, 'Elementalist'), plainIndex).build };
  const withTinyChance = { ...enduranceTrial, notables: [...enduranceTrial.notables, { name: 'tiny', effects: [{ kind: 'chance', stat: 'enduranceCharge', value: 0.04, condition: 'onKill' }] }] };
  const withRealChance = { ...enduranceTrial, notables: [...enduranceTrial.notables, { name: 'real', effects: [{ kind: 'chance', stat: 'enduranceCharge', value: 5, condition: 'onKill' }] }] };
  check('endurance: a typical seed\'s tiny charge chance is no source, a real one is',
    generator.evaluateBuild(withTinyChance).ehp === generator.evaluateBuild(enduranceTrial).ehp
    && generator.evaluateBuild(withRealChance).ehp > generator.evaluateBuild(enduranceTrial).ehp,
    [enduranceTrial, withTinyChance, withRealChance].map(build => Math.round(generator.evaluateBuild(build).ehp)).join(' / '));
  // Timeless jewels conquer the passives in their radius (scripts/timeless_conquest.py, the conquer rule), for a
  // typical seed, and a conquered passive is theirs alone: no other jewel's rule changes it.
  const timelessJewel = name => fullIndex.timeless.find(choice => choice.jewel === name && choice.keystone === null);
  const conqueredAt = (name, node) => radiusModule.nodeEffectsWith(node, [radiusModule.placementOf(passiveTree, busiestSocket, timelessJewel(name))]);
  const attributeSmall = [...passiveTree.nodes.values()].find(node => node.kind === 'small' && node.effects.length === 1
    && node.effects[0].kind === 'flat' && node.effects[0].stat === 'strength' && meek.area.has(node.id));
  const otherSmall = [...meek.area].map(id => passiveTree.nodes.get(id)).find(node => node.kind === 'small'
    && node.effects.length > 0 && node.effects.every(effect => effect.kind !== 'flat' || effect.stat !== 'strength'));
  check('timeless: every timeless jewel has a conquest and a choice without a keystone',
    ['Lethal Pride', 'Brutal Restraint', 'Glorious Vanity', 'Elegant Hubris', 'Militant Faith', 'Heroic Tragedy'].every(name => timelessJewel(name)?.rules[0]?.rule === 'conquer'),
    fullIndex.timeless.filter(choice => choice.keystone === null).map(choice => choice.jewel).join(', '));
  const prideAttribute = conqueredAt('Lethal Pride', attributeSmall);
  const prideOther = conqueredAt('Lethal Pride', otherSmall);
  check('timeless: Lethal Pride adds 2 Strength to an attribute passive and 4 to another small one',
    prideAttribute.length === 2 && prideAttribute[1].stat === 'strength' && prideAttribute[1].value === 2
    && prideOther.length === otherSmall.effects.length + 1 && prideOther.at(-1).stat === 'strength' && prideOther.at(-1).value === 4,
    JSON.stringify(prideAttribute) + ' | ' + JSON.stringify(prideOther));
  check('timeless: Elegant Hubris empties small passives', conqueredAt('Elegant Hubris', otherSmall).length === 0
    && conqueredAt('Elegant Hubris', attributeSmall).length === 0);
  const vanityNotable = conqueredAt('Glorious Vanity', areaNotable);
  check('timeless: Glorious Vanity replaces a notable with its typical one',
    vanityNotable.length > 10 && !vanityNotable.some(effect => areaNotable.effects.includes(effect)), String(vanityNotable.length));
  const faithNotable = conqueredAt('Militant Faith', areaNotable);
  const firstNumber = areaNotable.effects.find(effect => typeof effect.value === 'number');
  check('timeless: Militant Faith keeps a notable four times in five',
    faithNotable.some(effect => effect.stat === firstNumber.stat && Math.abs(effect.value - firstNumber.value * 0.8) < 1e-9),
    JSON.stringify(faithNotable.slice(0, 3)));
  const light = fullIndex.radiusJewels.find(choice => choice.baseName === 'The Light of Meaning');
  const lightAt = radiusModule.placementOf(passiveTree, busiestSocket, light);
  const prideAt = radiusModule.placementOf(passiveTree, busiestSocket, timelessJewel('Lethal Pride'));
  check('timeless: a conquered passive takes no other jewel\'s rule, whichever came first',
    JSON.stringify(radiusModule.nodeEffectsWith(otherSmall, [lightAt, prideAt])) === JSON.stringify(prideOther)
    && JSON.stringify(radiusModule.nodeEffectsWith(otherSmall, [prideAt, lightAt])) === JSON.stringify(prideOther)
    && radiusModule.nodeEffectsWith(otherSmall, [lightAt]).length === otherSmall.effects.length + light.rules[0].effects.length,
    light.name);
  const escape = fullIndex.radiusJewels.find(choice => choice.baseName === 'Impossible Escape');
  check('radius: Impossible Escape reaches its keystone from any socket',
    radiusModule.areaOf(passiveTree, busiestSocket, escape).has(escape.area.around), escape.name);
  // A planned tree: every radius jewel is placed once at most, the passives taken without a path lie in a
  // free-allocation jewel's area, and every other passive joins the class start without passing through them.
  const radiusBuild = generator.finalizeTree(generator.bestBuildFor(named(fullIndex.skills, 'Cyclone'), named(fullIndex.ascendancies, 'Slayer'), fullIndex).build, fullIndex);
  const radiusJewelsPlaced = (radiusBuild.tree.jewels || []).filter(jewel => jewel.kind === 'radius');
  const baseNames = radiusJewelsPlaced.map(jewel => jewel.baseName);
  check('radius: a Cyclone Slayer places radius jewels, one of each', radiusJewelsPlaced.length > 0 && new Set(baseNames).size === baseNames.length,
    baseNames.join(', '));
  const floatingNodes = new Set(radiusBuild.tree.floating || []);
  const freeAreas = radiusJewelsPlaced.filter(jewel => jewel.free).map(jewel => radiusModule.areaOf(passiveTree, jewel.socket, radiusChoice(jewel.name)));
  check('radius: passives taken without a path lie in a free-allocation area',
    [...floatingNodes].every(id => freeAreas.some(area => area.has(id))), [...floatingNodes].join(', '));
  const startId = passiveTree.starts[radiusBuild.ascendancy.baseClass];
  const joined = new Set([startId]);
  let reachedNow = [startId];
  while (reachedNow.length > 0) {
    const next = [];
    for (const id of reachedNow) {
      for (const neighbour of passiveTree.nodes.get(id).neighbours) {
        if (radiusBuild.tree.nodes.includes(neighbour) && !floatingNodes.has(neighbour) && !joined.has(neighbour)) {
          joined.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    reachedNow = next;
  }
  const unjoined = radiusBuild.tree.nodes.filter(id => !joined.has(id) && !floatingNodes.has(id));
  check('radius: every other passive joins the start without a free-allocated one', unjoined.length === 0, unjoined.join(', '));

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
  // "Include these items": the uniques are worn from the start, only on weapons they fit, and kept to the end.
  check('limits: included items count as one limit', search.limitCount({ class: 'Duelist', uniques: ['Starforge', 'Mageblood'] }) === 2);
  const includeLimits = { class: 'Duelist', uniques: ['Starforge'] };
  const cycloneVariant = search.skillVariants(quickIndex, includeLimits, false).find(variant => variant.skill === 'Cyclone');
  const cycloneWithStarforge = generator.planSkill(named(quickIndex.skills, 'Cyclone'), quickIndex, { requiredUniques: ['Starforge'], noStacking: true });
  check('include items: a required two-handed sword leaves only two-handed sword plans', cycloneWithStarforge.plans.length > 0
    && cycloneWithStarforge.plans.every(plan => plan.weapon === 'twoHandSword' && plan.build.uniques.some(unique => unique.name === 'Starforge')),
    cycloneWithStarforge.plans.map(plan => plan.weapon).join(', '));
  const includeQuick = search.quickPlans(cycloneVariant, quickIndex, ['Slayer'], { limits: includeLimits });
  check('include items: the quick pass keeps the build', includeQuick.length === 1);
  const twoBodies = search.quickPlans(cycloneVariant, quickIndex, ['Slayer'], { limits: { class: 'Duelist', uniques: ['Kaom\'s Heart', 'Stasis Prison'] } });
  check('include items: two body armours can\'t both be worn, so no build', twoBodies.length === 0);
  const includedCard = search.fullPlan(cycloneVariant, 'Slayer', fullIndex, { limits: includeLimits, gearRounds: 0 });
  check('include items: the full plan still wears it after the agents', Boolean(includedCard) && includedCard.uniques.includes('Starforge'),
    includedCard && includedCard.uniques.join(', '));
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
  // now leaves it short of mana, so the test asks that the mana it stacks keeps its skill going. Since Skin of the
  // Lords comes in one version per keystone (2026-11-23) the plain plan in it scores about 11% above the stacked one,
  // so the test plans the stacked commitment on its own rather than asking it to win. Its upkeep was 0.99 while Skin of
  // the Lords was read with all 49 keystones at once (Eldritch Battery among them); read as one, the stacked plan wears
  // Belly of the Beast and pays for about 85% of its uses, so the bar is 80%.
  const sparkPlan = generator.planSkill(named(gearIndex.skills, 'Spark of the Nova'), gearIndex, {});
  const manaPlan = sparkPlan.plans.find(plan => plan.stacking === 'mana');
  const stackedCaster = manaPlan ? generator.composeForAscendancy({ ...sparkPlan, plans: [manaPlan] }, named(gearIndex.ascendancies, 'Hierophant'), gearIndex, {}).build : null;
  const casterUpkeep = stackedCaster ? generator.evaluateBuild(stackedCaster).upkeep : { share: 0 };
  check('stacking: Spark Hierophant has a mana plan that pays for its skill', stackedCaster !== null && stackedCaster.stacking === 'mana' && casterUpkeep.share >= 0.8,
    (stackedCaster ? String(stackedCaster.stacking) : 'no mana plan') + ', upkeep ' + casterUpkeep.share.toFixed(2));

  // Revisiting gear (public/buildrevisit.js) at made-up prices: every unique at 0.01 Divines, The Caged Mammoth at 3.
  const revisit = await import(pathToFileURL(path.join(root, 'public', 'buildrevisit.js')).href);
  const revisitPrices = {};
  for (const unique of gearIndex.uniques) {
    revisitPrices[unique.name] = 1;
  }
  revisitPrices['The Caged Mammoth'] = 300;
  generator.attachPrices(gearIndex, revisitPrices, 100);
  const powerOf = build => generator.evaluateBuild(build).score;
  const gloves = revisit.slotOptions(geared, gearIndex, 'gloves', 1, { scoreOf: powerOf });
  const gloveUniques = gloves.options.filter(option => option.kind === 'unique');
  check('revisit: a slot offers only uniques of that slot', gloveUniques.length > 0
    && gloveUniques.every(option => named(gearIndex.uniques, option.name).category === 'Gloves'), gloveUniques.map(option => option.name).join(', '));
  check('revisit: a slot keeps to its budget', gloveUniques.every(option => option.price <= 1) && !gloveUniques.some(option => option.name === 'The Caged Mammoth'));
  const gloveRares = gloves.options.filter(option => option.kind === 'rare');
  check('revisit: a rare at each gear level, with an item to price', gloveRares.length === 3 && gloveRares.every(option => option.item && option.item.craftBase),
    gloveRares.map(option => option.level).join(', '));
  // A unique taking the gloves' place has the rares left solved again, so the build's resistances stay capped.
  const firstGloves = named(gearIndex.uniques, gloveUniques[0].name);
  const withGloves = { ...geared, uniques: [...geared.uniques, firstGloves], gear: { ...geared.gear, items: geared.gear.items.filter(item => item.slot !== 'gloves') } };
  const regeared = gearModule.solveGear({ ...withGloves, gear: undefined }, gearIndex.gear, generator.gearEngineFor(), geared.gear.level);
  check('revisit: rares solved again around a new unique keep resistances capped',
    Object.values(generator.gearNeedsOf(regeared).resistanceShort).every(short => short <= 0), JSON.stringify(generator.gearNeedsOf(regeared).resistanceShort));
  const jewels = revisit.jewelOptions(geared, gearIndex, 1, { scoreOf: powerOf });
  check('revisit: unique jewels offered are jewels that add to the build', jewels.options.length > 0
    && jewels.options.every(option => named(gearIndex.uniques, option.name).category === 'Jewel' && option.change > 0));
  const cheapSet = revisit.setComparison(geared, gearIndex, 0.05, { scoreOf: powerOf });
  const swappedSlots = cheapSet.slots.filter(entry => entry.unique !== null);
  check('revisit: the cheap-unique set takes uniques under the cap and sums their prices', swappedSlots.length > 0
    && swappedSlots.every(entry => entry.unique.price <= 0.05) && Math.abs(cheapSet.uniquesCost - swappedSlots.length * 0.01) < 1e-9,
    JSON.stringify(cheapSet.slots.map(entry => entry.unique && entry.unique.name)));
  // The planner's gear rounds (improveGear): every change logged raises the score by at least 0.5%, the result is
  // never worse than the start, it wears one of each item, and a change the planner refuses isn't made.
  const rounds = revisit.improveGear(geared, gearIndex, { scoreOf: powerOf });
  check('gear rounds: never lower the score', powerOf(rounds.build) >= powerOf(geared),
    powerOf(rounds.build).toFixed(2) + ' vs ' + powerOf(geared).toFixed(2));
  check('gear rounds: each change gains at least 0.5%', rounds.log.every(entry => entry.change >= 0.005), JSON.stringify(rounds.log));
  const itemNames = rounds.build.uniques.map(unique => unique.baseName || unique.name);
  check('gear rounds: one of each item', new Set(itemNames).size === itemNames.length, itemNames.join(', '));
  const refused = revisit.improveGear(geared, gearIndex, { scoreOf: powerOf, accept: () => false });
  check('gear rounds: a refused change is not made', refused.log.length === 0 && refused.build === geared);
} else {
  console.log('(no gear data: run npm run craft:build and scripts/build_gear_mods.py for the gear checks)');
}

if (failures.length > 0) {
  console.log('\n' + failures.length + ' failed.');
  process.exit(1);
}
console.log('\nAll passed.');
