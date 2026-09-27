# 04: Cancellable speech

**What to build:** Speech synthesis honours cancellation end to end. The speech seam accepts an abort signal so Barge-in and call close interrupt HTTP body reads and provider sockets rather than only discarding late chunks, and the realtime STT socket gains a connect timeout with cleanup.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Barge-in mid-synthesis interrupts the in-flight provider request (observable as an aborted request, not just dropped audio).
- [x] Call close cancels all speech work; no provider request outlives the session.
- [x] A realtime STT socket that never opens fails within a bounded connect timeout, traced, without holding the call open.
- [x] Existing TTS fallback behavior (streaming, falling back before any primary audio) is unchanged.

## Comments
- `SpeechOptions.signal` + `synthesize(text, signal?)` / `synthesizeStream(text, signal?)` threaded through `OpenAiTts` (fetch signal + body-read abort checks), `SarvamTts` REST, `SarvamStreamingTts.begin` (signal aborts utterance/closes socket), and `bufferedSpeech` (internal controller, abort settles queue without fallback/fail).
- `live.ts`: `runResponse` passes its per-response controller; `enqueueModelResponse` uses a dedicated speech controller so barge-in/close abort TTS while the turn-deadline abort only stops LLM generation (deadline-edge replies still speak). `close()` also aborts `turnAbort`.
- `openaiRealtime.ts`: `connectTimeoutMs` (default 5s), traces `stt:connect-timeout`, fails cleanly to REST fallback; timers cleared on open/fail/close.
- Verified: typecheck clean, focused suites pass, full `npm test` 491 pass.
