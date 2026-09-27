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
  transcribe(audio: Buffer, contentType: string, signal?: AbortSignal): Promise<Transcription>;
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
  replyStream?(ctx: AssistantContext, signal?: AbortSignal): AsyncIterable<string>;
}

export interface AssistantEvent {
  /** 1-based LLM request this event belongs to; later rounds follow tool calls. */
  round: number;
  event: 'round-start' | 'first-token' | 'done' | 'empty-retry' | 'tool-done' | 'http-retry';
  ms?: number;
  /** Retry count for `http-retry` (1-based), before the attempt that follows. */
  attempt?: number;
  /** Tool name, for `tool-done`. */
  name?: string;
  /** Content characters produced in the round, for `done`. */
  chars?: number;
  /** Request shape, for `round-start`: message count, tool names, model. */
  messages?: number;
  tools?: string[];
  model?: string;
  availabilityChars?: number;
  /** HTTP status of the round's request. */
  status?: number;
  requestId?: string | null;
  /** Provider that actually served the round (OpenRouter routing). */
  provider?: string;
  /** Model the provider reported serving; may differ from the requested one. */
  servedModel?: string;
  /** Parsed SSE chunks in the round; zero means the stream was empty. */
  chunks?: number;
  /** `data:` lines seen in the round, including keep-alives and `[DONE]`. */
  sseLines?: number;
  /** `data:` payloads that were not valid JSON (format drift). */
  skippedLines?: number;
  /** Last `finish_reason` reported by the stream. */
  finish?: string | null;
  /** Reasoning/thinking characters the provider streamed (never spoken). */
  reasoningChars?: number;
  /** Tool calls requested in the round. */
  toolCalls?: number;
  usage?: { prompt?: number; completion?: number; total?: number } | null;
  /** Tool outcome, for `tool-done`. */
  ok?: boolean;
  resultChars?: number;
  /** Failure detail: HTTP body snippet, stream error, or `empty-completion`. */
  detail?: string;
  /** Raw tail of the stream, for empty rounds where the payload explains why. */
  lastChunk?: string;
}

export interface AssistantContext {
  transcript: string;
  history: ChatTurn[];
  guide: ClinicGuide;
  /**
   * The number the Caller is phoning from (Twilio `From`), when it is a real
   * number. The assistant confirms it before using it as the patient phone.
   */
  callerPhone?: string;
  /**
   * Live Availability block already fetched for this Turn. When present the
   * assistant answers straight from it and the `get_availability` tool is
   * withheld for the Turn; absent means it must ask for the read.
   */
  availability?: string;
  /** Stable opaque call id passed to OpenRouter as `session_id`. */
  sessionId?: string;
  /** Structured dialogue act for this Turn, when the controller decided one. */
  dialogueAct?: string;
  /** Compact Slot shortlist (2-4 lines) injected late in the prompt. */
  slotShortlist?: string[];
  /**
   * Controller-owned phases leave the model no tools; ambiguous migration
   * Turns may re-enable the read-only availability lookup explicitly.
   */
  allowAvailabilityTool?: boolean;
  /**
   * Speculation: generation started from a partial transcription, before the
   * Turn's final landed. Booking tools are withheld and nothing may be written.
   */
  speculative?: boolean;
  /** Per-round timing for the live loop's console trace. */
  onAssistantEvent?: (event: AssistantEvent) => void;
  /**
   * Live Availability block. Fetched only when the assistant decides it
   * needs it (booking intent), never on every Turn.
   */
  getAvailability: () => Promise<string>;
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
  location: string;
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
  /**
   * Call state shared by every loop that can observe a call: the inbound-call
   * webhook resets it, the legacy record loop reads it, and the Stream session
   * receives the same instance. One store per process, never one per loop.
   */
  calls: CallStore;
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
  /** Live Availability block for the assistant; defaults to the no-slots placeholder. */
  availability?: () => Promise<string>;
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
  /** Readiness gate: /healthz reports 503 until the streaming endpoint is usable. */
  isReady?: () => boolean;
}

export const TURN_ACTION = '/voice/turn';
export const RECORDING_STATUS_CALLBACK = '/voice/recording-status';

export function greetingFor(guide: ClinicGuide): string {
  return `Welcome to ${guide.name}. How can I help you today?`;
}

export const REPROMPT_LINE = "Sorry, I didn't catch that. Could you say that again?";
/** Spoken when the Caller stays silent after a question; paired with the last question asked. */
export const NO_RESPONSE_LINE = 'Are you still there?';
export const FAILURE_LINE = "Sorry, I'm having trouble with that. The clinic will confirm shortly.";
/** Spoken while the assistant is slow to answer, so the Caller does not hear dead air. */
export const HOLD_ASSISTANT_LINE = 'Let me check that for you.';
/** Distinct failure when the booking write fails, so the Caller knows which side failed. */
export const BOOKING_FAILURE_LINE =
  "Sorry, I'm having trouble reaching the booking system. The clinic will confirm shortly.";

export function goodbyeFor(guide: ClinicGuide): string {
  return `Thanks for calling ${guide.name}. Goodbye.`;
}

/**
 * Twilio `From` is E.164 for real Callers. Blocked or anonymous calls send
 * values like `anonymous`, which must never become a patient phone.
 */
export function callerPhoneFrom(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return /^\+[1-9]\d{6,14}$/.test(value) ? value : undefined;
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
  const calls = deps.calls;

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
    const ready = deps.isReady ? deps.isReady() : true;
    res.status(ready ? 200 : 503).type('text/plain').send(ready ? 'ok' : 'starting');
  });

  app.post('/voice/incoming', async (req: Request, res: Response) => {
    const callSid = String(req.body?.CallSid ?? 'unknown');
    calls.reset(callSid);
    if (deps.voiceLoop === 'stream') {
      const callerPhone = callerPhoneFrom(req.body?.From);
      sendTwiml(res, twiml(connectStream(deps.streamWsUrl, callerPhone ? { callerPhone } : {})));
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
    const callerPhone = callerPhoneFrom(req.body?.From);
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
        callerPhone,
        getAvailability: () =>
          deps.availability ? deps.availability() : Promise.resolve(availabilityPlaceholder()),
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
