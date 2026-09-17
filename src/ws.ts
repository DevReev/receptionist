import { WebSocket } from 'ws';

/** Minimal websocket surface so tests can drive a session without a network. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}

export type RealtimeSocketFactory = (url: string, headers: Record<string, string>) => RealtimeSocket;

export function defaultSocket(url: string, headers: Record<string, string>): RealtimeSocket {
  const ws = new WebSocket(url, { headers });
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (cb) => ws.on('open', cb),
    onMessage: (cb) => ws.on('message', (data: unknown) => cb(String(data))),
    onClose: (cb) => ws.on('close', (code: number, reason: Buffer) => cb(code, reason.toString())),
    onError: (cb) => ws.on('error', (err: Error) => cb(err)),
  };
}
