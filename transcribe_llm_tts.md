# Transcription, LLM, and TTS Latency Design

Status: implemented. Provider/model selection and threshold tuning remain gated
on the evaluation corpus below.

## Decision

Keep the Twilio bidirectional Media Streams design in `twilio.md` and optimize the
three modules behind it:

1. Sarvam realtime STT is the latency-first primary path.
2. OpenRouter file transcription is a selective fallback and comparison path, not
   the live primary.
3. The server owns dialogue and Booking state; the LLM produces natural wording
   rather than controlling the workflow.
4. Sarvam streaming TTS is the preferred live speech path because it can return
   native 8 kHz mu-law audio over a persistent WebSocket.
5. STT, LLM, TTS, and Twilio playback overlap wherever correctness permits.

Provider choices must be confirmed by replaying real Twilio call audio. Published
provider features do not predict accuracy for Indian Patient names, phone digits,
or noisy PSTN speech.

## Scope

- Reduce final-speech-to-first-audio latency.
- Improve tail latency and remove avoidable serial work.
- Preserve or improve transcription fidelity.
- Make replies brief, natural, and consistent.
- Keep Booking writes deterministic and server-authorized.
- Retain Twilio, the local tunnel, Picktime automation, and `clinic.md` as the
  clinic guide.

## Non-goals

- Moving to speech-to-speech or direct SIP.
- Replacing Twilio Media Streams.
- Treating `clinic.md` as live Availability.
- Letting an LLM infer that a Booking is confirmed without server state.
- Choosing STT thresholds or models without a Twilio audio evaluation corpus.

## Current Critical Path

```text
Caller final speech
  -> local Endpointing silence window
  -> Sarvam realtime speech_end
  -> wait for transcript.final
     -> on timeout, upload complete WAV to REST STT
  -> reload clinic.md
  -> build full LLM prompt and tools
  -> OpenRouter provider queue + prompt prefill
  -> wait until enough punctuation exists for one sentence
  -> TTS request / streaming socket
  -> first 8 kHz mu-law audio
  -> Twilio outbound media
```

Availability and Booking can add:

```text
LLM round 1
  -> tool request
  -> Picktime browser work
  -> LLM round 2
  -> TTS
```

The main avoidable serializations are:

- Local Endpointing waits before requesting a Sarvam final.
- A failed realtime final can consume the full timeout before REST starts.
- OpenRouter file transcription cannot overlap recognition with Caller speech.
- LLM tool decisions can require another complete model round after slow browser
  work.
- The prompt currently carries tools even when the Turn cannot validly use them.
- TTS starts only after the text chunker finds terminal punctuation.
- Each sentence is currently a separate TTS utterance, resetting prosody and
  provider buffering.
- Request/response TTS reads the entire HTTP response before sending any audio.
- Current per-sentence Twilio playback marks can prevent TTS for the next sentence
  from starting until the previous sentence has audibly completed. `twilio.md`
  moves the mark to the logical response tail.

## Worktree Foundations Already Present

Do not reimplement these changes:

- `src/sarvamRealtime.ts` streams Twilio mu-law audio during Caller speech.
- Realtime Sarvam finals are correlated by `utterance_idx` so a missing timed-out
  final does not discard the next valid final.
- `src/openrouter.ts` avoids duplicating the current transcript when it is already
  the final history entry.
- LLM generation defaults to 200 tokens, reasoning effort `none`, and no parallel
  tool calls.
- `src/live.ts` continues draining LLM tokens while queued TTS work runs.
- `src/sarvamStreamTts.ts` keeps one TTS WebSocket per call and requests native
  8 kHz mu-law.
- VAD is loaded before the voice server reports ready.

These foundations are incomplete rather than final. In particular, the current
TTS interface still accepts one complete string per utterance and does not allow
incremental text input or per-response cancellation.

## Ranked Quick Wins

1. Keep Sarvam realtime STT primary; do not put OpenRouter file STT on every Turn.
2. Add a scoped Sarvam `prompt` containing clinic, doctor, service, and Location
   terms.
3. Use stable partial transcripts to start read-only Availability work before the
   Caller finishes, never to write a Booking.
4. Set one measured turn deadline and start the fallback before waiting through
   stacked timeouts.
5. Move Availability selection and Booking authorization out of LLM tool loops.
6. Send only the relevant Slot shortlist and active dialogue state to one LLM call.
7. Pass a stable OpenRouter `session_id` and keep the prompt prefix byte-stable.
8. Keep reasoning off and reduce spoken output toward 80-150 tokens after reply
   corpus validation.
