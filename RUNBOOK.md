# Runbook — start the server, connect Twilio

## 1. Prerequisites

- Node.js >= 24
- A `.env` file in the repo root (see `.env`; never commit it)
- The Silero VAD model, fetched once:

```sh
sh scripts/fetch-vad-model.sh
```

## 2. Required env vars

The live streaming loop is the default (`VOICE_LOOP=stream`), and transcription defaults to Sarvam (`STT_PROVIDER=sarvam`); set `STT_PROVIDER=openai` or `groq` to use Whisper instead, `STT_PROVIDER=openrouter` for the OpenRouter transcriptions endpoint (`OPENROUTER_STT_MODEL`, default `openai/gpt-transcribe`), or `STT_PROVIDER=openai-realtime` for OpenAI's streaming transcription (`gpt-live-transcribe`). OpenRouter transcription is a completed-utterance request with no realtime channel: the local detector owns turn boundaries, per-Turn partials (speculation, Backchannel semantics) are absent, and each Turn uploads its WAV before the reply can start. The OpenAI Realtime channel streams 8 kHz mu-law to a persistent socket, gated to the local detector's speech windows (the model rejects server turn detection), so `finalize` commits and reads the final ~550 ms later; it is billed on the audio appended, which the `stt close` trace reports as `bytes`/`audioMs`. With that channel, raise `STT_HEDGE_MS` (e.g. `1200`) so the REST fallback only fires on genuine stalls.

