import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, type FailureEvent, type TurnEvent } from './app.ts';
import { createInterimGuardrail } from './booking.ts';
import { CallStore } from './calls.ts';
import { loadClinicGuide } from './clinic.ts';
import { loadConfig, type Config } from './config.ts';
import { type EndpointPolicy } from './endpoint.ts';
import { LiveCallSession } from './live.ts';
import { formatFailureLine } from './log.ts';
import { OpenRouterAssistant } from './openrouter.ts';
import { TwilioRecordingFetcher } from './recordings.ts';
import { SileroVad } from './sileroVad.ts';
import { attachStreamEndpoint } from './stream.ts';
import { OpenAiTts } from './tts.ts';
import { WhisperTranscriber } from './whisper.ts';

function endpointPolicy(config: Config): EndpointPolicy {
  return {
    silenceMs: config.endpointSilenceMs,
    minSpeechMs: config.endpointMinSpeechMs,
    maxUtteranceMs: config.endpointMaxUtteranceMs,
    threshold: config.vadThreshold,
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
  const app = createApp({
    guidePath: config.guidePath,
    sayVoice: config.sayVoice,
    sayLanguage: config.sayLanguage,
    recordTimeout: config.recordTimeout,
    recordMaxLength: config.recordMaxLength,
    voiceLoop: config.voiceLoop,
    streamWsUrl: config.streamWsUrl,
    transcriber: new WhisperTranscriber({ stt: config.stt }),
    assistant: new OpenRouterAssistant({ apiKey: config.llmApiKey, model: config.openrouterModel }),
    recordingFetcher: new TwilioRecordingFetcher({
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken,
    }),
    logFailure,
    logTurn,
    onProposeBooking: createInterimGuardrail(logFailure),
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
    const transcriber = new WhisperTranscriber({ stt: config.stt });
    const tts = new OpenAiTts({
      apiKey: config.tts.apiKey,
      baseUrl: config.tts.baseUrl,
      model: config.tts.model,
      voice: config.tts.voice,
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
          calls,
          logTurn,
          logFailure,
          onUtteranceLog: (entry) => {
            console.log(JSON.stringify({ ts: new Date().toISOString(), kind: 'utterance', ...entry }));
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
