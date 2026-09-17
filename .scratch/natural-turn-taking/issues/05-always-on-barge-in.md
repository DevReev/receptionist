# 05: Always-on Barge-in

**What to build:** The Caller can interrupt the Receptionist at any point — greeting, hold lines, or replies. Audio streams upstream for the whole call; frames classified Echo are replaced with silence; non-Echo Caller speech while the Receptionist speaks fires Barge-in: the Receptionist stops within the current pacing window, aborts the in-flight reply, drops the unspoken remainder from history, and a fresh Turn begins with the interruption's first words retained. Provider speech-start events corroborate but never trigger. Safety holds: an interrupted readback can never authorize a Booking, and an in-flight Booking write is never cancelled.

**Blocked by:** 04.

**Status:** done

- [x] Scripted Caller speech during playback stops the Receptionist within the pacing window and starts a new Turn with the interruption's opening audio retained.
- [x] Echo-mixed inbound never stops the Receptionist: zero self-Echo-triggered Turns in synthetic runs.
- [x] The unspoken remainder is absent from history; an interrupted readback is cleared; Booking safety invariants hold.
- [x] The Barge-in boolean is deleted; Barge-in candidate knobs (minimum speech, dip tolerance) are named and env-configurable.
- [x] Barge-in works during the greeting and hold lines exactly as during replies.

## Comments

Implemented. `TurnTaking` lost its `muted` floor: `startSpeaking()` always watches,
so audio streams upstream for the whole call. While watching, every frame is
classified; flagged Echo is replaced with mu-law silence upstream and gate
`silence` frames are never Caller speech, so a quiet or not-yet-arrived echo
cannot count toward a candidate. The candidate fires after
`bargeInMinSpeechMs` of candidate audio (non-Echo speech plus dips inside the
`bargeInDipToleranceMs` budget); Echo frames contribute silence to the retained
candidate audio, so the promoted Turn never transcribes the Receptionist's own
words. `providerSpeechStart` during watching only sets a flag: the fire event
carries `corroborated`, traced with the candidate (`component:"call",
event:"barge-in"`). Accepted residual: Caller frames below the gate's silence
floor cannot barge in, whatever the VAD says; the Echo-gate bench still reports
the caller false-block rate.

`LiveCallSession` dropped the `bargeIn` boolean and always calls
`startSpeaking()`. `handleBargeIn` no longer gates on phase, aborts the Turn's
LLM controller (`turnAbort`) so a barge-in during a hold line never speaks the
reply it was waiting on, and marks the Turn `interruptedTurn`. An interrupted
readback still clears through `clearReadback`; a write in flight is untouched.

Config: `BARGE_IN` and `BARGE_IN_SPEECH_MS` deleted; `ENDPOINT_MIN_SPEECH_MS` and
`ENDPOINT_LATCH_DIP_MS` leave the config surface (their values live in
`LOCAL_ENDPOINT_FALLBACKS`); `BARGE_IN_MIN_SPEECH_MS` (200) and
`BARGE_IN_DIP_TOLERANCE_MS` (200) are env knobs with RUNBOOK rows.

Coverage: `turnTakingBargeIn.test.ts` (Echo before any caller speech, silence
scored as speech, corroboration without trigger), `turnTakingEchoGate.test.ts`
(upstream diet: Echo frames replaced, Caller frames passed), `liveBargeIn.test.ts`
(greeting, hold line, self-Echo, interrupted readback, in-flight write),
`wiring.test.ts` (config surface). The turn bench gained a hard self-echo bar
(`SELF_ECHO_BAR`), always-on scenarios, and a caller-bank silence skip so
declared interruptions carry audible content; recorded in
`bench-scripts/05-always-on-barge-in.md`. Full suite 377/377.
