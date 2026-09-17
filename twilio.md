# Twilio Media Streams Latency Design

Status: implemented. Barge-in stays off by default (`BARGE_IN=false`) until the
acceptance gate below passes on real Twilio fixtures.

## Decision

Keep Twilio bidirectional Media Streams as the phone transport. Continue using one
`<Connect><Stream>` WebSocket for the full call and native 8 kHz mono G.711 mu-law
audio in both directions.

This design does not replace Twilio, adopt direct SIP, change the local tunnel, or
move the voice server to regional hosting.

## Goals

- Start warm-cache greeting audio within 300 ms of Twilio's `start` event.
- Keep transport enqueue-to-send latency below 25 ms when the socket is healthy.
- Start a normal reply within 1 second of the Caller's final speech at p50 and
  within 1.5 seconds at p95, measured locally at the Twilio WebSocket.
- Stop audible assistant speech within 250 ms of sustained Caller barge-in.
- Never resume listening or start the no-response timer while Twilio still has
  assistant audio queued.
- Prevent outbound buffering from growing without a bound.
- Preserve every audio byte and maintain booking confirmation safety through an
  interruption.

## Non-goals

- Changing telephony providers.
- Replacing the local tunnel.
- Selecting a different STT, LLM, or TTS provider.
- Tuning STT accuracy or Endpointing thresholds beyond the barge-in requirements
  described here.
- Changing Picktime booking behavior.

## Current State

The current streaming path is:

```text
POST /voice/incoming
  -> Twilio <Connect><Stream>
  -> /stream WebSocket
  -> StreamSession
  -> LiveCallSession
  -> STT -> LLM -> TTS
  -> StreamSession.sendAudio
  -> Twilio playback
```

Relevant modules:

- `src/app.ts`: incoming Twilio webhook and stream TwiML.
- `src/stream.ts`: Twilio WebSocket messages and media transport.
- `src/live.ts`: call turn coordination, Endpointing, LLM, and speech.
- `src/server.ts`: startup and adapter wiring.
- `src/endpoint.ts`: local VAD and utterance boundaries.
- `src/sarvamStreamTts.ts`: persistent per-call streaming TTS.

The current worktree already has these useful foundations:

- One persistent bidirectional Media Stream per call.
- Native 8 kHz mu-law between Twilio and realtime Sarvam adapters.
- Twilio `mark` send/receive support.
- VAD loading before the HTTP server reports ready.
- LLM token draining while TTS jobs execute.

The playback mark currently belongs to each synthesized sentence because
`LiveCallSession.emitAudio` waits for playback. That must be changed. Waiting for a
mark after every sentence prevents the next sentence from being synthesized and
can introduce a new gap equal to network and scheduling latency.

The remaining gaps are:

- No paced outbound frame queue.
- No WebSocket backpressure or bounded buffering.
- No Twilio `clear` support.
- No barge-in while Endpointing is suspended.
- No cancellation contract for in-flight LLM or TTS work.
- No shared cache for fixed speech.
- Missing Twilio-specific first-frame, queue, mark, clear, and packet-continuity
  metrics.
- The WebSocket endpoint is attached after `listen()` rather than before the
  server begins accepting upgrades.

## Target Modules

### `TwilioMediaTransport`

Replace direct Twilio JSON construction in call logic with one deep transport
module. Its interface should be approximately:

```ts
type PlaybackResult =
  | { outcome: 'played'; mark: string }
  | { outcome: 'cleared'; mark: string; reason: string };

interface TwilioMediaTransport {
  enqueueMulaw(audio: Buffer): void;
  finishPlayback(): Promise<PlaybackResult>;
  clearPlayback(reason: string): void;
  close(reason: string): void;
  readonly stats: TwilioTransportStats;
}
```

The interface invariant is that `finishPlayback()` is an ordered barrier. It
resolves only after all audio enqueued before it has either played or been cleared.
Callers must not know about Twilio media envelopes, pacing timers, socket
backpressure, mark names, or clear acknowledgements.

`StreamSession` may become this module or contain it. Do not add a second shallow
wrapper that merely forwards every method.

### `LiveCallSession`

`LiveCallSession` owns conversational state and decides when speech may be
interrupted. It calls the transport interface but does not construct Twilio frames.

Use explicit phases:

