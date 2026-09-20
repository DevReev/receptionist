import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCall,
  callSids,
  formatLiveCallReport,
  parseLogLines,
  selectCall,
  type LogLine,
} from '../src/liveAnalysis.ts';

const T0 = Date.parse('2026-09-17T10:00:00.000Z');

function at(ms: number): string {
  return new Date(T0 + ms).toISOString();
}

function line(ms: number, fields: Record<string, unknown>): string {
  return JSON.stringify({ ts: at(ms), ...fields });
}

function session(ms: number, event: string, fields: Record<string, unknown> = {}): string {
  return line(ms, { callSid: 'CAone', kind: 'session', event, ...fields });
}

function trace(ms: number, component: string, event: string, fields: Record<string, unknown> = {}): string {
  return line(ms, { callSid: 'CAone', kind: 'trace', component, event, ...fields });
}

function phase(ms: number, name: string, event: string, fields: Record<string, unknown> = {}): string {
  return line(ms, { callSid: 'CAone', kind: 'phase', phase: name, event, ...fields });
}

function turn(ms: number, fields: Record<string, unknown>): string {
  return line(ms, { callSid: 'CAone', kind: 'turn', turn: 1, ...fields });
}

function parse(lines: string[]): LogLine[] {
  return parseLogLines(lines.join('\n'));
}

describe('live call analysis: parsing', () => {
  it('keeps well-formed JSON lines and skips anything unparseable', () => {
    const lines = parse([
      'not json at all',
      '',
      line(0, { callSid: 'CAone', kind: 'session', event: 'open' }),
      '{"missing":"ts","callSid":"CAone"}',
      line(10, { callSid: 'CAtwo', kind: 'session', event: 'open' }),
    ]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.callSid, 'CAone');
    assert.equal(lines[0]!.at, T0);
    assert.equal(lines[0]!.kind, 'session');
    assert.equal(lines[1]!.callSid, 'CAtwo');
  });

  it('lists distinct call ids and selects one call', () => {
    const lines = parse([
      line(0, { callSid: 'CAone', kind: 'session', event: 'open' }),
      line(10, { callSid: 'CAtwo', kind: 'session', event: 'open' }),
      line(20, { callSid: 'CAone', kind: 'session', event: 'close' }),
      line(30, { kind: 'appointments', event: 'result' }),
    ]);
    assert.deepEqual(callSids(lines), ['CAone', 'CAtwo']);
    assert.equal(selectCall(lines, 'CAone').length, 2);
    assert.equal(selectCall(lines, 'CAnone').length, 0);
  });
});

describe('live call analysis: reply latency', () => {
  it('measures a provider boundary to the first reply audio', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(100, 'tts', 'first-audio', { generation: 0, ms: 90 }),
        trace(500, 'stt', 'vad-speech-end', { utteranceIdx: 0 }),
        trace(700, 'tts', 'first-audio', { generation: 1, ms: 120 }),
        trace(2000, 'stt', 'vad-speech-end', { utteranceIdx: 1 }),
        trace(2300, 'tts', 'first-audio', { generation: 2, ms: 110 }),
      ]),
      'CAone',
    );
    assert.equal(metrics.turns, 2);
    assert.deepEqual(metrics.replyLatenciesMs, [200, 300]);
    assert.equal(metrics.replyLatencyMs.p50, 200);
    assert.equal(metrics.replyLatencyMs.samples, 2);
  });

  it('measures from the last caller speech sample to the first outbound frame', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(5000, 'vad', 'endpoint', { source: 'provider', speechMs: 800, trailingSilenceMs: 400 }),
        trace(5600, 'tts', 'first-audio', { generation: 1, ms: 90 }),
        trace(5900, 'call', 'first-outbound', { generation: 1 }),
      ]),
      'CAone',
    );
    assert.deepEqual(metrics.replyLatenciesMs, [1300]);
  });

  it('prefers the outbound frame over provider first-audio for the same reply', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(5000, 'vad', 'endpoint', { source: 'local', speechMs: 800, trailingSilenceMs: 200 }),
        trace(5100, 'tts', 'first-audio', { generation: 1, ms: 60 }),
        trace(5700, 'call', 'first-outbound', { generation: 1 }),
      ]),
      'CAone',
    );
    assert.deepEqual(metrics.replyLatenciesMs, [900]);
  });

  it('accepts a local detector boundary and a REST first-audio fallback', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(500, 'vad', 'endpoint', { source: 'local', speechMs: 900 }),
        trace(900, 'tts', 'first-audio', { generation: 1, ms: 100 }),
        trace(2000, 'vad', 'endpoint', { source: 'local', speechMs: 700 }),
        trace(2500, 'tts', 'rest-done', { ms: 220, bytes: 8000 }),
      ]),
      'CAone',
    );
    assert.deepEqual(metrics.replyLatenciesMs, [400, 500]);
    assert.deepEqual(metrics.boundaries, { provider: 0, local: 2 });
  });

  it('does not attribute reply audio to a later boundary', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(500, 'stt', 'vad-speech-end', { utteranceIdx: 0 }),
        trace(900, 'tts', 'first-audio', { generation: 1, ms: 100 }),
        trace(4000, 'stt', 'vad-speech-end', { utteranceIdx: 1 }),
        trace(5000, 'tts', 'first-audio', { generation: 2, ms: 100 }),
      ]),
      'CAone',
    );
    assert.deepEqual(metrics.replyLatenciesMs, [400, 1000]);
  });

  it('leaves a boundary without reply audio out of the latency samples', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(500, 'stt', 'vad-speech-end', { utteranceIdx: 0 }),
        trace(4000, 'stt', 'vad-speech-end', { utteranceIdx: 1 }),
        trace(4300, 'tts', 'first-audio', { generation: 2, ms: 100 }),
      ]),
      'CAone',
    );
    assert.deepEqual(metrics.replyLatenciesMs, [300]);
  });
});

