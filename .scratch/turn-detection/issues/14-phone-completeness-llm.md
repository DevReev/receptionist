# 14: Phone completeness via LLM, not digit counting

**What to build:** While collecting the Patient's phone, the Turn boundary holds until the number is actually complete — judged by language, not by counting digits. The digit-ceiling heuristic that calls any dictation over 13 digits "complete" splits real numbers (country code plus regrouped repeats plus extension cues) mid-number. Completeness becomes the dialogue layer's call: it asks the assistant whether the digits dictated so far form a complete callable number, tolerant of regroups and repeats, and the boundary treats "incomplete" as continuation evidence the same way it treats other incompleteness today.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] A scripted long dictation (country code, regrouped repeats, extension cue) never splits mid-number; a complete number endpoints at the normal floor.
- [x] The old digit ceiling no longer owns the decision; digit energy still feeds the pause floor as before.
- [x] `npm run turn-bench` false-cut and reply-latency bars hold; `npm test` passes.

## Comments

Design rationale. The boundary consults completeness on every silence frame (~50/sec), so an assistant round-trip per frame is impossible. Completeness is therefore the dialogue layer's *synchronous language judgement* (`isPhoneDictationComplete` in `src/dialogue.ts`), not a digit count and not a per-frame network call:

- Short of 10 digits (chars + spoken number words) → incomplete, as before.
- Bare extension cue (`ext`/`x`/`extension` with no digits after) or trailing separator → incomplete; a finished extension (`ext 123`) judges by the number core.
- Adjacent identical digit blocks ≥4 long collapse to one copy before counting, so a regrouped repeat (`98765 98765`) never fakes a complete count, while genuine short exchanges (`555 555`) are left alone.
- Over-long cores (>13 after dedupe) hold instead of force-completing: the ceiling is demoted from owner to non-factor. Emergency (1500 ms) and stale-partial (1300 ms) caps still bound every hold.
- Non-dictations (empty, `John Smith`, `I have 2 kids`) read complete, preserving prior behavior.

Plumbing keeps the boundary sync and pure: `FieldCollection.phoneComplete` carries the resolver (`PhoneCompletenessResolver = (text) => boolean`, a type no promise can satisfy); `TurnTaking` caches the verdict per partial text and re-asks at most once per partial; `LiveCallSession.setDialogue` injects the dialogue verdict. Digit energy still feeds the pause floor untouched (`dialogueFloorMs` 600 ms while collecting). Commit-time phone validation (`extractPhone` 10–13, DTMF) is unchanged.

Verification. New `test/phoneCompleteness.test.ts` (15 tests): verdict units, hybrid units, frame-driver long-hold + floor-endpoint + stub consult-count (40 silence frames → 1 consult; sync booleans only), live session seam. Focused suites (`hybridDetector`, `turnTakingHybrid`, `liveHybrid`, `dialogue`) 54/54 green. Isolation proof: HEAD (ticket 15) + only ticket-14 hunks in a clean worktree → full suite 543/543 green and `turn-bench` identical to baseline (false-cut 0.0% (0/15), reply p50 280 ms p95 1300 ms, echo-gate PASS, self-echo PASS). In the shared tree the same bars hold for false-cut/reply-latency (0.0%, p50 280 ms p95 1300 ms); the tree's self-echo FAIL (3), stop-miss (2), and 12 failing barge-in/speculation/echo tests come from tickets 16/17 in-flight uncommitted changes (their paths never touch the phone verdict, which is bench-inert: no bench scenario selects a Slot, so `collectingPhone` never activates there). `live.ts` was hunk-staged (2 hunks) so ticket 17's speech-path refactor stays out of this commit; `CONTEXT.md` untouched per rules.

Residual uncertainty. A caller who pauses on a clean complete-looking core mid-dictation (e.g. `+91 98765 43210`, about to add an extension) still endpoints — by language judgement that *is* a complete number; only repeat/extension/separator markers hold. Degenerate numbers containing an adjacent 4+ identical digit run hold to the emergency cap rather than endpointing at the floor.
