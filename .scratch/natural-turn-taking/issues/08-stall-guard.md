# 08: Stall guard

**What to build:** A provider that stops emitting boundaries never strands the Caller. If local speech presence sees no provider end signal and no final within 1.2 s of local trailing silence, the hybrid detector takes the boundary for that Turn and transcription falls back to the REST path. Two consecutive stalled Turns switch the session to hybrid mode at the next boundary. Every trip is traced.

**Blocked by:** 07.

**Status:** ready-for-agent

- [ ] A scripted stall completes the Turn via the hybrid boundary plus REST transcription; the Caller hears no hang.
- [ ] Two consecutive stalls switch the session's detector mode at a boundary; subsequent Turns are detector-owned.
- [ ] Traces record each stall, fallback, and mode switch with the evidence.
- [ ] An isolated one-off stall does not switch the session's mode.
