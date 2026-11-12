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
  // A company scenario lists its own openings in `sites`; zones it doesn't list stay shut.
  function siteOpensIn(S, st) {
    if (st.opens == null) return 0;
    if (!S.transition) return null;
    const sc = scenarioOf(S);
    return sc && sc.sites ? sc.sites[st.id] ?? null : st.opens;
  }
  const siteOpen = (S, st) => { const y = siteOpensIn(S, st); return y != null && yearOf(S) + 1 >= y; };
  // A zone's line can carry less than the zone has room for: build past it and output is curtailed.
  const lineOf = (S, st) => st.line == null ? null : (S.lines && S.lines[st.id]) ?? st.line;
  const LEGACY = { id: 'legacy', name: 'Original site', mlf: 1, res: 1, room: Infinity, blurb: '' };
  function siteOf(tech, id) { return (SITES[tech] || []).find(x => x.id === id) || (id === 'legacy' || !SITES[tech] ? LEGACY : SITES[tech][0]); }
  function siteUsed(S, tech, id) { return S.plants.reduce((a, p) => a + ((p.site === id && (SITES[p.tech] === SITES[tech])) ? p.land ?? p.mw : 0), 0); }   // land: a repowered farm stands on its old footprint
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
  // A plant's own draw for the day (v41): from the game's seed, the plant (a rebuild inherits the old
  // plant's, rkey) and the day, so one plant's
  // breakdowns never depend on what else you build, overhaul or sell, and the player stream (now only
  // contract offers) isn't shifted by them either. FNV-1a over the key, then a mulberry32 step.
  function plantRnd(S, p, salt) {
    const key = `${p.rkey ?? p.id}|${Math.floor(S.t / IPD)}|${salt}`;
    let h = Math.imul(((S.seed ?? 1) >>> 0) ^ 0x811C9DC5, 0x01000193) >>> 0;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
    let t = (h + 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

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
      upkeep: 0, penalties: 0, bonus: 0, contracts: 0, repairs: 0, interest: 0, capPay: 0, fcasRaise: 0, fcasLower: 0, certs: 0, starts: 0, clean: 0, cis: 0, loanInterest: 0, retail: 0, keepPay: 0, overruns: 0, rivalBuilt: 0, rivalShelved: 0, capPays: { 150: 0, 300: 0, 1000: 0 } };
  }
  // Older saves: fill in fields added since they were made.
  function migrate(S) {
    S.contracts ||= []; S.difficulty ||= 'standard';
    if (!S.contractOffers) makeContractOffers(S);
    for (const k of ['contracts', 'repairs', 'interest', 'capPay', 'fcasRaise', 'fcasLower', 'certs', 'starts', 'clean', 'cis', 'loanInterest', 'retail', 'keepPay', 'overruns', 'rivalBuilt', 'rivalShelved']) S.today[k] ??= 0;
    S.today.capPays ||= { 150: 0, 300: 0, 1000: 0 };
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
    // company scenarios started on version 24 had no closure schedule: give them the scenario's,
    // without units already gone or kept open by the government's deal
    const sc = scenarioOf(S);
    if (sc && sc.group === 'company' && sc.closes && !S.closeAt) {
      const kept = (S.keepOpen && S.keepOpen.refs) || [];
      S.closeAt = Object.fromEntries(Object.entries(sc.closes).filter(([ref]) => !kept.includes(ref) && S.plants.some(p => p.ref === ref)));
    }
    if (S.transition) {
      const owns = (scenarioOf(S) || {}).owns || [];
      for (const p of S.plants) {
        if (!AGEING[p.tech] || p.age != null || p.status === 'building') continue;
        const o = (owns.find(([rid]) => rid === p.ref) || [])[1] || {};
        const yrs = Math.floor(Math.max(0, S.t - (p.built || 0)) / IPD / yearDaysOf(S));
        p.age = (o.age || 0) + yrs; p.wear = Math.round((o.age || 0) / 2) + yrs;
      }
    }
    for (const r of S.rivals || []) {
      const m = /^Rival (battery|peaker) (\d+)$/.exec(r.name || '');
      if (m) r.name = rivalName(S, DEVELOPERS[(+m[2] - 1) % DEVELOPERS.length], m[1], r);
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
    return T.vc * (p.tech === 'coal' ? 1 : S.fuelMult) * (p.upg && p.tech === 'ccgt' ? 0.88 : 1) * ageEffects(p).vc / (p.vintage || 1);
  }
  // (storage has no emis of its own: without the || 0 a battery's output made the totals NaN, which
  // silently switched off emissions fines and broke challenge result codes)
  const emisOf = p => (TECH[p.tech].emis || 0) * (p.upg && p.tech === 'ccgt' ? 0.88 : 1);

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
    const vreMW = p => { const T = TECH[p.tech], cf = (p.tech === 'solar' ? c.sun : Math.min(1, (T.steady || 0) + c.wind * (p.res ?? 1))); return Math.min(p.mw, p.mw * cf * (p.upg ? 1.2 : 1) * (p.vintage || 1)) * ageEffects(p).out; };   // wear is lost availability: after the cap
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
  // ---- why prices spiked: the day's first price of SPIKE or more gets a news line with reasons ----
  const SPIKE = 1000;
  // Up to three reasons, the rarer and more telling first: units broken down, the interconnector out,
  // a heatwave or cold snap, still wind, dear gas; then imports at their limit (true at most evening
  // peaks) and sunset only to fill in.
  function spikeReasons(S, c, supply) {
    const out = [], ev = k => activeEvent(S, k);
    const down = S.rivals.filter(r => !r.gone && r.out > 0 && ['coal', 'ccgt', 'peaker'].includes(r.tech)).map(r => ({ name: r.name, mw: r.cap }))
      .concat(S.plants.filter(p => p.status === 'outage').map(p => ({ name: p.name, mw: p.mw, mine: true })));
    if (down.length === 1) out.push(`${down[0].mine ? 'your ' : ''}${down[0].name} (${fmtMW(down[0].mw)}) was broken down`);
    else if (down.length > 1) {
      const mine = down.find(x => x.mine);
      out.push(`${down.length} units were broken down (${fmtMW(down.reduce((a, x) => a + x.mw, 0))}${mine ? `, one of them your ${mine.name}` : ''})`);
    }
    if (c.linkOut) out.push('the interconnector was out');
    if (ev('heatwave')) out.push(`the heatwave pushed demand to ${fmtMW(c.demand)}`);
    else if (ev('cold')) out.push(`the cold snap pushed demand to ${fmtMW(c.demand)}`);
    if (ev('still') || c.wind < 0.08) out.push('wind was nearly still');
    if (ev('gascrunch')) out.push('gas was dear');
    const imp = supply.filter(b => b.ref && b.ref.id === 'imp');
    if (out.length < 3 && !c.linkOut && imp.length && imp.every(b => b.out >= b.mw - 0.5)) out.push('imports were at their limit');
    if (out.length < 2 && c.sun < 0.02 && c.h >= 16) out.push('the sun had set');
    return out.slice(0, 3);
  }
  const listText = a => a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
  // Who set the price: the dearest offer that ran (none if supply ran out, or a buyer's bid set it).
  function topBand(supply, res) {
    if (res.shortfall >= 1) return null;
    let top = null;
    for (const b of supply) if (b.out > 0.01 && (!top || b.price > top.price || (b.price === top.price && b.out > top.out))) top = b;
    return top && top.price >= res.price - 0.5 ? top : null;
  }
  function priceSetter(supply, res) {
    const top = topBand(supply, res);
    if (!top) return '';
    return top.owner === 'player' ? `Your ${top.ref.name} set the price.` : top.ref.id === 'imp' ? 'Imports set the price.'
      : top.ref.id === 'dsp' ? 'Demand response (customers paid to cut back) set the price.' : `${top.ref.name} set the price.`;
  }
  function spikeNews(S, c, supply, res) {
    const why = spikeReasons(S, c, supply), set = priceSetter(supply, res), head = `Prices hit ${fmtPrice(res.price)}/MWh at ${clock(c.h)}`;
    return `${why.length ? `${head}: ${listText(why)}.` : `${head} as demand outran the cheaper offers.`}${set ? ` ${set}` : ''}`;
  }
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
      countUse(S, p, o);
      // gas: a start costs money; once started it runs at least its minimum time
      const G = T[p.tech];
      if (G.startCost) {
        if (!running(p)) p.onFor = null;
        else if (o > 0.05) {
          if (p.onFor == null) {
            const c = G.startCost * p.mw; starts += c; p.life.starts += c; p.today.money -= c; p.today.starts = (p.today.starts || 0) + 1; p.onFor = 0;
            if (p.use) p.use.starts++;
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
      if (k.retail) d.retail += v;
    }

    S.cash += rev - cost + fcasRev + hedge + certs - starts;
    d.certs += certs; d.starts += starts;
    d.revenue += rev; d.costs += cost; d.fcas += fcasRev; d.fcasRaise += fcasR; d.fcasLower += fcasL; d.emis += emis; d.contracts += hedge;
    d.capPay += Math.max(0, res.price - 300) * H;
    for (const k of CAP_STRIKES) d.capPays[k] += Math.max(0, res.price - k) * H;
    if (careerOn(S)) {   // awards: how often your offer set the price, and the dearest price you sold into
      const M = (S.month ||= freshMonth()), R = (S.records ||= {});
      M.n++; const top = topBand(supply, res); if (top && top.owner === 'player') M.setN++;
      if (mine > 0.5) {
        const day = dayIndex(S);
        if (mine >= SURF_MW && (!M.top || res.price > M.top.price)) M.top = { price: res.price, day, h: c.h, mw: mine };
        if (!R.price || res.price > R.price.v) R.price = { v: res.price, day, h: c.h };
      }
    }
    d.energy += Math.max(0, mine) * H; d.regionEnergy += c.demand * H;
    for (const b of supply) if (b.owner === 'player' && b.out > 0 && !T[b.tech].emis) d.clean += b.out * H;   // wind, solar, storage, hydro
    d.price.push(res.price); d.demand.push(c.demand); d.mine.push(Math.max(0, mine));
    d.maxP = d.maxP == null ? res.price : Math.max(d.maxP, res.price); d.minP = d.minP == null ? res.price : Math.min(d.minP, res.price);
    S.totals.fcas += fcasRev; S.totals.emis += emis;

    // reliability obligation window
    if (S.obligation && S.t >= S.obligation.from && S.t < S.obligation.to) {
      const firm = firmCapacity(S, true);
      if (S.obligation.worst == null || firm < S.obligation.worst) { S.obligation.worst = firm; S.obligation.worstAt = S.t; }
    }
    if (res.shortfall >= 1) {   // a real shortfall (a rounding-sized one doesn't count)
      d.shed = (d.shed || 0) + res.shortfall * H; d.shedN = (d.shedN || 0) + 1;
      if (!d.shedNews) {
        d.shedNews = true; d.spikeNews = true;   // this line says why, so no separate spike line
        const why = spikeReasons(S, c, supply);
        addNews(S, 'bad', `Supply ran short at ${clock(c.h)}${why.length ? `: ${listText(why)}` : ''}. The operator cut ${fmtMW(res.shortfall)} of customers and the price hit the cap.`);
      }
    } else if (res.price >= SPIKE && !d.spikeNews) { d.spikeNews = true; addNews(S, 'info', spikeNews(S, c, supply, res)); }

    // construction, outages
    for (const p of S.plants) {
      if (p.status === 'building') {
        p.buildLeft -= 1 / IPD;
        if (p.buildLeft <= 0) {
          p.status = 'online'; p.today = { energy: 0, money: 0 };
          const old = p.replaces && S.plants.find(x => x.id === p.replaces);
          if (old) { S.plants = S.plants.filter(x => x !== old); retireRecord(S, old, p.salvage || 0); addNews(S, 'good', `The new ${p.name}${p.mw > old.mw ? ` (${fmtMW(p.mw)}, up from ${fmtMW(old.mw)})` : ''} is connected and trading; the old one has been knocked down.`); }
          else addNews(S, 'good', `${p.name} is connected and trading.`);
          delete p.replaces; checkMissions(S);
        }
      } else if (p.status === 'upgrading') {
        p.upgLeft -= 1 / IPD;
        if (p.upgLeft <= 0) finishUpgrade(S, p);
      } else if (p.status === 'overhaul') {
        p.ohLeft -= 1 / IPD;
        if (p.ohLeft <= 0) { p.status = 'online'; addNews(S, 'good', `${p.name} is back from its overhaul.`); }
      }
    }

    S.last = { c, res, fc, supply, demandBids, mine, hedge, rev: rev - cost + fcasRev + hedge };
    S.t++;
    // contracts that have run their term end
    for (const k of S.contracts) if (S.t >= k.until) addNews(S, k.pnl >= 0 ? 'good' : 'bad', k.retail
      ? `Your customers' year is over: supplying ${fmtMW(k.mw)} at ${fmtPrice(k.strike)}/MWh ${k.pnl >= 0 ? 'made' : 'cost'} you ${fmtMoney(Math.abs(k.pnl))} against the market.`
      : `Your ${k.mw} MW ${k.type === 'swap' ? `swap at ${fmtPrice(k.strike)}` : `${fmtPrice(k.strike)} cap`} has ended. It ${k.pnl >= 0 ? 'made' : 'cost'} you ${fmtMoney(Math.abs(k.pnl))} overall.`);
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
    const at = o.worstAt != null ? clock(((o.worstAt % IPD) * H)) : null;
    // what the result pop-up shows (the news line says it too)
    S.reserveResult = { mw: o.mw, worst: o.worst ?? 0, at, short, payment: o.payment, penalty: 0, kept: short <= 1, seen: false };
    if (short > 1) {
      const pen = Math.round(short / o.mw * o.payment * 3 * diff(S).penalty);
      S.cash -= pen; S.today.penalties += pen; S.reserveResult.penalty = pen;
      if (S.month) S.month.missed++;
      (S.reserveTally ||= { kept: 0, missed: 0 }).missed++;
      addNews(S, 'bad', `You were ${fmtMW(short)} short of the reserve you promised (lowest ${fmtMW(o.worst ?? 0)} ready${at ? ` at ${at}` : ''}). Penalty: ${fmtMoney(pen)}.`);
    } else {
      if (S.month) S.month.kept++;
      (S.reserveTally ||= { kept: 0, missed: 0 }).kept++;
      S.goalFlags = { ...(S.goalFlags || {}), reserveKept: true };
      addNews(S, 'good', `You kept your reserve promise: at least ${fmtMW(o.worst ?? 0)} stayed ready from 3 to 8 pm.`);
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
    settleKeepOpen(S, d);
    payBills(S, d);
    const profit = d.revenue - d.costs + d.fcas + d.contracts + d.certs - d.starts + d.cis - upkeep - d.penalties - d.repairs - d.interest - (d.loanInterest || 0) + d.bonus;
    const priceSorted = [...d.price].sort((a, b) => a - b);
    const avg = d.price.reduce((a, b) => a + b, 0) / Math.max(1, d.price.length);
    const rec = { day, profit, revenue: d.revenue, costs: d.costs, fcas: d.fcas, fcasRaise: d.fcasRaise, fcasLower: d.fcasLower, certs: d.certs, starts: d.starts, clean: d.clean, cis: d.cis, region: d.regionEnergy, contracts: d.contracts, repairs: d.repairs, interest: d.interest, loanInterest: d.loanInterest || 0, upkeep, energy: d.energy, share: d.energy / Math.max(1, d.regionEnergy),
      avg, max: d.maxP, min: d.minP, emis: d.emis, capPay: d.capPay, priceSorted, price: d.price, demand: d.demand, mine: d.mine, shed: d.shed || 0, penalties: d.penalties, bonus: d.bonus, retail: d.retail, keepPay: d.keepPay, overruns: d.overruns, capPays: d.capPays };
    S.days.push(rec);
    if (careerOn(S)) { tallyDay(S, rec); if ((day + 1) % 30 === 0) judgeAwards(S); }
    if (S.days.length > 3) { const old = S.days[S.days.length - 4]; delete old.price; delete old.demand; delete old.mine; }
    if (S.days.length > 60) S.days.shift();
    S.totals.profit += profit; S.totals.energy += d.energy;
    S.totals.contracts = (S.totals.contracts || 0) + d.contracts;
    if (S.transition) {   // the year's report: reliability, clean share, profit
      const y = Math.floor(day / yearDaysOf(S)), Y = (S.years[y] ||= { shed: 0, shedHours: 0, clean: 0, region: 0, profit: 0 });
      Y.shed += d.shed || 0; Y.shedHours += d.shedN ? d.shedN / 12 : 0; Y.clean += d.clean; Y.region += d.regionEnergy; Y.profit += profit; Y.value = companyValue(S);
      Y.energy = (Y.energy || 0) + d.energy; Y.emis = (Y.emis || 0) + d.emis; Y.emisTarget = S.emisTarget;
      for (const k of ['retail', 'keepPay', 'overruns', 'rivalBuilt', 'rivalShelved']) Y[k] = (Y[k] || 0) + (d[k] || 0);
      Y.priceSum = (Y.priceSum || 0) + avg; Y.days = (Y.days || 0) + 1; Y.peak = Math.max(Y.peak || 0, ...d.demand); Y.curtailed = (Y.curtailed || 0) + (d.curtailed || 0);
    }
    for (const p of S.plants) {
      if (p.today && p.status === 'online') {   // recent earnings, for judging an overhaul or a rebuild
        const m = p.today.money || 0, e = Math.max(0, p.today.energy || 0);
        p.margin = p.margin == null ? m : p.margin * 0.85 + m * 0.15; p.eDay = p.eDay == null ? e : p.eDay * 0.85 + e * 0.15;
      }
      if (p.use) p.use.ran = !!p.today && (p.today.energy || 0) > 0;   // a breakdown on a day it ran is a trip
      p.today = { energy: 0, money: 0 };
    }
    S.today = freshDay();

    // rivals: hydro water budget refills, outages count down, breakdowns
    for (const r of S.rivals) {
      if (r.tech === 'hydro') r.used = 0;
      if (r.out > 0) { r.out--; if (r.out === 0) addNews(S, 'info', `${r.name} is back online.`); }
      if (r.tech === 'coal' && !r.gone) {
        const roll = rnd(S, W), len = rnd(S, W);
        const odds = (activeEvent(S, 'heatwave') ? 0.03 : 0.012) * coalAge(S);
        if (r.out === 0 && roll < odds) {
          r.out = majorFailure(S, r, roll, odds) ? 6 + Math.floor(len * 7) : 1 + Math.floor(len * 3);
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
        const roll = plantRnd(S, p, 0), len = plantRnd(S, p, 1);
        const odds = T.outage * diff(S).outage * ageEffects(p).brk * (p.upg && p.tech === 'peaker' ? 0.5 : 1) * (p.tech === 'coal' ? coalAge(S) * (isCompany(S) && activeEvent(S, 'heatwave') ? 2 : 1) : 1);
        if (roll < odds) {
          const major = p.tech === 'coal' && majorFailure(S, p, roll, odds);
          p.status = 'outage'; p.outLeft = major ? 6 + Math.floor(len * 7) : 1 + Math.floor(len * 2);
          if (p.use && p.use.ran) p.use.trips++;
          const fix = Math.round(p.mw * 150 * diff(S).upkeep * (major ? 4 : 1)); S.cash -= fix; S.today.repairs += fix; p.life.repairs += fix;
          addNews(S, 'bad', major ? `${p.name}: ${FAILURES[Math.floor(len * FAILURES.length)]}. It's out for ${p.outLeft} days and repairs cost ${fmtMoney(fix)}.`
            : `${p.name} has broken down. Repairs cost ${fmtMoney(fix)} and take ${p.outLeft} day${p.outLeft > 1 ? 's' : ''}.`);
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
    // emissions: every 30 days the regulator checks your intensity (before a new year's target applies)
    if (dayIndex(S) % 30 === 0) emissionsCheck(S);
    choiceTimeout(S);
    if (S.transition && dayIndex(S) % yearDaysOf(S) === 0) transitionYear(S);
    offerScheduledChoice(S);
    if (dayIndex(S) % (S.transition ? yearDaysOf(S) : 60) === 0) { S.costMult.battery *= 0.96;   // once a transition year
      S.costMult.solar *= 0.97; S.costMult.wind *= 0.985; S.costMult.hydro *= 0.99; }
    // rivals invest too: a month of high prices brings new peaking plant or batteries. In a company
    // scenario they announce a project first and decide later; the Energy Transition follows its plan.
    if (isCompany(S)) { rivalProjects(S); if (dayIndex(S) % 5 === 0 && S.days.length >= 15) rivalProposal(S); }
    else if (dayIndex(S) % 15 === 0 && S.days.length >= 15 && !S.transition) rivalInvestment(S);
    // every site full for what you can build: say so once (again if room frees up and fills again)
    const full = regionFull(S);
    if (full && !S.fullSaid) addNews(S, 'info', fullNote(S));
    S.fullSaid = full;
    // a rival coal unit announces its closure on day 40 and closes on day 70
    if (dayIndex(S) === 40 && !S.challenge && !S.scenario) { const r = S.rivals.find(x => x.id === 'bh1'); r.closing = 70; addNews(S, 'info', 'Black Hill 1 will close for good in 30 days. That leaves a gap in the evening peak.'); }
    makeOffers(S);
    if (dayIndex(S) % 3 === 0) makeContractOffers(S);
    rec.value = companyValue(S);
    checkGoals(S, rec);
  }

  // Ageing coal in company scenarios: breakdowns ×(1 + 0.35 a year), and from year 3, or in a unit's
  // last year before it closes, one breakdown in five is a major failure lasting 6-12 days.
  const coalAge = S => isCompany(S) ? 1 + 0.35 * yearOf(S) : 1;
  const FAILURES = ['a boiler tube has burst', 'a turbine bearing has failed', 'a coal mill has caught fire', 'the generator transformer has failed', 'a cooling-water pump has seized'];
  function majorFailure(S, unit, roll, odds) {
    if (!isCompany(S) || roll >= odds * 0.2) return false;
    const c = unit.ref ? closesIn(S, unit) : null;
    return yearOf(S) >= 2 || !!(c && c.year === yearOf(S) + 2);
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
  function upkeepOf(S, p) { return upkeepFor(S, p.tech, p.mw, TECH[p.tech].kind === 'storage' ? (p.mwh ?? p.mw * hoursOf(p)) : undefined) * ageEffects(p).up; }

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
  // ---- plants age, in the multi-year scenarios (the Energy Transition and the company scenarios) ----
  // Once a game year every plant gains a year of age (only a rebuild resets it) and a year of wear (an
  // overhaul removes 70%). Per year of wear: out = output lost, vc = running cost added, up = upkeep
  // added, brk = breakdown odds added. Past its design life a plant wears three times as fast, and an
  // overhaul can't remove that part: in the end, knock it down and rebuild. Wind, offshore and solar
  // built later in a scenario make more (vint per year, up to +25%): turbines and panels improve.
  // oh = overhaul cost as a share of today's build price (hydro: of its turbines), ohDays offline (a
  // day: done in the quiet hours). A rebuild is built alongside: the old plant runs until it connects.
  // Coal keeps its own ageing (more breakdowns each year, coalAge) and its closure dates.
  // Gas built later runs cheaper (vint a year, up to vcap): newer turbines burn less gas.
  // Repowering (v41): wind, offshore and solar can be rebuilt bigger on the same land, as modern
  // turbines and panels allow: REPOWER_RATE of its MW per year of age, up to REPOWER_CAP.
  // Gas and storage wear with use (v41, see yearWear): start = the hours of running a start counts as,
  // typical = the steady test player's average use per game day (equivalent hours for gas, full cycles
  // for storage; v41, Transition and company scenarios), so typical play wears about a year a year.
  // Most of its peakers sit idle (median under 1 hour a day) and a few run hard (6+ hours).
  const AGEING = {
    solar:    { out: 0.006, up: 0.02, life: 25, oh: 0.08, ohDays: 1, vint: 0.01, repower: true },
    wind:     { out: 0.012, up: 0.03, life: 20, oh: 0.12, ohDays: 1, vint: 0.015, repower: true },
    offshore: { out: 0.010, up: 0.03, life: 25, oh: 0.12, ohDays: 1, vint: 0.01, repower: true },
    peaker:   { vc: 0.008, up: 0.025, brk: 0.08, life: 30, oh: 0.10, ohDays: 1, start: 2, typical: 2.5, vint: 0.005, vcap: 0.1 },
    ccgt:     { vc: 0.010, up: 0.025, brk: 0.08, life: 30, oh: 0.10, ohDays: 1, start: 10, typical: 16, vint: 0.005, vcap: 0.1 },
    hydro:    { up: 0.01, life: 50, oh: 0.06, ohDays: 1, noRebuild: true },
    battery:  { up: 0.02, life: 15, store: true, typical: 0.45 },
    ldes:     { up: 0.02, life: 20, store: true, typical: 0.25 },
  };
  const OVERHAUL_KEEPS = 0.3, VINTAGE_CAP = 0.25, WORN_AT = 1 / 3, REPOWER_RATE = 0.025, REPOWER_CAP = 0.5;
  // How much of each part of an estimated gain to count (see wearGain): more output, the newer design's
  // share of it, cheaper running, fewer breakdowns, cheaper upkeep.
  const GAIN_K = { out: 0.42, vint: 0.5, size: 1, vc: 0.6, brk: 0.6, up: 0.6 };
  // Years of wear that count: the wear, plus each year past design life twice more.
  function wearOf(p) { const A = AGEING[p.tech]; return A ? (p.wear || 0) + 2 * Math.max(0, (p.age || 0) - A.life) : 0; }
  // Use-based wear (v41). A year's wear = USE_CALENDAR (ageing even when idle) + the rest × this year's
  // use ÷ typical use, capped at USE_CAP; a battery's capacity fade scales the same way. Gas use is in
  // equivalent operating hours, as turbine makers count it: an hour running is 1, a start A.start more,
  // a trip while running TRIP_STARTS starts. Wind, solar and hydro age by the calendar.
  const USE_CALENDAR = 0.3, USE_CAP = 3, TRIP_STARTS = 5;
  const usesWear = A => !!A && (!!A.start || !!A.store);
  const freshUse = S => ({ since: S.t, hours: 0, starts: 0, trips: 0, mwh: 0 });
  const eohOf = (A, u) => u.hours + (u.starts + u.trips * TRIP_STARTS) * (A.start || 0);
  // Counted each interval in the multi-year scenarios: hours running (gas), MWh discharged (storage).
  function countUse(S, p, o) {
    const A = S.transition && AGEING[p.tech];
    if (!usesWear(A) || p.status === 'building') return;
    const u = (p.use ||= freshUse(S));
    if (A.store) { if (o > 0) u.mwh += o * H; }
    else if (o > 0.05) u.hours += H;
  }
  // This year's use so far: what it was, and the years of wear a whole year at this rate would add.
  function useSoFar(S, p) {
    const A = AGEING[p.tech], u = p.use;
    if (!usesWear(A) || !u) return null;
    const days = Math.max(0, Math.min(yearDaysOf(S), (S.t - u.since) / IPD));
    const cycles = A.store ? u.mwh / Math.max(1e-9, storeCap(p)) : 0, used = A.store ? cycles : eohOf(A, u);
    const ratio = A.typical && days >= 0.5 ? used / (A.typical * days) : 1;
    return { days, hours: u.hours, starts: u.starts, trips: u.trips, cycles, eoh: A.store ? 0 : eohOf(A, u), ratio, wear: Math.min(USE_CAP, USE_CALENDAR + (1 - USE_CALENDAR) * ratio) };
  }
  // The years of wear this year adds (1 for plants that age by the calendar). The part of the year
  // before counting started (an old save) counts as typical.
  function yearWear(S, p) {
    const s = useSoFar(S, p);
    if (!s) return 1;
    const frac = Math.min(1, s.days / yearDaysOf(S)), ratio = (1 - frac) + frac * s.ratio;
    return Math.min(USE_CAP, USE_CALENDAR + (1 - USE_CALENDAR) * ratio);
  }
  function ageEffects(p) {
    const A = AGEING[p.tech], w = wearOf(p);
    if (!A || !w) return { w: 0, out: 1, vc: 1, up: 1, brk: 1 };
    return { w, out: Math.max(0.5, 1 - (A.out || 0) * w), vc: 1 + (A.vc || 0) * w, up: 1 + (A.up || 0) * w, brk: 1 + (A.brk || 0) * w };
  }
  // A plant's condition for the page, the cards and the news.
  function condition(p) {
    const A = AGEING[p.tech]; if (!A) return null;
    const e = ageEffects(p), age = Math.floor(p.age || 0), past = age > A.life, worn = past || wearOf(p) >= A.life * WORN_AT, bits = [];
    if (A.out) bits.push(`output −${Math.round((1 - e.out) * 100)}%`);
    if (A.vc) bits.push(`running cost +${Math.round((e.vc - 1) * 100)}%`);
    if (A.brk) bits.push(`breakdowns ×${e.brk.toFixed(1)}`);
    bits.push(`upkeep +${Math.round((e.up - 1) * 100)}%`);
    return { age, life: A.life, past, worn, wear: wearOf(p), effects: e, text: e.w ? bits.join(', ') : 'as good as new' };
  }
  const vintageNow = (S, tech) => { const A = AGEING[tech]; return S.transition && A && A.vint ? 1 + Math.min(A.vcap ?? VINTAGE_CAP, A.vint * yearOf(S)) : 1; };
  // The size a farm could be repowered to on its land (null if no bigger: too young, or not wind or solar).
  function repowerMW(S, p) {
    const A = AGEING[p.tech], T = TECH[p.tech];
    if (!A || !A.repower) return null;
    const land = p.land ?? p.mw, mw = Math.min(T.range[1], Math.floor(land * (1 + Math.min(REPOWER_CAP, REPOWER_RATE * Math.floor(p.age || 0))) / 5) * 5);
    return mw > p.mw ? mw : null;
  }
  function overhaulCost(S, p) {
    const A = AGEING[p.tech]; if (!A || !A.oh) return null;
    const base = p.tech === 'hydro' ? TECH.hydro.capexMW * p.mw * S.costMult.hydro * diff(S).capex : priceOf(S, p.tech, p.mw, { site: p.site, mwh: p.mwh });
    return Math.round(base * A.oh / 100) * 100;
  }
  // Overhaul: most of the wear goes (not the years past design life); offline for a few days.
  function overhaul(S, p) {
    const A = AGEING[p.tech];
    if (!A || !A.oh || p.status !== 'online' || p.replacedBy || !((p.wear || 0) >= 1)) return { ok: false, why: 'unavailable' };
    const cost = overhaulCost(S, p);
    if (S.cash < cost) return { ok: false, why: 'cash' };
    S.cash -= cost; p.value += cost; p.capital += cost;
    p.wear = Math.round(p.wear * OVERHAUL_KEEPS * 10) / 10; p.status = 'overhaul'; p.ohLeft = A.ohDays; p.overhauls = (p.overhauls || 0) + 1;
    addNews(S, 'info', `${p.name} is offline for ${A.ohDays} day${A.ohDays === 1 ? '' : 's'} for an overhaul (${fmtMoney(cost)}).`);
    return { ok: true, cost };
  }
  // Knock down and rebuild: a new plant of today's design on the same site, same size. The grid
  // connection is reused, and the old plant is salvaged as if sold (40% of its book value).
  function rebuildCost(S, p, mw = p.mw) {
    const A = AGEING[p.tech], T = TECH[p.tech];
    if (!A || A.noRebuild) return null;
    const st = siteOf(p.tech, p.site), price = priceOf(S, p.tech, mw, { site: p.site, mwh: p.mwh });
    const conn = Math.round((T.connect || 0) * (st.connect ?? 1) * S.costMult[p.tech] * diff(S).capex / 100) * 100, salvage = Math.round(p.value * 0.4);
    return { price, conn, salvage, net: Math.max(0, price - conn - salvage), days: buildDays(p.tech, mw, p.site), mw };
  }
  // What a rebuild changes: output against today's (wind and solar), and the wear that goes.
  // A repower (a bigger mw) adds its extra size to the output; newer gas also runs cheaper.
  function rebuildGain(S, p, mw = p.mw) {
    const e = ageEffects(p), A = AGEING[p.tech], vNow = vintageNow(S, p.tech), vOld = p.vintage || 1;
    return { out: A.out ? vNow * mw / (vOld * e.out * p.mw) - 1 : 0, cheaper: A.vc ? 1 - vOld / (vNow * e.vc) : 0, vc: e.vc - 1, up: e.up - 1, brk: e.brk - 1 };
  }
  // The new plant is built alongside on the same site (its room is the old plant's); the old one keeps
  // running until the new one connects, then it's knocked down (see step). Salvage is paid now.
  function rebuild(S, p, opts = {}) {
    const mw = opts.mw ?? p.mw;
    if (mw !== p.mw && mw !== repowerMW(S, p)) return { ok: false, why: 'size' };
    const c = rebuildCost(S, p, mw);
    if (!c || !['online', 'outage'].includes(p.status) || p.replacedBy) return { ok: false, why: 'unavailable' };
    if (S.cash < c.net) return { ok: false, why: 'cash' };
    const keep = { name: p.name, bid: p.bid, bands: p.bands && JSON.parse(JSON.stringify(p.bands)), strategy: p.strategy, stratSet: p.stratSet, sbands: p.sbands && JSON.parse(JSON.stringify(p.sbands)), fcasRaise: p.fcasRaise, fcasLower: p.fcasLower, cis: p.cis, upg: p.upg };   // built to today's spec: its upgrade comes with it
    const at = S.plants.indexOf(p);
    S.plants.splice(at, 1);   // out of the way while the new one takes its room
    S.cash += c.salvage + c.conn;   // build() charges the full price: take off the salvage and the reused connection
    const r = build(S, p.tech, mw, { site: p.site, mwh: p.mwh, land: p.land ?? p.mw });
    S.plants.splice(at, 0, p);
    if (!r.ok) { S.cash -= c.salvage + c.conn; return r; }
    S.news.shift();   // not "construction has started"
    for (const [k, v] of Object.entries(keep)) if (v !== undefined) r.plant[k] = v;
    if (mw > p.mw && r.plant.bands) r.plant.bands.mw = r.plant.bands.mw.map(v => Math.round(v * mw / p.mw * 10) / 10);   // its own bids, over the bigger size
    Object.assign(r.plant, { value: c.price - c.conn, capital: c.price - c.conn, rebuilt: (p.rebuilt || 0) + 1, replaces: p.id, salvage: c.salvage, rkey: p.rkey ?? p.id });
    p.replacedBy = r.plant.id; p.value = 0;   // its salvage is paid: it no longer counts in the company's value
    S.plants.splice(S.plants.indexOf(r.plant), 1); S.plants.splice(at + 1, 0, r.plant);   // next to the old one
    addNews(S, 'info', mw > p.mw ? `Repowering ${p.name}: ${fmtMW(p.mw)} → ${fmtMW(mw)} on the same land, ${fmtMoney(c.net)} after ${fmtMoney(c.salvage)} for the old plant and its reused connection. The old one keeps running until the new one connects in ${c.days} day${c.days === 1 ? '' : 's'}.` : `Rebuilding ${p.name}: ${fmtMoney(c.net)} after ${fmtMoney(c.salvage)} for the old plant and its reused connection. The old one keeps running until the new one connects in ${c.days} day${c.days === 1 ? '' : 's'}.`);
    return { ok: true, plant: r.plant, cost: c.net };
  }
  // What a change in wear is worth a day at the plant's recent earnings (margin and energy averaged
  // over the last week or so): more output, cheaper running, fewer breakdowns, cheaper upkeep.
  // o.vint: today's design against the plant's (a rebuild); o.mw: the size it would be (a repower).
  function wearGain(S, p, now, after, o = {}) {
    const T = TECH[p.tech], margin = Math.max(0, p.margin || 0), A = AGEING[p.tech], K = GAIN_K, vint = o.vint || 1, mw = o.mw || p.mw, size = 1 + (mw / p.mw - 1) * K.size;
    let g = 0;
    if (A.out) {   // more output: less what the zone's line would curtail, and less what it takes off your other plants' price
      const L = p.life || {}, cut = (L.curtailed || 0) / Math.max(1, (L.energy || 0) + (L.curtailed || 0));
      const share = S.days.slice(-7).reduce((a, d) => a + (d.share || 0), 0) / Math.max(1, Math.min(7, S.days.length));
      // (better turbines and panels help in light wind and sun, not when the plant is already at its rating)
      const vr = 1 + (vint - 1) * K.vint;
      g += margin * (after.out * vr * size / now.out - 1) * (1 - cut) * (1 - share) * K.out;
    }
    if (A.vc) g += (p.eDay || 0) * T.vc * S.fuelMult * (p.upg && p.tech === 'ccgt' ? 0.88 : 1) * (now.vc - after.vc / vint) / (p.vintage || 1) * K.vc;
    if (A.brk && T.outage) g += (now.brk - after.brk) * T.outage * diff(S).outage * (p.mw * 150 * diff(S).upkeep + 2 * margin) * K.brk;
    const mwh = T.kind === 'storage' ? (p.mwh ?? p.mw * hoursOf(p)) : undefined;
    g += (upkeepFor(S, p.tech, p.mw, mwh) * now.up - upkeepFor(S, p.tech, mw, mwh) * after.up) * K.up;
    return g;
  }
  const effectsAt = (A, wear, age) => { const w = wear + 2 * Math.max(0, age - A.life); return { out: Math.max(0.5, 1 - (A.out || 0) * w), vc: 1 + (A.vc || 0) * w, up: 1 + (A.up || 0) * w, brk: 1 + (A.brk || 0) * w }; };
  // An overhaul and a rebuild, side by side: cost, the earnings lost while it's offline, a day's gain
  // at recent earnings, and days to pay back both (null without enough history, or if it never would).
  function maintenancePlan(S, p) {
    const A = AGEING[p.tech]; if (!A) return null;
    const now = ageEffects(p), known = p.margin != null, margin = Math.max(0, p.margin || 0), out = {};
    // payback: the days before the gain starts (offline, or building alongside), then cost and lost earnings over the gain
    const pay = (cost, days, gain, delay = days) => ({ cost, lost: known ? days * margin : null, gain: known ? gain : null, payback: known && gain > 0 ? delay + (cost + days * margin) / gain : null, days, delay });
    const oc = overhaulCost(S, p);
    if (oc != null && (p.wear || 0) >= 1) out.overhaul = pay(oc, A.ohDays, wearGain(S, p, now, effectsAt(A, (p.wear || 0) * OVERHAUL_KEEPS, p.age || 0)));
    const rc = rebuildCost(S, p);
    const vint = vintageNow(S, p.tech) / (p.vintage || 1);
    if (rc && !p.replacedBy) out.rebuild = pay(rc.net, 0, wearGain(S, p, now, effectsAt(A, 0, 0), { vint }), rc.days);
    const rm = repowerMW(S, p), rp = rm && rebuildCost(S, p, rm);
    if (rp && !p.replacedBy) out.repower = { ...pay(rp.net, 0, wearGain(S, p, now, effectsAt(A, 0, 0), { vint, mw: rm }), rp.days), mw: rm };
    return out;
  }
  // Refurbishing worn storage: new cells for about half of today's cost of that much storage.
  function refurbishCost(S, p) {
    const T = TECH[p.tech];
    return Math.round(T.capexMWh * (p.mwh ?? p.mw * hoursOf(p)) * 0.5 * S.costMult[p.tech] * diff(S).capex / 100) * 100;
  }
  function refurbish(S, p) {
    if (!TECH[p.tech].fade || (p.health ?? 1) > 0.95 || !running(p)) return { ok: false, why: 'unavailable' };
    const cost = refurbishCost(S, p);
    if (S.cash < cost) return { ok: false, why: 'cash' };
    S.cash -= cost; p.value += cost; p.capital += cost; p.health = 1; if (p.wear) p.wear = Math.round(p.wear * OVERHAUL_KEEPS * 10) / 10;
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
  // Cap:  you're paid a premium every day and pay (spot − strike) × MW whenever spot is above the
  //       strike. Each release has a $300 cap and one at $150 or $1,000 (in turn): the lower the
  //       strike, the bigger the premium and the more often it pays out.
  const CONTRACT_DAYS = 7;
  const CAP_STRIKES = [150, 300, 1000];
  const CAP_START = { 150: 60, 300: 25, 1000: 6 }, CAP_MARGIN = { 150: 5, 300: 3, 1000: 1.5 };   // $/MW/day before there's history; the seller's margin
  // $/MW/day a cap at this strike would have paid out lately (older day records only have the $300 one)
  function capRiskOf(last, k) {
    const v = last.map(d => d.capPays ? d.capPays[k] : k === 300 ? d.capPay : null).filter(x => x != null);
    return v.length ? v.reduce((a, b) => a + (b || 0), 0) / v.length : CAP_START[k];
  }
  function contractRoom(S) {
    const owned = S.plants.reduce((a, p) => a + (p.status === 'building' ? 0 : p.mw), 0);
    const used = S.contracts.reduce((a, k) => a + k.mw, 0);
    return Math.max(0, Math.round(Math.max(50, owned * 1.2) - used));
  }
  function makeContractOffers(S) {
    const last = S.days.slice(-14);
    const avg = last.length ? last.reduce((a, d) => a + d.avg, 0) / last.length : 105;
    const r = [rnd(S, P), rnd(S, P), rnd(S, P)];
    const size = v => Math.max(10, Math.round(v / 10) * 10);
    const owned = S.plants.reduce((a, p) => a + p.mw, 0);
    const firmMW = S.plants.reduce((a, p) => a + (TECH[p.tech].kind === 'thermal' || p.tech === 'hydro' ? p.mw : 0), 0);   // plant that can run through a spike
    S.contractOffers = [
      { type: 'swap', mw: size(Math.max(20, owned * 0.2)), strike: Math.round(avg * (0.92 + 0.16 * r[0])), days: CONTRACT_DAYS },
      { type: 'swap', mw: size(Math.max(30, owned * 0.4)), strike: Math.round(avg * (0.85 + 0.16 * r[1])), days: CONTRACT_DAYS },
    ];
    // the $300 cap, and one at $150 or $1,000 in turn (by release, so no extra random numbers)
    const capMW = size(Math.max(20, firmMW * 0.6, owned * 0.15)), alt = Math.floor(dayIndex(S) / 3) % 2 ? 1000 : 150;
    for (const [k, rr] of [[300, r[2]], [alt, 1 - r[2]]]) S.contractOffers.push({ type: 'cap', mw: capMW, strike: k, days: CONTRACT_DAYS, perMW: Math.round((capRiskOf(last, k) * (1 + 0.3 * rr) + CAP_MARGIN[k]) * 10) / 10 });
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
      : `You sold a ${o.mw} MW ${fmtPrice(o.strike)} cap for ${fmtMoney(o.premium)} a day. You pay out whenever the price goes above ${fmtPrice(o.strike)}.`);
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

  // "Tasman Power peaker", or "Tasman Power peaker 2" if that's taken
  function rivalName(S, dev, kind, self) {
    let name = `${dev} ${kind}`;
    for (let k = 2; S.rivals.some(x => x !== self && x.name === name); k++) name = `${dev} ${kind} ${k}`;
    return name;
  }
  function rivalInvestment(S) {
    const last = S.days.slice(-15);
    const avg = last.reduce((a, d) => a + d.avg, 0) / last.length;
    const D = diff(S);
    if (avg <= D.rivalAt) return;
    const n = (S.rivalBuilds = (S.rivalBuilds || 0) + 1);
    const mw = Math.round(Math.min(D.rivalMax, (avg - D.rivalAt) * 3 + 150) / 50) * 50;
    const battery = n % 2 === 0, dev = DEVELOPERS[(n - 1) % DEVELOPERS.length];
    const name = rivalName(S, dev, battery ? 'battery' : 'peaker');
    const r = battery
      ? { id: `rb${n}`, name, tech: 'battery', cap: mw, hours: 2, soc: mw }
      : { id: `rp${n}`, name, tech: 'peaker', cap: mw, bands: [[0.6, 320], [0.4, 520]], out: 0 };
    S.rivals.push(r);
    addNews(S, 'info', `Prices have averaged ${fmtPrice(avg)}/MWh lately, so ${dev} has built a ${fmtMW(mw)} ${battery ? 'battery' : 'gas peaker'}. Competition is coming.`);
  }

  function emissionsCheck(S) {
    const last = S.days.slice(-30);
    const energy = last.reduce((a, d) => a + d.energy, 0), emis = last.reduce((a, d) => a + d.emis, 0);
    if (energy < 1) return;
    const year = Math.floor(dayIndex(S) / 365);
    const target = S.emisTarget ?? Math.max(0.2, 0.7 - 0.08 * year);
    const intensity = emis / energy;
    if (intensity > target) {
      const over = emis - target * energy, pen = Math.round(over * ((scenarioOf(S) || {}).emisFine ?? 30) * diff(S).penalty);
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
      S.cash -= o.price; ownCoal(S, r, o.price);
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
    else { if (mw < T.range[0] || mw > T.range[1]) return 'size'; if ((opts.land ?? mw) > siteRoom(S, tech, site)) return 'room'; }
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
    if (vintageNow(S, tech) > 1) p.vintage = vintageNow(S, tech);
    if (opts.land != null && opts.land < mw) p.land = opts.land;
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

  // ---- every site full ----
  // The technologies you could build here (wind and solar farms, storage, gas; coal is only bought).
  const buildable = S => Object.keys(TECH).filter(t => !TECH[t].buyOnly && (!TECH[t].transition || S.transition));
  const roomFor = (S, t) => !!siteFor(S, t, TECH[t].range[0]);
  // True when no site has room for even the smallest plant of anything you've unlocked.
  function regionFull(S) { const open = buildable(S).filter(t => S.unlocked[t]); return open.length > 0 && open.every(t => !roomFor(S, t)); }
  // What to say then: what's left to unlock, when new sites open, and how to grow from here.
  function fullNote(S) {
    const year = yearOf(S) + 1, more = [];
    for (const t of buildable(S).filter(t => !S.unlocked[t] && roomFor(S, t))) {
      const g = GOALS.find(x => x.unlock === t), e = timelineOf(S).find(x => x.unlocks === t);
      if (g) more.push(`Unlock ${TECH[t].name.toLowerCase()} (${g.text[0].toLowerCase()}${g.text.slice(1)}) to build more.`);
      else if (S.transition && e) more.push(`${TECH[t].name} arrives in year ${e.year}.`);
    }
    const next = Math.min(...buildable(S).filter(t => S.unlocked[t]).flatMap(t => (SITES[t] || []).map(st => siteOpensIn(S, st))).filter(y => y != null && y > year));
    if (S.transition && isFinite(next)) more.push(`New sites open in year ${next}.`);
    // what's still possible without new room: upgrades (one per plant), and the rivals' coal units
    const canUp = S.plants.filter(p => UPGRADES[p.tech] && p.status !== 'retiring' && canUpgrade(p)).length;
    const coalLeft = !S.scenario && !S.challenge && S.rivals.some(x => x.tech === 'coal' && !x.gone && !x.closing && !x.sold && x.id !== 'bh1');
    const grow = [canUp ? `Upgrades need no site room: ${canUp} of your plants can still have one (open a plant to see it).` : 'Every plant has had its upgrade.'];
    if (coalLeft) grow.push('The rivals’ coal units may still be offered to you, and they need no site room either.');
    const canRepower = S.plants.filter(p => p.status === 'online' && !p.replacedBy && repowerMW(S, p)).length;
    if (canRepower) grow.push(`Repowering needs no site room: ${canRepower} of your farms ${canRepower === 1 ? 'is' : 'are'} old enough to come back bigger on the same land (open one to see).`);
    return `Every site in the region is full${more.length ? ' for the plants you can build' : ''}. ${[...more, ...grow].join(' ')} From here, your bids and contracts are what earn more.`;
  }

  // ---- career awards and records: recognition, not money ----
  // Every 30 days the month's play is judged for awards. There's no prize: the late game earns
  // plenty already. S.month holds the month's tallies, S.records the company's bests (from the day
  // records began, R.since), S.awards the trophy shelf, S.awardsNew the latest month's winners.
  const careerOn = S => !S.scenario && !S.challenge;
  const freshMonth = () => ({ days: 0, profitDays: 0, hedged: 0, profit: 0, clean: 0, energy: 0, region: 0, n: 0, setN: 0, share: 0, kept: 0, missed: 0, top: null });
  const SURF_PRICE = 5000, SURF_MW = 100;   // Spike surfer: this much sold into this price or more
  const pct = x => `${Math.round(x * 100)}%`;
  const AWARDS = [
    { id: 'steady', name: 'Steady hand', how: 'Make a profit every day for a month, with contracts in place on at least 20 days.', test: M => M.days >= 20 && M.profitDays === M.days && M.hedged >= 20, detail: M => `a profit on all ${M.days} days, hedged on ${M.hedged}` },
    { id: 'clean', name: 'Clean generator', how: 'Supply 5% of the region from your clean plant over a month.', test: M => M.region > 0 && M.clean / M.region >= 0.05, detail: M => `${(M.clean / M.region * 100).toFixed(1)}% of the region from your clean plant` },
    { id: 'maker', name: 'Market maker', how: 'Set the price in 15% of a month’s five-minute intervals.', test: M => M.n > 0 && M.setN / M.n >= 0.15, detail: M => `your offers set the price ${pct(M.setN / M.n)} of the time` },
    { id: 'spike', name: 'Spike surfer', how: `Sell ${SURF_MW} MW or more into a price of ${fmtPrice(SURF_PRICE)}/MWh or more.`, test: M => !!M.top && M.top.price >= SURF_PRICE, detail: M => `${fmtMW(M.top.mw)} sold at ${fmtPrice(M.top.price)}/MWh on day ${M.top.day + 1} at ${clock(M.top.h)}` },
    { id: 'reliable', name: 'Reliable', how: 'Keep every reserve promise in a month (at least one).', test: M => M.kept > 0 && M.missed === 0, detail: M => `${M.kept} reserve promise${M.kept === 1 ? '' : 's'} kept` },
    { id: 'heavy', name: 'Heavyweight', how: 'Supply 20% of the region on average for a month.', test: M => M.days > 0 && M.share / M.days >= 0.2, detail: M => `${pct(M.share / M.days)} of the region on average` },
  ];
  function tallyDay(S, rec) {
    const M = (S.month ||= freshMonth()), R = (S.records ||= {});
    R.since ??= rec.day;
    M.days++; if (rec.profit > 0) M.profitDays++;
    M.profit += rec.profit; M.clean += rec.clean || 0; M.energy += rec.energy || 0; M.region += rec.region || 0; M.share += rec.share || 0;
    if (S.contracts.some(k => !k.retail)) M.hedged++;
    const best = (k, v) => { if (v != null && (!R[k] || v > R[k].v)) R[k] = { v, day: rec.day }; };
    best('day', rec.profit); best('share', rec.share); best('value', companyValue(S));
    best('mw', S.plants.reduce((a, p) => a + (p.status === 'building' ? 0 : p.mw), 0));
    R.streakNow = rec.profit > 0 ? (R.streakNow || 0) + 1 : 0; best('streak', R.streakNow);
  }
  function judgeAwards(S) {
    const M = S.month || freshMonth(), month = Math.round(dayIndex(S) / 30), R = (S.records ||= {});
    S.awards ||= {};
    if (M.days && (!R.month || M.profit > R.month.v)) R.month = { v: M.profit, month };
    const won = AWARDS.filter(a => a.test(M));
    for (const a of won) { const w = (S.awards[a.id] ||= { count: 0 }); w.count++; w.last = month; w.detail = a.detail(M); }
    if (won.length) {
      S.awardsNew = { month, ids: won.map(a => a.id), seen: false };
      addNews(S, 'good', `Month ${month} awards: ${listText(won.map(a => `${a.name} (${a.detail(M)})`))}.`);
    }
    S.month = freshMonth();
    return won;
  }

  // ---- stars made of several parts, and the parts for objectives beyond money ----
  const allOf = (text, ...parts) => [text, r => parts.every(p => p(r).ok), r => parts.map(p => p(r))];
  const fmtT = t => t >= 10000 ? `${Math.round(t / 1000).toLocaleString()}k t` : `${Math.round(t).toLocaleString()} t`;
  const emisPart = max => r => ({ label: 'Your emissions', ok: r.emis <= max, detail: `${fmtT(r.emis)} of the ${fmtT(max)} allowed` });
  const cleanAllPart = share => r => ({ label: 'Clean share of your output', ok: r.ownCleanAll >= share, detail: `${pct(r.ownCleanAll)} (needs ${pct(share)})` });
  const gainPart = v => r => ({ label: 'Growth', ok: r.gain >= v, detail: `${fmtMoney(r.gain)} (needs ${fmtMoney(v)})` });
  const sharePart = need => r => ({ label: 'Your best day', ok: r.maxShare >= need, detail: `${(r.maxShare * 100).toFixed(1)}% of the region (needs ${pct(need)})` });
  const weekSharePart = need => r => ({ label: 'The last week', ok: r.weekShare >= need, detail: `${(r.weekShare * 100).toFixed(1)}% of the region on average (needs ${pct(need)})` });
  const keptPart = n => r => ({ label: 'Reserve promises kept', ok: r.kept >= n, detail: `${r.kept} (needs ${n})` });
  const missedPart = r => ({ label: 'Promises missed', ok: r.missed === 0, detail: r.missed ? `${r.missed} missed` : 'None' });

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
  // Keeping the lights on: the hours short allowed in the final year for one, two and three stars.
  const LIGHTS_HOURS = [48, 12, 0];
  const lit = (r, i) => (r.finalShedHours || 0) <= LIGHTS_HOURS[i] + 1e-9;
  // A star with a lights-on limit (i: 0, 1 or 2 for one, two or three stars) and other parts, each a
  // function of the result giving { label, ok, detail }. All must be met; the end screen lists them.
  const lightsStar = (i, text, ...parts) => [text, r => lit(r, i) && parts.every(p => p(r).ok), r => [lightsPart(r, i), ...parts.map(p => p(r))]];   // like allOf, with the lights first
  const lightsText = i => LIGHTS_HOURS[i] ? `no more than ${LIGHTS_HOURS[i]} hours short` : 'no shortfall at all';
  function lightsPart(r, i) {
    const h = r.finalShedHours || 0, max = LIGHTS_HOURS[i];
    return { label: max ? `Lights on (up to ${max} h short)` : 'Lights on (no shortfall)', ok: lit(r, i),
      detail: h > 0 ? `${h.toFixed(1)} hours short in year ${r.finalYear}` : `No shortfall in year ${r.finalYear}` };
  }
  const tunnelPart = r => ({ label: 'Tunnel Two running', ok: r.tunnelOn, detail: r.tunnelOn ? 'Generating' : 'Still being built' });
  const firmPart = r => ({ label: 'Your firm plant', ok: r.ownFirm >= r.firm, detail: `${fmtMW(r.ownFirm)} of the ${fmtMW(r.firm)} needed (gas, coal, hydro and storage you own)` });
  const valuePart = v => r => { const t = v ?? r.target; return { label: 'Company value', ok: r.value >= t, detail: `${fmtMoney(r.value)} (needs ${t >= 1e9 ? `$${+(t / 1e9).toFixed(2)}B` : t >= 1e6 ? `$${+(t / 1e6).toFixed(2)}M` : fmtMoney(t)})` }; };
  const cleanPart = (share, region) => r => { const x = region ? r.cleanShare : r.ownClean;
    return { label: region ? 'Clean share of the region' : 'Clean share of your output', ok: x >= share, detail: `${Math.round(x * 100)}% (needs ${Math.round(share * 100)}%)` }; };
  const profitPart = r => ({ label: 'A profit every year', ok: r.minYearProfit > 0, detail: `Worst year ${fmtMoney(r.minYearProfit)}` });
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
      stars: [lightsStar(0, `Keep the lights on in year 20: ${lightsText(0)}`), lightsStar(1, `…and ${lightsText(1)}, and supply 30% of the region from clean plant`, cleanPart(0.3, true)),
        lightsStar(2, `…and ${lightsText(2)}, and grow the company to {target}`, valuePart())] },
    { id: 'big-build', name: 'The Big Build', days: 45, startDoy: 304, seed: 6606, cash: 3000000,
      blurb: '$3M, every technology but coal, and six weeks over summer. Build an empire.',
      unlock: ['wind', 'ccgt', 'hydro'],
      stars: [['Grow the company to $5.5M', r => r.value >= 5500000], ['Grow it to $7M', r => r.value >= 7000000], ['Grow it to $8.5M', r => r.value >= 8500000]] },
    // ---- judged on more than money ----
    { id: 'clean-up', name: 'Clean Up', days: 30, startDoy: 75, seed: 7707, cash: 3000000, owns: [['bh3'], ['bh4']], unlock: ['wind'], watch: 'emis', emisCap: 500000,
      blurb: 'You own Black Hill 3 and 4, 1,320 MW of coal, and the regulator has capped your emissions at 500k t for the month. Clean up without giving up the profits.',
      stars: [allOf('Keep your emissions under 500k t', emisPart(500000)), allOf('…and make 40% of your output clean', cleanAllPart(0.4)), allOf('…and grow the company by $35M', gainPart(35e6))] },
    { id: 'big-fish', name: 'Big Fish', days: 21, startDoy: 130, seed: 8808, cash: 30000000, unlock: ['wind', 'ccgt'], watch: 'share', shareNeeds: [0.05, 0.1, 0.1],
      blurb: '$30M, a quiet autumn market and three weeks. How much of the region can you supply?',
      stars: [allOf('Supply 5% of the region in one day', sharePart(0.05)), allOf('…supply 10% in one day', sharePart(0.1)), allOf('…and average 10% over the last week', weekSharePart(0.1))] },
    { id: 'reserve-duty', name: 'Reserve Duty', days: 21, startDoy: 20, seed: 9909, cash: 1500000, calm: true, plants: [["peaker",150],["peaker",50],["peaker",50]], watch: 'reserve',
      script: [{"day":3,"key":"heatwave","len":2},{"day":8,"key":"heatwave","len":2},{"day":13,"key":"heatwave","len":2},{"day":18,"key":"heatwave","len":2}],
      blurb: 'Four heatwaves in three weeks. Before each, the operator asks you to promise 80% of your firm plant for the evening peak. Gas peakers count while they run; a battery only counts with two hours of charge in hand, so one that sells into the peak eats into your promise.',
      stars: [allOf('Keep a reserve promise', keptPart(1)), allOf('…keep all four, missing none', keptPart(4), missedPart), allOf('…and grow the company by $1.25M', gainPart(1250000))] },

    // ---- company scenarios: run a portfolio like a real NEM company's (the names are made up).
    // The plants come out of the rival fleet (`owns`), so the market is the same size as ever.
    // Each runs a few 60-day years on the Energy Transition's machinery with a timeline of its own.
    // `closes`: your plants that close at the start of a year (ref → year). `choices`: decisions the
    // timeline (or `choiceDays`) puts to you. `report`: the scenario's own lines in the year report.
    // `firm`: the MW of firm plant the first star asks you to own in the final year. Rivals propose
    // new plant when prices run high (rivalProposal).
    { id: 'highcountry', group: 'company', name: 'Highcountry Hydro', years: 5, yearDays: 60, startDoy: 0, seed: 7707, cash: 2000000, idle: true, transition: true,
      blurb: 'The mountain hydro company. Run the hydro and the gas peakers that back up the grid, and finish Tunnel Two, a giant pumped hydro scheme that is already late.',
      intro: 'You own the Snowgum hydro scheme and two fleets of gas peakers, the region’s backup. Tunnel Two (1,000 MW of pumped hydro) is half dug. Rivals’ coal closes around you.',
      owns: [['snw', { tech: 'hydro', site: 'snowy', name: 'Snowgum Hydro', age: 50 }], ['kur', { tech: 'peaker', site: 'port', name: 'Kurri Gas Turbines', age: 25 }], ['cst', { tech: 'peaker', site: 'gas-hub', name: 'Coastal Peakers', age: 15 }]],
      setup: S => {
        const p = givePlant(S, 'hydro', 1000, { site: 'tumut', name: 'Tunnel Two', tunnel: true });
        p.status = 'building'; p.buildLeft = p.buildDays = 2 * S.yearDays + 5;
      },
      unlock: ['wind', 'ccgt', 'hydro'], rivalPlan: { wind: 100, solar: 120, battery: 60 }, emis: [0.7, 0.5], emisFine: 120, firm: 2800,
      timeline: [
        { year: 1, text: 'Tunnel Two, 1,000 MW of pumped hydro under the mountains, is due to start generating early in year 3.' },
        { year: 2, text: 'Black Hill 1, a rival’s coal unit, closes (660 MW).', apply: S => closeRival(S, 'bh1'), close: 660 },
        { year: 2, text: 'The tunnel boring machine is stuck in soft rock. You decide how to free it.', apply: S => offerChoice(S, 'tbm'), close: true },
        { year: 3, text: 'More bad ground in the tailrace tunnel: finishing Tunnel Two costs another $12M, paid over 30 days.', apply: S => tunnelSetback(S, 0, 12e6), close: true },
        { year: 4, text: 'Black Hill 2 closes (660 MW).', apply: S => closeRival(S, 'bh2'), close: 660 },
        { year: 5, text: 'Black Hill 3 closes (660 MW). The final year.', apply: S => closeRival(S, 'bh3'), close: 660 },
      ],
      choices: {
        tbm: { title: 'Tunnel Two: the boring machine is stuck', deflt: 'wait',
          text: () => 'The machine is jammed in soft rock, deep under the range. Every month Tunnel Two is late is a month its 1,000 MW of firm power isn’t earning.',
          options: [
            { key: 'wait', label: 'Wait it out', detail: 'Dig it free slowly: $15M over the next 30 days, and Tunnel Two is a year late (generating early in year 4).', apply: S => tunnelSetback(S, S.yearDays, 15e6) },
            { key: 'rescue', label: 'Bring in a rescue machine', detail: '$35M over the next 30 days, and Tunnel Two is only 20 days late (generating in year 3).', apply: S => tunnelSetback(S, 20, 35e6) },
          ] },
      },
      report: (S, Y) => {
        const p = S.plants.find(x => x.tunnel), rows = [];
        if (p) rows.push(['Tunnel Two', p.status === 'building' ? `${Math.round(100 * (1 - p.buildLeft / p.buildDays))}% built, ${Math.ceil(p.buildLeft)} days to go` : 'Generating', p.status === 'building' ? '' : 'up']);
        if (Y.overruns) rows.push(['Tunnel Two overruns', fmtMoney(Y.overruns), 'down']);
        return rows;
      },
      stars: [lightsStar(0, `Keep the lights on in year 5 (${lightsText(0)}), with Tunnel Two running and {firm} of firm plant of your own (gas, coal, hydro or storage)`, tunnelPart, firmPart),
        lightsStar(1, `…and ${lightsText(1)}, and grow the company to $400M`, valuePart(400e6)), lightsStar(2, `…and ${lightsText(2)}, and grow it to $650M`, valuePart(650e6))] },
    { id: 'lakeside', group: 'company', name: 'Lakeside Power', years: 4, yearDays: 60, startDoy: 0, seed: 8808, cash: 1500000, idle: true, transition: true,
      blurb: 'The country’s biggest coal generator has promised to close it all. Shut Black Hill unit by unit, keep the lights on, and rebuild the company clean.',
      intro: 'You own all four Black Hill coal units (2,640 MW), the Ash Hill peaker and 400 MW of wind. Your coal closes on a fixed schedule: one unit at the start of each year from year 2.',
      owns: [['bh1'], ['bh2'], ['bh3'], ['bh4'], ['ash', { tech: 'peaker', site: 'gas-hub', name: 'Ash Hill Peaker', age: 20 }], ['rwind', { tech: 'wind', mw: 400, site: 'tablelands', name: 'Kestrel Ridge Wind', age: 12 }]],
      unlock: ['wind', 'ccgt', 'hydro'], rivalPlan: { wind: 100, solar: 120, battery: 60 }, emis: [0.9, 0.45], emisFine: 120, firm: 2940, sites: { 'bh-yard': 2, 'bh-ldes': 3 },
      closes: { bh1: 2, bh2: 3, bh3: 4 },
      timeline: [
        { year: 1, text: 'You’ve promised to close Black Hill: unit 1 at the start of year 2, unit 2 in year 3, unit 3 in year 4. Unit 4 runs to the end. The emissions target tightens every year, and your coal is getting old.' },
        { year: 2, text: 'Black Hill 1 closes (660 MW of your coal). Its switchyard is free for new batteries.', close: 660 },
        { year: 3, text: 'Black Hill 2 closes (660 MW). Long-duration storage can be built, on the old ash dam. The government asks about Black Hill 4.', apply: S => { S.unlocked.ldes = true; offerChoice(S, 'early'); }, close: 660, unlocks: 'ldes' },
        { year: 4, text: 'Black Hill 3 closes (660 MW), and the emissions target is at its tightest.', close: 660 },
      ],
      choices: {
        early: { title: 'Close Black Hill 4 early?', deflt: 'keep',
          text: () => 'The government will pay you $60M now if Black Hill 4 closes with unit 3 at the start of year 4, a year early. You’d lose its output in the final year, and its emissions.',
          options: [
            { key: 'close', label: 'Take $60M and close it early', detail: 'Black Hill 4 closes at the start of year 4 with unit 3.', apply: S => { (S.closeAt ||= {}).bh4 = 4; S.cash += 60e6; S.today.bonus += 60e6; } },
            { key: 'keep', label: 'Run it to the end', detail: 'Black Hill 4 keeps running through year 4.', apply: () => {} },
          ] },
      },
      report: (S, Y) => {
        const coal = S.plants.filter(p => p.tech === 'coal').length;
        return [['Coal units left', `${coal} of 4`, '']];
      },
      stars: [lightsStar(0, `Keep the lights on in year 4 (${lightsText(0)}), with {firm} of firm plant of your own (gas, coal, hydro or storage)`, firmPart),
        lightsStar(1, `…and ${lightsText(1)}, and make 40% of your own output clean`, cleanPart(0.4)), lightsStar(2, `…and ${lightsText(2)}, and grow the company to $1.15B`, valuePart(1.15e9))] },
    { id: 'wellspring', group: 'company', name: 'Wellspring Energy', years: 4, yearDays: 60, startDoy: 0, seed: 9909, cash: 1500000, idle: true, transition: true,
      blurb: 'Gas and the region’s last big coal station. The government wants the coal kept open; every winter the gas gets dear.',
      intro: 'You own Black Hill 3 and 4 (1,320 MW of coal), the Tallawang combined-cycle plant and the Mulga Creek peaker. The coal is due to close at the start of year 3, and gas runs short every winter.',
      owns: [['bh3'], ['bh4'], ['tal', { tech: 'ccgt', site: 'gas-hub', name: 'Tallawang Gas', age: 12 }], ['mul', { tech: 'peaker', site: 'port', name: 'Mulga Creek Peaker', age: 22 }]],
      unlock: ['wind', 'ccgt', 'hydro'], rivalPlan: { wind: 100, solar: 120, battery: 60 }, emis: [0.85, 0.55], emisFine: 120, firm: 2800, sites: { 'bh-yard': 2 },
      closes: { bh3: 3, bh4: 3 },
      script: winters(4, 28, [['gascrunch', 5], ['cold', 3, 3]]),
      timeline: [
        { year: 1, text: 'Black Hill 3 and 4 are due to close at the start of year 3. Gas runs short every winter.' },
        { year: 2, text: 'The government fears a shortfall when your coal goes, and offers you a deal. The coal switchyard opens for batteries.', apply: S => offerChoice(S, 'deal') },
        { year: 3, text: 'Black Hill 1, a rival’s unit, closes (660 MW).', apply: S => closeRival(S, 'bh1'), close: 660 },
        { year: 4, text: 'Black Hill 2 closes (660 MW). The final year.', apply: S => closeRival(S, 'bh2'), close: 660 },
      ],
      choices: {
        deal: { title: 'The government’s deal', deflt: 'deal',
          text: () => 'Keep Black Hill 3 and 4 open to the end of year 4 and be paid for every day a unit is available, or close them at the start of year 3 as planned and take a clean-energy grant instead.',
          options: [
            { key: 'deal', label: 'Keep the coal open', detail: '$500k a day for each unit that’s running (not broken down). Black Hill 3 and 4 run to the end of year 4.', apply: S => { S.closeAt ||= {}; delete S.closeAt.bh3; delete S.closeAt.bh4; S.keepOpen = { refs: ['bh3', 'bh4'], perDay: 500000 }; } },
            { key: 'close', label: 'Close on schedule, take the grant', detail: 'The coal closes at the start of year 3. New wind, solar, batteries and pumped hydro cost 30% less to the end.', apply: S => { for (const t of ['wind', 'solar', 'battery', 'hydro', 'ldes']) S.costMult[t] *= 0.7; S.grant = true; } },
          ] },
      },
      report: (S, Y) => {
        const rows = [['Coal units left', `${S.plants.filter(p => p.tech === 'coal').length} of 2`, '']];
        if (Y.keepPay) rows.push(['Government payments', fmtMoney(Y.keepPay), 'up']);
        if (S.grant) rows.push(['Clean-energy grant', 'New wind, solar and storage 30% cheaper', 'up']);
        return rows;
      },
      stars: [lightsStar(0, `Keep the lights on in year 4 (${lightsText(0)}), with {firm} of firm plant of your own (gas, coal, hydro or storage)`, firmPart),
        lightsStar(1, `…and ${lightsText(1)}, and grow the company to $800M`, valuePart(800e6)), lightsStar(2, `…and ${lightsText(2)}, and grow it to $1.4B`, valuePart(1.4e9))] },
    { id: 'coastline', group: 'company', name: 'Coastline Energy', years: 4, yearDays: 60, startDoy: 152, seed: 1212, cash: 1500000, idle: true, transition: true,
      blurb: 'A million customers to supply. You’ve sold 800 MW around the clock at a fixed price, and you set next year’s price. Stay able to supply them through cold, dear winters and a coal closure.',
      intro: 'You own Black Hill 2 (660 MW of coal, closing at the start of year 3), the Wollemi combined-cycle plant and the Mulga Creek peaker, and you supply your retail customers: 800 MW around the clock at a fixed price. Before each renewal you set the price: dearer keeps fewer customers.',
      owns: [['bh2'], ['wol', { tech: 'ccgt', site: 'gas-hub', name: 'Wollemi Gas', age: 18 }], ['mul', { tech: 'peaker', site: 'port', name: 'Mulga Creek Peaker', age: 22 }]],
      unlock: ['wind', 'ccgt', 'hydro'], rivalPlan: { wind: 100, solar: 120, battery: 60 }, emis: [0.8, 0.5], emisFine: 120, firm: 1510,
      closes: { bh2: 3 },
      script: winters(4, 3, [['cold', 3], ['gascrunch', 4, 2], ['still', 4, 8]]),
      choiceDays: [[50, 'price'], [110, 'price'], [170, 'price']],
      timeline: [
        { year: 1, text: 'Your customers buy 800 MW around the clock from you this year at a fixed price. Whenever the market is dearer, you pay the difference.', apply: S => retailBook(S) },
        { year: 2, text: 'Your customers renew on the price you set.', apply: S => retailBook(S) },
        { year: 3, text: 'Black Hill 2 closes (660 MW of your coal). Your customers renew again.', apply: S => retailBook(S), close: 660 },
        { year: 4, text: 'Black Hill 1, a rival’s unit, closes (660 MW). Your customers renew for the final year.', apply: S => { closeRival(S, 'bh1'); retailBook(S); }, close: 660 },
      ],
      choices: {
        price: { title: 'Your customers renew in 10 days', deflt: 'usual',
          text: S => `Set next year’s price. This year’s market has averaged ${fmtPrice(yearAvg(S))}/MWh so far, and you supply ${fmtMW(S.retailMW || 800)}. Customers pay the market average plus your rise and a ${fmtPrice(RETAIL_MARGIN)} retail margin. A cheaper price wins customers; a dearer one loses them.`,
          options: [
            { key: 'low', label: 'Hold the price', detail: S => `About ${fmtPrice(retailStrike(yearAvg(S), 'low'))}/MWh: customers join, about ${fmtMW(retailSize(S, 'low'))}.`, apply: S => { S.retailPlan = 'low'; } },
            { key: 'usual', label: 'The usual rise (+5%)', detail: S => `About ${fmtPrice(retailStrike(yearAvg(S), 'usual'))}/MWh: you keep about ${fmtMW(retailSize(S, 'usual'))}.`, apply: S => { S.retailPlan = 'usual'; } },
            { key: 'high', label: 'Raise it (+15%)', detail: S => `About ${fmtPrice(retailStrike(yearAvg(S), 'high'))}/MWh: some leave, about ${fmtMW(retailSize(S, 'high'))} stay.`, apply: S => { S.retailPlan = 'high'; } },
          ] },
      },
      report: (S, Y) => [['Your customers', `${fmtMoney(Y.retail || 0)} against the market`, (Y.retail || 0) >= 0 ? 'up' : 'down'], ['Supplying next year', `${fmtMW(S.retailMW || 800)} at ${fmtPrice((S.contracts.find(k => k.retail) || {}).strike || 0)}/MWh`, '']],
      stars: [lightsStar(0, `Keep the lights on in year 4 (${lightsText(0)}), with {firm} of firm plant of your own (gas, coal, hydro or storage)`, firmPart),
        lightsStar(1, `…and ${lightsText(1)}, make a profit every year and grow the company to $450M`, profitPart, valuePart(450e6)), lightsStar(2, `…and ${lightsText(2)}, and grow it to $700M`, valuePart(700e6))] },
  ];
  // The parts of a compound star, shown under it so you can see which one failed.
  // Winter events for each year of a company scenario: [key, length, days after the first].
  function winters(years, at, list) {
    const out = [];
    for (let y = 0; y < years; y++) for (const [key, len, off] of list) out.push({ day: y * 60 + at + (off || 0), key, len });
    return out;
  }
  const scenarioOf = S => S.scenario ? SCENARIOS.find(x => x.id === S.scenario.id) : null;
  const isCompany = S => (scenarioOf(S) || {}).group === 'company';
  // How many years a multi-year scenario runs, and its timeline of milestones.
  const yearsOf = S => (S.scenario && S.scenario.years) || TRANSITION_YEARS;
  const timelineOf = S => (scenarioOf(S) || {}).timeline || TRANSITION;
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
      // every plant ages a year (see AGEING), and wears a year (gas and storage: more or less with use,
      // yearWear); storage loses capacity too: at typical use batteries about 2.5% a year, long-duration
      // storage 1% (twice that past design life)
      S.hardUse = null;
      for (const p of S.plants) {
        if (p.status === 'building') continue;
        const yw = AGEING[p.tech] ? yearWear(S, p) : 0, s = useSoFar(S, p);
        if (AGEING[p.tech]) { p.age = (p.age || 0) + 1; p.wear = Math.round(((p.wear || 0) + yw) * 10) / 10; }
        if (s && AGEING[p.tech].start && yw >= 1.5 && (!S.hardUse || yw > S.hardUse.wear)) S.hardUse = { name: p.name, wear: Math.round(yw * 10) / 10, starts: s.starts, hours: Math.round(s.hours), trips: s.trips };
        if (p.use) p.use = freshUse(S);
        const f = TECH[p.tech].fade;
        if (!f) continue;
        const was = p.health ?? 1, past = (p.age || 0) > AGEING[p.tech].life;
        p.health = Math.max(0.5, Math.round((was - f * yw * (past ? 2 : 1)) * 1000) / 1000); p.soc = Math.min(p.soc, storeCap(p));
        if (was >= 0.8 && p.health < 0.8) addNews(S, 'bad', `${p.name} can now hold only ${Math.round(p.health * 100)}% of what it could when new. Refurbish it from its page.`);
      }
    }
    if (y > 1) ageingNews(S);
    const hu = S.hardUse;
    if (y > 1 && hu) addNews(S, 'info', `${hu.name} started ${hu.starts} time${hu.starts === 1 ? '' : 's'} and ran ${hu.hours} hours last year${hu.trips ? `, with ${hu.trips} trip${hu.trips === 1 ? '' : 's'}` : ''}: about ${hu.wear} years of wear in one. Gas wears with starts; "Peaks only" bids start it least.`);
    const N = yearsOf(S), TL = timelineOf(S), em = (scenarioOf(S) || {}).emis || [0.7, 0.05];
    S.emisTarget = Math.round((em[0] + (em[1] - em[0]) * (y - 1) / Math.max(1, N - 1)) * 100) / 100;
    for (const e of TL.filter(e => e.year === y)) { addNews(S, e.close ? 'bad' : 'info', `Year ${y}: ${e.text}`); if (e.apply) e.apply(S); }
    for (const [ref, at] of Object.entries(S.closeAt || {})) if (at === y) closeOwn(S, ref);   // your plants that close this year
    const next = TL.filter(e => e.year === y + 1);
    if (next.length) addNews(S, 'info', `Next year: ${next.map(e => e.text).join(' ')}`);
    // the year just ended, in review (shown as a pop-up), with what this year and next year bring
    const P = S.years && S.years[y - 2];
    if (y > 1 && y <= N && P) {
      S.yearReport = { ...P, year: y - 1, avgPrice: P.priceSum / Math.max(1, P.days), valueBefore: y > 2 && S.years[y - 3] ? S.years[y - 3].value : S.scenario.v0,
        now: TL.filter(e => e.year === y).map(e => ({ text: e.text, close: !!e.close })), next: next.map(e => e.text),
        tender: !!S.tender && S.tender.offeredAt === dayIndex(S), rows: reportRows(S, P), seen: false };
    }
  }
  // A company scenario's own lines in the year report: [label, value, tone] (tone 'up', 'down' or '').
  // Once a year: one line about your most worn plants (not one line per plant).
  function ageingNews(S) {
    const worn = S.plants.map(p => ({ p, c: condition(p) })).filter(x => x.c && x.c.worn && x.p.status !== 'building').sort((a, b) => b.c.wear / b.c.life - a.c.wear / a.c.life);
    if (!worn.length) return;
    const { p, c } = worn[0];
    addNews(S, 'info', `Ageing: ${p.name} is ${c.age} years old${c.past ? ', past its design life,' : ''} (${c.text}).${worn.length > 1 ? ` ${worn.length - 1} more of your plants ${worn.length > 2 ? 'are' : 'is'} worn.` : ''} Overhaul or rebuild from a plant's page.`);
  }
  function conditionRow(S) {
    const all = S.plants.map(p => ({ p, c: condition(p) })).filter(x => x.c && x.p.status !== 'building');
    const worn = all.filter(x => x.c.worn), past = all.filter(x => x.c.past);
    if (!worn.length) return null;
    const w = worn.sort((a, b) => b.c.wear / b.c.life - a.c.wear / a.c.life)[0];
    const hu = S.hardUse ? `; worked hardest: ${S.hardUse.name}, ${S.hardUse.wear} years of wear last year` : '';
    return ['Plant condition', `${worn.length} worn${past.length ? `, ${past.length} past design life` : ''} (most worn: ${w.p.name}, ${w.c.text}${hu})`, past.length ? 'down' : ''];
  }
  function reportRows(S, Y) {
    const sc = scenarioOf(S), rows = [], cond = conditionRow(S);
    if (cond) rows.push(cond);
    if (!sc || sc.group !== 'company') return rows;
    if (Y.energy > 0 && Y.emis != null) { const i = Y.emis / Y.energy; rows.push(['Emissions', `${i.toFixed(2)} t/MWh (target ${(Y.emisTarget ?? 0).toFixed(2)})`, i > (Y.emisTarget ?? 1) ? 'down' : 'up']); }
    if (sc.firm) rows.push(['Your firm plant', `${fmtMW(ownFirm(S))} (the first star needs ${fmtMW(sc.firm)})`, ownFirm(S) >= sc.firm ? 'up' : 'down']);
    if (Y.rivalBuilt || Y.rivalShelved) rows.push(['Rival projects', `${Y.rivalBuilt || 0} went ahead, ${Y.rivalShelved || 0} shelved`, '']);
    return rows.concat(sc.report ? sc.report(S, Y) : []);
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

  function givePlant(S, tech, mw, extra = {}) {
    const site = extra.site;
    S.cash += priceOf(S, tech, mw, site ? { site } : {});
    const p = build(S, tech, mw, site ? { site } : {}).plant;
    S.news.shift();   // not "construction has started"
    p.status = 'online'; p.buildLeft = 0; p.last = TECH[tech].kind === 'thermal' ? 0 : p.last;
    Object.assign(p, extra);
    return p;
  }
  // A company scenario's plants: a rival's plant becomes yours, so the market stays the same size.
  // Coal is bought as in the career's offers; anything else is rebuilt as your own plant of the
  // same size. A lumped rival (all the rival wind farms) just shrinks by the MW you take.
  function ownCoal(S, r, price) {
    r.gone = true; r.sold = true;
    const p = { id: `p${S.t}_${S.plants.length}`, tech: 'coal', mw: r.cap, name: r.name, ref: r.id, site: 'legacy', mlf: 1, res: 1, status: 'online', bid: 'cost', soc: 0, last: r.cap * 0.45, today: { energy: 0, money: 0 }, built: S.t, value: price, capital: price, life: freshLife() };
    freshBands(S, p);
    S.plants.push(p);
    return p;
  }
  function takeRival(S, id, o = {}) {
    const r = rival(S, id);
    if (!r || r.gone) return null;
    if (r.tech === 'coal') return ownCoal(S, r, Math.round(r.cap * 2400 / 1000) * 1000);
    const mw = o.mw ?? r.cap;
    if (mw < r.cap) r.cap -= mw; else r.gone = true;
    const tech = o.tech || r.tech, was = S.unlocked[tech];
    S.unlocked[tech] = true;
    const p = givePlant(S, tech, mw, { site: o.site, name: o.name || r.name, ref: r.id });
    S.unlocked[tech] = was;
    if (o.age) { p.age = o.age; p.wear = Math.round(o.age / 2); }   // old, and overhauled now and then
    return p;
  }
  // Your own coal closes on the scheduled day (the notice was given long ago).
  function closeOwn(S, ref) {
    const p = S.plants.find(x => x.ref === ref && x.status !== 'closed');
    if (!p) return;
    p.status = 'closed'; retireRecord(S, p, 0); S.plants = S.plants.filter(x => x !== p);
    addNews(S, 'info', `${p.name} has closed for good, as planned.`);
  }
  // When one of your plants is due to close: the year it closes at the start of, and days to go.
  function closesIn(S, p) {
    const at = S.closeAt && p.ref != null ? S.closeAt[p.ref] : null;
    return at == null ? null : { year: at, days: Math.max(0, (at - 1) * yearDaysOf(S) - dayIndex(S)) };
  }
  // Firm plant you own (gas, coal, hydro and storage), counting units under repair but not ones still being built.
  const ownFirm = S => S.plants.reduce((a, p) => a + (p.status !== 'building' && p.status !== 'closed' && (TECH[p.tech].kind === 'thermal' || TECH[p.tech].kind === 'storage') ? p.mw : 0), 0);
  // Tunnel Two's setbacks: a delay in days and a bill, paid over 30 days. The bill is capital
  // spending on the tunnel, not a running cost.
  function tunnelSetback(S, days, cost) {
    const p = S.plants.find(x => x.tunnel);
    if (!p) return;
    if (p.status === 'building') { p.buildLeft += days; p.buildDays += days; }
    (S.bills ||= []).push({ left: cost, perDay: cost / 30 });
  }
  function payBills(S, d) {
    if (!S.bills || !S.bills.length) return;
    const p = S.plants.find(x => x.tunnel);
    for (const b of S.bills) { const pay = Math.min(b.left, b.perDay); b.left -= pay; S.cash -= pay; d.overruns += pay; if (p) p.capital += pay; }
    S.bills = S.bills.filter(b => b.left > 0.5);
  }
  // Your retail customers: a year-long swap at the price you set (last year's average, plus a rise),
  // for as many customers as that price keeps.
  const RETAIL = { low: { markup: 1, keep: 1.15 }, usual: { markup: 1.05, keep: 1 }, high: { markup: 1.15, keep: 0.75 } };
  // Customers pay the wholesale-based price plus a retail margin on every MWh.
  const RETAIL_MARGIN = 15, retailStrike = (avg, plan) => Math.round(avg * RETAIL[plan].markup + RETAIL_MARGIN);
  const yearAvg = S => { const Y = S.years && S.years[yearOf(S)]; return Y && Y.days ? Y.priceSum / Y.days : 95; };
  const retailSize = (S, plan) => Math.round(Math.min(1200, Math.max(400, (S.retailMW || 800) * RETAIL[plan].keep)) / 10) * 10;
  function retailBook(S) {
    const plan = S.retailPlan || 'usual', P = S.years && S.years[yearOf(S) - 1];
    if (P) S.retailMW = retailSize(S, plan);
    const mw = S.retailMW || (S.retailMW = 800);
    const strike = retailStrike(P && P.days ? P.priceSum / P.days : 95, plan);
    S.contracts = S.contracts.filter(k => !k.retail);
    S.contracts.push({ type: 'swap', retail: true, mw, strike, days: yearDaysOf(S), until: S.t + yearDaysOf(S) * IPD, pnl: 0, signed: S.t });
    S.retailPlan = null;
  }
  // The government's payment for keeping coal open: so much a day for each unit that's available.
  function settleKeepOpen(S, d) {
    const K = S.keepOpen;
    if (!K) return;
    for (const p of S.plants) if (K.refs.includes(p.ref) && p.status === 'online') { S.cash += K.perDay; d.bonus += K.perDay; d.keepPay += K.perDay; }
  }

  // ---- decisions: a company scenario puts a choice to you; unanswered, the default applies ----
  // S.choice holds only its id and deadline (saves stay plain JSON); the words and effects live in
  // the scenario's `choices`.
  const CHOICE_DAYS = 10;
  const choiceDef = S => { const sc = scenarioOf(S), c = S.choice; return c && sc && sc.choices ? sc.choices[c.id] : null; };
  function offerChoice(S, id) {
    if (S.choice) choose(S, choiceDef(S).deflt, true);
    S.choice = { id, until: dayIndex(S) + CHOICE_DAYS, at: dayIndex(S) };
    addNews(S, 'info', `Decision waiting: ${scenarioOf(S).choices[id].title}. You have ${CHOICE_DAYS} days.`);
  }
  function offerScheduledChoice(S) {
    for (const [day, id] of (scenarioOf(S) || {}).choiceDays || []) if (dayIndex(S) === day) offerChoice(S, id);
  }
  // What the pop-up shows: the title, the text and each option's label and detail, worked out now.
  function choiceView(S) {
    const C = choiceDef(S);
    if (!C) return null;
    const val = v => typeof v === 'function' ? v(S) : v;
    return { id: S.choice.id, at: S.choice.at, title: C.title, text: val(C.text), deflt: C.deflt, daysLeft: S.choice.until - dayIndex(S),
      options: C.options.map(o => ({ key: o.key, label: o.label, detail: val(o.detail) })) };
  }
  function choose(S, key, timedOut) {
    const C = choiceDef(S);
    if (!C) return false;
    const o = C.options.find(x => x.key === key) || C.options.find(x => x.key === C.deflt);
    (S.chosen ||= {})[S.choice.id] = o.key;
    S.choice = null;
    o.apply(S);
    addNews(S, 'info', timedOut ? `No decision in time, so the default was taken: ${o.label.toLowerCase()}.` : `You decided: ${o.label.toLowerCase()}.`);
    return true;
  }
  function choiceTimeout(S) { if (S.choice && dayIndex(S) >= S.choice.until) choose(S, choiceDef(S).deflt, true); }

  // ---- rival proposals (company scenarios): when prices run high a rival announces a project,
  // decides 10 days later and builds only if prices stayed high, so you can build first to change its
  // mind, or buy the project. Built projects join the rival fleet after their build time.
  const DEVELOPERS = ['Tasman Power', 'Red Gum Energy', 'Southern Cross Renewables', 'Granite Peak Energy', 'Brolga Power', 'Saltbush Energy', 'Bight Energy', 'Boundary Gen'];
  const PROPOSAL_DAYS = 7, PROPOSAL_POPUP_MW = 300, PROPOSAL_PREMIUM = 1.25;
  // The average price each kind of project needs to pay its way (Standard; scaled by difficulty).
  const HURDLE = { wind: 100, ccgt: 120, battery: 130, peaker: 150 }, RIVAL_TECHS = ['ccgt', 'battery', 'wind', 'peaker'];
  function rivalProposal(S) {
    if (S.proposal) return;
    const last = S.days.slice(-15), k = diff(S).rivalAt / 140;   // tougher difficulties: rivals pounce sooner
    const avg = last.reduce((a, d) => a + d.avg, 0) / last.length, short = last.some(d => d.shed > 0);
    // gas, batteries, wind and peakers in turn; a shortfall brings a peaker forward
    const n = (S.rivalBuilds || 0) + 1;
    const tech = short && n % 2 === 0 ? 'peaker' : RIVAL_TECHS[(n - 1) % RIVAL_TECHS.length], T = TECH[tech];
    const hurdle = Math.round(HURDLE[tech] * k);
    if (avg <= hurdle && !short) return;
    S.rivalBuilds = n;
    const mw = Math.round(Math.min(T.range[1], 800, Math.max(0, avg - hurdle) * 4 + 200 + (short ? 300 : 0)) / 50) * 50;
    const site = siteFor(S, tech, mw);
    S.proposal = { n, dev: DEVELOPERS[(n - 1) % DEVELOPERS.length], tech, mw, hurdle, from: dayIndex(S), decideAt: dayIndex(S) + PROPOSAL_DAYS,
      buy: Math.round(priceOf(S, tech, mw, site ? { site } : {}) * PROPOSAL_PREMIUM / 1000) * 1000, big: mw >= PROPOSAL_POPUP_MW };
    addNews(S, 'info', `${S.proposal.dev} plans a ${fmtMW(mw)} ${T.name.toLowerCase()}. It decides in ${PROPOSAL_DAYS} days and builds if prices average ${fmtPrice(hurdle)}/MWh or more until then.`);
  }
  // Each day: decide an open proposal when its day comes, and connect rival projects that are finished.
  function rivalProjects(S) {
    const P = S.proposal, day = dayIndex(S);
    if (P && day >= P.decideAt) {
      const since = S.days.filter(d => d.day >= P.from), avg = since.reduce((a, d) => a + d.avg, 0) / Math.max(1, since.length);
      const what = `${fmtMW(P.mw)} ${TECH[P.tech].name.toLowerCase()}`;
      if (avg >= P.hurdle) {
        const days = Math.ceil(buildDays(P.tech, P.mw, siteFor(S, P.tech, P.mw) || undefined));
        (S.rivalPending ||= []).push({ ...P, online: day + days });
        S.today.rivalBuilt++;
        S.proposalResult = { dev: P.dev, tech: P.tech, mw: P.mw, hurdle: P.hurdle, avg, built: true, startsIn: days, big: P.big, seen: false };
        addNews(S, 'bad', `${P.dev} is going ahead: prices averaged ${fmtPrice(avg)}, above its ${fmtPrice(P.hurdle)} hurdle. Its ${what} starts in ${days} days.`);
      } else {
        S.today.rivalShelved++;
        S.proposalResult = { dev: P.dev, tech: P.tech, mw: P.mw, hurdle: P.hurdle, avg, built: false, big: P.big, seen: false };
        addNews(S, 'good', `${P.dev} has shelved its ${what}: prices averaged only ${fmtPrice(avg)}, below its ${fmtPrice(P.hurdle)} hurdle.`);
      }
      S.proposal = null;
    }
    for (const q of (S.rivalPending || []).filter(q => day >= q.online)) {
      const name = `${q.dev} ${{ peaker: 'peaker', ccgt: 'gas plant', battery: 'battery', wind: 'wind farm' }[q.tech]}`, id = `rv${q.n}`;
      S.rivals.push(q.tech === 'peaker' ? { id, name, tech: 'peaker', cap: q.mw, bands: [[0.6, 320], [0.4, 520]], out: 0 }
        : q.tech === 'ccgt' ? { id, name, tech: 'ccgt', cap: q.mw, bands: [[0.5, 92], [0.5, 128]], out: 0 }
        : q.tech === 'battery' ? { id, name, tech: 'battery', cap: q.mw, hours: 2, soc: q.mw }
        : { id, name, tech: 'wind', cap: q.mw, bid: -35 });
      addNews(S, 'info', `${name} (${fmtMW(q.mw)}) is now running. More competition.`);
    }
    if (S.rivalPending) S.rivalPending = S.rivalPending.filter(q => day < q.online);
  }
  // Buy the open proposal: it becomes your plant, built at the first site with room, for its price
  // plus the developer's premium. With opts.loan, borrow what you're short (secured on the plant).
  function buyProposal(S, opts = {}) {
    const P = S.proposal;
    if (!P) return { ok: false, why: 'gone' };
    const site = siteFor(S, P.tech, P.mw);
    if (!site) return { ok: false, why: 'room' };
    const price = Math.round(priceOf(S, P.tech, P.mw, { site }) * PROPOSAL_PREMIUM / 1000) * 1000;
    if (S.cash < price) {
      if (!opts.loan) return { ok: false, why: 'cash', price };
      if (!takeLoan(S, Math.ceil((price - S.cash) / 1000) * 1000, 90, price).ok) return { ok: false, why: 'cash', price };
    }
    const was = S.unlocked[P.tech];
    S.unlocked[P.tech] = true;
    const r = build(S, P.tech, P.mw, { site });
    S.unlocked[P.tech] = was;
    if (!r.ok) return r;
    const premium = price - r.plant.capital;
    S.cash -= premium; r.plant.capital += premium; r.plant.value += premium;
    S.news.shift();   // not "construction has started": say it this way
    addNews(S, 'good', `You bought ${P.dev}'s ${fmtMW(P.mw)} project for ${fmtMoney(price)}. ${r.plant.name} connects in ${r.plant.buildLeft} days.`);
    S.proposal = null;
    return { ok: true, plant: r.plant, price };
  }
  // What the proposal pop-up shows.
  function proposalView(S) {
    const P = S.proposal;
    if (!P) return null;
    const since = S.days.filter(d => d.day >= P.from), site = siteFor(S, P.tech, P.mw);
    return { ...P, daysLeft: P.decideAt - dayIndex(S), avgSoFar: since.length ? since.reduce((a, d) => a + d.avg, 0) / since.length : null,
      site: site ? siteOf(P.tech, site).name : null, price: site ? Math.round(priceOf(S, P.tech, P.mw, { site }) * PROPOSAL_PREMIUM / 1000) * 1000 : null };
  }
  // A scenario's length: the Energy Transition offers Standard (60-day years) or Long (90-day years).
  const lengthOf = (sc, key) => sc.lengths ? sc.lengths[key] || sc.lengths.standard : null;
  const fmtTarget = v => v >= 1e9 ? `$${+(v / 1e9).toFixed(1)}B` : fmtMoney(v);
  const starText = (sc, key) => sc.stars.map(([t]) => t.replace('{target}', fmtTarget((lengthOf(sc, key) || {}).target || 0)).replace('{firm}', fmtMW(sc.firm || 0)));
  function createScenario(id, opts = {}) {
    const sc = SCENARIOS.find(x => x.id === id), L = lengthOf(sc, opts.length);
    const S = create(sc.seed, { cash: sc.cash, startDoy: sc.startDoy });
    S.scenario = { id, days: sc.years ? sc.years * sc.yearDays : sc.days };
    if (sc.years) S.scenario.years = sc.years;
    if (L) Object.assign(S.scenario, { days: TRANSITION_YEARS * L.yearDays, length: sc.lengths[opts.length] ? opts.length : 'standard', target: L.target });
    S.script = sc.script || []; S.calm = !!sc.calm;
    if (sc.transition) {
      S.transition = true; S.yearDays = L ? L.yearDays : sc.yearDays; S.years = [];
      S.rooftopGrowth = Math.pow(1.0009, 60 / S.yearDays); S.rivalPlan = sc.rivalPlan || { wind: 120, solar: 150, battery: 80 };   // rooftop: about 5.5% a year
    }
    if (sc.rooftop) S.rooftop = sc.rooftop;
    for (const t of sc.unlock || []) S.unlocked[t] = true;
    for (const [t, mw, extra] of sc.plants || []) { const was = S.unlocked[t]; S.unlocked[t] = true; givePlant(S, t, mw, extra); S.unlocked[t] = was || (sc.unlock || []).includes(t); }
    for (const [rid, o] of sc.owns || []) takeRival(S, rid, o);
    if (sc.setup) sc.setup(S);
    if (sc.closes) S.closeAt = { ...sc.closes };
    for (const [rid, day] of Object.entries(sc.closures || {})) S.rivals.find(r => r.id === rid).closing = day;
    // no early goal bonuses in a scenario: it's scored on what you make of it
    for (const g of GOALS) S.goalsDone[g.id] = S.goalsDone[g.id] ?? -1;
    S.news = [];
    addNews(S, 'info', `${sc.name}: ${sc.intro || sc.blurb}`);
    if (sc.closures) for (const [rid, day] of Object.entries(sc.closures)) addNews(S, 'info', `${S.rivals.find(r => r.id === rid).name} closes for good on day ${day + 1}.`);
    if (S.transition) transitionYear(S);   // year 1: set the target, announce year 2
    S.upcoming = []; planEvents(S);   // plan tomorrow again, now the script is known
    S.scenario.v0 = companyValue(S);
    makeContractOffers(S);
    return S;
  }
  // What the stars are judged on. Multi-year scenarios judge their final year (Y).
  function resultOf(S, Y) {
    const sc = scenarioOf(S), full = (S.years || []).slice(0, yearsOf(S)).filter(Boolean);
    return { value: companyValue(S), gain: companyValue(S) - S.scenario.v0, target: S.scenario.target ?? (lengthOf(sc, 'standard') || {}).target,
      finalShed: Y.shed, finalRegion: Y.region, cleanShare: Y.clean / Math.max(1, Y.region), ownClean: Y.clean / Math.max(1, Y.energy || 0),
      minYearProfit: full.length ? Math.min(...full.map(y => y.profit)) : 0, tunnelOn: S.plants.some(p => p.tunnel && p.status !== 'building'),
      finalShedHours: Y.shedHours || 0, finalYear: Y.year ?? yearsOf(S),
      ownFirm: ownFirm(S), firm: sc.firm || 0, bust: !!S.bust };
  }
  function scenarioResult(S) {
    const sc = scenarioOf(S);
    const days = S.days.filter(d => d.day < S.scenario.days);
    // the final year comes from the year records: a long year has more days than S.days keeps
    const Y = (S.transition && S.years && S.years[yearsOf(S) - 1]) || { shed: 0, region: 0, clean: 0 };
    const week = days.slice(-7), energy = days.reduce((a, d) => a + (d.energy || 0), 0);
    const r = { ...resultOf(S, Y), profit: S.years ? S.years.reduce((a, Y) => a + Y.profit, 0) : days.reduce((a, d) => a + d.profit, 0),
      maxShare: days.reduce((m, d) => Math.max(m, d.share), 0), reserveKept: !!(S.goalFlags && S.goalFlags.reserveKept),
      emis: S.totals.emis, kept: (S.reserveTally || {}).kept || 0, missed: (S.reserveTally || {}).missed || 0,
      weekShare: week.length ? week.reduce((a, d) => a + d.share, 0) / week.length : 0, ownCleanAll: energy > 0 ? days.reduce((a, d) => a + (d.clean || 0), 0) / energy : 0 };
    return { ...r, ...scoreStars(S, sc, r) };
  }
  function scoreStars(S, sc, r) {
    let stars = 0;
    const texts = starText(sc, S.scenario.length);
    const lines = sc.stars.map(([, test, parts], i) => { const ok = !r.bust && test(r); if (ok && stars === i) stars++; return { text: texts[i], ok, parts: parts ? parts(r) : null }; });
    return { stars, lines };
  }
  // A multi-year scenario's stars as they would be if year Y were the final year.
  function starsIf(S, Y) { return scoreStars(S, scenarioOf(S), { ...resultOf(S, Y), bust: false }); }
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

  return { minMW, stackTarget, yearDays: yearDaysOf, LOAN_SECURED, debt, loanRoom, loanQuote, takeLoan, repayLoan, LOAN_TERMS, LOAN_LTV, starsIf, LIGHTS_HOURS, starText, rivalInvestment, regionFull, fullNote, spikeNews, SPIKE, AWARDS, judgeAwards, freshMonth, AGEING, ageEffects, condition, repowerMW, GAIN_K, wearGain, effectsAt, OVERHAUL_KEEPS, useSoFar, yearWear, USE_CALENDAR, overhaul, overhaulCost, rebuild, rebuildCost, rebuildGain, vintageNow, maintenancePlan, lineOf, storeCap, refurbish, refurbishCost, CAP_STRIKES, TRANSITION, TRANSITION_YEARS, yearsOf, timelineOf, scenarioOf, siteOpensIn, isCompany, closesIn, ownFirm, coalAge, choiceView, choose, proposalView, buyProposal, PROPOSAL_POPUP_MW, TENDER_KINDS, acceptTender, declineTender, yearOf, CERT, NB, presetMW, setBandPrice, setBandMW, fillBands, upkeepFor, SITES, siteOf, siteRoom, siteFor, buildDays, buildProblem, canUpgrade, IPD, H, FLOOR, CAP, APC, CPT, REAL_CPT, TECH, TECH_ORDER, OTHER, GOALS, EVENTS, AWAY_CAP_DAYS, DIFFICULTY, UPGRADES, CONTRACT_DAYS,
    create, migrate, step, catchUp, build, retire, acceptOffer, declineOffer, priceOf, companyValue, firmCapacity, conditions,
    upgrade, upgradeCost, upkeepOf, plantProfit, signContract, contractRoom, SCENARIOS, createScenario, scenarioResult, scenarioOver, MISSIONS, missionNext, checkMissions, completeMission, startTour, skipTour, overdraftLimit, forecast, hoursOf, vcOf,
    fmtMoney, fmtMW, fmtPrice, clock, dateLabel, dayIndex, hourOf, rnd };
})();
if (typeof module !== 'undefined') module.exports = Sim;
