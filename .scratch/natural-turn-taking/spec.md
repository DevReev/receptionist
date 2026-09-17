# Natural turn-taking: always-on Barge-in over echo-gated audio

**Status:** ready-for-agent

## Problem Statement

Callers experience the Receptionist as stop-and-go: after every utterance it waits out a fixed local silence window (1000 ms in production) before replying, and while it speaks it cannot hear the Caller at all. A Caller who tries to correct it mid-reply is talked over and ignored; a Caller who pauses to think gets answered half-way. The conversation feels like a walkie-talkie, not a receptionist.

## Solution

The Receptionist senses when the Caller has stopped and answers without a fixed local wait, and it stops speaking as soon as the Caller takes the floor. Short acknowledgements ("mm-hmm", "okay") are absorbed rather than treated as interruptions, and the Receptionist never mistakes its own voice returning through the Caller's phone for the Caller. Calls stay safe: interrupted confirmations never count, in-flight Bookings are never cancelled, and silent Callers still get the reprompt-and-goodbye flow.

## User Stories

1. As a Caller, I want the Receptionist to start answering as soon as I finish my sentence, so the call feels like talking to a person.
2. As a Caller, I want the Receptionist to stop speaking the instant I start speaking, so I can correct or redirect it without waiting.
3. As a Caller, I want my interruption to carry the words I already said, so the Receptionist responds to what I actually said rather than a truncated fragment.
4. As a Caller, I want "mm-hmm" and "okay" while the Receptionist is speaking to be treated as acknowledgement, not interruption, so I do not accidentally stop it.
5. As a Caller, I want the Receptionist to never mistake its own voice coming back through my phone for me speaking, so it never cuts itself off.
6. As a Caller, I want the Receptionist to wait a little longer when I pause mid-thought, so it does not answer half of what I meant to say.
7. As a Caller, I want extra patience while I dictate my name or phone number, so my digits are not split across two Turns.
8. As a Caller, I want an interrupted reply to be dropped rather than resumed later, so I never get a stale answer to a question I already changed.
9. As a Caller, I want an interrupted confirmation readback to never count as a "yes", so I cannot be booked by accident.
10. As a Caller, I want to be able to interrupt the greeting and hold lines too, so the Receptionist never talks over me at any point in the call.
11. As a Caller, I want the call to keep working if the speech provider stops emitting turn boundaries, so I am never left waiting in silence.
12. As a Caller, I want short chit-chat replies to start before transcription finalizes, so casual exchanges feel snappy.
13. As a Caller, I want speculative replies to never propose or save a Booking, so speed never risks a wrong appointment.
14. As a Caller, I want the no-response reprompt flow to still work when I say nothing at all, so silent calls still get guidance and a clean goodbye.
15. As a Caller, I want interruption to work even when the provider's boundary events are slow or missing, because the Receptionist yields on its own detection first.
16. As an operator, I want to choose provider endpointing or the local hybrid detector by configuration, so I can switch approaches without a code change.
17. As an operator, I want the Receptionist to fall back automatically when the provider stalls, so degraded service is invisible to the Caller.
18. As an operator, I want a session that stalls repeatedly to switch detectors once, so I do not pay extra latency on every subsequent Turn.
19. As an operator, I want trace lines for every Barge-in, Echo-gate decision, Backchannel absorption, and detector fallback, so live calls can be diagnosed.
20. As a developer, I want the fixed silence, max-utterance, and Barge-in-flag knobs deleted and replaced by named turn-taking knobs, so configuration reflects the new behavior.
21. As a developer, I want all turn-taking behavior (frame diet, Echo gate, local VAD use, detector strategy, Backchannel classification) behind one deep module, so the Stream session stays orchestration only.
22. As a developer, I want measurable metrics for false cuts, reply latency, stop latency, Echo false-stops, and Backchannel false-stops, so "more natural" is falsifiable.
23. As a developer, I want a scripted live scenario covering Barge-in, Backchannel, and Echo on a speakerphone call, so the bench gates have a real-audio counterpart.
24. As a developer, I want existing call-safety and booking tests to keep passing unchanged, so the overhaul cannot silently regress correctness.

## Implementation Decisions

