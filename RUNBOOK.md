# Runbook — start the server, connect Twilio

## 1. Prerequisites

- Node.js >= 24
- A `.env` file in the repo root (see `.env`; never commit it)
- The Silero VAD model, fetched once:

```sh
sh scripts/fetch-vad-model.sh
```

## 2. Required env vars

The live streaming loop is the default (`VOICE_LOOP=stream`).

| Var | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio account |
| `TWILIO_AUTH_TOKEN` | Verifies inbound webhook signatures |
| `OPENROUTER_API_KEY` | Assistant LLM + TTS |
| `STREAM_WS_URL` | Public `wss://<public-host>/stream` — must be `wss://`, cannot be `ws://` |
| `SARVAM_API_KEY` | STT/TTS when `STT_PROVIDER=sarvam` / `TTS_PROVIDER=sarvam` |
| `GROQ_API_KEY` or `OPENAI_API_KEY` | Whisper STT when the Whisper providers are used |
| `APPOINTMENTS_API_URL` | Picktime Tool API (defaults to the Render deploy) |
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
ask for availability, confirm the session ends cleanly. Twilio Trial accounts
strip `<Connect><Stream>` verbs, so the number must be on a paid account for the
streaming loop.
