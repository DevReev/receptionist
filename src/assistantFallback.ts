import type { Assistant, AssistantContext, AssistantReply } from './app.ts';

/**
 * Primary/fallback routing for the assistant LLM. The fallback runs only when
 * the primary fails before yielding any spoken token: once text has been
 * yielded, audio may already be playing and a restart would double-speak.
 */
export class FallbackAssistant implements Assistant {
  private readonly primary: Assistant;
  private readonly fallback: Assistant;
  private readonly onFallback?: (detail: string) => void;

  constructor(opts: { primary: Assistant; fallback: Assistant; onFallback?: (detail: string) => void }) {
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.onFallback = opts.onFallback;
  }

  async reply(ctx: AssistantContext): Promise<AssistantReply> {
    try {
      return await this.primary.reply(ctx);
    } catch (err) {
      this.onFallback?.(detail(err));
      return this.fallback.reply(ctx);
    }
  }

  async *replyStream(ctx: AssistantContext, signal?: AbortSignal): AsyncGenerator<string> {
    const stream = this.primary.replyStream;
    if (!stream) {
      const out = await this.reply(ctx);
      if (out.text) yield out.text;
      return;
    }
    let yielded = false;
    try {
      for await (const token of stream.call(this.primary, ctx, signal)) {
        yielded = true;
        yield token;
      }
      return;
    } catch (err) {
      if (yielded || signal?.aborted) throw err;
      this.onFallback?.(detail(err));
    }
    const fallbackStream = this.fallback.replyStream;
    if (!fallbackStream) {
      const out = await this.fallback.reply(ctx);
      if (out.text) yield out.text;
      return;
    }
    yield* fallbackStream.call(this.fallback, ctx, signal);
  }
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
