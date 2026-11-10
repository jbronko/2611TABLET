// Storm the Shore: the game engine. No DOM here; the page and the tests both use it.
// The squad runs up a beach lane on its own. The player only steers left and right (targetX).
// Lane coordinates: x runs from -1 (left edge) to 1 (right edge); z is the distance up the beach.
/* exported Shore */
const Shore = (() => {
  'use strict';

  const SPEED = 16;          // forward speed, lane z units per second
  const SIDE_SPEED = 3.2;    // fastest sideways move, lane widths (x units) per second
  const FIGHT_TIME = 0.75;   // seconds a skirmish with an enemy line lasts (more for big ones)
  const LADDER_STEPS = 8;    // multiplier steps past the bunker: ×1.5 … ×5
  const STORE = 'storm-the-shore';

  // ---- random numbers (seeded, so every level is the same each time) ----
  const rng = seed => () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const pick = (r, list) => list[Math.floor(r() * list.length)];
  const between = (r, a, b) => a + Math.floor(r() * (b - a + 1));

  // ---- upgrades ----
  const UPGRADES = {
    squad: { name: 'Bigger landing party', blurb: 'More soldiers step off the landing craft.', max: 10, base: 30,
             value: l => [1, 3, 5, 8, 12, 16, 20, 25, 30, 36, 42][l], show: v => `${v} to start` },
    coins: { name: 'War chest', blurb: 'Earn more coins from every level.', max: 10, base: 40,
             value: l => 1 + 0.1 * l, show: v => `+${Math.round((v - 1) * 100)}% coins` },
    armour: { name: 'Helmets and flak', blurb: 'Lose fewer soldiers when you clash with enemy lines.', max: 8, base: 50,
             value: l => 0.06 * l, show: v => `${Math.round(v * 100)}% fewer losses` },
  };
  const upgradeCost = (key, level) => level >= UPGRADES[key].max ? null : Math.round(UPGRADES[key].base * Math.pow(1.6, level) / 5) * 5;

  // ---- saved progress ----
  const freshSave = () => ({ level: 1, best: 0, coins: 0, up: { squad: 0, coins: 0, armour: 0 } });
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
  const apply = (op, a, n) => {
    if (op === '+') return n + a;
    if (op === '-') return n - a;
    if (op === 'x') return n * a;
    return Math.floor(n / a);   // '/'
  };
  const goodOp = op => op === '+' || op === 'x';
  const opLabel = (op, a) => ({ '+': '+', '-': '−', x: '×', '/': '÷' })[op] + a;

  // ---- levels ----
  // Each level is a list of beats up the beach, then a bunker. Levels 1–15 are tuned by hand through
  // this table (what each level brings in, how long it is, how hard); later levels follow a formula.
  // Every beat is made from what a best-playing squad would have at that point, so a level is
  // always winnable by choosing well and hard to finish by choosing badly.
  //   beats: number of beats; d: difficulty 0..1; f: features allowed; intro: beat kinds to use first
  const LEVELS = [
    { beats: 5, d: 0.00, f: ['gate'], title: 'First wave' },
    { beats: 6, d: 0.05, f: ['gate', 'enemy'], intro: ['enemy'], title: 'Contact' },
    { beats: 6, d: 0.10, f: ['gate', 'enemy', 'pickup'], intro: ['pickup'], title: 'Stragglers' },
    { beats: 7, d: 0.15, f: ['gate', 'enemy', 'wire'], intro: ['wire'], title: 'Wire on the sand' },
    { beats: 7, d: 0.20, f: ['gate', 'enemy', 'wire', 'pickup', 'bad'], intro: ['gate'], title: 'Wrong turns' },
    { beats: 8, d: 0.25, f: ['gate', 'enemy', 'mines', 'pickup', 'bad'], intro: ['mines'], title: 'Minefield' },
    { beats: 8, d: 0.30, f: ['gate', 'enemy', 'wall', 'wire', 'bad'], intro: ['wall'], title: 'Sandbags' },
    { beats: 9, d: 0.35, f: ['gate', 'enemy', 'wire', 'mines', 'pickup', 'bad'], title: 'Second wave' },
    { beats: 9, d: 0.40, f: ['gate', 'enemy', 'wall', 'mines', 'pickup', 'bad'], title: 'Dunes' },
    { beats: 10, d: 0.45, f: ['gate', 'enemy', 'wire', 'wall', 'pickup', 'bad'], title: 'Seawall' },
    { beats: 10, d: 0.50, f: ['gate', 'enemy', 'wire', 'mines', 'wall', 'bad'], title: 'Crossfire' },
    { beats: 11, d: 0.55, f: ['gate', 'enemy', 'wire', 'mines', 'wall', 'pickup', 'bad'], title: 'Hedgehogs' },
    { beats: 11, d: 0.60, f: ['gate', 'enemy', 'wire', 'mines', 'wall', 'pickup', 'bad'], title: 'The draw' },
    { beats: 12, d: 0.65, f: ['gate', 'enemy', 'wire', 'mines', 'wall', 'pickup', 'bad'], title: 'Gun line' },
    { beats: 12, d: 0.70, f: ['gate', 'enemy', 'wire', 'mines', 'wall', 'pickup', 'bad'], title: 'High ground' },
  ];
  const ALL = ['gate', 'enemy', 'wire', 'mines', 'wall', 'pickup', 'bad'];
  const levelSpec = num => num <= LEVELS.length ? LEVELS[num - 1]
    : { beats: Math.min(16, 12 + Math.floor((num - 15) / 4)), d: Math.min(0.9, 0.7 + (num - 15) * 0.01), f: ALL, title: `Push ${num - 15}` };

  // Two choices at a gate. The good one is what a best-playing squad takes; the other is
  // sometimes close (a real decision), sometimes bad.
  function gatePair(r, est, d, bad) {
    const adds = Math.max(3, Math.round(est * (0.5 + r() * 0.7)));
    const good = est < 6 ? pick(r, [['+', between(r, 4, 9)], ['x', 2], ['+', between(r, 5, 10)]])
      : est > 260 ? ['+', Math.round(est * 0.3)]
      : pick(r, [['x', 2], ['+', adds], ['x', est < 60 ? 3 : 2], ['+', adds]]);
    let other;
    if (bad && est >= 6 && r() < 0.35 + 0.4 * d) {
      other = pick(r, [['-', Math.max(2, Math.round(est * (0.3 + r() * 0.4)))], ['/', 2], ['/', 3]]);
    } else {
      // a close option: the other kind of good, a bit smaller
      const g = apply(good[0], good[1], est);
      other = good[0] === 'x' ? ['+', Math.max(1, Math.round((g - est) * (0.45 + r() * 0.35)))]
        : ['x', 2];
      if (apply(other[0], other[1], est) >= g) other = ['+', Math.max(1, Math.round((g - est) * 0.5))];
    }
    return r() < 0.5 ? [good, other] : [other, good];
  }

  function makeLevel(num, startSquad = 1) {
    const spec = levelSpec(num), r = rng(num * 7919 + 13), d = spec.d;
    const objs = [];
    let z = 70, est = startSquad, worst = startSquad, prev = '';
    const intro = (spec.intro || []).slice();
    for (let i = 0; i < spec.beats; i++) {
      let kind;
      if (i === 0) kind = 'gate';
      else if (intro.length && i >= 1) kind = intro.shift();
      else {
        const pool = spec.f.filter(f => f !== 'bad' && f !== prev && !(f === 'enemy' && est < 8));
        kind = r() < 0.4 ? 'gate' : pick(r, pool);
        if (i === spec.beats - 1 && kind !== 'enemy' && spec.f.includes('enemy') && est >= 8) kind = 'enemy';
      }
      if (kind === 'enemy' && est < 4) kind = 'gate';
      if (kind === 'gate') {
        const [L, R] = gatePair(r, est, d, spec.f.includes('bad'));
        objs.push({ type: 'gate', z, left: { op: L[0], n: L[1] }, right: { op: R[0], n: R[1] } });
        const a = apply(L[0], L[1], est), b = apply(R[0], R[1], est);
        const wa = apply(L[0], L[1], worst), wb = apply(R[0], R[1], worst);
        est = Math.max(a, b); worst = Math.max(0, a >= b ? wb : wa);
      } else if (kind === 'enemy') {
        const n = Math.max(2, Math.round(est * (0.22 + 0.33 * d + r() * 0.1)));
        objs.push({ type: 'enemy', z, n });
        est -= n; worst -= n;
      } else if (kind === 'pickup') {
        const n = Math.max(3, Math.round(3 + est * (0.15 + r() * 0.15)));
        const x = pick(r, [-0.62, 0.62]);
        objs.push({ type: 'pickup', z, x, n });
        est += n; worst = worst > 0 ? worst + n : worst;
      } else if (kind === 'wire' || kind === 'mines') {
        const span = 0.85 + r() * 0.35 * (0.5 + d), left = r() < 0.5;
        const x0 = left ? -1 : 1 - span, x1 = left ? -1 + span : 1;
        if (kind === 'wire') objs.push({ type: 'wire', z, x0, x1 });
        else {
          const mines = [];
          for (let m = 0; m < 4 + Math.round(d * 4); m++) mines.push({ x: x0 + 0.08 + r() * (x1 - x0 - 0.16), dz: r() * 10 });
          objs.push({ type: 'mines', z, x0, x1, mines });
        }
        // what a squad of this size loses at the best spot (the radius grows with the squad)
        const R = radius(est);
        let share = 1;
        for (let x = -1 + R; x <= 1 - R + 1e-9; x += 0.02) share = Math.min(share, discShare(x, R, x0, x1));
        est -= Math.round(est * share * (kind === 'mines' ? 0.8 : 1));
      } else if (kind === 'wall') {
        // sandbags along one side, then a gate pair whose better side is behind them
        const left = r() < 0.5, w = 0.55 + r() * 0.2, len = 26;
        objs.push({ type: 'wall', z, len, x0: left ? -1 : 1 - w, x1: left ? -1 + w : 1 });
        const [A, B] = gatePair(r, est, d, true);
        const goodA = apply(A[0], A[1], est) >= apply(B[0], B[1], est);
        const best = goodA ? A : B, other = goodA ? B : A;
        const [L, R] = left ? [best, other] : [other, best];
        z += len + 26;
        objs.push({ type: 'gate', z, left: { op: L[0], n: L[1] }, right: { op: R[0], n: R[1] } });
        const g = apply(best[0], best[1], est), o = apply(other[0], other[1], worst);
        est = g; worst = Math.max(0, o);
      }
      prev = kind;
      z += kind === 'gate' ? 46 : 52;
    }
    // the bunker holds against a squad that chose badly, where that still leaves room to win
    const hp = Math.max(3, Math.round(est * (0.36 + 0.3 * d)), Math.min(worst + 1, Math.round(est * 0.8)));
    z += 10;
    objs.push({ type: 'bunker', z, hp });
    return { num, title: spec.title, objs, end: z, hp, est, worst, stepCost: Math.max(1, Math.ceil(hp * 0.12)) };
  }

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

  // ---- a run ----
  function create(num, save) {
    const s0 = cleanSave(save);
    const start = UPGRADES.squad.value(s0.up.squad);
    const lvl = makeLevel(num);
    return {
      num, lvl, objs: lvl.objs.map(o => ({ ...o, hit: false, rem: o.type === 'enemy' ? o.n : o.type === 'bunker' ? o.hp : 0 })),
      armour: UPGRADES.armour.value(s0.up.armour), coinRate: UPGRADES.coins.value(s0.up.coins),
      n: start, start, x: 0, targetX: 0, z: 0, next: 0, t: 0,
      phase: 'run',          // run → fight → run … → bunker → climb → won | lost
      fight: null, acc: 0, lossAcc: 0, steps: 0, climb: 0, coins: 0, peak: start,
      events: [],            // what just happened, for the page to show (cleared by the page)
    };
  }

  const emit = (s, e) => { s.events.push(e); if (s.events.length > 100) s.events.shift(); };
  const lose = (s, k, why) => {
    const m = Math.min(s.n, k); s.n -= m;
    if (m > 0) emit(s, { kind: 'loss', n: m, why });
    if (s.n <= 0) { s.n = 0; s.phase = 'lost'; s.coins = Math.round(lossCoins(s) * s.coinRate); emit(s, { kind: 'lost', why }); }
  };
  const lossCoins = s => Math.round((5 + s.num * 2) * Math.min(1, s.z / s.lvl.end));
  const winCoins = s => Math.round((20 + s.num * 4) * (1 + 0.5 * s.steps) * s.coinRate);

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
    // walls hold the squad out even if it was already beside them
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
        if (o.type === 'enemy') {
          s.lossAcc += 1 - s.armour;
          if (s.lossAcc >= 1) { s.lossAcc -= 1; lose(s, 1, 'enemy'); }
        } else lose(s, 1, 'bunker');   // each soldier storming the bunker takes 1 HP
        emit(s, { kind: 'hit', on: o.type });
      }
      if (s.phase === 'lost') return;
      if (o.rem <= 0) {
        if (o.type === 'enemy') { s.phase = 'run'; s.fight = null; emit(s, { kind: 'cleared' }); }
        else { s.phase = 'climb'; s.fight = null; s.climb = 0; emit(s, { kind: 'taken' }); }
      }
      return;
    }
    if (s.phase === 'climb') {
      // spare soldiers climb the multiplier steps, one step costs stepCost soldiers
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

    // run
    s.z += SPEED * dt;
    while (s.next < s.objs.length && s.objs[s.next].z <= s.z) {
      const o = s.objs[s.next++];
      if (o.type === 'wall') continue;
      if (o.type === 'gate') {
        const side = s.x < 0 ? o.left : o.right;
        const before = s.n;
        s.n = Math.max(0, apply(side.op, side.n, s.n));
        o.hit = s.x < 0 ? 'left' : 'right';
        emit(s, { kind: 'gate', op: side.op, a: side.n, before, after: s.n });
        if (s.n <= 0) { s.n = before; lose(s, before, 'gate'); return; }
      } else if (o.type === 'pickup') {
        if (Math.abs(s.x - o.x) < R + 0.18) { s.n += o.n; o.hit = true; emit(s, { kind: 'pickup', n: o.n }); }
      } else if (o.type === 'wire') {
        const k = Math.round(s.n * discShare(s.x, R, o.x0, o.x1));
        o.hit = k > 0;
        if (k > 0) lose(s, k, 'wire');
      } else if (o.type === 'mines') {
        const k = Math.round(s.n * discShare(s.x, R, o.x0, o.x1) * 0.8);
        o.hit = k > 0;
        if (k > 0) lose(s, k, 'mines');
      } else if (o.type === 'enemy' || o.type === 'bunker') {
        s.z = o.z; s.phase = 'fight'; s.acc = 0; o.hit = true;
        const t = o.type === 'enemy' ? FIGHT_TIME + Math.min(0.9, o.n / 200) : 0.9 + Math.min(1.2, o.hp / 150);
        s.fight = { obj: o, rate: o.rem / t };
        emit(s, { kind: o.type === 'enemy' ? 'clash' : 'assault' });
        return;
      }
      if (s.phase === 'lost') return;
    }
    s.peak = Math.max(s.peak, s.n);
  }

  // What a player might steer toward, for the tests (good: best gates; bad: worst gates).
  function autopilot(s, mode = 'good') {
    const R = radius(s.n);
    for (let i = s.next; i < s.objs.length; i++) {
      const o = s.objs[i];
      if (o.type === 'wall') continue;
      if (o.z < s.z) continue;
      if (o.type === 'gate') {
        const a = apply(o.left.op, o.left.n, s.n), b = apply(o.right.op, o.right.n, s.n);
        const left = mode === 'good' ? a >= b : a < b;
        return left ? -0.5 : 0.5;
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
      return s.targetX;
    }
    return 0;
  }

  // Play a whole level with the autopilot; returns the finished run.
  function simulate(num, save, mode = 'good', dt = 1 / 60) {
    const s = create(num, save);
    for (let i = 0; i < 60 * 600 && s.phase !== 'won' && s.phase !== 'lost'; i++) {
      s.targetX = autopilot(s, mode);
      step(s, dt);
      s.events.length = 0;
    }
    return s;
  }

  // After a run: bank coins and move on (a win unlocks the next level).
  function finish(save, s) {
    save.coins += s.coins;
    if (s.phase === 'won') { save.best = Math.max(save.best, s.num); if (s.num >= save.level) save.level = s.num + 1; }
    return save;
  }

  return { SPEED, LADDER_STEPS, STORE, UPGRADES, LEVELS, upgradeCost, freshSave, cleanSave, buy, apply, goodOp, opLabel,
    makeLevel, levelSpec, radius, discShare, create, step, autopilot, simulate, finish, winCoins, rng };
})();
if (typeof module !== 'undefined') module.exports = Shore;
