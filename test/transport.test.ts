import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TwilioMediaTransport, type TransportClock, type TransportSocket } from '../src/transport.ts';
import type { TraceEvent } from '../src/trace.ts';

interface FakeTimer {
  at: number;
  cb: () => void;
}

class FakeClock implements TransportClock {
  time = 0;
  private timers = new Map<number, FakeTimer>();
  private nextId = 1;

  now = (): number => this.time;

  setTimer = (cb: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, cb });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | null = null;
      let next: FakeTimer | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (next === null || timer.at < next.at)) {
          nextId = id;
          next = timer;
        }
      }
      if (next === null || nextId === null) break;
      this.timers.delete(nextId);
      this.time = next.at;
      next.cb();
    }
    this.time = target;
  }

  /** Simulate a blocked event loop: jump the clock, then run due timers late. */
  wakeLate(ms: number): void {
    this.time += ms;
    const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.time);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.cb();
    }
  }
}

class FakeSocket implements TransportSocket {
  readonly sent: Record<string, unknown>[] = [];
  buffered = 0;
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  media(): Buffer[] {
    return this.sent
      .filter((frame) => frame['event'] === 'media')
      .map((frame) => Buffer.from((frame['media'] as { payload: string }).payload, 'base64'));
  }

  marks(): string[] {
    return this.sent
      .filter((frame) => frame['event'] === 'mark')
      .map((frame) => (frame['mark'] as { name: string }).name);
  }

  events(): string[] {
    return this.sent.map((frame) => String(frame['event']));
  }
}

function harness(overrides: {
  maxQueuedMs?: number;
  markTimeoutMs?: number;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  onOverflow?: (reason: string) => void;
  onFatal?: (reason: string) => void;
  onFrameSent?: (frame: Buffer) => void;
  events?: TraceEvent[];
} = {}) {
  const clock = new FakeClock();
  const socket = new FakeSocket();
  const events: TraceEvent[] = overrides.events ?? [];
  const transport = new TwilioMediaTransport({
    streamSid: 'MZ1',
    socket,
    clock,
    maxQueuedMs: overrides.maxQueuedMs,
    markTimeoutMs: overrides.markTimeoutMs,
    highWaterBytes: overrides.highWaterBytes,
    lowWaterBytes: overrides.lowWaterBytes,
    onOverflow: overrides.onOverflow,
    onFatal: overrides.onFatal,
    onFrameSent: overrides.onFrameSent,
    onTrace: (event) => events.push(event),
  });
  return { clock, socket, transport, events };
}

function bytes(count: number, seed = 1): Buffer {
  const buf = Buffer.alloc(count);
  for (let i = 0; i < count; i++) buf[i] = (seed + i) % 256;
  return buf;
}

describe('TwilioMediaTransport pacing', () => {
  it('sends the first frame immediately and paces the rest at 20 ms', () => {
    const h = harness();
    h.transport.enqueueMulaw(bytes(480));
    // 480 bytes = three 160-byte frames: first immediate, rest paced.
    assert.equal(h.socket.media().length, 1);
    h.clock.advance(19);
    assert.equal(h.socket.media().length, 1);
    h.clock.advance(1);
    assert.equal(h.socket.media().length, 2);
    h.clock.advance(20);
    assert.equal(h.socket.media().length, 3);
    h.transport.close('test');
  });

  it('reports each frame as it plays, in order, as the outbound reference', () => {
    const played: Buffer[] = [];
    const h = harness({ onFrameSent: (frame) => played.push(Buffer.from(frame)) });
    h.transport.enqueueMulaw(bytes(480));
    // The pump sends the first frame immediately; the rest are paced.
    assert.equal(played.length, 1);
    h.clock.advance(40);
    assert.equal(played.length, 3);
    assert.deepEqual(played, h.socket.media().map((frame) => Buffer.from(frame)));
    h.transport.close('test');
  });

  it('preserves every byte in order across arbitrary chunk sizes', () => {
    const h = harness();
    const input = bytes(1000, 7);
    h.transport.enqueueMulaw(input.subarray(0, 333));
    h.transport.enqueueMulaw(input.subarray(333, 334));
    h.transport.enqueueMulaw(input.subarray(334));
    h.clock.advance(20_000);
    const out = Buffer.concat(h.socket.media());
    assert.equal(out.length, input.length);
    assert.deepEqual(out, input);
    h.transport.close('test');
  });

  it('merges a small chunk into an unsent partial frame', () => {
    const h = harness();
    h.transport.enqueueMulaw(bytes(500));
    // 500 bytes: first 160 sent immediately, queue holds [160, 160, 20].
    h.transport.enqueueMulaw(bytes(100, 9));
    h.clock.advance(20_000);
    const out = Buffer.concat(h.socket.media());
    assert.equal(out.length, 600);
    assert.equal(h.socket.media().length, 4, 'frames: 160 + 160 + 160 + 120');
    h.transport.close('test');
  });

  it('bounds a late catch-up burst instead of dumping a delayed reply', () => {
    const h = harness();
    h.transport.enqueueMulaw(bytes(1600));
    assert.equal(h.socket.media().length, 1, 'first frame immediate');
    h.clock.wakeLate(1000);
    assert.ok(h.socket.media().length <= 6, `burst bounded, saw ${h.socket.media().length}`);
    h.transport.close('test');
  });

  it('rejects enqueues after close', () => {
    const h = harness();
    h.transport.close('done');
    assert.throws(() => h.transport.enqueueMulaw(bytes(160)), /transport-closed/);
  });
});

