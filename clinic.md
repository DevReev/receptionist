# Clinic Guide — Bobby Clinic

> Source of truth for the receptionist. Picktime facts below were read from the live page `b472d549-9be7-4a21-8bf9-cd81b7aa11ee` on 2026-09-05/06. Availability is always re-read live before a caller is offered a Slot.

## Locations

- **Bobby Clinic** — Picktime label: `Bobby Clinic, Bobby Clinic, Bangalore`.
- **Bobby Hospital** — Picktime label: `Bobby Hospital, Bobby Hospital, Bangalore`.
- Picktime did not provide a more detailed street address, landmark, or contact number in the directory response. Do not invent one.

## Hours and availability

- Live weekday slot probe: Monday–Friday, 09:00–17:00 IST.
- Appointment starts are offered every 15 minutes; the last observed start is 16:45 for a 15-minute service.
- Weekend hours were not supplied by the directory and are not confirmed.
- Availability is location-specific. Always tell the caller which location a Slot belongs to.
- Never invent a time. Offer only Slots returned by the live Picktime availability response.

## Services and fees

- **Appointment** — 15 minutes — Rs 700.
- The fee is the amount currently reported by Picktime. Payment method and payment timing were not supplied by the directory.

## Doctor

- **Bob Gowda** is the only doctor currently returned by the live Picktime directory.
- The API may omit `doctorId` while exactly one live doctor exists. If the page later returns multiple doctors, ask the caller to choose; never silently select one.

## Booking rules

- Collect, one question at a time: location → service → date → time → patient name → mobile phone.
- A booking requires an explicit location, a live Slot, patient name, and patient phone.
- Use an E.164 phone number, for example `+919108136464`.
- Do not default a patient's name or phone from previous calls or examples.
- Read back location, service, doctor, date, time, patient name, and phone before saving.
- Save only after explicit caller confirmation.
- A dropped or abandoned flow must release its temporary Hold.
- A repeated save request must reuse its Idempotency-Key rather than creating a second Booking.

## Contact

- Clinic phone: not supplied by Picktime.
- Owner or fallback mobile: not supplied by Picktime. Do not invent a number.

## Emergency line

- No emergency sentence or emergency number was supplied by Picktime. Do not provide medical advice; direct callers with emergency symptoms to local emergency services.

## FAQs

- No FAQ content was supplied by Picktime. For questions not covered here, say that the clinic will confirm rather than inventing an answer.
