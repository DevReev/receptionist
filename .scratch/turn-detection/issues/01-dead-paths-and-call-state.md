# 01: Cleanup prefactor — dead paths and single-sourced call state

**What to build:** Remove dead capability that obscures the live Turn loop and make call state single-sourced. Delete the unused hold/speak/guardrail/helper functions, fix the duplicated `second-opinion-disagree` trace so one disagreement emits one line, route keypad (DTMF) number entry through the same Turn bookkeeping as speech so a keyed number Turn produces the same turn logs and participates in the active Turn's reply capture, and make the live loop read call state from one CallStore (the one authoritative for the Stream session) instead of two.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Dead exports and functions are removed; build and the full test suite pass.
- [x] One second-opinion disagreement emits exactly one trace line.
- [x] A keyed number submitted with `#` emits a Turn event equivalent to a spoken number Turn, and its reply is captured in the active Turn.
- [x] Only one CallStore is consulted by the live loop; the inbound-call webhook and the Stream session observe the same turn/history state.
- [x] No behavior other than the above changes; existing call-safety suites pass unchanged.

## Comments

Implemented: `scheduleHold`, `LiveCallSession.speak`, `createInterimGuardrail`
(and `src/booking.ts`), `interpolate`, `noTrace`, and the unused
`DialogueDecision` import are gone; the duplicate disagree trace is one line.
Speech and DTMF share `beginTurn` (counter, active-Turn record, no-response
watch), and the whole keyed submit is queued on `pending` like an utterance, so
a `#` pressed mid-reply opens its Turn only after the previous one settles and
never repoints its reply capture. `AppDeps.calls` is now the one injected
`CallStore`; `server.ts` builds it once and hands it to both `createApp` and
every `LiveCallSession`, so `/voice/incoming` resets the state the Stream
session reads. Tests added for all three behaviors; typecheck and the full
suite (465 tests) pass.
