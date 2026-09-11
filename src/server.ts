import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp, type FailureEvent, type TurnEvent } from './app.ts';
import { createInterimGuardrail } from './booking.ts';
import { loadConfig, type Config } from './config.ts';
import { Endpointer, type EndpointPolicy } from './endpoint.ts';
import { formatFailureLine } from './log.ts';
import { OpenRouterAssistant } from './openrouter.ts';
import { TwilioRecordingFetcher } from './recordings.ts';
import { SileroVad } from './sileroVad.ts';
import { attachStreamEndpoint } from './stream.ts';
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
    const endpointers = new Map<string, Endpointer>();
    attachStreamEndpoint(server, {
      onAudio: (identity, audio) => {
        let endpointer = endpointers.get(identity.streamSid);
        if (!endpointer) {
          endpointer = new Endpointer(vadModel.fork(), policy, {
            onUtterance: (utterance) => {
              console.log(
                JSON.stringify({
                  ts: new Date().toISOString(),
                  kind: 'utterance',
                  callSid: identity.callSid,
                  durationMs: utterance.durationMs,
                  bytes: utterance.audio.length,
                }),
              );
            },
          });
          endpointers.set(identity.streamSid, endpointer);
        }
        void endpointer.receiveAudio(audio);
      },
      onClose: (identity) => {
        endpointers.get(identity.streamSid)?.endSession();
        endpointers.delete(identity.streamSid);
      },
    });
    return;
  }
  attachStreamEndpoint(server, { onAudio: () => {}, onClose: () => {} });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
