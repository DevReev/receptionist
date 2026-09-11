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

- [ ] Twilio account tier confirmed to allow the streaming verbs.
- [ ] One real test call completes: greeting, endpointed Turns, availability answer, clean session end.
- [ ] Loop-selector default flipped to streaming; legacy path retained behind the flag.
- [ ] Map amended: out-of-scope streaming line and locked-`<Say>` line updated; decision linked from Decisions-so-far.
