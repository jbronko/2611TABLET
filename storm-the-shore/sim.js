// Storm the Shore: the game engine. No DOM here; the page and the tests both use it.
// The squad runs up a beach lane on its own and fires straight ahead at whatever is in its column,
// so steering is choosing a target: the enemies pouring down the beach (each kill pays coins),
// a barrel holding a new weapon, or a gate to shoot up before you run through it.
// Lane coordinates: x runs from -1 (left edge) to 1 (right edge); z is the distance up the beach.
//
// Fair play, by design: one currency (coins) earned only by playing, no timers, energy, ads or
// random draws for rewards, and every level is checked (test/engine.js) to be winnable with no upgrades.
/* exported Shore */
const Shore = (() => {
  'use strict';

  const SPEED = 16;          // forward speed, lane z units per second
  const SIDE_SPEED = 3.2;    // fastest sideways move, lane widths (x units) per second
  const FIGHT_TIME = 0.75;   // seconds a clash with an enemy squad lasts (more for big ones)
  const LADDER_STEPS = 8;    // multiplier steps past the end: ×1.5 … ×5
  const RANGE = 40;          // how far ahead the squad's shots reach
  const FOE_SPEED = 7;       // enemy squads' charge
  const RUNNER_SPEED = 11;   // the runners that keep coming
  const BRUTE_SPEED = 4;
  const BOSS_SPEED = 2.5;
  const WAKE = 62;           // enemies start their charge when you're this close
  const GATE_COST = 3;       // damage that raises a gate side one step
  const BUNKER_COST = 3;     // damage that knocks one HP off a bunker from range (a boss takes 1)
  const KILL_COIN = 0.25;    // coins per enemy shot down
  const STORE = 'storm-the-shore';

  const WEAPONS = ['Rifle', 'SMG', 'Machine gun', 'Heavy MG', 'Rockets'];
  const ROCKETS = WEAPONS.length - 1;
  const SPLASH = 0.4;        // with Rockets, each kill on a crowd adds this much to a splash meter;
                             // every time it fills, the blast takes one more enemy nearby

  // ---- random numbers (seeded, so every level is the same each time) ----
  const rng = seed => () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const pick = (r, list) => list[Math.floor(r() * list.length)];
  const between = (r, a, b) => a + Math.floor(r() * (b - a + 1));

  // ---- upgrades: a small, finite shop, all bought with coins earned in play ----
  const UPGRADES = {
    squad: { name: 'Bigger landing party', blurb: 'More soldiers step off the landing craft.', max: 10, base: 30,
             value: l => [1, 3, 5, 8, 12, 16, 20, 25, 30, 36, 42][l], show: v => `${v} to start` },
    guns: { name: 'Better rifles', blurb: 'Every soldier hits harder.', max: 10, base: 35,
             value: l => 1 + 0.15 * l, show: v => `+${Math.round((v - 1) * 100)}% damage` },
    armour: { name: 'Helmets and flak', blurb: 'Lose fewer soldiers when enemies reach you.', max: 8, base: 50,
             value: l => 0.06 * l, show: v => `${Math.round(v * 100)}% fewer losses` },
    coins: { name: 'War chest', blurb: 'Earn more coins from every level.', max: 10, base: 40,
             value: l => 1 + 0.1 * l, show: v => `+${Math.round((v - 1) * 100)}% coins` },
  };
  const upgradeCost = (key, level) => level >= UPGRADES[key].max ? null : Math.round(UPGRADES[key].base * Math.pow(1.4, level) / 5) * 5;

  // ---- saved progress ----
  const freshSave = () => ({ level: 1, best: 0, coins: 0, up: { squad: 0, guns: 0, armour: 0, coins: 0 } });
  const cleanSave = d => {
    const s = freshSave();
    if (!d || typeof d !== 'object') return s;
    if (Number.isFinite(d.level) && d.level >= 1) s.level = Math.floor(d.level);
    if (Number.isFinite(d.best) && d.best >= 0) s.best = Math.floor(d.best);
    if (Number.isFinite(d.coins) && d.coins >= 0) s.coins = Math.floor(d.coins);
    for (const k of Object.keys(UPGRADES)) {
      const v = d.up && d.up[k];
      if (Number.isFinite(v)) s.up[k] = Math.max(0, Math.min(UPGRADES[k].max, Math.floor(v)));
    }
    return s;
  };
  const buy = (save, key) => {
    const cost = upgradeCost(key, save.up[key]);
    if (cost == null || save.coins < cost) return false;
    save.coins -= cost; save.up[key]++;
    return true;
  };

  // ---- gates ----
  // '+', '-', 'x', '/' change the squad; 'f' raises its rate of fire by n percent.
  const apply = (op, a, n) => {
    if (op === '+') return n + a;
    if (op === '-') return n - a;
    if (op === 'x') return n * a;
    if (op === 'f') return n;
    return Math.floor(n / a);   // '/'
  };
  const goodOp = op => op === '+' || op === 'x' || op === 'f';
  const opLabel = (op, a) => op === 'f' ? `FIRE +${a}%` : ({ '+': '+', '-': '−', x: '×', '/': '÷' })[op] + a;
  // Shooting a gate side raises it: −3 → −2 → −1 → +0 → +1 …, FIRE +20% → +25% …
  const raisable = side => side.op === '+' || side.op === '-' || side.op === 'f';
  const raise = side => {
    if (side.op === '+') side.n++;
    else if (side.op === 'f') side.n = Math.min(100, side.n + 5);
    else if (side.op === '-') { side.n--; if (side.n <= 0) { side.op = '+'; side.n = -side.n; } }
  };
  // How a careful player weighs a gate side, in soldiers.
  const worth = (side, n) => side.op === 'f' ? n * (1 + side.n / 100 * 0.45) : apply(side.op, side.n, n);

  // ---- firepower ----
  const dpsOf = (n, weapon, guns = 1, fire = 1) => 1.4 * Math.pow(Math.max(0, n), 0.7) * Math.pow(1.6, weapon) * guns * fire;

  // ---- crowd geometry ----
  const radius = n => Math.min(0.6, 0.075 * Math.sqrt(Math.max(1, n)));
  // Share of a disc (centre cx, radius R) lying between x0 and x1.
  function discShare(cx, R, x0, x1) {
    const F = x => {   // area of the unit disc left of x (x in -1..1), divided by π
      const t = Math.max(-1, Math.min(1, x));
      return (t * Math.sqrt(1 - t * t) + Math.asin(t)) / Math.PI + 0.5;
    };
    return Math.max(0, F((x1 - cx) / R) - F((x0 - cx) / R));
  }
  const overlaps = (cx, R, x0, x1) => cx + R > x0 && cx - R < x1;

  // ---- levels ----
  // Levels 1–15 are tuned through this table (what each brings in, how long, how hard); later ones
  // follow a formula. Every third level ends with a boss instead of a bunker. The layout is then
  // played by a careful and a careless autopilot, and the enemies and the final defence are set so
  // the careful one (with no upgrades) wins and the careless one loses.
  const LEVELS = [
    { beats: 7, d: 0.00, f: ['gate', 'barrel', 'enemy'], intro: ['barrel', 'enemy'], title: 'First wave' },
    { beats: 8, d: 0.05, f: ['gate', 'enemy', 'barrel', 'pickup'], intro: ['enemy', 'pickup'], title: 'Contact' },
    { beats: 8, d: 0.10, f: ['gate', 'enemy', 'barrel', 'pickup', 'fire'], intro: ['gate'], title: 'Big one' },
    { beats: 9, d: 0.15, f: ['gate', 'enemy', 'barrel', 'wire', 'brute', 'fire'], intro: ['brute', 'wire'], title: 'Brutes' },
    { beats: 9, d: 0.20, f: ['gate', 'enemy', 'barrel', 'brute', 'pickup', 'fire', 'boom', 'bad'], intro: ['barrel'], title: 'Wrong turns' },
    { beats: 10, d: 0.25, f: ['gate', 'enemy', 'barrel', 'brute', 'mines', 'fire', 'boom', 'bad'], intro: ['mines'], title: 'Minefield' },
    { beats: 10, d: 0.30, f: ['gate', 'enemy', 'barrel', 'brute', 'wall', 'wire', 'fire', 'boom', 'bad'], intro: ['wall'], title: 'Sandbags' },
    { beats: 11, d: 0.35, f: ['gate', 'enemy', 'barrel', 'brute', 'wire', 'mines', 'pickup', 'fire', 'boom', 'bad'], title: 'Second wave' },
    { beats: 11, d: 0.40, f: ['gate', 'enemy', 'barrel', 'brute', 'wall', 'mines', 'pickup', 'fire', 'boom', 'bad'], title: 'Dunes' },
    { beats: 12, d: 0.45, f: ['gate', 'enemy', 'barrel', 'brute', 'wire', 'wall', 'pickup', 'fire', 'boom', 'bad'], title: 'Seawall' },
    { beats: 12, d: 0.50, f: ['gate', 'enemy', 'barrel', 'brute', 'wire', 'mines', 'wall', 'fire', 'boom', 'bad'], title: 'Crossfire' },
    { beats: 13, d: 0.55, f: ['gate', 'enemy', 'barrel', 'brute', 'wire', 'mines', 'wall', 'pickup', 'fire', 'boom', 'bad'], title: 'Hedgehogs' },
    { beats: 13, d: 0.60, f: ['gate', 'enemy', 'barrel', 'brute', 'wire', 'mines', 'wall', 'pickup', 'fire', 'boom', 'bad'], title: 'The draw' },
    { beats: 14, d: 0.65, f: ['gate', 'enemy', 'barrel', 'brute', 'wire', 'mines', 'wall', 'pickup', 'fire', 'boom', 'bad'], title: 'Gun line' },
    { beats: 14, d: 0.70, f: ['gate', 'enemy', 'barrel', 'brute', 'wire', 'mines', 'wall', 'pickup', 'fire', 'boom', 'bad'], title: 'High ground' },
  ];
  const ALL = ['gate', 'enemy', 'barrel', 'brute', 'wire', 'mines', 'wall', 'pickup', 'fire', 'boom', 'bad'];
  const levelSpec = num => num <= LEVELS.length ? LEVELS[num - 1]
    : { beats: Math.min(18, 14 + Math.floor((num - 15) / 4)), d: Math.min(0.9, 0.7 + (num - 15) * 0.01), f: ALL, title: `Push ${num - 15}` };
  const isBoss = num => num % 3 === 0;
  const runEvery = d => 1.0 - 0.45 * d;   // seconds between bursts of runners

  // Two choices at a gate. The good one is what a best-playing squad takes; the other is sometimes
  // close (a real decision), sometimes a fire-rate gate, sometimes bad.
  function gatePair(r, est, d, f) {
    const adds = Math.max(3, Math.round(est * (0.5 + r() * 0.7)));
    const good = est < 6 ? pick(r, [['+', between(r, 4, 9)], ['x', 2], ['+', between(r, 5, 10)]])
      : est > 260 ? ['+', Math.round(est * 0.3)]
      : pick(r, [['x', 2], ['+', adds], ['x', est < 60 ? 3 : 2], ['+', adds]]);
    let other;
    const roll = r();
    if (f.includes('fire') && roll < 0.3) other = ['f', 10 + 5 * between(r, 1, 4)];
    else if (f.includes('bad') && est >= 6 && roll < 0.3 + 0.4 * (0.35 + 0.4 * d)) {
      other = pick(r, [['-', Math.max(2, Math.round(est * (0.3 + r() * 0.4)))], ['/', 2], ['/', 3]]);
    } else {
      const g = apply(good[0], good[1], est);
      other = good[0] === 'x' ? ['+', Math.max(1, Math.round((g - est) * (0.45 + r() * 0.35)))] : ['x', 2];
      if (apply(other[0], other[1], est) >= g) other = ['+', Math.max(1, Math.round((g - est) * 0.5))];
    }
    return r() < 0.5 ? [good, other] : [other, good];
  }

  // Lay out a level. `foeScale` shrinks the enemies when calibration finds them too strong.
  function layout(num, attempt, foeScale) {
    const spec = levelSpec(num), r = rng(num * 7919 + 13 + attempt * 104729), d = spec.d, f = spec.f;
    const objs = [];
    let z = 70, est = 1, weapon = 0, prev = '', guns = 0;
    const intro = (spec.intro || []).slice();
    const wakeTime = WAKE / (SPEED + FOE_SPEED);
    for (let i = 0; i < spec.beats; i++) {
      let kind;
      if (i === 0) kind = 'gate';
      else if (intro.length) kind = intro.shift();
      else {
        const pool = f.filter(k => !['bad', 'fire', 'boom'].includes(k) && k !== prev && !(k === 'enemy' && est < 6));
        const roll = r();
        kind = roll < 0.26 ? 'gate'
          : roll < 0.46 && pool.includes('barrel') ? 'barrel'
          : roll < 0.62 && pool.includes('enemy') ? 'enemy'
          : pick(r, pool);
        if (i === spec.beats - 1 && f.includes('enemy') && est >= 6) kind = 'enemy';
      }
      if ((kind === 'enemy' || kind === 'brute') && est < 4) kind = 'gate';
      let spaced = 44;
      if (kind === 'gate') {
        const [L, R] = gatePair(r, est, d, f);
        objs.push({ type: 'gate', z, left: { op: L[0], n: L[1] }, right: { op: R[0], n: R[1] } });
        est = Math.max(apply(L[0], L[1], est), apply(R[0], R[1], est));
        spaced = 40;
      } else if (kind === 'enemy') {
        // what the squad shoots on the way in, plus a real clash
        const shot = dpsOf(est, weapon) * wakeTime * 0.6;
        const n = Math.max(3, Math.round((shot + est * (0.3 + 0.35 * d + r() * 0.1)) * foeScale));
        const half = r() < 0.4 - 0.25 * d, left = r() < 0.5;
        objs.push({ type: 'enemy', z, n, x0: half && !left ? 0 : -1, x1: half && left ? 0 : 1 });
        est = Math.max(1, est - Math.round(n - shot));
        spaced = 56;
      } else if (kind === 'brute') {
        const hp = Math.max(6, Math.round(dpsOf(est, weapon) * (1.6 + 1.2 * d) * foeScale));
        objs.push({ type: 'brute', z, x: pick(r, [-0.5, 0, 0.5]), hp });
        spaced = 50;
      } else if (kind === 'pickup') {
        const n = Math.max(3, Math.round(3 + est * (0.15 + r() * 0.15)));
        objs.push({ type: 'pickup', z, x: pick(r, [-0.62, 0.62]), n });
        est += n;
      } else if (kind === 'barrel') {
        // a drum stack on one half: shoot it open for a weapon, soldiers, coins, or a big bang
        const left = r() < 0.5;
        const roll = r();
        const reward = weapon < WEAPONS.length - 1 && (guns === 0 || roll < 0.4) ? { kind: 'gun' }
          : f.includes('boom') && roll < 0.65 ? { kind: 'boom' }
          : roll < 0.85 ? { kind: 'men', n: Math.max(3, Math.round(3 + est * 0.25)) } : { kind: 'coins', n: 15 + num * 3 };
        const hp = Math.max(2, Math.round(dpsOf(est, weapon) * (0.9 + 0.8 * d)));
        objs.push({ type: 'barrel', z, x0: left ? -0.95 : 0.05, x1: left ? -0.05 : 0.95, hp, reward });
        if (reward.kind === 'gun') { weapon++; guns++; }
        if (reward.kind === 'men') est += reward.n;
        if (reward.kind === 'boom') {
          // a boom barrel comes with something worth blowing up
          const n = Math.max(4, Math.round(est * 0.4 * foeScale));
          objs.push({ type: 'enemy', z: z + 12, n, x0: -1, x1: 1 });
          spaced = 58;
        }
      } else if (kind === 'wire' || kind === 'mines') {
        const span = 0.85 + r() * 0.35 * (0.5 + d), left = r() < 0.5;
        const x0 = left ? -1 : 1 - span, x1 = left ? -1 + span : 1;
        if (kind === 'wire') objs.push({ type: 'wire', z, x0, x1 });
        else {
          const mines = [];
          for (let m = 0; m < 4 + Math.round(d * 4); m++) mines.push({ x: x0 + 0.08 + r() * (x1 - x0 - 0.16), dz: r() * 10 });
          objs.push({ type: 'mines', z, x0, x1, mines });
        }
        const R = radius(est);
        let share = 1;
        for (let x = -1 + R; x <= 1 - R + 1e-9; x += 0.02) share = Math.min(share, discShare(x, R, x0, x1));
        est -= Math.round(est * share * (kind === 'mines' ? 0.8 : 1));
      } else if (kind === 'wall') {
        // sandbags along one side, then a gate pair whose better side is behind them
        const left = r() < 0.5, w = 0.55 + r() * 0.2, len = 26;
        objs.push({ type: 'wall', z, len, x0: left ? -1 : 1 - w, x1: left ? -1 + w : 1 });
        const [A, B] = gatePair(r, est, d, f.filter(k => k !== 'fire').concat('bad'));
        const goodA = apply(A[0], A[1], est) >= apply(B[0], B[1], est);
        const best = goodA ? A : B, other = goodA ? B : A;
        const [L, R] = left ? [best, other] : [other, best];
        z += len + 24;
        objs.push({ type: 'gate', z, left: { op: L[0], n: L[1] }, right: { op: R[0], n: R[1] } });
        est = apply(best[0], best[1], est);
        spaced = 40;
      }
      prev = kind;
      z += spaced;
    }
    z += 16;
    const boss = isBoss(num);
    objs.push({ type: 'bunker', boss, z: boss ? z + 30 : z, hp: 1e9 });
    objs.sort((a, b) => a.z - b.z);
    return { num, title: spec.title, d, boss, objs, end: objs[objs.length - 1].z, hp: 1e9, stepCost: 1, runEvery: runEvery(d), seed: num * 977 + attempt };
  }

  // Run a layout with an autopilot. With stopAtEnd, stop as the final assault begins.
  function runLevel(lvl, save, mode, stopAtEnd) {
    const s = createFrom(lvl, save);
    for (let i = 0; i < 60 * 600 && s.phase !== 'won' && s.phase !== 'lost'; i++) {
      s.targetX = autopilot(s, mode);
      step(s, 1 / 60);
      s.events.length = 0;
      if (stopAtEnd && s.phase === 'fight' && s.fight.obj.type === 'bunker') break;
    }
    return s;
  }

  const cache = new Map();
  function makeLevel(num) {
    if (cache.has(num)) return cache.get(num);
    const fresh = freshSave();
    let lvl = null, fallback = null;
    for (let attempt = 0; attempt < 12 && !lvl; attempt++) {
      let L, good;
      for (let scale = 1, k = 0; k < 8; k++, scale *= 0.8) {
        L = layout(num, attempt, scale);
        good = runLevel(L, fresh, 'good', true);
        if (good.phase === 'fight') break;
      }
      if (good.phase !== 'fight') continue;
      const bad = runLevel(L, fresh, 'bad', true);
      const at = s => s.phase === 'fight' ? { n: s.n, shot: 1e9 - s.fight.obj.rem } : { n: 0, shot: 0 };
      const g = at(good), b = at(bad);
      // good must win: hp - g.shot < g.n; bad must lose: hp - b.shot >= b.n
      let hp = g.shot + Math.max(3, Math.round(g.n * (0.5 + 0.3 * L.d)));
      hp = Math.max(hp, b.shot + b.n);
      if (hp - g.shot >= g.n) { if (!fallback) fallback = { L, hp: g.shot + Math.max(1, g.n - 1), g }; continue; }
      lvl = { L, hp, g };
    }
    lvl = lvl || fallback;
    const { L, hp, g } = lvl;
    L.objs[L.objs.length - 1].hp = hp; L.hp = hp;
    L.stepCost = Math.max(1, Math.ceil(g.n * 0.05));
    cache.set(num, L);
    return L;
  }

  // ---- a run ----
  function createFrom(lvl, save) {
    const s0 = cleanSave(save);
    const start = UPGRADES.squad.value(s0.up.squad);
    const objs = lvl.objs.map(o => {
      const c = JSON.parse(JSON.stringify(o));
      c.hit = false;
      c.rem = o.type === 'enemy' ? o.n : o.hp || 0;
      if (o.type === 'enemy' || o.type === 'brute' || o.boss) { c.at = o.z; c.awake = false; c.gone = false; }
      return c;
    });
    return {
      num: lvl.num, lvl, objs, runners: [], spawn: 1.2, rnd: rng(lvl.seed || lvl.num), rid: 0,
      armour: UPGRADES.armour.value(s0.up.armour), coinRate: UPGRADES.coins.value(s0.up.coins), guns: UPGRADES.guns.value(s0.up.guns),
      n: start, start, x: 0, targetX: 0, z: 0, next: 0, t: 0, weapon: 0, fire: 1, kills: 0, splash: 0,
      phase: 'run',          // run → fight → run … → final assault → climb → won | lost
      fight: null, acc: 0, lossAcc: 0, dmg: 0, aim: null, steps: 0, climb: 0, coins: 0, bonus: 0, peak: start,
      events: [],            // what just happened, for the page to show (cleared by the page)
    };
  }
  const create = (num, save) => createFrom(makeLevel(num), save);

  const emit = (s, e) => { s.events.push(e); if (s.events.length > 300) s.events.shift(); };
  const lose = (s, k, why) => {
    const m = Math.min(s.n, k); s.n -= m;
    if (m > 0) emit(s, { kind: 'loss', n: m, why });
    if (s.n <= 0) { s.n = 0; s.phase = 'lost'; s.coins = Math.round((lossCoins(s) + s.bonus) * s.coinRate); emit(s, { kind: 'lost', why }); }
  };
  // armour soaks a share of every loss to enemies
  const hurt = (s, k, why) => { s.lossAcc += k * (1 - s.armour); const m = Math.floor(s.lossAcc); s.lossAcc -= m; if (m > 0) lose(s, m, why); };
  const lossCoins = s => Math.round((5 + s.num * 2) * Math.min(1, s.z / s.lvl.end));
  const winCoins = s => Math.round(((20 + s.num * 4) * (1 + 0.5 * s.steps) + s.bonus) * s.coinRate);
  const dps = s => dpsOf(s.n, s.weapon, s.guns, s.fire);
  const runCoins = s => Math.floor(s.bonus * s.coinRate);

  // Where something is now (things that charge have moved from where they started).
  const zOf = o => o.at != null ? o.at : o.z;

  // What the squad is shooting at: the nearest thing ahead in its column.
  function targetOf(s) {
    const R = radius(s.n), lo = s.x - R - 0.25, hi = s.x + R + 0.25;
    let best = null, bz = Infinity;
    for (const u of s.runners) {
      const dz = u.at - s.z;
      if (u.rem > 0 && dz > 0 && dz <= RANGE && u.x + 0.12 > lo && u.x - 0.12 < hi && u.at < bz) { best = u; bz = u.at; }
    }
    for (let i = s.next; i < s.objs.length; i++) {
      const o = s.objs[i];
      if (o.z - s.z > RANGE + WAKE) break;
      const z = zOf(o);
      if (o.type === 'enemy') { if (o.rem <= 0 || o.gone || o.x1 <= lo || o.x0 >= hi) continue; }
      else if (o.type === 'brute') { if (o.rem <= 0 || o.gone || o.x + 0.25 <= lo || o.x - 0.25 >= hi) continue; }
      else if (o.type === 'barrel') { if (o.rem <= 0 || o.x1 <= lo || o.x0 >= hi) continue; }
      else if (o.type === 'gate') { if (!raisable(s.x < 0 ? o.left : o.right)) continue; }
      else if (o.type === 'bunker') { if (o.rem <= 0) continue; }
      else continue;
      const dz = z - s.z;
      if (dz > 0 && dz <= (o.type === 'bunker' ? RANGE * 1.5 : RANGE) && z < bz) { best = o; bz = z; }
    }
    if (best) return best;
    // nothing in the column: swing round onto the nearest runner anywhere ahead
    for (const u of s.runners) { const dz = u.at - s.z; if (u.rem > 0 && dz > 2 && dz <= RANGE && u.at < bz) { best = u; bz = u.at; } }
    return best;
  }

  // who: 'run' (a runner), 'foe' (the enemy line) or 'brute', so the page can draw the right body
  function killOne(s, x, z, big, who = 'run') {
    s.kills++; s.bonus += big ? KILL_COIN * 6 : KILL_COIN;
    emit(s, { kind: 'kill', x, z, big: !!big, who: big ? 'brute' : who });
  }

  // Rockets: a kill on a runner group or an enemy squad also blasts a little of what's around it.
  // `o` was just hit at (x, z); the extra kill comes off it if any are left, else the nearest
  // runner group within a few metres.
  function splash(s, o, x, z) {
    if (s.weapon < ROCKETS) return;
    s.splash += SPLASH;
    if (s.splash < 1) return;
    s.splash -= 1;
    let t = o.rem > 0 ? o : null;
    if (!t) for (const u of s.runners) if (u !== o && u.rem > 0 && Math.abs(u.at - z) < 5 && Math.abs(u.x - x) < 0.35) { t = u; break; }
    emit(s, { kind: 'splash', x, z, k: t ? 1 : 0 });
    if (!t) return;
    t.rem--;   // (when t is o, fire() sees it emptied and routs it as usual)
    killOne(s, t === o ? x : t.x, t.at, false, t.type ? 'foe' : 'run');
  }

  // A boom barrel: everything near it goes up.
  function blast(s, bx, bz) {
    let k = 0;
    for (const u of s.runners) if (u.rem > 0 && Math.abs(u.at - bz) < 16) { while (u.rem > 0) { u.rem--; k++; killOne(s, u.x, u.at); } }
    for (let i = s.next; i < s.objs.length; i++) {
      const o = s.objs[i];
      if (o.z - bz > 30) break;
      if (o.at == null || o.gone || o.rem <= 0 || Math.abs(o.at - bz) > 18) continue;
      if (o.type === 'enemy') { const m = Math.min(o.rem, 20); for (let j = 0; j < m; j++) { o.rem--; k++; killOne(s, o.x0 + (o.x1 - o.x0) * (j + 0.5) / m, o.at, false, 'foe'); } }
      if (o.type === 'brute') { o.rem = Math.max(0, o.rem - 30); if (o.rem === 0) { k++; killOne(s, o.x, o.at, true); } }
    }
    emit(s, { kind: 'boom', x: bx, z: bz, kills: k });
  }

  function fire(s, dt) {
    const o = targetOf(s);
    if (!o) { s.dmg = 0; s.aim = null; return; }
    s.dmg += dps(s) * dt;
    const runner = !o.type;
    const cost = o.type === 'gate' ? GATE_COST : o.type === 'bunker' ? (o.boss ? 1 : BUNKER_COST) : 1;
    const ax = runner || o.type === 'brute' ? o.x : o.type === 'gate' ? (s.x < 0 ? -0.5 : 0.5)
      : o.type === 'enemy' || o.type === 'barrel' ? Math.max(o.x0, Math.min(o.x1, s.x)) : 0;
    const az = zOf(o);
    s.aim = { x: ax, z: az, kind: o.type || 'runner' };
    while (s.dmg >= cost) {
      s.dmg -= cost;
      if (o.type === 'gate') { raise(s.x < 0 ? o.left : o.right); emit(s, { kind: 'raise', side: s.x < 0 ? 'left' : 'right', z: o.z }); continue; }
      o.rem--;
      if (runner || o.type === 'enemy') { killOne(s, ax, az, false, runner ? 'run' : 'foe'); splash(s, o, ax, az); }
      else emit(s, { kind: 'hit', on: o.type, x: ax, z: az });
      if (o.rem <= 0) {
        if (o.type === 'barrel') {
          const w = o.reward;
          if (w.kind === 'gun') { s.weapon = Math.min(WEAPONS.length - 1, s.weapon + 1); emit(s, { kind: 'weapon', name: WEAPONS[s.weapon] }); }
          else if (w.kind === 'men') { s.n += w.n; emit(s, { kind: 'pickup', n: w.n }); }
          else if (w.kind === 'coins') { s.bonus += w.n; emit(s, { kind: 'coins', n: w.n }); }
          else blast(s, ax, o.z);
          emit(s, { kind: 'broke', x: ax, z: o.z });
        }
        if (o.type === 'brute') killOne(s, o.x, o.at, true);
        if (o.type === 'enemy') emit(s, { kind: 'routed' });
        if (o.type === 'bunker') {   // shot down from range: no assault needed
          s.phase = 'climb'; s.climb = 0; o.hit = true; s.aim = null; emit(s, { kind: o.boss ? 'bossdown' : 'taken' });
        }
        s.dmg = 0;
        break;
      }
    }
  }

  function spawnRunners(s, dt) {
    if (s.z < 30 || s.z > s.lvl.end - 30) return;
    s.spawn -= dt;
    if (s.spawn > 0) return;
    const r = s.rnd, d = s.lvl.d;
    s.spawn = s.lvl.runEvery * (0.6 + 0.8 * r());
    // bigger bursts for stronger squads, so they get close enough to matter
    const k = 1 + Math.floor(r() * (1.5 + 3 * d)) + Math.floor(dps(s) * 0.22 * r());
    // half of them head for the squad, the rest anywhere across the beach
    const x = r() < 0.5 ? s.x + (r() - 0.5) * 0.7 : -0.8 + 1.6 * r();
    s.runners.push({ id: ++s.rid, x: Math.max(-0.85, Math.min(0.85, x)), at: s.z + 48, rem: k, n: k });
  }

  // Everything that moves toward the squad. Returns true if a fight has started.
  function moveFoes(s, dt) {
    const R = radius(s.n), front = 1.2 + R * 4;
    // runners keep coming; any that reach the squad cut into it
    for (const u of s.runners) {
      if (u.rem <= 0) continue;
      u.at -= RUNNER_SPEED * dt;
      if (u.at - s.z > front) continue;
      if (Math.abs(u.x - s.x) < R + 0.14) {
        emit(s, { kind: 'stab', n: u.rem, x: u.x, z: u.at });
        hurt(s, u.rem, 'runners'); u.rem = 0;
        if (s.phase === 'lost') return true;
      } else if (u.at < s.z - 4) u.rem = 0;
    }
    if (s.runners.some(u => u.rem <= 0)) s.runners = s.runners.filter(u => u.rem > 0);
    for (let i = s.next; i < s.objs.length; i++) {
      const o = s.objs[i];
      if (o.z - s.z > WAKE + 5) break;
      if (o.at == null || o.rem <= 0 || o.gone) continue;
      if (!o.awake && o.z - s.z <= WAKE) { o.awake = true; emit(s, { kind: o.boss ? 'boss' : o.type === 'brute' ? 'brute' : 'charge' }); }
      if (!o.awake) continue;
      o.at -= (o.boss ? BOSS_SPEED : o.type === 'brute' ? BRUTE_SPEED : FOE_SPEED) * dt;
      if (o.at - s.z > front) continue;
      if (o.type === 'brute') {
        if (Math.abs(o.x - s.x) < R + 0.3) {
          emit(s, { kind: 'smash', x: o.x, z: o.at });
          hurt(s, Math.ceil(o.rem * 0.4), 'brute'); o.rem = 0; o.gone = true; o.hit = true;
          if (s.phase === 'lost') return true;
        } else if (o.at < s.z - 3) o.gone = true;
        continue;
      }
      if (o.type === 'enemy' && !overlaps(s.x, R, o.x0, o.x1)) {
        if (o.at < s.z - 3) { o.gone = true; emit(s, { kind: 'dodged' }); }
        continue;
      }
      // a squad or the boss reaches us
      o.at = s.z + front; o.hit = true; s.phase = 'fight'; s.acc = 0; s.aim = null;
      const rem = Math.min(o.rem, 1e6);
      if (o.boss) { s.fight = { obj: o, rate: rem / (1.2 + Math.min(1.4, rem / 120)) }; emit(s, { kind: 'assault' }); }
      else { s.fight = { obj: o, rate: rem / (FIGHT_TIME + Math.min(0.9, rem / 200)) }; emit(s, { kind: 'clash' }); }
      return true;
    }
    return false;
  }

  function step(s, dt) {
    if (s.phase === 'won' || s.phase === 'lost') return;
    s.t += dt;
    const R = radius(s.n);
    // steering, always, so the squad can line up even mid-fight
    let tx = Math.max(-1 + R, Math.min(1 - R, s.targetX));
    for (const o of s.objs) {
      if (o.type !== 'wall' || s.z < o.z - 2 || s.z > o.z + o.len) continue;
      if (o.x0 <= -1) tx = Math.max(tx, Math.min(1 - R, o.x1 + R));
      else tx = Math.min(tx, Math.max(-1 + R, o.x0 - R));
    }
    const dx = tx - s.x, mx = SIDE_SPEED * dt;
    s.x += Math.abs(dx) <= mx ? dx : Math.sign(dx) * mx;
    for (const o of s.objs) {
      if (o.type !== 'wall' || s.z < o.z || s.z > o.z + o.len) continue;
      if (o.x0 <= -1) s.x = Math.max(s.x, Math.min(1 - R, o.x1 + R));
      else s.x = Math.min(s.x, Math.max(-1 + R, o.x0 - R));
    }

    if (s.phase === 'fight') {
      const f = s.fight, o = f.obj;
      s.acc += f.rate * dt;
      while (s.acc >= 1 && o.rem > 0 && s.n > 0) {
        s.acc -= 1; o.rem--;
        if (o.type === 'enemy') { hurt(s, 1, 'enemy'); killOne(s, Math.max(o.x0, Math.min(o.x1, s.x)), o.at, false, 'foe'); }
        else lose(s, 1, o.boss ? 'boss' : 'bunker');   // each soldier storming it takes 1 HP
        emit(s, { kind: 'melee', on: o.type });
      }
      if (s.phase === 'lost') return;
      if (o.rem <= 0) {
        if (o.type === 'enemy') { s.phase = 'run'; s.fight = null; emit(s, { kind: 'cleared' }); }
        else { s.phase = 'climb'; s.fight = null; s.climb = 0; emit(s, { kind: o.boss ? 'bossdown' : 'taken' }); }
      }
      return;
    }
    if (s.phase === 'climb') {
      s.climb += dt;
      const want = Math.min(LADDER_STEPS, Math.floor(s.climb / 0.28) + 1);
      while (s.steps < want && s.n > s.lvl.stepCost) {
        s.n -= s.lvl.stepCost; s.steps++;
        emit(s, { kind: 'step', step: s.steps });
      }
      if (s.steps >= LADDER_STEPS || s.n <= s.lvl.stepCost || s.climb > 0.28 * LADDER_STEPS + 0.3) {
        s.phase = 'won'; s.coins = winCoins(s); emit(s, { kind: 'won' });
      }
      return;
    }

    // run: fire, move up the beach, the enemy comes on
    fire(s, dt);
    if (s.phase !== 'run') return;
    s.z += SPEED * dt;
    spawnRunners(s, dt);
    if (moveFoes(s, dt) || s.phase === 'lost') return;
    while (s.next < s.objs.length && s.objs[s.next].z <= s.z) {
      const o = s.objs[s.next];
      if (o.at != null && o.rem > 0 && !o.gone) break;   // still coming: wait for it to pass or reach us
      s.next++;
      if (o.type === 'wall' || o.type === 'enemy' || o.type === 'brute') continue;
      if (o.type === 'gate') {
        const side = s.x < 0 ? o.left : o.right;
        const before = s.n;
        s.n = Math.max(0, apply(side.op, side.n, s.n));
        if (side.op === 'f') s.fire *= 1 + side.n / 100;
        o.hit = s.x < 0 ? 'left' : 'right';
        emit(s, { kind: 'gate', op: side.op, a: side.n, before, after: s.n, side: o.hit, z: o.z });
        if (s.n <= 0) { s.n = before; lose(s, before, 'gate'); return; }
      } else if (o.type === 'pickup') {
        if (Math.abs(s.x - o.x) < R + 0.18) { s.n += o.n; o.hit = true; emit(s, { kind: 'pickup', n: o.n }); }
      } else if (o.type === 'barrel') {
        if (o.rem > 0 && overlaps(s.x, R, o.x0, o.x1)) {
          const k = o.rem; o.rem = 0; o.hit = true;
          emit(s, { kind: 'crash', x: s.x, z: o.z });
          lose(s, k, 'barrel');
        }
      } else if (o.type === 'wire') {
        const k = Math.round(s.n * discShare(s.x, R, o.x0, o.x1));
        o.hit = k > 0;
        if (k > 0) lose(s, k, 'wire');
      } else if (o.type === 'mines') {
        const k = Math.round(s.n * discShare(s.x, R, o.x0, o.x1) * 0.8);
        o.hit = k > 0;
        if (k > 0) lose(s, k, 'mines');
      } else if (o.type === 'bunker' && o.rem > 0) {
        s.z = o.z; s.phase = 'fight'; s.acc = 0; o.hit = true; s.aim = null;
        const rem = Math.min(o.rem, 1e6);
        s.fight = { obj: o, rate: rem / (0.9 + Math.min(1.2, rem / 150)) };
        emit(s, { kind: 'assault' });
        return;
      }
      if (s.phase === 'lost') return;
    }
    s.peak = Math.max(s.peak, s.n);
  }

  // What a player might steer toward, for the tests and level calibration.
  // good: best gates, shoots barrels open, dodges what it can't stop; bad: worst gates, no care.
  function autopilot(s, mode = 'good') {
    const R = radius(s.n), good = mode === 'good', d = dps(s);
    const items = [];
    for (let i = s.next; i < s.objs.length; i++) {
      const o = s.objs[i];
      if (o.z - s.z > RANGE + WAKE) break;
      if (o.type === 'wall') continue;
      if (o.at != null && (o.rem <= 0 || o.gone)) continue;
      const z = zOf(o);
      if (z < s.z) continue;
      items.push({ o, z });
    }
    items.sort((a, b) => a.z - b.z);
    for (const { o, z } of items) {
      const dz = z - s.z;
      if (o.type === 'enemy' || o.type === 'brute') {
        if (!good) continue;
        const x0 = o.type === 'brute' ? o.x - 0.3 : o.x0, x1 = o.type === 'brute' ? o.x + 0.3 : o.x1;
        if (x0 <= -1 && x1 >= 1) continue;                            // can't dodge a full-width charge
        const speed = o.type === 'brute' ? BRUTE_SPEED : FOE_SPEED;
        const t = (o.awake ? dz : Math.min(dz, WAKE)) / (SPEED + speed) + Math.max(0, dz - WAKE) / SPEED;
        if (d * t * 0.8 >= o.rem) return Math.max(-1 + R, Math.min(1 - R, (x0 + x1) / 2));   // shoot it down
        // step aside into the wider gap
        const gl = x0 + 1, gr = 1 - x1;
        return gl > gr ? Math.max(-1 + R, Math.min(x0 - R - 0.05, -1 + gl / 2)) : Math.min(1 - R, Math.max(x1 + R + 0.05, x1 + gr / 2));
      }
      if (o.type === 'barrel') {
        if (o.rem <= 0 || !good) continue;
        const mid = (o.x0 + o.x1) / 2, other = mid < 0 ? 0.5 : -0.5;
        if (o.rem <= d * Math.max(0, dz - 4) / SPEED * 0.9 || dz > 12) return mid;
        return other;
      }
      if (o.type === 'gate') {
        const a = worth(o.left, s.n), b = worth(o.right, s.n);
        return (good ? a >= b : a < b) ? -0.5 : 0.5;
      }
      if (o.type === 'pickup') return o.x;
      if (o.type === 'wire' || o.type === 'mines') {
        let best = 0, bestShare = 2;
        for (let x = -1 + R; x <= 1 - R + 1e-9; x += 0.02) {
          const sh = discShare(x, R, o.x0, o.x1);
          if (sh < bestShare - 1e-9) { bestShare = sh; best = x; }
        }
        return best;
      }
      if (o.type === 'bunker') return 0;
    }
    return s.targetX;
  }

  // Play a whole level with the autopilot; returns the finished run.
  const simulate = (num, save, mode = 'good') => runLevel(makeLevel(num), save, mode, false);

  // After a run: bank coins and move on (a win unlocks the next level).
  function finish(save, s) {
    save.coins += s.coins;
    if (s.phase === 'won') { save.best = Math.max(save.best, s.num); if (s.num >= save.level) save.level = s.num + 1; }
    return save;
  }

  return { SPEED, LADDER_STEPS, RANGE, WAKE, FOE_SPEED, RUNNER_SPEED, STORE, UPGRADES, LEVELS, WEAPONS, ROCKETS, SPLASH, upgradeCost, freshSave, cleanSave, buy,
    apply, goodOp, opLabel, raise, raisable, worth, dpsOf, makeLevel, levelSpec, isBoss, radius, discShare, create, createFrom, step, targetOf,
    autopilot, simulate, finish, winCoins, runCoins, zOf, rng };
})();
if (typeof module !== 'undefined') module.exports = Shore;
