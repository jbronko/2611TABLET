# Merit Order: notes for working on the game

An electricity market tycoon modelled on Australia's NEM. Read the root `CLAUDE.md` first (how apps
are built, tested and published); this file is what's specific to Merit Order. Current version: see
`VERSION` in `sw.js` (the title screen shows the same number).

## Modes
- **Career**: your company, three difficulties (Relaxed / Standard / Tough), a guided first week
  ("Getting started" missions), goals that unlock wind, combined-cycle gas and pumped hydro.
  - **Awards and records** (career only; `AWARDS`, `S.month`, `S.records`, `S.awards`):
    - Every 30 days the month is judged (`judgeAwards`):
      - Steady hand: a profit every day, hedged on at least 20
      - Clean generator: 5% of the region from your clean plant
      - Market maker: your offers set the price in 15% of intervals
      - Spike surfer: 100 MW or more sold into $5k+
      - Reliable: every reserve promise kept, at least one
      - Heavyweight: 20% of the region on average
    - The awards are recognition only; no money moves.
    - Winners get a news line and a toast. The menu's "Trophies and records" shows the shelf and
      the records:
      - best day and best month
      - the dearest price sold into
      - the biggest share of the region
      - the most plant running, and the highest value
      - the longest profitable streak
    - Old saves start records on update (`R.since`).
    - Tuned with the test players:
      - idle and peaker-only companies win nothing
      - a growing company wins its first awards around month 4, then several a month
- **Scenarios** (stars, cumulative, same seed for everyone): First Light, Heatwave Week, Black Hill
  Closes, Gas Squeeze Winter, Too Much Sun, The Big Build. Three are judged on more than money (v39):
  - **Clean Up:** two Black Hill coal units and an emissions cap.
  - **Big Fish:** $30M and market share; `shareNeeds`.
  - **Reserve Duty:** four heatwaves, each with a reserve promise to keep. The fleet is peakers only,
    because a battery that sells into the peak doesn't count as ready.
  - Each has a live goal chip (`watch`: emis, share or reserve). Tapping it shows the stars with
    their parts so far.
  - Their stars are built with `allOf(text, ...parts)` (`emisPart`, `cleanAllPart`, `gainPart`,
    `sharePart`, `weekSharePart`, `keptPart`, `missedPart`).
  - And the **Energy Transition**: 20 years,
  Standard (60-day years) or Long (90-day years), coal closing unit by unit, demand growth, offshore
  wind and long-duration storage arriving, Renewable Energy Zones with grid line limits, storage that
  wears out (refurbish), Capacity Investment Scheme underwriting rounds, a yearly report.
- **Company scenarios** (`group: 'company'`, listed under "Run a company"): a real company's
  portfolio under a made-up name, 4–5 years of 60 days on the same yearly machinery, each with a
  decision:
  - Highcountry Hydro (Snowy Hydro): hydro and peakers; Tunnel Two is stuck in year 2 (wait it out, or
    pay for a rescue machine). Overruns are paid over 30 days as capital.
  - Lakeside Power (AGL): all four Black Hill units close one a year; in year 3, take $60M to close
    unit 4 early.
  - Wellspring Energy (Origin): in year 2, keep the coal open for $500k a day per running unit, or
    close on schedule with a grant (new wind, solar and storage 30% cheaper). Gas squeezes each winter.
  - Coastline Energy (EnergyAustralia): a retail book (a year-long swap, `retail: true`), renewed
    each year at a price you set 10 days before (hold / +5% / +15%: customers join or leave), plus a
    $15/MWh retail margin.
