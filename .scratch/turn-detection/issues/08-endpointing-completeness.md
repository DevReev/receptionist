# 08: Endpointing completeness with real partials

**What to build:** The completeness rules the Turn boundary consults are good enough that real partials neither cut Callers mid-thought nor hold them to the emergency cap. Expand the continuation vocabulary to cover common mid-sentence function words and phrase starts (for example "can you tell me", "I'd like to"), treat a dictated phone number as incomplete while its digit grouping is still open, stop treating abbreviations such as "Dr." as sentence-terminal, and treat a stale partial as no evidence rather than incomplete evidence so a lagging provider does not pin the boundary at the emergency cap.

**Blocked by:** 02.

**Status:** done

- [x] Fixture corpus: mid-list phrases are not endpointed at the pause, while completed sentences are.
- [x] While collecting the Patient's phone, grouped digits do not endpoint mid-number; name collection still gets the longer floor.
- [x] A partial ending in an abbreviation is not treated as terminal.
- [x] A stale partial no longer pins the boundary at the emergency cap; replay-bench false-cut and reply-latency metrics hold or improve.

## Comments

- Continuation vocabulary (`src/hybridDetector.ts`): object pronouns
  (`me`/`us`/`him`/`them`, so "can you tell me" holds; `you` deliberately
  excluded so "thank you" stays complete), dangling verbs (`tell`/`like`/
  `want`/`need` + inflections, `wondering`, booking `book`), modifiers
  (`not`/`never`/`just`/`also`/`still`/`even`/`only`/quantifiers/`than`),
  and contraction fragments (`don't`→`don t`, `I'm`→`i m`).
- Abbreviations: terminal `.` on `mr/mrs/ms/dr/st/vs/rs/e.g./i.e.` is not
  sentence-terminal. Bare `No.` stays a complete answer; `Room No.` holds.
  Over-hold residual (e.g. `Main St.` at utterance end) is bounded by the
  staleness budget.
- Phone grouping: `isSemanticallyComplete(text, { collectingPhone })`;
  mostly-digits with <10 digits holds, 10-13 endpoints unless a trailing
  separator/extension cue says more is coming. `src/live.ts` `setDialogue`
  arms the flag only when the name is settled and the phone is still open;
  name collection keeps the 600 ms floor alone.
- Stale partial: `TurnTaking` arrival clock in sample counts
  (`processedSamples`/`lastPartialAtSamples`, never wall-clock); evidence
  older than `stalePartialMs: 1300` counts as no evidence. 1300 (not a few
  hundred) is the smallest budget that preserves the bench's 1200 ms held
  mid-utterance pause with deterministic margin while releasing stalled
  Turns ~200 ms before the 1500 ms cap; a few-hundred-ms budget false-cuts
  `long-pause` (verified: emits mid-pause at 500 ms).
- Bench (`npm run turn-bench`): false-cut 0.0% (0/12) holds; reply p50
  280 ms holds, p95 1480→1300 ms improves (both pause scenarios now release
  at the stale budget); echo-gate PASS, self-echo 0 PASS.
- Tests: `test/hybridDetector.test.ts` (continuation/abbreviation/phone
  tables), `test/turnTakingHybrid.test.ts` (frame-accurate corpus, phone,
  abbreviation, stale-vs-fresh), `test/liveHybrid.test.ts` (stale release,
  phone collection end to end), `test/turnBench.test.ts` (long-pause now
  expects ~1300 ms). Full suite 520 pass, 0 skipped.
