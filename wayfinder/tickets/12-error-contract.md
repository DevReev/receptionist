---
label: wayfinder:build
status: open
parent: ../map.md
blocked-by: [11-full-live-turn.md]
assignee:
---

# 12: Error contract on the live path

**What to build:** the legacy error contract, carried over verbatim to the Stream session — bounded reprompts then handoff, console-log-first failures, polite session ends, and no double-booking — so a Caller on the live path is never left on a dead call and the clinic never misses a failure.

**Blocked by:** 11 (needs the full Turn to exercise mid-Turn failures).

**Spec:** `06-live-streaming-voice-loop.md`.

- [ ] Two unintelligible utterances → reprompts, third miss → handoff line and session end, all logged.
- [ ] Mid-Turn downstream failure writes the console log first, then speaks the clinic-will-confirm line and ends the session.
- [ ] Caller hangup / dropped socket logs the partial Turn.
- [ ] Booking writes stay single-attempt per confirmed intent under failure.
- [ ] Verified through the fake driver against the Turn/failure log collectors.
