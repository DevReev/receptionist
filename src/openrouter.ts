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

const PROPOSE_BOOKING_TOOL = {
  type: 'function',
  function: {
    name: 'propose_booking',
    description:
      'Propose a booking once service, date, time, caller name, and caller phone are all collected and the slot is in the availability block.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['service', 'date', 'time', 'callerName', 'callerPhone'],
      properties: {
        service: { type: 'string' },
        date: { type: 'string' },
        time: { type: 'string' },
        callerName: { type: 'string' },
        callerPhone: { type: 'string' },
      },
    },
  },
} as const;

const SLOT_FIELDS = ['service', 'date', 'time', 'callerName', 'callerPhone'] as const;

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
    date: record.date as string,
    time: record.time as string,
    callerName: record.callerName as string,
    callerPhone: record.callerPhone as string,
  };
}

function systemPrompt(guide: ClinicGuide): string {
  return [
    `You are the phone receptionist for ${guide.name}.`,
    'Scope: clinic information + appointment booking ONLY.',
    '',
    'RULES',
    '- Answer ONLY from the CLINIC GUIDE below for hours, address, contact,',
    '  services+fees, doctors, booking rules, emergency line, FAQs.',
    '- Answer ONLY from the AVAILABILITY block below for open slots.',
    '- Never invent, guess, or paraphrase into new facts. If the answer is not',
    '  in the guide or the availability block, say you do not know and that the',
    '  clinic will confirm.',
    '- Keep every reply short: 1-2 spoken sentences, plain words, no markdown,',
    '  no lists, no URLs, no spelling things out letter-by-letter. It will be',
    '  read aloud by text-to-speech.',
    '- One question at a time when collecting booking details',
    '  (service, then date, then time, then name, then phone).',
    '- Before closing, ask if the caller needs anything else.',
    '- For emergency symptoms, speak the emergency line from the CLINIC GUIDE verbatim first.',
    '',
    'CLINIC GUIDE',
    guide.raw,
    '',
    'REFUSALS (use these lines exactly)',
    '- Medical advice, diagnosis, prescription, or price negotiation:',
    '  "I cannot help with medical advice or prescriptions. Please contact the clinic directly, or your emergency number right away if this is urgent."',
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
    this.temperature = opts.temperature ?? 0.2;
    this.maxTokens = opts.maxTokens ?? 250;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private requestBody(ctx: AssistantContext): Record<string, unknown> {
    const history: ChatMessage[] = ctx.history.map((t: ChatTurn) => ({
      role: t.role === 'caller' ? 'user' : 'assistant',
      content: t.text,
    }));
    return {
      model: this.model,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt(ctx.guide) },
        { role: 'system', content: ctx.availability },
        ...history,
        { role: 'user', content: ctx.transcript },
      ],
      tools: [PROPOSE_BOOKING_TOOL],
      tool_choice: 'auto',
    };
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

  async reply(ctx: AssistantContext): Promise<AssistantReply> {
    const body = this.requestBody(ctx);
    const message = await this.complete(body);
    const toolCall = message.tool_calls?.[0];
    if (!toolCall || toolCall.function?.name !== 'propose_booking') {
      return { text: message.content ?? '', endCall: false };
    }
    const slot = parseSlot(toolCall.function.arguments);
    const outcome: BookingOutcome = slot
      ? await ctx.proposeBooking(slot)
      : { ok: false, reason: 'invalid booking details; ask for service, date, time, name, and phone again' };
    const followUp = await this.complete({
      ...body,
      messages: [
        ...(body.messages as ChatMessage[]),
        message,
        { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(outcome) },
      ],
    });
    return { text: followUp.content ?? '', endCall: false };
  }

  /**
   * Streaming twin of `reply`: same model, same single `propose_booking`
   * tool, same single-attempt rule — but speakable text is yielded as it
   * arrives so the live session can cut sentences into speech early.
   */
  async *replyStream(ctx: AssistantContext): AsyncGenerator<string> {
    const body = this.requestBody(ctx);
    const toolIds = new Map<number, string>();
    const toolNames = new Map<number, string>();
    const toolArgs = new Map<number, string>();
    for await (const chunk of this.postStream(body)) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) yield delta.content;
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        if (tc.id) toolIds.set(index, tc.id);
        if (tc.function?.name) toolNames.set(index, tc.function.name);
        if (typeof tc.function?.arguments === 'string') {
          toolArgs.set(index, (toolArgs.get(index) ?? '') + tc.function.arguments);
        }
      }
    }
    const name = toolNames.get(0);
    if (name !== 'propose_booking') return;
    const id = toolIds.get(0) ?? 'call_0';
    const argsText = toolArgs.get(0) ?? '';
    const slot = parseSlot(argsText);
    const outcome: BookingOutcome = slot
      ? await ctx.proposeBooking(slot)
      : { ok: false, reason: 'invalid booking details; ask for service, date, time, name, and phone again' };
    const followUp = {
      ...body,
      messages: [
        ...(body.messages as ChatMessage[]),
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name: 'propose_booking', arguments: argsText } }],
        },
        { role: 'tool', tool_call_id: id, content: JSON.stringify(outcome) },
      ],
    };
    for await (const chunk of this.postStream(followUp)) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content) yield content;
    }
  }
}
