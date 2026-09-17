# 03: Provider VAD primary boundaries

**What to build:** Turns end when the speech provider says the Caller stopped — no local fixed wait. The realtime adapter connects in provider VAD mode, consumes provider speech start/end events and per-utterance finals, stops sending client boundary messages, and switches detector mode only at utterance boundaries. The operator gets a detector choice plus provider VAD tuning knobs; the fixed silence and max-utterance knobs disappear from config, `.env`, and the RUNBOOK. The no-response reprompt flow is unchanged.

**Blocked by:** 01, 02.

**Status:** ready-for-agent

- [ ] A scripted call is answered with no local fixed silence wait; the reply pipeline starts from the provider end-of-turn signal plus its final.
- [ ] Adapter protocol tests cover VAD-mode connect parameters, provider speech events, and boundary-gated mode switching; no client boundary messages are sent in VAD mode.
- [ ] `TURN_DETECTION=sarvam|hybrid` (default `sarvam`) and provider VAD knobs (threshold, silence duration, minimum speech) are env-configurable at provider defaults.
- [ ] Fixed silence and max-utterance knobs are removed from config, `.env`, and the RUNBOOK.
- [ ] The no-response reprompt flow still repeats then closes after two unanswered asks.
