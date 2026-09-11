import type {
  Assistant,
  AssistantContext,
  AssistantReply,
  BookingOutcome,
  ChatTurn,
  ClinicGuide,
  ProposedSlot,
} from './app.ts';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_TOOL_ROUNDS = 5;

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
      'Propose a booking once service, location, date, time, caller name, and caller phone are all collected, the caller has confirmed, and the slot came from get_availability.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['service', 'location', 'date', 'time', 'callerName', 'callerPhone'],
      properties: {
        service: { type: 'string' },
        location: { type: 'string', description: 'One of the locations named in the availability block.' },
        date: { type: 'string', description: 'YYYY-MM-DD exactly as listed in the availability block.' },
        time: { type: 'string', description: 'HH:MM exactly as listed in the availability block.' },
        callerName: { type: 'string' },
        callerPhone: { type: 'string' },
      },
    },
  },
} as const;

const TOOLS = [GET_AVAILABILITY_TOOL, PROPOSE_BOOKING_TOOL];

const SLOT_FIELDS = ['service', 'location', 'date', 'time', 'callerName', 'callerPhone'] as const;

function parseSlot(argsText: string): ProposedSlot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  for (const field of SLOT_FIELDS) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim() === '') return null;
  }
  return {
    service: record.service as string,
    location: record.location as string,
    date: record.date as string,
    time: record.time as string,
    callerName: record.callerName as string,
    callerPhone: record.callerPhone as string,
  };
}

function systemPrompt(guide: ClinicGuide): string {
  return [
    `You are the phone receptionist for ${guide.name} — warm, natural, and brief.`,
    'The CLINIC GUIDE below is your source of truth; its CONVERSATION STYLE and BOOKING',
    'RULES sections tell you how to behave. Follow them, but speak in your own words —',
    'never recite the guide like a script.',
    '',
    'WHAT YOU DO',
    '- Chat naturally. Greetings and small talk need no lookup: just respond like a person.',
    '- Answer clinic questions from the CLINIC GUIDE.',
    '- Help callers book. When they ask about open times or want an appointment, call',
    '  get_availability to read live Slots. Never offer or confirm a date or time without it.',
    '  Collect details conversationally, then call propose_booking once the caller confirms.',
    '- If a tool result includes a "say" field, speak that sentence verbatim.',
    '- If get_availability fails, apologize briefly and say the booking system cannot be',
    '  reached right now, so the clinic will confirm.',
    '',
    'BOUNDARIES',
    '- Never invent clinic facts, times, prices, or phone numbers. If a fact is not in the',
    '  guide or live availability, say the clinic will confirm.',
    '- Clinic information + appointments only. For medical advice, diagnosis, prescriptions,',
    '  or price negotiation: "I cannot help with medical advice or prescriptions. Please',
    '  contact the clinic directly, or your emergency number right away if this is urgent."',
    '- For emergency symptoms, speak the emergency line from the CLINIC GUIDE verbatim first.',
    '- Replies are read aloud: 1-2 short sentences, plain words, no markdown, no lists,',
    '  no URLs, no spelling things out letter-by-letter.',
    '',
    'CLINIC GUIDE',
    guide.raw,
  ].join('\n');
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

interface StreamChunk {
  choices?: { delta?: { content?: string | null; tool_calls?: StreamDeltaToolCall[] } }[];
}

export class OpenRouterAssistant implements Assistant {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    apiKey: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    fetchFn?: typeof fetch;
  }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'deepseek/deepseek-v4-flash-0731';
    this.temperature = opts.temperature ?? 0.4;
    this.maxTokens = opts.maxTokens ?? 1000;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private initialMessages(ctx: AssistantContext): ChatMessage[] {
    const history: ChatMessage[] = ctx.history.map((t: ChatTurn) => ({
      role: t.role === 'caller' ? 'user' : 'assistant',
      content: t.text,
    }));
    return [
      { role: 'system', content: systemPrompt(ctx.guide) },
      ...history,
      { role: 'user', content: ctx.transcript },
    ];
  }

  /** One tool call → its `tool` message, including speakable failures. */
  private async runTool(
    toolCall: { id: string; function?: { name?: string; arguments?: string } },
    ctx: AssistantContext,
  ): Promise<ChatMessage> {
    const id = toolCall.id;
    const name = toolCall.function?.name;
    const argsText = toolCall.function?.arguments ?? '{}';
    try {
      if (name === 'get_availability') {
        const availability = await ctx.getAvailability();
        return { role: 'tool', tool_call_id: id, content: JSON.stringify({ ok: true, availability }) };
      }
      if (name === 'propose_booking') {
        const slot = parseSlot(argsText);
        if (!slot) {
          return {
            role: 'tool',
            tool_call_id: id,
            content: JSON.stringify({ ok: false, reason: 'invalid booking details; ask for service, date, time, name, and phone again' }),
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

  async reply(ctx: AssistantContext): Promise<AssistantReply> {
    const base = {
      model: this.model,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      tools: TOOLS,
      tool_choice: 'auto',
    };
    let messages = this.initialMessages(ctx);
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const message = await this.complete({ ...base, messages });
      if (!message.tool_calls || message.tool_calls.length === 0) {
        return { text: message.content ?? '', endCall: false };
      }
      messages = [...messages, message, ...(await this.runTools(message, ctx))];
    }
    return { text: '', endCall: false };
  }

  private async complete(body: Record<string, unknown>): Promise<ChatMessage> {
    const res = await this.fetchFn(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`openrouter-http-${res.status}`);
    const data = (await res.json()) as { choices?: { message?: ChatMessage }[] };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('openrouter-empty-choices');
    return message;
  }

  /** SSE token stream for one chat request; same model and tools as `reply`. */
  private async *postStream(body: Record<string, unknown>): AsyncGenerator<StreamChunk> {
    const res = await this.fetchFn(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok) throw new Error(`openrouter-http-${res.status}`);
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
        const payload = line.slice('data:'.length).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          chunks.push(JSON.parse(payload) as StreamChunk);
        } catch {
          // Skip keep-alive or partial lines; the next chunk completes them.
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

  /**
   * Streaming twin of `reply`: same model, same tools, same rule — speakable
   * text is yielded as it arrives, and tool rounds (availability reads,
   * booking writes) continue the conversation until the model answers.
   */
  async *replyStream(ctx: AssistantContext): AsyncGenerator<string> {
    const base = {
      model: this.model,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      tools: TOOLS,
      tool_choice: 'auto',
    };
    let messages = this.initialMessages(ctx);
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const content: string[] = [];
      const toolIds = new Map<number, string>();
      const toolNames = new Map<number, string>();
      const toolArgs = new Map<number, string>();
      for await (const chunk of this.postStream({ ...base, messages })) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          content.push(delta.content);
          yield delta.content;
        }
        for (const tc of delta.tool_calls ?? []) {
          const index = tc.index ?? 0;
          if (tc.id) toolIds.set(index, tc.id);
          if (tc.function?.name) toolNames.set(index, tc.function.name);
          if (typeof tc.function?.arguments === 'string') {
            toolArgs.set(index, (toolArgs.get(index) ?? '') + tc.function.arguments);
          }
        }
      }
      if (toolNames.size === 0) return;
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
      messages = [
        ...messages,
        assistantMessage,
        ...(await Promise.all(toolCalls.map((toolCall) => this.runTool(toolCall, ctx)))),
      ];
    }
  }
}
