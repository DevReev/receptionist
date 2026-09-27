# 16: Mid-decode barge-in audio path

**What to build:** A Caller who speaks over a Turn stuck in transcription actually aborts the in-flight decode through the audio path, end to end. Today the abort exists but nothing can trigger it live: turn-taking sits idle while a Turn transcribes, so no audio-path Barge-in can reach a hanging decode (the ticket-03 test drives the entry point directly). Either wire the audio path so speech during transcription fires a real Barge-in that aborts the decode, or prove with evidence that it is unnecessary and close the gap by decision.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Scripted Caller speech over a hung decode aborts it; the Turn recovers within the transcription deadline and no late transcript ever lands.
- [x] Content-bearing speech during a healthy transcription still becomes the next Turn without loss; stop-latency impact measured.
- [x] `npm run turn-bench` bars hold; `npm test` passes.

## Comments

Wired the audio path (no decision close): `TurnTaking.emit()` now parks the
floor in a new `transcribing` mode instead of `idle`, and frames heard there
are VAD-scored for a fast energy-only Barge-in candidate (fires at
`bargeInMinSpeechMs`, no confirm/lag hold for partial semantics, no Echo
reference — no reply plays during transcription). On candidate,
`onBargeIn` fires; the session's existing `handleBargeIn` aborts the
in-flight decode (`transcribeAbort`) and `acceptBargeIn` adopts the retained
candidate as the next utterance's head, so interrupting speech is never lost.
No `src/live.ts` change was needed: `handleBargeIn` already aborts decode
controllers and its continuations already guard aborted Turns, and
`startSpeaking`/`startListening` exit the mode automatically.

Evidence: new `test/liveMidDecodeBargeIn.test.ts` (4 tests) drives
barge-in purely through `receiveAudio` — hung decode aborted via audio
(`signals[0].aborted`), late release never lands (history empty, no reprompt,
nothing spoken), interrupting speech completes intact as the next Turn;
brief noise (5 frames) and pure silence never abort. Stop latency measured
at 10 speech frames (~200 ms audio) from interrupt start to abort, asserted
`<= 15` frames. The new tests fail on the old code (abort never fires).
`test/liveTurn.test.ts` "stops accepting a second utterance…" encoded the
old drop-while-transcribing behavior and now asserts the ticket-16 behavior
(second utterance becomes Turn 2, aborted decode never lands).

Bench (isolated clean tree at HEAD + this change): echo-gate PASS,
safety PASS, TOTAL false-cut 0.0% (0/13), reply p50 280ms p95 1300ms,
stop p50 180ms p95 220ms (missed 0), backchannel false-stop 0.0% absorbed 1,
echo false-stop 0.0%, self-echo 0, gate pass 0.0% (0/111), gate block 4.8%
(2/42) — byte-identical to the no-change baseline, so zero stop-latency
regression. `npm test` 530/530 green and `typecheck` clean in isolation.

Residual uncertainty: this tree concurrently holds uncommitted edits from
tickets 14/15/17 (`live.ts`, `hybridDetector.ts`, `tts.ts`,
`sarvamStreamTts.ts`); full-suite/typecheck failures here (e.g. 2
`liveBargeIn` timeouts, `turnTakingHybrid` type errors) reproduce without
this change and pass 9/9 with it in isolation — they belong to the
in-flight concurrent work, not this ticket. Trade-off accepted per the
ticket pointers: speech mid-transcription aborts the first decode, so a
fast legitimate follow-up discards the first transcript (Caller repairing
dead air is the expected case).
