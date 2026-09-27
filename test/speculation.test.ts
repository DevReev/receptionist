import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySpeculation, guideBookingNames, partialAgrees, MIN_SPECULATIVE_TOKENS } from '../src/speculation.ts';

const GUIDE_RAW = [
  '# Clinic Guide — Maple Clinic',
  '',
  '## Locations',
  '',
  '- **Bobby Clinic** — Picktime label: `Bobby Clinic, Bangalore`.',
  '- **Bobby Hospital** — Picktime label: `Bobby Hospital, Bangalore`.',
  '',
  '## Services and fees',
  '',
  '- **Appointment** — 15 minutes — Rs 700.',
  '- **Root Canal** — 30 minutes — Rs 2500.',
  '',
  '## Doctor',
  '',
  '- **Bob Gowda** is the only doctor returned.',
  '',
  '## Conversation style',
  '',
  '- Never rush into the booking script.',
].join('\n');

describe('speculative reply classifier (ticket 09)', () => {
  it('lets a clearly non-booking partial speculate', () => {
    for (const text of [
      'what are your hours',
      'where are you located',
      'do you treat children',
      'hello there',
    ]) {
      const decision = classifySpeculation(text);
      assert.equal(decision.speculative, true, `"${text}" should speculate`);
      assert.equal(decision.reason, 'non-booking');
    }
  });

  it('defaults to booking-sensitive for empty and too-short partials', () => {
    assert.equal(classifySpeculation('').speculative, false);
    assert.equal(classifySpeculation('   ').reason, 'empty');
    assert.equal(classifySpeculation('hello').speculative, false);
    assert.equal(classifySpeculation('hello').reason, 'short');
    assert.equal(MIN_SPECULATIVE_TOKENS, 2);
  });

  it('is booking-sensitive on any digit', () => {
    const decision = classifySpeculation('do you have anything on the 21st');
    assert.equal(decision.speculative, false);
    assert.equal(decision.reason, 'digits');
    assert.equal(decision.cue, '21st');
  });

  it('is booking-sensitive on date and time words', () => {
    for (const text of [
      'are you open tomorrow',
      'can I come in on Wednesday',
      'do you have a slot in the morning',
      'see you in September',
    ]) {
      const decision = classifySpeculation(text);
      assert.equal(decision.speculative, false, `"${text}" is booking-sensitive`);
      assert.equal(decision.reason, 'date-time', `"${text}"`);
    }
  });

  it('is booking-sensitive on service, doctor, and location names', () => {
    const names = guideBookingNames(GUIDE_RAW);
    assert.deepEqual(names, ['Bobby Clinic', 'Bobby Hospital', 'Appointment', 'Root Canal', 'Bob Gowda']);
    for (const [text, cue] of [
      ['can I see Bob Gowda', 'Bob Gowda'],
      ['is the Root Canal painful', 'Root Canal'],
      ['do you have a Bobby Hospital branch', 'Bobby Hospital'],
    ] as const) {
      const decision = classifySpeculation(text, { names });
      assert.equal(decision.speculative, false, `"${text}" is booking-sensitive`);
      assert.equal(decision.reason, 'name', `"${text}"`);
      assert.equal(decision.cue, cue);
    }
  });

  it('is booking-sensitive on book, change, and cancel phrasing', () => {
    for (const text of [
      'I would like to book something',
      'can I change my appointment',
      'I need to cancel it',
      'when is the doctor free',
      'is there a free slot',
    ]) {
      const decision = classifySpeculation(text);
      assert.equal(decision.speculative, false, `"${text}" is booking-sensitive`);
      assert.equal(decision.reason, 'booking', `"${text}"`);
    }
  });

  it('tolerates punctuation-heavy service names', () => {
    const decision = classifySpeculation('can i see C++ Consult', { names: ['C++ Consult'] });
    assert.equal(decision.speculative, false);
    assert.equal(decision.reason, 'name');
    assert.equal(decision.cue, 'C++ Consult');
  });

  it('ignores request fillers that read as non-booking', () => {
    assert.equal(classifySpeculation('may I ask a question').speculative, false, 'may is a month cue');
    assert.equal(classifySpeculation('can you tell me about the clinic').speculative, true);
  });
});

describe('partial/final agreement (ticket 09)', () => {
  it('agrees when the final extends the partial', () => {
    assert.equal(partialAgrees('what are your hours', 'what are your hours on Saturday'), true);
    assert.equal(partialAgrees('what are your hours', 'what are your hours'), true);
    assert.equal(partialAgrees('where are you', 'where are you located'), true);
  });

  it('agrees through a corrected or inserted word', () => {
    assert.equal(partialAgrees('what are your hours', 'what are your opening hours'), true);
  });

  it('disagrees on unrelated text', () => {
    assert.equal(partialAgrees('what are your hours', 'where is the clinic located'), false);
    assert.equal(partialAgrees('do you treat children', 'can I change my appointment'), false);
  });

  it('never agrees with an empty partial or final', () => {
    assert.equal(partialAgrees('', 'what are your hours'), false);
    assert.equal(partialAgrees('what are your hours', ''), false);
  });
});

describe('partial/final agreement against real provider lag (ticket 10)', () => {
  it('keeps through cumulative-prefix growth: short partials extend into the final', () => {
    // Realtime deltas accumulate per conversation item, so live partials are
    // prefixes the final extends. Every growth step agrees.
    assert.equal(partialAgrees('what are', 'what are your hours'), true);
    assert.equal(partialAgrees('what are your', 'what are your hours'), true);
    assert.equal(partialAgrees('what are your hours', 'what are your hours please'), true);
  });

  it('keeps through final normalization and insertions', () => {
    assert.equal(partialAgrees('what are your hours', 'What are your hours?'), true);
    assert.equal(partialAgrees('what are your hours', 'what are your opening hours'), true);
  });

  it('aborts on a corrected word in a short partial, the safe direction', () => {
    // One substituted word in four changes the overlap below the bar, so a
    // same-meaning ASR correction ("our" for "your") regenerates rather than
    // risk keeping a reply built on a reworded ("fees" for "hours") question.
    assert.equal(partialAgrees('what are our hours', 'what are your hours'), false);
    assert.equal(partialAgrees('what are your hours', 'what are your fees'), false);
  });

  it('aborts when the final is reworded past recognition', () => {
    assert.equal(partialAgrees('where are you located', 'where is the clinic located'), false);
  });

  it('never keeps a booking-sensitive final, even when it extends the partial', () => {
    // Lexically the final carries the partial forward, but the keep path also
    // requires the final itself to classify non-booking.
    assert.equal(partialAgrees('can i ask you something', 'can i ask you something to reschedule'), true);
    assert.equal(classifySpeculation('can i ask you something to reschedule').speculative, false);
    assert.equal(partialAgrees('what are your hours', 'what are your hours tomorrow'), true);
    assert.equal(classifySpeculation('what are your hours tomorrow').speculative, false);
  });
});
