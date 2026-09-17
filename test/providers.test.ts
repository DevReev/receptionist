import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WhisperTranscriber } from '../src/whisper.ts';
import { OpenRouterAssistant } from '../src/openrouter.ts';
import { TwilioRecordingFetcher } from '../src/recordings.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { AssistantContext, AssistantEvent, BookingOutcome, ProposedSlot } from '../src/app.ts';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };

function assistantCtx(overrides: Partial<AssistantContext> = {}): AssistantContext {
  return {
    transcript: 'what are your hours',
    history: [],
    guide: GUIDE,
    getAvailability: async () => 'AVAILABILITY: no slots known.',
    proposeBooking: async () => ({ ok: false, reason: 'booking-not-wired' }),
    ...overrides,
  };
}

describe('WhisperTranscriber', () => {
  it('returns the transcript text', async () => {
    const t = new WhisperTranscriber({
      stt: { apiKey: 'k', baseUrl: 'http://stub-whisper/v1', model: 'stub-model' },
      fetchFn: (async () =>
        jsonResponse({ text: 'hello clinic', segments: [{ no_speech_prob: 0.05 }] })) as typeof fetch,
    });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/mpeg');
    assert.equal(out.text, 'hello clinic');
    assert.equal(out.noSpeech, false);
  });

  it('flags hallucination-prone audio as no-speech', async () => {
    const t = new WhisperTranscriber({
      stt: { apiKey: 'k', baseUrl: 'http://stub-whisper/v1', model: 'stub-model' },
      fetchFn: (async () =>
        jsonResponse({ text: 'background music', segments: [{ no_speech_prob: 0.95, avg_logprob: -1.5 }] })) as typeof fetch,
    });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/mpeg');
    assert.equal(out.noSpeech, true);
  });

  it('accepts quiet but confidently decoded speech', async () => {
    const t = new WhisperTranscriber({
      stt: { apiKey: 'k', baseUrl: 'http://stub-whisper/v1', model: 'stub-model' },
      fetchFn: (async () =>
        jsonResponse({ text: 'Thank you.', segments: [{ no_speech_prob: 0.85, avg_logprob: -0.2 }] })) as typeof fetch,
    });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/mpeg');
    assert.equal(out.noSpeech, false);
  });

  it('rejects repetitive decodes even when confident', async () => {
    const t = new WhisperTranscriber({
      stt: { apiKey: 'k', baseUrl: 'http://stub-whisper/v1', model: 'stub-model' },
      fetchFn: (async () =>
        jsonResponse({
          text: 'Cormorant is a phone call. Cormorant is a phone call.',
          segments: [{ no_speech_prob: 0.1, avg_logprob: -0.2, compression_ratio: 3.1 }],
        })) as typeof fetch,
    });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/mpeg');
    assert.equal(out.noSpeech, true);
  });

  it('throws on provider errors', async () => {
    const t = new WhisperTranscriber({
      stt: { apiKey: 'k', baseUrl: 'http://stub-whisper/v1', model: 'stub-model' },
      fetchFn: (async () => jsonResponse({ error: 'boom' }, 500)) as typeof fetch,
    });
    await assert.rejects(() => t.transcribe(Buffer.from('audio'), 'audio/mpeg'));
  });

  it('traces REST transcription timing and outcome', async () => {
    const events: TraceEvent[] = [];
    const t = new WhisperTranscriber({
      stt: { apiKey: 'k', baseUrl: 'http://stub-whisper/v1', model: 'stub-model' },
      fetchFn: (async () =>
        jsonResponse({ text: 'hello clinic', segments: [{ no_speech_prob: 0.05 }] })) as typeof fetch,
      onTrace: (e) => events.push(e),
    });
    await t.transcribe(Buffer.from('audio'), 'audio/wav');
    assert.deepEqual(
      events.map((e) => `${e.component}:${e.event}`),
      ['stt:rest-start', 'stt:rest-done'],
    );
    assert.equal(events[1]!['chars'], 'hello clinic'.length);
    assert.equal(events[1]!['noSpeech'], false);
  });
});

function chatMessage(message: unknown): typeof fetch {
  return (async () => jsonResponse({ choices: [{ message }] })) as typeof fetch;
}

