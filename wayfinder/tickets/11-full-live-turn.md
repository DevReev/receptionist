---
label: wayfinder:build
status: closed
parent: ../map.md
blocked-by: [08-endpointing.md, 09-whisper-utterance.md, 10-voice-tts-greeting.md]
assignee:
---

# 11: Full live Turn with streamed sentences

**What to build:** the complete live loop — listen → endpoint → transcribe → reply → listen — where the assistant's streamed tokens are cut at sentence boundaries and each finished sentence is spoken immediately, with history, Clinic guide grounding, live Availability, and single-attempt Booking proposal all working inside the Stream session.

**Blocked by:** 08, 09, 10 (needs Endpointing, transcription, and voice).

**Spec:** `06-live-streaming-voice-loop.md`.

- [x] Multi-Turn conversation runs inside one Stream session: each Caller utterance gets a grounded reply, then listening resumes.
- [x] First sentence reaches TTS before the full reply completes (sentence-cut streaming observable in tests).
- [x] Replies use only live Slots from Availability; confirmed intents propose a Booking at most once with Patient name + phone.
- [x] Configured model unchanged; verified through the fake driver with stubbed providers.

## Resolution

Implemented: `Assistant.replyStream` optional token seam (`src/app.ts`) with a real SSE `OpenRouterAssistant.replyStream` twin of `reply` (same model `deepseek/deepseek-v4-flash-0731`, same single `propose_booking` single-attempt rule, `stream: true`); `LiveCallSession.answerTurn` (`src/live.ts`) resolves guide per Turn + Availability per Turn, streams tokens via `extractCompleteSentences`, and speaks each finished sentence immediately under one endpoint suspend (no barge-in), with caller+receptionist history and `logTurn` per Turn; `server.ts` stream mode wires the live assistant, per-Turn availability placeholder, and interim booking guardrail. Tests: `test/liveTurn.test.ts` (multi-turn grounding, first-sentence-before-complete gate, single booking with name+phone through the fake driver) + `OpenRouterAssistant streaming` provider tests (model unchanged, tool-once-then-follow-up). Full suite 75/75 green, typecheck clean. Review: no hard Standards violations (sentence/TTS and tool-map duplications noted as refactor-optional, left inline); Spec notes on real Picktime wiring, endCall-on-stream, and failure taxonomy deferred (placeholder Availability matches the interim-guardrail contract, live keeps listening per story 12, assistant-error reason matches legacy — errors harden in ticket 12).
