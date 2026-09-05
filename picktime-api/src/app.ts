import express, { type Express, type NextFunction, type Request, type Response } from 'express';

export interface AppDeps {
  bearerKey: string;
  /** Deep readiness probe (browser + page reachability); ticket 02 plugs the page check. */
  checkReadiness: () => Promise<void>;
  logEvent: (event: Record<string, unknown>) => void;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());
  app.get('/health', async (_req: Request, res: Response) => {
    try {
      await deps.checkReadiness();
    } catch (err) {
      deps.logEvent({ kind: 'health', status: 'degraded', reason: detail(err) });
      res.status(503).json({ status: 'degraded' });
      return;
    }
    res.json({ status: 'ok' });
  });

  app.use('/v1', (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== `Bearer ${deps.bearerKey}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  });

  return app;
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
