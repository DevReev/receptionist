# Live speakerphone acceptance (ticket 10)

Build: `e7170ca` plus the ticket-10 working tree (stamped `e7170ca-dirty` while
uncommitted; the reviewed tree is the one these files sit in)
Date: 2026-09-17
Scenario: `bench-scripts/10-live-scenario.md`
Synthetic metrics: `bench-scripts/turn-bench-acceptance.json`
Live metrics: `bench-scripts/10-live-call.json` (written after the call)
Baseline: `bench-scripts/01-turn-taking-baseline.md` (`d5b1c1a`, pre-change)

## Synthetic gates

Run: `TURN_BENCH_JSON=bench-scripts/turn-bench-acceptance.json npm run turn-bench`
(11 scripted scenarios, 35 captured Caller fixtures, real `LiveCallSession`).

| Metric | Baseline `d5b1c1a` | Acceptance `e7170ca` | Gate | Verdict |
| --- | --- | --- | --- | --- |
| False-cut rate | 11.1% (1/9) | 0.0% (0/10) | 0 | PASS |
| Reply latency p50 / p95 | 980 ms / 980 ms (n=8) | 280 ms / 1480 ms (n=10) | p50 < baseline | PASS |
| Stop latency p50 / p95 | none (missed 3) | 180 ms / 180 ms (missed 0) | every content Barge-in stops | PASS |
| Backchannel false-stop | 0.0% (0/1) | 0.0% (0/1) | 0 | PASS |
| Backchannels absorbed | 0 | 1 | ≥ 1 | PASS |
| Echo false-stop | 0.0% (0/3) | 0.0% (0/3) | 0 | PASS |
| **Self-Echo Turns** | 0 | **0** | **0 (hard)** | **PASS** |
| Echo-gate false-pass | — | 0.0% (0/102) | ≤ 5% | PASS |
| Echo-gate false-block | — | 2.5% (1/40) | ≤ 5% | PASS |

The two latency numbers that look like regressions are not: `p95 1480 ms` is
the scripted `long-pause`/`short-pause` scenarios waiting out a real mid-sentence
pause (the baseline answered *through* them at a false cut), and `missed 0` is
the bench now stopping on every content Barge-in where the baseline never
stopped at all. `stop p50 180 ms` is the 200 ms Barge-in candidate taken the
frame it completes, at the bench's 20 ms frame resolution.

## Hard safety gates

| Gate | Evidence | Verdict |
| --- | --- | --- |
| Zero Bookings from an interrupted readback | `test/liveBargeIn.test.ts` "an interrupted readback can never authorize a Booking" (barge-in clears the readback, the following Turn proposes nothing); `test/dialogue.test.ts` rejects a bare yes after an interrupted readback and re-reads instead. Full suite 461/461. | PASS |
| Zero self-Echo-triggered Turns (synthetic) | Bench `safety bar: self-echo Turns == 0 -> PASS (0)` across all three Echo delay/attenuation variants and the double-talk variant. | PASS |

## Live speakerphone call

The user places one real call following `bench-scripts/10-live-scenario.md`
(speakerphone on; greeting Barge-in, steady turn, reply Barge-in, Backchannels,
pure Echo, double-talk, interrupted readback, no-response). Capture: the
CallSid's log slice retained under `bench-scripts/captures/` (gitignored) plus
the utterance WAVs in `debug-audio/`; analysed with
`npm run analyze-call -- --call <SID> --audio-dir debug-audio --json bench-scripts/10-live-call.json`.

### Attempt 1 — environment-aborted, not a feature verdict

Call `CA4aca1ce458c33a3c334c0fd5532d3efe` (2026-09-17 09:38:39Z, retained as
`bench-scripts/captures/CA4aca1ce458c33a3c334c0fd5532d3efe.log`, metrics in
`bench-scripts/10-live-call-attempt1.json`). The Caller stopped at
`09:38:44.187`; the provider boundary became a Turn 1 ms later; the assistant
round then produced no first token inside the 6 s Turn deadline and was
aborted (`llm done ms 6006 chars 0 detail "This operation was aborted"`), so
only the 3 s hold line played. Turn 2 reached a first token at 3.08 s and the
Caller hung up at `09:39:06.637`. Trace evidence: provider boundary 63 ms after
speech end, `phase assistant hold` at +3.07 s, no reply audio. Root cause was
the assistant provider, not turn-taking: a direct OpenRouter probe of
`deepseek/deepseek-v4-flash-0731` immediately after the call took 20.2 s to
first content, while a second probe a minute later took 1.4 s. Separately, the
availability prefetch failed (`fetch failed`) because the local Picktime Tool
API at `127.0.0.1:4101` was down; it was started (memory driver) before the
retry. The scenario steps after the greeting were never exercised.

