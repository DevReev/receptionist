import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { connectStream } from '../src/twiml.ts';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { CallStore } from '../src/calls.ts';
import { LiveCallSession } from '../src/live.ts';
import { attachStreamSocket, attachStreamEndpoint, type StreamIdentity } from '../src/stream.ts';
import { LOCAL_ENDPOINT_FALLBACKS, type Vad } from '../src/endpoint.ts';
import type { TraceEvent } from '../src/trace.ts';
import type { Tts } from '../src/tts.ts';
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
  OPENAI_API_KEY: 'sk-openai',
  SARVAM_API_KEY: 'sk-sarvam',
};

describe('connect TwiML', () => {
  it('points Twilio at the streaming endpoint', () => {
    const xml = connectStream('wss://example.com/stream');
    assert.match(xml, /<Connect><Stream url="wss:\/\/example\.com\/stream"\/><\/Connect>/);
  });

  it('escapes the url', () => {
    assert.match(connectStream('wss://example.com/s?a=1&b=2'), /a=1&amp;b=2/);
  });

  it('passes caller identity as stream parameters', () => {
    const xml = connectStream('wss://example.com/stream', { callerPhone: '+919840950950' });
    assert.match(xml, /<Parameter name="callerPhone" value="\+919840950950"\/>/);
  });
});

