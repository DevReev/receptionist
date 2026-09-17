# ADR-0003: Always-on Barge-in over echo-gated audio; provider VAD owns turn boundaries

## Context

The live loop ends a Caller's Turn on a fixed local silence window
(`ENDPOINT_SILENCE_MS`, 1000 ms in `.env`) and, while the Receptionist speaks,
drops inbound audio entirely (`BARGE_IN` exists but is off). Callers get a
fixed beat of silence before every answer and cannot interrupt. The goal is
natural turn-taking: reply when the Caller stops, stop when the Caller talks.

Always-on listening has a hard constraint: Twilio provides no acoustic echo
cancellation and no delayed reference of what the Caller actually heard. The
Caller's phone microphone returns the Receptionist's own voice (Echo); naive
listening makes the Receptionist cut itself off.

## Decision

- **Turn boundary**: Sarvam realtime `endpointing=vad` is authoritative
  (`vad.speech_start` / `vad.speech_end`; knobs `threshold`,
  `silence_duration_ms`, `min_speech_duration_ms`). Local Silero is demoted to
  Barge-in candidate detection and Echo-gate timing.
- **Hybrid backup**: `TURN_DETECTION=hybrid` runs the socket in manual mode
  with local semantic + caller-adaptive endpointing. A stall guard falls back
  per Turn (REST transcription) and escalates the session to manual after two
  consecutive provider stalls.
- **Echo handling**: audio streams upstream continuously, with per-frame
  gating: frames classified as Echo are replaced with mulaw silence, Caller
  frames pass through. Rejected: muting upstream while speaking (kills
  semantic Backchannel confirmation) and full software AEC (weight and
  artifact risk for what is only a gate-level need).
- **Barge-in**: local-first trigger (Silero + Echo gate); `vad.speech_start` is
  corroboration, never the trigger. On Barge-in the Receptionist stops within
  the current pacing window (Twilio `clear`), aborting LLM/TTS; the unspoken
  remainder is dropped from history. Backchannels never take the floor.

## Consequences

- A false-pass Echo is heard as Caller speech (spurious Barge-in); a false-block
  silently loses a quiet Caller. Both are measured (echo false-stop,
  backchannel false-stop) rather than assumed away.
- Readback and Booking safety invariants are unchanged: an interrupted
  readback clears confirmation; a Booking write in flight is never cancelled.
- `ENDPOINT_SILENCE_MS` and the `BARGE_IN` boolean are deleted; `TURN_DETECTION`
  and the provider VAD knobs replace them, so the behavior change is visible in
  `.env` and the RUNBOOK.
