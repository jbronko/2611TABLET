#!/usr/bin/env node
// Engine checks for Merit Order: the market clears correctly, money adds up, challenges are fair,
// saves round-trip, the price limits and debt rules behave. Run before pushing changes to sim.js:
//
//   node merit-order/test/engine.js
//
// Exits 1 if any check fails.
const Sim = require(require('path').join(__dirname, '..', 'sim.js'));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; };

// 1. Every interval balances and the price is the marginal bid.
{
  const S = Sim.create(5);
  Sim.build(S, 'solar', 50); Sim.build(S, 'battery', 25);
  let worstGap = 0, priceBad = 0, n = 0, shortfalls = 0, capped = 0;
  for (let k = 0; k < 20 * Sim.IPD; k++) {
    const r = Sim.step(S); n++;
    const supplied = r.supply.reduce((a, b) => a + b.out, 0);
    const demanded = r.c.demand + r.demandBids.reduce((a, d) => a + (d.take || 0), 0) - r.res.shortfall;
    worstGap = Math.max(worstGap, Math.abs(supplied - demanded));
    if (r.res.shortfall > 0) { shortfalls++; continue; }
    if (r.res.capped) { capped++; continue; }   // administered price cap: the price is held at $600
    // the price is the bid of some band that is (partly) dispatched or of a demand bid that sets it
    const marginal = r.supply.filter(b => b.out > 1e-6).reduce((m, b) => Math.max(m, b.price), -Infinity);
    const setByDemand = r.demandBids.some(d => d.price === r.res.price);
    if (!(Math.abs(marginal - r.res.price) < 1e-6 || setByDemand)) priceBad++;
    // nothing bid below the price is left undispatched (except at the floor, where oversupply shares)
    if (r.res.price > Sim.FLOOR && r.supply.some(b => b.price < r.res.price && b.out < b.mw - 1e-6)) priceBad++;
  }
  check('supply equals demand every interval', worstGap < 1e-3, `worst gap ${worstGap.toExponential(2)} MW over ${n} intervals (${shortfalls} shortfalls, ${capped} under the administered cap)`);
  check('price is the marginal bid', priceBad === 0, `${priceBad} bad intervals`);
}

// 2. Money adds up: cash change = revenue - costs + fcas - upkeep - penalties + bonuses + goal rewards - builds.
{
  // 40 days with a gas peaker (breakdowns and repairs), contracts and an upgrade
  const S = Sim.create(11, { cash: 3e6, difficulty: 'tough' });
  const start = S.cash;
  Sim.build(S, 'solar', 50); Sim.build(S, 'battery', 25); for (let k = 0; k < 4; k++) Sim.build(S, 'peaker', 50);
  let capital = S.plants.reduce((a, p) => a + p.value, 0);
  let signed = 0, upgraded = 0;
  for (let d = 0; d < 40; d++) {
    for (let k = 0; k < Sim.IPD; k++) Sim.step(S);
    while (S.contractOffers.length && Sim.signContract(S, 0).ok) signed++;
    const pk = S.plants.find(p => p.tech === 'peaker' && !p.upg && p.status === 'online');
    if (pk && d === 10) { const r = Sim.upgrade(S, pk); if (r.ok) { capital += r.cost; upgraded++; } }
  }
  const goals = Sim.GOALS.filter(g => S.goalsDone[g.id] !== undefined).reduce((a, g) => a + g.reward, 0);
  const t = S.today;
  const ledger = S.days.reduce((a, r) => a + r.profit, 0) + t.revenue - t.costs + t.fcas + t.contracts + t.certs - t.starts - t.penalties - t.repairs - t.interest + t.bonus;
  const expect = start - capital + ledger + goals + (S.totals.sold || 0);   // forced sales by the bank aren't profit
  const repairs = S.days.reduce((a, r) => a + (r.repairs || 0), 0);
  check('money adds up (contracts, repairs, upgrades)', Math.abs(S.cash - expect) < 1,
    `cash ${S.cash.toFixed(0)} vs ledger ${expect.toFixed(0)} · ${signed} contracts · repairs ${Sim.fmtMoney(repairs)} · contracts ${Sim.fmtMoney(S.totals.contracts)} · ${upgraded} upgrade · bank sold ${Sim.fmtMoney(S.totals.sold || 0)}`);
  // each power station's own accounts add up to the company's
  const all = [...S.plants.map(p => ({ life: p.life, capital: p.capital })), ...S.retired];
  const sumL = k => all.reduce((a, p) => a + p.life[k], 0), sumD = k => S.days.reduce((a, r) => a + (r[k] || 0), 0);
  const lines = {
    revenue: [sumL('sales') - sumL('charging'), sumD('revenue') + t.revenue],
    fuel: [sumL('fuel'), sumD('costs') + t.costs],
    fcas: [sumL('fcas'), sumD('fcas') + t.fcas],
    upkeep: [sumL('upkeep'), sumD('upkeep')],
    repairs: [sumL('repairs'), sumD('repairs') + t.repairs],
    certs: [sumL('certs'), sumD('certs') + t.certs],
    starts: [sumL('starts'), sumD('starts') + t.starts],
  };
  const bad = Object.entries(lines).filter(([, [a, b]]) => Math.abs(a - b) > 1).map(([k, [a, b]]) => `${k} ${a.toFixed(0)}≠${b.toFixed(0)}`);
  check('each power station\'s accounts add up to the company\'s', !bad.length && Math.abs(all.reduce((a, p) => a + p.capital, 0) - capital) < 1,
    bad.join(', ') || `${all.length} plants (${S.retired.length} sold), capital ${Sim.fmtMoney(capital)}`);
}

