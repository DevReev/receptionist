---
label: ready-for-agent
source-map: wayfinder/map.md
---

# LLM clinic receptionist — build spec

## Problem Statement

Patients calling the clinic outside answered hours (or while staff are busy) reach no one: no hours/fees/doctor information, no way to check availability, no way to book. The clinic owner manually fields repetitive info and booking calls. The result is missed appointments and staff time spent as a human FAQ.

## Solution

A live receptionist on the clinic's Twilio number. A caller speaks; each turn is transcribed, answered by an LLM grounded in the hand-edited clinic guide plus live Picktime slots, and spoken back — and when the caller confirms, the booking is created on the clinic's Picktime page while they are still on the line. Failures degrade to a fixed "clinic will confirm" line plus a console log the owner reviews. Clinic information stays editable as a single markdown file with no redeploy.

## User Stories

1. As a caller, I want to hear a greeting stating which clinic I reached, so that I know I dialed correctly.
2. As a caller, I want to ask for clinic hours and hear them, so that I know when to visit.
3. As a caller, I want to ask for the clinic address, so that I can find it.
4. As a caller, I want to ask about services and fees, so that I know cost before booking.
5. As a caller, I want to ask which doctors take bookings, so that I can choose one.
6. As a caller, I want to ask what's needed to book, so that I have details ready.
7. As a caller, I want to ask for available slots for a service, so that I can pick a time.
8. As a caller, I want to be offered only slots that actually exist right now, so that I am never promised a phantom appointment.
9. As a caller, I want to hear available times as dates and times (never URLs or spellings), so that I can decide by voice.
10. As a caller, I want to pick a doctor (no silent default), so that I see the doctor I chose.
11. As a caller, I want to give my name and phone one question at a time, so that I am not interrogated three things at once.
12. As a caller who won't share my number, I want the booking to use my caller-ID number, so that the clinic can still reach me.
13. As a caller, I want to hear my booking read back before anything is saved, so that errors get caught.
14. As a caller, I want my booking confirmed while I am on the phone, so that I hang up certain.
15. As a caller whose booking fails, I want to hear the clinic will confirm shortly, so that I am not left guessing.
16. As a caller asking for medical advice, diagnosis, a prescription, or price negotiation, I want a clear refusal plus how to reach the clinic, so that I know the boundary and the alternative.
17. As a caller describing emergency symptoms, I want the emergency sentence immediately, so that I act fast instead of chatting with a robot.
18. As a caller asking something the guide doesn't cover, I want an honest "I don't know, the clinic will confirm," so that I am never fed an invented answer.
19. As a caller who stays silent or is unintelligible, I want one reprompt and then a graceful goodbye, so that the line doesn't hang forever.
20. As a caller, I want short replies (a sentence or two), so that I am not lectured at by a robot.
21. As a caller, I want to be asked if I need anything else before goodbye, so that one call settles everything.
22. As a clinic owner, I want to edit one markdown file to change hours/fees/doctors/FAQs, so that updates take effect without a redeploy or a developer.
23. As a clinic owner, I want guide edits to take effect mid-call-safe (next turn at latest), so that I never restart the server for a typo fix.
24. As a clinic owner, I want every failure as a greppable console log line with call identity and reason, so that I can review what the robot fumbled.
25. As a clinic owner, I want bookings created only after explicit caller confirmation, so that the schedule never fills with accidental holds.
26. As a clinic owner, I want the server to reject any slot the model invents, so that a hallucinated time can never become a booking.
27. As a clinic owner, I want slot holds to expire harmlessly if a call drops mid-booking, so that abandoned holds free themselves.
28. As a clinic owner, I want dev testing to never write real bookings (hold-and-release only, page identity behind config), so that testing doesn't spam patients or the schedule.
29. As a clinic owner, I want per-call spend to stay at cents (cents-scale STT + fractions of a cent LLM), so that the phone line pays for itself.

## Implementation Decisions