| Var | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Verifies inbound webhook signatures |
| `OPENROUTER_API_KEY` | Assistant LLM + TTS |
| `GROQ_ASSISTANT_MODEL` | Optional, default `openai/gpt-oss-120b`: the primary assistant LLM on Groq. `GROQ_ASSISTANT_BASE_URL` overrides the endpoint (default `https://api.groq.com/openai/v1`); `GROQ_ASSISTANT_REASONING_EFFORT` is `low`/`medium`/`high` (default `low`) |
| `ASSISTANT_PROVIDER` | Optional, `groq` or `openrouter`: primary assistant provider. Defaults to `groq` when `GROQ_API_KEY` is set, `openrouter` otherwise; a `groq` override without the key is a startup error |
| `OPENROUTER_MODEL` | Optional, default `deepseek/deepseek-v4.1-flash`: the OpenRouter assistant model, used as the fallback whenever `ASSISTANT_PROVIDER=groq`. `reasoning: effort` is sent as `OPENROUTER_REASONING_EFFORT` (default `minimal`); reasoning-mandatory endpoints refuse `none` |
| `STREAM_WS_URL` | Public `wss://<public-host>/stream` — must be `wss://`, cannot be `ws://` |
| `SARVAM_API_KEY` | STT by default; TTS when `TTS_PROVIDER=sarvam` |
| `SARVAM_STT_REALTIME` | Optional, default `true`: stream caller audio to Sarvam's realtime WebSocket (`saaras:v3-realtime`, `mulaw` @ 8 kHz) so each Turn does not wait on a REST transcription. A failed socket falls back to REST per Turn; set `false` to force REST |
| `SARVAM_STT_STREAM_TYPE` | Optional, default `fast` (`fast` \| `balanced` \| `simulated`): realtime partial-latency vs accuracy tradeoff |
| `TURN_DETECTION` | Optional, default `sarvam` (`sarvam` \| `hybrid`): who ends a Turn. `sarvam` = the provider's VAD (`vad.speech_start`/`vad.speech_end`, no local fixed wait); `hybrid` = the local detector with the socket in manual mode: a Caller-adaptive pause (1.25 × p90 of the Caller's last 8 intra-utterance pauses, 150–600 ms, 300 ms until three are seen, 1.5 s emergency cap) plus partial-transcript completeness, with a 600 ms floor while collecting the Patient's name or phone |
| `STALL_GRACE_MS` | Optional, default `1200`: local trailing silence after locally-heard speech that takes a provider-held boundary when the provider emits neither `vad.speech_end` nor a final. A final without its boundary closes the Turn by itself; a truly stalled Turn transcribes through the REST path, and two consecutive stalled Turns switch the session to the local detector (`hybrid` behaviour) at the next boundary |
| `STT_HEDGE_MS` | Optional, default `400`: how long a Turn waits for the realtime final before starting the REST decode alongside it. Whichever non-empty result lands first wins; the provider final is still preferred while the REST request is in flight, and REST is called at most once per Turn. `0` disables hedging and waits out `SARVAM_STT_FINAL_TIMEOUT_MS` |
| `STT_WARMUP` | Optional, default `true`: on call open, one throwaway transcription heats the REST STT route while the greeting plays, so the first Turn does not pay the provider cold start (traced `stt/warmup-start/done/error`). `false` disables |
| `SARVAM_TTS_MIN_BUFFER_SIZE` | Optional, default `30` (the provider's floor; values below 30 are clamped up): provider-side text buffering before speech synthesis starts. Keep it near the floor so the first phrase the voice chunker pushes starts synthesizing as soon as the provider allows; raise it only if the provider's phrasing suffers |
| `SARVAM_VAD_THRESHOLD` | Optional, default `0.3`: provider VAD sensitivity (0.0–1.0), `TURN_DETECTION=sarvam` only |
| `SARVAM_VAD_SILENCE_MS` | Optional, default `500`: provider-side silence that ends a Turn, `TURN_DETECTION=sarvam` only |
| `SARVAM_VAD_MIN_SPEECH_MS` | Optional, default `250`: minimum provider-heard speech to count as an utterance, `TURN_DETECTION=sarvam` only |
| `ECHO_GATE_CORRELATION` | Optional, default `0.7`: normalized cross-correlation against the played-audio reference needed to classify an inbound frame as the Receptionist's own Echo |
| `ECHO_GATE_LEVEL_MARGIN_DB` | Optional, default `6`: how far above the learned echo-return level an inbound frame may sit before it counts as the Caller talking over the Echo (double-talk) |
| `ECHO_GATE_MAX_DELAY_MS` | Optional, default `600`: longest Echo return delay the adaptive-delay correlation search considers |
| `BARGE_IN_MIN_SPEECH_MS` | Optional, default `200`: non-Echo Caller speech needed before the Receptionist stops mid-reply and the Caller takes the floor |
| `BARGE_IN_DIP_TOLERANCE_MS` | Optional, default `200`: brief sub-threshold dip inside a Barge-in candidate that does not reset it |
| `BARGE_IN_CONFIRM_MS` | Optional, default `300`: how long past `BARGE_IN_MIN_SPEECH_MS` the candidate waits for a partial transcript to confirm a Backchannel before unknown speech takes the floor. Only applies while partials arrive (provider VAD mode); a Backchannel is absorbed, content-bearing speech stops the Receptionist at once |
| `SARVAM_TTS_STREAM` | Optional, default `true`: stream replies over Sarvam's text-to-speech WebSocket (`bulbul:v3`, `mulaw` @ 8 kHz) so audio reaches the Caller while it is still being generated. A failed or stalled utterance falls back to the REST TTS call; set `false` to force REST |
| `SARVAM_TTS_STREAM_IDLE_TIMEOUT_MS` | Optional, default `5000`: silence on the TTS socket before the sentence falls back to REST |
| `GROQ_API_KEY` or `OPENAI_API_KEY` | Whisper STT when `STT_PROVIDER=openai` or `groq`; `OPENAI_API_KEY` is required for `STT_PROVIDER=openai-realtime` (and doubles as its REST fallback key) |
| `OPENAI_REALTIME_MODEL` | Optional, default `gpt-live-transcribe`: the streaming transcription model |
| `OPENAI_REALTIME_URL` | Optional, default `wss://api.openai.com/v1/realtime?intent=transcription`: the transcription session socket |
| `OPENAI_REALTIME_DELAY` | Optional, default `low` (`minimal`\|`low`\|`medium`\|`high`\|`xhigh`): the model's latency/accuracy tradeoff. `minimal` is marginally faster but drops punctuation |
| `OPENAI_REALTIME_LANGUAGES` | Optional, default `en`: comma-separated language hints |
| `APPOINTMENTS_API_URL` | Picktime Tool API (defaults to the Render deploy) |
| `APPOINTMENTS_WINDOW_WORKING_DAYS` | Working days of Availability read and prefetched at call start (default `5`, range 1–21) |
| `NO_RESPONSE_MS` | Optional, default `8000`: silence after the Receptionist stops speaking before it asks again, repeating the last question. Two unanswered asks, then a goodbye and close. `0` disables |
| `PORT` | Optional, default `3000` |

## 3. Build and start

```sh
npm install
npm run build
node --env-file=.env dist/server.js
```

- Listens on `PORT` (default 3000); boot log: `receptionist listening on :3000`.
- Health check: `curl http://localhost:3000/healthz` → `ok`.
- `npm start` runs `node dist/server.js` and does **not** read `.env`, so pass `--env-file` as above.
- Legacy rollback path: `VOICE_LOOP=legacy node --env-file=.env dist/server.js`.

### Restart (local, history preserved)

Local runs append stdout/stderr to `/tmp/receptionist.log`, so restarting never
truncates earlier calls:

```sh
kill $(pgrep -f "node --env-file=.env dist/server.js")
npm run build
nohup node --env-file=.env dist/server.js >> /tmp/receptionist.log 2>&1 &
sleep 2 && curl -s http://localhost:3000/healthz   # ok
```

Rebuild first when restarting to pick up code changes (`dist/` is what runs).
As long as `STREAM_WS_URL` and the tunnel host are unchanged, Twilio reconnects
on the next call with no console changes. A fresh `receptionist listening on
:3000` line marks each restart in the log.

## 4. Twilio configuration

The server needs a public HTTPS host (always-on host in production; a tunnel such as
`cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000` for local dev).

In the Twilio Console, on the phone number's **Voice Configuration**:

| Setting | Value |
| --- | --- |
| A call comes in (webhook) | `https://<public-host>/voice/incoming` — HTTP `POST` |
| Status callback (legacy only) | `https://<public-host>/voice/recording-status` — HTTP `POST` |

And in `.env`, point the media stream at the same host:

```
STREAM_WS_URL=wss://<public-host>/stream
```

`/voice/incoming` answers with `<Connect><Stream url="wss://<public-host>/stream"/>`,
so the `STREAM_WS_URL` host must be reachable by Twilio over TLS.

Other routes (set automatically, only relevant for debugging):

- `POST /voice/turn` — legacy record loop's per-turn action
- `GET /healthz` — liveness check

## 5. Verify

```sh
curl https://<public-host>/healthz
STREAM_WS_URL=wss://<public-host>/stream sh scripts/live-validation.sh
```

Then place one real call to the Twilio number: hear the greeting, ask for hours,
ask for availability, confirm the session ends cleanly. `<Connect><Stream>` works
on Twilio Trial accounts, so the streaming loop needs no paid upgrade.

## 6. Logs and tracing

The server prints one JSON object per line to stdout (the local runs capture it
in `/tmp/receptionist.log`). One call replays with:

```sh
grep <CallSid> /tmp/receptionist.log
```

Line kinds:

| `kind` / `phase` | What it tells you |
| --- | --- |
| `session` | call open/close, with close reason |
| `phase` | per-Turn timing: `transcribe`, `availability`, `assistant`, `llm`, `tts` |

An `availability` phase carries `start`/`done` (`ms`, `chars`, `slots`),
`injected` (`chars` in the prompt), and `hold` when a cold read outlived the
hold budget and `HOLD_ASSISTANT_LINE` bridged it. The full block only enters
the prompt on availability-intent Turns; all other Turns skip it.
| `turn` / `failure` | clinic-facing outcome and bounded-reprompt decisions |
| `vad` | 2 s score summary (`maxScore`, `latched`) |
| `utterance` | endpointed utterance duration and bytes |
| `trace` + `component` | component internals (see below) |
| `appointments` | every Picktime Tool API read/write with attempt, status, ms |

Component traces (`kind:"trace"`):

- `component:"llm"` — `round-start` carries request shape (`messages`, `tools`,
  `availabilityChars`); `done`/`empty-retry` carry `finish`, `reasoningChars`,
  `chunks`, `sseLines`, `skippedLines`, `provider`, `servedModel`, `status`,
  `requestId`, `usage`, and `detail` on failure. `tool-done` carries `ok` and
  `resultChars`. `http-retry` carries `status`, `attempt`, and `ms` whenever a
  round hit a transient provider status (429/502/503): the request retries with
  a short backoff before the round is allowed to fail the call.
- `component:"stt"` — socket `open`/`close`/`error`, `speech-start`
  (`bufferedBytes`), `final` (`ms`, `chars`, `partials`, `noSpeech`),
  `final-timeout`, `stale-final`, `vad-speech-start`/`vad-speech-end`,
  `endpointing-update`, and REST `rest-start/rest-done/rest-error`. Hedging:
  `hedge-start` (REST began alongside a late final), `hedge-win` (the REST
  result answered the Turn) and `hedge-lost` (the provider final still won).
  `second-opinion-start` marks a critical-field second decode started before
  the primary final landed; `second-opinion-disagree` reprompts without
  committing the field. `warmup-start/done/error` is the on-open route warm-up.
  The OpenAI Realtime channel traces `open` (model, delay, keywords),
  `speech-start` (`bufferedBytes`), `commit` (`bytes`), `committed`, `final`
  (`ms`, `chars`, `partials`, `noSpeech`), `final-timeout`, and `close`
  (`bytes`, `audioMs` — the billed audio, at $0.017/min for `gpt-live-transcribe`).
- `component:"tts"` — socket `stream-open`/`stream-close`/`stream-error`,
  `utterance-start`, `first-audio` (latency), `utterance-done` (`chunks`,
  `bytes`), `provider-error`, `idle-timeout`, `closed`, and REST
  `rest-start/rest-done/rest-error`.
- `component:"vad"` — `endpoint` per utterance: `source` (`provider` when the
  provider VAD owned the boundary, `local` in hybrid mode), `speechMs`, the
  locally-heard `trailingSilenceMs` the detector waited out (the Caller's last
  speech sample is the endpoint minus this, which is what `analyze-call`
  measures reply latency from), and the local-detector `frames`, `maxScore`,
  `meanScore` (all zero when the provider owned the boundary).
- `component:"echo-gate"` — `decision` per inbound frame heard while the
  Receptionist speaks: `echo` (true = own voice returning), `reason`
  (`echo` | `silence` | `no-reference` | `uncorrelated` | `double-talk`), and the
  evidence used (`correlation`, `delayMs`, `inboundRms`, `referenceRms`,
  `residualRms`, `returnLossDb`, `threshold`, `marginDb`). High-volume by
  design: one line per 20 ms frame, `grep <callSid>` scoped.
- `component:"call"` — `phase` transitions, `playback-cleared`, `barge-in`
  (`generation`, `candidateMs`, `corroborated`), `first-outbound`
  (`generation`; the first frame of a reply that reached the transport — the
  caller-observable audio start), and `backchannel` (`durationMs`,
  `text`). Keypad entry: `dtmf-digit` (`buffered` count), `dtmf-submit`,
  `dtmf-rejected`, `dtmf-cleared`; digits themselves are never logged.
  `barge-in`'s `corroborated` is true when a provider
  `vad.speech_start` arrived while the local candidate was building; the
  provider never triggers Barge-in, the local Silero candidate plus Echo-gate
  clearance does. `backchannel` is one line per absorbed acknowledgement: the
  Receptionist kept speaking, no Turn opened, no history was written. A
  `failure`/`goodbye` close also REST-hangs the call up (`component:"twilio"`,
  `rest-hangup` with `ok`), so the Caller never sits on a dead line after the
  session is gone.
- `component:"stream"` — `open` and `close` with `framesIn`/`bytesIn`/
  `framesOut`/`bytesOut`/`durationMs` for the Twilio media socket.

Diagnosing an empty assistant reply: read the Turn's `llm` `done` and
`empty-retry` lines. `finish:"length"` with high `reasoningChars` means the
provider spent the token budget reasoning; `finish:"stop"` with no content and
`chunks:0` means the provider returned an empty completion; HTTP/stream
failures carry `detail`, and the retried round carries a raw `lastChunk` sample
plus the OpenRouter `requestId` when support needs it.

