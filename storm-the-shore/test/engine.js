#!/usr/bin/env node
// Engine checks for Storm the Shore (no browser): gate maths, shooting, charging enemies, barrels,
// the crowd's geometry, payouts, upgrades and saves, and that every level is winnable with no
// upgrades by choosing well and lost by choosing badly.   node storm-the-shore/test/engine.js
const S = require('../sim.js');
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.log('FAIL', msg); } };
const fresh = S.freshSave();
// a hand-made level: objs plus a far-off bunker
// (no runners unless asked for, so each check sees only what it sets up)
const custom = (objs, save = fresh, hp = 3, runEvery = 1e9, last = { type: 'bunker', z: 400, hp }) => {
  const all = [...objs, last];
  return S.createFrom({ num: 1, title: 'test', d: 0, objs: all, end: last.z, hp: last.hp, stepCost: 1, runEvery, seed: 7 }, save);
};
const runUntil = (s, cond, max = 60 * 120) => { for (let i = 0; i < max && !cond(s) && s.phase !== 'won' && s.phase !== 'lost'; i++) S.step(s, 1 / 60); return s; };
const withSquad = n => { const v = S.freshSave(); v.up.squad = n; return v; };

// gates
ok(S.apply('+', 8, 5) === 13 && S.apply('x', 2, 5) === 10 && S.apply('-', 3, 5) === 2 && S.apply('/', 2, 5) === 2, 'gate maths');
ok(S.opLabel('x', 3) === '×3' && S.opLabel('-', 4) === '−4' && S.opLabel('/', 2) === '÷2', 'gate labels');
{
  const g = { op: '-', n: 2 }; S.raise(g); ok(g.op === '-' && g.n === 1, 'shooting −2 makes −1');
  S.raise(g); ok(g.op === '+' && g.n === 0, '−1 becomes +0'); S.raise(g); ok(g.op === '+' && g.n === 1, 'then +1');
  const m = { op: 'x', n: 2 }; S.raise(m); ok(m.op === 'x' && m.n === 2, '× gates don\'t change');
}

// geometry
ok(Math.abs(S.discShare(0, 0.5, -1, 1) - 1) < 1e-9, 'a disc inside the band is all in it');
ok(Math.abs(S.discShare(0, 0.5, -1, 0) - 0.5) < 1e-9, 'half a disc either side of its centre');
ok(S.discShare(0.8, 0.1, -1, 0) === 0, 'a disc clear of the band is not in it');
ok(S.radius(1) < S.radius(50) && S.radius(10000) === 0.6, 'squads grow wider, up to a limit');

// firepower
ok(S.dpsOf(20, 0) > S.dpsOf(5, 0) && S.dpsOf(5, 1) > S.dpsOf(5, 0) && S.dpsOf(5, 0, 1.3) > S.dpsOf(5, 0), 'more soldiers, better guns and upgrades all hit harder');

// shooting a gate raises it
{
  const s = custom([{ type: 'gate', z: 60, left: { op: '-', n: 3 }, right: { op: '-', n: 3 } }], withSquad(8));
  s.targetX = -0.5;
  runUntil(s, s => s.next > 0);
  ok(s.objs[0].left.op === '+' && s.objs[0].left.right === undefined, `shooting the −3 gate on the way in turns it positive (${S.opLabel(s.objs[0].left.op, s.objs[0].left.n)})`);
  ok(s.objs[0].right.op === '-' && s.objs[0].right.n === 3, 'the other side is untouched');
}

// enemy squads charge, and shots thin them out
{
  const s = custom([{ type: 'enemy', z: 120, n: 40, x0: -1, x1: 1 }], withSquad(10));
  runUntil(s, s => s.objs[0].awake);
  const at0 = s.objs[0].at;
  const t0 = s.t; runUntil(s, s => s.t > t0 + 1);
  ok(s.objs[0].at < at0 - 5, 'an enemy squad charges down the beach');
  ok(s.objs[0].rem < 40, `and the squad's fire kills some on the way (${s.objs[0].rem} left of 40)`);
  runUntil(s, s => s.phase === 'fight');
  ok(s.phase === 'fight' && s.fight.obj.type === 'enemy', 'the rest clash with the squad');
  runUntil(s, s => s.phase === 'run');
  ok(s.phase === 'run' && s.n > 0 && s.n < 42, 'the squad wins the clash with losses');
}
{
  // a big squad shoots a small charge down before it arrives
  const s = custom([{ type: 'enemy', z: 120, n: 10, x0: -1, x1: 1 }], withSquad(10));
  runUntil(s, s => s.z > 140);
  ok(s.objs[0].rem === 0 && s.n === 42, 'a small charge is shot down before it reaches a big squad');
}
{
  // a half-width charge can be dodged
  const s = custom([{ type: 'enemy', z: 120, n: 400, x0: -1, x1: 0 }]);
  s.targetX = 0.6;
  runUntil(s, s => s.z > 140);
  ok(s.phase === 'run' && s.n === 1 && s.objs[0].gone, 'stepping aside lets a half-width charge run past');
}