- **Turn-boundary authority.** The Sarvam realtime adapter switches from manual endpointing to the provider's VAD mode. Provider `vad.speech_start` / `vad.speech_end` events plus per-utterance finals define Turns; client-sent `speech_start` / `speech_end` stop being used in this mode. The provider knobs (threshold, silence duration, minimum speech) are exposed as env, starting at provider defaults (0.3 / 500 ms / 250 ms) and tuned from bench data. Accepted residual: the provider's silence duration is still a fixed wait, but it is provider-owned rather than a local constant.
- **Local VAD demoted.** Silero keeps exactly two jobs: Barge-in candidate detection and Echo-gate timing. It no longer ends Turns in the primary mode.
- **Detector selection.** `TURN_DETECTION=sarvam|hybrid` (default `sarvam`). In `hybrid`, the socket runs in manual mode and the local detector owns boundaries.
- **Hybrid detector.** Trailing silence must exceed a caller-adaptive pause: 1.25 × p90 of the Caller's last 8 completed intra-utterance pauses (silence runs that ended because speech resumed, measured by local VAD), clamped to 150-600 ms, default 300 ms until 3 pauses are observed, with a 1.5 s emergency cap that emits regardless. Semantic completeness comes from partials: incomplete only on clear continuation cues (trailing conjunction/filler/"uh"/"um", dangling question), complete otherwise. A dialogue-aware floor of 600 ms applies while collecting Patient name or phone. The detector consumes dialogue field state.
- **Continuous upstream audio diet.** Audio streams upstream for the whole call. A per-frame Echo gate replaces frames classified as Echo with mulaw silence; Caller frames pass through as-is. Upstream muting while the Receptionist speaks is rejected because it would blind semantic Backchannel confirmation.
- **Echo gate.** Per call, learn the echo return level while the Receptionist speaks (echo-return-loss estimate) and cross-correlate inbound against the outbound reference at an adaptive delay; only non-echo energy counts as Caller speech. No full software AEC in this overhaul (see ADR-0003).
- **Barge-in.** Local-first trigger: Silero speech candidate plus Echo-gate clearance. Provider `vad.speech_start` only corroborates, never triggers. On Barge-in the Receptionist stops within the current pacing window (Twilio `clear`), aborts LLM and TTS generation, drops the unspoken remainder from history, and clears readback confirmation. A Booking write in flight is never cancelled.
- **Backchannels.** Classified from partials while the Receptionist speaks, absorbed, trace-only. Never a Turn, never LLM history.
- **Speculative replies.** Only partials classified as non-booking speculate (booking cues: digits, date/time words, service/doctor names, "book"/"change"/"cancel"); the classifier defaults to booking-sensitive. Speculative generation is text-only with Booking tools suppressed. When the final transcription lands: keep the generation if it agrees with or contains the partial, otherwise abort and regenerate from the final.
- **Stall guard.** If local VAD sees speech but no provider `vad.speech_end` or final arrives within 1.2 s of local trailing silence, the hybrid detector takes the boundary for that Turn and transcription comes from the existing REST fallback. After two consecutive stalled Turns, switch the session to manual/hybrid mode at the next boundary. Every trip is traced.
- **Module seam.** A new deep `TurnTaking` module owns the frame diet, Echo gate, local VAD gating, detector strategy, Backchannel classification, and adaptive pause. `LiveCallSession` remains orchestration only; `Endpointer` is retired and its responsibilities fold into the new module; the `Vad` seam is unchanged. The Sarvam realtime adapter grows vad-mode event parsing and boundary-gated mode switching.
- **Config surface.** Delete the fixed silence knob (including its production `.env` value), the max-utterance knob, and the Barge-in boolean. Repurpose minimum-speech and dip-tolerance as Barge-in candidate knobs. Add `TURN_DETECTION`, provider VAD knobs, Echo-gate margins, and stall grace. Rewrite the RUNBOOK env table and update `.env`.
- **Unchanged.** No-response reprompt timing (8 s), Barge-in during all Receptionist speech (greeting, hold lines, replies), readback and Booking safety invariants, history cap, and TTS/LLM/booking providers.
- **Tracing.** Structured events for Barge-in fire (candidate and corroboration), Echo-gate classification decisions, Backchannel absorption, speculative classify/reconcile, and detector stall/fallback.
- **Docs.** ADR-0003 records the posture; glossary terms Barge-in, Backchannel, Echo, Double-talk, and Speculative reply are in `CONTEXT.md`.

## Testing Decisions

- **What makes a good test.** Tests assert caller-observable behavior through the highest available seam: what the Receptionist speaks, when it stops, what audio the provider receives, and what enters history. Never internal scores, buffers, or message framing — except the adapter protocol tests, whose subject is the wire protocol itself.
- **Primary seam.** The existing fake Stream driver harness, extended with scripted VAD scores, scripted provider events (partials, `vad.speech_start`/`vad.speech_end`, finals), Echo-injected inbound audio (outbound reference mixed into the caller stream), and stubbed STT/TTS. Real `TurnTaking` and real dialogue run underneath. Prior art: the live Turn, live Barge-in, and no-response suites.
- **Protocol seam.** The Sarvam realtime adapter's websocket tests, extended for vad-mode connect parameters, `vad.*` event parsing, boundary-gated mode switching, and suppression of client boundary messages in vad mode. Prior art: the existing realtime adapter protocol tests.
- **Unit tests.** Only for pure, combinatorially heavy logic if the driver seam proves insufficient: adaptive-pause math, semantic-completeness classification, and Echo-gate frame classification, all table-driven. Prefer scenarios through the primary seam.
- **Bench and gates.** Extend the benchmark harness with a synthetic Echo-mix generator over the captured fixtures and metrics: false-cut rate, reply latency p50/p95, stop latency, Backchannel false-stop rate, Echo false-stop rate. Run a baseline on the current build first, then set gates relative to baseline. Hard safety gates: zero Bookings from an interrupted readback, and zero self-Echo-triggered Turns in synthetic runs.
- **Live.** A scripted call scenario (Barge-in, Backchannel, speakerphone Echo) captured from a real line, developer-run, as the real-audio counterpart to the bench gates.
- **Regression.** All existing suites pass; only config/env-surface tests change, and only because the removed knobs are gone.

## Out of Scope

- Full software acoustic echo cancellation (revisit only if Echo false-stop metrics fail).
- Resuming or parking interrupted replies (drop semantics stay).
- The legacy record-based loop.
- Changes to no-response reprompt timing.
- Provider swaps, TTS/LLM changes, or Picktime booking automation changes.
- Multilingual behavior or voice changes.

## Further Notes

- The provider option is `endpointing=vad`, not "auto" — `auto` only exists as a `language_code` value. This correction is recorded because the original request assumed `auto`.
- Latency tiebreaks made during grilling: hybrid numbers (1.25 × p90, 150-600 ms clamp, 300 ms default, 1.5 s cap), the 600 ms dialogue-aware floor, and the 1.2 s stall grace with two-strike escalation.
- The live speakerphone gate needs the user to place one real call when implementation reaches that point.
- Related: `docs/adr/0003-always-on-barge-in.md`, `CONTEXT.md`.
