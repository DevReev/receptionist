---
label: wayfinder:build
status: open
parent: ../map.md
blocked-by: [08-endpointing.md, 09-whisper-utterance.md, 10-voice-tts-greeting.md]
assignee:
---

# 11: Full live Turn with streamed sentences

**What to build:** the complete live loop — listen → endpoint → transcribe → reply → listen — where the assistant's streamed tokens are cut at sentence boundaries and each finished sentence is spoken immediately, with history, Clinic guide grounding, live Availability, and single-attempt Booking proposal all working inside the Stream session.

**Blocked by:** 08, 09, 10 (needs Endpointing, transcription, and voice).

**Spec:** `06-live-streaming-voice-loop.md`.

- [ ] Multi-Turn conversation runs inside one Stream session: each Caller utterance gets a grounded reply, then listening resumes.
- [ ] First sentence reaches TTS before the full reply completes (sentence-cut streaming observable in tests).
- [ ] Replies use only live Slots from Availability; confirmed intents propose a Booking at most once with Patient name + phone.
- [ ] Configured model unchanged; verified through the fake driver with stubbed providers.
