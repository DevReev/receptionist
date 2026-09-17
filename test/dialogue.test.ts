import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DialogueReducer,
  EMERGENCY_LINE,
  emptyDialogueState,
  isAvailabilityIntent,
  parseAvailabilityBlock,
  readbackText,
  spokenTime,
} from '../src/dialogue.ts';

const NOW = new Date(Date.UTC(2026, 8, 28)); // Monday 28 September 2026
const SLOTS = parseAvailabilityBlock(
  'AVAILABILITY (fetched live)\n' +
    '- 2026-09-30 09:30 Appointment with Bob Gowda at Bobby Clinic\n' +
    '- 2026-10-01 15:00 Appointment with Bob Gowda at Bobby Clinic',
);

function reducer(): DialogueReducer {
  return new DialogueReducer({ now: () => NOW });
}

describe('parseAvailabilityBlock', () => {
  it('parses grouped production lines into per-time slots', () => {
    const slots = parseAvailabilityBlock(
      'AVAILABILITY (fetched 2026-09-12, timezone Asia/Kolkata)\n' +
        '- location · service · date: times (24-hour HH:MM)\n' +
        '- Bobby Clinic · Appointment · 2026-09-30: 09:30 10:00 10:15\n' +
        '- Bobby Hospital · Appointment · 2026-10-01: 15:00',
    );
    assert.equal(slots.length, 4);
    assert.deepEqual(slots[0], {
      service: 'Appointment',
      location: 'Bobby Clinic',
      date: '2026-09-30',
      time: '09:30',
    });
    assert.equal(slots[3]!.location, 'Bobby Hospital');
  });

  it('parses flat fixture lines and ignores none lines', () => {
    assert.equal(parseAvailabilityBlock('- none: no Slots are open').length, 0);
    assert.equal(SLOTS.length, 2);
    assert.equal(SLOTS[0]!.doctor, 'Bob Gowda');
  });
});

describe('availability intent', () => {
  it('matches booking and time language but not small talk', () => {
    assert.equal(isAvailabilityIntent('can I book an appointment?'), true);
    assert.equal(isAvailabilityIntent('what time are you open on Wednesday'), true);
    assert.equal(isAvailabilityIntent('hello there'), false);
    assert.equal(isAvailabilityIntent('what are your fees?'), false);
  });
});

