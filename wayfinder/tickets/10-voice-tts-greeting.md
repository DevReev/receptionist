---
label: wayfinder:build
status: closed
parent: ../map.md
blocked-by: [07-stream-session-skeleton.md]
assignee:
---

# 10: Voice — TTS interface, greeting, playback tracking

**What to build:** the Receptionist can speak inside the Stream session — a new swappable TTS interface (OpenAI first implementation, reusing the existing STT key), the greeting spoken in-session on open so the whole call has one voice, and playback-completion tracking so Endpointing knows when the Receptionist finished talking.

**Blocked by:** 07 (needs the Stream session; independent of Endpointing and transcription).

**Spec:** `06-live-streaming-voice-loop.md`.

- [x] New TTS interface (text in, playable audio out) with an OpenAI-backed implementation; stubbed in tests like the transcriber/assistant seams.
- [x] Session open speaks the greeting through the session's own TTS path.
- [x] Every spoken reply emits a playback-completion signal the endpoint timer can key off.
- [x] Verified through the fake driver: greeting audio out on open; text in → audio out + completion event.

## Resolution

Implemented: `Tts` seam + `OpenAiTts` (`src/tts.ts`, wav `response_format` → 8 kHz mulaw, reuses STT key, `TTS_MODEL`/`TTS_VOICE`/`TTS_BASE_URL` env in `src/config.ts`); `LiveCallSession.open/speak` greet and speak through the session TTS path with `onPlaybackComplete` per reply and `suspend`/`resume` around playback so the endpoint timer restarts after the Receptionist finishes (no barge-in); `StreamObserver.onOpen` + session-passing in `src/stream.ts`; per-session live wiring in `src/server.ts` stream mode. 6 live/TTS tests through the fake driver. Full suite 69/69 green, typecheck clean. Review fixed an unneeded session cast and one-letter wrapper params.
