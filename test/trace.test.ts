import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clip, traceToConsole } from '../src/trace.ts';

describe('trace', () => {
  it('clips long payloads while keeping both ends', () => {
    const long = `start-${'x'.repeat(600)}-end`;
    const out = clip(long, 100);
    assert.ok(out.length < long.length);
    assert.match(out, /elided/);
    assert.ok(out.startsWith('start-'));
    assert.ok(out.endsWith('-end'));
  });

  it('leaves short payloads untouched', () => {
    assert.equal(clip('short', 100), 'short');
  });

  it('writes one JSON line with the per-call scope merged in', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      traceToConsole({ callSid: 'CA1' })({ component: 'stt', event: 'open', ms: 7 });
    } finally {
      console.log = original;
    }
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed['kind'], 'trace');
    assert.equal(parsed['callSid'], 'CA1');
    assert.equal(parsed['component'], 'stt');
    assert.equal(parsed['event'], 'open');
    assert.equal(parsed['ms'], 7);
    assert.equal(typeof parsed['ts'], 'string');
  });
});
