#!/usr/bin/env node
// Check that an app is installable and works offline, the way GitHub Pages will serve it.
//
//   node tools/check-pwa.js <app-folder>
//
// Serves the repo at http://localhost:<port>/2611TABLET/ (matching
// https://jbronko.github.io/2611TABLET/), then in headless Chromium checks that the manifest
// parses, the service worker takes control, Chrome reports no installability problems, the page
// reloads with the network off, "Check for updates" finds a new version and restarts into it, and
// nothing logs an error. Exits 1 if any check fails.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const app = process.argv[2];
if (!app) { console.error('Usage: node tools/check-pwa.js <app-folder>'); process.exit(1); }
const ROOT = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(ROOT, app, 'index.html'))) { console.error(`${app}/index.html not found.`); process.exit(1); }

const BASE = '/2611TABLET/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.ogg': 'audio/ogg' };

let newerSw = false;   // when true, sw.js is served changed, as if a new version had been published
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(BASE)) { res.writeHead(404).end(); return; }
  let file = path.join(ROOT, url.slice(BASE.length));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!url.endsWith('/')) { res.writeHead(301, { Location: url + '/' }).end(); return; }
    file = path.join(file, 'index.html');
  }
  if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  if (newerSw && path.basename(file) === 'sw.js') { res.end(fs.readFileSync(file, 'utf8') + '\n// a newer version\n'); return; }
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${server.address().port}${BASE}${app}/`;
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok, detail });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()} (${m.location().url || 'page'})`); });

  try {
    await page.goto(url);
    const cdp = await ctx.newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    check('Manifest found and parses', !!manifest.url && manifest.errors.length === 0,
      manifest.url ? manifest.errors.map(e => e.message).join('; ') : 'no <link rel="manifest">');

    const swReady = await page.evaluate(() => Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise(r => setTimeout(() => r(false), 8000)),
    ]));
    await page.reload();
    const controlled = swReady && await page.evaluate(() => !!navigator.serviceWorker.controller);
    check('Service worker controls the page', controlled);

    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    check('Chrome can install it', installabilityErrors.length === 0, installabilityErrors.map(e => e.errorId).join(', '));

    const icons = await page.evaluate(async () => {
      const m = await (await fetch(document.querySelector('link[rel=manifest]').href)).json();
      const base = new URL(document.querySelector('link[rel=manifest]').href);
      return Promise.all((m.icons || []).map(async i => [i.src, (await fetch(new URL(i.src, base))).status]));
    });
    const missing = icons.filter(([, s]) => s !== 200).map(([src]) => src);
    check('All manifest icons load', icons.length > 0 && missing.length === 0, missing.join(', '));

    // Updates: nothing new at first; then a new version is published, found, and restarted into.
    const first = await page.evaluate(() => window.appUpdates && window.appUpdates.check());
    newerSw = true;
    await page.evaluate(() => window.appUpdates.check());
    const offered = await page.waitForSelector('#app-update-go:not([hidden])', { timeout: 10000 }).then(() => true, () => false);
    if (offered) await Promise.all([page.waitForNavigation(), page.click('#app-update-go')]);
    const after = offered && await page.evaluate(() => !!navigator.serviceWorker.controller && document.getElementById('app-update').hidden);
    check('"Check for updates" finds a new version and restarts into it', first === 'latest' && offered && after,
      first !== 'latest' ? `first check said ${first}` : !offered ? 'no Restart offered' : !after ? 'not back in control after the restart' : '');

    await ctx.setOffline(true);
    const before = errors.length;
    await page.reload();
    const title = await page.title();
    check('Loads with the network off', !!title, title ? `title "${title}"` : 'blank page');
    // Third-party fonts may be missing offline on a first visit; the page falls back to system fonts.
    const offlineErrors = errors.slice(before).filter(e => !/fonts\.(googleapis|gstatic)\.com/.test(e) && !/503 \(Offline\)/.test(e));
    errors.splice(before, errors.length - before, ...offlineErrors);
    await ctx.setOffline(false);

    // Two elements with one id: $('x') finds only the first, so the other's button silently does nothing.
    const dupIds = await page.evaluate(() => { const n = {}; document.querySelectorAll('[id]').forEach(e => { n[e.id] = (n[e.id] || 0) + 1; }); return Object.keys(n).filter(k => n[k] > 1); });
    check('No duplicate element ids', dupIds.length === 0, dupIds.join(', '));
    check('No errors in the console', errors.length === 0, errors.join(' | '));
  } catch (err) {
    check('Checks ran to completion', false, err.message);
  } finally {
    await browser.close();
    server.close();
  }

  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const failed = results.filter(r => !r.ok).length;
  console.log(failed ? `\n${failed} check(s) failed for ${app}.` : `\nAll checks passed for ${app}.`);
  process.exit(failed ? 1 : 0);
})();
