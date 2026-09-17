# 08: Stall guard

**What to build:** A provider that stops emitting boundaries never strands the Caller. If local speech presence sees no provider end signal and no final within 1.2 s of local trailing silence, the hybrid detector takes the boundary for that Turn and transcription falls back to the REST path. Two consecutive stalled Turns switch the session to hybrid mode at the next boundary. Every trip is traced.

**Blocked by:** 07.

**Status:** done

- [x] A scripted stall completes the Turn via the hybrid boundary plus REST transcription; the Caller hears no hang.
- [x] Two consecutive stalls switch the session's detector mode at a boundary; subsequent Turns are detector-owned.
- [x] Traces record each stall, fallback, and mode switch with the evidence.
- [x] An isolated one-off stall does not switch the session's mode.

## Comments

Implemented. In `sarvam` mode `TurnTaking` now scores the local VAD while
listening, so a provider that stops emitting boundaries cannot strand the
Caller. Locally-heard speech past the minimum-speech floor opens the fallback
capture (a blip does not; a later provider `vad.speech_start` only claims it, so
a provider that never opens anything is covered too, as is an utterance adopted
from a Barge-in candidate). Trailing silence past `STALL_GRACE_MS` (env, default
1200) with no `vad.speech_end` takes the boundary: the utterance is emitted with
`stalled: true` (trailing silence trimmed, evidence stats from the local frames)
and `onStall` carries trailing silence, locally-heard speech, and the grace.
Completed intra-utterance pauses are observed for the adaptive floor, so a
post-switch hybrid Turn already tracks the Caller's rhythm. `setDetection` moves
boundary ownership at a boundary.

The adapter also closes an utterance on its `transcript.final` when the
`vad.speech_end` for it never came: the final is the provider's own end-of-turn
evidence, so that Turn takes the normal realtime path instead of waiting out
the grace. A late real `vad.speech_end` is then surfaced once, not twice.

`LiveCallSession` counts consecutive stalled Turns, resetting on a
provider-boundary Turn. A stalled Turn does not call `finalize()`;
`RealtimeStt.abandonUtterance` releases the provider's orphaned utterance,
adopts any pending endpointing switch and hands back a final that already
landed (used as-is instead of REST). Without one, the captured audio goes to
the REST transcriber. Two consecutive stalls call `switchToHybrid` at the
boundary just taken: `providerBoundaries` flips, `TurnTaking` detection becomes
`hybrid`, the socket is told `setEndpointing('manual')`, and subsequent Turns
are detector-owned while transcription still prefers the channel final.

Traces: `call/stall` (trailingSilenceMs, speechMs, graceMs), `stt/fallback`
(source rest, reason provider-stall, turn), `call/detector-switch` (mode hybrid,
stalls 2, reason provider-stall); `vad/endpoint` reports source `local` for
stalled Turns, and the adapter traces `stt/final-boundary` and
`stt/utterance-abandoned`.

Interpretations recorded:

- The guard arms on local speech presence, not on `vad.speech_start`: "no
  provider end signal" also covers a provider that emits nothing at all
  (user story 11). Provider-owned captures keep their trailing silence; only a
  stalled boundary trims it. Local speech must clear the detector's own
  minimum-speech floor before it arms, so one echo or noise frame cannot cancel
  the no-response watch or open a phantom Turn.
- A final without its boundary ends the Turn on the normal path, so the grace
  only ever applies when neither signal arrives.
- "Switch ... at the next boundary" is read as the boundary-gated switch the
  adapter already implements (ticket 03): the session flips during the second
  stalled Turn's handling, which is the next boundary the session sees, and the
  socket adopts manual at its own next boundary.
- A stalled boundary with a final already in hand still counts toward
  escalation: the boundary is what failed, and the extra wait is the latency
  the switch avoids.

Coverage: `turnTakingStallGuard.test.ts` (grace, provider end inside grace
without trimming, no provider start, Barge-in candidate, no local speech, blip
floor, restarted clock, post-switch adaptive boundary),
`liveStallGuard.test.ts` (REST fallback with no hang and full traces, delivered
final not discarded, provider emitting nothing, two-stall switch with a
detector-owned third Turn, isolated stall), adapter `abandonUtterance` and
final-boundary protocol cases, config default/tunable. Full suite 421/421.
