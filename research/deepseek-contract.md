# DeepSeek prompt and grounding contract — findings

## Verdict

The model id in the map is **correct as written**: `deepseek/deepseek-v4-flash-0731` exists on OpenRouter. No correction needed. Pin the dated `0731` id (not the `-latest` alias) so behavior stays reproducible.

## Verified model facts (OpenRouter primary sources)

- **ID**: `deepseek/deepseek-v4-flash-0731` — exact match in `GET /api/v1/models` and has its own model page and `/endpoints` detail.
- **What it is**: sparse mixture-of-experts, 13B active / 284B total parameters; "re-post-trained revision … suited for coding, reasoning, and agent workflows". Modality `text->text`, DeepSeek tokenizer.
- **Context window**: 1,310,720 tokens top-level (`context_length` in `/models`); per-endpoint context 1,048,576. Max completion tokens 131,072 (some providers allow more, up to 943,718 — do not rely on it; cap `max_tokens` low ourselves).
- **Price** (pinned `0731`, from `/api/v1/models` — authoritative):
  - input $0.065 / 1M tokens (`"prompt": "0.000000065"`)
  - output $0.18 / 1M tokens (`"completion": "0.00000018"`)
  - cache-read $0.016 / 1M (`"input_cache_read": "0.000000016"`)
  - Cheapest serving endpoint (Baidu, fp8, 64% discount): $0.04998 / $0.09996 per 1M in/out — this is the figure shown on the public model page. Expect the blended/default-route price to sit between the two.
  - Back-of-envelope per turn (labeled estimate, arithmetic only): ~3k input tokens ≈ $0.0002; ~150 output tokens ≈ $0.00003. A 10-turn call costs on the order of a third of a cent in LLM spend.
- **Tool calling**: fully supported. `supported_parameters` on the model includes `tools`, `tool_choice`, `parallel_tool_calls`, `structured_outputs`, `response_format`. Every sampled endpoint advertises `tools` + `tool_choice` with `auto`/`required`/`function` modes. Transport is OpenAI-compatible (`tools: [{type:'function', function:{name, description, parameters}}]`, `tool_choice`), normalized across providers by OpenRouter.
- **Latency**: OpenRouter publishes no per-model latency figure (endpoint `latency_last_30m` fields are null). "Flash" is the speed-optimized tier of the V4 family; treat latency as "fast tier, measure live" — the build must time real turns (STT → LLM → `<Say>`) and set the budget empirically. Keep prompts small and `max_tokens` capped to protect turn latency.
- **Availability**: 30 serving endpoints (Baidu, DeepInfra, Together, Fireworks, DeepSeek, Cloudflare, …), sampled uptimes ~98–100% over 30m/1d. Default routing falls back across providers on 5xx/rate-limit.
- **Reasoning**: `reasoning` / `reasoning_effort` / `include_reasoning` supported — leave reasoning off/default for v1 (voice replies must be short; reasoning tokens add latency and cost).

## Prompt architecture (decision)

Grounding sources, in priority order: (1) `clinic.md` — the ONLY source for static info; (2) the per-turn Picktime slot block — the ONLY source for availability; (3) nothing else — the model must never invent hours, fees, doctors, or slots.

### 1. System-prompt shape

One system message, rebuilt on every turn from the hot-reloaded `clinic.md` (file-watch; re-read each turn so edits take effect mid-call):

