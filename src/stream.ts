import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { callerPhoneFrom } from './app.ts';
import {
  TwilioMediaTransport,
  type PlaybackResult,
  type TransportClock,
  type TransportSocket,
  type TwilioTransportStats,
} from './transport.ts';
import type { TraceFn } from './trace.ts';

export interface StreamIdentity {
  callSid: string;
  streamSid: string;
  /** The number the Caller is phoning from, passed as a `<Parameter>`; absent for blocked calls. */
  callerPhone?: string;
}

export interface StreamObserver {
  onAudio(identity: StreamIdentity, audio: Buffer, session?: StreamSession): void;
  onClose(identity: StreamIdentity, reason: string, session?: StreamSession): void;
  /** Fired once when the start frame assigns call identity; greeting hook. */
  onOpen?(identity: StreamIdentity, session?: StreamSession): void;
}

/** Minimal surface a media-stream socket must provide; real and fake sockets both fit. */
export interface StreamSocket extends TransportSocket {
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
}

/** Frame/byte counters for one media socket; the close trace reports these. */
export interface StreamStats {
  framesIn: number;
  bytesIn: number;
  framesOut: number;
  bytesOut: number;
  openedAt: number | null;
  durationMs: number;
}

/** One call's bidirectional audio session. Driven by parsed inbound events. */
export class StreamSession {
  private identity: StreamIdentity | null = null;
  private closed = false;
  private readonly socket: StreamSocket;
  private readonly observer: StreamObserver;
  private readonly traceFor?: (identity: StreamIdentity) => TraceFn;
  private readonly clock?: TransportClock;
  private transport: TwilioMediaTransport | null = null;
  private framesIn = 0;
  private bytesIn = 0;
  private framesOut = 0;
  private bytesOut = 0;
  private openedAt: number | null = null;

