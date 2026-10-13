# Notes for AI assistants

- Follow the "Code style (required)" section in README.md for all code: explicit `if`/`for` blocks with braces,
  full descriptive names, small named functions. Verbose is preferred over compact.
- Planner refactors must give identical results; README.md explains how to check that.
- Commit, push or deploy only when asked, each time.
- After any change to the crafting engine (`public/craft.js`, `public/craft-worker.js`) run
  `npm run test:craft`: two fixed wands at frozen prices must cost the same as the baseline
  (`scripts/craft-regression/`). A plan that got dearer is a regression; one that got cheaper must be
  checked (a dropped failure case also looks cheaper) before `npm run test:craft -- --update`.
  The pre-commit hook in `.githooks/` runs it too (enable per clone: `git config core.hooksPath .githooks`).