// 3. Batteries buy cheap and sell dear.
{
  const S = Sim.create(21, { cash: 1e6 });
  const b = Sim.build(S, 'battery', 50).plant;
  let buy = 0, buyMWh = 0, sell = 0, sellMWh = 0;
  for (let k = 0; k < 15 * Sim.IPD; k++) {
    const r = Sim.step(S);
    const out = r.supply.filter(x => x.ref === b).reduce((a, x) => a + x.out, 0);
    const take = r.demandBids.filter(x => x.ref === b).reduce((a, x) => a + (x.take || 0), 0);
    sell += out * r.res.price; sellMWh += out; buy += take * r.res.price; buyMWh += take;
  }
  const avgBuy = buy / buyMWh, avgSell = sell / sellMWh;
  check('battery buys cheap, sells dear', avgSell > avgBuy * 1.5 && buyMWh > 0 && sellMWh > 0, `buys at ${avgBuy.toFixed(0)}, sells at ${avgSell.toFixed(0)} $/MWh`);
}

// 4. Challenges: same seed, different builds -> identical weather and events.
{
  const a = Sim.create(777, { challenge: { seed: 777 } }), b = Sim.create(777, { challenge: { seed: 777 } });
  Sim.build(a, 'solar', 100); Sim.build(b, 'peaker', 50); Sim.build(b, 'battery', 25);
  let same = true, evA = [], evB = [];
  for (let k = 0; k < 30 * Sim.IPD; k++) {
    const ra = Sim.step(a), rb = Sim.step(b);
    if (Math.abs(ra.c.demand - rb.c.demand) > 1e-9 || Math.abs(ra.c.wind - rb.c.wind) > 1e-12 || Math.abs(ra.c.sun - rb.c.sun) > 1e-12) same = false;
    if (k % Sim.IPD === 0) { evA.push(a.events.map(e => e.key).join('+')); evB.push(b.events.map(e => e.key).join('+')); }
  }
  check('challenge weather identical', same);
  check('challenge events identical', evA.join() === evB.join(), evA.filter(Boolean).slice(0, 6).join(' '));
}

// 5. Catching up after time away matches running live.
{
  const a = Sim.create(31), b = Sim.create(31);
  for (const S of [a, b]) { Sim.build(S, 'solar', 50); Sim.build(S, 'battery', 25); }
  for (let k = 0; k < 3 * Sim.IPD + 17; k++) Sim.step(a);
  const rep = Sim.catchUp(b, 3 * Sim.IPD + 17);
  check('catch-up equals live play', Math.abs(a.cash - b.cash) < 1e-6 && a.t === b.t, `cash ${a.cash.toFixed(0)} / ${b.cash.toFixed(0)}, report profit ${Sim.fmtMoney(rep.profit)}`);
  const c = Sim.create(31); const rep2 = Sim.catchUp(c, 30 * Sim.IPD);
  check('catch-up is capped', rep2.intervals === Sim.AWAY_CAP_DAYS * Sim.IPD && rep2.capped);
}

