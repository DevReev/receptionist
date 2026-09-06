# 05: Backpressure, observability, and client

**What to build:** Production hardening and reuse packaging: the service degrades as retries under load, failures are diagnosable without video, and other projects integrate from a published contract plus a typed client instead of reading server code.

**Blocked by:** 04 (confirm bookings with guardrails and idempotency).

**Status:** ready-for-agent

- [ ] Browser pool caps concurrency with 429 plus Retry-After backpressure; page-down surfaces distinctly (502-style) from slot and validation failures
- [ ] Failures log as console JSON lines with page identity, reason taxonomy, and Slot, with screenshots on failure only and Patient data kept to the minimum the log needs
- [ ] Published OpenAPI document plus a typed client stub that books end-to-end against the live page
- [ ] Live suites stay env-gated so default runs are offline-fast; page internals (URLs, tokens, slot math) appear nowhere outside the service
