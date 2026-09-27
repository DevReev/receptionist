# 10: Speculative replies on live partials

**What to build:** Speculative replies work against real partial lag from the default provider: clearly non-booking partials start reply generation before the final arrives, and the keep-or-abort policy is tuned to actual partial/final agreement. Booking-sensitive partials never speculate; a mismatched final discards the reply and regenerates from the final; nothing speculative ever reaches history or writes a Booking.

**Blocked by:** 02.

**Status:** done

- [x] Against recorded or scripted real-provider partial/final sequences, a clearly non-booking partial produces reply audio before the final lands, and the reply is kept when the final agrees.
- [x] A mismatched or booking-sensitive final aborts (or never starts) speculation; no speculative text enters history and no Booking is proposed.
- [x] Reply latency p50 on the speculative path is measured against the no-speculation path; false-cut and safety metrics do not regress.

## Comments

- `partialAgrees` calibrated against realistic cumulative-prefix lag, not changed:
  prefix growth (`what are` → `what are your hours`), final normalization
  (`What are your hours?`), and insertions keep; a corrected word in a short
  partial aborts (safe direction — overlap cannot tell a same-meaning ASR fix
  from a reword, so short-partial substitutions regenerate); meaning-change
  rewords abort. Locked in by `partial/final agreement against real provider
  lag` block in `test/speculation.test.ts`. `classifySpeculation` untouched:
  booking gating stays strict.
- New `test/liveSpeculation.test.ts` block drives the real `OpenAiRealtimeStt`
  over a fake socket: cumulative deltas (`what are` / ` your` / ` hours`) start
  the reply, audio lands while `input_audio_buffer.commit` is in flight and the
  completed event is withheld, then the agreeing final keeps (one assistant
  call, speculative) and the mismatched final aborts (`final-mismatch`) and
  regenerates with no history/Booking leakage.
- Redaction fix in `src/live.ts`: a digit cue (Caller number fragment, e.g. a
  `my number is 987…` partial aborting a speculation) no longer reaches
  `speculation-aborted` traces — `traceCue` drops digit cues and the trace
  omits the key entirely. Fixed-vocabulary (booking/date-time) and guide-name
  cues are unchanged. Covered by the `never traces a digit cue` test.
- Bench (this tree, 35 fixtures): speculative-faq reply p50 280 ms on vs
  880 ms off (600 ms scripted final delay hidden); TOTAL p50 280 ms / p95
  1480 ms identical both runs; false-cut 0/12, stop p50 180 ms missed 0,
  backchannel absorbed 1 / false-stop 0, echo false-stop 0/4, self-echo 0,
  echo-gate bars PASS (pass 0/111, block 0/40) in both runs. Recorded
  `turn-bench-*.json` files untouched.
- Full suite: 512 pass, 0 fail, 0 skipped. `npm run typecheck` clean.
