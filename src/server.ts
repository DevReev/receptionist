import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BOOKING_FAILURE_LINE,
  createApp,
  FAILURE_LINE,
  greetingFor,
  goodbyeFor,
  HOLD_ASSISTANT_LINE,
  NO_RESPONSE_LINE,
  REPROMPT_LINE,
  type Assistant,
  type BookingOutcome,
  type FailureEvent,
  type ProposedSlot,
  type Transcriber,
  type TurnEvent,
} from './app.ts';
import { FallbackAssistant } from './assistantFallback.ts';
import { AppointmentsClient } from './appointments.ts';
import { CallStore } from './calls.ts';
import { deriveSttPrompt, loadClinicGuide, type ClinicGuide } from './clinic.ts';
import { loadConfig, type Config } from './config.ts';
import { LOCAL_ENDPOINT_FALLBACKS, type EndpointPolicy } from './endpoint.ts';
import { FixedAudioCache } from './fixedAudio.ts';
import { LiveCallSession } from './live.ts';
import { formatFailureLine } from './log.ts';
import { OpenRouterAssistant } from './openrouter.ts';
import { OpenRouterStt } from './openrouterStt.ts';
import { TwilioRecordingFetcher } from './recordings.ts';
import { SarvamTranscriber, SarvamTts } from './sarvam.ts';
import { SileroVad } from './sileroVad.ts';
import { SarvamRealtimeStt, type RealtimeStt } from './sarvamRealtime.ts';
import { OpenAiRealtimeStt } from './openaiRealtime.ts';
import { SarvamStreamingTts } from './sarvamStreamTts.ts';
import { attachStreamEndpoint } from './stream.ts';
import { traceToConsole, type TraceFn } from './trace.ts';
import { twilioCallEnds } from './twilioCalls.ts';
import { OpenAiTts, type Tts } from './tts.ts';
import { WhisperTranscriber } from './whisper.ts';

function createTranscriber(config: Config, trace?: TraceFn): Transcriber {
  if (config.sttProvider === 'sarvam') {
    const { apiKey, baseUrl, sttModel, sttLanguageCode, sttMode } = config.sarvam;
    return new SarvamTranscriber({
      stt: { apiKey, baseUrl, model: sttModel, languageCode: sttLanguageCode, mode: sttMode },
      onTrace: trace,
    });
  }
  if (config.sttProvider === 'openrouter') {
    // OpenRouter transcription is a completed-utterance request: no realtime
    // channel, so the session's local detector owns boundaries and every Turn
    // uploads its WAV here.
    return new OpenRouterStt({
      stt: { apiKey: config.llmApiKey, model: config.openrouterSttModel },
      onTrace: trace,
    });
  }
  return new WhisperTranscriber({ stt: config.stt, onTrace: trace });
}

/** REST-only speech: used for fixed-phrase prewarm and as the stream fallback. */
function createRestTts(config: Config, trace?: TraceFn): Tts {
  if (config.ttsProvider === 'sarvam') {
    const { apiKey, baseUrl, ttsModel, ttsSpeaker, ttsLanguageCode, ttsSampleRate } = config.sarvam;
    return new SarvamTts({
      tts: { apiKey, baseUrl, model: ttsModel, speaker: ttsSpeaker, languageCode: ttsLanguageCode, sampleRate: ttsSampleRate },
      onTrace: trace,
    });
  }
  return new OpenAiTts({
    apiKey: config.tts.apiKey,
    baseUrl: config.tts.baseUrl,
    model: config.tts.model,
    voice: config.tts.voice,
    responseFormat: config.tts.responseFormat,
    pcmSampleRate: config.tts.pcmSampleRate,
    onTrace: trace,
  });
}

/**
 * Per-call TTS. Sarvam prefers the text-to-speech WebSocket so chunks reach
 * the Caller while they are still being generated; the REST implementation
 * stays as the per-phrase fallback. OpenAI TTS streams the HTTP body.
 */
