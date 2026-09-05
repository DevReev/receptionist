---
label: wayfinder:research
status: closed
parent: ../map.md
blocked-by: []
assignee: research-agent
---

# Picktime availability and booking surface

## Question

On https://www.picktime.com/6412ef14-82b7-494c-97b2-5a1d5ad50e69#book/services (no login required), how are availability read and bookings written without a public API? Map step-by-step: how availability is exposed (XHR endpoints vs DOM scrape), the booking click path with required fields (name / phone / service / doctor minimum), the confirmation signal, and bot defenses / rate limits. Recommend the live-path automation: Browserbase vs local Playwright / Chrome DevTools, with cost/latency/robustness tradeoffs. Output is a decision the booking implementation and behavior tickets build on.

## Resolution

Direct HTTPS wins: the page is XHR-driven with a page-embedded JWT (`scanToken` +
`browserId` headers) and every step replayed live — availability reads, plus a
hold→release round-trip (no booking created). Minimum booking: service + doctor +
date/time + first name; confirmation = `save/event status:true` → confirmation tab.
No CAPTCHA/WAF/booking rate-limit on this page today. Recommendation over local
Playwright vs Browserbase with tradeoffs in `research/picktime-surface.md`.
