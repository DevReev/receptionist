# Backchannel absorption record (ticket 06)

Build: `f9d7b16` (ticket-06 Backchannel absorption)
Date: 2026-09-17
Raw metrics: `bench-scripts/turn-bench-backchannel.json`

Compared with the ticket-05 record (`bench-scripts/05-always-on-barge-in.md`,
build `cbe1adc`), where the one declared Backchannel was a false stop.

## Command

`TURN_BENCH_JSON=bench-scripts/turn-bench-backchannel.json npm run turn-bench`

35 captured caller fixtures from `bench-fixtures/` (local, PII — never
committed), 10 scripted scenarios running the real `LiveCallSession`.

```
turn-taking bench  build f9d7b16  fixtures 35
policy: silence 1000ms  min-speech 300ms  max-utterance 30000ms  threshold 0.1  dip 200ms
barge-in: min-speech 200ms  dip-tolerance 200ms  confirm 300ms
echo-gate bars: false-pass <= 5.0%  false-block <= 5.0%  ->  PASS
safety bar: self-echo Turns == 0  ->  PASS (0)

TOTAL                    false-cut 11.1% (1/9)  reply p50 980ms p95 980ms (n=8)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/1)  absorbed 1  echo false-stop 0.0% (0/3)  self-echo 0  gate pass 0.0% (0/102)  gate block 5.0% (2/40)
steady-turn              false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/0)
short-pause              false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/0)
long-pause               false-cut 100.0% (1/1)  reply none (n=0)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/0)
barge-in-reply           false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/10)
barge-in-greeting        false-cut 0.0% (0/0)  reply none (n=0)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/10)
backchannel-reply        false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/1)  absorbed 1  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/10)
echo-return-d60-a-12     false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/1)  self-echo 0  gate pass 0.0% (0/38)  gate block 0.0% (0/0)
echo-return-d120-a-18    false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/1)  self-echo 0  gate pass 0.0% (0/35)  gate block 0.0% (0/0)
echo-return-d240-a-24    false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/1)  self-echo 0  gate pass 0.0% (0/29)  gate block 0.0% (0/0)
double-talk-d120-a-18    false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/0)  absorbed 0  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 20.0% (2/10)
```

## What the numbers mean

- **Backchannel false-stop 0/1 with `absorbed 1`** is the ticket's headline:
  the `backchannel-reply` scenario's declared "mm-hmm" is classified from
  partials and absorbed. The Receptionist is not stopped, so there is no
  `clearPlayback` to attribute and no history/Turn behind it.
- **Every other number is identical to the ticket-05 record**: stop p50/p95
  180 ms (missed 0), echo false-stop 0/3, self-echo 0, gate pass 0 %, gate
  block 5.0 % (the double-talk scenario sitting exactly on the ticket-04 bar).
  Absorption changed nothing about content-bearing Barge-in or the Echo gate.
- The `long-pause` false cut (1/9) is still the fixed 1000 ms local wait that
  ticket 07 replaces.

## How the partial channel is scripted

The bench keeps local Turn boundaries (it has no provider VAD), so the runner
stands in for the provider's partial stream: one declared-span-text partial per
speech/backchannel frame through a fake `RealtimeStt`, with `partialSemantics:
true` on the session. The production carrier is the same session path in
provider VAD mode (`TURN_DETECTION=sarvam`), where the realtime socket streams
the whole audio diet while the floor is watched.

Accepted residual: `TURN_DETECTION=hybrid` (manual-mode socket) does not yet
open utterances for Barge-in candidates, so its Backchannels still take the
floor until partials flow there; ticket 07's detector work owns that seam.

## Coverage landed with this bench

`backchannel.test.ts` (classification table), `liveBackchannel.test.ts`
(absorb with no stop/Turn/history and one trace, short "wait" still fires,
confirm hold then unknown speech takes the floor, a fresh content burst after
an absorbed one still fires, readback affirmatives interrupt), and
`turnBench.test.ts` (the two scenarios above). Full suite 387/387.
