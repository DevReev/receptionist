# Echo-gate classification record (ticket 04)

Build: `ea44cf0` (ticket-04 Echo gate)
Date: 2026-09-17
Raw metrics: `bench-scripts/echo-gate-bench.json`, `bench-scripts/turn-bench-echo-gate.json`

Agreed bars (defined in `src/turnBench.ts`: `ECHO_GATE_BARS`): **false-pass <= 5%**
of pure-Echo frames passed as Caller, and **false-block <= 5%** of Caller-dominant
frames blocked as Echo. Both runs below meet them on this build.

## Fixture classification bench

Command: `ECHO_GATE_BENCH_JSON=bench-scripts/echo-gate-bench.json npm run echo-gate-bench`
Fixtures: 35 captured Caller utterances from `bench-fixtures/` (local, PII — never
committed). Reference: synthetic Receptionist voice (4 s). Variants: delays
60/120/240 ms x attenuations -12/-18/-24 dB, one fresh gate per case.

```
echo-gate bench  callers 35  reference synthetic  variants 3x3
frames: pure-echo 47649  caller 12318 (double-talk 4935)  silence 2589  decisions 67491
false-pass 3.3% (1577/47649)  false-block 0.3% (41/12318)  ->  PASS
```

Labels are energy-relative: **pure Echo** means Caller energy is below a quarter
of the return, **Caller** means Caller energy dominates the return, and frames
in between are **double-talk**, reported but not scored because neither
classification is wrong there. Without fixtures the bench synthesizes both
sides, so it always produces numbers; only the local run reflects captured
audio.

## Driver-seam gate metrics

Command: `TURN_BENCH_JSON=bench-scripts/turn-bench-echo-gate.json npm run turn-bench`
The scripted scenarios run the real `LiveCallSession`; the gate classifies the
declared Echo spans and the declared Caller-while-speaking spans (Barge-in and
Backchannel declarations).

```
gate pass 0.0% (0/128)  gate block 0.0% (0/42)      TOTAL across 10 scenarios
```

The per-scenario lines are in the JSON. Barge-in is still off on this build, so
`stop latency` and the false-stop rates remain degenerate; ticket 05 turns the
gate decisions into behaviour.

## What later tickets compare against

- Ticket 05: zero self-Echo-triggered Turns in synthetic runs; stop latency
  inside the pacing window. The gate bars above are the classification floor
  for that work; a decision change that pushes either rate past 5% should fail
  the bench.
- Ticket 07 (hybrid): the same gate must keep Echo out of the local detector's
  candidate path.
- Ticket 10 (live): rerun both benches after the speakerphone call and compare.
