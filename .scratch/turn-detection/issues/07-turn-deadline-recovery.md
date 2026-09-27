# 07: Turn deadline — one coherent recovery

**What to build:** A Turn that hits the model deadline recovers exactly once. Today the deadline abort stops the LLM stream while speech synthesis and playback continue, so the Caller can hear a truncated reply and then a reprompt. The deadline should end in one of two clean outcomes: the buffered safe reply finishes, or playback clears and a single reprompt is spoken. Never a truncated reply followed by a second reply.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] A model that stalls mid-reply produces exactly one of: completed buffered reply, or cleared playback plus one reprompt — never both.
- [x] History contains at most the reply that actually played.
- [x] Deadline events are traced once, with their outcome.

## Comments

- `enqueueModelResponse` (src/live.ts) now tracks complete phrases pushed to TTS. When the deadline aborts token flow mid-reply with live speech, it recovers once: pushed phrases play out as the Turn's reply (incomplete tail stays unspoken), or — when nothing speakable buffered — the TTS response is cancelled, `clearPlaybackFn('turn-deadline')` drops partial audio, and the Turn falls back to one reprompt. The result carries `deadline: 'completed-buffered' | 'cleared' | null`.
- `answerWithModel` unifies the two old `logPhase('turn','deadline')` sites into one trace per deadline with `outcome`: `completed-buffered`, `cleared-reprompt` (catch path before any token, and cleared path), or `completed-full` (provider finished despite the abort — preserves the ticket-11 edge tests).
- History: cleared path commits nothing (truncated text excluded, `replySoFar` reset); buffered path commits exactly the played phrases. Ticket 04 (dedicated speech abort, deadline never cancels TTS implicitly) and ticket 05 (generation guards) preserved.
- Tests: two new focused tests in test/liveTurn.test.ts (stall-after-sentence → finish; stall-mid-phrase → clear+reprompt). Both fail on pre-fix code, pass after. Full suite 501/501.
