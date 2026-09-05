import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDeps, type FailureEvent } from '../src/app.ts';

const AUTH_TOKEN = 'test-auth-token-123';

function sign(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
}

let guidePath: string;
let baseUrl: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
const failures: FailureEvent[] = [];

async function postSigned(
  path: string,
  params: Record<string, string>,
  signature: string | null,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signature !== null) headers['X-Twilio-Signature'] = signature;
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params),
  });
  return { status: res.status, text: await res.text() };
}

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'receptionist-sec-'));
  guidePath = join(dir, 'clinic.md');
  writeFileSync(guidePath, '# Clinic Guide — Maple Clinic\n');
  const deps: AppDeps = {
    guidePath,
    sayVoice: 'alice',
    sayLanguage: 'en-IN',
    twilioAuthToken: AUTH_TOKEN,
    transcriber: { transcribe: async () => ({ text: 'hi', noSpeech: false }) },
    assistant: { reply: async () => ({ text: 'Hello.', endCall: false }) },
    recordingFetcher: { fetch: async () => ({ audio: Buffer.from('x'), contentType: 'audio/mpeg' }) },
    logFailure: (e) => failures.push(e),
    onProposeBooking: async () => ({ ok: false, reason: 'booking-not-wired' }),
  };
  server = createApp(deps).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('Twilio request validation', () => {
  it('accepts a correctly signed webhook', async () => {
    const params = { CallSid: 'CA999', From: '+911234567890' };
    const { status, text } = await postSigned(
      '/voice/incoming',
      params,
      sign(`${baseUrl}/voice/incoming`, params),
    );
    assert.equal(status, 200);
    assert.match(text, /Maple Clinic/);
  });

  it('rejects a tampered webhook', async () => {
    const signed = { CallSid: 'CA999', From: '+911234567890' };
    const sent = { CallSid: 'CA000', From: '+911234567890' };
    const { status } = await postSigned('/voice/incoming', sent, sign(`${baseUrl}/voice/incoming`, signed));
    assert.equal(status, 403);
  });

  it('rejects an unsigned webhook', async () => {
    const { status } = await postSigned('/voice/incoming', { CallSid: 'CA999' }, null);
    assert.equal(status, 403);
  });
});
