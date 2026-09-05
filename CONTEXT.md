# Receptionist — domain glossary

- **Caller**: patient on the phone. Only actor the receptionist speaks to.
- **Patient**: the person a Booking is for. Identified by name + phone; may differ from the Caller.
_Avoid_: caller, customer
- **Receptionist**: the system (Twilio number → STT → LLM → TTS → Picktime automation).
- **Clinic guide** (`clinic.md`): hand-edited source of truth for human-facing hours / locations / services+fees / doctors / booking rules / emergency boundary / FAQs. Live availability still comes only from Picktime. Never use it as a substitute for a live Slot.
- **Availability**: the set of bookable Slots. Read from the Picktime page only.
- **Slot**: a single live bookable date/time for one service + doctor + Location.
- **Location**: a Picktime booking venue, such as Bobby Clinic or Bobby Hospital; it is required when creating a Booking and may filter Availability.
- **Hold**: a temporary reservation of a Slot that expires unless confirmed into a Booking.
_Avoid_: lock, block
- **Dry run**: a hold+release check that never saves.
_Avoid_: test booking
- **Booking**: confirmed appointment. Written via Picktime page automation (no public Picktime API). Public operation name: `book_appointment`.
- **Picktime page**: the single configured booking page from env for v1; it currently exposes one service, one doctor, and two Locations.
- **Turn**: one caller utterance → transcription → reply cycle. Turn-based; no barge-in.
- **Hosting**: where the public Tool API runs. First production deploy: Render using the Chromium-baked Docker image.
- **Tunneling**: not required for the Render-hosted Tool API; it is only relevant to the local Twilio receptionist.
- **Pointing**: setting an external caller or client integration to the deployed API endpoint.
