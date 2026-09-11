---
label: wayfinder:map
status: open
tracker: local-markdown
---

# LLM clinic receptionist map

## Destination

A live receptionist on a real Twilio number: turn-based call → whisper-large transcription → OpenRouter `deepseek/deepseek-v4-flash-0731` grounded in `clinic.md` + Picktime slots → Twilio `<Say>` reply → booking driven via Picktime page automation, failures to the console log. Done when a test call checks availability and books on the Picktime page.

## Notes

- Domain: Node webhook server (always-on host, public URL; laptop tunnels dev-only) driving an upgraded Twilio voice number. Voice path is now the live Stream session by default (`VOICE_LOOP=stream`): Caller audio → Endpointing → whisper STT → streamed assistant tokens cut at sentence boundaries → OpenAI TTS in-session (one voice for greeting + replies; the fixed `<Say>` voice differs and survives only on the legacy path). Legacy record-based loop (`<Record>` → whisper → LLM → `<Say>`) is retained behind `VOICE_LOOP=legacy` as rollback until the follow-up removes it.
- Locked by the human: whisper-large STT only; single hand-edited `clinic.md`, hot-reloaded by file-watch; info + appointments only, medical advice refused with handoff line; slots only from Picktime; failures to console log (no SMS). Live validation (ticket 13) found the Twilio account still on Trial (`scripts/live-validation.sh` reports type Trial) — streaming `<Connect><Stream>` verbs require an upgraded account, so the first real streaming call is operator-gated on upgrade.
- Skills per ticket type: `research` tickets → research skill, AFK. Grilling ticket → grilling + domain-modeling skills, HITL (never answer for the human).
- Local-markdown conventions: each ticket carries `label: wayfinder:<type>`, `status: open|closed`, `blocked-by: [...]`, `assignee:`. Claim = set `assignee` before work. Frontier = open, unblocked (every `blocked-by` closed), unclaimed children of this map. Resolve = append `## Resolution`, link assets (findings under `research/`), set `status: closed`. Work-through sessions sync Decisions-so-far.
- Key links: Picktime page https://www.picktime.com/6412ef14-82b7-494c-97b2-5a1d5ad50e69#book/services (no login). Glossary: `CONTEXT.md`.

## Decisions so far

<!-- one line per closed ticket: gist + link; detail lives in the ticket -->
- [Whisper-large transcription path](tickets/01-whisper-large-transcription-path.md): OpenAI `whisper-1` per turn via `<Record>` download-and-forward; self-hosted large-v3 rejected.
- [DeepSeek prompt and grounding contract](tickets/02-deepseek-prompt-and-grounding-contract.md): model id verified verbatim; verbatim `clinic.md` + per-turn availability block + single `propose_booking` tool.
- [Picktime availability and booking surface](tickets/03-picktime-availability-and-booking-surface.md): direct HTTPS XHR (hold → heartbeat → save), no browser; minimum service + doctor + date/time + first name.
- [Twilio turn-based voice loop](tickets/04-twilio-turn-based-voice-loop.md): `<Gather>` on trial, `<Record>` after upgrade; per-turn state machine, budgets, trial limits.
- [Receptionist behavior and clinic.md contract](tickets/05-receptionist-behavior-and-clinic-md-contract.md): upgrade-first single path; live-save on read-back yes; phone falls back to caller ID; scripts + JSON log locked; `clinic.md` v1 drafted.
- [Live validation call and map amendments](tickets/13-live-validation.md) (code-complete, live-gated): `VOICE_LOOP` default flipped to `stream` with `wss://` guard, legacy behind `VOICE_LOOP=legacy`; `scripts/live-validation.sh` carries the automatable preconditions; Twilio account still Trial so the real streaming call waits on upgrade.

## Not yet specified

- Reschedule / cancel flows on the Picktime page (book + availability-check first).
- Dev-vs-live Picktime safety: how to test booking without polluting the live page.
- After-hours behavior (take-a-message vs book) and the exact emergency sentence.
- Call recording / logging privacy constraints for patient data.
- Cost and latency budgets per call (Whisper + OpenRouter + Twilio trial limits).
- Production host choice for the Node server.
- Language expansion beyond v1 (caller-language matching deferred).

## Out of scope

- Sarvam STT and WhisperFlow (whisper-large locked instead).
- SMS/WhatsApp human handoff (console log instead, per human).
- Medical advice, diagnosis, prescriptions, price negotiation (refused with handoff line).
- Barge-in (caller interrupting the Receptionist; inbound audio during playback is discarded) and neural/expressive voice shopping beyond the single configured OpenAI TTS voice. Turn-based `<Say>` is the retained legacy path, not the default.