- Turn loop: inbound call → greeting plus listen → per caller turn: record utterance, transcribe, run assistant, speak reply, listen again; terminal turns speak goodbye and hang up.
- Transcription: hosted Whisper API, whisper-class model id, fixed English, per-turn audio clip downloaded server-side with auth; empty/failed transcription reprompts once, then graceful exit. No provider transcription features; no self-hosted models for v1.
- Assistant: pinned dated DeepSeek flash-tier model id on OpenRouter (`deepseek/deepseek-v4-flash-0731`), low temperature, small completion cap, no reasoning effort for v1.
- Grounding: system message rebuilt every turn from the verbatim clinic guide; per-turn availability block (service → date/times, fetch timestamp, explicit none-available lines) is the ONLY slot source; caller transcription enters verbatim as the user message with no cleanup.
- Booking boundary: exactly one model tool — propose a booking carrying service, date, time, caller name, caller phone — callable only when all five fields are collected and the slot is in the availability block. The server owns all Picktime interaction; the tool outcome returns as confirmed/failed and becomes one spoken sentence. No other tools; availability is injected context, not a tool call.
- Server-side guardrails (never prompt-only): reject proposed slots absent from the live availability block (re-scrape, re-offer); on automation failure write the failure log and speak the fixed line; never expose booking internals or the Picktime URL to the caller.
- Picktime access: direct server-to-server HTTPS replay of the page's own endpoints (bootstrap/auth token, booking-page data, slots, hold, heartbeat while the form is open, save, release on abandon). No browser for v1; a headed/headless browser is the documented fallback if CAPTCHA/WAF appears. Re-scrape auth on token errors, never hardcode tokens; read required contact fields and slot granularity from live preferences every call, not constants.
- Call flow order mirrors the page flow: location → service → doctor (mandatory pick, never auto-selected) → date → time → contact → confirm-then-save.
- Voice: Twilio `<Record>` per turn (bounded length, silence timeout, no beep) on an upgraded account, fixed `<Say>` voice/language (English, en-IN family) for v1.
- Clinic guide: single hand-edited markdown file (hours / address / contact / services+fees / doctors / booking rules / emergency line / FAQs), watched and reloaded without restart.
- Failure log: JSON lines to console with call identity, turn number, reason taxonomy (save-failed, low-confidence, unknown-question, phone-fallback), and transcript excerpt.
- Timezone: Asia/Kolkata end to end; slot integers are local `YYYYMMDDHHMM`.
- Credentials live in environment, never in the guide or logs; call audio is sent to the transcription provider (documented; revisit if data-residency rules change).

## Testing Decisions

- What makes a good test here: full turns through the public HTTP boundary (fake inbound-call webhook in, assert spoken reply plus next listen verb out), with the three outbound providers stubbed. Never assert prompt text, model ids in code, or Picktime endpoint strings — assert caller-observable behavior: correct slot offered, invented slot refused, refusal line spoken, booking saved only after "yes".
- Modules under test: the turn loop/state machine, the grounding assembly (guide + availability block), the booking guardrails (slot-must-exist, confirm-before-save, hold expiry), the failure-log events.
- Prior art: none — greenfield codebase, no existing tests to mirror. The first tests set the convention: boundary-level, stubbed providers, behavior-only assertions.
- Live-provider verification stays manual and safe: hold-and-release round-trips only, gated page identity, never automated `save` in tests.

## Out of Scope

- Sarvam STT, WhisperFlow, self-hosted transcription, Twilio built-in transcription.
- Trial-number voice path (account is upgraded before build).
- Streaming voice, barge-in, neural/expressive voices, non-English callers.
- Reschedule/cancel flows (book + availability-check first).
- SMS/WhatsApp human handoff (console log instead).
- Medical advice, diagnosis, prescriptions, price negotiation (refused with handoff line).
- After-hours take-a-message behavior beyond what's written in the guide.
- Call recording; recording/privacy review is a separate decision.
- Browser automation (fallback only), Browserbase costing.
- Production host selection and cost/latency budgets beyond the cents-per-call envelope (measured live post-build).

## Further Notes

- Seed data observed live on the Picktime page (one 30-min zero-fee sample service, three staff, Mon–Fri 09:00–17:00 IST) is sample content until the owner confirms; the guide draft marks every such fact for verification.
- Known fragilities to watch post-launch: Picktime bundle version changes, auth-token rotation, preferences flipping (CAPTCHA, required fields, slot granularity) — all handled by re-reading live state, never constants.
- Map this spec collapses: `wayfinder/map.md` with per-ticket detail in `wayfinder/tickets/` and evidence in `research/`.