describe('voice loop config', () => {
  it('defaults to the streaming loop (ticket 13)', () => {
    const cfg = loadConfig({ ...BASE_ENV, STREAM_WS_URL: 'wss://example.com/stream' });
    assert.equal(cfg.voiceLoop, 'stream');
    assert.equal(cfg.vadThreshold, 0.1);
    assert.equal(cfg.sttProvider, 'openai-realtime');
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
      calls: new CallStore(),
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
        body: new URLSearchParams({ CallSid: 'CAstream1', From: '+919840950950' }),
      });
      const text = await res.text();
      assert.match(text, /<Stream url="wss:\/\/example\.com\/stream"/);
      assert.match(text, /<Parameter name="callerPhone" value="\+919840950950"\/>/);
    } finally {
      server.close();
    }
  });

  it('does not forward a blocked or anonymous caller as a phone number', async () => {
    const app = createApp({
      guidePath: './clinic.md',
      sayVoice: 'alice',
      sayLanguage: 'en-IN',
      voiceLoop: 'stream',
      streamWsUrl: 'wss://example.com/stream',
      calls: new CallStore(),
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
        body: new URLSearchParams({ CallSid: 'CAstream2', From: 'anonymous' }),
      });
      const text = await res.text();
      assert.doesNotMatch(text, /<Parameter/);
    } finally {
      server.close();
    }
  });

  it('shares one call-state store between the webhook and the live session', async () => {
    const calls = new CallStore();
    // State left behind by an earlier connection on the same CallSid.
    calls.get('CAshare1').turn = 4;
    calls.pushHistory('CAshare1', { role: 'caller', text: 'stale words' });
    const app = createApp({
      guidePath: './clinic.md',
      sayVoice: 'alice',
      sayLanguage: 'en-IN',
      voiceLoop: 'stream',
      streamWsUrl: 'wss://example.com/stream',
      calls,
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
        body: new URLSearchParams({ CallSid: 'CAshare1', From: '+919840950950' }),
      });
      assert.equal(res.status, 200);
    } finally {
      server.close();
    }
    assert.equal(calls.get('CAshare1').turn, 0, 'the webhook resets the injected store');
    assert.deepEqual(calls.get('CAshare1').history, []);

    const vad: Vad = { score: async () => 0.05, reset: () => {} };
    const tts: Tts = { synthesize: async () => ({ audio: Buffer.from([0xff]) }) };
    const live = new LiveCallSession({
      identity: { callSid: 'CAshare1', streamSid: 'MZCAshare1' },
      sendAudio: () => {},
      vad,
      policy: { ...LOCAL_ENDPOINT_FALLBACKS, threshold: 0.5 },
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      tts,
      guide: { raw: '# Clinic Guide — Maple Clinic\n', name: 'Maple Clinic' },
      calls,
    });
    for (const digit of '9876543210#') live.receiveDtmf(digit);
    await live.flush();
    assert.equal(calls.get('CAshare1').turn, 1, 'the session writes to the same store');
  });

  it('reports readiness separately from liveness', async () => {
    let ready = false;
    const app = createApp({
      guidePath: './clinic.md',
      sayVoice: 'alice',
      sayLanguage: 'en-IN',
      voiceLoop: 'stream',
      streamWsUrl: 'wss://example.com/stream',
      calls: new CallStore(),
      transcriber: { transcribe: async () => ({ text: '', noSpeech: true }) },
      assistant: { reply: async () => ({ text: '', endCall: true }) },
      recordingFetcher: { fetch: async () => null },
      logFailure: () => {},
      onProposeBooking: async () => ({ ok: false as const, reason: 'unused' }),
      isReady: () => ready,
    });
    const server = app.listen(0);
    try {
      const addr = server.address() as AddressInfo;
      const starting = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
      assert.equal(starting.status, 503);
      assert.equal(await starting.text(), 'starting');
      ready = true;
      const ok = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
      assert.equal(ok.status, 200);
      assert.equal(await ok.text(), 'ok');
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

  it('carries the caller number from start custom parameters, ignoring non-numbers', () => {
    const socket = new FakeSocket();
    const identities: StreamIdentity[] = [];
    attachStreamSocket(socket, {
      onAudio: (identity) => identities.push(identity),
      onClose: () => {},
    });
    socket.peerMessage(
      twilioStart({ callSid: 'CA5', streamSid: 'MZ5', customParameters: { callerPhone: '+919840950950' } }),
    );
    socket.peerMessage(twilioMedia(Buffer.from([1]).toString('base64')));
    socket.peerMessage(
      twilioStart({ callSid: 'CA6', streamSid: 'MZ6', customParameters: { callerPhone: 'anonymous' } }),
    );
    socket.peerMessage(twilioMedia(Buffer.from([1]).toString('base64')));
    assert.equal(identities[0]!.callerPhone, '+919840950950');
    assert.equal(identities[1]!.callerPhone, undefined);
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

  it('forwards an inbound DTMF digit to the observer', () => {
    const socket = new FakeSocket();
    const digits: { callSid: string; digit: string }[] = [];
    attachStreamSocket(socket, {
      onAudio: () => {},
      onClose: () => {},
      onDtmf: (identity, digit) => digits.push({ callSid: identity.callSid, digit }),
    });
    socket.peerMessage(twilioStart({ callSid: 'CAdtmf', streamSid: 'MZdtmf' }));
    socket.peerMessage({ event: 'dtmf', streamSid: 'MZdtmf', dtmf: { track: 'inbound_track', digit: '5' } });
    socket.peerMessage({ event: 'dtmf', streamSid: 'MZdtmf', dtmf: { digit: '#' } });
    assert.deepEqual(digits, [
      { callSid: 'CAdtmf', digit: '5' },
      { callSid: 'CAdtmf', digit: '#' },
    ]);
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

  it('counts frames and bytes in both directions for the close trace', () => {
    const socket = new FakeSocket();
    const session = attachStreamSocket(socket, { onAudio: () => {}, onClose: () => {} });
    socket.peerMessage(twilioStart({ callSid: 'CAstats', streamSid: 'MZstats' }));
    socket.peerMessage(twilioMedia(Buffer.from([1, 2, 3]).toString('base64')));
    socket.peerMessage(twilioMedia(Buffer.from([4, 5]).toString('base64')));
    session.sendAudio(Buffer.from([9, 9]));
    const stats = session.stats;
    assert.equal(stats.framesIn, 2);
    assert.equal(stats.bytesIn, 5);
    assert.equal(stats.framesOut, 1);
    assert.equal(stats.bytesOut, 2);
    assert.ok(stats.openedAt !== null);
    assert.ok(stats.durationMs >= 0);
  });

  it('flags non-contiguous media chunks without false-positiving on marks', () => {
    const socket = new FakeSocket();
    const traces: TraceEvent[] = [];
    attachStreamSocket(
      socket,
      { onAudio: () => {}, onClose: () => {} },
      { traceFor: (identity) => (event) => traces.push({ callSid: identity.callSid, ...event }) },
    );
    socket.peerMessage(twilioStart({ callSid: 'CAgap', streamSid: 'MZgap' }));
    socket.peerMessage(twilioMedia(Buffer.from([1]).toString('base64'), { chunk: 0, timestampMs: 0 }));
    // A mark between media frames shares the connection sequence but not the media chunk.
    socket.peerMessage({ event: 'mark', streamSid: 'MZgap', mark: { name: 'reply-0-mark-1' } });
    socket.peerMessage(twilioMedia(Buffer.from([2]).toString('base64'), { chunk: 1, timestampMs: 20 }));
    socket.peerMessage(twilioMedia(Buffer.from([3]).toString('base64'), { chunk: 3, timestampMs: 60 }));
    const gaps = traces.filter((event) => event.event === 'sequence-gap');
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!['expected'], 2);
    assert.equal(gaps[0]!['got'], 3);
    assert.equal(gaps[0]!['timestampDeltaMs'], 40);
    assert.equal(gaps[0]!['callSid'], 'CAgap');
  });

  it('resolves playback only after Twilio acknowledges its mark', async () => {
    const socket = new FakeSocket();
    const session = attachStreamSocket(socket, { onAudio: () => {}, onClose: () => {} });
    socket.peerMessage(twilioStart({ callSid: 'CAmark', streamSid: 'MZmark' }));
    session.sendAudio(Buffer.from([1, 2, 3]));
    let played = false;
    const pending = session.waitForPlayback().then(() => {
      played = true;
    });
    const mark = (socket.sentJson() as { event: string; mark?: { name?: string } }[]).find((frame) => frame.event === 'mark');
    assert.equal(played, false);
    assert.ok(mark?.mark?.name);
    socket.peerMessage({ event: 'mark', streamSid: 'MZmark', mark: { name: mark!.mark!.name } });
    await pending;
    assert.equal(played, true);
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
      calls: new CallStore(),
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
