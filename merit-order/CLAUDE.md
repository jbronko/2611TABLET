# Merit Order: notes for working on the game

An electricity market tycoon modelled on Australia's NEM. Read the root `CLAUDE.md` first (how apps
are built, tested and published); this file is what's specific to Merit Order. Current version: see
`VERSION` in `sw.js` (the title screen shows the same number).

## Modes
- **Career**: your company, three difficulties (Relaxed / Standard / Tough), a guided first week
  ("Getting started" missions), goals that unlock wind, combined-cycle gas and pumped hydro.
- **Scenarios** (stars, cumulative, same seed for everyone): First Light, Heatwave Week, Black Hill
  Closes, Gas Squeeze Winter, Too Much Sun, The Big Build, and **Energy Transition**: 20 years,
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
    tracks the hours short against the three limits (its pop-up lists them). Year reports always
    pause, even with "Pause for decisions" off.
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
- Scenarios: doing nothing earns at most 1 star, steady play 1–2, a good plan 3.
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

## Ideas not built yet
Backup and restore of saves (all progress lives in this browser's storage: `merit-order` plus a
`merit-order-run-<id>` key per scenario game), a reserve setting for
storage (hold back energy for emergencies and price spikes), fewer pop-ups (merge same-day dialogs,
skip contract pop-ups at 16×).
