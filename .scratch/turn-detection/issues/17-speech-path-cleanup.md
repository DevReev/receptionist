# 17: Speech-path cleanup batch

**What to build:** One mechanical cleanup pass over the speech path, no behavior change: a shared alive-guard predicate for the repeated closed/cancelled/generation checks in the model-response pipeline, one shared finish helper for the normal and deadline-recovery completion paths (history commit, phase logging, playback barrier), a shared abort-binding helper for the two streaming-speech implementations, and one field-collection type replacing the travelling `collecting`/`collectingPhone` boolean pair. Deliberately out of scope: the item-lifecycle names and the word-list unification (mild findings, not worth a ticket).

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Each duplication is extracted once and called from all prior sites; no caller keeps a local copy.
- [x] No behavior change: full suite plus both benches byte-identical in outcome (same bars, same PASS).
- [x] `npm run typecheck` and `npm test` pass.

## Comments

Alive guard (`speechAlive`, `src/live.ts`): all model-response checks route through it — pre-speech, audio-drain loop, drain catch (now includes `closed`, matching every other site), pre-barrier tails, and the deadline-abort classifier (`controller.signal.aborted && speechAlive(...)`). Speculation-settle and turn-outer watermark checks are separate pipelines and stay as-is. Finish helper (`finishSpokenReply`): the normal tail and the deadline-recovery buffered prefix share one synchronous completion (playback-barrier outcome, `playback-complete` trace, assistant/tts phases, history commit, `replySoFar`); the `await finishPlayback` stays at the call sites so the `finally` (`beginListening`) interleaving the turn benches pin is unchanged. Abort binding (`bindAbortSignal`, `src/tts.ts`): both streaming-speech implementations use it; both detach on settle (`bufferedSpeech` wraps `queue.end/fail`, Sarvam already did) so a reused controller cannot cancel a later response. Field collection: `FieldCollection` travels as one object (`setDialogue` → `observeDialogueState` → `isSemanticallyComplete`); all boolean call sites converted to object form. Item-lifecycle names and word-list unification untouched per scope.

Evidence: `typecheck` clean, `npm test` 547/547 green. `turn-bench` TOTAL false-cut 0.0% (0/15), reply p50 280 ms p95 1300 ms, stop p50 180 ms p95 180 ms, echo-gate PASS, safety PASS (0) — byte-identical to the HEAD baseline run in a clean tree. `echo-gate-bench` PASS (false-pass 3.3%, false-block 0.3%), identical to baseline. Code review: Standards pass (no hard violations); Spec minors adjudicated — the settle-detach fulfils the helper's documented contract, and the drain-catch `closed` inclusion is the intended unification (HEAD's omission was the outlier). This commit stages only the ticket-17 hunks; the unrelated `CONTEXT.md` (Slot range) edit stays uncommitted.