- **What company scenarios add:**
  - Rivals propose plant when prices run high (`rivalProposal`, every 5 days; one open at a time).
    A proposal decides 7 days later and builds only if prices averaged above its hurdle: wind $100,
    gas $120, battery $130, peaker $150. A pop-up for 300 MW or more offers "Build to compete" and
    "Buy it" (cost + 25%).
  - Ageing coal: breakdowns ×(1 + 0.35 a year); from year 3, or in a unit's last year, one in five
    is major (6–12 days).
  - Emissions fines at `emisFine` ($120/t).
  - Year-report rows from `report(S, Y)` (plus common rows: emissions, rival projects, your firm
    plant against the first star).
  - **Keeping the lights on** (company scenarios and the Energy Transition): each star has its own
    limit on hours short in the final year, `LIGHTS_HOURS` = 48 h for ★, 12 h for ★★, none for ★★★
    (an interval counts as short for a shortfall of 1 MW or more). Build such stars with
    `lightsStar(i, text, ...parts)`: the lights part plus parts such as `firmPart`, `tunnelPart`,
    `valuePart(v)`, `cleanPart(share, region)`, `profitPart`; the star needs every part.
  - Compound stars list their parts (a third element in `stars`), shown ✓/✗ on the end screen and
    in the year report; stars are won in order, and the screen says so. In the final year a chip
    tracks the hours short against the three limits (its pop-up lists them).
  - Year reports and scenario decisions always pause, even with "Pause for decisions" off. A
    decision that arrives with the year report opens when the report closes, even if the clock is
    paused. That check runs every frame, not just while the clock runs. Rival plans, their results
    and reserve results follow the setting.
  - Closure badges from `closes` (copied to `S.closeAt`; `closesIn`).
