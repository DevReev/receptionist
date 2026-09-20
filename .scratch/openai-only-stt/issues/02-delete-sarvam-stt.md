# 02: Delete Sarvam STT

**What to build:** Sarvam is a text-to-speech provider only. Speech-to-text is OpenAI: streaming `gpt-live-transcribe` by default, with the Whisper-compatible REST fallback. Selecting Sarvam for STT fails fast and clearly; leaving `STT_PROVIDER` unset selects `openai-realtime`. The Sarvam realtime adapter, the Sarvam REST transcriber, and the Sarvam STT config surface are gone. The benchmark replay harness keeps working by driving captured fixtures through the OpenAI realtime channel.

**Blocked by:** 01 (the seam must live outside the Sarvam adapter first).

**Status:** done

- [x] Unset `STT_PROVIDER` selects `openai-realtime`; `STT_PROVIDER=sarvam` is rejected with a message naming the accepted providers.
- [x] No source module exports or constructs a Sarvam transcriber, and no `SARVAM_STT_*` knob is read; `SARVAM_API_KEY` is required only when `TTS_PROVIDER=sarvam`.
- [x] Sarvam TTS behavior is untouched: streaming socket, REST fallback, idle timeout, buffer clamp, and prewarm tests all pass unchanged.
- [x] The benchmark/replay harness runs its fixtures through the OpenAI realtime channel and keeps the same metrics output shape, so existing bench runs stay comparable.
- [x] The RUNBOOK env table and the design doc that still calls Sarvam realtime the primary STT path are updated to match.
- [x] `npm run typecheck` and `npm test` pass; Sarvam STT-only tests are deleted, not skipped.