describe('OpenRouterAssistant', () => {
  it('returns the model reply text', async () => {
    const a = new OpenRouterAssistant({
      apiKey: 'k',
      fetchFn: chatMessage({ role: 'assistant', content: 'We open at nine.' }),
    });
    const out = await a.reply(assistantCtx());
    assert.equal(out.text, 'We open at nine.');
    assert.equal(out.endCall, false);
  });

  it('runs a valid booking tool call through proposeBooking and speaks the outcome', async () => {
    const slot = {
      service: 'Sample Service',
      location: 'Bobby Clinic',
      date: '2026-09-30',
      time: '09:30',
      callerName: 'Asha',
      callerPhone: '+911234567890',
    };
    const calls: { url: string; body: string }[] = [];
    let n = 0;
    const fetchFn = (async (url: string, init: { body: string }) => {
      n += 1;
      calls.push({ url: String(url), body: String(init.body) });
      if (n === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 'propose_booking', arguments: JSON.stringify(slot) } },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Booked for Wednesday.' } }] });
    }) as unknown as typeof fetch;

    let proposed: ProposedSlot | null = null;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const out = await a.reply(
      assistantCtx({
        proposeBooking: async (s) => {
          proposed = s;
          const outcome: BookingOutcome = { ok: true };
          return outcome;
        },
      }),
    );
    assert.deepEqual(proposed, slot);
    assert.equal(n, 2);
    assert.equal(out.text, 'Booked for Wednesday.');
    const followUp = JSON.parse(calls[1].body) as {
      messages: { role: string; content?: string }[];
    };
    const toolMsg = followUp.messages.find((m) => m.role === 'tool');
    assert.deepEqual(JSON.parse(toolMsg?.content ?? ''), { ok: true });
  });

  it('does not propose when the tool arguments are malformed', async () => {
    let proposed = false;
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      if (n === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 'propose_booking', arguments: 'not-json{' } },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Let me take that again.' } }] });
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const out = await a.reply(assistantCtx({ proposeBooking: async () => ((proposed = true), { ok: true }) }));
    assert.equal(proposed, false);
    assert.equal(out.text, 'Let me take that again.');
  });

  it('defaults location and service when the model omits them', async () => {
    const proposed: ProposedSlot[] = [];
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      if (n === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'propose_booking',
                      arguments: JSON.stringify({
                        date: '2026-09-30',
                        time: '09:30',
                        callerName: 'Asha',
                        callerPhone: '+911234567890',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Booked.' } }] });
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    await a.reply(
      assistantCtx({
        proposeBooking: async (slot) => {
          proposed.push(slot);
          return { ok: true };
        },
      }),
    );
    assert.equal(proposed[0]!.service, 'Appointment');
    assert.equal(proposed[0]!.location, 'Bobby Clinic');
  });

  it('does not propose when a required field is missing', async () => {
    let proposed = false;
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      if (n === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'propose_booking', arguments: JSON.stringify({ service: 'x' }) },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Which date works?' } }] });
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    await a.reply(assistantCtx({ proposeBooking: async () => ((proposed = true), { ok: true }) }));
    assert.equal(proposed, false);
  });

  it('falls back to the caller number when the model omits callerPhone', async () => {
    const proposed: ProposedSlot[] = [];
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      if (n === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'propose_booking',
                      arguments: JSON.stringify({ date: '2026-09-30', time: '09:30', callerName: 'Asha' }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Booked.' } }] });
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    await a.reply(
      assistantCtx({
        callerPhone: '+919840950950',
        proposeBooking: async (slot) => {
          proposed.push(slot);
          return { ok: true };
        },
      }),
    );
    assert.equal(proposed[0]!.callerPhone, '+919840950950');
  });

  it('does not propose when no phone number is known', async () => {
    let proposed = false;
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      if (n === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'propose_booking',
                      arguments: JSON.stringify({ date: '2026-09-30', time: '09:30', callerName: 'Asha' }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'What number should I use?' } }] });
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    await a.reply(assistantCtx({ proposeBooking: async () => ((proposed = true), { ok: true }) }));
    assert.equal(proposed, false);
  });

  it('tells the model the caller number and to confirm it before booking', async () => {
    const bodies: { messages: { role: string; content?: string | null }[] }[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(String(init.body)) as { messages: { role: string; content?: string | null }[] });
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Sure.' } }] });
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    await a.reply(assistantCtx({ callerPhone: '+919840950950' }));
    const system = bodies[0]!.messages.find((m) => m.role === 'system');
    assert.match(system?.content ?? '', /\+919840950950/);
    assert.match(system?.content ?? '', /confirm|ask if/i);
    assert.match(system?.content ?? '', /never read the digits aloud/i);
  });

  it('throws on provider errors', async () => {
    const a = new OpenRouterAssistant({
      apiKey: 'k',
      fetchFn: (async () => jsonResponse({ error: 'boom' }, 500)) as typeof fetch,
    });
    await assert.rejects(() => a.reply(assistantCtx()));
  });

  it('never reads availability unless the model asks for it', async () => {
    let reads = 0;
    const a = new OpenRouterAssistant({
      apiKey: 'k',
      fetchFn: chatMessage({ role: 'assistant', content: 'Hi there! How can I help?' }),
    });
    const out = await a.reply(
      assistantCtx({
        transcript: 'hello',
        getAvailability: async () => {
          reads += 1;
          return 'AVAILABILITY: secrets';
        },
      }),
    );
    assert.equal(out.text, 'Hi there! How can I help?');
    assert.equal(reads, 0);
  });

  it('runs a get_availability tool call and answers with the live block', async () => {
    const bodies: { messages: { role: string; content?: string | null }[] }[] = [];
    let n = 0;
    const fetchFn = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(String(init.body)) as { messages: { role: string; content?: string | null }[] });
      n += 1;
      if (n === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_availability', arguments: '{}' } }],
              },
            },
          ],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Tuesday at nine is free.' } }] });
    }) as unknown as typeof fetch;

    let reads = 0;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const out = await a.reply(
      assistantCtx({
        transcript: 'any time on Tuesday?',
        getAvailability: async () => {
          reads += 1;
          return 'AVAILABILITY: Tue 09:00';
        },
      }),
    );
    assert.equal(reads, 1);
    assert.equal(out.text, 'Tuesday at nine is free.');
    const toolMsg = bodies[1]!.messages.find((m) => m.role === 'tool');
    assert.deepEqual(JSON.parse(toolMsg?.content ?? ''), { ok: true, availability: 'AVAILABILITY: Tue 09:00' });
  });

  it('turns a failed availability read into a speakable tool result', async () => {
    let n = 0;
    const bodies: { messages: { role: string; content?: string | null }[] }[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(String(init.body)) as { messages: { role: string; content?: string | null }[] });
      n += 1;
      if (n === 1) {
        return jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_availability', arguments: '{}' } }],
              },
            },
          ],
        });
      }
      return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Sorry, the clinic will confirm.' } }] });
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const out = await a.reply(
      assistantCtx({
        getAvailability: async () => {
          throw new Error('availability-timeout after 10000ms');
        },
      }),
    );
    assert.equal(out.text, 'Sorry, the clinic will confirm.');
    const toolMsg = bodies[1]!.messages.find((m) => m.role === 'tool');
    const result = JSON.parse(toolMsg?.content ?? '') as { ok: boolean; say?: string };
    assert.equal(result.ok, false);
    assert.match(result.say ?? '', /booking system/);
  });
});

