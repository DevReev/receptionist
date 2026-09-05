import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { formatLogLine } from './log.ts';

export function main(): void {
  const config = loadConfig();
  const app = createApp({
    bearerKey: config.bearerKey,
    // Ticket 02 replaces this liveness stub with the browser + page probe.
    checkReadiness: async () => {},
    logEvent: (event) => console.log(formatLogLine(event)),
  });
  app.listen(config.port, () => {
    console.log(formatLogLine({ kind: 'ready', pageId: config.pageId, port: config.port }));
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
