# 04: Echo gate and outbound reference

**What to build:** The Receptionist can tell its own voice returning through the Caller's phone from the Caller actually speaking. Played audio is retained as an outbound reference, and every inbound frame during Receptionist speech is classified Echo or not-Echo using a learned return level plus correlation against the reference at an adaptive delay. Decisions are traced. The call stays half-duplex for now: this ticket changes no stop or segmentation behaviour and cannot false-stop on its own.

**Blocked by:** 03.

**Status:** ready-for-agent

- [x] Echo-mixed fixtures and scripted inbound produce correct classifications: Echo frames flagged, clean Caller speech passed.
- [x] Trace lines record each gate decision with the evidence used.
- [x] Classification accuracy on fixtures meets the agreed bar, with false-pass and false-block rates recorded.
- [x] Segmentation, stop behaviour, and history are untouched.

## Comments

Implemented. `src/echoGate.ts` is the per-call gate: it retains played outbound
frames as a reference ring, searches delays 0-600 ms for the best normalized
cross-correlation (locked tracking once found, full rescan after three weak
frames), correlates over the previous plus current 20 ms frame, and combines
that with a learned echo-return level (EMA, re-learned on a near-perfect match
so an earpiece-to-speakerphone level jump does not lock the gate out). Reasons:
`echo`, `silence`, `no-reference`, `uncorrelated`, `double-talk`.

The reference is true playout: `TwilioMediaTransport` gained `onFrameSent`,
wired through `StreamObserver.onOutboundFrame` and the server into
`LiveCallSession.retainReference` -> `TurnTaking.retainReference`. `TurnTaking`
classifies every inbound frame while it holds the floor (muted or
watching-barge-in, including pending Barge-in), feeds listening-mode frames to
the gate's history, and emits `onEchoDecision`; the session traces each decision
as `component:"echo-gate", event:"decision"` with correlation, delayMs, RMS
levels, residual, learned return loss, threshold, and margin.

Passive by design: no stop, segmentation, upstream-frame, or history path reads
a decision. `tests`: `echoGate.test.ts` (table unit), `turnTakingEchoGate.test.ts`
(driver: echo flagged, Caller passed, no utterances/stops/upstream),
`liveEchoGate.test.ts` (trace evidence), `turnBench` scenarios and gate metrics
(`gate pass`/`gate block` in the report), `echoGateBench.test.ts` +
`scripts/echo-gate-bench.ts` (fixture accuracy), `transport.test.ts`
(played-frame reference). `ECHO_GATE_CORRELATION` (0.7),
`ECHO_GATE_LEVEL_MARGIN_DB` (6), and `ECHO_GATE_MAX_DELAY_MS` (600) are env
knobs with RUNBOOK rows. Agreed bars: false-pass <= 5%, false-block <= 5%.
Recorded: `bench-scripts/04-echo-gate.md`.
