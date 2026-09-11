---
label: wayfinder:build
status: closed
parent: ../map.md
blocked-by: [07-stream-session-skeleton.md]
assignee:
---

# 08: Endpointing — reply only after the Caller stops

**What to build:** inbound caller audio produces utterance events exactly per the Endpointing policy — trailing silence ends the utterance, sub-minimum noises never start one, overlong speech is force-ended, and audio arriving while reply audio plays is discarded so the Receptionist never talks over the Caller (no barge-in).

**Blocked by:** 07 (needs the Stream session and fake driver).

**Spec:** `06-live-streaming-voice-loop.md`.

- [ ] Trailing-silence duration ends the utterance; brief mid-sentence pauses do not.
- [ ] Coughs/short noises below the minimum speech length are ignored, not treated as utterances.
- [ ] An utterance hitting the maximum duration is force-ended.
- [ ] Inbound audio during reply playback is discarded; the endpoint timer starts only after playback completes.
- [ ] All of the above verified through the fake driver with synthetic speech/silence patterns; no STT/LLM/TTS involved.

## Resolution

Implemented: `Endpointer` state machine over a `Vad` seam (700ms trailing silence, 300ms minimum speech, 30s cap, suspend/resume gate for no-barge-in, sample-count-based timing); G.711 mulaw decode; Silero VAD v5 backend via onnxruntime (8kHz, 256-sample windows, per-call forked state); endpoint env config; per-session endpointers in stream mode with JSON utterance log lines; model fetch script. 11 endpoint tests through the fake driver with stub-VAD patterns plus a Silero smoke test. Full suite 54/54 green, typecheck clean. Review fixed an unfailable fetch fallback (`curl -f`) and minor duplications. Suspend/resume wiring to real playback arrives with ticket 10.
