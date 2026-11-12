# Faustus Ledger

A free, browser-only dashboard for Path of Exile's Currency Exchange (PoE 1 and PoE 2, PC and consoles),
built on GGG's public hourly exchange history.

The tabs sit in three folders, with the open folder's tabs in a row below: **Economy** (everything below except Crafting
and the Guide), **Crafting** (main and Ruthless) and **Settings / Guide** (the Guide; there's no settings page yet).
Visitors start on Economy. A folder reopens the tab last used in it, and a link like `#craft` opens the right folder.

- **Top picks:** the biggest earners in the newest hour ("quick") and gaps that held all day ("steady").
- **Flips:** the same item priced differently against two currencies (for example Chaos and Divine).
  Buy on the cheap side, sell on the dear side, convert back. Each one shows how long the gap held and the gold cost.
- **Routes:** loops through several markets that end with more than they started (Chaos → Alteration →
  Divine → Essence → Chaos). Every step is checked against demand: what actually traded that hour, and the
  buyers' stock that stayed on offer all hour (the hour's lowest stock). You're assumed to win only a share of
  that (25% by default). A route is only as big as its tightest step. Prices are the hour's average fills
  minus a safety margin per step. There's also a worst-case return at the hour's worst ratios, and a
  whole-unit plan. Steps with no buyers waiting are dropped, which removes fake prices from account transfers.
- **Recipes:** fixed upgrades such as 3 essences or oils → 1 of the next tier, runes and liquid emotions in
  PoE 2, and shard and splinter stacks.
- **Open maths:** every column with a "?" explains its formula. **Formulas** lets you change the coefficients
  everything uses: median vs VWAP prices, the safety margin, your share of demand, the value of gold, score
  weights and thresholds. Three presets set the safety margin and share in one click (`PRESETS` in
  `public/formulas.js`): Optimized (the defaults, 3% and 25%), Instant sell (take the orders already there: 5%
  and 50%) and Patient (place your own orders and wait: 1% and 10%); the Lab's margin and share fields follow
  them. The page recomputes live, and values are saved in your browser. Detail panels show
  the arithmetic with the real numbers filled in. The **Lab** tab has free calculators (flip, route, score,
  price ↔ in-game ratio) for any values you type. All coefficients live in `DEFAULTS` in `public/model.js`;
  the formula texts are in `public/formulas.js`.
- **Prices**, **Spreads** (buy low and sell high in one pair) and **Odd trades** (fat fingers, bait fills,
  and account-to-account transfers through dead markets).
- **Crafting** (PoE 1): step-by-step plans to craft the rare items worn by the most played builds on
  poe.ninja, or any base and mods you pick. Each plan is ranked by expected cost at the exchange's prices
  and covers chaos and alteration spam, augment/regal with a beast imprint, essences, fossils, Veiled
  Chaos and Veiled Exalted Orbs, Eldritch Chaos/Exalt/Annul with Embers, Ichors and Orb of Conflict,
  recombinators, Orb of Dominance, Farric Wolf/Lynx Alpha, bench blockers, metamods and bench crafts.
  "Any base" lists every explicit mod with its weight and per-roll chance, with a coloured tag for where it
  comes from (base, essence, veiled, bench, fossil, influence, Eldritch); the list folds away (Hide/Show), and
  the builder and popular builds plan only when you press **Start computing** (three or more mods take 10-20 seconds). Recombinator plans come with a recipe
  card: what to make as each input item, then what comes out and what to do next. The **Workbench** applies
  currencies one click at a time (predictable recombination included, at the success chance the game shows)
  and has a simulator that checks the planner's odds over 20,000 rolls.
- **Crafting (Ruthless)**: the same planner with Ruthless rules (no bench, no Harvest, no Veiled Chaos, essences
  and fossils only on normal items, ...), Ruthless prices in Orbs of Alchemy and builds from poe.ninja's Ruthless
  league. A plan costing 1,000+ Alchemy gets a warning to aim lower (a fractured base, fewer mods).
