# Snapshots of poe.ninja item prices

Written by `.github/workflows/ninja-snapshots.yml` on the main branch: prices of the items the
[Faustus Ledger](https://github.com/STEPAN-BANDERA/economy-bubble) Farming tab prices from poe.ninja, for the running league.
They let the tab show a running league's real item prices at earlier stages. poe.ninja has no daily history for
a running league, and its [data dumps](https://poe.ninja/poe1/data) only appear after a league ends.

- One file per snapshot: `snapshots/<league>/<YYYY-MM-DDTHH>.json` (UTC).
- Every six hours for the first two weeks after the league's first snapshot, then daily. Scheduled runs can be delayed or
  dropped, so expect gaps.
- Values are Chaos Orbs per item, as listed on poe.ninja at that time. Listings aren't sales.
- A league's snapshots are removed once its dump is published.

The prices come from [poe.ninja](https://poe.ninja/economy). This project isn't affiliated with poe.ninja or Grinding Gear
Games, and this data isn't covered by the main branch's MIT license.