```
You are the phone receptionist for <clinic name from clinic.md>.
Scope: clinic information + appointment booking ONLY.

RULES
- Answer ONLY from the CLINIC GUIDE below for hours, address, contact,
  services+fees, doctors, booking rules, emergency line, FAQs.
- Answer ONLY from the AVAILABILITY block below for open slots.
- Never invent, guess, or paraphrase into new facts. If the answer is not
  in the guide or the availability block, say you don't know and that the
  clinic will confirm (failure-log line), and log it.
- Keep every reply short: 1–2 spoken sentences, plain words, no markdown,
  no lists, no URLs, no spelling things out letter-by-letter. It will be
  read aloud by text-to-speech.
- One question at a time when collecting booking details
  (service → date → time → name → phone).

CLINIC GUIDE
<clinic.md injected verbatim: hours / address / contact / services+fees /
 doctors / booking rules / emergency line / FAQs>

REFUSALS (use exact lines)
- Medical advice / diagnosis / prescription / price negotiation:
  "<handoff line — behavior ticket to fix exact wording>"
- Emergency symptoms: "<emergency sentence from clinic.md>" then offer to
  note details for the clinic.
- Booking failure / low confidence: "<clinic-will-confirm line>" + console log.
```

Notes for the builder:
- Inject `clinic.md` verbatim rather than summarizing — the file is hand-edited and small; verbatim injection removes a whole class of drift bugs.
- `temperature` low (0–0.3), `max_tokens` small (e.g. 200–300): replies are spoken sentences, and the cap bounds latency/cost.
- No conversation summarization in v1; the 1M+ context window makes full-history turns trivially affordable.

### 2. Slot data format passed per turn

Append after the system message (a second `system` message or a compact block prepended to the user turn — either works; pick one and stay consistent), refreshed from the Picktime scrape every turn:

```
AVAILABILITY (live from Picktime, fetched <ISO timestamp> — only these slots exist)
- <service>: <date> <time>, <date> <time>, …
- <service>: none in the next 7 days
```

- Include only the services relevant to the call plus "none available" lines so the model can say so honestly instead of inventing.
- Always carry the fetch timestamp so the model can hedge ("as of just now…") and the server can decide staleness.
- Transcription of the caller's latest utterance goes in as the `user` message, verbatim from whisper-large (no cleanup — the model tolerates STT noise better with the raw text).

### 3. Booking function-call boundary vs page automation

- The LLM **never touches the browser**. Exactly one tool, `tool_choice: "auto"`:

  `propose_booking({ service, date, time, caller_name, caller_phone })`
  — called when the model has collected all five fields and the chosen slot
  appears in the AVAILABILITY block. JSON Schema enforced via `response_format`/`structured_outputs`-compatible strict parameters.

- The server executes the Picktime page automation (ticket 03's surface), then feeds the outcome back as a `role: "tool"` message (`confirmed` / `failed: <reason>`); the model turns that into one spoken sentence.
- Guardrails on the server, not in the prompt: reject any `propose_booking` whose slot is absent from the current AVAILABILITY block (re-scrape and ask the model to re-offer); on automation failure write the console Failure log and have the model speak the clinic-will-confirm line. Never expose booking internals, selectors, or the Picktime URL to the caller.
- No other tools in v1. Availability is server-injected context, not a model tool call — one fewer round-trip per turn, which is what keeps the voice loop snappy.

### 4. Medical-advice refusal behavior

- Refuse diagnosis, prescriptions, treatment recommendations, and price negotiation with the fixed handoff line (exact wording owned by the behavior ticket / `clinic.md` FAQs — this contract only fixes the mechanism: always the exact line, no elaboration, no partial advice first).
- Emergency symptoms: speak the emergency sentence from `clinic.md`, offer to take details for the clinic, log it.
- Out-of-scope-but-harmless chatter: brief polite redirect back to info/booking, not a lecture.

## Sources

- Model page (pricing/context headline): https://openrouter.ai/deepseek/deepseek-v4-flash-0731
- Model list API (pinned-0731 pricing, context 1310720, `supported_parameters` incl. `tools`/`parallel_tool_calls`): https://openrouter.ai/api/v1/models
- Endpoints API (30 providers, per-endpoint context/completion, tool_choice modes, uptimes): https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash-0731/endpoints
- Request schema incl. `tools`/`tool_choice` normalization: https://openrouter.ai/docs/api/reference/overview (alternate markdown used)
- Map + glossary constraints (clinic.md as truth, Picktime-only slots, page-automation booking, turn-based, failure log): `wayfinder/map.md`, `CONTEXT.md`
