# 05: Fixed-response generation guard

**What to build:** Queued fixed/scripted responses (greeting, holds, readbacks, reprompts — any fixed line enqueued while another response is still streaming) all play in full and in order. Today the audio drain compares against the latest global generation, which has already advanced by the time an earlier queued response runs, so the earlier response is silently truncated. The guard should use the cancelled-generation watermark instead of the latest allocated generation.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Two fixed responses enqueued back-to-back both play, in order, with no truncation.
- [x] A fixed response interrupted by Barge-in still stops immediately and is never committed to history.
- [x] A regression test at the session seam with a fake transport proves both behaviors.

## Comments
Replaced all 7 `generation !== this.generation` audio/token guards in `runResponse` and `enqueueModelResponse` with `generation <= this.cancelledThrough`. Queued fixed responses no longer see a newer allocated generation as cancellation; only real cancellation (barge-in/speculation, via `speech.cancelled` + watermark) stops them. New `test/liveFixedGuard.test.ts` proves ordering and barge-in history suppression.
