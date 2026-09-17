# Hybrid detector record (ticket 07)

Build: `6aed6f3` (ticket-07 hybrid detector; the bench stamped
`6aed6f3-dirty` because an unrelated `AGENTS.md` working-tree edit was
present — the reviewed tree is that commit)
Date: 2026-09-17
Raw metrics: `bench-scripts/turn-bench-hybrid.json`

Compared with the ticket-02 baseline (`bench-scripts/01-turn-taking-baseline.md`,
build `d5b1c1a`), which waited out the fixed 1000 ms local silence.

## Command

`TURN_BENCH_JSON=bench-scripts/turn-bench-hybrid.json npm run turn-bench`

35 captured caller fixtures from `bench-fixtures/` (local, PII — never
committed), 10 scripted scenarios running the real `LiveCallSession`. The bench
runs the local detector (manual realtime channel), so this is the hybrid rule
end to end.

```
turn-taking bench  build 6aed6f3-dirty  fixtures 35
policy: silence 1000ms (Barge-in candidate reset)  min-speech 300ms  max-utterance 30000ms  threshold 0.1  dip 200ms
detector: hybrid local  adaptive pause 150-600ms (default 300ms, emergency 1500ms)  field floor 600ms
barge-in: min-speech 200ms  dip-tolerance 200ms  confirm 300ms
echo-gate bars: false-pass <= 5.0%  false-block <= 5.0%  ->  PASS
safety bar: self-echo Turns == 0  ->  PASS (0)

TOTAL                    false-cut 0.0% (0/9)  reply p50 280ms p95 1480ms (n=9)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/1)  absorbed 1  echo false-stop 0.0% (0/3)  self-echo 0  gate pass 0.0% (0/102)  gate block 5.0% (2/40)
steady-turn              false-cut 0.0% (0/1)  reply p50 280ms p95 280ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/0)
short-pause              false-cut 0.0% (0/1)  reply p50 1480ms p95 1480ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/0)
long-pause               false-cut 0.0% (0/1)  reply p50 1480ms p95 1480ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/0)
barge-in-reply           false-cut 0.0% (0/1)  reply p50 280ms p95 280ms (n=1)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/10)
barge-in-greeting        false-cut 0.0% (0/0)  reply none (n=0)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/10)
backchannel-reply        false-cut 0.0% (0/1)  reply p50 280ms p95 280ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/1)  absorbed 1  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/10)
echo-return-d60-a-12     false-cut 0.0% (0/1)  reply p50 280ms p95 280ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/1)  self-echo 0  gate pass 0.0% (0/38)  gate block 0.0% (0/0)
echo-return-d120-a-18    false-cut 0.0% (0/1)  reply p50 280ms p95 280ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/1)  self-echo 0  gate pass 0.0% (0/35)  gate block 0.0% (0/0)
echo-return-d240-a-24    false-cut 0.0% (0/1)  reply p50 280ms p95 280ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/1)  self-echo 0  gate pass 0.0% (0/29)  gate block 0.0% (0/0)
double-talk-d120-a-18    false-cut 0.0% (0/1)  reply p50 280ms p95 280ms (n=1)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 20.0% (2/10)
```

## What the numbers mean

- **False cut 0/9 (baseline 1/9, ticket 05 1/9).** `long-pause` no longer
  false-cuts: the partial "my number is" ends on a continuation cue, so the
  1200 ms pause is held open and the Turn lands on the emergency cap instead.
  `short-pause` stays 0.
- **Reply p50 280 ms (baseline 980 ms), below the fixed wait the baseline note
  asked to beat.** The steady, barge-in, Backchannel, echo and double-talk
  scenarios all answer at the adaptive default floor.
- **Reply p95 1480 ms.** `short-pause` ("book for") and `long-pause` ("my number
  is") both end at the 1.5 s cap because the bench's scripted partial never
  improves past the declared fragment. On a real stream the resumed words update
  the partial, so a caller who finishes the thought is not held to the cap. This
  is the price of the accepted rule: an incomplete-looking partial waits.
- **Safety and gates unchanged:** self-echo Turns 0, echo false-stop 0/3,
  Backchannel absorbed 1 with 0 false stops, gate pass 0%, gate block 5.0%
  (2/40, exactly on the ticket-04 bar).
- **Stop latency p50/p95 180 ms, missed 0**, unchanged from tickets 05/06.

## Comparison points

| Metric | Baseline `d5b1c1a` | Ticket 05/06 | This record |
| --- | --- | --- | --- |
| False cut | 11.1% (1/9) | 0.0% (0/9) | 0.0% (0/9) |
| Reply p50 | 980 ms | 980 ms | 280 ms |
| Reply p95 | 980 ms | 980 ms | 1480 ms |
| Stop p50 | none | 180 ms | 180 ms |
| Backchannel false-stop | 0/1 (degenerate) | 0/1 | 0/1, absorbed 1 |
| Echo false-stop | 0/3 (degenerate) | 0/3 | 0/3 |
| Self-echo Turns | 0 | 0 | 0 |

The local detector's fixed silence is gone from the boundary path; the
`policy: silence 1000ms` line now only configures the Barge-in candidate reset.
Ticket 08's stall guard builds on this detector for provider stalls; ticket 10
compares a real speakerphone call against this file.

Accepted residual: hybrid Barge-in while watching stays energy-only. The manual
socket opens no utterance while the Receptionist speaks, so Backchannel partials
do not flow there; the bench's Backchannel absorption rides the ticket-06
provider-VAD path. The `short-pause`/`long-pause` held-to-cap latencies are the
other cost of the rule; a real partial stream improves as the caller resumes, so
only calls that truly end on a fragment pay it.
