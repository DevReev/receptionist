# 02: Directory and Slot listing

**What to build:** Live Availability reads through the real page: a directory of services, doctors, and location plus Slot listing over a date window, so consumer LLMs only ever offer times that exist right now.

**Blocked by:** 01 (service scaffold, config, health, Docker).

**Status:** ready-for-agent

- [ ] `GET /v1/meta` returns the page's services, doctors, and location with stable IDs
- [ ] `GET /v1/slots` requires a service, resolves an absent doctor to the configured single doctor, caps windows at one month, omits past times, and returns ISO local times with the configured timezone (page-local slot math stays internal)
- [ ] Unfiltered listings keep per-doctor grouping and empty results carry an explicit none-available reason, never an ambiguous empty reply
- [ ] Unknown service or doctor IDs are rejected (404-style), proven against the real page behind env gating
