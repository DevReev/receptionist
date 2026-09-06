# 03: Holds and dry-run bookings

**What to build:** The page's reserve-before-confirm flow as callable tools: place a Hold on a Slot, keep it alive while the caller decides, release it on abandon, and run dry runs that hold then release without ever saving.

**Blocked by:** 02 (directory and Slot listing).

**Status:** ready-for-agent

- [ ] `POST /v1/holds` holds a live Slot with server-owned heartbeat and expiry; dropped or abandoned Holds free themselves via release
- [ ] `POST /v1/bookings` with a dry run holds then releases and never saves, so dev and tests never spam the live page
- [ ] Slots absent from the live Availability block (invented times, elsewhere-held Slots) are rejected (422-style) and never held
- [ ] Hold lifecycle proven against the real page behind env gating: hold, heartbeat, release round-trip leaves no residue
