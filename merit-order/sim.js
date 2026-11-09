// Merit Order: the market engine. No DOM here; the page and the tests both use it.
// One region, a 5-minute dispatch: every generator's bids are stacked cheapest-first and the
// last megawatt needed sets the price everyone is paid.
/* exported Sim */
const Sim = (() => {
  'use strict';

  const IPD = 288;                 // dispatch intervals per day
  const H = 5 / 60;                // hours per interval
  const FLOOR = -1000;             // market price floor, $/MWh
  const CAP = 23200;               // market price cap, $/MWh (NEM 2026-27)
  const START_DOY = 304;          // the game starts on 1 November (late spring)
  const AWAY_CAP_DAYS = 7;         // most game days simulated while the app was closed

  // ---- technologies (costs are scaled down so a company grows in days, not decades) ----
  const TECH = {
    solar:   { name: 'Solar farm', short: 'Solar', color: '#c98500', sizes: [50, 100, 200], range: [10, 400], connect: 50000, capexMW: 6500, capex: 7500, build: 2, upkeep: 15, vc: 0, emis: 0, kind: 'vre', fcasLower: true,
               blurb: 'Free sunshine. Every panel in the region floods the market at midday, so prices sag when you need them.' },
    wind:    { name: 'Wind farm', short: 'Wind', color: '#199e70', sizes: [60, 120, 240], range: [20, 500], connect: 80000, capexMW: 15700, capex: 17000, build: 4, upkeep: 45, vc: 0, emis: 0, kind: 'vre', fcasLower: true,
               blurb: 'Runs day and night while it blows, including the evening peak. Still weeks hurt.' },
    battery: { name: 'Battery', short: 'Battery', color: '#9085e9', sizes: [25, 50, 100], range: [5, 400], hours: 2, hoursRange: [0.5, 8], connect: 25000, capexMW: 3000, capexMWh: 2500, capex: 9000, build: 1.5, upkeep: 18, upkeepMW: 10, upkeepMWh: 4, vc: 5, eff: 0.86, kind: 'storage', fcas: true, fcasLower: true, fade: 0.025,
               blurb: 'Charges when power is cheap and sells into the peak. The best at frequency control.' },
    peaker:  { name: 'Gas peaker', short: 'Peaker', color: '#d95926', sizes: [50, 150, 300], range: [20, 600], connect: 50000, capexMW: 12500, capex: 11000, build: 3, upkeep: 22, vc: 150, emis: 0.6, kind: 'thermal', fcas: true, fcasLower: true, outage: 0.006, startCost: 25, minRun: 6, stableLoad: 0.3, startMargin: 30,
               blurb: 'Dear to run, but on in minutes when prices spike. Insurance for heatwaves.' },
    ccgt:    { name: 'Combined-cycle gas', short: 'CCGT', color: '#d95926', sizes: [200, 400], range: [100, 800], connect: 200000, capexMW: 20000, capex: 21000, build: 6, upkeep: 45, vc: 82, emis: 0.38, kind: 'thermal', ramp: 0.25, fcasLower: true, outage: 0.008, startCost: 90, minRun: 48, stableLoad: 0.4, startMargin: 12,
               blurb: 'Efficient gas for long evening and winter peaks. Pays when prices sit above $80.' },
    hydro:   { name: 'Pumped hydro', short: 'Hydro', color: '#3987e5', sizes: [250, 500], range: [100, 1000], hours: 8, capexMW: 8000, capex: 19000, build: 10, upkeep: 35, upkeepMW: 25, upkeepMWh: 1.25, vc: 3, eff: 0.78, kind: 'storage', fcas: true, fcasLower: true,
               blurb: 'Pumps water uphill when power is cheap and runs it back down for hours of firm supply.' },
    offshore: { name: 'Offshore wind', short: 'Offshore', color: '#199e70', sizes: [300, 600, 1000], range: [200, 1500], connect: 400000, capexMW: 30000, capex: 30000, build: 10, upkeep: 80, vc: 0, emis: 0, kind: 'vre', fcasLower: true, steady: 0.12, transition: true,
               blurb: 'Big turbines out at sea: stronger, steadier wind than on land, at a high price and a long build.' },
    ldes:    { name: 'Long-duration storage', short: 'Long storage', color: '#9085e9', sizes: [100, 200, 400], range: [50, 800], hours: 12, hoursRange: [8, 24], connect: 50000, capexMW: 4000, capexMWh: 350, capex: 8200, build: 6, upkeep: 15, upkeepMW: 10, upkeepMWh: 0.6, vc: 3, eff: 0.6, kind: 'storage', fcas: true, fcasLower: true, transition: true, fade: 0.01,
               blurb: 'Cheap storage that lasts all night or through a still day, but loses 40% of what it stores.' },
    coal:    { name: 'Coal unit', short: 'Coal', color: '#a8692a', sizes: [660], capex: 0, build: 0, upkeep: 90, vc: 32, emis: 0.95, kind: 'thermal', minLoad: 0.45, ramp: 0.05, outage: 0.014, buyOnly: true,
               blurb: 'Cheap power around the clock, but slow to change output, prone to breakdowns and heavy on emissions.' },
  };
  const OTHER = { name: 'Other', short: 'Other', color: '#6f828c' };
  // Renewable certificates (like the NEM's LGCs): wind and solar earn this on every MWh they sell.
  const CERT = 10;

  // ---- sites: where you build changes what you get ----
  // mlf: marginal loss factor (each MWh is paid price x mlf, and offers rank at offer / mlf, as in the
  // NEM). res: sun or wind compared with average. room: MW the local network can take, for all your
  // plants there. Pumped hydro sites have a fixed reservoir, a turbine range and room for one plant.
  // The first site in each list is the balanced default.
  const SITES = {
    solar: [
      { id: 'riverina', name: 'Riverina Flats', mlf: 0.96, res: 1.04, room: 400, blurb: 'Good sun, a fair way from the city.' },
      { id: 'far-west', name: 'Far West Plains', mlf: 0.90, res: 1.12, room: 600, blurb: 'The strongest sun in the region, at the end of a long line.' },
      { id: 'city-fringe', name: 'City Fringe', mlf: 1.01, res: 0.95, room: 150, blurb: 'Hazier, but right next to the load.' },
      { id: 'cw-rez', name: 'Central-West REZ', mlf: 0.94, res: 1.08, room: 2500, line: 1500, opens: 5, blurb: 'A Renewable Energy Zone: a new high-voltage line with room for gigawatts.' },
      { id: 'sw-rez', name: 'South-West REZ', mlf: 0.92, res: 1.10, room: 3000, line: 2000, opens: 10, blurb: 'The second solar zone, far out but enormous.' },
      { id: 'cw-rez-2', name: 'Central-West REZ stage 2', mlf: 0.93, res: 1.08, room: 2500, line: 2000, opens: 17, blurb: 'A second line into the Central-West, with room for more.' },
    ],
    wind: [
      { id: 'tablelands', name: 'Northern Tablelands', mlf: 0.95, res: 1.10, room: 400, blurb: 'Steady winds on high country.' },
      { id: 'cape', name: 'Cape Windy', mlf: 0.88, res: 1.25, room: 600, blurb: 'Roaring coastal winds, far from anyone who needs the power.' },
      { id: 'ranges', name: 'Western Ranges', mlf: 1.00, res: 0.95, room: 200, blurb: 'Lighter winds, close to the main grid.' },
      { id: 'ne-rez', name: 'New England REZ', mlf: 0.93, res: 1.15, room: 2500, line: 1500, opens: 5, blurb: 'A Renewable Energy Zone on the windy tablelands.' },
      { id: 'hunter-rez', name: 'Hunter REZ', mlf: 0.97, res: 1.05, room: 2000, opens: 10, blurb: 'Old coal country, re-wired for wind. The coal stations’ strong grid carries everything you build.' },
      { id: 'ne-rez-2', name: 'New England REZ stage 2', mlf: 0.92, res: 1.12, room: 2000, line: 1500, opens: 13, blurb: 'More of the windy tablelands, on a new line of its own.' },
    ],
    offshore: [
      { id: 'hunter-off', name: 'Hunter Coast', mlf: 0.98, res: 1.0, room: 1500, blurb: 'Offshore from the old coal port, close to the grid.' },
      { id: 'south-off', name: 'Southern Coast', mlf: 0.93, res: 1.15, room: 2500, blurb: 'Stronger winds, a longer cable.' },
      { id: 'illawarra', name: 'Illawarra Coast', mlf: 1.0, res: 1.05, room: 2000, opens: 13, blurb: 'Close to the steelworks and the city.' },
    ],
    battery: [
      { id: 'hub', name: 'Regional Hub', mlf: 0.98, room: 400, blurb: 'A busy substation between the farms and the city.' },
      { id: 'city', name: 'City Substation', mlf: 1.02, room: 200, connect: 1.4, blurb: 'Right at the load: the best loss factor, dear land.' },
      { id: 'rez', name: 'Renewable Zone', mlf: 0.93, room: 600, connect: 0.7, blurb: 'Shares a connection with the wind and solar farms. Cheap to hook up.' },
      { id: 'bh-yard', name: 'Black Hill Switchyard', mlf: 1.0, room: 1500, connect: 0.6, opens: 3, blurb: 'The closed coal station’s grid connection, going spare.' },
      { id: 'wollemi', name: 'Wollemi Switchyard', mlf: 0.99, room: 1500, connect: 0.6, opens: 15, blurb: 'The retired gas plant’s connection, reused.' },
    ],
    peaker: [
      { id: 'gas-hub', name: 'Pipeline Hub', mlf: 0.98, room: 800, blurb: 'On the main gas pipeline.' },
      { id: 'port', name: 'Port Industrial', mlf: 1.02, room: 400, connect: 1.4, blurb: 'Near the city and its peak demand.' },
      { id: 'inland', name: 'Inland Junction', mlf: 0.93, room: 800, connect: 0.75, blurb: 'Cheap land and a cheap connection, a long way out.' },
      { id: 'firming', name: 'Hunter Firming Hub', mlf: 0.99, room: 1500, opens: 9, blurb: 'A pipeline spur built for firming plant as the coal closes.' },
      { id: 'kurri', name: 'Kurri Kurri', mlf: 0.99, room: 1500, opens: 12, blurb: 'Hydrogen-ready turbines on an old smelter site: backup for still, dark weeks.' },
      { id: 'tallawang-gas', name: 'Tallawang Gas Site', mlf: 0.98, room: 1000, opens: 18, blurb: 'The retired plant’s pipeline and connection, ready for new turbines.' },
    ],
    hydro: [
      { id: 'wombat', name: 'Wombat Falls', mlf: 0.97, reservoir: 2000, mw: [150, 350], civil: 2750000, build: 10, blurb: 'A valley with room for a medium reservoir.' },
      { id: 'kangaroo', name: 'Kangaroo Valley', mlf: 1.01, reservoir: 1200, mw: [100, 200], civil: 1600000, build: 8, blurb: 'Small, close to the city.' },
      { id: 'snowy', name: 'Snowy Creek', mlf: 0.94, reservoir: 4000, mw: [250, 500], civil: 4500000, build: 12, blurb: 'A big alpine reservoir.' },
      { id: 'tumut', name: 'Tumut Gorge', mlf: 0.92, reservoir: 9000, mw: [400, 1000], civil: 9000000, build: 16, blurb: 'Huge, remote and slow to build.' },
    ],
  };
  SITES.ccgt = SITES.peaker;
  SITES.ldes = [
    { id: 'caverns', name: 'Old Mine Caverns', mlf: 0.92, room: 2000, blurb: 'Worked-out mines that can store compressed air.' },
    { id: 'bh-ldes', name: 'Black Hill Ash Dam', mlf: 1.0, room: 1500, opens: 9, blurb: 'The coal station’s old land and grid connection.' },
    { id: 'tallawang', name: 'Tallawang Site', mlf: 0.98, room: 1500, opens: 18, blurb: 'The last gas plant’s land, with its strong connection.' },
  ];
  // A Renewable Energy Zone opens in a given year of the Energy Transition (and never in the career).
  const siteOpen = (S, st) => st.opens == null || (!!S.transition && yearOf(S) + 1 >= st.opens);
  // A zone's line can carry less than the zone has room for: build past it and output is curtailed.
  const lineOf = (S, st) => st.line == null ? null : (S.lines && S.lines[st.id]) ?? st.line;
  const LEGACY = { id: 'legacy', name: 'Original site', mlf: 1, res: 1, room: Infinity, blurb: '' };
  function siteOf(tech, id) { return (SITES[tech] || []).find(x => x.id === id) || (id === 'legacy' || !SITES[tech] ? LEGACY : SITES[tech][0]); }
  function siteUsed(S, tech, id) { return S.plants.reduce((a, p) => a + ((p.site === id && (SITES[p.tech] === SITES[tech])) ? p.mw : 0), 0); }
  // How many MW a new plant can have at this site (hydro: its turbine range, one plant only).
  function siteRoom(S, tech, id) {
    const st = siteOf(tech, id), T = TECH[tech];
    if (!siteOpen(S, st)) return 0;
    if (tech === 'hydro') return S.plants.some(p => p.tech === 'hydro' && p.site === id) ? 0 : st.mw[1];
    return Math.max(0, Math.min(T.range ? T.range[1] : Infinity, st.room - siteUsed(S, tech, id)));
  }
  function siteFor(S, tech, mw) {   // the first site that can take this size
    for (const st of SITES[tech] || [LEGACY]) {
      if (tech === 'hydro') { if (siteRoom(S, tech, st.id) && mw >= st.mw[0] && mw <= st.mw[1]) return st.id; }
      else if (siteRoom(S, tech, st.id) >= mw) return st.id;
    }
    return null;
  }
  function buildDays(tech, mw, siteId) {
    const T = TECH[tech];
    if (tech === 'hydro') { const st = siteOf(tech, siteId); return Math.round(st.build * (0.85 + 0.15 * mw / st.mw[0]) * 2) / 2; }
    return Math.round(T.build * Math.min(3, 0.75 + 0.25 * mw / T.sizes[0]) * 2) / 2;
  }
  const TECH_ORDER = ['peaker', 'ccgt', 'hydro', 'coal', 'battery', 'wind', 'solar'];   // stacking order (palette validated)

  const NAMES = {
    solar: ['Saltbush', 'Mallee Flat', 'Bluegum Plains', 'Red Gully', 'Wattle Downs', 'Emu Springs', 'Sandy Hollow', 'Brolga'],
    wind: ['Kestrel Ridge', 'Granite Hills', 'Cape Windy', 'Ironstone', 'High Paddock', 'Boobook Range'],
    battery: ['Ironbark', 'Stringybark', 'Kurrajong', 'Tuart', 'Coolabah', 'Grey Box', 'Yarran', 'Boree'],
    peaker: ['Quartz Creek', 'Billabong', 'Spinifex', 'Dingo Gap', 'Copper Flat'],
    ccgt: ['Tallowwood', 'Banksia Point', 'Riverina'],
    hydro: ['Tumut Gorge', 'Snowy Creek', 'Wombat Falls'],
    coal: [],
    offshore: ['Southern Ocean', 'Albatross', 'Bass Strait', 'Seal Rocks'],
    ldes: ['Basalt', 'Ironstone Vault', 'Deep Lead', 'Salt Cavern'],
  };

  // ---- rival fleet ----
  function rivalFleet() {
    const coal = (n, name) => ({ id: `bh${n}`, name, tech: 'coal', cap: 660, out: 0, last: 520, closing: 0 });
    return [
      coal(1, 'Black Hill 1'), coal(2, 'Black Hill 2'), coal(3, 'Black Hill 3'), coal(4, 'Black Hill 4'),
      { id: 'tal', name: 'Tallawang CCGT', tech: 'ccgt', cap: 600, bands: [[0.5, 84], [0.5, 120]], out: 0 },
      { id: 'wol', name: 'Wollemi CCGT', tech: 'ccgt', cap: 450, bands: [[0.6, 98], [0.4, 150]], out: 0 },
      { id: 'ash', name: 'Ash Hill peaker', tech: 'peaker', cap: 300, bands: [[0.5, 245], [0.5, 290]], out: 0 },
      { id: 'cst', name: 'Coastal peakers', tech: 'peaker', cap: 600, bands: [[0.5, 330], [0.5, 640]], out: 0 },
      { id: 'mul', name: 'Mulga Creek peaker', tech: 'peaker', cap: 400, bands: [[0.5, 195], [0.5, 235]], out: 0 },
      { id: 'kur', name: 'Kurri gas turbines', tech: 'peaker', cap: 350, bands: [[0.5, 170], [0.5, 220]], out: 0 },
      { id: 'red', name: 'Redbank peaker', tech: 'peaker', cap: 400, bands: [[0.5, 1100], [0.5, 3000]], out: 0 },
      { id: 'qry', name: 'Quarry Road peaker', tech: 'peaker', cap: 300, bands: [[1, 12500]], out: 0 },
      { id: 'snw', name: 'Snowgum hydro', tech: 'hydro', cap: 450, bands: [[0.6, 165], [0.4, 280]], budget: 3200, used: 0 },
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

  // ---- difficulty ----
  const DIFFICULTY = {
    relaxed:  { name: 'Relaxed',  cash: 900000, capex: 0.85, upkeep: 0.85, outage: 0.6, events: 0.75, penalty: 0.5, rivalAt: 170, rivalMax: 450,
                blurb: 'More money, cheaper plants, fewer breakdowns and gentler rivals.' },
    standard: { name: 'Standard', cash: 600000, capex: 1, upkeep: 1, outage: 1, events: 1, penalty: 1, rivalAt: 140, rivalMax: 600,
                blurb: 'The market as designed.' },
    tough:    { name: 'Tough',    cash: 450000, capex: 1.15, upkeep: 1.2, outage: 1.6, events: 1.35, penalty: 1.6, rivalAt: 120, rivalMax: 800,
                blurb: 'Dearer plants, more breakdowns and wild weather, bigger fines, and rivals that pounce on high prices.' },
  };
  const diff = S => DIFFICULTY[S.difficulty] || DIFFICULTY.standard;

  // ---- a new company ----
  function create(seed, opts = {}) {
    seed = seed >>> 0;
    const difficulty = DIFFICULTY[opts.difficulty] ? opts.difficulty : 'standard';
    const S = {
      v: 3, seed, rng: [seed ^ 0x9E3779B9, (seed * 2654435761) >>> 0],
      t: 0,                          // intervals since the start
      difficulty,
      cash: opts.cash ?? DIFFICULTY[difficulty].cash,
      contracts: [], contractOffers: [], loans: [],
      plants: [], retired: [], rivals: rivalFleet(), nameUse: {},
      wx: { wind: 0.33, cloud: 0.85, temp: 0, noise: 0, nb: 0 },
      events: [], upcoming: [], news: [], offer: null, obligation: null,
      rooftop: 3200,
      unlocked: { solar: true, battery: true, peaker: true },
      goalsDone: {}, costMult: {}, fuelMult: 1,
      today: freshDay(), days: [], last: null, totals: { profit: 0, energy: 0, fcas: 0, emis: 0 },
      challenge: opts.challenge || null,
      startDoy: opts.startDoy,
      mode: opts.mode || 'career',
      missions: opts.tour ? { on: true, done: {}, paid: {} } : null,
    };
    for (const k of Object.keys(TECH)) S.costMult[k] = 1;
    if (opts.challenge) Object.assign(S.unlocked, { wind: true });
    planEvents(S);
    makeContractOffers(S);
    seedCpt(S);
    return S;
  }
  function freshDay() {
    return { price: [], demand: [], mine: [], revenue: 0, costs: 0, fcas: 0, energy: 0, regionEnergy: 0, emis: 0, maxP: null, minP: null,
      upkeep: 0, penalties: 0, bonus: 0, contracts: 0, repairs: 0, interest: 0, capPay: 0, fcasRaise: 0, fcasLower: 0, certs: 0, starts: 0, clean: 0, cis: 0, loanInterest: 0 };
  }
  // Older saves: fill in fields added since they were made.
  function migrate(S) {
    S.contracts ||= []; S.difficulty ||= 'standard';
    if (!S.contractOffers) makeContractOffers(S);
    for (const k of ['contracts', 'repairs', 'interest', 'capPay', 'fcasRaise', 'fcasLower', 'certs', 'starts', 'clean', 'cis', 'loanInterest']) S.today[k] ??= 0;
    S.loans ||= [];
    for (const p of S.plants) {
      p.life ||= freshLife(); p.capital ??= p.value || 0; p.life.certs ??= 0; p.life.starts ??= 0;
      if (p.tech === 'coal' && p.bands && !p.bands.minIn) { if (p.bid === 'custom') p.bands.mw[0] = (p.bands.mw[0] || 0) + minMW(p); fixMinBand(p); }
      if (!p.site) { p.site = 'legacy'; p.mlf = 1; p.res = 1; }
      if (p.fcasRaise === undefined && TECH[p.tech].fcas) p.fcasRaise = p.fcas !== false;
      if (p.fcasLower === undefined && TECH[p.tech].fcasLower) p.fcasLower = true;
      if (TECH[p.tech].kind === 'storage' && p.mwh == null) { p.mwh = p.mw * (p.hours ?? TECH[p.tech].hours); delete p.hours; }
      if (!p.bands) {
        freshBands(S, p);
        if (p.bid === 'custom' && p.price != null) {   // keep the old custom price as one of the bands
          const prices = p.bands.prices.slice(); let i = prices.findIndex(v => v >= p.price); if (i < 0) i = NB - 1;
          prices[i] = p.price; p.bands.prices = ascend(prices); p.bands.mw[p.bands.prices.indexOf(Math.round(Math.min(CAP, Math.max(FLOOR, p.price))))] = p.mw;
          if (!p.bands.mw.some(v => v > 0)) p.bands.mw[i] = p.mw;
        }
        if (p.sbands && p.strategy === 'custom') {
          const put = (B, price) => { let i = B.prices.findIndex(v => v >= price); if (i < 0) i = NB - 1; B.prices[i] = price; B.prices = ascend(B.prices); B.mw = new Array(NB).fill(0); B.mw[i] = p.mw; };
          put(p.sbands.d, p.dischargeAbove ?? 150); put(p.sbands.c, p.chargeBelow ?? 40);
        }
      }
    }
    S.retired ||= [];
    if (!S.cptBuf) { seedCpt(S); delete S.cpt; if (S.apc && S.cptSum <= CPT) S.apc = false; }
    if ((S.v || 1) < 3) {
      // wind and solar used to bid −$1,000 by default, which now costs big fleets dearly at midday
      const vre = S.plants.filter(p => TECH[p.tech].kind === 'vre' && p.bid === 'always');
      for (const p of vre) p.bid = 'nonneg';
      if (vre.length) addNews(S, 'info', 'Market update: your wind and solar farms now stop when prices go negative. You can change this for each plant.');
    }
    S.v = 3;
    return S;
  }

  // ---- calendar and weather ----
  const dayIndex = S => Math.floor(S.t / IPD);
  const hourOf = S => (S.t % IPD) * H;
  const startDoy = S => S.startDoy ?? START_DOY;
  // The Energy Transition squeezes a year into S.yearDays game days, so seasons pass faster.
  const yearDaysOf = S => S.yearDays || 365;
  const calDay = (S, day) => startDoy(S) + day * 365 / yearDaysOf(S);
  const doyOf = S => Math.floor(calDay(S, dayIndex(S))) % 365;
  const yearOf = S => Math.floor(dayIndex(S) / yearDaysOf(S));   // 0-based
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
    if (hw) temp += 8 * (0.55 + 0.45 * bump(h, 16, 3.5));
    if (cs) temp -= 8;
    const shape = 0.72 + 0.09 * bump(h, 8, 1.4) + 0.08 * bump(h, 12.5, 3.5) + 0.22 * bump(h, 18.6, 1.9) - 0.05 * bump(h, 3.5, 2);
    let underlying = 5500 * (S.demandMult || 1) * shape * (1 + wx.noise) + (S.flatLoad || 0) + (S.evLoad || 0) * bump(h, 19.5, 2.6);
    underlying += Math.max(0, temp - 24) * 125 * (0.4 + 0.6 * bump(h, 16.5, 4));
    underlying += Math.max(0, 14 - temp) * 105 * (S.heatMult || 1) * (0.5 + 0.5 * bump(h, 19, 3));
    const sun = solarShape(h, doy) * wx.cloud;
    const rooftop = S.rooftop * sun * 0.82;
    const demand = Math.max(2500, underlying - rooftop);
    const evening = bump(h, 18.5, 2.2), midday = bump(h, 12.5, 2.5);
    let nbPrice = 78 + 90 * evening - 80 * midday + wx.nb + (hw ? 120 * bump(h, 17, 3) : 0);
    return { h, doy, temp, sun, wind: wx.wind, demand, nbPrice, linkOut: !!activeEvent(S, 'linktrip') };
  }

  // A plant that has been given notice keeps running until it closes.
  const running = p => p.status === 'online' || p.status === 'retiring';
  const hoursOf = p => p.mwh ? p.mwh / p.mw : p.hours ?? TECH[p.tech].hours;
  // What storage can hold now: its rating times its health (cells wear out in the Energy Transition).
  const storeCap = p => p.mw * hoursOf(p) * (p.health ?? 1);

  const LINK_STEPS = [0, 15, 35, 70, 130];   // interconnector: price premium (imports) / discount (exports) per 140 MW step

  // ---- bids ----
  // Supply bands: {mw, price, tech, owner, ref}. Elastic demand bands: {mw, price, ref}.
  // Bands cover a plant's whole capacity. Coal must always run its minimum load, so as in the NEM
  // its band 1 is fixed at the floor (-$1,000) and always holds at least that minimum.
  const coalMin = p => p.upg ? 0.3 : TECH.coal.minLoad;
  const minMW = p => p.tech === 'coal' ? p.mw * coalMin(p) : 0;
  // A preset over the whole plant: coal's minimum in band 1, the rest where the preset puts it.
  function presetStack(S, p) { const out = presetMW(S, p, p.mw - minMW(p)); out[0] += minMW(p); return out; }
  function stackOf(S, p) {
    if (p.bid !== 'custom') return presetStack(S, p);
    const mw = p.bands.mw.slice(); if (minMW(p)) mw[0] = Math.max(mw[0], minMW(p));
    return fillBands(mw, p.mw);
  }
  // Keep a coal stack honest: band 1 at the floor holding the minimum, never more than the plant
  // (trimming the dearest bands first). Older saves had the minimum outside the bands.
  function fixMinBand(p) {
    const min = minMW(p); if (!min || !p.bands) return;
    const B = p.bands;
    B.prices[0] = FLOOR; if (B.next) B.next[0] = FLOOR;
    B.mw[0] = Math.max(B.mw[0] || 0, min);
    let over = B.mw.reduce((a, v) => a + v, 0) - p.mw;
    for (let k = NB - 1; k > 0 && over > 1e-9; k--) { const t = Math.min(over, B.mw[k]); B.mw[k] -= t; over -= t; }
    B.minIn = true;
  }
  // What the plant would run at this price if it could move freely: every band at or below it.
  function stackTarget(S, p, price) {
    if (!p.bands) freshBands(S, p);
    const mw = stackOf(S, p);
    return Math.min(p.mw, mw.reduce((a, m, i) => a + (p.bands.prices[i] <= price ? m : 0), 0));
  }
  // Offer the part of a plant's stack between output levels `from` and `to`: its bands in price
  // order, stacked from `base` up. Below `from` the plant must run (coal's minimum, as far as it can
  // ramp down this interval, or a gas plant's stable load in its minimum run), offered at the floor. Each MW above is offered at the price of the band that covers it,
  // so a unit running in its $300 band ramps down when the price is below $300.
  function offerSlice(S, p, base, from, to, supply) {
    if (!p.bands) freshBands(S, p);
    if (from > 0.05) supply.push({ mw: from, price: FLOOR, tech: p.tech, owner: 'player', ref: p, mustRun: true });
    if (to <= from + 0.05) return;
    const mw = stackOf(S, p);
    let level = base;
    for (let i = 0; i < NB; i++) {
      const lo = Math.max(level, from), hi = Math.min(level + mw[i], to);
      if (hi - lo > 0.05) supply.push({ mw: hi - lo, price: p.bands.prices[i], tech: p.tech, owner: 'player', ref: p, band: i });
      level += mw[i];
    }
  }
  function offerBands(S, p, avail, supply) {
    if (!p.bands) freshBands(S, p);
    const mw = bandMW(S, p, avail);
    for (let i = 0; i < NB; i++) if (mw[i] > 0.05) supply.push({ mw: mw[i], price: p.bands.prices[i], tech: p.tech, owner: 'player', ref: p, band: i });
  }
  // q-th percentile of an array that is already sorted (yesterday's priceSorted), without re-sorting:
  // this runs for every battery every interval, so it has to be cheap.
  function percentile(sorted, q) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
  }
  function storageStrategy(S, p, c) {
    const strat = p.strategy || 'arb';
    const ref = S.days.length ? S.days[S.days.length - 1].priceSorted : null;
    if (strat === 'custom') return { charge: p.chargeBelow ?? 40, discharge: p.dischargeAbove ?? 150 };
    if (strat === 'fcas') {
      // stay ready: never sell energy, but top up to 60% when power is cheap so the reserve is real
      const full = p.soc / (storeCap(p));
      return { charge: full < 0.6 ? 30 : -Infinity, discharge: Infinity };
    }
    if (strat === 'evening') {
      const inCharge = c.h >= 9.5 && c.h < 15.5, inSell = c.h >= 16.5 && c.h < 21.5;
      return { charge: inCharge ? 90 : -Infinity, discharge: inSell ? 40 : Infinity };
    }
    // arbitrage: buy in the cheapest quarter of yesterday's prices, sell in the dearest quarter
    const lo = ref ? percentile(ref, 0.25) : 40, hi = ref ? percentile(ref, 0.8) : 150;
    return { charge: Math.min(lo, 70), discharge: Math.max(hi, (lo ?? 40) + 60, 90) };
  }

  // ---- bid stacks: ten price bands per plant, as in the NEM ----
  // Band prices are set for the trading day: a change is saved in `next` and takes effect when the next
  // day starts. MW in each band can be moved at any time (a rebid). Presets keep the prices current
  // each day and place the MW themselves; "custom" uses the MW you set, cheapest band first.
  const NB = 10;
  function ascend(prices) {   // band prices must rise from band 1 to band 10
    const a = prices.map(v => Math.round(Math.min(CAP, Math.max(FLOOR, v))));
    for (let i = 1; i < a.length; i++) if (a[i] <= a[i - 1]) a[i] = a[i - 1] + 1;
    return a;
  }
  function presetPrices(S, p) {
    const T = TECH[p.tech];
    if (T.kind === 'vre') return ascend([FLOOR, -100, -CERT, 0, 30, 60, 100, 300, 1000, CAP]);
    const v = Math.round(vcOf(S, p));
    return ascend([FLOOR, 0, v, T.startMargin ? v + T.startMargin : v * 1.3, 300, Math.max(300, v * 2.5), 600, 1000, 5000, CAP].sort((a, b) => a - b));   // the presets' prices are all here
  }
  const STORE_PRICES = { d: [60, 90, 120, 150, 200, 300, 500, 1000, 5000, CAP], c: [FLOOR, -100, -20, 0, 20, 40, 60, 80, 100, 150] };
  function freshBands(S, p) {
    p.bands = { prices: presetPrices(S, p), mw: new Array(NB).fill(0), next: null };
    if (TECH[p.tech].kind === 'storage') {
      const mk = (k, price) => { const prices = STORE_PRICES[k].slice(), mw = new Array(NB).fill(0); mw[prices.indexOf(price)] = p.mw; return { prices, mw, next: null }; };
      p.sbands = { d: mk('d', 150), c: mk('c', 40) };
    }
  }
  // How a preset spreads `avail` MW over today's bands.
  function presetMW(S, p, avail) {
    const B = p.bands, out = new Array(NB).fill(0), vc = vcOf(S, p);
    const place = (target, share) => { let i = B.prices.findIndex(x => x >= target - 1e-9); if (i < 0) i = NB - 1; out[i] += avail * share; };
    switch (p.bid) {
      case 'always': out[0] = avail; break;
      case 'nonneg': place(-CERT, 1); break;   // run while price + certificate is above zero
      case 'peak': place(Math.max(300, vc * 2.5), 1); break;
      case 'ladder': place(Math.max(0, vc), 0.4); place(300, 0.3); place(1000, 0.3); break;
      default: place(vc + (TECH[p.tech].startMargin || 0), 1);   // cover running costs and start-ups
    }
    return out;
  }
  // Fill bands with what's available: cheapest first for generation (highest first for charging).
  function fillBands(mw, avail, highFirst) {
    const out = new Array(NB).fill(0);
    let left = avail;
    for (let k = 0; k < NB && left > 1e-9; k++) { const i = highFirst ? NB - 1 - k : k; const m = Math.min(left, mw[i] || 0); out[i] = m; left -= m; }
    return out;
  }
  function bandMW(S, p, avail) { return p.bid === 'custom' ? fillBands(p.bands.mw, avail) : presetMW(S, p, avail); }
  // At the start of each day: pending prices take effect; presets refresh theirs.
  function rollBands(S) {
    for (const p of S.plants) {
      if (!p.bands) continue;
      if (p.bands.next) { p.bands.prices = ascend(p.bands.next); p.bands.next = null; }
      else if (p.bid !== 'custom' && TECH[p.tech].kind !== 'storage') p.bands.prices = presetPrices(S, p);
      if (p.sbands) for (const k of ['d', 'c']) { const B = p.sbands[k]; if (B.next) { B.prices = ascend(B.next); B.next = null; } }
    }
  }
  // Set a band's price for tomorrow / its MW now. Returns the value used (clamped, kept in order).
  function setBandPrice(S, p, stack, i, price) {
    const B = stack === 'g' ? p.bands : p.sbands[stack];
    if (stack === 'g' && p.bid !== 'custom') { p.bands.mw = presetStack(S, p); p.bands.minIn = true; p.bid = 'custom'; }
    if (stack !== 'g') p.strategy = 'custom';
    if (stack === 'g' && i === 0 && minMW(p)) return FLOOR;   // coal's band 1 is fixed: its minimum always runs
    const next = (B.next || B.prices).slice();
    const lo = i > 0 ? next[i - 1] + 1 : FLOOR, hi = i < NB - 1 ? next[i + 1] - 1 : CAP;
    next[i] = Math.round(Math.min(hi, Math.max(lo, Math.min(CAP, Math.max(FLOOR, price)))));
    B.next = next.every((v, k) => v === B.prices[k]) ? null : next;
    return next[i];
  }
  function setBandMW(S, p, stack, i, mw) {
    const B = stack === 'g' ? p.bands : p.sbands[stack];
    if (stack === 'g' && p.bid !== 'custom') { p.bands.mw = presetStack(S, p); p.bands.minIn = true; p.bid = 'custom'; }
    if (stack !== 'g') p.strategy = 'custom';
    // raising a band moves MW out of the others, fullest band first, so the stack never exceeds the
    // plant; coal's band 1 never drops below its minimum
    const floorOf = j => stack === 'g' && j === 0 ? minMW(p) : 0;
    B.mw[i] = Math.max(floorOf(i), Math.min(mw, p.mw - (stack === 'g' && i !== 0 ? minMW(p) : 0)));   // room left by the minimum
    let over = B.mw.reduce((a, v) => a + v, 0) - p.mw;
    while (over > 1e-9) {
      let k = -1; for (let j = 0; j < NB; j++) if (j !== i && B.mw[j] - floorOf(j) > 1e-9 && (k < 0 || B.mw[j] - floorOf(j) > B.mw[k] - floorOf(k))) k = j;
      if (k < 0) break;
      const take = Math.min(over, B.mw[k] - floorOf(k)); B.mw[k] -= take; over -= take;
    }
    B.mw = B.mw.map(v => Math.round(v * 10) / 10);
    return B.mw[i];
  }

  // Running cost and emissions per MWh for a player's plant, after upgrades and fuel prices.
  function vcOf(S, p) {
    const T = TECH[p.tech];
    if (T.kind !== 'thermal') return T.vc;
    return T.vc * (p.tech === 'coal' ? 1 : S.fuelMult) * (p.upg && p.tech === 'ccgt' ? 0.88 : 1);
  }
  const emisOf = p => TECH[p.tech].emis * (p.upg && p.tech === 'ccgt' ? 0.88 : 1);

  // forecast: plan ahead ignoring ramp limits (pre-dispatch looks hours ahead, not 5 minutes)
  function buildBids(S, c, forecast) {
    const supply = [], demandBids = [];
    const gm = S.fuelMult;
    // rivals
    for (const r of S.rivals) {
      if (r.gone) continue;
      if (r.tech === 'coal') {
        if (r.out > 0) continue;
        const min = r.cap * 0.45;
        const up = forecast ? r.cap : Math.min(r.cap, r.last + r.cap * 0.06), down = forecast ? min : Math.max(min, r.last - r.cap * 0.06);
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
        // the neighbouring region has a supply curve too: the more you import the dearer it gets,
        // the more you export the cheaper it has to be, so the link can't soak up everything
        for (const [k, step] of LINK_STEPS.entries()) {
          supply.push({ mw: r.cap / LINK_STEPS.length, price: Math.max(10, c.nbPrice + step), tech: 'other', owner: 'rival', ref: r, band: k });
          demandBids.push({ mw: r.cap / LINK_STEPS.length, price: Math.max(-200, c.nbPrice - 12 - step), ref: r, exp: true, band: k });
        }
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
    // upgrades: trackers and repowering lift output about 20%, never above the plant's rating
    const vreMW = p => { const T = TECH[p.tech], cf = (p.tech === 'solar' ? c.sun : Math.min(1, (T.steady || 0) + c.wind * (p.res ?? 1))); return Math.min(p.mw, p.mw * cf * (p.upg ? 1.2 : 1)); };
    const zone = {};   // your wind and solar output in each zone with a line limit
    if (S.transition) for (const p of S.plants) {
      if (!running(p) || TECH[p.tech].kind !== 'vre') continue;
      const st = siteOf(p.tech, p.site);
      if (lineOf(S, st) != null) zone[st.id] = (zone[st.id] || 0) + vreMW(p);
    }
    for (const p of S.plants) {
      if (!running(p)) continue;
      const T = TECH[p.tech];
      if (T.kind === 'vre') {
        let mw = vreMW(p);
        const st = zone[p.site] ? siteOf(p.tech, p.site) : null, line = st && lineOf(S, st);
        if (line != null && zone[p.site] > line) {
          const cut = mw * (1 - line / zone[p.site]);
          mw -= cut;
          if (!forecast) {
            p.life.curtailed = (p.life.curtailed || 0) + cut * H; S.today.curtailed = (S.today.curtailed || 0) + cut * H;
            if (!(S.curtailNews ||= {})[st.id]) { S.curtailNews[st.id] = true; addNews(S, 'bad', `The ${st.name} line is full: your farms there can make more than its ${fmtMW(line)} carries, so their output is being cut.`); }
          }
        }
        if (mw > 0.1) offerBands(S, p, mw, supply);
      } else if (T.kind === 'thermal') {
        if (p.tech === 'coal') {
          const ramp = p.upg ? T.ramp * 2 : T.ramp, min = minMW(p);
          const up = forecast ? p.mw : Math.min(p.mw, (p.last ?? min) + p.mw * ramp), down = forecast ? min : Math.max(min, (p.last ?? min) - p.mw * ramp);
          offerSlice(S, p, 0, down, up, supply);   // band 1 holds the minimum, at the floor
        } else {
          const mw = T.ramp && !forecast ? Math.min(p.mw, (p.last ?? 0) + p.mw * T.ramp) : p.mw;
          if (T.startCost && p.onFor != null && p.onFor < T.minRun && !forecast) {
            // started and still inside its minimum run: it holds its stable load whatever the price
            offerSlice(S, p, 0, Math.min(mw, p.mw * T.stableLoad), mw, supply);
          } else offerBands(S, p, mw, supply);
        }
      } else {   // storage
        const e = storeCap(p);
        const dis = Math.min(p.mw, p.soc / H), ch = Math.min(p.mw, (e - p.soc) / H / T.eff);
        if (p.strategy === 'custom' && p.sbands) {
          const d = fillBands(p.sbands.d.mw, dis), cb = fillBands(p.sbands.c.mw, ch, true);
          for (let i = 0; i < NB; i++) {
            if (d[i] > 0.05) supply.push({ mw: d[i], price: p.sbands.d.prices[i], tech: p.tech, owner: 'player', ref: p, storage: true, band: i });
            if (cb[i] > 0.05) demandBids.push({ mw: cb[i], price: p.sbands.c.prices[i], ref: p, owner: 'player', band: i });
          }
          continue;
        }
        const st = storageStrategy(S, p, c);
        if (!st) continue;
        if (dis > 0.5 && st.discharge < Infinity) supply.push({ mw: dis, price: st.discharge, tech: p.tech, owner: 'player', ref: p, storage: true });
        if (ch > 0.5 && st.charge > -Infinity) demandBids.push({ mw: ch, price: st.charge, ref: p, owner: 'player' });
      }
    }
    // offers from your plants rank at the regional reference node: offer / loss factor (as in the NEM)
    for (const b of supply) if (b.owner === 'player' && b.ref.mlf && b.ref.mlf !== 1) { b.offer = b.price; b.price = Math.min(CAP, Math.max(FLOOR, b.price / b.ref.mlf)); }
    for (const d of demandBids) if (d.owner === 'player' && d.ref.mlf && d.ref.mlf !== 1) { d.offer = d.price; d.price = Math.min(CAP, Math.max(FLOOR, d.price / d.ref.mlf)); }
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

  // Administered pricing: when the last 7 days of prices (2,016 intervals) add up past the cumulative
  // price threshold, prices are held at APC. Checked again at each day's end. The real NEM threshold
  // for 2026-27 is $2,225,900 (about 8 hours at the cap); the game's market is spikier, so it uses a
  // shorter fuse of about 3 hours at the cap.
  const APC = 600, CPT = 1050000, REAL_CPT = 2225900, CPT_N = 7 * IPD;
  function administer(S, res) { return S.apc && res.price > APC ? { ...res, price: APC, capped: true } : res; }
  function seedCpt(S) {
    // a new game starts with a quiet week behind it; an old save rebuilds the week from its records
    const hist = [];
    for (const d of S.days.slice(-7)) for (let i = 0; i < IPD; i++) hist.push(d.price ? d.price[i] ?? d.avg : d.avg);
    for (const v of S.today.price) hist.push(v);
    const buf = new Array(CPT_N).fill(100);
    const tail = hist.slice(-CPT_N);
    for (let i = 0; i < tail.length; i++) buf[CPT_N - tail.length + i] = Math.round(tail[i]);
    S.cptBuf = buf; S.cptI = 0; S.cptSum = buf.reduce((a, b) => a + b, 0);
  }
  function trackCpt(S, price) {
    if (!S.cptBuf || S.cptBuf.length !== CPT_N) seedCpt(S);
    const v = Math.round(price);
    S.cptSum += v - S.cptBuf[S.cptI]; S.cptBuf[S.cptI] = v; S.cptI = (S.cptI + 1) % CPT_N;
  }

  // ---- frequency control (one simplified raise service) ----
  // Two markets, each cleared cheapest first until its requirement is met:
  //   Raise: spare capacity ready to add output fast (needed more when the interconnector is out).
  //   Lower: output that can be cut fast, or batteries ready to charge (needed more when the sun is high).
  function clearMarket(offers, need) {
    offers.sort((a, b) => a.price - b.price);
    let got = 0, price = 1000;
    for (const o of offers) {
      const take = Math.min(o.mw, need - got);
      o.take = Math.max(0, take); got += o.take;
      if (got >= need - 1e-6) { price = o.price; break; }
    }
    return { price, offers, need };
  }
  function clearFcas(S, energyBids, c) {
    const raise = [
      { mw: 150, price: 2, owner: 'rival' }, { mw: 150, price: 5, owner: 'rival' }, { mw: 150, price: 8, owner: 'rival' },
      { mw: 120, price: 20, owner: 'rival' }, { mw: 100, price: 70, owner: 'rival' }, { mw: 60, price: 600, owner: 'rival' },
    ];
    const lower = [
      { mw: 180, price: 1, owner: 'rival' }, { mw: 140, price: 2, owner: 'rival' }, { mw: 100, price: 5, owner: 'rival' },
      { mw: 80, price: 15, owner: 'rival' }, { mw: 60, price: 45, owner: 'rival' }, { mw: 50, price: 300, owner: 'rival' },
    ];
    // what each player plant is doing in the energy market (one pass, not one per plant)
    const gen = new Map(), chg = new Map();
    for (const b of energyBids) {
      if (b.owner !== 'player') continue;
      if (b.out != null) gen.set(b.ref, (gen.get(b.ref) || 0) + b.out);
      else if (b.take != null) chg.set(b.ref, (chg.get(b.ref) || 0) + b.take);
    }
    for (const p of S.plants) {
      if (!running(p)) continue;
      const T = TECH[p.tech], out = gen.get(p) || 0, ch = chg.get(p) || 0, fast = p.upg && p.tech === 'peaker' ? 0.8 : 0.4;   // fast-start controls double it
      if (T.fcas && p.fcasRaise !== false) {
        const head = T.kind === 'storage'
          ? (p.strategy === 'fcas' ? p.mw : Math.max(0, p.mw - out - ch)) * (p.soc > storeCap(p) * 0.1 ? 1 : 0)
          : Math.max(0, p.mw - out) * fast;
        if (head > 0.5) raise.push({ mw: head, price: 2, owner: 'player', ref: p });
      }
      if (T.fcasLower && p.fcasLower !== false) {
        const foot = T.kind === 'storage' ? Math.min(p.mw, out + (p.soc < storeCap(p) * 0.95 ? Math.max(0, p.mw - ch) : 0))
          : T.kind === 'vre' ? out * 0.5 : out * fast;
        if (foot > 0.5) lower.push({ mw: foot, price: 1, owner: 'player', ref: p });
      }
    }
    const link = S.events.some(e => e.key === 'linktrip');
    const R = clearMarket(raise, link ? 650 : 380), L = clearMarket(lower, 230 + 130 * (c ? c.sun : 0) + (link ? 100 : 0));
    return { price: R.price, offers: R.offers, raise: R, lower: L };
  }

  // ---- one dispatch interval ----
  function step(S) {
    if (S.t % IPD === 0 && S.t > 0) endOfDay(S);
    stepWeather(S);
    const c = conditions(S);
    const { supply, demandBids } = buildBids(S, c);
    const res = administer(S, clear(supply, demandBids, c.demand));
    const fc = clearFcas(S, [...supply, ...demandBids], c);
    // the last 7 days of prices added up: past the threshold, the operator caps prices at $600
    trackCpt(S, res.price);
    if (!S.apc && S.cptSum > CPT) { S.apc = true; addNews(S, 'info', `Prices over the last week have added up past the market's limit, so the operator has capped them at ${fmtPrice(APC)}/MWh until the week's total falls back.`); }

    // settle the player's money and storage
    const T = TECH, d = S.today;
    let rev = 0, cost = 0, fcasRev = 0, mine = 0, emis = 0, certs = 0, starts = 0;
    const out = new Map();
    for (const b of supply) {
      if (b.owner !== 'player') continue;
      const p = b.ref, t = T[p.tech];
      out.set(p, (out.get(p) || 0) + b.out);
      const paid = b.out * res.price * (p.mlf ?? 1) * H;   // energy is paid at the price times the site's loss factor
      rev += paid;
      cost += b.out * vcOf(S, p) * H;
      const L = p.life; L.sales += paid; L.fuel += b.out * vcOf(S, p) * H; L.energy += b.out * H;
      if (t.kind === 'vre') { const cert = b.out * CERT * H; certs += cert; L.certs += cert; p.today.money += cert; }
      emis += b.out * emisOf(p) * H;
      mine += b.out;
      if (b.storage) p.soc = Math.max(0, p.soc - b.out * H);
    }
    for (const db of demandBids) {
      if (db.owner !== 'player' || !db.take) continue;
      const p = db.ref, t = T[p.tech];
      rev -= db.take * res.price * (p.mlf ?? 1) * H;
      p.life.charging += db.take * res.price * (p.mlf ?? 1) * H;
      p.soc = Math.min(storeCap(p), p.soc + db.take * H * t.eff);
      out.set(p, (out.get(p) || 0) - db.take);
    }
    let fcasR = 0, fcasL = 0;
    for (const [M, side] of [[fc.raise, 'r'], [fc.lower, 'l']]) for (const o of M.offers) if (o.owner === 'player' && o.take) {
      const v = o.take * M.price * H; o.ref.life.fcas += v; if (side === 'r') fcasR += v; else fcasL += v;
    }
    fcasRev = fcasR + fcasL;
    for (const p of S.plants) {
      const o = out.get(p) || 0;
      // gas: a start costs money; once started it runs at least its minimum time
      const G = T[p.tech];
      if (G.startCost) {
        if (!running(p)) p.onFor = null;
        else if (o > 0.05) {
          if (p.onFor == null) {
            const c = G.startCost * p.mw; starts += c; p.life.starts += c; p.today.money -= c; p.today.starts = (p.today.starts || 0) + 1; p.onFor = 0;
          } else p.onFor++;
        } else if (p.onFor != null) { if (p.onFor >= G.minRun) p.onFor = null; else p.onFor++; }
      }
      p.last = Math.max(0, o);
      p.now = o;
      if (running(p)) {
        const pr = (p.today ||= { energy: 0, money: 0 });
        pr.energy += o * H;
      }
    }
    // per-plant money (for the plant cards)
    for (const b of supply) if (b.owner === 'player') b.ref.today.money += b.out * (res.price * (b.ref.mlf ?? 1) - vcOf(S, b.ref)) * H;
    for (const db of demandBids) if (db.owner === 'player' && db.take) db.ref.today.money -= db.take * res.price * (db.ref.mlf ?? 1) * H;
    for (const M of [fc.raise, fc.lower]) for (const o of M.offers) if (o.owner === 'player' && o.take) o.ref.today.money += o.take * M.price * H;

    // rivals' state
    for (const b of supply) if (b.owner === 'rival') {
      const r = b.ref;
      if (r.tech === 'coal') r.lastAcc = (r.lastAcc || 0) + b.out;
      if (r.tech === 'battery') r.soc = Math.max(0, r.soc - b.out * H);
      if (r.tech === 'hydro') r.used += b.out * H;
    }
    for (const r of S.rivals) if (r.tech === 'coal') { r.last = r.lastAcc ?? (r.out > 0 ? 0 : r.cap * 0.45); r.lastAcc = 0; }
    for (const db of demandBids) if (db.owner !== 'player' && db.ref.tech === 'battery') db.ref.soc = Math.min(db.ref.cap * db.ref.hours, db.ref.soc + db.take * H * 0.86);

    // contracts settle against this interval's price
    let hedge = 0;
    for (const k of S.contracts) {
      // caps earn their daily premium a little every interval, so it matches the time at risk
      const v = k.type === 'swap' ? (k.strike - res.price) * k.mw * H : k.premium / IPD - Math.max(0, res.price - k.strike) * k.mw * H;
      k.pnl += v; hedge += v;
    }

    S.cash += rev - cost + fcasRev + hedge + certs - starts;
    d.certs += certs; d.starts += starts;
    d.revenue += rev; d.costs += cost; d.fcas += fcasRev; d.fcasRaise += fcasR; d.fcasLower += fcasL; d.emis += emis; d.contracts += hedge;
    d.capPay += Math.max(0, res.price - 300) * H;
    d.energy += Math.max(0, mine) * H; d.regionEnergy += c.demand * H;
    for (const b of supply) if (b.owner === 'player' && b.out > 0 && !T[b.tech].emis) d.clean += b.out * H;   // wind, solar, storage, hydro
    d.price.push(res.price); d.demand.push(c.demand); d.mine.push(Math.max(0, mine));
    d.maxP = d.maxP == null ? res.price : Math.max(d.maxP, res.price); d.minP = d.minP == null ? res.price : Math.min(d.minP, res.price);
    S.totals.fcas += fcasRev; S.totals.emis += emis;

    // reliability obligation window
    if (S.obligation && S.t >= S.obligation.from && S.t < S.obligation.to) {
      const firm = firmCapacity(S, true);
      S.obligation.worst = S.obligation.worst == null ? firm : Math.min(S.obligation.worst, firm);
    }
    if (res.shortfall > 0) {
      d.shed = (d.shed || 0) + res.shortfall * H; d.shedN = (d.shedN || 0) + 1;
      if (!d.shedNews) { d.shedNews = true; addNews(S, 'bad', `Supply ran short at ${clock(c.h)}. The operator cut ${fmtMW(res.shortfall)} of customers and the price hit the cap.`); }
    }

    // construction, outages
    for (const p of S.plants) {
      if (p.status === 'building') {
        p.buildLeft -= 1 / IPD;
        if (p.buildLeft <= 0) { p.status = 'online'; p.today = { energy: 0, money: 0 }; addNews(S, 'good', `${p.name} is connected and trading.`); checkMissions(S); }
      } else if (p.status === 'upgrading') {
        p.upgLeft -= 1 / IPD;
        if (p.upgLeft <= 0) finishUpgrade(S, p);
      }
    }

    S.last = { c, res, fc, supply, demandBids, mine, hedge, rev: rev - cost + fcasRev + hedge };
    S.t++;
    // contracts that have run their term end
    for (const k of S.contracts) if (S.t >= k.until) addNews(S, k.pnl >= 0 ? 'good' : 'bad', `Your ${k.mw} MW ${k.type === 'swap' ? `swap at ${fmtPrice(k.strike)}` : '$300 cap'} has ended. It ${k.pnl >= 0 ? 'made' : 'cost'} you ${fmtMoney(Math.abs(k.pnl))} overall.`);
    if (S.contracts.length) S.contracts = S.contracts.filter(k => S.t < k.until);
    if (S.obligation && S.t >= S.obligation.to) settleObligation(S);
    return S.last;
  }

  function firmCapacity(S, live) {
    let mw = 0;
    for (const p of S.plants) {
      if (!running(p)) continue;
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
      const pen = Math.round(short / o.mw * o.payment * 3 * diff(S).penalty);
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
    rollBands(S);
    if (S.apc && S.cptSum <= CPT) { S.apc = false; addNews(S, 'info', 'The administered price cap has been lifted. Prices can rise to the full cap again.'); }
    let upkeep = 0;
    for (const p of S.plants) if (p.status !== 'building') { const u = upkeepOf(S, p); upkeep += u; p.life.upkeep += u; }
    S.cash -= upkeep; d.upkeep = upkeep;
    payLoans(S, d);
    // an overdraft costs interest every day
    if (S.cash < 0) { const i = Math.round(-S.cash * OVERDRAFT_RATE * diff(S).penalty); S.cash -= i; d.interest += i; }
    settleUnderwriting(S, d);
    const profit = d.revenue - d.costs + d.fcas + d.contracts + d.certs - d.starts + d.cis - upkeep - d.penalties - d.repairs - d.interest - (d.loanInterest || 0) + d.bonus;
    const priceSorted = [...d.price].sort((a, b) => a - b);
    const avg = d.price.reduce((a, b) => a + b, 0) / Math.max(1, d.price.length);
    const rec = { day, profit, revenue: d.revenue, costs: d.costs, fcas: d.fcas, fcasRaise: d.fcasRaise, fcasLower: d.fcasLower, certs: d.certs, starts: d.starts, clean: d.clean, cis: d.cis, region: d.regionEnergy, contracts: d.contracts, repairs: d.repairs, interest: d.interest, loanInterest: d.loanInterest || 0, upkeep, energy: d.energy, share: d.energy / Math.max(1, d.regionEnergy),
      avg, max: d.maxP, min: d.minP, emis: d.emis, capPay: d.capPay, priceSorted, price: d.price, demand: d.demand, mine: d.mine, shed: d.shed || 0, penalties: d.penalties, bonus: d.bonus };
    S.days.push(rec);
    if (S.days.length > 3) { const old = S.days[S.days.length - 4]; delete old.price; delete old.demand; delete old.mine; }
    if (S.days.length > 60) S.days.shift();
    S.totals.profit += profit; S.totals.energy += d.energy;
    S.totals.contracts = (S.totals.contracts || 0) + d.contracts;
    if (S.transition) {   // the year's report: reliability, clean share, profit
      const y = Math.floor(day / yearDaysOf(S)), Y = (S.years[y] ||= { shed: 0, shedHours: 0, clean: 0, region: 0, profit: 0 });
      Y.shed += d.shed || 0; Y.shedHours += d.shedN ? d.shedN / 12 : 0; Y.clean += d.clean; Y.region += d.regionEnergy; Y.profit += profit; Y.value = companyValue(S);
      Y.priceSum = (Y.priceSum || 0) + avg; Y.days = (Y.days || 0) + 1; Y.peak = Math.max(Y.peak || 0, ...d.demand); Y.curtailed = (Y.curtailed || 0) + (d.curtailed || 0);
    }
    for (const p of S.plants) p.today = { energy: 0, money: 0 };
    S.today = freshDay();

    // rivals: hydro water budget refills, outages count down, breakdowns
    for (const r of S.rivals) {
      if (r.tech === 'hydro') r.used = 0;
      if (r.out > 0) { r.out--; if (r.out === 0) addNews(S, 'info', `${r.name} is back online.`); }
      if (r.tech === 'coal' && !r.gone) {
        const roll = rnd(S, W), len = rnd(S, W);
        if (r.out === 0 && roll < (activeEvent(S, 'heatwave') ? 0.03 : 0.012)) {
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
        const odds = T.outage * diff(S).outage * (p.upg && p.tech === 'peaker' ? 0.5 : 1);
        if (roll < odds) {
          p.status = 'outage'; p.outLeft = 1 + Math.floor(len * 2);
          const fix = Math.round(p.mw * 150 * diff(S).upkeep); S.cash -= fix; S.today.repairs += fix; p.life.repairs += fix;
          addNews(S, 'bad', `${p.name} has broken down. Repairs cost ${fmtMoney(fix)} and take ${p.outLeft} day${p.outLeft > 1 ? 's' : ''}.`);
        }
      }
      if (p.status === 'retiring') { p.retireLeft--; if (p.retireLeft <= 0) { p.status = 'closed'; addNews(S, 'info', `${p.name} has closed.`); } }
    }
    for (const p of S.plants) {
      if (p.status === 'closed') retireRecord(S, p, 0);
      else if (p.paidBack == null && p.capital > 0 && plantProfit(p) >= p.capital) { p.paidBack = dayIndex(S) - 1; addNews(S, 'good', `${p.name} has paid for itself.`); }
    }
    S.plants = S.plants.filter(p => p.status !== 'closed');
    // past the limit the bank gives you three days to get back under it, then sells plant
    const lim = overdraftLimit(S);
    S.overLimit = S.cash < -lim ? (S.overLimit || 0) + 1 : 0;
    if (S.overLimit && S.overLimit < 3) addNews(S, 'bad', `You owe ${fmtMoney(-S.cash)}, past your ${fmtMoney(lim)} overdraft limit. Get back under it within ${3 - S.overLimit} day${S.overLimit === 2 ? '' : 's'} or the bank will sell plant, most valuable first.`);
    if (S.overLimit >= 3) {
      const order = S.plants.slice().sort((a, b) => (a.status === 'building') - (b.status === 'building') || b.value - a.value);
      for (const p of order) {
        if (S.cash >= -lim / 2) break;
        const got = Math.round(p.value * 0.35);
        S.cash += got; p.status = 'closed'; S.totals.sold = (S.totals.sold || 0) + got; retireRecord(S, p, got);
        addNews(S, 'bad', `You owed ${fmtMoney(got - S.cash)}, past your overdraft limit, so the bank sold ${p.name} for ${fmtMoney(got)}.`);
      }
      S.plants = S.plants.filter(p => p.status !== 'closed'); S.overLimit = 0;
      if (!S.plants.length && (S.cash < 0 || S.cash < debt(S))) { S.bust = true; addNews(S, 'bad', 'With nothing left to sell, the bank has put your company into administration.'); }
    }
    if (S.cash < 0 && !S.inDebt) addNews(S, 'bad', `You're overdrawn. The bank charges interest every day and will sell plant if you owe more than ${fmtMoney(overdraftLimit(S))}.`);
    S.inDebt = S.cash < 0;

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
    S.rooftop *= S.rooftopGrowth || 1.0012;
    if (S.transition && dayIndex(S) % yearDaysOf(S) === 0) transitionYear(S);
    if (dayIndex(S) % (S.transition ? yearDaysOf(S) : 60) === 0) { S.costMult.battery *= 0.96;   // once a transition year
      S.costMult.solar *= 0.97; S.costMult.wind *= 0.985; S.costMult.hydro *= 0.99; }
    // emissions: every 30 days the regulator checks your intensity
    if (dayIndex(S) % 30 === 0) emissionsCheck(S);
    // rivals invest too: a month of high prices brings new peaking plant or batteries
    if (dayIndex(S) % 15 === 0 && S.days.length >= 15 && !S.transition) rivalInvestment(S);   // the transition follows its plan instead
    // a rival coal unit announces its closure on day 40 and closes on day 70
    if (dayIndex(S) === 40 && !S.challenge && !S.scenario) { const r = S.rivals.find(x => x.id === 'bh1'); r.closing = 70; addNews(S, 'info', 'Black Hill 1 will close for good in 30 days. That leaves a gap in the evening peak.'); }
    makeOffers(S);
    if (dayIndex(S) % 3 === 0) makeContractOffers(S);
    rec.value = companyValue(S);
    checkGoals(S, rec);
  }

  const OVERDRAFT_RATE = 0.003;
  function overdraftLimit(S) { return 150000 + 0.3 * S.plants.reduce((a, p) => a + (p.status === 'building' ? 0 : p.value || 0), 0); }

  // ---- each plant's own accounts since it was built ----
  const freshLife = () => ({ sales: 0, charging: 0, fuel: 0, fcas: 0, upkeep: 0, repairs: 0, energy: 0, certs: 0, starts: 0 });
  function plantProfit(p) { const L = p.life; return L.sales - L.charging - L.fuel + L.fcas + (L.certs || 0) - (L.starts || 0) + (L.cis || 0) - L.upkeep - L.repairs; }
  function retireRecord(S, p, salePrice) {
    (S.retired ||= []).unshift({ name: p.name, tech: p.tech, mw: p.mw, capital: p.capital, life: { ...p.life }, sold: salePrice, built: p.built, closed: S.t, paidBack: p.paidBack });
    if (S.retired.length > 20) S.retired.length = 20;
  }

  function upkeepFor(S, tech, mw, mwh) {
    const T = TECH[tech];
    return (T.upkeepMW ? mw * T.upkeepMW + (mwh ?? mw * T.hours) * T.upkeepMWh : mw * T.upkeep) * diff(S).upkeep;
  }
  function upkeepOf(S, p) { return upkeepFor(S, p.tech, p.mw, TECH[p.tech].kind === 'storage' ? (p.mwh ?? p.mw * hoursOf(p)) : undefined); }

  // ---- upgrades: one per plant ----
  const UPGRADES = {
    solar:   { name: 'Single-axis trackers', cost: 0.3, days: 0.5, blurb: 'Panels follow the sun for about 20% more energy, mostly early and late in the day when prices are better.' },
    wind:    { name: 'Repower with taller turbines', cost: 0.35, days: 1, blurb: 'Bigger rotors catch lighter winds for about 20% more energy.' },
    battery: { name: 'Add 2 hours of storage', days: 1, blurb: 'More cells on the same connection, so it can cover more of the evening peak and hold a reserve.' },
    peaker:  { name: 'Fast-start controls', cost: 0.2, days: 0.5, blurb: 'Offers twice as much frequency control and breaks down half as often.' },
    ccgt:    { name: 'Efficiency upgrade', cost: 0.2, days: 1, blurb: 'New blades and controls cut running cost and emissions by about 12%.' },
    hydro:   { name: 'Extra turbine', days: 2, blurb: 'Another turbine adds 25% more power from the same reservoir, as far as the site allows.' },
    coal:    { name: 'Flexible operation retrofit', fixed: 600000, days: 3, blurb: 'Turns down to 30% and changes output twice as fast, so it loses less money when prices go negative.' },
  };
  // Refurbishing worn storage: new cells for about half of today's cost of that much storage.
  function refurbishCost(S, p) {
    const T = TECH[p.tech];
    return Math.round(T.capexMWh * (p.mwh ?? p.mw * hoursOf(p)) * 0.5 * S.costMult[p.tech] * diff(S).capex / 100) * 100;
  }
  function refurbish(S, p) {
    if (!TECH[p.tech].fade || (p.health ?? 1) > 0.95 || !running(p)) return { ok: false, why: 'unavailable' };
    const cost = refurbishCost(S, p);
    if (S.cash < cost) return { ok: false, why: 'cash' };
    S.cash -= cost; p.value += cost; p.capital += cost; p.health = 1;
    addNews(S, 'good', `${p.name} has new cells: back to its full ${Math.round(p.mwh ?? p.mw * hoursOf(p)).toLocaleString()} MWh.`);
    return { ok: true, cost };
  }
  function upgradeCost(S, p) {
    const U = UPGRADES[p.tech], T = TECH[p.tech], m = S.costMult[p.tech] * diff(S).capex;
    if (U.fixed) return Math.round(U.fixed * diff(S).capex);
    if (p.tech === 'battery') return Math.round(T.capexMWh * 2 * p.mw * m / 100) * 100;
    if (p.tech === 'hydro') return Math.round(T.capexMW * (hydroUpgradeMW(p) - p.mw) * 1.2 * m / 100) * 100;
    return Math.round(p.value * U.cost / 100) * 100;
  }
  function hydroUpgradeMW(p) { const st = siteOf('hydro', p.site); return Math.min(st.mw ? st.mw[1] : Infinity, Math.round(p.mw * 1.25)); }
  // Can this plant still be upgraded? (A hydro plant already at its site's limit can't.)
  function canUpgrade(p) { return !p.upg && !(p.tech === 'hydro' && hydroUpgradeMW(p) <= p.mw) && !(p.tech === 'battery' && hoursOf(p) + 2 > TECH.battery.hoursRange[1]); }
  function upgrade(S, p) {
    if (!UPGRADES[p.tech] || p.upg || p.status !== 'online' || !canUpgrade(p)) return { ok: false, why: 'unavailable' };
    const cost = upgradeCost(S, p);
    if (S.cash < cost) return { ok: false, why: 'cash' };
    S.cash -= cost; p.value += cost; p.capital += cost;
    p.status = 'upgrading'; p.upgLeft = UPGRADES[p.tech].days; p.upg = true;
    addNews(S, 'info', `${p.name} is offline for ${UPGRADES[p.tech].days} day${UPGRADES[p.tech].days === 1 ? '' : 's'} for its upgrade: ${UPGRADES[p.tech].name.toLowerCase()}.`);
    checkMissions(S);
    return { ok: true, cost };
  }
  function finishUpgrade(S, p) {
    p.status = 'online';
    if (p.tech === 'battery') p.mwh = (p.mwh ?? p.mw * hoursOf(p)) + 2 * p.mw;
    if (p.tech === 'hydro') { p.mwh = p.mwh ?? p.mw * hoursOf(p); p.mw = hydroUpgradeMW(p); }
    addNews(S, 'good', `${p.name} is back with its upgrade: ${UPGRADES[p.tech].name.toLowerCase()}.`);
  }

  // ---- contracts with retailers ----
  // Swap: each interval you receive (strike − spot) × MW, so you pay when spot is above the strike.
  // Cap:  you're paid a premium every day and pay (spot − $300) × MW whenever spot is above $300.
  const CONTRACT_DAYS = 7;
  function contractRoom(S) {
    const owned = S.plants.reduce((a, p) => a + (p.status === 'building' ? 0 : p.mw), 0);
    const used = S.contracts.reduce((a, k) => a + k.mw, 0);
    return Math.max(0, Math.round(Math.max(50, owned * 1.2) - used));
  }
  function makeContractOffers(S) {
    const last = S.days.slice(-14);
    const avg = last.length ? last.reduce((a, d) => a + d.avg, 0) / last.length : 105;
    const capRisk = last.length ? last.reduce((a, d) => a + (d.capPay || 0), 0) / last.length : 25;   // $/MW/day the cap would have paid out
    const r = [rnd(S, P), rnd(S, P), rnd(S, P)];
    const size = v => Math.max(10, Math.round(v / 10) * 10);
    const owned = S.plants.reduce((a, p) => a + p.mw, 0);
    const firmMW = S.plants.reduce((a, p) => a + (TECH[p.tech].kind === 'thermal' || p.tech === 'hydro' ? p.mw : 0), 0);   // plant that can run through a spike
    S.contractOffers = [
      { type: 'swap', mw: size(Math.max(20, owned * 0.2)), strike: Math.round(avg * (0.92 + 0.16 * r[0])), days: CONTRACT_DAYS },
      { type: 'swap', mw: size(Math.max(30, owned * 0.4)), strike: Math.round(avg * (0.85 + 0.16 * r[1])), days: CONTRACT_DAYS },
      { type: 'cap', mw: size(Math.max(20, firmMW * 0.6, owned * 0.15)), strike: 300, days: CONTRACT_DAYS, perMW: Math.round((capRisk * (1 + 0.3 * r[2]) + 3) * 10) / 10 },
    ];
    for (const o of S.contractOffers) if (o.type === 'cap') o.premium = Math.round(o.perMW * o.mw);
  }
  function signContract(S, i) {
    const o = S.contractOffers[i];
    if (!o) return { ok: false, why: 'gone' };
    if (o.mw > contractRoom(S)) return { ok: false, why: 'room' };
    S.contracts.push({ ...o, until: S.t + o.days * IPD, pnl: 0, signed: S.t });
    S.contractOffers.splice(i, 1);
    addNews(S, 'info', o.type === 'swap'
      ? `You sold a ${o.mw} MW swap at ${fmtPrice(o.strike)}/MWh for ${o.days} days. You now earn that price on ${o.mw} MW whatever the market does, as long as you can supply it.`
      : `You sold a ${o.mw} MW $300 cap for ${fmtMoney(o.premium)} a day. You pay out whenever the price goes above $300.`);
    checkMissions(S);
    return { ok: true };
  }

  // ---- pre-dispatch: the price forecast for the next few hours ----
  // Uses today's weather and offers as they stand, so it misses surprises, like the real thing.
  function forecast(S, steps) {
    const out = [];
    const F = { ...S };
    for (let k = 0; k < steps; k++) {
      F.t = S.t + k;
      const c = conditions(F);
      const { supply, demandBids } = buildBids(F, c, true);
      out.push({ t: F.t, price: administer(F, clear(supply, demandBids, c.demand)).price, demand: c.demand });
    }
    return out;
  }

  function rivalInvestment(S) {
    const last = S.days.slice(-15);
    const avg = last.reduce((a, d) => a + d.avg, 0) / last.length;
    const D = diff(S);
    if (avg <= D.rivalAt) return;
    const n = (S.rivalBuilds = (S.rivalBuilds || 0) + 1);
    const mw = Math.round(Math.min(D.rivalMax, (avg - D.rivalAt) * 3 + 150) / 50) * 50;
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
    const target = S.emisTarget ?? Math.max(0.2, 0.7 - 0.08 * year);
    const intensity = emis / energy;
    if (intensity > target) {
      const over = emis - target * energy, pen = Math.round(over * 30 * diff(S).penalty);
      S.cash -= pen; S.today.penalties += pen;
      addNews(S, 'bad', `Your emissions were ${intensity.toFixed(2)} t per MWh, above the ${target.toFixed(2)} target. Penalty: ${fmtMoney(pen)}.`);
    } else if (emis > 0) {
      addNews(S, 'good', `Your emissions (${intensity.toFixed(2)} t per MWh) beat the ${target.toFixed(2)} target.`);
    }
  }

  function planEvents(S) {
    // Forecast tomorrow's weather events one day ahead. Fixed number of draws per day.
    const tomorrow = dayIndex(S) + 1, doy = Math.floor(calDay(S, tomorrow)) % 365;
    const summer = 0.5 + 0.5 * Math.cos(2 * Math.PI * (doy - 15) / 365);
    const r = [rnd(S, W), rnd(S, W), rnd(S, W)];
    const scripted = (S.script || []).filter(e => e.day === tomorrow);
    if (scripted.length) {
      for (const e of scripted) {
        S.upcoming.push({ key: e.key, start: tomorrow, len: e.len });
        addNews(S, EVENTS[e.key].tone, `Forecast: ${EVENTS[e.key].news}`);
        if (e.key === 'heatwave') offerReserve(S, tomorrow, e.len, r[2]);
      }
      return;
    }
    if (S.script && S.calm) return;
    if (S.upcoming.some(u => u.start >= tomorrow) || S.events.length >= 2) return;
    const odds = [['heatwave', 0.02 + 0.07 * summer], ['cold', 0.05 * (1 - summer)], ['still', 0.05], ['windy', 0.05], ['cloudy', 0.05], ['linktrip', 0.015], ['gascrunch', 0.012]];
    const em = diff(S).events;
    let acc = 0;
    for (const [key, p] of odds) {
      acc += p * (key === 'windy' ? 1 : em);
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
    const mw = Math.round(firm * 0.8 / 5) * 5, payment = Math.round(mw * (220 + 150 * r) / 100) * 100;
    S.offer = { type: 'reserve', mw, payment, from: day * IPD + Math.round(15 / H), to: day * IPD + Math.round(20 / H), expires: day * IPD,
      text: `The market operator expects a supply shortfall tomorrow afternoon. Promise ${fmtMW(mw)} of reserve between 3 and 8 pm for ${fmtMoney(payment)}? If you can't deliver, you pay back three times the shortfall.` };
  }

  function makeOffers(S) {
    if (S.offer && S.t >= S.offer.expires) S.offer = null;
    if (S.offer || S.challenge || S.scenario) return;
    const day = dayIndex(S);
    if (day >= 12 && day % 17 === 5) {
      const r = S.rivals.find(x => x.tech === 'coal' && !x.gone && !x.closing && !x.sold && x.id !== 'bh1');
      if (r) {
        const price = Math.round(r.cap * 2400 * Math.max(0.6, 1 - day / 400) / 1000) * 1000;
        S.offer = { type: 'coal', rival: r.id, price, expires: S.t + IPD * 2,
          text: `The owner of ${r.name} (${fmtMW(r.cap)} of coal) wants out and offers it to you for ${fmtMoney(price)}. It earns well most nights, but it's slow, breaks down and counts heavily against your emissions target.` };
      }
    }
  }

  function acceptOffer(S, opts = {}) {
    const o = S.offer; if (!o) return false;
    if (o.type === 'coal' && opts.loan && S.cash < o.price) {
      const need = Math.ceil((o.price - S.cash) / 1000) * 1000;   // an overdraft is cleared too
      if (!takeLoan(S, need, 90, o.price).ok) return false;
    }
    if (o.type === 'reserve') {
      S.cash += o.payment; S.today.bonus += o.payment;
      S.obligation = { mw: o.mw, payment: o.payment, from: o.from, to: o.to, worst: null };
      addNews(S, 'info', `You promised ${fmtMW(o.mw)} of reserve for tomorrow afternoon and were paid ${fmtMoney(o.payment)}. Keep it available.`);
    } else if (o.type === 'coal') {
      if (S.cash < o.price) return false;
      const r = S.rivals.find(x => x.id === o.rival);
      S.cash -= o.price; r.gone = true; r.sold = true;
      S.plants.push({ id: `p${S.t}`, tech: 'coal', mw: r.cap, name: r.name, status: 'online', bid: 'cost', soc: 0, last: r.cap * 0.45, today: { energy: 0, money: 0 }, built: S.t, value: o.price, capital: o.price, life: freshLife() });
      freshBands(S, S.plants[S.plants.length - 1]);
      addNews(S, 'info', `You bought ${r.name}. It's yours to run, and to retire.`);
    }
    S.offer = null;
    return true;
  }
  function declineOffer(S) { S.offer = null; }

  // ---- building and closing ----
  // Building cost: a fixed connection (scaled by the site), power (per MW) and, for storage, energy
  // (per MWh). Pumped hydro pays its site's civil works instead of a connection.
  function priceOf(S, tech, mw, opts = {}) {
    const T = TECH[tech], st = siteOf(tech, opts.site || siteFor(S, tech, mw) || 'legacy');
    let c;
    if (tech === 'hydro') c = (st.civil ?? 2750000) + T.capexMW * mw;
    else c = T.connect * (st.connect ?? 1) + T.capexMW * mw + (T.capexMWh || 0) * (opts.mwh ?? mw * (T.hours || 0));
    return Math.round(c * S.costMult[tech] * diff(S).capex / 100) * 100;
  }
  // Why a design can't be built, or null if it can.
  function buildProblem(S, tech, mw, opts = {}) {
    const T = TECH[tech];
    if (!S.unlocked[tech] || T.buyOnly) return 'locked';
    if (tech !== 'hydro' && (mw < T.range[0] || mw > T.range[1])) return 'size';
    const site = opts.site || siteFor(S, tech, mw);
    if (!site) return 'site';
    const st = siteOf(tech, site);
    if (tech === 'hydro') { if (mw < st.mw[0] || mw > st.mw[1]) return 'size'; if (!siteRoom(S, tech, site)) return 'site'; }
    else { if (mw < T.range[0] || mw > T.range[1]) return 'size'; if (mw > siteRoom(S, tech, site)) return 'room'; }
    if (tech === 'battery') { const h = (opts.mwh ?? mw * T.hours) / mw; if (h < T.hoursRange[0] - 1e-9 || h > T.hoursRange[1] + 1e-9) return 'hours'; }
    if (S.cash < priceOf(S, tech, mw, { ...opts, site })) return 'cash';
    return null;
  }
  function nameFor(S, tech) {
    const list = NAMES[tech], k = S.nameUse[tech] || 0; S.nameUse[tech] = k + 1;
    const base = list[k % list.length] + (k >= list.length ? ` ${Math.floor(k / list.length) + 1}` : '');
    return `${base} ${tech === 'solar' ? 'Solar' : tech === 'wind' ? 'Wind' : tech === 'battery' ? 'Battery' : tech === 'peaker' ? 'Peaker' : tech === 'ccgt' ? 'Gas' : tech === 'offshore' ? 'Offshore Wind' : tech === 'ldes' ? 'Storage' : 'Hydro'}`;
  }
  // build(S, tech, mw, { site, mwh }): site defaults to the first that fits; storage MWh to the
  // standard hours (pumped hydro: the site's reservoir).
  function build(S, tech, mw, opts = {}) {
    const T = TECH[tech];
    mw = Math.round(mw);
    const why = buildProblem(S, tech, mw, opts);
    if (why) return { ok: false, why };
    const site = opts.site || siteFor(S, tech, mw), st = siteOf(tech, site);
    const mwh = T.kind !== 'storage' ? undefined : tech === 'hydro' ? st.reservoir : Math.round(opts.mwh ?? mw * T.hours);
    const cost = priceOf(S, tech, mw, { site, mwh }), days = buildDays(tech, mw, site);
    S.cash -= cost;
    const p = { id: `p${S.t}_${S.plants.length}`, tech, mw, mwh, site, mlf: st.mlf, res: st.res ?? 1, name: nameFor(S, tech), status: 'building', buildLeft: days, buildDays: days, built: S.t, value: cost,
      bid: T.kind === 'vre' ? 'nonneg' : T.kind === 'thermal' ? 'cost' : undefined,
      strategy: T.kind === 'storage' ? 'arb' : undefined, soc: T.kind === 'storage' ? mwh * 0.5 : 0, last: 0, fcasRaise: T.fcas ? true : undefined, fcasLower: T.fcasLower ? true : undefined, today: { energy: 0, money: 0 },
      capital: cost, life: freshLife() };
    freshBands(S, p);
    S.plants.push(p);
    addNews(S, 'info', `Construction has started on ${p.name} (${fmtMW(mw)}${mwh ? `, ${Math.round(mwh).toLocaleString()} MWh` : ''}) at ${st.name}. It connects in ${days} day${days === 1 ? '' : 's'}.`);
    if (S.tender) underwrite(S, p);
    checkMissions(S);
    return { ok: true, plant: p };
  }
  function retire(S, p) {
    if (p.tech === 'coal') { p.status = 'retiring'; p.retireLeft = 5; addNews(S, 'info', `You've given notice to close ${p.name}. It runs for 5 more days, as the rules require.`); return; }
    const refund = Math.round(p.value * 0.4);
    S.cash += refund; p.status = 'closed'; S.plants = S.plants.filter(x => x !== p); retireRecord(S, p, refund);
    addNews(S, 'info', `You sold ${p.name} for ${fmtMoney(refund)}.`);
  }

  // ---- goals ----
  const GOALS = [
    { id: 'first', text: 'Build your first plant', reward: 50000, test: S => S.plants.length > 0 },
    { id: 'day10k', text: 'Make $10k profit in one day', reward: 0, unlock: 'wind', test: (S, d) => d && d.profit >= 10000 },
    { id: 'fcas', text: 'Earn $5k from frequency control', reward: 40000, test: S => S.totals.fcas >= 5000 },
    { id: 'share5', text: 'Supply 5% of the region in one day', reward: 0, unlock: 'ccgt', test: (S, d) => d && d.share >= 0.05 },
    { id: 'reserve', text: 'Keep a reserve promise through a shortfall', reward: 150000, test: S => S.goalFlags?.reserveKept },
    { id: 'mw500', text: 'Own 500 MW of plant', reward: 0, unlock: 'hydro', test: S => S.plants.reduce((a, p) => a + p.mw, 0) >= 500 },
    { id: 'day100k', text: 'Make $100k profit in one day', reward: 250000, test: (S, d) => d && d.profit >= 100000 },
    { id: 'value10m', text: 'Grow your company to $10M', reward: 500000, test: S => companyValue(S) >= 1e7 },
    { id: 'share25', text: 'Supply a quarter of the region in one day', reward: 1000000, test: (S, d) => d && d.share >= 0.25 },
  ];
  // ---- the guided first week: short missions for a new company, each with a small reward ----
  // `hint` names what the app highlights; `ui` missions are completed by the app (completeMission).
  const MISSIONS = [
    { id: 'solar', text: 'Build a solar farm', why: 'Free energy every sunny day.', hint: 'build:solar', reward: 15000, test: S => S.plants.some(p => p.tech === 'solar') },
    { id: 'connect', text: 'Speed up the clock until your solar farm connects', why: 'Plants take a while to build. 4× or 16× gets there faster.', hint: 'speed', reward: 10000, test: S => S.plants.some(p => p.status === 'online') },
    { id: 'merit', text: 'Tap a bar in the merit order', why: 'Each bar is someone\'s offer. The cheapest run first; the last one needed sets the price.', hint: 'merit', reward: 10000, ui: true },
    { id: 'battery', text: 'Build a battery and choose how it trades', why: 'Batteries fill up when power is cheap and sell into the evening peak.', hint: 'battery', reward: 20000, test: S => S.plants.some(p => p.tech === 'battery' && p.stratSet) },
    { id: 'forecast', text: 'Tap the dashed forecast line on the price chart', why: 'It shows where prices are heading over the next six hours.', hint: 'forecast', reward: 10000, ui: true },
    { id: 'contract', text: 'Sign a contract', why: 'A swap fixes the price you get on part of your output for a week.', hint: 'contracts', reward: 15000, test: S => S.contracts.length > 0 || (S.totals.contracts || 0) !== 0 },
    { id: 'upgrade', text: 'Upgrade a plant', why: 'Every plant has one upgrade. Open a plant to see it.', hint: 'upgrade', reward: 25000, test: S => S.plants.some(p => p.upg) },
  ];
  function missionNext(S) { const M = S.missions; return M && M.on ? MISSIONS.find(m => M.done[m.id] === undefined) || null : null; }
  function finishMission(S, m) {
    const M = S.missions;
    M.done[m.id] = dayIndex(S);
    const pay = !M.paid[m.id] ? m.reward : 0;
    M.paid[m.id] = true;
    if (pay) { S.cash += pay; S.totals.missions = (S.totals.missions || 0) + pay; }
    if (MISSIONS.every(x => M.done[x.id] !== undefined)) { M.on = false; M.finished = true; addNews(S, 'good', `Getting started: all done${pay ? `. Bonus ${fmtMoney(pay)}` : ''}. The market is yours.`); }
    else addNews(S, 'good', `Getting started: ${m.text.toLowerCase()} — done.${pay ? ` Bonus ${fmtMoney(pay)}.` : ''}`);
  }
  function checkMissions(S) {
    const M = S.missions; if (!M || !M.on) return;
    for (const m of MISSIONS) if (!m.ui && M.done[m.id] === undefined && m.test(S)) finishMission(S, m);
  }
  function completeMission(S, id) {
    const M = S.missions, m = MISSIONS.find(x => x.id === id);
    if (!M || !M.on || !m || M.done[id] !== undefined) return false;
    finishMission(S, m); return true;
  }
  function startTour(S) { S.missions = { on: true, done: {}, paid: (S.missions && S.missions.paid) || {} }; checkMissions(S); }
  function skipTour(S) { if (S.missions) S.missions.on = false; }

  // ---- scenarios: hand-made situations with a fixed seed, so everyone gets the same weather ----
  // Stars are cumulative: the second needs the first, the third needs both. `r` is scenarioResult().
  const RELIABILITY = 0.00002;   // the NEM reliability standard: 0.002% of energy unserved in a year
  const SCENARIOS = [
    { id: 'first-light', name: 'First Light', days: 14, startDoy: 273, seed: 1101, cash: 600000, calm: true,
      blurb: 'Spring, a quiet market and $600k. Build your first plants and grow the company in two weeks.',
      stars: [['Grow the company to $650k', r => r.value >= 650000], ['Grow it to $745k', r => r.value >= 745000], ['Grow it to $775k', r => r.value >= 775000]] },
    { id: 'heatwave-week', name: 'Heatwave Week', days: 10, startDoy: 14, seed: 2202, cash: 300000,
      blurb: 'Two heatwaves are on the way. You own a 150 MW gas peaker and a 50 MW battery. Ride the spikes, and keep any reserve you promise.',
      plants: [['peaker', 150], ['battery', 50]], script: [{ day: 2, key: 'heatwave', len: 3 }, { day: 7, key: 'heatwave', len: 2 }],
      stars: [['Make $500k profit', r => r.profit >= 500000], ['Make $850k profit', r => r.profit >= 850000], ['…and keep a reserve promise', r => r.reserveKept]] },
    { id: 'black-hill', name: 'Black Hill Closes', days: 21, startDoy: 31, seed: 3303, cash: 2000000,
      blurb: 'Two units of the Black Hill coal plant close this month, taking 1.3 GW out of the evening peak. You have $2M to fill the gap.',
      unlock: ['wind', 'ccgt'], closures: { bh1: 4, bh2: 12 },
      stars: [['Grow the company by $500k', r => r.gain >= 500000], ['Grow it by $1.5M', r => r.gain >= 1500000], ['Grow it by $5M', r => r.gain >= 5000000]] },
    { id: 'gas-squeeze', name: 'Gas Squeeze Winter', days: 16, startDoy: 171, seed: 4404, cash: 1500000,
      blurb: 'Midwinter. You own a 120 MW wind farm and have $1.5M. Gas is about to get very expensive, twice, and then the wind drops. Get ready.',
      plants: [['wind', 120]], unlock: ['wind', 'ccgt'],
      script: [{ day: 3, key: 'gascrunch', len: 5 }, { day: 5, key: 'cold', len: 3 }, { day: 10, key: 'gascrunch', len: 5 }, { day: 11, key: 'still', len: 4 }],
      stars: [['Grow the company by $1.8M', r => r.gain >= 1800000], ['Grow it by $2.45M', r => r.gain >= 2450000], ['Grow it by $2.75M', r => r.gain >= 2750000]] },
    { id: 'too-much-sun', name: 'Too Much Sun', days: 14, startDoy: 282, seed: 5505, cash: 300000, rooftop: 5200,
      blurb: 'Rooftop solar is everywhere and middays go deeply negative. You own 200 MW of solar, set to run whatever the price. Turn it into a business.',
      plants: [['solar', 200, { bid: 'always' }]],
      stars: [['Make a profit', r => r.profit > 0], ['Grow the company by $350k', r => r.gain >= 350000], ['Grow it by $600k', r => r.gain >= 600000]] },
    { id: 'energy-transition', name: 'Energy Transition', days: 20 * 60, yearDays: 60, startDoy: 0,
      lengths: { standard: { name: 'Standard', yearDays: 60, target: 2e9 }, long: { name: 'Long', yearDays: 90, target: 3e9 } }, seed: 2026, cash: 1500000, idle: true, transition: true,
      blurb: 'Twenty fast years. The coal closes, demand grows, new technology arrives and the targets head to zero. Keep the lights on, go green and grow.',
      unlock: ['wind', 'ccgt', 'hydro'],
      stars: [['Keep the lights on: meet the reliability standard in year 20 (no more than 0.002% of demand unserved)', r => r.finalShed <= RELIABILITY * r.finalRegion], ['…and supply 30% of the region from clean plant in year 20', r => r.cleanShare >= 0.3], ['…and grow the company to {target}', r => r.value >= r.target]] },
    { id: 'big-build', name: 'The Big Build', days: 45, startDoy: 304, seed: 6606, cash: 3000000,
      blurb: '$3M, every technology but coal, and six weeks over summer. Build an empire.',
      unlock: ['wind', 'ccgt', 'hydro'],
      stars: [['Grow the company to $5.5M', r => r.value >= 5500000], ['Grow it to $7M', r => r.value >= 7000000], ['Grow it to $8.5M', r => r.value >= 8500000]] },
  ];
  // ---- the Energy Transition: twenty fast years, following the NEM's path ----
  // Each entry happens at the start of its year and is announced a year before. Every year also:
  // demand +2%, rival wind/solar/batteries grow on plan, emissions target tightens to near zero.
  const rival = (S, id) => S.rivals.find(r => r.id === id);
  const closeRival = (S, id) => { const r = rival(S, id); if (r && !r.gone) { r.gone = true; addNews(S, 'info', `${r.name} has closed for good, taking ${fmtMW(r.cap)} out of the market.`); } };
  const TRANSITION = [
    { year: 2, text: 'Electric vehicles take off: evening demand grows every year from now on.', apply: S => { S.evGrow = 70; } },
    { year: 3, text: 'Black Hill 1 closes (660 MW of coal). Its switchyard is free for new batteries.', apply: S => closeRival(S, 'bh1'), close: 660 },
    { year: 3, text: 'Capacity Investment Scheme: the government underwrites new renewables.', apply: S => openTender(S, 'renewable'), tender: true },
    { year: 4, text: 'Offshore wind can be built.', apply: S => { S.unlocked.offshore = true; }, unlocks: 'offshore' },
    { year: 5, text: 'Two Renewable Energy Zones open: Central-West (solar) and New England (wind).' },
    { year: 6, text: 'Black Hill 2 closes (660 MW of coal).', apply: S => closeRival(S, 'bh2'), close: 660 },
    { year: 6, text: 'Long-duration storage can be built.', apply: S => { S.unlocked.ldes = true; }, unlocks: 'ldes' },
    { year: 6, text: 'Capacity Investment Scheme: underwriting for new storage.', apply: S => openTender(S, 'firm'), tender: true },
    { year: 8, text: 'A data-centre cluster connects: 300 MW of demand around the clock.', apply: S => { S.flatLoad = (S.flatLoad || 0) + 300; } },
    { year: 9, text: 'Black Hill 3 closes (660 MW of coal). A gas firming hub and the Black Hill ash dam (for long-duration storage) open for building.', apply: S => closeRival(S, 'bh3'), close: 660 },
    { year: 9, text: 'Capacity Investment Scheme: underwriting for new renewables.', apply: S => openTender(S, 'renewable'), tender: true },
    { year: 10, text: 'Homes switch to electric heating: winter evenings get much busier.', apply: S => { S.heatMult = 1.5; } },
    { year: 10, text: 'Two more zones open: South-West (solar) and Hunter (wind).' },
    { year: 12, text: 'Black Hill 4, the last coal unit, closes (660 MW). A site for hydrogen-ready gas turbines opens at Kurri Kurri.', apply: S => closeRival(S, 'bh4'), close: 660 },
    { year: 12, text: 'Capacity Investment Scheme: underwriting for new storage.', apply: S => openTender(S, 'firm'), tender: true },
    { year: 13, text: 'New places to build: New England REZ stage 2 (wind) and the Illawarra Coast (offshore wind).' },
    { year: 14, text: 'The Central-West REZ line is upgraded to carry 2,500 MW.', apply: S => { (S.lines ||= {})['cw-rez'] = 2500; } },
    { year: 14, text: 'More data centres: another 300 MW around the clock.', apply: S => { S.flatLoad = (S.flatLoad || 0) + 300; } },
    { year: 15, text: 'Wollemi gas plant retires (450 MW). Its switchyard is free for new batteries.', apply: S => closeRival(S, 'wol'), close: 450 },
    { year: 15, text: 'Capacity Investment Scheme: underwriting for new renewables.', apply: S => openTender(S, 'renewable'), tender: true },
    { year: 16, text: 'A bigger interconnector: 1,200 MW each way instead of 700.', apply: S => { rival(S, 'imp').cap = 1200; } },
    { year: 17, text: 'The New England REZ line is upgraded to carry 2,500 MW, and Central-West REZ stage 2 opens (solar).', apply: S => { (S.lines ||= {})['ne-rez'] = 2500; } },
    { year: 18, text: 'Tallawang gas plant retires (600 MW). Its land can take long-duration storage or new turbines.', apply: S => closeRival(S, 'tal'), close: 600 },
    { year: 18, text: 'Capacity Investment Scheme: underwriting for new storage.', apply: S => openTender(S, 'firm'), tender: true },
    { year: 19, text: 'The South-West REZ line is upgraded to carry 3,000 MW.', apply: S => { (S.lines ||= {})['sw-rez'] = 3000; } },
    { year: 20, text: 'The final year: the emissions target is close to zero.' },
  ];
  const TRANSITION_YEARS = 20;
  function transitionYear(S) {
    const y = yearOf(S) + 1;   // the year that is starting
    if (y > 1) {
      S.demandMult = (S.demandMult || 1) * 1.02;
      S.evLoad = (S.evLoad || 0) + (S.evGrow || 0);
      const grow = (id, mw) => { const r = rival(S, id); if (r) { r.cap += mw; if (r.tech === 'battery') r.soc = Math.min(r.soc, r.cap * r.hours); } };
      grow('rwind', S.rivalPlan.wind); grow('rsol', S.rivalPlan.solar); grow('rbat', S.rivalPlan.battery);
      // storage wears out: batteries lose about 2.5% of their capacity a year, long-duration storage 1%
      for (const p of S.plants) {
        const f = TECH[p.tech].fade;
        if (!f || p.status === 'building') continue;
        const was = p.health ?? 1;
        p.health = Math.max(0.5, Math.round((was - f) * 1000) / 1000); p.soc = Math.min(p.soc, storeCap(p));
        if (was >= 0.8 && p.health < 0.8) addNews(S, 'bad', `${p.name} can now hold only ${Math.round(p.health * 100)}% of what it could when new. Refurbish it from its page.`);
      }
    }
    S.emisTarget = Math.round((0.7 - 0.65 * (y - 1) / (TRANSITION_YEARS - 1)) * 100) / 100;
    for (const e of TRANSITION.filter(e => e.year === y)) { addNews(S, e.close ? 'bad' : 'info', `Year ${y}: ${e.text}`); if (e.apply) e.apply(S); }
    const next = TRANSITION.filter(e => e.year === y + 1);
    if (next.length) addNews(S, 'info', `Next year: ${next.map(e => e.text).join(' ')}`);
    // the year just ended, in review (shown as a pop-up), with what this year and next year bring
    const P = S.years && S.years[y - 2];
    if (y > 1 && y <= TRANSITION_YEARS && P) {
      S.yearReport = { ...P, year: y - 1, avgPrice: P.priceSum / Math.max(1, P.days), valueBefore: y > 2 && S.years[y - 3] ? S.years[y - 3].value : S.scenario.v0,
        now: TRANSITION.filter(e => e.year === y).map(e => ({ text: e.text, close: !!e.close })), next: next.map(e => e.text),
        tender: !!S.tender && S.tender.offeredAt === dayIndex(S), seen: false };
    }
  }
  // Capacity Investment Scheme: for a year, new plant of the right kind can be underwritten for 5
  // years: topped up to a floor if it earns less in a day, half of anything above a ceiling paid back.
  const TENDER_KINDS = {
    renewable: { techs: ['solar', 'wind', 'offshore'], floor: 250, ceiling: 650, name: 'renewables' },
    firm: { techs: ['battery', 'ldes', 'hydro'], floor: 300, ceiling: 800, name: 'storage' },
  };
  function openTender(S, kind) {
    const K = TENDER_KINDS[kind];
    S.tender = { kind, floor: K.floor, ceiling: K.ceiling, mw: 600, used: 0, until: dayIndex(S) + yearDaysOf(S), years: 5, accepted: false, offeredAt: dayIndex(S) };
  }
  function acceptTender(S) { if (S.tender && !S.tender.accepted) { S.tender.accepted = true; addNews(S, 'good', `You've joined the Capacity Investment Scheme: new ${TENDER_KINDS[S.tender.kind].name} you start this year (up to ${fmtMW(S.tender.mw)}) are underwritten for ${S.tender.years} years.`); } }
  function declineTender(S) { if (S.tender) S.tender.declined = true; }
  function underwrite(S, p) {   // called when a plant is built
    const t = S.tender;
    if (!t || !t.accepted || dayIndex(S) > t.until || !TENDER_KINDS[t.kind].techs.includes(p.tech) || t.used + p.mw > t.mw) return;
    t.used += p.mw;
    p.cis = { floor: t.floor, ceiling: t.ceiling, until: dayIndex(S) + t.years * yearDaysOf(S) };
    addNews(S, 'good', `${p.name} is underwritten by the Capacity Investment Scheme for ${t.years} years.`);
  }
  function settleUnderwriting(S, d) {
    for (const p of S.plants) {
      if (!p.cis || !running(p) || dayIndex(S) > p.cis.until) continue;
      const perMW = (p.today ? p.today.money : 0) / p.mw;
      let v = 0;
      if (perMW < p.cis.floor) v = (p.cis.floor - perMW) * p.mw;
      else if (perMW > p.cis.ceiling) v = -0.5 * (perMW - p.cis.ceiling) * p.mw;
      S.cash += v; d.cis += v; p.life.cis = (p.life.cis || 0) + v;
    }
  }

  function givePlant(S, tech, mw, extra) {
    S.cash += priceOf(S, tech, mw);
    const p = build(S, tech, mw).plant;
    S.news.shift();   // not "construction has started"
    p.status = 'online'; p.buildLeft = 0; p.last = TECH[tech].kind === 'thermal' ? 0 : p.last;
    Object.assign(p, extra || {});
    return p;
  }
  // A scenario's length: the Energy Transition offers Standard (60-day years) or Long (90-day years).
  const lengthOf = (sc, key) => sc.lengths ? sc.lengths[key] || sc.lengths.standard : null;
  const fmtTarget = v => v >= 1e9 ? `$${+(v / 1e9).toFixed(1)}B` : fmtMoney(v);
  const starText = (sc, key) => sc.stars.map(([t]) => t.replace('{target}', fmtTarget((lengthOf(sc, key) || {}).target || 0)));
  function createScenario(id, opts = {}) {
    const sc = SCENARIOS.find(x => x.id === id), L = lengthOf(sc, opts.length);
    const S = create(sc.seed, { cash: sc.cash, startDoy: sc.startDoy });
    S.scenario = { id, days: sc.days };
    if (L) Object.assign(S.scenario, { days: TRANSITION_YEARS * L.yearDays, length: sc.lengths[opts.length] ? opts.length : 'standard', target: L.target });
    S.script = sc.script || []; S.calm = !!sc.calm;
    if (sc.transition) {
      S.transition = true; S.yearDays = L ? L.yearDays : sc.yearDays; S.years = [];
      S.rooftopGrowth = Math.pow(1.0009, 60 / S.yearDays); S.rivalPlan = { wind: 120, solar: 150, battery: 80 };   // rooftop: about 5.5% a year
    }
    if (sc.rooftop) S.rooftop = sc.rooftop;
    for (const t of sc.unlock || []) S.unlocked[t] = true;
    for (const [t, mw, extra] of sc.plants || []) { const was = S.unlocked[t]; S.unlocked[t] = true; givePlant(S, t, mw, extra); S.unlocked[t] = was || (sc.unlock || []).includes(t); }
    for (const [rid, day] of Object.entries(sc.closures || {})) S.rivals.find(r => r.id === rid).closing = day;
    // no early goal bonuses in a scenario: it's scored on what you make of it
    for (const g of GOALS) S.goalsDone[g.id] = S.goalsDone[g.id] ?? -1;
    S.news = [];
    addNews(S, 'info', `${sc.name}: ${sc.blurb}`);
    if (sc.closures) for (const [rid, day] of Object.entries(sc.closures)) addNews(S, 'info', `${S.rivals.find(r => r.id === rid).name} closes for good on day ${day + 1}.`);
    if (S.transition) transitionYear(S);   // year 1: set the target, announce year 2
    S.upcoming = []; planEvents(S);   // plan tomorrow again, now the script is known
    S.scenario.v0 = companyValue(S);
    makeContractOffers(S);
    return S;
  }
  function scenarioResult(S) {
    const sc = SCENARIOS.find(x => x.id === S.scenario.id);
    const days = S.days.filter(d => d.day < S.scenario.days);
    // the final year comes from the year records: a long year has more days than S.days keeps
    const Y = (S.transition && S.years && S.years[TRANSITION_YEARS - 1]) || { shed: 0, region: 0, clean: 0 };
    const r = { value: companyValue(S), gain: companyValue(S) - S.scenario.v0, profit: S.years ? S.years.reduce((a, Y) => a + Y.profit, 0) : days.reduce((a, d) => a + d.profit, 0),
      target: S.scenario.target ?? (lengthOf(sc, 'standard') || {}).target,
      finalShed: Y.shed, finalRegion: Y.region, cleanShare: Y.clean / Math.max(1, Y.region),
      maxShare: days.reduce((m, d) => Math.max(m, d.share), 0), reserveKept: !!(S.goalFlags && S.goalFlags.reserveKept), bust: !!S.bust };
    return { ...r, ...scoreStars(S, sc, r) };
  }
  function scoreStars(S, sc, r) {
    let stars = 0;
    const texts = starText(sc, S.scenario.length);
    const lines = sc.stars.map(([, test], i) => { const ok = !r.bust && test(r); if (ok && stars === i) stars++; return { text: texts[i], ok }; });
    return { stars, lines };
  }
  // The Energy Transition's stars as they would be if year Y were the final year.
  function starsIf(S, Y) {
    const sc = SCENARIOS.find(x => x.id === S.scenario.id);
    return scoreStars(S, sc, { value: companyValue(S), target: S.scenario.target ?? (lengthOf(sc, 'standard') || {}).target,
      finalShed: Y.shed, finalRegion: Y.region, cleanShare: Y.clean / Math.max(1, Y.region), bust: false });
  }
  const scenarioOver = S => !!S.scenario && (S.bust || S.days.some(d => d.day >= S.scenario.days - 1));

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
    return S.cash - debt(S) + S.plants.reduce((a, p) => a + (p.value || 0) * (p.status === 'building' ? 1 : 0.8), 0);
  }

  // ---- bank loans ----
  // You can borrow up to LOAN_LTV of your company's net worth (value after debts, so borrowing can't
  // raise its own limit). Buying a plant you're offered, the plant itself secures more: up to
  // LOAN_SECURED of its price on top. (Plants here pay for themselves in weeks, so borrowed money
  // compounds fast: simulations put an always-borrow-the-maximum player at about 1.5x a careful one.)
  // The rate is set when you sign: a base rate, more the more geared you'd be, and a little more or
  // less by difficulty. Repaid in equal daily amounts plus the day's interest.
  const LOAN_LTV = 0.2, LOAN_SECURED = 0.6, LOAN_BASE = 0.07, LOAN_GEARING = 0.15, LOAN_TERMS = [30, 90, 180];
  const debt = S => (S.loans || []).reduce((a, l) => a + l.balance, 0);
  const loanRoom = (S, price = 0) => Math.max(0, Math.floor((LOAN_LTV * companyValue(S) - debt(S) + LOAN_SECURED * price) / 1000) * 1000);
  function loanQuote(S, amount, days = 90) {
    const assets = companyValue(S) + debt(S) + amount;
    const gearing = (debt(S) + amount) / Math.max(1, assets);
    const rate = Math.round((LOAN_BASE + LOAN_GEARING * gearing + ({ tough: 0.03, relaxed: -0.01 }[S.difficulty] || 0)) * 1000) / 1000;
    const daily = rate / yearDaysOf(S);
    let bal = amount, interest = 0;
    for (let k = 0; k < days; k++) { interest += bal * daily; bal -= amount / days; }
    return { amount, days, rate, first: Math.round(amount / days + amount * daily), interest: Math.round(interest), room: loanRoom(S) };
  }
  // price: the plant this loan buys, if it's secured on one
  function takeLoan(S, amount, days = 90, price = 0) {
    amount = Math.round(amount);
    if (!LOAN_TERMS.includes(days)) return { ok: false, why: 'term' };
    if (!(amount >= 1000)) return { ok: false, why: 'small' };
    if (amount > loanRoom(S, price)) return { ok: false, why: 'room' };
    const q = loanQuote(S, amount, days);
    const loan = { id: `l${S.t}_${(S.loans || []).length}`, principal: amount, balance: amount, rate: q.rate, days, left: days, taken: dayIndex(S) };
    (S.loans ||= []).push(loan);
    S.cash += amount;
    addNews(S, 'info', `You borrowed ${fmtMoney(amount)} at ${(q.rate * 100).toFixed(1)}% a year, repaid over ${days} days.`);
    return { ok: true, loan, quote: q };
  }
  function repayLoan(S, id, amount) {
    const l = (S.loans || []).find(x => x.id === id); if (!l) return { ok: false, why: 'none' };
    amount = Math.min(l.balance, amount ?? l.balance);
    if (!(amount > 0) || S.cash < amount) return { ok: false, why: 'cash' };
    S.cash -= amount; l.balance -= amount;
    if (l.balance < 1) { S.loans = S.loans.filter(x => x !== l); addNews(S, 'good', `Loan of ${fmtMoney(l.principal)} repaid.`); }
    return { ok: true, amount };
  }
  function payLoans(S, d) {
    for (const l of S.loans || []) {
      const interest = Math.round(l.balance * l.rate / yearDaysOf(S));
      const principal = l.left <= 1 ? l.balance : Math.min(l.balance, l.principal / l.days);
      S.cash -= interest + principal; d.loanInterest = (d.loanInterest || 0) + interest;
      l.balance -= principal; l.left--;
      if (l.balance < 1) addNews(S, 'good', `Loan of ${fmtMoney(l.principal)} repaid.`);
    }
    S.loans = (S.loans || []).filter(l => l.balance >= 1);
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
      if (S.bust) break;
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
  function fmtPrice(v) { const s = v < 0 ? '−' : ''; const a = Math.abs(v); return `${s}$${a >= 1000 ? `${(a / 1000).toFixed(Math.round(a) % 1000 === 0 ? 0 : 1)}k` : Math.round(a)}`; }
  function clock(h) { const hh = Math.floor(h), mm = Math.round((h - hh) * 60); const ap = hh >= 12 ? 'pm' : 'am'; const h12 = ((hh + 11) % 12) + 1; return `${h12}:${String(mm).padStart(2, '0')} ${ap}`; }
  function dateLabel(S) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], len = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let d = doyOf(S), m = 0; while (d >= len[m]) { d -= len[m]; m++; }
    const year = S.yearDays ? yearOf(S) + 1 : Math.floor((startDoy(S) + dayIndex(S)) / 365) + 1;
    return { day: dayIndex(S) + 1, date: `${d + 1} ${months[m]}`, month: months[m], year, time: clock(hourOf(S)) };
  }

  return { minMW, stackTarget, yearDays: yearDaysOf, LOAN_SECURED, debt, loanRoom, loanQuote, takeLoan, repayLoan, LOAN_TERMS, LOAN_LTV, starsIf, RELIABILITY, starText, lineOf, storeCap, refurbish, refurbishCost, TRANSITION, TRANSITION_YEARS, TENDER_KINDS, acceptTender, declineTender, yearOf, CERT, NB, presetMW, setBandPrice, setBandMW, fillBands, upkeepFor, SITES, siteOf, siteRoom, siteFor, buildDays, buildProblem, canUpgrade, IPD, H, FLOOR, CAP, APC, CPT, REAL_CPT, TECH, TECH_ORDER, OTHER, GOALS, EVENTS, AWAY_CAP_DAYS, DIFFICULTY, UPGRADES, CONTRACT_DAYS,
    create, migrate, step, catchUp, build, retire, acceptOffer, declineOffer, priceOf, companyValue, firmCapacity, conditions,
    upgrade, upgradeCost, upkeepOf, plantProfit, signContract, contractRoom, SCENARIOS, createScenario, scenarioResult, scenarioOver, MISSIONS, missionNext, checkMissions, completeMission, startTour, skipTour, overdraftLimit, forecast, hoursOf, vcOf,
    fmtMoney, fmtMW, fmtPrice, clock, dateLabel, dayIndex, hourOf, rnd };
})();
if (typeof module !== 'undefined') module.exports = Sim;
