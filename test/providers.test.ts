import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WhisperTranscriber } from '../src/whisper.ts';
import { OpenRouterAssistant } from '../src/openrouter.ts';
import { TwilioRecordingFetcher } from '../src/recordings.ts';
import type { AssistantContext, BookingOutcome, ProposedSlot } from '../src/app.ts';

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
    availability: 'AVAILABILITY: no slots known.',
    proposeBooking: async () => ({ ok: false, reason: 'booking-not-wired' }),
    ...overrides,
  };
}

describe('WhisperTranscriber', () => {
  it('returns the transcript text', async () => {
    const t = new WhisperTranscriber({
      apiKey: 'k',
      fetchFn: (async () =>
        jsonResponse({ text: 'hello clinic', segments: [{ no_speech_prob: 0.05 }] })) as typeof fetch,
    });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/mpeg');
    assert.equal(out.text, 'hello clinic');
    assert.equal(out.noSpeech, false);
  });

  it('flags hallucination-prone audio as no-speech', async () => {
    const t = new WhisperTranscriber({
      apiKey: 'k',
      fetchFn: (async () =>
        jsonResponse({ text: 'background music', segments: [{ no_speech_prob: 0.95 }] })) as typeof fetch,
    });
    const out = await t.transcribe(Buffer.from('audio'), 'audio/mpeg');
    assert.equal(out.noSpeech, true);
  });

  it('throws on provider errors', async () => {
    const t = new WhisperTranscriber({
      apiKey: 'k',
      fetchFn: (async () => jsonResponse({ error: 'boom' }, 500)) as typeof fetch,
    });
    await assert.rejects(() => t.transcribe(Buffer.from('audio'), 'audio/mpeg'));
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

  it('throws on provider errors', async () => {
    const a = new OpenRouterAssistant({
      apiKey: 'k',
      fetchFn: (async () => jsonResponse({ error: 'boom' }, 500)) as typeof fetch,
    });
    await assert.rejects(() => a.reply(assistantCtx()));
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
  it('posts to the configured endpoint with the configured model', async () => {
    let url = '';
    let model = '';
    const fetchFn = (async (u: string, init: { body: FormData }) => {
      url = String(u);
      model = String(init.body.get('model'));
      return jsonResponse({ text: 'hi', segments: [] });
    }) as unknown as typeof fetch;
    const t = new WhisperTranscriber({
      apiKey: 'k',
      baseUrl: 'http://stub-whisper/v1',
      model: 'stub-model',
      fetchFn,
    });
    await t.transcribe(Buffer.from('audio'), 'audio/mpeg');
    assert.equal(url, 'http://stub-whisper/v1/audio/transcriptions');
    assert.equal(model, 'stub-model');
  });
});
