---
label: wayfinder:grilling
status: closed
parent: ../map.md
blocked-by: [02-deepseek-prompt-and-grounding-contract, 03-picktime-availability-and-booking-surface]
assignee: Main
---

# Receptionist behavior and clinic.md contract

## Question

HITL — resolve live with the human via the grilling + domain-modeling skills; never answer for them. Lock the caller-facing behavior and the `clinic.md` contract: exact scripts (greeting, slot offer, booking confirmation, medical-advice refusal + handoff line, emergency sentence, failure line matching the console-log path), the `clinic.md` section schema and hot-reload rule, and the console failure-log format. Builds on the slot-data shape (Picktime ticket) and prompt contract (DeepSeek ticket); read both resolutions first. Output is a decision the build executes directly.

## Resolution

Resolved live with the human (grilling round 1; all six answers accepted).
- Upgrade-first: Twilio account is upgraded before build; single `<Record>` → whisper-1 path. Trial `<Gather>`/Twilio-STT loop abandoned (out of scope).
- Live-save on explicit caller "yes" after read-back (service + doctor + date/time + name). Hold-then-read-back-then-save; nothing silent, no confirm-later queue.
- Phone fallback: ask once; on refusal use the caller-ID (`From`) number; log the source. First name always required.
- Scripts locked as drafted (greeting, refusal + handoff, emergency + call-now line, read-back, failure line); exact wording in the round-1 record, injected as the REFUSALS block per the DeepSeek prompt contract.
- English-only v1 (`en-IN` `<Say>` voice; whisper `language=en`); non-English → failure line + log.
- Failure log: JSON lines with CallSid, turn, reason (save-failed / low-confidence / unknown-question / phone-fallback), transcript excerpt.
- Asset: `clinic.md` v1 drafted from live Picktime facts (hours, address, service, doctors) with `{placeholders}` the human fills (clinic name, contact, emergency sentence, FAQs, after-hours rule).
