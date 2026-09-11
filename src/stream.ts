import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';

export interface StreamIdentity {
  callSid: string;
  streamSid: string;
}

export interface StreamObserver {
  onAudio(identity: StreamIdentity, audio: Buffer, session?: StreamSession): void;
  onClose(identity: StreamIdentity, reason: string, session?: StreamSession): void;
  /** Fired once when the start frame assigns call identity; greeting hook. */
  onOpen?(identity: StreamIdentity, session?: StreamSession): void;
}

/** Minimal surface a media-stream socket must provide; real and fake sockets both fit. */
export interface StreamSocket {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
}

/** One call's bidirectional audio session. Driven by parsed inbound events. */
export class StreamSession {
  private identity: StreamIdentity | null = null;
  private closed = false;
  private readonly send: (data: string) => void;
  private readonly observer: StreamObserver;

  constructor(send: (data: string) => void, observer: StreamObserver) {
    this.send = send;
    this.observer = observer;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  open(identity: StreamIdentity): void {
    if (this.closed) return;
    this.identity = identity;
    this.observer.onOpen?.(identity, this);
  }

  receiveAudio(audio: Buffer): void {
    if (this.closed || !this.identity) return;
    this.observer.onAudio(this.identity, audio, this);
  }

  sendAudio(audio: Buffer): void {
    if (this.closed) throw new Error('stream-closed');
    if (!this.identity) throw new Error('stream-not-started');
    this.send(
      JSON.stringify({
        event: 'media',
        streamSid: this.identity.streamSid,
        media: { payload: audio.toString('base64') },
      }),
    );
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    // Notify even before start so the endpoint always releases the session.
    this.observer.onClose(this.identity ?? { callSid: 'unknown', streamSid: 'unknown' }, reason, this);
  }
}

interface TwilioFrame {
  event?: unknown;
  start?: { callSid?: unknown; streamSid?: unknown };
  streamSid?: unknown;
  media?: { payload?: unknown };
}

function asIdentity(frame: TwilioFrame): StreamIdentity | null {
  const callSid = frame.start?.callSid;
  const streamSid = frame.start?.streamSid ?? frame.streamSid;
  if (typeof callSid === 'string' && typeof streamSid === 'string') return { callSid, streamSid };
  return null;
}

/** Feeds parsed Twilio Media Streams frames from any socket into a session. */
export function attachStreamSocket(socket: StreamSocket, observer: StreamObserver): StreamSession {
  const session = new StreamSession((data) => socket.send(data), observer);
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
      const identity = asIdentity(frame);
      if (identity) session.open(identity);
      return;
    }
    if (frame.event === 'media') {
      const payload = frame.media?.payload;
      if (typeof payload === 'string' && payload.length > 0) {
        session.receiveAudio(Buffer.from(payload, 'base64'));
      }
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
      const session = attachStreamSocket(toStreamSocket(ws), {
        onAudio: (identity, audio, sess) => observer.onAudio(identity, audio, sess ?? session),
        onOpen: (identity, sess) => observer.onOpen?.(identity, sess ?? session),
        onClose: (identity, reason, sess) => {
          sessions.delete(session);
          observer.onClose(identity, reason, sess ?? session);
        },
      });
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