- **Scenario fields:**
  - `years`, `yearDays`, `timeline` (same shape as `TRANSITION`)
  - `owns`: rivals handed to you via `takeRival`, so the market keeps its size
  - `setup`, `closes`
  - `choices` (`{ title, text, options: [{ key, label, detail, apply }], deflt }`; put to you with
    `offerChoice` or `choiceDays`; `S.choice` stores only the id; the default applies after 10 days)
  - `sites`: which zones open in which year; unlisted ones stay shut
  - `emis`, `emisFine`, `firm` (the first star's MW of your own firm plant), `rivalPlan`, `report`,
    `intro`
  - Use `yearsOf`/`timelineOf`/`siteOpensIn`, never `TRANSITION` directly.
- **Saves:** the career, one challenge, and **one game per scenario**, all at once.
  - Each scenario's game has its own key, `merit-order-run-<id>`, so a save writes only the game
    being played. `store.runs` in `merit-order` indexes them (`{ at, length, when, value }`).
  - The Scenarios list shows them under "In progress" (Carry on, `data-resume`), and the title's
    Scenarios button says how many are going.
  - A scenario's intro offers Carry on (`#sc-go`) and Start again (`#sc-again`, asks first);
    `startScenario(id, length, fresh)` opens the saved game unless `fresh`.
  - The menu's "Restart this scenario" asks first and restarts only that scenario. Finishing a
    scenario drops only its save.
  - The menu's "Start a new company" deletes the career, so it is shown only in the career.
  - Saves from before v36 (`store.scenario`) are moved to their key on load. A run key with no index
    entry is adopted, not deleted.
- **Challenges**: 30 days, a shareable code (`MO-…`), highest company value wins.
- **Plant ageing (v40):** only in the multi-year scenarios (the Energy Transition and the company
  scenarios), once a game year in `transitionYear`. The career and the short scenarios never age.
  - Each plant has `p.age`, which only a rebuild resets, and `p.wear`, which an overhaul cuts to 30%.
  - **Wear from use (v41):** gas and storage wear with use, everything else by the calendar.
    - A year's wear = `USE_CALENDAR` (0.3, ageing even when idle) + 0.7 × this year's use ÷ typical use,
      capped at 3 (`yearWear`). A battery's capacity fade scales the same way.
    - Gas use is in equivalent operating hours, as turbine makers count it: an hour running is 1, a
      start counts `start` more (peaker 2, combined-cycle 10), and a trip (a breakdown on a day it
      ran) counts as five starts. Storage use is full cycles (MWh discharged ÷ capacity).
    - `typical` is the steady test player's average per game day (`typical.js`-style measurement,
      Transition and company scenarios): peaker 2.5 equivalent hours, combined-cycle 16, battery 0.45
      cycles. Long storage is set at 0.25 (the steady player builds none). Most of steady's peakers
      sit idle (median under 1 hour a day) and a few run hard, so idle peakers now age slowly.
    - Counted in `p.use` (`countUse` each interval; starts where they happen; trips at the breakdown
      roll via `p.use.ran`), turned into wear in `transitionYear` and reset. `useSoFar` gives the
      year so far for the condition card ("This year so far: 41 starts, 96 hours running…"). An old
      save's uncounted part of the year counts as typical.
    - The year's hardest-worked gas plant gets a news line and a mention in the Plant condition row
      (`S.hardUse`), and the bid note says "Peaks only" wears gas least.
  - Per year of wear (`AGEING`):
    - wind and offshore: −1.2% and −1.0% output; solar −0.6%
    - gas: +0.8–1% running cost and +8% breakdowns
    - everything: +1–3% upkeep
  - The effects come from `ageEffects` and are applied in `vreMW`, `vcOf`, `upkeepOf` and the
    breakdown odds.
  - **Past design life** (solar 25, wind 20, offshore 25, gas 30, hydro 50, batteries 15, long
    storage 20), each year counts three times and an overhaul can't remove that part. Storage fades
    twice as fast then.
  - Output wear applies after the output cap (`vreMW`), so an upgraded or newer farm still loses it.
  - **Better technology:** wind, offshore and solar built later in a scenario make more (`p.vintage`:
    +1.5%, +1% and +1% a year, capped at +25%). Gas built later runs cheaper (v41: 0.5% a year, capped at
    10%, `vcap`; `vcOf` divides by `p.vintage`).
  - **Overhaul** (`overhaul`): 6–12% of today's price (hydro: of its turbines), a day offline,
    leaves 30% of the wear. Storage keeps its "new cells" refurbish, which now also cuts wear.
  - **Rebuild** (`rebuild`): a new plant of today's design on the same site, same size, built
    alongside. The old one keeps running until the new one connects, then it's knocked down (in
    `step`'s construction loop; `p.replaces` / `p.replacedBy`).
    - Price: today's price less the reused connection and 40% salvage of the old plant (paid at
      once; the old plant's value drops to 0).
    - Keeps the name, bids, storage and FCAS settings and the upgrade; age 0, today's vintage.
    - Not offered for hydro or coal.
  - **Repower (v41, `repowerMW`):** wind, offshore and solar can be rebuilt bigger on the same land:
    +2.5% of the original MW per year of age, up to +50%, rounded down to 5 MW (a 20-year-old 240 MW
    farm → 360 MW). `p.land` keeps the original footprint and `siteUsed` counts it, so a repower
    needs no site room and frees none. `rebuild(S, p, { mw })`; custom bid bands scale with the size.
    The plant page shows "Rebuild, same size" and "Repower to N MW" side by side, each with its payback.
    It's a growth move that works when every site is full (`fullNote` says how many farms could).
  - `maintenancePlan` estimates each option's daily gain and payback at the plant's recent earnings
    (`p.margin` and `p.eDay`, averaged daily). The plant page shows it, because maintenance only
    pays where the plant earns. Worn solar in a late Transition full of cheap midday power often
    isn't worth it.
    - The estimate (`wearGain`) is deliberately cautious: more output is discounted for the share
      the zone would curtail, for your own share of the region (extra output lowers the price your
      other plants get) and ×0.7 for falling prices; a newer design's extra output counts at half;
      and the whole gain is × `GAIN_CAUTION` (0.6). An overhaul also counts what it misses
      offline; a rebuild doesn't (it's built alongside).
    - **Balance (v40, `balance.js` steadyM/firmM):** a neglected fleet ends about 12% below no
      ageing in the Transition (steady $5.62B → $4.93B), and every bot keeps its stars. Acting on
      the estimates roughly breaks even (steadyM $4.79B, firmM $3.48B vs firm $3.41B): plants pay
      back in weeks, so fixing an old one gains little against building another. Rebuilds pay where
      a plant earns well, isn't curtailed and is far behind today's design. In the company
      scenarios the bots make 0–2 maintenance moves, so differences there are the random stream.
  - **Inherited fleets start old** (`age` in `owns`; `wear` is half the age).
  - **Telling the player:** a worn tag on the plant cards, a condition card on the plant page, a
    yearly ageing news line (one line, the most worn plant), and a "Plant condition" row in the year
    report.
  - Coal keeps its own ageing (`coalAge`) and closure dates.
- **Menu (v40):** sections Your company / Play / Settings / Help (`.menu-h`). Recent days is part of
  the Company report; Goals has the target icon.
