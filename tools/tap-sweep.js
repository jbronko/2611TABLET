#!/usr/bin/env node
// Tap every button on every screen of an app, the way a person would, and report taps that throw
// an error, can't be reached (covered or off-screen), or visibly do nothing.
//
//   node tools/tap-sweep.js <app-folder>|launcher [--portrait] [--depth 4] [--max 600] [--workers 4]
//
// It serves the repo like tools/check-pwa.js, opens the app in headless Chromium at tablet size,
// lists the buttons a person could tap on the current screen (ignoring anything behind an open
// sheet or overlay), and taps each one. A tap that opens a new screen or sheet is explored in turn,
// up to --depth taps deep. Every tap starts from a fresh page with empty storage and replays the
// taps that lead to it, so taps never affect each other. Random numbers are seeded, so replays
// repeat exactly. Exits 1 if any tap throws, can't be reached, or does nothing (unless it's in
// ALLOW below, which lists reviewed taps that legitimately change nothing a test can see).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const app = args[0];
if (!app) { console.error('Usage: node tools/tap-sweep.js <app-folder>|launcher [--portrait] [--depth 4] [--max 600] [--workers 4]'); process.exit(1); }
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i > 0 ? Number(args[i + 1]) : def; };
const PORTRAIT = args.includes('--portrait'), DEPTH = opt('depth', 4), MAX = opt('max', 600), WORKERS = opt('workers', 4);
const ROOT = path.resolve(__dirname, '..');
const BASE = '/2611TABLET/';
const launcher = app === 'launcher';
if (!launcher && !fs.existsSync(path.join(ROOT, app, 'index.html'))) { console.error(`${app}/index.html not found.`); process.exit(1); }
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

// Reviewed taps that change nothing a test can see. { app: [[pattern for "label [selector]", why]] }
const ALLOW = {
  'merit-order': [['#share-go', 'opens Android\'s share sheet; headless Chromium has none and its clipboard waits for permission']],
  'tablet-tasks': [['^Add \\[', 'adding an empty task does nothing, on purpose']],
  'tide-digger': [['#wave', 'sends a wave across the canvas, which the sweep doesn\'t read']],
};

// Prepared starting points beyond a fresh page, so the sweep reaches deeper screens.
const SEEDS = {
  'merit-order': {
    // a company with one of every plant, a few days in, paused
    company: async p => {
      await p.evaluate(() => MeritOrder.startCareer(true, 'standard'));
      await p.waitForTimeout(150);
      await p.evaluate(() => {
        const M = MeritOrder, S = M.state; S.cash = 2e8; M.Sim.skipTour(S);   // no mission messages mid-sweep
        for (const t of ['wind', 'ccgt', 'hydro']) S.unlocked[t] = true;
        for (const [t, mw] of [['solar', 50], ['wind', 60], ['battery', 25], ['peaker', 50], ['ccgt', 200], ['hydro', 250]]) M.Sim.build(S, t, mw);
        for (let k = 0; k < 4 * 288; k++) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); }
        M.setSpeed(0); M.renderAll();
      });
      await p.keyboard.press('Escape');
    },
    // the Energy Transition at the start of year 3: a yearly report with an underwriting round
    transition: async p => {
      await p.click('#t-scenarios'); await p.click('[data-scenario="energy-transition"]'); await p.click('#sc-go');
      await p.waitForTimeout(150);
      await p.evaluate(() => {
        const M = MeritOrder, S = M.state; S.cash = 2e8; M.setSpeed(0);
        M.Sim.build(S, 'solar', 100); M.Sim.build(S, 'battery', 50);
        while (S.t < 120 * 288 + 2) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); }
        M.renderAll();
      });
    },
  },
};

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
  fs.createReadStream(file).pipe(res);
});

