import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type FailureEvent, type TurnEvent } from './app.ts';
import { createInterimGuardrail } from './booking.ts';
import { loadConfig } from './config.ts';
import { formatFailureLine } from './log.ts';
import { OpenRouterAssistant } from './openrouter.ts';
import { TwilioRecordingFetcher } from './recordings.ts';
import { attachStreamEndpoint } from './stream.ts';
import { WhisperTranscriber } from './whisper.ts';

export function main(): void {
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
  // Audio handling lands in a later ticket; the skeleton only tracks session lifecycle.
  attachStreamEndpoint(server, { onAudio: () => {}, onClose: () => {} });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
