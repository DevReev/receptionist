export type { ChatTurn } from './calls.ts';
export type { ClinicGuide } from './clinic.ts';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { loadClinicGuide, type ClinicGuide } from './clinic.ts';
import { CallStore, type ChatTurn } from './calls.ts';
import { verifyTwilioSignature } from './signature.ts';
import { hangup, connectStream, recordTurn, say, twiml } from './twiml.ts';
import type { VoiceLoop } from './config.ts';

export interface Transcription {
  text: string;
  noSpeech: boolean;
}

export interface Transcriber {
  transcribe(audio: Buffer, contentType: string): Promise<Transcription>;
}

export interface AssistantReply {
  text: string;
  endCall: boolean;
}

export interface Assistant {
  reply(ctx: AssistantContext): Promise<AssistantReply>;
  /**
   * Token stream of the final spoken reply. Handles the single
   * `propose_booking` tool internally (same single-attempt rule as
   * `reply`) and yields only speakable text. The live Stream session
   * prefers this when present and falls back to `reply` otherwise.
   */
  replyStream?(ctx: AssistantContext): AsyncIterable<string>;
}

export interface AssistantContext {
  transcript: string;
  history: ChatTurn[];
  guide: ClinicGuide;
  availability: string;
  proposeBooking: (slot: ProposedSlot) => Promise<BookingOutcome>;
}

export interface Recording {
  audio: Buffer;
  contentType: string;
}

export interface RecordingFetcher {
  /** Returns null when the recording is not readable yet (Twilio action-vs-media race). */
  fetch(url: string): Promise<Recording | null>;
}
export type FailureReason = 'save-failed' | 'low-confidence' | 'unknown-question' | 'phone-fallback';

export interface CallIdentity {
  callSid: string;
  turn: number;
  excerpt: string;
}

export interface FailureEvent extends CallIdentity {
  reason: FailureReason;
  detail?: string;
}

export interface TurnEvent extends CallIdentity {
  reply: string;
  endCall: boolean;
  miss: boolean;
}
export interface ProposedSlot {
  service: string;
  date: string;
  time: string;
  callerName: string;
  callerPhone: string;
}

export type BookingOutcome = { ok: true } | { ok: false; reason: string };

export interface AppDeps {
  guidePath: string;
  sayVoice: string;
  sayLanguage: string;
  recordTimeout?: number;
  recordMaxLength?: number;
  /** Selects the voice loop: legacy record-based Turns, or a live Stream session. */
  voiceLoop: VoiceLoop;
  /** Public websocket URL Twilio connects to in streaming mode. */
  streamWsUrl: string;
  /** When set, every /voice webhook must carry a valid Twilio signature. Unset = dev mode. */
  twilioAuthToken?: string;
  transcriber: Transcriber;
  assistant: Assistant;
  recordingFetcher: RecordingFetcher;
  logFailure: (event: FailureEvent) => void;
  onProposeBooking: (args: {
    callSid: string;
    turn: number;
    excerpt: string;
    slot: ProposedSlot;
  }) => Promise<BookingOutcome>;
  /** Per-turn outcome log; optional so tests stay quiet unless they opt in. */
  logTurn?: (event: TurnEvent) => void;
}

export const TURN_ACTION = '/voice/turn';
export const RECORDING_STATUS_CALLBACK = '/voice/recording-status';

export function greetingFor(guide: ClinicGuide): string {
  return `Welcome to ${guide.name}. How can I help you today?`;
}

export const REPROMPT_LINE = "Sorry, I didn't catch that. Could you say that again?";
export const FAILURE_LINE = "Sorry, I'm having trouble with that. The clinic will confirm shortly.";

export function goodbyeFor(guide: ClinicGuide): string {
  return `Thanks for calling ${guide.name}. Goodbye.`;
}

/** Placeholder until the Picktime availability ticket lands: no slots known, model must not offer times. */
export function availabilityPlaceholder(): string {
  return (
    `AVAILABILITY (fetched ${new Date().toISOString()} — only these slots exist)\n` +
    '- availability lookup is not connected yet: no slots known. Do not offer any times.'
  );
}

