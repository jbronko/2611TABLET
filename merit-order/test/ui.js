#!/usr/bin/env node
// Browser checks for Merit Order in headless Chromium (Playwright): every screen and flow a player
// uses, with no page errors. Serves the repo the way GitHub Pages does. Run before pushing:
//
//   node merit-order/test/ui.js            (add --shots <folder> to save screenshots)
//
// Exits 1 if any check fails.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const BASE = '/2611TABLET/';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };
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
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; };

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const URL = `http://localhost:${server.address().port}${BASE}merit-order/`;
  const browser = await chromium.launch();
  const errs = [];
  const page = async (opts = { viewport: { width: 1280, height: 800 } }) => {
    const ctx = await browser.newContext(opts);
    const p = await ctx.newPage();
    p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
    await p.goto(URL); await p.waitForTimeout(500);
    return p;
  };
  const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const state = (p, fn, arg) => p.evaluate(fn, arg);
  const newCompany = async (p, diff = 'relaxed') => {
    await p.evaluate(() => localStorage.removeItem('merit-order')); await p.reload(); await p.waitForTimeout(500);
    await p.click('#t-continue'); await p.click(`[data-diff="${diff}"]`); await p.click('#diff-go'); await p.waitForTimeout(200);
    await p.click('#welcome-ok');
  };
  const run = (p, days) => p.evaluate(d => { const M = MeritOrder, S = M.state; for (let k = 0; k < d * 288; k++) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); } M.renderAll(); M.drawMerit(); }, days);

  // 1. A new company: difficulty, building, the plant sheet, the price forecast.
  {
    const p = await page();
    const swVersion = fs.readFileSync(path.join(ROOT, 'merit-order', 'sw.js'), 'utf8').match(/const VERSION = (\d+);/)[1];
    check('the title screen shows the version from sw.js', (await p.textContent('#t-version')).trim() === `Version ${swVersion}`, `sw.js says ${swVersion}`);
    await p.click('#title [data-check-updates]'); await p.waitForTimeout(800);
    check('pop-up messages never block a tap', await p.$eval('#toast', x => getComputedStyle(x).pointerEvents) === 'none' && (await p.getAttribute('#toast', 'role')) === 'status');
    check('"Check for updates" says you have the latest version', /latest version/.test(await p.textContent('#app-update-text')) && !(await p.$eval('#app-update', x => x.hidden)));
    await shot(p, 'title');
    await p.click('#t-continue'); await p.waitForTimeout(200);
    check('a new company asks for a difficulty', (await p.textContent('#i-title')) === 'New company');
    await p.click('[data-diff="tough"]'); await p.click('#diff-go'); await p.waitForTimeout(200);
    check('tough difficulty starts with its own cash', (await state(p, () => [MeritOrder.state.difficulty, MeritOrder.state.cash].join())) === 'tough,450000');
    check('a new company starts paused, with 1× pulsing', (await p.$eval('[data-speed="0"]', x => x.getAttribute('aria-pressed'))) === 'true' && await p.$eval('.speed', x => x.classList.contains('waiting'))
      && /starts paused/.test(await p.textContent('#i-body')));
    await p.click('#welcome-ok');
    await p.click('[data-speed="1"]');
    check('…and the pulse stops once the clock runs', !(await p.$eval('.speed', x => x.classList.contains('waiting'))));
    // the merit order chart redraws live as the market moves, not just while its bars animate
    await state(p, () => MeritOrder.setSpeed(16)); await p.waitForTimeout(1500);
    const shot1 = await p.evaluate(() => [MeritOrder.state.t, document.getElementById('c-merit').toDataURL()]);
    await p.waitForTimeout(1500);
    const shot2 = await p.evaluate(() => [MeritOrder.state.t, document.getElementById('c-merit').toDataURL()]);
    await state(p, () => MeritOrder.setSpeed(0));
    check('the merit order chart updates live', shot2[0] > shot1[0] && shot2[1] !== shot1[1], `${shot2[0] - shot1[0]} intervals apart`);
    // ...without bars vanishing and regrowing each interval (a re-priced band is the same bar)
    await state(p, () => MeritOrder.meritNew());
    const tA = await state(p, () => MeritOrder.state.t);
    await state(p, () => MeritOrder.setSpeed(16)); await p.waitForTimeout(2000); await state(p, () => MeritOrder.setSpeed(0));
    const born = await state(p, () => MeritOrder.meritNew()), steps = (await state(p, () => MeritOrder.state.t)) - tA;
    check('chart bars keep their identity from one interval to the next', steps >= 10 && born / steps < 1, `${born} new bars over ${steps} intervals`);
    await p.click('#add-plant'); await p.waitForTimeout(200); await shot(p, 'build');
    await p.click('[data-build="solar"]'); await p.waitForTimeout(200);
    check('building a plant', (await state(p, () => MeritOrder.state.plants.length)) === 1);
    await state(p, () => { MeritOrder.state.cash += 1e6; MeritOrder.Sim.build(MeritOrder.state, 'battery', 25); });
    await run(p, 3.5);
    const fc = await state(p, () => MeritOrder.Sim.forecast(MeritOrder.state, 6).map(f => f.price));
    check('price forecast for the hours ahead', fc.length === 6 && fc.every(Number.isFinite));
    await shot(p, 'main');
    const bat = await state(p, () => MeritOrder.state.plants.find(x => x.tech === 'battery').id);
    await p.click(`[data-plant="${bat}"]`); await p.waitForTimeout(200);
    await p.click('[data-set="strategy:evening"]');
    check('battery strategy can be changed', (await state(p, id => MeritOrder.state.plants.find(x => x.id === id).strategy, bat)) === 'evening');
    await p.click('[data-fcas="fcasLower"]'); await p.waitForTimeout(100);
    check('frequency control: separate Raise and Lower switches', (await p.$$('[data-fcas]')).length === 2 && (await state(p, id => { const x = MeritOrder.state.plants.find(y => y.id === id); return [x.fcasRaise, x.fcasLower].join(); }, bat)) === 'true,false');
    check('plant sheet shows its accounts since it was built', /Since it was built[\s\S]*Operating profit/.test(await p.textContent('#p-life')));
    await shot(p, 'plant');
    await p.click('#sh-plant [data-close]');
    await p.context().close();
  }

  // 2. Contracts, an upgrade and the company report.
  {
    const p = await page();
    await newCompany(p);
    await state(p, () => { const M = MeritOrder; M.state.cash += 2e6; M.Sim.build(M.state, 'solar', 50); M.Sim.build(M.state, 'battery', 25); M.Sim.build(M.state, 'peaker', 50); });
    await run(p, 4);
    await p.click('#open-contracts'); await p.waitForTimeout(200); await shot(p, 'contracts');
    await p.click('[data-sign]:not([disabled])'); await p.waitForTimeout(200);
    check('signing a contract', (await state(p, () => MeritOrder.state.contracts.length)) === 1);
    await p.click('#sh-info [data-close]');
    const solar = await state(p, () => MeritOrder.state.plants.find(x => x.tech === 'solar').id);
    await p.click(`[data-plant="${solar}"]`); await p.waitForTimeout(200);
    await p.click('[data-upgrade]'); await p.waitForTimeout(200);
    check('upgrading a plant', (await state(p, id => MeritOrder.state.plants.find(x => x.id === id).status, solar)) === 'upgrading');
    await p.click('#sh-plant [data-close]');
    await state(p, () => { const M = MeritOrder, S = M.state; M.Sim.retire(S, S.plants.find(x => x.tech === 'peaker')); M.renderAll(); });
    await p.click('#open-menu'); await p.click('#m-company'); await p.waitForTimeout(300);
    const rows = await p.$$eval('#i-body table.compact tbody tr', rs => rs.map(r => r.textContent));
    check('company report: a row per power station, sold ones included, and a total', rows.length === 4 && /gone/.test(rows[2]) && /All plants/.test(rows[3]));
    await shot(p, 'company');
    await p.click('#i-body tr.link'); await p.waitForTimeout(200);
    check('tapping a power station opens it', !(await state(p, () => document.getElementById('sh-plant').hidden)));
    await p.click('#sh-plant [data-close]');
    await p.context().close();
  }

  // 3. Offers and new contracts pause the game; custom bids typed to the dollar.
  {
    const p = await page();
    await newCompany(p);
    await state(p, () => MeritOrder.Sim.build(MeritOrder.state, 'solar', 50));
    await state(p, () => { const S = MeritOrder.state; S.offer = { type: 'reserve', mw: 20, payment: 5000, from: S.t + 100, to: S.t + 160, expires: S.t + 288, text: 'Test reserve request' }; MeritOrder.setSpeed(16); });
    await p.waitForTimeout(800);
    check('an offer pauses the game', (await p.$eval('[data-speed="0"]', x => x.getAttribute('aria-pressed'))) === 'true');
    await shot(p, 'offer');
    const cash0 = await state(p, () => MeritOrder.state.cash);
    await p.click('#offer-yes'); await p.waitForTimeout(200);
    check('accepting it pays and resumes at the earlier speed', (await state(p, () => MeritOrder.state.cash)) > cash0 && (await p.$eval('[data-speed="16"]', x => x.getAttribute('aria-pressed'))) === 'true');
    const toRefresh = () => state(p, () => { const M = MeritOrder, S = M.state; M.setSpeed(0); while (!((S.t + 3) % 288 === 0 && Math.floor((S.t + 3) / 288) % 3 === 0)) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); } M.renderAll(); });
    await toRefresh(); await state(p, () => MeritOrder.setSpeed(16)); await p.waitForTimeout(1200);
    check('new contracts pause the game with a dialog', (await p.textContent('#i-title')) === 'New contracts on offer' && (await p.$eval('[data-speed="0"]', x => x.getAttribute('aria-pressed'))) === 'true');
    await shot(p, 'contracts-dialog');
    await p.click('#nc-play'); await p.waitForTimeout(200);
    check('"Keep playing" resumes at the earlier speed', (await p.$eval('[data-speed="16"]', x => x.getAttribute('aria-pressed'))) === 'true');
    await toRefresh(); await state(p, () => MeritOrder.setSpeed(4)); await p.waitForTimeout(2000);
    await p.click('#nc-view'); await p.waitForTimeout(200);
    await p.click('#sh-info [data-close]'); await p.waitForTimeout(200);
    check('"View contracts" opens them and stays paused', (await p.$eval('[data-speed="0"]', x => x.getAttribute('aria-pressed'))) === 'true');
    const solar = await state(p, () => MeritOrder.state.plants[0].id);
    const plant = () => state(p, id => { const x = MeritOrder.state.plants.find(y => y.id === id); return { bid: x.bid, prices: x.bands.prices, next: x.bands.next, mw: x.bands.mw }; }, solar);
    const typeIn = async (sel, v) => { await p.fill(sel, String(v)); await p.press(sel, 'Enter'); await p.waitForTimeout(120); };
    await p.click(`[data-plant="${solar}"]`); await p.waitForTimeout(200);
    const preset = await p.$$eval('[data-smw^="g:"]', xs => xs.map(x => +x.value));
    check('a preset fills the bid stack (run while it pays: all MW in the minus-certificate band)', preset[2] === 50 && preset.reduce((a, b) => a + b, 0) === 50);
    await typeIn('[data-smw="g:4"]', 20);
    let st = await plant();
    check('moving MW between bands is a rebid: switches to Custom, applies now, takes MW from the fullest band', st.bid === 'custom' && st.mw[4] === 20 && st.mw[2] === 30 && +(await p.inputValue('[data-smw="g:2"]')) === 30);
    await typeIn('[data-sprice="g:1"]', -37); await typeIn('[data-sprice="g:8"]', 1234);
    st = await plant();
    check('new band prices are exact to the dollar and wait for tomorrow', st.next && st.next[1] === -37 && st.next[8] === 1234 && st.prices[1] === -100 && /from tomorrow/.test(await p.textContent('#sp-g-1')));
    await typeIn('[data-sprice="g:9"]', 99999); await typeIn('[data-sprice="g:5"]', 5);
    st = await plant();
    check('prices stay within the cap and rise band by band', st.next[9] === 23200 && st.next[5] === 31);
    await typeIn('[data-sprice="g:3"]', 8); await p.click('[data-sflip="g:3"]'); await p.waitForTimeout(120);
    check('the ± key makes a band price negative', (await plant()).next[3] === -8);
    await p.click('#sh-plant [data-close]');
    await state(p, () => { const M = MeritOrder, S = M.state, d = Math.floor(S.t / 288); while (Math.floor(S.t / 288) === d) M.Sim.step(S); M.Sim.step(S); });
    st = await plant();
    check('tomorrow the new prices are in force', !st.next && st.prices[1] === -37 && st.prices[8] === 1234);
    await shot(p, 'typed-bid');
    await p.context().close();
  }

  // 4. Time away, a challenge to the end, the goals list.
  {
    const p = await page();
    await newCompany(p, 'standard');
    await state(p, () => { const M = MeritOrder; M.Sim.build(M.state, 'solar', 50); });
    await run(p, 1);
    await p.click('#open-menu'); await p.click('#m-goals'); await p.waitForTimeout(200);
    check('goals list', (await p.$$('#i-body .goal')).length >= 9);
    await p.click('#sh-info [data-close]');
    const t0 = await state(p, () => MeritOrder.state.t);
    // pretend the app was closed 3 real hours ago: reload (which saves), then edit the save while
    // nothing is loaded, then reload again so the app reads it
    await p.reload(); await p.waitForTimeout(300);
    await state(p, () => { const s = JSON.parse(localStorage.getItem('merit-order')); s.careerSeen = Date.now() - 3 * 3600 * 1000; localStorage.setItem('merit-order', JSON.stringify(s)); });
    await p.reload(); await p.waitForTimeout(300);
    await p.click('#t-continue'); await p.waitForTimeout(400);
    check('coming back after 3 hours: a week of catch-up and a report', (await p.textContent('#i-title')) === 'While you were away' && ((await state(p, () => MeritOrder.state.t)) - t0) === 7 * 288);
    await shot(p, 'away');
    await p.click('#sh-info [data-close]');
    // with "Keep trading while I'm away" off, the same 3 hours away changes nothing
    await state(p, () => MeritOrder.setSpeed(0));
    await p.click('#open-menu'); await p.click('#m-idle'); await p.waitForTimeout(100);
    const idleOff = (await p.getAttribute('#m-idle', 'aria-checked')) === 'false';
    await p.click('#sh-menu [data-close]');
    const t1 = await state(p, () => MeritOrder.state.t);
    await p.reload(); await p.waitForTimeout(300);
    await state(p, () => { const s = JSON.parse(localStorage.getItem('merit-order')); s.careerSeen = Date.now() - 3 * 3600 * 1000; localStorage.setItem('merit-order', JSON.stringify(s)); });
    await p.reload(); await p.waitForTimeout(300);
    await p.click('#t-continue'); await p.waitForTimeout(400);
    check('with "Keep trading while I\'m away" off, the game waits for you', idleOff && (await state(p, () => MeritOrder.state.t)) === t1 && await p.$eval('#sh-info', x => x.hidden));
    await p.click('#open-menu'); await p.click('#m-challenge'); await p.click('#ch-new'); await p.waitForTimeout(200);
    const code = await p.textContent('#sh-info .code');
    await p.click('#cs-go');
    check('a new challenge starts paused', (await p.$eval('[data-speed="0"]', x => x.getAttribute('aria-pressed'))) === 'true');
    await state(p, () => { const M = MeritOrder; M.Sim.build(M.state, 'solar', 50); while (M.state.t < 30 * 288 - 2) M.Sim.step(M.state); M.setSpeed(16); });
    await p.waitForTimeout(1200);
    if ((await p.textContent('#i-title')) === 'New contracts on offer') { await p.click('#nc-play'); await p.waitForTimeout(1200); }
    const rcode = await p.textContent('#sh-info .code').catch(() => '');
    const parsed = await state(p, c => MeritOrder.parseResult(c), rcode);
    check('a challenge ends on day 30 with a result code that checks out', /^MO-/.test(code) && !!parsed && parsed.seed === MeritOrder_seed(code), rcode);
    await shot(p, 'challenge-end');
    await p.click('#ce-back'); await p.waitForTimeout(300);
    check('then back to your own company', await state(p, () => !MeritOrder.state.challenge && !JSON.parse(localStorage.getItem('merit-order')).challenge));
    await p.context().close();
  }

  // 5. An old save is brought up to date; debt, then collapse.
  {
    const p = await page();
    await state(p, () => {
      const Sim = MeritOrder.Sim, S = Sim.create(77);
      Sim.build(S, 'solar', 50); for (let k = 0; k < 2 * 288 + 30; k++) Sim.step(S);
      delete S.contracts; delete S.contractOffers; delete S.difficulty; delete S.retired; delete S.cptBuf;
      for (const k of ['contracts', 'repairs', 'interest', 'capPay']) delete S.today[k];
      for (const x of S.plants) { delete x.life; delete x.capital; x.bid = 'always'; }
      S.v = 1; S.last = undefined; S.goalsDone.value5m = 3;
      localStorage.setItem('merit-order', JSON.stringify({ career: S, careerSeen: Date.now(), slot: 'career' }));
    });
    await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-continue'); await p.waitForTimeout(300);
    await state(p, () => MeritOrder.setSpeed(16)); await p.waitForTimeout(1500);
    const m = await state(p, () => { const S = MeritOrder.state; return { v: S.v, diff: S.difficulty, bid: S.plants[0].bid, offers: S.contractOffers.length, life: !!S.plants[0].life, cpt: S.cptBuf.length }; });
    check('an old save is migrated', m.v === 3 && m.diff === 'standard' && m.bid === 'nonneg' && m.offers > 0 && m.life && m.cpt === 2016, JSON.stringify(m));
    await p.click('#open-menu');
    check('goal count ignores goals that no longer exist', /^1 of 9$/.test(await p.textContent('#m-goals-n')));
    await p.click('#sh-menu [data-close]');
    await state(p, () => { MeritOrder.setSpeed(0); MeritOrder.state.cash = -50000; MeritOrder.renderAll(); });
    check('an overdraft shows a warning', /Overdrawn/.test(await p.textContent('#chips')));
    await state(p, () => { const M = MeritOrder; M.state.cash = -5e7; let n = 0; while (!M.state.bust && n++ < 6 * 288) M.Sim.step(M.state); });
    await p.waitForTimeout(400);
    check('deep debt ends the company', (await p.textContent('#i-title')) === 'Your company has collapsed' && await state(p, () => !JSON.parse(localStorage.getItem('merit-order')).career));
    await shot(p, 'collapse');
    await p.click('#bust-new'); await p.waitForTimeout(200);
    check('and offers a new one', (await p.textContent('#i-title')) === 'New company');
    await p.context().close();
  }

  // 6. Portrait: nothing wider than the screen.
  {
    const p = await page({ viewport: { width: 800, height: 1280 } });
    await newCompany(p, 'standard');
    await state(p, () => { const M = MeritOrder; M.Sim.build(M.state, 'solar', 50); M.Sim.build(M.state, 'battery', 25); });
    await run(p, 3);
    check('portrait fits the screen', !(await state(p, () => document.documentElement.scrollWidth > innerWidth)));
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'portrait.png'), fullPage: true });
    await p.context().close();
  }

  // 7. Getting started: the tour walks through its missions with hints on the right controls.
  {
    const p = await page();
    await newCompany(p, 'standard');
    const card = async () => (await p.textContent('#mission')).replace(/\s+/g, ' ');
    const hinted = () => p.$$eval('.hint', xs => xs.map(x => x.id || x.dataset.build || x.dataset.speed || x.dataset.plant || 'other'));
    check('a new company starts the tour with Build hinted', /1 of 7.*Build a solar farm/.test(await card()) && (await hinted()).includes('add-plant'));
    await p.click('#add-plant'); await p.waitForTimeout(150);
    check('the right card in the build sheet is hinted', (await hinted()).includes('solar'));
    await p.click('[data-build="solar"]'); await p.waitForTimeout(200);
    check('building it moves on to speeding up', /2 of 7/.test(await card()) && (await hinted()).includes('16'));
    await state(p, () => { const M = MeritOrder; while (M.state.plants[0].status !== 'online') M.Sim.step(M.state); M.renderAll(); M.drawMerit(); });
    const r = await p.$eval('#c-merit', c => { const b = c.getBoundingClientRect(); return { x: b.left + b.width * 0.3, y: b.top + b.height * 0.75 }; });
    await p.mouse.click(r.x, r.y); await p.waitForTimeout(200);
    check('tapping the merit order completes that mission', /4 of 7.*battery/.test(await card()));
    await shot(p, 'tour');
    await p.click('#mission-skip'); await p.waitForTimeout(150);
    check('skip hides the tour', await p.$eval('#mission', x => x.hidden));
    await p.click('#open-menu'); await p.click('#m-tour'); await p.waitForTimeout(150);
    check('"Show me around" brings it back', !(await p.$eval('#mission', x => x.hidden)));
    await p.context().close();
  }

  // 8. Scenarios: pick one, play it to the end, stars are saved, carry on later, a collapse scores nothing.
  {
    const p = await page();
    await p.evaluate(() => localStorage.removeItem('merit-order')); await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    check('the scenarios list, with the company scenarios in their own group', (await p.$$('[data-scenario]')).length === 11 && /Run a company/.test(await p.textContent('#i-body')));
    await shot(p, 'scenarios');
    await p.click('[data-scenario="heatwave-week"]'); await p.waitForTimeout(150);
    check('a scenario shows its three stars before starting', (await p.$$('.starlist li')).length === 3);
    await p.click('#sc-go'); await p.waitForTimeout(300);
    check('it starts with its own plants and date', /Heatwave Week · day 1 of 10 · 15 Jan/.test(await p.textContent('#clock')) && (await p.$$('[data-plant]')).length === 2 && await p.$eval('#mission', x => x.hidden));
    check('a new scenario starts paused', (await p.$eval('[data-speed="0"]', x => x.getAttribute('aria-pressed'))) === 'true');
    await state(p, () => { const M = MeritOrder, S = M.state; while (S.t < 10 * 288 - 3) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); } M.setSpeed(16); });
    await p.waitForTimeout(1500);
    if ((await p.textContent('#i-title')) === 'New contracts on offer') { await p.click('#nc-play'); await p.waitForTimeout(1500); }
    check('it ends on its last day with stars', (await p.textContent('#i-title')) === 'Heatwave Week' && !!(await p.$('.stars.big')) && /day 10 of 10/.test(await p.textContent('#clock')));
    await shot(p, 'scenario-end');
    check('the best result is saved', await state(p, () => { const s = JSON.parse(localStorage.getItem('merit-order')); return !!s.scenarios['heatwave-week'] && !s.scenario; }));
    await p.click('#se-again'); await p.waitForTimeout(300);
    await p.click('#open-menu'); await p.click('#m-title'); await p.waitForTimeout(200);
    check('the menu\'s "Title screen" button goes back to the title', await state(p, () => MeritOrder.scene()) === 'title' && !(await p.$eval('#title', x => x.hidden)));
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('#sc-resume'); await p.waitForTimeout(300);
    check('try again, leave, and carry on later', /Heatwave Week · day 1 of 10/.test(await p.textContent('#clock')));
    await state(p, () => { const M = MeritOrder; M.state.cash = -5e7; let n = 0; while (!M.state.bust && n++ < 6 * 288) M.Sim.step(M.state); });
    await p.waitForTimeout(500);
    check('a collapse ends the scenario with no stars', (await p.textContent('#i-body')).includes('collapsed before the end'));
    await p.context().close();
  }

  // 8b. Energy Transition: a timeline, the year on the clock, technology that arrives later, an
  //     underwriting round that pauses the game, catch-up while away and a year-by-year report.
  {
    const p = await page();
    await p.evaluate(() => localStorage.removeItem('merit-order')); await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('[data-scenario="energy-transition"]'); await p.waitForTimeout(150);
    await p.click('[data-len="long"]'); await p.waitForTimeout(100);
    check('the Energy Transition offers Standard or Long years, and the value star follows', /\$3B/.test(await p.textContent('.starlist')) && (await p.$eval('[data-len="long"]', x => x.getAttribute('aria-pressed'))) === 'true');
    await p.click('[data-len="standard"]'); await p.waitForTimeout(100);
    await p.click('#sc-timeline'); await p.waitForTimeout(150);
    check('the Energy Transition shows its 20-year timeline before you start', (await p.$$('ol.timeline li')).length === 20 && /Each year is 60 game days/.test(await p.textContent('#i-body')));
    await p.click('#tl-back'); await p.waitForTimeout(150);
    await p.click('#sc-go'); await p.waitForTimeout(300);
    check('it starts in year 1 with the next milestone showing', /Year 1 of 20 · Jan/.test(await p.textContent('#clock')) && /Year 2:/.test(await p.textContent('#chips')));
    await p.click('#add-plant'); await p.waitForTimeout(150);
    check('offshore wind and long-duration storage wait for their year', (await p.$$eval('#sh-build .lock', xs => xs.map(x => x.textContent))).filter(t => /Arrives in year [46]/.test(t)).length === 2);
    await p.click('#sh-build [data-close]');
    await state(p, () => { const M = MeritOrder, S = M.state; S.cash = 5e7; while (S.t < 120 * 288 - 20) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); } S.yearReport.seen = true; M.renderAll(); M.setSpeed(16); });
    let title = '';
    for (let k = 0; k < 8 && title !== 'Year 2 in review'; k++) {
      await p.waitForTimeout(400); title = await p.textContent('#i-title');
      if (title === 'New contracts on offer' && !(await p.$eval('#sh-info', x => x.hidden))) await p.click('#nc-play');
    }
    const paused = async () => (await p.$eval('[data-speed="0"]', x => x.getAttribute('aria-pressed'))) === 'true';
    check('a new year opens with a report on the last, paused', title === 'Year 2 in review' && /Year 3 of 20/.test(await p.textContent('#clock')) && await paused()
      && /Black Hill 1 closes/.test(await p.textContent('#i-body')) && (await p.$$('#i-body .starlist li')).length === 3 && !!(await p.$('#yr-tender')));
    await shot(p, 'transition-report');
    await p.click('#yr-tender'); await p.waitForTimeout(150);
    title = await p.textContent('#i-title');
    check('its underwriting button opens the round, still paused', title === 'Capacity Investment Scheme' && await paused());
    await shot(p, 'transition-tender');
    await p.click('#cis-yes'); await p.waitForTimeout(150);
    await state(p, () => MeritOrder.setSpeed(0));
    if (!(await p.$eval('#sh-info', x => x.hidden))) await p.click('#sh-info [data-close]');   // new contracts released the same day
    await p.click('#add-plant'); await p.click('[data-design="wind"]'); await p.waitForTimeout(150);
    check('the Renewable Energy Zones are shown with their opening year and line', /opens in year 5 · line carries 1.5 GW/.test(await p.textContent('#dz-sites')));
    await p.keyboard.press('Escape');
    const w = await state(p, () => { const M = MeritOrder, r = M.Sim.build(M.state, 'wind', 300); M.renderAll(); return !!r.plant.cis; });
    check('a wind farm built this year is underwritten', w && /Underwriting: 300 MW of new renewables left/.test(await p.textContent('#chips')));
    await p.click('#open-menu'); await p.click('#m-timeline'); await p.waitForTimeout(150);
    check('the timeline marks this year', /Year 3/.test(await p.textContent('ol.timeline li.now')) && (await p.$$('ol.timeline li.done')).length === 2);
    await shot(p, 'transition-timeline');
    await p.click('#tl-report'); await p.waitForTimeout(150);
    check('the timeline reopens last year\'s report', (await p.textContent('#i-title')) === 'Year 2 in review');
    await p.click('#sh-info [data-close]');
    // away for a while: reload (which saves), edit the save while nothing is loaded, reload and carry on
    const t0 = await state(p, () => MeritOrder.state.t);
    await p.reload(); await p.waitForTimeout(300);
    await state(p, () => { const s = JSON.parse(localStorage.getItem('merit-order')); s.scenarioSeen = Date.now() - 2 * 288 * 1250; localStorage.setItem('merit-order', JSON.stringify(s)); });
    await p.reload(); await p.waitForTimeout(300);
    await p.click('#t-scenarios'); await p.waitForTimeout(150);
    check('the scenario list shows the year', /Energy Transition · year 3 of 20/.test(await p.textContent('#i-body')));
    await p.click('#sc-resume'); await p.waitForTimeout(400);
    const dt = (await state(p, () => MeritOrder.state.t)) - t0;
    check('it kept trading while you were away', (await p.textContent('#i-title')) === 'While you were away' && dt >= 2 * 288 - 2 && dt <= 2 * 288 + 2, `${dt} intervals`);
    await p.click('#sh-info [data-close]');
    await state(p, () => { const M = MeritOrder, S = M.state; while (S.t < 1200 * 288 - 3) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); if (S.tender && !S.tender.accepted && !S.tender.declined) M.Sim.declineTender(S); } S.yearReport.seen = true; M.setSpeed(16); });
    for (let k = 0; k < 8 && (await p.textContent('#i-title')) !== 'Energy Transition'; k++) {
      await p.waitForTimeout(400);
      if ((await p.textContent('#i-title')) === 'New contracts on offer' && !(await p.$eval('#sh-info', x => x.hidden))) await p.click('#nc-play');
    }
    check('after year 20: stars and a year-by-year report', (await p.textContent('#i-title')) === 'Energy Transition' && !!(await p.$('.stars.big')) && (await p.$$('#i-body table.res tbody tr')).length === 20);
    await shot(p, 'transition-end');
    await p.context().close();
  }

  // 8c. The Long version, and refurbishing a worn battery.
  {
    const p = await page();
    await p.evaluate(() => localStorage.removeItem('merit-order')); await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('[data-scenario="energy-transition"]'); await p.waitForTimeout(150);
    await p.click('[data-len="long"]'); await p.waitForTimeout(100);
    await p.click('#sc-go'); await p.waitForTimeout(300);
    const ff = days => state(p, d => { const M = MeritOrder, S = M.state; M.setSpeed(0); while (S.t < d * 288 + 1) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); } if (S.yearReport) S.yearReport.seen = true; M.renderAll(); }, days);
    await ff(89); const dec = await p.textContent('#clock');
    await ff(90);
    check('Long: a year is 90 game days', /Year 1 of 20 · Dec/.test(dec) && /Year 2 of 20 · Jan/.test(await p.textContent('#clock')), dec);
    const id = await state(p, () => { const M = MeritOrder, S = M.state; S.cash = 1e8; const b = M.Sim.build(S, 'battery', 100).plant; b.status = 'online'; b.buildLeft = 0; b.health = 0.7; M.renderAll(); return b.id; });
    await p.click(`[data-plant="${id}"]`); await p.waitForTimeout(200);
    check('a worn battery shows its health and offers new cells', /cells at 70% of new/.test(await p.textContent('#p-bid')) && !!(await p.$('[data-refurbish]:not([disabled])')));
    await shot(p, 'transition-refurbish');
    await p.click('[data-refurbish]'); await p.waitForTimeout(150);
    check('refurbishing restores it', (await state(p, i => MeritOrder.state.plants.find(x => x.id === i).health, id)) === 1 && !(await p.$('[data-refurbish]')));
    await p.context().close();
  }

  // 8e. Company scenarios: a portfolio taken from the rivals, a timeline of their own, a few short years.
  {
    const p = await page();
    await p.evaluate(() => localStorage.removeItem('merit-order')); await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('[data-scenario="lakeside"]'); await p.waitForTimeout(150);
    check('a company scenario explains its portfolio and stars', /all four Black Hill coal units/.test(await p.textContent('#i-body')) && (await p.$$('.starlist li')).length === 3 && /4 years of 60 days/.test(await p.textContent('#i-body')));
    await p.click('#sc-timeline'); await p.waitForTimeout(150);
    check('its timeline has its own years', (await p.$$('ol.timeline li')).length === 4 && /Lakeside Power: the plan/.test(await p.textContent('#i-title')));
    await shot(p, 'company-timeline');
    await p.click('#tl-back'); await p.waitForTimeout(150);
    await p.click('#sc-go'); await p.waitForTimeout(300);
    check('it starts with the company’s plants and its own clock', /Lakeside Power · Year 1 of 4 · Jan/.test(await p.textContent('#clock')) && (await p.$$('[data-plant]')).length === 6 && /Year 2:/.test(await p.textContent('#chips')), await p.textContent('#clock'));
    await shot(p, 'company-start');
    await p.click('#add-plant'); await p.waitForTimeout(150);
    const locks = (await p.$$eval('#sh-build .lock', xs => xs.map(x => x.textContent.trim()))).join('|');
    check('long-duration storage waits for its year; offshore wind is not in this one', locks === 'Arrives in year 3', locks);
    await p.click('#sh-build [data-close]');
    await state(p, () => { const M = MeritOrder, S = M.state; M.setSpeed(0); while (S.t < 61 * 288) M.Sim.step(S); S.yearReport.seen = true; M.renderAll(); });
    check('your coal closes on schedule', /Year 2 of 4/.test(await p.textContent('#clock')) && await state(p, () => !MeritOrder.state.plants.some(x => x.name === 'Black Hill 1')));
    const bh2 = await state(p, () => MeritOrder.state.plants.find(x => x.ref === 'bh2').id);
    check('a plant due to close says when', (await p.textContent(`[data-plant="${bh2}"] .closes`)) === 'Closes in 59 days');
    await p.context().close();
  }

  // 8f. Company scenarios, round 2: a decision pop-up, a rival's proposal (and buying it), the year
  //     report's own lines, and the 32x speed.
  {
    const p = await page();
    await p.evaluate(() => localStorage.removeItem('merit-order')); await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('[data-scenario="coastline"]'); await p.waitForTimeout(150);
    await p.click('#sc-go'); await p.waitForTimeout(300);
    await p.click('[data-speed="32"]'); await p.waitForTimeout(100);
    check('a 32× speed', (await p.$eval('[data-speed="32"]', x => x.getAttribute('aria-pressed'))) === 'true');
    // just before day 50, when the customers' renewal comes up
    await state(p, () => { const M = MeritOrder, S = M.state; M.setSpeed(0); while (S.t < 50 * 288 - 5) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); if (S.proposal) S.proposal = null; } M.renderAll(); M.setSpeed(16); });
    let title = '';
    for (let k = 0; k < 10 && title !== 'Your customers renew in 10 days'; k++) {
      await p.waitForTimeout(300); title = await p.textContent('#i-title');
      if (/New contracts|A rival plans/.test(title) && !(await p.$eval('#sh-info', x => x.hidden))) await p.keyboard.press('Escape');
    }
    check('a decision pops up, paused, with its options', title === 'Your customers renew in 10 days' && (await p.$$('[data-choose]')).length === 3 && (await p.$eval('[data-speed="0"]', x => x.getAttribute('aria-pressed'))) === 'true');
    await shot(p, 'company-decision');
    await p.click('[data-choose="high"]'); await p.waitForTimeout(200);
    check('choosing applies it and carries on', await state(p, () => MeritOrder.state.chosen.price === 'high' && !MeritOrder.state.choice) && (await p.$eval('[data-speed="16"]', x => x.getAttribute('aria-pressed'))) === 'true');
    // a run of dear days brings a rival's proposal
    await state(p, () => { const M = MeritOrder, S = M.state; M.setSpeed(0); S.proposal = null; for (const d of S.days.slice(-15)) d.avg = 400; S.cash = 5e8;
      while (!S.proposal) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); if (S.choice) M.Sim.choose(S, M.Sim.choiceView(S).deflt); } S.proposal.big = true; M.renderAll(); });
    check('a rival proposal shows as a chip', /decides in \d+ days/.test(await p.textContent('#chips')));
    await p.click('[data-proposal]'); await p.waitForTimeout(200);
    check('…and opens its pop-up: carry on, build to compete or buy', (await p.textContent('#i-title')) === 'A rival plans new plant' && !!(await p.$('#pr-buy')) && !!(await p.$('#pr-build')));
    await shot(p, 'company-proposal');
    const n0 = await state(p, () => MeritOrder.state.plants.length);
    await p.click('#pr-buy'); await p.waitForTimeout(200);
    check('buying it makes it your plant', await state(p, n => MeritOrder.state.plants.length === n + 1 && !MeritOrder.state.proposal, n0));
    // the year report has the scenario's own lines
    await state(p, () => { const M = MeritOrder, S = M.state; M.setSpeed(0); while (S.t < 60 * 288 - 5) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); if (S.choice) M.Sim.choose(S, M.Sim.choiceView(S).deflt); if (S.proposal) S.proposal = null; } M.renderAll(); M.setSpeed(16); });
    for (let k = 0; k < 10 && title !== 'Year 1 in review'; k++) {
      await p.waitForTimeout(300); title = await p.textContent('#i-title');
      if (/New contracts|A rival plans/.test(title) && !(await p.$eval('#sh-info', x => x.hidden))) await p.keyboard.press('Escape');
    }
    const body = await p.textContent('#i-body');
    check('the year report has the company’s own lines', title === 'Year 1 in review' && /Your customers/.test(body) && /Emissions/.test(body) && /Clean, of your output/.test(body), body.replace(/\s+/g, ' ').slice(0, 160));
    await shot(p, 'company-report');
    await p.context().close();
  }

  // 8h. A save that storage refuses says so (once), and play carries on.
  {
    const p = await page();
    await p.evaluate(() => localStorage.removeItem('merit-order')); await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('[data-scenario="first-light"]'); await p.waitForTimeout(150);
    await p.click('#sc-go'); await p.waitForTimeout(300);
    await p.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }; MeritOrder.save(); });
    await p.waitForTimeout(150);
    check('a refused save shows a warning instead of failing silently', /Couldn’t save your game/.test(await p.textContent('#toast')) && !(await p.$eval('#toast', x => x.hidden)));
    await p.click('[data-speed="16"]'); await p.waitForTimeout(600);
    check('…and the game carries on', await state(p, () => MeritOrder.state.t > 5));
    await p.context().close();
  }

  // 8g. Company scenarios saved and reloaded: a decision waiting and a rival proposal open come back
  //     as chips that still work; trading while away past a decision's deadline takes its default.
  {
    const p = await page();
    await p.evaluate(() => localStorage.removeItem('merit-order')); await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('[data-scenario="highcountry"]'); await p.waitForTimeout(150);
    await p.click('#sc-go'); await p.waitForTimeout(300);
    await state(p, () => { const M = MeritOrder, S = M.state; M.setSpeed(0); S.cash = 2e8;
      while (S.t < 61 * 288) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); if (S.proposal) S.proposal = null; }
      for (const d of S.days.slice(-15)) d.avg = 400;
      while (!S.proposal) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); }
      S.proposal.big = true; if (S.yearReport) S.yearReport.seen = true; M.renderAll(); M.save(); });
    await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('#sc-resume'); await p.waitForTimeout(400);
    const chips = await p.textContent('#chips');
    check('after a reload, the waiting decision and the open proposal are chips again', /Decision: Tunnel Two/.test(chips) && /decides in \d+ days/.test(chips), chips.slice(0, 160));
    await p.click('[data-choice]'); await p.waitForTimeout(200);
    await p.click('[data-choose="rescue"]'); await p.waitForTimeout(200);
    check('…the decision still works', await state(p, () => MeritOrder.state.chosen.tbm === 'rescue' && !MeritOrder.state.choice));
    await p.click('[data-proposal]'); await p.waitForTimeout(200);
    const n0 = await state(p, () => MeritOrder.state.plants.length);
    await p.click('#pr-buy'); await p.waitForTimeout(200);
    check('…and so does buying the project', await state(p, n => MeritOrder.state.plants.length === n + 1 && !MeritOrder.state.proposal, n0));
    // away past a decision's deadline: a new game four days before the deadline, then a week away
    await p.evaluate(() => localStorage.removeItem('merit-order')); await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('[data-scenario="highcountry"]'); await p.waitForTimeout(150);
    await p.click('#sc-go'); await p.waitForTimeout(300);
    await state(p, () => { const M = MeritOrder, S = M.state; M.setSpeed(0);
      while (S.t < 66 * 288) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); }
      if (S.yearReport) S.yearReport.seen = true; M.save(); });
    check('a decision is waiting before going away', await state(p, () => !!MeritOrder.state.choice && MeritOrder.Sim.choiceView(MeritOrder.state).daysLeft === 4));
    await p.reload(); await p.waitForTimeout(300);   // reloading saves, so edit the save after it
    await state(p, () => { const st = JSON.parse(localStorage.getItem('merit-order')); st.scenarioSeen = Date.now() - 7 * 288 * 1250; localStorage.setItem('merit-order', JSON.stringify(st)); });
    await p.reload(); await p.waitForTimeout(400);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('#sc-resume'); await p.waitForTimeout(600);
    check('away past the deadline: the default was taken, and the away report shows', (await p.textContent('#i-title')) === 'While you were away' && await state(p, () => MeritOrder.state.chosen.tbm === 'wait' && !MeritOrder.state.choice && MeritOrder.state.news.some(n => /No decision in time/.test(n.text))));
    await p.context().close();
  }

  // 8d. Bank loans: borrow and repay in the menu, borrow-and-build, and buy an offered plant on a loan.
  {
    const p = await page();
    await newCompany(p, 'standard');
    await state(p, () => MeritOrder.setSpeed(0));
    await p.click('#open-menu'); await p.click('#m-loans'); await p.waitForTimeout(150);
    check('the bank loans sheet shows what you can borrow', (await p.textContent('#i-title')) === 'Bank loans' && /a year, fixed/.test(await p.textContent('#ln-quote')));
    await p.click('[data-lterm="30"]'); await p.click('#ln-go'); await p.waitForTimeout(150);
    const owed = await state(p, () => MeritOrder.Sim.debt(MeritOrder.state));
    check('borrowing adds a loan and a chip', owed > 0 && /Loans \$/.test(await p.textContent('#chips')) && (await p.$$('[data-repay]')).length === 2);
    await p.click('[data-repay$=":all"]'); await p.waitForTimeout(150);
    check('repaying it in full', (await state(p, () => MeritOrder.Sim.debt(MeritOrder.state))) === 0);
    await p.click('#sh-info [data-close]');
    // too little cash to build: borrow the difference
    await state(p, () => { const M = MeritOrder, S = M.state; S.cash = M.Sim.priceOf(S, 'solar', M.Sim.TECH.solar.sizes[0]) - 20000; M.renderAll(); });   // $20k short
    await p.click('#add-plant'); await p.waitForTimeout(150);
    const btn = await p.textContent('[data-build="solar"]');
    await p.click('[data-build="solar"]'); await p.waitForTimeout(150);
    check('"Borrow and build" when short of cash', /^Borrow \$.* and build$/.test(btn) && (await state(p, () => MeritOrder.state.plants.length)) === 1 && (await state(p, () => MeritOrder.Sim.debt(MeritOrder.state))) > 0, btn);
    // an offered plant you can't afford in cash
    await state(p, () => { const M = MeritOrder, S = M.state, r = S.rivals.find(x => x.tech === 'coal' && x.id !== 'bh1'); S.cash = 400000; S.offer = { type: 'coal', rival: r.id, price: 900000, expires: S.t + 288, text: `${r.name} is for sale.` }; M.renderAll(); });
    await p.waitForTimeout(150);
    check('a plant offer you can\'t afford offers a loan', !(await p.$eval('#offer-loan', x => x.hidden)) && /loan/.test(await p.textContent('#offer-loan')) && /a year/.test(await p.textContent('#offer-note')));
    await shot(p, 'loan-offer');
    await p.click('#offer-loan'); await p.waitForTimeout(150);
    check('…and buying with it works', (await state(p, () => MeritOrder.state.plants.some(x => x.tech === 'coal'))) && await p.$eval('#offer', x => x.hidden));
    await p.context().close();
  }

  // 8e. A coal unit's page: the bid chart is drawn when it opens, Right now explains the minimum and