function createTts(config: Config, trace?: TraceFn): Tts {
  if (config.ttsProvider === 'sarvam') {
    const {
      apiKey,
      baseUrl,
      ttsModel,
      ttsSpeaker,
      ttsLanguageCode,
      ttsStream,
      ttsStreamIdleTimeoutMs,
      ttsMinBufferSize,
      ttsMaxChunkLength,
    } = config.sarvam;
    const rest = createRestTts(config, trace);
    if (!ttsStream) return rest;
    return new SarvamStreamingTts({
      config: {
        apiKey,
        baseUrl,
        model: ttsModel,
        speaker: ttsSpeaker,
        languageCode: ttsLanguageCode,
        idleTimeoutMs: ttsStreamIdleTimeoutMs,
        minBufferSize: ttsMinBufferSize,
        maxChunkLength: ttsMaxChunkLength,
      },
      fallback: rest,
      onTrace: trace,
    });
  }
  return createRestTts(config, trace);
}

/**
 * Per-call live STT channel: audio streams to Sarvam while the Caller speaks,
 * so a Turn reads its transcript at endpointing instead of posting the WAV.
 * Absent when another STT provider is selected, or realtime is turned off.
 */
function createRealtimeStt(config: Config, trace?: TraceFn, prompt?: string): RealtimeStt | undefined {
  if (config.sttProvider === 'openai-realtime') {
    // OpenAI's transcription session rejects server turn detection, so the
    // channel is manual: gated by the local detector, billed on appended audio.
    return new OpenAiRealtimeStt({
      config: {
        apiKey: config.openaiRealtime.apiKey,
        url: config.openaiRealtime.url,
        model: config.openaiRealtime.model,
        delay: config.openaiRealtime.delay,
        languages: config.openaiRealtime.languages,
        ...(prompt
          ? { keywords: prompt.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0) }
          : {}),
      },
      onTrace: trace,
    });
  }
  if (config.sttProvider !== 'sarvam' || !config.sarvam.sttRealtime) return undefined;
  const {
    apiKey,
    baseUrl,
    sttRealtimeModel,
    sttLanguageCode,
    sttStreamType,
    sttMode,
    sttFinalTimeoutMs,
    sttVadThreshold,
    sttVadSilenceMs,
    sttVadMinSpeechMs,
  } = config.sarvam;
  const endpointing = config.turnDetection === 'sarvam' ? 'vad' : 'manual';
  return new SarvamRealtimeStt({
    config: {
      apiKey,
      baseUrl,
      model: sttRealtimeModel,
      languageCode: sttLanguageCode,
      streamType: sttStreamType,
      mode: sttMode,
      encoding: 'mulaw',
      sampleRate: 8000,
      endpointing,
      ...(endpointing === 'vad'
        ? { vad: { threshold: sttVadThreshold, silenceMs: sttVadSilenceMs, minSpeechMs: sttVadMinSpeechMs } }
        : {}),
      finalTimeoutMs: sttFinalTimeoutMs,
      ...(prompt ? { prompt } : {}),
    },
    onTrace: trace,
  });
}

/**
 * Assistant LLM: Groq's gpt-oss-120b is the primary when a Groq key is
 * configured, with the OpenRouter model as the pre-token fallback. Without a
 * Groq key the OpenRouter model is the only assistant.
 */
function createAssistant(config: Config, tools: 'legacy' | 'phase'): Assistant {
  const openrouter = new OpenRouterAssistant({
    apiKey: config.llmApiKey,
    model: config.openrouterModel,
    temperature: config.openrouterTemperature,
    reasoningEffort: config.openrouterReasoningEffort,
    tools,
  });
  if (config.assistant.primary === 'openrouter') return openrouter;
  const groq = new OpenRouterAssistant({
    apiKey: config.assistant.groqApiKey,
    baseUrl: config.assistant.groqBaseUrl,
    model: config.assistant.groqModel,
    temperature: config.openrouterTemperature,
    reasoningEffort: config.assistant.groqReasoningEffort,
    openRouterRouting: false,
    tools,
  });
  return new FallbackAssistant({
    primary: groq,
    fallback: openrouter,
    onFallback: (detail) =>
      console.log(
        JSON.stringify({ ts: new Date().toISOString(), kind: 'trace', component: 'llm', event: 'fallback', detail }),
      ),
  });
}

