---
label: wayfinder:build
status: open
parent: ../map.md
blocked-by: [11-full-live-turn.md, 12-error-contract.md]
assignee:
---

# 13: Live validation call and map amendments

**What to build:** the live path proven on a real phone call — account tier verified (streaming verbs require an upgraded account), the connect TwiML pointed at the public streaming URL, one real call checking Availability end-to-end, streaming flipped to the default loop, and the map updated to reflect the new voice path.

**Blocked by:** 11, 12 (needs the working loop and its error contract).

**Spec:** `06-live-streaming-voice-loop.md`.

- [x] Loop-selector default flipped to streaming; legacy path retained behind the flag.
- [x] Map amended: out-of-scope streaming line and locked-`<Say>` line updated; decision linked from Decisions-so-far.
- [ ] Twilio account tier confirmed to allow the streaming verbs.
- [ ] One real test call completes: greeting, endpointed Turns, availability answer, clean session end.

## Progress (2026-09-11, code-complete, live-gated)

- `VOICE_LOOP` default is now `stream` (`src/config.ts`); `STREAM_WS_URL` is required by default and must be a public `wss://` URL (the Connect TwiML target). `VOICE_LOOP=legacy` restores the record loop with no URL requirement. Tests in `test/stream.test.ts` cover the new default, the legacy opt-out, and the `wss://` guard.
- `/voice/incoming` already answers `<Connect><Stream url="…">` in stream mode (`src/app.ts` + `src/twiml.ts`); covered by `test/stream.test.ts` incoming-call routing.
- `scripts/live-validation.sh` automates every checkable precondition (loop default, `wss://` URL, credentials present without printing, VAD model, built-config load, read-only Twilio tier query) and prints the manual call checklist + `VOICE_LOOP=legacy` rollback.
- Live gate: the script's Twilio tier query reports the account as Trial — streaming verbs are stripped on trial accounts per spec 06, so the real-call checklist (point webhook at `https://<public-host>/voice/incoming`, place one call, tail Turn/failure logs) is an operator step after upgrade. Run `STREAM_WS_URL=wss://<public-host>/stream sh scripts/live-validation.sh` then place the call.
