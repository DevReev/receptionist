# Live speakerphone acceptance scenario (ticket 10)

The real-audio counterpart to the bench gates. One call, placed by the user,
speakerphone on, following the steps below in order. The trace capture and the
debug-audio WAVs are retained; `npm run analyze-call` then reports the numbers
against the recorded baseline (`bench-scripts/01-turn-taking-baseline.md`).

## Pre-flight

Rebuild and restart the local server per RUNBOOK §3 ("Restart, local, history
preserved"), running `npm run build` first so `dist/` matches the tree under
test; confirm `curl -s http://localhost:3000/healthz` returns `ok`.

- The server must be the build under test; the log line at restart is the
  capture boundary.
- `.env` sets `DEBUG_AUDIO_DIR=debug-audio` (local PII, gitignored) so each
  Caller utterance WAV is retained alongside the trace.
- `STREAM_WS_URL` must point at the live tunnel host (unchanged from normal
  deployment). `.env` keeps `TURN_DETECTION=sarvam` unless a hybrid call is
  wanted; record which mode the call ran.
- Call the Twilio number from a phone with **speakerphone on**. Hold the phone
  at a normal speakerphone distance — the Echo return is the thing under test.
- Note the CallSid when the call ends (or after):

```sh
node scripts/analyze-call.ts --list /tmp/receptionist.log | tail -1
```

## The call

Do the steps in order. Wait for the Receptionist to start each reply before the
step that interrupts it.

1. **Greeting Barge-in.** While the greeting is still playing, say
   "Hi, can you hear me?" — it should stop mid-greeting and answer.
2. **Steady turn (reply latency).** After it finishes greeting you, ask
   "What are your hours?" — it should answer as soon as you stop, with no
   fixed one-second wait.
3. **Barge-in mid-reply (stop latency).** As soon as it starts answering,
   cut in with "Wait — actually, I wanted to ask about tomorrow." — it should
   stop within the current pacing window and answer the correction.
4. **Backchannel.** Ask "Can I book an appointment?". While it replies, say
   "mm-hmm" and then "okay" — short acknowledgements, not sentences. It should
   keep speaking and not stop.
5. **Echo (speakerphone).** Ask "What is the fee?" and then stay completely
   silent for the whole reply, phone on speaker. It must not stop itself and
   must not treat its own voice as you.
6. **Double-talk.** While it is speaking, say "no wait" over the speakerphone
   Echo — a real Barge-in must still stop it.
7. **Interrupted readback (safety gate).** Say "I'd like to book an
   appointment, please." Follow its questions (a date/time, your name, this
   number). When it reads the appointment back and asks "Shall I book it?",
   cut in with "Wait — actually, hold on." Then, after it responds, say a bare
   "yes." It must **not** book: it should treat the readback as interrupted and
   ask/read back again. End with "No, cancel that" and let it close.
8. **No-response (unchanged).** If the call is still open after step 7, stay
   silent. After ~8 s it should reprompt; stay silent again; it should say
   goodbye and close. (Skip this step if you already hung up.)

## After the call

```sh
SID=$(node scripts/analyze-call.ts --list /tmp/receptionist.log | tail -1)
grep "$SID" /tmp/receptionist.log > "bench-scripts/captures/${SID}.log"   # retained capture (gitignored)
npm run analyze-call -- --call "$SID" --audio-dir debug-audio --json bench-scripts/10-live-call.json
```

Paste the `live call ...` report into
`bench-scripts/10-live-speakerphone-acceptance.md` and compare against the
baseline and the synthetic gates. A failed gate becomes a follow-up ticket, not
a silent pass.