function endpointPolicy(config: Config): EndpointPolicy {
  return {
    ...LOCAL_ENDPOINT_FALLBACKS,
    threshold: config.vadThreshold,
  };
}

/** Shared fixed-phrase cache identity; the key includes the provider voice. */
function createFixedCache(config: Config, trace?: TraceFn): FixedAudioCache {
  const identity =
    config.ttsProvider === 'sarvam'
      ? {
          model: config.sarvam.ttsModel,
          voice: config.sarvam.ttsSpeaker,
          language: config.sarvam.ttsLanguageCode,
          sampleRate: config.sarvam.ttsSampleRate,
        }
      : {
          model: config.tts.model,
          voice: config.tts.voice,
          language: config.sayLanguage,
          sampleRate: 8000,
        };
  return new FixedAudioCache({
    provider: config.ttsProvider,
    ...identity,
    encoding: 'mulaw',
    dir: config.fixedAudioCacheDir,
    onTrace: trace,
  });
}

/** Fixed, non-Patient speech eligible for the shared cache. */
export function fixedPhrases(guide: ClinicGuide): string[] {
  return [
    greetingFor(guide),
    goodbyeFor(guide),
    HOLD_ASSISTANT_LINE,
    NO_RESPONSE_LINE,
    REPROMPT_LINE,
    FAILURE_LINE,
    BOOKING_FAILURE_LINE,
  ];
}

async function prewarmFixedAudio(
  config: Config,
  guide: ClinicGuide,
  cache: FixedAudioCache,
  trace?: TraceFn,
): Promise<void> {
  const tts = createRestTts(config, trace);
  try {
    await cache.prewarm(
      fixedPhrases(guide),
      async (text) => (await tts.synthesize(text)).audio,
      config.fixedPrewarmMs,
    );
  } finally {
    tts.close?.();
  }
}

interface UtteranceCapture {
  onUtteranceAudio?: (entry: { callSid: string; turn: number; wav: Buffer }) => void;
  onUtteranceTranscribed?: (entry: { callSid: string; turn: number; text: string; wav: Buffer }) => void;
}

/**
 * Debug-only capture for benchmark fixtures: each utterance WAV lands with a
 * JSON sidecar carrying the transcript, so `npm run fixtures` can build the
 * bench pair. Captures contain Patient data and stay gitignored.
 */
