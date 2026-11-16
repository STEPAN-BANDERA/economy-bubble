# Licence of the Build maker data

This folder's files are not under the repository's MIT licence.

- `game-poe1.json` holds skill gems and unique items from [poewiki.net](https://www.poewiki.net/)'s data tables,
  and ascendancies, notables, keystones and bloodlines from Grinding Gear Games' passive tree export. Wiki content is
  licensed under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/), so this file is too: credit
  poewiki.net, no commercial use, and share changes under the same licence. Built by `scripts/build_game_data.py`.
- `mechanics-poe1.json` holds every gem's, notable's and unique's effects as read by this project's own vocabulary
  from the same sources, plus skill types and support rules from Grinding Gear Games' game files. Being derived
  from the wiki's text, it is CC BY-NC-SA 3.0 too. Built by `scripts/build_mechanics.py`.
- `tree-poe1.json` is Grinding Gear Games' passive tree (nodes, links, class starts) from their public tree export,
  with each node's effects as read by this project's vocabulary. The tree is GGG's.
- `generated-poe1.json` is our generator's builds (`scripts/generate_builds.mjs`), made from `mechanics-poe1.json`
  and so under the same licence, with poe.ninja player counts beside them.
- `icons-poe1.json` says where each piece's picture is on Grinding Gear Games' image server (web.poecdn.com):
  passive icons' places on the sprite sheets of their tree export, and item art paths from their game files. It
  holds no images; the paths and pictures are GGG's. Built by `scripts/build_icons.py`.
- `meta-poe1-*.json` and `leagues-poe1.json` are aggregates (counts, shares and medians, no player or account names)
  of [poe.ninja](https://poe.ninja/)'s public builds data, built by `scripts/fetch_build_meta.py`. Credit poe.ninja
  when you reuse them.

Path of Exile and its content are trademarks and copyright of Grinding Gear Games.
