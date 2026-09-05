---
label: ready-for-agent
source: grill-with-docs session 2026-09-05 + docs/adr/0001-playwright-over-direct-https + research/picktime-surface.md
---

# Picktime Tool API — build spec

## Problem Statement

An LLM that needs to book on the Picktime page today has no hands: the page exposes no public API, and the direct-HTTPS replay path is version-pinned XHR only a developer can operate. Agent builders (the clinic receptionist first, other projects next) need callable tools — list real Slots, hold one, confirm a Booking — behind a deployable HTTP service, without each project solving browser automation, hold heartbeats, or page quirks on its own.

## Solution

A standalone Dockerized Tool API service owns a Playwright-driven Chromium instance and exposes two public business endpoints — `GET /v1/get_available_slots` and `POST /v1/book_appointment` — plus live directory, health, hold, legacy aliases, and OpenAPI support routes. The service owns all Picktime interaction, guardrails, and failure logging. It deploys from GitHub to Render; the configured Picktime page is single-tenant for v1.

## User Stories

1. As a consumer developer, I want a directory endpoint for services, doctors, and locations, so that my agent resolves names to stable IDs once.
2. As a consumer LLM, I want to list Slots for a service over a date window, so that I only ever offer times that exist right now.
3. As a consumer LLM, I want to list Slots without passing a doctor, so that single-doctor setups stay one call.
4. As a consumer LLM, I want unfiltered listings grouped per doctor, so that doctor identity survives when more doctors book later.
5. As a consumer LLM, I want an explicit none-available signal instead of an ambiguous empty reply, so that I say "nothing free" honestly.
6. As a consumer LLM, I want past times omitted and windows capped at one month, so that I never offer yesterday or scrape forever.
7. As a consumer LLM, I want times as ISO local plus an explicit timezone, so that no caller does page-int math.
8. As a consumer LLM, I want invented or unknown IDs rejected with 404/422, so that a hallucinated Slot can never become a Booking.
9. As a consumer LLM, I want to place a Hold before confirming, so that read-back-first flows (voice loops) mirror the page.
10. As a developer, I want a separately gated live-save test, so that integration checks can prove a real booking without running on every test or deploy.
11. As a consumer LLM, I want to confirm a Booking with service, location, date, time, Patient name, and Patient phone, so that one call finishes the job.
12. As a Patient, I want my Booking saved only from a real held Slot, so that double-booking and phantom appointments cannot happen.
13. As a consumer LLM, I want bookings without a doctor to resolve to the page's single doctor, so that single-doctor callers pass less.
14. As a consumer LLM, I want an ambiguous-doctor booking to fail as 422 pick-a-doctor with candidates, so that no silent default ever books the wrong doctor.
15. As a consumer LLM, I want contact prefs re-read live with 422 on newly-required missing fields, so that page changes fail loudly instead of misbooking.
16. As a consumer LLM, I want every real Booking to require an Idempotency-Key, so that a retried "yes" never double-books.
17. As a consumer LLM, I want distinct codes for unknown IDs (404), invented/held slots and bad contact (422), key conflicts (409), pool-full (429 plus Retry-After), and page-down (502), so that my agent reacts correctly per failure.
18. As a clinic owner, I want phone always required even though page prefs call it optional, so that every Booking stays reachable.
19. As a clinic owner, I want failures as greppable console JSON lines with page identity, reason, and Slot, so that I can review what the robot fumbled.
20. As an operator, I want a deep health check (browser plus page reachability), so that the cloud restarts or pages on real breakage.
21. As an operator, I want all tunables in env (page, timezone, pool, timeouts, and rate limit), so that Render deploys differ by config, never code.
22. As an operator, I want Chromium baked into the Docker image with a ~2GB RAM floor, so that any container host runs it.
23. As a consumer developer, I want an OpenAPI document plus a typed client stub, so that other projects integrate without reading server code.
24. As a consumer LLM under load, I want capped browser concurrency with 429 backpressure, so that bursts degrade as retries, not corruption.
25. As a clinic owner, I want Hold expiry plus release-on-abandon server-side, so that dropped calls free their Slots by themselves.
26. As a consumer developer, I want page internals (URLs, tokens, ints) never exposed, so that my agent cannot depend on what will change.
27. As the receptionist voice loop, I want hold-then-save owned server-side with heartbeat, so that the call just says "yes" and hangs up certain.

## Implementation Decisions

