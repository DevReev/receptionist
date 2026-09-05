# Receptionist — domain glossary

- **Caller**: patient on the phone. Only actor the receptionist speaks to.
- **Receptionist**: the system (Twilio number → STT → LLM → TTS → Picktime automation).
- **Clinic guide** (`clinic.md`): hand-edited source of truth for hours / address / contact / services+fees / doctors / booking rules / emergency line / FAQs. Hot-reloaded by file-watch. Never Picktime for static info.
- **Availability**: bookable slots. Read from the Picktime page only.
- **Booking**: confirmed appointment. Written via Picktime page automation (no public API).
- **Turn**: one caller utterance → transcription → reply cycle. Turn-based; no barge-in.
- **Hosting**: where the Node webhook server runs. First deploy: this laptop (dev-only).
- **Tunneling**: the public URL in front of the laptop so Twilio webhooks can reach it.
- **Pointing**: setting the Twilio number's voice webhook to the server's incoming-call route. The deploy act itself.
