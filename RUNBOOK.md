# Runbook — start the server, connect Twilio

## 1. Prerequisites

- Node.js >= 24
- A `.env` file in the repo root (see `.env`; never commit it)
- The Silero VAD model, fetched once:

```sh
sh scripts/fetch-vad-model.sh
```

## 2. Required env vars

The live streaming loop is the default (`VOICE_LOOP=stream`), and transcription defaults to Sarvam (`STT_PROVIDER=sarvam`); set `STT_PROVIDER=openai` or `groq` to use Whisper instead.

| Var | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Verifies inbound webhook signatures |
| `OPENROUTER_API_KEY` | Assistant LLM + TTS |
| `STREAM_WS_URL` | Public `wss://<public-host>/stream` — must be `wss://`, cannot be `ws://` |
| `SARVAM_API_KEY` | STT by default; TTS when `TTS_PROVIDER=sarvam` |
| `SARVAM_STT_REALTIME` | Optional, default `true`: stream caller audio to Sarvam's realtime WebSocket (`saaras:v3-realtime`, `mulaw` @ 8 kHz) so each Turn does not wait on a REST transcription. A failed socket falls back to REST per Turn; set `false` to force REST |
| `SARVAM_STT_STREAM_TYPE` | Optional, default `fast` (`fast` \| `balanced` \| `simulated`): realtime partial-latency vs accuracy tradeoff |
| `TURN_DETECTION` | Optional, default `sarvam` (`sarvam` \| `hybrid`): who ends a Turn. `sarvam` = the provider's VAD (`vad.speech_start`/`vad.speech_end`, no local fixed wait); `hybrid` = the local detector with the socket in manual mode |
| `SARVAM_VAD_THRESHOLD` | Optional, default `0.3`: provider VAD sensitivity (0.0–1.0), `TURN_DETECTION=sarvam` only |
| `SARVAM_VAD_SILENCE_MS` | Optional, default `500`: provider-side silence that ends a Turn, `TURN_DETECTION=sarvam` only |
| `SARVAM_VAD_MIN_SPEECH_MS` | Optional, default `250`: minimum provider-heard speech to count as an utterance, `TURN_DETECTION=sarvam` only |
| `SARVAM_TTS_STREAM` | Optional, default `true`: stream replies over Sarvam's text-to-speech WebSocket (`bulbul:v3`, `mulaw` @ 8 kHz) so audio reaches the Caller while it is still being generated. A failed or stalled utterance falls back to the REST TTS call; set `false` to force REST |
| `SARVAM_TTS_STREAM_IDLE_TIMEOUT_MS` | Optional, default `5000`: silence on the TTS socket before the sentence falls back to REST |
| `GROQ_API_KEY` or `OPENAI_API_KEY` | Whisper STT only when `STT_PROVIDER=openai` or `groq` |
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
  `resultChars`.
- `component:"stt"` — socket `open`/`close`/`error`, `speech-start`
  (`bufferedBytes`), `final` (`ms`, `chars`, `partials`, `noSpeech`),
  `final-timeout`, `stale-final`, `vad-speech-start`/`vad-speech-end`,
  `endpointing-update`, and REST `rest-start/rest-done/rest-error`.
- `component:"tts"` — socket `stream-open`/`stream-close`/`stream-error`,
  `utterance-start`, `first-audio` (latency), `utterance-done` (`chunks`,
  `bytes`), `provider-error`, `idle-timeout`, `closed`, and REST
  `rest-start/rest-done/rest-error`.
- `component:"vad"` — `endpoint` per utterance: `source` (`provider` when the
  provider VAD owned the boundary, `local` in hybrid mode), `speechMs`, and the
  local-detector `frames`, `maxScore`, `meanScore` (all zero when the provider
  owned the boundary).
- `component:"stream"` — `open` and `close` with `framesIn`/`bytesIn`/
  `framesOut`/`bytesOut`/`durationMs` for the Twilio media socket.

Diagnosing an empty assistant reply: read the Turn's `llm` `done` and
`empty-retry` lines. `finish:"length"` with high `reasoningChars` means the
provider spent the token budget reasoning; `finish:"stop"` with no content and
`chunks:0` means the provider returned an empty completion; HTTP/stream
failures carry `detail`, and the retried round carries a raw `lastChunk` sample
plus the OpenRouter `requestId` when support needs it.

