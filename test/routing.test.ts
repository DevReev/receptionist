import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocationRouting, resolveBookingTarget, routeForLocation } from '../src/routing.ts';

const GUIDE = [
  '# Clinic Guide — Bobby Clinic',
  '',
  '## Locations',
  '',
  '- **Bobby Clinic** — Picktime label: `Bobby Clinic, Bobby Clinic, Bangalore` — books on: clone.',
  '- **Bobby Hospital** — Picktime label: `Bobby Hospital, Bobby Hospital, Bangalore` — books on: picktime.',
  '',
  '## Services and fees',
  '',
  '- **Appointment** — 15 minutes — Rs 700 — books on: clone.',
  '',
].join('\n');

describe('parallel-run routing', () => {
  it('parses the per-Location toggle and ignores other sections', () => {
    const table = parseLocationRouting(GUIDE);
    assert.equal(table.get('Bobby Clinic'), 'clone');
    assert.equal(table.get('Bobby Hospital'), 'picktime');
    assert.equal(table.has('Appointment'), false);
  });

  it('fails closed to picktime when the toggle is absent or invalid', () => {
    const raw = [
      '## Locations',
      '- **Bobby Clinic** — Picktime label: `x`.',
      '- **Bobby Hospital** — label `y` — books on: bogus.',
    ].join('\n');
    assert.equal(routeForLocation(raw, 'Bobby Clinic'), 'picktime');
    assert.equal(routeForLocation(raw, 'Bobby Hospital'), 'picktime');
    assert.equal(routeForLocation('no headings', 'Bobby Clinic'), 'picktime');
  });

  it('matches short names and case-insensitively; unknown fails closed', () => {
    assert.equal(resolveBookingTarget(GUIDE, 'Bobby Clinic'), 'clone');
    assert.equal(resolveBookingTarget(GUIDE, 'bobby clinic'), 'clone');
    assert.equal(resolveBookingTarget(GUIDE, 'Bobby Clinic, Bobby Clinic, Bangalore'), 'clone');
    assert.equal(resolveBookingTarget(GUIDE, 'Bobby Hospital'), 'picktime');
    assert.equal(resolveBookingTarget(GUIDE, 'Downtown'), 'picktime');
  });
});
