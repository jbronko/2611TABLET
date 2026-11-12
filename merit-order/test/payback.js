#!/usr/bin/env node
// Are the plant page's maintenance estimates true? (v41) Plays a scenario with the steady test player
// to a checkpoint, then for a sample of plants forks the game: one copy overhauls, rebuilds or
// repowers the plant, the other doesn't, and both play on for D days making no decisions. The
// difference in cash, plus what the action cost, is what it really earned. That is compared with the
// estimate (Sim.maintenancePlan) and with each part of the estimate counted in full (Sim.wearGain with
// every GAIN_K at 1), and the parts are fitted to what happened: the fit is what GAIN_K should be.
//
//   node merit-order/test/payback.js [scenario@year,...] [samples per action] [days] > out.txt
//   node merit-order/test/payback.js --sum out1.txt out2.txt ...
//
// Checkpoints default to the Energy Transition at years 6, 10, 14 and 17 and each company scenario at
// years 2 and 4. A game clones exactly (saves are JSON; random streams live in S.rng), and since v41 a
// plant's breakdowns come from its own draw (plantRnd), so an action shifts no one else's luck: the
// only difference between the copies is the action and what it changes in the market (a rebuild keeps
// the old plant's draws, rkey). Rival proposals are frozen in both copies for the window: a day's
// prices can flip a rival's 300 MW decision, which would swamp what one plant's upkeep is worth. A
// control copy with no action checks all that (it must come out level to the cent).
const path = require('path'), fs = require('fs');
const Sim = require(path.join(__dirname, '..', 'sim.js'));
const { STRATS } = require(path.join(__dirname, 'balance.js'));
const IPD = Sim.IPD, PARTS = ['outW', 'outV', 'outS', 'vc', 'brk', 'up'];

if (process.argv[2] === '--sum') { summarise(process.argv.slice(3)); process.exit(0); }
const args = process.argv.slice(2);
const points = (args[0] || 'energy-transition@6,energy-transition@10,energy-transition@14,energy-transition@17,highcountry@2,lakeside@2,wellspring@2,coastline@2,highcountry@4,lakeside@4,wellspring@4,coastline@4').split(',');
const N = +(args[1] || 8), D = +(args[2] || 30);
const clone = S => Sim.migrate(JSON.parse(JSON.stringify(S)));
const kindOf = p => Sim.TECH[p.tech].kind;

function playTo(id, year) {   // the steady test player, to a few days into the year
  const S = Sim.createScenario(id), st = STRATS.steady, until = (year - 1) * Sim.yearDays(S) + 5;
  for (let d = 0; d < until && !Sim.scenarioOver(S); d++) {
    st.day(S, d);
    for (let k = 0; k < IPD && !Sim.scenarioOver(S); k++) {
      Sim.step(S);
      if (S.offer && S.offer !== S._seen) { S._seen = S.offer; st.offer(S); }
      if (S.choice) { const v = Sim.choiceView(S); Sim.choose(S, v.deflt); }
      if (S.proposal && st.proposal) st.proposal(S);
    }
  }
  return S;
}
function hold(S, days) {   // play on with no decisions of our own (offers and tenders declined, defaults chosen)
  const end = S.t + days * IPD;
  while (S.t < end && !Sim.scenarioOver(S)) {
    Sim.step(S);
    if (S.offer) Sim.declineOffer(S);
    if (S.choice) { const v = Sim.choiceView(S); Sim.choose(S, v.deflt); }
    if (S.tender && !S.tender.accepted && !S.tender.declined) Sim.declineTender(S);
  }
  return S;
}
// Each part of the estimate on its own, counted in full: output from less wear, from the newer design,
// from the bigger size; running cost; breakdowns; upkeep.
function parts(S, p, a) {
  const A = Sim.AGEING[p.tech], now = Sim.ageEffects(p), K = Sim.GAIN_K, keep = { ...K };
  const after = a === 'overhaul' ? Sim.effectsAt(A, (p.wear || 0) * Sim.OVERHAUL_KEEPS, p.age || 0) : Sim.effectsAt(A, 0, 0);
  const vint = a === 'overhaul' ? 1 : Sim.vintageNow(S, p.tech) / (p.vintage || 1), mw = a === 'repower' ? Sim.repowerMW(S, p) : p.mw;
  const g = k => { Object.assign(K, { out: 0, vint: 0, size: 0, vc: 0, brk: 0, up: 0 }, k); return Sim.wearGain(S, p, now, after, { vint, mw }); };
  const outW = g({ out: 1 }), outV = g({ out: 1, vint: 1 }) - outW, outS = g({ out: 1, vint: 1, size: 1 }) - outW - outV;
  const r = { outW, outV, outS, vc: g({ vc: 1 }), brk: g({ brk: 1 }), up: g({ up: 1 }) };
  Object.assign(K, keep);
  return r;
}
function act(S, p, a) {
  if (a === 'overhaul') return Sim.overhaul(S, p);
  return Sim.rebuild(S, p, a === 'repower' ? { mw: Sim.repowerMW(S, p) } : {});
}

