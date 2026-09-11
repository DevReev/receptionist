import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { connectStream } from '../src/twiml.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { attachStreamSocket, attachStreamEndpoint } from '../src/stream.ts';
import {
  FakeSocket,
  recordingObserver,
  twilioConnected,
  twilioMedia,
  twilioStart,
  twilioStop,
} from './fakeStream.ts';

const BASE_ENV = {
  TWILIO_ACCOUNT_SID: 'ACx',
  TWILIO_AUTH_TOKEN: 't',
  GROQ_API_KEY: 'g',
  OPENROUTER_API_KEY: 'o',
};

describe('connect TwiML', () => {
  it('points Twilio at the streaming endpoint', () => {
    const xml = connectStream('wss://example.com/stream');
    assert.match(xml, /<Connect><Stream url="wss:\/\/example\.com\/stream"\/><\/Connect>/);
  });

  it('escapes the url', () => {
    assert.match(connectStream('wss://example.com/s?a=1&b=2'), /a=1&amp;b=2/);
  });
});

describe('voice loop config', () => {
  it('defaults to the streaming loop (ticket 13)', () => {
    const cfg = loadConfig({ ...BASE_ENV, STREAM_WS_URL: 'wss://example.com/stream' });
    assert.equal(cfg.voiceLoop, 'stream');
  });

  it('requires the public stream url by default', () => {
    assert.throws(() => loadConfig({ ...BASE_ENV }), /STREAM_WS_URL/);
  });

  it('keeps the legacy record loop behind the flag', () => {
    const cfg = loadConfig({ ...BASE_ENV, VOICE_LOOP: 'legacy' });
    assert.equal(cfg.voiceLoop, 'legacy');
    assert.equal(cfg.streamWsUrl, '');
  });

  it('selects streaming when asked', () => {
    const cfg = loadConfig({ ...BASE_ENV, VOICE_LOOP: 'stream', STREAM_WS_URL: 'wss://x/stream' });
    assert.equal(cfg.voiceLoop, 'stream');
    assert.equal(cfg.streamWsUrl, 'wss://x/stream');
  });

  it('requires the stream url in streaming mode', () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, VOICE_LOOP: 'stream' }), /STREAM_WS_URL/);
  });

  it('rejects a non-public stream url in streaming mode', () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, VOICE_LOOP: 'stream', STREAM_WS_URL: 'ws://localhost:3000/stream' }),
      /public wss:\/\//,
    );
  });

  it('rejects unknown loop values', () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, VOICE_LOOP: 'flaky' }), /VOICE_LOOP/);
  });
});

describe('incoming call routing', () => {
  it('answers Connect TwiML in streaming mode', async () => {
    const app = createApp({
      guidePath: './clinic.md',
      sayVoice: 'alice',
      sayLanguage: 'en-IN',
      voiceLoop: 'stream',
      streamWsUrl: 'wss://example.com/stream',
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      assistant: { reply: async () => ({ text: '', endCall: true }) },
      recordingFetcher: { fetch: async () => null },
      logFailure: () => {},
      onProposeBooking: async () => ({ ok: false as const, reason: 'unused' }),
    });
    const server = app.listen(0);
    try {
      const addr = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${addr.port}/voice/incoming`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ CallSid: 'CAstream1' }),
      });
      const text = await res.text();
      assert.match(text, /<Stream url="wss:\/\/example\.com\/stream"\/>/);
    } finally {
      server.close();
    }
  });
});

describe('stream session lifecycle', () => {
  it('opens on start and delivers audio frames', () => {
    const socket = new FakeSocket();
    const observer = recordingObserver();
    attachStreamSocket(socket, observer);
    socket.peerMessage(twilioConnected());
    socket.peerMessage(twilioStart({ callSid: 'CA1', streamSid: 'MZ1' }));
    socket.peerMessage(twilioMedia(Buffer.from([1, 2, 3]).toString('base64')));
    assert.deepEqual(observer.audio, [{ callSid: 'CA1', bytes: 3 }]);
    assert.deepEqual(observer.closes, []);
  });

  it('closes exactly once on stop, then on socket close', () => {
    const socket = new FakeSocket();
    const observer = recordingObserver();
    attachStreamSocket(socket, observer);
    socket.peerMessage(twilioStart({ callSid: 'CA2', streamSid: 'MZ2' }));
    socket.peerMessage(twilioStop());
    socket.peerClose();
    assert.equal(observer.closes.length, 1);
    assert.equal(observer.closes[0]?.reason, 'stop');
    assert.equal(socket.closedByServer, true);
  });

  it('closes on socket drop without a stop', () => {
    const socket = new FakeSocket();
    const observer = recordingObserver();
    attachStreamSocket(socket, observer);
    socket.peerMessage(twilioStart({ callSid: 'CA3', streamSid: 'MZ3' }));
    socket.peerClose();
    assert.deepEqual(observer.closes, [{ callSid: 'CA3', reason: 'socket-closed' }]);
  });

  it('ignores malformed frames without crashing', () => {
    const socket = new FakeSocket();
    const observer = recordingObserver();
    attachStreamSocket(socket, observer);
    socket.peerMessage('not-json{{{');
    socket.peerMessage({ event: 'media' });
    socket.peerMessage(twilioStart({ callSid: 'CA4', streamSid: 'MZ4' }));
    socket.peerClose();
    assert.deepEqual(observer.closes, [{ callSid: 'CA4', reason: 'socket-closed' }]);
  });

  it('drops audio arriving before start', () => {
    const socket = new FakeSocket();
    const observer = recordingObserver();
    attachStreamSocket(socket, observer);
    socket.peerMessage(twilioMedia(Buffer.from([9]).toString('base64')));
    assert.deepEqual(observer.audio, []);
    socket.peerClose();
    assert.deepEqual(observer.closes, [{ callSid: 'unknown', reason: 'socket-closed' }]);
  });
});

describe('streaming endpoint', () => {
  let server: Server | undefined;
  let endpoint: { sessions: Set<unknown>; close: () => void } | undefined;
  let port = 0;

  before(() => {
    const app = createApp({
      guidePath: './clinic.md',
      sayVoice: 'alice',
      sayLanguage: 'en-IN',
      voiceLoop: 'legacy',
      streamWsUrl: '',
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      assistant: { reply: async () => ({ text: '', endCall: true }) },
      recordingFetcher: { fetch: async () => null },
      logFailure: () => {},
      onProposeBooking: async () => ({ ok: false as const, reason: 'unused' }),
    });
    server = app.listen(0);
    port = (server.address() as AddressInfo).port;
    const observer = recordingObserver();
    endpoint = attachStreamEndpoint(server, observer) as unknown as {
      sessions: Set<unknown>;
      close: () => void;
    };
  });

  after(() => {
    endpoint?.close();
    server?.close();
  });

  it('registers a session on start and removes it on disconnect', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('ws open failed')));
    });
    ws.send(JSON.stringify(twilioConnected()));
    ws.send(JSON.stringify(twilioStart({ callSid: 'CAlive', streamSid: 'MZlive' })));
    await waitFor(() => (endpoint?.sessions.size ?? 0) === 1, 'session registered');
    ws.close();
    await waitFor(() => (endpoint?.sessions.size ?? 0) === 0, 'session removed');
  });
});

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
