# 03: Provider VAD primary boundaries

**What to build:** Turns end when the speech provider says the Caller stopped — no local fixed wait. The realtime adapter connects in provider VAD mode, consumes provider speech start/end events and per-utterance finals, stops sending client boundary messages, and switches detector mode only at utterance boundaries. The operator gets a detector choice plus provider VAD tuning knobs; the fixed silence and max-utterance knobs disappear from config, `.env`, and the RUNBOOK. The no-response reprompt flow is unchanged.

**Blocked by:** 01, 02.

**Status:** ready-for-agent

- [x] A scripted call is answered with no local fixed silence wait; the reply pipeline starts from the provider end-of-turn signal plus its final.
- [x] Adapter protocol tests cover VAD-mode connect parameters, provider speech events, and boundary-gated mode switching; no client boundary messages are sent in VAD mode.
- [x] `TURN_DETECTION=sarvam|hybrid` (default `sarvam`) and provider VAD knobs (threshold, silence duration, minimum speech) are env-configurable at provider defaults.
- [x] Fixed silence and max-utterance knobs are removed from config, `.env`, and the RUNBOOK.
- [x] The no-response reprompt flow still repeats then closes after two unanswered asks.

## Comments

Implemented. The Sarvam realtime adapter connects with `endpointing=vad`
(`threshold` / `silence_duration_ms` / `min_speech_duration_ms` at provider
defaults 0.3 / 500 / 250, env `SARVAM_VAD_THRESHOLD` / `SARVAM_VAD_SILENCE_MS` /
`SARVAM_VAD_MIN_SPEECH_MS`), streams every frame so the provider's VAD can hear
it, parses `vad.speech_start` / `vad.speech_end`, buffers finals that land
before the session asks, and sends no `speech_start` / `speech_end` in VAD mode.
`setEndpointing` tells the provider at once (it gates the change at its next
utterance) and flips local boundary ownership when the current utterance
closes, so a stalled provider cannot strand the request.

`TurnTaking` gains a `detection` strategy: in `sarvam` mode the local VAD no
longer ends Turns; it only captures the utterance audio between provider
boundaries, seeded by the pre-roll, for REST fallback and fixture capture.
`hybrid` keeps the local detector and runs the socket in manual mode.
`LiveCallSession` derives the effective detector from `TURN_DETECTION` plus the
channel's endpointing mode, wires the provider events, and traces `endpoint`
with `source: provider|local`.

`TURN_DETECTION` defaults to `sarvam`; `ENDPOINT_SILENCE_MS` and
`ENDPOINT_MAX_UTTERANCE_MS` are gone from config, `.env`, and the RUNBOOK (the
local fallback keeps 1000 ms / 30 s internally). New coverage:
`test/liveProviderVad.test.ts` (provider boundary answers with no local wait,
pre-roll capture, REST fallback, no-response unchanged) and the adapter VAD-mode
protocol suite. Full suite 348/348; the turn bench reproduces the ticket-02
baseline numbers on the same policy.
