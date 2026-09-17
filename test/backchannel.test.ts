import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPartial } from '../src/backchannel.ts';

describe('partial classification', () => {
  it('classifies acknowledgements and listening noises as Backchannels', () => {
    for (const text of [
      'mm-hmm',
      'mm hmm',
      'mmhmm',
      'mhm',
      'hmm',
      'hmmm',
      'uh-huh',
      'uh huh',
      'okay',
      'ok',
      'right',
      'alright',
      'I see',
      'got it',
      'thank you',
      'Okay.',
      ' okay ',
      'Mm-hmm, mm-hmm',
    ]) {
      assert.equal(classifyPartial(text), 'backchannel', `"${text}"`);
    }
  });

  it('classifies content-bearing speech as content', () => {
    for (const text of [
      'wait',
      'no',
      'no, Monday',
      'no wait',
      'hold on',
      'actually I meant tomorrow',
      'change it to 9:30',
      'my name is Asha',
      'book it',
      'mm-hmm wait',
      'mm hmm, but actually',
      'yeah, change the time',
      'I want an appointment on Monday',
      '9840950950',
      // Phrase words alone are fragments of a sentence, not acknowledgements.
      'I',
      'you',
      'it',
      'see',
    ]) {
      assert.equal(classifyPartial(text), 'content', `"${text}"`);
    }
  });

  it('reports no information for empty or punctuation-only partials', () => {
    for (const text of ['', '   ', '...', '—']) {
      assert.equal(classifyPartial(text), 'unknown', `"${text}"`);
    }
  });

  it('does not treat an elongated backchannel as content', () => {
    assert.equal(classifyPartial('hmmmm'), 'backchannel');
    assert.equal(classifyPartial('okaaay'), 'backchannel');
  });
});
