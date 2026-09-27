# 06: Echo gate — playback tail and correlated double-talk

**What to build:** The Echo gate protects the two windows it currently misses. First, the residual Echo tail immediately after the Receptionist stops speaking, where returned own voice can be scored as Caller speech because the gate only classifies while the Receptionist is speaking. Second, double-talk where the Caller's voice correlates strongly with the outbound reference: the gate currently classifies the Caller as Echo and can shift the learned return level. Gated by the existing fixture-bench bars: Echo false-pass and Caller false-block within 5%.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Fixture bench: Echo false-pass and Caller false-block remain within bars, with a fixture case exercising the playback-tail window.
- [x] A strongly correlated Caller fixture takes the floor rather than being classified as Echo.
- [x] Stop latency, self-Echo, and Backchannel metrics from the replay bench do not regress.

## Comments

Window 2 (correlated double-talk): the double-talk level check in
`EchoGate.classify` (`src/echoGate.ts`) used to apply only below correlation
0.85, so any Caller correlating above that was Echo and re-learned `lossDb`.
It now applies at all correlations below a near-perfect 0.97 bar
(`ECHO_RELEARN_CORRELATION`): excess energy over the predicted Echo means
Caller even at high correlation, only a sample-identical match re-learns the
level as a changed acoustic path, and double-talk frames never learn. A
synthetic correlated Caller (pre-fix: 160/206 frames Echo, level hijacked
-18 dB to -14 dB) now passes entirely as double-talk with the level untouched.

Window 1 (playback tail): `TurnTaking.startListening` (`src/turnTaking.ts`)
arms a 300 ms tail (`echoTailMs` option) during which listening frames are
still classified; Echo frames are suppressed from the utterance candidate and
sent upstream as silence, everything else flows normally so prompt Caller
speech is never eaten.

New coverage: `playbackTailCase` + `correlatedDoubleTalkCase` in
`src/echoGateBench.ts` (wired into `scripts/echo-gate-bench.ts`), an
`echo-tail` scenario in `src/turnBench.ts`, and unit tests at the gate seam
(`test/echoGate.test.ts`), turn-taking seam
(`test/turnTakingEchoGate.test.ts`, incl. a correlated-Caller barge-in), and
replay seam (`test/turnBench.test.ts`). Shared stress fixture
`correlatedDoubleTalkFrame` in `test/voiceFixtures.ts`.

Benches (local, 35 captured fixtures; recorded JSONs untouched):
- `npm run echo-gate-bench`: false-pass 3.3% (1577/47789, unchanged) /
  false-block 0.3% (34/12528, was 41 — the wider band rescued 7 real Caller
  frames) -> PASS. Synthetic cases: tail 100 pure-Echo flagged + 50 Caller
  passed; correlated 40 pure-Echo flagged + 160 Caller passed, 0 blocks.
- `npm run turn-bench` (12 scenarios incl. new echo-tail): stop p50/p95
  180 ms missed 0, reply p50 280 / p95 1480, backchannel false-stop 0/1
  (absorbed 1), echo false-stop 0/4, self-echo 0, gate pass 0/111 /
  block 0/40 (was 1/40) -> PASS. echo-tail: 2 turns endpointed and answered
  (reply p50 280 ms), its 9 tail Echo frames all gated.
- `npm test`: 499 pass, 0 fail, no skips. `npm run typecheck` clean.

Residual uncertainty: a Caller matching the reference sample-for-sample at
correlation >= 0.97 is indistinguishable from a louder Echo path in one
frame and still re-learns; the bar placement (0.97) trades rare path-change
lockout against correlated-Caller hijack. Real speakerphone audio (ticket 10)
should confirm the tail length and the bar.
