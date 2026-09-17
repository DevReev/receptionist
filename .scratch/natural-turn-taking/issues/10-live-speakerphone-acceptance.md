# 10: Live speakerphone acceptance

**What to build:** The gate report for the overhaul. A scripted live scenario covers Barge-in, Backchannel, and Echo on a real speakerphone call; the capture is analysed (trace plus audio); bench metrics are compared against the recorded baseline with the agreed gates; safety gates are confirmed at zero. The user places the real call; the scenario script, capture analysis, and report are agent work.

**Blocked by:** 02, 05, 06, 07, 08, 09.

**Status:** ready-for-agent

- [ ] The scenario script exists and is run on a real speakerphone call placed by the user, with the capture retained.
- [ ] Echo false-stop and Backchannel false-stop are zero in synthetic runs and recorded on the live call; stop latency and reply latency are reported against baseline.
- [ ] Hard safety gates: zero Bookings from an interrupted readback; zero self-Echo-triggered Turns in synthetic runs.
- [ ] A report is written with numbers and trace evidence; any failed gate spawns a follow-up ticket instead of a silent pass.