function createUtteranceCapture(dir: string | undefined): UtteranceCapture {
  if (!dir) return {};
  mkdirSync(dir, { recursive: true });
  const stem = (callSid: string, turn: number): string => `${dir}/${callSid}-turn${turn}`;
  return {
    onUtteranceAudio: ({ callSid, turn, wav }) => {
      const path = `${stem(callSid, turn)}.wav`;
      writeFileSync(path, wav);
      console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'audio-dump', callSid, turn, path }));
    },
    onUtteranceTranscribed: ({ callSid, turn, text, wav }) => {
      writeFileSync(
        `${stem(callSid, turn)}.json`,
        JSON.stringify({ callSid, turn, text, bytes: wav.length, capturedAt: new Date().toISOString() }),
      );
    },
  };
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const bootTrace = traceToConsole({ component: 'boot' });
  let vadModel: SileroVad | undefined;
  let guide: ClinicGuide = { raw: '', name: 'the clinic' };
  let fixedCache: FixedAudioCache | undefined;
  if (config.voiceLoop === 'stream') {
    if (!existsSync(config.vadModelPath)) {
      throw new Error(`VAD model missing at ${config.vadModelPath}: run scripts/fetch-vad-model.sh`);
    }
    // Do not report the server ready until live calls can actually be handled.
    vadModel = await SileroVad.load(config.vadModelPath);
    try {
      guide = await loadClinicGuide(config.guidePath);
    } catch (err) {
      bootTrace({ component: 'boot', event: 'guide-load-error', detail: err instanceof Error ? err.message : String(err) });
    }
    fixedCache = createFixedCache(config, bootTrace);
    await fixedCache.loadFromDisk();
    await prewarmFixedAudio(config, guide, fixedCache, bootTrace);
    bootTrace({
      component: 'boot',
      event: 'cache-ready',
      entries: fixedCache.stats().entries,
      diskEntries: fixedCache.stats().diskEntries,
    });
  }
  const logFailure = (event: FailureEvent): void => {
    console.log(formatFailureLine(event));
  };
  const logTurn = (event: TurnEvent): void => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'turn', ...event }));
  };
  // One attempt per Turn, keyed by call+slot so a retried confirm replays the
  // same Booking instead of saving a second one.
  const appointments = new AppointmentsClient({
    appointments: config.appointments,
    onEvent: (event) => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
    },
  });
  const proposeBooking = async (args: {
    callSid: string;
    turn: number;
    excerpt: string;
    slot: ProposedSlot;
  }): Promise<BookingOutcome> => {
    // No patient name/phone in logs: identity stays in the Turn excerpt.
    const { service, location, date, time } = args.slot;
    const started = Date.now();
    console.log(
      JSON.stringify({ ts: new Date().toISOString(), kind: 'booking', event: 'start', callSid: args.callSid, turn: args.turn, service, location, date, time }),
    );
    const outcome = await appointments.book(args.slot, {
      idempotencyKey: `${args.callSid}:${args.slot.location}:${args.slot.date}T${args.slot.time}`,
    });
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'booking',
        event: 'outcome',
        callSid: args.callSid,
        turn: args.turn,
        ok: outcome.ok,
        reason: outcome.ok ? undefined : outcome.reason,
        ms: Date.now() - started,
      }),
    );
    if (!outcome.ok) {
      logFailure({
        callSid: args.callSid,
        turn: args.turn,
        reason: 'save-failed',
        excerpt: args.excerpt,
        detail: `booking-failed: ${outcome.reason}`,
      });
    }
    return outcome;
  };
  const readiness = { ready: config.voiceLoop !== 'stream' };
  const app = createApp({
    guidePath: config.guidePath,
    sayVoice: config.sayVoice,
    sayLanguage: config.sayLanguage,
    recordTimeout: config.recordTimeout,
    recordMaxLength: config.recordMaxLength,
    voiceLoop: config.voiceLoop,
    streamWsUrl: config.streamWsUrl,
    transcriber: createTranscriber(config),
    assistant: createAssistant(config, 'legacy'),
    recordingFetcher: new TwilioRecordingFetcher({
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken,
    }),
    availability: () => appointments.availabilityBlock(),
    logFailure,
    logTurn,
    onProposeBooking: proposeBooking,
    isReady: () => readiness.ready,
  });
  // Build the HTTP server explicitly so the /stream upgrade handler exists
  // before the first connection is accepted.
  const server = createServer(app);
  if (config.voiceLoop === 'stream') {
    const policy = endpointPolicy(config);
    const calls = new CallStore();
    const liveAssistant = createAssistant(config, 'phase');
    const streamPrompt = config.sarvam.sttPrompt ?? (guide.raw ? deriveSttPrompt(guide) : undefined);
    const lives = new Map<string, LiveCallSession>();
    const capture = createUtteranceCapture(config.debugAudioDir);
    const callEnds = twilioCallEnds({
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken,
    });
    attachStreamEndpoint(
      server,
      {
        onOpen: (identity, session) => {
          if (!session || lives.has(identity.streamSid)) return;
          // One tracer per call: every component line carries the same identity,
          // so a whole call replays with `grep <callSid>`.
          const trace = traceToConsole({ callSid: identity.callSid, streamSid: identity.streamSid });
          trace({ component: 'stream', event: 'open', callerPhone: identity.callerPhone ?? null });
          const live = new LiveCallSession({
            identity,
            sendAudio: (audio) => {
              try {
                session.sendAudio(audio);
              } catch {
                // Socket already gone; the close handler releases the session.
              }
            },
            vad: vadModel!.fork(),
            policy,
            transcriber: createTranscriber(config, trace),
            realtime: createRealtimeStt(config, trace, streamPrompt),
            secondOpinion: config.openrouterSttFallback
              ? new OpenRouterStt({
                  stt: { apiKey: config.llmApiKey, model: config.openrouterSttModel },
                  onTrace: trace,
                })
              : undefined,
            tts: createTts(config, trace),
            guide,
            loadGuide: () => loadClinicGuide(config.guidePath),
            assistant: liveAssistant,
            availability: () => appointments.availabilityBlock(),
            holdAfterMs: config.speakHoldMs,
            noResponseMs: config.noResponseMs,
            availabilityTimeoutMs: config.appointmentsWaitMs,
            bargeInMinSpeechMs: config.bargeInMinSpeechMs,
            bargeInDipToleranceMs: config.bargeInDipToleranceMs,
            bargeInConfirmMs: config.bargeInConfirmMs,
            turnDetection: config.turnDetection,
            stallGraceMs: config.stallGraceMs,
            sttHedgeMs: config.sttHedgeMs,
            warmTranscriber: config.sttWarmup,
            echoGate: {
              correlationThreshold: config.echoGateCorrelation,
              levelMarginDb: config.echoGateLevelMarginDb,
              maxDelayMs: config.echoGateMaxDelayMs,
            },
            turnDeadlineMs: config.turnDeadlineMs,
            fixedCache,
            onProposeBooking: proposeBooking,
            calls,
            logTurn,
            logFailure,
            trace,
            onUtteranceLog: (entry) => {
              console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'utterance', ...entry }));
            },
            onUtteranceAudio: capture.onUtteranceAudio,
            onUtteranceTranscribed: capture.onUtteranceTranscribed,
            logSession: (event) => {
              console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
            },
            finishPlayback: (generation) => session.finishPlayback(generation),
            clearPlayback: (reason) => session.clearPlayback(reason),
            hangupCall: (callSid) => callEnds.hangup(callSid),
          });
          lives.set(identity.streamSid, live);
          void live.open().catch((err) => {
            logFailure({
              callSid: identity.callSid,
              turn: 0,
              reason: 'low-confidence',
              excerpt: '',
              detail: err instanceof Error ? `greeting-error: ${err.message}` : `greeting-error: ${String(err)}`,
            });
          });
        },
        onAudio: (identity, audio) => {
          const live = lives.get(identity.streamSid);
          if (!live) return;
          void live.receiveAudio(audio);
        },
        onOutboundFrame: (identity, frame) => {
          // Feed the Echo gate what actually played; retainReference is cheap
          // and ignores frames after close.
          lives.get(identity.streamSid)?.retainReference(frame);
        },
        onDtmf: (identity, digit) => {
          lives.get(identity.streamSid)?.receiveDtmf(digit);
        },
        onClose: (identity, reason, session) => {
          lives.get(identity.streamSid)?.close('socket-closed');
          lives.delete(identity.streamSid);
          traceToConsole({ callSid: identity.callSid, streamSid: identity.streamSid })({
            component: 'stream',
            event: 'close',
            reason,
            ...(session?.stats ?? {}),
            ...(session?.transportStats ?? {}),
          });
        },
      },
      '/stream',
      {
        traceFor: (identity) => traceToConsole({ callSid: identity.callSid, streamSid: identity.streamSid }),
      },
    );
  } else {
    attachStreamEndpoint(server, { onAudio: () => {}, onClose: () => {} });
  }
  server.listen(config.port, () => {
    readiness.ready = true;
    console.log(`receptionist listening on :${config.port}`);
    bootTrace({
      component: 'boot',
      event: 'ready',
      voiceLoop: config.voiceLoop,
      turnDetection: config.turnDetection,
      sttProvider: config.sttProvider,
      assistantProvider: config.assistant.primary,
      assistantModel: config.assistant.primary === 'groq' ? config.assistant.groqModel : config.openrouterModel,
    });
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
