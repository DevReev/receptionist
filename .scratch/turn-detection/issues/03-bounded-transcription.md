# 03: Bounded transcription

**What to build:** The transcription phase has a deadline and honours cancellation. A REST decode (commit-time hedge, second opinion, or primary) can no longer pin a Turn indefinitely: if the provider hangs, the Turn resolves within a bounded wait with a speakable recovery and a trace carrying the timeout reason. Barge-in and call close abort in-flight decodes instead of letting them run to completion and dropping the result.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] With a scripted hung transcriber, the Turn resolves within the configured deadline with a reprompt and a timeout trace line.
- [x] Barge-in during transcription aborts the in-flight decode; no late transcript can reach the session after the abort.
- [x] Call close aborts hedge, second-opinion, and warm-up work with no unhandled rejection.
- [x] A Realtime final that lands after the REST deadline still wins while the Turn is alive (no double reply).

## Comments

`Transcriber.transcribe` takes an optional `signal` (honoured by both REST providers via
`fetch`); `STT_DEADLINE_MS` (default 5000, `<=0` disables) bounds the REST wait in
`handleUtterance`/`verifyCriticalFields` with `stt/deadline` + `transcribe/timeout` traces and
the normal `miss()` reprompt. The realtime final is still awaited first, so a late non-empty
final wins with a single reply. One per-Turn controller is aborted by barge-in and close
(warm-up has its own); every post-await continuation guards `closed`/aborted. Note: a barge-in
cannot currently arrive over the audio path mid-decode (TurnTaking is `idle` during a Turn), so
the barge-in test drives the single `handleBargeIn` entry point directly, then completes a
promoted Turn end-to-end.
