# 11: Live partial-channel validation

**What to build:** A real speakerphone call proves the partial channel on the default provider: a mid-list pause is not cut, an acknowledgement is absorbed, and a clearly non-booking Turn starts its reply before the final lands. The call is captured and analysed (trace plus audio), compared against the existing baseline gates, and written up. Any failed gate spawns a follow-up ticket rather than a silent pass. This extends — does not replace — `natural-turn-taking` ticket 10, which is still awaiting its live call.

**Blocked by:** 02, 08, 09, 10.

**Status:** done

- [x] One real call is placed by the user, with the capture retained and analysed.
- [x] Trace evidence shows partial-driven boundary behavior, an absorbed Backchannel, and a Speculative reply on the call.
- [x] False cuts, stop latency, reply latency, Echo false-stops, and Booking-safety gates are reported against baseline, with zero Bookings from interrupted readbacks.
- [x] A report is written; any failed gate spawns a follow-up ticket.

## Comments

Call `CA132fee8e3e777e11cf583e43f1a66811` placed 2026-09-27 (~2.5 min, 15
Turns, speakerphone). Report: `bench-scripts/11-live-partial-channel-report.md`;
metrics: `bench-scripts/11-live-call.json`; capture: `bench-scripts/captures/CA132….log`
(gitignored) + `debug-audio/CA132…-turn*.wav`. Box 2 is partial: boundary (15/15
local) and speculation-kept with audio-before-final hold; absorbed-Backchannel
evidence failed (zero absorptions, one false stop → ticket 13). False cut on the
mid-list pause → ticket 12. No code changed by this ticket.
