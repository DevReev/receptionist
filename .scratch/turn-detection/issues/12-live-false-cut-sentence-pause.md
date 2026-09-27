# 12: Live false cut at a sentence-boundary pause

**What to build:** Decide and implement the Turn-boundary behavior for a pause
that lands at a complete sentence inside a larger list ("I also wanted to ask
about the fee — [pause] — and whether you have parking"). Live call
`CA132fee8e3e777e11cf583e43f1a66811` (see
`bench-scripts/11-live-partial-channel-report.md`) split this into turn 2
("I also wanted to ask about the fee", endpointed after 900 ms trailing
silence) and turn 3 ("Mm, and whether you have parking"). The ticket-08
completeness policy fired correctly per its rules — the pre-pause text is a
complete sentence — so this is a policy question, not a simple bug: either
hold list prosody across a complete-sentence pause (e.g. list-intonation cues,
a trailing "and"-less continuation, or a longer floor when the prior Turns
show list structure), or rule the split correct and fix the scenario/gate
instead. Whichever way, the bench corpus gains a case for it and the gate is
explicit.

**Blocked by:** None (report and capture retained; analysis in ticket 11).

**Status:** done

- [x] The bench gains a mid-list sentence-pause case with the decided outcome pinned.
- [x] Implementation or scenario/gate fix per the decision, with rationale recorded.
- [x] `npm run turn-bench` false-cut and reply-latency bars hold; `npm test` passes.

## Comments

Decision: bounded (a) — hold the boundary one extra short beat after a
complete sentence ONLY when the partial frames a larger list/question pair.
No merge-repair (b): joining Turns after the endpoint would delay the first
reply and complicate transcription commit, while the hold costs nothing when
the caller keeps talking.

Implementation: `hasListContinuationCue` (`src/hybridDetector.ts`) flags
additives (`also`, `additionally`, `another`, `both`, `plus`), enumerators
(`first`, `second`, `third`), the plural (`questions`), and the phrase `as
well`. Bare `and` is excluded: mid-list it arrives with the continuation,
so it cannot predict one. `listeningBoundaryDue` (`src/turnTaking.ts`)
extends the floor by `listContinuationMs` (800 ms) on a cued partial;
emergency (1500 ms) and stale-partial (1300 ms) caps still bound it above,
and incomplete partials already hold via completeness. Single-question
phrasing without cues (`I wanted to ask about the fee`) still endpoints at
the floor — pinned by test.

Timing evidence (ticket pointer): the capture has no per-partial text
timeline, only endpoint traces (turn 2: speech 1680 ms, trailing 900 ms;
turn 1/4/5 endpoint at 300/200/200 ms). The 900 ms trailing over a ~1 s
wall pause is consistent with speakerphone VAD flicker: noisy pause frames
scored as speech reset the trailing counter (stretching wall time) while
training the adaptive floor upward mid-pause. Either reading (complete
sentence endpointed at a flicker-raised floor, or an incomplete mid-pause
revision released by the stale clock) is covered by the same bounded hold:
floor + 800 ms (1100–1400 ms trailing) spans the ~1 s live pause, while a
finished list costs exactly one short beat.

Measured cost: new bench scenario `mid-list-sentence-pause` replies at
1080 ms (≈ floor + window); aggregate reply p50 280 / p95 1300 ms and all
other bars unchanged. Bench: false-cut 0/13, echo-gate PASS, self-echo 0.
`npm test`: 526 pass, 0 fail.
