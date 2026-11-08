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
    await shot(p, 'title');
    await p.click('#t-continue'); await p.waitForTimeout(200);
    check('a new company asks for a difficulty', (await p.textContent('#i-title')) === 'New company');
    await p.click('[data-diff="tough"]'); await p.click('#diff-go'); await p.waitForTimeout(200);
    check('tough difficulty starts with its own cash', (await state(p, () => [MeritOrder.state.difficulty, MeritOrder.state.cash].join())) === 'tough,450000');
    await p.click('#welcome-ok');
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
    check('a preset fills the bid stack (avoid negative prices: all MW in the $0 band)', preset[3] === 50 && preset.reduce((a, b) => a + b, 0) === 50);
    await typeIn('[data-smw="g:4"]', 20);
    let st = await plant();
    check('moving MW between bands is a rebid: switches to Custom, applies now, takes MW from the fullest band', st.bid === 'custom' && st.mw[4] === 20 && st.mw[3] === 30 && +(await p.inputValue('[data-smw="g:3"]')) === 30);
    await typeIn('[data-sprice="g:1"]', -37); await typeIn('[data-sprice="g:8"]', 1234);
    st = await plant();
    check('new band prices are exact to the dollar and wait for tomorrow', st.next && st.next[1] === -37 && st.next[8] === 1234 && st.prices[1] === -100 && /from tomorrow/.test(await p.textContent('#sp-g-1')));
    await typeIn('[data-sprice="g:9"]', 99999); await typeIn('[data-sprice="g:5"]', 5);
    st = await plant();
    check('prices stay within the cap and rise band by band', st.next[9] === 23200 && st.next[5] === 31);
    await typeIn('[data-sprice="g:3"]', 25); await p.click('[data-sflip="g:3"]'); await p.waitForTimeout(120);
    check('the ± key makes a band price negative', (await plant()).next[3] === -25);
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
    await p.click('#open-menu'); await p.click('#m-challenge'); await p.click('#ch-new'); await p.waitForTimeout(200);
    const code = await p.textContent('#sh-info .code');
    await p.click('#cs-go');
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
    check('the scenarios list', (await p.$$('[data-scenario]')).length === 6);
    await shot(p, 'scenarios');
    await p.click('[data-scenario="heatwave-week"]'); await p.waitForTimeout(150);
    check('a scenario shows its three stars before starting', (await p.$$('.starlist li')).length === 3);
    await p.click('#sc-go'); await p.waitForTimeout(300);
    check('it starts with its own plants and date', /Heatwave Week · day 1 of 10 · 15 Jan/.test(await p.textContent('#clock')) && (await p.$$('[data-plant]')).length === 2 && await p.$eval('#mission', x => x.hidden));
    await state(p, () => { const M = MeritOrder, S = M.state; while (S.t < 10 * 288 - 3) { M.Sim.step(S); if (S.offer) M.Sim.declineOffer(S); } M.setSpeed(16); });
    await p.waitForTimeout(1500);
    if ((await p.textContent('#i-title')) === 'New contracts on offer') { await p.click('#nc-play'); await p.waitForTimeout(1500); }
    check('it ends on its last day with stars', (await p.textContent('#i-title')) === 'Heatwave Week' && !!(await p.$('.stars.big')) && /day 10 of 10/.test(await p.textContent('#clock')));
    await shot(p, 'scenario-end');
    check('the best result is saved', await state(p, () => { const s = JSON.parse(localStorage.getItem('merit-order')); return !!s.scenarios['heatwave-week'] && !s.scenario; }));
    await p.click('#se-again'); await p.waitForTimeout(300);
    await p.click('#open-menu'); await p.click('#m-title'); await p.waitForTimeout(200);
    await p.click('#t-scenarios'); await p.waitForTimeout(200);
    await p.click('#sc-resume'); await p.waitForTimeout(300);
    check('try again, leave, and carry on later', /Heatwave Week · day 1 of 10/.test(await p.textContent('#clock')));
    await state(p, () => { const M = MeritOrder; M.state.cash = -5e7; let n = 0; while (!M.state.bust && n++ < 6 * 288) M.Sim.step(M.state); });
    await p.waitForTimeout(500);
    check('a collapse ends the scenario with no stars', (await p.textContent('#i-body')).includes('collapsed before the end'));
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
