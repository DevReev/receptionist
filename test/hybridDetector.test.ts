import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePause, adaptivePauseMs, isSemanticallyComplete } from '../src/hybridDetector.ts';

describe('adaptive pause math', () => {
  it('defaults to 300 ms until three pauses are observed', () => {
    assert.equal(adaptivePauseMs([]), 300);
    assert.equal(adaptivePauseMs([200]), 300);
    assert.equal(adaptivePauseMs([200, 220]), 300);
  });

  it('turns 1.25 x p90 into the floor once enough pauses exist', () => {
    // Nearest-rank p90 of three values is the largest: 1.25 x 240 = 300.
    assert.equal(adaptivePauseMs([200, 220, 240]), 300);
    assert.equal(adaptivePauseMs([160, 160, 160]), 200);
    // The nearest-rank p90 of eight values is the largest; the clamp holds.
    const steady = Array<number>(8).fill(400);
    assert.equal(adaptivePauseMs(steady), 500);
    assert.equal(adaptivePauseMs([100, 200, 200, 200, 200, 200, 200, 400]), 500);
  });

  it('clamps the floor to 150-600 ms', () => {
    assert.equal(adaptivePauseMs([80, 80, 80]), 150, 'below the floor clamps up');
    assert.equal(adaptivePauseMs(Array<number>(8).fill(900)), 600, 'above the ceiling clamps down');
  });

  it('keeps only the last eight completed pauses', () => {
    const tracker = new AdaptivePause();
    // A long outlier first; eight more pauses evict it from the window.
    tracker.observe(900);
    for (let i = 0; i < 8; i += 1) tracker.observe(200);
    assert.equal(tracker.floorMs, 250, 'the evicted outlier no longer raises the floor');
  });

  it('ignores empty pauses', () => {
    const tracker = new AdaptivePause();
    tracker.observe(0);
    tracker.observe(0);
    tracker.observe(0);
    // Three observations would otherwise lift the floor at the 0 ms clamp.
    assert.equal(tracker.floorMs, 300);
  });
});

describe('semantic completeness from partials', () => {
  const complete = [
    '',
    'what are your hours',
    'I would like to book an appointment',
    'book me for Monday at nine thirty',
    'my name is John Smith',
    'five five five one two three four',
    'thank you',
    'no thanks',
    'I need an appointment tomorrow morning',
    'what time do you open?',
    'that is all.',
  ];
  const incomplete = [
    'and',
    'I would like to book an appointment for',
    'my number is',
    'I want to book a',
    'the appointment is on',
    'uh',
    'um',
    'well, I was going to say uh',
    'I thought that',
    'what',
    'how',
    'can I',
    'do you',
    'is there',
    'what about',
    'where are you',
  ];

  it('holds only on clear continuation cues', () => {
    for (const text of complete) {
      assert.equal(isSemanticallyComplete(text), true, `complete: ${text}`);
    }
    for (const text of incomplete) {
      assert.equal(isSemanticallyComplete(text), false, `incomplete: ${text}`);
    }
  });
});