// 6. Save and load: JSON round trip keeps playing identically.
{
  const a = Sim.create(41); Sim.build(a, 'solar', 50); Sim.build(a, 'battery', 25);
  for (let k = 0; k < 2 * Sim.IPD + 5; k++) Sim.step(a);
  const b = JSON.parse(JSON.stringify({ ...a, last: undefined }));
  for (let k = 0; k < Sim.IPD; k++) { Sim.step(a); Sim.step(b); }
  check('save/load round trip', Math.abs(a.cash - b.cash) < 1e-6, `${a.cash.toFixed(0)} / ${b.cash.toFixed(0)}`);
}

// 7. Midday oversupply goes negative; squeezes spike prices, but rarely.
{
  const S = Sim.create(1);
  let neg = 0, spike = 0; const n = 240 * Sim.IPD;
  for (let k = 0; k < n; k++) { const r = Sim.step(S); if (r.res.price < 0) neg++; if (r.res.price >= 5000) spike++; }
  check('negative prices happen', neg > n * 0.02, `${(neg / n * 100).toFixed(1)}% of intervals below $0 in 240 days`);
  check('spikes above $5,000 happen but are rare', spike > 0 && spike < n * 0.005, `${spike} intervals`);
}

// 8. The administered price cap: the last 7 days of prices (2,016 intervals) added up; past the
//    threshold prices are held at $600; it lifts at a day's end once the total is back under.
{
  const S = Sim.create(4);
  const mine = [];
  let on = 0, maxWhileOn = 0, lifted = 0, badStart = 0, badLift = 0, sumBad = 0, overCap = 0;
  for (let k = 0; k < 240 * Sim.IPD; k++) {
    const was = !!S.apc, r = Sim.step(S);
    mine.push(Math.round(r.res.price)); if (mine.length > 7 * Sim.IPD) mine.shift();
    if (r.res.price > Sim.CAP) overCap++;
    if (was) { on++; maxWhileOn = Math.max(maxWhileOn, r.res.price); }
    if (!was && S.apc && !(S.cptSum > Sim.CPT)) badStart++;
    if (was && !S.apc) { lifted++; if (S.cptSum > Sim.CPT || (S.t - 1) % Sim.IPD !== 0) badLift++; }
    if (mine.length === 7 * Sim.IPD && k % 97 === 0 && mine.reduce((a, b) => a + b, 0) !== S.cptSum) sumBad++;
  }
  check('prices stay between the floor and the $23,200 cap', overCap === 0 && Sim.CAP === 23200 && Sim.FLOOR === -1000);
  check('7-day total tracked exactly', sumBad === 0);
  check('administered cap starts past the threshold, holds $600, lifts at day end', on > 0 && maxWhileOn <= Sim.APC && lifted > 0 && !badStart && !badLift,
    `${(on / Sim.IPD).toFixed(1)} days under the cap, lifted ${lifted} times`);
}

// 9. Debt: interest, three days' grace past the limit, then forced sales; nothing left means administration.
{
  const S = Sim.create(5); Sim.build(S, 'solar', 50); Sim.build(S, 'battery', 25);
  for (let k = 0; k < 3 * Sim.IPD; k++) Sim.step(S);
  S.cash = -2e6;
  const n0 = S.plants.length; let soldOn = null;
  for (let d = 0; d < 6 && !S.bust; d++) { for (let k = 0; k < Sim.IPD; k++) Sim.step(S); if (soldOn == null && S.plants.length < n0) soldOn = d; }
  check('debt past the limit: grace, then forced sale', soldOn === 2, `plants sold on day ${soldOn} after the debt; interest ${Sim.fmtMoney(S.days.slice(-4).reduce((a, r) => a + (r.interest || 0), 0))}; bust ${!!S.bust}`);
  check('nothing left to sell means administration', S.bust === true);
}

// 11. Getting started: missions complete in play, pay once, and can be restarted without paying again.
{
  const S = Sim.create(3, { tour: true }), c0 = S.cash;
  const first = Sim.missionNext(S).id;
  const cost = Sim.priceOf(S, 'solar', 50); Sim.build(S, 'solar', 50);
  const afterBuild = S.cash - (c0 - cost);
  for (let k = 0; k < 3 * Sim.IPD; k++) Sim.step(S);
  const appSide = Sim.completeMission(S, 'merit') && !Sim.completeMission(S, 'merit');
  const paid = S.totals.missions;
  Sim.startTour(S); Sim.completeMission(S, 'merit');
  check('missions complete in play and pay once', first === 'solar' && afterBuild === 15000 && appSide && Sim.missionNext(S).id === 'battery' && S.totals.missions === paid && paid === 35000,
    `paid ${Sim.fmtMoney(paid)}, next ${Sim.missionNext(S).id}`);
  check('no missions for challenges or tests', Sim.missionNext(Sim.create(5, { challenge: { seed: 5 } })) === null && Sim.missionNext(Sim.create(5)) === null);
}

