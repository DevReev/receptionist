# 02: Bench metrics, Echo-mix generator, baseline

**What to build:** The benchmark harness learns to measure the turn-taking qualities this feature promises, and a baseline is recorded on the current pre-change build so later tickets can be judged against real numbers. A synthetic Echo-mix generator contaminates captured Caller fixtures with the outbound reference at varied delay and attenuation.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Bench reports false-cut rate and reply latency p50/p95, and defines and reports stop latency, Backchannel false-stop, and Echo false-stop (degenerate on the pre-change build — that is the baseline record).
- [ ] Echo-mix generator builds fixtures from captured utterances plus a reference signal, parameterised by delay and attenuation.
- [ ] Baseline numbers are recorded with the build they came from.
- [ ] The live loop's behaviour is untouched.