// Runs in the page: seeded random numbers, and helpers to list taps and fingerprint the screen.
const PAGE_HELPERS = () => {
  let seed = 20261109;
  Math.random = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const TAPPABLE = 'button, a[href], [role=button], input[type=checkbox], input[type=radio], select, summary, label[for]';
  const unique = sel => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  const selectorOf = el => {
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const tag = el.tagName.toLowerCase();
    for (const a of el.attributes) {
      if (!a.name.startsWith('data-')) continue;
      const s = `${tag}[${a.name}="${a.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
      if (unique(s)) return s;
    }
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (e !== el && e.id && unique('#' + CSS.escape(e.id))) { parts.unshift('#' + CSS.escape(e.id)); break; }
      const t = e.tagName.toLowerCase(), sibs = [...e.parentElement.children].filter(c => c.tagName === e.tagName);
      parts.unshift(sibs.length > 1 ? `${t}:nth-of-type(${sibs.indexOf(e) + 1})` : t);
    }
    return (parts[0].startsWith('#') ? '' : 'body > ') + parts.join(' > ');
  };
  const labelOf = el => (el.getAttribute('aria-label') || el.innerText || el.title || el.value || '').trim().split('\n')[0].slice(0, 50) || el.tagName.toLowerCase();
  const shown = el => {
    if (el.closest('[hidden], [inert]')) return false;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none' && +cs.opacity > 0.05;
  };
  // What a finger can hit: a checkbox or radio inside a label can be tapped anywhere on the label.
  const hitArea = el => (el.matches('input') && el.closest('label')) || el;
  // Text a tap could change: the open sheet's (or the page's), plus messages like toasts.
  const screenText = layer => (layer || document.body).innerText + '\n--\n' + [...document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role=status], [role=alert], .toast')]
    .filter(e => !e.closest('[hidden]') && e.getBoundingClientRect().height > 0).map(e => e.innerText).join('\n');
  // The open sheet or overlay on top, if any: a fixed layer over most of the screen.
  const topLayer = () => {
    const centre = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    if (!centre) return null;
    const layers = [...document.querySelectorAll('body *')].filter(e => {
      const cs = getComputedStyle(e);
      if (cs.position !== 'fixed' || !(+cs.zIndex > 0) || cs.pointerEvents === 'none' || e.tagName === 'CANVAS' || !shown(e)) return false;
      const r = e.getBoundingClientRect();
      return r.width * r.height >= 0.6 * innerWidth * innerHeight;
    }).sort((a, b) => +getComputedStyle(b).zIndex - +getComputedStyle(a).zIndex);
    return layers.find(l => l.contains(centre)) || null;
  };
  window.__sweep = {
    list() {
      const layer = topLayer(), out = [];
      for (const el of document.querySelectorAll(TAPPABLE)) {
        if (!shown(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        if (layer && !layer.contains(el)) continue;
        const r = hitArea(el).getBoundingClientRect();
        const on = el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-selected') === 'true' || (el.type === 'radio' && el.checked);
        out.push({ sel: selectorOf(el), label: labelOf(el), w: Math.round(r.width), h: Math.round(r.height), on,
          state: [el.getAttribute('aria-pressed'), el.getAttribute('aria-checked'), el.getAttribute('aria-expanded'), el.checked, el.tagName === 'SELECT' ? el.value : ''].join('|') });
      }
      return out;
    },
    sig() {
      const store = {};
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); store[k] = localStorage.getItem(k); }
      const taps = this.list();
      return { loc: location.href, store: JSON.stringify(store), taps: taps.map(t => t.sel + '~' + t.label).join('\n'),
        states: taps.map(t => t.sel + '~' + t.state).join('\n'), text: screenText(topLayer()) };
    },
    // Is this tap covered by something that isn't part of the open layer? Returns what covers it.
    cover(sel) {
      const el = document.querySelector(sel); if (!el) return 'gone';
      const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return 'off-screen';
      const hit = document.elementFromPoint(x, y);
      if (!hit || el.contains(hit) || hit.contains(el)) return null;
      return selectorOf(hit) + ' "' + labelOf(hit) + '"';
    },
  };
};

const url = `${BASE}${launcher ? '' : app + '/'}`;
const findings = { error: new Map(), blocked: new Map(), noEffect: new Map(), unreachable: new Map(), small: new Map() };
const allowed = (label, sel) => (ALLOW[app] || []).some(([re]) => new RegExp(re).test(`${label} [${sel}]`));
let taps = 0, statesSeen = 0;

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch();
  const viewport = PORTRAIT ? { width: 800, height: 1280 } : { width: 1280, height: 800 };

  // Tap like a finger: at the centre of the element, after scrolling it into view. (Playwright's own
  // click waits for the page to be idle, which never happens in an app that animates every frame.)
  async function tapAt(page, sel) {
    const pt = await page.evaluate(sel => {
      const el = document.querySelector(sel); if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, sel);
    if (!pt) throw new Error(`${sel} is not on the page`);
    await page.mouse.click(pt.x, pt.y);
  }
  // Open a fresh page with empty storage, run a seed, and replay a path of taps.
  async function open(seed, steps) {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('dialog', d => d.accept().catch(() => {}));
    ctx.on('page', p => p.close().catch(() => {}));
    await page.addInitScript(PAGE_HELPERS);
    await page.goto(origin + url); await page.waitForTimeout(400);
    if (seed) await SEEDS[app][seed](page);
    await page.waitForTimeout(250);
    for (const s of steps) {
      await tapAt(page, s.sel);
      await page.waitForTimeout(350);
    }
    return { ctx, page, errors };
  }
  const where = (seed, steps, t) => [seed ? `[${seed}]` : '', ...steps.map(s => `"${s.label}"`), `"${t.label}"`].filter(Boolean).join(' › ');
  const note = (kind, key, text) => { if (!findings[kind].has(key)) findings[kind].set(key, text); };

  // One tap: replay to the state, fingerprint, tap, fingerprint. Returns the new taps it revealed.
  async function tapOnce(job) {
    const { seed, steps, t } = job;
    let s;
    try { s = await open(seed, steps); } catch (e) { note('unreachable', seed + t.sel, `${where(seed, steps, t)}: couldn't replay the taps that lead here (${e.message.split('\n')[0]})`); return null; }
    const { ctx, page, errors } = s;
    try {
      const sig1 = await page.evaluate(() => __sweep.sig());
      await page.waitForTimeout(350);
      const sig2 = await page.evaluate(() => __sweep.sig());
      const cover = await page.evaluate(sel => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); return __sweep.cover(sel); }, t.sel);
      if (cover) { note('blocked', t.sel + cover, `${where(seed, steps, t)} [${t.sel}]: ${cover === 'off-screen' ? 'off the screen' : `covered by ${cover}`}`); return null; }
      const before = errors.length;
      try { await tapAt(page, t.sel); } catch (e) { note('blocked', t.sel, `${where(seed, steps, t)} [${t.sel}]: ${e.message.split('\n')[0]}`); return null; }
      taps++;
      await page.waitForTimeout(500);
      const errs = errors.slice(before);
      if (errs.length) note('error', t.sel + errs[0], `${where(seed, steps, t)} [${t.sel}]: ${errs[0]}`);
      let sig3;
      try { sig3 = await page.evaluate(() => __sweep.sig()); } catch { return null; }   // it navigated away
      const changed = k => sig3[k] !== sig2[k] && sig1[k] === sig2[k];   // a part that was steady before the tap
      const effect = sig3.loc !== sig2.loc || changed('store') || changed('taps') || changed('states') || changed('text')
        || (sig1.text !== sig2.text && (sig3.taps !== sig2.taps));
      // tapping an option that's already chosen rightly changes nothing
      if (!effect && !t.on && !allowed(t.label, t.sel)) note('noEffect', t.sel + t.label, `${where(seed, steps, t)} [${t.sel}]`);
      if (sig3.loc !== sig2.loc) return null;   // another page: not explored
      const was = new Set(sig2.taps.split('\n'));
      return (await page.evaluate(() => __sweep.list())).filter(x => !was.has(x.sel + '~' + x.label));
    } finally { await ctx.close(); }
  }

  // Breadth-first over states. A state is a seed plus the taps that reach it.
  const seen = new Set(), tapped = new Set();
  let level = [];
  for (const seed of [null, ...Object.keys(SEEDS[app] || {})]) {
    let s;
    try { s = await open(seed, []); } catch (e) { console.log(`Seed ${seed} failed: ${e.message}`); continue; }
    const list = await s.page.evaluate(() => __sweep.list());
    await s.ctx.close();
    statesSeen++;
    level.push(...list.map(t => ({ seed, steps: [], t })));
  }
  for (let depth = 0; depth < DEPTH && level.length && taps < MAX; depth++) {
    const jobs = level.filter(j => { const k = `${j.seed}|${j.t.sel}|${j.t.label}`; if (tapped.has(k)) return false; tapped.add(k); return true; });
    for (const j of jobs) if (j.t.w < 44 || j.t.h < 44) findings.small.set(j.t.sel + j.t.label, `"${j.t.label}" ${j.t.w}×${j.t.h} [${j.t.sel}]`);
    const next = [];
    let i = 0;
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      while (i < jobs.length && taps < MAX) {
        const j = jobs[i++];
        const found = await tapOnce(j).catch(e => { note('unreachable', j.t.sel, `${where(j.seed, j.steps, j.t)}: ${e.message.split('\n')[0]}`); return null; });
        if (!found || !found.length) continue;
        const key = `${j.seed}|` + found.map(x => x.sel + '~' + x.label).sort().join(',');
        if (seen.has(key)) continue;
        seen.add(key); statesSeen++;
        const steps = [...j.steps, { sel: j.t.sel, label: j.t.label }];
        next.push(...found.map(t => ({ seed: j.seed, steps, t })));
      }
    }));
    level = next;
  }
  await browser.close(); server.close();

  const name = launcher ? 'Launcher' : app;
  console.log(`${name} (${PORTRAIT ? 'portrait' : 'landscape'}): ${taps} taps across ${statesSeen} screens, up to ${DEPTH} taps deep${taps >= MAX ? ' (stopped at --max)' : ''}`);
  const section = (kind, title) => {
    const m = findings[kind]; if (!m.size) return;
    console.log(`\n${title} (${m.size})`);
    for (const v of m.values()) console.log(`  ${v}`);
  };
  section('error', 'ERRORS');
  section('blocked', 'CAN\'T BE TAPPED');
  section('noEffect', 'NO VISIBLE EFFECT');
  section('unreachable', 'COULD NOT REPLAY');
  section('small', 'SMALL TARGETS (under 44 px; CLAUDE.md asks for 48)');
  const bad = findings.error.size + findings.blocked.size + findings.noEffect.size;
  console.log(bad ? `\n${bad} problem(s) to look at.` : '\nNo errors, unreachable buttons or dead taps.');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
