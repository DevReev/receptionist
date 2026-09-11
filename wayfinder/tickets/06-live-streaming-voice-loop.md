---
label: wayfinder:spec
status: open
parent: ../map.md
blocked-by: []
assignee:
---

# Live streaming voice loop

## Problem Statement

Today every Turn of a call pays a full record-then-fetch round trip: the Caller speaks into a recording, the server downloads the finished audio, transcribes it, runs the assistant, and only then speaks the whole reply at once. The conversation feels stop-and-go — the Caller waits in silence while the recording is fetched and processed, and the Receptionist cannot start speaking until the entire reply is ready. Callers experience this as talking to a voicemail box, not a receptionist.

## Solution

Carry each call on a live bidirectional Stream session: caller audio flows to the server continuously, Endpointing decides the moment the Caller has stopped speaking, the buffered utterance is transcribed with the existing whisper STT, and the assistant's reply streams sentence-by-sentence into speech — so the Receptionist starts talking as early as possible and only ever talks after the Caller stops. The existing record-based loop stays available behind a configuration flag until one live call succeeds end-to-end.

## User Stories

1. As a Caller, I want to hear a spoken greeting shortly after the call connects, so that I know the Receptionist is live.
2. As a Caller, I want the Receptionist to start replying soon after I stop speaking, so that the conversation feels live rather than stop-and-go.
3. As a Caller, I want the Receptionist to wait until I have finished speaking before it replies, so that I am not talked over.
4. As a Caller who pauses mid-sentence to think, I want brief pauses not to cut me off, so that I can finish my request.
5. As a Caller who coughs or makes a short noise, I want that ignored rather than treated as my request, so that I am not asked to clarify constantly.
6. As a Caller who speaks at length, I want the Receptionist to eventually respond rather than listen forever, so that the call makes progress.
7. As a Caller asking about hours or services, I want an accurate answer grounded in the Clinic guide, so that I get correct information.
8. As a Caller asking for an appointment, I want to be offered only real Slots from live Availability, so that I am not promised a time that does not exist.
9. As a Caller confirming a Booking, I want my Patient name and phone confirmed back to me, so that the Booking is made for the right person.
10. As a Caller whose request cannot be understood twice, I want a handoff line and a callback promise, so that I know a human will follow up.
11. As a Caller calling when something fails downstream, I want to hear the clinic-will-confirm line and a polite goodbye, so that I am not left on a dead call.
12. As a Caller, I want the Receptionist to keep listening after each reply until the call ends, so that I can ask follow-up questions.
13. As a clinic operator, I want every Turn logged with call identity, excerpt, and reply, so that the console log remains the handoff channel for the clinic.
14. As a clinic operator, I want every failure logged with call identity and reason before the Caller hears anything, so that no failure goes unrecorded.
15. As a clinic operator, I want bookings attempted at most once per confirmed intent, so that a retry never double-books a Slot.
16. As a clinic operator, I want the old record-based loop kept behind a flag during rollout, so that a broken live path does not take the phone line down.
17. As a developer, I want the TTS provider hidden behind an interface matching the existing transcriber/assistant seams, so that a different voice provider can replace OpenAI TTS later without touching the loop.
18. As a developer, I want Endpointing parameters (trailing silence, minimum speech, maximum utterance) configurable without code changes, so that tuning does not require a deploy of new logic.
19. As a developer, I want a fake Stream session driver in tests, so that a full Turn can be exercised without a Twilio account or network calls.
20. As a developer, I want utterance audio converted to the format the existing transcriber already accepts, so that no new STT integration is needed.

## Implementation Decisions

