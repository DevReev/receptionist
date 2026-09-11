import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createApp,
  type BookingOutcome,
  type FailureEvent,
  type ProposedSlot,
  type Transcriber,
  type TurnEvent,
} from './app.ts';
import { AppointmentsClient } from './appointments.ts';
import { CallStore } from './calls.ts';
import { loadClinicGuide } from './clinic.ts';
import { loadConfig, type Config } from './config.ts';
import { type EndpointPolicy } from './endpoint.ts';
import { LiveCallSession } from './live.ts';
import { formatFailureLine } from './log.ts';
import { OpenRouterAssistant } from './openrouter.ts';
import { TwilioRecordingFetcher } from './recordings.ts';
import { SileroVad } from './sileroVad.ts';
import { SarvamTranscriber, SarvamTts } from './sarvam.ts';
import { attachStreamEndpoint } from './stream.ts';
import { OpenAiTts, type Tts } from './tts.ts';
import { WhisperTranscriber } from './whisper.ts';

function createTranscriber(config: Config): Transcriber {
  if (config.sttProvider === 'sarvam') {
    const { apiKey, baseUrl, sttModel, sttLanguageCode, sttMode } = config.sarvam;
    return new SarvamTranscriber({
      stt: { apiKey, baseUrl, model: sttModel, languageCode: sttLanguageCode, mode: sttMode },
    });
  }
  return new WhisperTranscriber({ stt: config.stt });
}

function createTts(config: Config): Tts {
  if (config.ttsProvider === 'sarvam') {
    const { apiKey, baseUrl, ttsModel, ttsSpeaker, ttsLanguageCode, ttsSampleRate } = config.sarvam;
    return new SarvamTts({
      tts: { apiKey, baseUrl, model: ttsModel, speaker: ttsSpeaker, languageCode: ttsLanguageCode, sampleRate: ttsSampleRate },
    });
  }
  return new OpenAiTts({
    apiKey: config.tts.apiKey,
    baseUrl: config.tts.baseUrl,
    model: config.tts.model,
    voice: config.tts.voice,
    responseFormat: config.tts.responseFormat,
    pcmSampleRate: config.tts.pcmSampleRate,
  });
}

function endpointPolicy(config: Config): EndpointPolicy {
  return {
    silenceMs: config.endpointSilenceMs,
    minSpeechMs: config.endpointMinSpeechMs,
    maxUtteranceMs: config.endpointMaxUtteranceMs,
    threshold: config.vadThreshold,
    latchDipMs: config.endpointLatchDipMs,
  };
}

export async function main(): Promise<void> {
  const config = loadConfig();
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
  const app = createApp({
    guidePath: config.guidePath,
    sayVoice: config.sayVoice,
    sayLanguage: config.sayLanguage,
    recordTimeout: config.recordTimeout,
    recordMaxLength: config.recordMaxLength,
    voiceLoop: config.voiceLoop,
    streamWsUrl: config.streamWsUrl,
    transcriber: createTranscriber(config),
    assistant: new OpenRouterAssistant({
      apiKey: config.llmApiKey,
      model: config.openrouterModel,
      temperature: config.openrouterTemperature,
    }),
    recordingFetcher: new TwilioRecordingFetcher({
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken,
    }),
    availability: () => appointments.availabilityBlock(),
    logFailure,
    logTurn,
    onProposeBooking: proposeBooking,
  });
  const server = app.listen(config.port, () => {
    console.log(`receptionist listening on :${config.port}`);
  });
  if (config.voiceLoop === 'stream') {
    if (!existsSync(config.vadModelPath)) {
      throw new Error(`VAD model missing at ${config.vadModelPath}: run scripts/fetch-vad-model.sh`);
    }
    const vadModel = await SileroVad.load(config.vadModelPath);
    const policy = endpointPolicy(config);
    const calls = new CallStore();
    const transcriber = createTranscriber(config);
    const tts = createTts(config);
    const liveAssistant = new OpenRouterAssistant({
      apiKey: config.llmApiKey,
      model: config.openrouterModel,
      temperature: config.openrouterTemperature,
    });
    const lives = new Map<string, LiveCallSession>();
    attachStreamEndpoint(server, {
      onOpen: (identity, session) => {
        if (!session || lives.has(identity.streamSid)) return;
        const live = new LiveCallSession({
          identity,
          sendAudio: (audio) => {
            try {
              session.sendAudio(audio);
            } catch {
              // Socket already gone; the close handler releases the session.
            }
          },
          vad: vadModel.fork(),
          policy,
          transcriber,
          tts,
          guide: { raw: '', name: 'the clinic' },
          loadGuide: () => loadClinicGuide(config.guidePath),
          assistant: liveAssistant,
          availability: () => appointments.availabilityBlock(),
          holdAfterMs: config.speakHoldMs,
          availabilityTimeoutMs: config.appointmentsWaitMs,
          onProposeBooking: proposeBooking,
          calls,
          logTurn,
          logFailure,
          onUtteranceLog: (entry) => {
            console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'utterance', ...entry }));
          },
          logSession: (event) => {
            console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
          },
          onPlaybackComplete: () => {},
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
      onClose: (identity) => {
        lives.get(identity.streamSid)?.close('socket-closed');
        lives.delete(identity.streamSid);
      },
    });
    return;
  }
  attachStreamEndpoint(server, { onAudio: () => {}, onClose: () => {} });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