// 12. Scenarios: same weather for everyone whatever they build; each runs to its last day and is scored.
{
  const a = Sim.createScenario('heatwave-week'), b = Sim.createScenario('heatwave-week');
  Sim.build(b, 'battery', 25);
  let same = true;
  while (!Sim.scenarioOver(a)) { const ra = Sim.step(a), rb = Sim.step(b); if (ra.c.demand !== rb.c.demand || ra.c.wind !== rb.c.wind) same = false; }
  const ev = d => d.days.map(r => r.day).join();
  check('scenario weather is the same for everyone', same && ev(a) === ev(b));
  const scored = Sim.SCENARIOS.map(sc => { const S = Sim.createScenario(sc.id); let n = 0; while (!Sim.scenarioOver(S) && n++ < (sc.days + 2) * Sim.IPD) Sim.step(S); const r = Sim.scenarioResult(S); return { id: sc.id, ok: Sim.scenarioOver(S) && S.days[S.days.length - 1].day === sc.days - 1 && r.lines.length === 3, stars: r.stars }; });
  check('every scenario runs to its last day and is scored', scored.every(x => x.ok), scored.map(x => `${x.id} ${x.stars}★`).join(', '));
  check('doing nothing never earns more than one star', scored.every(x => x.stars <= 1));
}

// 13. Custom builds on sites: costs, room, one scheme per hydro valley, loss factors paid in full.
{
  const S = Sim.create(8, { cash: 1e9 }); Object.assign(S.unlocked, { wind: true, hydro: true });
  const bat = Sim.priceOf(S, 'battery', 37, { site: 'city', mwh: 111 });
  check('custom battery cost = connection + MW + MWh', bat === Math.round((25000 * 1.4 + 37 * 3000 + 111 * 2500) / 100) * 100, Sim.fmtMoney(bat));
  const a = Sim.build(S, 'solar', 100, { site: 'city-fringe' }), b = Sim.build(S, 'solar', 60, { site: 'city-fringe' });
  const h1 = Sim.build(S, 'hydro', 350, { site: 'wombat' }), h2 = Sim.build(S, 'hydro', 200, { site: 'wombat' });
  check('site room and one scheme per hydro valley', a.ok && b.why === 'room' && h1.ok && h2.why === 'site' && Sim.build(S, 'solar', 500).why === 'size' && Sim.build(S, 'battery', 50, { mwh: 500 }).why === 'hours');
  h1.plant.status = 'online';
  check('a hydro scheme at its valley\'s limit can\'t add turbines', !Sim.canUpgrade(h1.plant) && h1.plant.mwh === 2000);
  // every MWh is paid price x loss factor
  const T = Sim.create(9); const far = Sim.build(T, 'solar', 50, { site: 'far-west' }).plant;
  for (let k = 0; k < 3 * Sim.IPD; k++) Sim.step(T);
  let expect = far.life.sales, got = 0;
  for (let k = 0; k < Sim.IPD; k++) { const r = Sim.step(T); for (const x of r.supply) if (x.ref === far) got += x.out * r.res.price * 0.90 * Sim.H; }
  check('energy is paid at price x loss factor', Math.abs(far.life.sales - expect - got) < 1e-6 && far.mlf === 0.9, `${Sim.fmtMoney(far.life.sales - expect)} in a day`);
  // an old plant without a site keeps its old economics
  const O = Sim.create(10); const op = Sim.build(O, 'battery', 25).plant; delete op.site; delete op.mlf; delete op.res; op.hours = 2; delete op.mwh; Sim.migrate(O);
  check('old plants move to their original site unchanged', op.site === 'legacy' && op.mlf === 1 && op.mwh === 50);
}

