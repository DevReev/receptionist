import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FallbackAssistant } from '../src/assistantFallback.ts';
import type { Assistant, AssistantContext } from '../src/app.ts';

const GUIDE = { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' };

function ctx(): AssistantContext {
  return {
    transcript: 'what are your hours',
    history: [],
    guide: GUIDE,
    getAvailability: async () => 'AVAILABILITY: no slots known.',
    proposeBooking: async () => ({ ok: false, reason: 'unused' }),
  };
}

function assistant(texts: string[], log: string[]): Assistant {
  return {
    reply: async () => {
      log.push('reply');
      return { text: texts.join(''), endCall: false };
    },
    replyStream: async function* () {
      for (const text of texts) yield text;
    },
  };
}

function failing(err: string, log: string[]): Assistant {
  return {
    reply: async () => {
      log.push('reply');
      throw new Error(err);
    },
    replyStream: async function* () {
      log.push('stream');
      throw new Error(err);
      // eslint-disable-next-line no-unreachable
      yield '';
    },
  };
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const token of stream) out += token;
  return out;
}

describe('FallbackAssistant', () => {
  it('streams the primary and never touches the fallback when it succeeds', async () => {
    const log: string[] = [];
    const a = new FallbackAssistant({ primary: assistant(['Hello '], log), fallback: assistant(['fallback'], log) });
    assert.equal(await collect(a.replyStream!(ctx())), 'Hello ');
    assert.deepEqual(log, []);
  });

  it('streams the fallback when the primary fails before yielding a token', async () => {
    const log: string[] = [];
    const fallbacks: string[] = [];
    const a = new FallbackAssistant({
      primary: failing('groq-http-429', log),
      fallback: assistant(['Deepseek says ', 'hello.'], log),
      onFallback: (detail) => fallbacks.push(detail),
    });
    assert.equal(await collect(a.replyStream!(ctx())), 'Deepseek says hello.');
    assert.deepEqual(fallbacks, ['groq-http-429']);
  });

  it('propagates a mid-stream failure once text has been yielded', async () => {
    const log: string[] = [];
    const primary: Assistant = {
      reply: async () => ({ text: '', endCall: false }),
      replyStream: async function* () {
        yield 'We are open ';
        throw new Error('groq-stream-died');
      },
    };
    const a = new FallbackAssistant({ primary, fallback: assistant(['fallback'], log) });
    await assert.rejects(() => collect(a.replyStream!(ctx())), /groq-stream-died/);
    assert.deepEqual(log, [], 'audio may already be playing; the fallback must not restart');
  });

  it('propagates when both providers fail', async () => {
    const a = new FallbackAssistant({ primary: failing('groq-http-500', []), fallback: failing('or-http-502', []) });
    await assert.rejects(() => collect(a.replyStream!(ctx())), /or-http-502/);
  });

  it('falls back for the non-streaming reply path too', async () => {
    const log: string[] = [];
    const a = new FallbackAssistant({ primary: failing('groq-http-500', log), fallback: assistant(['ok'], log) });
    const reply = await a.reply(ctx());
    assert.equal(reply.text, 'ok');
    assert.deepEqual(log, ['reply', 'reply'], 'primary attempted, then the fallback answered');
  });
});
