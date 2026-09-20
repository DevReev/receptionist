# 03: Local detector is the only Turn boundary authority

**What to build:** With no provider-VAD channel left, the local detector always owns Turn boundaries. The `TURN_DETECTION` switch, the stall grace, provider boundary events, endpointing mode switching, the stall guard and its two-strike escalation, and utterance abandonment are all unreachable and are deleted. Local turn-taking behavior is unchanged: adaptive pause, barge-in, backchannel absorption, and the no-partials floor.

**Blocked by:** 02 (removes the last provider-VAD channel).

**Status:** ready-for-agent

- [ ] No config env or trace field remains for provider VAD, endpointing mode switching, or detector escalation; `.env` and the RUNBOOK env table are updated.
- [ ] The realtime channel contract has one boundary story: the local detector opens and closes utterances and the channel only streams audio and finalizes.
- [ ] Turn-taking behavior suites (turn, barge-in, backchannel, speculation, no-response, hybrid detector) pass against the simplified contract.
- [ ] Provider-VAD and stall-guard suites are deleted, not skipped, and no reference to a provider-owned boundary mode remains in the turn-taking code.
- [ ] `npm run typecheck` and `npm test` pass.
