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
}