//      the ramp, the Min row and Now column show what's running.
  {
    const p = await page();
    await newCompany(p, 'standard');
    const id = await state(p, () => {
      const M = MeritOrder, S = M.state; M.setSpeed(0); S.cash = 3e6;
      const r = S.rivals.find(x => x.tech === 'coal' && x.id !== 'bh1');
      S.offer = { type: 'coal', rival: r.id, price: 500000, expires: S.t + 288, text: '' }; M.Sim.acceptOffer(S);
      const c = S.plants.find(x => x.tech === 'coal'); c.bid = 'custom';
      c.bands.prices = [-1000, 0, 32, 42, 300, 301, 600, 1000, 5000, 23200]; c.bands.mw = [297, 0, 260, 0, 103, 0, 0, 0, 0, 0]; c.bands.minIn = true; c.last = 660;
      for (let k = 0; k < 2; k++) M.Sim.step(S);
      M.renderAll(); return c.id;
    });
    await p.click(`[data-plant="${id}"]`); await p.waitForTimeout(300);
    const blank = await p.$eval('#stk-g', c => { const x = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < x.length; i += 4) if (x[i]) return false; return true; });
    check('a plant\'s bid chart is drawn as soon as its page opens', !blank);
    const now = await p.textContent('#p-now');
    check('Right now explains the minimum load and the ramp', /Minimum load/.test(now) && /Ramping down/.test(now), now.replace(/\s+/g, ' ').slice(0, 160));
    const run = await state(p, i => Math.round(MeritOrder.state.plants.find(x => x.id === i).now), id);
    const shown = await p.$$eval('#p-bid td.now b', xs => xs.reduce((a, x) => a + parseFloat(x.textContent.replace(/[^0-9.]/g, '')) * (/GW/.test(x.textContent) ? 1000 : 1), 0));
    check('the Now column adds up to what it runs', Math.abs(shown - run) <= 2, `${shown} vs ${run} MW`);
    const band1 = await p.$eval('#p-bid table.stack tbody tr', r => r.textContent.replace(/\s+/g, ' '));
    check('coal\'s minimum is band 1: fixed at −$1,000, its MW box no lower than 297', /fixed/.test(band1) && !(await p.$('[data-sprice="g:0"]')) && (await p.getAttribute('[data-smw="g:0"]', 'min')) === '297'
      && /660 MW of 660 MW/.test(await p.textContent('#st-g')) && !(await p.$('.minrow')), band1.slice(0, 80));
    check('the card says what it\'s doing', /ramping down/.test(await p.textContent(`[data-plant="${id}"]`)));
    await shot(p, 'coal-now');
    await p.context().close();
  }

  // 9. Design a plant: a custom battery at a chosen site; a hydro valley can only be used once.
  {
    const p = await page();
    await newCompany(p, 'standard');
    await state(p, () => { const S = MeritOrder.state; S.cash = 3e7; Object.assign(S.unlocked, { wind: true, ccgt: true, hydro: true }); MeritOrder.renderAll(); });
    await p.click('#add-plant'); await p.click('[data-design="battery"]'); await p.waitForTimeout(200);
    await p.click('[data-site="city"]');
    await p.fill('#dz-mw', '37'); await p.press('#dz-mw', 'Enter');
    await p.fill('#dz-mwh', '111'); await p.press('#dz-mwh', 'Enter');
    await shot(p, 'design');
    await p.click('#dz-build'); await p.waitForTimeout(200);
    check('a custom 37 MW / 111 MWh battery at the city site', (await state(p, () => { const x = MeritOrder.state.plants.at(-1); return [x.mw, x.mwh, x.site].join(); })) === '37,111,city');
    await p.click('#add-plant'); await p.click('[data-design="hydro"]'); await p.waitForTimeout(200);
    await p.click('[data-site="kangaroo"]'); await p.click('#dz-build'); await p.waitForTimeout(200);
    await p.click('#add-plant'); await p.click('[data-design="hydro"]'); await p.waitForTimeout(200);
    check('a hydro valley can only be used once', await p.$eval('[data-site="kangaroo"]', x => x.disabled));
    await p.click('[data-site="tumut"]'); await p.fill('#dz-mw', '5000'); await p.press('#dz-mw', 'Enter');
    check('sizes are kept within the site\'s range', (await p.inputValue('#dz-mw')) === '1000');
    await p.context().close();
  }

  check('no errors on any page', errs.length === 0, errs.slice(0, 3).join(' | '));
  await browser.close(); server.close();
  console.log(fails ? `\n${fails} check(s) failed` : '\nAll browser checks passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

// The challenge code is the seed in base 36.
function MeritOrder_seed(code) { return parseInt(code.slice(3), 36); }
