# 01: TurnTaking seam

**What to build:** The Stream session's turn-taking surface moves behind one deep module that owns the local VAD gate, utterance segmentation, and interruption-candidate state. Behaviour is identical to today (fixed local Endpointing, no Barge-in); the session keeps orchestration only. This is the expand half of the refactor: later tickets change behaviour inside the new module instead of rewiring the session.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] A live Turn completes exactly as today through the new module: same Endpointing defaults, same audio routing, same reply path.
- [ ] The Stream session no longer touches endpointing internals directly; the `Vad` seam is unchanged.
- [ ] Existing live, Endpointing, and interruption suites pass, moved to the new seam where they assert internals.
- [ ] No Caller-observable behaviour change on a smoke call.
