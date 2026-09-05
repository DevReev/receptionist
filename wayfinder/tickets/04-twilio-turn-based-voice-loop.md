---
label: wayfinder:research
status: closed
parent: ../map.md
blocked-by: []
assignee: research-agent
---

# Twilio turn-based voice loop

## Question

Which Twilio primitives carry a turn-based whisper → LLM → `<Say>` loop on a trial number, given external STT (whisper-large) and TTS (`<Say>` fixed voice)? Decide: `<Record>` vs `<Gather>` for per-turn capture, webhook flow with timeouts / retries, per-turn state machine including error paths (silence, unintelligible input, booking failure → console log + clinic-will-confirm line), and trial-number limits that constrain the live path. Output is a decision the behavior ticket scripts against.

## Resolution

Decision: **`<Gather input="speech">` carries the trial-number loop; `<Record>` is blocked on trial accounts** (stripped, replaced with a "not available on trial accounts" `<Say>`), so the map's `<Record>` → whisper-large leg requires an account upgrade. Trial loop is `<Gather>` (Twilio `SpeechResult`) → LLM → `<Say>`; post-upgrade, `<Record>` unlocks and only the transcription source swaps (action-time `RecordingUrl` may not be readable — `recordingStatusCallback completed` is the reliable signal). Webhook flow: inbound → greeting `<Say>` + `<Gather action="/voice/turn" actionOnEmptyResult="true">` → per-turn `action` posts (`SpeechResult` + `Confidence`) → server answers next `<Say>` + `<Gather>`; terminal turns end `<Say>` + `<Hangup/>`. Budgets: 5 s TwiML fetch timeout, 64 KB max, 10-hop ceiling (cap reprompts at 2), 11200 + fallback URL for webhook failure (no auto-retry). Error paths: silence/unintelligible → bounded reprompt; downstream/booking failure → console log + clinic-will-confirm `<Say>` + `<Hangup/>` (single-attempt booking); full state table in findings. Trial limits: verified-numbers-only (≤5), same-country, 75 min total, 10 min/call, 5 concurrent, 30-day expiry. Full loop design, per-turn state machine, limits, and source links: `research/twilio-loop.md`.

## Amendment 2026-09-05 (deploy trial)

- Empirical: `<Record>` turn loop executed 4+ turns on the Trial account (transcription + LLM + `<Say>` all ran); the "stripped on trial" claim above proved over-strict, at least for this account today.
- Upgrade still recommended for quotas (75 min), geo limits, and headroom — but it no longer gates loop validation.