9. Feed phrase-sized text into one persistent Sarvam TTS utterance instead of
   flushing every sentence.
10. Cache fixed speech and use native mu-law in the Sarvam REST fallback.
11. Add abort signals and first-result deadlines to every provider operation.
12. Tune Endpointing, STT stream type, and STT model only against real Twilio
    fixtures.

## Transcription Provider Matrix

| Path | During-speech recognition | Telephony audio | Context hints | Language behavior | Latency role |
|---|---|---|---|---|---|
| Sarvam realtime | Yes, partial and final events over one WebSocket | Accepts 8 kHz `mulaw` directly | `prompt`; live `config.update` | `en-IN`, `hi-IN`, `kn-IN`, `auto`; final modes include `codemix` | Recommended primary |
| Sarvam REST | No; uploads completed utterance | Current code uploads 8 kHz WAV | Model/mode/language; evaluate current REST hint support separately | Indian English and Indic language modes | Same-provider fallback |
| OpenRouter STT | No ongoing-call WebSocket; completed audio request | Upload WAV or another supported file | Normalized multipart `prompt` is accepted but ignored; some provider-specific options exist | Singular ISO language or auto, depending on model/provider | Selective independent fallback |
| OpenAI direct realtime | Yes, using OpenAI Realtime transcription | Requires a second live provider integration and format handling | Model-specific prompting and Realtime config | Model-specific | Future benchmark, not current recommendation |
| OpenAI direct file transcription | Completed file; file response can stream text while processing | Upload completed WAV | Current `gpt-transcribe` supports `prompt`, `keywords`, and expected `languages` | Multilingual hints and detected languages | Accuracy benchmark |

Primary sources:

- Sarvam realtime accepts 8/16 kHz, `mulaw`, partial/final transcripts, `prompt`,
  `fast`/`balanced`, manual or server VAD, `auto` language detection, `codemix`, and
  live configuration updates:
  <https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming>
- OpenRouter exposes `POST /api/v1/audio/transcriptions`, including discoverable
  transcription models. Normal routing preferences do not apply to STT requests,
  and the normalized multipart `prompt` is ignored:
  <https://openrouter.ai/docs/guides/overview/multimodal/stt>
- OpenAI recommends `gpt-transcribe` for new completed-file transcription and
  supports prompts, keywords, and expected languages. OpenAI directs ongoing call
  audio to its Realtime transcription path:
  <https://developers.openai.com/api/docs/guides/speech-to-text>

### OpenRouter GPT-4o Clarification

OpenRouter now has a real STT endpoint and documents
`openai/gpt-4o-transcribe` as an STT model. It is not the same as sending audio to
Chat Completions, and it is not a persistent realtime transcription socket.

Important limitations for this design:

- The full endpointed utterance must be uploaded before recognition starts.
- OpenRouter's normal `provider.sort`, `order`, `only`, and `ignore` routing
  preferences are not applied to transcription requests.
- The normalized `prompt` field is ignored.
- OpenRouter documents `openai/gpt-4o-transcribe` as rejecting
  `verbose_json`, so do not rely on Whisper-style segments for confidence gates.
- Model availability can change. Check
  `GET /api/v1/models?output_modalities=transcription` at startup validation or
  deployment time rather than assuming a slug exists forever.

This makes OpenRouter GPT-4o useful as an independent second decode, but inferior
to Sarvam realtime for the latency-first primary path.

### Recommended STT Configuration

Initial production candidate:

```text
Primary:  Sarvam saaras:v3-realtime
Stream:   fast
Encoding: mulaw
Rate:     8000 Hz
Mode:     transcribe
Language: en-IN
Boundary: manual, owned by the call controller
Fallback: Sarvam REST for transport failure
Second opinion: OpenRouter openai/gpt-4o-transcribe only on selected critical Turns
```

Run these A/B candidates before locking the primary:

```text
saaras:v3-realtime fast
saaras:v3-realtime balanced
saaras:v4-realtime fast
saaras:v4-realtime balanced
```

Sarvam describes `fast` as the conversational-agent setting and `balanced` as
slightly slower but more accurate. The repository currently ignores partial text,
so `fast` only earns its accuracy tradeoff after partials are used for barge-in or
safe speculation. Compare final transcript latency and field accuracy, not only
partial TTFT.

Do not switch the default model or stream type from provider descriptions alone.
The decision needs the corpus described below.

### STT Prompt

Pass a short, stable terminology prompt to Sarvam:

