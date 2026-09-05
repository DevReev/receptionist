# Whisper-large transcription path — findings

Decision: use the **OpenAI-hosted Whisper API** (`POST https://api.openai.com/v1/audio/transcriptions`,
`model: "whisper-1"`) for every turn. One Twilio `<Record>` per turn produces the clip; the Node
server downloads it and forwards it to OpenAI. No self-hosting, no Twilio built-in transcription,
no Sarvam/WhisperFlow (out of scope per map).

## 1. Endpoint decision

- **Endpoint:** `POST https://api.openai.com/v1/audio/transcriptions` (multipart form-data), authenticated
  with `Authorization: Bearer $OPENAI_API_KEY`.
  Source: [Create transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create),
  [Speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text).
- **Model id: `whisper-1`.** This is the only Whisper-family model id exposed by the OpenAI API. There is
  **no `large-v3` model id** in the API — `large-v3` (and its optimized `turbo` variant) are names of the
  open-source checkpoints in [openai/whisper](https://github.com/openai/whisper) ("Available models and
  languages" table: `large` = 1550M params, ~10 GB VRAM; `turbo` = 809M, ~6 GB VRAM, MIT license).
  `whisper-1` is the hosted Whisper large model and therefore satisfies the human's "whisper-large only" lock
  with zero infrastructure. (OpenAI's current default recommendation for new work is `gpt-transcribe`, but that
  is a different model family and is rejected here by the lock.)
- **Price:** Whisper transcription is billed at **$0.006 / minute** (audio duration, rounded to seconds).
  Source: official [Pricing](https://developers.openai.com/api/docs/pricing) → "Transcription models" table
  (`Whisper | Transcription | $0.006 / minute`). At clinic volumes (a few minutes of caller speech per call)
  this is fractions of a cent per call.
- **Self-hosted `large-v3` rejected for v1:** needs an always-on GPU host (~10 GB VRAM for `large`, ~6 GB for
  `turbo`), plus `ffmpeg`, scaling, and ops burden — orders of magnitude more expensive than $0.006/min at
  receptionist call volumes. Revisit only if patient-data residency ever forbids sending call audio to OpenAI.

## 2. Per-turn capture flow (builder-ready)

Twilio side — one `<Record>` per caller turn (matches the map's turn-based `<Record>` → STT → LLM → `<Say>` loop):

1. Server responds with `<Say>` (the receptionist prompt) followed by `<Record>` with an `action` URL, e.g.
   `timeout="5" maxLength="30" finishOnKey="#" playBeep="false"`. Relevant semantics, all from the
   [`<Record>` TwiML reference](https://www.twilio.com/docs/voice/twiml/record):
   - `timeout` (default 5): seconds of silence that end the record. `0` disables.
   - `finishOnKey` (default `1234567890*#`, i.e. any key ends the record): restrict to `#` so stray DTMF
     doesn't cut the caller off. WARNING from the docs: ~the last second of audio before the keypress may be lost.
   - `maxLength` (default 3600; 120 for transcribed recordings — we don't use Twilio transcription, so 3600
     applies): cap at 30–60 s per turn for latency and cost.
   - `playBeep` (default true): set `false` so the beep doesn't confuse callers mid-conversation.
   - `trim` (default `trim-silence`): trims leading/trailing silence; keep the default.
   - Verbs after `<Record>` are unreachable — the loop continues from the `action` webhook. (Final verb tuning
     belongs to the voice-loop ticket; values above are starting points.)
2. When the turn ends, Twilio POSTs to the `action` URL with `RecordingUrl`, `RecordingDuration`, and `Digits`
   (plus standard voice params). **The file may not be downloadable yet at this point** — the docs explicitly
   say to use `recordingStatusCallback` for reliable availability notification. Builder must handle this race:
   either wait on the `recordingStatusCallback` (`completed` event) or retry the download with backoff.
3. Download: `GET RecordingUrl` server-side with HTTP Basic auth (`AccountSid:AuthToken`; all `api.twilio.com`
   media/API access uses this — cf. the authenticated curl examples in the
   [Recordings resource](https://www.twilio.com/docs/voice/api/recording)). Default format is WAV; appending
   `.mp3` to the URL returns MP3. Both are accepted Whisper input formats (see §3). Prefer `.mp3` for smaller
   transfers.
4. Transcribe: forward the bytes as multipart `file` to `/v1/audio/transcriptions` with:
   `model=whisper-1`, `language=en` (fixed — see §4), `response_format=json` (or `verbose_json` if the builder
   wants `no_speech_prob`, see §5), optional `prompt` (≤224 tokens, clinic/doctor names) and
   `temperature=0` (default; raise only as a fallback on garbled output).
5. Feed `text` into the DeepSeek loop; `<Say>` the reply; next `<Record>`. On empty/failed transcription,
   reprompt ("Sorry, I didn't catch that…") and cap retries (behavior ticket owns exact wording/counts).
6. **Do NOT set `transcribe=true` on `<Record>`** — that is Twilio's own paid transcription engine
   (English-only, 2–120 s limits), a different provider from whisper-large and therefore out of scope.

## 3. Request shape and hard limits

- Accepted formats: `flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm`. **Max file 25 MB.** A 30–60 s Twilio
  clip (8 kHz telephony, WAV ~0.5–1 MB, MP3 far less) is nowhere near either limit — no chunking needed at
  these turn lengths. (For longer audio the documented strategy is compress or split on sentence boundaries.)
  Source: [Speech-to-text guide](https://developers.openai.com/api/docs/guides/speech-to-text)
  ("Longer inputs"), [Create transcription reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).
- `whisper-1`-specific knobs: singular `language` hint (not the plural `languages` used by `gpt-transcribe`);
  `prompt` ≤ 224 tokens and "doesn't follow instructions like a general-purpose text model";
  `timestamp_granularities[]` (word/segment, requires `response_format=verbose_json`) is **only supported on
  `whisper-1`**; file-streaming (`stream=true`) is **not** supported on `whisper-1` (fine — turns are short,
  blocking calls are simpler).
- Minimal request (curl):
  `curl https://api.openai.com/v1/audio/transcriptions -H "Authorization: Bearer $OPENAI_API_KEY" -H "Content-Type: multipart/form-data" -F file=@turn.mp3 -F model=whisper-1 -F language=en -F response_format=json`
  → `{"text": "…"}`.

## 4. Language behavior: fixed `en`

- Send `language=en` (ISO-639-1) on every request. The clinic serves English callers; a fixed hint is faster
  and avoids mis-detection on short noisy clips. Whisper supports ~99 languages
  ([tokenizer.py](https://github.com/openai/whisper/blob/main/whisper/tokenizer.py), guide: "Whisper supports
  98 languages, but accuracy varies"), and omitting `language` enables auto-detect (returned as `language` in
  `verbose_json`), but auto-detect is not needed for v1. Language expansion is explicitly deferred in the map.

## 5. Failure modes and mitigations

| Mode | What happens | Mitigation |
|---|---|---|
| Silence / caller says nothing | `timeout` fires; empty or near-empty `text`; silent recordings are still saved by Twilio by default | Treat empty/short text as no-input → reprompt; cap retries then console-log + polite close (behavior ticket) |
| Background noise / music | Whisper famously hallucinates fluent text on non-speech; `avg_logprob` low, `no_speech_prob` high | Request `response_format=verbose_json` and gate on `no_speech_prob` (docs: >1.0 with `avg_logprob` < −1 ≈ silent) and segment `compression_ratio` (>2.4 ≈ failed); reprompt instead of acting |
| Truncation by `finishOnKey` | ~1 s of audio before the keypress can be lost (documented) | Only `#` ends input; tell callers ("press # when done" is optional); `maxLength` 30–60 s bounds the rest |
| Recording not ready at `action` time | Download 404s/empty (documented race) | Retry with backoff, or gate transcription on `recordingStatusCallback` `completed`; `RecordingStatus=absent/failed` → reprompt + console-log |
| API error / timeout / key invalid | 4xx/5xx or hung request | Retry once, then reprompt once, then console-log and fail the turn safe (never crash the call webhook; always return valid TwiML) |
| Oversize (>25 MB) | 413 rejection | Impossible at 30–60 s turns; if `maxLength` is ever raised, compress or split first |
| Twilio trial-number limits | Trial numbers can't receive all call types; recording storage/MFA constraints | Voice-loop ticket verifies trial behavior on the real number; this path adds no extra Twilio features beyond `<Record>` + media download |

## 6. Expected per-turn latency (budget, not an SLA)

OpenAI publishes no latency SLA for transcription, so treat these as planning estimates [INFERENCE], not
guarantees: the added latency per turn is (a) silence `timeout` (~5 s worst case, less when the caller presses
`#`), + (b) recording-availability delay (usually ~1 s), + (c) one short-file Whisper round-trip (a few seconds
for a 5–30 s clip) + download. Practical budget: **~3–8 s overhead per turn** dominated by endpoint silence
detection, not by Whisper inference. Keep turns short (`maxLength` 30–60 s) and prefer MP3 download to minimize
transfer. Measure on the real trial number during the voice-loop build; if turns feel sluggish, lower `timeout`
before touching anything else.

## Sources

- OpenAI Speech-to-text guide (endpoint, formats, 25 MB, `language` vs `languages`, prompt limits, streaming):
  https://developers.openai.com/api/docs/guides/speech-to-text
- OpenAI Create-transcription reference (request/response schema, `timestamp_granularities`, usage objects):
  https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
- OpenAI Pricing → Transcription models (Whisper $0.006/min):
  https://developers.openai.com/api/docs/pricing
- openai/whisper repo (model sizes, `large`/`turbo` checkpoints, MIT license, language support):
  https://github.com/openai/whisper
- Twilio `<Record>` TwiML reference (attributes, `action` params, file-not-ready warning, `transcribe` limits):
  https://www.twilio.com/docs/voice/twiml/record
- Twilio Recordings resource (media download, statuses, dual-channel note):
  https://www.twilio.com/docs/voice/api/recording
