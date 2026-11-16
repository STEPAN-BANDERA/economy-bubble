// The Farming strategies tab (PoE 1).
//
// A library of farming strategies: the map mechanics (Essence, Strongbox, Ritual,
// Abyss, Legion, Breach and so on) plus farms that aren't a map at all, like deep
// Delve, Uber Lab and uber boss kills. Each one lists the Atlas passives to take,
// the scarabs and other items to load per run, where to run, and what the drops
// are worth. Costs and drops are priced from live markets, so the net profit per
// run and per hour follows the league's real economy. A League stage menu reprices
// everything as it stood earlier in this league or in a finished one.
//
// Every quantity here is an editable estimate. Drop rates swing with your
// build, your Atlas, the map and plain luck, and the best loadout shifts each
// league. The baselines are gathered from public 3.29 ("Curse of the Allflame")
// farming guides and community sample runs (e.g. Wealthy Exile's public strategies);
// many are thin, and cards with no measured sample say so (roughNumbers). Yields and
// speed also depend on who's farming and when: they're one player at one moment.
// Change any number and the profit recomputes.
// Values are saved in your browser (nothing leaves it), and "Reset" puts a
// strategy back to the baseline.
//
// This file is only the data and the interface. The one piece of real maths,
// pricing a loadout, is priceLine below. A line gets its price from one of three
// places: the Currency Exchange by in-game name (actual trades, a day's median);
// poe.ninja by name, for uniques, beasts, Wombgifts, corpse items and Nightmare Maps the
// exchange doesn't trade (what people are listing them at now, so what you sell gets a
// discount; see indexNinjaLines for items poe.ninja lists many times over);
// or a Chaos estimate the viewer can edit, for things neither source prices.
// Past leagues add a fourth: poe.ninja's published daily dumps (see PAST_LEAGUES).

let X; // helpers from app.js: el, fmt, store, rerender, exchangePrice, todayDivine, exchangeVolume, iconByName, realm, league, priceWindow, stagesAvailable, pastLeaguesAvailable, stage
const S = {
  overrides: null, // the viewer's saved edits, loaded from storage once
  openCards: new Set(), // cards with their details unfolded, so editing a number doesn't fold them
  ninja: { league: null, status: 'idle', byType: new Map() }, // poe.ninja prices for the picked league
};

// ---------- league stages ----------
// What the picker offers: a 24-hour window starting this many days after the league's
// first hour. Days 1, 2 and 4 are there because the early ramp moves fastest: the very
// top players reach endgame by the end of day one, and the wider crowd over the next days.
export const FARM_STAGES = [
  { id: 'day1', label: 'Day 1', startDay: 0 },
  { id: 'day2', label: 'Day 2', startDay: 1 },
  { id: 'day4', label: 'Day 4', startDay: 3 },
  { id: 'week1', label: 'Week 1', startDay: 6 },
  { id: 'week2', label: 'Week 2', startDay: 13 },
  { id: 'week3', label: 'Week 3', startDay: 20 },
  { id: 'month1', label: 'Month 1', startDay: 30 },
  { id: 'month2', label: 'Month 2', startDay: 60 },
  { id: 'month3', label: 'Month 3', startDay: 90 },
];

// Finished leagues the picker can replay in full: exchange trades from GGG's API, and item
// prices from poe.ninja's dump (scripts/build_ninja_history.py writes the file). A league's
// first hour never changes, so it's kept here rather than searched for.
// Oldest first: a card's removedInLeague relies on this order.
export const PAST_LEAGUES = [
  { name: 'Mirage', historyFile: 'data/ninja-history/mirage.json', startHour: 1772827200, lastDay: '2026-07-20' },
];

// 3.30 (Covens of Umbra) removes scarabs from the game and adds Threads in their place, one type per primary league
// mechanic, up to eight per map (GGG's 3.30.0 patch notes, Endgame Changes). Each card keeps its 3.29 scarab loadout
// for replays of older leagues and lists its Threads beside it. Live since 3.30's launch (turned on 2026-11-14);
// SCARABS_REMOVED_IN_LEAGUE must match the name the league gets in PAST_LEAGUES once it ends.
export const THREADS_ARE_LIVE = true;
export const SCARABS_REMOVED_IN_LEAGUE = 'Covens of Umbra';
const THREADS_ROUGH_NUMBERS = 'Scarabs are gone since 3.30: the Threads here stand in for them at 8 per map, the most that count, before any free Threads a Shaped Region gives. The yields were gathered with 3.29 scarab loadouts and the 3.29 Atlas tree, and nobody has measured them with Threads yet.';

// The usual stages that fit the league, plus its last full day.
export function pastLeagueStages(pastLeague) {
  const stages = [];
  const lastDayStart = Date.parse(pastLeague.lastDay + 'T00:00:00Z') / 1000;
  const endStartDay = (lastDayStart - 86400 - pastLeague.startHour) / 86400;
  for (const stage of FARM_STAGES) {
    if (stage.startDay < endStartDay) {
      stages.push(stage);
    }
  }
  stages.push({ id: 'end', label: 'League end', startDay: endStartDay });
  return stages;
}