```text
Bobby Clinic, Bobby Hospital, Bangalore, Bob Gowda, Appointment
```

Generate it from structured clinic guide fields where possible. Add service,
doctor, and Location names; exclude unknown Patient names. Reconfigure only at an
utterance boundary.

Prompting can bias a model into hallucinating expected terms. The corpus must test
both utterances containing a term and utterances where no prompted term was spoken.

OpenAI's direct `gpt-transcribe` supports literal `keywords`, while OpenRouter's
normalized STT `prompt` is ignored. Do not design one provider-neutral hint field
that silently does nothing. Each STT adapter must report which hints it applied.

### Language Strategy

Use `en-IN` when the clinic intentionally supports English-only calls. A fixed
language avoids short-utterance language-detection ambiguity.

If Hindi/Kannada-English code-mixing is in scope, evaluate:

```text
language_code=auto
mode=codemix
```

Capture Sarvam's detected language and confidence. Do not enable `auto` globally
until tests cover short English names that resemble words in another language.

### Endpoint-to-Final Optimization

The lowest-risk near-term path keeps manual Endpointing:

1. Stream raw Twilio audio to Sarvam during speech.
2. Send `speech_end` immediately when local Endpointing fires.
3. Await the indexed final under a measured deadline.
4. Fall back without reconnecting or discarding the Turn.

Measure these separately:

```text
last speech sample -> local endpoint
local endpoint -> speech_end sent
speech_end sent -> transcript.final
fallback start -> fallback final
```

Potential improvements:

- Reduce ordinary trailing silence from the current configured value toward
  450-600 ms.
- Use a shorter minimum speech duration for expected `yes`, `no`, and digit Turns.
- Use a longer silence window while collecting Patient names or grouped phone
  digits.
- Shadow Sarvam's server VAD and compare its boundaries with local Silero before
  considering one authoritative VAD.
- Set the realtime-final timeout from measured p99 rather than the current fixed
  2-second default.
- For a critical Turn where a fallback is likely, start the independent fallback
  speculatively at the local endpoint instead of after the full realtime timeout.

Every threshold change above requires real Twilio audio. Synthetic VAD scores do
not model Indian accents, weak mobile microphones, traffic, or conversational
pauses.

### Critical-field Fidelity

STT confidence is not sufficient authorization for a Booking. Track these fields
separately:

```text
Patient name
Patient phone
date preference
selected Slot date/time
Location
affirmative confirmation
```

Use selective second decoding only when the active dialogue state expects a
critical field or the primary transcript fails a field grammar.

Examples:

- Phone: accept caller ID when confirmed; otherwise require a valid normalized
  number and read it back in grouped digits.
- Patient name: ask again when two independent decodes disagree materially.
- Date/time: resolve only against live candidate Slots; ask when several candidates
  match.
- Confirmation: classify against the exact readback generation. An interrupted or
  modified readback invalidates a later bare `yes`.

Do not run dual STT on every FAQ Turn. That spends latency and money where the
transcript is not safety-critical.

## LLM Flow

### Target Responsibility Split

The current assistant both decides workflow and writes conversational text. Split
those responsibilities:

```text
DialogueReducer (deterministic server code)
  -> updates structured state
  -> decides required read/tool/write action

TurnSpeaker (LLM)
  -> receives current dialogue act and relevant facts
  -> streams one brief natural reply
```

The LLM may extract a candidate entity, but server code validates and applies it.
The LLM never decides that a Booking is confirmed and never constructs final write
parameters from prose history.

### Structured Dialogue State

Keep at least:

```ts
interface DialogueState {
  intent: 'faq' | 'availability' | 'book' | 'goodbye' | 'unknown';
  phase: 'idle' | 'choosing-slot' | 'collecting-patient' | 'awaiting-confirmation' | 'booking';
  selectedSlot?: {
    serviceId: string;
    doctorId: string;
    locationId: string;
    startsAt: string;
  };
  patient?: {
    name?: string;
    phone?: string;
    phoneSource?: 'caller-id' | 'spoken';
  };
  readback?: {
    generation: number;
    stateVersion: number;
    played: boolean;
  };
  confirmation?: {
    readbackGeneration: number;
    affirmative: boolean;
  };
}
```

Text history exists for tone and references. It is not the Booking database.

### Remove Avoidable Tool Rounds

Normal target flows:

```text
FAQ:
  final transcript -> one streamed LLM call -> TTS

Availability:
  stable partial starts read-only prefetch
  final transcript + compact Slot shortlist -> one streamed LLM call -> TTS

Collecting fields:
  DialogueReducer chooses missing field -> deterministic or one LLM wording call

Confirmed Booking:
  server validates state -> Picktime write -> deterministic success/failure speech
```

Do not ask the LLM to call `get_availability` after a Turn is already known to need
Availability. Controller-owned prefetch removes one complete LLM round.

Do not ask the LLM to call `propose_booking`. The controller can write only after
the state machine proves that the exact readback played and was confirmed in a
later Caller Turn.

Retain model tools only for genuinely ambiguous intents during migration. Expose
only the tool valid in the current phase, not both tools on every Turn.

### Prompt Shape

Keep the cacheable prefix stable:

```text
system behavior
clinic guide
tool schemas, when any
recent dialogue history
structured state for this Turn
relevant live Slot shortlist
current transcript
```

Move dynamic Availability out of the system message and into a late context
message. Avoid timestamps in the static prefix. Keep the exact model slug stable.

Pass `session_id=<callSid or opaque stream ID>` so OpenRouter can keep a call on a
provider endpoint and maximize provider prompt-cache hits. OpenRouter documents
TTFT as network + queue + prefill and recommends a stable `session_id` plus a
byte-stable prefix for agent loops:
<https://openrouter.ai/docs/guides/best-practices/latency-and-performance>

The complete clinic guide is small enough to keep verbatim, but it should be loaded
and parsed once, then reused until a file watcher publishes a new immutable guide.
Disk reads are not likely the main latency, but a stable in-memory string helps
prompt caching and removes per-Turn variability.

### Context Budget

- Keep 6-10 recent spoken messages for conversational continuity.
- Keep all Booking facts in structured state regardless of history trimming.
- Include only 2-4 relevant candidate Slots, not every Slot across all Locations
  and days.
- Include no holding lines in model history.
- Include the current transcript exactly once.
- Avoid a Turn history beginning with an orphaned assistant message after trimming.

### Generation Configuration

Current worktree defaults are a good baseline:

```json
{
  "max_tokens": 200,
  "reasoning": { "effort": "none" },
  "parallel_tool_calls": false,
  "stream": true
}
```

After collecting real response lengths, target 80-150 tokens for ordinary Turns.
Do not reduce the cap until emergency and Booking readbacks fit reliably.

Reasoning tokens count as generated output and increase latency. OpenRouter supports
`reasoning.effort="none"` on compatible models:
<https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>

Pin a concrete model slug for reproducibility. A moving `latest` alias can change
reasoning behavior and invalidate latency baselines.

### Provider Routing

For short voice replies, TTFT matters more than high decode throughput.

Start with:

```json
{
  "provider": {
    "sort": "latency",
    "require_parameters": true,
    "preferred_max_latency": { "p90": 2.0 }
  },
  "session_id": "opaque-call-id"
}
```

The p90 number is an initial preference, not a hard timeout. OpenRouter documents
performance preferences as soft reordering over a rolling window. Keep an
application `AbortSignal` deadline regardless of routing.

Log requested model, served model, provider, request ID, fallback attempt, TTFT,
and prompt/completion usage. If latency sorting causes voice/style instability,
pin the best measured provider with one fallback. Do not guess from one call.

### Streaming and First Speakable Text

Do not wait exclusively for `.`, `!`, or `?`. Use a voice chunker that emits a
speakable phrase when one of these is true:

- A safe punctuation boundary is present.
- The buffer is at least 30-50 characters and ends at a clause/word boundary.
- A short-answer timeout expires after the first token.
- The full response ends.

Avoid splitting after abbreviations such as `Dr.` or inside dates, times, phone
numbers, and currency. The chunker emits text to the same logical TTS response; it
does not create separate voices or Twilio playback marks.

### Naturalness Rules

The LLM wording contract should enforce:

- Answer first; acknowledge only when it adds meaning.
- Do not echo the Caller request.
- Use contractions.
- Ask at most one question.
- Use one or two short spoken sentences.
- Avoid the same opening on consecutive Turns.
- Use deterministic text for emergencies, Booking success/failure, and readbacks.
- Emit an explicit `endCall` intent for a clear goodbye.

The current worktree already adds anti-echo and anti-generic-opening instructions.
Structured dialogue state is still required to prevent repeated field questions.

## TTS Provider Matrix

