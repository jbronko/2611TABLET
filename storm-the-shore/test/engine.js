#!/usr/bin/env node
// Engine checks for Storm the Shore (no browser): gate maths, the crowd's geometry, fights,
// payouts, upgrades and saves, and that every level is winnable by choosing well and lost by
// choosing badly.   node storm-the-shore/test/engine.js
const S = require('../sim.js');
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.log('FAIL', msg); } };

// gates
ok(S.apply('+', 8, 5) === 13 && S.apply('x', 2, 5) === 10 && S.apply('-', 3, 5) === 2 && S.apply('/', 2, 5) === 2, 'gate maths');
ok(S.opLabel('x', 3) === '×3' && S.opLabel('-', 4) === '−4' && S.opLabel('/', 2) === '÷2', 'gate labels');

// geometry
ok(Math.abs(S.discShare(0, 0.5, -1, 1) - 1) < 1e-9, 'a disc inside the band is all in it');
ok(Math.abs(S.discShare(0, 0.5, -1, 0) - 0.5) < 1e-9, 'half a disc either side of its centre');
ok(S.discShare(0.8, 0.1, -1, 0) === 0, 'a disc clear of the band is not in it');
ok(S.radius(1) < S.radius(50) && S.radius(10000) === 0.6, 'squads grow wider, up to a limit');

// levels are the same every time, and sorted up the beach
for (let n = 1; n <= 40; n++) {
  const a = S.makeLevel(n), b = S.makeLevel(n);
  ok(JSON.stringify(a) === JSON.stringify(b), `level ${n} is the same each time`);
  ok(a.objs.every((o, i) => i === 0 || o.z >= a.objs[i - 1].z), `level ${n} beats are in order`);
  ok(a.objs[a.objs.length - 1].type === 'bunker', `level ${n} ends at a bunker`);
  const g = a.objs.find(o => o.type === 'gate');
  ok(g && g === a.objs[0] && S.goodOp(g.left.op) && S.goodOp(g.right.op), `level ${n} opens with a fair gate`);
}

// winnable by choosing well, lost by choosing badly (no upgrades)
const fresh = S.freshSave();
for (let n = 1; n <= 40; n++) {
  const good = S.simulate(n, fresh, 'good'), bad = S.simulate(n, fresh, 'bad');
  ok(good.phase === 'won', `level ${n}: best gates win (got ${good.phase})`);
  ok(bad.phase === 'lost', `level ${n}: worst gates lose (got ${bad.phase})`);
  ok(good.coins > bad.coins, `level ${n}: a win pays more than a loss`);
}
// levels get longer and the bunker tougher
ok(S.makeLevel(15).objs.length > S.makeLevel(1).objs.length, 'later levels are longer');

// a fight: armour cuts losses
const fightWith = armour => {
  const save = S.freshSave(); save.up.armour = armour; save.up.squad = 10;
  const s = S.create(1, save);
  s.objs = [{ type: 'enemy', z: 5, n: 20, rem: 20 }, { type: 'bunker', z: 50, hp: 3, rem: 3 }];
  s.lvl = { ...s.lvl, end: 50, stepCost: 1 };
  while (s.phase !== 'won' && s.phase !== 'lost') S.step(s, 1 / 60);
  return s;
};
const plain = fightWith(0), armoured = fightWith(8);
ok(plain.phase === 'won' && armoured.phase === 'won', 'a 42-soldier squad beats 20 defenders');
ok(armoured.peak - armoured.steps - 3 >= plain.peak - plain.steps - 3 && armoured.steps >= plain.steps, 'armour keeps more soldiers alive');

// a gate that takes the last soldier loses the run
{
  const s = S.create(1, fresh);
  s.objs = [{ type: 'gate', z: 3, left: { op: '-', n: 5 }, right: { op: '-', n: 5 } }, { type: 'bunker', z: 50, hp: 3, rem: 3 }];
  while (s.phase === 'run') S.step(s, 1 / 60);
  ok(s.phase === 'lost' && s.n === 0, 'a minus gate can wipe out a small squad');
}
// walls hold the squad out
{
  const s = S.create(1, fresh);
  s.objs = [{ type: 'wall', z: 0, len: 40, x0: -1, x1: -0.3 }, { type: 'bunker', z: 80, hp: 1, rem: 1 }];
  s.targetX = -1;
  for (let i = 0; i < 120; i++) S.step(s, 1 / 60);
  ok(s.x >= -0.3 + S.radius(s.n) - 1e-9, 'sandbags keep the squad on the open side');
}
// pickups only join if you reach them
{
  const s = S.create(1, fresh);
  s.objs = [{ type: 'pickup', z: 5, x: 0.62, n: 7 }, { type: 'bunker', z: 80, hp: 1, rem: 1 }];
  s.targetX = -0.6;
  while (s.z < 10) S.step(s, 1 / 60);
  ok(s.n === 1, 'stragglers on the far side stay behind');
  const t = S.create(1, fresh);
  t.objs = [{ type: 'pickup', z: 5, x: 0.62, n: 7 }, { type: 'bunker', z: 80, hp: 1, rem: 1 }];
  t.targetX = 0.62;
  while (t.z < 10) S.step(t, 1 / 60);
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
  ok(c.level === 4 && c.coins === 0 && c.up.squad === 10 && c.up.armour === 0 && !('junk' in c), 'saves are cleaned');
  ok(S.cleanSave(null).level === 1, 'no save starts at level 1');
  const f = S.freshSave(), won = S.simulate(1, f, 'good');
  S.finish(f, won);
  ok(f.level === 2 && f.coins === won.coins && f.best === 1, 'a win opens the next level and banks coins');
  const f2 = S.freshSave(), lost = S.simulate(2, f2, 'bad');
  S.finish(f2, lost);
  ok(f2.level === 1 && f2.coins === lost.coins, 'a loss banks a few coins and opens nothing');
  // coin bonus
  const rich = S.freshSave(); rich.up.coins = 10;
  ok(S.simulate(1, rich, 'good').coins > S.simulate(1, S.freshSave(), 'good').coins, 'the war chest pays more');
}

console.log(fails ? `\n${fails} failed, ${passes} passed.` : `All ${passes} engine checks passed.`);
process.exit(fails ? 1 : 0);
