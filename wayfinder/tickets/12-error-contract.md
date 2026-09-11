---
label: wayfinder:build
status: closed
parent: ../map.md
blocked-by: [11-full-live-turn.md]
assignee:
---

# 12: Error contract on the live path

**What to build:** the legacy error contract, carried over verbatim to the Stream session — bounded reprompts then handoff, console-log-first failures, polite session ends, and no double-booking — so a Caller on the live path is never left on a dead call and the clinic never misses a failure.

**Blocked by:** 11 (needs the full Turn to exercise mid-Turn failures).

**Spec:** `06-live-streaming-voice-loop.md`.

- [x] Two unintelligible utterances → reprompts, third miss → handoff line and session end, all logged.
- [x] Mid-Turn downstream failure writes the console log first, then speaks the clinic-will-confirm line and ends the session.
- [x] Caller hangup / dropped socket logs the partial Turn.
- [x] Booking writes stay single-attempt per confirmed intent under failure.
- [x] Verified through the fake driver against the Turn/failure log collectors.

## Resolution

Implemented in `src/live.ts` (`LiveCallSession`), verified by `test/liveError.test.ts` (8 tests through stubbed providers + `FakeSocket`/`attachStreamSocket` fake driver against Turn/failure collectors). Full suite 83/83 green, typecheck clean.
- Reprompt policy per checklist: misses 1–2 speak `REPROMPT_LINE` (Turn log, `miss: true`), 3rd miss logs `low-confidence` failure then speaks `goodbyeFor` and closes `goodbye`. Note: this is two reprompts / handoff-on-third, differing from the legacy 1-reprompt / handoff-on-second policy and from spec-06's "two misses then handoff" test line — checklist taken as acceptance; legacy `src/app.ts` record loop unchanged. `test/live.test.ts` goodbye test updated to the 3-miss policy.
- Mid-Turn failures (assistant throw, TTS throw, availability resolver throw, booking writer throw) all funnel through one catch: `logFailure` first, then `FAILURE_LINE` speech, then terminal Turn log and `close('failure')`. Availability resolution moved inside the guarded region with an `availability-error:` detail prefix (previously an unguarded throw left the Caller on a dead call). TTS failure speaking `FAILURE_LINE` still ends the session with the log as handoff channel.
- Hangup/dropped socket: new `activeTurn` tracker (opened in `handleUtterance`, updated with excerpt + streamed `replySoFar`, cleared on every settled Turn log) lets `close()` emit the partial Turn (`endCall: true, miss: false`) when the socket dies mid-Turn. Transcribe-only sessions clear it with no log owed.
- Single-attempt booking: per-Turn `bookingAttempted` guard — second `proposeBooking` in one Turn resolves `ok: false` without touching the writer; a throwing writer surfaces once as a Turn failure with no retry.
- Review: no hard Standards violations (activeTurn open/update/clear scatter, error-prefix cascade, failure-speech shape duplication, and test-stub duplication across test files noted as judgement-call smells, left inline); Spec notes on callback-promise wording, polite-goodbye-after-failure-line, and cross-Turn intent identity deferred (caller-facing scripts and legacy loop untouched).
