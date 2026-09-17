# 05: Always-on Barge-in

**What to build:** The Caller can interrupt the Receptionist at any point — greeting, hold lines, or replies. Audio streams upstream for the whole call; frames classified Echo are replaced with silence; non-Echo Caller speech while the Receptionist speaks fires Barge-in: the Receptionist stops within the current pacing window, aborts the in-flight reply, drops the unspoken remainder from history, and a fresh Turn begins with the interruption's first words retained. Provider speech-start events corroborate but never trigger. Safety holds: an interrupted readback can never authorize a Booking, and an in-flight Booking write is never cancelled.

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] Scripted Caller speech during playback stops the Receptionist within the pacing window and starts a new Turn with the interruption's opening audio retained.
- [ ] Echo-mixed inbound never stops the Receptionist: zero self-Echo-triggered Turns in synthetic runs.
- [ ] The unspoken remainder is absent from history; an interrupted readback is cleared; Booking safety invariants hold.
- [ ] The Barge-in boolean is deleted; Barge-in candidate knobs (minimum speech, dip tolerance) are named and env-configurable.
- [ ] Barge-in works during the greeting and hold lines exactly as during replies.