describe('DialogueReducer', () => {
  it('routes an FAQ turn to the LLM without touching availability', () => {
    const { state, decision } = reducer().reduce({ transcript: 'what are your hours?', state: emptyDialogueState() });
    assert.equal(decision.kind, 'continue');
    assert.equal(state.intent, 'unknown');
    assert.equal(state.phase, 'idle');
  });

  it('decides availability for booking language', () => {
    const { decision } = reducer().reduce({ transcript: 'can I book an appointment?', state: emptyDialogueState() });
    assert.equal(decision.kind, 'availability');
  });

  it('collects slot, name, and phone with fixed questions, then reads back', () => {
    const r = reducer();
    let state = emptyDialogueState();
    ({ state } = r.reduce({ transcript: 'book an appointment', state }));
    const slotTurn = r.reduce({ transcript: 'Wednesday morning', state, slots: SLOTS });
    state = slotTurn.state;
    assert.equal(state.selectedSlot!.date, '2026-09-30');
    assert.equal(state.phase, 'collecting-patient');
    assert.match((slotTurn.decision as { text: string }).text, /name/i);
    const phoneTurn = r.reduce({ transcript: 'Asha', state, slots: SLOTS });
    state = phoneTurn.state;
    assert.equal(state.patient.name, 'Asha');
    assert.match((phoneTurn.decision as { text: string }).text, /number/i);
    const readback = r.reduce({ transcript: '98409 50950', state, slots: SLOTS });
    assert.equal(readback.decision.kind, 'readback');
    state = readback.state;
    assert.equal(state.phase, 'awaiting-confirmation');
  });

  it('reads back, requires a played mark, then books on a later turn', () => {
    const r = reducer();
    let state = emptyDialogueState();
    ({ state } = r.reduce({ transcript: 'book an appointment', state }));
    ({ state } = r.reduce({ transcript: 'Wednesday at 9:30', state, slots: SLOTS }));
    ({ state } = r.reduce({ transcript: 'my name is Asha', state, slots: SLOTS }));
    const readback = r.reduce({ transcript: '9840950950', state, slots: SLOTS });
    assert.equal(readback.decision.kind, 'readback');
    state = readback.state;
    const generation = (readback.decision as { generation: number }).generation;
    assert.match((readback.decision as { text: string }).text, /Asha/);
    assert.match((readback.decision as { text: string }).text, /Wednesday, 30 September/);
    assert.equal(r.authorizeBooking(state), null, 'unplayed readback cannot authorize');
    state = r.markReadbackPlayed(state, generation);
    const confirmed = r.reduce({ transcript: 'yes please', state, slots: SLOTS });
    assert.equal(confirmed.decision.kind, 'book');
    assert.equal((confirmed.decision as { slot: { date: string } }).slot.date, '2026-09-30');
    assert.deepEqual(r.authorizeBooking(confirmed.state), {
      slot: confirmed.state.selectedSlot,
      patient: { name: 'Asha', phone: '9840950950' },
    });
  });

  it('rejects a bare yes after an interrupted readback and reads back again', () => {
    const r = reducer();
    let state = emptyDialogueState();
    ({ state } = r.reduce({ transcript: 'book Wednesday at 9:30', state, slots: SLOTS }));
    const first = r.reduce({ transcript: 'my name is Asha, 9840950950', state, slots: SLOTS });
    assert.equal(first.decision.kind, 'readback');
    state = first.state;
    const firstGeneration = (first.decision as { generation: number }).generation;
    // Barge-in cleared the audio: it never reached a played mark.
    const repeated = r.reduce({ transcript: 'yes', state, slots: SLOTS });
    assert.equal(repeated.decision.kind, 'readback', 'state must be re-read, not booked');
    assert.notEqual((repeated.decision as { generation: number }).generation, firstGeneration);
    assert.equal(r.authorizeBooking(repeated.state), null);
  });

  it('invalidates a played readback when booking facts change', () => {
    const r = reducer();
    let state = emptyDialogueState();
    ({ state } = r.reduce({ transcript: 'book Wednesday at 9:30', state, slots: SLOTS }));
    ({ state } = r.reduce({ transcript: 'my name is Asha, 9840950950', state, slots: SLOTS }));
    const readback = r.reduce({ transcript: 'ok', state, slots: SLOTS });
    state = readback.state;
    state = r.markReadbackPlayed(state, (readback.decision as { generation: number }).generation);
    ({ state } = r.reduce({ transcript: 'actually my name is Ravi', state, slots: SLOTS }));
    const yes = r.reduce({ transcript: 'yes', state, slots: SLOTS });
    assert.equal(yes.decision.kind, 'readback', 'changed facts require a fresh readback');
    assert.equal(r.authorizeBooking(yes.state), null);
  });

  it('uses the caller ID number as a confirmed patient phone', () => {
    const r = reducer();
    let state = emptyDialogueState();
    ({ state } = r.reduce({ transcript: 'book Wednesday at 9:30', state, slots: SLOTS, callerPhone: '+919840950950' }));
    const readback = r.reduce({ transcript: 'Asha', state, slots: SLOTS, callerPhone: '+919840950950' });
    assert.equal(readback.decision.kind, 'readback');
    state = r.markReadbackPlayed(readback.state, (readback.decision as { generation: number }).generation);
    const booked = r.reduce({ transcript: 'yes', state, slots: SLOTS, callerPhone: '+919840950950' });
    assert.equal(booked.decision.kind, 'book');
    assert.equal((booked.decision as { patient: { phone: string } }).patient.phone, '+919840950950');
  });

  it('treats a negative confirmation as a slot change request', () => {
    const r = reducer();
    let state = emptyDialogueState();
    ({ state } = r.reduce({ transcript: 'book Wednesday at 9:30', state, slots: SLOTS }));
    ({ state } = r.reduce({ transcript: 'my name is Asha, 9840950950', state, slots: SLOTS }));
    const readback = r.reduce({ transcript: 'ok', state, slots: SLOTS });
    state = readback.state;
    const rejected = r.reduce({ transcript: 'no', state, slots: SLOTS });
    assert.equal(rejected.decision.kind, 'speak');
    assert.equal(rejected.state.phase, 'choosing-slot');
  });

  it('says goodbye only outside an active booking flow', () => {
    const goodbye = reducer().reduce({ transcript: 'that is all, bye', state: emptyDialogueState() });
    assert.equal(goodbye.decision.kind, 'goodbye');
  });

  it('speaks the emergency boundary line deterministically', () => {
    const { decision } = reducer().reduce({ transcript: 'he is having chest pain', state: emptyDialogueState() });
    assert.deepEqual(decision, { kind: 'speak', text: EMERGENCY_LINE });
  });

  it('asks instead of guessing when several slots match', () => {
    const slots = parseAvailabilityBlock(
      '- 2026-09-30 09:30 Appointment with Bob Gowda at Bobby Clinic\n' +
        '- 2026-09-30 10:30 Appointment with Bob Gowda at Bobby Clinic',
    );
    const { decision } = reducer().reduce({ transcript: 'Wednesday', state: emptyDialogueState(), slots });
    assert.equal(decision.kind, 'availability');
  });

  it('offers preference-filtered candidates and resolves a later short answer', () => {
    const grid = parseAvailabilityBlock(
      ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']
        .map((date) => `- Bobby Clinic · Appointment · ${date}: 09:00 09:15 09:30 10:00 15:00`)
        .join('\n'),
    );
    const r = reducer();
    let state = emptyDialogueState();
    ({ state } = r.reduce({ transcript: 'I want to book an appointment', state, slots: grid }));
    assert.ok(state.lastOffered.length > 0 && state.lastOffered.length <= 4);
    assert.equal(state.lastOffered[0]!.date, '2026-09-14', 'no preference means the earliest Slots');
    ({ state } = r.reduce({ transcript: 'Wednesday morning would be good', state, slots: grid }));
    assert.ok(state.lastOffered.length > 0);
    assert.ok(state.lastOffered.every((slot) => slot.date === '2026-09-16'));
    assert.ok(state.lastOffered.every((slot) => slot.time < '12:00'));
    const selected = r.reduce({ transcript: 'Yes, 9:15 works.', state });
    assert.equal(selected.state.selectedSlot?.date, '2026-09-16');
    assert.equal(selected.state.selectedSlot?.time, '09:15');
    assert.equal(selected.state.phase, 'collecting-patient');
    assert.match((selected.decision as { text: string }).text, /name/i);
  });

  it('resolves a bare spoken time like "915" against the offered candidates', () => {
    const offered = { service: 'Appointment', location: 'Bobby Clinic', date: '2026-09-16', time: '09:15' };
    const state = {
      ...emptyDialogueState(),
      phase: 'choosing-slot' as const,
      offeredSlots: [
        offered,
        { ...offered, date: '2026-09-14' },
        { ...offered, date: '2026-09-15' },
      ],
      lastOffered: [offered],
    };
    const { state: next } = reducer().reduce({ transcript: '915 work', state });
    assert.equal(next.selectedSlot?.time, '09:15');
    assert.equal(next.selectedSlot?.date, '2026-09-16', 'the offered Slot beats other 9:15s');
  });

  it('asks instead of guessing when several offered Slots fit a bare yes', () => {
    const state = { ...emptyDialogueState(), phase: 'choosing-slot' as const, offeredSlots: SLOTS, lastOffered: SLOTS };
    const { decision } = reducer().reduce({ transcript: 'yes please', state });
    assert.equal(decision.kind, 'availability');
  });

  it('collapses same-time Slots across Locations and resolves the offered one', () => {
    const dual = parseAvailabilityBlock(
      '- Bobby Clinic · Appointment · 2026-09-14: 09:15 09:30 09:45 10:00\n' +
        '- Bobby Hospital · Appointment · 2026-09-14: 09:15 09:30 09:45 10:00\n' +
        '- Bobby Clinic · Appointment · 2026-09-15: 09:00 09:15\n' +
        '- Bobby Hospital · Appointment · 2026-09-15: 09:00 09:15',
    );
    const r = reducer();
    let state = emptyDialogueState();
    ({ state } = r.reduce({ transcript: 'I want to book an appointment', state, slots: dual }));
    assert.deepEqual(
      state.lastOffered.map((slot) => `${slot.location} ${slot.date} ${slot.time}`),
      [
        'Bobby Clinic 2026-09-14 09:15',
        'Bobby Clinic 2026-09-14 09:30',
        'Bobby Clinic 2026-09-14 09:45',
        'Bobby Clinic 2026-09-14 10:00',
      ],
      'one day, one candidate per time, default Location first',
    );
    const selected = r.reduce({ transcript: 'Yes, 9:15 works.', state });
    assert.equal(selected.state.selectedSlot?.location, 'Bobby Clinic');
    assert.equal(selected.state.selectedSlot?.time, '09:15');
    assert.equal(selected.state.phase, 'collecting-patient');
  });

  it('honours a Location named by the Caller in the offered candidates', () => {
    const dual = parseAvailabilityBlock(
      '- Bobby Clinic · Appointment · 2026-09-14: 09:15 09:30 09:45 10:00\n' +
        '- Bobby Hospital · Appointment · 2026-09-14: 09:15 09:30 09:45 10:00',
    );
    const { state } = reducer().reduce({
      transcript: 'I need an appointment at Bobby Hospital',
      state: emptyDialogueState(),
      slots: dual,
    });
    assert.ok(state.lastOffered.length >= 2);
    assert.ok(state.lastOffered.every((slot) => slot.location === 'Bobby Hospital'));
  });

  it('re-reads with a corrected phone instead of dropping the Slot', () => {
    const r = reducer();
    let state = emptyDialogueState();
    ({ state } = r.reduce({ transcript: 'book Wednesday at 9:30', state, slots: SLOTS, callerPhone: '+919840950950' }));
    const readback = r.reduce({ transcript: 'Asha', state, slots: SLOTS, callerPhone: '+919840950950' });
    assert.equal(readback.decision.kind, 'readback');
    state = r.markReadbackPlayed(readback.state, (readback.decision as { generation: number }).generation);
    const corrected = r.reduce({
      transcript: 'No, my mobile number is 9840950950',
      state,
      slots: SLOTS,
      callerPhone: '+919840950950',
    });
    assert.equal(corrected.decision.kind, 'readback', 'a correction re-reads rather than rejecting the Slot');
    assert.notEqual(
      (corrected.decision as { generation: number }).generation,
      (readback.decision as { generation: number }).generation,
    );
    assert.equal(corrected.state.patient.phone, '9840950950');
    assert.equal(corrected.state.patient.phoneSource, 'spoken');
    assert.equal(corrected.state.selectedSlot?.time, '09:30');
  });

  it('formats spoken times for readback', () => {
    assert.equal(spokenTime('09:30'), '9:30 am');
    assert.equal(spokenTime('15:00'), '3 pm');
    assert.match(
      readbackText({ service: 'Appointment', location: 'Bobby Clinic', date: '2026-09-30', time: '09:30' }, { name: 'Asha' }, false),
      /Asha on Wednesday, 30 September at 9:30 am at Bobby Clinic/,
    );
  });
});