// barrels
{
  const reward = { kind: 'gun' };
  const s = custom([{ type: 'barrel', z: 50, x0: 0.05, x1: 0.95, hp: 8, reward }], withSquad(6));
  s.targetX = 0.5;
  runUntil(s, s => s.objs[0].rem <= 0 || s.next > 0);
  ok(s.objs[0].rem <= 0 && s.weapon === 1 && s.n === 20, 'shooting a barrel open gives its weapon');
  const t = custom([{ type: 'barrel', z: 20, x0: 0.05, x1: 0.95, hp: 30, reward }]);
  t.targetX = 0.5;
  runUntil(t, t => t.next > 0);
  ok(t.phase === 'lost' && t.weapon === 0, 'running into an unbroken barrel costs soldiers, and no weapon');
  const m = custom([{ type: 'barrel', z: 50, x0: 0.05, x1: 0.95, hp: 4, reward: { kind: 'men', n: 9 } }], withSquad(2));
  m.targetX = 0.5; runUntil(m, m => m.next > 0);
  ok(m.n === 14, 'a soldiers barrel adds its soldiers');
  const c = custom([{ type: 'barrel', z: 50, x0: -0.95, x1: -0.05, hp: 4, reward: { kind: 'coins', n: 30 } }], withSquad(2));
  c.targetX = -0.5; runUntil(c, c => c.next > 0);
  ok(c.bonus === 30, 'a coins barrel adds to the payout');
  const w = custom([{ type: 'barrel', z: 50, x0: -0.95, x1: -0.05, hp: 4, reward }], withSquad(2));
  w.targetX = 0.5; runUntil(w, w => w.next > 0);
  ok(w.objs[0].rem === 4 && w.n === 5, 'a barrel on the other side is left alone');
  const top = custom([], withSquad(2)); top.weapon = S.WEAPONS.length - 1;
  top.objs.unshift({ type: 'barrel', z: 50, x0: -0.95, x1: 0.95, hp: 1, rem: 1, reward });
  runUntil(top, s => s.objs[0].rem <= 0);
  ok(top.weapon === S.WEAPONS.length - 1, 'weapons stop at Rockets');
}

// Rockets splash: the same squad clears a crowd faster with them, and the page hears about each blast
{
  const crowd = weapon => {
    const s = custom([{ type: 'enemy', z: 75, n: 400, x0: -1, x1: 1 }], withSquad(4));
    s.weapon = weapon;
    let blasts = 0;
    for (let i = 0; i < 60 * 4 && s.phase === 'run'; i++) { S.step(s, 1 / 60); blasts += s.events.filter(e => e.kind === 'splash').length; s.events.length = 0; }
    return { killed: 400 - s.objs[0].rem, blasts, kills: s.kills };
  };
  const heavy = crowd(S.ROCKETS - 1), rockets = crowd(S.ROCKETS);
  const plain = S.dpsOf(20, S.ROCKETS) / S.dpsOf(20, S.ROCKETS - 1);
  ok(rockets.blasts > 0 && heavy.blasts === 0, `only Rockets splash (${rockets.blasts} blasts)`);
  ok(rockets.killed > heavy.killed * plain * 1.25, `the splash takes extra enemies (${rockets.killed} vs ${heavy.killed} with the Heavy MG)`);
  ok(rockets.kills === rockets.killed, 'every splash kill counts and pays');
  // a splash with nothing left in the target spills onto a runner group close by
  const s = custom([], withSquad(4)); s.weapon = S.ROCKETS; s.splash = 0.9;
  s.runners.push({ id: 1, x: 0, at: 20, rem: 1, n: 1 }, { id: 2, x: 0.1, at: 22, rem: 5, n: 5 });
  for (let i = 0; i < 30 && s.kills === 0; i++) S.step(s, 1 / 60);
  const next = s.runners.find(u => u.id === 2);
  ok(s.kills === 2 && next && next.rem === 4,'a splash spills onto the runners next to the one it killed');
}

