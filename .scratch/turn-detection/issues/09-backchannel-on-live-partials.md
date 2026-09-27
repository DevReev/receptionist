# 09: Backchannel absorption on live partials

**What to build:** Backchannel absorption works against real partial text from the default provider. The acknowledgement vocabulary covers common English affirmations (for example "yeah", "yep", "yup", "nah", "perfect", "cool"), and a stale backchannel classification cannot absorb a following content burst. Absorbed acknowledgements stay trace-only: no Turn, no history, no interruption; content-bearing speech takes the floor immediately.

**Blocked by:** 02.

**Status:** done

- [x] With provider partials, an acknowledgement while the Receptionist speaks is absorbed: it keeps speaking, no Turn event fires, and no history is written.
- [x] The added acknowledgements classify as Backchannel; an unknown short word takes the floor.
- [x] A content burst following an absorbed acknowledgement takes the floor within the confirm window; a stale classification cannot keep absorbing it.
- [x] Backchannel false-stop rate on the replay bench holds or improves.

## Comments

- Vocab (`src/backchannel.ts`): added `yes/yeah/yea/yep/yup/nah/perfect/cool`. `no` stays content (corrections take the floor); `nope` excluded as correctional. Elongations ride the existing collapse variants.
- Staleness (`src/turnTaking.ts`): `observePartial` content clears `absorbing`; fresh speech burst drops a stale `backchannel` verdict to `unknown` (keeping the flag for dip-tolerance end + single trace) while preserving early-arriving content evidence.
- Trace redaction untouched: backchannel trace carries `chars` only; new tests assert no raw text leaks.
- Bench: backchannel false-stop 0.0% (0/1), absorbed 1 — holds baseline. Full suite 512/512.