- **Away time** goes only to the game that was open when the app closed:
  - `store.last` names it at each save; on load the time since becomes that game's credit
    (`store.away`), used when it's next opened.
  - The career and the multi-year scenarios then catch up (up to 7 game days per absence) unless
    "Keep trading while I'm away" is off.
  - A game you switch away from inside the app, or leave for the title screen, waits for you.
- New games start paused.
- Tests: wipe storage from the title screen (`wipe` in `ui.js`). A game that is open saves itself
  again on reload.

## Files
- `sim.js`: the whole engine, no DOM, runs in Node. Exposes `Sim` (create, step, catchUp, build,
  bids, loans, scenarios, …).
- `index.html`: the UI (one file). `window.MeritOrder` is a debug/test handle (`state`, `Sim`,
  `setSpeed`, `renderAll`, `save`, `meritNew`, …).
- `test/payback.js`: are the maintenance estimates true? Forks the game at checkpoints and compares
  what an overhaul, rebuild or repower really earned with the estimate; `--sum` fits `GAIN_K`.
- `test/engine.js` (engine checks), `test/ui.js` (Playwright, `--shots <dir>` saves screenshots),
  `test/balance.js` (simulated players: `node test/balance.js` career; `--scenarios`;
  `--transition [bots] [--long]`; `--companies [bots] [ids]`).

## Market as built
- 5-minute intervals (288 a day). Uniform price; floor −$1,000, cap $23,200. Cumulative price
  threshold: past it the administered price cap ($600) applies until the week's sum falls back.
- Sites have loss factors (offers rank at price ÷ MLF, revenue × MLF) and room; hydro valleys are
  fixed reservoirs, one plant each. Zones in the transition have line limits (curtailment).
- Frequency control: Raise and Lower markets. Contracts: swaps and caps, released every 3 days. Each
  release has a $300 cap and one at $150 or $1,000 in turn (`CAP_STRIKES`), each priced from what it
  would have paid out over two weeks (`d.capPays`) plus a margin.
- Wind and solar earn a $10 certificate per MWh. The interconnector imports/exports in priced steps.
- **Why prices spiked:** a day's first interval at $1,000 or more (`SPIKE`) gets a news line from
  `spikeNews`.
  - It gives up to three reasons, rarer ones first: units broken down, the interconnector out, a
    heatwave or cold snap, still wind, dear gas. Imports at their limit and sunset only fill in.
  - It ends with who set the price (often your own plant).
  - A shortfall's line carries the same reasons instead, so there's one line for that moment.
  - Spikes happen on 5–10% of career days.
- **Rival builds in the career** (`rivalInvestment`) take developers' names (`DEVELOPERS`,
  `rivalName`), like the company scenarios' rivals. `migrate` renames old saves' "Rival peaker N".
- **Every site full** (`regionFull`, `fullNote`): when no site has room for the smallest plant of
  anything unlocked, the news says so once (`S.fullSaid`) and the build sheet shows it (counted
  live). The note says:
  - what's left to unlock, and when new sites open
  - how many plants can still be upgraded (upgrades need no site room), or that every plant has
    been
  - whether the rivals' coal units may still be offered (career only)
  - that bids and contracts are what earn more from there

  Selling a plant frees room only for the same kind, so the note doesn't suggest it. A rich late
  game is intended: the owner likes that you earn a lot of money there.
- **Bid stacks**: 10 bands per plant. New band prices apply from tomorrow; MW rebids apply now.
  Presets: Cover costs (and start-ups for gas), Peaks only, Ladder, Custom. Plants offer the slice
  of their stack they can reach this interval (`offerSlice` in `sim.js`): below it they must run.
  Coal: band 1 is fixed at −$1,000 holding the minimum (45%, 30% after the retrofit), ramps 5% a
  step. Gas: start cost, then a minimum run at stable load. Storage: auto-strategies or custom
  sell/charge stacks; capacity fades in the transition.
- The plant page explains what's happening ("Right now" panel, the bid table's Now column).

## Money
- Overdraft: interest daily, a limit; past it for 3 days the bank sells plant. Bust when nothing is
  left to sell.
