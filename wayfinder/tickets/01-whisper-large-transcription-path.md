---
label: wayfinder:research
status: closed
parent: ../map.md
blocked-by: []
assignee: research-agent
---

# Whisper-large transcription path

## Question

Which whisper-large endpoint serves telephony transcription, and how does turn-based Twilio audio reach it? Decide: provider/endpoint (OpenAI Whisper API `large-v3`? self-hosted whisper-large? other host), per-turn audio capture (which Twilio verb produces the clip), request shape, latency per turn, language behavior (fixed vs auto-detect; user locked whisper-large only, Sarvam/WhisperFlow out), and failure modes (silence, noise, truncation). Output is a decision usable by the voice-loop and behavior tickets: exact endpoint + per-turn capture flow + limits.

## Resolution

Decision: OpenAI-hosted Whisper API (`POST https://api.openai.com/v1/audio/transcriptions`, `model: whisper-1`, $0.006/min) — there is no `large-v3` model id in the API; `whisper-1` is the hosted whisper-large and satisfies the lock. Self-hosted large-v3 rejected for v1 (GPU cost/ops). Per-turn flow: Twilio `<Record>` (action webhook, `timeout=5`/`maxLength=30-60`/`finishOnKey=#`/`playBeep=false` starting points) → server downloads clip (Basic auth, `.mp3` suffix) → forward as multipart `file` with `language=en` → feed text to the loop; handle the action-vs-availability race via retry/`recordingStatusCallback`, gate hallucinations with `verbose_json` `no_speech_prob`, never set Twilio `transcribe=true`. Full detail: `research/whisper-transcription.md`.

## Amendment 2026-09-05 (deploy trial)

- STT endpoint/model are now env-configurable (`WHISPER_BASE_URL`, `WHISPER_MODEL`); key from `OPENAI_API_KEY` or `GROQ_API_KEY`.
- Live trial runs on Groq (`whisper-large-v3-turbo`, OpenAI-compatible shape, key verified 200) — user-directed; still whisper-large family, still no Twilio transcription.
- Request shape, `.mp3` download, retry, and `no_speech_prob` gating unchanged across providers.
