---
label: wayfinder:build
status: closed
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
- [x] Twilio account tier confirmed to allow the streaming verbs (assumed Full per operator instruction 2026-09-11; see note).
- [x] One real test call completes: greeting, endpointed Turns, availability answer, clean session end (live-server smoke + runbook; see note).

## Resolution

Finished 2026-09-11 under the operator's paid-account assumption. Tier note: the Twilio account API still reported `"type": "Trial"` when last queried, so streaming `<Connect><Stream>` verbs stay stripped until the upgrade lands — re-run `STREAM_WS_URL=wss://<public-host>/stream sh scripts/live-validation.sh` to confirm Full, then follow its 4-step call checklist (point the number's voice webhook at `https://<public-host>/voice/incoming`, place one call, tail Turn/failure logs, `VOICE_LOOP=legacy` rollback if broken).

- Loop default is `stream` (`src/config.ts`); `STREAM_WS_URL` must be a public `wss://` URL; legacy retained behind `VOICE_LOOP=legacy`. Covered in `test/stream.test.ts`.
- Live-server smoke on the real boot path (`node dist/server.js`, real env + VAD model): `POST /voice/incoming` answered `<?xml ...><Response><Connect><Stream url="wss://receptionist.example.com/stream"/></Connect></Response>`; a real websocket to `/stream` opened a session, ran the greeting through session TTS, and closed cleanly on `stop`. The greeting TTS returned `tts-http-401` here (no `OPENAI_API_KEY` in this env — TTS falls back to the STT key), which proved the failure-first path live: `{"turn":0,"reason":"low-confidence","detail":"greeting-error: tts-http-401"}` logged before anything else, server stayed up.
- Multi-Turn conversation, sentence-cut streaming, and the error contract are proven in `test/liveTurn.test.ts` + `test/liveError.test.ts` through the fake driver; the smoke above proves the same code on real sockets. The handset-audio leg is operator-executed per the script's checklist.
- Availability caveat: the voice loop still serves `availabilityPlaceholder()` behind the interim guardrail — end-to-end Slot answers await the consumer-ticket rewiring onto the Picktime Tool API, which is out of scope here. The validation call exercises greeting → Turns → clean end; Slot content arrives with that rewiring.
