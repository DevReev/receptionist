# 04: Confirm bookings with guardrails and idempotency

**What to build:** Real Booking confirmation on the live page: hold, heartbeat, save, and release owned server-side, with guardrails that stop hallucinated Slots, unreachable Bookings, and double-books from retried confirmations.

**Blocked by:** 03 (holds and dry-run bookings).

**Status:** ready-for-agent

- [ ] `POST /v1/bookings` confirms with service, date, time, Patient first name, and Patient phone; phone is enforced server-side even though page prefs call it optional, and live prefs are re-read per call with 422 on newly-required missing fields
- [ ] A retried confirmation with the same key replays instead of double-booking, aided by a natural-key fallback (same phone plus Slot within 10 minutes); same key with different payload conflicts (409-style)
- [ ] Absent doctor resolves to the configured single doctor, with the 422 pick-a-doctor path (returning candidates, never a silent default) wired for the day a second doctor books
- [ ] Live-save suite books real appointments behind explicit opt-in gating only, never by default; every run's residue is a real Booking plus confirmation email needing manual cleanup
