---
label: wayfinder:research
status: closed
parent: ../map.md
blocked-by: []
assignee: research-agent
---

# DeepSeek prompt and grounding contract

## Question

Does `deepseek/deepseek-v4-flash-0731` exist on OpenRouter, and with what price / context window / tool-calling support / latency? Decide the prompt architecture that grounds it in `clinic.md` (sections: hours / address / contact / services+fees / doctors / booking rules / emergency line / FAQs, hot-reloaded by file-watch) plus Picktime slot data: system-prompt shape, slot data format passed per turn, booking function-call boundary vs page automation, and the refusal/handoff behavior for medical advice. Output is a decision the behavior ticket builds on: verified model id + prompt contract.

## Resolution

`deepseek/deepseek-v4-flash-0731` exists on OpenRouter exactly as written — no id correction. Verified: 1.31M context (1.05M per-endpoint), $0.065/$0.18 per 1M in/out ($0.05/$0.10 at cheapest endpoint), full tool-calling support (`tools`, `tool_choice` auto/required/function, `parallel_tool_calls`), 30 providers, no published latency figure (measure live). Prompt contract decided: verbatim `clinic.md` in a rebuilt-per-turn system message, per-turn Picktime availability block as the only slot source, a single `propose_booking` tool with the server owning all page automation (guardrail: reject slots absent from the live block), fixed-line refusal/handoff for medical advice. Full decision in `research/deepseek-contract.md`.