// 14. Bid stacks: presets place MW; bands fill cheapest first; prices wait for the next day; rebids don't.
{
  const S = Sim.create(12, { cash: 1e8 });
  const pk = Sim.build(S, 'peaker', 50).plant, so = Sim.build(S, 'solar', 50).plant;
  for (const x of S.plants) { x.status = 'online'; x.buildLeft = 0; }
  const pkBands = () => Sim.step(S).supply.filter(b => b.ref === pk);
  pk.bid = 'peak'; const peak = Sim.presetMW(S, pk, 50);
  check('presets place their MW in the right band', pk.bands.prices[peak.findIndex(v => v > 0)] === Math.max(300, Math.round(Sim.vcOf(S, pk)) * 2.5) && Sim.presetMW(S, so, 30)[so.bands.prices.indexOf(-Sim.CERT)] === 30);
  check('custom bands fill cheapest first up to what is available', Sim.fillBands([30, 0, 0, 0, 30, 0, 0, 0, 0, 0], 40).join() === '30,0,0,0,10,0,0,0,0,0' && Sim.fillBands([0, 20, 0, 0, 0, 0, 0, 0, 0, 30], 25, true).join() === '0,0,0,0,0,0,0,0,0,25');
  const top = peak.findIndex(v => v > 0);
  Sim.setBandMW(S, pk, 'g', 2, 20);
  const nowBands = pkBands();
  check('a rebid of MW applies straight away, moving MW from the fullest band', pk.bid === 'custom' && pk.bands.mw[2] === 20 && pk.bands.mw[top] === 30 && nowBands.some(b => (b.offer ?? b.price) === pk.bands.prices[2] && Math.abs(b.mw - 20) < 1e-9));
  check('a band never holds more than the plant', Sim.setBandMW(S, pk, 'g', 5, 99) === 50 && pk.bands.mw.reduce((a, b) => a + b, 0) <= 50 + 1e-9);
  const was = pk.bands.prices[2], used = Sim.setBandPrice(S, pk, 'g', 2, was + 7);
  const sameDay = pkBands().every(b => (b.offer ?? b.price) !== was + 7);
  while (S.t % Sim.IPD !== 0) Sim.step(S); Sim.step(S);
  check('a new band price waits for the next day', used === was + 7 && sameDay && pk.bands.prices[2] === was + 7 && !pk.bands.next);
  check('band prices must rise band by band', Sim.setBandPrice(S, pk, 'g', 4, -5000) === pk.bands.prices[3] + 1);
}

// 15. Frequency control: Raise and Lower each meet their requirement; switches are respected.
{
  const S = Sim.create(14, { cash: 1e7 }); Sim.build(S, 'solar', 50); const bat = Sim.build(S, 'battery', 50).plant;
  let met = true, both = 0, offLower = true;
  for (let k = 0; k < 4 * Sim.IPD; k++) {
    if (k === 3 * Sim.IPD) bat.fcasLower = false;
    const r = Sim.step(S), R = r.fc.raise, L = r.fc.lower;
    const got = M => M.offers.reduce((a, o) => a + (o.take || 0), 0);
    if (Math.abs(got(R) - R.need) > 1e-6 || Math.abs(got(L) - L.need) > 1e-6) met = false;
    if (R.offers.some(o => o.ref === bat && o.take) && L.offers.some(o => o.ref === bat && o.take)) both++;
    if (k >= 3 * Sim.IPD && L.offers.some(o => o.ref === bat)) offLower = false;
  }
  const d = S.days[S.days.length - 1];
  check('Raise and Lower each meet their requirement', met);
  check('a battery can earn in both, and its switches are respected', both > 0 && offLower && Math.abs(d.fcas - d.fcasRaise - d.fcasLower) < 1e-6, `raise ${Sim.fmtMoney(d.fcasRaise)}, lower ${Sim.fmtMoney(d.fcasLower)} on day ${d.day + 1}`);
}

// 16. Your supply moves the price: the interconnector has its own supply curve, so it can't soak up
//     everything you add. A 600 MW peaker bidding its running cost lowers the evening average clearly.
{
  const evening = build => {
    const S = Sim.create(5, { cash: 1e10 }); build(S); for (const p of S.plants) { p.status = 'online'; p.buildLeft = 0; }
    let sum = 0, n = 0;
    for (let k = 0; k < 20 * Sim.IPD; k++) { const h = (S.t % Sim.IPD) * Sim.H, r = Sim.step(S); if (h >= 17 && h < 20) { sum += r.res.price; n++; } }
    return sum / n;
  };
  const base = evening(() => {}), withPeaker = evening(S => { Sim.build(S, 'peaker', 600, { site: 'gas-hub' }).plant.bid = 'cost'; });
  check('your supply moves the price', base - withPeaker >= 10, `evening average $${base.toFixed(0)} without you, $${withPeaker.toFixed(0)} with a 600 MW peaker`);
}