- Shape: a standalone Express service, deployed as its own Chromium-baked Docker image; the receptionist or another caller consumes it over HTTP and keeps no page logic of its own.
- Seams: one browser driver behind the public HTTP boundary. Reused conventions: fail-fast page env loading, JSON console failure lines, and boundary-level node:test suites.
- HTTP layer: public `GET /v1/get_available_slots` and `POST /v1/book_appointment`, plus `/v1/meta`, `/health`, `/v1/holds`, `/v1/openapi.json`, and compatibility aliases `/v1/slots` and `/v1/bookings`. No bearer authentication. `POST` writes require an `Idempotency-Key` header.
- Browser pool: one persistent Chromium, one isolated context per request (no cookie or token bleed), capped concurrency (4, rest get 429 plus Retry-After), per-step timeouts, and one re-bootstrap retry on auth/token errors.
- Page flow driver: automation mirrors the page order (location, service, doctor, date, time, contact, confirm-then-save); required contact fields and slot granularity come from live prefs every call, never constants.
- Slot mapping: page-local slot ints stay internal; outside the service every time is ISO local with the configured timezone end to end; Availability responses carry fetch time and explicit none-available reasons. `locationId` is optional for search and required for Booking.
- Doctor resolution: no configured doctor; absent doctor in listings fans out per doctor with grouping, absent doctor at booking resolves to the page's single doctor; multiple booking doctors flip ambiguous bookings to 422 pick-a-doctor with candidates (no silent default, ever).
- Booking boundary: confirm-only writes; every write is hold, heartbeat while the form is open, save, release on failure or abandon; dry runs execute hold plus release and never save.
- Guardrails: reject Slots absent from live Availability; enforce Patient name plus E.164 phone server-side; require an explicit Idempotency-Key for every real save; same key with a different payload conflicts.
- Public endpoint controls: 16 KiB JSON body limit, strict field validation, 60 requests per minute per process/IP by default, no CORS middleware, and no patient names or phones in logs.
- Failure log: JSON lines to console with page identity, reason taxonomy (save-failed, slot-taken, unknown-id, invented-slot, validation, conflict, pool-full, page-down), and Slot; screenshots on failure only, no video.
- Config: page identity, timezone, pool size, timeouts, and rate limit from env; only `PICKTIME_PAGE_ID` is required; no bearer or LLM key server-side.
- Render: `render.yaml` points the GitHub service at `picktime-api/Dockerfile`, uses `/health`, sets `PICKTIME_LIVE=1`, and leaves `PICKTIME_PAGE_ID` as a Render secret.
- Per ADR-0001: Playwright-driven Chromium fronts the Tool API; the researched direct-HTTPS replay stays the documented fallback if selector fragility ever costs more than version-pinned XHR.

## Testing Decisions

- What makes a good test here: public HTTP boundary checks run offline against the memory driver; live reads and hold/release checks are env-gated; real saves run only in the separately gated `PICKTIME_LIVE_SAVE=1` suite and intentionally leave manual-cleanup residue. Assert caller-observable behavior: real Slot offered, invented Slot refused, dry run saves nothing, retried keyed confirm books once, and unauthenticated requests work.
- Modules under test: the HTTP layer and contracts, Slot mapping and validation, hold/heartbeat/save/release with expiry, required idempotency, the error taxonomy, body limits, rate limiting, config, failure-log privacy, and Render startup configuration.
- Prior art: the repo's boundary-level node:test suites. Live-save runs never run by default, never run during Render deploys, and always target the configured page only.

## Out of Scope

- Multi-tenancy and per-request page identity (single page from env for v1).
- Reschedule and cancel flows (book plus availability-check first).
- Rewiring the receptionist onto this API (consumer ticket; the interim guardrail stays until then).
- Browser fallback vendors, streaming voice, non-English callers, SMS handoff.
- Production host selection beyond "any container host with ~2GB RAM"; cost and latency budgets beyond the cents-per-call envelope (measured live post-build).
- Call recording and recording-privacy review (separate decision).

## Further Notes

- Live data observed on the page: one 15-minute Rs 700 Appointment service, one doctor (Bob Gowda), two Locations (Bobby Clinic and Bobby Hospital), and weekday 09:00–17:00 IST slot starts. Names and IDs remain live directory data rather than hardcoded contract defaults.
- Known fragilities to watch post-launch: page bundle version changes, auth-token rotation, prefs flipping (CAPTCHA, required fields, slot granularity), and Render Chromium resource limits — the driver re-reads live state and retries bootstrap once, never hardcodes.
- Direct-HTTPS replay details live in the Picktime surface research; consult them before any fallback work.
