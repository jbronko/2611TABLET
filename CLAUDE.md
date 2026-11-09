# 2611tablet: installable tablet apps

Every app in this repo is a **Progressive Web App (PWA) hosted on GitHub Pages**: a single static
`index.html` plus a manifest, icons and a service worker. The owner builds them with Claude Code from an
Android tablet and installs them from Chrome ("Install app"). No build step, no frameworks, no servers.

- Site: https://jbronko.github.io/2611TABLET/ (launcher page listing every app, from `apps.json`)
- Each app: https://jbronko.github.io/2611TABLET/<slug>/

## Layout

```
index.html          launcher page (reads apps.json; don't hand-edit the app list into it)
apps.json           list of apps: { slug, name, description }
_template/          starting point for new apps (placeholders like __APP_NAME__)
tools/new-app.js    copy the template into <slug>/, fill placeholders, make icons, add to apps.json
tools/make-icons.js render <slug>/icon.svg into <slug>/icons/*.png
tools/check-pwa.js  verify an app: manifest, service worker, installable, works offline, no errors
<slug>/             one folder per app: index.html, manifest.webmanifest, sw.js, icon.svg, icons/
```

## Making a new app

1. `node tools/new-app.js <slug> "<App Name>" --color "#hex" --description "One sentence."`
   (slug: lowercase-with-hyphens).
2. Build the app inside `<slug>/index.html`. Keep the template's head block, theme tokens (light on
   `:root`, dark in the two dark blocks), safe-area gutters, `[hidden]` rule and service-worker
   registration. Keep it one file: inline CSS and JS. Exception: a game engine with no DOM code may
   live in a second file (as `merit-order/sim.js` does) so it can be tested directly in Node; list it
   in the app's `sw.js` PRECACHE. Make it touch-first (targets ≥ 48px, pointer
   events for drag) and work in landscape and portrait.
3. Redraw `<slug>/icon.svg` for the app: full-bleed 512×512, important parts inside the middle circle
   (radius 205). Then `node tools/make-icons.js <slug>`.
4. Test the app's own behaviour in Playwright (Chromium is preinstalled; `require('playwright')`),
   then `node tools/check-pwa.js <slug>` must print "All checks passed".
5. Commit and push. GitHub Pages deploys from `main`, so the app goes live once the commit is on
   `main` (merge the working branch into `main`, or open a pull request for the owner to merge).

## Rules that keep apps working

- **Storage keys must be unique per app.** All apps share one origin (jbronko.github.io), so
  `localStorage` is shared. Use the slug as the key or prefix.
- **Service worker cache names are per app** (`<slug>-v<N>`) and an app only deletes its own old
  caches. If you add files that must work offline, list them in that app's `sw.js` PRECACHE and bump
  `VERSION`. Updates reach installed apps on the next launch after the user opens it online.
- **Use relative paths** (`icons/icon-192.png`, `sw.js`), never `/...`: the site lives under `/2611TABLET/`.
- **External resources:** only Google Fonts is cached for offline use; always give fonts a system
  fallback. Don't depend on other CDNs: installed apps must work offline.
- `.nojekyll` must stay at the root so GitHub Pages serves every file as-is.
- Tablet Tasks (`tablet-tasks/`) keeps its key `tablet-tasks`; Tide Pool uses `tide-pool-progress`.

## Merit Order tests

Merit Order (`merit-order/`) has its own checks in `merit-order/test/` (not precached, not needed offline):

- `node merit-order/test/engine.js` and `node merit-order/test/ui.js` must both pass before pushing
  changes to Merit Order (`ui.js --shots <folder>` also saves screenshots).
- After changing prices, costs or rules, run `node merit-order/test/balance.js` and compare with the
  targets in its header comment.
- Bump `VERSION` in `merit-order/sw.js` with every published change, so `index.html` and `sim.js`
  always update together, and set the same number in the title screen's `#t-version` line in
  `merit-order/index.html` (`ui.js` checks they match).

## Optional: also publish to claude.ai

A private claude.ai artifact is handy for a quick link, but it can't be installed. Build the artifact
copy from `<slug>/index.html` by dropping the doctype/html/head/body wrappers and the charset and
viewport metas (keep `<title>`, links and `<style>`).
