# 2611tablet

Small browser projects built with Claude Code from an Android tablet. Each one is a single HTML file
with no build step and no dependencies.

## Run

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000 (Tablet Tasks) or http://localhost:8000/tide-pool/ (Tide Pool).

## Tide Pool (`tide-pool/index.html`)

A touch puzzle game. The sea runs along the top of the shore; lay channels across the sand so that
when the tide comes in, water reaches every rock pool.

- Drag a channel from the tray onto the sand, or tap it in the tray and then tap a square.
- Tap a placed channel to turn it. Drag it to another square to move it, or off the board to put it back.
- Pieces with a dot are pinned: they can't be moved or turned. Rocks block the way.
- Tap **Let the tide in** to test your layout. Pools take water from any channel that opens into them.
- Stars: 3 for filling every pool on the first tide, 2 within three tides, 1 after that.

### Install on an Android tablet

Tide Pool is an installable web app: it gets a home-screen icon, opens full screen and plays offline.
It's hosted with GitHub Pages at **https://jbronko.github.io/2611TABLET/tide-pool/**.

1. Open that address in Chrome on the tablet.
2. Tap the ⋮ menu, then **Install app** (on some versions, **Add to Home screen**, then **Install**).
3. Launch Tide Pool from the home screen or app drawer. After the first launch it works without internet.

Updates are picked up in the background and appear the next time you open the app.

To turn hosting on (one time): on GitHub, open the repo's **Settings → Pages**, set **Source** to
**Deploy from a branch**, pick the branch that has these files and the **/ (root)** folder, and save.

There are 12 levels, from 5×5 to 7×7. Progress is saved in the browser's `localStorage`.

Levels are drawn as solved shores in the `LEVELS` array using box-drawing characters (`│ ─ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼`),
`O` for pools, `#` for rocks and `.` for sand. Every non-pinned channel goes into the tray. In the
browser console, `TidePool.validate()` checks that each level's drawn solution fills all its pools.

## Tablet Tasks (`index.html`)

A small, touch-friendly to-do list. Tasks are saved in the browser's `localStorage`.
