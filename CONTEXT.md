# Receptionist — domain glossary

- **Caller**: patient on the phone. Only actor the receptionist speaks to.
- **Patient**: the person a Booking is for. Identified by name + phone; may differ from the Caller.
_Avoid_: caller, customer
- **Receptionist**: the system (Twilio number → STT → LLM → TTS → Picktime automation).
- **Clinic guide** (`clinic.md`): hand-edited source of truth for human-facing hours / locations / services+fees / doctors / booking rules / emergency boundary / FAQs. Live availability still comes only from Picktime. Never use it as a substitute for a live Slot.
- **Availability**: the set of bookable Slots. Read live per Location — Picktime page or clone API, per the `## Locations` routing toggle in the clinic guide.
- **Slot**: a single live bookable date/time for one service + doctor + Location.
- **Slot range**: a run of consecutive Slots at one Location on one day; the unit Availability is offered to the Caller in.
- **Location**: a booking venue, such as Bobby Clinic or Bobby Hospital; it is required when creating a Booking and may filter Availability. Each Location carries a routing target (`picktime` | `clone`) in the clinic guide's `## Locations` toggle — the rule for which system books it during parallel run.
- **Hold**: a temporary reservation of a Slot that expires unless confirmed into a Booking.
_Avoid_: lock, block
- **Dry run**: a hold+release check that never saves.
_Avoid_: test booking
- **Booking**: confirmed appointment. Written through the routed system — Picktime page automation or the clone API (hold → confirm). Public operation name: `book_appointment`.
- **Picktime page**: the single configured booking page from env for v1; it currently exposes one service, one doctor, and two Locations.
- **Endpointing**: deciding the caller has stopped speaking; the Receptionist replies only after it. The local detector always owns it: the Caller-adaptive pause plus partial-transcript completeness.
_Avoid_: silence timeout
- **Hedge**: starting the REST transcription at Turn commit, before the realtime final lands, so an empty final resolves in `max(final, REST)`; the realtime final wins whenever it lands non-empty.
_Avoid_: timeout fallback, race
- **Stream session**: one call's bidirectional audio websocket; it replaces the per-turn webhook chain while live streaming is enabled.
- **Turn**: one caller utterance → transcription → reply cycle, inside a Stream session while streaming is enabled. A Turn may begin while the previous reply is still being spoken (Barge-in).
- **Speculative reply**: a reply started from a partial transcription, before the Turn's final transcription arrives; discarded and regenerated if the final disagrees with the partial.
- **Barge-in**: the Caller speaking while the Receptionist is speaking; the Receptionist stops speaking immediately and the Caller's speech starts a new Turn.
_Avoid_: interruption, talk-over
- **Backchannel**: a short Caller acknowledgement ("mm-hmm", "okay", "right") that does not take the floor and does not stop the Receptionist.
_Avoid_: interruption
- **Echo**: the Receptionist's own voice returning through the Caller's phone microphone.
_Avoid_: feedback, loopback
- **Double-talk**: the Caller speaking while the Receptionist's own voice is still audible as Echo; the Receptionist must yield without mistaking its own voice for the Caller.
- **Hosting**: where the public Tool API runs. First production deploy: Render using the Chromium-baked Docker image.
- **Tunneling**: not required for the Render-hosted Tool API; it is only relevant to the local Twilio receptionist.
- **Pointing**: setting an external caller or client integration to the deployed API endpoint.
