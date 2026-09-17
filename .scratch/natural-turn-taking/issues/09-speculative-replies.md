# 09: Speculative replies

**What to build:** Clearly non-booking partials get a head start: reply generation begins text-only, with Booking tools suppressed, before the final transcription lands; when the final arrives it is kept if it agrees with the partial, otherwise aborted and regenerated from the final. Booking-sensitive partials always wait for the final. Speculation can never propose or save a Booking. The classifier defaults to booking-sensitive, and booking cues include digits, date/time words, service or doctor names, and book/change/cancel phrasing.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] A scripted non-booking Turn produces reply audio before the final lands, with first-audio latency measurably better than the no-speculation path.
- [ ] Speculative generation emits no Booking proposal or tool activity, including when the final disagrees.
- [ ] A mismatched final aborts and regenerates; no speculative text reaches history.
- [ ] Booking-cue partials never speculate.
