# Live partial-channel validation scenario (ticket 11)

One call, placed by the user, speakerphone on. It proves the partial channel on
the default provider (`STT_PROVIDER=openai-realtime`): a mid-list pause is not
cut, an acknowledgement is absorbed, and a clearly non-booking Turn starts its
reply before the final lands. Extends the ticket-10 scenario; the safety gates
are the same.

## Pre-flight

- Server is the build under test (`npm run build` + restart per RUNBOOK §3);
  `curl -s http://localhost:3000/healthz` → `ok`.
- `.env` has `DEBUG_AUDIO_DIR=debug-audio` so each Caller utterance WAV is kept.
- `STREAM_WS_URL` points at the live tunnel host, and the Twilio number's Voice
  webhook (`POST`) points at `https://<same-host>/voice/incoming`.
- Call the Twilio number from a phone with **speakerphone on**, normal distance.
- Note the CallSid when the call ends:
  `node scripts/analyze-call.ts --list /tmp/receptionist.log | tail -1`

## The call (in order)

Wait for the Receptionist to start each reply before the step that interrupts it.

1. **Speculative non-booking turn (reply latency).** After the greeting, ask
   "What are your hours?" — a clearly non-booking question. Note whether the
   answer starts promptly (generation starts from the partial, before the
   final lands).
2. **Mid-list pause (no false cut).** Say, with a full ~1 s pause where marked:
   "I also wanted to ask about the fee — [pause] — and whether you have
   parking." It must NOT answer at the pause; one Turn, one reply covering
   both.
3. **Backchannel absorption.** Ask "Can I book an appointment?". While it
   replies, say "yeah" … then "okay" … then "perfect" — short acknowledgements
   only. It should keep speaking and not stop.
4. **Barge-in / double-talk (stop latency).** While it is speaking, cut in with
   "no wait — actually, hold on." It should stop within the pacing window and
   yield.
5. **Echo silence.** Ask "What is the fee?" then stay completely silent for the
   whole reply, phone on speaker. It must not stop itself or treat its own
   voice as you.
6. **Phone dictation in groups.** Say "I'd like to book an appointment,
   please." Follow its questions; when it asks for the number, dictate in
   groups with pauses: "98765 — [pause] — 43210". It must not split the number
   across Turns.
7. **Interrupted readback (safety gate).** When it reads the appointment back
   and asks "Shall I book it?", cut in with "Wait — actually, hold on." After
   it responds, say a bare "yes." It must **not** book: the readback was
   interrupted, so it should ask/read back again. End with "No, cancel that"
   and let it close (or hang up after the goodbye).

## After the call

```sh
SID=$(node scripts/analyze-call.ts --list /tmp/receptionist.log | tail -1)
grep "$SID" /tmp/receptionist.log > "bench-scripts/captures/${SID}.log"
npm run analyze-call -- --call "$SID" --audio-dir debug-audio --json bench-scripts/11-live-call.json
```

## Gates (vs `bench-scripts/01-turn-taking-baseline.md` + current synthetic)

| Gate | Synthetic on this tree | Live bar |
| --- | --- | --- |
| False cuts | 0/12 | 0 on steps 2 and 6 |
| Stop latency | p50/p95 180 ms, missed 0 | every content Barge-in stops (steps 4, 7) |
| Reply latency | p50 280 ms, p95 1300 ms | step 1 starts promptly; no Turn > ~4 s |
| Backchannel false-stop | 0/1, absorbed 1 | 0 on step 3 |
| Echo false-stop / self-Echo Turns | 0 / 0 | 0 on step 5 |
| Interrupted-readback Bookings | 0 | 0 on step 7 |
| Trace evidence | — | partial-driven boundary, `backchannel` absorbed line, `speculation-kept` line |

A failed gate becomes a follow-up ticket, not a silent pass. Report lands in
`bench-scripts/11-live-partial-channel-report.md`.
