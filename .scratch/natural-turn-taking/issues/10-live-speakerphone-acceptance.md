# 10: Live speakerphone acceptance

**What to build:** The gate report for the overhaul. A scripted live scenario covers Barge-in, Backchannel, and Echo on a real speakerphone call; the capture is analysed (trace plus audio); bench metrics are compared against the recorded baseline with the agreed gates; safety gates are confirmed at zero. The user places the real call; the scenario script, capture analysis, and report are agent work.

**Blocked by:** 02, 05, 06, 07, 08, 09.

**Status:** done

- [x] The scenario script exists and is run on a real speakerphone call placed by the user, with the capture retained.
- [x] Echo false-stop and Backchannel false-stop are zero in synthetic runs and recorded on the live call; stop latency and reply latency are reported against baseline.
- [x] Hard safety gates: zero Bookings from an interrupted readback; zero self-Echo-triggered Turns in synthetic runs.
- [x] A report is written with numbers and trace evidence; any failed gate spawns a follow-up ticket instead of a silent pass.

## Comments

Closed by the turn-detection ticket-11 call (`CA132fee8e3e777e11cf583e43f1a66811`,
2026-09-27), which extends — per its ticket — this ticket's scenario rather than
repeating it. Evidence: `bench-scripts/11-live-partial-channel-report.md`,
`bench-scripts/11-live-call.json`, capture `bench-scripts/captures/CA132….log`
(gitignored) + `debug-audio/CA132…-turn*.wav`. Box 2 is mixed: synthetic bars
all green (echo 0/4, backchannel 0/1, self-echo 0); live echo false-stop 0 but
backchannel false-stop 1 → turn-detection ticket 13. Box 3's readback half is
untested live (caller hung up before any readback; 0 bookings vacuous) —
synthetic safety tests still cover it. Live false cut → turn-detection ticket 12.