| Path | First-audio behavior | Telephony conversion | Session reuse | Recommendation |
|---|---|---|---|---|
| Sarvam streaming Bulbul v3 | Audio chunks over WebSocket | Native 8 kHz mu-law | Persistent per call | Primary |
| Sarvam REST Bulbul v3 | Full JSON response | API accepts 8 kHz and `mulaw`; current code requests WAV and converts | HTTP request per utterance | Pre-audio fallback |
| OpenRouter `/audio/speech` current adapter | Current code waits for full response body | PCM 24 kHz is downsampled to 8 kHz mu-law | HTTP request per sentence | Benchmark fallback |
| OpenAI direct GPT-4o mini TTS | HTTP chunked streaming; PCM/WAV recommended for fastest response | PCM is 24 kHz, requiring incremental resampling | HTTP request per response | Optional benchmark |

Primary sources:

- Sarvam streaming TTS supports a persistent WebSocket, `text` chunks, `flush`,
  8 kHz sample rate, mu-law codec, buffer sizing, pace, temperature, and Bulbul v3
  pronunciation dictionaries:
  <https://docs.sarvam.ai/api-reference/text-to-speech/stream>
- Sarvam REST accepts `mulaw`, 8 kHz, pace, temperature, and a Bulbul v3
  pronunciation dictionary:
  <https://docs.sarvam.ai/api-reference/text-to-speech/convert>
- OpenAI's Speech API supports HTTP streaming and recommends WAV or PCM for the
  fastest response. Its PCM output is 24 kHz:
  <https://developers.openai.com/api/docs/guides/text-to-speech>

### Recommended TTS Configuration

```text
Primary:       Sarvam bulbul:v3 WebSocket
Voice:         selected by listening evaluation
Language:      en-IN initially
Sample rate:   8000
Codec:         mulaw
Pace:          start at 1.0; evaluate 1.05-1.1
Temperature:   start near 0.4-0.6 and evaluate consistency
Connection:    one persistent socket per call
Fallback:      Sarvam REST before any primary audio has played
```

Do not switch to a REST fallback after partial primary audio has played. Repeating
the sentence from its beginning sounds broken. After partial playback failure,
clear the response and use a short cached failure line or reprompt.

### Incremental TTS Interface

Replace the current whole-string interface for the streaming path with a response
session:

```ts
interface StreamingSpeech {
  begin(options: { generation: number; language: string }): SpeechResponse;
  close(): void;
}

interface SpeechResponse {
  pushText(text: string): void;
  finishText(): void;
  audio(): AsyncIterable<Buffer>;
  cancel(reason: string): void;
}
```

The module hides provider text buffering, `flush`, completion events, cancellation,
and late chunks. The call controller sees one logical response even when the LLM
delivers several phrases.

For Sarvam:

1. Configure once when the per-call socket opens.
2. Push safe phrase chunks as the LLM produces them.
3. Let the provider's `min_buffer_size` begin synthesis when enough text exists.
4. Send one `flush` only at the response tail.
5. Stream each returned mu-law chunk immediately to the Twilio transport.
6. Ignore audio tagged to a cancelled generation.

Start `min_buffer_size` at 30-50 characters and `max_chunk_length` around 100-150.
Lower buffering may improve first audio while harming pronunciation/prosody. Select
the values with a listening test rather than a microbenchmark alone.

### REST Fast Path

`src/sarvam.ts` currently asks REST TTS for WAV and calls `wavToMulaw`. Change the
request to native 8 kHz mu-law if the live response confirms that the returned
bytes match the requested codec. This removes WAV parsing and resampling.

Because Sarvam's REST response text still describes WAV in places while the request
schema lists multiple output codecs, add a provider integration test and inspect
`content_type` or a known audio prefix before deleting the WAV fallback.

`src/tts.ts` currently calls `res.arrayBuffer()`, so OpenRouter/OpenAI-compatible
TTS cannot produce first audio until generation finishes. If that path remains:

- Read `res.body` incrementally.
- Prefer raw PCM.
- Preserve a one-byte carry between odd PCM chunks.
- Resample incrementally while preserving filter state across chunks.
- Emit mu-law as soon as samples are available.

Benchmark this against Sarvam native mu-law. It remains more CPU and code than the
Sarvam path.

### Pronunciation and Spoken Normalization

Normalize text before TTS, not inside prompts:

- Expand dates into unambiguous spoken forms.
- Render times naturally while retaining morning/afternoon context.
- Say fees in a form the selected voice pronounces consistently.
- Group phone digits for confirmation.
- Avoid abbreviations such as `Dr.` when the sentence chunker could split them.