// 17. Real plant costs: a start is charged once; a combined-cycle plant holds its stable load for its
//     minimum run; certificates are paid on MWh sold; the default gas preset beats bidding at cost.
{
  const S = Sim.create(16, { cash: 1e9 }); Object.assign(S.unlocked, { ccgt: true });
  const cc = Sim.build(S, 'ccgt', 200).plant, so = Sim.build(S, 'solar', 50).plant;
  for (const x of S.plants) { x.status = 'online'; x.buildLeft = 0; }
  let starts = 0, heldOK = true, certOK = true;
  for (let k = 0; k < 6 * Sim.IPD; k++) {
    const was = cc.onFor, s0 = cc.life.starts, c0 = so.life.certs;
    const r = Sim.step(S);
    if (was == null && cc.onFor === 0) { starts++; if (Math.abs(cc.life.starts - s0 - Sim.TECH.ccgt.startCost * 200) > 1e-6) heldOK = false; }
    if (was != null && was < Sim.TECH.ccgt.minRun - 1 && cc.status === 'online' && (cc.onFor == null || !((cc.now || 0) > 0))) heldOK = false;   // never stops inside its minimum run
    const sold = r.supply.filter(b => b.ref === so).reduce((a, b) => a + b.out, 0);
    if (Math.abs(so.life.certs - c0 - sold * Sim.CERT * Sim.H) > 1e-6) certOK = false;
  }
  check('a gas start is charged once and the plant then holds its minimum run', starts > 0 && heldOK, `${starts} starts in 6 days`);
  check('certificates are paid on every MWh of wind and solar sold', certOK && so.life.certs > 0);
  // the default preset (running cost + a start-up margin) beats bidding exactly at running cost
  const earn = custom => {
    const T = Sim.create(3, { cash: 1e10 });
    const pk = Sim.build(T, 'peaker', 150).plant; pk.status = 'online'; pk.buildLeft = 0;
    if (custom) { pk.bid = 'custom'; pk.bands.mw = pk.bands.prices.map(v => v === Math.round(Sim.vcOf(T, pk)) ? 150 : 0); }
    for (let k = 0; k < 40 * Sim.IPD; k++) Sim.step(T);
    return Sim.plantProfit(pk);
  };
  const atCost = earn(true), preset = earn(false);
  check('a peaker does better with a start-up margin than bidding at running cost', preset > atCost, `${Sim.fmtMoney(preset)} vs ${Sim.fmtMoney(atCost)} over 40 days`);
}

// 10. Speed: a big company's 7-day catch-up (what runs when the app opens after a week away).
{
  const S = Sim.create(1, { cash: 1e9 });
  for (let i = 0; i < 150; i++) { const t = ['solar', 'battery', 'peaker', 'wind'][i % 4]; S.unlocked[t] = true; Sim.build(S, t, Sim.TECH[t].sizes[0]); }
  for (let k = 0; k < 2 * Sim.IPD; k++) Sim.step(S);
  const t0 = Date.now(); Sim.catchUp(S, Sim.AWAY_CAP_DAYS * Sim.IPD); const ms = Date.now() - t0;
  check('150-plant company catches up a week quickly', ms < 2000, `${ms} ms here (a tablet is a few times slower)`);
}

