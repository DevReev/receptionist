# 15: List-cue precision

**What to build:** The extra boundary hold after a complete sentence fires only when the partial actually frames a larger list or question pair — not on any lone occurrence of a cue word. Today a finished singleton ("I also need to cancel", "I take both medications") pays the 800 ms hold budgeted for lists, adding dead air to every such Turn. The cue becomes positional: it must frame an open list (enumeration, question pair, additive structure), not merely appear in finished prose.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Finished singletons containing cue words endpoint at the normal floor; a true mid-list sentence pause still holds.
- [x] Bench corpus pins both cases (singleton vs list-pause contrast).
- [x] `npm run turn-bench` false-cut and reply-latency bars hold; `npm test` passes.

## Comments

Positional cue (`hasListContinuationCue`, `src/hybridDetector.ts`): enumerators
and the plural (`first`/`second`/`third`/`questions`) still always frame a
list, and `as well` stays an explicit pair marker. Additives (`also`,
`additionally`, `another`) now count only beside question-pair structure
(`ask`/`question(s)`/`wondering`/`whether`/enumerator), `both` only with its
`and` sibling, and `plus` only joining or trailing (never sentence-initial).
So "I also need to cancel" and "I take both medications" endpoint at the 300
ms floor, while "I also wanted to ask about the fee" still holds floor + 800
ms. `listeningBoundaryDue` (`src/turnTaking.ts`) untouched (read-only).

Bench: new `singleton-cue-sentence` scenario (two cue-word singletons, 0/2
false-cut, reply 280 ms) contrasts `mid-list-sentence-pause` (1080 ms hold,
0/1). Isolated run (HEAD + this ticket only): TOTAL false-cut 0/15, reply p50
280 / p95 1300, echo-gate PASS, self-echo 0. `npm test`: 528 pass, 0 fail.
Note: the shared tree concurrently carries tickets 14/16/17 (uncommitted);
a bench run there shows self-echo 3 + missed stops, absent from the isolated
HEAD + ticket-15 run, so attributable to those concurrent speech-path changes
rather than this ticket. This commit stages only the
ticket-15 hunks; unrelated `CONTEXT.md` edit left untouched.
