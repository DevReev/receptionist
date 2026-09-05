# ADR-0002: Hold and save share one browser session

## Context

`PlaywrightDriver.withAuthed` opens a fresh browser context per call (new
cookies, `browserId`, `scanToken`). Direct confirms ran hold and save in two
separate sessions. Live evidence 2026-09-05: holds succeeded but `save/event`
answered generic `failure`, and cross-session `releaseSlot` left blockers
behind that hid the slots from later availability reads until their ~10 min
TTL expired. The researched curl replay (single session) never showed this.

## Decision

Direct `confirmBooking` (no prior `holdId`) loads the directory, holds, saves,
and on failure releases inside a single `withAuthed` session (`holdVia` /
`releaseVia` share the request context and bootstrap).

## Consequences

- Direct bookings no longer depend on the page accepting another session's
  blocker key.
- The holds API (`POST /v1/holds` then confirm by `holdId`, heartbeat,
  expiry release) is still cross-session by nature: holds taken through it
  may not survive heartbeat, and their release may leak until TTL. A
  session-pinned pool or cookie jar is future work if the voice loop needs
  long-lived holds; tonight it books direct only.

## Postscript (2026-09-05, proven live)

The session change alone did not fix saves: `save/event` kept answering
generic `failure` until the payload was rebuilt to the page's real shape
(`account_id` / `type: appointment` / `services[]` / `team[]` /
`start_date_time` / `location` / `cost`, `comments` → `notes`), reverse-
engineered from `newBookingPage.js` and verified with booking `JN3000`.
The research replay never saved, so the hold-shaped payload went unproven.
Both fixes stand: shape was the blocker, same-session is defense in depth.