// ---------- the strategies ----------
// Difficulty and investment are rough bands for sorting and colour, not maths.
// scarabs / inputs: things you BUY and consume each run.
// threads: what 3.30 loads in place of the scarabs (see THREADS_ARE_LIVE); empty when no Thread
//   exists for the mechanic. Edits to them are kept apart from edits to the scarabs.
// outputs: things you SELL each run.
// A line names its item in one of these ways:
//   { name / item }                  priced from the exchange by name
//   { name / item, ninja: 'Beast' }  priced from poe.ninja (that item type); `chaos`
//                                    is the fallback when poe.ninja can't be reached.
//                                    Adding one? Rebuild public/data/ninja-history/ too:
//                                    those files hold only the items named here.
//   { label, chaos }                 no market price at all: an editable estimate
// An exchange line may carry `chaos` as well, for an item that hardly ever trades.
// notInPastLeagues: why an old league's price means nothing now (a removed craft, say);
//   past-league views show the line as "not counted" with this reason.
// removedInLeague: the first league (a name from PAST_LEAGUES) without this content. The
//   card then only shows when replaying a league older than that one. If GGG brings the
//   content back, delete the field.
// mapCost: Chaos spent per run on the map itself, alch/sustain and odds and ends.
// unit: what one run is, 'map' if left out ('kill', 'run', or 'hour' for something
//   with no natural run, like a mining session, which is simply priced per hour).
// roughNumbers: set when no measured sample backs the yields, which says why. The
//   card carries a warning so a high rank isn't mistaken for a measured result.
// variants: the same farm with a choice inside it (which boss, which map). The
//   card picks the most profitable until the viewer picks one.
const FOUR_FRAGMENTS = 4; // poedb: "Use four of these in a personal Map Device"
// A dedicated 0 HP miner's rate on bosses whose invulnerability phases don't slow it, as a player reported it.
const FAST_UBER_KILLS_PER_HOUR = 15;
const NIGHTMARE_MAP_DEVICE = [
  { name: 'Sacrifice at Dusk', qty: 1 },
  { name: 'Sacrifice at Dawn', qty: 1 },
  { name: 'Sacrifice at Midnight', qty: 1 },
];
const STRATEGIES = [
  {
    id: 'essence',
    name: 'Essence',
    blurb: 'Alch-and-go open maps, popping essence monoliths and corrupting the catches. Cheap to run, sells in bulk, scales straight into the corrupted essences that pay.',
    difficulty: 'Medium', investment: 'Low',
    atlas: 'Full Essence wheel — Lithomancy, Crystal Resonance and Infinite Possibility (the last adds Remnants of Corruption, i.e. corrupted essences). Take extra-monster and pack-size nodes on the way.',
    maps: 'Fast open layouts you can clear in a couple of minutes: City Square, Jungle Valley, Dunes. Tier doesn\'t change essence rolls much, so run what you clear quickest.',
    mapsPerHour: 10, mapCost: 2,
    scarabs: [
      { name: 'Essence Scarab of Calcification', qty: 1 },
      { name: 'Essence Scarab of Stability', qty: 1 },
      { name: 'Essence Scarab of Ascent', qty: 1 },
      { name: 'Essence Scarab', qty: 1 },
    ],
    threads: [],
    inputs: [
      { name: 'Vaal Orb', qty: 2 },
    ],
    outputs: [
      { item: 'Essence of Horror', qty: 0.3 },
      { item: 'Essence of Hysteria', qty: 0.3 },
      { item: 'Essence of Insanity', qty: 0.2 },
      { item: 'Essence of Delirium', qty: 0.2 },
      { label: 'Deafening / shrieking essences (bulk)', chaos: 3, qty: 22 },
    ],
    notes: 'Corrupting with Vaal turns ordinary essences into the five corrupted ones (Horror, Hysteria, Insanity, Delirium, Desolation), which are most of the money. Sell essences in bulk; singles aren\'t worth the gold.',
  },
  {
    id: 'strongbox',
    name: 'Strongboxes (Ambush)',
    blurb: 'Open every box, with Ambush scarabs forcing extra boxes and a chance at the currency and scarab chests. Pairs with Cartography to keep maps sustaining themselves.',
    difficulty: 'Medium', investment: 'Medium',
    atlas: 'Full Ambush/Strongbox cluster (Blest Locks, Hidden Compartments) plus the Operative mastery so detonated boxes drop more. A few Cartography nodes keep maps coming.',
    maps: 'Any open map; chisel and alch for quantity. Strongbox packs don\'t care about layout, so pick a map you clear fast.',
    mapsPerHour: 10, mapCost: 3,
    scarabs: [
      { name: 'Ambush Scarab of Containment', qty: 1 },
      { name: 'Ambush Scarab of Discernment', qty: 1 },
      { name: 'Ambush Scarab of Hidden Compartments', qty: 1 },
      { name: 'Ambush Scarab of Potency', qty: 1 },
    ],
    threads: [],
    inputs: [],
    outputs: [
      { item: 'Stacked Deck', qty: 2 },
      { label: 'Strongbox currency (chaos, divines, cards)', chaos: 110, qty: 1 },
      { label: 'Scarabs from containment boxes', chaos: 22, qty: 1 },
      { label: 'Maps rolled off boxes', chaos: 6, qty: 1 },
    ],
    notes: 'Containment is the key (and priciest) scarab — it turns boxes into currency and scarab chests; Discernment adds the good box types. Skip anything that isn\'t an Arcanist or Diviner box and run a fast layout. One juiced currency box carries the map.',
  },
  {
    id: 'ritual',
    name: 'Ritual',
    blurb: 'Complete every altar, bank the tribute, and reroll the shop for the omens and currency you actually want. Low setup, steady payout, light on your build.',
    difficulty: 'Medium', investment: 'Low',
    atlas: 'Full Ritual wheel — Grand Design, Reant\'s Reward and the reroll/tribute nodes so you can afford the deferred rewards. Blood-filled Vessel mastery to carry rewards between maps.',
    maps: 'Open maps with big packs: Ritual only revives what died inside the circle, so pick layouts where monsters bunch up (Strand, Dunes, City Square).',
    mapsPerHour: 7, mapCost: 2,
    scarabs: [
      { name: 'Ritual Scarab of Abundance', qty: 1 },
      { name: 'Ritual Scarab of Wisps', qty: 1 },
      { name: 'Ritual Scarab of Selectiveness', qty: 1 },
      { name: 'Ritual Scarab of Corpses', qty: 1 },
    ],
    threads: [
      { name: 'Ritual Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { item: 'Omen of Amelioration', qty: 0.15 },
      { item: 'Omen of the Soul Devourer', qty: 0.08 },
      { label: 'Ritual rewards (currency, uniques)', chaos: 38, qty: 1 },
      { name: 'Corpse items', ninja: 'Corpse', chaos: 8, qty: 2 },
    ],
    notes: 'Defer rewards you can\'t afford and reroll for omens and divines. Wisps (Azmeri) hugely raise the value of what the altar can offer; Selectiveness trims the junk so rerolls land on the good stuff. Ritual also gives corpse items. Most of the types on poe.ninja sell for a few Chaos, so the price here is the live average across all of them without the dearest tenth, and a rare Perfect corpse can beat it by thousands. Past leagues have no corpse prices, so they use an estimate of 8 Chaos, scaled to that stage of the league like other estimates.',
    roughNumbers: 'No measured sample backs this card. Ritual rewards and two corpse items per map are estimates.',
  },
  {
    id: 'abyss',
    name: 'Abyss',
    blurb: 'Chase the abyss to its Stygian chest, with scarabs doubling the crawl and stacking extra rare monsters. A dense, rippy screen that drops jewels, bases and a lot of raw loot.',
    difficulty: 'Medium', investment: 'Medium',
    atlas: 'Full Abyss wheel (Abyssal Elements, Encroaching Darkness) plus rare-monster nodes — Abyss leans on magic/rare density. Amplified Artifacts if you also run a rare-stacking build.',
    maps: 'Long, linear maps so the abyss can travel without dead-ending: Strand, Dunes, Atoll. A capped-out abyss that reaches its chest is where the value is.',
    mapsPerHour: 8, mapCost: 2,
    scarabs: [
      { name: 'Abyss Scarab', qty: 1 },
      { name: 'Abyss Scarab of Multitudes', qty: 1 },
      { name: 'Abyss Scarab of the Consort', qty: 1 },
      { name: 'Scarab of Adversaries', qty: 1 },
    ],
    threads: [
      { name: 'Abyss Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { label: 'Abyss jewels (Searching Eye, Hypnotic)', chaos: 22, qty: 1 },
      { label: 'Stygian Vise bases', chaos: 6, qty: 1 },
      { label: 'Raw currency & rares', chaos: 14, qty: 1 },
      // poedb: the Abyssal Lich drops these (Bubonic Trail "only ... from Abyssal Lich in Abyssal
      // Depths"); it names no rates and no lich per Gaze. Chances per map are guesses.
      { name: 'Tecrod\'s Gaze', ninja: 'UniqueJewel', chaos: 44, qty: 0.01 },
      { name: 'Amanamu\'s Gaze', ninja: 'UniqueJewel', chaos: 30, qty: 0.01 },
      { name: 'Kurgal\'s Gaze', ninja: 'UniqueJewel', chaos: 5, qty: 0.01 },
      { name: 'Ulaman\'s Gaze', ninja: 'UniqueJewel', chaos: 4, qty: 0.01 },
      { name: 'Bubonic Trail', ninja: 'UniqueArmour', chaos: 2, qty: 0.01 },
      { name: 'Shroud of the Lightless', ninja: 'UniqueArmour', chaos: 20, qty: 0.01 },
    ],
    notes: 'Most value is abyss jewels and the occasional good Stygian Vise, neither of which trades on the exchange — the Chaos values here are your call. Of the Consort spawns a second chest; Multitudes stacks the monsters. The Abyssal Lich in Abyssal Depths drops the Gazes, Bubonic Trail and Shroud of the Lightless (poedb). Bubonic Trail usually has one abyssal socket and is priced as that copy.',
    roughNumbers: 'No measured sample backs this card. The jewel and base values are estimates, and the lich uniques are guessed at 1% a map each: poedb gives no drop rates, and nothing found says how 3.29\'s Abyss rework changed Abyssal Depths.',
  },
  {
    id: 'legion',
    name: 'Legion',
    blurb: 'Freeze the legion, kill as much as you can before it breaks, and cash the splinters, emblems and the odd divine. A classic one-button money printer with a modest scarab bill.',
    difficulty: 'Medium', investment: 'Medium',
    atlas: 'Full Legion wheel — Unbroken (more monsters), the splinter and reward nodes, and Eternal Conflict for two legions. Open-reward masteries push the vaults.',
    maps: 'Big open maps so the whole legion fits on screen: Dunes, Strand, Glacier. You want to shatter as many soldiers as possible before the timer.',
    mapsPerHour: 8, mapCost: 3,
    scarabs: [
      { name: 'Legion Scarab of Treasures', qty: 2 },
      { name: 'Legion Scarab', qty: 1 },
      { name: 'Legion Scarab of Eternal Conflict', qty: 1 },
    ],
    threads: [
      { name: 'Legion Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { item: 'Timeless Karui Splinter', qty: 8 },
      { item: 'Timeless Maraketh Splinter', qty: 8 },
      { item: 'Stacked Deck', qty: 2 },
      { item: 'Divine Orb', qty: 0.08 },
      { label: 'Emblems, incubators, scarabs & currency', chaos: 30, qty: 1 },
      // poe.ninja lists each Timeless jewel once, whatever its seed: the cheap end of a spread
      // where a good seed sells for Divines. Chances per map are guesses.
      { name: 'Elegant Hubris', ninja: 'UniqueJewel', chaos: 50, qty: 0.004 },
      { name: 'Lethal Pride', ninja: 'UniqueJewel', chaos: 49, qty: 0.004 },
      { name: 'Militant Faith', ninja: 'UniqueJewel', chaos: 20, qty: 0.004 },
      { name: 'Glorious Vanity', ninja: 'UniqueJewel', chaos: 20, qty: 0.004 },
      { name: 'Brutal Restraint', ninja: 'UniqueJewel', chaos: 20, qty: 0.004 },
    ],
    notes: '100 splinters of one faction make a Timeless Emblem; five emblems open a Domain of Timeless Conflict (a Legion simulacrum worth a lot). Treasures is the reward scarab; Eternal Conflict adds a second general. Timeless jewels are priced as poe.ninja\'s single line per jewel, the typical seed; a sought-after seed is worth far more.',
    roughNumbers: 'No measured sample backs this card. Splinters, decks and Divines per map are estimates, and each Timeless jewel is guessed at 1 in 250 maps: no source gives their drop rate in Legion encounters.',
  },
  {
    id: 'breach',
    name: 'Breach',
    blurb: 'Open Unstable Breaches, kill the hordes and sell the Wombgifts they leave, along with Foulborn items and the currency that drops. Splinters are gone since Keepers of the Flame. You need the clear to kill the hordes inside each breach, and the high-investment setup gets very expensive.',
    difficulty: 'Medium', investment: 'Medium',
    atlas: 'The Breach wheel: Swelling Ranks and Evolving Hives for more monsters, the extra Unstable Breach chance, and the Wombgift nodes (more of them, and a better chance of the Lavish or Ancient type).',
    maps: 'Tier 16 Jungle Valley, or City Square or Dunes (Maxroll); Eater of Worlds influence helps but isn\'t essential. Since 3.29 at most two Unstable Breaches stay open at once. Take altars for item quantity, duplicate currency and duplicate scarabs.',
    mapsPerHour: 6, mapCost: 6,
    scarabs: [
      { name: 'Breach Scarab of Instability', qty: 2 },
      { name: 'Breach Scarab of the Marshal', qty: 1 },
    ],
    threads: [
      { name: 'Breach Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { name: 'Ancient Wombgift', ninja: 'Wombgift', chaos: 9, qty: 4 },
      { name: 'Lavish Wombgift', ninja: 'Wombgift', chaos: 10, qty: 4 },
      { name: 'Mysterious Wombgift', ninja: 'Wombgift', chaos: 2, qty: 6 },
      { name: 'Provisioning Wombgift', ninja: 'Wombgift', chaos: 0.3, qty: 8 },
      { label: 'Foulborn items', chaos: 25, qty: 1 },
      { label: 'Currency (Divine, Chaos, Valdo\'s Puzzle Box, the odd jackpot)', chaos: 70, qty: 1 },
    ],
    notes: 'The scarabs and map are Maxroll\'s 3.29 low-investment Breach setup. Its Unstable Breach guide spends far more: Tier 16 Originator Dunes rolled to 92% more Currency or higher, Scarab of Wisps, two Instability and two Monstrous Lineage (or a Horned Scarab of Bloodlines and a Cartography Scarab of Risk at 140%), Maven\'s Chisel of Avarice, Delirium Orbs and a Grasping Astrolabe with Synthesised Stability. Add those here if you run it: its extra yield isn\'t counted, because nobody has published it. Wombgifts are priced as sold unopened, at poe.ninja\'s busiest item level. You can birth them on the Genesis Tree for currency, Foulborn uniques and rare items instead, and the Foulborn line is a small estimate for that. Hiveblood isn\'t priced. Breachstones stopped working in 3.28.',
    roughNumbers: 'No guide gives Wombgifts or currency per map and no run was measured, so the quantities and maps per hour are placeholders, set to keep the card\'s total near its previous estimate. The Wombgift prices are live; their quantities aren\'t.',
  },
  {
    id: 'expedition',
    name: 'Expedition',
    blurb: 'Blow up the explosives, loot the artifacts, and spend them at Tujen and Dannig for currency and logbooks. Reliable, build-agnostic, and easy to run alongside anything.',
    difficulty: 'Medium', investment: 'Medium',
    atlas: 'Full Expedition wheel — the artifact, remnant and extra-explosive nodes. Runefinding/Archaeology on the scarabs matter more than the tree for logbook and artifact yield.',
    maps: 'Any map; big open layouts let you chain more explosives in one blast. Item level 81+ maps so logbook areas roll high.',
    mapsPerHour: 8, mapCost: 2,
    scarabs: [
      { name: 'Expedition Scarab of Runefinding', qty: 1 },
      { name: 'Expedition Scarab of Archaeology', qty: 1 },
      { name: 'Expedition Scarab', qty: 1 },
      { name: 'Expedition Scarab of Verisium Powder', qty: 1 },
    ],
    threads: [
      { name: 'Expedition Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { item: 'Exotic Coinage', qty: 2 },
      { label: 'Logbooks', chaos: 18, qty: 1 },
      { label: 'Tujen / Dannig currency gambles', chaos: 28, qty: 1 },
    ],
    notes: 'Tujen is for gambling currency cheap; Dannig for logbooks and reroll currency. Save logbooks for a dedicated logbook session with their own scarabs. Verisium Powder adds explosives radius.',
  },
  {
    id: 'delirium',
    name: 'Delirium',
    blurb: 'Fog the whole map, push the reward bar as deep as your clear allows, and reap cluster jewels, simulacrum splinters and stacked currency. Scales hard with how fast you kill.',
    difficulty: 'High', investment: 'Medium',
    atlas: 'Full Delirium wheel — the reward-type nodes for what you want (currency, scarabs, div cards), plus depth/reward-bar nodes. Pair with Legion or Breach density to feed the fog.',
    maps: 'Dense, linear maps you can run end to end before the fog catches you: Strand, Dunes. A fast clear is worth more than any single scarab here.',
    mapsPerHour: 8, mapCost: 2,
    scarabs: [
      { name: 'Delirium Scarab of Paranoia', qty: 3 },
      { name: 'Delirium Scarab of Mania', qty: 1 },
    ],
    threads: [],
    inputs: [],
    outputs: [
      { item: 'Simulacrum Splinter', qty: 12 },
      { item: 'Stacked Deck', qty: 4 },
      { item: 'Fine Delirium Orb', qty: 0.7 },
      { label: 'Cluster jewels, Maven\'s chisels & stacked currency', chaos: 55, qty: 1 },
    ],
    notes: 'Paranoia (×3) plus Mania is the standard reward loadout. Deep fog floods the map with Stacked Decks, Simulacrum Splinters (300 = a Simulacrum) and delirium orbs — the whole value is killing fast enough to push the bar. Reward type follows your scarab and Atlas choice.',
  },
  {
    id: 'blight',
    name: 'Blight',
    blurb: 'Tower-defence the pump, pick the right lanes, and crack the bountiful chests for oils. Slower per map, but oils and blighted maps hold their value all league.',
    difficulty: 'Medium', investment: 'Medium',
    atlas: 'Full Blight wheel — Fungal Growth, Blight-ravaged and the oil/tower nodes. Blooming and Invigoration on the scarabs push oil tier and reward chests.',
    maps: 'Open maps where lanes are short and the pump is central: Dunes, Strand. You need the clear and towers to actually hold every lane.',
    mapsPerHour: 6, mapCost: 2,
    scarabs: [
      { name: 'Blight Scarab', qty: 1 },
      { name: 'Blight Scarab of Blooming', qty: 1 },
      { name: 'Blight Scarab of Invigoration', qty: 1 },
      { name: 'Blight Scarab of the Blightheart', qty: 1 },
    ],
    threads: [
      { name: 'Blight Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { item: 'Golden Oil', qty: 0.25 },
      { item: 'Silver Oil', qty: 0.5 },
      { item: 'Opalescent Oil', qty: 0.4 },
      { label: 'Blighted maps', chaos: 16, qty: 1 },
      // Rare oils. No source found says where these drop or how often (poedb has no acquisition
      // for either), so the chances are guesses. Tainted Oil is left out: poedb says it drops
      // from corrupted Blighted maps, not from Blight in a regular map.
      { item: 'Prismatic Oil', qty: 0.005 },
      { item: 'Reflective Oil', qty: 0.002 },
    ],
    notes: 'Golden and higher oils are where the profit is — anoint them or sell. Blighted maps are their own farm (Blight Scarab of Bounty, Blighted map device). Of the Blightheart adds a guaranteed unique chest. Tainted Oil comes from corrupted Blighted maps (poedb), so it isn\'t on this card.',
    roughNumbers: 'No measured sample backs this card. Oils per map are estimates, and Prismatic and Reflective Oil are guesses: no source found gives where or how often they drop.',
  },
  {
    id: 'harbinger',
    name: 'Harbinger',
    // 3.28 notes: "Harbinger Removed as a Core League". The 3.29 notes don't bring it back.
    removedInLeague: 'Mirage',
    blurb: 'Kill the harbingers for currency shards and the orbs that make Beachhead maps. No scarab exists for it any more — it is pure Atlas tree, so it layers on top of anything else for free.',
    difficulty: 'Low', investment: 'Low',
    atlas: 'Full Harbinger wheel — extra harbingers, Harbinger packs and the shard/orb reward nodes. Because there is no Harbinger scarab, the tree is the whole investment.',
    maps: 'Any map, layered under another scarab farm (Essence, Legion). Harbingers are fast and don\'t need a layout.',
    mapsPerHour: 10, mapCost: 2,
    scarabs: [],
    threads: [],
    inputs: [],
    outputs: [
      { item: 'Ancient Orb', qty: 0.4 },
      { item: 'Chaos Shard', qty: 18 },
      { item: 'Alchemy Shard', qty: 16 },
      { label: 'Harbinger orbs & Beachhead maps', chaos: 18, qty: 1 },
    ],
    notes: 'Harbinger is best as a free passenger: allocate the wheel and run it under whatever scarabs you\'re already loading. The orbs (Horizon, Harbinger) and Beachhead fragments are the stand-out drops.',
  },
  {
    id: 'betrayal',
    name: 'Betrayal (Syndicate)',
    blurb: 'Build up the Immortal Syndicate, run the right members in Intervention and Research, and cash safehouses for veiled gear, scarabs and currency. Fiddly to manage, rich once set up.',
    difficulty: 'High', investment: 'Medium',
    atlas: 'Full Betrayal wheel — the extra-encounter and safehouse-reward nodes. Reinforcements and Unbreaking on the scarabs raise ranks and keep members from being removed.',
    maps: 'Any map; Betrayal spawns don\'t depend on layout. Run what you clear fast and chase the safehouse boards you\'ve set up.',
    mapsPerHour: 6, mapCost: 2,
    scarabs: [
      { name: 'Betrayal Scarab', qty: 1 },
      { name: 'Betrayal Scarab of Reinforcements', qty: 1 },
      { name: 'Betrayal Scarab of the Allflame', qty: 1 },
      { name: 'Betrayal Scarab of Unbreaking', qty: 1 },
    ],
    threads: [
      { name: 'Betrayal Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { item: 'Syndicate Medallion', qty: 0.08 },
      { label: 'Veiled gear & unveils', chaos: 34, qty: 1 },
      { label: 'Safehouse currency & scarabs', chaos: 26, qty: 1 },
    ],
    notes: 'Aisling (T4) for the veiled mod, Gravicius/It That Fled for currency, Cameria for scarabs. The value comes from managing the board, not the per-map drops; treat the Chaos figures as a long-run average.',
  },
  {
    id: 'incursion',
    name: 'Incursion (Temple)',
    blurb: 'Run the Alva incursions, build up a Temple of Atzoatl, then farm or sell it. The double-corrupt and currency rooms are the prize; a strong temple sells for a lot on its own.',
    difficulty: 'Medium', investment: 'Medium',
    atlas: 'Full Incursion wheel — extra incursions, more Architects and the reward-room nodes. Timelines and Champions on the scarabs add rooms and tougher Architects.',
    maps: 'Any map; Alva appears regardless of layout. You\'re building the temple across ~11 incursions, so consistency matters more than the map.',
    mapsPerHour: 8, mapCost: 2,
    scarabs: [
      { name: 'Incursion Scarab', qty: 1 },
      { name: 'Incursion Scarab of Timelines', qty: 1 },
      { name: 'Incursion Scarab of Champions', qty: 1 },
      { name: 'Incursion Scarab of Invasion', qty: 1 },
    ],
    threads: [
      { name: 'Incursion Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { label: 'Temple of Atzoatl (sold or run)', chaos: 400, qty: 0.2 },
      { label: 'Incursion currency & items', chaos: 20, qty: 1 },
    ],
    notes: 'A temple is finished roughly every five maps, hence the 0.2 per map. Doryani\'s Institute (double corrupt) or the Apex of Ascension sell best; or run them yourself to corrupt gems and gear.',
  },
  {
    id: 'beyond',
    name: 'Beyond',
    blurb: 'Pile up enough on-death spawns that Beyond demons tear through the portal, dropping tainted currency and raw wealth. Dangerous density; pairs naturally with other pack-heavy farms.',
    difficulty: 'High', investment: 'Medium',
    atlas: 'Full Beyond wheel — the demon and tainted-currency nodes. Corruption and Resurgence on the scarabs push the demon tiers and the tainted drops.',
    maps: 'Dense maps with tight packs so Beyond portals chain: City Square, Defiled Cathedral. The more dies at once, the bigger the demons.',
    mapsPerHour: 7, mapCost: 3,
    scarabs: [
      { name: 'Beyond Scarab', qty: 1 },
      { name: 'Beyond Scarab of Corruption', qty: 1 },
      { name: 'Beyond Scarab of Resurgence', qty: 1 },
      { name: 'Beyond Scarab of Haemophilia', qty: 1 },
    ],
    threads: [],
    inputs: [],
    outputs: [
      { item: 'Tainted Chaos Orb', qty: 0.3 },
      { item: 'Tainted Exalted Orb', qty: 0.05 },
      { item: 'Tainted Mythic Orb', qty: 0.02 },
      { label: 'Demon drops (currency, rares)', chaos: 14, qty: 1 },
    ],
    notes: 'Tainted currency (for corrupted-item crafting) is the signature drop and trades on the exchange. Of Corruption guarantees demons are corrupted; the screen can get lethal, so bring defences.',
  },
  {
    id: 'harvest',
    name: 'Harvest',
    blurb: 'Grow and crop the Sacred Grove for lifeforce, then sell it in bulk or use it to craft. Gentle on your build, very consistent, and the lifeforce all trades on the exchange.',
    difficulty: 'Low', investment: 'Low',
    atlas: 'Full Harvest wheel — Heart of the Grove, the lifeforce-quantity and extra-crop nodes. The Harvest Scarab of Doubling is most of the yield; a Scarab of Cornucopia adds crops if you want to invest more.',
    maps: 'Any map; the grove spawns regardless of layout. Run fast maps and clear the grove whenever it appears.',
    mapsPerHour: 12, mapCost: 2,
    scarabs: [
      { name: 'Harvest Scarab of Doubling', qty: 1 },
      { name: 'Harvest Scarab', qty: 1 },
    ],
    threads: [],
    inputs: [],
    outputs: [
      { item: 'Vivid Crystallised Lifeforce', qty: 900 },
      { item: 'Primal Crystallised Lifeforce', qty: 450 },
      { item: 'Wild Crystallised Lifeforce', qty: 180 },
      { item: 'Sacred Crystallised Lifeforce', qty: 0.15 },
    ],
    notes: 'Lifeforce drops in the hundreds-to-thousands per grove, mostly of the dominant colour — Vivid (blue) is usually the money; Sacred (yellow) is rare but dear. Doubling doubles the lifeforce dropped and is the one scarab worth it. Rush to the grove, pick yellow plots, sell in bulk — lifeforce is cheap per unit and eats gold in singles. Yield swings wildly with the plots you get. The whole league sells only about 13 Sacred an hour late on, so a higher rate than this can\'t be typical.',
  },
  {
    id: 'ultimatum-regular',
    name: 'Ultimatum (regular)',
    blurb: 'Maxroll\'s 3.29 setup: Bribing scarabs and Domination shrines on Jungle Valley, finishing each encounter for whatever it offers and hunting the Trialmaster\'s uniques. Cheap to load, but you stand and fight through the modifiers.',
    difficulty: 'High', investment: 'Low',
    atlas: 'Ultimatum wheel, including Brave The Tower (the Trialmaster drops a full stack of Catalysts). Searing Exarch influence for Eldritch Altars.',
    maps: 'Tier 16 Jungle Valley: its Eldritch Altars can\'t roll boss modifiers until you enter the boss arena. Clear, take every Domination Shrine, then do the encounter. Avoid Stalking Ruin, Sawblades, Reduced Recovery, Blood Altar, Less Cooldown Recovery, Treacherous Auras and Drought.',
    mapsPerHour: 6, mapCost: 4,
    scarabs: [
      { name: 'Ultimatum Scarab of Bribing', qty: 2 },
      { name: 'Domination Scarab', qty: 1 },
    ],
    threads: [
      { name: 'Ultimatum Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { item: 'Imbued Catalyst', qty: 2 },
      { item: 'Intrinsic Catalyst', qty: 2 },
      { label: 'Ultimatum wave rewards (currency, catalysts)', chaos: 90, qty: 1 },
      { name: 'Yaomac\'s Accord', ninja: 'UniqueWeapon', chaos: 14, qty: 0.024 },
      { name: 'Mahuxotl\'s Machination', ninja: 'UniqueArmour', chaos: 86, qty: 0.024 },
      { name: 'Hateforge', ninja: 'UniqueArmour', chaos: 2300, qty: 0.0025 },
    ],
    notes: 'Trialmaster odds are Maxroll\'s (Yaomac\'s Accord and Mahuxotl\'s Machination 9.5% each, Hateforge under 1%), times an assumed one Trialmaster every four maps. Ixchel\'s Temptation and Glimpse of Chaos (40% each) are left out as near-worthless. Take the rewards and bail before a wave you can\'t clear.',
    roughNumbers: 'Trialmaster odds are from Maxroll, but no guide measures rewards per map. The wave reward value and the Trialmaster rate are estimates.',
  },
  {
    id: 'ultimatum-catalysing',
    name: 'Ultimatum (Catalysing)',
    blurb: 'A costly scarab makes every Ultimatum reward a catalyst, so all the income is a bulk item the exchange trades. Lives or dies on the scarab\'s price against what catalysts sell for today.',
    difficulty: 'High', investment: 'High',
    atlas: 'Ultimatum wheel, including Brave The Tower. Searing Exarch influence for Eldritch Altars.',
    maps: 'Tier 16 Jungle Valley, as for regular Ultimatum.',
    mapsPerHour: 6, mapCost: 4,
    scarabs: [
      { name: 'Ultimatum Scarab of Catalysing', qty: 1 },
      { name: 'Ultimatum Scarab of Bribing', qty: 2 },
    ],
    threads: [
      { name: 'Ultimatum Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { item: 'Prismatic Catalyst', qty: 5 },
      { item: 'Fertile Catalyst', qty: 5 },
      { item: 'Tainted Catalyst', qty: 5 },
      { item: 'Unstable Catalyst', qty: 5 },
      { item: 'Tempering Catalyst', qty: 5 },
      { item: 'Intrinsic Catalyst', qty: 5 },
      { item: 'Accelerating Catalyst', qty: 5 },
      { item: 'Noxious Catalyst', qty: 5 },
      { item: 'Turbulent Catalyst', qty: 5 },
      { item: 'Abrasive Catalyst', qty: 5 },
      { item: 'Imbued Catalyst', qty: 5 },
    ],
    notes: 'poedb: encounters in the area only offer Catalysts as rewards to the map owner. No guide states the quantity; an even mix of 55 per map is assumed, and the type you get is random, so check your own first few maps before buying in bulk. Maxroll\'s 3.29 guide doesn\'t list this scarab at all.',
    roughNumbers: 'No source gives catalysts per map. The 55 is a guess, and this card\'s profit depends on it almost entirely.',
  },
  {
    id: 'ultimatum-inscription',
    name: 'Ultimatum (Inscription)',
    blurb: 'Rewards that would be catalysts become Inscribed Ultimatums instead. Keep the ones that are worth running, vendor the rest five-for-one, and sell or gamble the good ones.',
    difficulty: 'High', investment: 'Low',
    atlas: 'Ultimatum wheel. Searing Exarch influence for Eldritch Altars.',
    maps: 'Tier 16 Jungle Valley, as for regular Ultimatum.',
    mapsPerHour: 6, mapCost: 4,
    scarabs: [
      { name: 'Ultimatum Scarab of Inscription', qty: 1 },
      { name: 'Ultimatum Scarab of Bribing', qty: 2 },
    ],
    threads: [
      { name: 'Ultimatum Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { label: 'Inscribed Ultimatums worth keeping', chaos: 20, qty: 4 },
      { label: 'Ultimatum wave rewards (currency)', chaos: 45, qty: 1 },
    ],
    notes: 'poedb: Catalyst rewards become Inscribed Ultimatums. Maxroll: rewards are currency, cards or uniques, keep ones worth at least 20 Chaos and those with "more Monster Life", and vendor the rest 5:1. Five with the same Monster Life modifier vendor for up to 1 Divine (30%), 4 (70%), 8 (120%), or a top unique or Mirror (200%), a jackpot this average leaves out. One player reported 10+ per map using both Inscription and Catalysing.',
    roughNumbers: 'No source gives Inscribed Ultimatums per map for this loadout, and poe.ninja doesn\'t price them. Both numbers are estimates.',
  },
  {
    id: 'delve',
    name: 'Delve (Sulphite)',
    blurb: 'Bank sulphite from your maps, then dive the mine for fossils, resonators and biome-locked loot. Off the map and never resets, so it banks progress between sessions.',
    difficulty: 'Medium', investment: 'Medium',
    atlas: 'Full Delve wheel — the sulphite-quantity and Niko nodes so each map banks more. Greed and Fumes on the scarabs multiply the sulphite you carry down.',
    maps: 'Any map; sulphite drops regardless of layout. Run fast maps to bank sulphite, then spend it all in one mining session.',
    mapsPerHour: 8, mapCost: 2,
    scarabs: [
      { name: 'Sulphite Scarab of Greed', qty: 1 },
      { name: 'Sulphite Scarab', qty: 1 },
      { name: 'Sulphite Scarab of Fumes', qty: 1 },
    ],
    threads: [],
    inputs: [],
    outputs: [
      { item: 'Aberrant Fossil', qty: 0.3 },
      { item: 'Sanctified Fossil', qty: 0.08 },
      { label: 'Fossils, resonators & node loot', chaos: 20, qty: 1 },
    ],
    notes: 'The map farm is really just sulphite; the value is realised in the mine. Deeper nodes and fractured/biome walls drop the pricey fossils. Sanctified and Faceted are the stand-outs when their mods are in demand.',
  },
  {
    id: 'torment',
    name: 'Torment',
    blurb: 'Let tormented spirits possess rare monsters, then kill the juiced packs for extra drops. Dirt cheap, and a fine free layer under a bigger farm.',
    difficulty: 'Medium', investment: 'Low',
    atlas: 'Full Torment wheel — extra spirits and the possession/reward nodes. A light passenger strategy, so the tree is the whole cost.',
    maps: 'Any map; spirits roam regardless of layout. Best layered under another scarab farm for free extra rare drops.',
    mapsPerHour: 10, mapCost: 1,
    scarabs: [
      { name: 'Torment Scarab', qty: 1 },
      { name: 'Torment Scarab of Possession', qty: 1 },
      { name: 'Torment Scarab of Release', qty: 1 },
      { name: 'Torment Scarab of Peculiarity', qty: 1 },
    ],
    threads: [],
    inputs: [],
    outputs: [
      { label: 'Tormented rare drops & currency', chaos: 14, qty: 1 },
    ],
    notes: 'Possessed rares drop more and better. There\'s no single tradeable output, so the whole payout is an editable Chaos estimate — treat Torment as a density multiplier on whatever else you\'re running.',
  },
  {
    id: 'cartography',
    name: 'Cartography (map sustain)',
    blurb: 'Not a money farm so much as a map farm: scarabs that duplicate, add and upgrade the maps you drop, so you never buy maps and sell the surplus. Underpins every other strategy.',
    difficulty: 'Low', investment: 'Low',
    atlas: 'Full Cartography wheel — Wrack and Ruin, Explorer, the map-quantity and duplicate nodes. Singularity (same map type) keeps you in whichever map you like running.',
    maps: 'Whatever map tier you want to sustain. Run the map you enjoy; the scarabs feed it back to you plus extras.',
    mapsPerHour: 9, mapCost: 2,
    scarabs: [
      { name: 'Cartography Scarab of the Multitude', qty: 1 },
      { name: 'Cartography Scarab of Escalation', qty: 1 },
      { name: 'Cartography Scarab of Singularity', qty: 1 },
    ],
    threads: [],
    inputs: [],
    outputs: [
      { label: 'Surplus maps (sold / sustained)', chaos: 130, qty: 1 },
      { label: 'Scarabs from the extra map content', chaos: 28, qty: 1 },
    ],
    notes: 'The real win is never spending on maps, which is hard to price — the Chaos figure stands in for the surplus you sell. Escalation upgrades tiers; Singularity floods one type so you can T17-sustain a favourite.',
  },
  {
    id: 'pilfering',
    name: 'Pilfering (divination cards)',
    blurb: 'The final boss steals every card that drops in the map and drops them all when it dies, duplicated by whatever altars you take. Slow, heavily rolled maps with an Abyss layer and a scried card target.',
    difficulty: 'High', investment: 'Medium',
    atlas: 'An Abyss tree, with Eater of Worlds influence for quantity, rarity and the occasional card altar.',
    maps: 'Jungle Valley or Mausoleum. Scry a card\'s map onto yours: Residence for Fire Of Unknown Origin (Nimis), Defiled Cathedral for The Apothecary (Mageblood). Chisel with Divination, add a cheap Delirium Orb, roll to at least 70% quantity.',
    mapsPerHour: 5, mapCost: 70,
    scarabs: [
      { name: 'Divination Scarab of Pilfering', qty: 1 },
      { name: 'Abyss Scarab', qty: 2 },
      { name: 'Abyss Scarab of Multitudes', qty: 1 },
      { name: 'Influencing Scarab of Hordes', qty: 1 },
    ],
    threads: [
      { name: 'Abyss Thread', qty: 8 },
    ],
    inputs: [
      { name: 'Maven\'s Chisel of Divination', qty: 1 },
      { name: 'Singular Delirium Orb', qty: 1 },
    ],
    outputs: [
      { item: 'Fire Of Unknown Origin', chaos: 1500, qty: 0.12 },
      { item: 'Divine Orb', qty: 0.2 },
      { item: 'Valdo\'s Puzzle Box', qty: 0.2 },
      { label: 'Other cards, currency & 5-affix abyss jewels', chaos: 500, qty: 1 },
    ],
    notes: 'The boss drops 5 to 60 cards depending on altars. The sample run took 11-12 minutes a map and reported 8-9 Divines an hour of revenue and about 2 of cost, without the card jackpot, with a set of Fire Of Unknown Origin cards about every 25 maps. Each stolen card also strengthens the boss (more damage and toughness) and heals it, so bring a build that can finish it. Fire Of Unknown Origin barely trades on the exchange right now, so that line uses a Chaos estimate.',
    roughNumbers: 'One Wealthy Exile sample run of about 100 maps from a 2024 league. Its Divine income is carried over as a Chaos figure at today\'s price, and may not match 3.29.',
  },
  {
    id: 'ritual-vessels',
    name: 'Ritual (filled vessels)',
    blurb: 'Load a Blood-filled Vessel holding map bosses, so each altar starts with six extra bosses and its favours are worth more. Dearer per map than plain Ritual, with more tribute and better rewards to show for it.',
    difficulty: 'Medium', investment: 'Medium',
    atlas: 'Ritual wheel: the extra-altar node first (+4 maximum altars per map), then tribute, reroll and deferred-reward nodes, and the chance for Blood-filled Vessels on final Ritual completion.',
    maps: 'City Square, kiting the central bosses to altars. Fill a vessel by using a Ritual Vessel on a completed altar with bosses in it; the map you fill in can\'t itself be opened with a filled vessel, so either alternate maps or buy filled ones.',
    mapsPerHour: 6, mapCost: 3,
    scarabs: [
      { name: 'Ritual Scarab of Abundance', qty: 2 },
      { name: 'Ritual Scarab of Selectiveness', qty: 2 },
    ],
    threads: [
      { name: 'Ritual Thread', qty: 8 },
    ],
    inputs: [
      { label: 'Blood-filled Vessel with 6 bosses (bought)', chaos: 15, qty: 1 },
    ],
    outputs: [
      { item: 'Omen of Amelioration', qty: 0.3 },
      { item: 'Divine Orb', qty: 0.1 },
      { item: 'An Audience With The King', qty: 0.5 },
      { label: 'Deferred Ritual rewards (currency, uniques, corpses)', chaos: 120, qty: 1 },
    ],
    notes: 'poedb: a Blood-filled Vessel forces a Ritual into the map, adds its stored monsters to an altar, and gives 20% improved favour rewards, 20% faster spawns, 20% more monsters alive and 5% more item quantity. Filling your own costs a Ritual Vessel (priced on the exchange) and a map where you can\'t also use one. Rerolling for jackpot rewards is high variance, which this average doesn\'t show.',
    roughNumbers: 'The loadout and mechanics are sourced, but the only money figures found are unsourced seller claims. Reward value and omen rates are estimates.',
  },
  {
    id: 'einhar',
    name: 'Einhar (red beasts)',
    blurb: 'Force Einhar and stack Herd scarabs for extra Red Beasts, capture and duplicate them, then sell the beasts crafters need. A very fast map loop with cheap maps, but plenty of Menagerie housekeeping.',
    difficulty: 'Medium', investment: 'Low',
    atlas: 'Bestiary nodes: Eternal Hunt and Bestiary Chance (Einhar more often), Big Game (Yellow Beasts become Red), and the Red Beast and Red Beast Pair chance nodes.',
    maps: 'Dunes or another fast open map, tier 14 or higher. Aim for about a minute of map; the speed is the strategy. Clear out your Menagerie about every 25-30 maps.',
    mapsPerHour: 20, mapCost: 10,
    scarabs: [
      { name: 'Bestiary Scarab', qty: 1 },
      { name: 'Bestiary Scarab of the Herd', qty: 3 },
      { name: 'Bestiary Scarab of Duplicating', qty: 1 },
    ],
    threads: [
      { name: 'Bestiary Thread', qty: 8 },
    ],
    inputs: [],
    outputs: [
      { name: 'Craicic Croaker', ninja: 'Beast', chaos: 1250, qty: 0.05 },
      { name: 'Black Mórrigan', ninja: 'Beast', chaos: 1250, qty: 0.03 },
      { name: 'Fenumal Plagued Arachnid', ninja: 'Beast', chaos: 330, qty: 0.1 },
      { name: 'Farric Tiger Alpha', ninja: 'Beast', chaos: 150, qty: 0.1 },
      { name: 'Wild Bristle Matron', ninja: 'Beast', chaos: 100, qty: 0.15 },
      { name: 'Wild Brambleback', ninja: 'Beast', chaos: 70, qty: 0.2 },
      { name: 'Wild Hellion Alpha', ninja: 'Beast', chaos: 70, qty: 0.2 },
      { name: 'Vivid Vulture', ninja: 'Beast', chaos: 46, qty: 0.3, notInPastLeagues: 'Its price in earlier leagues came from the synthesised implicit reroll craft, which was removed in 3.29. The market collapsed after that, so an old price says nothing about selling one now.' },
      { name: 'Primal Crushclaw', ninja: 'Beast', chaos: 30, qty: 0.3 },
    ],
    notes: 'Each Herd scarab adds 5 Red Beasts if Einhar is in the map, and Duplicating copies what you capture. Craicic Croaker (the Imprint beast, renamed from Craicic Chimeral in 3.29) and the Fenumal Plagued Arachnid split craft are the usual earners. Beast prices swing with what crafters are doing, and poe.ninja shows what they are listed at, not what they sold for. A removed craft can end a beast\'s market overnight: Vivid Vulture sold for thousands of Chaos in Mirage for the synthesised implicit reroll, and a few dozen since that craft went in 3.29, so past-league views leave it out.',
    roughNumbers: 'Beast prices are live, but no source could be found for how often each beast appears. Those rates are estimates, and they decide this card\'s rank.',
  },
  {
    id: 'lab',
    name: 'Uber Labyrinth',
    blurb: 'Run the daily Uber Lab with a fast movement build, spending both Divine Font uses per run on gem crafts. Almost no input cost and no Atlas needed; a good lane for a character without map gear.',
    difficulty: 'Low', investment: 'Low',
    unit: 'run',
    maps: 'Uber Labyrinth. The layout changes daily at 00:00 UTC, so follow poelab.com\'s route for the day. Most runs take 4-5 minutes on a movement build. Bring cheap 20/20 or level 1 gems for the Font.',
    mapsPerHour: 10, mapCost: 2,
    scarabs: [],
    threads: [],
    inputs: [
      { name: 'Offering to the Goddess', qty: 1 },
    ],
    outputs: [
      { label: 'Divine Font gem crafts (2 per run)', chaos: 40, qty: 2 },
      { label: 'Izaro\'s treasure keys & chests', chaos: 15, qty: 1 },
      // poedb: "rare rewards from Izaro's Treasure Chests in the Eternal and Enriched Eternal
      // Labyrinth" since 3.14. No rate is published, so each is guessed at 1 in 500 runs.
      // Emperor's Cunning had no poe.ninja line in Allflame (2026-11-10), so it falls back to
      // 2,000, about Emperor's Wit; in Mirage it ran from 76 to 21,018 like its siblings.
      { name: 'Emperor\'s Mastery', ninja: 'UniqueJewel', chaos: 14391, qty: 0.002 },
      { name: 'Emperor\'s Might', ninja: 'UniqueJewel', chaos: 10989, qty: 0.002 },
      { name: 'Emperor\'s Wit', ninja: 'UniqueJewel', chaos: 1989, qty: 0.002 },
      { name: 'Emperor\'s Cunning', ninja: 'UniqueJewel', chaos: 2000, qty: 0.002 },
    ],
    notes: 'Font options seen in a 3.27 guide: a random Exceptional Gem from a support, a non-transfigured gem into a Transfigured one (100 Chaos to a Divine when it hits; a gem with only one transfigured version is a sure target), a Facetor\'s Lens from a sacrificed gem, or added quality. Price the transfigured gem you plan to make before committing, since popular ones get crowded.',
    roughNumbers: 'Runs per hour and Font values come from one player\'s 3.27 guide, which gives no income total. Neither was measured in 3.29. The Emperor\'s jewels are guessed at 1 in 500 runs each: no drop rate is published, and their price decides much of this card.',
  },
  {
    id: 'delve-mine',
    name: 'Delve (deep mining)',
    blurb: 'Spend your banked sulphite going deep for fossils and resonators, breaking every wall on the way. Not a map strategy: an hour in the mine, paid for by sulphite from the maps you already run.',
    difficulty: 'High', investment: 'Medium',
    unit: 'hour',
    atlas: 'Frantic Mining (Niko in every map) and Packed with Energy on the way, plus sulphite quantity. Map quantity scales sulphite; player quantity doesn\'t.',
    maps: 'Azurite Mine, at depth 500 at the very least and as deep as you can go without failing nodes. Take Primeval Ruins, Vaal Outposts, Abyssal Cities and Azurite Fissures; don\'t spend long travelling to poor nodes. Bank sulphite first (the Delve (Sulphite) card).',
    mapsPerHour: 1, mapCost: 100,
    scarabs: [],
    threads: [],
    inputs: [],
    outputs: [
      { item: 'Hollow Fossil', qty: 4.9 },
      { item: 'Faceted Fossil', qty: 2.5 },
      { item: 'Fractured Fossil', qty: 3.5 },
      { item: 'Prime Chaotic Resonator', qty: 5 },
      { item: 'Powerful Chaotic Resonator', qty: 120 },
      { item: 'Potent Chaotic Resonator', qty: 400 },
      { item: 'Primitive Chaotic Resonator', qty: 400 },
      { label: 'Other fossils (sold in bulk)', chaos: 15, qty: 20 },
    ],
    notes: 'Quantities are one 8-hour 3.29 session divided by 8 (about 925 resonators, 241,000 Azurite in all). It reported about 21 Divines an hour in August, or close to 25 once its fossils went into crafting rather than being sold; pick that part of the league in the League stage menu to compare, since today\'s prices are far lower. The resonator split by tier is an estimate. Sulphite isn\'t in the cost: it comes from your maps, so count those hours too. Sell in bulk; Maxroll says most of the profit is the pile of smaller items.',
    roughNumbers: 'One session from a currency-seller\'s guide, read through a summary of the page. Treat it as a single anecdote.',
  },
  {
    id: 'uber-fragment-rush',
    name: 'Uber fragment rush (Nightmare maps)',
    blurb: 'Run straight to the Nightmare boss in a Tier 17 map, kill it, sell the uber fragments it drops. Very short runs with a low entry price, though your build has to kill the boss safely in under a minute.',
    difficulty: 'High', investment: 'High',
    atlas: 'A lean tree: map quantity and boss nodes on the way. One guide reports area quantity lifts fragment counts in steps (about 2 per kill at low quantity, 2-4 at 250%+), though it also says this was reduced in 3.29.',
    maps: 'A Nightmare Map opened as the boss map you pick below. Add Sacrifice fragments for quantity and the Sinistral and Dextral scarabs to strip modifiers. Rush the boss, loot, leave.',
    unit: 'run',
    mapsPerHour: 25, mapCost: 3,
    variantLabel: 'Map',
    variants: [
      {
        id: 'ziggurat', name: 'Ziggurat (Blazing, Devouring)',
        outputs: [
          { item: 'Devouring Fragment', qty: 1 },
          { item: 'Blazing Fragment', qty: 1 },
          { name: 'Wraithlord', ninja: 'UniqueArmour', chaos: 34, qty: 0.05 },
        ],
      },
      {
        id: 'fortress', name: 'Fortress (Decaying, Synthesising)',
        outputs: [
          { item: 'Decaying Fragment', qty: 1 },
          { item: 'Synthesising Fragment', qty: 1 },
          { name: 'Yoke of Suffering', ninja: 'UniqueAccessory', chaos: 140, qty: 0.05 },
        ],
      },
      {
        id: 'abomination', name: 'Abomination (Reality, Awakening, Traumatic)',
        outputs: [
          { item: 'Reality Fragment', qty: 0.8 },
          { item: 'Awakening Fragment', qty: 0.8 },
          { item: 'Traumatic Fragment', qty: 0.4 },
          { name: 'Malachai\'s Mark', ninja: 'UniqueArmour', chaos: 93, qty: 0.05 },
        ],
      },
      {
        id: 'citadel', name: 'Citadel (Cosmic, Synthesising, Traumatic)',
        outputs: [
          { item: 'Cosmic Fragment', qty: 0.8 },
          { item: 'Synthesising Fragment', qty: 0.8 },
          { item: 'Traumatic Fragment', qty: 0.4 },
          { name: 'Manastorm', ninja: 'UniqueArmour', chaos: 130, qty: 0.05 },
        ],
      },
      {
        id: 'sanctuary', name: 'Sanctuary (Reverent, Lonely)',
        outputs: [
          { item: 'Reverent Fragment', qty: 1 },
          { item: 'Lonely Fragment', qty: 1 },
          { name: 'The Dark Seer', ninja: 'UniqueWeapon', chaos: 419, qty: 0.05 },
        ],
      },
    ],
    scarabs: [
      { name: 'Scarab of the Sinistral', qty: 1 },
      { name: 'Scarab of the Dextral', qty: 1 },
    ],
    threads: [],
    inputs: [
      { name: 'Nightmare Map', ninja: 'Map', chaos: 40, qty: 1 },
      ...NIGHTMARE_MAP_DEVICE,
    ],
    notes: 'Which boss drops which fragment is from poedb (Traumatic: "more likely" from Abomination and Citadel). About two fragments per kill, split evenly across that boss\'s pool. Fragment markets are small: a few dozen trade per hour, so if a line is marked as more than the market takes, profit per hour won\'t scale.',
    roughNumbers: 'Fragments per kill and runs per hour come from seller guides that contradict each other (a claimed 40 runs an hour is lowered to 25 here). The 5% unique rate is from the same guides.',
  },
  {
    id: 'uber-boss-rush',
    name: 'Uber boss kills',
    blurb: 'Buy four fragments, kill the uber boss, sell the uniques. A few unique drops carry almost all the profit, so this card is an average you\'ll only see after dozens of kills, and a death can burn the entry fee.',
    difficulty: 'High', investment: 'High',
    unit: 'kill',
    atlas: 'Boss nodes as the fight allows. Uber fights don\'t take Eldritch Altar quantity, so spend Atlas points on the maps you run between kills.',
    maps: 'The boss\'s own arena, opened with four of its fragments in a personal Map Device.',
    mapsPerHour: 5, mapCost: 0,
    variantLabel: 'Boss',
    variants: [
      {
        id: 'eater', name: 'Uber Eater of Worlds',
        mapsPerHour: FAST_UBER_KILLS_PER_HOUR,
        inputs: [{ name: 'Devouring Fragment', qty: FOUR_FRAGMENTS }],
        outputs: [
          { name: 'Nimis', ninja: 'UniqueAccessory', chaos: 20970, qty: 0.03 },
          { name: 'Melding of the Flesh', ninja: 'UniqueJewel', chaos: 1258, qty: 0.05 },
          { name: 'Ashes of the Stars', ninja: 'UniqueAccessory', chaos: 100, qty: 0.2 },
          { name: 'Forbidden Flesh', ninja: 'ForbiddenJewel', chaos: 1000, qty: 0.3 },
          { name: 'Ravenous Passion', ninja: 'UniqueArmour', chaos: 5, qty: 0.3 },
          { item: 'Exceptional Eldritch Ichor', qty: 0.5 },
          { label: 'Currency, gems and other drops', chaos: 120, qty: 1 },
        ],
      },
      {
        id: 'exarch', name: 'Uber Searing Exarch',
        mapsPerHour: FAST_UBER_KILLS_PER_HOUR,
        inputs: [{ name: 'Blazing Fragment', qty: FOUR_FRAGMENTS }],
        outputs: [
          { name: 'The Annihilating Light', ninja: 'UniqueWeapon', chaos: 15, qty: 0.25 },
          { name: 'Crystallised Omniscience', ninja: 'UniqueAccessory', chaos: 6, qty: 0.25 },
          { name: 'Forbidden Flame', ninja: 'ForbiddenJewel', chaos: 1000, qty: 0.3 },
          { name: 'Dawnbreaker', ninja: 'UniqueArmour', chaos: 3, qty: 0.2 },
          { item: 'Exceptional Eldritch Ember', qty: 0.5 },
          { label: 'Currency, gems and other drops', chaos: 120, qty: 1 },
        ],
      },
      {
        id: 'maven', name: 'Uber Maven',
        mapsPerHour: 7,
        inputs: [{ name: 'Reality Fragment', qty: FOUR_FRAGMENTS }],
        outputs: [
          { name: 'Progenesis', ninja: 'UniqueFlask', chaos: 16860, qty: 0.03 },
          { label: 'Awakened gems (Enlighten, Empower, Enhance)', chaos: 60000, qty: 0.01 },
          { name: 'Viridi\'s Veil', ninja: 'UniqueArmour', chaos: 18, qty: 0.3 },
          // poe.ninja has one price for every keystone, the cheap end. A player's estimate of
          // 36 keystones near 1 Divine and 4 near 10 averages 1.9 Divines, about 890 Chaos.
          { label: 'Impossible Escape (value depends on its keystone)', chaos: 890, qty: 0.3 },
          { label: 'Currency, gems and other drops', chaos: 120, qty: 1 },
        ],
      },
      {
        id: 'elder', name: 'Uber Uber Elder',
        mapsPerHour: 10,
        inputs: [{ name: 'Decaying Fragment', qty: FOUR_FRAGMENTS }],
        outputs: [
          { name: 'Voidforge', ninja: 'UniqueWeapon', chaos: 21389, qty: 0.03 },
          { name: 'The Eternity Shroud', ninja: 'UniqueArmour', chaos: 30, qty: 0.25 },
          { label: 'Watcher\'s Eye (value depends on its mods)', chaos: 300, qty: 0.2 },
          { label: 'Currency, gems and other drops', chaos: 120, qty: 1 },
        ],
      },
      {
        id: 'shaper', name: 'Uber Shaper',
        mapsPerHour: 10,
        inputs: [{ name: 'Cosmic Fragment', qty: FOUR_FRAGMENTS }],
        outputs: [
          { name: 'Starforge', ninja: 'UniqueWeapon', chaos: 4530, qty: 0.03 },
          // poe.ninja has one price for all 17 aura variants, the cheap end of the 1 to 400+
          // Divines a player reports. 9,400 Chaos is about 20 Divines, the geometric middle.
          { label: 'Sublime Vision (value depends on its aura)', chaos: 9400, qty: 0.01 },
          { name: 'Echoes of Creation', ninja: 'UniqueArmour', chaos: 40, qty: 0.3 },
          { name: 'Shaper\'s Touch', ninja: 'UniqueArmour', chaos: 14, qty: 0.3 },
          { label: 'Currency, gems and other drops', chaos: 120, qty: 1 },
        ],
      },
      {
        id: 'sirus', name: 'Uber Sirus',
        mapsPerHour: 10,
        inputs: [{ name: 'Awakening Fragment', qty: FOUR_FRAGMENTS }],
        outputs: [
          { item: 'Awakener\'s Orb', qty: 0.3 },
          { name: 'The Saviour', ninja: 'UniqueWeapon', chaos: 839, qty: 0.1 },
          { name: 'Hands of the High Templar', ninja: 'UniqueArmour', chaos: 351, qty: 0.1 },
          { name: 'Oriath\'s End', ninja: 'UniqueFlask', chaos: 100, qty: 0.3 },
          { name: 'Crown of the Inward Eye', ninja: 'UniqueArmour', chaos: 25, qty: 0.2 },
          { name: 'Thread of Hope', ninja: 'UniqueJewel', chaos: 10, qty: 0.3 },
          { label: 'Currency, gems and other drops', chaos: 120, qty: 1 },
        ],
      },
      {
        id: 'fear', name: 'Uber Incarnation of Fear',
        mapsPerHour: FAST_UBER_KILLS_PER_HOUR,
        inputs: [{ name: 'Traumatic Fragment', qty: FOUR_FRAGMENTS }],
        outputs: [
          { name: 'Enmity\'s Embrace', ninja: 'UniqueAccessory', chaos: 9828, qty: 0.03 },
          { name: 'Starcaller', ninja: 'UniqueWeapon', chaos: 70, qty: 0.2 },
          { name: 'Woespike', ninja: 'UniqueAccessory', chaos: 37, qty: 0.25 },
          { name: 'Servant of Decay', ninja: 'UniqueArmour', chaos: 25, qty: 0.25 },
          { name: 'Coiling Whisper', ninja: 'UniqueAccessory', chaos: 20, qty: 0.25 },
          { name: 'Bound By Destiny', ninja: 'UniqueJewel', chaos: 5, qty: 0.25 },
          { label: 'Currency, gems and other drops', chaos: 120, qty: 1 },
        ],
      },
      {
        id: 'dread', name: 'Uber Incarnation of Dread',
        mapsPerHour: 5,
        inputs: [{ name: 'Reverent Fragment', qty: FOUR_FRAGMENTS }],
        outputs: [
          { name: 'The Golden Charlatan', ninja: 'UniqueWeapon', chaos: 17955, qty: 0.03 },
          { name: 'Wine of the Prophet', ninja: 'UniqueFlask', chaos: 11812, qty: 0.03 },
          { name: 'The Hallowed Monarch', ninja: 'UniqueArmour', chaos: 256, qty: 0.2 },
          { name: 'Whispers of Infinity', ninja: 'UniqueAccessory', chaos: 90, qty: 0.25 },
          { name: 'Seven Teachings', ninja: 'UniqueArmour', chaos: 20, qty: 0.25 },
          { name: 'The Dark Monarch', ninja: 'UniqueArmour', chaos: 19, qty: 0.25 },
          { name: 'Bonemeld', ninja: 'UniqueAccessory', chaos: 10, qty: 0.25 },
          { name: 'Bound By Destiny', ninja: 'UniqueJewel', chaos: 5, qty: 0.25 },
          { label: 'Currency, gems and other drops', chaos: 120, qty: 1 },
        ],
      },
      {
        id: 'neglect', name: 'Uber Incarnation of Neglect',
        mapsPerHour: FAST_UBER_KILLS_PER_HOUR,
        inputs: [{ name: 'Lonely Fragment', qty: FOUR_FRAGMENTS }],
        outputs: [
          { name: 'Festering Resentment', ninja: 'UniqueWeapon', chaos: 403, qty: 0.05 },
          { name: 'Legacy of the Rose', ninja: 'UniqueWeapon', chaos: 94, qty: 0.2 },
          { name: 'Venarius\' Astrolabe', ninja: 'UniqueAccessory', chaos: 74, qty: 0.25 },
          { name: 'Betrayal\'s Sting', ninja: 'UniqueAccessory', chaos: 25, qty: 0.25 },
          { name: 'The Arkhon\'s Tools', ninja: 'UniqueAccessory', chaos: 20, qty: 0.25 },
          { name: 'Bound By Destiny', ninja: 'UniqueJewel', chaos: 5, qty: 0.25 },
          { label: 'Currency, gems and other drops', chaos: 120, qty: 1 },
        ],
      },
    ],
    scarabs: [],
    threads: [],
    notes: 'Eater, Exarch, Fear and Neglect can be killed without waiting out an invulnerability phase, so a dedicated 0 HP miner finishes them with one set of mines, about 15 kills an hour. Shaper, Elder and Sirus are about 10, Maven about 7, and Dread about 5 for its three phase mechanics. At 15 kills you need 60 fragments an hour, and fragment markets are small, so buying them all can push the price up. A Forbidden jewel is worth 10 Chaos to 10 Divines by its ascendancy notable, so it\'s priced as the average across every notable, leaving out the dearest tenth, whose thin listings would otherwise decide the card. That assumes each notable drops equally often. Sublime Vision is a player\'s 1% per kill, and worth 1 to 400+ Divines by its aura, so its 20 Divines is a placeholder. Impossible Escape varies by keystone, and a player puts most near 1 Divine and a few near 10. Thread of Hope varies by ring size, with one poe.ninja price for all of them, and a player puts the Massive ring, which only Uber Sirus drops, at about 35 Chaos. poedb lists each Incarnation\'s uniques without saying which need the uber fight, and its Fear page says both four and five fragments (four is used here), so those three bosses are the roughest here. Their cheap prices hide some real value: Bound By Destiny has hundreds of combinations that one price can\'t capture, a good Betrayal\'s Sting can reach about 2 Divines, and some Dark Monarch variants are worth more. Legacy of the Rose and Bonemeld lose value fast through a league. Four fragments per entry is from poedb, and prices of what drops are live from poe.ninja. Chase uniques are assumed at 3%, since GGG publishes no drop rates; set your own numbers once you have some kills behind you. Rare variants such as a 6-link are priced as the plain unique.',
    roughNumbers: 'GGG publishes no drop rates and no measured table was found. Every chance per kill here is a guess, and the rarest drop decides whether a boss looks profitable. Kills per hour are a player\'s estimate, not a timed run.',
  },
];

// Whether a card's content exists in the league being viewed. Only a replay of a league
// older than the removal counts: today and this league's stages are always after it.
function existsInViewedLeague(strategy) {
  if (!strategy.removedInLeague) {
    return true;
  }
  return viewedLeagueIsOlderThan(strategy.removedInLeague);
}

// Whether the league being viewed is a replay of one older than `leagueName`. A name not yet in PAST_LEAGUES
// is this league (or a later one), so every past league is older than it.
function viewedLeagueIsOlderThan(leagueName) {
  if (!viewingPastLeague()) {
    return false;
  }
  const leagueNames = [];
  for (const pastLeague of PAST_LEAGUES) {
    leagueNames.push(pastLeague.name);
  }
  const removalPosition = leagueNames.indexOf(leagueName);
  if (removalPosition < 0) {
    return true;
  }
  return leagueNames.indexOf(X.stage.pastLeague) < removalPosition;
}

// Whether the map device still takes scarabs in the league being viewed.
function scarabsExistInViewedLeague() {
  if (!THREADS_ARE_LIVE) {
    return true;
  }
  return viewedLeagueIsOlderThan(SCARABS_REMOVED_IN_LEAGUE);
}

// What a card loads into the map device in the league being viewed: its scarabs, or since 3.30 its Threads.
function mapDeviceLoadout(strategy) {
  if (scarabsExistInViewedLeague()) {
    return { kind: 'scarab', lines: strategy.scarabs };
  }
  return { kind: 'thread', lines: strategy.threads || [] };
}

// Why a card's numbers are rough, if they are. Since 3.30 every card that loaded scarabs is, until someone
// measures it again with Threads.
function roughNumbersOf(strategy) {
  const usedScarabs = strategy.scarabs && strategy.scarabs.length > 0;
  if (scarabsExistInViewedLeague() || !usedScarabs) {
    return strategy.roughNumbers || null;
  }
  if (strategy.roughNumbers) {
    return strategy.roughNumbers + ' ' + THREADS_ROUGH_NUMBERS;
  }
  return THREADS_ROUGH_NUMBERS;
}

// A plain list with every variant farm resolved to the variant in play, leaving out
// farms that don't exist in the league being viewed.
function strategiesInPlay() {
  const resolved = [];
  for (const strategy of STRATEGIES) {
    if (!existsInViewedLeague(strategy)) {
      continue;
    }
    if (strategy.variants) {
      resolved.push(chosenVariant(strategy));
    } else {
      resolved.push(strategy);
    }
  }
  return resolved;
}

// One variant as a complete strategy: the farm's fields with the variant's on top,
// and its own id, so edits to one boss's numbers stay with that boss.
function variantAsStrategy(strategy, variant) {
  const merged = { ...strategy, ...variant };
  merged.id = strategy.id + '.' + variant.id;
  merged.farmId = strategy.id;
  merged.variantName = variant.name;
  merged.name = strategy.name;
  return merged;
}

function variantsOf(strategy) {
  const list = [];
  for (const variant of strategy.variants) {
    list.push(variantAsStrategy(strategy, variant));
  }
  return list;
}

// The viewer's pick, or else whichever makes the most per hour at today's prices.
function chosenVariant(strategy) {
  const list = variantsOf(strategy);
  const picks = X.store.get('farmVariant', {}) || {};
  for (const candidate of list) {
    if (candidate.id === picks[strategy.id]) {
      return candidate;
    }
  }
  let best = list[0];
  let bestProfit = -Infinity;
  for (const candidate of list) {
    const profit = economics(candidate).netPerHour;
    if (profit > bestProfit) {
      bestProfit = profit;
      best = candidate;
    }
  }
  return best;
}

function setVariant(farmId, variantId) {
  saveVariantPick(farmId, variantId);
  rerenderKeepingCardInView(farmId);
  const picker = cardElement(farmId)?.querySelector('.farm-variant select');
  if (picker) {
    picker.focus({ preventScroll: true });
  }
}

function cardElement(key) {
  for (const card of document.querySelectorAll('.farm-card')) {
    if (card.dataset.cardKey === key) {
      return card;
    }
  }
  return null;
}

// Changing a card's numbers can move it far up or down the ranking. The page scrolls by the
// same distance, so the card stays where the visitor was looking and the others move around it.
function rerenderKeepingCardInView(key) {
  const cardBefore = cardElement(key);
  if (!cardBefore) {
    X.rerender();
    return;
  }
  const topBefore = cardBefore.getBoundingClientRect().top;
  X.rerender();
  const cardAfter = cardElement(key);
  if (cardAfter) {
    window.scrollBy({ top: cardAfter.getBoundingClientRect().top - topBefore, behavior: 'instant' });
  }
}

function saveVariantPick(farmId, variantId) {
  const picks = X.store.get('farmVariant', {}) || {};
  picks[farmId] = variantId;
  X.store.set('farmVariant', picks);
}

// Editing one boss's numbers settles the choice. Otherwise lowering a price could make
// another boss the most profitable, and the card would swap away from what's being edited.
function pinVariant(strategy) {
  if (strategy.farmId) {
    saveVariantPick(strategy.farmId, strategy.id);
  }
}

// ---------- per-viewer overrides ----------
// Shape in storage: { [strategyId]: { mapsPerHour, mapCost,
//   scarab: {index: qty}, thread: {index: qty}, input: {index: qty}, output: {index: qty},
//   inputChaos: {index: chaosPerUnit}, outputChaos: {index: chaosPerUnit} } }.
// Only changed values are kept.
function loadOverrides() {
  if (!S.overrides) {
    S.overrides = X.store.get('farming', {}) || {};
  }
  return S.overrides;
}
function strategyOverride(id) {
  const all = loadOverrides();
  if (!all[id]) {
    all[id] = {};
  }
  return all[id];
}
function saveOverrides() {
  X.store.set('farming', S.overrides);
}

// A strategy's numbers with the viewer's edits applied on top of the baseline.
function mapsPerHour(strategy) {
  const o = strategyOverride(strategy.id);
  return o.mapsPerHour ?? strategy.mapsPerHour;
}
function mapCost(strategy) {
  const o = strategyOverride(strategy.id);
  return o.mapCost ?? strategy.mapCost * pastStageScale();
}
function lineQty(strategy, kind, index, fallback) {
  const o = strategyOverride(strategy.id);
  return o[kind]?.[index] ?? fallback;
}
function setOverride(strategy, path, index, value) {
  pinVariant(strategy);
  const o = strategyOverride(strategy.id);
  if (index == null) {
    o[path] = value;
  } else {
    if (!o[path]) {
      o[path] = {};
    }
    o[path][index] = value;
  }
  saveOverrides();
  rerenderKeepingCardInView(cardKey(strategy));
}
function clearPriceOverride(strategy, kind, index) {
  pinVariant(strategy);
  const o = strategyOverride(strategy.id);
  if (o[priceOverrideKey(kind)]) {
    delete o[priceOverrideKey(kind)][index];
  }
  saveOverrides();
  rerenderKeepingCardInView(cardKey(strategy));
}
function resetStrategy(strategy) {
  const all = loadOverrides();
  delete all[strategy.id];
  saveOverrides();
  rerenderKeepingCardInView(cardKey(strategy));
}

// The name of the storage slot holding a viewer's own prices for this kind of line.
function priceOverrideKey(kind) {
  return kind + 'Chaos';
}

// ---------- poe.ninja: items the exchange doesn't trade ----------
// poe.ninja only covers GGG's public PC leagues. Everywhere else (consoles, private
// leagues) those lines quietly use their estimates, and the panel says so.
function ninjaCoversLeague() {
  const realm = X.realm();
  if (realm === 'xbox' || realm === 'sony') {
    return false;
  }
  const league = X.league();
  if (!league || /\(PL\d+\)\s*$/.test(league)) {
    return false;
  }
  return true;
}

function ninjaTypesInUse() {
  const types = new Set();
  const collect = list => {
    for (const entry of list || []) {
      if (entry.ninja) {
        types.add(entry.ninja);
      }
    }
  };
  for (const strategy of STRATEGIES) {
    collect(strategy.inputs);
    collect(strategy.outputs);
    for (const variant of strategy.variants || []) {
      collect(variant.inputs);
      collect(variant.outputs);
    }
  }
  return [...types];
}

// Load the prices once per league. The tab draws straight away on its estimates and
// redraws when the prices are in, so a slow poe.ninja never holds the page up.
function ensureNinjaPrices() {
  if (!ninjaCoversLeague()) {
    S.ninja = { league: null, status: 'unavailable', byType: new Map() };
    return;
  }
  const league = X.league();
  if (S.ninja.league === league) {
    return;
  }
  const loading = { league, status: 'loading', byType: new Map() };
  S.ninja = loading;
  const requests = ninjaTypesInUse().map(itemType => loadNinjaType(loading, itemType));
  Promise.all(requests).then(() => {
    if (S.ninja !== loading) {
      return; // the viewer changed league while this was loading
    }
    loading.status = loading.byType.size > 0 ? 'ready' : 'failed';
    X.rerender();
  });
}

async function loadNinjaType(loading, itemType) {
  try {
    const response = await fetch('/api/ninja/' + encodeURIComponent(loading.league) + '/' + itemType);
    if (!response.ok) {
      return;
    }
    const body = await response.json();
    loading.byType.set(itemType, indexNinjaLines(body.lines || [], itemType));
  } catch {
    // One failed type leaves its lines on their estimates; the others still price.
  }
}

// Wombgifts have one line per item level, with prices apart by up to six times. The busiest
// line is what most players farm and sell; the top line can be a handful of listings.
const NINJA_TYPES_PRICED_BY_BUSIEST_LINE = new Set(['Wombgift']);

function busiestLineByName(lines) {
  const byName = new Map();
  for (const line of lines) {
    const existing = byName.get(line.name);
    if (!existing || (line.listings ?? 0) > (existing.listings ?? 0)) {
      byName.set(line.name, line);
    }
  }
  return byName;
}

// The average, leaving out the dearest tenth. scripts/build_ninja_history.py does the same.
function meanWithoutDearestTenth(values) {
  const ascending = [...values].sort((a, b) => a - b);
  const keptCount = Math.max(1, Math.floor(ascending.length * 0.9));
  let total = 0;
  for (let index = 0; index < keptCount; index++) {
    total += ascending[index];
  }
  return total / keptCount;
}

// poe.ninja lists a Forbidden jewel once per ascendancy notable, with the notable as the
// line's name and the jewel as its variant. A drop's notable is random and they run from
// 10 Chaos to 10 Divines and beyond, so one price stands for the whole spread. The dearest
// tenth goes because a few thin listings there (one read 550 Divines) would swamp it.
function forbiddenJewelLines(lines) {
  const linesByJewel = new Map();
  for (const line of lines) {
    if (!linesByJewel.has(line.variant)) {
      linesByJewel.set(line.variant, []);
    }
    linesByJewel.get(line.variant).push(line);
  }
  const byName = new Map();
  for (const [jewelName, jewelLines] of linesByJewel) {
    const prices = [];
    let totalListings = 0;
    for (const line of jewelLines) {
      prices.push(line.chaos);
      totalListings += line.listings ?? 0;
    }
    byName.set(jewelName, {
      name: jewelName,
      chaos: meanWithoutDearestTenth(prices),
      listings: totalListings,
      links: null,
      icon: jewelLines[0].icon,
    });
  }
  return byName;
}

// poe.ninja lists each corpse monster separately, and a card can't say which ones drop. So
// one line, the card's "Corpse items", stands for the whole category, by the same rule.
function corpseLines(lines) {
  const prices = [];
  let totalListings = 0;
  for (const line of lines) {
    prices.push(line.chaos);
    totalListings += line.listings ?? 0;
  }
  const byName = new Map();
  if (prices.length > 0) {
    byName.set('Corpse items', {
      name: 'Corpse items',
      chaos: meanWithoutDearestTenth(prices),
      listings: totalListings,
      links: null,
      icon: null,
    });
  }
  return byName;
}

// The same unique can appear several times, by number of links. Keep the plain copy:
// that's what a drop usually is, and a 6-link's price would flatter every drop. But links
// never make an item worth less, so a plain copy listed far above a linked one is a few
// absurd listings: Allflame's plain Voidforge read 1,730 Divines on 11 listings while its
// 6-link read 60. Past PLAIN_PRICE_SUSPECT_RATIO times the cheapest linked copy, that copy
// stands for the item. Smaller gaps are left alone: thin linked lines sell cheap too (Allflame's
// Starforge: plain 20,409 Chaos on 14 listings, a 5-link 4,814 on 3).
// scripts/build_ninja_history.py does the same.
const PLAIN_PRICE_SUSPECT_RATIO = 10;

function plainOrLinkedCopy(copies) {
  let plain = copies[0];
  for (const copy of copies) {
    if ((copy.links ?? 0) < (plain.links ?? 0)) {
      plain = copy;
    }
  }
  let cheapestLinked = null;
  for (const copy of copies) {
    if ((copy.links ?? 0) <= (plain.links ?? 0)) {
      continue;
    }
    if (!cheapestLinked || copy.chaos < cheapestLinked.chaos) {
      cheapestLinked = copy;
    }
  }
  if (cheapestLinked && plain.chaos > PLAIN_PRICE_SUSPECT_RATIO * cheapestLinked.chaos) {
    return cheapestLinked;
  }
  return plain;
}

// Uniques poe.ninja lists once per variant where the variant is rolled on the drop, not added
// later. A drop is usually the common variant, which has the most listings: Bubonic Trail with
// one abyssal socket ("a much more common occurrence" than two, poedb), Shroud of the Lightless.
const NINJA_NAMES_PRICED_BY_BUSIEST_VARIANT = new Set(['Bubonic Trail', 'Shroud of the Lightless']);

function busiestCopy(copies) {
  let busiest = copies[0];
  for (const copy of copies) {
    if ((copy.listings ?? 0) > (busiest.listings ?? 0)) {
      busiest = copy;
    }
  }
  return busiest;
}

function indexNinjaLines(lines, itemType) {
  if (itemType === 'ForbiddenJewel') {
    return forbiddenJewelLines(lines);
  }
  if (itemType === 'Corpse') {
    return corpseLines(lines);
  }
  if (NINJA_TYPES_PRICED_BY_BUSIEST_LINE.has(itemType)) {
    return busiestLineByName(lines);
  }
  const copiesByName = new Map();
  for (const line of lines) {
    if (!copiesByName.has(line.name)) {
      copiesByName.set(line.name, []);
    }
    copiesByName.get(line.name).push(line);
  }
  const byName = new Map();
  for (const [name, copies] of copiesByName) {
    if (NINJA_NAMES_PRICED_BY_BUSIEST_VARIANT.has(name)) {
      byName.set(name, busiestCopy(copies));
    } else {
      byName.set(name, plainOrLinkedCopy(copies));
    }
  }
  return byName;
}

function ninjaLine(entry) {
  if (viewingPastLeague()) {
    const chaos = X.stage.itemPrices[entryName(entry)];
    return chaos == null ? null : { chaos, listings: null };
  }
  const prices = S.ninja.byType.get(entry.ninja);
  if (!prices) {
    return null;
  }
  return prices.get(entryName(entry)) || null;
}

// poe.ninja shows asking prices, unlike the exchange's completed trades, and a listed
// item can sit for a while. What you SELL at a listed price is discounted by this
// share, which the viewer can change. What you BUY pays the listing as it stands.
const DEFAULT_LISTING_DISCOUNT_PERCENT = 15;
const FEW_LISTINGS = 10; // fewer than this and a listed price says little
function listingDiscountPercent() {
  return X.store.get('farmListingDiscount', DEFAULT_LISTING_DISCOUNT_PERCENT);
}

// ---------- pricing a past stage ----------
// The exchange keeps its history. Live poe.ninja prices and the estimates don't have one,
// so in a past stage they stay what they are today in Divines, not in Chaos: with a Divine
// at 79 Chaos on day 1 against 405 now, keeping them in Chaos would show today's prices as
// a fortune. It's still not history, so each card says how much of its value this covers.
// A finished league is better off: poe.ninja's dump gives its items real daily prices,
// and only the estimates are carried back this way. Mirage's replay showed why that
// matters: this shortcut put Uber Sirus at -3.7 Divines an hour on day 2, against a real 18.4.
function viewingPastStage() {
  return !!X.stage && X.stage.status === 'ready';
}

// A finished league has a real daily price for each item, from poe.ninja's dump.
function viewingPastLeague() {
  return viewingPastStage() && !!X.stage.pastLeague;
}

function pastStageScale() {
  if (!viewingPastStage()) {
    return 1;
  }
  const stageDivine = divineChaos();
  const todayDivine = X.todayDivine();
  if (!stageDivine || !todayDivine) {
    return 1;
  }
  return stageDivine / todayDivine;
}

// Below this share of real market prices, a past stage's figure isn't worth comparing.
const MOSTLY_MEASURED_SHARE = 0.75;
const BARELY_MEASURED_SHARE = 0.5;

// The share of a card's sell value that comes from the exchange in the window on show.
function measuredShareOfValue(value) {
  if (!(value.total > 0)) {
    return 0;
  }
  let measured = 0;
  for (const line of value.lines) {
    if ((line.source === 'exchange' || line.source === 'history') && line.lineChaos != null) {
      measured += line.lineChaos;
    }
  }
  return measured / value.total;
}

// ---------- pricing ----------
function entryName(entry) {
  return entry.name ?? entry.item ?? entry.label;
}

// Chaos per unit of an item named on the exchange, or null if it doesn't trade.
function unitPrice(itemName) {
  const p = X.exchangePrice(itemName);
  if (p == null || !isFinite(p) || p <= 0) {
    return null;
  }
  return p;
}
// Chaos value of one Divine, for showing big numbers in Divines.
function divineChaos() {
  return unitPrice('Divine Orb');
}

// What one unit of a line is worth, and where that number came from:
//   'yours'     the viewer typed it
//   'exchange'  traded on the Currency Exchange
//   'ninja'     listed on poe.ninja (minus the discount, when selling)
//   'history'   that day's price in poe.ninja's dump of a past league (same discount)
//   'removed'   left out of past leagues: the reason that made it valuable is gone
//   'estimate'  the baseline Chaos value, when no market prices it
//   'none'      no price at all, so the line can't be counted
function priceLine(strategy, kind, index, entry) {
  const overrides = strategyOverride(strategy.id)[priceOverrideKey(kind)];
  const yourPrice = overrides?.[index];
  if (yourPrice != null) {
    return { price: yourPrice, source: 'yours' };
  }

  if (entry.notInPastLeagues && viewingPastLeague()) {
    return { price: 0, source: 'removed', reason: entry.notInPastLeagues };
  }

  if (entry.ninja) {
    const line = ninjaLine(entry);
    if (line && line.chaos > 0) {
      // A past league's dump is already that day's price; today's has to be carried back.
      const scale = viewingPastLeague() ? 1 : pastStageScale();
      let price = line.chaos * scale;
      if (kind === 'output') {
        price = price * (1 - listingDiscountPercent() / 100);
      }
      const source = viewingPastLeague() ? 'history' : 'ninja';
      return { price, source, listings: line.listings, listedPrice: line.chaos, icon: line.icon, ninjaType: entry.ninja };
    }
    return { price: entry.chaos * pastStageScale(), source: 'estimate' };
  }

  if (entry.label) {
    return { price: entry.chaos * pastStageScale(), source: 'estimate' };
  }

  const exchangePrice = unitPrice(entryName(entry));
  if (exchangePrice != null) {
    return { price: exchangePrice, source: 'exchange' };
  }
  if (entry.chaos != null) {
    return { price: entry.chaos * pastStageScale(), source: 'estimate' };
  }
  return { price: null, source: 'none' };
}

function pricedLine(strategy, kind, index, entry) {
  const qty = lineQty(strategy, kind, index, entry.qty);
  const priced = priceLine(strategy, kind, index, entry);
  const lineChaos = priced.price == null ? null : priced.price * qty;
  return { kind, index, name: entryName(entry), qty, lineChaos, ...priced };
}

// What one run's scarabs and other bought items cost, in Chaos. Returns the total,
// the per-line detail, and the lines no market could price (so they cost nothing
// here and flatter the profit, which the card has to say out loud).
function loadoutCost(strategy) {
  const lines = [];
  const unpriced = [];
  let total = mapCost(strategy);
  const addBought = (kind, list) => {
    for (let index = 0; index < list.length; index++) {
      const line = pricedLine(strategy, kind, index, list[index]);
      if (line.lineChaos != null) {
        total += line.lineChaos;
      } else {
        unpriced.push(line.name);
      }
      lines.push(line);
    }
  };
  const deviceLoadout = mapDeviceLoadout(strategy);
  addBought(deviceLoadout.kind, deviceLoadout.lines);
  addBought('input', strategy.inputs);
  return { total, lines, unpriced };
}

// What one run's drops sell for, in Chaos.
function loadoutValue(strategy) {
  const lines = [];
  const unpriced = [];
  let total = 0;
  for (let index = 0; index < strategy.outputs.length; index++) {
    const line = pricedLine(strategy, 'output', index, strategy.outputs[index]);
    if (line.lineChaos != null) {
      total += line.lineChaos;
    } else {
      unpriced.push(line.name);
    }
    line.demand = marketDemand(strategy, line, strategy.outputs[index]);
    lines.push(line);
  }
  return { total, lines, unpriced };
}

// Selling more than your fair share of a market moves its price, so past this share
// the hourly profit is a ceiling (the same 25% the site assumes for routes).
const MARKET_SHARE = 0.25;

// How this line's yield compares with what its exchange market actually trades. Null
// for anything the exchange doesn't list. The trade volume counts every unit that
// changed hands, resales by flippers included, so real end-buyer demand is lower.
function marketDemand(strategy, line, entry) {
  if (entry.ninja || entry.label || !X.exchangeVolume) {
    return null;
  }
  const traded = X.exchangeVolume(line.name);
  if (!traded) {
    return null;
  }
  const youSellPerHour = line.qty * mapsPerHour(strategy);
  const tradedPerHour = traded.perHour;
  return {
    youSellPerHour,
    tradedPerHour,
    listedNow: traded.stock,
    overShare: youSellPerHour > tradedPerHour * MARKET_SHARE,
  };
}

// Chaos per hour of exchange drops beyond your fair share of their markets: what the
// profit figure counts but the market wouldn't take at that price. Estimated lines stay
// in, because their value doesn't come from the market being measured.
function unsellableChaosPerHour(valueLines) {
  let total = 0;
  for (const line of valueLines) {
    if (line.source === 'exchange' && line.demand && line.demand.overShare) {
      const fairShare = line.demand.tradedPerHour * MARKET_SHARE;
      total += (line.demand.youSellPerHour - fairShare) * line.price;
    }
  }
  return total;
}

// The money figures for a strategy at the current prices. The sort decides which of them a
// card shows largest (CARD_FIGURES_BY_SORT).
function economics(strategy) {
  const cost = loadoutCost(strategy);
  const value = loadoutValue(strategy);
  const netPerMap = value.total - cost.total;
  const maps = mapsPerHour(strategy);
  return {
    cost, value, netPerMap,
    revenuePerMap: value.total,
    costPerMap: cost.total,
    costPerHour: cost.total * maps,
    netPerHour: netPerMap * maps,
    netPerHourWithinDemand: netPerMap * maps - unsellableChaosPerHour(value.lines),
    measuredShare: measuredShareOfValue(value),
    revenuePerHour: value.total * maps,
  };
}

// ---------- formatting ----------
// A Chaos amount as "12.3 div" when it's a lot, else "840 c". Keeps the page in
// the reader's head: Divines for the headline, Chaos for the small print.
function money(chaos, { chaosOnly = false } = {}) {
  if (chaos == null || !isFinite(chaos)) {
    return '–';
  }
  const div = divineChaos();
  if (!chaosOnly && div && Math.abs(chaos) >= div * 0.5) {
    return `${X.fmt(chaos / div)} div`;
  }
  return `${X.fmt(chaos)} c`;
}
const BAND_CLASS = { Low: 'band-low', Medium: 'band-med', High: 'band-high' };
const BAND_RANK = { Low: 0, Medium: 1, High: 2 };

// What the labels call one run of this strategy.
function unitWord(strategy) {
  return strategy.unit || 'map';
}
function capitalised(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// ---------- the panel ----------
const SORT_OPTIONS = [
  ['netPerHour', 'Profit per hour'],
  ['netPerHourWithinDemand', 'Profit per hour within market demand'],
  ['netPerMap', 'Profit per run'],
  ['difficulty', 'Difficulty (easiest first)'],
  ['investment', 'Required investment (lowest first)'],
  ['costPerMap', 'Cost per run (lowest first)'],
  ['name', 'Name'],
];

// What each sort shows on the cards. The largest figure is the one the cards are ranked by,
// so the order explains itself. The small figures are what to weigh against it. Sorting by
// name ranks by the title, so it keeps the usual profit view.
const USUAL_CARD_FIGURES = { headline: 'netPerHour', stats: ['netPerMap', 'revenuePerMap', 'costPerMap'] };
const CARD_FIGURES_BY_SORT = {
  netPerHour: USUAL_CARD_FIGURES,
  netPerHourWithinDemand: { headline: 'netPerHourWithinDemand', stats: ['netPerHour', 'netPerMap', 'costPerMap'] },
  netPerMap: { headline: 'netPerMap', stats: ['netPerHour', 'revenuePerMap', 'costPerMap'] },
  // Within a band, difficulty ranks by profit per hour and investment by cost per hour, so
  // those come first among the small figures.
  difficulty: { headline: 'difficulty', stats: ['netPerHour', 'netPerMap', 'costPerMap'] },
  investment: { headline: 'investment', stats: ['costPerHour', 'netPerHour', 'netPerMap'] },
  costPerMap: { headline: 'costPerMap', stats: ['netPerHour', 'netPerMap', 'revenuePerMap'] },
  name: USUAL_CARD_FIGURES,
};
// The headline's colour for a band: the same good-to-bad reading as the band tags.
const BAND_TONE = { Low: 'up', Medium: '', High: 'down' };

// Profit is green or red by its sign. Other amounts, like a cost, have no good or bad sign.
function profitTone(chaos) {
  if (chaos > 0) {
    return 'up';
  }
  if (chaos < 0) {
    return 'down';
  }
  return '';
}

// One figure a card can show: its text, its label, and its colour when it's the headline.
// `isPriced` says it depends on market prices, so it can be unmeasured at a past league stage.
function cardFigure(figureKey, strategy, econ) {
  const unit = unitWord(strategy);
  if (figureKey === 'netPerHour') {
    return { text: money(econ.netPerHour), label: 'Profit / hour', tone: profitTone(econ.netPerHour), isPriced: true };
  }
  if (figureKey === 'netPerHourWithinDemand') {
    return { text: money(econ.netPerHourWithinDemand), label: 'Profit / hour within demand', tone: profitTone(econ.netPerHourWithinDemand), isPriced: true };
  }
  if (figureKey === 'netPerMap') {
    return { text: money(econ.netPerMap), label: 'Profit / ' + unit, tone: profitTone(econ.netPerMap), isPriced: true };
  }
  if (figureKey === 'revenuePerMap') {
    return { text: money(econ.revenuePerMap), label: 'Sell / ' + unit, tone: '', isPriced: true };
  }
  if (figureKey === 'costPerMap') {
    return { text: money(econ.costPerMap), label: 'Cost / ' + unit, tone: '', isPriced: true };
  }
  if (figureKey === 'costPerHour') {
    return { text: money(econ.costPerHour), label: 'Cost / hour', tone: '', isPriced: true };
  }
  if (figureKey === 'difficulty') {
    return { text: strategy.difficulty, label: 'Difficulty', tone: BAND_TONE[strategy.difficulty], isPriced: false };
  }
  return { text: strategy.investment, label: 'Investment', tone: BAND_TONE[strategy.investment], isPriced: false };
}

// The boxed figures on a card, chosen by the current sort.
function cardHeadline(strategy, econ, sortKey) {
  let figures = CARD_FIGURES_BY_SORT[sortKey];
  if (!figures) {
    figures = USUAL_CARD_FIGURES;
  }

  const headlineFigure = cardFigure(figures.headline, strategy, econ);
  let valueClass = 'farm-net-val ' + headlineFigure.tone;
  if (headlineFigure.isPriced && viewingPastStage() && econ.measuredShare < BARELY_MEASURED_SHARE) {
    valueClass += ' farm-net-unmeasured';
  }

  // A strategy counted in hours, like Delve, has one run per hour, so its per-run and per-hour
  // figures are the same figure under the same label: show it once.
  const labelsShown = new Set([headlineFigure.label]);
  const stats = [];
  for (const figureKey of figures.stats) {
    const figure = cardFigure(figureKey, strategy, econ);
    if (!labelsShown.has(figure.label)) {
      labelsShown.add(figure.label);
      stats.push(stat(figure.label, figure.text));
    }
  }

  return X.el('div', { class: 'farm-headline' },
    X.el('div', { class: 'farm-net' },
      X.el('span', { class: valueClass }, headlineFigure.text),
      X.el('span', { class: 'farm-net-label' }, headlineFigure.label)),
    X.el('dl', { class: 'farm-stats' }, stats));
}

export function farmingPanel(helpers) {
  X = helpers;

  if (X.realm() === 'poe2') {
    return [X.el('p', { class: 'empty' }, 'Farming strategies are a Path of Exile 1 feature: scarabs, the Atlas passive tree and these map mechanics don\'t exist in PoE 2. Switch the realm to a PoE 1 one.')];
  }

  ensureNinjaPrices();

  const div = divineChaos();
  const sortKey = X.store.get('farmSort', 'netPerHour');
  const sorted = [];
  for (const strategy of strategiesInPlay()) {
    sorted.push({ strategy, econ: economics(strategy) });
  }
  sortStrategies(sorted, sortKey);

  const sortOptions = [];
  for (const [value, labelText] of SORT_OPTIONS) {
    sortOptions.push(X.el('option', { value, selected: value === sortKey }, labelText));
  }
  const sortControl = X.el('label', {
    class: 'farm-sort',
    title: 'Each card\'s largest figure is the one it\'s sorted by. Difficulty puts the easiest first, then the best earners in each band. Required investment puts the lowest first, then the cheapest to keep running. Within market demand counts only a quarter of each market\'s trades as sellable.',
  }, 'Sort by ',
    X.el('select', { onchange: e => { X.store.set('farmSort', e.target.value); X.rerender(); } }, sortOptions));

  // The panel's children are handed straight to the page, where a null would print as "null".
  const noticeIfAny = stageNotice();
  const noticeNodes = noticeIfAny ? [noticeIfAny] : [];

  return [
    X.el('p', { class: 'lede' },
      'How players farm for currency, priced against live markets. Every strategy lists the ',
      X.el('b', {}, 'Atlas passives'), ' to take, the ', X.el('b', {}, 'scarabs'), ' and items to load, where to run, and what the ',
      X.el('b', {}, 'drops'), ' are worth, so ', X.el('b', {}, 'profit per run and per hour'),
      ' tracks this league\'s economy. Open a card to see and ', X.el('b', {}, 'edit'), ' every number.'),
    X.el('p', { class: 'muted small' },
      'Every quantity is an editable estimate from public guides: drop rates swing with your build, Atlas, map and luck. Cards marked ',
      X.el('b', {}, 'Rough numbers'), ' have no measured sample behind their yields, so don\'t read their rank as a result. ',
      div ? `Priced at 1 Divine = ${X.fmt(div)} Chaos. ` : 'Divine isn\'t trading this window, so figures stay in Chaos. ',
      priceWindowText(),
      ninjaStatusText(),
      'Your edits are saved in this browser only. Not financial advice — check the live economy before you commit.'),
    ...noticeNodes,
    sourcesLine(),
    X.el('div', { class: 'farm-toolbar' }, sortControl,
      viewControl(),
      stageControl(),
      discountControl(),
      X.el('button', { class: 'linklike', onclick: () => resetAll() }, 'Reset every strategy to the baseline')),
    X.store.get('farmView', 'cards') === 'list'
      ? rankingTable(sorted, sortKey)
      : X.el('div', { class: 'farm-grid' }, sorted.map(({ strategy, econ }) => strategyCard(strategy, econ, sortKey))),
  ];
}

function viewControl() {
  const selectedView = X.store.get('farmView', 'cards');
  return X.el('label', { class: 'farm-sort', title: 'Every strategy as a full card, or one row each to compare them at a glance' }, 'View ',
    X.el('select', { onchange: event => { X.store.set('farmView', event.target.value); X.rerender(); } },
      X.el('option', { value: 'cards', selected: selectedView === 'cards' }, 'Cards'),
      X.el('option', { value: 'list', selected: selectedView === 'list' }, 'Compact list')));
}

// The columns of the compact list. Each header sorts by the key the Sort by menu uses.
const RANKING_COLUMNS = [
  { sortKey: 'name', label: 'Strategy', isText: true, order: 'ascending' },
  { sortKey: 'difficulty', label: 'Difficulty', isText: true, order: 'ascending' },
  { sortKey: 'investment', label: 'Investment', isText: true, order: 'ascending' },
  { sortKey: 'netPerHour', label: 'Profit / hour', order: 'descending' },
  { sortKey: 'netPerHourWithinDemand', label: 'Within demand / hour', order: 'descending', title: 'Profit per hour if you sell only a quarter of what each market trades' },
  { sortKey: 'netPerMap', label: 'Profit / run', order: 'descending', title: 'A run is the card\'s own unit: a map, a kill, or for Delve an hour' },
  { sortKey: 'costPerMap', label: 'Cost / run', order: 'ascending', title: 'A run is the card\'s own unit: a map, a kill, or for Delve an hour' },
];

function rankingHeaderCell(column, sortKey) {
  const attributes = { title: column.title };
  if (column.isText) {
    attributes.class = 'l';
  }
  if (column.sortKey === sortKey) {
    attributes['aria-sort'] = column.order;
  }
  const sortButton = X.el('button', {
    class: 'farm-rank-sort',
    onclick: () => {
      X.store.set('farmSort', column.sortKey);
      X.rerender();
    },
  }, column.label);
  return X.el('th', attributes, sortButton);
}

function rankingNameCell(strategy) {
  const parts = [X.el('span', { class: 'farm-rank-name' }, strategy.name)];
  if (strategy.variantName) {
    parts.push(X.el('span', { class: 'muted small' }, ' ', strategy.variantName));
  }
  const roughNumbers = roughNumbersOf(strategy);
  if (roughNumbers) {
    parts.push(' ', X.el('span', { class: 'farm-band band-rough', title: roughNumbers }, 'Rough'));
  }
  return X.el('td', { class: 'l farm-rank-strategy' }, parts);
}

function rankingBandCell(band) {
  return X.el('td', { class: 'l ' + BAND_CLASS[band] }, band);
}

function rankingMoneyCell(chaos, tone, isUnmeasured) {
  let cellClass = tone;
  if (isUnmeasured) {
    cellClass += ' farm-rank-unmeasured';
  }
  return X.el('td', { class: cellClass }, money(chaos));
}

// Leaves the list for the full card: the row is only the short form of it.
function showCardFromRanking(key) {
  X.store.set('farmView', 'cards');
  X.rerender();
  const card = cardElement(key);
  if (!card) {
    return;
  }
  card.scrollIntoView({ block: 'start' });
  const firstControl = card.querySelector('summary');
  if (firstControl) {
    firstControl.focus({ preventScroll: true });
  }
}

function rankingRow(strategy, econ, rank) {
  const key = cardKey(strategy);
  const isUnmeasured = viewingPastStage() && econ.measuredShare < BARELY_MEASURED_SHARE;
  return X.el('tr', {
    class: 'click',
    tabindex: '0',
    title: 'Open this strategy\'s card',
    onclick: () => showCardFromRanking(key),
    onkeydown: event => {
      if (event.key === 'Enter') {
        showCardFromRanking(key);
      }
    },
  },
  X.el('td', { class: 'muted' }, String(rank)),
  rankingNameCell(strategy),
  rankingBandCell(strategy.difficulty),
  rankingBandCell(strategy.investment),
  rankingMoneyCell(econ.netPerHour, profitTone(econ.netPerHour), isUnmeasured),
  rankingMoneyCell(econ.netPerHourWithinDemand, profitTone(econ.netPerHourWithinDemand), isUnmeasured),
  rankingMoneyCell(econ.netPerMap, profitTone(econ.netPerMap), isUnmeasured),
  rankingMoneyCell(econ.costPerMap, '', isUnmeasured));
}

// The short form of the cards: one row per strategy, in the same order.
function rankingTable(sorted, sortKey) {
  const headerCells = [X.el('th', {}, '#')];
  for (const column of RANKING_COLUMNS) {
    headerCells.push(rankingHeaderCell(column, sortKey));
  }
  const rows = [];
  let rank = 1;
  for (const { strategy, econ } of sorted) {
    rows.push(rankingRow(strategy, econ, rank));
    rank += 1;
  }
  return X.el('div', { class: 'scroll farm-rank' },
    X.el('table', {},
      X.el('thead', {}, X.el('tr', {}, headerCells)),
      X.el('tbody', {}, rows)));
}

function priceWindowText() {
  const windowKind = X.priceWindow ? X.priceWindow() : 'hour';
  if (windowKind === 'stage') {
    return `Exchange prices are the median of the 24 hours of ${X.stage.label}. `;
  }
  if (windowKind === 'day') {
    return 'Exchange prices are the median of the last 24 hours, so one odd trade in a thin market can\'t swing a card. ';
  }
  return 'Exchange prices are the latest hour for now (a day of history is loading); thin end-league markets can misprice a scarab, and near a league\'s end currency deflates — treat today\'s absolute numbers with that in mind. ';
}

function stageControl() {
  if (!X.stagesAvailable && !X.pastLeaguesAvailable) {
    return null;
  }
  const selectedId = X.store.get('farmStage', 'today');
  const optionFor = (value, labelText) => X.el('option', { value, selected: selectedId === value }, labelText);
  const groups = [optionFor('today', 'Today')];

  if (X.stagesAvailable) {
    const currentOptions = [];
    for (const stage of FARM_STAGES) {
      currentOptions.push(optionFor('current:' + stage.id, stage.label));
    }
    groups.push(X.el('optgroup', { label: `${X.league()} (this league)` }, currentOptions));
  }
  if (X.pastLeaguesAvailable) {
    for (const pastLeague of PAST_LEAGUES) {
      const pastOptions = [];
      for (const stage of pastLeagueStages(pastLeague)) {
        pastOptions.push(optionFor(pastLeague.name + ':' + stage.id, stage.label));
      }
      groups.push(X.el('optgroup', { label: `${pastLeague.name} (previous league)` }, pastOptions));
    }
  }
  return X.el('label', { class: 'farm-sort', title: 'Price every card as the market stood at this point in a league' }, 'League stage ',
    X.el('select', { onchange: event => { X.store.set('farmStage', event.target.value); X.rerender(); } }, groups));
}

// Who the numbers come from. poe.ninja's dumps are cc-by-sa, which asks for this credit
// wherever they're used, along with the licence and what was changed.
function externalLink(href, text) {
  return X.el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

function sourcesLine() {
  const parts = [
    'Sources: market data from ', externalLink('https://www.pathofexile.com/developer/docs/reference#currencyexchange', 'GGG\'s Currency Exchange API'),
    ' and item prices from ', externalLink('https://poe.ninja/economy', 'poe.ninja'), '. ',
  ];
  if (viewingPastLeague()) {
    parts.push('Past-league item prices are from ', externalLink('https://poe.ninja/poe1/data', 'poe.ninja\'s data dumps'),
      ', licensed cc-by-sa; filtered to the items here, with low-confidence rows removed. ');
  }
  parts.push('Loadouts and rates draw on ', externalLink('https://poedb.tw/', 'poedb'), ', ', externalLink('https://maxroll.gg/poe/', 'Maxroll'), ', ',
    externalLink('https://wealthyexile.com/', 'Wealthy Exile'), ' and public guides listed in the README. Not affiliated with any of them, or with Grinding Gear Games.');
  return X.el('p', { class: 'muted small farm-sources' }, parts);
}

// What a past stage can and can't tell you, right above the cards it changes.
function stageNotice() {
  if (!X.stage) {
    return null;
  }
  if (X.stage.status === 'loading') {
    return X.el('p', { class: 'farm-stage-notice' }, `Loading ${X.stage.label}: fetching that day's trades, which can take half a minute the first time anyone asks for them. Cards show today's prices until it's in.`);
  }
  if (X.stage.status === 'future') {
    return X.el('p', { class: 'farm-stage-notice' }, `This league hasn't reached ${X.stage.label} yet, so cards show today's prices.`);
  }
  if (X.stage.status === 'failed') {
    return X.el('p', { class: 'farm-stage-notice' }, `Couldn't load ${X.stage.label}, so cards show today's prices. Reload the page to try again.`);
  }
  const when = new Date(X.stage.fromHour * 1000).toISOString().slice(0, 10);
  const pricesText = viewingPastLeague()
    ? `Exchange prices and volumes are that day's real trades, and items the exchange doesn't trade use that day's poe.ninja prices where its dump has them. This was ${X.stage.pastLeague}'s economy, so a craft or mechanic changed since can make a price meaningless now; cards leave those out and say why. Estimates stay at today's value in Divines. `
    : 'Exchange prices and volumes are that day\'s real trades. Items the exchange doesn\'t trade and estimates have no history until this league\'s poe.ninja dump is out, so they stay at today\'s value in Divines, and each card says how much of it that is. ';
  return X.el('p', { class: 'farm-stage-notice' },
    X.el('b', {}, `Showing ${X.stage.label} (from ${when}). `),
    pricesText,
    X.el('b', {}, 'Quantities and speed stay as you set them, and they change most of all: '),
    'at first only the fastest players can run this content; later casual players log out while rarity stackers and party farmers stay, and fast builds move into harder content rather than clearing the same maps faster. Set them for the player you\'d be at this stage.');
}

function ninjaStatusText() {
  if (viewingPastLeague()) {
    return `Items the exchange doesn't trade use that day's price from poe.ninja's data dump, ${listingDiscountPercent()}% lower when you're the seller, since these are listings, not sales. `;
  }
  const status = S.ninja.status;
  if (status === 'ready') {
    return `Items the exchange doesn't trade use poe.ninja's listed prices, ${listingDiscountPercent()}% lower when you're the seller, since listings aren't sales. `;
  }
  if (status === 'loading') {
    return 'Items the exchange doesn\'t trade use estimates until poe.ninja\'s prices arrive. ';
  }
  if (status === 'unavailable') {
    return 'poe.ninja doesn\'t cover this league or realm, so items the exchange doesn\'t trade use estimates from another league\'s prices: set your own. ';
  }
  return 'poe.ninja couldn\'t be reached, so items the exchange doesn\'t trade use saved estimates. ';
}

function discountControl() {
  const field = numberField(listingDiscountPercent(), value => {
    const clamped = Math.min(100, Math.max(0, value));
    X.store.set('farmListingDiscount', clamped);
    X.rerender();
  }, 'How far below the listed price you expect to sell items the exchange doesn\'t trade');
  return X.el('label', { class: 'farm-sort', title: 'poe.ninja shows asking prices. Sold items usually go for less, and can take a while.' },
    'Listed-item discount % ', field);
}

function compareByProfitPerHour(a, b) {
  return b.econ.netPerHour - a.econ.netPerHour;
}

// Bands have many ties, so each band keeps a useful order inside it: the easiest cards
// by what they earn, the lowest-investment cards by what they cost to keep running.
function sortStrategies(list, key) {
  list.sort((a, b) => {
    if (key === 'name') {
      return a.strategy.name.localeCompare(b.strategy.name);
    }
    if (key === 'costPerMap') {
      return a.econ.costPerMap - b.econ.costPerMap; // cheapest first
    }
    if (key === 'difficulty') {
      const bandGap = BAND_RANK[a.strategy.difficulty] - BAND_RANK[b.strategy.difficulty];
      if (bandGap !== 0) {
        return bandGap;
      }
      return compareByProfitPerHour(a, b);
    }
    if (key === 'investment') {
      const bandGap = BAND_RANK[a.strategy.investment] - BAND_RANK[b.strategy.investment];
      if (bandGap !== 0) {
        return bandGap;
      }
      return a.econ.costPerHour - b.econ.costPerHour;
    }
    const av = a.econ[key], bv = b.econ[key];
    return bv - av; // most profitable first
  });
}

function resetAll() {
  S.overrides = {};
  saveOverrides();
  X.store.set('farmVariant', {});
  X.store.set('farmListingDiscount', DEFAULT_LISTING_DISCOUNT_PERCENT);
  X.rerender();
}

// One strategy as a card: the bands, the blurb, the figure it's sorted by as the headline,
// and a folding panel with the full setup and every editable number.
function strategyCard(strategy, econ, sortKey) {
  const bandTags = [
    X.el('span', { class: 'farm-band ' + BAND_CLASS[strategy.difficulty], title: 'How demanding it is on your build and attention' }, strategy.difficulty, ' difficulty'),
    X.el('span', { class: 'farm-band ' + BAND_CLASS[strategy.investment], title: 'How much it costs to set up and run' }, strategy.investment, ' investment'),
  ];
  const roughNumbers = roughNumbersOf(strategy);
  if (roughNumbers) {
    bandTags.push(X.el('span', { class: 'farm-band band-rough', title: roughNumbers }, 'Rough numbers'));
  }
  const header = X.el('div', { class: 'farm-head' },
    X.el('h3', {}, strategy.name),
    X.el('div', { class: 'farm-bands' }, bandTags));

  const headline = cardHeadline(strategy, econ, sortKey);

  const detail = X.el('details', {
    class: 'farm-detail',
    open: S.openCards.has(cardKey(strategy)),
    ontoggle: event => rememberCardOpen(cardKey(strategy), event.target.open),
  },
  X.el('summary', {}, 'Setup & numbers'),
  setupBlock(strategy),
  loadoutTables(strategy, econ),
  worked(strategy, econ),
  X.el('p', { class: 'farm-notes' }, strategy.notes),
  roughNumbersOf(strategy) ? X.el('p', { class: 'farm-notes farm-rough-note' }, X.el('b', {}, 'Where the numbers come from: '), roughNumbersOf(strategy)) : null,
  X.el('button', { class: 'linklike', onclick: () => resetStrategy(strategy) }, 'Reset this strategy to the baseline'));

  return X.el('section', { class: 'farm-card', 'data-card-key': cardKey(strategy) }, header,
    X.el('p', { class: 'farm-blurb' }, strategy.blurb),
    strategy.farmId ? variantPicker(strategy) : null,
    headline,
    warnings(econ),
    detail);
}

// A variant farm is one card, so it stays unfolded when another variant is picked.
function cardKey(strategy) {
  return strategy.farmId || strategy.id;
}

function rememberCardOpen(key, isOpen) {
  if (isOpen) {
    S.openCards.add(key);
  } else {
    S.openCards.delete(key);
  }
}

// The choice inside a farm, best first, with what each option makes per hour.
function variantPicker(strategy) {
  const farm = STRATEGIES.find(candidate => candidate.id === strategy.farmId);
  const rows = [];
  for (const candidate of variantsOf(farm)) {
    rows.push({ candidate, profit: economics(candidate).netPerHour });
  }
  rows.sort((a, b) => b.profit - a.profit);
  const options = [];
  for (const row of rows) {
    options.push(X.el('option', { value: row.candidate.id, selected: row.candidate.id === strategy.id },
      `${row.candidate.variantName}: ${money(row.profit)} / hour`));
  }
  return X.el('label', { class: 'farm-variant' }, (farm.variantLabel || 'Option') + ' ',
    X.el('select', { onchange: event => setVariant(farm.id, event.target.value) }, options));
}

// What the card's figures can't be trusted on, right under them.
function warnings(econ) {
  const messages = [];
  const unpriced = [...econ.cost.unpriced, ...econ.value.unpriced];
  if (unpriced.length > 0) {
    messages.push(`No reliable price in this window, so not counted: ${unpriced.join(', ')}.`);
  }
  if (viewingPastStage() && econ.measuredShare < MOSTLY_MEASURED_SHARE) {
    const unmeasuredPercent = Math.round((1 - econ.measuredShare) * 100);
    const whatItIs = viewingPastLeague() ? 'estimates' : 'today\'s prices and estimates';
    messages.push(`${unmeasuredPercent}% of this card's value is ${whatItIs}, not ${X.stage.label}'s.`);
  }
  const limited = [];
  for (const line of econ.value.lines) {
    if (line.source === 'exchange' && line.demand && line.demand.overShare) {
      limited.push(line.name);
    }
  }
  if (limited.length > 0) {
    messages.push(`More than a quarter of the market each hour: ${limited.join(', ')}. Selling only a quarter of each makes about ${money(econ.netPerHourWithinDemand)} / hour.`);
  }
  if (messages.length === 0) {
    return null;
  }
  return X.el('p', { class: 'farm-warning' }, messages.join(' '));
}

function stat(label, value) {
  return X.el('div', {}, X.el('dt', {}, label), X.el('dd', {}, value));
}

// The Atlas / where to run / runs-per-hour block.
function setupBlock(strategy) {
  const rows = [];
  if (strategy.atlas) {
    rows.push(X.el('div', { class: 'farm-setrow' }, X.el('b', {}, 'Atlas passives'), X.el('span', {}, strategy.atlas)));
  }
  rows.push(X.el('div', { class: 'farm-setrow' }, X.el('b', {}, 'Where to run'), X.el('span', {}, strategy.maps)));

  const unit = unitWord(strategy);
  const fields = [];
  if (unit !== 'hour') {
    const perHour = numberField(mapsPerHour(strategy), v => setOverride(strategy, 'mapsPerHour', null, Math.max(0, v)), `${capitalised(unit)}s you finish in an hour`);
    fields.push(X.el('label', {}, `${capitalised(unit)}s / hour`, perHour));
  }
  const perRunCost = numberField(mapCost(strategy), v => setOverride(strategy, 'mapCost', null, Math.max(0, v)), `Chaos per ${unit} on anything not listed below: the map itself, rolling, odds and ends`);
  fields.push(X.el('label', {}, unit === 'map' ? 'Map & sustain (c)' : 'Other costs (c)', perRunCost));
  rows.push(X.el('div', { class: 'farm-setrow farm-setnums' }, fields));
  return X.el('div', { class: 'farm-setup' }, rows);
}

// A small number input that commits on change.
function numberField(value, onChange, title) {
  const shown = Math.round(value * 10000) / 10000;
  const input = X.el('input', { type: 'number', min: 0, step: 'any', value: shown, title, class: 'farm-num' });
  input.addEventListener('change', () => {
    const n = Number(input.value);
    onChange(isFinite(n) ? n : 0);
  });
  return input;
}

// The buy (scarabs + inputs) and sell (outputs) tables, with prices and editable
// quantities. Exchange lines show the traded price; anything else can be overridden.
function loadoutTables(strategy, econ) {
  const kids = [];
  const unit = unitWord(strategy);

  const buyRows = econ.cost.lines;
  if (buyRows.length) {
    kids.push(X.el('h4', {}, `Buy per ${unit}`));
    kids.push(loadoutTable(strategy, 'Item', buyRows));
  }

  kids.push(X.el('h4', {}, `Sell per ${unit}`));
  kids.push(loadoutTable(strategy, 'Drop', econ.value.lines));

  return X.el('div', { class: 'farm-loadout' }, kids);
}

function loadoutTable(strategy, firstColumn, lines) {
  const rows = [];
  for (const line of lines) {
    const demandText = demandSentence(line);
    rows.push(X.el('tr', { class: demandText ? 'farm-has-demand' : null },
      X.el('td', {}, lineLabel(line)),
      X.el('td', { class: 'r' }, numberField(line.qty, v => setOverride(strategy, line.kind, line.index, Math.max(0, v)))),
      X.el('td', { class: 'r' }, unitCell(strategy, line)),
      X.el('td', { class: 'r' }, line.lineChaos == null ? '–' : X.fmt(line.lineChaos))));
    if (demandText) {
      rows.push(X.el('tr', { class: 'farm-demand' }, X.el('td', { colspan: 4 }, demandText)));
    }
  }
  return X.el('table', { class: 'farm-table' },
    X.el('thead', {}, X.el('tr', {},
      X.el('th', { scope: 'col' }, firstColumn),
      X.el('th', { scope: 'col', class: 'r' }, 'Qty'),
      X.el('th', { scope: 'col', class: 'r' }, 'Unit (c)'),
      X.el('th', { scope: 'col', class: 'r' }, 'Line (c)'))),
    X.el('tbody', {}, rows));
}

// Exchange prices are facts about the market, so they aren't typed over. Every other
// price is someone's best guess, so the viewer's own number can replace it, and a
// small × goes back to the market's.
function unitCell(strategy, line) {
  if (line.source === 'exchange') {
    return X.fmt(line.price);
  }
  if (line.source === 'none') {
    return noPrice();
  }
  // A big price needs no decimals, and they'd only push its digits out of the small box.
  const decimalsFactor = line.price >= 100 ? 1 : 100;
  const shownPrice = Math.round(line.price * decimalsFactor) / decimalsFactor;
  const field = numberField(shownPrice, v => setOverride(strategy, priceOverrideKey(line.kind), line.index, Math.max(0, v)),
    'Type what you actually get for this');
  if (line.source !== 'yours') {
    return field;
  }
  return X.el('span', { class: 'farm-yours' }, field,
    X.el('button', { class: 'linklike', title: 'Back to the baseline or market price', 'aria-label': 'Clear your price', onclick: () => clearPriceOverride(strategy, line.kind, line.index) }, '×'));
}

// A count the way players say it: 10.8k rather than 10,800, and 0.15 stays exact.
function shortCount(count) {
  if (count >= 1000000) {
    return `${X.fmt(count / 1000000)}m`;
  }
  if (count >= 1000) {
    return `${X.fmt(count / 1000)}k`;
  }
  return X.fmt(count);
}

function demandWindowLabel() {
  if (X.priceWindow && X.priceWindow() === 'day') {
    return 'over the last 24h';
  }
  if (X.priceWindow && X.priceWindow() === 'stage') {
    return `over those 24h of ${X.stage.label}`;
  }
  return 'in the last hour';
}

// "You farm 10.8k/h. Over the last 24h, 21k/h sold, worth 6.2 div/h (your share: 51%)."
function demandSentence(line) {
  const demand = line.demand;
  if (!demand) {
    return null;
  }
  const youFarm = `You farm ${shortCount(demand.youSellPerHour)}/h.`;
  if (!(demand.tradedPerHour > 0)) {
    return `${youFarm} None sold ${demandWindowLabel()}.`;
  }
  const soldPart = `${capitalised(demandWindowLabel())}, ${shortCount(demand.tradedPerHour)}/h sold`;
  let worthPart = '';
  if (line.source === 'exchange') {
    worthPart = `, worth ${money(demand.tradedPerHour * line.price)}/h`;
  }
  const sharePercent = Math.round(demand.youSellPerHour / demand.tradedPerHour * 100);
  const shareText = sharePercent < 1 ? 'under 1%' : `${sharePercent}%`;
  return `${youFarm} ${soldPart}${worthPart} (you'd be ${shareText} of that).`;
}

// How a poe.ninja price was reached, in the words of the tag's tooltip. An averaged item has no
// single listing at this price, so "listed at" would claim something poe.ninja doesn't show.
function ninjaPriceWording(line) {
  if (line.ninjaType === 'ForbiddenJewel') {
    return 'average of every notable, without the dearest tenth,';
  }
  if (line.ninjaType === 'Corpse') {
    return 'average of every corpse type, without the dearest tenth,';
  }
  return 'listed at';
}

function sourceTag(line) {
  if (line.source === 'ninja') {
    const discount = line.kind === 'output' ? `, ${listingDiscountPercent()}% off when selling` : '';
    const history = viewingPastStage() ? ' Today\'s price, kept in Divines: poe.ninja has no history here.' : '';
    let wording = ninjaPriceWording(line);
    if (NINJA_TYPES_PRICED_BY_BUSIEST_LINE.has(line.ninjaType)) {
      wording = 'busiest item level, listed at';
    }
    return X.el('span', { class: 'farm-tag farm-tag-ninja', title: `poe.ninja: ${wording} ${X.fmt(line.listedPrice)} c across ${line.listings} listings${discount}.${history}` }, 'ninja');
  }
  if (line.source === 'history') {
    const discount = line.kind === 'output' ? `, ${listingDiscountPercent()}% off when selling` : '';
    let wording = '';
    if (line.ninjaType === 'ForbiddenJewel') {
      wording = ninjaPriceWording(line) + ' ';
    } else if (NINJA_TYPES_PRICED_BY_BUSIEST_LINE.has(line.ninjaType)) {
      wording = 'cheapest item level, ';
    }
    return X.el('span', { class: 'farm-tag farm-tag-ninja', title: `poe.ninja's data dump for ${X.stage.pastLeague} (cc-by-sa): ${wording}${X.fmt(line.listedPrice)} c that day${discount}` }, 'ninja');
  }
  if (line.source === 'removed') {
    return X.el('span', { class: 'farm-tag farm-tag-warn', title: line.reason }, 'not counted');
  }
  if (line.source === 'estimate') {
    return X.el('span', { class: 'farm-tag', title: 'No market price: an estimate. Set your own Chaos value.' }, 'est');
  }
  if (line.source === 'yours') {
    return X.el('span', { class: 'farm-tag farm-tag-yours', title: 'Your own price' }, 'yours');
  }
  return null;
}

function lineLabel(line) {
  const tags = [sourceTag(line)];
  if (line.source === 'ninja' && line.listings < FEW_LISTINGS) {
    tags.push(X.el('span', { class: 'farm-tag farm-tag-warn', title: `Only ${line.listings} listings, so this price says little` }, 'few listed'));
  }
  if (line.demand && line.demand.overShare) {
    tags.push(X.el('span', {
      class: 'farm-tag farm-tag-warn',
      title: `More than ${Math.round(MARKET_SHARE * 100)}% of what this market trades. ${shortCount(line.demand.listedNow)} listed right now.`,
    }, 'thin market'));
  }
  return X.el('span', { class: 'farm-manual' }, itemLabel(line), tags);
}

// An item name with its icon, when we have one: the exchange's, or poe.ninja's.
function itemLabel(line) {
  let iconNode = X.iconByName ? X.iconByName(line.name, 20) : null;
  if (!iconNode && line.icon) {
    iconNode = X.el('img', { src: line.icon, width: 20, height: 20, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  }
  if (iconNode) {
    return X.el('span', { class: 'farm-item' }, iconNode, X.el('span', {}, line.name));
  }
  return X.el('span', {}, line.name);
}
function noPrice() {
  return X.el('span', { class: 'muted', title: 'Traded too rarely in this window to trust a price' }, 'no price');
}

// The per-run and per-hour arithmetic, spelled out with the real numbers.
function worked(strategy, econ) {
  const runs = mapsPerHour(strategy);
  const unit = unitWord(strategy);
  const rows = [
    [`Sell per ${unit}`, `${X.fmt(econ.revenuePerMap)} c`, money(econ.revenuePerMap, { chaosOnly: true })],
    [`Cost per ${unit}`, `${X.fmt(econ.costPerMap)} c (scarabs + inputs + ${X.fmt(mapCost(strategy))} other)`, money(econ.costPerMap, { chaosOnly: true })],
    [`Profit per ${unit}`, `${X.fmt(econ.revenuePerMap)} − ${X.fmt(econ.costPerMap)}`, money(econ.netPerMap)],
    ['Profit per hour', `${X.fmt(econ.netPerMap)} c × ${X.fmt(runs)} per hour`, money(econ.netPerHour)],
  ];
  const unsellable = econ.netPerHour - econ.netPerHourWithinDemand;
  if (unsellable > 0) {
    const sharePercent = Math.round(MARKET_SHARE * 100);
    rows.push(['Within market demand', `${X.fmt(econ.netPerHour)} − ${X.fmt(unsellable)} c of drops past ${sharePercent}% of their market`, money(econ.netPerHourWithinDemand)]);
  }
  return X.el('details', { class: 'worked' }, X.el('summary', {}, 'How these numbers were calculated'),
    X.el('dl', {}, rows.flatMap(([label, expr, result]) => [X.el('dt', {}, label), X.el('dd', {}, X.el('code', {}, expr), ' = ', X.el('b', {}, result))])),
    X.el('ul', { class: 'farm-worked-notes' }, workedNotes()));
}

// How a line's unit price gets there, the same for every card.
function workedNotes() {
  const notes = [
    'Exchange prices: the median of the window\'s hourly averages. An item that traded in under a quarter of those hours gets no price, because a median can\'t filter a wealth transfer through a dead market.',
    `Items tagged ninja: poe.ninja's listed price, ${listingDiscountPercent()}% lower when you sell, because listings aren't sales. Sold volumes don't exist for these, so no demand limit applies to them.`,
    `Demand: the exchange's units traded per hour in the window, resales by flippers included, so real demand is lower. Past ${Math.round(MARKET_SHARE * 100)}% of a market, the extra isn't counted in the within-demand figure.`,
  ];
  if (viewingPastLeague()) {
    notes.push(`${X.stage.pastLeague}: ninja-tagged prices are that day's, from poe.ninja's dump. Items tagged est stay at today's value in Divines.`);
  } else if (viewingPastStage()) {
    notes.push(`${X.stage.label}: ninja-tagged items and estimates stay at today's value in Divines, because poe.ninja has no daily history for a running league.`);
  }
  notes.push('Quantities and speed are always the numbers shown, whatever the stage.');
  const items = [];
  for (const note of notes) {
    items.push(X.el('li', {}, note));
  }
  return items;
}