- Bank loans: up to 20% of net worth, plus up to 60% of an offered plant's price secured on it;
  7% a year + 15% × gearing (+3% Tough, −1% Relaxed); 30/90/180-day terms, equal daily repayments,
  free early repayment. Company value is net of debt.

## Balance targets (re-check with `balance.js` after any change to prices, costs or rules)
- Career at day 120: Standard steady ≈ $26–29M (28.6M now), Tough ≈ $11M, Relaxed ≈ $45M; idle
  ≈ $4.5M; reckless and cap gamblers usually bust; the always-borrow bot ≈ 1.5× steady.
- Scenarios: doing nothing earns at most 1 star, steady play 1–2, a good plan 3. The three judged on
  more than money: doing nothing 0, the obvious response 1–2, a plan for the objective 3 (results
  and the players that show it in `balance.js`, `--scenarios`).
- Energy Transition: doing nothing 0 stars (the region runs short); the steady and firm bots
  3 stars at both lengths with no shortfall from year 12.
- Company scenarios (`--companies`), measured with these bots: handsoff, steady, firm, gouge
  (thermal only at $300+), quitcoal (closes its coal on day 1), buyer (buys every proposal), plus
  steady with each decision option.
  - **First star:** no more than 48 hours short in the final year *and* own the scenario's `firm`
    MW, so rivals filling the gap doesn't earn it for you. One star should be very achievable for
    anyone who builds firm plant; three need no shortfall at all.
  - **Targets:**
    - Handsoff, gouge and quitcoal end below steady in value (rival proposals are what stop
      withholding from paying).
    - Handsoff earns 0 stars; steady 2.
    - No decision option is more than about 15% from another.
  - Company values run to hundreds of millions.
- Plants pay back in weeks here, so anything that adds capital (loans, subsidies) compounds fast:
  simulate before choosing numbers.

## Before publishing
`node test/engine.js`, `node test/ui.js`, `node ../tools/check-pwa.js merit-order`,
`node ../tools/tap-sweep.js merit-order` and `--portrait` (no errors, unreachable or dead taps).
Bump `VERSION` in `sw.js` and the title's `#t-version` together (ui.js checks they match). Publish by
fast-forwarding `main` to the working branch.

## Lessons learned
- Ids must be unique: `$('id')` and Playwright both take the first match, so a duplicate silently
  breaks a button (check-pwa now fails on duplicates).
- Draw a canvas after its sheet is visible, or it has no size.
- The merit chart's bars are keyed by owner and band number, never by price (re-priced bands would
  flicker).
- `renderAll()` marks the interval as drawn; decide "is this interval new?" before calling it.
- Shell edits: inline scripts containing `${` or `||=` trip the command safety checker; write the
  edit script to a file and run it.
- A missing number turns totals into NaN, and NaN silently fails every comparison.
  - Storage has no `emis` in `TECH`, so before v39 a battery made the emissions totals NaN.
  - That switched off emissions fines and broke challenge result codes.
  - `emisOf` now uses `|| 0`, and `engine.js` checks the totals stay finite.
- A "never overdrawn" objective didn't work: you can't build on the overdraft, so it never bit.
  Calibrate any new objective with the test players before writing it into a scenario.
- Random draws shared between plants make every action reshuffle every later breakdown. Before v41
  one player stream fed every plant's daily breakdown roll, so building, overhauling or selling one
  plant changed everyone's luck from then on: balance comparisons between bots swung ±3–7% from that
  alone, and a forked game moved by about $400k a day. Now each plant draws its own (`plantRnd`: seed,
  plant, day; a rebuild inherits `rkey`), and the player stream only makes contract offers.
- Check any estimate shown to the player against forked games (`test/payback.js`), not guesses: a
  game clones exactly through JSON (`Sim.migrate(JSON.parse(JSON.stringify(S)))`). Freeze rival
  proposals in the window (a day's prices can flip a 300 MW decision), and remember that JSON turns
  `Infinity` into `null`.

## Ideas not built yet
Backup and restore of saves (all progress lives in this browser's storage: `merit-order` plus a
`merit-order-run-<id>` key per scenario game), a reserve setting for
storage (hold back energy for emergencies and price spikes), fewer pop-ups (merge same-day dialogs,
skip contract pop-ups at 16×).
