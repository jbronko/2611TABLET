# 2611tablet

Small apps built with Claude Code from an Android tablet. Each one is an installable web app
(a **Progressive Web App**, hosted on **GitHub Pages**): it gets a home-screen icon, opens full
screen and works offline. No app store, no APK, no build step.

**All apps:** https://jbronko.github.io/2611TABLET/

| App | What it is |
| --- | --- |
| [Tide Pool](https://jbronko.github.io/2611TABLET/tide-pool/) | A 12-level channel puzzle: lay channels so the tide fills every rock pool. |
| [Tide Digger](https://jbronko.github.io/2611TABLET/tide-digger/) | Dig channels in the sand with your finger; real-feeling water and sand physics carry the tide into rock pools. 8 beaches plus a sandbox. |
| [Merit Order](https://jbronko.github.io/2611TABLET/merit-order/) | An electricity market tycoon: build plants, bid into a 5-minute NEM-style market, earn from frequency control, sell contracts, upgrade plants and keep trading while you're away. Real NEM price limits, ten-band bid stacks with rebids, custom-sized plants on sites with loss factors, Raise and Lower frequency control, three difficulty levels, a guided first week, six scenarios with stars, and challenges to share with friends. |
| [Tablet Tasks](https://jbronko.github.io/2611TABLET/tablet-tasks/) | A small, touch-friendly to-do list. |

## Install an app on Android

1. Open the app's link in Chrome on the tablet (or tap **Open** on the launcher page).
2. Tap the ⋮ menu, then **Install app** (on some versions, **Add to Home screen**, then **Install**).
3. Launch it from the home screen. After the first launch it works without internet.

Updates download in the background and appear the next time you open the app.

## Add a new app

Ask Claude Code for one ("make me a new app called …"); `CLAUDE.md` has the full recipe. By hand:

```sh
node tools/new-app.js word-garden "Word Garden" --color "#4f7a3a" --description "A daily word game."
# build the app in word-garden/index.html, draw word-garden/icon.svg, then:
node tools/make-icons.js word-garden
node tools/check-pwa.js word-garden   # installable + offline + no errors
```

Commit and push; once the change is merged into `main`, the new app appears on the launcher page.

## Hosting (one-time setup)

GitHub Pages serves the `main` branch. On GitHub: **Settings → Pages → Source: Deploy from a branch**,
branch **main**, folder **/ (root)**, Save. `.nojekyll` at the root makes Pages serve every file as-is.

To run locally: `python3 -m http.server 8000` and open http://localhost:8000.

## Tide Pool rules

- Drag a channel from the tray onto the sand, or tap it in the tray and then tap a square.
- Tap a placed channel to turn it. Drag it to another square to move it, or off the board to put it back.
- Pieces with a dot are pinned. Rocks block the way. Pools take water from any channel that opens into them.
- Stars: 3 for filling every pool on the first tide, 2 within three tides, 1 after that.

Levels are drawn as solved shores in the `LEVELS` array in `tide-pool/index.html` using box-drawing
characters (`│ ─ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`), `O` for pools, `#` for rocks and `.` for sand. Every non-pinned
channel goes into the tray. In the browser console, `TidePool.validate()` checks each level is solvable.
