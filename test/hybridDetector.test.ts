import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePause, adaptivePauseMs, hasListContinuationCue, isSemanticallyComplete } from '../src/hybridDetector.ts';

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
    'No.',
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
    // Phrase starts and dangling verbs: the thought needs its object.
    'can you tell me',
    "I'd like to",
    "I'd like",
    'I want',
    'I need',
    'I was wondering',
    'I would like to book',
    'give me',
    'tell him',
    // Mid-sentence modifiers and determiners expecting more.
    'I am not',
    "I'm",
    "don't",
    'better than',
    'the other',
    'I need more',
  ];

  it('holds only on clear continuation cues', () => {
    for (const text of complete) {
      assert.equal(isSemanticallyComplete(text), true, `complete: ${text}`);
    }
    for (const text of incomplete) {
      assert.equal(isSemanticallyComplete(text), false, `incomplete: ${text}`);
    }
  });

  it('does not treat abbreviations as sentence-terminal', () => {
    for (const text of [
      'I need to see Dr.',
      'ask for Mr.',
      'she is Mrs.',
      'we live on Main St.',
      'bring something, e.g.',
      'the morning slot, i.e.',
    ]) {
      assert.equal(isSemanticallyComplete(text), false, `incomplete: ${text}`);
    }
    // A bare "No." answers the question; "Room No." is still numbering.
    assert.equal(isSemanticallyComplete('No.'), true);
    assert.equal(isSemanticallyComplete('Room No.'), false);
  });

  it('holds open phone groupings only while the Patient phone is collected', () => {
    const grouping = ['98765', 'my number is 98765', 'nine eight seven six five', 'my number is nine eight'];
    for (const text of grouping) {
      assert.equal(isSemanticallyComplete(text, { collectingPhone: true }), false, `grouping held: ${text}`);
      assert.equal(isSemanticallyComplete(text), true, `no phone flag, no hold: ${text}`);
    }
    // A plausible full number endpoints even while collecting the phone.
    assert.equal(isSemanticallyComplete('9876543210', { collectingPhone: true }), true);
    assert.equal(isSemanticallyComplete('my number is 9876543210', { collectingPhone: true }), true);
    // ...unless a trailing separator or extension says more digits are coming.
    assert.equal(isSemanticallyComplete('9876543210-', { collectingPhone: true }), false);
    // Name-shaped partials are untouched by the phone flag.
    assert.equal(isSemanticallyComplete('John Smith', { collectingPhone: true }), true);
    // A digit inside a content sentence is not a dictated number.
    assert.equal(isSemanticallyComplete('I have 2 kids', { collectingPhone: true }), true);
  });
});

describe('list-continuation cues (ticket 12)', () => {
  it('flags only partials that frame a larger list or question pair', () => {
    const cued = [
      'I also wanted to ask about the fee',
      'I have another question about parking',
      'my first question is about the fee',
      'my second question is about parking',
      'do you have parking as well',
      'I have two questions about the visit',
    ];
    for (const text of cued) {
      assert.equal(hasListContinuationCue(text), true, `cued: ${text}`);
    }
    const uncued = [
      '',
      'what are your hours',
      'I wanted to ask about the fee',
      'I wanted to ask about the fee and parking',
      'do you have parking',
      'my name is John Smith',
      'we are open on Saturday',
    ];
    for (const text of uncued) {
      assert.equal(hasListContinuationCue(text), false, `uncued: ${text}`);
    }
  });
});