  constructor(
    socket: StreamSocket,
    observer: StreamObserver,
    options: { traceFor?: (identity: StreamIdentity) => TraceFn; clock?: TransportClock } = {},
  ) {
    this.socket = socket;
    this.observer = observer;
    this.traceFor = options.traceFor;
    this.clock = options.clock;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get currentIdentity(): StreamIdentity | null {
    return this.identity;
  }

  get isPlaying(): boolean {
    return this.transport?.isPlaying ?? false;
  }

  get stats(): StreamStats {
    return {
      framesIn: this.framesIn,
      bytesIn: this.bytesIn,
      framesOut: this.framesOut,
      bytesOut: this.bytesOut,
      openedAt: this.openedAt,
      durationMs: this.openedAt === null ? 0 : Date.now() - this.openedAt,
    };
  }

  get transportStats(): TwilioTransportStats | null {
    return this.transport?.stats ?? null;
  }

  open(identity: StreamIdentity): void {
    if (this.closed) return;
    this.identity = identity;
    this.openedAt = Date.now();
    this.transport = new TwilioMediaTransport({
      streamSid: identity.streamSid,
      socket: {
        send: (data) => this.socket.send(data),
        close: () => {},
        bufferedAmount: () => this.socket.bufferedAmount?.() ?? 0,
      },
      clock: this.clock,
      onTrace: this.traceFor?.(identity),
      onFatal: (reason) => this.close(`transport-fatal:${reason}`),
    });
    this.observer.onOpen?.(identity, this);
  }

  receiveAudio(audio: Buffer): void {
    if (this.closed || !this.identity) return;
    this.framesIn += 1;
    this.bytesIn += audio.length;
    this.observer.onAudio(this.identity, audio, this);
  }

  /** Queue playable 8 kHz mu-law for paced delivery to Twilio. */
  sendAudio(audio: Buffer): void {
    if (this.closed) throw new Error('stream-closed');
    if (!this.identity || !this.transport) throw new Error('stream-not-started');
    this.framesOut += 1;
    this.bytesOut += audio.length;
    this.transport.enqueueMulaw(audio);
  }

  /** Ordered barrier: resolves after all audio queued before now has played or been cleared. */
  finishPlayback(generation?: number): Promise<PlaybackResult> {
    if (this.closed) return Promise.reject(new Error('stream-closed'));
    if (!this.transport) return Promise.reject(new Error('stream-not-started'));
    return this.transport.finishPlayback(generation);
  }

  /** Resolve when Twilio confirms all media queued before this mark has played. */
  waitForPlayback(): Promise<void> {
    return this.finishPlayback().then((result) => {
      if (result.outcome === 'cleared') throw new Error(`playback-cleared: ${result.reason}`);
    });
  }

  clearPlayback(reason: string): void {
    this.transport?.clearPlayback(reason);
  }

  receiveMark(name: string): void {
    this.transport?.receiveMark(name);
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.transport?.close(reason);
    // Notify even before start so the endpoint always releases the session.
    this.observer.onClose(this.identity ?? { callSid: 'unknown', streamSid: 'unknown' }, reason, this);
  }
}

interface TwilioFrame {
  event?: unknown;
  start?: {
    callSid?: unknown;
    streamSid?: unknown;
    mediaFormat?: { encoding?: unknown; sampleRate?: unknown; channels?: unknown };
    customParameters?: { callerPhone?: unknown };
  };
  streamSid?: unknown;
  sequenceNumber?: unknown;
  media?: { payload?: unknown; chunk?: unknown; timestamp?: unknown };
  mark?: { name?: unknown };
}

const SUPPORTED_MEDIA_FORMAT = { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } as const;

function asIdentity(frame: TwilioFrame): StreamIdentity | null {
  const callSid = frame.start?.callSid;
  const streamSid = frame.start?.streamSid ?? frame.streamSid;
  if (typeof callSid !== 'string' || typeof streamSid !== 'string') return null;
  const callerPhone = callerPhoneFrom(frame.start?.customParameters?.callerPhone);
  return callerPhone ? { callSid, streamSid, callerPhone } : { callSid, streamSid };
}

/** Close and trace an unsupported media format instead of emitting corrupt audio. */
function mediaFormatError(frame: TwilioFrame): string | null {
  const format = frame.start?.mediaFormat;
  if (!format) return null;
  const encoding = format.encoding;
  const sampleRate = Number(format.sampleRate);
  const channels = Number(format.channels);
  if (encoding !== SUPPORTED_MEDIA_FORMAT.encoding || sampleRate !== SUPPORTED_MEDIA_FORMAT.sampleRate || channels !== SUPPORTED_MEDIA_FORMAT.channels) {
    return `unsupported-media-format:${String(encoding)}/${sampleRate}/${channels}`;
  }
  return null;
}

/** Feeds parsed Twilio Media Streams frames from any socket into a session. */
export function attachStreamSocket(
  socket: StreamSocket,
  observer: StreamObserver,
  options: { traceFor?: (identity: StreamIdentity) => TraceFn; clock?: TransportClock } = {},
): StreamSession {
  const session = new StreamSession(socket, observer, options);
  let lastChunk: number | null = null;
  let lastTimestampMs: number | null = null;
  const traceFrame = (event: string, fields: Record<string, unknown>): void => {
    const identity = session.currentIdentity ?? { callSid: 'unknown', streamSid: 'unknown' };
    options.traceFor?.(identity)({ component: 'twilio', event, ...fields });
  };
  socket.onMessage((data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const frame = parsed as TwilioFrame;
    if (frame.event === 'start') {
      const formatError = mediaFormatError(frame);
      if (formatError) {
        traceFrame('media-format-error', { detail: formatError });
        session.close(formatError);
        socket.close();
        return;
      }
      const identity = asIdentity(frame);
      if (identity) session.open(identity);
      return;
    }
    if (frame.event === 'media') {
      const payload = frame.media?.payload;
      if (typeof payload === 'string' && payload.length > 0) {
        // `media.chunk` is the media-frame counter; the connection-wide
        // `sequenceNumber` also counts marks, so it would false-positive.
        const chunk = Number(frame.media?.chunk);
        const timestampMs = Number(frame.media?.timestamp);
        if (Number.isInteger(chunk) && Number.isInteger(timestampMs) && chunk >= 0) {
          if (lastChunk !== null && chunk !== lastChunk + 1) {
            traceFrame('sequence-gap', {
              expected: lastChunk + 1,
              got: chunk,
              timestampDeltaMs: lastTimestampMs !== null ? timestampMs - lastTimestampMs : undefined,
            });
          }
          lastChunk = chunk;
          lastTimestampMs = timestampMs;
        }
        session.receiveAudio(Buffer.from(payload, 'base64'));
      }
      return;
    }
    if (frame.event === 'mark') {
      const name = frame.mark?.name;
      if (typeof name === 'string') session.receiveMark(name);
      return;
    }
    if (frame.event === 'stop') {
      session.close('stop');
      socket.close();
    }
    // connected and everything else: ignored.
  });
  socket.onClose(() => session.close('socket-closed'));
  return session;
}

export interface StreamEndpoint {
  sessions: Set<StreamSession>;
  close(): void;
}

function toStreamSocket(ws: WebSocket): StreamSocket {
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    bufferedAmount: () => ws.bufferedAmount,
    onMessage: (cb) => {
      ws.on('message', (data: unknown) => {
        cb(String(data));
      });
    },
    onClose: (cb) => {
      ws.on('close', () => {
        cb();
      });
    },
  };
}

/** Upgrades websocket hits on path to media-stream sessions tracked in `sessions`. */
export function attachStreamEndpoint(
  server: HttpServer,
  observer: StreamObserver,
  path = '/stream',
  options: { traceFor?: (identity: StreamIdentity) => TraceFn } = {},
): StreamEndpoint {
  const wss = new WebSocketServer({ noServer: true });
  const sessions = new Set<StreamSession>();
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = req.url ? new URL(req.url, 'http://localhost').pathname : '';
    if (pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = attachStreamSocket(
        toStreamSocket(ws),
        {
          onAudio: (identity, audio, sess) => observer.onAudio(identity, audio, sess ?? session),
          onOpen: (identity, sess) => observer.onOpen?.(identity, sess ?? session),
          onClose: (identity, reason, sess) => {
            sessions.delete(session);
            observer.onClose(identity, reason, sess ?? session);
          },
        },
        options,
      );
      sessions.add(session);
    });
  };
  server.on('upgrade', onUpgrade);
  return {
    sessions,
    close: () => {
      server.off('upgrade', onUpgrade);
      wss.close();
    },
  };
}
