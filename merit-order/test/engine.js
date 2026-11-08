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
  const ledger = S.days.reduce((a, r) => a + r.profit, 0) + t.revenue - t.costs + t.fcas + t.contracts - t.penalties - t.repairs - t.interest + t.bonus;
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

// 10. Speed: a big company's 7-day catch-up (what runs when the app opens after a week away).
{
  const S = Sim.create(1, { cash: 1e9 });
  for (let i = 0; i < 150; i++) { const t = ['solar', 'battery', 'peaker', 'wind'][i % 4]; S.unlocked[t] = true; Sim.build(S, t, Sim.TECH[t].sizes[0]); }
  for (let k = 0; k < 2 * Sim.IPD; k++) Sim.step(S);
  const t0 = Date.now(); Sim.catchUp(S, Sim.AWAY_CAP_DAYS * Sim.IPD); const ms = Date.now() - t0;
  check('150-plant company catches up a week quickly', ms < 2000, `${ms} ms here (a tablet is a few times slower)`);
}

console.log(fails ? `\n${fails} check(s) failed` : '\nAll engine checks passed');
process.exit(fails ? 1 : 0);
