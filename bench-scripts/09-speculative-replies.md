# Speculative replies record (ticket 09)

Build: `a572ba5` plus the ticket-09 working tree (the stamp reads
`a572ba5-dirty` because the ticket is uncommitted; the reviewed tree is the
one these files sit in)
Date: 2026-09-17
Raw metrics: `bench-scripts/turn-bench-speculative.json` (on),
`bench-scripts/turn-bench-no-speculation.json` (off)

Compared with the ticket-07 hybrid detector record
(`bench-scripts/07-hybrid-detector.md`, build `6aed6f3`), which has no
speculation and no provider-final delay.

## Commands

```
TURN_BENCH_JSON=bench-scripts/turn-bench-speculative.json npm run turn-bench
TURN_BENCH_JSON=bench-scripts/turn-bench-no-speculation.json \
  TURN_BENCH_SPECULATION=false npm run turn-bench
```

35 captured caller fixtures from `bench-fixtures/` (local, PII — never
committed), 11 scripted scenarios running the real `LiveCallSession`. The new
`speculative-faq` scenario scripts a provider that holds its final for 30
frames (600 ms) after the Turn boundary: the speculation path answers from the
partial, the control waits the final out.

## The comparison

```
speculation: on  (clearly non-booking partials answer early)
speculative-faq   reply p50 280ms p95 280ms (n=1)   ...
TOTAL             reply p50 280ms p95 1480ms (n=10) ...
```

```
speculation: off (every reply waits for its final)
speculative-faq   reply p50 880ms p95 880ms (n=1)   ...
TOTAL             reply p50 280ms p95 1480ms (n=10) ...
```

- **`speculative-faq` 280 ms vs 880 ms.** Both runs pay the same 280 ms
  adaptive local boundary; the control then waits the scripted 600 ms provider
  final before generation starts. With speculation on, generation started from
  the partial during the Caller's speech and the reply audio begins at the
  boundary — 600 ms before the final lands.
- **TOTAL p50/p95 unchanged** (280 ms / 1480 ms): only the new scenario
  carries provider-final latency; every other scenario's reply already started
  at its boundary.
- **Everything else unchanged:** false-cut 0/10, stop p50 180 ms missed 0,
  Backchannel absorbed 1 with 0 false stops, echo false-stop 0/3, self-echo 0,
  echo-gate bars PASS (pass 0.0%, block 2.5% = 1/40, inside the ticket-04 bar).
  The `double-talk` run shows 10.0% (1/10) block, one frame inside the bar,
  same as ticket 07.

## What this bench does not cover

- The provider-final delay is scripted (30 frames), not measured from Sarvam;
  it stands in for the observed end-of-turn → final gap the speculation hides.
- The assistant and TTS are stubs with no first-token latency, so the run
  isolates the final-wait saving. A real-call check belongs to ticket 10.
- Disagreement cost (abort + regenerate) is covered by
  `test/liveSpeculation.test.ts`, not by this latency corpus.
