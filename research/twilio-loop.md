# Twilio turn-based voice loop — findings

Decision: carry each turn with **`<Gather>`** (`input="speech"`, optionally `"dtmf speech"`), **not `<Record>`**.
`<Record>` is stripped from custom TwiML on trial accounts, so the trial-number live path cannot use a
`<Record>` → whisper → LLM → `<Say>` loop. The whisper-large leg of the map requires an upgraded account;
until then the trial loop uses Twilio's built-in speech recognition inside `<Gather>`.

## 1. Verb choice: `<Gather>` wins on trial, `<Record>` is blocked

- **`<Record>` is a blocked verb during trial.** Trial sanitization strips it and substitutes a
  `<Say>` "The Record verb is not available on trial accounts." message. Every other audio-capture
  primitive is blocked too: `<Stream>`, `<ConversationRelay>`, `<VirtualAgent>`, `<Siprec>`,
  `<Start>/<Stop>` `<Recording>`, and `<Dial>` `record` / `recordingStatusCallback*` attributes.
  Source: [Try out Twilio Voice — Custom TwiML during trial](https://www.twilio.com/docs/usage/trials/try-out-voice#custom-twiml-during-trial)
  (Blocked verbs table; `<Dial>` stripped-attributes row).
- **`<Gather>` is fully supported on trial** with all standard attributes (`input`, `timeout`,
  `numDigits`, `finishOnKey`, `speechTimeout`, `speechModel`, `language`, `hints`, `profanityFilter`,
  `actionOnEmptyResult`, `enhanced`), `action` URL (hop-counted), `method`, and nested `<Say>`/`<Play>`
  (recursively sanitized under the same rules).
  Source: [Try out Twilio Voice — `<Gather>` row](https://www.twilio.com/docs/usage/trials/try-out-voice#custom-twiml-during-trial).
- **`<Say>` is fully supported on trial** with all standard attributes (`voice`, `language`, `loop`).
  Fixed voice/language per the map lock is just a constant choice of these attributes.
  Source: [Try out Twilio Voice — `<Say>` row](https://www.twilio.com/docs/usage/trials/try-out-voice#custom-twiml-during-trial);
  attribute reference: [TwiML `<Say>`](https://www.twilio.com/docs/voice/twiml/say).
- **`<Pause>`, `<Hangup>`, `<Redirect>`, `<Reject>`, `<Leave>` pass through unchanged** on trial.
  Source: [Try out Twilio Voice — Verbs (no restrictions)](https://www.twilio.com/docs/usage/trials/try-out-voice#custom-twiml-during-trial);
  reference: [TwiML `<Hangup>`](https://www.twilio.com/docs/voice/twiml/hangup),
  [TwiML `<Redirect>`](https://www.twilio.com/docs/voice/twiml/redirect),
  [TwiML `<Pause>`](https://www.twilio.com/docs/voice/twiml/pause).

Consequence for the map: the Notes line "turn-based (`<Record>` → whisper-large → LLM → `<Say>`)" is
**not executable on a trial number**. Two paths:

- **Trial path (now):** `<Gather input="speech">` → Twilio `SpeechResult` → LLM → `<Say>`. No
  whisper-large; no caller audio is ever exposed (see §5).
- **Whisper path (after upgrade):** `<Record>` unlocks and the map's loop works as written —
  `<Record action="…">` posts `RecordingUrl`/`RecordingDuration`/`Digits`; the server downloads the
  audio (`RecordingUrl` + `.mp3` for MP3, WAV by default), runs whisper-large, runs the LLM, and
  answers with `<Say>`. Note the documented race: **the recording file may not be readable when the
  `action` callback arrives** — use `recordingStatusCallback` (default event `completed`) as the
  reliable "audio ready" signal.
  Source: [TwiML `<Record>` — action](https://www.twilio.com/docs/voice/twiml/record#attributes-action)
  (`action` request-parameter table + "may not yet be accessible" note),
  [`recordingStatusCallback`](https://www.twilio.com/docs/voice/twiml/record#attributes-recording-status-callback).

## 2. Webhook flow (trial `<Gather>` loop)

One inbound call = a chain of TwiML documents linked by `action` URLs. Per-turn skeleton:

```xml
<!-- GET/POST /voice/incoming : greet, then listen -->
<Response>
  <Say voice="{fixed}" language="{fixed}">Welcome to {clinic}. How can I help?</Say>
  <Gather input="speech" language="en-US" timeout="5"
          speechTimeout="auto" action="/voice/turn" method="POST"
          actionOnEmptyResult="true">
    <Say voice="{fixed}" language="{fixed}">Are you calling about hours or an appointment?</Say>
  </Gather>
  <!-- fallthrough: only reached when no input AND actionOnEmptyResult=false -->
  <Say voice="{fixed}" language="{fixed}">I didn't catch that. Goodbye.</Say>
  <Hangup/>
</Response>
```

```xml
<!-- POST /voice/turn : server runs LLM (+ Picktime), answers with next turn -->
<Response>
  <Say voice="{fixed}" language="{fixed}">{assistant reply}</Say>
  <Gather input="speech" language="en-US" timeout="5"
          speechTimeout="auto" action="/voice/turn" method="POST"
          actionOnEmptyResult="true">
    <Say voice="{fixed}" language="{fixed}">Anything else I can help with?</Say>
  </Gather>
  <Say voice="{fixed}" language="{fixed}">Thanks for calling {clinic}. Goodbye.</Say>
  <Hangup/>
</Response>
```

Mechanics, all primary-sourced:

- **Inbound entry:** the number's Voice webhook (`POST` recommended, HTTPS) receives the standard
  parameters (`CallSid`, `AccountSid`, `From`, `To`, `CallStatus`, `Direction`, …) and the server
  answers with TwiML. Source: [Voice Webhooks — Incoming Voice Call](https://www.twilio.com/docs/usage/webhooks/voice-webhooks);
  [TwiML — Twilio's request to your application](https://www.twilio.com/docs/voice/twiml#twilios-request-to-your-application).
- **`<Gather>` capture:** Twilio pauses, plays the nested `<Say>`, and listens. On completion it
  requests `action` with the standard parameters **plus `SpeechResult` + `Confidence`
  (0.0–1.0, presence/accuracy not guaranteed)** for speech input, or `Digits` for DTMF.
  Source: [TwiML `<Gather>` — action](https://www.twilio.com/docs/voice/twiml/gather#action).
- **Default `action` is the current document URL — set it explicitly** or the caller loops on the
  same document. Source: [TwiML `<Gather>` — action](https://www.twilio.com/docs/voice/twiml/gather#action)
  ("If you omit this attribute… unwanted looping behavior").
- **Timeouts on `<Gather>`:** `timeout` (default `5` s) is the overall wait; `speechTimeout`
  (default = `timeout` value, or `auto`) is the end-of-speech pause. Tune `timeout` up for
  slow/older callers; `speechTimeout="auto"` lets Twilio pick the endpoint.
  Source: [TwiML `<Gather>` attributes](https://www.twilio.com/docs/voice/twiml/gather#gather-attributes).
- **Verbs after `<Gather>`/`<Record>` run only on the no-input path** (unless
  `actionOnEmptyResult="true"`, which routes empty results to `action` too). Any verbs after
  `<Record>` are unreachable once recording starts; control continues from the `action` response.
  Source: [TwiML `<Gather>` — action](https://www.twilio.com/docs/voice/twiml/gather#action);
  [TwiML `<Record>` — action](https://www.twilio.com/docs/voice/twiml/record#attributes-action).
- **Branching/termination:** `<Redirect>` transfers control to another URL's TwiML (verbs after it
  are ignored); `<Hangup>` ends the call and is the correct terminal after a closing `<Say>`
  (as the first verb it still answers/bills — only `<Reject>` declines unbilled).
  Source: [TwiML `<Redirect>`](https://www.twilio.com/docs/voice/twiml/redirect),
  [TwiML `<Hangup>`](https://www.twilio.com/docs/voice/twiml/hangup).

## 3. Timeouts, failures, retries (webhook side)

- **TwiML fetch timeout is 5 s on trial; TwiML max size is 64 KB.** The `/voice/turn` handler must
  answer fast — every hop's LLM + Picktime work counts against this budget. If a turn risks
  exceeding it, the behavior ticket should script a holding pattern (answer the current hop with
  `<Say>` + `<Redirect>` to a "still working" step rather than blocking the webhook).
  Source: [Try out Twilio Voice — Global limits](https://www.twilio.com/docs/usage/trials/try-out-voice#custom-twiml-during-trial).
- **Failure signal is error 11200 (HTTP retrieval failure):** non-2xx, connection failure,
  bad `Content-Type`, private-URL host, or server too slow. Twilio logs it to the Debugger; it
  does **not** automatically retry the webhook — set a **fallback URL** on the number/TwiML app
  (ideally separate infrastructure) so a primary failure still yields TwiML.
  Source: [Error 11200](https://www.twilio.com/docs/api/errors/11200).
- **Loop guard: max 10 action/redirect hops**, then Twilio terminates the call with a `<Say>` +
  `<Hangup>`. Reprompt loops (silence / unintelligible, §4) therefore need a **bounded counter**
  (server-side, keyed by `CallSid`) well under 10 total hops per call — suggest cap reprompts at
  2 and hand off on the third miss.
  Source: [Try out Twilio Voice — Global limits + `<Redirect>` hop counter](https://www.twilio.com/docs/usage/trials/try-out-voice#custom-twiml-during-trial).
- **Call-level observability:** `StatusCallback` (`Call` resource param or `<Number>`
  `statusCallback`) fires after the call ends (events `initiated`/`ringing`/`answered`/`completed`
  selectable); recording callbacks report `in-progress`/`completed`/`absent`/`failed`.
  Source: [Voice Webhooks — Call Status / Recording Status Callbacks](https://www.twilio.com/docs/usage/webhooks/voice-webhooks).

## 4. Per-turn state machine (for the behavior ticket to script)

States per turn: `LISTEN → (CLASSIFY) → ANSWER → LISTEN … → CLOSE`. Error edges:

| # | Condition | Detection | Response (behavior ticket owns exact wording) |
|---|-----------|-----------|-----------------------------------------------|
| 1 | **Silence / no input** | No `SpeechResult`/`Digits` on the `action` hit (with `actionOnEmptyResult="true"`), or fallthrough past `<Gather>` | `<Say>` reprompt ("I didn't hear you…") + fresh `<Gather>`; count a miss |
| 2 | **Unintelligible / low confidence** | Empty `SpeechResult`, or `Confidence` below threshold (field not guaranteed — treat missing as low) | `<Say>` clarification prompt + fresh `<Gather>`; count a miss |
| 3 | **Downstream failure** (LLM error, Picktime unreachable, booking write fails) | Server exception / timeout / bad payload | **Console log** (no SMS per map lock) with `CallSid` + turn transcript + error; caller hears `<Say>` clinic-will-confirm line, then `<Hangup/>` (do not re-`<Gather>` — avoids double-booking on retry) |
| 4 | **Repeated misses** (miss counter hits cap, suggest 2 reprompts) | Server-side counter per `CallSid` (mind the 10-hop ceiling) | Console log + `<Say>` handoff line ("The clinic will call you back to confirm.") + `<Hangup/>` |
| 5 | **Caller hangup mid-turn** | `CallStatus` / status-callback `completed` | Nothing to say; log the partial turn to console for the clinic |
| 6 | **Webhook failure** (our 5xx / timeout) | Debugger 11200 | Fallback-URL TwiML: `<Say>` clinic-will-confirm line + `<Hangup/>`; console log |

Rules feeding the behavior contract:

- Booking turns are **single-attempt**: one Picktime write per confirmed intent; any ambiguity →
  edge 3/4 (confirm-later line), never a silent retry of the write.
- Every failure writes the **console log first**, then speaks to the caller — the log is the
  clinic's only handoff channel (SMS handoff is out of scope per map).
- Keep per-turn server work inside the 5 s fetch budget; move slow work (whisper post-upgrade,
  Picktime page automation) behind a `<Say>` + `<Redirect>` holding step if needed.

## 5. Trial-number limits constraining the live path

| Limit | Value | Effect on the live path |
|-------|-------|-------------------------|
| Recipients | Only **verified numbers, max 5**/account (signup number auto-verified; one number max 3 accounts) | Test callers must be verified first; no public-patient traffic |
| Geography | Calls **only within signup country** | Cross-border test calls fail |
| Voice quota | **75 minutes total**, then calls auto-terminate | Budget turns; watch Free units tracker |
| Per-call cap | **10 minutes**, real-time enforced | Long bookings must close fast; reprompt cap helps |
| Concurrency | **Max 5 concurrent calls** | One test call at a time in practice |
| TwiML fetch | **5 s timeout**, 64 KB max | Fast `/voice/turn` handler (§3) |
| Hop ceiling | **Max 10 action/redirect hops** | Bounded reprompts (§4) |
| Trial numbers | Twilio-provided, **vary by product/recipient**; replaced by purchased number after upgrade | Confirm the exact Voice trial number per verified caller |
| Expiry | **30 days**, then trial resources die | Upgrade before expiry to keep building |
| Content | Custom TwiML allowed **with the verb restrictions above** | `<Record>`-based whisper loop impossible until upgrade |

Sources: [Twilio trial account](https://www.twilio.com/docs/usage/trials)
(free units, 30-day expiry, verified recipients, geographic restrictions);
[Try out Twilio Voice](https://www.twilio.com/docs/usage/trials/try-out-voice)
(verified-numbers-only, same-country, Global limits table);
[Get started with your trial account](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account)
(verified recipients, geographic restrictions).

## 6. Builder-ready decision

1. **Implement the trial loop on `<Gather input="speech">`** with `action="/voice/turn"`,
   `actionOnEmptyResult="true"`, `speechTimeout="auto"`; fixed `<Say>` voice/language; terminal
   turns end `<Say>` + `<Hangup/>`. This is the only turn-based loop a trial number can carry.
2. **Do not build the `<Record>` leg until the account is upgraded.** After upgrade, add
   `<Record action maxLength timeout playBeep=false recordingStatusCallback>` capture, download
   via `RecordingUrl`, feed whisper-large, and keep the §4 state machine unchanged (only the
   transcription source swaps).
3. **Behavior ticket scripts against §4's table**: reprompt ×2, then confirm-later + hangup;
   downstream failure → console log + clinic-will-confirm line + hangup; single-attempt booking.
4. **Ops checklist for the live test call:** caller number verified; same-country; inbound by
   dialing the trial number from the verified phone; public HTTPS webhook URL (tunnel is dev-only
   per map); fallback URL set; Free-units/Logs open in Console.

## Sources

- [TwiML Voice overview](https://www.twilio.com/docs/voice/twiml) — verbs, `<Response>`, request parameters
- [TwiML `<Gather>`](https://www.twilio.com/docs/voice/twiml/gather) — attributes, `action`, `SpeechResult`/`Confidence`
- [TwiML `<Record>`](https://www.twilio.com/docs/voice/twiml/record) — `action`, `recordingStatusCallback`, transcribe limits
- [TwiML `<Say>`](https://www.twilio.com/docs/voice/twiml/say) — `voice`, `language`, `loop`
- [TwiML `<Hangup>`](https://www.twilio.com/docs/voice/twiml/hangup) / [`<Redirect>`](https://www.twilio.com/docs/voice/twiml/redirect) / [`<Pause>`](https://www.twilio.com/docs/voice/twiml/pause)
- [Voice Webhooks](https://www.twilio.com/docs/usage/webhooks/voice-webhooks) — incoming call, status callbacks, recording callbacks
- [Webhooks Overview](https://www.twilio.com/docs/usage/webhooks/webhooks-overview) — response/fallback model, local tunneling
- [Error 11200: HTTP retrieval failure](https://www.twilio.com/docs/api/errors/11200)
- [Twilio trial account](https://www.twilio.com/docs/usage/trials) — units, restrictions, expiry
- [Try out Twilio Voice](https://www.twilio.com/docs/usage/trials/try-out-voice) — custom-TwiML verb support, global limits
- [Get started with your trial account](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account)
