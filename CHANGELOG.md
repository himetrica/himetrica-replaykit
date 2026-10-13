# @himetrica/replaykit

## 0.2.1

### Patch Changes

- 1da5a8a: Fewer false rage clicks: only clicks on elements that promise something (links, buttons, pointer cursor) count, so selecting text with a triple click is no longer rage; a burst is one DOM element, not every element sharing a selector; and the first 3 clicks must land within 1 s, so steady slow clicking does not add up.

## 0.2.0

### Minor Changes

- 38cdd85: Minimum recording duration: sampled, checkout and paying recordings start only after the visit has been on screen for the project's minimum (5 s by default). Errors and rage clicks still record right away.

## 0.1.0

### Minor Changes

- 48290b9: First release of ReplayKit: session replay and friction signals for the web. Records the sessions that matter (an error, a rage click, a checkout, a paying customer, or a sample) and flags rage clicks, dead clicks, JavaScript errors, back navigation and abandoned forms in every session, tied to the visitor and session the Himetrica tracker already knows.
