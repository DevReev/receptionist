# 04: Echo gate and outbound reference

**What to build:** The Receptionist can tell its own voice returning through the Caller's phone from the Caller actually speaking. Played audio is retained as an outbound reference, and every inbound frame during Receptionist speech is classified Echo or not-Echo using a learned return level plus correlation against the reference at an adaptive delay. Decisions are traced. The call stays half-duplex for now: this ticket changes no stop or segmentation behaviour and cannot false-stop on its own.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] Echo-mixed fixtures and scripted inbound produce correct classifications: Echo frames flagged, clean Caller speech passed.
- [ ] Trace lines record each gate decision with the evidence used.
- [ ] Classification accuracy on fixtures meets the agreed bar, with false-pass and false-block rates recorded.
- [ ] Segmentation, stop behaviour, and history are untouched.