for (const pt of points) {
  const [id, y] = pt.split('@'), S = playTo(id, +y);
  if (S.proposal) S.proposal.decideAt = 1e9; else S.proposal = { frozen: true, decideAt: 1e9 };   // no rival moves in the window (1e9: Infinity would not survive the JSON clone)
  const base = hold(clone(S), D);
  const ctl = hold(clone(S), D);
  console.log(JSON.stringify({ control: true, id, year: +y, diff: ctl.cash - base.cash, earnPerDay: S.days.slice(-7).reduce((a, d) => a + d.profit, 0) / 7, plants: S.plants.length }));
  const elig = S.plants.filter(p => p.status === 'online' && !p.replacedBy && Sim.AGEING[p.tech] && p.margin != null);
  const acts = { overhaul: p => !!Sim.AGEING[p.tech].oh && (p.wear || 0) >= 1, rebuild: p => !!Sim.rebuildCost(S, p), repower: p => !!Sim.repowerMW(S, p) };
  for (const [a, ok] of Object.entries(acts)) {
    const byTech = {};
    for (const p of elig.filter(ok).sort((x, z) => Sim.condition(z).wear - Sim.condition(x).wear)) (byTech[p.tech] ||= []).push(p);
    const pick = [], seen = new Set(), sig = p => `${p.tech}|${p.mw}|${p.site}|${p.wear}|${p.age}|${p.upg || ''}`;   // identical plants once
    for (const l of Object.values(byTech)) for (let i = l.length - 1; i >= 0; i--) { if (seen.has(sig(l[i]))) l.splice(i, 1); else seen.add(sig(l[i])); }
    while (pick.length < N && Object.values(byTech).some(l => l.length)) for (const l of Object.values(byTech)) if (l.length && pick.length < N) pick.push(l.shift());
    for (const p of pick) {
      const est = (Sim.maintenancePlan(S, p) || {})[a];
      if (!est || est.gain == null) continue;
      const pr = parts(S, p, a), T = clone(S), q = T.plants.find(x => x.id === p.id), r = act(T, q, a);
      if (!r.ok) continue;
      hold(T, D);
      const realised = T.cash - base.cash + r.cost;   // what the action earned over D days (its cost added back)
      console.log(JSON.stringify({ id, year: +y, a, tech: p.tech, kind: kindOf(p), wear: Sim.condition(p).wear, mw: p.mw, D, delay: est.delay, lost: est.lost, cost: r.cost, gain: est.gain, payback: est.payback, parts: pr, realised }));
    }
  }
}