describe('live call analysis: barge-in', () => {
  it('derives stop latency from the candidate window to the cleared playback', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(10000, 'call', 'barge-in', { generation: 3, candidateMs: 220 }),
        trace(10002, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 3 }),
        trace(20000, 'call', 'barge-in', { generation: 4, candidateMs: 240 }),
        trace(20001, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 4 }),
      ]),
      'CAone',
    );
    assert.equal(metrics.bargeIns, 2);
    assert.deepEqual(metrics.stopLatenciesMs, [222, 241]);
    assert.equal(metrics.stopLatencyMs.p50, 222);
  });

  it('anchors stop latency to the clear that was sent, even without a barrier trace', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(10000, 'call', 'barge-in', { generation: 3, candidateMs: 500 }),
        trace(10001, 'twilio', 'clear-sent', { reason: 'caller-barge-in' }),
        trace(15000, 'call', 'barge-in', { generation: 4, candidateMs: 200 }),
        trace(15001, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 4 }),
      ]),
      'CAone',
    );
    assert.deepEqual(metrics.stopLatenciesMs, [501, 201]);
  });

  it('flags a barge-in whose candidate window held only returning Echo', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(9900, 'echo-gate', 'decision', { echo: true, reason: 'echo' }),
        trace(9950, 'echo-gate', 'decision', { echo: true, reason: 'echo' }),
        trace(10000, 'call', 'barge-in', { generation: 3, candidateMs: 240 }),
        trace(10001, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 3 }),
        trace(19900, 'echo-gate', 'decision', { echo: false, reason: 'double-talk' }),
        trace(20000, 'call', 'barge-in', { generation: 4, candidateMs: 200 }),
        trace(20001, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 4 }),
      ]),
      'CAone',
    );
    assert.equal(metrics.selfEchoBargeIns, 1);
    assert.equal(metrics.bargeIns, 2);
  });

  it('does not treat no-reference frames as caller evidence for a Barge-in', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(9950, 'echo-gate', 'decision', { echo: false, reason: 'no-reference' }),
        trace(10000, 'call', 'barge-in', { generation: 3, candidateMs: 240 }),
        trace(10001, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 3 }),
      ]),
      'CAone',
    );
    assert.equal(metrics.selfEchoBargeIns, 1);
  });

  it('counts absorbed backchannels and a stop on acknowledgement speech as a false stop', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(10000, 'call', 'backchannel', { durationMs: 260, text: 'okay' }),
        trace(20000, 'echo-gate', 'decision', { echo: false, reason: 'double-talk' }),
        trace(20100, 'call', 'barge-in', { generation: 4, candidateMs: 200 }),
        trace(20101, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 4 }),
        turn(21000, { excerpt: 'mm-hmm', reply: 'Certainly.', endCall: false, miss: false }),
      ]),
      'CAone',
    );
    assert.equal(metrics.backchannelAbsorptions, 1);
    assert.equal(metrics.backchannelFalseStops, 1);
  });

  it('does not call a content-bearing Barge-in a backchannel false stop', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(20000, 'echo-gate', 'decision', { echo: false, reason: 'double-talk' }),
        trace(20100, 'call', 'barge-in', { generation: 4, candidateMs: 200 }),
        trace(20101, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 4 }),
        turn(22000, { excerpt: 'no wait, the tenth', reply: 'Sure.', endCall: false, miss: false }),
      ]),
      'CAone',
    );
    assert.equal(metrics.backchannelFalseStops, 0);
  });

  it('does not attribute a distant Turn to an earlier Barge-in as a false stop', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(20000, 'echo-gate', 'decision', { echo: false, reason: 'double-talk' }),
        trace(20100, 'call', 'barge-in', { generation: 4, candidateMs: 200 }),
        trace(20101, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 4 }),
        turn(60000, { excerpt: 'okay', reply: 'Sure.', endCall: false, miss: false }),
      ]),
      'CAone',
    );
    assert.equal(metrics.backchannelFalseStops, 0);
  });
});

