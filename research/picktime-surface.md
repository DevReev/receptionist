# Picktime availability + booking surface (live, no login)

Question: on https://www.picktime.com/6412ef14-82b7-494c-97b2-5a1d5ad50e69#book/services,
how are availability read and bookings written without a public API?
Verified 2026-09-04/05 against the live page, its JS bundles, and live endpoint probes.
No booking was created during research (only reads + one hold immediately released).

## Recommendation

**Automate over direct HTTPS (Node `fetch`), not a browser.** The whole surface is
unguarded XHR with a page-embedded auth token, and every step was replayed with curl:
reads, slot hold, and slot release all return `status:true`. A browser (local Playwright
or Browserbase) is only a fallback if Picktime adds a CAPTCHA/WAF later.

| path | cost | latency | robustness |
|---|---|---|---|
| Direct HTTPS from the Node server | ~0 (same host, no extra service) | lowest (3 sequential calls, no page/JS/ad load) | highest today: no selectors to break; version-pin the bundle (`v26825v2`) and re-verify on change |
| Local Playwright on the always-on host | ~0 license (self-hosted browser; cost = host CPU/RAM) | higher (full page + ads + Backbone boot per call) | medium: DOM selectors break on Picktime redesigns |
| Browserbase (cloud browsers) | metered per-session/minute (check current pricing — page unreachable from here) + network hop | highest (remote browser + streaming) | same DOM fragility as local, plus a vendor dependency |

Why direct HTTPS wins here specifically: no CAPTCHA is enabled (`captcha: null` in live
prefs), no WAF (Google Frontend, no challenge headers), auth is a static page JWT, and
slot ints/timezone math are plain JSON. Revisit only if `captcha` becomes non-null or
`save/event` starts rejecting non-browser clients.

## 1. Bootstrap + auth (all `/endpoint/1.0.0/ia/*` calls need this)

- `GET /` page HTML embeds an inline bootstrap: `scanToken` (JWT, `iss: PT`,
  `accountId: 6412ef14-…`, `sub: book`), `browserId` (uuid, persisted to
  `localStorage.pt_browser_id`), `socket_server: https://io.pushfarm.com`,
  `accountTimezone: Asia/Kolkata`, `today`.
- Cookies: `pt_csrf` (HttpOnly, Secure, SameSite=None + Partitioned — keep a cookie jar).
- Every XHR sends headers `scanToken: <jwt>`, `browserId: <uuid>`, and POSTs add
  `X-CSRF-TOKEN: <pt_csrf value>` (see bundle ajaxSetup + holdSlot call).
- Without those headers every endpoint returns
  `{"status":false,"message":"Auth token validation error"}` (reproduced live).

## 2. Availability read path (XHR, no scraping needed)

1. `GET /endpoint/1.0.0/ia/loadBookingPage?_=…&bootstrap=true` → services, team
   (doctors), locations, preferences. Live snapshot: 1 service `Sample Service`
   (`6ea794a6-…`, 30 min, Rs 0.00); 3 staff: Veer Maruthesh (`66a9d907-…`),
   veer2 (`6f2fb68e-…`), veeer (`c283d7f1-…`); 1 location `bobby home, nallurhalli,
   Bangalore` (`abac505c-…`); hours Mon–Fri 09:00–17:00 IST (`m-540-1020` etc.).
2. `GET /endpoint/1.0.0/ia/bookingFlowData?eventType=all&bookNowKey=<page uuid>&bookNowType=services`
   → flow order `LST` (Location → Service → Team/Time), `booking_slot: 15`,
   `auto_select_staff: false` (a doctor MUST be picked), `contact_form_fields:
   [firstName, lastName, address, comments, mobileNumber, email]`,
   `contact_form_req_fields: [firstName]`, `captcha: null`, no payment fields.
3. `GET /endpoint/1.0.0/ia/slots` with `dateAndTime=YYYYMMDD0000`,
   `endDate=YYYYMMDD0000` (month window), `schedulerId`, `locationId`, `duration=30`,
   `slot=15`, `offBooking=false`, `eventType=appointment`, `serviceClassId`,
   `accountId`, `timezone=Asia/Kolkata`, `v3=true`
   (+ companion `GET /endpoint/1.0.0/ia/getTimezoneHoursMap?dateAndTime=…`).
   Live result for Veer Maruthesh, Sept 2026: `status:true`, 31 slots as ints
   `YYYYMMDDHHMM` local (e.g. `202609070900`), plus `metadata.availabledays`
   (`20260907…11, 14…18, 21…25, 28…30` — weekdays only).

