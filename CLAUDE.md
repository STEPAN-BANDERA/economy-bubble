# Notes for AI assistants

- Follow the "Code style (required)" section in README.md for all code: explicit `if`/`for` blocks with braces,
  full descriptive names, small named functions. Verbose is preferred over compact.
- Planner refactors must give identical results; README.md explains how to check that.
- Scripts must run on Linux, macOS and Windows (README's "Windows" section). In Python, read and write text only
  through `scripts/text_files.py` (`read_utf8`, `write_utf8`, `use_utf8_console()` in `__main__`), never bare
  `open()`/`read_text()`/`write_text()`. npm scripts start Python as `node scripts/run_python.mjs <script.py>`, not
  `python3`. In Node, pass `import()` a `pathToFileURL(...).href`, not a path. Build paths with `pathlib`/`path.join`,
  not `/` string concatenation, and run npm `.bin` tools through their `.cmd` wrapper on Windows.
- Commit, push or deploy only when asked, each time.
- Farming cards: when poe.ninja lists an item many times by variant, one price must stand for them, so check for that before adding a
  `ninja:` line (README's "Items with many prices"). The user plays these farms: record their figures as a player's report, not a measurement.
  Content that leaves the game gets `removedInLeague`, not deletion.
- Farming cards (`public/farming.js`): yields are estimates, so label new ones honestly with `roughNumbers` when no measured
  sample backs them. Adding a `ninja:` line means rerunning `scripts/build_ninja_history.py` for each league in
  `PAST_LEAGUES`. `public/data/ninja-history/` is cc-by-sa, not MIT. README's "How the Farming tab prices things" explains the rest.
- Build maker (`public/builds.js`, `public/buildmaker.js`, the generator in `public/buildgen.js`, `public/buildideas.js`,
  the tree planner `public/buildtree.js` and its view `public/buildtreeview.js`):
  run `npm run test:builds` after changes. Rebuild its data (`npm run builds:build`, public sources only) when a
  league starts. Advice rules and guide content go in our own words with a source link; never copy guide text.
  `public/data/builds/` is CC BY-NC-SA, not MIT, and holds aggregates only, never player or account names.
  Its game data comes only from public sources anyone can reach (GGG's tree export and game files, poewiki.net,
  via `scripts/build_sources.py`); never read a private repository or local-only files, so every clone can rebuild.
- Build generator: two separate scores. The power score is the original, price-blind plan; poe.ninja's build data
  (player counts, archetypes) only reviews it and is never an input to it. The value score is a second plan whose
  pieces are chosen with poe.ninja's item prices (`scripts/fetch_unique_prices.py`); prices never reach the power
  score, and calibration is measured on the power score. Stat lines are read by
  `scripts/mechanics_vocabulary.py`; a line it can't read fully stays unread, never guessed (an unknown word may be
  the line's scope). Rules that aren't numbers go in `scripts/mechanics_statements.py`, each with a comment saying
  why its value is what it is. When a misreading is fixed, add the line to `scripts/test_mechanics.py`. After a
  model change, rerun `node scripts/generate_builds.mjs` and compare its calibration line (favourite ascendancy in
  the top 3) with README's figure: a change that lowers it needs a reason. Don't hammer poe.ninja: character
  sampling is off by default because it triggers HTTP 429; use `fetch_build_meta.py --cached` to rebuild offline.
- After any change to the crafting engine (`public/craft.js`, `public/craft-worker.js`) run
  `npm run test:craft`: two fixed wands at frozen prices must cost the same as the baseline
  (`scripts/craft-regression/`). A plan that got dearer is a regression; one that got cheaper must be
  checked (a dropped failure case also looks cheaper) before `npm run test:craft -- --update`.
  The pre-commit hook in `.githooks/` runs it too (enable per clone: `git config core.hooksPath .githooks`).