```text
GREETING
LISTENING
FINALIZING
PLANNING
SPEAKING
INTERRUPTING
BOOKING
CLOSED
```

Only `LISTENING` can create a normal Caller Turn. `SPEAKING` may run interruption
detection but must not create a second Turn until sustained Caller speech promotes
the buffered candidate into the next Turn.

## Outbound Audio

### Native Format

Twilio must receive raw, headerless, base64-encoded 8 kHz mono mu-law audio.

On `start`, validate `start.mediaFormat`:

```text
encoding: audio/x-mulaw
sampleRate: 8000
channels: 1
```

Close and trace an unsupported format instead of silently producing corrupt audio.
Sarvam's streaming TTS should remain configured to emit this format directly. A
fallback that emits PCM or WAV should be converted exactly once at the TTS adapter
seam, never inside the Twilio transport.

### Pacing

Split arbitrary TTS chunks into 160-byte frames, representing 20 ms of 8 kHz
mu-law audio.

- Send the first available frame immediately.
- Schedule later frames against monotonic 20 ms deadlines.
- Preserve a partial final frame; do not drop or pad speech bytes unless Twilio
  requires it.
- Keep order across chunks from the streaming TTS adapter.
- Do not use one timer per frame. Use one pump owned by the transport.
- When the pump wakes late, send at most a small bounded burst. Do not dump an
  entire delayed response into Twilio's playback buffer.

Pacing keeps queued audio local, where `clear` can remove it immediately, instead
of placing seconds of uninterruptible audio inside Twilio's playback buffer.

### Backpressure

Extend `StreamSocket` with the real WebSocket's `bufferedAmount` or an equivalent
send-completion signal. The fake socket must expose the same interface.

- Pause the pump above a high-water mark.
- Resume below a low-water mark.
- Bound the local queue by audio duration, not only bytes.
- A suggested initial maximum is 30 seconds, matching the maximum utterance.
- If the bound is exceeded, clear the response, cancel its producer, and trace
  `outbound-overflow`. Never allow an unbounded call-level queue.

The exact water marks should be constants selected by transport tests, not new
environment variables unless live measurements show an operational need.

## Playback Marks

Send one Twilio `mark` after a complete logical reply, not after every audio chunk
or sentence.

The required order is:

```text
enqueue reply audio chunks
drain all local frames for that reply to the WebSocket
send one mark
wait for Twilio to return the same mark
commit spoken reply to history
resume Endpointing
start no-response timer
```

`finishPlayback()` places the mark barrier behind already queued local audio. It
must not send a mark immediately while audio remains in the local pacing queue.

Mark names must include a call-local monotonic sequence and response generation,
for example `reply-7-mark-1`. Never include Patient data.

Add a bounded mark timeout. On timeout:

1. Send `clear`.
2. Settle the barrier as `cleared`.
3. Trace `mark-timeout` with queued duration and socket state.
4. Close the call if transport state is no longer trustworthy.

Twilio returns outstanding marks when a buffer is cleared. The transport must
distinguish `played` from `cleared` using its own generation state; receiving a mark
alone does not prove that its audio played.

## Barge-in

### Detection

Continue examining the inbound Twilio track while the Receptionist is speaking.
Twilio bidirectional Media Streams provide the inbound Caller track, so outbound
assistant audio is not directly mixed into these frames.

Add an interruptible suspended mode to `Endpointer`:

```ts
endpointer.suspend({ detectInterruption: true });
```

In this mode:

- Score incoming audio with VAD.
- Retain pre-roll and candidate speech.
- Ignore brief noise and backchannels below the interruption threshold.
- Trigger interruption after sustained speech, initially 200 ms.
- Promote the retained candidate into the next utterance rather than discarding
  its first word.

Keep the existing fully muted suspend mode for phases where input must be dropped.
Do not overload a Boolean with both meanings.

The 200 ms value is an initial operating point, not a fidelity claim. Evaluate it
against real Twilio audio containing coughs, traffic, `yes`, `no`, and natural
interruptions before reducing it.

### Interruption Sequence

When sustained Caller speech is detected during an interruptible reply:

1. Transition `SPEAKING -> INTERRUPTING` atomically.
2. Call `transport.clearPlayback('caller-barge-in')`.
3. Abort the active LLM request.
4. Cancel the active TTS utterance and discard future TTS chunks for that response
   generation.