function errorDetail(prefix: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${msg}`;
}


export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.urlencoded({ extended: false }));
  const calls = new CallStore();

  if (deps.twilioAuthToken) {
    const authToken = deps.twilioAuthToken;
    app.use('/voice', (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'POST') {
        next();
        return;
      }
      const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.body ?? {})) {
        if (typeof value === 'string') params[key] = value;
      }
      const signature = req.header('X-Twilio-Signature') ?? '';
      if (!verifyTwilioSignature(authToken, url, params, signature)) {
        res.status(403).type('text/plain').send('forbidden');
        return;
      }
      next();
    });
  }
  const voiceOpts = { voice: deps.sayVoice, language: deps.sayLanguage };

  function listenAgain(): string {
    return recordTurn({
      ...voiceOpts,
      action: TURN_ACTION,
      statusCallback: RECORDING_STATUS_CALLBACK,
      timeout: deps.recordTimeout ?? 5,
      maxLength: deps.recordMaxLength ?? 30,
    });
  }

  function sendTwiml(res: Response, body: string): void {
    res.type('text/xml').send(body);
  }

  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  app.post('/voice/incoming', async (req: Request, res: Response) => {
    const callSid = String(req.body?.CallSid ?? 'unknown');
    calls.reset(callSid);
    if (deps.voiceLoop === 'stream') {
      sendTwiml(res, twiml(connectStream(deps.streamWsUrl)));
      return;
    }
    const guide = await loadClinicGuide(deps.guidePath);
    sendTwiml(res, twiml(say(greetingFor(guide), voiceOpts), listenAgain()));
  });
  app.post(TURN_ACTION, async (req: Request, res: Response) => {
    const callSid = String(req.body?.CallSid ?? 'unknown');
    const state = calls.get(callSid);
    state.turn += 1;
    const guide = await loadClinicGuide(deps.guidePath);

    const emitTurn = (excerpt: string, reply: string, endCall: boolean, miss: boolean): void => {
      deps.logTurn?.({ callSid, turn: state.turn, excerpt, reply, endCall, miss });
    };

    const miss = (excerpt: string, detail?: string): void => {
      state.misses += 1;
      if (state.misses <= 1) {
        emitTurn(excerpt, REPROMPT_LINE, false, true);
        sendTwiml(res, twiml(say(REPROMPT_LINE, voiceOpts), listenAgain()));
        return;
      }
      deps.logFailure({ callSid, turn: state.turn, reason: 'low-confidence', excerpt, detail });
      emitTurn(excerpt, goodbyeFor(guide), true, true);
      sendTwiml(res, twiml(say(goodbyeFor(guide), voiceOpts), hangup()));
    };
    const recordingUrl = req.body?.RecordingUrl ? String(req.body.RecordingUrl) : '';
    if (!recordingUrl) {
      miss('');
      return;
    }
    let rec: Recording | null;
    try {
      rec = await deps.recordingFetcher.fetch(recordingUrl);
    } catch (err) {
      miss('', errorDetail('recording-fetch-error', err));
      return;
    }
    if (!rec) {
      miss('', 'recording-not-ready');
      return;
    }
    let tx: Transcription;
    try {
      tx = await deps.transcriber.transcribe(rec.audio, rec.contentType);
    } catch (err) {
      miss('', errorDetail('transcribe-error', err));
      return;
    }
    if (!tx.text.trim() || tx.noSpeech) {
      miss(tx.text);
      return;
    }
    state.misses = 0;
    calls.pushHistory(callSid, { role: 'caller', text: tx.text });
    let reply: AssistantReply;
    try {
      reply = await deps.assistant.reply({
        transcript: tx.text,
        history: [...state.history],
        guide,
        availability: availabilityPlaceholder(),
        proposeBooking: (slot) =>
          deps.onProposeBooking({ callSid, turn: state.turn, excerpt: tx.text, slot }),
      });
    } catch (err) {
      deps.logFailure({
        callSid,
        turn: state.turn,
        reason: 'low-confidence',
        excerpt: tx.text,
        detail: errorDetail('assistant-error', err),
      });
      emitTurn(tx.text, FAILURE_LINE, true, false);
      sendTwiml(res, twiml(say(FAILURE_LINE, voiceOpts), hangup()));
      return;
    }
    calls.pushHistory(callSid, { role: 'receptionist', text: reply.text });
    emitTurn(tx.text, reply.text, reply.endCall, false);
    if (reply.endCall) {
      sendTwiml(res, twiml(say(reply.text, voiceOpts), hangup()));
      return;
    }
    sendTwiml(res, twiml(say(reply.text, voiceOpts), listenAgain()));
  });

  app.post(RECORDING_STATUS_CALLBACK, (_req, res) => {
    res.sendStatus(200);
  });

  return app;
}
