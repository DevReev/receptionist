import type {
  Assistant,
  AssistantContext,
  AssistantEvent,
  AssistantReply,
  BookingOutcome,
  ChatTurn,
  ClinicGuide,
  ProposedSlot,
} from './app.ts';
import { clip } from './trace.ts';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const MAX_TOOL_ROUNDS = 5;
/** Providers occasionally return an empty completion; one retry usually recovers. */
const MAX_EMPTY_RETRIES = 1;
/**
 * A failed round hangs up on the Caller, and upstream rate limits and blips
 * last seconds; a short bounded backoff is cheaper than a dead Turn. Same
 * transient statuses the booking client retries.
 */
const RETRYABLE_STATUS = new Set([429, 502, 503]);
const HTTP_RETRY_BACKOFF_MS = 300;

/**
 * OpenRouter routing: favour whatever provider currently has the lowest
 * observed latency, with a soft p90 ceiling. Without this, requests land on
 * the default provider and TTFT can swing from under a second to many
 * seconds. `require_parameters` is deliberately NOT set: it is stricter than
 * tool support and zeroes out endpoint pools (e.g. gpt-5-nano) whose
 * first-party providers already support every parameter actually sent.
 * Sent only when `openRouterRouting` is on; a direct Groq endpoint rejects
 * or ignores these fields.
 */
const PROVIDER_PREFERENCE = {
  sort: 'latency',
  preferred_max_latency: { p90: 2.0 },
} as const;

const GET_AVAILABILITY_TOOL = {
  type: 'function',
  function: {
    name: 'get_availability',
    description:
      'Read live clinic availability (open Slots). Call this when the caller asks about open times, or before offering or confirming any date or time. Returns the bookable Slots, or an error with a `say` line when the booking system cannot be reached.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
} as const;

const PROPOSE_BOOKING_TOOL = {
  type: 'function',
  function: {
    name: 'propose_booking',
    description:
      "Propose a booking once the date, time, and patient name are collected, the caller has confirmed the slot from get_availability, and the mobile number is settled. Location and service default to Bobby Clinic and the standard Appointment — pass them only when the caller asked for something else. Omit callerPhone when the caller confirmed the number they are calling from.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['date', 'time', 'callerName'],
      properties: {
        service: { type: 'string', description: 'Defaults to the standard Appointment service.' },
        location: { type: 'string', description: 'Defaults to Bobby Clinic.' },
        date: { type: 'string', description: 'YYYY-MM-DD exactly as listed in the availability block.' },
        time: { type: 'string', description: 'HH:MM exactly as listed in the availability block.' },
        callerName: { type: 'string', description: 'The patient name.' },
        callerPhone: {
          type: 'string',
          description:
            'The patient mobile number. Omit only when the caller confirmed the number they are calling from.',
        },
      },
    },
  },
} as const;

const TOOLS = [GET_AVAILABILITY_TOOL, PROPOSE_BOOKING_TOOL];

const DEFAULT_SERVICE = 'Appointment';
const DEFAULT_LOCATION = 'Bobby Clinic';
const REQUIRED_SLOT_FIELDS = ['date', 'time', 'callerName'] as const;

function parseSlot(argsText: string, callerPhone?: string): ProposedSlot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  for (const field of REQUIRED_SLOT_FIELDS) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') return null;
  }
  const optional = (field: string, fallback: string): string => {
    const value = record[field];
    return typeof value === 'string' && value.trim() !== '' ? value : fallback;
  };
  const phone = optional('callerPhone', callerPhone ?? '');
  if (phone === '') return null;
  return {
    service: optional('service', DEFAULT_SERVICE),
    location: optional('location', DEFAULT_LOCATION),
    date: record.date as string,
    time: record.time as string,
    callerName: record.callerName as string,
    callerPhone: phone,
  };
}