### Attempt 2 — provider 429, environment-aborted

Call `CAc63b9d1afdca23158b409e638d59ff50` (09:43:17Z, capture
`bench-scripts/captures/CAc63b9d1afdca23158b409e638d59ff50.log`, metrics
`bench-scripts/10-live-call-attempt2.json`). Turn-taking traces were healthy:
availability prefetch succeeded (5291 chars, 780 slots), the provider boundary
opened Turn 1, speculation started from the partial "Hello, what" and aborted
correctly on the deterministic Turn, and the 3 s hold line played. Then the
assistant round failed with `openrouter-http-429` ("deepseek/deepseek-v4-flash-0731
is temporarily rate-limited upstream") at +5.9 s, the failure line played, and
the session closed `failure`. A direct probe right after returned 200 in
1.1 s, so the limit is transient. No Barge-in, Backchannel, Echo, or readback
step was reached.

### Attempt 3 — real bug found: speech during generation was dropped

Call `CAc9d8802c8c7eb9c62ccd348c4bd8d08b` (09:44:58Z, capture
`bench-scripts/captures/CAc9d8802c8c7eb9c62ccd348c4bd8d08b.log`, metrics
`bench-scripts/10-live-call-attempt3.json`). Turn 1 ("Hello") and Turn 2 were
answered (`reply latency p50 2034 ms`) but Turn 3 exposed two defects:

1. The local stall guard took Turn 3's boundary after a >1.2 s pause and REST
   transcribed only "what"; the rest of the question arrived as the provider's
   next utterance while Turn 3's generation was still in flight. `TurnTaking`
   ignored provider `speech_start`/`speech_end` outside listening and dropped
   the captured audio, so the continuation never became a Turn — the Caller
   got no response and had to speak again. Trace evidence: `stall` +
   `utterance-abandoned` + `fallback rest provider-stall turn 3`, then
   `vad-speech-start/end` and a final for `utteranceIdx 4` with no Turn, then a
   second stall for `utteranceIdx 5` creating "turn 4".
2. When the assistant round exceeded the 6 s turn deadline, the abort was
   swallowed by the `isAbortError` early return: no reprompt played (the
   `turn deadline` branch below it was unreachable) and the Turn ended in
   silence. Trace evidence: `llm done ms 6003 chars 0 detail "This operation
   was aborted"` with no following `turn deadline` or reprompt.

Both are fixed on this tree:

- `TurnTaking` now captures a provider-opened utterance heard while a Turn is
  in flight (start/end/frames) and adopts it when the floor returns: an ended
  utterance becomes the next Turn at once, an open one is held for its
  provider boundary. A Barge-in supersedes it, and a detector switch drops it.
- `LiveSession`'s deadline abort now takes the intended reprompt path
  (`turn deadline` + `REPROMPT_LINE`) and clears the active Turn, instead of
  returning silently. A Barge-in abort still returns quietly.

Regression tests: `test/liveProviderVad.test.ts` "answers an utterance that
arrives while a reply is still generating" and "reprompts and keeps answering
when the turn deadline aborts the reply". Full suite 466/466; the synthetic
bench gates above are unchanged by the fix.

### The scripted call

| Metric | Expected | Live |
| --- | --- | --- |
| Reply latency p50 / p95 | below the 980 ms baseline | _pending retry_ |
| Stop latency p50 / p95 | inside the pacing window | _pending retry_ |
| Echo false-stop | 0 | _pending retry_ |
| Backchannel false-stop | 0 | _pending retry_ |
| Interrupted-readback Bookings | 0 | _pending retry_ |
| Stalls / detector switches | traced, tolerated | _pending retry_ |

Any failed gate spawns a follow-up ticket instead of a silent pass.
