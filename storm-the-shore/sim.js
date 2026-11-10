// Storm the Shore: the game engine. No DOM here; the page and the tests both use it.
// The squad runs up a beach lane on its own and fires straight ahead. The player only steers
// left and right (targetX). Enemy squads charge down the lane; barrels hold weapons and soldiers.
// Lane coordinates: x runs from -1 (left edge) to 1 (right edge); z is the distance up the beach.
//
// Fair play, by design: one currency (coins) earned only by playing, no timers, energy, ads or
// random draws, and every level is checked (test/engine.js) to be winnable with no upgrades at all.
/* exported Shore */
const Shore = (() => {
  'use strict';

  const SPEED = 16;          // forward speed, lane z units per second
  const SIDE_SPEED = 3.2;    // fastest sideways move, lane widths (x units) per second
  const FIGHT_TIME = 0.75;   // seconds a clash with an enemy squad lasts (more for big ones)
  const LADDER_STEPS = 8;    // multiplier steps past the bunker: ×1.5 … ×5
  const RANGE = 40;          // how far ahead the squad's shots reach
  const FOE_SPEED = 7;       // how fast enemy squads charge
  const WAKE = 62;           // enemy squads start their charge when you're this close
  const GATE_COST = 3;       // damage that raises a + or − gate side by one
  const BUNKER_COST = 3;     // damage that knocks one HP off the bunker from range
  const STORE = 'storm-the-shore';

  const WEAPONS = ['Rifle', 'SMG', 'Machine gun', 'Heavy MG', 'Rockets'];

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
    armour: { name: 'Helmets and flak', blurb: 'Lose fewer soldiers when an enemy squad reaches you.', max: 8, base: 50,
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
  const apply = (op, a, n) => {
    if (op === '+') return n + a;
    if (op === '-') return n - a;
    if (op === 'x') return n * a;
    return Math.floor(n / a);   // '/'
  };
  const goodOp = op => op === '+' || op === 'x';
  const opLabel = (op, a) => ({ '+': '+', '-': '−', x: '×', '/': '÷' })[op] + a;
  // Shooting a + or − side raises it by one: −3 → −2 → −1 → +0 → +1 …
  const raise = side => {
    if (side.op === '+') side.n++;
    else if (side.op === '-') { side.n--; if (side.n <= 0) { side.op = '+'; side.n = -side.n; } }
  };

  // ---- firepower ----
  const dpsOf = (n, weapon, guns = 1) => 1.4 * Math.pow(Math.max(0, n), 0.7) * Math.pow(1.6, weapon) * guns;

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
  // Each level is a list of beats up the beach, then a bunker. Levels 1–15 are tuned through this
  // table (what each level brings in, how long it is, how hard); later levels follow a formula.
  // The layout is then played by a careful and a careless autopilot, and the enemies and the
  // bunker are set so the careful one (with no upgrades) wins and the careless one loses.
  const LEVELS = [
    { beats: 6, d: 0.00, f: ['gate', 'barrel', 'enemy'], intro: ['barrel', 'gate', 'enemy'], title: 'First wave' },
    { beats: 6, d: 0.05, f: ['gate', 'enemy', 'barrel'], intro: ['enemy'], title: 'Contact' },
    { beats: 6, d: 0.10, f: ['gate', 'enemy', 'pickup', 'barrel'], intro: ['pickup'], title: 'Stragglers' },
    { beats: 7, d: 0.15, f: ['gate', 'enemy', 'wire', 'barrel'], intro: ['wire'], title: 'Wire on the sand' },
    { beats: 7, d: 0.20, f: ['gate', 'enemy', 'wire', 'pickup', 'barrel', 'bad'], intro: ['gate'], title: 'Wrong turns' },
    { beats: 8, d: 0.25, f: ['gate', 'enemy', 'mines', 'pickup', 'barrel', 'bad'], intro: ['mines'], title: 'Minefield' },
    { beats: 8, d: 0.30, f: ['gate', 'enemy', 'wall', 'wire', 'barrel', 'bad'], intro: ['wall'], title: 'Sandbags' },
    { beats: 9, d: 0.35, f: ['gate', 'enemy', 'wire', 'mines', 'pickup', 'barrel', 'bad'], title: 'Second wave' },
    { beats: 9, d: 0.40, f: ['gate', 'enemy', 'wall', 'mines', 'pickup', 'barrel', 'bad'], title: 'Dunes' },
    { beats: 10, d: 0.45, f: ['gate', 'enemy', 'wire', 'wall', 'pickup', 'barrel', 'bad'], title: 'Seawall' },
    { beats: 10, d: 0.50, f: ['gate', 'enemy', 'wire', 'mines', 'wall', 'barrel', 'bad'], title: 'Crossfire' },
    { beats: 11, d: 0.55, f: ['gate', 'enemy', 'wire', 'mines', 'wall', 'pickup', 'barrel', 'bad'], title: 'Hedgehogs' },
    { beats: 11, d: 0.60, f: ['gate', 'enemy', 'wire', 'mines', 'wall', 'pickup', 'barrel', 'bad'], title: 'The draw' },
    { beats: 12, d: 0.65, f: ['gate', 'enemy', 'wire', 'mines', 'wall', 'pickup', 'barrel', 'bad'], title: 'Gun line' },
    { beats: 12, d: 0.70, f: ['gate', 'enemy', 'wire', 'mines', 'wall', 'pickup', 'barrel', 'bad'], title: 'High ground' },
  ];
  const ALL = ['gate', 'enemy', 'wire', 'mines', 'wall', 'pickup', 'barrel', 'bad'];
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
      const g = apply(good[0], good[1], est);
      other = good[0] === 'x' ? ['+', Math.max(1, Math.round((g - est) * (0.45 + r() * 0.35)))] : ['x', 2];
      if (apply(other[0], other[1], est) >= g) other = ['+', Math.max(1, Math.round((g - est) * 0.5))];
    }
    return r() < 0.5 ? [good, other] : [other, good];
  }

  // Lay out a level. `foeScale` shrinks the enemy squads when calibration finds them too strong.
  function layout(num, attempt, foeScale) {
    const spec = levelSpec(num), r = rng(num * 7919 + 13 + attempt * 104729), d = spec.d;
    const objs = [];
    let z = 70, est = 1, weapon = 0, prev = '', guns = 0;
    const intro = (spec.intro || []).slice();
    const wakeTime = WAKE / (SPEED + FOE_SPEED);
    for (let i = 0; i < spec.beats; i++) {
      let kind;
      if (i === 0) kind = 'gate';
      else if (intro.length) kind = intro.shift();
      else {
        const pool = spec.f.filter(f => f !== 'bad' && f !== prev && !(f === 'enemy' && est < 6));
        const roll = r();
        kind = roll < 0.28 ? 'gate'
          : roll < 0.48 && pool.includes('barrel') ? 'barrel'
          : roll < 0.66 && pool.includes('enemy') ? 'enemy'
          : pick(r, pool);
        if (i === spec.beats - 1 && spec.f.includes('enemy') && est >= 6) kind = 'enemy';
      }
      if (kind === 'enemy' && est < 4) kind = 'gate';
      if (kind === 'gate') {
        const [L, R] = gatePair(r, est, d, spec.f.includes('bad'));
        objs.push({ type: 'gate', z, left: { op: L[0], n: L[1] }, right: { op: R[0], n: R[1] } });
        est = Math.max(apply(L[0], L[1], est), apply(R[0], R[1], est));
      } else if (kind === 'enemy') {
        // what the squad shoots on the way in, plus a real clash
        const shot = dpsOf(est, weapon) * wakeTime * 0.7;
        const n = Math.max(3, Math.round((shot + est * (0.3 + 0.35 * d + r() * 0.1)) * foeScale));
        const half = r() < 0.45 - 0.3 * d, left = r() < 0.5;
        objs.push({ type: 'enemy', z, n, x0: half && !left ? 0 : -1, x1: half && left ? 0 : 1 });
        est = Math.max(1, est - Math.round(n - shot));
      } else if (kind === 'pickup') {
        const n = Math.max(3, Math.round(3 + est * (0.15 + r() * 0.15)));
        objs.push({ type: 'pickup', z, x: pick(r, [-0.62, 0.62]), n });
        est += n;
      } else if (kind === 'barrel') {
        // a drum stack on one half: shoot it open for a weapon, soldiers or coins
        const left = r() < 0.5;
        const reward = weapon < WEAPONS.length - 1 && (guns === 0 || r() < 0.45) ? { kind: 'gun' }
          : r() < 0.6 ? { kind: 'men', n: Math.max(3, Math.round(3 + est * 0.25)) } : { kind: 'coins', n: 15 + num * 3 };
        const hp = Math.max(2, Math.round(dpsOf(est, weapon) * (0.9 + 0.8 * d)));
        objs.push({ type: 'barrel', z, x0: left ? -0.95 : 0.05, x1: left ? -0.05 : 0.95, hp, reward });
        if (reward.kind === 'gun') { weapon++; guns++; }
        if (reward.kind === 'men') est += reward.n;
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
        const [A, B] = gatePair(r, est, d, true);
        const goodA = apply(A[0], A[1], est) >= apply(B[0], B[1], est);
        const best = goodA ? A : B, other = goodA ? B : A;
        const [L, R] = left ? [best, other] : [other, best];
        z += len + 26;
        objs.push({ type: 'gate', z, left: { op: L[0], n: L[1] }, right: { op: R[0], n: R[1] } });
        est = apply(best[0], best[1], est);
      }
      prev = kind;
      z += kind === 'gate' ? 46 : kind === 'enemy' ? 60 : 52;
    }
    z += 10;
    objs.push({ type: 'bunker', z, hp: 1e9 });
    return { num, title: spec.title, d, objs, end: z, hp: 1e9, stepCost: 1 };
  }

  // Run a layout with an autopilot. With stopAtBunker, stop as the assault on the bunker begins.
  function runLevel(lvl, save, mode, stopAtBunker) {
    const s = createFrom(lvl, save);
    for (let i = 0; i < 60 * 600 && s.phase !== 'won' && s.phase !== 'lost'; i++) {
      s.targetX = autopilot(s, mode);
      step(s, 1 / 60);
      s.events.length = 0;
      if (stopAtBunker && s.phase === 'fight' && s.fight.obj.type === 'bunker') break;
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
      const ok = hp - g.shot < g.n;
      if (!ok && !fallback) fallback = { L, hp: g.shot + Math.max(1, g.n - 1), g };
      if (!ok) continue;
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
      c.rem = o.type === 'enemy' ? o.n : o.type === 'bunker' || o.type === 'barrel' ? o.hp : 0;
      if (o.type === 'enemy') { c.at = o.z; c.awake = false; c.gone = false; }
      return c;
    });
    return {
      num: lvl.num, lvl, objs,
      armour: UPGRADES.armour.value(s0.up.armour), coinRate: UPGRADES.coins.value(s0.up.coins), guns: UPGRADES.guns.value(s0.up.guns),
      n: start, start, x: 0, targetX: 0, z: 0, next: 0, t: 0, weapon: 0,
      phase: 'run',          // run → fight → run … → bunker → climb → won | lost
      fight: null, acc: 0, lossAcc: 0, dmg: 0, aim: null, steps: 0, climb: 0, coins: 0, bonus: 0, peak: start,
      events: [],            // what just happened, for the page to show (cleared by the page)
    };
  }
  const create = (num, save) => createFrom(makeLevel(num), save);

  const emit = (s, e) => { s.events.push(e); if (s.events.length > 200) s.events.shift(); };
  const lose = (s, k, why) => {
    const m = Math.min(s.n, k); s.n -= m;
    if (m > 0) emit(s, { kind: 'loss', n: m, why });
    if (s.n <= 0) { s.n = 0; s.phase = 'lost'; s.coins = Math.round((lossCoins(s) + s.bonus) * s.coinRate); emit(s, { kind: 'lost', why }); }
  };
  const lossCoins = s => Math.round((5 + s.num * 2) * Math.min(1, s.z / s.lvl.end));
  const winCoins = s => Math.round(((20 + s.num * 4) * (1 + 0.5 * s.steps) + s.bonus) * s.coinRate);
  const dps = s => dpsOf(s.n, s.weapon, s.guns);

  // What the squad is shooting at: the nearest thing ahead in its path.
  function targetOf(s) {
    const R = radius(s.n), lo = s.x - R - 0.25, hi = s.x + R + 0.25;
    let best = null, bz = Infinity;
    for (let i = s.next; i < s.objs.length; i++) {
      const o = s.objs[i];
      if (o.z - s.z > RANGE + 30) break;
      let z = o.z;
      if (o.type === 'enemy') { if (o.rem <= 0 || o.gone || o.x1 <= lo || o.x0 >= hi) continue; z = o.at; }
      else if (o.type === 'barrel') { if (o.rem <= 0 || o.x1 <= lo || o.x0 >= hi) continue; }
      else if (o.type === 'gate') { const side = s.x < 0 ? o.left : o.right; if (side.op !== '+' && side.op !== '-') continue; }
      else if (o.type === 'bunker') { if (o.rem <= 0) continue; }
      else continue;
      const dz = z - s.z;
      if (dz > 0 && dz <= RANGE && z < bz) { best = o; bz = z; }
    }
    // enemies are listed by where they started; one that has charged in may be nearer
    return best;
  }

  function fire(s, dt) {
    const o = targetOf(s);
    if (!o) { s.dmg = 0; s.aim = null; return; }
    s.dmg += dps(s) * dt;
    const cost = o.type === 'gate' ? GATE_COST : o.type === 'bunker' ? BUNKER_COST : 1;
    const ax = o.type === 'gate' ? (s.x < 0 ? -0.5 : 0.5) : o.type === 'enemy' || o.type === 'barrel' ? Math.max(o.x0, Math.min(o.x1, s.x)) : 0;
    s.aim = { x: ax, z: o.type === 'enemy' ? o.at : o.z, kind: o.type };
    while (s.dmg >= cost) {
      s.dmg -= cost;
      if (o.type === 'gate') { raise(s.x < 0 ? o.left : o.right); emit(s, { kind: 'raise' }); continue; }
      o.rem--;
      if (o.type === 'enemy') emit(s, { kind: 'kill', x: ax, z: o.at });
      if (o.rem <= 0) {
        if (o.type === 'barrel') {
          const w = o.reward;
          if (w.kind === 'gun') { s.weapon = Math.min(WEAPONS.length - 1, s.weapon + 1); emit(s, { kind: 'weapon', name: WEAPONS[s.weapon] }); }
          else if (w.kind === 'men') { s.n += w.n; emit(s, { kind: 'pickup', n: w.n }); }
          else { s.bonus += w.n; emit(s, { kind: 'coins', n: w.n }); }
          emit(s, { kind: 'broke', x: ax, z: o.z });
        }
        if (o.type === 'enemy') emit(s, { kind: 'routed' });
        s.dmg = 0;
        break;
      }
    }
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
      s.aim = null;
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

    // run: fire, move up the beach, enemy squads charge
    fire(s, dt);
    s.z += SPEED * dt;
    for (let i = s.next; i < s.objs.length; i++) {
      const o = s.objs[i];
      if (o.z - s.z > WAKE + 5) break;
      if (o.type !== 'enemy' || o.rem <= 0 || o.gone) continue;
      if (!o.awake && o.z - s.z <= WAKE) { o.awake = true; emit(s, { kind: 'charge' }); }
      if (o.awake) o.at -= FOE_SPEED * dt;
      const front = 1.2 + radius(s.n) * 4;   // they meet the front rank, not the middle
      if (o.at - s.z <= front) {
        if (overlaps(s.x, radius(s.n), o.x0, o.x1)) {
          s.phase = 'fight'; s.acc = 0; o.hit = true; o.at = s.z + front;
          s.fight = { obj: o, rate: o.rem / (FIGHT_TIME + Math.min(0.9, o.rem / 200)) };
          emit(s, { kind: 'clash' });
          return;
        }
        if (o.at < s.z - 3) { o.gone = true; emit(s, { kind: 'dodged' }); }
      }
    }
    while (s.next < s.objs.length && s.objs[s.next].z <= s.z) {
      const o = s.objs[s.next];
      if (o.type === 'enemy' && o.rem > 0 && !o.gone) break;   // still charging: wait for it to pass or reach us
      s.next++;
      if (o.type === 'wall' || o.type === 'enemy') continue;
      if (o.type === 'gate') {
        const side = s.x < 0 ? o.left : o.right;
        const before = s.n;
        s.n = Math.max(0, apply(side.op, side.n, s.n));
        o.hit = s.x < 0 ? 'left' : 'right';
        emit(s, { kind: 'gate', op: side.op, a: side.n, before, after: s.n });
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
      } else if (o.type === 'bunker') {
        s.z = o.z; s.phase = 'fight'; s.acc = 0; o.hit = true; s.aim = null;
        s.fight = { obj: o, rate: Math.min(o.rem, 1e6) / (0.9 + Math.min(1.2, Math.min(o.rem, 1e6) / 150)) };
        emit(s, { kind: 'assault' });
        return;
      }
      if (s.phase === 'lost') return;
    }
    s.peak = Math.max(s.peak, s.n);
  }

  // What a player might steer toward, for the tests and level calibration.
  // good: best gates, shoots barrels open, dodges squads it can't stop; bad: worst gates, no care.
  function autopilot(s, mode = 'good') {
    const R = radius(s.n), good = mode === 'good', d = dps(s);
    const closing = SPEED + FOE_SPEED;
    // things in the way, nearest first
    const items = [];
    for (let i = s.next; i < s.objs.length; i++) {
      const o = s.objs[i];
      if (o.z - s.z > RANGE + 40) break;
      if (o.type === 'wall') continue;
      const z = o.type === 'enemy' ? o.at : o.z;
      if (o.type === 'enemy' && (o.rem <= 0 || o.gone)) continue;
      if (z < s.z) continue;
      items.push({ o, z });
    }
    items.sort((a, b) => a.z - b.z);
    for (const { o, z } of items) {
      const dz = z - s.z;
      if (o.type === 'enemy') {
        if (!good || (o.x0 <= -1 && o.x1 >= 1)) continue;          // can't dodge a full-width charge
        const t = Math.max(0, (o.awake ? dz : Math.min(dz, WAKE)) / closing + Math.max(0, dz - WAKE) / SPEED);
        if (d * t * 0.8 >= o.rem) return (o.x0 + o.x1) / 2;        // shoot it down
        return o.x0 <= -1 ? 0.5 : -0.5;                             // step out of its path
      }
      if (o.type === 'barrel') {
        if (o.rem <= 0) continue;
        const mid = (o.x0 + o.x1) / 2, other = mid < 0 ? 0.5 : -0.5;
        if (!good) continue;
        if (o.rem <= d * Math.max(0, dz - 4) / SPEED * 0.9) return mid;   // time to break it
        if (dz > 12) return mid;
        return other;
      }
      if (o.type === 'gate') {
        const a = apply(o.left.op, o.left.n, s.n), b = apply(o.right.op, o.right.n, s.n);
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

  return { SPEED, LADDER_STEPS, RANGE, WAKE, FOE_SPEED, STORE, UPGRADES, LEVELS, WEAPONS, upgradeCost, freshSave, cleanSave, buy,
    apply, goodOp, opLabel, raise, dpsOf, makeLevel, levelSpec, radius, discShare, create, createFrom, step, targetOf, autopilot,
    simulate, finish, winCoins, rng };
})();
if (typeof module !== 'undefined') module.exports = Shore;
