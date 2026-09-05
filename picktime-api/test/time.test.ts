import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isoToSlotInt, slotIntToISO } from '../src/time.ts';

describe('slot int conversions', () => {
  it('round-trips ISO local and page slot ints without separators leaking', async () => {
    assert.equal(isoToSlotInt('2026-09-28T14:00:00'), '202609281400');
    assert.equal(isoToSlotInt('2026-09-28T14:15'), '202609281415');
    assert.equal(slotIntToISO('202609281400'), '2026-09-28T14:00:00');
    assert.equal(slotIntToISO(isoToSlotInt('2026-09-28T09:30:00')), '2026-09-28T09:30:00');
  });
});