function sseResponse(events: unknown[], headers: Record<string, string> = {}): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });
}

async function collectTokens(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const token of stream) out += token;
  return out;
}

describe('OpenRouterAssistant streaming (ticket 11)', () => {
  it('sends the current caller utterance once and bounds voice generation', async () => {
    let body: {
      messages: { role: string; content?: string | null }[];
      max_tokens?: number;
      reasoning?: { effort?: string };
      parallel_tool_calls?: boolean;
    } | null = null;
    const fetchFn = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(String(init.body)) as typeof body;
      return sseResponse([{ choices: [{ delta: { content: 'We open at nine.' } }] }]);
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    await collectTokens(
      a.replyStream!(
        assistantCtx({
          history: [
            { role: 'caller', text: 'hello' },
            { role: 'receptionist', text: 'How can I help?' },
            { role: 'caller', text: 'what are your hours' },
          ],
        }),
      ),
    );
    const callerMessages = body!.messages.filter(
      (message) => message.role === 'user' && message.content === 'what are your hours',
    );
    assert.equal(callerMessages.length, 1);
    assert.equal(body!.max_tokens, 200);
    assert.deepEqual(body!.reasoning, { effort: 'none' });
    assert.equal(body!.parallel_tool_calls, false);
  });

  it('ends the prompt with the current caller utterance, never a system message', async () => {
    let body: { messages: { role: string; content?: string | null }[] } | null = null;
    const fetchFn = (async (_url: string, init: { body: string }) => {
      body = JSON.parse(String(init.body)) as typeof body;
      return sseResponse([{ choices: [{ delta: { content: 'We open at nine.' } }] }]);
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    await collectTokens(
      a.replyStream!(
        assistantCtx({
          transcript: 'what are your hours',
          availability: 'AVAILABILITY: Wed 09:00',
          history: [
            { role: 'caller', text: 'hello' },
            { role: 'receptionist', text: 'How can I help?' },
            { role: 'caller', text: 'what are your hours' },
          ],
        }),
      ),
    );
    const last = body!.messages.at(-1)!;
    assert.equal(last.role, 'user', 'a trailing system message makes the model answer the instructions');
    assert.equal(last.content, 'what are your hours');
    assert.equal(
      body!.messages.filter((message) => message.role === 'user' && message.content === 'what are your hours').length,
      1,
    );
  });

  it('streams content tokens with the configured model unchanged', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      return sseResponse([
        { choices: [{ delta: { content: 'We are open ' } }] },
        { choices: [{ delta: { content: 'Monday to Friday.' } }] },
      ]);
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const text = await collectTokens(a.replyStream!(assistantCtx()));
    assert.equal(text, 'We are open Monday to Friday.');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!['model'], 'deepseek/deepseek-v4-flash-0731');
    assert.equal(bodies[0]!['stream'], true);
  });

  it('proposes a booking once then streams the follow-up', async () => {
    const slot = {
      service: 'Sample Service',
      location: 'Bobby Clinic',
      date: '2026-09-30',
      time: '09:30',
      callerName: 'Asha',
      callerPhone: '+911234567890',
    };
    let n = 0;
    let proposed = 0;
    const fetchFn = (async (_url: string, init: { body: string }) => {
      n += 1;
      if (n === 1) {
        return sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'propose_booking', arguments: JSON.stringify(slot) },
                    },
                  ],
                },
              },
            ],
          },
        ]);
      }
      const body = JSON.parse(String(init.body)) as { messages: { role: string }[] };
      assert.ok(body.messages.some((m) => m.role === 'tool'));
      return sseResponse([{ choices: [{ delta: { content: 'Booked for Wednesday.' } }] }]);
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const text = await collectTokens(
      a.replyStream!(
        assistantCtx({
          proposeBooking: async (s) => {
            proposed += 1;
            assert.deepEqual(s, slot);
            return { ok: true };
          },
        }),
      ),
    );
    assert.equal(text, 'Booked for Wednesday.');
    assert.equal(n, 2);
    assert.equal(proposed, 1);
  });

  it('prefers the lowest-latency provider that supports tools', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return sseResponse([{ choices: [{ delta: { content: 'Hi.' } }] }]);
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    await collectTokens(a.replyStream!(assistantCtx()));
    assert.deepEqual(bodies[0]!['provider'], {
      sort: 'latency',
      require_parameters: true,
      preferred_max_latency: { p90: 2.0 },
    });
  });

  it('answers from warm availability without a lookup tool round', async () => {
    const bodies: {
      messages: { role: string; content?: string | null }[];
      tools?: { function: { name: string } }[];
    }[] = [];
    const events: AssistantEvent[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(String(init.body)) as (typeof bodies)[number]);
      return sseResponse([{ choices: [{ delta: { content: 'Wednesday at ten is free.' } }] }]);
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const text = await collectTokens(
      a.replyStream!(
        assistantCtx({
          availability: 'AVAILABILITY: Wed 09:00 with Bob Gowda',
          onAssistantEvent: (e) => events.push(e),
        }),
      ),
    );
    assert.equal(text, 'Wednesday at ten is free.');
    assert.equal(bodies.length, 1, 'the warm block removes the lookup round');
    assert.deepEqual((bodies[0]!.tools ?? []).map((t) => t.function.name), ['propose_booking']);
    const dynamic = bodies[0]!.messages.filter((m) => m.role === 'system').map((m) => m.content ?? '');
    assert.ok(dynamic.some((content) => /Wed 09:00 with Bob Gowda/.test(content)));
    assert.ok(dynamic.some((content) => /LIVE AVAILABILITY/.test(content)));
    assert.equal(
      bodies[0]!.messages[0]!.content?.includes('Wed 09:00 with Bob Gowda'),
      false,
      'dynamic availability stays out of the byte-stable prefix',
    );
    assert.deepEqual(
      events.map((e) => e.event),
      ['round-start', 'first-token', 'done'],
    );
  });

  it('streams a get_availability tool round before answering', async () => {
    let n = 0;
    let reads = 0;
    const events: AssistantEvent[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      n += 1;
      if (n === 1) {
        return sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: 'get_availability', arguments: '{}' } },
                  ],
                },
              },
            ],
          },
        ]);
      }
      const body = JSON.parse(String(init.body)) as { messages: { role: string; content?: string | null }[] };
      const toolMsg = body.messages.find((m) => m.role === 'tool');
      assert.match(toolMsg?.content ?? '', /Tue 09:00/);
      return sseResponse([{ choices: [{ delta: { content: 'Tuesday at nine is free.' } }] }]);
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const text = await collectTokens(
      a.replyStream!(
        assistantCtx({
          transcript: 'any time Tuesday?',
          onAssistantEvent: (e) => events.push(e),
          getAvailability: async () => {
            reads += 1;
            return 'AVAILABILITY: Tue 09:00';
          },
        }),
      ),
    );
    assert.equal(text, 'Tuesday at nine is free.');
    assert.equal(n, 2);
    assert.equal(reads, 1);
    assert.deepEqual(
      events.map((e) => `${e.event}${e.name ? `:${e.name}` : ''}`),
      ['round-start', 'done', 'tool-done:get_availability', 'round-start', 'first-token', 'done'],
    );
    assert.equal(typeof events[0]!.round, 'number');
  });

  it('retries once when the provider returns an empty round', async () => {
    let n = 0;
    const events: AssistantEvent[] = [];
    const fetchFn = (async () => {
      n += 1;
      if (n === 1) return sseResponse([]);
      return sseResponse([{ choices: [{ delta: { content: 'Recovered reply.' } }] }]);
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const text = await collectTokens(a.replyStream!(assistantCtx({ onAssistantEvent: (e) => events.push(e) })));
    assert.equal(text, 'Recovered reply.');
    assert.equal(n, 2);
    assert.deepEqual(
      events.map((e) => e.event),
      ['round-start', 'done', 'empty-retry', 'round-start', 'first-token', 'done'],
    );
  });

  it('returns empty after the retry is exhausted instead of looping', async () => {
    let n = 0;
    const events: AssistantEvent[] = [];
    const fetchFn = (async () => {
      n += 1;
      return sseResponse([]);
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const text = await collectTokens(a.replyStream!(assistantCtx({ onAssistantEvent: (e) => events.push(e) })));
    assert.equal(text, '');
    assert.equal(n, 2, 'one original attempt plus one retry');
    assert.equal(events.filter((e) => e.event === 'empty-retry').length, 1);
  });

  it('traces each round with finish reason, usage, provider, and request id', async () => {
    const events: AssistantEvent[] = [];
    const fetchFn = (async () =>
      sseResponse(
        [
          { provider: 'DeepSeek', model: 'deepseek/deepseek-v4-flash-0731', choices: [{ delta: { content: 'Hi.' } }] },
          {
            provider: 'DeepSeek',
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1200, completion_tokens: 3, total_tokens: 1203 },
          },
        ],
        { 'x-request-id': 'req_abc123' },
      )) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const text = await collectTokens(a.replyStream!(assistantCtx({ onAssistantEvent: (e) => events.push(e) })));
    assert.equal(text, 'Hi.');
    const done = events.find((e) => e.event === 'done')!;
    assert.equal(done.finish, 'stop');
    assert.equal(done.provider, 'DeepSeek');
    assert.equal(done.servedModel, 'deepseek/deepseek-v4-flash-0731');
    assert.equal(done.requestId, 'req_abc123');
    assert.equal(done.status, 200);
    assert.equal(done.chunks, 2);
    assert.equal(done.sseLines, 3, 'two chunks plus [DONE]');
    assert.deepEqual(done.usage, { prompt: 1200, completion: 3, total: 1203 });
    assert.equal(done.reasoningChars, 0);
  });

  it('flags an empty round with finish reason, reasoning volume, and a raw sample', async () => {
    let n = 0;
    const events: AssistantEvent[] = [];
    const fetchFn = (async () => {
      n += 1;
      if (n === 1) {
        return sseResponse([
          { provider: 'SomeReasoner', choices: [{ delta: { reasoning: 'thinking about the schedule...' } }] },
          { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 4000, completion_tokens: 1000 } },
        ]);
      }
      return sseResponse([{ choices: [{ delta: { content: 'Recovered.' } }] }]);
    }) as unknown as typeof fetch;
    const a = new OpenRouterAssistant({ apiKey: 'k', fetchFn });
    const text = await collectTokens(a.replyStream!(assistantCtx({ onAssistantEvent: (e) => events.push(e) })));
    assert.equal(text, 'Recovered.');
    const retry = events.find((e) => e.event === 'empty-retry')!;
    assert.equal(retry.finish, 'length');
    assert.equal(retry.provider, 'SomeReasoner');
    assert.equal(retry.reasoningChars, 'thinking about the schedule...'.length);
    assert.equal(retry.detail, 'empty-completion');
    assert.match(retry.lastChunk ?? '', /finish_reason/);
    assert.deepEqual(retry.usage, { prompt: 4000, completion: 1000, total: undefined });
  });

  it('throws on streaming provider errors', async () => {
    const a = new OpenRouterAssistant({
      apiKey: 'k',
      fetchFn: (async () => jsonResponse({ error: 'boom' }, 500)) as typeof fetch,
    });
    await assert.rejects(() => collectTokens(a.replyStream!(assistantCtx())));
  });
});

