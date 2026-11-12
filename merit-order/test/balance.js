#!/usr/bin/env node
// Balance check for Merit Order: simulated players with different strategies, on each difficulty.
// Prints company value at days 10/30/60/end (median of the seeds, and the worst), the lowest cash,
// how many went bust, and what contracts made. Run after changing prices, costs or rules:
//
//   node merit-order/test/balance.js [strategies] [difficulties] [days] [seeds]
//   node merit-order/test/balance.js steady,reckless standard 120 1,2,3
//
// Strategies: idle (starter plants only), steady (reinvests in a mix, swaps on wind/solar), borrower
// (steady plus every loan the bank allows),
// peaker (gas peakers only), capseller (sells caps only against firm thermal plant),
// capgambler (sells every cap), reckless (builds big on no cash, signs everything).
// Targets after the last rebalance (Standard, day 120): steady about $20-30M (about $26M now), idle about $4.5M,
// capseller about steady, capgambler and reckless usually bust.
// Caps at three strikes (v33): Standard day 120, seeds 1-4: steady $28.6M (unchanged), capseller $37.1M
// (was $34.6M with only $300 caps), capgambler and reckless bust 4/4.
const Sim = require(require('path').join(__dirname, '..', 'sim.js'));
const { IPD, TECH } = Sim;
const owned = (S, f = () => true) => S.plants.filter(f).reduce((a, p) => a + p.mw, 0);
const firm = S => owned(S, p => ['peaker', 'ccgt', 'hydro', 'battery', 'coal'].includes(p.tech) && p.status === 'online');
const thermalFirm = S => owned(S, p => ['peaker', 'ccgt', 'hydro', 'coal'].includes(p.tech) && p.status === 'online');
function tryBuild(S, t, buffer, big) {
  if (!S.unlocked[t]) return false;
  const sizes = big ? [...TECH[t].sizes].reverse() : TECH[t].sizes;
  for (const mw of sizes) if (S.cash - Sim.priceOf(S, t, mw) >= buffer) return Sim.build(S, t, mw).ok;
  return false;
}
const STRATS = {
  idle: {
    day(S, d) { if (d === 0) { tryBuild(S, 'solar', 0); tryBuild(S, 'battery', 0); } },
    offer(S) { Sim.declineOffer(S); },
  },
  steady: {
    day(S, d) {
      const target = { solar: 0.22, wind: 0.25, battery: 0.2, peaker: 0.1, ccgt: 0.15, hydro: 0.08 };
      const buffer = Math.max(60000, S.cash * 0.15);
      for (let n = 0; n < 3; n++) {
        const tot = Math.max(1, owned(S));
        const order = Object.keys(target).filter(t => S.unlocked[t]).sort((a, b) => owned(S, p => p.tech === a) / tot - target[a] - (owned(S, p => p.tech === b) / tot - target[b]));
        if (!order.some(t => tryBuild(S, t, buffer))) break;
      }
      for (const p of S.plants) if (!p.upg && p.status === 'online' && S.cash > Sim.upgradeCost(S, p) * 4 + buffer) Sim.upgrade(S, p);
      const vre = owned(S, p => p.tech === 'solar' || p.tech === 'wind');
      for (let i = S.contractOffers.length - 1; i >= 0; i--) {
        const o = S.contractOffers[i];
        if (o.type === 'swap' && S.contracts.filter(k => k.type === 'swap').reduce((a, k) => a + k.mw, 0) + o.mw <= vre * 0.3) Sim.signContract(S, i);
      }
    },
    offer(S) { const o = S.offer; if (o.type === 'reserve' && firm(S) >= o.mw * 1.2) Sim.acceptOffer(S); else Sim.declineOffer(S); },
  },
  peaker: {
    day(S) { while (tryBuild(S, 'peaker', 50000)); },
    offer(S) { const o = S.offer; if (o.type === 'reserve' && firm(S) >= o.mw) Sim.acceptOffer(S); else Sim.declineOffer(S); },
  },
  borrower: {   // steady, but borrows all the bank allows (180 days) and buys offered plant on loans
    day(S, d) {
      if (Sim.loanRoom(S) >= 100000) Sim.takeLoan(S, Sim.loanRoom(S), 180);
      STRATS.steady.day(S, d);
    },
    offer(S) { const o = S.offer; if (o.type === 'coal' && S.cash + Sim.loanRoom(S, o.price) >= o.price) Sim.acceptOffer(S, { loan: true }); else STRATS.steady.offer(S); },
  },
  capseller: {   // sells caps only against firm plant that can run in a spike
    day(S, d) {
      STRATS.steady.day(S, d);
      const capped = () => S.contracts.filter(k => k.type === 'cap').reduce((a, k) => a + k.mw, 0);
      for (let i = S.contractOffers.length - 1; i >= 0; i--) { const o = S.contractOffers[i]; if (o.type === 'cap' && capped() + o.mw <= thermalFirm(S) * 0.8) Sim.signContract(S, i); }
    },
    offer(S) { STRATS.steady.offer(S); },
  },
  capgambler: {
    day(S, d) {
      STRATS.steady.day(S, d);
      for (let i = S.contractOffers.length - 1; i >= 0; i--) if (S.contractOffers[i].type === 'cap') Sim.signContract(S, i);
    },
    offer(S) { STRATS.steady.offer(S); },
  },
  reckless: {
    day(S) {
      const techs = ['solar', 'wind', 'peaker', 'ccgt', 'battery', 'hydro'].filter(t => S.unlocked[t]);
      for (let n = 0; n < 4; n++) { const t = techs[Math.floor(Math.random() * techs.length)]; tryBuild(S, t, 0, true); }
      while (S.contractOffers.length && Sim.signContract(S, 0).ok);
      for (const p of S.plants) if (p.bid !== undefined && TECH[p.tech].kind === 'vre') p.bid = 'always';
    },
    offer(S) { Sim.acceptOffer(S) || Sim.declineOffer(S); },
  },
  savvy: {   // steady, plus the obvious good habits: no negative-price running, peakers on cost, keep reserve promises
    day(S, d) {
      for (const p of S.plants) { if (TECH[p.tech].kind === 'vre') p.bid = 'nonneg'; if (p.tech === 'peaker') p.bid = 'cost'; }
      STRATS.steady.day(S, d);
    },
    offer(S) { const o = S.offer; if (o.type === 'reserve' && firm(S) >= o.mw) Sim.acceptOffer(S); else Sim.declineOffer(S); },
  },
};
// Plant ageing (v40, multi-year scenarios): a maintainer reads each plant's page once a day and acts
// on its payback estimates (Sim.maintenancePlan: at recent earnings, counting what's lost offline):
// an overhaul, a rebuild or (v41) a repower that pays back within a game year (whichever is soonest),
// and only if it pays back by halfway through what's left of the scenario; storage gets new cells below
// 80%. steadyM and firmM are steady and firm plus that. MAINT counts what it did (printed and reset with
// each result line).
// Results (v40, Standard): Energy Transition steady $4.93B, steadyM $4.79B (73 overhauls, 41 rebuilds);
// firm $3.41B, firmM $3.48B (44 and 74); all 3 stars. Company scenarios steady vs steadyM: Coastline
// $637M / $622M, Highcountry $608M / $603M, Lakeside $937M / $937M, Wellspring $1.24B / $1.16B, all
// 2 stars, but with 0-2 actions each, so the gaps there are the random stream shifting, not upkeep.
// Ageing itself: a neglected fleet ends about 12% below no ageing at all (Transition steady $5.62B
// before v40). Maintenance on these estimates roughly breaks even: plants pay back in weeks, so the
// gain from fixing an old one is small next to building another, and the estimates are cautious.
const MAINT = { overhaul: 0, rebuild: 0, repower: 0 };
const maintText = () => { const t = MAINT.overhaul + MAINT.rebuild + MAINT.repower ? `  (${MAINT.overhaul} overhauls, ${MAINT.rebuild} rebuilds, ${MAINT.repower} repowers)` : ''; MAINT.overhaul = MAINT.rebuild = MAINT.repower = 0; return t; };
function maintain(S) {
  const yr = Sim.yearDays(S), left = S.scenario.days - Sim.dayIndex(S);
  for (const p of [...S.plants]) {
    if (p.status !== 'online' || !Sim.AGEING[p.tech] || p.replacedBy) continue;
    const m = Sim.maintenancePlan(S, p);
    const ok = x => x && x.payback != null && x.payback <= Math.min(yr, left / 2) && S.cash > x.cost * 1.5;
    const best = ['repower', 'rebuild', 'overhaul'].filter(k => ok(m[k])).sort((a, b) => m[a].payback - m[b].payback)[0];
    if (best === 'overhaul') { if (Sim.overhaul(S, p).ok) MAINT.overhaul++; }
    else if (best) { if (Sim.rebuild(S, p, best === 'repower' ? { mw: m.repower.mw } : {}).ok) MAINT[best]++; continue; }
    if (Sim.AGEING[p.tech].store && (p.health ?? 1) < 0.8 && S.cash > Sim.refurbishCost(S, p) * 2) Sim.refurbish(S, p);
  }
}
const withUpkeep = k => ({ day(S, d) { STRATS[k].day(S, d); maintain(S); }, offer: S => STRATS[k].offer(S), proposal: STRATS[k].proposal });
// For the scenarios judged on more than money (v39): Clean Up's plans for the coal, and building big.
STRATS.greener = { day(S, d) { if (d === 0) for (const p of S.plants) if (p.tech === 'coal') p.bid = 'peak'; STRATS.steady.day(S, d); }, offer: S => STRATS.steady.offer(S) };   // coal only at $300+
STRATS.cleanplan = {   // close one coal unit, run the other only at peaks, build wind, solar and storage hard
  day(S, d) {
    if (d === 0) { const c = S.plants.filter(p => p.tech === 'coal'); if (c[0]) Sim.retire(S, c[0]); if (c[1]) c[1].bid = 'peak'; }
    for (let n = 0; n < 4; n++) if (!['wind', 'solar', 'battery'].some(t => tryBuild(S, t, Math.max(100000, S.cash * 0.1), true))) break;
  },
  offer(S) { Sim.declineOffer(S); },
};
STRATS.bigbuild = {   // the biggest sizes first, gas and wind before the rest
  day(S) { for (let n = 0; n < 6; n++) if (!['ccgt', 'wind', 'solar', 'peaker', 'battery'].some(t => tryBuild(S, t, Math.max(100000, S.cash * 0.05), true))) break; },
  offer(S) { Sim.declineOffer(S); },
};
// Scenarios: play each one to its end with a strategy and report the stars.
// Energy Transition players: build firm plant ahead of each closure and keep adding clean plant.
STRATS.firm = {
  day(S, d) {
    for (const p of S.plants) { if (TECH[p.tech].kind === 'vre') p.bid = 'nonneg'; }
    if (S.tender && !S.tender.accepted && !S.tender.declined) Sim.acceptTender(S);
    for (const p of S.plants) if ((p.health ?? 1) < 0.8 && S.cash > Sim.refurbishCost(S, p) * 2) Sim.refurbish(S, p);
    const buffer = Math.max(100000, S.cash * 0.1);
    const order = ['hydro', 'ldes', 'battery', 'peaker', 'wind', 'offshore', 'solar'];
    for (let n = 0; n < 6; n++) {
      let built = false;
      for (const t of order) {
        if (!S.unlocked[t]) continue;
        for (const mw of [...TECH[t].sizes].reverse()) { if (S.cash - Sim.priceOf(S, t, mw) < buffer) continue; if (Sim.build(S, t, mw).ok) { built = true; break; } }
        if (built) break;
      }
      if (!built) break;
    }
  },
  offer(S) { const o = S.offer; if (o.type === 'reserve' && firm(S) >= o.mw) Sim.acceptOffer(S); else Sim.declineOffer(S); },
};
// Company scenarios: a decision is answered with opts.picks[id] (else its default), and a rival
// proposal is passed to the strategy's proposal() if it has one.
function runScenario(kind, id, report, opts = {}) {
  const S = Sim.createScenario(id, opts), st = STRATS[kind];
  const maxDays = S.scenario.days + 5;
  for (let d = 0; d < maxDays && !Sim.scenarioOver(S); d++) {
    if (report && S.yearDays && d % S.yearDays === 0 && d) report(S, d);
    st.day(S, d);
    for (let k = 0; k < IPD && !Sim.scenarioOver(S); k++) {
      Sim.step(S);
      if (S.offer && S.offer !== S._seen) { S._seen = S.offer; st.offer(S); }
      if (S.choice) { const v = Sim.choiceView(S); Sim.choose(S, (opts.picks || {})[v.id] || v.deflt); }
      if (S.proposal && st.proposal) st.proposal(S);
    }
  }
  return Sim.scenarioResult(S);
}
// Company-scenario styles from the playtest: the exploits they test must not beat steady play.
STRATS.handsoff = { day() {}, offer(S) { Sim.declineOffer(S); } };   // builds nothing, bids as given
STRATS.gouge = { day(S, d) { if (d === 0) for (const p of S.plants) if (TECH[p.tech].kind === 'thermal') p.bid = 'peak'; }, offer(S) { Sim.declineOffer(S); } };   // gas and coal only at $300+
STRATS.quitcoal = { day(S, d) { if (d === 0) for (const p of S.plants.filter(p => p.tech === 'coal')) Sim.retire(S, p); STRATS.steady.day(S, d); }, offer: S => STRATS.steady.offer(S) };   // closes its coal on day 1
STRATS.buyer = { day: (S, d) => STRATS.steady.day(S, d), offer: S => STRATS.steady.offer(S), proposal(S) { Sim.buyProposal(S, { loan: true }); } };   // steady, and buys every rival project
function run(kind, seed, difficulty, days) {
  const S = Sim.create(seed, { difficulty });
  const st = STRATS[kind], out = { minCash: S.cash, at: {} };
  for (let d = 0; d < days; d++) {
    if (S.bust) { for (const k of [10, 30, 60, 120, 180]) if (k > d) out.at[k] = Sim.companyValue(S); break; }
    st.day(S, d);
    for (let k = 0; k < IPD; k++) { Sim.step(S); if (S.offer && S.offer !== S._seen) { S._seen = S.offer; st.offer(S); } out.minCash = Math.min(out.minCash, S.cash); }
    if ([10, 30, 60, 120, 180].includes(d + 1)) out.at[d + 1] = Sim.companyValue(S);
  }
  out.mw = owned(S); out.emis = S.totals.emis; out.contracts = S.totals.contracts || 0; out.sold = S.totals.sold || 0; out.goals = Object.keys(S.goalsDone).length;
  out.cap = S.days.reduce((a, r) => a + (r.capPay > 0 ? 1 : 0), 0); out.bust = S.bust ? 1 : 0;
  return out;
}
STRATS.steadyM = withUpkeep('steady'); STRATS.firmM = withUpkeep('firm');
module.exports = { run, runScenario, STRATS, MAINT };
if (require.main === module && process.argv[2] === '--transition') {
  // node merit-order/test/balance.js --transition [strategies] [--long]
  // Targets: idle 0 stars and the region runs short without the player; players who keep building
  // firm and clean plant reach 3, and still have places to build after year 10.
  // v35 (lights-on limit per star), Standard: idle 0 (696 h short in year 20), steady 3 ($5.6B), firm 3 ($3.4B), both 0 h short.
  // Before ageing (v39): Standard steady 3 ($5.6B), firm 3 ($3.4B); Long steady 3 ($8.7B), firm 3 ($5.2B), idle 0.
  // v40 (ageing), Standard: steady 3 ($4.93B), steadyM 3 ($4.79B), firm 3 ($3.41B), firmM 3 ($3.48B), all 0 MWh short.
  const long = process.argv.includes('--long');
  const kinds = (process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'idle,steady,firm').split(',');
  for (const kind of kinds) {
    console.log(`${kind}${long ? ' (Long: 90-day years)' : ''}`);
    let curtailed = 0;
    const r = runScenario(kind, 'energy-transition', (S, d) => {
      curtailed = S.plants.reduce((a, p) => a + ((p.life && p.life.curtailed) || 0), 0);
      const y = S.years[d / S.yearDays - 1];
      if ((d / S.yearDays) % 2 === 0) console.log(`  year ${String(d / S.yearDays).padStart(2)} value ${Sim.fmtMoney(Sim.companyValue(S)).padStart(7)} plant ${String(Math.round(S.plants.reduce((a, p) => a + p.mw, 0))).padStart(6)} MW shortfall ${y.shedHours.toFixed(1).padStart(6)} h clean share ${(y.clean / Math.max(1, y.region) * 100).toFixed(0)}% curtailed ${Math.round(curtailed / 1000)} GWh`);
    }, { length: long ? 'long' : 'standard' });
    console.log(`  ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)} value ${Sim.fmtMoney(r.value)} final-year shortfall ${r.finalShed.toFixed(0)} MWh, clean share ${(r.cleanShare * 100).toFixed(0)}%${r.bust ? ' BUST' : ''}${maintText()}`);
  }
} else if (require.main === module && process.argv[2] === '--companies') {
  // node merit-order/test/balance.js --companies [strategies] [scenario ids]
  // Company scenarios: a real company's portfolio for a few 60-day years, rivals proposing plant
  // when prices run high, and a decision or two. Each strategy plays with the defaults, then steady
  // plays each option of each decision. Targets: handsoff, gouge and quitcoal end below steady in
  // value; handsoff at most 1 star; steady 2; no option beats another by more than about 15%.
  // Last run (v25): Highcountry handsoff $324M 0★, steady $597M ★★, gouge $416M, rescue $575M; Lakeside
  // handsoff $911M 0★, steady $1.09B ★★, gouge $637M, quitcoal $685M, close BH4 early $1.12B; Wellspring
  // handsoff $1.26B 0★, steady $1.27B ★★, gouge $639M, quitcoal $814M, close on schedule $1.12B; Coastline
  // handsoff $436M 0★, steady $657M ★★, gouge $241M, quitcoal $632M, hold $604M, raise $704M ★★★.
  // v35, a lights-on limit per star (48 h / 12 h / none short in the final year): values and stars as
  // above, except Coastline raise $704M ★★ (12 MWh short in year 4 misses "no shortfall at all").
  // Handsoff still 0★ everywhere (short of its own firm plant), steady, firm, buyer, quitcoal ★★.
  const kinds = (process.argv[3] || 'handsoff,steady,firm,gouge,quitcoal,buyer').split(',');
  const ids = process.argv[4] ? process.argv[4].split(',') : Sim.SCENARIOS.filter(sc => sc.group === 'company').map(sc => sc.id);
  const line = (label, r, yrs) => console.log(`  ${label.padEnd(16)} ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}  value ${Sim.fmtMoney(r.value).padStart(7)}  worst year ${Sim.fmtMoney(r.minYearProfit).padStart(7)}  final short ${r.finalShed.toFixed(0).padStart(6)} MWh  own firm ${String(Math.round(r.ownFirm)).padStart(5)}/${r.firm}  own clean ${(r.ownClean * 100).toFixed(0)}%${r.tunnelOn ? '  tunnel on' : ''}${r.bust ? '  BUST' : ''}  [${yrs.join(' ')}]${maintText()}`);
  const yearly = yrs => (S, d) => { const Y = S.years[d / S.yearDays - 1]; yrs.push(`${Sim.fmtMoney(Y.value)}/${Y.shedHours.toFixed(0)}h`); };
  for (const id of ids) {
    const sc = Sim.SCENARIOS.find(x => x.id === id);
    console.log(`${sc.name} (${sc.years} years)`);
    for (const kind of kinds) { const yrs = []; line(kind, runScenario(kind, id, yearly(yrs)), yrs); }
    for (const [cid, C] of Object.entries(sc.choices || {})) for (const o of C.options) {
      if (o.key === C.deflt) continue;
      const yrs = []; line(`steady, ${cid}=${o.key}`, runScenario('steady', id, yearly(yrs), { picks: { [cid]: o.key } }), yrs);
    }
  }
} else if (require.main === module && process.argv[2] === '--scenarios') {
  // node merit-order/test/balance.js --scenarios [strategies]
  // Targets: idle at most 1 star, steady 1-2, savvy 2-3.
  // The ones judged on more than money (v39), with the players that show each star can be won:
  //   Clean Up (emissions cap 500k t, 40% clean, +$35M): idle 0 (832k t), steady 0 (722k t), greener 1
  //   (405k t, 34% clean), quitcoal 2 (162k t, 44%, +$20.5M), cleanplan 3 (276k t, 48%, +$42.8M).
  //   Big Fish (5% in a day, 10% in a day, 10% over the last week): idle 0, steady 2 (11.5%, week 9.7%),
  //   bigbuild 3 (16.5%, week 12.9%).
  //   Reserve Duty (four heatwave promises; keep one, keep all four, +$1.25M): idle 0 (declines),
  //   steady 1 (its batteries sell into the peak, so 3 are missed), peaker 3 (all four kept, +$1.49M).
  //   node merit-order/test/balance.js --scenarios idle,steady,greener,quitcoal,cleanplan,bigbuild,peaker
  const kinds = (process.argv[3] || 'idle,steady,savvy').split(',');
  for (const sc of Sim.SCENARIOS) {
    if (sc.transition) continue;   // the 20-year scenario has its own mode (--transition), the companies too (--companies)
    console.log(`${sc.name} (${sc.days} days)`);
    for (const kind of kinds) {
      const r = runScenario(kind, sc.id);
      console.log(`  ${kind.padEnd(7)} ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}  value ${Sim.fmtMoney(r.value).padStart(7)}  gain ${Sim.fmtMoney(r.gain).padStart(7)}  profit ${Sim.fmtMoney(r.profit).padStart(7)}  best share ${(r.maxShare * 100).toFixed(1)}%${r.reserveKept ? '  reserve kept' : ''}${r.bust ? '  BUST' : ''}`);
    }
  }
} else if (require.main === module) {
  const kinds = (process.argv[2] || 'idle,steady,peaker,capseller,reckless').split(',');
  const diffs = (process.argv[3] || 'relaxed,standard,tough').split(',');
  const days = +(process.argv[4] || 120), seeds = (process.argv[5] || '1,2,3,4').split(',').map(Number);
  const M = v => Sim.fmtMoney(v).padStart(8);
  for (const diff of diffs) for (const kind of kinds) {
    const rs = seeds.map(s => run(kind, s, diff, days));
    const med = k => { const v = rs.map(r => r.at[k]).filter(x => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
    const lo = k => Math.min(...rs.map(r => r.at[k] ?? Infinity));
    console.log(`${diff.padEnd(8)} ${kind.padEnd(9)} d10 ${M(med(10))} d30 ${M(med(30))} d60 ${M(med(60))} d${days} ${M(med(days))} (worst ${M(lo(days))}) minCash ${M(Math.min(...rs.map(r => r.minCash)))} mw ${Math.round(rs.reduce((a, r) => a + r.mw, 0) / rs.length)} contracts ${M(rs.reduce((a, r) => a + r.contracts, 0) / rs.length)} goals ${(rs.reduce((a, r) => a + r.goals, 0) / rs.length).toFixed(1)} sold ${M(rs.reduce((a, r) => a + r.sold, 0) / rs.length)} bust ${rs.reduce((a, r) => a + r.bust, 0)}/${rs.length} capdays ${(rs.reduce((a, r) => a + r.cap, 0) / rs.length).toFixed(0)}`);
  }
}