describe('TwilioMediaTransport marks', () => {
  it('places the mark behind already queued audio and resolves on ack', async () => {
    const h = harness();
    h.transport.enqueueMulaw(bytes(480));
    const pending = h.transport.finishPlayback(7);
    assert.deepEqual(h.socket.marks(), [], 'no mark while two frames are still local');
    h.clock.advance(40);
    assert.deepEqual(h.socket.marks(), ['reply-7-mark-1']);
    h.transport.receiveMark('reply-7-mark-1');
    const result = await pending;
    assert.deepEqual(result, { outcome: 'played', mark: 'reply-7-mark-1' });
    h.transport.close('test');
  });

  it('sends the mark synchronously when no audio is queued', async () => {
    const h = harness();
    const pending = h.transport.finishPlayback(1);
    assert.deepEqual(h.socket.marks(), ['reply-1-mark-1']);
    h.transport.receiveMark('reply-1-mark-1');
    assert.equal((await pending).outcome, 'played');
    h.transport.close('test');
  });

  it('does not let audio enqueued after a barrier delay its mark', async () => {
    const h = harness();
    h.transport.enqueueMulaw(bytes(160));
    const first = h.transport.finishPlayback(1);
    h.transport.enqueueMulaw(bytes(320));
    const second = h.transport.finishPlayback(2);
    assert.deepEqual(h.socket.marks(), ['reply-1-mark-1'], 'first barrier mark goes out once its own frames have sent');
    h.clock.advance(100);
    assert.deepEqual(h.socket.marks(), ['reply-1-mark-1', 'reply-2-mark-2']);
    h.transport.receiveMark('reply-1-mark-1');
    h.transport.receiveMark('reply-2-mark-2');
    assert.equal((await first).outcome, 'played');
    assert.equal((await second).outcome, 'played');
    h.transport.close('test');
  });
});

