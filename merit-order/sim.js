// Merit Order: the market engine. No DOM here; the page and the tests both use it.
// One region, a 5-minute dispatch: every generator's bids are stacked cheapest-first and the
// last megawatt needed sets the price everyone is paid.
/* exported Sim */
const Sim = (() => {
  'use strict';

  const IPD = 288;                 // dispatch intervals per day
  const H = 5 / 60;                // hours per interval
  const FLOOR = -1000;             // market price floor, $/MWh
  const CAP = 20000;               // market price cap (stylised), $/MWh
  const START_DOY = 304;          // the game starts on 1 November (late spring)
  const AWAY_CAP_DAYS = 7;         // most game days simulated while the app was closed

  // ---- technologies (costs are scaled down so a company grows in days, not decades) ----
  const TECH = {
    solar:   { name: 'Solar farm', short: 'Solar', color: '#c98500', sizes: [50, 100, 200], capex: 2600, build: 2, upkeep: 10, vc: 0, emis: 0, kind: 'vre',
               blurb: 'Free sunshine. Every panel in the region floods the market at midday, so prices sag when you need them.' },
    wind:    { name: 'Wind farm', short: 'Wind', color: '#199e70', sizes: [60, 120, 240], capex: 7000, build: 4, upkeep: 32, vc: 0, emis: 0, kind: 'vre',
               blurb: 'Runs day and night while it blows, including the evening peak. Still weeks hurt.' },
    battery: { name: 'Battery', short: 'Battery', color: '#9085e9', sizes: [25, 50, 100], hours: 2, capex: 3400, build: 1.5, upkeep: 12, vc: 5, eff: 0.86, kind: 'storage', fcas: true,
               blurb: 'Charges when power is cheap and sells into the peak. The best at frequency control.' },
    peaker:  { name: 'Gas peaker', short: 'Peaker', color: '#d95926', sizes: [50, 150, 300], capex: 6000, build: 3, upkeep: 14, vc: 150, emis: 0.6, kind: 'thermal', fcas: true, outage: 0.006,
               blurb: 'Dear to run, but on in minutes when prices spike. Insurance for heatwaves.' },
    ccgt:    { name: 'Combined-cycle gas', short: 'CCGT', color: '#d95926', sizes: [200, 400], capex: 9000, build: 6, upkeep: 30, vc: 82, emis: 0.38, kind: 'thermal', ramp: 0.25, outage: 0.008,
               blurb: 'Efficient gas for long evening and winter peaks. Pays when prices sit above $80.' },
    hydro:   { name: 'Pumped hydro', short: 'Hydro', color: '#3987e5', sizes: [250, 500], hours: 8, capex: 10000, build: 10, upkeep: 22, vc: 3, eff: 0.78, kind: 'storage', fcas: true,
               blurb: 'Pumps water uphill when power is cheap and runs it back down for hours of firm supply.' },
    coal:    { name: 'Coal unit', short: 'Coal', color: '#a8692a', sizes: [660], capex: 0, build: 0, upkeep: 75, vc: 32, emis: 0.95, kind: 'thermal', minLoad: 0.45, ramp: 0.05, outage: 0.014, buyOnly: true,
               blurb: 'Cheap power around the clock, but slow to change output, prone to breakdowns and heavy on emissions.' },
  };
  const OTHER = { name: 'Other', short: 'Other', color: '#6f828c' };
  const TECH_ORDER = ['peaker', 'ccgt', 'hydro', 'coal', 'battery', 'wind', 'solar'];   // stacking order (palette validated)

  const NAMES = {
    solar: ['Saltbush', 'Mallee Flat', 'Bluegum Plains', 'Red Gully', 'Wattle Downs', 'Emu Springs', 'Sandy Hollow', 'Brolga'],
    wind: ['Kestrel Ridge', 'Granite Hills', 'Cape Windy', 'Ironstone', 'High Paddock', 'Boobook Range'],
    battery: ['Ironbark', 'Stringybark', 'Kurrajong', 'Tuart', 'Coolabah', 'Grey Box', 'Yarran', 'Boree'],
    peaker: ['Quartz Creek', 'Billabong', 'Spinifex', 'Dingo Gap', 'Copper Flat'],
    ccgt: ['Tallowwood', 'Banksia Point', 'Riverina'],
    hydro: ['Tumut Gorge', 'Snowy Creek', 'Wombat Falls'],
    coal: [],
  };

  // ---- rival fleet ----
  function rivalFleet() {
    const coal = (n, name) => ({ id: `bh${n}`, name, tech: 'coal', cap: 660, out: 0, last: 520, closing: 0 });
    return [
      coal(1, 'Black Hill 1'), coal(2, 'Black Hill 2'), coal(3, 'Black Hill 3'), coal(4, 'Black Hill 4'),
      { id: 'tal', name: 'Tallawang CCGT', tech: 'ccgt', cap: 600, bands: [[0.5, 92], [0.5, 140]], out: 0 },
      { id: 'wol', name: 'Wollemi CCGT', tech: 'ccgt', cap: 450, bands: [[0.6, 105], [0.4, 175]], out: 0 },
      { id: 'ash', name: 'Ash Hill peaker', tech: 'peaker', cap: 300, bands: [[1, 380]], out: 0 },
      { id: 'cst', name: 'Coastal peakers', tech: 'peaker', cap: 600, bands: [[0.5, 450], [0.5, 950]], out: 0 },
      { id: 'mul', name: 'Mulga Creek peaker', tech: 'peaker', cap: 400, bands: [[1, 290]], out: 0 },
      { id: 'red', name: 'Redbank peaker', tech: 'peaker', cap: 400, bands: [[0.5, 620], [0.5, 1800]], out: 0 },
      { id: 'qry', name: 'Quarry Road peaker', tech: 'peaker', cap: 300, bands: [[1, 12500]], out: 0 },
      { id: 'snw', name: 'Snowgum hydro', tech: 'hydro', cap: 450, bands: [[0.6, 175], [0.4, 330]], budget: 3200, used: 0 },
      { id: 'rwind', name: 'Rival wind farms', tech: 'wind', cap: 2200, bid: -35 },
      { id: 'rsol', name: 'Rival solar farms', tech: 'solar', cap: 1700, bid: -25 },
      { id: 'rbat', name: 'Rival batteries', tech: 'battery', cap: 250, hours: 2, soc: 250 },
      { id: 'imp', name: 'Interconnector', tech: 'other', cap: 700 },
      { id: 'dsp', name: 'Demand response', tech: 'other', cap: 350, bands: [[1, 1400]] },
    ];
  }

  // ---- random numbers: separate streams so weather and events are identical for everyone
  //      playing the same challenge, whatever they build ----
  function rnd(S, stream) {
    let a = (S.rng[stream] = (S.rng[stream] + 0x6D2B79F5) >>> 0);
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const W = 0, P = 1;   // weather/events stream, player stream

  // ---- events ----
  const EVENTS = {
    heatwave: { name: 'Heatwave', days: [2, 4], tone: 'bad', news: 'A heatwave is coming. Air conditioners will push demand to records in the late afternoon.' },
    cold:     { name: 'Cold snap', days: [2, 3], tone: 'bad', news: 'A cold snap is on its way. Expect big evening heating demand.' },
    still:    { name: 'Still week', days: [3, 6], tone: 'bad', news: 'A high-pressure system parks over the region. Wind farms will be nearly idle.' },
    windy:    { name: 'Windy spell', days: [2, 4], tone: 'good', news: 'Strong fronts are crossing the region. Wind output will be high.' },
    cloudy:   { name: 'Cloudy spell', days: [2, 4], tone: 'bad', news: 'Thick cloud is forecast. Solar output will be well down.' },
    linktrip: { name: 'Interconnector out', days: [1, 2], tone: 'bad', news: 'A bushfire has tripped the interconnector. No imports until it is repaired.' },
    gascrunch:{ name: 'Gas squeeze', days: [3, 5], tone: 'bad', news: 'Gas supply is tight. Fuel for gas plants costs much more this week.' },
  };

  // ---- a new company ----
  function create(seed, opts = {}) {
    seed = seed >>> 0;
    const S = {
      v: 1, seed, rng: [seed ^ 0x9E3779B9, (seed * 2654435761) >>> 0],
      t: 0,                          // intervals since the start
      cash: opts.cash ?? 250000,
      plants: [], rivals: rivalFleet(), nameUse: {},
      wx: { wind: 0.33, cloud: 0.85, temp: 0, noise: 0, nb: 0 },
      events: [], upcoming: [], news: [], offer: null, obligation: null,
      rooftop: 3200,
      unlocked: { solar: true, battery: true, peaker: true },
      goalsDone: {}, costMult: {}, fuelMult: 1,
      today: freshDay(), days: [], last: null, totals: { profit: 0, energy: 0, fcas: 0, emis: 0 },
      challenge: opts.challenge || null,
      mode: opts.mode || 'career',
    };
    for (const k of Object.keys(TECH)) S.costMult[k] = 1;
    if (opts.challenge) Object.assign(S.unlocked, { wind: true });
    planEvents(S);
    return S;
  }
  function freshDay() {
    return { price: [], demand: [], mine: [], revenue: 0, costs: 0, fcas: 0, energy: 0, regionEnergy: 0, emis: 0, maxP: null, minP: null, upkeep: 0, penalties: 0, bonus: 0 };
  }

  // ---- calendar and weather ----
  const dayIndex = S => Math.floor(S.t / IPD);
  const hourOf = S => (S.t % IPD) * H;
  const doyOf = S => (START_DOY + dayIndex(S)) % 365;
  function seasonTemp(doy) { return 18.5 + 7.5 * Math.cos(2 * Math.PI * (doy - 15) / 365); }   // warm in January
  function activeEvent(S, key) { return S.events.find(e => e.key === key); }

  function solarShape(h, doy) {
    const summer = 0.5 + 0.5 * Math.cos(2 * Math.PI * (doy - 355) / 365);
    const rise = 6.6 - 1.0 * summer, set = 17.6 + 1.6 * summer;
    if (h <= rise || h >= set) return 0;
    const x = Math.sin(Math.PI * (h - rise) / (set - rise));
    return Math.pow(x, 1.25) * (0.68 + 0.32 * summer);
  }
  const bump = (h, c, w) => Math.exp(-0.5 * ((h - c) / w) * ((h - c) / w));

  // Advance the weather by one interval. Always draws the same number of random numbers.
  function stepWeather(S) {
    const wx = S.wx, doy = doyOf(S);
    const winter = 0.5 - 0.5 * Math.cos(2 * Math.PI * (doy - 15) / 365);
    let windTarget = 0.3 + 0.1 * winter;
    if (activeEvent(S, 'still')) windTarget = 0.07;
    if (activeEvent(S, 'windy')) windTarget = 0.62;
    let cloudTarget = 0.86;
    if (activeEvent(S, 'cloudy')) cloudTarget = 0.35;
    const r1 = rnd(S, W), r2 = rnd(S, W), r3 = rnd(S, W), r4 = rnd(S, W), r5 = rnd(S, W);
    wx.wind = Math.min(0.95, Math.max(0.02, wx.wind + 0.015 * (windTarget - wx.wind) + (r1 - 0.5) * 0.045));
    wx.cloud = Math.min(1, Math.max(0.15, wx.cloud + 0.02 * (cloudTarget - wx.cloud) + (r2 - 0.5) * 0.05));
    wx.temp = wx.temp * 0.997 + (r3 - 0.5) * 0.25;
    wx.noise = wx.noise * 0.96 + (r4 - 0.5) * 0.02;
    wx.nb = wx.nb * 0.97 + (r5 - 0.5) * 6;
  }

  function conditions(S) {
    const h = hourOf(S), doy = doyOf(S), wx = S.wx;
    const hw = activeEvent(S, 'heatwave'), cs = activeEvent(S, 'cold');
    let temp = seasonTemp(doy) + 5.5 * Math.cos(2 * Math.PI * (h - 15) / 24) + wx.temp * 4;
    if (hw) temp += 9 * (0.55 + 0.45 * bump(h, 16, 3.5));
    if (cs) temp -= 8;
    const shape = 0.72 + 0.09 * bump(h, 8, 1.4) + 0.08 * bump(h, 12.5, 3.5) + 0.26 * bump(h, 18.6, 1.9) - 0.05 * bump(h, 3.5, 2);
    let underlying = 5900 * shape * (1 + wx.noise);
    underlying += Math.max(0, temp - 24) * 170 * (0.4 + 0.6 * bump(h, 16.5, 4));
    underlying += Math.max(0, 14 - temp) * 105 * (0.5 + 0.5 * bump(h, 19, 3));
    const sun = solarShape(h, doy) * wx.cloud;
    const rooftop = S.rooftop * sun * 0.82;
    const demand = Math.max(2500, underlying - rooftop);
    const evening = bump(h, 18.5, 2.2), midday = bump(h, 12.5, 2.5);
    let nbPrice = 78 + 90 * evening - 55 * midday + wx.nb + (hw ? 120 * bump(h, 17, 3) : 0);
    return { h, doy, temp, sun, wind: wx.wind, demand, nbPrice, linkOut: !!activeEvent(S, 'linktrip') };
  }

  // ---- bids ----
  // Supply bands: {mw, price, tech, owner, ref}. Elastic demand bands: {mw, price, ref}.
  function percentile(arr, q) {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];
  }
  function storageStrategy(S, p, c) {
    const strat = p.strategy || 'arb';
    const ref = S.days.length ? S.days[S.days.length - 1].priceSorted : null;
    if (strat === 'custom') return { charge: p.chargeBelow ?? 40, discharge: p.dischargeAbove ?? 150 };
    if (strat === 'fcas') return null;
    if (strat === 'evening') {
      const inCharge = c.h >= 9.5 && c.h < 15.5, inSell = c.h >= 16.5 && c.h < 21.5;
      return { charge: inCharge ? 90 : -Infinity, discharge: inSell ? 40 : Infinity };
    }
    // arbitrage: buy in the cheapest quarter of yesterday's prices, sell in the dearest quarter
    const lo = ref ? percentile(ref, 0.25) : 40, hi = ref ? percentile(ref, 0.8) : 150;
    return { charge: Math.min(lo, 70), discharge: Math.max(hi, (lo ?? 40) + 60, 90) };
  }

  function buildBids(S, c) {
    const supply = [], demandBids = [];
    const gm = S.fuelMult;
    // rivals
    for (const r of S.rivals) {
      if (r.gone) continue;
      if (r.tech === 'coal') {
        if (r.out > 0) continue;
        const min = r.cap * 0.45, up = Math.min(r.cap, r.last + r.cap * 0.06), down = Math.max(min, r.last - r.cap * 0.06);
        supply.push({ mw: down, price: FLOOR, tech: 'coal', owner: 'rival', ref: r });
        const flex = up - down;
        if (flex > 0) { supply.push({ mw: flex * 0.7, price: 36, tech: 'coal', owner: 'rival', ref: r }); supply.push({ mw: flex * 0.3, price: 72, tech: 'coal', owner: 'rival', ref: r }); }
      } else if (r.tech === 'wind') {
        supply.push({ mw: r.cap * c.wind, price: r.bid, tech: 'wind', owner: 'rival', ref: r });
      } else if (r.tech === 'solar') {
        const mw = r.cap * c.sun; if (mw > 1) supply.push({ mw, price: r.bid, tech: 'solar', owner: 'rival', ref: r });
      } else if (r.tech === 'battery') {
        const pmw = r.cap, e = r.cap * r.hours;
        const dis = Math.min(pmw, r.soc / H);
        if (dis > 1) supply.push({ mw: dis, price: 165, tech: 'battery', owner: 'rival', ref: r, storage: true });
        const ch = Math.min(pmw, (e - r.soc) / H / 0.86);
        if (ch > 1) demandBids.push({ mw: ch, price: 35, ref: r });
      } else if (r.id === 'imp') {
        if (c.linkOut) continue;
        supply.push({ mw: r.cap, price: Math.max(10, c.nbPrice), tech: 'other', owner: 'rival', ref: r });
        demandBids.push({ mw: r.cap, price: Math.max(-50, c.nbPrice - 12), ref: r, exp: true });
      } else if (r.tech === 'hydro') {
        if (r.used >= r.budget) continue;
        for (const [f, pr] of r.bands) supply.push({ mw: r.cap * f, price: pr, tech: 'hydro', owner: 'rival', ref: r });
      } else {
        if (r.out > 0) continue;
        for (const [f, pr] of r.bands) {
          const price = (r.tech === 'ccgt' || r.tech === 'peaker') ? pr * (gm > 1 ? gm * 0.8 : 1) : pr;
          supply.push({ mw: r.cap * f, price, tech: r.tech === 'other' ? 'other' : r.tech, owner: 'rival', ref: r });
        }
      }
    }
    // player
    for (const p of S.plants) {
      if (p.status !== 'online') continue;
      const T = TECH[p.tech];
      if (T.kind === 'vre') {
        const mw = p.mw * (p.tech === 'solar' ? c.sun : c.wind * (p.site || 1));
        const price = p.bid === 'nonneg' ? 0 : p.bid === 'custom' ? (p.price ?? 0) : FLOOR;
        if (mw > 0.1) supply.push({ mw, price, tech: p.tech, owner: 'player', ref: p });
      } else if (T.kind === 'thermal') {
        const vc = T.vc * (p.tech === 'coal' ? 1 : gm);
        const price = p.bid === 'peak' ? Math.max(300, vc * 2.5) : p.bid === 'custom' ? (p.price ?? vc) : vc;
        if (p.tech === 'coal') {
          const min = p.mw * T.minLoad, up = Math.min(p.mw, (p.last ?? min) + p.mw * T.ramp), down = Math.max(min, (p.last ?? min) - p.mw * T.ramp);
          supply.push({ mw: down, price: FLOOR, tech: 'coal', owner: 'player', ref: p });
          if (up > down) supply.push({ mw: up - down, price, tech: 'coal', owner: 'player', ref: p });
        } else {
          const mw = T.ramp ? Math.min(p.mw, (p.last ?? 0) + p.mw * T.ramp) : p.mw;
          supply.push({ mw, price, tech: p.tech, owner: 'player', ref: p });
        }
      } else {   // storage
        const st = storageStrategy(S, p, c);
        if (!st) continue;
        const e = p.mw * T.hours;
        const dis = Math.min(p.mw, p.soc / H);
        if (dis > 0.5 && st.discharge < Infinity) supply.push({ mw: dis, price: st.discharge, tech: p.tech, owner: 'player', ref: p, storage: true });
        const ch = Math.min(p.mw, (e - p.soc) / H / T.eff);
        if (ch > 0.5 && st.charge > -Infinity) demandBids.push({ mw: ch, price: st.charge, ref: p, owner: 'player' });
      }
    }
    // a hair of tie-breaking so equal bids share in a stable order
    supply.forEach((b, i) => { b.key = b.price + i * 1e-7; });
    return { supply, demandBids };
  }

  // ---- uniform-price clearing ----
  function clear(supply, demandBids, fixed) {
    const prices = new Set([FLOOR, CAP]);
    for (const b of supply) prices.add(b.price);
    for (const d of demandBids) prices.add(d.price);
    const cand = [...prices].filter(p => p >= FLOOR && p <= CAP).sort((a, b) => a - b);
    const S = p => supply.reduce((a, b) => a + (b.price <= p ? b.mw : 0), 0);
    const Sbelow = p => supply.reduce((a, b) => a + (b.price < p ? b.mw : 0), 0);
    const D = p => fixed + demandBids.reduce((a, d) => a + (d.price >= p ? d.mw : 0), 0);
    const Dabove = p => fixed + demandBids.reduce((a, d) => a + (d.price > p ? d.mw : 0), 0);
    let price = CAP, shortfall = 0;
    for (const p of cand) { if (S(p) >= Dabove(p) - 1e-6) { price = p; break; } }
    if (S(CAP) < fixed - 1e-6) { price = CAP; shortfall = fixed - S(CAP); }
    // How much is traded: supply below the price runs in full, bands at the price share the rest.
    const sAt = supply.filter(b => b.price === price), dAt = demandBids.filter(d => d.price === price);
    const sFull = Sbelow(price), dFull = Dabove(price);
    const sAtTot = sAt.reduce((a, b) => a + b.mw, 0), dAtTot = dAt.reduce((a, d) => a + d.mw, 0);
    // traded quantity: as much as the marginal bands allow
    let q;
    if (shortfall > 0) q = S(CAP);
    else q = Math.max(Math.min(sFull + sAtTot, dFull + dAtTot), dFull);
    q = Math.max(q, sFull);
    const sShare = sAtTot > 0 ? Math.max(0, Math.min(1, (q - sFull) / sAtTot)) : 0;
    const dShare = dAtTot > 0 ? Math.max(0, Math.min(1, (q - dFull) / dAtTot)) : 0;
    for (const b of supply) b.out = b.price < price ? b.mw : b.price === price ? b.mw * sShare : 0;
    for (const d of demandBids) d.take = d.price > price ? d.mw : d.price === price ? d.mw * dShare : 0;
    return { price, shortfall, traded: q };
  }

  // ---- frequency control (one simplified raise service) ----
  function clearFcas(S, energyBids) {
    const offers = [
      { mw: 150, price: 2, owner: 'rival' }, { mw: 150, price: 5, owner: 'rival' }, { mw: 150, price: 8, owner: 'rival' },
      { mw: 120, price: 20, owner: 'rival' }, { mw: 100, price: 70, owner: 'rival' }, { mw: 60, price: 600, owner: 'rival' },
    ];
    for (const p of S.plants) {
      if (p.status !== 'online' || !TECH[p.tech].fcas || p.fcas === false) continue;
      const T = TECH[p.tech];
      let head;
      if (T.kind === 'storage') {
        const used = energyBids.reduce((a, b) => a + (b.ref === p ? (b.out ?? b.take ?? 0) : 0), 0);
        head = (p.strategy === 'fcas' ? p.mw : Math.max(0, p.mw - used)) * (p.soc > p.mw * T.hours * 0.1 ? 1 : 0);
      } else {
        const used = energyBids.reduce((a, b) => a + (b.ref === p ? (b.out ?? 0) : 0), 0);
        head = Math.max(0, p.mw - used) * 0.4;
      }
      if (head > 0.5) offers.push({ mw: head, price: 2, owner: 'player', ref: p });
    }
    const need = S.events.some(e => e.key === 'linktrip') ? 650 : 380;
    offers.sort((a, b) => a.price - b.price);
    let got = 0, price = 1000;
    for (const o of offers) {
      const take = Math.min(o.mw, need - got);
      o.take = Math.max(0, take); got += o.take;
      if (got >= need - 1e-6) { price = o.price; break; }
    }
    return { price, offers };
  }

  // ---- one dispatch interval ----
  function step(S) {
    if (S.t % IPD === 0 && S.t > 0) endOfDay(S);
    stepWeather(S);
    const c = conditions(S);
    const { supply, demandBids } = buildBids(S, c);
    let res = clear(supply, demandBids, c.demand);
    const fc = clearFcas(S, [...supply, ...demandBids]);

    // settle the player's money and storage
    const T = TECH, d = S.today;
    let rev = 0, cost = 0, fcasRev = 0, mine = 0, emis = 0;
    const out = new Map();
    for (const b of supply) {
      if (b.owner !== 'player') continue;
      const p = b.ref, t = T[p.tech];
      out.set(p, (out.get(p) || 0) + b.out);
      rev += b.out * res.price * H;
      const vc = t.kind === 'thermal' ? t.vc * (p.tech === 'coal' ? 1 : S.fuelMult) : t.vc;
      cost += b.out * vc * H;
      emis += b.out * t.emis * H;
      mine += b.out;
      if (b.storage) p.soc = Math.max(0, p.soc - b.out * H);
    }
    for (const db of demandBids) {
      if (db.owner !== 'player' || !db.take) continue;
      const p = db.ref, t = T[p.tech];
      rev -= db.take * res.price * H;
      p.soc = Math.min(p.mw * t.hours, p.soc + db.take * H * t.eff);
      out.set(p, (out.get(p) || 0) - db.take);
    }
    for (const o of fc.offers) if (o.owner === 'player' && o.take) fcasRev += o.take * fc.price * H;
    for (const p of S.plants) {
      const o = out.get(p) || 0;
      p.last = Math.max(0, o);
      p.now = o;
      if (p.status === 'online') {
        const pr = (p.today ||= { energy: 0, money: 0 });
        pr.energy += o * H;
      }
    }
    // per-plant money (for the plant cards)
    for (const b of supply) if (b.owner === 'player') { const pt = b.ref.today; const t = T[b.ref.tech]; const vc = t.kind === 'thermal' ? t.vc * (b.ref.tech === 'coal' ? 1 : S.fuelMult) : t.vc; pt.money += b.out * (res.price - vc) * H; }
    for (const db of demandBids) if (db.owner === 'player' && db.take) db.ref.today.money -= db.take * res.price * H;
    for (const o of fc.offers) if (o.owner === 'player' && o.take) o.ref.today.money += o.take * fc.price * H;

    // rivals' state
    for (const b of supply) if (b.owner === 'rival') {
      const r = b.ref;
      if (r.tech === 'coal') r.lastAcc = (r.lastAcc || 0) + b.out;
      if (r.tech === 'battery') r.soc = Math.max(0, r.soc - b.out * H);
      if (r.tech === 'hydro') r.used += b.out * H;
    }
    for (const r of S.rivals) if (r.tech === 'coal') { r.last = r.lastAcc ?? (r.out > 0 ? 0 : r.cap * 0.45); r.lastAcc = 0; }
    for (const db of demandBids) if (db.owner !== 'player' && db.ref.tech === 'battery') db.ref.soc = Math.min(db.ref.cap * db.ref.hours, db.ref.soc + db.take * H * 0.86);

    S.cash += rev - cost + fcasRev;
    d.revenue += rev; d.costs += cost; d.fcas += fcasRev; d.emis += emis;
    d.energy += Math.max(0, mine) * H; d.regionEnergy += c.demand * H;
    d.price.push(res.price); d.demand.push(c.demand); d.mine.push(Math.max(0, mine));
    d.maxP = d.maxP == null ? res.price : Math.max(d.maxP, res.price); d.minP = d.minP == null ? res.price : Math.min(d.minP, res.price);
    S.totals.fcas += fcasRev; S.totals.emis += emis;

    // reliability obligation window
    if (S.obligation && S.t >= S.obligation.from && S.t < S.obligation.to) {
      const firm = firmCapacity(S, true);
      S.obligation.worst = S.obligation.worst == null ? firm : Math.min(S.obligation.worst, firm);
    }
    if (res.shortfall > 0) {
      d.shed = (d.shed || 0) + res.shortfall * H;
      if (!d.shedNews) { d.shedNews = true; addNews(S, 'bad', `Supply ran short at ${clock(c.h)}. The operator cut ${fmtMW(res.shortfall)} of customers and the price hit the cap.`); }
    }

    // construction, outages
    for (const p of S.plants) {
      if (p.status === 'building') {
        p.buildLeft -= 1 / IPD;
        if (p.buildLeft <= 0) { p.status = 'online'; p.today = { energy: 0, money: 0 }; addNews(S, 'good', `${p.name} is connected and trading.`); }
      }
    }

    S.last = { c, res, fc, supply, demandBids, mine, rev: rev - cost + fcasRev };
    S.t++;
    if (S.obligation && S.t >= S.obligation.to) settleObligation(S);
    return S.last;
  }

  function firmCapacity(S, live) {
    let mw = 0;
    for (const p of S.plants) {
      if (p.status !== 'online') continue;
      const T = TECH[p.tech];
      if (T.kind === 'thermal') mw += p.mw;
      else if (T.kind === 'storage') mw += live ? Math.min(p.mw, p.soc / 2) : p.mw;
    }
    return mw;
  }

  function settleObligation(S) {
    const o = S.obligation; S.obligation = null;
    const short = Math.max(0, o.mw - (o.worst ?? 0));
    if (short > 1) {
      const pen = Math.round(short / o.mw * o.payment * 3);
      S.cash -= pen; S.today.penalties += pen;
      addNews(S, 'bad', `You were ${fmtMW(short)} short of the reserve you promised. Penalty: ${fmtMoney(pen)}.`);
    } else {
      S.goalFlags = { ...(S.goalFlags || {}), reserveKept: true };
      addNews(S, 'good', `You kept your reserve promise through the shortfall. Well done.`);
    }
  }

  // ---- end of day: upkeep, records, outages, events, offers, goals ----
  function endOfDay(S) {
    const d = S.today, day = dayIndex(S) - 1;
    let upkeep = 0;
    for (const p of S.plants) if (p.status !== 'building') upkeep += p.mw * TECH[p.tech].upkeep;
    S.cash -= upkeep; d.upkeep = upkeep;
    const profit = d.revenue - d.costs + d.fcas - upkeep - d.penalties + d.bonus;
    const priceSorted = [...d.price].sort((a, b) => a - b);
    const avg = d.price.reduce((a, b) => a + b, 0) / Math.max(1, d.price.length);
    const rec = { day, profit, revenue: d.revenue, costs: d.costs, fcas: d.fcas, upkeep, energy: d.energy, share: d.energy / Math.max(1, d.regionEnergy),
      avg, max: d.maxP, min: d.minP, emis: d.emis, priceSorted, price: d.price, demand: d.demand, mine: d.mine, shed: d.shed || 0, penalties: d.penalties };
    S.days.push(rec);
    if (S.days.length > 3) { const old = S.days[S.days.length - 4]; delete old.price; delete old.demand; delete old.mine; }
    if (S.days.length > 60) S.days.shift();
    S.totals.profit += profit; S.totals.energy += d.energy;
    for (const p of S.plants) p.today = { energy: 0, money: 0 };
    S.today = freshDay();

    // rivals: hydro water budget refills, outages count down, breakdowns
    for (const r of S.rivals) {
      if (r.tech === 'hydro') r.used = 0;
      if (r.out > 0) { r.out--; if (r.out === 0) addNews(S, 'info', `${r.name} is back online.`); }
      if (r.tech === 'coal' && !r.gone) {
        const roll = rnd(S, W), len = rnd(S, W);
        if (r.out === 0 && roll < (activeEvent(S, 'heatwave') ? 0.05 : 0.015)) {
          r.out = 1 + Math.floor(len * 3);
          addNews(S, 'info', `${r.name} has broken down and will be out for about ${r.out} day${r.out > 1 ? 's' : ''}. Prices may rise.`);
        }
        if (r.closing && dayIndex(S) >= r.closing) { r.gone = true; addNews(S, 'info', `${r.name} has closed for good after 45 years. The region has ${fmtMW(r.cap)} less coal.`); }
      }
    }
    // player plants: breakdowns and repairs
    for (const p of S.plants) {
      const T = TECH[p.tech];
      if (p.status === 'outage') { p.outLeft--; if (p.outLeft <= 0) { p.status = 'online'; addNews(S, 'good', `${p.name} is repaired and back online.`); } }
      else if (p.status === 'online' && T.outage) {
        const roll = rnd(S, P), len = rnd(S, P);
        if (roll < T.outage) { p.status = 'outage'; p.outLeft = 1 + Math.floor(len * 2); const fix = Math.round(p.mw * 60); S.cash -= fix; addNews(S, 'bad', `${p.name} has broken down. Repairs cost ${fmtMoney(fix)} and take ${p.outLeft} day${p.outLeft > 1 ? 's' : ''}.`); }
      }
      if (p.status === 'retiring') { p.retireLeft--; if (p.retireLeft <= 0) { p.status = 'closed'; addNews(S, 'info', `${p.name} has closed.`); } }
    }
    S.plants = S.plants.filter(p => p.status !== 'closed');

    // events: today's ones age, tomorrow's begin, new ones are forecast a day ahead
    S.events = S.events.filter(e => --e.left > 0);
    if (!S.events.some(e => e.key === 'gascrunch')) S.fuelMult = 1;
    for (const u of S.upcoming.filter(u => u.start <= dayIndex(S))) {
      S.events.push({ key: u.key, left: u.len });
      if (u.key === 'gascrunch') S.fuelMult = 1.9;
    }
    S.upcoming = S.upcoming.filter(u => u.start > dayIndex(S));
    planEvents(S);

    // rooftop solar keeps growing; costs drift each 60 days
    S.rooftop *= 1.0012;
    if (dayIndex(S) % 60 === 0) { S.costMult.battery *= 0.96; S.costMult.solar *= 0.97; S.costMult.wind *= 0.985; S.costMult.hydro *= 0.99; }
    // emissions: every 30 days the regulator checks your intensity
    if (dayIndex(S) % 30 === 0) emissionsCheck(S);
    // rivals invest too: a month of high prices brings new peaking plant or batteries
    if (dayIndex(S) % 15 === 0 && S.days.length >= 15) rivalInvestment(S);
    // a rival coal unit announces its closure on day 40 and closes on day 70
    if (dayIndex(S) === 40 && !S.challenge) { const r = S.rivals.find(x => x.id === 'bh1'); r.closing = 70; addNews(S, 'info', 'Black Hill 1 will close for good in 30 days. That leaves a gap in the evening peak.'); }
    makeOffers(S);
    checkGoals(S, rec);
  }

  function rivalInvestment(S) {
    const last = S.days.slice(-15);
    const avg = last.reduce((a, d) => a + d.avg, 0) / last.length;
    if (avg <= 140) return;
    const n = (S.rivalBuilds = (S.rivalBuilds || 0) + 1);
    const mw = Math.round(Math.min(600, (avg - 140) * 3 + 150) / 50) * 50;
    const battery = n % 2 === 0;
    const r = battery
      ? { id: `rb${n}`, name: `Rival battery ${n}`, tech: 'battery', cap: mw, hours: 2, soc: mw }
      : { id: `rp${n}`, name: `Rival peaker ${n}`, tech: 'peaker', cap: mw, bands: [[0.6, 320], [0.4, 520]], out: 0 };
    S.rivals.push(r);
    addNews(S, 'info', `Prices have averaged ${fmtPrice(avg)}/MWh lately, so a rival has built a ${fmtMW(mw)} ${battery ? 'battery' : 'gas peaker'}. Competition is coming.`);
  }

  function emissionsCheck(S) {
    const last = S.days.slice(-30);
    const energy = last.reduce((a, d) => a + d.energy, 0), emis = last.reduce((a, d) => a + d.emis, 0);
    if (energy < 1) return;
    const year = Math.floor(dayIndex(S) / 365);
    const target = Math.max(0.2, 0.7 - 0.08 * year);
    const intensity = emis / energy;
    if (intensity > target) {
      const over = emis - target * energy, pen = Math.round(over * 30);
      S.cash -= pen; S.today.penalties += pen;
      addNews(S, 'bad', `Your emissions were ${intensity.toFixed(2)} t per MWh, above the ${target.toFixed(2)} target. Penalty: ${fmtMoney(pen)}.`);
    } else if (emis > 0) {
      addNews(S, 'good', `Your emissions (${intensity.toFixed(2)} t per MWh) beat the ${target.toFixed(2)} target.`);
    }
  }

  function planEvents(S) {
    // Forecast tomorrow's weather events one day ahead. Fixed number of draws per day.
    const tomorrow = dayIndex(S) + 1, doy = (START_DOY + tomorrow) % 365;
    const summer = 0.5 + 0.5 * Math.cos(2 * Math.PI * (doy - 15) / 365);
    const r = [rnd(S, W), rnd(S, W), rnd(S, W)];
    if (S.upcoming.some(u => u.start >= tomorrow) || S.events.length >= 2) return;
    const odds = [['heatwave', 0.02 + 0.07 * summer], ['cold', 0.05 * (1 - summer)], ['still', 0.05], ['windy', 0.05], ['cloudy', 0.05], ['linktrip', 0.015], ['gascrunch', 0.012]];
    let acc = 0;
    for (const [key, p] of odds) {
      acc += p;
      if (r[0] < acc) {
        if (S.events.some(e => e.key === key)) return;
        const [a, b] = EVENTS[key].days, len = a + Math.floor(r[1] * (b - a + 1));
        S.upcoming.push({ key, start: tomorrow, len });
        addNews(S, EVENTS[key].tone, `Forecast: ${EVENTS[key].news}`);
        if (key === 'heatwave') offerReserve(S, tomorrow, len, r[2]);
        return;
      }
    }
  }

  function offerReserve(S, day, len, r) {
    const firm = firmCapacity(S, false);
    if (firm < 20) return;
    const mw = Math.round(firm * 0.8 / 5) * 5, payment = Math.round(mw * (90 + 60 * r));
    S.offer = { type: 'reserve', mw, payment, from: day * IPD + Math.round(15 / H), to: day * IPD + Math.round(20 / H), expires: day * IPD,
      text: `The market operator expects a supply shortfall tomorrow afternoon. Promise ${fmtMW(mw)} of reserve between 3 and 8 pm for ${fmtMoney(payment)}? If you can't deliver, you pay back three times the shortfall.` };
  }

  function makeOffers(S) {
    if (S.offer && S.t >= S.offer.expires) S.offer = null;
    if (S.offer || S.challenge) return;
    const day = dayIndex(S);
    if (day >= 12 && day % 17 === 5) {
      const r = S.rivals.find(x => x.tech === 'coal' && !x.gone && !x.closing && !x.sold && x.id !== 'bh1');
      if (r) {
        const price = Math.round(r.cap * 950 * Math.max(0.6, 1 - day / 400));
        S.offer = { type: 'coal', rival: r.id, price, expires: S.t + IPD * 2,
          text: `The owner of ${r.name} (${fmtMW(r.cap)} of coal) wants out and offers it to you for ${fmtMoney(price)}. It earns well most nights, but it's slow, breaks down and counts heavily against your emissions target.` };
      }
    }
  }

  function acceptOffer(S) {
    const o = S.offer; if (!o) return false;
    if (o.type === 'reserve') {
      S.cash += o.payment; S.today.bonus += o.payment;
      S.obligation = { mw: o.mw, payment: o.payment, from: o.from, to: o.to, worst: null };
      addNews(S, 'info', `You promised ${fmtMW(o.mw)} of reserve for tomorrow afternoon and were paid ${fmtMoney(o.payment)}. Keep it available.`);
    } else if (o.type === 'coal') {
      if (S.cash < o.price) return false;
      const r = S.rivals.find(x => x.id === o.rival);
      S.cash -= o.price; r.gone = true; r.sold = true;
      S.plants.push({ id: `p${S.t}`, tech: 'coal', mw: r.cap, name: r.name, status: 'online', bid: 'cost', soc: 0, last: r.cap * 0.45, today: { energy: 0, money: 0 }, built: S.t, value: o.price });
      addNews(S, 'info', `You bought ${r.name}. It's yours to run, and to retire.`);
    }
    S.offer = null;
    return true;
  }
  function declineOffer(S) { S.offer = null; }

  // ---- building and closing ----
  function priceOf(S, tech, mw) { return Math.round(TECH[tech].capex * S.costMult[tech] * mw / 100) * 100; }
  function nameFor(S, tech) {
    const list = NAMES[tech], k = S.nameUse[tech] || 0; S.nameUse[tech] = k + 1;
    const base = list[k % list.length] + (k >= list.length ? ` ${Math.floor(k / list.length) + 1}` : '');
    return `${base} ${tech === 'solar' ? 'Solar' : tech === 'wind' ? 'Wind' : tech === 'battery' ? 'Battery' : tech === 'peaker' ? 'Peaker' : tech === 'ccgt' ? 'Gas' : 'Hydro'}`;
  }
  function build(S, tech, mw) {
    const T = TECH[tech];
    if (!S.unlocked[tech] || T.buyOnly) return { ok: false, why: 'locked' };
    const cost = priceOf(S, tech, mw);
    if (S.cash < cost) return { ok: false, why: 'cash' };
    S.cash -= cost;
    const p = { id: `p${S.t}_${S.plants.length}`, tech, mw, name: nameFor(S, tech), status: 'building', buildLeft: T.build, built: S.t, value: cost,
      bid: T.kind === 'vre' ? 'always' : T.kind === 'thermal' ? (tech === 'peaker' ? 'peak' : 'cost') : undefined,
      strategy: T.kind === 'storage' ? 'arb' : undefined, soc: T.kind === 'storage' ? mw * T.hours * 0.5 : 0, last: 0, fcas: T.fcas ? true : undefined, today: { energy: 0, money: 0 } };
    S.plants.push(p);
    addNews(S, 'info', `Construction has started on ${p.name} (${fmtMW(mw)}). It connects in ${T.build} day${T.build === 1 ? '' : 's'}.`);
    return { ok: true, plant: p };
  }
  function retire(S, p) {
    if (p.tech === 'coal') { p.status = 'retiring'; p.retireLeft = 5; addNews(S, 'info', `You've given notice to close ${p.name}. It runs for 5 more days, as the rules require.`); return; }
    const refund = Math.round(p.value * 0.4);
    S.cash += refund; p.status = 'closed'; S.plants = S.plants.filter(x => x !== p);
    addNews(S, 'info', `You sold ${p.name} for ${fmtMoney(refund)}.`);
  }

  // ---- goals ----
  const GOALS = [
    { id: 'first', text: 'Build your first plant', reward: 20000, test: S => S.plants.length > 0 },
    { id: 'day10k', text: 'Make $10k profit in one day', reward: 0, unlock: 'wind', test: (S, d) => d && d.profit >= 10000 },
    { id: 'fcas', text: 'Earn $5k from frequency control', reward: 15000, test: S => S.totals.fcas >= 5000 },
    { id: 'share5', text: 'Supply 5% of the region in one day', reward: 0, unlock: 'ccgt', test: (S, d) => d && d.share >= 0.05 },
    { id: 'reserve', text: 'Keep a reserve promise through a shortfall', reward: 60000, test: S => S.goalFlags?.reserveKept },
    { id: 'mw500', text: 'Own 500 MW of plant', reward: 0, unlock: 'hydro', test: S => S.plants.reduce((a, p) => a + p.mw, 0) >= 500 },
    { id: 'day100k', text: 'Make $100k profit in one day', reward: 100000, test: (S, d) => d && d.profit >= 100000 },
    { id: 'value5m', text: 'Grow your company to $5M', reward: 250000, test: S => companyValue(S) >= 5e6 },
    { id: 'share25', text: 'Supply a quarter of the region in one day', reward: 500000, test: (S, d) => d && d.share >= 0.25 },
  ];
  function checkGoals(S, d) {
    for (const g of GOALS) {
      if (S.goalsDone[g.id] || !g.test(S, d)) continue;
      S.goalsDone[g.id] = dayIndex(S);
      if (g.reward) { S.cash += g.reward; }
      if (g.unlock) S.unlocked[g.unlock] = true;
      addNews(S, 'good', `Goal reached: ${g.text}.${g.reward ? ` Bonus ${fmtMoney(g.reward)}.` : ''}${g.unlock ? ` You can now build ${TECH[g.unlock].name.toLowerCase()}s.` : ''}`);
    }
  }
  function companyValue(S) {
    return S.cash + S.plants.reduce((a, p) => a + (p.value || 0) * (p.status === 'building' ? 1 : 0.8), 0);
  }

  // ---- news ----
  function addNews(S, tone, text) {
    S.news.unshift({ t: S.t, tone, text });
    if (S.news.length > 40) S.news.length = 40;
  }

  // ---- catching up after time away ----
  function catchUp(S, intervals) {
    const n = Math.min(intervals, AWAY_CAP_DAYS * IPD);
    const before = { cash: S.cash, t: S.t, news: S.news.length ? S.news[0] : null, energy: S.totals.energy + S.today.energy };
    let maxP = -Infinity, minP = Infinity, shed = 0;
    for (let k = 0; k < n; k++) {
      // auto-decline offers that expire while you're away
      if (S.offer && S.t >= S.offer.expires) S.offer = null;
      const r = step(S);
      maxP = Math.max(maxP, r.res.price); minP = Math.min(minP, r.res.price);
      if (r.res.shortfall) shed++;
    }
    const newNews = [];
    for (const n2 of S.news) { if (n2 === before.news) break; newNews.push(n2); }
    return { intervals: n, capped: intervals > n, profit: S.cash - before.cash, maxP, minP, shed, news: newNews.slice(0, 8),
      energy: S.totals.energy + S.today.energy - before.energy };
  }

  // ---- formatting ----
  function fmtMoney(v) {
    const s = v < 0 ? '−' : '', a = Math.abs(v);
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
    if (a >= 1e4) return `${s}$${Math.round(a / 1e3)}k`;
    if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
    return `${s}$${Math.round(a)}`;
  }
  function fmtMW(v) { return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} GW` : `${Math.round(v)} MW`; }
  function fmtPrice(v) { const s = v < 0 ? '−' : ''; const a = Math.abs(v); return `${s}$${a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : Math.round(a)}`; }
  function clock(h) { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); const ap = hh >= 12 ? 'pm' : 'am'; const h12 = ((hh + 11) % 12) + 1; return `${h12}:${String(mm).padStart(2, '0')} ${ap}`; }
  function dateLabel(S) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], len = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let d = doyOf(S), m = 0; while (d >= len[m]) { d -= len[m]; m++; }
    const year = Math.floor((START_DOY + dayIndex(S)) / 365) + 1;
    return { day: dayIndex(S) + 1, date: `${d + 1} ${months[m]}`, year, time: clock(hourOf(S)) };
  }

  return { IPD, H, FLOOR, CAP, TECH, TECH_ORDER, OTHER, GOALS, EVENTS, AWAY_CAP_DAYS,
    create, step, catchUp, build, retire, acceptOffer, declineOffer, priceOf, companyValue, firmCapacity, conditions,
    fmtMoney, fmtMW, fmtPrice, clock, dateLabel, dayIndex, hourOf, rnd };
})();
if (typeof module !== 'undefined') module.exports = Sim;
