# 07: Hybrid detector

**What to build:** `TURN_DETECTION=hybrid` gives the operator a local detector as the primary boundary source, with the socket in manual mode. Endpointing requires a caller-adaptive pause — 1.25 × p90 of the Caller's last 8 completed intra-utterance pauses, clamped 150-600 ms, defaulting to 300 ms until 3 pauses are observed, with a 1.5 s emergency cap — combined with semantic completeness from partials. While collecting Patient name or phone the floor rises to 600 ms. Selectable without a code change; provider VAD remains the default.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] With the flag set, scripted calls end Turns on the adaptive rule; the measured pause tracks the Caller's own pause rhythm in fixtures.
- [ ] Mid-thought pauses do not false-cut; dictated names and grouped digits are not split across Turns.
- [ ] The 1.5 s emergency cap emits regardless of other signals.
- [ ] `TURN_DETECTION=sarvam` remains the default and its behaviour is unchanged.
