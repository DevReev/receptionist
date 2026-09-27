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

**Status:** ready-for-agent

- [ ] A scripted live-like sequence (energy first, partials lagging past the confirm window) absorbs instead of taking the floor.
- [ ] Content-bearing speech still takes the floor within the window; stop-latency impact measured.
- [ ] `npm run turn-bench` backchannel/stop bars hold; `npm test` passes.
