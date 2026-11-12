#!/usr/bin/env node
// Runs a Python script with whichever Python 3 this machine has, so the npm scripts work on Linux,
// macOS and Windows alike:
//
//     node scripts/run_python.mjs scripts/fetch_craft_data.py [arguments...]
//
// Linux and macOS install Python 3 as `python3`. Windows installs from python.org have no `python3`:
// they have the `py` launcher (`py -3` picks the newest Python 3) and `python`. The first command that
// answers to `--version` with a Python 3 is used. Set PYTHON (for example PYTHON=python3.12) to choose one.
import { spawnSync } from "node:child_process";

const isWindows = process.platform === "win32";

function candidateCommands() {
  const candidates = [];
  if (process.env.PYTHON) {
    candidates.push({ command: process.env.PYTHON, prefixArguments: [] });
  }
  if (isWindows) {
    candidates.push({ command: "py", prefixArguments: ["-3"] });
    candidates.push({ command: "python", prefixArguments: [] });
    candidates.push({ command: "python3", prefixArguments: [] });
  } else {
    candidates.push({ command: "python3", prefixArguments: [] });
    candidates.push({ command: "python", prefixArguments: [] });
  }
  return candidates;
}

// `python` can be Python 2 on old Linux systems, and on Windows a bare `python` may be the
// Microsoft Store stub that prints an advert instead of a version, so the version is checked.
function isPython3(candidate) {
  const versionCheck = spawnSync(candidate.command, [...candidate.prefixArguments, "--version"], { encoding: "utf8" });
  if (versionCheck.error || versionCheck.status !== 0) {
    return false;
  }
  const versionText = `${versionCheck.stdout}${versionCheck.stderr}`;
  return /^Python 3\./m.test(versionText);
}

function findPython3() {
  for (const candidate of candidateCommands()) {
    if (isPython3(candidate)) {
      return candidate;
    }
  }
  return null;
}

function main() {
  const scriptArguments = process.argv.slice(2);
  if (scriptArguments.length === 0) {
    console.error("usage: node scripts/run_python.mjs <script.py> [arguments...]");
    process.exit(2);
  }
  const python = findPython3();
  if (python === null) {
    console.error("No Python 3 found (tried python3, python and, on Windows, py -3). Install Python 3 or set PYTHON.");
    process.exit(1);
  }
  const run = spawnSync(python.command, [...python.prefixArguments, ...scriptArguments], { stdio: "inherit" });
  if (run.error) {
    console.error(run.error.message);
    process.exit(1);
  }
  if (run.status === null) {
    console.error(`Python stopped by signal ${run.signal}`);
    process.exit(1);
  }
  process.exit(run.status);
}

main();