Use a Bulbul v3 pronunciation dictionary for stable clinic, doctor, service, and
Location pronunciations. Do not add Patient names globally.

### Fixed Audio Cache

Follow `twilio.md` for greeting, hold, reprompt, failure, and goodbye caching. The
cache sits before TTS but all bytes still pass through Twilio pacing, clear, and
response-tail marks.

## Overlapped Target Timeline

```text
Caller speaking
  Sarvam receives mu-law continuously
  partials arrive
  stable booking partial may start read-only Availability prefetch

Last speech sample                         t=0
  local endpoint                         t=450-600 ms target
  Sarvam speech_end sent                 immediately
  Sarvam final                           +50-300 ms target, measure
  DialogueReducer                        +0-10 ms
  await already-running Availability     often 0 ms on a warm/shared read
  OpenRouter request starts              immediately
  first model token                      +250-800 ms target, measure
  first safe phrase                      +50-250 ms
  Sarvam TTS starts buffering text       immediately
  first TTS audio                        +100-400 ms target, measure
  first Twilio media frame               <25 ms transport target

Meanwhile
  LLM continues producing text
  phrase chunker continues feeding one TTS response
  TTS continues producing audio
  Twilio continues playing audio
```

These are engineering targets, not provider SLAs. The first benchmark must replace
them with p50/p95 values from the actual local tunnel and provider accounts.

Deterministic paths should bypass the LLM:

```text
confirmed Booking -> Picktime result -> fixed success/failure wording -> TTS
missing phone      -> fixed short question -> TTS
emergency          -> exact clinic guide line -> cached/deterministic TTS
goodbye            -> fixed goodbye -> cached TTS
```

## Deep Module Seams

### `RealtimeTranscriber`

```ts
interface RealtimeTranscriber {
  pushAudio(mulaw: Buffer): void;
  beginUtterance(context: TranscriptionContext): void;
  partials(): AsyncIterable<PartialTranscript>;
  finalize(signal: AbortSignal): Promise<TranscriptResult>;
  reconfigure(context: TranscriptionContext): Promise<void>;
  close(): void;
}
```

`TranscriptResult` should contain provider, model, text, utterance index, language,
applied hints, timing, and whatever quality metadata the provider actually returns.
Do not manufacture a provider-neutral confidence number.

### `DialogueController`

```ts
interface DialogueController {
  handleCallerTurn(input: TranscriptResult, signal: AbortSignal): AsyncIterable<DialogueEvent>;
  interruptResponse(generation: number): void;
  close(reason: string): void;
}
```

The controller owns structured dialogue state, Availability intent, readback
generation, Booking authorization, LLM calls, and deterministic reply selection.

### `StreamingSpeech`

Use the incremental interface above. At least two adapters exist: Sarvam streaming
and an HTTP streaming fallback, so this is a real seam.

## Deadlines and Failure Semantics

Use one Turn-level `AbortController`. Child operations inherit its signal.

Initial limits to validate:

| Phase | Initial limit | Failure behavior |
|---|---:|---|
| Realtime STT final after endpoint | 800-1200 ms | Use already-started or immediate fallback |
| File STT fallback | 2500 ms | Reprompt; never guess critical fields |
| LLM first token | 1500-2000 ms | Speak cached context-specific hold or use deterministic fallback |
| LLM total | 4000 ms | Finish buffered safe phrase or reprompt |
| TTS first audio | 800-1200 ms | Fallback only if no audio played |
| TTS inter-chunk idle | 1500-2500 ms | Clear partial response; do not replay from start |
| Whole Turn | 6000 ms | Cancel remaining work and use safe recovery |

Set final values from live p99 measurements. Avoid layered five-attempt retries
inside a six-second Turn. One owner controls the deadline and retry budget.

Rules:

- A call close aborts STT, LLM, tools, and TTS.
- Barge-in aborts the active LLM/TTS generation but preserves the new Caller audio.
- A superseded partial can cancel speculative Availability reads when practical.
- Read-only operations may retry once within remaining Turn budget.
- Booking writes do not retry after side effects begin.
- A realtime STT empty final may use REST re-decode rather than immediately count
  as no speech.
- Provider errors must carry safe request IDs and timings, never credentials or
  Patient fields.

## Observability

Use a monotonic clock. Add or preserve:

```text
vad:last-speech
vad:endpoint
stt:speech-start
stt:first-partial
stt:speech-end-sent
stt:final
stt:fallback-start
stt:fallback-final
dialogue:reduced
availability:speculative-start
availability:ready
llm:request
llm:first-token
llm:first-speakable
llm:done
tts:text-first
tts:request-or-flush
tts:first-audio
tts:done
twilio:first-outbound-sent
twilio:playback-complete
```

