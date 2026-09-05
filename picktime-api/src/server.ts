import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { formatLogLine } from './log.ts';
import { MemoryDriver } from './memoryDriver.ts';
import { PlaywrightDriver } from './playwrightDriver.ts';
import { Pool } from './pool.ts';

export function main(): void {
  const config = loadConfig();
  const useLive = process.env.PICKTIME_LIVE === '1';
  const driver = useLive
    ? new PlaywrightDriver({
        pageId: config.pageId,
        navigationTimeoutMs: config.navigationTimeoutMs,
        actionTimeoutMs: config.actionTimeoutMs,
      })
    : new MemoryDriver();
  const pool = new Pool(config.poolSize);
  const app = createApp({
    bearerKey: config.bearerKey,
    checkReadiness: () => driver.checkHealth(),
    logEvent: (event) => console.log(formatLogLine(event)),
    pageId: config.pageId,
    staffId: config.staffId,
    timeZone: config.timeZone,
    driver,
    pool,
  });
  app.listen(config.port, () => {
    console.log(formatLogLine({ kind: 'ready', pageId: config.pageId, port: config.port }));
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
