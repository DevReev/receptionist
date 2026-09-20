# OpenAI-only STT: remove Sarvam from the speech-to-text loop and hedge the REST fallback

**Status:** done

## Problem Statement

The last live call (`CAfa19c0…`, 8 turns, 91 s) ran the streaming path entirely on OpenAI: `gpt-live-transcribe` over the realtime websocket, with `whisper-1` REST as the per-Turn fallback. Sarvam was in the loop only for TTS. Yet the Sarvam STT adapters, `SARVAM_STT_*` config, `STT_PROVIDER=sarvam` default, and the provider-VAD boundary machinery they fed are all still present — and the provider-VAD mode is now unreachable (the OpenAI channel is manual-only), so that code is dead weight that hides the real authority.

The measured defect is on the empty-final path. Three turns had a realtime final with zero characters and zero partials; the session then re-decoded the same utterance through `whisper-1`, serially:

| turn | endpoint | realtime final | REST re-decode | transcribe total |
|---|---|---|---|---|
| 2 | 500 ms | empty (629 ms) | empty, 3.29 s | 3.91 s |
| 7 | 500 ms | empty (552 ms) | "Bye-bye.", 2.37 s | 2.92 s |
| 8 | 500 ms | empty (548 ms) | "Shhhh", 1.85 s | 2.40 s |

Turn 2 is the p95: 3.9 s before the reprompt. Requested fix was "empty final plus zero partials means no speech, skip REST". That is wrong on this evidence: turns 7 and 8 produced audible speech (RMS 1291 and 119) that only `whisper-1` recovered. Zero partials is not a no-speech signal for this channel; it is the model failing on quiet or short audio.

## Solution

STT becomes OpenAI-only: streaming `gpt-live-transcribe` with a `whisper-1` REST fallback, no Sarvam code, config, or vocabulary in the transcription path. The REST re-decode stays and stays on `whisper-1`; it is the accuracy net for exactly the turns the streaming model drops. The latency fix is to start that decode when the channel commits instead of after the empty final, so an empty final never pays `final + REST` serially. Realtime text still wins whenever it lands non-empty.

## Evidence and rejected alternatives

- **Do not skip REST on empty final + zero partials.** Turns 7 and 8 recovered real speech through REST (`Bye-bye.`, `Shhhh`). The skip would have dropped the goodbye turn.
- **Do not swap the fallback model.** Re-running the captured utterances against the same endpoint: `gpt-4o-mini-transcribe` returned empty on turns 1, 2, 5, 7, 8 and mangled 4 and 6; `gpt-4o-transcribe` hallucinated non-English text on 2, 7, 8 (`Kita.`, `はい。`, `بھی۔`). Both reject `verbose_json`, which the hallucination gates in the Whisper transcriber rely on. `whisper-1` was the only model that recovered 7 and 8, and `gpt-live-transcribe` was the best decoder on normal turns 4 and 6.
- **Audibility floor (out of scope).** A local RMS floor before creating a Turn would drop turn 5 (RMS 98), but turn 8 (RMS 119) carried recovered speech and turn 2 (RMS 272) did not, so RMS cannot separate "no speech" from "quiet speech" reliably. Left out; revisit only if it can be paired with duration and level evidence.
- **Reply length and warm-up** are real UX costs (turn 4's long answer invited a barge-in; the 2.4 s warm-up bought little) but are not part of this spec.

## Implementation Decisions

- **Single provider.** `STT_PROVIDER` accepts only Whisper-compatible REST (`openai|groq|openrouter`) and `openai-realtime`; unset defaults to `openai-realtime`. `SARVAM_API_KEY` is required only when `TTS_PROVIDER=sarvam`. Sarvam TTS (streaming socket and REST fallback, prewarm, buffer clamps) is unchanged.
- **One realtime seam.** The `RealtimeStt` contract, partial/context types, and boundary types move to their own provider-neutral module. The Sarvam adapter is deleted; the OpenAI adapter and the session import the seam, never a provider module. During the transition the old module re-exports the seam so existing imports keep compiling.
- **Local boundary authority.** With no provider-VAD channel left, the local detector always owns boundaries. `TURN_DETECTION`, `STALL_GRACE_MS`, provider boundary events, endpointing switching, stall guard/escalation, and `abandonUtterance` become dead code and are deleted. Local detector behavior (adaptive pause, barge-in, backchannel, no-partials floor) is unchanged.
- **Commit-time hedge.** The REST fallback decode starts at turn start/commit on the streaming path, not after the empty final. The realtime final is preferred whenever it arrives non-empty. An empty REST result must not preempt a realtime final still in flight — the session waits for the final (or its timeout) before treating the Turn as no speech.
- **Keeping the fallback model and its gates.** The Whisper transcriber keeps `verbose_json`, `temperature=0`, and the `no_speech_prob` / `avg_logprob` / `compression_ratio` gates; those gates are what make "empty means no speech" trustworthy on the REST side.

## Testing Decisions

- **What makes a good test.** Assert caller-observable behavior through the live-session seam: which transcript source supplied the Turn, what the fallback wait cost, and whether a Turn was treated as no speech. Scripted realtime channels and a scripted REST transcriber, real session code underneath.
- **Primary seam.** The existing fake-channel live suites (turn, latency, speculation, barge-in) become the hedge tests: with a channel that finalizes empty and a REST stub with a known delay, assert the Turn resolves without waiting for `final + REST` and that the source is labelled as a realtime-empty REST recovery. With a channel that finalizes non-empty, assert REST never replaces it. Add the pending-final race: an empty REST result arriving before a non-empty final must not win.
- **Config seam.** Provider-default and validation tests: unset `STT_PROVIDER` selects `openai-realtime`; `sarvam` is rejected; `SARVAM_API_KEY` is not required for STT; Sarvam TTS wiring tests keep passing.
- **Adapter protocol seam.** Interface-move churn only; the OpenAI realtime protocol tests stay as the behavioural contract.
- **Bench.** The replay harness drives captured fixtures through the OpenAI realtime channel and keeps the same metrics output shape, so existing bench comparisons remain valid.
- **Regression.** Existing suites pass or are deleted only with their subject (provider-VAD, stall guard). No skipped tests.

## Out of Scope

- Sarvam TTS changes, voice/pace tuning.
- Reply-length control and hold-line UX.
- Changing or removing the STT warm-up.
- A local audibility/noise floor before Turn creation.
- Falling back to REST for any reason other than an empty/failed final.
- ADR extraction of the model-choice evidence (candidate follow-up).

## Further Notes

- Evidence source: `/tmp/receptionist.log` lines for `CAfa19c0d6ba23589baf39f000382b01e3`; captures in `debug-audio/CAfa19c0…-turn*.wav`.
- The empty-final REST recovery is a deliberate accuracy/latency trade: it buys back dropped speech at the cost of decoding turns that are genuinely silent. The commit-time hedge removes the avoidable part of that cost, not the decode itself.
- `transcribe_llm_tts.md` still describes Sarvam realtime as the primary STT path; it is a design document from before the OpenAI streaming channel and should be marked superseded when ticket 02 lands.
