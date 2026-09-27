# 13: Live backchannel loss to partial lag

**What to build:** Backchannel absorption must engage on live speakerphone
audio, where partial semantics lag energy. Live call
`CA132fee8e3e777e11cf583e43f1a66811` (see
`bench-scripts/11-live-partial-channel-report.md`) took the floor on "Mhm
okay" (turn 6): the Barge-in fired on energy with `candidateMs` 620 —
pre-trigger plus an expired 300 ms confirm window — and no `backchannel` event
fired on the entire call, despite 3 partials arriving for the utterance.
Candidates: lengthen the confirm window when partials are flowing but stale,
let a backchannel-classified partial arriving just after the floor was taken
convert the Turn back (absorb instead of answering), or speed the partial path
so classification lands inside the window. Measure against the bench's
backchannel false-stop bar and the stop-latency cost of a longer window.

**Blocked by:** None (report and capture retained; analysis in ticket 11).

**Status:** done

- [x] A scripted live-like sequence (energy first, partials lagging past the confirm window) absorbs instead of taking the floor.
- [x] Content-bearing speech still takes the floor within the window; stop-latency impact measured.
- [x] `npm run turn-bench` backchannel/stop bars hold; `npm test` passes.

## Comments

- Chose direction (a): lengthen the confirm hold for unknown candidates while
  partial semantics are expected but silent. `evaluateCandidate` now waits
  `bargeInMinSpeechMs + bargeInConfirmMs + bargeInLagMs` (200 + 300 + 300 =
  800 ms) instead of 500 ms. Reaching that line already implies
  unknown + `partialSemantics` + absorption enabled (every other case is
  handled in `resolveBargeInCandidate`), so classified partials still decide
  at the pre-trigger however late they arrive, and no-semantics / readback
  sessions still fire at the pre-trigger.
- Rejected (b) post-floor repair: `handleBargeIn` (`src/live.ts`) clears
  playback and cancels the active speech before the Turn opens, so the audio
  side-effect is irreversible even though caller history is only committed
  later in `handleUtterance`. Unwinding would need re-speaking with a gap;
  holding longer is strictly safer. (c) speeding the partial path is
  provider-side, out of scope.
- Calibration: live `candidateMs` 620 needed a budget past 600 ms after
  energy onset; 800 ms covers the 300-600 ms lag range with margin.
  `test/liveBackchannel.test.ts` now scripts it at the session seam: 600 ms
  of energy with no partials holds (old code fired at 500 ms), then
  "mhm okay" absorbs with no stop/Turn/history and one trace; a lagging
  "wait, I meant tomorrow" partial fires on arrival and becomes one Turn.
- Stop-latency impact, measured: unknown speech with no partials takes the
  floor at 800 ms instead of 500 ms (+300 ms, asserted frame-exact in the
  confirm-hold test). Classified content is unaffected (fires at the
  ~200 ms pre-trigger). Bench (synchronous partials) is unchanged:
  backchannel false-stop 0.0% (0/1), absorbed 1, stop p50/p95 180 ms
  (missed 0), echo-gate bars PASS, self-echo 0. Full suite 522/522, 0 skips.