// runners keep coming, get shot, and pay coins
{
  const s = custom([], withSquad(6), 3, 0.6);
  runUntil(s, s => s.t > 8);
  ok(s.kills > 5 && s.bonus > 1, `runners keep coming and are shot down for coins (${s.kills} kills)`);
  const t = custom([], withSquad(1));
  t.runners.push({ id: 1, x: 0, at: 4, rem: 3, n: 3 });
  runUntil(t, t => t.t > 0.3);
  ok(t.n < 3, 'runners that reach the squad cut into it');
}
// brutes: smash if not stopped, die if shot
{
  const s = custom([{ type: 'brute', z: 80, x: 0, hp: 90 }], withSquad(10));
  runUntil(s, s => s.objs[0].gone);
  ok(s.objs[0].gone && s.n < 42 && s.phase === 'run', `an unstopped brute smashes into the squad (${s.n} of 42 left)`);
  const t = custom([{ type: 'brute', z: 80, x: 0, hp: 8 }], withSquad(10));
  runUntil(t, t => t.objs[0].rem <= 0 || t.objs[0].gone);
  ok(t.objs[0].rem === 0 && t.n === 42 && t.kills === 1 && t.bonus >= 1.5, 'a brute shot down pays well and hurts no one');
}
// the boss: every third level, and he can be shot down before he arrives
{
  ok(S.makeLevel(3).boss && S.makeLevel(3).objs.at(-1).boss && !S.makeLevel(4).boss, 'every third level ends with a boss');
  const s = custom([], withSquad(10), 0, 1e9, { type: 'bunker', boss: true, z: 120, hp: 30 });
  let fought = false;
  runUntil(s, s => { if (s.phase === 'fight') fought = true; return s.phase === 'climb'; });
  ok(s.phase === 'climb' && !fought && s.n === 42, 'a strong squad shoots the boss down before he reaches it');
  const t = custom([], withSquad(1), 0, 1e9, { type: 'bunker', boss: true, z: 120, hp: 200 });
  runUntil(t, t => t.phase === 'fight');
  ok(t.phase === 'fight' && t.fight.obj.boss, 'a weak squad has to swarm him');
}
// boom barrels blow up what's near them
{
  const s = custom([{ type: 'barrel', z: 60, x0: 0.05, x1: 0.95, hp: 2, reward: { kind: 'boom' } }, { type: 'enemy', z: 70, n: 15, x0: -1, x1: 1 }], withSquad(4));
  s.targetX = 0.5;
  runUntil(s, s => s.objs[0].rem <= 0);
  ok(s.objs[0].rem <= 0 && s.objs[1].rem === 0 && s.kills >= 15, `a boom barrel wipes out the squad behind it (${s.kills} kills)`);
}
// FIRE gates
{
  const s = custom([{ type: 'gate', z: 60, left: { op: 'f', n: 20 }, right: { op: 'f', n: 20 } }], withSquad(6));
  s.targetX = -0.5;
  runUntil(s, s => s.next > 0);
  ok(s.objs[0].left.n > 20 && s.objs[0].right.n === 20, `shooting a FIRE gate raises it (${S.opLabel('f', s.objs[0].left.n)})`);
  ok(Math.abs(s.fire - (1 + s.objs[0].left.n / 100)) < 1e-9 && s.n === 20, 'running through it speeds up the squad\'s fire, not its size');
  ok(S.opLabel('f', 25) === 'FIRE +25%', 'fire gates say what they do');
}
// no dead time: in careful play there is always something to shoot
for (let n = 1; n <= 15; n++) {
  const s = S.create(n, fresh);
  let gap = 0, worst = 0;
  for (let i = 0; i < 60 * 600 && s.phase !== 'won' && s.phase !== 'lost'; i++) {
    s.targetX = S.autopilot(s, 'good'); S.step(s, 1 / 60); s.events.length = 0;
    if (s.phase === 'run' && s.z > 40) { gap = s.aim ? 0 : gap + 1 / 60; worst = Math.max(worst, gap); }
  }
  ok(worst <= 1.8, `level ${n}: never more than a moment without a target (longest ${worst.toFixed(1)} s)`);
}

// levels are the same every time, and sorted up the beach
for (let n = 1; n <= 40; n++) {
  const a = S.makeLevel(n);
  ok(a.objs.every((o, i) => i === 0 || o.z >= a.objs[i - 1].z), `level ${n} beats are in order`);
  ok(a.objs[a.objs.length - 1].type === 'bunker' && a.hp > 0 && a.hp < 1e8, `level ${n} ends at a real bunker`);
  const g = a.objs[0];
  ok(g.type === 'gate' && S.goodOp(g.left.op) && S.goodOp(g.right.op), `level ${n} opens with a fair gate`);
}
ok(S.makeLevel(1).objs.some(o => o.type === 'enemy') && S.makeLevel(1).objs.some(o => o.type === 'barrel'), 'level 1 has a charge and a barrel');
ok(S.makeLevel(4).objs.some(o => o.type === 'brute'), 'brutes arrive by level 4');
ok(S.makeLevel(15).objs.length > S.makeLevel(1).objs.length, 'later levels are longer');

