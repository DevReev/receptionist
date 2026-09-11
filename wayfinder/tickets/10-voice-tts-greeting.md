---
label: wayfinder:build
status: open
parent: ../map.md
blocked-by: [07-stream-session-skeleton.md]
assignee:
---

# 10: Voice — TTS interface, greeting, playback tracking

**What to build:** the Receptionist can speak inside the Stream session — a new swappable TTS interface (OpenAI first implementation, reusing the existing STT key), the greeting spoken in-session on open so the whole call has one voice, and playback-completion tracking so Endpointing knows when the Receptionist finished talking.

**Blocked by:** 07 (needs the Stream session; independent of Endpointing and transcription).

**Spec:** `06-live-streaming-voice-loop.md`.

- [ ] New TTS interface (text in, playable audio out) with an OpenAI-backed implementation; stubbed in tests like the transcriber/assistant seams.
- [ ] Session open speaks the greeting through the session's own TTS path.
- [ ] Every spoken reply emits a playback-completion signal the endpoint timer can key off.
- [ ] Verified through the fake driver: greeting audio out on open; text in → audio out + completion event.
