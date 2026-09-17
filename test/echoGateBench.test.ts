import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMulaw } from '../src/audio.ts';
import { aggregateEchoBench, classifyEchoMix } from '../src/echoGateBench.ts';
import { voice } from './voiceFixtures.ts';

const FRAME = 160;

/** Silence, then returning Echo, then Caller speech after the Echo ends. */
function scriptedCaller(): Buffer {
  const pcm = new Int16Array(FRAME * 60);
  pcm.set(voice(FRAME * 12, 31), FRAME * 48);
  return encodeMulaw(pcm);
}

describe('echo gate fixture bench', () => {
  it('labels pure Echo and Caller frames and scores classifications', () => {
    const counts = classifyEchoMix({
      name: 'scripted',
      caller: scriptedCaller(),
      reference: encodeMulaw(voice(FRAME * 40, 7)),
      mix: { delayMs: 120, attenuationDb: -18 },
    });
    // The Echo returns on frames 6..45; Caller speech lands on frames 48+,
    // after it ends, so neither label overlaps the other.
    assert.ok(counts.pureEchoFrames >= 30, `pure echo ${counts.pureEchoFrames}`);
    assert.ok(counts.callerFrames >= 10, `caller ${counts.callerFrames}`);
    assert.equal(counts.echoFalsePasses, 0);
    assert.equal(counts.callerFalseBlocks, 0);
    assert.ok(counts.decisions > 0);
  });

  it('aggregates false-pass and false-block rates and applies the bars', () => {
    const summary = aggregateEchoBench([
      {
        name: 'clean',
        delayMs: 120,
        attenuationDb: -18,
        counts: {
          pureEchoFrames: 100,
          echoFalsePasses: 2,
          callerFrames: 100,
          callerFalseBlocks: 0,
          doubleTalkFrames: 0,
          silenceFrames: 10,
          decisions: 210,
        },
      },
      {
        name: 'noisy',
        delayMs: 240,
        attenuationDb: -24,
        counts: {
          pureEchoFrames: 50,
          echoFalsePasses: 5,
          callerFrames: 50,
          callerFalseBlocks: 4,
          doubleTalkFrames: 0,
          silenceFrames: 5,
          decisions: 105,
        },
      },
    ]);
    assert.equal(summary.cases, 2);
    assert.equal(summary.pureEchoFrames, 150);
    assert.equal(summary.echoFalsePasses, 7);
    assert.equal(summary.callerFrames, 150);
    assert.equal(summary.callerFalseBlocks, 4);
    assert.equal(summary.falsePassRate, 7 / 150);
    assert.equal(summary.falseBlockRate, 4 / 150);
    assert.equal(summary.pass, true);
  });
});