function systemPrompt(guide: ClinicGuide, callerPhone?: string): string {
  return [
    `You are the phone receptionist for ${guide.name} — warm, natural, and brief.`,
    'The CLINIC GUIDE below is your source of truth; its CONVERSATION STYLE and BOOKING',
    'RULES sections tell you how to behave. Follow them, but speak in your own words —',
    'never recite the guide like a script.',
    '',
    'WHAT YOU DO',
    '- Chat naturally. Greetings and small talk need no lookup: just respond like a person.',
    '- Answer clinic questions from the CLINIC GUIDE.',
    '- Help callers book. The booking system is worked by the call controller, not by you:',
    '  never claim an appointment is confirmed. When the controller gives you live slots or a',
    '  dialogue act, phrase exactly that state back in one or two short sentences.',
    ...(callerPhone
      ? [
          '- The controller confirms the number the caller is phoning from; never read the',
          '  digits aloud and never promise a booking yourself.',
        ]
      : []),
    '',
    'CALLER NUMBER',
    callerPhone
      ? `- The Caller is phoning from ${callerPhone}. If the controller asks you to confirm it, say "the number you are calling from" — never read the digits aloud.`
      : "- The Caller's number is not shown. If the controller needs a mobile number, ask for the patient's mobile number.",
    '',
    'BOUNDARIES',
    '- Never invent clinic facts, times, prices, or phone numbers. If a fact is not in the',
    '  guide or the live context, say the clinic will confirm.',
    '- Clinic information + appointments only. For medical advice, diagnosis, prescriptions,',
    '  or price negotiation: "I cannot help with medical advice or prescriptions. Please',
    '  contact the clinic directly, or your emergency number right away if this is urgent."',
    '- For emergency symptoms, speak the emergency line from the CLINIC GUIDE verbatim first.',
    '- Replies are read aloud: 1-2 short sentences, plain words, no markdown, no lists,',
    '  no URLs, no spelling things out letter-by-letter.',
    '- Speak only what the Caller should hear. Never output instructions, rules, labels,',
    '  or notes; the whole reply is spoken verbatim.',
    '- Answer directly. Do not echo or paraphrase the caller unless you are confirming',
    '  booking details. Skip generic openings like "sure" or "okay" when they add nothing.',
    '- Use contractions and at most one natural follow-up question. Vary phrasing instead of',
    '  repeating the same acknowledgement on every Turn.',
    '',
    'CLINIC GUIDE',
    guide.raw,
  ].join('\n');
}

/** Late, per-Turn context: the stable system prefix above never changes. */
function lateContext(ctx: AssistantContext): string | null {
  const parts: string[] = [];
  if (ctx.slotShortlist && ctx.slotShortlist.length > 0) {
    // The controller picked these candidates for this Turn; offering anything
    // else breaks short-answer resolution on the Caller's next Turn.
    parts.push('LIVE SLOTS (offer only these):', ...ctx.slotShortlist.map((line) => `- ${line}`));
  } else if (ctx.availability) {
    parts.push(
      'LIVE AVAILABILITY (fetched moments ago — only these Slots exist; do not promise any other time):',
      ctx.availability,
    );
  }
  if (ctx.dialogueAct) parts.push(`DIALOGUE ACT: ${ctx.dialogueAct}`);
  if (parts.length === 0) return null;
  return parts.join('\n');
}

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface StreamDeltaToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface StreamChunk {
  provider?: string;
  model?: string;
  /** OpenRouter can report a mid-stream failure on an HTTP 200 response. */
  error?: { message?: unknown; code?: unknown };
  usage?: StreamUsage | null;
  choices?: {
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      reasoning_details?: unknown;
      tool_calls?: StreamDeltaToolCall[];
    };
    finish_reason?: string | null;
  }[];
}

/** Count reasoning text across OpenRouter's `reasoning`/`reasoning_details` shapes. */
function reasoningChars(delta: NonNullable<NonNullable<StreamChunk['choices']>[number]['delta']>): number {
  const direct = delta.reasoning ?? delta.reasoning_content;
  let total = typeof direct === 'string' ? direct.length : 0;
  if (Array.isArray(delta.reasoning_details)) {
    for (const detail of delta.reasoning_details as unknown[]) {
      if (typeof detail === 'string') total += detail.length;
      else if (detail && typeof detail === 'object' && typeof (detail as { text?: unknown }).text === 'string') {
        total += ((detail as { text: string }).text).length;
      }
    }
  }
  return total;
}

/** Per-round diagnostics filled by `postStream` for the `done` trace event. */
interface RoundTrace {
  status?: number;
  requestId?: string | null;
  provider?: string;
  servedModel?: string;
  chunks: number;
  sseLines: number;
  skippedLines: number;
  finish?: string | null;
  reasoningChars: number;
  usage?: StreamUsage | null;
  lastChunk?: string;
}

function usageFields(usage: StreamUsage | null | undefined): AssistantEvent['usage'] {
  if (!usage) return null;
  return { prompt: usage.prompt_tokens, completion: usage.completion_tokens, total: usage.total_tokens };
}

