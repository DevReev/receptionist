---
label: wayfinder:build
status: closed
parent: ../map.md
blocked-by: [08-endpointing.md]
assignee:
---

# 09: Whisper transcription of the buffered utterance

**What to build:** each endpointed utterance is converted to the audio format the existing whisper transcriber already accepts and submitted through that unchanged interface, so its text lands in the Turn — the Caller speaks, the Receptionist hears words.

**Blocked by:** 08 (needs utterance events).

**Spec:** `06-live-streaming-voice-loop.md`.

- [x] Buffered utterance audio is converted and transcribed via the existing transcriber seam (no new STT integration).
- [x] Transcript text lands in the Turn with history updated, as in the legacy loop.
- [x] Empty/unintelligible audio counts one miss toward the bounded-reprompt policy.
- [x] Verified through the fake driver with a stubbed transcriber.

## Resolution

Implemented: `src/audio.ts` PCM→WAV (`encodeWav`, mulaw encode, resample, WAV→mulaw) so the buffered utterance meets the unchanged `Transcriber` seam (`audio/wav`); `LiveCallSession.handleUtterance` (`src/live.ts`) transcribes, pushes Caller text to `CallStore` history with per-utterance Turn counting, and counts empty/`noSpeech`/throw as one miss (reprompt once via TTS, goodbye + close on the second, matching the legacy policy). 4 live tests with stubbed transcriber/TTS. Full suite 69/69 green, typecheck clean. Review noted success-path `logTurn` (no assistant reply yet) and greeting-failure speech both belong to tickets 11/12; `suspend` covers TTS fetch as well as playback (conservative no-barge-in).