Record:

- Model, provider, and actual served model.
- STT mode, stream type, language, applied prompt hash, partial count, and source.
- Endpoint-to-final and last-speech-to-final.
- LLM message count, prompt tokens, completion tokens, TTFT, and tool rounds.
- TTS text characters, phrase count, time to first audio, audio bytes, and fallback.
- Whether Availability was warm, speculative, or cold.
- Whether the response was deterministic, LLM-worded, interrupted, or cleared.

Do not sum durations that overlap. The primary user metric is:

```text
last Caller speech sample -> first Twilio outbound audio frame
```

Also report p50, p95, and p99. Averages hide provider queue spikes.

## Evaluation Corpus

Build a consented, deidentified set of original Twilio 8 kHz mu-law fixtures.

Include:

- Short `yes`, `no`, `haan`, and single digits.
- Common and uncommon Indian Patient names.
- Initials and multi-part surnames.
- Bobby Clinic, Bobby Hospital, Bob Gowda, Bangalore, and service names.
- Dates and times in several spoken forms.
- Ten-digit Indian mobile numbers spoken continuously and in groups.
- Indian English across several speakers and mobile networks.
- Hindi-English and Kannada-English code-mixing if supported by clinic policy.
- Quiet speech, clipping, packet gaps, traffic, fan noise, television, and another
  nearby speaker.
- Long pauses inside names and numbers.

Measure:

```text
ordinary WER/CER
exact Patient-name match
exact phone-digit match
date/time semantic match
Location classification accuracy
missed-short-answer rate
false endpoint rate
clipped-first-word rate
hallucinated-prompt-term rate
last-speech-to-final p50/p95/p99
```

Store expected critical fields separately from the reference transcript. A decode
can have mediocre WER and still capture every field needed for the Turn, or good WER
and one dangerous wrong digit.

## Test Matrix

### Deterministic

- Realtime final arrives before timeout.
- Realtime final is empty and REST succeeds.
- Realtime final times out; old indexed final never arrives; next Turn remains
  correct.
- Stable partial starts one Availability read; changed partial does not write.
- Primary and second decode disagree on a Patient name.
- Short confirmation and phone grammar rejection.
- Static prompt prefix remains byte-identical across Turns.
- Current transcript appears once.
- FAQ Turn exposes no Booking tools.
- Availability Turn uses one LLM round with injected shortlist.
- Booking write occurs only after played readback plus later confirmation.
- LLM stream continues while TTS emits audio.
- Phrase chunker handles `Dr.`, dates, times, currency, and phone digits.
- Sarvam TTS receives several text chunks and one final flush.
- REST TTS native mu-law validation and WAV fallback.
- Abort during STT, LLM, TTS, and Picktime read settles every promise.
- TTS failure before and after first audio.
- Four concurrent calls keep STT/TTS sockets and state isolated.

### Live Read-only

- Replay the same corpus through every STT candidate.
- Measure cold and warm provider sockets.
- Measure OpenRouter provider TTFT across time-of-day windows.
- Compare LLM routing with and without `session_id`.
- Compare full Availability block versus 2-4 Slot shortlist.
- Compare sentence TTS calls versus one incremental response.
- Compare Sarvam TTS buffer sizes, voices, pace, and temperature.
- Compare fixed phrase cache hit and miss.
- Run one and four concurrent calls.

Live Booking tests remain dry runs or explicit, isolated save tests under the
existing Picktime safety contract.

## Acceptance Targets

Targets measured at the local process boundary:

| Metric | Target |
|---|---:|
| Normal last-speech to STT final | p50 <= 700 ms, p95 <= 1200 ms |
| Normal STT final to LLM first token | p50 <= 500 ms, p95 <= 1200 ms |
| LLM first token to first speakable text | p50 <= 150 ms |
| First speakable text to TTS first audio | p50 <= 300 ms, p95 <= 800 ms |
| Last-speech to first Twilio audio | p50 <= 1000 ms, p95 <= 1500 ms |
| Deterministic reply after STT final | first TTS text <= 20 ms |
| OpenRouter tool rounds on normal Turn | 0 |
| LLM calls on normal Turn | 1 or 0 |
| Booking after interrupted readback | 0 occurrences |
| Phone digit exactness | 100% before Booking, using clarification when needed |

