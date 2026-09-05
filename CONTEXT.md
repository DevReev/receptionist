# Receptionist — domain glossary

- **Caller**: patient on the phone. Only actor the receptionist speaks to.
- **Receptionist**: the system (Twilio number → STT → LLM → TTS → Picktime automation).
- **Clinic guide** (`clinic.md`): hand-edited source of truth for hours / address / contact / services+fees / doctors / booking rules / emergency line / FAQs. Hot-reloaded by file-watch. Never Picktime for static info.
- **Availability**: bookable slots. Read from the Picktime page only.
- **Booking**: confirmed appointment. Written via Picktime page automation (no public API).
- **Turn**: one caller utterance → transcription → reply cycle. Turn-based; no barge-in.
- **Failure log**: console log entry on booking failure / low confidence. Caller hears the clinic-will-confirm line.
