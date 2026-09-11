import type { StreamObserver, StreamSocket } from '../src/stream.ts';

/** In-memory stand-in for a Twilio Media Streams websocket. No network. */
export class FakeSocket implements StreamSocket {
  readonly sent: string[] = [];
  closedByServer = false;
  private messageCb: ((data: string) => void) | null = null;
  private closeCb: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByServer = true;
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  /** Simulate a text frame arriving from the peer. */
  peerMessage(payload: unknown): void {
    this.messageCb?.(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  /** Simulate the peer hanging up the socket. */
  peerClose(): void {
    this.closeCb?.();
  }

  /** Outbound messages parsed as JSON. */
  sentJson(): unknown[] {
    return this.sent.map((s) => JSON.parse(s) as unknown);
  }
}

export interface TwilioStart {
  callSid: string;
  streamSid: string;
}

export function twilioConnected(): unknown {
  return { event: 'connected', protocol: 'Call', version: '1.0.0' };
}

export function twilioStart(start: TwilioStart): unknown {
  return {
    event: 'start',
    sequenceNumber: '1',
    start,
    streamSid: start.streamSid,
  };
}

export function twilioMedia(payloadB64: string): unknown {
  return { event: 'media', media: { payload: payloadB64 } };
}

export function twilioStop(): unknown {
  return { event: 'stop' };
}

export function recordingObserver(): StreamObserver & {
  audio: { callSid: string; bytes: number }[];
  closes: { callSid: string; reason: string }[];
} {
  const audio: { callSid: string; bytes: number }[] = [];
  const closes: { callSid: string; reason: string }[] = [];
  return {
    audio,
    closes,
    onAudio: (identity, chunk) => {
      audio.push({ callSid: identity.callSid, bytes: chunk.length });
    },
    onClose: (identity, reason) => {
      closes.push({ callSid: identity.callSid, reason });
    },
  };
}