function summarise(files) {
  const rows = files.flatMap(f => fs.readFileSync(f, 'utf8').split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l)));
  const ctl = rows.filter(r => r.control), S = rows.filter(r => !r.control);
  const fmt = x => (Math.abs(x) >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : Math.abs(x) >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : x.toFixed(0));
  console.log('Controls (a copy with no action must end level):');
  for (const n of ctl) console.log(`  ${n.id}@${n.year}: ${n.diff === 0 ? 'level' : 'OFF BY ' + fmt(n.diff)} (company earns ${fmt(n.earnPerDay)} a day, ${n.plants} plants)`);
  const per = r => r.D - r.delay, raw = r => PARTS.reduce((a, k) => a + r.parts[k], 0);
  const groups = {};
  for (const r of S) (groups[`${r.a} ${r.kind}`] ||= []).push(r);
  console.log('\nRealised against estimated, per day of gain (the estimate counts lost earnings separately):');
  for (const [g, rs] of Object.entries(groups)) {
    const real = rs.reduce((a, r) => a + r.realised + r.lost, 0), est = rs.reduce((a, r) => a + per(r) * r.gain, 0), full = rs.reduce((a, r) => a + per(r) * raw(r), 0);
    const med = rs.map(r => (r.realised + r.lost) / Math.max(1e-9, per(r) * r.gain)).sort((x, z) => x - z)[Math.floor(rs.length / 2)];
    console.log(`  ${g.padEnd(18)} n=${String(rs.length).padStart(3)}  realised/estimate ${(real / est).toFixed(2)} (median ${med.toFixed(2)})  realised/full ${(real / full).toFixed(2)}  realised ${fmt(real / rs.reduce((a, r) => a + per(r), 0))}/day`);
  }
  // Least squares: what each sample earned a day of gain = Σ factor × part − loss factor × the
  // estimated earnings lost while offline (per kind: wind and solar can't bank their energy; hydro and
  // gas can sell later). Then again without the worst tenth of residuals (spikes and luck).
  const KINDS = ['vre', 'thermal', 'storage'], NAMES = [...PARTS, ...KINDS.map(k => 'lost ' + k)];
  const X = S.map(r => [...PARTS.map(k => r.parts[k]), ...KINDS.map(k => r.kind === k ? -(r.lost || 0) / Math.max(1, per(r)) : 0)]), Y = S.map(r => r.realised / Math.max(1, per(r)));
  const solve = rows => {
    const idx = NAMES.map((k, j) => j).filter(j => rows.some(n => Math.abs(X[n][j]) > 1e-6)), m = idx.length;
    const A = idx.map(i => idx.map(j => rows.reduce((a, n) => a + X[n][i] * X[n][j], 0))), b = idx.map(i => rows.reduce((a, n) => a + X[n][i] * Y[n], 0));
    for (let c = 0; c < m; c++) {   // Gaussian elimination
      let p = c; for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < m; r++) if (r !== c && A[c][c]) { const q = A[r][c] / A[c][c]; for (let k = c; k < m; k++) A[r][k] -= q * A[c][k]; b[r] -= q * b[c]; }
    }
    const coef = new Array(NAMES.length).fill(null); idx.forEach((j, c) => { coef[j] = b[c] / A[c][c]; });
    return coef;
  };
  const all = S.map((r, n) => n), c1 = solve(all);
  const resid = all.map(n => Math.abs(Y[n] - X[n].reduce((a, x, j) => a + x * (c1[j] || 0), 0)));
  const cut = [...resid].sort((a, b) => a - b)[Math.floor(resid.length * 0.9)], c2 = solve(all.filter(n => resid[n] <= cut));
  console.log('\nFitted factors (what GAIN_K should be; out parts relative to full output; lost = share of the estimated loss that is real):');
  NAMES.forEach((k, j) => { if (c1[j] != null) console.log(`  ${k.padEnd(13)} ${c1[j].toFixed(2).padStart(6)}   without the worst tenth: ${c2[j] != null ? c2[j].toFixed(2) : '-'}`); });
  console.log(`  (current GAIN_K: ${JSON.stringify(Sim.GAIN_K)})`);
}
