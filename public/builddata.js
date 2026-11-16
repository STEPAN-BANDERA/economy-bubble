// The Build maker's data files (public/data/builds/, built by npm run builds:build), for the
// Build maker (buildmaker.js), its ideas and planner (buildideas.js) and its worker
// (build-worker.js). The rare-gear affixes come from the Crafting area: craftdata.js.
const DATA = 'data/builds/';

export async function fetchBuildFile(name) {
  const response = await fetch(DATA + name);
  if (!response.ok) {
    throw new Error(name + ' answered ' + response.status);
  }
  return response.json();
}
