# 01: Service scaffold, config, health, Docker

**What to build:** A deployable skeleton of the Picktime Tool API: an HTTP service that fails fast on missing env, guards calls with a bearer key, reports deep health, logs JSON lines to console, and ships as a Chromium-baked Docker image any container host can run.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Missing env fails fast listing every missing credential; page identity, doctor, bearer key, timezone, pool and timeout tunables all come from env, never code
- [ ] `GET /health` passes only when the browser launches and the Picktime page is reachable, and calls without the bearer key are rejected
- [ ] Docker image builds with Chromium baked in and serves the API on the configured port
- [ ] Failure and lifecycle events log as greppable console JSON lines carrying page identity