describe('live call analysis: readback and booking safety', () => {
  it('links an interrupted readback to its cleared generation and counts bookings', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(40000, 'dialogue', 'reduced', { turn: 3, phase: 'collecting-patient', decision: 'readback' }),
        phase(40100, 'tts', 'start', { generation: 7, chars: 80 }),
        trace(40300, 'call', 'barge-in', { generation: 7, candidateMs: 200 }),
        trace(40301, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 7 }),
        phase(40400, 'booking', 'start', { turn: 4, date: '2026-09-30', time: '09:30', location: 'Bobby Clinic' }),
        phase(40500, 'booking', 'outcome', { turn: 4, ok: false, reason: 'slot-taken' }),
      ]),
      'CAone',
    );
    assert.equal(metrics.readbackDecisions, 1);
    assert.equal(metrics.interruptedReadbacks, 1);
    assert.equal(metrics.bookingAttempts, 1);
    assert.equal(metrics.bookingsSaved, 0);
    assert.equal(metrics.bookingsAfterInterruptedReadback, 0);
  });

  it('counts a save after an interrupted readback as a gate breach', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(40000, 'dialogue', 'reduced', { turn: 3, phase: 'collecting-patient', decision: 'readback' }),
        phase(40100, 'tts', 'start', { generation: 7, chars: 80 }),
        trace(40301, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 7 }),
        trace(40400, 'dialogue', 'reduced', { turn: 4, phase: 'collecting-patient', decision: 'continue' }),
        phase(40450, 'booking', 'start', { turn: 4, date: '2026-09-30', time: '09:30', location: 'Bobby Clinic' }),
        phase(40500, 'booking', 'outcome', { turn: 4, ok: true }),
      ]),
      'CAone',
    );
    assert.equal(metrics.interruptedReadbacks, 1);
    assert.equal(metrics.bookingsSaved, 1);
    assert.equal(metrics.bookingsAfterInterruptedReadback, 1);
  });

  it('does not count an uninterrupted readback as interrupted', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(40000, 'dialogue', 'reduced', { turn: 3, phase: 'collecting-patient', decision: 'readback' }),
        phase(40100, 'tts', 'start', { generation: 7, chars: 80 }),
        trace(41000, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 8 }),
      ]),
      'CAone',
    );
    assert.equal(metrics.interruptedReadbacks, 0);
  });

  it('does not breach when a fresh readback started before the save', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(40000, 'dialogue', 'reduced', { turn: 3, phase: 'collecting-patient', decision: 'readback' }),
        phase(40100, 'tts', 'start', { generation: 7, chars: 80 }),
        trace(40301, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 7 }),
        trace(41000, 'dialogue', 'reduced', { turn: 4, phase: 'collecting-patient', decision: 'readback' }),
        phase(41100, 'tts', 'start', { generation: 8, chars: 80 }),
        phase(42000, 'booking', 'start', { turn: 5, date: '2026-09-30', time: '09:30', location: 'Bobby Clinic' }),
        phase(42100, 'booking', 'outcome', { turn: 5, ok: true }),
      ]),
      'CAone',
    );
    assert.equal(metrics.interruptedReadbacks, 1);
    assert.equal(metrics.bookingsSaved, 1);
    assert.equal(metrics.bookingsAfterInterruptedReadback, 0);
  });
});

