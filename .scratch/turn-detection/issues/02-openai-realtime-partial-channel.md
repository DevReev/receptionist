# 02: OpenAI Realtime partial channel

**What to build:** The default streaming STT provider exposes live partial transcripts. The OpenAI Realtime adapter accumulates transcription deltas per conversation item and emits them to the session through the provider-neutral partial channel; capability is declared explicitly so the session no longer infers partial support from the presence of a callback. With partials flowing, semantic Endpointing becomes live on the default provider: the Turn boundary is owned by the caller-adaptive pause plus partial-transcript completeness, with the emergency cap and the name/phone dialogue floor, instead of the flat no-partials floor. Partial text carries Patient-sensitive content, so no raw partial text is added to traces. This also brings the Backchannel and Speculative reply paths live; their behavior is covered by tickets 09 and 10.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Scripted transcription deltas on the adapter socket produce partial emissions; a completed event resolves the final as before; deltas arriving after commit/final never leak into the next utterance's partials.
- [x] A session built with the OpenAI Realtime adapter reports semantic-boundary capability; a session with a provider that has no partial channel uses the no-partials floor; the distinction is explicit, not inferred from callback presence.
- [x] With scripted partials, an incomplete partial holds the boundary past the adaptive pause until it becomes complete or the emergency cap fires; a complete partial lets the boundary fire at the adaptive pause.
- [x] Existing adapter protocol tests, hedge tests, and replay-bench output shapes pass.
- [x] Traces carry partial counts/latency but never raw partial text.
