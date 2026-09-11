---
label: wayfinder:build
status: closed
parent: ../map.md
blocked-by: []
assignee:
---

# 07: Stream session skeleton with loop flag

**What to build:** a Caller connecting over the streaming endpoint gets a live Stream session that opens and closes cleanly; a configuration flag selects the streaming loop vs the legacy record-based loop (legacy stays the default). This ticket also delivers the fake Stream session driver test harness that all later live-loop tickets build on.

**Blocked by:** none (can start immediately).

**Spec:** `06-live-streaming-voice-loop.md`.

- [ ] Streaming endpoint accepts a session open and closes the session cleanly on client disconnect.
- [ ] Loop-selector flag routes calls to the streaming session or the legacy record loop; legacy remains the default.
- [ ] Fake Stream session driver exists in tests: scripted inbound audio in, outbound audio/text events out, no network.
- [ ] Existing test suite still passes with the flag on legacy.

## Resolution

Implemented: `StreamSession` + transport-agnostic socket adapter + `/stream` upgrade endpoint on the existing server; `VOICE_LOOP` flag (`legacy` default, `STREAM_WS_URL` required iff `stream`); `/voice/incoming` answers Connect TwiML in streaming mode; fake Stream session driver (`test/fakeStream.ts`) carries the lifecycle, audio, and real-websocket tests. Full suite 43/43 green, typecheck clean. Review fixed a pre-start disconnect registry leak and a dead server-side socket close.