describe('TwilioMediaTransport clears', () => {
  it('settles a pending barrier as cleared and drops queued audio', async () => {
    const h = harness();
    h.transport.enqueueMulaw(bytes(320));
    const pending = h.transport.finishPlayback(3);
    h.transport.clearPlayback('caller-barge-in');
    assert.deepEqual(await pending, { outcome: 'cleared', mark: 'reply-3-mark-1', reason: 'caller-barge-in' });
    h.clock.advance(1000);
    assert.equal(h.socket.events().includes('clear'), true);
    assert.equal(h.socket.media().length, 1, 'only the already-sent frame remains');
    h.transport.close('test');
  });

  it('settles a mark sent but not yet acknowledged as cleared', async () => {
    const h = harness();
    const pending = h.transport.finishPlayback(4);
    assert.deepEqual(h.socket.marks(), ['reply-4-mark-1']);
    h.transport.clearPlayback('caller-barge-in');
    assert.equal((await pending).outcome, 'cleared');
    h.transport.close('test');
  });

  it('ignores a late mark after a clear', async () => {
    const h = harness();
    const pending = h.transport.finishPlayback(5);
    h.transport.clearPlayback('caller-barge-in');
    h.transport.receiveMark('reply-5-mark-1');
    assert.equal((await pending).outcome, 'cleared');
    assert.equal(h.transport.stats.marksAcked, 0);
    h.transport.close('test');
  });

  it('still sends the next mark after a clear dropped queued audio', async () => {
    const h = harness();
    // The clear drops unsent frames; the next response's barrier must not wait
    // on frames that will never play.
    h.transport.enqueueMulaw(bytes(1600));
    assert.equal(h.socket.media().length, 1, 'first frame immediate');
    h.transport.clearPlayback('caller-barge-in');
    h.transport.enqueueMulaw(bytes(320));
    const pending = h.transport.finishPlayback(9);
    h.clock.advance(100);
    assert.deepEqual(h.socket.marks(), ['reply-9-mark-1'], 'the mark follows its own audio only');
    h.transport.receiveMark('reply-9-mark-1');
    assert.equal((await pending).outcome, 'played');
    h.transport.close('test');
  });

  it('clears and reports overflow past the queued-duration bound', () => {
    let overflow = '';
    const h = harness({ maxQueuedMs: 40, onOverflow: (reason) => (overflow = reason) });
    h.transport.enqueueMulaw(bytes(480));
    assert.equal(overflow, 'outbound-overflow');
    assert.equal(h.transport.stats.overflows, 1);
    assert.equal(h.socket.events().includes('clear'), true);
    assert.equal(h.transport.isPlaying, false);
    h.transport.close('test');
  });
});

describe('TwilioMediaTransport timeouts and close', () => {
  it('clears, settles, and reports a mark timeout', async () => {
    const fatal: string[] = [];
    const h = harness({ markTimeoutMs: 50, onFatal: (reason) => fatal.push(reason) });
    const pending = h.transport.finishPlayback(1);
    const result = await (async () => {
      h.clock.advance(50);
      return pending;
    })();
    assert.equal(result.outcome, 'cleared');
    assert.deepEqual(fatal, ['mark-timeout']);
    assert.equal(h.transport.stats.markTimeouts, 1);
    assert.equal(h.socket.events().includes('clear'), true);
    h.transport.close('test');
  });

  it('pauses the pump above the high-water mark and resumes below the low mark', () => {
    const h = harness({ highWaterBytes: 320, lowWaterBytes: 160 });
    h.socket.buffered = 1000;
    h.transport.enqueueMulaw(bytes(1600));
    assert.equal(h.socket.media().length, 0, 'pump paused before sending when the socket buffer is high');
    h.clock.advance(100);
    assert.equal(h.socket.media().length, 0);
    h.socket.buffered = 0;
    h.clock.advance(20);
    assert.ok(h.socket.media().length > 0, 'pump resumes below the low mark');
    assert.ok(h.transport.stats.backpressureEvents >= 1);
    h.transport.close('test');
  });

  it('rejects pending barriers when the transport closes', async () => {
    const h = harness();
    h.transport.enqueueMulaw(bytes(320));
    const pending = h.transport.finishPlayback(1);
    h.transport.close('socket-closed');
    await assert.rejects(() => pending, /transport-closed: socket-closed/);
  });

  it('traces first-frame, mark, backpressure, clear, and completion milestones', async () => {
    const events: TraceEvent[] = [];
    const h = harness({ highWaterBytes: 320, lowWaterBytes: 160, events });
    h.socket.buffered = 1000;
    h.transport.enqueueMulaw(bytes(160));
    h.socket.buffered = 0;
    h.clock.advance(20);
    const pending = h.transport.finishPlayback(2);
    h.socket.buffered = 0;
    h.clock.advance(20);
    h.transport.receiveMark('reply-2-mark-1');
    await pending;
    h.transport.clearPlayback('manual');
    h.transport.close('test');
    const names = events.map((e) => `${e.component}:${e.event}`);
    assert.ok(names.includes('twilio:backpressure-start'), JSON.stringify(names));
    assert.ok(names.includes('twilio:backpressure-end'));
    assert.ok(names.includes('twilio:first-outbound-sent'));
    assert.ok(names.includes('twilio:mark-sent'));
    assert.ok(names.includes('twilio:mark-ack'));
    assert.ok(names.includes('twilio:playback-complete'));
    assert.ok(names.includes('twilio:clear-sent'));
  });
});