Provider and tunnel conditions may make a latency target temporarily unattainable.
Do not weaken Booking safety to hit it. Report the failing phase and retain the
measurement.

## Implementation Sequence

### 1. Build the replay benchmark

Add paced 20 ms Twilio audio replay and phase timing before changing defaults.

Completion criterion: one command reports field accuracy and p50/p95/p99 latency
for every STT candidate on identical fixtures.

### 2. Complete Sarvam STT context and partial handling

Add terminology prompt, partial events, applied-config traces, and empty-final
fallback. Keep writes forbidden from partials.

Completion criterion: prompted and unprompted corpus runs quantify both critical
field gains and hallucinated-term regressions.

### 3. Add OpenRouter GPT-4o selective fallback

Implement the OpenRouter STT endpoint as a completed-utterance adapter. Trigger it
only from dialogue state or primary failure.

Completion criterion: ordinary FAQ Turns make zero OpenRouter STT calls, critical
fallbacks are deadline bounded, and disagreement always clarifies rather than
guessing.

### 4. Introduce structured dialogue state

Build `DialogueReducer` and move Slot, Patient, readback, and confirmation facts
out of prose history.

Completion criterion: server tests prove no LLM output can directly authorize a
Booking.

### 5. Remove normal tool rounds

Make Availability intent controller-owned, inject a compact shortlist, and perform
confirmed writes directly from validated state.

Completion criterion: FAQ and Availability replies need at most one LLM request;
confirmed Booking result speech needs none.

### 6. Stabilize and bound OpenRouter

Add `session_id`, a stable prefix, late dynamic context, application deadlines, and
measured provider preferences.

Completion criterion: traces identify provider/model/TTFT, the current transcript
appears once, and p95 TTFT improves without response-quality regression.

### 7. Deepen streaming TTS

Replace one-string utterances with incremental text input, one response-tail flush,
cancellation, and generation IDs.

Completion criterion: the first phrase produces audio while the LLM is still
running, a two-sentence reply is one prosodic response, and interruption emits no
late audio.

### 8. Optimize fallbacks and fixed speech

Add native Sarvam REST mu-law after format verification, HTTP-body streaming for
any retained PCM fallback, and the fixed cache from `twilio.md`.

Completion criterion: a fixed cache hit makes no provider request, and every
fallback either begins before any primary audio or clears without replay.

### 9. Tune against live data

A/B Endpointing, Sarvam versions/stream types, TTS buffering, pace, and OpenRouter
routing.

Completion criterion: one selected configuration meets the accuracy gates and has
the best p95 last-speech-to-first-audio latency across at least 100 replayed Turns.

## Rollout

Use per-call feature assignments and log them:

```text
stt_model
stt_stream_type
stt_language_mode
stt_prompt_version
openrouter_routing_version
dialogue_controller_version
tts_chunking_version
tts_voice
```

Roll out in this order:

1. Metrics only.
2. Prompt and partial-based read-only speculation.
3. Structured dialogue state in shadow mode.
4. Controller-owned Availability.
5. Controller-authorized Booking.
6. Incremental TTS.
7. Endpoint and model tuning.

Compare abandonment, reprompts, transcript disagreement, missed speech, Booking
clarifications, Booking failures, and latency percentiles. Keep an immediate flag
to return to the previous adapter/configuration without changing Twilio handling.

## Primary Sources

- OpenRouter Speech-to-Text:
  <https://openrouter.ai/docs/guides/overview/multimodal/stt>
- OpenRouter latency and routing:
  <https://openrouter.ai/docs/guides/best-practices/latency-and-performance>
- OpenRouter provider selection:
  <https://openrouter.ai/docs/guides/routing/provider-selection>
- OpenRouter reasoning control:
  <https://openrouter.ai/docs/guides/best-practices/reasoning-tokens>
- OpenRouter prompt caching and sticky sessions:
  <https://openrouter.ai/docs/guides/best-practices/prompt-caching>
- OpenAI Speech-to-Text:
  <https://developers.openai.com/api/docs/guides/speech-to-text>
- OpenAI transcription endpoint:
  <https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create>
- OpenAI Text-to-Speech:
  <https://developers.openai.com/api/docs/guides/text-to-speech>
- Sarvam realtime Speech-to-Text:
  <https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming>
- Sarvam streaming Text-to-Speech:
  <https://docs.sarvam.ai/api-reference/text-to-speech/stream>
- Sarvam REST Text-to-Speech:
  <https://docs.sarvam.ai/api-reference/text-to-speech/convert>
- Twilio transport design for this repository: `twilio.md`