## 3. Booking write path (click path → API chain)

Page flow mirrors `bookingFlowOrder LST`: Location → Service (`Sample Service`) →
Team/doctor (no auto-select) → date → 15-min-granularity slot → contact form →
confirm. Underneath it is a hold-then-save chain (all `POST`, JSON, CSRF header):

1. `POST /endpoint/1.0.0/ia/holdSlot` `{accountKey, type:"service", staffKey,
   serviceKey, startDateAndTimeGMT, endDateAndTimeGMT (+duration), timezone,
   anyStaff:false, locationId}` → `{blockerKey, expiresAt}`.
   Live proof: held `202609300930` for Veer Maruthesh → `blockerKey 5e3f8ba7-…`,
   `expiresAt 20260904203307` (~10 min TTL), then released.
2. `POST /endpoint/1.0.0/ia/heartbeatSlot` `{blockerKeys:[…]}` every ~60 s
   (`interval:6e4`) while the form is open; expiry/elsewhere-held triggers the
   "Someone else just reserved this slot" / cross-tab dialogs.
3. `POST /endpoint/1.0.0/ia/save/event` with `dateTime`, `duration`, `fname`
   (+ `lname/email/mobile_number/…` per prefs), `timezone`, `slotBlockerKey`,
   `pay_later`, optional `captcha_token`/`coupon_id`.
   Required minimum: service + doctor + date/time + **first name only**
   (`fname` hard-required; phone/email optional per current prefs).
4. Confirmation signal: response `status:true` + `data` (event record) →
   client sets `tabId="confirmation"`, `booking.booked=true`, stops the heartbeat,
   clears the hold (`slotBlockerKey=null`); `data.booking_email_confirmation`
   gates the email notice. Variants: `approve_status:"pending"` → pending tab;
   `payment_required` → payment tab (not applicable: cost is Rs 0).

## 4. Bot defenses / rate limits

- No WAF/challenge (headers: `server: Google Frontend`; no Cloudflare): page, bundles,
  and XHR all curl-replayable.
- CAPTCHA exists in code (`grecaptcha`, `captcha_token`) but is **disabled** for this
  page (`captcha: null`; only sent if prefs require it).
- No booking-path rate limiting found in the bundle; the only "Too many" strings are
  login-2FA lockouts. Abuse control = slot holds (10-min TTL + heartbeat + cross-tab
  conflict dialogs) and short-lived `pt_csrf` (30 min).
- Caveat: the sandbox headless tab would not execute the page's `<script>` tags
  (bundles 200 OK, zero console errors, yet `window.jQuery` stayed undefined and a
  probe script never ran) — a harness limitation, not Picktime behavior; all findings
  above were verified via static bundle analysis + live HTTP instead.

## Evidence (primary sources)

- Live page: https://www.picktime.com/6412ef14-82b7-494c-97b2-5a1d5ad50e69#book/services
- Bundles (version observed): `https://www.picktime.com/assets2/newBookingPage.js?_=v26825v2`
  (1.37 MB, jQuery 3.7.1 + Backbone app), `…/templates-booking-bundle.js?_=v26825v2`
- Live probes 2026-09-04/05: `loadBookingPage`, `bookingFlowData`, `slots`,
  `getTimezoneHoursMap` (`status:true`); `holdSlot` → `releaseSlot` round-trip
  (`status:true`, no residue). Raw probe outputs live in `/tmp` (`lb3.json`,
  `bf4.json`, `slots.json`, `hold.json`, `rel.json`) — scratch only, not repo assets.
- Automation options: https://docs.browserbase.com/welcome/introduction (cloud-browser
  API/SDKs), https://playwright.dev/docs/intro (self-hosted, runs locally/CI).
  Browserbase metered pricing page was unreachable from here — confirm before costing.

## Open threads for implementation tickets (not this ticket)

- Dev-vs-live safety: any `save/event` test writes a REAL booking + email. Test with
  hold+release only; gate the live page uuid behind config.
- `scanToken` rotation: re-scrape on `Auth token validation error`, never hardcode.
- Watch `bookingPreferences` (`captcha`, `contact_form_req_fields`, `booking_slot`)
  per call — required fields and slot math come from there, not constants.
