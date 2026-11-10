#!/usr/bin/env node
// Browser checks for Storm the Shore in headless Chromium (Playwright): steering by drag, a level
// played in real time to the result sheet, wins, losses, upgrades, pause and saves, with no page
// errors, in landscape and portrait. Also: the CC0 assets load with no 404s, the Credits sheet, and
// the game still plays with every asset request blocked (and with reduced motion).
//   node storm-the-shore/test/ui.js [--shots <folder>]   (--shots also stages the big moments:
//   a gate shattering, a barrel explosion throwing bodies, the boss going down, a MEGA WIN)
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = '/2611TABLET/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ogg': 'audio/ogg' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (!url.startsWith(BASE)) { res.writeHead(404).end(); return; }
  let file = path.join(ROOT, url.slice(BASE.length));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
const shotsAt = process.argv.indexOf('--shots');
const SHOTS = shotsAt > 0 ? path.resolve(process.argv[shotsAt + 1] || 'shots') : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.log('FAIL', msg); } };

// Step a level in the page (with its effects) until an event of `kind` happens, then let the effects
// play for `ms` of real time. save: changes to a fresh save first (a stronger squad).
async function stage(page, num, kind, ms, up = {}) {
  const got = await page.evaluate(([num, kind, up]) => {
    const M = StormShore, g = M.G;
    Object.assign(g.save.up, up); M.startLevel(num);
    const s = g.run;
    for (let i = 0; i < 60 * 300 && s.phase !== 'won' && s.phase !== 'lost'; i++) {
      s.targetX = M.S.autopilot(s, 'good'); M.S.step(s, 1 / 60);
      const seen = s.events.some(e => e.kind === kind);
      g.view.z = s.z; g.view.x = s.x;
      M.handleEvents();
      if (seen) return true;
    }
    return false;
  }, [num, kind, up]);
  await page.waitForTimeout(ms);
  return got;
}
async function stageScenes(page, shot) {
  if (await stage(page, 1, 'gate', 140)) await shot('scene-gate-shatter');
  for (let n = 5; n <= 12; n++) if (await stage(page, n, 'boom', 260)) { await shot('scene-explosion'); break; }
  if (await stage(page, 3, 'bossdown', 380, { squad: 10, guns: 10 })) await shot('scene-boss-down');
  if (await stage(page, 1, 'won', 420, { squad: 10 })) {
    await shot('scene-mega-stamp');
    await page.waitForFunction(() => StormShore.G.mode === 'over', null, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await shot('scene-mega-result');
  }
  await page.evaluate(() => { const g = StormShore.G; g.save.up = { squad: 0, guns: 0, armour: 0, coins: 0 }; });
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${server.address().port}${BASE}storm-the-shore/`;
  const browser = await chromium.launch();
  for (const [name, viewport] of [['landscape', { width: 1280, height: 800 }], ['portrait', { width: 800, height: 1280 }]]) {
    const ctx = await browser.newContext({ viewport, hasTouch: true });
    const page = await ctx.newPage();
    const errors = [], missing = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', r => { if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`); });
    const shot = async what => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-${what}.png`) }); };
    const visible = sel => page.isVisible(sel);
    const text = sel => page.textContent(sel);
    const mode = () => page.evaluate(() => StormShore.G.mode);

    await page.goto(url); await page.waitForTimeout(300);
    ok(await visible('#title') && !(await visible('#hud')), `${name}: opens on the title screen`);
    ok((await text('#t-play')).includes('level 1'), `${name}: a new player starts at level 1`);
    ok(await page.isDisabled('#t-next'), `${name}: later levels are locked`);
    // the bundled sprites and sounds all load, and the progress line says so
    await page.waitForFunction(() => StormShore.A.done, null, { timeout: 10000 });
    const assets = await page.evaluate(() => ({ loaded: StormShore.A.loaded, total: StormShore.A.total, line: document.getElementById('t-load').textContent }));
    ok(assets.loaded === assets.total && missing.length === 0, `${name}: all ${assets.total} assets load with no 404s (${assets.loaded} loaded; ${missing.join(', ')})`);
    ok(assets.line.startsWith('Effects loaded'), `${name}: the title says the effects are ready ("${assets.line}")`);
    await shot('title');
    // credits
    await page.click('#t-credits'); await page.waitForTimeout(100);
    ok(await visible('#credits') && (await text('#credits')).includes('CC0') && (await text('#credits')).includes('Kenney'), `${name}: Credits opens and lists the CC0 packs`);
    await shot('credits');
    await page.click('#c-done'); await page.waitForTimeout(100);
    ok(await visible('#title') && !(await visible('#credits')), `${name}: Close returns to the title`);

    // play: the HUD shows and the squad runs
    await page.click('#t-play'); await page.waitForTimeout(400);
    ok(await mode() === 'play' && await visible('#hud') && !(await visible('#title')), `${name}: Play starts the level`);
    const z1 = await page.evaluate(() => StormShore.G.run.z);
    ok(z1 > 2, `${name}: the squad runs up the beach (${z1.toFixed(1)})`);
    await page.waitForFunction(() => StormShore.Snd.loaded === 14, null, { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(() => StormShore.Snd.loaded) === 14, `${name}: the sound samples decode once a tap unlocks audio (${await page.evaluate(() => StormShore.Snd.loaded)} of 14)`);

    // steer by dragging across the screen (a finger, then a mouse)
    const cx = viewport.width / 2, cy = viewport.height * 0.7;
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + viewport.width * 0.2, cy, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(300);
    const r1 = await page.evaluate(() => ({ t: StormShore.G.run.targetX, x: StormShore.G.run.x }));
    ok(r1.t > 0.3 && r1.x > 0.2, `${name}: dragging right steers right (${r1.t.toFixed(2)}, ${r1.x.toFixed(2)})`);
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx - viewport.width * 0.4, cy, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(400);
    const r2 = await page.evaluate(() => ({ t: StormShore.G.run.targetX, x: StormShore.G.run.x }));
    ok(r2.t < -0.3 && r2.x < 0, `${name}: dragging left steers left (${r2.t.toFixed(2)}, ${r2.x.toFixed(2)})`);
    await shot('play');

    // the sound switch, saved for next time
    ok(await page.getAttribute('#sound', 'aria-pressed') === 'true', `${name}: sound starts on`);
    await page.click('#sound'); await page.waitForTimeout(50);
    ok(await page.getAttribute('#sound', 'aria-pressed') === 'false' && await page.evaluate(() => localStorage.getItem('storm-the-shore-sound')) === 'off', `${name}: the sound button mutes, and remembers`);
    await page.click('#sound');
    ok(await page.evaluate(() => localStorage.getItem('storm-the-shore-sound')) === 'on', `${name}: and unmutes`);

    // pause and resume
    await page.click('#pause'); await page.waitForTimeout(200);
    const zp = await page.evaluate(() => StormShore.G.run.z);
    await page.waitForTimeout(400);
    ok(await visible('#paused') && await page.evaluate(() => StormShore.G.run.z) === zp, `${name}: Pause stops the squad`);
    await page.click('#p-resume'); await page.waitForTimeout(300);
    ok(await mode() === 'play' && await page.evaluate(() => StormShore.G.run.z) > zp, `${name}: Resume carries on`);
    // restart from the pause menu
    await page.click('#pause'); await page.click('#p-restart'); await page.waitForTimeout(100);
    ok(await mode() === 'play' && await page.evaluate(() => StormShore.G.run.z) < 5, `${name}: Restart starts the level again`);

    // play level 1 in real time, steering toward the better gates, until the result sheet shows by itself
    await page.evaluate(() => { window.__pilot = setInterval(() => { const s = StormShore.G.run; if (s && StormShore.G.mode === 'play') s.targetX = StormShore.S.autopilot(s, 'good'); }, 30); });
    // watch the fighting: enemies shot before they reach us, and a weapon from a barrel
    await page.evaluate(() => { window.__seen = { shotAtRange: false, aimed: false };
      window.__watch = setInterval(() => { const s = StormShore.G.run; if (!s) return;
        if (s.aim) __seen.aimed = true;
        if (s.objs.some(o => o.type === 'enemy' && o.awake && !o.hit && o.rem < o.n)) __seen.shotAtRange = true; }, 20); });
    await page.waitForFunction(() => StormShore.G.run.phase === 'climb' || StormShore.G.mode === 'over', null, { timeout: 60000 });
    await shot('bunker');
    await page.waitForFunction(() => StormShore.G.mode === 'over', null, { timeout: 15000 });
    await page.evaluate(() => clearInterval(window.__pilot));
    const seen = await page.evaluate(() => { clearInterval(window.__watch); return window.__seen; });
    ok(seen.aimed, `${name}: the squad fires`);
    ok(seen.shotAtRange, `${name}: charging enemies are shot down before they arrive`);
    ok(await page.evaluate(() => StormShore.G.best) >= 10, `${name}: kill streaks build up (best ×${await page.evaluate(() => StormShore.G.best)})`);
    ok(+(await text('#r-kills')) > 20 && (await text('#r-streak')).startsWith('×'), `${name}: the result shows kills and best streak`);
    ok(await page.evaluate(() => StormShore.G.run.weapon) >= 1 && (await text('#hud-weapon')) !== 'Rifle', `${name}: a barrel gives a new weapon (${await text('#hud-weapon')})`);
    ok(await visible('#result') && (await text('#r-title')) === 'Bunker taken!', `${name}: level 1 played through to a win`);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('storm-the-shore')));
    ok(saved && saved.level === 2 && saved.coins > 0, `${name}: the win is saved (level ${saved && saved.level}, ${saved && saved.coins} coins)`);
    ok((await text('#r-go')).includes('level 2'), `${name}: Next goes to level 2`);
    await shot('won');

    // upgrades from the result sheet
    await page.click('#r-upgrades'); await page.waitForTimeout(150);
    ok(await visible('#upgrades'), `${name}: Upgrades opens`);
    await shot('upgrades');
    const before = await page.evaluate(() => StormShore.G.save.coins);
    const buy = await page.$('button[data-up="squad"]:not([disabled])');
    ok(!!buy, `${name}: the first upgrade is affordable after a win`);
    if (buy) {
      await buy.click(); await page.waitForTimeout(100);
      const after = await page.evaluate(() => ({ c: StormShore.G.save.coins, u: StormShore.G.save.up.squad }));
      ok(after.u === 1 && after.c < before && (await text('#u-coins')) === String(after.c), `${name}: buying an upgrade spends coins`);
    }
    await page.click('#u-done'); await page.waitForTimeout(100);
    ok(await visible('#result'), `${name}: Done returns to the result`);

    // next level, then lose it on purpose
    await page.click('#r-go'); await page.waitForTimeout(200);
    ok(await page.evaluate(() => StormShore.G.run.num) === 2 && await page.evaluate(() => StormShore.G.run.n) === 3, `${name}: level 2 starts with the bigger landing party`);
    await page.evaluate(() => StormShore.finishNow('bad')); await page.waitForTimeout(100);
    ok((await text('#r-title')) === 'Squad lost' && (await text('#r-go')) === 'Try again' && !(await visible('#r-retry')), `${name}: losing offers Try again`);
    await shot('lost');
    await page.click('#r-go'); await page.waitForTimeout(100);
    ok(await page.evaluate(() => StormShore.G.run.num) === 2, `${name}: Try again replays the same level`);
    await page.click('#pause'); await page.click('#p-menu'); await page.waitForTimeout(150);
    ok(await visible('#title') && (await text('#t-play')).includes('level 2'), `${name}: Menu returns to the title at level 2`);

    // a boss level: the boss bar shows when he comes
    await page.evaluate(() => {
      StormShore.startLevel(3);
      const s = StormShore.G.run, b = s.objs[s.objs.length - 1];
      for (let i = 0; i < 60 * 120 && !b.awake && s.phase !== 'lost'; i++) { s.targetX = StormShore.S.autopilot(s, 'good'); StormShore.S.step(s, 1 / 60); s.events.length = 0; }
    });
    await page.waitForTimeout(200);
    ok(await visible('#bossbar') && (await text('#boss-text')).startsWith('BOSS'), `${name}: the boss bar shows on level 3`);
    await shot('boss');
    await page.click('#pause'); await page.click('#p-menu'); await page.waitForTimeout(100);
    ok(!(await visible('#bossbar')), `${name}: and goes away with the level`);

    // the save survives a reload, and level 1 can be replayed
    await page.reload(); await page.waitForTimeout(300);
    ok((await text('#t-play')).includes('level 2') && +(await text('#t-coins')) > 0, `${name}: progress survives a reload`);
    await page.click('#t-prev');
    ok((await text('#t-play')).includes('Replay level 1'), `${name}: an earlier level can be replayed`);

    // a broken save doesn't break the game
    await page.evaluate(() => localStorage.setItem('storm-the-shore', '{not json'));
    await page.reload(); await page.waitForTimeout(300);
    ok((await text('#t-play')).includes('level 1'), `${name}: a broken save starts fresh`);

    if (SHOTS) await stageScenes(page, shot);
    ok(errors.length === 0, `${name}: no page errors (${errors.join(' | ')})`);
    await ctx.close();
  }

  // Installed and offline: the service worker serves every asset from its cache.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload(); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => StormShore.A.done, null, { timeout: 10000 });
    const a = await page.evaluate(() => ({ loaded: StormShore.A.loaded, total: StormShore.A.total }));
    ok(a.loaded === a.total, `offline: the service worker serves all ${a.total} assets (${a.loaded} loaded)`);
    await ctx.close();
  }

  // Every asset request blocked (and the Google font), with reduced motion: the game still plays.
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true, reducedMotion: 'reduce' });
    await ctx.route(/\/assets\/|fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(url);
    await page.waitForFunction(() => StormShore.A.done, null, { timeout: 10000 });
    const a = await page.evaluate(() => ({ failed: StormShore.A.failed, total: StormShore.A.total, line: document.getElementById('t-load').textContent }));
    ok(a.failed === a.total && a.line.includes("didn't load"), `blocked: the title says the built-in effects stand in ("${a.line}")`);
    await page.click('#t-play');
    await page.evaluate(() => { window.__pilot = setInterval(() => { const s = StormShore.G.run; if (s && StormShore.G.mode === 'play') s.targetX = StormShore.S.autopilot(s, 'good'); }, 30); });
    await page.waitForFunction(() => StormShore.G.run.weapon >= 1 || StormShore.G.mode === 'over', null, { timeout: 30000 });
    const mid = await page.evaluate(() => ({ z: StormShore.G.run.z, kills: StormShore.G.run.kills, slow: StormShore.G.slow, parts: StormShore.G.parts.length }));
    ok(mid.z > 50 && mid.kills > 0, `blocked: level 1 plays with the drawn effects (z ${mid.z.toFixed(0)}, ${mid.kills} kills, ${mid.parts} particles)`);
    ok(mid.slow === 0, 'reduced motion: a new weapon brings no slow-mo');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'blocked-play.png') });
    await page.waitForFunction(() => StormShore.G.mode === 'over', null, { timeout: 60000 });
    ok((await page.textContent('#r-title')) === 'Bunker taken!', 'blocked: and is won');
    ok(errors.length === 0, `blocked: no page errors (${errors.join(' | ')})`);
    await ctx.close();
  }
  await browser.close(); server.close();
  console.log(fails ? `\n${fails} failed, ${passes} passed.` : `All ${passes} UI checks passed.`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