- **Farming strategies** (PoE 1): how players farm for currency, each as a card showing the Atlas passives to take,
  the scarabs and items to load, where to run, and what the drops are worth. The map mechanics (Essence, Strongbox,
  Ritual, Abyss, Legion, Breach, Expedition, Delirium, Blight, Betrayal, Incursion, Beyond, Harvest, Delve,
  Torment, Cartography) are joined by Pilfering for divination cards, Ritual with filled vessels, Einhar's red beasts,
  regular, Catalysing and Inscription Ultimatum, deep Delve mining, Uber Lab, the Nightmare map uber fragment rush, and
  uber boss kills. The last two pick a map or boss on the card, the most profitable until you choose.
  **Sort** by profit per hour or per run, difficulty (easiest first, best earners first within a band), required
  investment (lowest first, cheapest to keep running within a band), cost per run or name. Each card's largest figure
  is the one it's sorted by, and sorting by name shows profit per hour. A **compact list** shows every strategy as one
  row, with sortable columns and a click through to its card. **Prices come from three
  places**, tagged per line: the exchange (actual trades, the **median of the last 24 hours**, so one odd trade in a thin
  market can't swing a card), poe.ninja for what the exchange doesn't trade (uniques, beasts, Wombgifts, corpse items, Nightmare Maps; these are
  listings, not sales, so what you sell is discounted, 15% by default and editable) and an editable estimate for what
  neither prices (a Watcher's Eye, Inscribed Ultimatums). Your own number can replace any price but an exchange one.
  Every quantity is an editable estimate saved in the browser. Cards say when their numbers are unmeasured ("Rough
  numbers") and when an input has no price today (it would otherwise flatter the profit). Each drop the exchange lists
  shows **your yield against its market**: "You farm 10.8k/h. Over the last 24h, 21k/h sold, worth 6.2 div/h". Those
  volumes count resales too, so real demand is lower. When an hour's drops pass a quarter of what their market trades,
  the card says what you'd make selling only that quarter, and you can sort by that figure; every other profit figure stays uncapped. Negative cards are
  shown as such. A **league stage** menu (Day 1 to Month 3, in challenge leagues) re-prices every card from that day's
  real exchange trades, fetched only when picked. poe.ninja has no history here, so its items and the estimates stay at
  today's value in Divines and each card says how much of it that is; quantities and speed stay as you set them, though
  they shift the most over a league. A market that traded in under a quarter of the day's hours gets no price, because a
  median can't filter a wealth transfer through a dead market. The same menu replays **Mirage**, the previous league,
  with real prices on both sides: its exchange hours, and item prices from poe.ninja's daily dumps. Prices that
  only made sense under old rules are left out and say why (Vivid Vulture, whose craft was removed in 3.29).
- **Legendary league-end flip:** opens behind a warning ("Danger, generational wealth ahead"), shown until the
  visitor proceeds once (saved in the browser; backing out keeps it). It compares the
  chosen challenge league with the permanent league its characters move to when it ends (Standard, or
  Hardcore, Ruthless, Hardcore Ruthless; `permanentLeagueOf` in `model.js`) over the last 24 hours, in a carry
  currency you pick. Each item's × is what 1 unit of that currency spent on it here is worth there, after the
  safety margin on both trades (`leagueEndRows`). The suggested luggage fills the wealth you want to move, best ×
  first, each item capped at your share of a few days of its trade on both sides (`luggagePlan`); the rest stays
  in the carry currency. The list folds away (click its heading; remembered). Prices are the past day's, not a forecast: a league's prices sink near its end, and
  everyone's luggage lands in the permanent league at once.
- **Ruthless and private leagues:** a Ruthless league (or a private league trading mostly in Alchemy) is priced
  in Orbs of Alchemy everywhere, with lower default volume filters. Type a private league's name or PL number
  into "Private league": the page looks back up to a week for its trades and widens the window to reach them.
- Click any row for a chart of the last 24 hours, the exact in-game ratios, and a whole-unit trade calculator
  you can fill with live ratios.
- Stars, "New" badges, and an auto-update that pulls each hour as soon as GGG publishes it, with sound (off
  by default), on-screen and desktop alerts for new picks.

By default the page loads only the newest hour, a single request. History is fetched only when something
needs it: opening a row, the steady picks, odd trades, or a longer window.

All the maths runs in the browser. The only server-side pieces are two tiny Cloudflare Pages Functions that proxy
the exchange API and poe.ninja's item prices, because neither sends CORS headers. They fit the free plan.

```
git clone https://github.com/STEPAN-BANDERA/economy-bubble.git && cd economy-bubble
npm install
npm run items:build   # game files -> public/data/items-{poe1,poe2}.json (names, categories, gold fees, icons)
npm run craft:build   # Craft of Exile mod data + poe.ninja build items (main and Ruthless) -> public/data/craft/
python3 scripts/build_ninja_history.py Mirage.zip Mirage   # optional: poe.ninja dump -> public/data/ninja-history/ (already committed)
npm run builds:build  # wiki + GGG tree export and game files + poe.ninja archetypes + the generator -> public/data/builds/ (committed)
npm run dev           # local server at http://localhost:8788
npm run deploy        # Cloudflare Pages
```

Re-run `items:build` after each game patch to pick up new items and fee changes.

### What the machine needs

- **Node.js 22 or newer** with npm. Wrangler 4 and its local server (miniflare) need 22; `pathofexile-dat` needs 20.
  `npm install` brings both, plus the platform's own `workerd` and `esbuild` binaries.
- **Python 3.8 or newer**, standard library only (no `pip install`). Only the data builds use it: `items:build`,
  `craft:build` and the scripts run by hand. The page, `npm run dev` and the tests don't.
- **Git**. The pre-commit hook is a `sh` script: Linux and macOS have `sh`, and on Windows it comes with Git for Windows.
  Enable the hook once per clone with `git config core.hooksPath .githooks`.
- **Network**: `items:build` asks the game's patch servers for the current version over plain TCP
  (`patch.pathofexile.com:12995`, `patch.pathofexile2.com:13060`), so a firewall that only lets HTTPS out stops it
  there. The other builds use HTTPS only (poe.ninja, Craft of Exile, the trade site, the game's CDN, poewiki.net and
  GGG's passive tree export on GitHub).
- **A Cloudflare account** only to deploy (`npx wrangler login`); `npm run dev` works without one.

`public/data/craft/` isn't committed: run `npm run craft:build` once on each machine before using the Crafting tab
or `npm run test:craft`. The pre-commit hook skips the crafting test, with a warning, when that data is missing.

### Windows

The commands above work unchanged in PowerShell, cmd or Git Bash; Linux, macOS and Windows produce byte-identical
data files. What differs on Windows, and how the code handles it:

- **No `python3` command.** Python's Windows installer provides `py` and `python`, so the npm scripts start Python
  through `scripts/run_python.mjs`: `python3` then `python` on Linux and macOS, `py -3` then `python` then `python3`
  on Windows, using the first that reports Python 3 (a bare `python` can be the Microsoft Store stub). Set `PYTHON` to
  choose one. When you run a script by hand, write `py` where this README says `python3`.
- **Text encoding.** Up to Python 3.14, Python on Windows reads and writes text in the ANSI code page (cp1252), not
  UTF-8, and turns `\n` into `\r\n`. The scripts therefore read and write every text file through
  `scripts/text_files.py`: UTF-8 with `\n` line endings. Without it, `Maelström Talons` reached the Crafting tab as
  `Maelstr�m Talons`.
- **npm's `.bin` launchers.** On Windows, `node_modules/.bin/pathofexile-dat` is a shell script that can't be started
  directly, so `fetch_exchange_items.py` runs the `pathofexile-dat.cmd` wrapper npm puts next to it.
- **`import()` of a path.** Node's `import()` takes a URL, and a Windows path (`c:\...`) reads as one with the scheme
  `c:`. Node scripts convert paths with `pathToFileURL()` first, as `scripts/craft_regression.mjs` does.
- **Line endings in Git.** Git for Windows usually has `core.autocrlf=true`, which would check the pre-commit hook out
  with `\r\n` and break it under `sh`. `.gitattributes` keeps `.githooks/*` and `*.sh` on `\n`.
- `npm install` may warn that `esbuild` and `workerd` have install scripts it didn't run. Both still work, because
  their Windows binaries come as separate packages (`@esbuild/win32-x64`, `@cloudflare/workerd-windows-64`).

## Layout

- `public/index.html`, `style.css`: the page. No build step.
- `public/app.js`: the interface: tabs, tables, detail panel, calculator, live updates and alerts.
- `public/model.js`: the analysis as pure functions (prices, flips, spreads, odd trades, recipes, ratio maths). It runs in Node too.
- `public/recipes.js`: fixed-ratio recipes, generated from the exchange's item names.
- `public/formulas.js`: the formula texts, tunable parameters, and Lab calculators.
- `public/craft.js`: the crafting engine: mod pools, one-currency rolls (the workbench), exact odds and the planner. Runs in Node too.
- `public/crafting.js`: the Crafting tabs (main and Ruthless).
- `public/farming.js`: the Farming strategies tab (PoE 1): the strategy library (scarab loadouts, Atlas notables,
  maps, drops as editable estimates) plus the interface. `priceLine` decides each line's price and where it came from
  (the exchange through the same `exchangePrice` helper the Crafting tabs use, then poe.ninja, then the estimate); the
  only maths is cost vs. value per run and per hour.
- `public/data/craft/`: generated by `scripts/fetch_craft_data.py` (one file of mods per base type, plus an
  index) and `scripts/fetch_ninja_targets.py` (items from popular builds, mods matched to tiers; `--ruthless` writes the
  Ruthless league's to `targets-poe1-ruthless.json`). Not in git,
  because it is derived from Craft of Exile's data; `npm run craft:build` makes it before you deploy.
- `public/data/ninja-history/`: a finished league's daily item prices, cut down to the Farming cards' items by
  `scripts/build_ninja_history.py` from poe.ninja's dump (download the league's zip from https://poe.ninja/poe1/data, run
  the script, add the league to `PAST_LEAGUES` in `farming.js`). It holds only items the cards name, so rerun it after
  adding a `ninja:` line to a card. Committed, cc-by-sa, not MIT.
- `scripts/snapshot_ninja_prices.py`, `.github/workflows/ninja-snapshots.yml`: every six hours for a league's first two
  weeks and daily after that, save poe.ninja's prices for the cards' items to the `snapshots` branch, because a running
  league has no other record of them. The site doesn't read this branch yet.
- `public/data/items-*.json`: generated. Maps `Metadata/Items/...` ids to name, category, gold fee and icon.
- `functions/api/cx/[[path]].js`: the proxy. `/api/cx/<hour>` or `/api/cx/<poe2|xbox|sony>/<hour>`.
  Complete hours are cached for a year. A 404 (hour not out yet) is cached for 60 s. A body that was
  cut off is never cached.
- `functions/api/ninja/[[path]].js`: the poe.ninja proxy for the Farming tab. `/api/ninja/<league>/<type>`, for the item
  types the tab uses only. Cached for 30 minutes per Cloudflare data centre (a cached answer has an `Age` header;
  `cf-cache-status` always says DYNAMIC) and trimmed to the fields the tab reads. `npm run test:proxy` tests it offline.
- `scripts/fetch_exchange_items.py`: reads the game's `CurrencyExchange`, `CurrencyExchangeCategories`
  and `BaseItemTypes` tables with [`pathofexile-dat`](https://www.npmjs.com/package/pathofexile-dat), and icons from the trade site's static data.
- `public/buildgen.js`: the Build maker's generator: support rules, which effects reach a build, the offence,
  defence and clear indexes, composing a build, the reasons for each piece, the player bands. Pure functions that
  run in Node too. `public/buildtree.js` plans a build's passive tree. `public/buildideas.js` draws the "Our ideas"
  view.
- `public/builds.js`: the engine of the "What people play" view (archetype traits, the questions, ranking, the spin
  wheel); `public/buildmaker.js` draws the tab. `npm run test:builds` tests both engines and the stat-line reader.
- `public/data/builds/`: the Build maker's data, CC BY-NC-SA and poe.ninja aggregates (its `LICENSE.md`).
  `game-poe1.json` from `scripts/build_game_data.py` (skills with their delivery and damage types, ascendancies,
  keystones, bloodlines, uniques); `mechanics-poe1.json` from `scripts/build_mechanics.py` (every
  piece's effects and the support rules) and `tree-poe1.json` (the passive tree's nodes, links and effects);
  `meta-poe1-<league>.json` and `leagues-poe1.json` from
  `scripts/fetch_build_meta.py` (archetypes and per-ascendancy skill counts per league); `generated-poe1.json` from
  `scripts/generate_builds.mjs` (the generator's builds, checked against those counts).
- `scripts/build_sources.py`: gathers the Build maker's game knowledge from public sources (GGG's tree export and game
  files, poewiki.net) and normalises it, through `scripts/poewiki.py` (the wiki's data API, cached and polite) and
  `scripts/game_files.py` (game-file tables via `pathofexile-dat`).
- `scripts/mechanics_vocabulary.py` and `scripts/mechanics_statements.py`: our reading of stat text into effects
  (the grammar, and the hand-written rules); `scripts/test_mechanics.py` tests them on real lines.
- `scripts/ninja_builds.py`: reads poe.ninja's builds API: the disk cache, the protobuf search answer, and its
  "NDIC" name dictionaries. Shared by `fetch_ninja_targets.py` and `fetch_build_meta.py`.
- `scripts/run_python.mjs`: starts a Python script with whichever Python 3 the machine has (see "Windows" above).
- `scripts/text_files.py`: UTF-8, `\n`-ending text reads and writes that every Python script uses, so Windows and
  Linux builds match.
- `scripts/dat_preload.mjs`: maps PoE2's `0.x` patch numbers, and names the schema's unnamed columns `Unk<n>` so they can be exported.

## Code style (required)

The code is written to be read and debugged, not to be short. `public/craft.js` is the reference.

- **Explicit blocks.** Every `if`, `else` and `for` gets braces and its own lines. No `if (x) return y;` chains, no
  `cond ? a : b ? c : d` chains, no long `.map().filter().reduce()` one-liners: write the loop.
- **Full names.** `targetWeight`, `prefixCount`, `unveilChance`, not `tw`, `nP`, `q`. Helpers say what they do
  (`combineBills`, `triesUntilSuccess`, `modGroupsOn`). The one exception is the planner's state vocabulary inside
  `planOnce` (`F`, `st`, `jp`, `js`, `T`, `K`, `P`), which is explained in the comment above it.
- **Small named functions.** A function that grows several separate jobs gets split into named helpers (see
  `moves()`, `solve()` and the per-currency `apply*` functions).
- **Comments say why**, in plain sentences: game rules, sources, and what a number means.
- Verbose is fine. Token count and line count don't matter; clarity does.

Refactoring the planner must not change its results:

- Keep the order of floating-point additions and of random-number draws the same (sums written as loops add in the
  same order as the `reduce` they replace; `mulberry32` draws must happen in the same sequence).
- Some sorts are in place on purpose (`likelyStop`, `trace`); they change later iteration order, so keep them.
- Check against saved outputs: run a fixed set of plans (several bases, phases, influences, Ruthless, a pasted
  item, supply data) plus seeded `apply()` sequences, before and after, and compare the JSON exactly.
  `simulateGraph` stops on a time budget, so freeze `Date.now` (for example `Date.now = () => 0`) while comparing.

Every change to the crafting engine (refactor or not) runs the **crafting regression test**: `npm run test:craft`
(`scripts/craft_regression.mjs`, about 2 minutes). It plans two fixed wands (`scripts/craft-regression/items.json`:
a Kinetic Wand with crit suffixes and a bench spell damage prefix, and a +1/+1 chaos DoT wand with a veiled
prefix and bench cast speed) at frozen prices (`prices.json`), the way the page does (with and without fossils),
and compares every plan's cost with `baseline.json`. A plan more than 0.5% dearer, gone or broken fails; so does
one that got cheaper, until its steps are checked (a dropped failure case also looks cheaper) and the baseline
is saved with `npm run test:craft -- --update`. The crafting data isn't committed, so the baseline records the
data's build date and the test says when the data was rebuilt. `.githooks/pre-commit` runs the test whenever a
commit touches `public/craft.js`, `public/craft-worker.js` or the test and its fixtures (enable per clone with
`git config core.hooksPath .githooks`; skip once with `git commit --no-verify`). Turning off the "Cannot roll Caster" + Annul
move, for example, makes the second wand's Best mix 129% dearer and fails the test.

### Patch rules

A few crafting rules changed between patches. `scripts/fetch_craft_data.py` records the newest league Craft of
Exile's data covers (`dataLeague` in `craft/index-poe1.json`), and `gameRulesOf` in `public/craft.js` picks the rules
by it: Allflame and earlier (or data without the field) are modelled as up to 3.29, anything newer as 3.30.

- **"Cannot roll Caster/Attack Modifiers" + Annul** (3.30.0 Item Changes): Annulment no longer respects these
  metamods, so the planner stops offering the move under 3.30 rules. On the fixed wands at frozen prices the
  Kinetic Wand's cheapest plan goes from 19,163c to 19,663c and the Opal Wand's from 15,512c to 36,492c, so
  `npm run test:craft` will fail the first time the data is rebuilt on 3.30. That is this rule, not a regression:
  check the plans and save the baseline with `--update`.
- **Wild Bristle Matron**: it adds a random bench metamod that fits an open side, from the metamods the data lists.
  3.30 adds four ("1 Prefix Modifier cannot be changed", "2 Prefix Modifiers ...", and the suffix pair, 1 and 2
  Divines), so once the data has them each metamod the Matron can give gets rarer, and the planner prices it that way
  with no code change. 3.30 also reprices "Prefixes/Suffixes Cannot Be Changed" by item type (4 Divines plus a Sacred
  Orb on weapons, 4 Blessed Orbs on armour, 8 Exalted Orbs on jewellery); bench costs come from the data.
- **Partial locks** ("1 Prefix Modifier cannot be changed", "2 Suffix Modifiers ..."): the bench protects that many
  random mods of the side, and crafting it again picks again. The planner crafts one until it covers every wanted mod
  of that side (all of them, no more than the lock holds): on average 1 / chance crafts, each wrong one removed for an
  Orb of Scouring, where the chance is C(n - w, k - w) / C(n, k) for w wanted mods among n with a k-lock. A Wild
  Bristle Matron is the other way in: it gives one of the N metamods that fit an open side, so N / chance pulls (each
  wrong one scoured off), and the cheaper of bench and Matron is used. At the frozen test prices the bench wins (a
  suffix pull is 1 of 6 metamods once the new prefix locks join the four old ones); with Divines at 1,000c the Matron
  does ("1 in 18" for the Opal Wand's two gem prefixes). Then a
  Chaos Orb rerolls everything else, an Annul takes any unprotected mod on either side (or the lock), or a Scour
  leaves only the protected mods. The manual bench marks the protected mods when the lock goes on (bench or
  Matron); they are safe only while the lock stays. The locks are recognised by their text, as their flag names
  aren't known before the data has them: if Craft of Exile words them differently, `partialLockOf` needs the new
  wording. With the four added by hand at 1 and 2 Divines, the Opal Wand's cheapest plan under 3.30 rules is 15,339c
  (36,492c without them) and the Kinetic Wand's 15,422c; `npm run test:craft` checks the odds and the manual
  behaviour ("Patch rules").

## Disclaimer, privacy and license

- A free fan project, not affiliated with or endorsed by Grinding Gear Games. Path of Exile, its item names,
  icons and game data belong to Grinding Gear Games.
- No ads, no accounts, no cookies, no analytics. The site collects nothing about visitors. Settings and stars
  live in the visitor's own browser storage. The Farming tab's item prices come from poe.ninja through this site's
  proxy, so visitors' browsers don't contact it. Item icons load directly from GGG's image server
  (`web.poecdn.com`, with no referrer sent). The Cinzel font is served from this site, not a font CDN.
- Crafting mod weights come from [Craft of Exile](https://www.craftofexile.com/)'s public data files (some weights
  measured by the Prohibited Library community), and build items from [poe.ninja](https://poe.ninja/builds).
  Neither is affiliated with this project. The derived files are generated locally and not committed.
- Numbers are estimates from past trades, not financial advice.
- The code is MIT licensed (see `LICENSE`). Cinzel is SIL OFL 1.1 (`public/fonts/Cinzel-OFL.txt`). The images
  in `public/img/wiki/` are copies from the PoE Wiki (CC BY-NC-SA 3.0, artwork © Grinding Gear Games) and are
  not covered by the MIT license. The files in `public/data/ninja-history/` are derived from poe.ninja's data dumps,
  licensed cc-by-sa as poe.ninja publishes them, and aren't covered by it either. Nor is `public/data/builds/`:
  its game data comes from poewiki.net (CC BY-NC-SA 3.0) and GGG's own exports, and its archetypes are aggregates of
  poe.ninja's builds data (see the folder's `LICENSE.md`).
- `robots.txt` and `sitemap.xml` point at `https://ledger.poedle.xyz/`, the Pages project's custom domain (some
  ISPs block `*.pages.dev`; the custom domain avoids that, and `faustus-ledger.pages.dev` still works). Change
  them, and the canonical link in `index.html`, if you deploy under another name or domain.

## Credits and sources

| What | Source | Terms |
|---|---|---|
| Hourly market data | GGG's public [Currency Exchange API](https://www.pathofexile.com/developer/docs/reference#currencyexchange) (`web.poecdn.com/api/currency-exchange`) | Public, no key; GGG's developer terms |
| Item names, categories, gold fees | Path of Exile game files, read with [`pathofexile-dat`](https://github.com/SnosMe/poe-dat-viewer) and its community [dat schema](https://github.com/poe-tool-dev/dat-schema) | Game data © Grinding Gear Games; tool MIT |
| Item icons | Official trade site static data (`pathofexile.com/api/trade/data/static`), images hot-linked from `web.poecdn.com` | © Grinding Gear Games |
| Beast and Recombinator icons (`public/img/wiki/`) | [PoE Wiki](https://www.poewiki.net/) | Artwork © Grinding Gear Games; wiki content CC BY-NC-SA 3.0 |
| Mod tiers, spawn weights, fossils, essences, bench costs | [Craft of Exile](https://www.craftofexile.com/) public JSON data, unminable weights by the Prohibited Library community | Generated locally, not committed |
| Popular-build items | [poe.ninja](https://poe.ninja/builds) builds API | Generated locally, not committed; player names are dropped |
| Build maker archetypes (`public/data/builds/meta-poe1-*.json`) | [poe.ninja](https://poe.ninja/builds) builds API: per-ascendancy and per-archetype searches, and a few characters per archetype | Committed as aggregates only (counts, shares, medians); no player or account names |
| Build maker game data (`public/data/builds/game-poe1.json`) | Gems and uniques from the [PoE Wiki](https://www.poewiki.net/)'s data tables; ascendancies, notables, keystones and bloodlines from GGG's [passive tree export](https://github.com/grindinggear/skilltree-export) | CC BY-NC-SA 3.0 (wiki-derived) |
| Build maker mechanics (`public/data/builds/mechanics-poe1.json`) | Gem and unique stat text from the [PoE Wiki](https://www.poewiki.net/), passive stat text from GGG's tree export, read by our own vocabulary; skill types and support rules from GGG's game files via [`pathofexile-dat`](https://www.npmjs.com/package/pathofexile-dat) | CC BY-NC-SA 3.0 (wiki-derived) |
| Build maker ideas (`public/data/builds/generated-poe1.json`) | Our generator (`public/buildgen.js`), each build checked against poe.ninja's per-ascendancy skill counts | Same licence as the mechanics it is made from; counts only, no names |
| Harvest lifeforce costs | [Maxroll](https://maxroll.gg/poe/) 3.24 Harvest guide | Numbers only |
| Fee format, Mirage essences, Dominance rules | [poedb](https://poedb.tw/) | Facts only |
| Farming-strategy baselines (scarab loadouts, Atlas notes, drop estimates) | public 3.29 farming guides ([timesaver.gg](https://timesaver.gg/), [Maxroll](https://maxroll.gg/poe/), [AOEAH](https://www.aoeah.com/), [MMOexp](https://www.mmoexp.com/), Farm of Exile), [poedb](https://poedb.tw/) for fragment sources and scarab effects, and community sample runs ([Wealthy Exile](https://wealthyexile.com/) public strategies) | Facts and estimates only; editable in the tab |
| Prices of items the exchange doesn't trade (Farming tab) | [poe.ninja](https://poe.ninja/economy) item overviews, fetched live through a cached proxy as [its API docs](https://poe.ninja/docs/api) advise | Not affiliated; public economy endpoints |
| Past-league item prices (Farming tab, `public/data/ninja-history/`) | [poe.ninja raw economy data dumps](https://poe.ninja/poe1/data); filtered to the cards' items, low-confidence rows removed, values rounded, renamed beasts given current names, the cheapest copy kept where a name has several, Forbidden jewels averaged across notables without the dearest tenth | cc-by-sa, as published by poe.ninja |
| Farming rates, loadouts and mechanics by card | Pilfering: [Wealthy Exile sample run](https://wealthyexile.com/strategies/2971/pilfering_div_cards_with_abyss). Ultimatum: [Maxroll](https://maxroll.gg/poe/currency/ultimatum-currency-strategy), [poedb](https://poedb.tw/us/Ultimatum_Scarab_of_Catalysing). Delve: [Maxroll](https://maxroll.gg/poe/currency/delve-farming-guide), [MMOexp session](https://www.mmoexp.com/News/poe-3-29-delve-farming-guide-best-low-investment-strategy-for-25-divines-per-hour.html). Ritual vessels: [poedb](https://poedb.tw/us/Blood-filled_Vessel), [AOEAH](https://www.aoeah.com/news/4733--poe-329-ritual-farm-strategy-atlas-maps--scarabs-setup). Einhar: [Timesaver](https://timesaver.gg/blog/poe-3-29-bestiary-farming-guide), [EZG](https://www.ezg.com/blog/poe-3-29-beast-farming-is-this-still-one-of-the-best-ways-to-make-currency). Uber Lab: [PoE forum guide](https://www.pathofexile.com/forum/view-thread/3878070), [PoE Vault](https://www.poe-vault.com/guides/uber-lab-farming-guide), routes on [poelab.com](https://www.poelab.com/). Uber fragments and bosses: [poedb](https://poedb.tw/us/Blazing_Fragment), [AOEAH](https://www.aoeah.com/news/4443--poe-328-voidstones--nightmare-maps-farm-guide), [Timesaver](https://timesaver.gg/blog/poe-uber-boss-farming-guide-3-29). Uber Incarnations: [poedb](https://poedb.tw/us/Traumatic_Fragment). Breach: [Maxroll low-investment](https://maxroll.gg/poe/currency/breach-league-start-strategy) and [Unstable Breach](https://maxroll.gg/poe/currency/unstable-breach-currency-farming) guides, [poedb](https://poedb.tw/us/Breach). Harbinger's removal: [poedb 3.28 notes](https://poedb.tw/us/Version_3.28.0) | Facts and estimates only; several are currency sellers' blogs, so treat their income claims with care |
| Font | [Cinzel](https://github.com/NDISCOVER/Cinzel) | SIL OFL 1.1 |
| Hosting and proxy | [Cloudflare Pages](https://pages.cloudflare.com/) + [Wrangler](https://github.com/cloudflare/workers-sdk) | Free plan; Wrangler MIT/Apache-2.0 |

Ideas borrowed with thanks from Divine Tendies, Path of Stonks, timeolord's poe-arbitrage and Maxroll's
flipping guide (see "Other tools seen" below).

## Keys and credentials

None. Every source above is public and needs no API key, the repo contains no secrets, and the site has no
environment variables. To deploy your own copy you need your own Cloudflare account: `npx wrangler login`,
then change `--project-name` in `package.json` and `name` in `wrangler.toml`. Keep any local secrets in
`.env` or `.dev.vars`; both are gitignored.

## What the API actually is (tested 2026-10-09)

`GET https://web.poecdn.com/api/currency-exchange[/<realm>][/<hour>]`. It is public, with no OAuth.

- **No CORS header** (`Access-Control-Allow-Origin` is missing for every origin), so a browser can't call it
  directly. Hence the proxy. A GitHub Actions cron that commits JSON hourly would also work; that is what
  `timeolord/poe-arbitrage` does.
- One digest per hour, covering all leagues of the realm, private leagues included (`"... (PL12345)"`).
  The id is the unix hour start. The hour becomes available once it ends; until then you get a 404 whose
  body has `next_change_id == id`. Akamai doesn't cache those 404s.
- Without an id you get the first hour ever (2024-07-26, Settlers). You can jump straight to any hour.
  Any id that isn't on the hour returns 404.
- Size: PoE1 PC is about 1 MB per hour (64 KB gzipped), with about 1,250 markets per hour. PoE2 is about
  2.3 MB, with about 2,800 markets. Responses are `Cache-Control: max-age≈1y`.
- Per market `[A, B]` (verified on 708/708 active markets in one hour):
  - `volume_traded[A] : volume_traded[B]` is the total of each side that changed hands, so `vB/vA` is the hour's average price.
  - `lowest_ratio` / `highest_ratio` are the min and max of A:B over the hour's trades. The average always falls inside.
    They are integer pairs, e.g. `{chaos: 336, divine: 1}`.
  - `lowest_stock` / `highest_stock` are the min and max quantity offered on each side during the hour.
  - Markets can appear with 0 volume (stock only).
  - GGG's reference doesn't define the stock or ratio fields, so these readings come from the data. It calls the digests
    "purely historical": there are no open orders, no order book, and nothing from the current hour. Stock is the nearest
    thing to pending orders, with no prices attached, and the lowest stock is what stayed on offer all hour.

## Crafting data and how the Crafting tab works (studied 2026-10-10)

**Craft of Exile** serves its data as plain JSON (`/json/data/main/poec_data.json`, about 8.6 MB). The useful parts:

- `modifiers`: every mod with its affix (`prefix`, `suffix`, `eldritch_red`/`eldritch_blue` for
  Exarch/Eater implicits), mod groups (two mods of the same group can't share an item), tags (what fossils
  and metamods act on), and a source group (`mgroup`): 1 base, 2–7 Shaper/Elder/Crusader/Hunter/Warlord/Redeemer,
  8 fossil, 10 veiled, 11 bench, 13 essence, 14 beast aspects.
- `tiers[mod][base]`: per base type, the tiers with item level, spawn weight and value ranges. Veiled mods
  and Eldritch implicits aren't minable; those weights were measured by the Prohibited Library community.
- `basemods`, `bases`, `bitems`, `bgroups`: which mods each base type can have, item names, affix limits.
- `fossils` (tag multipliers: `{"chaos":1000,"lightning":0}` is ×10 chaos, no lightning), `essences`
  (per base, the forced mod), and `poec_common.json` → `benchcosts` (bench costs per mod, base and tier).

Its JavaScript (`packages/package.js`) has two tools, which this site copies:

- **Emulator** (`poec_sim*`): apply one currency at a time to an item. A mod roll builds the pool (right
  item level, free prefix/suffix slot, no clashing mod group, metamod and fossil filters) and picks by
  weight. A reforge rolls 4/5/6 mods with chances 8/12, 3/12 and 1/12 (3/4 mods at 65/35% on jewels).
  Alterations give 1 or 2 mods, half and half. Chaos Orb keeps the side protected by "Prefixes/Suffixes Cannot
  Be Changed". Veiled Chaos rerolls with one veiled mod on a random open side; Veiled Exalt adds a veiled mod on a
  random open side, then removes another random mod (so it needs room and never fills the item); unveiling offers 3 by weight. Eldritch Chaos/Exalt/Annul act only on the
  dominant side (Exarch stronger: prefixes; Eater stronger: suffixes). Orb of Conflict raises one eldritch
  implicit a tier and lowers the other. Orb of Dominance needs two influenced mods, removes a random one and
  upgrades another (elevated past the top tier). The recombinator keeps either base, averages item level,
  pools both items' prefixes (and suffixes), draws how many survive from a table by pool size (2 → 1 or 2
  at 2/3 and 1/3), then picks them at random. Only one exclusive mod (crafted, metamod, essence, veiled,
  Aspect, elevated) can be kept; since 3.26.0 (2025-06-12 update) a second one picked still uses up its
  slot, so exclusive mods make a pool bigger without adding anything (crafted fillers no longer help). Beasts: Craicic Chimeral imprints a magic item, Farric Wolf
  Alpha swaps a prefix for a suffix, Farric Lynx Alpha the reverse, the four Firsts add an Aspect suffix.
- **Simulator** (`poec_nsim*`): you chain steps ("chaos until these mods, else go to step 2") and it runs
  the emulator thousands of times to report average cost. The Crafting tab does the same check per method,
  and instead of sampling it also computes each method's odds exactly: a recursion over which targets are
  hit, which are dead (their mod group taken by a wrong tier), and how many prefix and suffix slots are used.
  Junk mods can't repeat their group, so junk weight shrinks as junk lands: an even share per junk group,
  except that a junk group with a quarter or more of its side's junk weight is followed on its own. Fossils
  make that common (Aetheric + Corroded + Metallic + Shuddering on a wand: Spell Damage is 97% of the
  prefixes; once it lands, the gem prefixes are most of what's left, which gives Craft of Exile's 13 tries for
  both gem prefixes; with even shares it came out at about 2,700).
  The exact odds match 40,000-roll simulations within error, and they also work for one-in-a-billion crafts.

**poe.ninja builds**: `/poe1/api/data/index-state` gives the build snapshot version,
`/poe1/api/data/build-index-state` the top class + skill pairs, `/poe1/api/builds/<version>/search` is
protobuf (the character and account names are string columns: message 1, field 12, values in field 7), and
`/poe1/api/builds/<version>/character?account=&name=&overview=&type=exp` returns the items as JSON. The
script keeps only the rare items and drops player names. Hybrid mods show up as two separate lines, not
always next to each other, so it pairs lines when no single mod explains them, and again when a side holds more
mods than the base allows (`33% increased Armour and Evasion` and `15% increased Stun and Block Recovery` each
match a mod alone, but on a full item they are one hybrid prefix; two bench crafts can be one hybrid craft too).
An item that still doesn't fit is skipped: the game sums the same stat from two mods into one line
(`130% increased Energy Shield`), which can't be split back reliably.

**Plans.** The planner treats a craft as a Markov decision process. A state is which wanted mods are on the
item, which are blocked by a wrong tier of the same mod group, how many junk mods sit on each side, and which
wanted mod (if any) is fractured. From each state it knows every move and the exact odds of where it leads:

- reforges: Chaos, essences, fossils (Hollow included), Veiled Chaos, Harvest reforge with a type and "more
  likely", Eldritch Chaos on the dominant side, "Prefixes/Suffixes Cannot Be Changed" + Chaos;
- Fracturing Orb (a random mod becomes permanent; a junk fracture ruins the base);
- slams: Exalted Orb with a cheap bench craft blocking the other side, Exalted Orb under "Cannot roll
  Attack/Caster Modifiers", Eldritch Exalt, Veiled Exalt, Harvest "add a mod of a type";
- removals: Annul, Eldritch Annul, metamod lock + Annul (only the unlocked side can lose a mod; the metamod
  itself can eat the Annul), "Cannot roll Caster/Attack Modifiers" + Annul (Annulment, unlike any reforge,
  respects those metamods on explicit mods, so wanted caster mods stay: with "Prefixes Cannot Be Changed" +
  Veiled Chaos repeated, a wrong unveil is picked as a non-caster mod and annulled this way, which makes the
  veiled prefix nearly free next to two +1 gem prefixes; 3.30 ends that protection, see "Patch rules" below),
  metamod lock + Scour; Farric Wolf/Lynx Alpha swaps;
- metamod tricks: "Prefixes/Suffixes Cannot Be Changed" + Chaos or + Harvest reforge (today's "reforge keeping
  prefixes/suffixes"), "Cannot roll Attack/Caster Modifiers" before a slam, and "Can have up to 3 Crafted
  Modifiers" so a blocker and an Attack/Caster metamod share one slam;
- from a fresh base, Alteration (+Augmentation) then Regal, with or without a Craicic Chimeral imprint.

It finds the cheapest strategy from every state at once by policy iteration: start from a strategy that is
sure to finish, solve its expected costs exactly (a sparse linear system, solved directly by eliminating
states in Markowitz order), switch every state to its cheapest move, repeat until nothing changes. An
Alteration start is one more unknown in that system: with its rule for which Regal results to keep fixed, its
value is linear in the states' values, and a ruined item links back to it (`keptRow` in `craft.js`). Carried
over from the round before instead, the starting-over cost lagged behind, and every state that can ruin the
item was priced a little too high (6% on the chaos wand: the solver said 18,016c, its own strategy simulated at
16,938c; now 16,954c). The keep rule is improved like a move: a better one for the new values is another round.
Progress is
kept: an Annul that takes a wanted mod costs that mod, not the whole craft. Each method family is also solved
on its own (with every finishing move allowed) so they can be compared. Fossil combinations of up to four are
scored by the value of what they roll; the best three join the solve, and so do the three that hit the wanted
mods most cheaply in one reforge (when one hard mod dominates the cost, the whole-craft values barely differ), and
the two that hit one side's wanted mods most cheaply (fossil the gem prefixes, then do the suffixes another
way). Only the mods fossils roll count for those (a veiled or essence-only wanted mod never comes from them). The
"Ways to start" table also prices the alternative for each reforge: rolling until a chosen set of wanted mods lands
at once, then finishing. It can't beat the plan's stopping rule, which may stop at that set too. The plan shown is the likeliest
path through the strategy. Prices: the exchange; Harvest lifeforce amounts from Maxroll's 3.24 guide (Harvest
"reforge keeping prefixes/suffixes" is no longer in the game); beasts and recombinators use editable estimates.
The planner runs in Web Workers (`public/craft-worker.js`), two at once: one without fossils and one with them
(fossil plans, the fossil lab, Best mix and the Recombinators with fossils). Each worker hands over every plan
as soon as it is made (`plan`'s `onPlan`, a preview without the graph and currency count), so the list fills
in this order: Essence spam, Alteration / Regal, Chaos spam, Veiled Chaos, Harvest, Eldritch currency, Best
mix, prefixes first, suffixes first, the Recombinator. The fossil plans are worked out alongside but shown
last, once the other worker is done; the same plan from both workers keeps the cheaper version. While a plan
is being worked out the item's mods and settings are locked, and a new item waits for the current plan rather
than stopping the workers mid-run (on a big craft a worker holds about a gigabyte).

Memory: one solve is a graph of every reachable state with every move and reforge outcome (on a 6-mod wand,
13,164 states and about 2.7 million edges, 150 to 200 MB of objects). A method's solve is shrunk as soon as
its plan is made (`shrinkSolve`): only the states its strategy can reach keep their moves, the rest keep their
value and chosen action (all Best mix's warm start and fossil scoring read). Best mix stays whole: much is
built on it. Cutting rare reforge outcomes was tried and dropped: on hard crafts the hits are the rare
outcomes, so it changed costs by up to 7% (or by under 0.3% while saving nothing at a smaller cut).

**Hardest mod.** A table under the plans (`rankModDifficulty` in `craft.js`, instant) ranks the wanted mods by
their best chance per pick: a random roll (share of its side's pool at the wanted tier), an essence or bench
craft (always), Harvest "add a mod of a type" (share of that type on its side: the only mod of a type is always
added, only the tier is luck), Harvest reforge with a type, or veiled + unveil; and which types are shared with
other mods. The hardest one is the mod to buy fractured. It's a rule of thumb: the full plans below price
every method, and fossils and later steps can change the answer (a wand's two +1 gem prefixes come from
Aetheric + Corroded + Metallic + Shuddering, the veiled prefix from a locked Veiled Chaos, so the mod to fracture
is the one nothing forces).

**Fractured base and side order.** A button under the plans runs the whole planner once with nothing
fractured, then once per wanted mod starting from a base with that mod fractured (its price not counted), on a
third worker, and ranks them by what the rest of the craft costs. That measures how hard each mod is to get
later with every method, not its weight: a rare mod that a Harvest reforge or add can force (few mods share its
type) is easy later, so fracturing it wastes the item's one fracture. A mod whose rest costs more than "nothing
fractured" makes the craft dearer than no fractured base at all.

Each of those runs also prices the side-by-side way deterministic crafts are done (`spec.sideOrder`,
`planSideOrders` in `craft.js`): all the prefixes first, then the suffixes, and the reverse. The first side is
a solve of its own in which no move or reforge may aim only at the other side (a slam that can only bring a
suffix, or "Prefixes Cannot Be Changed" + Chaos, waits until the prefixes are done; `onlyAimsAtOtherSide`).
The strategy for the first side is chosen only for that side, as a crafter doing it would, with one exception:
a fractured wanted mod of the other side. While choosing, an end of the phase (the first side complete) is
worth what the best strategy pays to finish from it with the other side's wanted mods counted as junk, except a
fractured one (`keyWithOtherSideAsJunk`). So a wanted mod of the other side that lands by luck is a bonus it
doesn't aim for, but fracturing one first is worth aiming for: the usual opening (roll a suffix, fracture it,
then work on the prefixes, with a lock where it helps). The plan then says so ("Fracture a wanted suffix
first"). The phase ends as soon as that side is complete (`solve`'s `phaseGoal`: done states carry their cost
as `term`; an end state the best solve never reached has no price, and the phase plays on from it). The same
strategy is then priced twice (`phaseCostWithEnds`): with every end free, for what the first side alone costs,
and with each end at what finishing really costs from it, which counts luck and wanted mods an Annul knocked
off. That gives the cost of "this side first, then finish", which can't beat the best plan with no fixed order
(when it plays the same strategy, rounding can put it a hair below, so it is held at the best plan's cost), and
its steps, Fracturing Orb included (traced before the pricing, so they read as chosen). Without the fracture
exception the order that doesn't suit the item cost 3-4 times the best plan on the regression wands (finishing
that side under a lock needs two specific mods at once); with it, both orders cost within 2% of the best plan.
The plan list shows both orders as plans of their own (`spec.sidePlans`); the other plans
come out the same with or without them.

**Fossils.** The fossil thread scores every combination of up to four of the most useful fossils (Craft of
Exile's fossil calculator) and adds what only today's prices can tell. Before pricing, a quick score keeps the
150 best for all wanted mods together, plus the 25 best for each side's wanted mods alone (each mod's chance to
be on the item after one reforge, estimated with one pick per mod group and at most three mods per side, so
Shuddering blocking mana prefixes and Faceted's socketed-gem suffixes are counted). The **fossil lab** lists, per
combination, the chance one reforge rolls each wanted mod and all of them, cost and clicks per try and per full
hit, and the whole craft when it opens with that combination and then plays the cheapest strategy; the best of
each size (1 to 4) by each measure is on top. When both sides have wanted mods, it also lists the three cheapest
combinations to land each side's mods together, Craft of Exile's question when only, say, the gem prefixes are
asked for (on the regression's Opal Wand: Aetheric + Corroded + Metallic + Shuddering, 8.04% a try for both +1 gem
prefixes, against Craft of Exile's 8.031%). Besides the cheapest fossil plan there are two more:
**fewest clicks** (the same solve with every fossil, resonator, orb, beast or bench craft priced at one click;
bulk payments like dust, gold, lifeforce and sulphur don't count, so Harvest and the Allflame bench are left
out) and **cost and clicks balanced** (each click priced at what a click of the cheapest fossil plan costs,
shown only when no other plan is both cheaper and needs fewer clicks). Their chaos costs come from simulated
crafts. Every plan shows its clicks per craft from the same simulation.

**Fossils + Recombinator.** Two inputs, each rolled with fossils until it carries a set of wanted mods (or a
clean Alteration item), recombined into an item with 4-5. Each input is an exact spread of results: which extra
wanted mods it brought, how much junk on each side (junk goes into the pool and lowers the odds). A wanted mod
on both inputs is assumed to count twice in the pool (only one copy can stay); guides disagree on this (an
AoEAH 3.29 guide says duplicates "shrink the pool", while Pohx's sceptre recipes deliberately put damage over
time multiplier on both inputs). Every item a recombine can make is solved as a state, so the plan finishes
from wherever the recombine lands.

**Other starting points.** The steps follow the likeliest result. Under each plan, "Other starting points"
lists the other ways the opening (the first spam, Alteration and Regal, a recombine) can leave the item, with
their chance, what's left to pay, and the plan from there; the fossil plans also get a state graph per start.

**State graph.** For the three best plans the worker also runs the strategy about 500 times through the
state machine and draws it: columns by how many wanted mods the item has, boxes for classes of states
(prefixes/suffixes done, fractured, junk count, slots full, magic stage, imprint saved), arrows for the
moves the strategy makes (thicker = more often per craft; dashed arrows back are setbacks). Clicking a state
lists every move from it with its expected cost to finish, so you can see which choices are close and why the
strategy picks the one it does. The simulation also gives the spread of the total cost (median, 10th and
90th percentile) next to the exact average.

**Crafting (Ruthless).** The same planner with Ruthless rules (GGG's "Announcing Ruthless" post and a
250-hour player review on the forum): no crafting bench (no bench crafts, metamods or blockers); no Veiled Chaos
Orbs, Orbs of Binding, Orbs of Dominance, influenced Exalted Orbs or Awakener's Orbs; no Harvest crafts at all
(reforges and resistance swaps are gone, and lifeforce is left unpriced so the rest are skipped too); no Wild
Bristle Matron (a wrong metamod comes off at the bench); no Chaotic Resonators, and essences only upgrade a normal
item, so an essence or fossil reforge is priced as Scour + essence, or Scour + fossils in an Alchemical
Resonator. Prices come from the last 24 hours of the Ruthless league in Orbs of Alchemy, the main currency there.
Its Popular builds come from poe.ninja's Ruthless league (`python3 scripts/fetch_ninja_targets.py 8 4 --ruthless`
writes `targets-poe1-ruthless.json`).
Not modelled: in Ruthless a reforged influenced item loses its influence. Ruthless lost unpredictable
recombination in 3.26.0, so plans there have no Recombinator routes and the Workbench offers predictable mode only.
The Workbench follows the same rules: no Veiled Chaos or influence buttons (influenced Exalts, Awakener's,
Dominance, the Harvest influence crafts), and a fossil reforge charges an Alchemical Resonator, plus an Orb of
Scouring on a rare item (`applyFossils` with `{ fossils, ruthless }`).

**Predictable recombination** (3.26+): you pick which mods to keep from the two items, and the game shows a
success chance that drops with more and higher-tier mods; a failure destroys both items. GGG hasn't published
the formula (one 3.29 guide reports about 8% for any crafted mod, down from 40-50% in 3.27), so the Workbench
takes the chance you read in-game, and plans still use the unpredictable mode.

**Allflame bench**, from 3.29 guides: 2 to 4 outcomes depending on the currency; Intangibility (the chance the
next craft shows one outcome) rises with each craft and carries over when the item is the base of a
recombination; 3.29.1 added Ancient Orbs and Orbs of Chance; Sulphur costs about 1,000-2,000 for most crafts
and 50,000+ for a Fracturing Orb, and less on jewels.

## How the Farming tab prices things

**A line's price** (`priceLine` in `farming.js`), in order: the viewer's own number; "not counted" for a line whose old
price no longer means anything (`notInPastLeagues`, past leagues only); a poe.ninja line (live, or that day's dump in a
past league, discounted when selling); a label's estimate; the exchange; the line's fallback estimate; else no price,
which the card lists because an uncounted cost flatters the profit. Editing a number on a farm with a map or boss choice
pins that choice, or the card could swap away from what's being edited when another option became the best earner.

**Exchange prices** are the median of the window's hourly averages. In the Farming tab an item must also have traded in
at least a quarter of the window's hours (`farmExchangePrice` in `app.js`; the other tabs don't apply this). A median
can't filter a wealth transfer when there are only two hours of trades: 34 Alchemy Shards sold for 61 Divines once made
Harbinger read 288 Divines an hour.

**Items with many prices.** A Forbidden jewel's value depends on its random ascendancy notable, from 10 Chaos to 10 Divines
and beyond, so one price stands for all of them: the average across notables, leaving out the dearest tenth, whose thin
listings would swamp it. This assumes each notable drops equally often. Corpse items use the same rule across every corpse monster, because a
card can't say which ones drop, and past leagues, whose dumps have no corpses, fall back to an estimate. Wombgifts have one line per item level; live prices
use the line with the most listings, and the past-league dumps, which have no listing counts, keep the cheapest. Today
that's the same line, level 75, for all four types. Jewels poe.ninja lists once whatever their variant are editable
estimates when the single price would mislead: Sublime Vision and Impossible Escape take a player's figures. Thread of
Hope keeps the live price, since a player rates its Massive ring near worthless. A unique listed again by links is priced
as its plain copy, unless that is over 10 times its cheapest linked copy: links never make an item worth less, so the
plain price is then a few absurd listings (Allflame's plain Voidforge read 1,730 Divines on 11 listings, its 6-link 60).
Smaller gaps stand, since thin linked lines also sell cheap. A unique whose variant is rolled on the drop is priced as
its busiest variant, the common one: Bubonic Trail with one abyssal socket, Shroud of the Lightless
(`NINJA_NAMES_PRICED_BY_BUSIEST_VARIANT`). Timeless jewels have one poe.ninja line each whatever their seed, so they
are priced as the typical seed.

**Kill rates and removed content.** A farm's choices can override any card field, which is how each uber boss has its own
kills per hour. They're a player's estimates for a dedicated 0 HP miner: 15 for bosses whose invulnerability phases don't
slow it (Eater, Exarch, Fear, Neglect), 10 for Shaper, Elder and Sirus, 7 for Maven, 5 for Dread. `removedInLeague` hides a
card from that league on (Harbinger, from Mirage), and it reappears only when replaying an older league.

**Demand** (`marketDemand`) compares a line's yield per hour with the units its exchange market traded per hour in the
window. Past 25% (the share routes assume), the extra is left out of the "within demand" figure, which you can sort by. Every
other profit figure stays uncapped. Volumes count flippers' resales, so real demand is lower. Lifeforce looks especially inflated: 42
million Vivid an hour in Allflame's week 3. poe.ninja gives no sold volumes, so its lines have no limit.

**League stages.** The exchange API serves any past hour, so a stage is 24 hours fetched on demand: the league's first
hour plus a number of days (`FARM_STAGES`). A running league's first hour is found by searching back weekly and then halving
the gap, and is remembered in the browser. poe.ninja's API has no daily history, so that league's poe.ninja items and
estimates stay at today's value in Divines, and cards say what share of their value that is. Finished leagues
(`PAST_LEAGUES`) get real daily item prices from a dump, and only estimates are carried back. Consoles don't get past
leagues: the dump is PC data.

**What replaying leagues showed.** With the same yields, the shape repeated in both leagues checked: Delve and the fragment
rush rise to a peak around weeks 2 to 4 and collapse by month 3 (Delve 22.8 and 24.7 Divines an hour at week 3 in Mirage and
Allflame, 2.5 and 2.2 at the end). Other farms don't transfer between leagues, and item prices can follow old rules: Vivid
Vulture sold for thousands of Chaos in Mirage for the synthesised implicit reroll, removed in 3.29.

**What it can't show.** Quantities and speed are fixed numbers, and they move most of all. Early on only the fastest players
can run endgame content; later casual players log out while rarity stackers and party farmers stay, and fast builds move to
harder content rather than clearing the same maps faster. No source publishes uber drop rates or beasts per map, so those
are guesses, and a replay tests the prices, not the guesses.

**Snapshots of a running league.** A GitHub Action keeps the prices a dump can't give yet on the `snapshots` branch, with no
secrets and about 7 requests per run. A league's dump replaces its snapshots once published. poe.ninja's docs don't address
storing or republishing live API data, so only the cards' items are kept. GitHub can delay or drop scheduled runs, so
expect gaps.

**Adding a finished league:** download its zip from https://poe.ninja/poe1/data, run `scripts/build_ninja_history.py`, and
add its name, file, first hour and last day to `PAST_LEAGUES`.

## How the Build maker works

The tab has two views. **Our ideas** (the default) shows builds our own generator composes from the game's
mechanics; poe.ninja only reviews them afterwards. **What people play** narrows poe.ninja's real archetypes down by
your answers. The generator is the point of the tab: like the crafting planner, it has every piece and the rules for
combining them, and it hunts for combinations few people play that should work.

### The generator ("Our ideas")

**What it knows** (`scripts/build_mechanics.py` -> `public/data/builds/mechanics-poe1.json`): every current skill and
support gem, ascendancy notable, keystone, tree notable and unique. Where it comes from is in "Where the game data
comes from" below. Each
stat line is read into an *effect* by `scripts/mechanics_vocabulary.py`, a hand-written reading of how the game words
its stats: "Supported Skills deal 39% more Spell Damage" becomes `more damage [spell] 39, from the support`.
The grammar handles subjects (supported skills, minions, totems, enemies), conditions (weapon requirements become
hard requirements; "on low life", "recently", "per charge" become conditions weighed by how often they hold),
and the number patterns (increased, more, added, gem levels, conversion, penetration, exposure, block...). Rules
that aren't numbers (keystones, many ascendancy mechanics, a few build-defining uniques and supports) are written
once each in `scripts/mechanics_statements.py`, with our own estimate of what each is worth and why.
A line the vocabulary can't read fully is left out, never guessed: a stray unknown word may be the line's real scope
("Damage with Movement Skills"), and reading it as global would be worse than not reading it. The build prints how
much it understood (2026-11-11: ascendancy notables 97%, keystones 95%, tree notables 86%, uniques 79%, support lines
70% but the main effect of nearly every support) and writes the rest to `.cache/mechanics-unread.json`.
Auras, heralds, banners and curses word their stats from the outside ("You and nearby allies gain ...", "Buff
grants ...", "Cursed enemies have ..."); the vocabulary rewrites each into the words the same stat has on your own
character, and only those lines are kept for them (a herald's own burning damage or summoned minions aren't
something it gives the main skill). What enemies *deal* is read as damage you take ("Nearby Enemies deal 8% less
Elemental Damage" is 8% less damage taken), what they *take* or *have* as offence.
Local item lines (a weapon's own increased physical damage, an armour's own armour) are dropped: a good rare of the
same kind gives about as much, and what makes a unique worth building around is its other lines.

**Weapon rules** come from the same game files (`ActiveSkills.WeaponRestriction_ItemClassesKeys`): until
2026-11-11 the item classes were looked up by their plural display names ("One Hand Maces") and matched nothing, so
every attack's weapon was guessed from its skill types (a transfigured Kinetic Blast was planned on a bow). Now 181
skills and 14 supports carry their weapons.

**Which support fits which skill** is exact: GGG's game files (read with `pathofexile-dat`, like the exchange item
list) give every skill's types and every support's allowed, added and excluded types, in postfix form (`Spell
Totemable AND`). `typeExpressionMatches` evaluates them as Path of Building does. A support that adds types (Spell
Totem adds SummonsTotem) lets further supports fit (Multiple Totems). A support that fits only a summoner's minions
(Melee Physical Damage on Summon Raging Spirit) applies to the minions. Trigger supports (Cast on Death and the
like) are left out until the generator can model a second skill.

**Scoring a build** (`public/buildgen.js`): an *offence index* (base rate x (1 + increased) x more multipliers x
crit or not, whichever is better x added damage x gem levels x speed x totems x the enemy's resistances after
penetration and exposure), a *defence index* (effective HP, below) and a *clear index* (area, projectiles, chains).
Rare gear is assumed (60% increased damage, 10% speed, for a crit build 100% increased crit and +40 multiplier),
so the first "increased" bonus isn't overvalued; the passive tree is planned for real (below).
Damage can't be compared between a minion, a spell and an attack, so offence is measured as how far the pieces scale
the bare skill. Score = scaling^0.5 x defence^0.5 x clear^0.15 (damage times effective health, as players weigh a
build), times 0.88 when the skill needs an attribute the class doesn't start near. These are indexes for comparing
builds, not DPS.

**Effective HP** (`defenceOf`): the build's pool over the share of a reference hit it takes, divided by the same
for a character with nothing defensive but gear (so 1 is "gear only"). All the numbers are our estimates:
- the hit: 10,000 damage from a pinnacle boss, half physical, 40% elemental, 10% chaos, half of the hits attacks;
  monster accuracy 2,000. poe.ninja's sampled top characters survive a median largest hit of about 13,000 (10%
  under 5,900), so this is a hit a ready build must take;
- the pool: 1,250 life at level ~92, plus rare gear, tried four ways and the best kept: life bases (+700 life and
  3,000 armour, evasion or half of each) or energy shield bases (1,600 ES before increases). The build's own life,
  ES, armour and evasion lines scale these;
- mitigation: armour as the game computes it (armour / (armour + 5 x the physical part), up to 90% with physical
  damage reduction); elemental resistances taken as capped at 75% plus maximum resistance lines (up to 90%), then
  elemental damage reduction; chaos resistance 20% from gear plus its lines; damage taken lines by type;
  endurance charges (3 plus added maximum, 4% physical reduction each) when the build has a way to gain them;
- avoidance at its expected value: the game's evasion formula against attacks, block (a shield's own 25% included,
  up to 75% plus maximum block), spell block, suppression (half the damage of a suppressed spell, more with prevent);
- recovery within a second: regeneration, leech (each 1% leeched recovers about 4% of life a second while hitting,
  up to the 20% cap; not for minion or damage-over-time builds), life on hit at three hits a second, the life flask
  (the data's best, Divine Life Flask: its life over its duration, raised by "increased Life Recovery from Flasks";
  not with Chaos Inoculation or Vaal Pact), energy shield recharge (33.3% of energy shield a second, the game's
  rate, for the share of a fight you go unhit long enough for it to start: 15% at the base delay, more with a faster
  start, up to half; always when recharge can't be interrupted; to life with "recharge applies to life"), and recoup
  (three quarters of it lands in time, and it can at most double the pool);
- utility flasks (wiki `flasks` and `item_buffs` tables): up to four, fewer when unique flasks take slots, picked
  like any piece. Each one's buff counts at its uptime: duration x charges gained a second / charges per use, at most
  always, with 2 charges a second assumed in a fight (our estimate) plus "Flasks gain N Charges every M seconds"
  lines; increased flask duration, flask charges gained and flask effect lines raise it. Minions don't drink them;
- keystones: Chaos Inoculation (life 1, chaos immune), Blood Magic (auras reserve life: 60% of their cost after the
  efficiency the reservation budget assumes), Eldritch Battery and "bypasses Energy Shield" (ES isn't pool), Iron
  Reflexes, Mind over Matter (up to 1,000 mana), Vaal Pact (no regeneration), no helmet (gear pools 15% lower).
Elemental resistance lines add nothing (gear caps them), and overkill leech, mana leech and mana recoup are not
life recovery (fixed in the vocabulary: Slayer's Endless Hunger had read as 20% of all damage leeched, Timeclasp's
mana recoup as life recoup). Flask mods (the prefix and suffix on a magic flask) aren't modelled. The page's "Why" shows the build's effective HP.

**What a ready build looks like** (poe.ninja, the archetypes detailed in Allflame and Mirage, medians over each
one's top characters, nearly all level 100), and what the generator takes from it:

| | 10th percentile | median | 90th percentile |
|---|---|---|---|
| life (life builds) | 3,000 | 4,000 | 7,000-8,000 |
| energy shield (ES and CI builds) | 4,000-7,000 | 9,000 | 16,000-17,000 |
| effective HP (poe.ninja's figure) | 27,000-30,000 | 106,000-127,000 | 226,000-283,000 |
| DPS (poe.ninja's figure, non-minion) | 76,000-220,000 | 3.1-5.3 million | 27-33 million |

- **Life floor.** The lowest life medians among life archetypes are 2,300 to 3,000. A build under 3,000 life (or
  under 5,000 energy shield when it is built on ES) has its effective HP cut by the square of how far short it falls;
  life and ES aren't added for this, since a hybrid of the two is neither. Players' own rule of thumb for pinnacle
  bosses is the same 3,000 life.
- **Spell suppression is capped or skipped.** Of 50 Allflame archetypes with sampled defences, 28 run under 10% and
  13 at 90% or more; nine sit between. Suppression counts at its chance squared: 100% is worth all of it, 50% a
  quarter.
- **Conditional defences.** A defensive line under a condition (a guard skill, "if you haven't been hit recently",
  "while stationary") counts at its uptime and then at half again; players rarely prefer an inconsistent defence over
  a weaker steady one. Conditions that hold for a whole boss fight (per charge, against rare or unique enemies,
  nearby enemies, recently used a skill, fortified, enemy cursed, during a flask) aren't discounted.
- **Attack DPS** is estimated on the sheet (before enemy resistances, as poe.ninja shows it): the endgame weapon
  base with the most physical DPS for the build's weapon type (wiki `weapons` table: Legion Sword, Royal Axe, Gavel,
  Imperial Claw, Sai, Imperial Staff, Citadel Bow, Kinetic Wand), with our estimate of a good rare's local modifiers
  (170% increased physical damage, flat physical about 32 one-handed or 48 on a staff or bow, 20% attack speed, 20%
  quality) and about 30 flat attack damage from other gear, times the skill's effectiveness and attack speed
  multiplier and the offence index's own increases, more multipliers, crit, gem levels, speed and totems. It is shown
  in "Why" and stored as `dps`, but not scored: against poe.ninja's DPS for the same archetypes (Allflame's 14 most
  played hit attack builds) it is about a fourteenth (median ratio 0.07, from 0.01 to 3.8); jewels and cluster jewels
  barely moved it (Cyclone of Tumult Slayer 1.29 to 1.34 million), since they take tree points that went to similar
  nodes and the planner spends them on the score, not on DPS alone. poe.ninja's medians are
  each archetype's top 100 characters by level, far better geared than a good rare, and the estimate leaves out
  jewels, cluster jewels, unique weapons and the multipliers the vocabulary doesn't read; where it comes out
  higher, poe.ninja's figure is a trigger set-up's main skill, not its damage. A floor like players' "1 million DPS
  for pinnacle bosses" would need the estimate to be right within a factor of two first. Spells, minions and damage
  over time get no figure yet.

**Composing** (`planSkill`, `composeForAscendancy`): per skill, for each weapon it could use, five supports are
added greedily (each the one that raises the score most), and shortlists of the uniques and keystones that help it
are made; the best two weapons go on. Then for each of the 21 ascendancies: up to four notables (two for the
Ascendant and Reliquarian, whose borrowed notables are weaker), auras and heralds within 100% of mana reservation
(the wiki's reservation at level 20; our estimate is that endgame reservation efficiency lets a build run that much
and keep mana for its skill) and one curse, up to four uniques from the shortlists, then the supports again with
the rest in place. An aura's lines reach your minions too; a herald's buff is yours alone. A curse counts at 90% of
its value, our estimate for the time a cast curse isn't up (bosses take curses at full effect since 3.20). Curses that are damage skills
of their own (Bane, Hexblast) aren't picked as a curse. Hands and slots are respected (no two-handed weapon with a shield, two
rings, one helmet). A piece that adds under 1.5% isn't kept. `scripts/generate_builds.mjs` runs this for 355 main
skills x 21 ascendancies and keeps each skill's five best ascendancies plus every pairing people play.

**Two scores: power and value.** The *power score* is the original plan: every piece chosen for what it adds,
prices never seen. Fit, ranking and calibration use it. The *value score* comes from a second plan of the same skill
and ascendancy, whose pieces are chosen with prices: the score divided by, per unique, 1 + 0.04 x ln(1 + its price in
Divines). That is our estimate of what players pay for power: a 1-Divine unique has to add about 3%, a 10-Divine one
about 10%, a 100-Divine one about 20%. A unique poe.ninja doesn't list counts as 20 Divines, since hardly anyone sells
it. Each kept build stores its value plan beside it (`value`: its own pieces and tree, its power as `score`, its
`value` and the uniques' `cost`); when it picks the same pieces, the power plan's tree serves both. The page has a
Power plan / Value plan switch; the value plan's cards say how much of the power plan's power they keep.
Prices come from `scripts/fetch_unique_prices.py` -> `.cache/ninja/unique-prices-<league>.json`, a cache, not shipped:
poe.ninja's unique prices for the running league, priced like the Budget question (a unique listed several times is
its unlinked line with the most listings), refreshed once a day. Between leagues poe.ninja's economy can drop a league
its build data still lists (Allflame on 2026-11-11); the prices then come from Standard, and the output says so.
Without the file there is no value plan. poe.ninja's build counts never enter either score.

**The passive tree** (`public/buildtree.js`, data in `tree-poe1.json` from GGG's tree export): from the class's
start node, the planner repeatedly takes the target (a notable, a keystone, or a small node worth having) with the
best score gain per point, counting the small nodes on the path to it, until 110 points are spent (a level ~92
character with every quest point) or nothing left gains at least 0.04% a point. Every node's stat text is read by
the same vocabulary (94% of small-node lines, 86% of notables). Gains come from the generator's own scoring:
effects are grouped by everything but their number, each group's gain per point of value is measured, and measured
again every 10 points; keystones change rules, so each is scored exactly. Keystones therefore come only through the
tree, at their real distance from the class's start: Chaos Inoculation is cheap for a Witch, far for a Marauder.
While ascendancies are compared, one tree per class serves its three ascendancies; each kept build's tree is then
planned again with all its pieces in place (`finalizeTree`), which is also what the page does when a card's "Why"
is opened, so both agree. **Masteries** are targets too: a mastery costs one point once a notable of its cluster
is taken, so the planner weighs the path to the nearest unlocking notable plus the mastery's best option (each
option once per tree, as the game allows), and scores options exactly like keystones, skipping those that can't
change the score. Before a step is taken, its real gain is measured once; if it's far below the estimate, the
estimates are stale and are all measured again (lazy greedy). A keystone changes how everything after it is worth
(Elemental Overload turns a crit build into a non-crit one), so for the trees it keeps the generator also plans
once without each keystone the tree took and keeps the better tree. **Jewels** are planned with the tree. Every socket the planner can reach is a
target worth what goes in it, scored exactly: the build's rare jewel (the three jewel modifiers from the wiki's
`mods` table, domain 10, that raise this build's score most, at most two prefixes and two suffixes, at their middle
roll: our estimate of a good rare jewel), or, in one of the six outer sockets, a large cluster jewel. A large cluster's
types, small passives and which notables each type can roll come from GGG's game files (`PassiveTreeExpansionSkills`
and the spawn weights of the `AfflictionNotable` mods; the notables' stat text from the wiki's `passive_skills`); one
gives its small passive on four small passives and its type's three best notables for the build, for 8 points inside
it (our estimates), and a build runs at most two. The card lists each socket's jewel; a jewel can't hold two modifiers that change the same stat.

**The tree view** (`public/buildtreeview.js`): opening a card's "Why these pieces" draws the whole passive tree as
SVG with the build's nodes, links, chosen masteries and jewel sockets lit (rare jewels green, large clusters purple),
like poe.ninja's or a tree planner's view. Positions come from GGG's tree export: `scripts/build_sources.py` works
each node out from its group's centre, its orbit's radius and its slot (orbits of 16 and 40 slots use the game's
uneven angles), and links between nodes on the same orbit of a group are drawn as arcs. Drag to move, wheel or the
buttons to zoom, "Fit build" and "Whole tree" to reset; hovering a node shows its name and what it does, a socket its
jewel and a mastery the chosen option. The zoom of each card is kept while the page redraws. Ascendancy nodes aren't
drawn (the card lists them). Medium and small cluster jewels
inside a large one, abyss jewels and timeless jewels aren't planned.

**The review.** Each build is then looked up in poe.ninja's per-ascendancy skill counts (every count down to one
character, from the searches the archetype data already makes): **nobody** (maybe our reasoning missed something,
maybe a find), **a handful** (1-9), **a working niche** (10-200: what the view hunts for), established (201-1000),
meta. Ideas are ranked by *fit*, how much better the ascendancy suits the skill than that skill's typical
ascendancy, blended with the build's own score.

**Calibration.** `generate_builds.mjs` checks the generator against players: for each skill with 100+ players, is
the ascendancy most of them pick among the generator's three best for that skill? On 2026-11-11, with the planned
tree and auras and curses, on the power score: 58 of 137 (42%; 59 before auras and curses, the one lost to the
existing lean towards Slayer and Berserker that auras' added offence deepens; with a fixed tree allowance it was 37%;
picking at random would get 14%). Ranked by the value plan instead it would be 59. The value plan costs the median
build 2.6% of its power (a tenth of builds 14% or more, mostly by dropping Skin of the Lords and The Utmost, which
poe.ninja doesn't list); the uniques' median cost falls from about 20 Divines to 0.1. `npm run
test:builds` fails if this falls under 25%. A full run takes about an hour, most of it planning trees. Known
gaps, the next work: jewels, flasks, trigger set-ups, reservation efficiency and auras that act on enemies (Pride)
aren't modelled; defensive
ascendancies (Juggernaut, Gladiator) are undervalued against Slayer.

### Where the game data comes from

Public sources only, so anyone with this repository can rebuild it (`npm run builds:build`), gathered by
`scripts/build_sources.py`:

| What | Source | How it's read |
|---|---|---|
| Keystones, notables, ascendancy notables, bloodlines, and which class each ascendancy belongs to | GGG's [passive tree export](https://github.com/grindinggear/skilltree-export), published for tool makers | Downloaded once a week into `.cache/skilltree/`. It is the authority on what is on the tree now: the wiki and the game files also keep removed and league-only nodes |
| Gems: tags, attribute and level requirements, stat text, cast time, effectiveness and crit at level 20 | poewiki.net's Cargo tables `items`, `skill_gems`, `skill`, `skill_levels` | `scripts/poewiki.py`: pages of 500 rows a second apart, cached a week in `.cache/poewiki/`, backing off on 429. The wiki keeps a skill's level-independent values on a "level 0" row, used when level 20 has none |
| Uniques: category, base, requirements, implicit and explicit stat text | poewiki.net's `items` table | The version that still drops stands for the item; legacy versions are dropped |
| Keystones granted by timeless jewels | poewiki.net's `passive_skills` table | Only listed in `game-poe1.json`, so poe.ninja's keystone shares can be named; the generator doesn't pick them, since they need a specific jewel |
| Skill types and support rules | GGG's game files via `pathofexile-dat` (`ActiveSkills`, `GrantedEffects`, `ActiveSkillType`, `ItemClasses`) | Exported into `.cache/dat/poe1-skills/` once per patch. Also fill in gem tags the wiki lacks |

Requests carry a generic client name, nothing about who runs the script. `--refresh` on `build_game_data.py` or
`build_mechanics.py` asks again before a week is up.

### What people play (poe.ninja's archetypes)

**Archetypes** are poe.ninja's own pairing of an ascendancy and a main skill. `scripts/fetch_build_meta.py` asks
poe.ninja's search once per ascendancy, which counts that ascendancy's characters by main skill: every archetype
with 20 or more characters and its population. Auras and Vaal skills (cast beside the plain skill) don't count as
main skills. It then asks once per archetype for the 120 most played (80 in a past league): those answers aggregate
every matching character (the uniques worn, keystones, support gems, auras, bloodlines, as shares) and give columns
for the top 100 characters by level (life, energy shield, EHP, DPS, the damage split and whether the damage is a hit
or over time). Searches don't return armour, evasion, suppression or block; `fetch_build_meta.py 120 5` opens 5
characters per archetype for those, but that costs a request each and poe.ninja rate limits it (HTTP 429), so it is
off by default. On a 429 the requests wait as long as poe.ninja asks (30, 90, 240 s), then stop sampling;
`--cached` rebuilds from what is already in the disk cache without asking poe.ninja anything. Medians come from the
highest-level characters, so they describe finished builds.

**Reading the answers.** The search answer is protobuf. Its dimension values are indexes into name lists in
poe.ninja's "NDIC" format (`builds/dictionary/<hash>`): a header with the entry count at byte 12, the block count
at 28 and the size of the lengths at 32, an 8-byte table entry per block, each name's length as a varint, then the
names (worked out from the files, 2026-11-10; `parse_dictionary` raises if the lengths stop adding up). The
per-skill `mode` column is 0 for hits (Winter Orb) and 2 for damage over time (Righteous Fire).

**Which leagues.** The running softcore trade league, plus each past one poe.ninja still lists whose address is its
name. Exilecon qualifiers are SSF events and are left out. Ancestors is left out too: it used Phrecia's
ascendancies, and poe.ninja answers a filter on an ascendancy nobody had with the whole league. An archetype played
in a past league with 20+ characters is marked **Proven** and ranks a quarter higher.

**Traits** (`public/builds.js`): damage types are those with 25%+ of the DPS, else the skill's tags; hit or DoT is the
majority of the measured mode, else a guess from the skill's description and a short list; the pool is energy
shield from 70% of life + ES, life under 30%, hybrid between; a defence layer counts from a median of 20,000
armour or evasion, 90% suppression or 50% block. Delivery (spell, melee, bow, totem, mine, trap, brand, minion,
trigger) comes from the skill's tags, with minions told apart by name and description because Absolution carries the
Minion tag.

**Budget.** The browser prices the uniques on poe.ninja through the same proxy as the Farming tab, and an
archetype's cost is each unique's price times the share of its players wearing it: a build half its players run
with Mageblood costs half a Mageblood. A unique listed several times is priced as its unlinked line with the most
listings, so uniques whose mods set the price (Watcher's Eye) read as their common roll and the cost undercounts
builds that need a specific one. Under 5 Divines is cheap, 5 to 30 medium, more is expensive.

**The questions** narrow the archetypes in order: class, ascendancy, damage type, hit or DoT, playstyle, life or
energy shield, defence layer, budget. Any can be skipped or changed from the chain; an option that would leave
nothing stays visible but disabled, and changing an early answer drops later ones that no longer fit. The chain is
kept in the link (`?b=class:Witch,ascendancy:Elementalist`) and in the browser.

**The spin wheel** holds up to 12 archetypes that fit the answers so far, outside the 20 most played, with 40+
characters, top characters at a median level of 95+ and 40,000+ EHP: niche but proven playable. With none left it
falls back to every remaining archetype and says so.

In the ideas view the wheel spins over a dozen of the best ideas that fit the answers and the player bands shown.

Planned next: advice rules in our own words with sources, leveling suggestions, and links to the Farming cards a
build suits.

## Gold fee

The fee comes from the game file `CurrencyExchange.GoldPurchaseFee`: a fixed gold amount per unit **received**.

| Item | PoE1 | PoE2 |
|---|---|---|
| Chaos Orb | 15 | 160 |
| Exalted Orb | 20 | 120 |
| Divine Orb | 250 | 800 |
| Mirror of Kalandra | 25,000 | 25,000 |
| Rogue's Marker, Dead Man's Sulphur | 1 per 1,000 | – |
| Lifeforce | 1 per 8 | – |

The unnamed column 6 of that table flips the fee to "1 gold per N". That matches poedb's `1/1000`.
Gold is the only friction on flips. It is what makes a doubled price on Orbs of Alteration not quite free money.

## What the data shows (Allflame, 24 h to 2026-10-09 22:00 UTC)

- **The Chaos/Divine gap is real and persistent.** Many items are systematically dearer in their Divine
  market than in their Chaos market, and the gap holds in 23–24 of 24 hours. Orb of Alteration trades at
  about 10 per Chaos but about 1,780 per Divine (0.10c vs 0.20c, +87%, 32k/h on the thinner side).
  Valdo's Puzzle Box (+24%), Simulacrum (+37%), Fracturing Orb (+16%) and Horned Scarab of Bloodlines (+15%)
  show the same pattern. Cause: people who hold Divines and want bulk pay a premium for convenience. The
  flip is to buy with Chaos, sell for Divine, and convert back. The cost is gold, roughly 60–300 gold per
  Chaos of profit.
- **In-pair spreads.** Liquid markets often trade over a range of about 5–50% within the same hour
  (Valdo's Box vs Divine: 0.5–1.0). Posting at both ends is the market-maker play the Maxroll flipping guide describes.
- **Transfers through dead markets.** In four hours, about 3,100 Divines (around 1.1M Chaos) were paid for
  35 Blighted Delirium Orbs worth about 11c each. 40,000 Stacked Decks went for 600 Orbs of Chance. Stock
  was zero or near zero on both sides, so the orders matched the instant they were placed. This is how
  wealth is moved between accounts (RMT delivery, mules) without a trade window. The Odd trades tab flags
  these as "Instant".
- **Fat-finger and bait fills.** In a thin market someone will sell 14 cards worth 28c each for 1 Chaos.
  The integer-ratio UI makes "1 : 14" and "14 : 1" one misclick apart.
- Single-trade extremes are noise. The day's lowest and highest Divine ratios were 40 and 900 Exalted on
  PoE2. That's why the site uses the **median of hourly averages** everywhere and shows hourly-average ranges.

## Caveats

- This is history, not a live order book. Everything is at least an hour old.
- "Profit / h" assumes you take all the volume of the thinner market. Treat it as a ceiling.
- Spreads use per-hour min and max ratios, which can come from tiny trades.

## Other tools seen

- [timeolord/poe-arbitrage](https://github.com/timeolord/poe-arbitrage): Rust cycle scanner over the same
  API, with an hourly GitHub Actions run and a static page. It models gold fees from poedb.
- [Misyuk-T/poe2-currency-flip-tracker](https://github.com/Misyuk-T/poe2-currency-flip-tracker):
  Vercel cron plus Supabase, hourly ingestion, entry and exit ranges.
- [metaseonso/wraeclast-index#85](https://github.com/metaseonso/wraeclast-index/issues/85): an archive of
  full PoE2 history (15.8k hours, 1.1 GB gzipped).
- poe.ninja: its PoE2 currency pages are built on this exchange data. Its economy endpoints are documented at
  https://poe.ninja/docs/api (public but with no stability promise), and past leagues are published as data dumps. The same
  page calls the builds endpoints internal and not available for third-party use, and `scripts/fetch_ninja_targets.py` uses them.
- [Maxroll: Flipping with the Currency Exchange](https://maxroll.gg/poe2/resources/flipping-with-the-currency-exchange):
  in-pair and Exalted to Divine flipping, as players actually do it.