// fair play: every level is won with no upgrades by playing well, and lost by playing badly
for (let n = 1; n <= 40; n++) {
  const good = S.simulate(n, fresh, 'good'), bad = S.simulate(n, fresh, 'bad');
  ok(good.phase === 'won', `level ${n}: careful play wins with no upgrades (got ${good.phase})`);
  ok(bad.phase === 'lost', `level ${n}: careless play loses (got ${bad.phase})`);
  ok(good.coins > bad.coins && bad.coins > 0, `level ${n}: a win pays more than a loss, and a loss still pays`);
}
// coins earned by playing the first 15 levels once buy a good share of the shop
{
  let earned = 0; for (let n = 1; n <= 15; n++) earned += S.simulate(n, fresh, 'good').coins;
  let shop = 0; for (const [k, u] of Object.entries(S.UPGRADES)) for (let l = 0; l < u.max; l++) shop += S.upgradeCost(k, l);
  ok(earned > 1500, `the first 15 levels pay a useful amount (${earned} coins)`);
  console.log(`  (first 15 levels pay ${earned} coins; the whole shop costs ${shop})`);
}

// armour cuts losses in a clash
const clash = armour => {
  const save = withSquad(10); save.up.armour = armour;
  const s = custom([{ type: 'enemy', z: 70, n: 80, x0: -1, x1: 1 }], save);
  runUntil(s, s => s.phase === 'fight'); runUntil(s, s => s.phase === 'run');
  return s.n;
};
ok(clash(8) > clash(0), 'helmets keep more soldiers alive');

// a gate that takes the last soldier loses the run
{
  const s = custom([{ type: 'gate', z: 3, left: { op: '/', n: 5 }, right: { op: '/', n: 5 } }]);
  runUntil(s, s => s.next > 0);
  ok(s.phase === 'lost' && s.n === 0, 'a ÷ gate can wipe out a lone soldier');
}
// walls hold the squad out
{
  const s = custom([{ type: 'wall', z: 0, len: 40, x0: -1, x1: -0.3 }]);
  s.targetX = -1;
  runUntil(s, s => s.t > 2);
  ok(s.x >= -0.3 + S.radius(s.n) - 1e-9, 'sandbags keep the squad on the open side');
}
// pickups only join if you reach them
{
  const s = custom([{ type: 'pickup', z: 5, x: 0.62, n: 7 }]);
  s.targetX = -0.6; runUntil(s, s => s.z > 10);
  ok(s.n === 1, 'stragglers on the far side stay behind');
  const t = custom([{ type: 'pickup', z: 5, x: 0.62, n: 7 }]);
  t.targetX = 0.62; runUntil(t, t => t.z > 10);
  ok(t.n === 8, 'stragglers you run through join the squad');
}

// upgrades and saves
{
  const save = S.freshSave();
  ok(!S.buy(save, 'squad'), 'no coins, no upgrade');
  save.coins = 1000;
  const cost = S.upgradeCost('squad', 0);
  ok(S.buy(save, 'squad') && save.up.squad === 1 && save.coins === 1000 - cost, 'buying takes the price');
  ok(S.upgradeCost('squad', 1) > cost, 'prices rise');
  ok(S.create(1, save).n === 3, 'a bigger landing party starts bigger');
  save.up.squad = 10; ok(S.upgradeCost('squad', 10) === null && !S.buy(save, 'squad'), 'maxed upgrades stop');
  const c = S.cleanSave({ level: 4, coins: -5, up: { squad: 99, armour: 'x' }, junk: 1 });
  ok(c.level === 4 && c.coins === 0 && c.up.squad === 10 && c.up.armour === 0 && c.up.guns === 0 && !('junk' in c), 'saves are cleaned (and old saves gain the new upgrade)');
  ok(S.cleanSave(null).level === 1, 'no save starts at level 1');
  const f = S.freshSave(), won = S.simulate(1, f, 'good');
  S.finish(f, won);
  ok(f.level === 2 && f.coins === won.coins && f.best === 1, 'a win opens the next level and banks coins');
  const f2 = S.freshSave(), lost = S.simulate(2, f2, 'bad');
  S.finish(f2, lost);
  ok(f2.level === 1 && f2.coins === lost.coins, 'a loss banks a few coins and opens nothing');
  const rich = S.freshSave(); rich.up.coins = 10;
  ok(S.simulate(1, rich, 'good').coins > S.simulate(1, S.freshSave(), 'good').coins, 'the war chest pays more');
  const gun = S.freshSave(); gun.up.guns = 10;
  ok(S.create(1, gun).guns > S.create(1, S.freshSave()).guns, 'better rifles raise damage');
}

console.log(fails ? `\n${fails} failed, ${passes} passed.` : `All ${passes} engine checks passed.`);
process.exit(fails ? 1 : 0);
