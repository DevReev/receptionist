import type { TraceFn } from './trace.ts';

export type PlaybackResult =
  | { outcome: 'played'; mark: string }
  | { outcome: 'cleared'; mark: string; reason: string };

/** Socket surface the transport needs; real and fake sockets both fit. */
export interface TransportSocket {
  send(data: string): void;
  close(): void;
  /** Bytes queued below the application layer (WebSocket `bufferedAmount`). */
  bufferedAmount?(): number;
}

export interface TransportClock {
  now(): number;
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface TwilioTransportStats {
  framesQueued: number;
  framesSent: number;
  bytesQueued: number;
  bytesSent: number;
  queuedMs: number;
  maxQueuedMs: number;
  bufferedAmount: number;
  backpressureEvents: number;
  backpressureMs: number;
  marksSent: number;
  marksAcked: number;
  clearsSent: number;
  overflows: number;
  markTimeouts: number;
  playing: boolean;
}

export interface TwilioMediaTransportOptions {
  streamSid: string;
  socket: TransportSocket;
  /** 20 ms of 8 kHz mu-law. */
  frameBytes?: number;
  bytesPerMs?: number;
  /** Pause the pump above this socket-buffer level; resume below the low mark. */
  highWaterBytes?: number;
  lowWaterBytes?: number;
  /** Bound local queued audio by duration; exceed it and the response is cleared. */
  maxQueuedMs?: number;
  markTimeoutMs?: number;
  /** Cap catch-up after a late pump wake; never dump a delayed reply in one go. */
  maxBurstFrames?: number;
  clock?: TransportClock;
  onTrace?: TraceFn;
  /** Fires for each media frame as it is sent, in playout order (the Echo reference). */
  onFrameSent?: (frame: Buffer) => void;
  /** The active response exceeded the bounded queue; the producer must cancel. */
  onOverflow?: (reason: string) => void;
  /** Playback state can no longer be reconciled; the session should close the call. */
  onFatal?: (reason: string) => void;
}

interface Frame {
  data: Buffer;
  ms: number;
}

interface Barrier {
  /** Frames queued before this barrier; its mark may only go out past this index. */
  index: number;
  epoch: number;
  mark: string;
  generation: number;
  sent: boolean;
  settled: boolean;
  timer: unknown;
  resolve: (result: PlaybackResult) => void;
  reject: (err: Error) => void;
}

const DEFAULT_FRAME_BYTES = 160;
const DEFAULT_BYTES_PER_MS = 8;
const DEFAULT_HIGH_WATER_BYTES = 16_000;
const DEFAULT_LOW_WATER_BYTES = 4_000;
const DEFAULT_MAX_QUEUED_MS = 30_000;
const DEFAULT_MARK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BURST_FRAMES = 5;
const PUMP_INTERVAL_MS = 20;

const realClock: TransportClock = {
  now: () => Date.now(),
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const defaultTrace: TraceFn = () => {};

/**
 * Paced, bounded outbound media for one Twilio Media Stream. Audio is split
 * into 20 ms frames, sent against monotonic deadlines by one pump, and backed
 * by socket backpressure and a duration-bounded local queue. `finishPlayback`
 * is an ordered barrier: it resolves once every frame queued before it has
 * played or been cleared.
 */
export class TwilioMediaTransport {
  private readonly streamSid: string;
  private readonly socket: TransportSocket;
  private readonly clock: TransportClock;
  private readonly trace: TraceFn;
  private readonly onFrameSent?: (frame: Buffer) => void;
  private readonly frameBytes: number;
  private readonly bytesPerMs: number;
  private readonly highWaterBytes: number;
  private readonly lowWaterBytes: number;
  private readonly maxQueuedMs: number;
  private readonly markTimeoutMs: number;
  private readonly maxBurstFrames: number;
  private readonly onOverflow?: (reason: string) => void;
  private readonly onFatal?: (reason: string) => void;
  private queue: Frame[] = [];
  private pendingBarriers: Barrier[] = [];
  private awaiting = new Map<string, Barrier>();
  private timer: unknown = null;
  private nextSendAt: number | null = null;
  private paused = false;
  private backpressureStartedAt: number | null = null;
  private closed = false;
  private epoch = 0;
  private markSeq = 0;
  private framesQueuedTotal = 0;
  private framesSentTotal = 0;
  private framesSent = 0;
  private bytesSent = 0;
  private framesQueued = 0;
  private bytesQueued = 0;
  private maxQueuedDurationMs = 0;
  private buffered = 0;
  private backpressureEvents = 0;
  private backpressureMs = 0;
  private marksSent = 0;
  private marksAcked = 0;
  private clearsSent = 0;
  private overflows = 0;
  private markTimeouts = 0;

  constructor(opts: TwilioMediaTransportOptions) {
    this.streamSid = opts.streamSid;
    this.socket = opts.socket;
    this.clock = opts.clock ?? realClock;
    this.trace = opts.onTrace ?? defaultTrace;
    this.onFrameSent = opts.onFrameSent;
    this.frameBytes = opts.frameBytes ?? DEFAULT_FRAME_BYTES;
    this.bytesPerMs = opts.bytesPerMs ?? DEFAULT_BYTES_PER_MS;
    this.highWaterBytes = opts.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
    this.lowWaterBytes = opts.lowWaterBytes ?? DEFAULT_LOW_WATER_BYTES;
    this.maxQueuedMs = opts.maxQueuedMs ?? DEFAULT_MAX_QUEUED_MS;
    this.markTimeoutMs = opts.markTimeoutMs ?? DEFAULT_MARK_TIMEOUT_MS;
    this.maxBurstFrames = opts.maxBurstFrames ?? DEFAULT_MAX_BURST_FRAMES;
    this.onOverflow = opts.onOverflow;
    this.onFatal = opts.onFatal;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get isPlaying(): boolean {
    return this.queue.length > 0 || this.pendingBarriers.length > 0 || this.awaiting.size > 0;
  }

  get stats(): TwilioTransportStats {
    return {
      framesQueued: this.framesQueued,
      framesSent: this.framesSent,
      bytesQueued: this.bytesQueued,
      bytesSent: this.bytesSent,
      queuedMs: this.queuedMs(),
      maxQueuedMs: this.maxQueuedDurationMs,
      bufferedAmount: this.buffered,
      backpressureEvents: this.backpressureEvents,
      backpressureMs: this.backpressureMs,
      marksSent: this.marksSent,
      marksAcked: this.marksAcked,
      clearsSent: this.clearsSent,
      overflows: this.overflows,
      markTimeouts: this.markTimeouts,
      playing: this.isPlaying,
    };
  }

  /** Queue playable 8 kHz mu-law bytes; no-op after close. */
  enqueueMulaw(audio: Buffer): void {
    if (this.closed) throw new Error('transport-closed');
    if (audio.length === 0) return;
    const pieces: Buffer[] = [audio];
    const tail = this.queue.at(-1);
    if (tail && tail.data.length < this.frameBytes) {
      const head = pieces.shift()!;
      const room = this.frameBytes - tail.data.length;
      const take = Math.min(room, head.length);
      tail.data = Buffer.concat([tail.data, head.subarray(0, take)]);
      tail.ms = tail.data.length / this.bytesPerMs;
      this.bytesQueued += take;
      if (take < head.length) pieces.unshift(head.subarray(take));
    }
    for (const piece of pieces) {
      let offset = 0;
      while (offset < piece.length) {
        const chunk = Buffer.from(piece.subarray(offset, offset + this.frameBytes));
        offset += chunk.length;
        this.queue.push({ data: chunk, ms: chunk.length / this.bytesPerMs });
        this.framesQueued += 1;
        this.bytesQueued += chunk.length;
        this.framesQueuedTotal += 1;
      }
    }
    const duration = this.queuedMs();
    if (duration > this.maxQueuedDurationMs) this.maxQueuedDurationMs = duration;
    if (duration > this.maxQueuedMs) {
      this.overflows += 1;
      this.log('outbound-overflow', { queuedMs: duration, limitMs: this.maxQueuedMs });
      this.onOverflow?.('outbound-overflow');
      this.clearPlayback('outbound-overflow');
      return;
    }
    this.pump();
  }

  /**
   * Ordered playback barrier: resolves after all audio enqueued before this
   * call has either played (`played`) or been cleared (`cleared`).
   */
  finishPlayback(generation = 0): Promise<PlaybackResult> {
    if (this.closed) return Promise.reject(new Error('transport-closed'));
    return new Promise<PlaybackResult>((resolve, reject) => {
      this.pendingBarriers.push({
        index: this.framesQueuedTotal,
        epoch: this.epoch,
        mark: `reply-${generation}-mark-${++this.markSeq}`,
        generation,
        sent: false,
        settled: false,
        timer: null,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  /** Drop queued audio and settle outstanding barriers as `cleared`. Idempotent per response. */
  clearPlayback(reason: string): void {
    if (this.closed) return;
    this.epoch += 1;
    this.queue = [];
    this.nextSendAt = null;
    // Dropped frames will never be sent, and every barrier that referenced
    // them has just been settled: align the sent counter so a barrier created
    // after this clear can still be reached by its own frames.
    this.framesSentTotal = this.framesQueuedTotal;
    const pending = this.pendingBarriers;
    this.pendingBarriers = [];
    for (const barrier of pending) this.settleCleared(barrier, reason);
    for (const barrier of this.awaiting.values()) {
      this.clearBarrierTimer(barrier);
      this.settleCleared(barrier, reason);
    }
    this.awaiting.clear();
    this.clearsSent += 1;
    this.log('clear-sent', { reason });
    try {
      this.socket.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    } catch {
      // The socket is gone; close() is the release path.
    }
  }

  /** Twilio mark acknowledgement; unknown, late, and stale marks are ignored. */
  receiveMark(name: string): void {
    const barrier = this.awaiting.get(name);
    if (!barrier) {
      this.log('mark-unknown', { mark: name });
      return;
    }
    this.awaiting.delete(name);
    this.clearBarrierTimer(barrier);
    if (barrier.settled || barrier.epoch !== this.epoch) {
      this.log('mark-late', { mark: name });
      return;
    }
    barrier.settled = true;
    this.marksAcked += 1;
    this.log('mark-ack', { mark: name });
    this.log('playback-complete', { mark: name });
    barrier.resolve({ outcome: 'played', mark: name });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
    this.queue = [];
    const err = new Error(`transport-closed: ${reason}`);
    const pending = this.pendingBarriers;
    this.pendingBarriers = [];
    for (const barrier of pending) {
      this.clearBarrierTimer(barrier);
      if (!barrier.settled) {
        barrier.settled = true;
        barrier.reject(err);
      }
    }
    for (const barrier of this.awaiting.values()) {
      this.clearBarrierTimer(barrier);
      if (!barrier.settled) {
        barrier.settled = true;
        barrier.reject(err);
      }
    }
    this.awaiting.clear();
    this.log('transport-close', { reason });
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.trace({ component: 'twilio', event, ...fields });
  }

  private queuedMs(): number {
    let ms = 0;
    for (const frame of this.queue) ms += frame.ms;
    return ms;
  }

  private settleCleared(barrier: Barrier, reason: string): void {
    if (barrier.settled) return;
    barrier.settled = true;
    this.log('playback-cleared', { mark: barrier.mark, reason });
    barrier.resolve({ outcome: 'cleared', mark: barrier.mark, reason });
  }

  private clearBarrierTimer(barrier: Barrier): void {
    if (barrier.timer === null) return;
    this.clock.clearTimer(barrier.timer);
    barrier.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.closed || this.timer !== null) return;
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, delayMs));
  }

  private pump(): void {
    if (this.closed) return;
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
    const buffered = this.socket.bufferedAmount?.() ?? 0;
    this.buffered = buffered;
    if (!this.paused && buffered >= this.highWaterBytes) {
      this.paused = true;
      this.backpressureEvents += 1;
      this.backpressureStartedAt = this.clock.now();
      this.log('backpressure-start', { bufferedAmount: buffered });
    } else if (this.paused && buffered <= this.lowWaterBytes) {
      this.paused = false;
      if (this.backpressureStartedAt !== null) {
        this.backpressureMs += this.clock.now() - this.backpressureStartedAt;
        this.backpressureStartedAt = null;
      }
      this.log('backpressure-end', { bufferedAmount: buffered });
    }
    if (this.paused) {
      this.schedule(PUMP_INTERVAL_MS);
      return;
    }
    let burst = 0;
    while (this.queue.length > 0 && burst < this.maxBurstFrames) {
      const now = this.clock.now();
      if (this.nextSendAt === null) this.nextSendAt = now;
      if (now < this.nextSendAt) break;
      const frame = this.queue.shift()!;
      this.sendFrame(frame);
      this.nextSendAt += frame.ms;
      burst += 1;
    }
    if (this.queue.length > 0) {
      const now = this.clock.now();
      let delay = (this.nextSendAt ?? now) - now;
      if (delay <= 0) {
        // Fell behind schedule (blocked event loop): resync rather than
        // accumulate debt, so delayed audio is not dumped into playback.
        this.nextSendAt = now;
        delay = PUMP_INTERVAL_MS;
      }
      this.schedule(delay);
      return;
    }
    this.nextSendAt = null;
    this.processBarriers();
  }

  private processBarriers(): void {
    while (this.pendingBarriers.length > 0) {
      const barrier = this.pendingBarriers[0]!;
      if (barrier.index > this.framesSentTotal) break;
      this.pendingBarriers.shift();
      this.sendMark(barrier);
    }
  }

  private sendMark(barrier: Barrier): void {
    barrier.sent = true;
    this.awaiting.set(barrier.mark, barrier);
    barrier.timer = this.clock.setTimer(() => {
      barrier.timer = null;
      this.onMarkTimeout(barrier);
    }, this.markTimeoutMs);
    this.marksSent += 1;
    this.log('mark-sent', { mark: barrier.mark, generation: barrier.generation });
    try {
      this.socket.send(
        JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: barrier.mark } }),
      );
    } catch (err) {
      this.log('send-error', { detail: err instanceof Error ? err.message : String(err) });
      this.close('send-error');
    }
  }

  private onMarkTimeout(barrier: Barrier): void {
    if (barrier.settled || this.closed) return;
    this.markTimeouts += 1;
    this.log('mark-timeout', {
      mark: barrier.mark,
      queuedMs: this.queuedMs(),
      bufferedAmount: this.buffered,
    });
    this.clearPlayback('mark-timeout');
    this.onFatal?.('mark-timeout');
  }

  private sendFrame(frame: Frame): void {
    try {
      this.socket.send(
        JSON.stringify({
          event: 'media',
          streamSid: this.streamSid,
          media: { payload: frame.data.toString('base64') },
        }),
      );
    } catch (err) {
      this.log('send-error', { detail: err instanceof Error ? err.message : String(err) });
      this.close('send-error');
      return;
    }
    this.framesSent += 1;
    this.bytesSent += frame.data.length;
    this.framesSentTotal += 1;
    this.onFrameSent?.(frame.data);
    if (this.framesSent === 1) this.log('first-outbound-sent', { bytes: frame.data.length });
  }
}