describe('live call analysis: echo gate, speculation, session shape', () => {
  it('summarizes gate decisions by reason and kind', () => {
    const metrics = analyzeCall(
      parse([
        trace(100, 'echo-gate', 'decision', { echo: true, reason: 'echo' }),
        trace(120, 'echo-gate', 'decision', { echo: true, reason: 'echo' }),
        trace(140, 'echo-gate', 'decision', { echo: false, reason: 'silence' }),
        trace(160, 'echo-gate', 'decision', { echo: false, reason: 'double-talk' }),
        trace(180, 'echo-gate', 'decision', { echo: false, reason: 'no-reference' }),
      ]),
      'CAone',
    );
    assert.equal(metrics.echoGate.decisions, 5);
    assert.equal(metrics.echoGate.echoFrames, 2);
    assert.equal(metrics.echoGate.callerFrames, 1);
    assert.equal(metrics.echoGate.silentFrames, 1);
    assert.deepEqual(metrics.echoGate.reasons, {
      echo: 2,
      silence: 1,
      'double-talk': 1,
      'no-reference': 1,
    });
  });

  it('counts speculation lifecycle events', () => {
    const metrics = analyzeCall(
      parse([
        trace(300, 'call', 'speculation-start', { partial: 'what are your hours', reason: 'partial' }),
        trace(400, 'call', 'speculation-kept', { turn: 1, partial: 'what are your hours', chars: 42, ms: 120 }),
        trace(500, 'call', 'speculation-start', { partial: 'book', reason: 'partial' }),
        trace(600, 'call', 'speculation-aborted', { reason: 'booking-cue', cue: 'book', partial: 'book', final: 'book it', ms: 90 }),
      ]),
      'CAone',
    );
    assert.deepEqual(metrics.speculation, { started: 2, kept: 1, aborted: 1 });
  });

  it('captures the session shape, hold lines, and audio-dump captures', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        phase(1000, 'assistant', 'hold', { text: 'One moment.' }),
        line(1100, { callSid: 'CAone', kind: 'audio-dump', turn: 1, path: 'debug-audio/CAone-turn1.wav' }),
        trace(1200, 'vad', 'endpoint', { source: 'provider', speechMs: 600 }),
        session(5000, 'close', { reason: 'goodbye' }),
      ]),
      'CAone',
    );
    assert.equal(metrics.openAt, at(0));
    assert.equal(metrics.closeAt, at(5000));
    assert.equal(metrics.closeReason, 'goodbye');
    assert.equal(metrics.holdLines, 1);
    assert.deepEqual(metrics.audioCaptures, ['debug-audio/CAone-turn1.wav']);
  });
});

describe('live call analysis: report', () => {
  it('formats the headline numbers and the gate verdicts', () => {
    const metrics = analyzeCall(
      parse([
        session(0, 'open'),
        trace(500, 'stt', 'vad-speech-end', { utteranceIdx: 0 }),
        trace(700, 'tts', 'first-audio', { generation: 1, ms: 120 }),
        trace(10000, 'echo-gate', 'decision', { echo: true, reason: 'echo' }),
        trace(10050, 'echo-gate', 'decision', { echo: false, reason: 'double-talk' }),
        trace(10100, 'call', 'barge-in', { generation: 2, candidateMs: 220 }),
        trace(10102, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 2 }),
        trace(10200, 'call', 'backchannel', { durationMs: 200, text: 'mm-hmm' }),
        trace(20000, 'dialogue', 'reduced', { turn: 2, phase: 'collecting-patient', decision: 'readback' }),
        phase(20100, 'tts', 'start', { generation: 3, chars: 60 }),
        trace(20200, 'echo-gate', 'decision', { echo: false, reason: 'double-talk' }),
        trace(20300, 'call', 'barge-in', { generation: 3, candidateMs: 180 }),
        trace(20302, 'call', 'playback-cleared', { reason: 'caller-barge-in', generation: 3 }),
      ]),
      'CAone',
    );
    const report = formatLiveCallReport(metrics);
    assert.match(report, /live call CAone/, report);
    assert.match(report, /reply latency p50 200ms p95 200ms \(n=1\)/, report);
    assert.match(report, /stop latency p50 182ms p95 222ms \(n=2\)/, report);
    assert.match(report, /barge-in 2  self-echo barge-ins 0/, report);
    assert.match(report, /backchannels absorbed 1  false-stop 0/, report);
    assert.match(report, /readbacks 1  interrupted 1  bookings 0\/0 saved/, report);
    assert.match(report, /gate echo false-stop 0 -> PASS/, report);
    assert.match(report, /gate backchannel false-stop 0 -> PASS/, report);
    assert.match(report, /gate interrupted-readback bookings 0 -> PASS/, report);
  });
});
