import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDeps, type FailureEvent } from '../src/app.ts';

const GUIDE_V1 = `# Clinic Guide — Maple Clinic

## Hours

- Mon–Fri 09:00–17:00 IST.
`;

let dir: string;
let guidePath: string;

function stubDeps(overrides: Partial<AppDeps> = {}): { deps: AppDeps; failures: FailureEvent[] } {
  const failures: FailureEvent[] = [];
  const deps: AppDeps = {
    guidePath,
    sayVoice: 'alice',
    sayLanguage: 'en-IN',
    transcriber: {
      transcribe: async () => ({ text: 'what are your hours', noSpeech: false }),
    },
    assistant: {
      reply: async () => ({ text: 'We are open Monday to Friday.', endCall: false }),
    },
    recordingFetcher: {
      fetch: async () => ({ audio: Buffer.from('fake-audio'), contentType: 'audio/mpeg' }),
    },
    logFailure: (e) => failures.push(e),
    onProposeBooking: async () => ({ ok: false as const, reason: 'booking-not-wired' }),
    ...overrides,
  };
  return { deps, failures };
}

interface TestServer {
  failures: FailureEvent[];
  close: () => void;
  post: (path: string, params: Record<string, string>) => Promise<{ status: number; text: string }>;
}

function startTestServer(overrides: Partial<AppDeps> = {}): TestServer {
  const { deps, failures } = stubDeps(overrides);
  const server = createApp(deps).listen(0);
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    failures,
    close: () => server.close(),
    post: async (path, params) => {
      const res = await fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

let main: TestServer;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'receptionist-test-'));
  guidePath = join(dir, 'clinic.md');
  writeFileSync(guidePath, GUIDE_V1);
  main = startTestServer();
});

after(() => {
  main.close();
});

describe('incoming call', () => {
  it('greets with the clinic name and starts listening', async () => {
    const { status, text } = await main.post('/voice/incoming', {
      CallSid: 'CA111',
      From: '+911234567890',
    });
    assert.equal(status, 200);
    assert.match(text, /Maple Clinic/);
    assert.match(text, /<Record\b/);
    assert.match(text, /action="\/voice\/turn"/);
  });
});

describe('caller turn', () => {
  it('answers the transcription and keeps listening', async () => {
    await main.post('/voice/incoming', { CallSid: 'CA222', From: '+911234567890' });
    const { status, text } = await main.post('/voice/turn', {
      CallSid: 'CA222',
      From: '+911234567890',
      RecordingUrl: 'https://api.twilio.com/recordings/RE123',
      RecordingDuration: '4',
    });
    assert.equal(status, 200);
    assert.match(text, /We are open Monday to Friday/);
    assert.match(text, /<Record\b/);
    assert.match(text, /action="\/voice\/turn"/);
  });
});

describe('silence and unintelligible input', () => {
  it('reprompts once, then says goodbye and hangs up', async () => {
    const first = await main.post('/voice/turn', { CallSid: 'CA333', From: '+911234567890' });
    assert.equal(first.status, 200);
    assert.match(first.text, /didn't catch that/);
    assert.match(first.text, /<Record\b/);
    assert.doesNotMatch(first.text, /<Hangup/);

    const second = await main.post('/voice/turn', { CallSid: 'CA333', From: '+911234567890' });
    assert.equal(second.status, 200);
    assert.match(second.text, /Goodbye/);
    assert.match(second.text, /<Hangup\/>/);
    assert.doesNotMatch(second.text, /<Record\b/);
  });

  it('logs a failure event when giving up on a call', async () => {
    const before = main.failures.length;
    await main.post('/voice/turn', { CallSid: 'CA444', From: '+911234567890' });
    await main.post('/voice/turn', { CallSid: 'CA444', From: '+911234567890' });
    assert.equal(main.failures.length, before + 1);
    const event = main.failures[main.failures.length - 1];
    assert.equal(event.callSid, 'CA444');
    assert.equal(event.reason, 'low-confidence');
    assert.equal(typeof event.turn, 'number');
  });

  it('treats empty transcription as a miss', async () => {
    const srv = startTestServer({
      transcriber: { transcribe: async () => ({ text: '   ', noSpeech: false }) },
    });
    try {
      await srv.post('/voice/incoming', { CallSid: 'CA555', From: '+911234567890' });
      const { text } = await srv.post('/voice/turn', {
        CallSid: 'CA555',
        RecordingUrl: 'https://api.twilio.com/recordings/RE1',
      });
      assert.match(text, /didn't catch that/);
      assert.match(text, /<Record\b/);
    } finally {
      srv.close();
    }
  });

  it('treats whisper no-speech as a miss', async () => {
    const srv = startTestServer({
      transcriber: { transcribe: async () => ({ text: 'background music lyrics', noSpeech: true }) },
    });
    try {
      await srv.post('/voice/incoming', { CallSid: 'CA556', From: '+911234567890' });
      const { text } = await srv.post('/voice/turn', {
        CallSid: 'CA556',
        RecordingUrl: 'https://api.twilio.com/recordings/RE2',
      });
      assert.match(text, /didn't catch that/);
    } finally {
      srv.close();
    }
  });

  it('treats an unreadable recording as a miss', async () => {
    const srv = startTestServer({ recordingFetcher: { fetch: async () => null } });
    try {
      await srv.post('/voice/incoming', { CallSid: 'CA557', From: '+911234567890' });
      const { text } = await srv.post('/voice/turn', {
        CallSid: 'CA557',
        RecordingUrl: 'https://api.twilio.com/recordings/RE3',
      });
      assert.match(text, /didn't catch that/);
    } finally {
      srv.close();
    }
  });
});

describe('assistant failure', () => {
  it('speaks the clinic-will-confirm line and hangs up', async () => {
    const srv = startTestServer({
      assistant: {
        reply: async () => {
          throw new Error('llm timeout');
        },
      },
    });
    try {
      await srv.post('/voice/incoming', { CallSid: 'CA666', From: '+911234567890' });
      const { status, text } = await srv.post('/voice/turn', {
        CallSid: 'CA666',
        RecordingUrl: 'https://api.twilio.com/recordings/RE9',
      });
      assert.equal(status, 200);
      assert.match(text, /clinic will confirm shortly/);
      assert.match(text, /<Hangup\/>/);
      assert.doesNotMatch(text, /<Record\b/);
      assert.equal(srv.failures.length, 1);
      assert.equal(srv.failures[0].callSid, 'CA666');
    } finally {
      srv.close();
    }
  });
});

describe('clinic guide edits', () => {
  it('takes effect on the next turn without a restart', async () => {
    const first = await main.post('/voice/incoming', { CallSid: 'CA777', From: '+911234567890' });
    assert.match(first.text, /Maple Clinic/);
    writeFileSync(guidePath, GUIDE_V1.replace('Maple Clinic', 'Oak Clinic'));
    try {
      const second = await main.post('/voice/incoming', { CallSid: 'CA778', From: '+911234567890' });
      assert.match(second.text, /Oak Clinic/);
    } finally {
      writeFileSync(guidePath, GUIDE_V1);
    }
  });
});
