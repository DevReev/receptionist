# Always-on Barge-in record (ticket 05)

Build: `cbe1adc` (ticket-05 always-on Barge-in)
Date: 2026-09-17
Raw metrics: `bench-scripts/turn-bench-always-on.json`

Compared with the ticket-02 baseline (`bench-scripts/01-turn-taking-baseline.md`,
build `d5b1c1a`), where every stop metric was degenerate because Barge-in was
off.

## Command

`TURN_BENCH_JSON=bench-scripts/turn-bench-always-on.json npm run turn-bench`

35 captured caller fixtures from `bench-fixtures/` (local, PII — never
committed), 10 scripted scenarios running the real `LiveCallSession`.

```
turn-taking bench  build cbe1adc  fixtures 35
policy: silence 1000ms  min-speech 300ms  max-utterance 30000ms  threshold 0.1  dip 200ms
barge-in: min-speech 200ms  dip-tolerance 200ms
echo-gate bars: false-pass <= 5.0%  false-block <= 5.0%  ->  PASS
safety bar: self-echo Turns == 0  ->  PASS (0)

TOTAL                    false-cut 11.1% (1/9)  reply p50 980ms p95 980ms (n=8)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 100.0% (1/1)  echo false-stop 0.0% (0/3)  self-echo 0  gate pass 0.0% (0/102)  gate block 5.0% (2/40)
steady-turn              false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/0)
short-pause              false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/0)
long-pause               false-cut 100.0% (1/1)  reply none (n=0)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/0)
barge-in-reply           false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/10)
barge-in-greeting        false-cut 0.0% (0/0)  reply none (n=0)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/10)
backchannel-reply        false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 100.0% (1/1)  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 0.0% (0/10)
echo-return-d60-a-12     false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/1)  self-echo 0  gate pass 0.0% (0/38)  gate block 0.0% (0/0)
echo-return-d120-a-18    false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/1)  self-echo 0  gate pass 0.0% (0/35)  gate block 0.0% (0/0)
echo-return-d240-a-24    false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/1)  self-echo 0  gate pass 0.0% (0/29)  gate block 0.0% (0/0)
double-talk-d120-a-18    false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop p50 180ms p95 180ms (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0  gate pass 0.0% (0/0)  gate block 20.0% (2/10)
```

## What the numbers mean

- **Safety bar (new, hard):** zero self-Echo-triggered Turns (`SELF_ECHO_BAR`).
  The three echo-return scenarios declare 40 frames of pure returning Echo
  while the Receptionist speaks; none stops it, none promotes a Turn. This is
  the ticket's "zero self-Echo-triggered Turns in synthetic runs".
- **Stop latency p50/p95 180 ms (missed 0)** across the reply, greeting, and
  double-talk scenarios, inside the transport's 250 ms goal.
- **Echo false-stop 0/3.**
- **Backchannel false-stop 1/1** is the recorded pre-absorption state:
  "mm-hmm" is still real speech to the candidate. Ticket 06 classifies and
  absorbs it.
- **False cut 1/9 (long-pause at 1200 ms)** is the fixed 1000 ms hybrid wait
  that ticket 07 replaces with the caller-adaptive pause.
- **Gate block 5.0% (2/40)** on the double-talk scenario sits exactly on the
  ticket-04 bar; `gate pass 0%` holds.

## Changes the bench forced

1. The first run of this bench **failed the safety bar**: a scenario whose
   fixture tail is near-silence fed "echo" frames the gate called `silence`, and
   the scripted VAD still scored them speech, so an echo-only span was promoted
   into a Turn. Fix: a gate-`silence` frame is never Caller speech, whatever the
   VAD says (`src/turnTaking.ts`).
2. Captured fixtures end in trailing silence; declared interruptions were
   replaying that silence. The runner now skips inaudible slices in the caller
   bank (`speechFrame`), so every declared speech frame carries content.

Accepted residual: Caller frames below the gate's silence floor (RMS 40) cannot
barge in, however the VAD scores them. Measured indirectly by the Echo-gate
bench's caller false-block rate; ticket 10's speakerphone call is the real-audio
check.