describe('TwilioRecordingFetcher', () => {
  it('retries while the recording is not ready, then returns the audio', async () => {
    const requested: string[] = [];
    let n = 0;
    const fetchFn = (async (url: string) => {
      n += 1;
      requested.push(String(url));
      if (n === 1) return new Response('missing', { status: 404 });
      return new Response(Buffer.from('clip-bytes') as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    }) as unknown as typeof fetch;
    const f = new TwilioRecordingFetcher({
      accountSid: 'AC1',
      authToken: 'tok',
      fetchFn,
      sleepMs: async () => {},
    });
    const out = await f.fetch('https://api.twilio.com/recordings/RE1');
    assert.ok(out);
    assert.equal(out.audio.toString(), 'clip-bytes');
    assert.equal(out.contentType, 'audio/mpeg');
    assert.equal(n, 2);
    assert.equal(requested[0], 'https://api.twilio.com/recordings/RE1.mp3');
  });

  it('returns null when the recording never becomes readable', async () => {
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      return new Response('missing', { status: 404 });
    }) as unknown as typeof fetch;
    const f = new TwilioRecordingFetcher({
      accountSid: 'AC1',
      authToken: 'tok',
      fetchFn,
      sleepMs: async () => {},
      attempts: 3,
    });
    assert.equal(await f.fetch('https://api.twilio.com/x'), null);
    assert.equal(n, 3);
  });

  it('throws on auth failures instead of silently missing', async () => {
    const fetchFn = (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch;
    const f = new TwilioRecordingFetcher({ accountSid: 'AC1', authToken: 'bad', fetchFn });
    await assert.rejects(() => f.fetch('https://api.twilio.com/x'));
  });
});

describe('WhisperTranscriber configuration', () => {
  it('posts to the configured endpoint with the configured model and no prompt bias', async () => {
    let url = '';
    let model = '';
    let prompt: string | null = null;
    let temperature = '';
    let filename = '';
    const fetchFn = (async (u: string, init: { body: FormData }) => {
      url = String(u);
      model = String(init.body.get('model'));
      const promptField = init.body.get('prompt');
      prompt = promptField === null ? null : String(promptField);
      temperature = String(init.body.get('temperature'));
      const file = init.body.get('file');
      filename = file instanceof File ? file.name : '';
      return jsonResponse({ text: 'hi', segments: [] });
    }) as unknown as typeof fetch;
    const t = new WhisperTranscriber({
      stt: { apiKey: 'k', baseUrl: 'http://stub-whisper/v1', model: 'stub-model' },
      fetchFn,
    });
    await t.transcribe(Buffer.from('audio'), 'audio/wav');
    assert.equal(url, 'http://stub-whisper/v1/audio/transcriptions');
    assert.equal(model, 'stub-model');
    assert.equal(prompt, null);
    assert.equal(temperature, '0');
    assert.equal(filename, 'turn.wav');
  });
});
