# Notes for AI assistants

- Follow the "Code style (required)" section in README.md for all code: explicit `if`/`for` blocks with braces,
  full descriptive names, small named functions. Verbose is preferred over compact.
- Planner refactors must give identical results; README.md explains how to check that.
- Commit, push or deploy only when asked, each time.
- Farming cards (`public/farming.js`): yields are estimates, so label new ones honestly with `roughNumbers` when no measured
  sample backs them. Adding a `ninja:` line means rerunning `scripts/build_ninja_history.py` for each league in
  `PAST_LEAGUES`. `public/data/ninja-history/` is cc-by-sa, not MIT. README's "How the Farming tab prices things" explains the rest.
- After any change to the crafting engine (`public/craft.js`, `public/craft-worker.js`) run
  `npm run test:craft`: two fixed wands at frozen prices must cost the same as the baseline
  (`scripts/craft-regression/`). A plan that got dearer is a regression; one that got cheaper must be
  checked (a dropped failure case also looks cheaper) before `npm run test:craft -- --update`.
  The pre-commit hook in `.githooks/` runs it too (enable per clone: `git config core.hooksPath .githooks`).
