// Generates the Build maker's own build ideas: for every main skill and every ascendancy, the build
// public/buildgen.js composes from the game's mechanics, then checks each against poe.ninja's player counts.
//
//   node scripts/generate_builds.mjs
//
// Reads public/data/builds/mechanics-poe1.json (scripts/build_mechanics.py) and the meta files
// (scripts/fetch_build_meta.py); writes public/data/builds/generated-poe1.json and prints a calibration report:
// how many of the most played archetypes the generator found on its own, and how many of its ideas land in the
// niche band (played, but by few).
//
// The skills are planned in worker threads (one per core, less two; GENERATE_WORKERS sets the count, 1 runs one
// worker). Each skill is planned on its own, and the results are put back in skill order, so the output is the same
// with any number of workers.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILDS = path.join(ROOT, 'public', 'data', 'builds');
// GENERATE_OUT writes elsewhere (to compare two runs without touching the published file).
const OUT = process.env.GENERATE_OUT ? path.resolve(process.env.GENERATE_OUT) : path.join(BUILDS, 'generated-poe1.json');
const engine = await import(pathToFileURL(path.join(ROOT, 'public', 'buildgen.js')).href);
const gearEngine = await import(pathToFileURL(path.join(ROOT, 'public', 'buildgear.js')).href);

const CALIBRATION_TOP_ARCHETYPES = 30;
const CALIBRATION_GENERATED_TOP = 300;
const NICHE_YIELD_TOP = 100;
const CALIBRATION_MIN_PLAYERS = 100;
const ASCENDANCIES_KEPT_PER_SKILL = 5;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

// The prices scripts/fetch_unique_prices.py saved for the current league, or null.
function readUniquePrices() {
  const current = readJson(path.join(BUILDS, 'leagues-poe1.json')).leagues.find(league => league.current);
  if (!current) {
    return null;
  }
  const file = path.join(ROOT, '.cache', 'ninja', 'unique-prices-' + current.url + '.json');
  if (!existsSync(file)) {
    return null;
  }
  return readJson(file);
}

function readMeta() {
  const leagues = readJson(path.join(BUILDS, 'leagues-poe1.json')).leagues;
  let current = null;
  const past = [];
  for (const league of leagues) {
    const meta = readJson(path.join(BUILDS, league.file));
    if (league.current) {
      current = meta;
    } else {
      past.push(meta);
    }
  }
  return { current, past };
}

