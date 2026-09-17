import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSttPrompt, extractClinicName, FALLBACK_CLINIC_NAME } from '../src/clinic.ts';

const GUIDE = {
  name: 'Bobby Clinic',
  raw: [
    '# Clinic Guide — Bobby Clinic',
    '',
    '## Locations',
    '',
    '- **Bobby Clinic** — Picktime label: `Bobby Clinic, Bobby Clinic, Bangalore`.',
    '- **Bobby Hospital** — Picktime label: `Bobby Hospital, Bobby Hospital, Bangalore`.',
    '',
    '## Services and fees',
    '',
    '- **Appointment** — 15 minutes — Rs 700.',
    '',
    '## Doctor',
    '',
    '- **Bob Gowda** is the only doctor currently returned by the live Picktime directory.',
    '',
    '## FAQs',
    '',
    '- **Not a real term** should be ignored because it is in another section.',
  ].join('\n'),
};

describe('clinic guide', () => {
  it('extracts the clinic name or falls back', () => {
    assert.equal(extractClinicName(GUIDE.raw), 'Bobby Clinic');
    assert.equal(extractClinicName('# Clinic Guide — {placeholder}\n'), FALLBACK_CLINIC_NAME);
    assert.equal(extractClinicName('# Something else\n'), FALLBACK_CLINIC_NAME);
  });

  it('derives a stable STT terminology prompt from the guide sections', () => {
    assert.equal(
      deriveSttPrompt(GUIDE),
      'Bobby Clinic, Bobby Hospital, Bob Gowda, Appointment',
    );
    assert.equal(deriveSttPrompt(GUIDE).includes('Not a real term'), false);
  });
});