- Transport is Twilio's raw bidirectional media stream primitive: the voice webhook answers with a connect-style TwiML document pointing at the server's streaming endpoint, and one Stream session lives for the whole call. This assumes an upgraded Twilio account, since the streaming verbs are stripped on trial accounts; verifying the account tier is step zero.
- The streaming endpoint upgrades the existing HTTP server to websockets on the same port; no separate host or process is introduced.
- A new Stream session module owns one call's lifecycle: session open, greeting spoken, listen → endpoint → transcribe → reply → listen loop, session close. It reuses the existing per-call history store, failure logger, Turn logger, and booking guardrail unchanged.
- Endpointing uses an on-device voice activity detector over the inbound audio stream. An utterance ends after the configured trailing-silence duration with no speech; sub-minimum-speech noises never start an utterance; a maximum utterance duration forces an endpoint. While reply audio is playing, inbound audio is discarded and the endpoint timer only starts after playback finishes (no barge-in, per glossary).
- Utterance audio is buffered from the inbound stream and converted to the audio format the existing transcriber interface already accepts, then submitted through that same interface — Whisper (OpenAI or Groq, per existing configuration) is unchanged.
- A new TTS interface mirrors the existing transcriber/assistant injection seams: text in, playable audio out. Its first implementation calls OpenAI TTS reusing the key already configured for STT. The voice will differ from the previous fixed `<Say>` voice; that is accepted.
- The assistant seam is extended to stream reply tokens; the Stream session cuts the token stream at sentence boundaries and sends each finished sentence to TTS immediately, so first-audio latency does not wait for the full reply. The assistant context (transcript, history, Clinic guide, Availability block, single-attempt booking proposal) is unchanged, as is the configured model.
- The greeting is synthesized through the session's own TTS path rather than a pre-connect `<Say>`, keeping one voice for the whole call.
- A configuration flag selects the streaming loop vs the legacy record-based loop; legacy is the default until the first successful live call, then streaming becomes the default and the legacy path is removed in a follow-up.
- The error contract from the turn-based loop carries over verbatim: empty/unintelligible utterance counts a miss with bounded reprompts then handoff; downstream or mid-Turn failure writes the console log first, then the clinic-will-confirm line, then ends the session; the caller's hangup or a dropped socket logs the partial Turn; Booking stays single-attempt.
- New configuration covers: loop selector flag, TTS model and voice, endpointing durations, and the streaming endpoint's public URL for the TwiML document.

## Testing Decisions

- Tests assert external behavior only: given scripted caller audio and stubbed providers, the session speaks at the right times with the right text — never the internals of VAD scoring, buffering, or message framing.
- Highest seam is a fake Stream session driver: tests open a session, feed canned audio frames, and observe outbound audio/text events, with the transcriber, assistant (token stream), TTS, and clock all stubbed. This is the one seam the feature is tested through; provider units stay at their existing lower seams.
- Endpointing policy (trailing silence ends utterance, short noise ignored, overlong utterance forced, speech-during-playback discarded) is tested through the fake driver with synthetic speech/silence frame patterns.
- Sentence-cut streaming (first sentence reaches TTS before the reply completes) is tested through the fake driver with a scripted token stream.
- Error paths (two misses then handoff, mid-Turn failure ordering of log-before-speech, socket drop logging) are tested through the fake driver against the Turn/failure log collectors.
- Prior art: the AppDeps stub pattern that injects fake transcriber/assistant/recording-fetcher plus log collectors; fetch-stubbed provider unit tests; the `node:test` runner over the test directory.

## Out of Scope

- Barge-in (caller interrupting the Receptionist): explicitly kept out per glossary; inbound audio during playback is discarded.
- Managed relay alternatives: the raw bidirectional stream primitive is chosen; hosted STT/TTS/endpointing bundles are not evaluated further.
- Voice choice beyond the single configured OpenAI TTS voice; neural/expressive voice shopping.
- Reschedule / cancel flows, after-hours messaging, the exact emergency sentence, and recording-privacy constraints (all still open on the map).
- Removing the legacy record-based loop (follow-up after the first successful live call).
- Per-call cost/latency budgets beyond first-audio latency observation in the live test.
- Language expansion beyond the currently configured language.

## Further Notes

- This spec amends the map: the "Out of scope" line excluding streaming voice and neural TTS, and the "Locked by the human" line pinning the fixed `<Say>` voice, both need updating when this ticket closes. The turn-based ticket's resolution stands as the legacy path's contract.
- Glossary entries for Endpointing, Stream session, and the redefined Turn are already in the domain glossary; the spec uses them throughout.
- If the transport choice (raw bidirectional stream vs a managed relay) ever needs revisiting, it meets the bar for an architecture decision record: hard to reverse, surprising without context, and the result of a genuine trade-off argued during design.
- Triage note: the `ready-for-agent` label vocabulary is not configured in this repo (no tracker setup found), so this ticket follows the local-markdown conventions from the map instead. Run `/setup-matt-pocock-skills` to configure the full issue-tracker and triage-label vocabulary.
