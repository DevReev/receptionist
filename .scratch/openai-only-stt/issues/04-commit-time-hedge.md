# 04: Hedge the REST decode from commit

**What to build:** On the streaming path, the REST fallback decode starts when the Turn's audio is committed to the realtime channel, not after an empty final arrives. A non-empty realtime final is still preferred whenever it lands. The win is that an empty final no longer pays the realtime commit-to-final wait and then a fresh REST decode on top; turns 2, 7, and 8 went through that serial path and cost 2.4–3.9 s. Expected outcome: the empty-final turn resolves in about `max(final, REST)` instead of `final + REST` (about 0.6–0.7 s faster on the observed call), with no change for turns whose final lands with text.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] An empty realtime final uses the already-in-flight REST decode; no second REST request starts after the final, and the trace shows the hedge starting no later than commit.
- [x] A non-empty realtime final is used, and REST never replaces it.
- [x] Race edge: an empty REST hedge result arriving before a non-empty realtime final does not win — the session waits for the final (or its timeout) before treating the Turn as no speech.
- [x] Failure behavior is preserved: realtime error falls back to REST, REST error preserves the realtime result, both empty or failed still reaches the miss/reprompt path.
- [x] A latency test with a scripted channel and a delayed REST stub asserts the empty-final Turn does not wait for `final + REST`.
- [x] RUNBOOK guidance for the hedge knob is rewritten: the fallback now starts at commit, and the knob no longer exists to "only fire on genuine stalls".
- [x] `npm run typecheck` and `npm test` pass.
