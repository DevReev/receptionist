import type { Vad } from '../src/endpoint.ts';
import type { StreamObserver, StreamSocket } from '../src/stream.ts';

/** 20 ms of 8 kHz mu-law, the Twilio media frame size. */
export const FRAME_BYTES = 160;
/** Audible caller audio: 0xFF is mu-law silence and can never be Caller speech. */
export const SPEECH_FRAME = Buffer.alloc(FRAME_BYTES, 0x11);
export const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff);

/** The frame bytes are the script: 0x11 is audible speech, 0xFF is silence. */
export const byteVad: Vad = {
  score: async (pcm) => (pcm.every((sample) => sample === 0) ? 0.05 : 0.9),
  reset: () => {},
};

/** In-memory stand-in for a Twilio Media Streams websocket. No network. */
export class FakeSocket implements StreamSocket {
  readonly sent: string[] = [];
  closedByServer = false;
  buffered = 0;
  private messageCb: ((data: string) => void) | null = null;
  private closeCb: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByServer = true;
  }

  bufferedAmount(): number {
    return this.buffered;
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
  customParameters?: Record<string, string>;
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

export function twilioMedia(payloadB64: string, opts: { chunk?: number; timestampMs?: number } = {}): unknown {
  return {
    event: 'media',
    media: {
      payload: payloadB64,
      ...(opts.chunk !== undefined ? { chunk: opts.chunk } : {}),
      ...(opts.timestampMs !== undefined ? { timestamp: opts.timestampMs } : {}),
    },
  };
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
