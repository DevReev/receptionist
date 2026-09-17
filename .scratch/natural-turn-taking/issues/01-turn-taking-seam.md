# 01: TurnTaking seam

**Status:** done

- [x] A live Turn completes exactly as today through the new module: same Endpointing defaults, same audio routing, same reply path.
- [x] The Stream session no longer touches endpointing internals directly; the `Vad` seam is unchanged.
- [x] Existing live, Endpointing, and interruption suites pass, moved to the new seam where they assert internals.
- [x] No Caller-observable behaviour change on a smoke call.

## Comments

Landed in `a7b780e`. `TurnTaking` owns the frame diet, local VAD gate, utterance
segmentation, and interruption-candidate state; `LiveCallSession` orchestrates.
Status was left at `ready-for-agent` by mistake; corrected while implementing
ticket 05.
