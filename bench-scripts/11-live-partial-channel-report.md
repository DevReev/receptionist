# Live partial-channel validation report (ticket 11)

Call `CA132fee8e3e777e11cf583e43f1a66811`, 2026-09-27 13:56:34Z, speakerphone,
~2.5 min, 15 Turns. Server: tree at `e86e0ea` + `1f693ca` + `865ffc1` +
`96c6019` (tickets 07–10), rebuilt per RUNBOOK. Capture retained at
`bench-scripts/captures/CA132fee8e3e777e11cf583e43f1a66811.log` (gitignored,
4194 lines); utterance WAVs in `debug-audio/CA132…-{turn}.wav` (15/15 audible);
metrics in `bench-scripts/11-live-call.json`.

## What held

- **Local boundary authority 15/15.** Zero provider boundaries; every Turn was
  endpointed by the caller-adaptive pause + partial completeness. All 15 finals
  came from the realtime channel (`source: realtime`, 605–1012 ms each); the
  REST hedge never had to supply a transcript.
- **Speculative reply with audio before the final.** Turn 2 ("I also wanted to
  ask about the fee", 35 chars, 9 partials): `speculation-start` (non-booking),
  first reply audio at 13:56:52.581, final resolved 13:56:53.172,
  `speculation-kept` (ms 1831). Two more speculations started later and aborted
  correctly (`deterministic-turn`); one aborted on `caller-barge-in`. No
  speculative text reached history; no Booking was proposed or written (0/0).
- **Every content Barge-in stopped playback.** 6 barge-ins, 6
  `playback-cleared` + `clear-sent`, 0 self-Echo barge-ins. Stop latency
  p50 620 / p95 680 ms (n=6) vs synthetic 180 ms: the difference is the live
  candidate buildup (200 ms pre-trigger + 300 ms partial-confirm + pacing),
  not a regression — functionally every interruption stopped.
- **Echo discipline.** Echo false-stop 0; self-Echo Turns 0 (3545 gate frames).
- **Provider resilience.** Turn 14 hit a Groq 429 (`gpt-oss-120b` TPM limit);
  `http-retry` 300/600 ms backoff fired and the Turn recovered and spoke.
  Availability prefetch succeeded (2506 chars).

## Failures (each spawns a follow-up ticket)

1. **False cut on the step-2 mid-list pause → ticket 12.** Turn 2 endpointed
   after 900 ms trailing silence ("I also wanted to ask about the fee");
   turn 3 continued "Mm, and whether you have parking". Nuance: the pre-pause
   text is a complete sentence, so the ticket-08 completeness policy fired
   exactly as designed — the scenario's pause landed at a sentence boundary,
   not mid-phrase. The gate as scripted still fails: one list, two Turns.
2. **Backchannel false-stop, zero absorptions → ticket 13.** Turn 6 ("Mhm
   okay", 8 chars, 3 partials) took the floor: barge-in fired on energy with
   `candidateMs` 620 ≈ pre-trigger + confirm-window expiry, and the reply
   answered it ("We have openings…") instead of absorbing. No `backchannel`
   event fired on the entire call. On live speakerphone audio the partial
   semantics did not arrive or classify inside the 300 ms confirm window, so
   energy alone took the floor.

## Observations (no ticket)

- **Reply latency p50 2064 / p95 4215 ms (n=14)** vs synthetic p50 280 ms is
  provider-dominated, not turn-taking: transcription ~800 ms + LLM first token
  ~750 ms + full-generation tail (`assistant done` 2.6–8.1 s on
  `gpt-oss-120b`) + Sarvam TTS first audio. The speculative path demonstrably
  hid the final wait on turn 2. Reply-length control was already out of scope
  (openai-only-stt spec); no silent pass — recorded here.
- **Interrupted-readback gate untested.** The booking flow reached
  collecting-patient (name "Bobby" captured, phone partially dictated) but the
  user hung up before any readback, so 0 interrupted-readback Bookings is
  vacuous. The synthetic safety tests still cover it.
- Turn 12 ("Four three two one zero") shows grouped-digit dictation reaching
  the dialogue, but without inter-group pauses the ticket-08 phone rule was
  not exercised either.

## Gate verdicts

| Gate | Live | Verdict |
| --- | --- | --- |
| False cuts | 1 (step-2 pause split) | FAIL → ticket 12 |
| Stop latency | 6/6 stopped, p50 620 / p95 680 | PASS (slower than synthetic, cause identified) |
| Reply latency | p50 2064 / p95 4215, provider-dominated | AMBER (attributed, no code change) |
| Backchannel false-stop | 1, absorbed 0 | FAIL → ticket 13 |
| Echo false-stop / self-Echo | 0 / 0 | PASS |
| Interrupted-readback Bookings | 0 (readback never reached) | PASS, untested live |