/**
 * Assistant over the OpenAI-compatible chat-completions dialect: OpenRouter
 * by default (with its routing preferences and reasoning envelope), or any
 * direct provider via `baseUrl` (Groq), which takes a flat `reasoning_effort`.
 */
export class OpenRouterAssistant implements Assistant {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly openRouterRouting: boolean;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly tokenLimitField: 'max_tokens' | 'max_completion_tokens';
  private readonly omitTemperature: boolean;
  /** Reasoning effort sent with every request; `none` is refused by reasoning-mandatory endpoints. */
  private readonly reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  private readonly fetchFn: typeof fetch;
  /** Total request attempts per round, first included; the bound on transient-error retries. */
  private readonly retryAttempts: number;
  private readonly sleepMs: (ms: number) => Promise<void>;
  /**
   * `legacy` keeps the tool-driven booking loop for the record-based voice
   * loop; `phase` is the live controller-owned mode where the model words
   * replies and only an explicitly re-enabled read may use a tool.
   */
  private readonly toolsMode: 'legacy' | 'phase';

  constructor(opts: {
    apiKey: string;
    /** Endpoint base; defaults to OpenRouter. */
    baseUrl?: string;
    /** Send OpenRouter routing fields (provider prefs, session id, reasoning envelope). */
    openRouterRouting?: boolean;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /**
     * Which token-cap field the provider accepts: `max_tokens` for
     * OpenRouter/Groq, `max_completion_tokens` for OpenAI's GPT-5 models.
     */
    tokenLimitField?: 'max_tokens' | 'max_completion_tokens';
    /** Omit `temperature` for models that only accept the provider default. */
    omitTemperature?: boolean;
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
    fetchFn?: typeof fetch;
    tools?: 'legacy' | 'phase';
    retryAttempts?: number;
    sleepMs?: (ms: number) => Promise<void>;
  }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.openRouterRouting = opts.openRouterRouting ?? true;
    this.model = opts.model ?? 'openai/gpt-5-nano';
    this.temperature = opts.temperature ?? 0.4;
    this.maxTokens = opts.maxTokens ?? 512;
    this.tokenLimitField = opts.tokenLimitField ?? 'max_tokens';
    this.omitTemperature = opts.omitTemperature ?? false;
    this.reasoningEffort = opts.reasoningEffort ?? 'minimal';
    this.fetchFn = opts.fetchFn ?? fetch;
    this.retryAttempts = Math.max(1, opts.retryAttempts ?? 3);
    this.sleepMs = opts.sleepMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.toolsMode = opts.tools ?? 'legacy';
  }

  private initialMessages(ctx: AssistantContext): ChatMessage[] {
    const history: ChatMessage[] = ctx.history.map((t: ChatTurn) => ({
      role: t.role === 'caller' ? 'user' : 'assistant',
      content: t.text,
    }));
    const latest = ctx.history.at(-1);
    const currentAlreadyInHistory = latest?.role === 'caller' && latest.text === ctx.transcript;
    // The prompt must end with the current Caller utterance: a trailing system
    // message lets the model answer the instructions instead of the Caller and
    // leak rule text into speech. Drop the duplicate history entry and always
    // append the utterance as the final user message.
    const prior = currentAlreadyInHistory ? history.slice(0, -1) : history;
    const late = lateContext(ctx);
    return [
      { role: 'system', content: systemPrompt(ctx.guide, ctx.callerPhone) },
      ...prior,
      ...(late ? [{ role: 'system', content: late }] : []),
      { role: 'user', content: ctx.transcript },
    ];
  }

  /**
   * Phase mode exposes no booking write to the model; availability reads are
   * controller-owned, so only an explicitly ambiguous Turn may keep the
   * read-only lookup. Legacy mode preserves the tool-driven loop.
   */
  private toolsFor(ctx: AssistantContext): readonly unknown[] {
    // A speculative reply runs before the final transcription is known: no
    // tool may read or write, so the model is offered nothing at all.
    if (ctx.speculative) return [];
    if (this.toolsMode === 'legacy') {
      return ctx.availability ? [PROPOSE_BOOKING_TOOL] : TOOLS;
    }
    if (ctx.availability || ctx.slotShortlist?.length) return [];
    return ctx.allowAvailabilityTool ? [GET_AVAILABILITY_TOOL] : [];
  }