// 11. Energy Transition: a compressed calendar, a timeline that fires once and is announced a year
//     ahead, underwriting that settles into the ledger, stars on the final year, and nothing leaks
//     into the career or the other scenarios.
{
  const sc = Sim.SCENARIOS.find(x => x.id === 'energy-transition');
  const S = Sim.createScenario('energy-transition');
  // run whole days; the step after midnight closes the day (and starts a new year), so end just past it
  const run = days => { const end = S.t + days * Sim.IPD; while (S.t < end) { Sim.step(S); if (S.offer) Sim.declineOffer(S); } };
  Sim.step(S);
  const bh = () => S.rivals.find(r => /Black Hill 1/.test(r.name));
  const months = [];
  for (let d = 0; d < 60; d++) { months.push(Sim.dateLabel(S).month); run(1); }
  check('a transition year is 60 game days and the seasons cycle within it', Sim.yearOf(S) === 1 && Sim.dateLabel(S).year === 2 && new Set(months).size === 12 && months[0] === 'Jan' && months[59] === 'Dec', [...new Set(months)].join(' '));
  check('next year\'s milestones are announced a year ahead', S.news.some(n => /Next year/.test(n.text) && /Black Hill 1/.test(n.text)));
  run(59);
  const before = !bh().gone;
  run(1);
  check('Black Hill 1 closes on the first day of year 3, not before', before && bh().gone && Sim.yearOf(S) === 2);
  check('a Capacity Investment Scheme round opens with the closure', !!S.tender && S.tender.kind === 'renewable' && !S.tender.accepted);
  const target = S.emisTarget, demand = S.demandMult;
  run(10);
  check('a year\'s changes apply once', S.emisTarget === target && S.demandMult === demand);
  // underwriting: join, build a wind farm, and the top-up or share lands in both ledgers
  S.cash = 1e9; Sim.acceptTender(S);
  const w = Sim.build(S, 'wind', 300).plant, pk = Sim.build(S, 'peaker', 150).plant;
  check('a plant of the round\'s kind is underwritten, another kind is not', !!w.cis && !pk.cis && S.tender.used === 300);
  while (w.status !== 'online') run(1);
  const partial = () => { const t = S.today; return t.revenue - t.costs + t.fcas + t.contracts + t.certs - t.starts - t.penalties - t.repairs - t.interest + t.bonus; };
  const cash0 = S.cash, part0 = partial(), cis0 = w.life.cis || 0; let profits = 0, cis = 0;
  for (let k = 0; k < 20; k++) { run(1); const r = S.days[S.days.length - 1]; profits += r.profit; cis += r.cis; }
  const gap = S.cash - cash0 - (profits - part0 + partial());
  check('underwriting is paid into the day\'s profit and the plant\'s accounts', Math.abs(gap) < 1 && cis !== 0 && Math.abs(w.life.cis - cis0 - cis) < 1,
    `${Sim.fmtMoney(cis)} over 20 days, ledger gap ${gap.toFixed(2)}`);
  check('the year report records reliability, clean share and profit', S.years.length === 3 && S.years[0].region > 0 && S.years.every(Y => 'shedHours' in Y && 'clean' in Y));
  // new technology and zones arrive on schedule, and never in the career
  check('offshore wind arrives in year 4 and the first zones in year 5', !S.unlocked.offshore && Sim.siteRoom(S, 'solar', 'cw-rez') === 0);
  run(60);
  const off = S.unlocked.offshore;
  run(60);
  check('…and they do', off && Sim.siteRoom(S, 'solar', 'cw-rez') > 0 && Sim.siteRoom(S, 'wind', 'ne-rez') > 0);
  const C = Sim.create(5);
  check('the career keeps a normal calendar and has no zones or new technology', C.yearDays == null && Sim.siteRoom(C, 'solar', 'cw-rez') === 0 && Sim.siteRoom(C, 'battery', 'bh-yard') === 0 && !C.unlocked.offshore && Sim.dateLabel(C).year === 1);
  // stars: reliability in the final year only
  const T = Sim.createScenario('energy-transition');
  T.t = (sc.days - 1) * Sim.IPD - 1; Sim.step(T);
  const day = d => ({ day: d, shed: 0, clean: 300000, region: 1e6, profit: 0, share: 0 });
  T.days = Array.from({ length: 60 }, (_, k) => day(sc.days - 60 + k));
  T.cash = 3e9;
  const ok = Sim.scenarioResult(T);
  T.days[5].shed = 0.00003 * 60e6;
  const short = Sim.scenarioResult(T);
  check('stars: reliable, clean and big earns three; missing the reliability standard earns none', ok.stars === 3 && short.stars === 0, `${ok.stars} vs ${short.stars}`);
  // the catch-up never runs past the end
  const E = Sim.createScenario('energy-transition'); E.t = (sc.days - 1) * Sim.IPD;
  Sim.catchUp(E, Math.min(7 * Sim.IPD, sc.days * Sim.IPD - E.t + Sim.IPD));
  check('coming back after the last year ends the scenario', Sim.scenarioOver(E));
}

console.log(fails ? `\n${fails} check(s) failed` : '\nAll engine checks passed');
process.exit(fails ? 1 : 0);
