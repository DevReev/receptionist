# Playwright browser over direct HTTPS for the Picktime Tool API

Direct-HTTPS replay won on latency/cost/robustness, but the product decision is an LLM-operable, cross-project Tool API driving the real page through Chrome DevTools. We run Playwright-driven Chromium behind the public `GET /v1/get_available_slots` and `POST /v1/book_appointment` routes, with `GET /v1/meta`, `POST /v1/holds`, `GET /health`, OpenAPI, and compatibility aliases, and keep direct HTTPS as the documented fallback if selectors prove costlier than version-pinned XHR.