  /** One tool call → its `tool` message, including speakable failures. */
  private async runTool(
    toolCall: { id: string; function?: { name?: string; arguments?: string } },
    ctx: AssistantContext,
  ): Promise<ChatMessage> {    const id = toolCall.id;
    const name = toolCall.function?.name;
    const argsText = toolCall.function?.arguments ?? '{}';
    // Defense in depth: even if a model emits a tool call the request never
    // offered, a speculative reply may not run it.
    if (ctx.speculative) {
      return {
        role: 'tool',
        tool_call_id: id,
        content: JSON.stringify({ ok: false, reason: 'speculative reply: tools are unavailable before the final transcript' }),
      };
    }
    try {
      if (name === 'get_availability') {
        const availability = await ctx.getAvailability();
        return { role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: true, availability }) };
      }
      if (name === 'propose_booking') {
        const slot = parseSlot(argsText, ctx.callerPhone);
        if (!slot) {
          return {
            role: 'tool',
            tool_call_id: id,
            content: JSON.stringify({ ok: false, reason: 'invalid booking details; ask for date, time, patient name, and phone again' }),
          };
        }
        const outcome: BookingOutcome = await ctx.proposeBooking(slot);
        return { role: 'tool', tool_call_id: id, content: JSON.stringify(outcome) };
      }
      return { role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: false, reason: 'unsupported tool' }) };
    } catch (err) {
      // Availability failures stay conversational; booking-write failures keep
      // the live error contract (they bubble to the session's failure path).
      if (name === 'get_availability') {
        return {
          role: 'tool',
          tool_call_id: id,
          content: JSON.stringify({
            ok: false,
            reason: 'availability lookup failed',
            say: "Sorry, I'm having trouble reaching the booking system. The clinic will confirm shortly.",
          }),
        };
      }
      throw err;
    }
  }

  private async runTools(message: ChatMessage, ctx: AssistantContext): Promise<ChatMessage[]> {
    return Promise.all((message.tool_calls ?? []).map((toolCall) => this.runTool(toolCall, ctx)));
  }

  /** Direct providers only take OpenAI's flat low/medium/high scale. */
  private directReasoningEffort(): 'low' | 'medium' | 'high' {
    return this.reasoningEffort === 'none' || this.reasoningEffort === 'minimal' ? 'low' : this.reasoningEffort;
  }

  private requestBase(ctx: AssistantContext): Record<string, unknown> {
    return {
      model: this.model,
      ...(this.omitTemperature ? {} : { temperature: this.temperature }),
      [this.tokenLimitField]: this.maxTokens,
      tools: this.toolsFor(ctx),
      tool_choice: 'auto',
      ...(this.openRouterRouting
        ? {
            reasoning: { effort: this.reasoningEffort },
            provider: PROVIDER_PREFERENCE,
            ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
          }
        : { reasoning_effort: this.directReasoningEffort() }),
    };
  }

  async reply(ctx: AssistantContext, signal?: AbortSignal): Promise<AssistantReply> {
    const base = this.requestBase(ctx);
    let messages = this.initialMessages(ctx);
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const roundNo = round + 1;
      const roundStarted = Date.now();
      ctx.onAssistantEvent?.({
        round: roundNo,
        event: 'round-start',
        messages: messages.length,
        tools: this.toolNames(ctx),
        model: this.model,
        availabilityChars: ctx.availability?.length ?? 0,
      });
      const completion = await this.complete(
        { ...base, messages },
        signal,
        (status, attempt, ms) => ctx.onAssistantEvent?.({ round: roundNo, event: 'http-retry', status, attempt, ms }),
      );
      const text = completion.message.content ?? '';
      const toolCalls = completion.message.tool_calls ?? [];
      ctx.onAssistantEvent?.({
        round: roundNo,
        event: 'done',
        ms: Date.now() - roundStarted,
        chars: text.length,
        toolCalls: toolCalls.length,
        finish: completion.finish,
        provider: completion.provider,
        usage: usageFields(completion.usage),
        detail: text.trim() === '' && toolCalls.length === 0 ? 'empty-completion' : undefined,
      });
      if (toolCalls.length === 0) {
        return { text, endCall: false };
      }
      const toolStarted = Date.now();
      const results = await this.runTools(completion.message, ctx);
      this.emitToolDone(ctx, roundNo, toolCalls, results, toolStarted);
      messages = [...messages, completion.message, ...results];
    }
    return { text: '', endCall: false };
  }

  private toolNames(ctx: AssistantContext): string[] {
    return this.toolsFor(ctx).map((tool) => (tool as { function: { name: string } }).function.name);
  }

  /** One `tool-done` event per tool call, carrying its outcome size and ok flag. */
  private emitToolDone(
    ctx: AssistantContext,
    round: number,
    toolCalls: { function?: { name?: string } }[],
    results: ChatMessage[],
    started: number,
  ): void {
    const ms = Date.now() - started;
    toolCalls.forEach((toolCall, index) => {
      const content = results[index]?.content ?? '';
      let ok: boolean | undefined;
      try {
        const parsed = JSON.parse(content) as { ok?: unknown };
        if (typeof parsed?.ok === 'boolean') ok = parsed.ok;
      } catch {
        ok = undefined;
      }
      ctx.onAssistantEvent?.({
        round,
        event: 'tool-done',
        name: toolCall.function?.name,
        ms,
        ok,
        resultChars: content.length,
      });
    });
  }

  /**
   * One chat request with bounded retry on transient provider statuses
   * (429/502/503): `onRetry` reports each wait before the attempt it buys.
   * An aborted signal ends the retrying immediately.
   */
  private async postWithRetry(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onRetry: (status: number, attempt: number, ms: number) => void,
  ): Promise<Response> {
    for (let attempt = 1; ; attempt += 1) {
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= this.retryAttempts || signal?.aborted) return res;
      const ms = HTTP_RETRY_BACKOFF_MS * attempt;
      onRetry(res.status, attempt, ms);
      await this.sleepMs(ms);
    }
  }

  private async complete(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    onRetry: (status: number, attempt: number, ms: number) => void = () => {},
  ): Promise<{
    message: ChatMessage;
    finish: string | null;
    usage: StreamUsage | null;
    provider?: string;
  }> {
    const res = await this.postWithRetry(body, signal, onRetry);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`openrouter-http-${res.status}${detail ? `: ${clip(detail)}` : ''}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: ChatMessage; finish_reason?: string | null }[];
      usage?: StreamUsage;
      provider?: string;
    };
    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error('openrouter-empty-choices');
    return {
      message: choice.message,
      finish: choice.finish_reason ?? null,
      usage: data.usage ?? null,
      provider: data.provider,
    };
  }

  /** SSE token stream for one chat request; same model and tools as `reply`. */
  private async *postStream(
    body: Record<string, unknown>,
    trace: RoundTrace,
    signal?: AbortSignal,
    onRetry: (status: number, attempt: number, ms: number) => void = () => {},
  ): AsyncGenerator<StreamChunk> {
    const res = await this.postWithRetry(body, signal, onRetry);
    trace.status = res.status;
    trace.requestId = res.headers.get('x-request-id') ?? res.headers.get('x-or-request-id') ?? null;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`openrouter-http-${res.status}${detail ? `: ${clip(detail)}` : ''}`);
    }
    if (!res.body) throw new Error('openrouter-empty-stream');
    const decoder = new TextDecoder();
    let buffered = '';
    const chunks: StreamChunk[] = [];
    const emitLines = (text: string): void => {
      buffered += text;
      let idx: number;
      while ((idx = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, idx).trim();
        buffered = buffered.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        trace.sseLines += 1;
        const payload = line.slice('data:'.length).trim();
        if (!payload || payload === '[DONE]') continue;
        trace.lastChunk = clip(payload, 400);
        try {
          chunks.push(JSON.parse(payload) as StreamChunk);
          trace.chunks += 1;
        } catch {
          // Keep-alive or partial line; count it so format drift is visible.
          trace.skippedLines += 1;
        }
      }
    };
    for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
      emitLines(decoder.decode(piece, { stream: true }));
      while (chunks.length > 0) yield chunks.shift()!;
    }
    emitLines(decoder.decode());
    while (chunks.length > 0) yield chunks.shift()!;
  }

  /** Stream metadata attached to every per-round outcome event. */
  private traceFields(trace: RoundTrace): Partial<AssistantEvent> {
    return {
      status: trace.status,
      requestId: trace.requestId ?? null,
      provider: trace.provider,
      servedModel: trace.servedModel,
      chunks: trace.chunks,
      sseLines: trace.sseLines,
      skippedLines: trace.skippedLines,
      finish: trace.finish ?? null,
      reasoningChars: trace.reasoningChars,
      usage: usageFields(trace.usage),
    };
  }

  /**
   * Streaming twin of `reply`: same model, same tools, same rule — speakable
   * text is yielded as it arrives, and tool rounds (availability reads,
   * booking writes) continue the conversation until the model answers.
   */
  async *replyStream(ctx: AssistantContext, signal?: AbortSignal): AsyncGenerator<string> {
    const base = this.requestBase(ctx);
    let messages = this.initialMessages(ctx);
    let emptyRetries = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const roundNo = round + 1;
      const roundStarted = Date.now();
      const trace: RoundTrace = { chunks: 0, sseLines: 0, skippedLines: 0, reasoningChars: 0 };
      ctx.onAssistantEvent?.({
        round: roundNo,
        event: 'round-start',
        messages: messages.length,
        tools: this.toolNames(ctx),
        model: this.model,
        availabilityChars: ctx.availability?.length ?? 0,
      });
      const content: string[] = [];
      let firstToken = false;
      const toolIds = new Map<number, string>();
      const toolNames = new Map<number, string>();
      const toolArgs = new Map<number, string>();
      try {
        for await (const chunk of this.postStream(
          { ...base, messages, stream: true },
          trace,
          signal,
          (status, attempt, ms) => ctx.onAssistantEvent?.({ round: roundNo, event: 'http-retry', status, attempt, ms }),
        )) {
          if (chunk.error) {
            throw new Error(`openrouter-stream-error: ${clip(JSON.stringify(chunk.error))}`);
          }
          if (chunk.provider) trace.provider = chunk.provider;
          if (chunk.model) trace.servedModel = chunk.model;
          if (chunk.usage) trace.usage = chunk.usage;
          const choice = chunk.choices?.[0];
          if (choice?.finish_reason) trace.finish = choice.finish_reason;
          const delta = choice?.delta;
          if (!delta) continue;
          if (typeof delta.content === 'string' && delta.content) {
            if (!firstToken) {
              firstToken = true;
              ctx.onAssistantEvent?.({ round: roundNo, event: 'first-token', ms: Date.now() - roundStarted });
            }
            content.push(delta.content);
            yield delta.content;
          }
          trace.reasoningChars += reasoningChars(delta);
          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0;
            if (tc.id) toolIds.set(index, tc.id);
            if (tc.function?.name) toolNames.set(index, tc.function.name);
            if (typeof tc.function?.arguments === 'string') {
              toolArgs.set(index, (toolArgs.get(index) ?? '') + tc.function.arguments);
            }
          }
        }
      } catch (err) {
        // A failed round is itself a trace: status, request id, and how far
        // the stream got before it died are the first things to look at.
        ctx.onAssistantEvent?.({
          round: roundNo,
          event: 'done',
          ms: Date.now() - roundStarted,
          chars: content.join('').length,
          toolCalls: 0,
          detail: err instanceof Error ? err.message : String(err),
          ...this.traceFields(trace),
        });
        throw err;
      }
      const produced = content.join('');
      ctx.onAssistantEvent?.({
        round: roundNo,
        event: 'done',
        ms: Date.now() - roundStarted,
        chars: produced.length,
        toolCalls: toolNames.size,
        ...this.traceFields(trace),
      });
      if (toolNames.size === 0) {
        // Silence here would leave the Caller hearing nothing: retry the same
        // request once before giving up, then let the session reprompt.
        if (produced.trim() === '' && emptyRetries < MAX_EMPTY_RETRIES) {
          emptyRetries += 1;
          ctx.onAssistantEvent?.({
            round: roundNo,
            event: 'empty-retry',
            detail: 'empty-completion',
            lastChunk: trace.lastChunk,
            ...this.traceFields(trace),
          });
          continue;
        }
        return;
      }
      const toolCalls = [...toolNames.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, name]) => ({
          id: toolIds.get(index) ?? `call_${index}`,
          type: 'function',
          function: { name, arguments: toolArgs.get(index) ?? '' },
        }));
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: content.join('') || null,
        tool_calls: toolCalls,
      };
      const toolStarted = Date.now();
      const results = await Promise.all(toolCalls.map((toolCall) => this.runTool(toolCall, ctx)));
      this.emitToolDone(ctx, roundNo, toolCalls, results, toolStarted);
      messages = [...messages, assistantMessage, ...results];
    }
  }
}
