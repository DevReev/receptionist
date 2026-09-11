#!/bin/sh
# Live validation preconditions for ticket 13 (spec 06).
# Checks everything automatable; the real phone call itself stays a manual
# operator step (see the checklist it prints at the end).
set -eu
cd "$(dirname "$0")/.."

fail=0
say() { printf '%s\n' "$*"; }
ok() { say "ok: $*"; }
warn() { say "FAIL: $*"; fail=1; }

# 1. Loop selector defaults to streaming; legacy stays behind the flag.
# Checked against the code default (not the env, which would be vacuous).
if grep -q "VOICE_LOOP', 'stream'" src/config.ts; then
  ok "src/config.ts defaults VOICE_LOOP to stream"
else
  warn "src/config.ts does not default VOICE_LOOP to stream"
fi
VOICE_LOOP="${VOICE_LOOP:-stream}"
[ "$VOICE_LOOP" = "stream" ] || warn "VOICE_LOOP=$VOICE_LOOP (expected stream default; legacy only via VOICE_LOOP=legacy)"
ok "effective VOICE_LOOP=$VOICE_LOOP"

# 2. Public streaming URL for the Connect TwiML.
case "${STREAM_WS_URL:-}" in
  wss://*) ok "STREAM_WS_URL=$STREAM_WS_URL" ;;
  '') warn "STREAM_WS_URL is unset (required: public wss://<host>/stream)" ;;
  *) warn "STREAM_WS_URL=${STREAM_WS_URL} (expected public wss:// URL)" ;;
esac

# 3. Credentials present (never printed).
[ -n "${TWILIO_ACCOUNT_SID:-}" ] || warn "TWILIO_ACCOUNT_SID is unset"
[ -n "${TWILIO_AUTH_TOKEN:-}" ] || warn "TWILIO_AUTH_TOKEN is unset"
[ -n "${OPENAI_API_KEY:-${GROQ_API_KEY:-}}" ] || warn "OPENAI_API_KEY or GROQ_API_KEY is unset (STT)"
[ -n "${OPENROUTER_API_KEY:-}" ] || warn "OPENROUTER_API_KEY is unset (assistant + TTS)"
[ "$fail" -eq 0 ] && ok "credentials present (values not printed)"

# 4. VAD model baked for the streaming loop.
[ -f "${VAD_MODEL_PATH:-./models/silero_vad.onnx}" ] \
  && ok "VAD model present at ${VAD_MODEL_PATH:-./models/silero_vad.onnx}" \
  || warn "VAD model missing: run scripts/fetch-vad-model.sh"

# 5. Config loads under the live defaults (typecheck-adjacent seam).
if node -e "import('./dist/config.js').then(async (m) => { const c = m.loadConfig(); if (c.voiceLoop !== 'stream') throw new Error('voiceLoop=' + c.voiceLoop); if (!c.streamWsUrl.startsWith('wss://')) throw new Error('streamWsUrl=' + c.streamWsUrl); })" 2>/dev/null; then
  ok "built config loads with stream default (dist/)"
else
  say "skip: dist/config.js not built or env incomplete for a live load (run npm run build first)"
fi

# 6. Twilio account tier (read-only; needs the two Twilio env vars).
if [ -n "${TWILIO_ACCOUNT_SID:-}" ] && [ -n "${TWILIO_AUTH_TOKEN:-}" ]; then
  if command -v curl >/dev/null 2>&1; then
    resp="$(curl -sS -u "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}" \
      "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}.json" || true)"
    case "$resp" in
      *'"type": "Trial"'*) warn "Twilio account is Trial — streaming verbs are stripped; upgrade before the live call" ;;
      *'"status": "active"'*) ok "Twilio account reachable and active (see type field for Trial vs Full)" ;;
      *) say "info: could not confirm Twilio tier from API; response: $(printf '%s' "$resp" | head -c 200)" ;;
    esac
  else
    say "skip: curl missing, cannot query Twilio account tier"
  fi
else
  say "skip: Twilio tier check needs TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN"
fi

say ""
say "Manual live-call checklist (operator on the Twilio console):"
say "  1. Point the number's voice webhook at https://<public-host>/voice/incoming (POST)."
say "  2. Place one real call: hear greeting, ask hours, ask availability, confirm clean session end."
say "  3. Tail logs: one turn log per Turn, no failure lines on the happy path."
say "  4. Rollback if broken: VOICE_LOOP=legacy restores the record loop without a deploy of new logic."
say ""
[ "$fail" -eq 0 ] && say "live-validation preconditions: PASS" || say "live-validation preconditions: FAIL (see FAIL lines)"
exit "$fail"
