---
label: wayfinder:build
status: open
parent: ../map.md
blocked-by: [08-endpointing.md]
assignee:
---

# 09: Whisper transcription of the buffered utterance

**What to build:** each endpointed utterance is converted to the audio format the existing whisper transcriber already accepts and submitted through that unchanged interface, so its text lands in the Turn — the Caller speaks, the Receptionist hears words.

**Blocked by:** 08 (needs utterance events).

**Spec:** `06-live-streaming-voice-loop.md`.

- [ ] Buffered utterance audio is converted and transcribed via the existing transcriber seam (no new STT integration).
- [ ] Transcript text lands in the Turn with history updated, as in the legacy loop.
- [ ] Empty/unintelligible audio counts one miss toward the bounded-reprompt policy.
- [ ] Verified through the fake driver with a stubbed transcriber.