5. Preserve the VAD/STT pre-roll that triggered the interruption.
6. Do not commit unheard assistant text to conversation history.
7. Transition to `LISTENING` with the promoted utterance already in progress.

Every produced response needs a generation ID. Audio, marks, LLM tokens, and TTS
chunks from an older generation must be ignored after interruption.

### Cancellation Interfaces

Use `AbortSignal` for LLM requests and request/response TTS. Add an explicit
per-utterance cancellation method to streaming TTS if its protocol cannot consume
an `AbortSignal`.

Closing a whole Sarvam TTS socket is an acceptable first implementation, provided
the next response lazily creates a fresh socket. Cancellation must settle every
pending promise; it must not leave `speechTail`, `flush()`, or call shutdown
hanging.

### Booking Safety

An interrupted booking readback was not heard completely. Clear its readback
completion state and reject a later bare `yes` as confirmation.

A Booking may proceed only when:

- The complete deterministic readback reached a `played` mark.
- A later Caller Turn explicitly confirmed that same readback generation.
- The selected Slot and Patient details have not changed since the readback.

Transport interruption must never cancel a Booking after the write has begun. The
Booking operation remains non-retriable after side effects start; only its spoken
outcome may be interrupted.

## Fixed Audio Cache

Cache only fixed, non-Patient speech:

- Greeting after resolving the clinic name.
- Holding line.
- No-response line.
- Transcription reprompt.
- Generic failure line.
- Booking-system failure line.
- Goodbye after resolving the clinic name.

Do not cache replies containing Patient names, phone numbers, Slots, dates, or
other dynamic call data.

The cache key must include:

```text
TTS provider
model
voice/speaker
language
sample rate
encoding
exact text
```

Use one shared cache across calls. A cache hit returns immutable 8 kHz mu-law bytes
which enter the normal paced transport queue. It must not bypass marks, clear, or
backpressure.

For fast local restarts, optionally persist cache entries under a configured cache
directory. Use a versioned hash key and atomic rename. Cache files contain only
fixed phrases, never call audio or transcripts.

Startup behavior:

1. Load the clinic guide once.
2. Load valid disk cache entries.
3. Best-effort prewarm missing fixed phrases under a total deadline.
4. Start accepting calls even if prewarm failed; synthesize and fill lazily.

The persistent per-call Sarvam streaming socket remains useful for dynamic speech.
The fixed cache sits in front of it rather than replacing it.

## Startup Ordering

Build the HTTP server explicitly rather than calling `app.listen()` before the
stream endpoint exists:

```text
load config
load VAD
load clinic guide
initialize fixed-audio cache
create Express app
create HTTP server
attach /stream upgrade handler
start listening
report ready
```

`/healthz` should distinguish liveness from readiness, or return ready only after
the upgrade handler and VAD are available. Availability prefetch must not block the
greeting or readiness.

## Inbound Continuity

Parse and validate these Twilio fields:

- `sequenceNumber`
- `media.chunk`
- `media.timestamp`
- `start.mediaFormat`

Track gaps, duplicates, and out-of-order frames. Do not invent missing speech by
default. Trace the gap and let STT quality handling decide whether the transcript
needs clarification. If tests show that inserting mu-law silence improves VAD
continuity, add it inside the transport with a strict maximum gap.

DTMF can remain out of scope unless phone-number or confirmation collection adopts
it later.

## Observability

Use a monotonic clock for durations. Keep wall-clock timestamps only for joining
logs.

Add these per-call milestones:

```text
twilio:webhook-start
twilio:webhook-done
twilio:ws-upgrade
twilio:start
twilio:first-inbound-media
twilio:sequence-gap
vad:last-speech
vad:endpoint
stt:final
llm:start
llm:first-token
llm:first-speakable-text
tts:first-audio
twilio:first-outbound-enqueued
twilio:first-outbound-sent
twilio:backpressure-start
twilio:backpressure-end
twilio:mark-sent
twilio:mark-ack
twilio:clear-sent
twilio:playback-complete
```

Record durations and aggregate p50/p95/p99 for:

