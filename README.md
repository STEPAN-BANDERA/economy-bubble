# Faustus Ledger

A free, browser-only dashboard for Path of Exile's Currency Exchange (PoE 1 and PoE 2, PC and consoles),
built on GGG's public hourly exchange history.

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

All the maths runs in the browser. The only server-side piece is a tiny Cloudflare Pages Function that
proxies the API, because the API sends no CORS headers. It fits the free plan.

```
git clone https://github.com/STEPAN-BANDERA/economy-bubble.git && cd economy-bubble
npm install
npm run items:build   # game files -> public/data/items-{poe1,poe2}.json (names, categories, gold fees, icons)
npm run craft:build   # Craft of Exile mod data + poe.ninja build items (main and Ruthless) -> public/data/craft/
npm run dev           # local server at http://localhost:8788
npm run deploy        # Cloudflare Pages
```

Re-run `items:build` after each game patch to pick up new items and fee changes.

## Layout

- `public/index.html`, `style.css`: the page. No build step.
- `public/app.js`: the interface: tabs, tables, detail panel, calculator, live updates and alerts.
- `public/model.js`: the analysis as pure functions (prices, flips, spreads, odd trades, recipes, ratio maths). It runs in Node too.
- `public/recipes.js`: fixed-ratio recipes, generated from the exchange's item names.
- `public/formulas.js`: the formula texts, tunable parameters, and Lab calculators.
- `public/craft.js`: the crafting engine: mod pools, one-currency rolls (the workbench), exact odds and the planner. Runs in Node too.
- `public/crafting.js`: the Crafting tabs (main and Ruthless).
- `public/data/craft/`: generated by `scripts/fetch_craft_data.py` (one file of mods per base type, plus an
  index) and `scripts/fetch_ninja_targets.py` (items from popular builds, mods matched to tiers; `--ruthless` writes the
  Ruthless league's to `targets-poe1-ruthless.json`). Not in git,
  because it is derived from Craft of Exile's data; `npm run craft:build` makes it before you deploy.
- `public/data/items-*.json`: generated. Maps `Metadata/Items/...` ids to name, category, gold fee and icon.
- `functions/api/cx/[[path]].js`: the proxy. `/api/cx/<hour>` or `/api/cx/<poe2|xbox|sony>/<hour>`.
  Complete hours are cached for a year. A 404 (hour not out yet) is cached for 60 s. A body that was
  cut off is never cached.
- `scripts/fetch_exchange_items.py`: reads the game's `CurrencyExchange`, `CurrencyExchangeCategories`
  and `BaseItemTypes` tables with [`pathofexile-dat`](https://www.npmjs.com/package/pathofexile-dat), and icons from the trade site's static data.
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

## Disclaimer, privacy and license

- A free fan project, not affiliated with or endorsed by Grinding Gear Games. Path of Exile, its item names,
  icons and game data belong to Grinding Gear Games.
- No ads, no accounts, no cookies, no analytics. The site collects nothing about visitors. Settings and stars
  live in the visitor's own browser storage. Item icons load directly from GGG's image server
  (`web.poecdn.com`, with no referrer sent). The Cinzel font is served from this site, not a font CDN.
- Crafting mod weights come from [Craft of Exile](https://www.craftofexile.com/)'s public data files (some weights
  measured by the Prohibited Library community), and build items from [poe.ninja](https://poe.ninja/builds).
  Neither is affiliated with this project. The derived files are generated locally and not committed.
- Numbers are estimates from past trades, not financial advice.
- The code is MIT licensed (see `LICENSE`). Cinzel is SIL OFL 1.1 (`public/fonts/Cinzel-OFL.txt`). The images
  in `public/img/wiki/` are copies from the PoE Wiki (CC BY-NC-SA 3.0, artwork © Grinding Gear Games) and are
  not covered by the MIT license.
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
| Harvest lifeforce costs | [Maxroll](https://maxroll.gg/poe/) 3.24 Harvest guide | Numbers only |
| Fee format, Mirage essences, Dominance rules | [poedb](https://poedb.tw/) | Facts only |
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
  veiled prefix nearly free next to two +1 gem prefixes), metamod lock + Scour; Farric Wolf/Lynx Alpha swaps;
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
each size (1 to 4) by each measure is on top. Besides the cheapest fossil plan there are two more:
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
- poe.ninja: its PoE2 currency pages are built on this exchange data. The endpoints are undocumented.
- [Maxroll: Flipping with the Currency Exchange](https://maxroll.gg/poe2/resources/flipping-with-the-currency-exchange):
  in-pair and Exalted to Divine flipping, as players actually do it.
