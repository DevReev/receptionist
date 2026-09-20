# 01: Extract the provider-neutral realtime STT seam

**What to build:** A realtime transcription seam that names no provider. The `RealtimeStt` contract, its partial and context types, and its boundary/endpointing types live in their own module; the Sarvam adapter becomes one implementation of it. The OpenAI realtime adapter, the live session, and the session tests all import the seam rather than a provider module. This is a prefactor: no call behavior changes, and it lets the Sarvam deletion be a deletion rather than a move.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] The seam module imports nothing provider-specific and exposes the full contract the session already relies on (`pushAudio`, `speechStart`, `finalize`, `reconfigure`, `onPartial`, boundary ownership, `close`).
- [x] Provider tuning knobs (for example the Sarvam VAD threshold/silence/minimum-speech trio) live with the implementation that consumes them, not with the seam.
- [x] The Sarvam adapter module re-exports the seam types so every existing import in source and tests compiles unchanged; no test is edited to accommodate the move.
- [x] `npm run typecheck` and `npm test` pass, and no live-call trace or timing behavior changes.
