# 06: Backchannel absorption

**What to build:** Short Caller acknowledgements while the Receptionist speaks ("mm-hmm", "okay", "right") are heard, classified as Backchannels, and do not stop it. Energy is the fast pre-trigger; partial transcription semantics confirm. A Backchannel never becomes a Turn and never enters LLM history — it is absorbed and traced only.

**Blocked by:** 05.

**Status:** done

- [x] Scripted Backchannels during playback do not stop the Receptionist and leave history unchanged; traces record the absorption.
- [x] Backchannels are distinguished from short content-bearing interruptions ("wait", "no, Monday") in scripted scenarios.
- [x] Genuine Barge-in still fires on content-bearing speech while the Receptionist speaks.
- [x] The Caller hears no gap or acknowledgement reply to a Backchannel.

## Comments

Implemented. `src/backchannel.ts` is the pure classifier: lowercased,
punctuation-stripped tokens, letter-run collapse, a whitelist vocabulary
(`hmm`, `mm-hmm`, `okay`, `right`, …) plus phrase particles (`I`, `see`,
`got`, `it`, `thank`, `you`) that only count inside a multi-token phrase, so
`"I"` or `"it"` alone stay content-bearing. Any digit, more than four tokens,
or an unknown word means content; empty partials are `unknown`.

`TurnTaking` owns the absorption state machine. When partial semantics are
promised (`partialSemantics`, default: the realtime channel is in provider VAD
mode and implements `onPartial`), the 200 ms energy pre-trigger no longer fires
immediately: a `content` partial fires at once, a `backchannel` partial absorbs
at once, and an unknown candidate waits up to `bargeInConfirmMs` (300 ms, env
`BARGE_IN_CONFIRM_MS`) for a partial before taking the floor anyway. Without a
semantics channel the pre-trigger fires exactly as in ticket 05. Absorption
drops the candidate audio, keeps the classification for the burst tail so a
long "mm-hmm" does not re-trigger, and expires it after `bargeInDipToleranceMs`
of trailing silence so the next content burst is judged on its own evidence.

`observePartial` is fed from the session's `realtime.onPartial` (alongside the
availability prefetch). `LiveCallSession` traces each first absorption as
`component:"call", event:"backchannel"` with `durationMs` and `text`; no Turn
opens, no history is written, and playback keeps running. Absorption is
suspended while a confirmation readback plays (`startSpeaking({absorbBackchannels:
false})`), so an answer to "Shall I book it?" takes the floor and clears the
readback instead of being swallowed as an acknowledgement.

Coverage: `backchannel.test.ts` (table unit), `liveBackchannel.test.ts`
(absorb without stop/Turn/history + trace, short content interruption still
fires, confirm hold then unknown speech takes the floor, fresh burst after an
absorbed one, readback affirmatives interrupt). The turn bench gained a
scripted partial channel and an `absorbed` count; `turnBench.test.ts` asserts
the `backchannel-reply` scenario absorbs with zero false stops and that a short
"wait" still stops. Full suite 387/387.

Bench (`bench-scripts/06-backchannel-absorption.md`): backchannel false-stop
0/1 with `absorbed 1` (was 1/1), stop p50 180 ms unchanged, echo false-stop 0,
self-echo 0, gates pass.

Accepted residuals: partials only stream while the floor is watched in provider
VAD mode (`TURN_DETECTION=sarvam`); `hybrid` keeps energy-only Barge-in until
its manual-mode socket opens utterances for candidates. The confirm hold adds
up to 300 ms of stop latency when no partial arrives; content partials fire at
the pre-trigger as before.
