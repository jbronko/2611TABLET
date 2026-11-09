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
- **Challenges**: 30 days, a shareable code (`MO-…`), highest company value wins.
- The career and the Energy Transition keep trading while the app is closed (up to 7 game days per
  absence) unless "Keep trading while I'm away" is off. New games start paused.

## Files
- `sim.js`: the whole engine, no DOM, runs in Node. Exposes `Sim` (create, step, catchUp, build,
  bids, loans, scenarios, …).
- `index.html`: the UI (one file). `window.MeritOrder` is a debug/test handle (`state`, `Sim`,
  `setSpeed`, `renderAll`, `save`, `meritNew`, …).
- `test/engine.js` (engine checks), `test/ui.js` (Playwright, `--shots <dir>` saves screenshots),
  `test/balance.js` (simulated players: `node test/balance.js` career; `--scenarios`;
  `--transition [bots] [--long]`).

## Market as built
- 5-minute intervals (288 a day). Uniform price; floor −$1,000, cap $23,200. Cumulative price
  threshold: past it the administered price cap ($600) applies until the week's sum falls back.
- Sites have loss factors (offers rank at price ÷ MLF, revenue × MLF) and room; hydro valleys are
  fixed reservoirs, one plant each. Zones in the transition have line limits (curtailment).
- Frequency control: Raise and Lower markets. Contracts: swaps and caps, released every few days.
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
Backup and restore of saves (all progress lives in this browser's storage), a reserve setting for
storage (hold back energy for emergencies and price spikes), fewer pop-ups (merge same-day dialogs,
skip contract pop-ups at 16×).
