# 02: Bench metrics, Echo-mix generator, baseline

**What to build:** The benchmark harness learns to measure the turn-taking qualities this feature promises, and a baseline is recorded on the current pre-change build so later tickets can be judged against real numbers. A synthetic Echo-mix generator contaminates captured Caller fixtures with the outbound reference at varied delay and attenuation.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Bench reports false-cut rate and reply latency p50/p95, and defines and reports stop latency, Backchannel false-stop, and Echo false-stop (degenerate on the pre-change build — that is the baseline record).
- [x] Echo-mix generator builds fixtures from captured utterances plus a reference signal, parameterised by delay and attenuation.
- [x] Baseline numbers are recorded with the build they came from.
- [x] The live loop's behaviour is untouched.

## Comments

Implemented: `src/turnBench.ts` (metrics, scenario runner at the fake-driver
seam, report), `src/echoMix.ts` (`mixEcho`), `scripts/turn-bench.ts`,
`scripts/echo-fixtures.ts`, and the unit/driver suites. Baseline run on
`d5b1c1a` is recorded in `bench-scripts/01-turn-taking-baseline.md` with the
raw metrics in `bench-scripts/turn-bench-baseline.json` and the report summary.
Degenerate as expected while Barge-in is off: stop latency has no samples,
false-stop rates are structurally zero, reply p50 is the fixed 980 ms, and the
only false cut is the 1200 ms mid-thought pause. Later tickets compare against
this file; the booking-safety gate lands with the booking scenarios.
