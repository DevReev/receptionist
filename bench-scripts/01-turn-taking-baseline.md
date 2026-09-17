# Turn-taking bench baseline (ticket 02)

Build: `d5b1c1a` (ticket-02 bench apparatus; live loop unchanged since `a7b780e`)
Date: 2026-09-17
Command: `TURN_BENCH_JSON=bench-scripts/turn-bench-baseline.json npm run turn-bench`
Fixtures: 35 captured Caller utterances from `bench-fixtures/` (local, PII — never committed)
Raw metrics: `bench-scripts/turn-bench-baseline.json`

Policy knobs mirror the shipped configuration (`.env`): `ENDPOINT_SILENCE_MS=1000`,
`ENDPOINT_MIN_SPEECH_MS=300`, `ENDPOINT_MAX_UTTERANCE_MS=30000`,
`VAD_SPEECH_THRESHOLD=0.1`, `ENDPOINT_LATCH_DIP_MS=200`, `BARGE_IN=false`,
`BARGE_IN_SPEECH_MS=200`.

```
turn-taking bench  build d5b1c1a  fixtures 35
policy: silence 1000ms  min-speech 300ms  max-utterance 30000ms  threshold 0.1  dip 200ms
note: Barge-in is off — stop latency and false-stop rates are degenerate (the baseline record).

TOTAL                    false-cut 11.1% (1/9)  reply p50 980ms p95 980ms (n=8)  stop none (missed 3)  backchannel false-stop 0.0% (0/1)  echo false-stop 0.0% (0/3)  self-echo 0
steady-turn              false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0
short-pause              false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0
long-pause               false-cut 100.0% (1/1)  reply none (n=0)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0
barge-in-reply           false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 1)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0
barge-in-greeting        false-cut 0.0% (0/0)  reply none (n=0)  stop none (missed 1)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0
backchannel-reply        false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/1)  echo false-stop 0.0% (0/0)  self-echo 0
echo-return-d60-a-12     false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/1)  self-echo 0
echo-return-d120-a-18    false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/1)  self-echo 0
echo-return-d240-a-24    false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 0)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/1)  self-echo 0
double-talk-d120-a-18    false-cut 0.0% (0/1)  reply p50 980ms p95 980ms (n=1)  stop none (missed 1)  backchannel false-stop 0.0% (0/0)  echo false-stop 0.0% (0/0)  self-echo 0
```

## Definitions

- **False cut** — a reply's first outbound audio lands inside a declared Caller
  utterance. The whole-utterance rate is `false cuts / Caller utterances`.
- **Reply latency** — declared Caller speech end → first outbound reply frame;
  p50/p95 over replies that were not false cuts.
- **Stop latency** — interruption speech start → `clearPlayback`; `missed` counts
  content interruptions that never stopped the Receptionist.
- **Backchannel false-stop** — a `clearPlayback` inside a declared Backchannel
  span; rate is stopped Backchannels / Backchannels.
- **Echo false-stop** — a `clearPlayback` inside a returned-Echo span; rate is
  stopped Echo spans / Echo spans. **Self-echo Turns** counts Turns whose audio
  came from Echo rather than the Caller. Both must stay 0.
- Clear attribution is content-first and once per span: a clear in a Caller
  interruption that overlaps Echo counts as a stop, not an Echo false-stop.

## How the scenarios run

`scripts/turn-bench.ts` drives the real `LiveCallSession` (real `TurnTaking` and
dialogue) with a scripted VAD, stub STT/TTS, and frame-gated playback, so every
number is caller-observable behavior at the pre-agreed fake-driver seam. No
provider network is involved. Echo is synthesized from the session's own
outbound reference via `mixEcho` at 60 ms/-12 dB, 120 ms/-18 dB, 240 ms/-24 dB,
plus a double-talk variant (Caller speech over the 120 ms/-18 dB return).
Captured fixtures supply Caller speech frames when `bench-fixtures/` is present;
synthetic speech is the fallback on a fresh clone.

`scripts/echo-fixtures.ts` additionally writes standalone echo-contaminated
fixture files plus sidecars (source, reference, delay, attenuation, Echo span)
from captured utterances and a supplied reference signal, parameterised by
`ECHO_DELAYS_MS` and `ECHO_ATTENUATIONS_DB`, for the Echo-gate classification
work in ticket 04.

## Degenerate on this build

Barge-in is off in the shipped configuration, so:

- `stop none (missed 3)` means the Receptionist never stops; stop latency has no
  samples and is not a healthy zero.
- Backchannel and Echo false-stop rates are structurally zero: nothing can stop,
  so nothing was checked. Ticket 05 turns these into real measurements.

## What later tickets compare against

- Ticket 03 (`vad` mode) / 07 (hybrid): reply p50/p95 should drop below the
  fixed 980 ms and `long-pause` false cuts should go to 0 while `short-pause`
  stays 0.
- Ticket 05: `missed` → 0 with stop latency inside the pacing window; Echo
  false-stops and self-echo Turns stay 0 at all three delay/attenuation variants.
- Ticket 06: Backchannel false-stops stay 0 and Backchannels still never open
  Turns.
- Ticket 10 (live): compare the speakerphone call's numbers against this file.

Hard safety gates (zero Bookings from an interrupted readback, zero
self-Echo-triggered Turns) are reported for self-Echo here; the Booking gate
lands with the booking scenarios in later tickets, since the baseline assistant
never books.