- Webhook response.
- WebSocket `start` to greeting first frame.
- Last Caller speech to Endpointing.
- Endpointing to STT final.
- STT final to LLM first token.
- LLM first token to first speakable text.
- Speakable text to TTS first audio.
- TTS first audio to first Twilio media frame.
- Last Caller speech to first Twilio media frame.
- Mark sent to mark acknowledgement.
- Barge-in speech start to clear sent.
- Maximum local queued audio and WebSocket `bufferedAmount`.

Do not sum overlapping phases. In particular, LLM completion, TTS generation, and
Twilio playback intentionally overlap.

## Failure Semantics

- Socket close rejects all playback barriers and cancels their response
  generations.
- A malformed Twilio frame is ignored and counted; repeated malformed frames close
  the stream.
- Unsupported media format closes before audio is processed.
- Mark timeout clears then closes if playback state cannot be reconciled.
- Outbound queue overflow clears the active response and records a failure.
- Backpressure pauses production before memory grows without a bound.
- `clear` is idempotent for the active response generation.
- Late marks, TTS chunks, and LLM tokens from a cleared generation are ignored.

## Implementation Sequence

### 1. Deepen the transport

Implement `enqueueMulaw`, the 20 ms pump, bounded buffering, backpressure, ordered
mark barriers, and `clearPlayback` in `src/stream.ts` or a replacement module.

Completion criterion: deterministic fake-clock tests prove byte preservation,
pacing, backpressure, one response-tail mark, clear settlement, timeout settlement,
and bounded memory.

### 2. Lift marks to response scope

Remove playback waiting from `LiveCallSession.emitAudio`. Queue every sentence or
clause for a logical response, then call `finishPlayback()` once after the response
tail has been enqueued.

Completion criterion: a two-sentence response has one mark and no transport-created
gap between sentences when the second sentence audio is ready.

### 3. Add interruption detection

Give `Endpointer` explicit muted and interruptible-suspended modes. Preserve the
candidate audio that triggers interruption.

Completion criterion: real-shape 20 ms frame tests distinguish sustained speech
from short noise and retain the complete interrupted utterance.

### 4. Cancel response generations

Add generation IDs and cancellation to `LiveCallSession`, OpenRouter fetches, and
TTS adapters. Wire interruption to Twilio `clear`.

Completion criterion: a barge-in test proves old audio/tokens never play, unheard
assistant text does not enter history, and the Caller interruption becomes exactly
one new Turn.

### 5. Add fixed-audio caching

Add a shared cache at the TTS seam and prewarm fixed phrases.

Completion criterion: the second call performs no provider request for fixed
phrases, dynamic text is never cached, and cached bytes still pass through pacing
and marks.

### 6. Complete startup and metrics

Attach the WebSocket endpoint before listening, validate Twilio media metadata, and
emit the transport milestones.

Completion criterion: readiness implies an immediately usable `/stream`, and a
deterministic call trace contains every applicable milestone with monotonic
durations.

## Test Matrix

- One short cached greeting.
- Streaming TTS chunks smaller and larger than 160 bytes.
- Request/response TTS returning several seconds of audio at once.
- Two-sentence LLM reply with TTS overlap.
- Socket backpressure entering and leaving the water marks.
- Queue overflow.
- Normal mark acknowledgement.
- Missing, duplicate, late, and unknown marks.
- Clear before a mark is sent.
- Clear after a mark is sent but before acknowledgement.
- Caller barge-in during the first and final sentence.
- Noise and brief backchannels during playback.
- Socket close during LLM, TTS, paced send, and mark wait.
- Interrupted booking readback followed by `yes`.
- Twilio sequence gap and invalid media format.
- Four concurrent calls, proving queues and marks remain call-local.

## Acceptance Gate

Do not tune pacing, backpressure, or barge-in from synthetic tests alone. Before
enabling barge-in by default:

1. Capture consented, deidentified Twilio mu-law call fixtures.
2. Replay at real 20 ms timing through the full local WebSocket path.
3. Measure false interruption, missed interruption, clipped first-word, queue size,
   and mark latency.
4. Run at least 100 scripted Turns across one and four concurrent calls.
5. Enable by default only when no Booking can occur after an interrupted readback
   and the latency goals above hold at p95.

## Primary Twilio Reference

Twilio Media Streams WebSocket messages define media buffering, `mark`, and
`clear`: <https://www.twilio.com/docs/voice/media-streams/websocket-messages>
