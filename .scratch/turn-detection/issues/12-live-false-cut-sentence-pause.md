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

**Status:** ready-for-agent

- [ ] The bench gains a mid-list sentence-pause case with the decided outcome pinned.
- [ ] Implementation or scenario/gate fix per the decision, with rationale recorded.
- [ ] `npm run turn-bench` false-cut and reply-latency bars hold; `npm test` passes.