function roundTo(value, places) {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

// What the file keeps of a build: the engine's compactBuild, which the build planner's cards share.
const compactBuild = engine.compactBuild;

// The kept builds' trees, planned again with every other piece in place (as the page does), and their scores
// with that tree. With prices, each also gets its value plan (see valuePlanOf).
// A kept build with the tree its own pieces call for, and its value plan; null when it can't be rebuilt.
function finalizeOne(stored, index, skillPlans) {
  const build = engine.rebuildFromNames({ ...stored, keystones: [] }, index);
  if (!build) {
    return null;
  }
  const evaluation = engine.evaluateBuild(build);
  const fresh = compactBuild(build, evaluation);
  const entry = { ...stored, ...fresh, players: stored.players, band: stored.band, pastPlayers: stored.pastPlayers };
  if (index.priced) {
    entry.value = valuePlanOf(stored, build, index, skillPlans);
  }
  return entry;
}

// The pieces of a stored build that its plan chose (the tree is planned from them).
function chosenPieces(stored) {
  return JSON.stringify([stored.weapon, stored.supports, stored.notables, stored.uniques, stored.buffs, stored.flasks]);
}

// The second score: the same skill and ascendancy planned again with pieces chosen for their gain over their price.
// Stored beside the power plan as its own pieces, its power ("score"), its value (power over the price penalty)
// and its uniques' cost. When it picks the same pieces as the power plan, the power plan's tree serves it too.
function valuePlanOf(stored, powerBuild, index, skillPlans) {
  const ascendancy = index.ascendancies.find(entry => entry.name === stored.ascendancy);
  const { build } = engine.composeForAscendancy(skillPlans.get(stored.skill), ascendancy, index, { priced: true });
  if (!build) {
    return null;
  }
  const chosen = compactBuild(build, engine.evaluateBuild(build));
  let finished = powerBuild;
  if (chosenPieces(chosen) !== chosenPieces(stored)) {
    finished = engine.rebuildFromNames({ ...chosen, keystones: [] }, index);
    if (!finished) {
      return null;
    }
  }
  const plan = compactBuild(finished, engine.evaluateBuild(finished));
  return {
    weapon: plan.weapon, score: plan.score, value: roundTo(engine.valueScore(finished), 3), cost: plan.cost,
    scaling: plan.scaling, defence: plan.defence, crit: plan.crit, supports: plan.supports, notables: plan.notables,
    keystones: plan.keystones, uniques: plan.uniques, buffs: plan.buffs, flasks: plan.flasks, treeNotables: plan.treeNotables,
    treePoints: plan.treePoints, treeMasteries: plan.treeMasteries, treeJewels: plan.treeJewels,
  };
}

// Each skill's best few ascendancies are kept, and any pairing people actually play.
function keptBuilds(builds) {
  const bySkill = new Map();
  for (const build of builds) {
    if (!bySkill.has(build.skill)) {
      bySkill.set(build.skill, []);
    }
    bySkill.get(build.skill).push(build);
  }
  const kept = [];
  for (const skillBuilds of bySkill.values()) {
    const byScore = [...skillBuilds].sort((first, second) => second.score - first.score);
    byScore.forEach((build, position) => {
      if (position < ASCENDANCIES_KEPT_PER_SKILL || build.players > 0) {
        kept.push(build);
      }
    });
  }
  kept.sort((first, second) => second.idea - first.idea || first.ascendancy.localeCompare(second.ascendancy) || first.skill.localeCompare(second.skill));
  return kept;
}

function pastPlayers(pastMetas, ascendancy, skill) {
  let players = 0;
  for (const meta of pastMetas) {
    players += meta.populations?.[ascendancy]?.[skill] ?? 0;
  }
  return players;
}

// How much better an ascendancy suits a skill than the skill's typical ascendancy: the build's score over the
// median score of the same skill across all ascendancies. Ideas are ranked by this fit, blended with the
// build's own score, so a strong pairing stands out whatever family of skill it is.
function addFit(builds) {
  const scoresBySkill = new Map();
  for (const build of builds) {
    if (!scoresBySkill.has(build.skill)) {
      scoresBySkill.set(build.skill, []);
    }
    scoresBySkill.get(build.skill).push(build.score);
  }
  const allScores = builds.map(build => build.score).sort((first, second) => first - second);
  const overallMedian = allScores[Math.floor(allScores.length / 2)];
  for (const build of builds) {
    const scores = [...scoresBySkill.get(build.skill)].sort((first, second) => first - second);
    const median = scores[Math.floor(scores.length / 2)];
    build.fit = roundTo(build.score / median, 3);
    build.idea = roundTo(build.fit * Math.sqrt(build.score / overallMedian), 3);
  }
}

// Calibration 1: for each skill people play a lot, is the ascendancy they pick most among the generator's three
// best for that skill? Picking at random would hit 3 in 21.
function ascendancyCalibration(builds, current) {
  const bySkill = new Map();
  for (const build of builds) {
    if (!bySkill.has(build.skill)) {
      bySkill.set(build.skill, []);
    }
    bySkill.get(build.skill).push(build);
  }
  const playersBySkill = new Map();
  for (const [ascendancy, skills] of Object.entries(current.populations)) {
    for (const [skill, players] of Object.entries(skills)) {
      if (!playersBySkill.has(skill)) {
        playersBySkill.set(skill, []);
      }
      playersBySkill.get(skill).push({ ascendancy, players });
    }
  }
  let tested = 0;
  let hits = 0;
  const misses = [];
  for (const [skill, entries] of playersBySkill.entries()) {
    let total = 0;
    for (const entry of entries) {
      total += entry.players;
    }
    const generated = bySkill.get(skill);
    if (total < CALIBRATION_MIN_PLAYERS || !generated) {
      continue;
    }
    entries.sort((first, second) => second.players - first.players);
    const favourite = entries[0].ascendancy;
    const ranked = [...generated].sort((first, second) => second.score - first.score).map(build => build.ascendancy);
    tested += 1;
    if (ranked.slice(0, 3).includes(favourite)) {
      hits += 1;
    } else {
      misses.push(`${skill}: players pick ${favourite}, generator ${ranked.slice(0, 3).join('/')}`);
    }
  }
  return { tested, hits, misses };
}

function calibrate(builds, current) {
  const generatedRank = new Map();
  builds.forEach((build, position) => generatedRank.set(build.ascendancy + '|' + build.skill, position + 1));
  const top = current.archetypes.slice(0, CALIBRATION_TOP_ARCHETYPES);
  let found = 0;
  for (const archetype of top) {
    const rank = generatedRank.get(archetype.ascendancy + '|' + archetype.skill);
    if (rank !== undefined && rank <= CALIBRATION_GENERATED_TOP) {
      found += 1;
    }
  }
  const bandCounts = {};
  for (const build of builds.slice(0, NICHE_YIELD_TOP)) {
    bandCounts[build.band] = (bandCounts[build.band] || 0) + 1;
  }
  return { found, bandCounts, ascendancy: ascendancyCalibration(builds, current) };
}

function pieceFrequencies(builds, field) {
  const counts = new Map();
  for (const build of builds) {
    for (const name of build[field] || []) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((first, second) => second[1] - first[1]);
}

// The mechanics, tree, rare gear and prices, prepared the same way in the main thread and in every worker.
function loadIndex(say) {
  const mechanics = readJson(path.join(BUILDS, 'mechanics-poe1.json'));
  const tree = readJson(path.join(BUILDS, 'tree-poe1.json'));
  // Rare gear from the Crafting tab's data (scripts/build_gear_mods.py), when it is built; else the fixed gear figures.
  const gearFile = path.join(ROOT, 'public', 'data', 'craft', 'gear-poe1.json');
  const gear = existsSync(gearFile) ? readJson(gearFile) : null;
  say(gear ? 'rare gear: solved from public/data/craft/gear-poe1.json' : 'rare gear: fixed figures (no public/data/craft/gear-poe1.json)');
  const index = engine.prepareMechanics(mechanics, tree, gear);
  const prices = readUniquePrices();
  if (prices) {
    engine.attachPrices(index, prices.prices, prices.divineChaos);
    say(`unique prices from ${prices.pricesFrom || prices.league}, ${prices.fetched} (1 Divine = ${prices.divineChaos} chaos)`);
  } else {
    say('no unique prices (run scripts/fetch_unique_prices.py): planning without them');
  }
  return { mechanics, index, prices };
}

// ---------- a worker: plans the skills it is given and keeps their plans for the final trees ----------
function workerMain() {
  const { index } = loadIndex(() => {});
  const skillPlans = new Map();
  parentPort.on('message', message => {
    if (message.type === 'plan') {
      const skill = index.skills.find(candidate => candidate.name === message.skill);
      const plan = engine.planSkill(skill, index);
      skillPlans.set(skill.name, plan);
      const builds = [];
      if (plan.plans.length > 0) {
        for (const ascendancy of index.ascendancies) {
          const { build, evaluation } = engine.composeForAscendancy(plan, ascendancy, index);
          if (build && evaluation.score > 0) {
            builds.push(compactBuild(build, evaluation));
          }
        }
      }
      parentPort.postMessage({ type: 'planned', skill: skill.name, builds });
    } else if (message.type === 'finalize') {
      // Any worker finalizes any build: one without that skill's plan makes it (planning is deterministic, so it is
      // the same plan the first worker made).
      if (!skillPlans.has(message.stored.skill)) {
        const skill = index.skills.find(candidate => candidate.name === message.stored.skill);
        skillPlans.set(skill.name, engine.planSkill(skill, index));
      }
      parentPort.postMessage({ type: 'finalized', position: message.position, finalized: finalizeOne(message.stored, index, skillPlans) });
    }
  });
  parentPort.postMessage({ type: 'ready' });
}

function workerCount() {
  const asked = Number(process.env.GENERATE_WORKERS);
  if (Number.isInteger(asked) && asked > 0) {
    return asked;
  }
  return Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 2);
}

function startWorkers(count) {
  const workers = [];
  for (let position = 0; position < count; position += 1) {
    const worker = new Worker(fileURLToPath(import.meta.url));
    workers.push({ worker, ready: new Promise(resolve => worker.once('message', resolve)) });
  }
  return workers;
}

// Every skill planned, a free worker taking the next one; returns each skill's builds and which worker has its plan.
async function planAll(workers, skillNames) {
  const buildsBySkill = new Map();
  const ownerOf = new Map();
  const started = Date.now();
  let next = 0;
  let done = 0;
  await Promise.all(workers.map(entry => entry.ready));
  await Promise.all(workers.map((entry, position) => new Promise(resolve => {
    const giveNext = () => {
      if (next >= skillNames.length) {
        resolve();
        return;
      }
      const skill = skillNames[next];
      next += 1;
      ownerOf.set(skill, position);
      entry.worker.postMessage({ type: 'plan', skill });
    };
    entry.worker.on('message', message => {
      if (message.type !== 'planned') {
        return;
      }
      buildsBySkill.set(message.skill, message.builds);
      done += 1;
      if (done % 50 === 0) {
        console.log(`  ${done}/${skillNames.length} skills, ${Math.round((Date.now() - started) / 1000)} s`);
      }
      giveNext();
    });
    giveNext();
  })));
  for (const entry of workers) {
    entry.worker.removeAllListeners('message');
  }
  return { buildsBySkill, ownerOf };
}

// The kept builds finalized one at a time by whichever worker is free, preferring a build whose skill that worker
// planned, back in the kept order.
async function finalizeAll(workers, kept, ownerOf) {
  const results = new Array(kept.length).fill(null);
  const waiting = new Set(kept.map((stored, position) => position));
  let done = 0;
  const nextFor = workerPosition => {
    for (const position of waiting) {
      if (ownerOf.get(kept[position].skill) === workerPosition) {
        return position;
      }
    }
    const first = waiting.values().next();
    return first.done ? null : first.value;
  };
  await Promise.all(workers.map((entry, workerPosition) => new Promise(resolve => {
    const giveNext = () => {
      const position = nextFor(workerPosition);
      if (position === null) {
        resolve();
        return;
      }
      waiting.delete(position);
      entry.worker.postMessage({ type: 'finalize', stored: kept[position], position });
    };
    entry.worker.on('message', message => {
      if (message.type !== 'finalized') {
        return;
      }
      results[message.position] = message.finalized;
      done += 1;
      if (done % 500 === 0) {
        console.log(`  final trees: ${done}/${kept.length}`);
      }
      giveNext();
    });
    giveNext();
  })));
  return results.filter(entry => entry !== null);
}

async function main() {
  const { mechanics, index, prices } = loadIndex(message => console.log(message));
  const { current, past } = readMeta();
  const mainSkills = index.skills.filter(skill => skill.main);
  const count = workerCount();
  console.log(`planning in ${count} worker thread${count === 1 ? '' : 's'}`);
  const started = Date.now();
  const workers = startWorkers(count);
  const { buildsBySkill, ownerOf } = await planAll(workers, mainSkills.map(skill => skill.name));
  // In skill order, as one thread would have made them, with poe.ninja's player counts.
  const builds = [];
  for (const skill of mainSkills) {
    for (const compact of buildsBySkill.get(skill.name) || []) {
      const verdict = engine.verifyBuild(compact.ascendancy, compact.skill, current.populations);
      compact.players = verdict.players;
      compact.band = verdict.band.id;
      compact.pastPlayers = pastPlayers(past, compact.ascendancy, compact.skill);
      builds.push(compact);
    }
  }
  addFit(builds);
  builds.sort((first, second) => second.idea - first.idea || first.ascendancy.localeCompare(second.ascendancy) || first.skill.localeCompare(second.skill));
  const calibration = calibrate(builds, current);
  const ascendancyHitRate = calibration.ascendancy.tested > 0 ? calibration.ascendancy.hits / calibration.ascendancy.tested : 0;
  const kept = keptBuilds(builds);
  console.log(`  final trees for ${kept.length} kept builds`);
  const finalized = await finalizeAll(workers, kept, ownerOf);
  for (const entry of workers) {
    await entry.worker.terminate();
  }
  const output = {
    built: new Date().toISOString().slice(0, 10), patch: mechanics.patch, league: current.league,
    leagueUrl: current.leagueUrl, method: 'scripts/generate_builds.mjs with public/buildgen.js',
    // Two scores per build: "score" is the power plan's, chosen without prices (fit and calibration use it); "value"
    // holds the plan chosen for gain over price. "cost" is the uniques' price in Divines at these prices.
    prices: prices ? { from: prices.pricesFrom || prices.league, fetched: prices.fetched } : null,
    calibration: {
      favouriteAscendancyInTop3: roundTo(ascendancyHitRate, 3), skillsTested: calibration.ascendancy.tested,
      topArchetypesFound: calibration.found, of: CALIBRATION_TOP_ARCHETYPES, within: CALIBRATION_GENERATED_TOP,
      bandsInTop: calibration.bandCounts,
    },
    // Fit and calibration come from the comparison above (one tree per class); the kept builds then get the tree
    // their own pieces call for, which is what the page shows.
    // Rare gear in its short form (storeGear): the page brings back the affix text from the gear data.
    builds: finalized.map(entry => (entry.gear ? { ...entry, gear: gearEngine.storeGear(entry.gear) } : entry)),
  };
  writeFileSync(OUT, JSON.stringify(output));
  console.log(`${builds.length} builds from ${mainSkills.length} skills x ${index.ascendancies.length} ascendancies in ${Math.round((Date.now() - started) / 1000)} s -> ${path.relative(ROOT, OUT)}`);
  console.log(`calibration: for ${calibration.ascendancy.hits} of ${calibration.ascendancy.tested} skills with ${CALIBRATION_MIN_PLAYERS}+ players, their most played ascendancy is in the generator's top 3 (${Math.round(100 * ascendancyHitRate)}%; random: 14%)`);
  console.log(`  ${calibration.found} of poe.ninja's top ${CALIBRATION_TOP_ARCHETYPES} archetypes are in the generator's top ${CALIBRATION_GENERATED_TOP} ideas`);
  console.log(`  some misses: ${calibration.ascendancy.misses.slice(0, 12).join('; ')}`);
  console.log(`bands of the top ${NICHE_YIELD_TOP} ideas: ${JSON.stringify(calibration.bandCounts)}`);
  for (const field of ['uniques', 'keystones', 'supports', 'buffs', 'flasks']) {
    const top = pieceFrequencies(builds, field).slice(0, 8).map(([name, count]) => `${name} ${Math.round(100 * count / builds.length)}%`);
    console.log(`most used ${field}: ${top.join(', ')}`);
  }
}

if (isMainThread) {
  await main();
} else {
  workerMain();
}

