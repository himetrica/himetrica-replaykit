# @himetrica/replaykit

## 0.2.3

### Patch Changes

- 34a74eb: Recordings end once they have uploaded 40 MB of raw event data. Pages that rewrite themselves nonstop (tickers, carousels, animated counters) no longer produce recordings too heavy to load in the player.

## 0.2.2

### Patch Changes

- 039f51d: Recordings now end on their own: after 20 minutes, or after 10 minutes without a click, key or scroll (page mutations alone no longer keep a recording going). What was captured up to that point is still uploaded; nothing more is recorded for the rest of the session. The API enforces the same limits for every SDK version.

## 0.2.1

### Patch Changes

- 1da5a8a: Fewer false rage clicks: only clicks on elements that promise something (links, buttons, pointer cursor) count, so selecting text with a triple click is no longer rage; a burst is one DOM element, not every element sharing a selector; and the first 3 clicks must land within 1 s, so steady slow clicking does not add up.

## 0.2.0

### Minor Changes

- 38cdd85: Minimum recording duration: sampled, checkout and paying recordings start only after the visit has been on screen for the project's minimum (5 s by default). Errors and rage clicks still record right away.

## 0.1.0

### Minor Changes

- 48290b9: First release of ReplayKit: session replay and friction signals for the web. Records the sessions that matter (an error, a rage click, a checkout, a paying customer, or a sample) and flags rage clicks, dead clicks, JavaScript errors, back navigation and abandoned forms in every session, tied to the visitor and session the Himetrica tracker already knows.
