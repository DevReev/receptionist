/**
 * Deterministic dialogue state for the booking flow. The model words replies;
 * this reducer owns phases, Slot selection, readback generations, and the
 * authorization gate that no LLM output may bypass.
 */

export interface SlotOption {
  service: string;
  location: string;
  doctor?: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  time: string;
}

export interface DialoguePatient {
  name?: string;
  phone?: string;
  phoneSource?: 'caller-id' | 'spoken';
}

export interface DialogueReadback {
  generation: number;
  stateVersion: number;
  played: boolean;
}

export interface DialogueState {
  intent: 'faq' | 'availability' | 'book' | 'goodbye' | 'unknown';
  phase: 'idle' | 'choosing-slot' | 'collecting-patient' | 'awaiting-confirmation' | 'booking';
  offeredSlots: SlotOption[];
  /** The candidate Slots the model was last told to offer; short answers resolve against these first. */
  lastOffered: SlotOption[];
  selectedSlot?: SlotOption;
  patient: DialoguePatient;
  readback?: DialogueReadback;
  confirmation?: { readbackGeneration: number; affirmative: boolean };
  version: number;
  /** Monotonic readback generation; every produced readback gets a fresh one. */
  readbackSeq: number;
}

export type DialogueDecision =
  | { kind: 'continue' }
  | { kind: 'availability' }
  | { kind: 'speak'; text: string }
  | { kind: 'readback'; text: string; slot: SlotOption; generation: number; stateVersion: number }
  | { kind: 'book'; slot: SlotOption; patient: { name: string; phone: string } }
  | { kind: 'goodbye' };

export interface ReduceInput {
  transcript: string;
  state: DialogueState;
  callerPhone?: string;
  /** Slots from the controller-owned availability read. */
  slots?: SlotOption[];
  nameQuestion?: string;
  phoneQuestion?: string;
}

export const DEFAULT_NAME_QUESTION = 'What name should I put on the appointment?';
export const DEFAULT_PHONE_QUESTION = "What's the best mobile number for the appointment?";
export const EMERGENCY_LINE =
  'If this is an emergency, please hang up and call your local emergency number right away. I cannot give medical advice.';

/** How many candidate Slots the model may offer at once. */
const SHORTLIST_LIMIT = 4;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const AFFIRMATIVE = /\b(yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|correct|right|go ahead|book it|please do|haan|theek hai)\b/;
const NEGATIVE = /\b(no|nope|nah|cancel|don't|do not|dont)\b/;
const GOODBYE = /\b(bye|goodbye|that's all|thats all|nothing else|no thanks|no thank you)\b/;
const EMERGENCY = /\b(emergency|chest pain|bleeding|unconscious|collapsed|can't breathe|cant breathe|heart attack|stroke|overdose)\b/;
const AVAILABILITY_INTENT =
  /\b(book|booking|appointment|appoint|slot|available|availability|opening|open|time|times|when|date|schedule|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|morning|afternoon|evening)\b/;
const BOOKING_KEYWORDS =
  /\b(book|booking|appointment|appoint|slot|available|availability|schedule|at|on|for|yes|no|please)\b/;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function isAffirmative(text: string): boolean {
  return AFFIRMATIVE.test(normalize(text));
}

export function isNegative(text: string): boolean {
  return NEGATIVE.test(normalize(text));
}

export function isGoodbyeIntent(text: string): boolean {
  const t = normalize(text);
  return GOODBYE.test(t) && !AVAILABILITY_INTENT.test(t);
}

export function isEmergencyIntent(text: string): boolean {
  return EMERGENCY.test(normalize(text));
}

export function isAvailabilityIntent(text: string): boolean {
  return AVAILABILITY_INTENT.test(normalize(text));
}

export function emptyDialogueState(): DialogueState {
  return { intent: 'unknown', phase: 'idle', offeredSlots: [], lastOffered: [], patient: {}, version: 0, readbackSeq: 0 };
}

export function spokenDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day!));
  return `${WEEKDAYS[value.getUTCDay()]}, ${day} ${MONTHS[month! - 1]}`;
}

export function spokenTime(time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  const suffix = hour! < 12 ? 'am' : 'pm';
  const h12 = hour! % 12 === 0 ? 12 : hour! % 12;
  return minute === 0 ? `${h12} ${suffix}` : `${h12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function readbackText(
  slot: SlotOption,
  patient: { name: string },
  phoneFromCallerId: boolean,
): string {
  const doctor = slot.doctor ? ` with ${slot.doctor}` : '';
  const phone = phoneFromCallerId ? ' I will use the number you are calling from.' : '';
  return `Ok, I have an appointment for ${patient.name}${doctor} on ${spokenDate(slot.date)} at ${spokenTime(slot.time)} at ${slot.location}.${phone} Shall I book it?`;
}

/**
 * Parse the availability block into individual bookable Slots. Supports the
 * controller's grouped format and a flat `date time service with doctor at
 * location` line, so fixtures built before grouping still resolve.
 */
export function parseAvailabilityBlock(block: string): SlotOption[] {
  const slots: SlotOption[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const body = line.slice(2).trim();
    if (/^none\b/i.test(body)) continue;
    const grouped = /^(.+?)\s+·\s+(.+?)\s+·\s+(\d{4}-\d{2}-\d{2}):\s*(.+)$/.exec(body);
    if (grouped) {
      const [, location, service, date, times] = grouped;
      for (const time of times!.split(/\s+/)) {
        if (/^\d{2}:\d{2}$/.test(time)) {
          slots.push({ service: service!.trim(), location: location!.trim(), date: date!, time });
        }
      }
      continue;
    }
    const flat = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+?)(?:\s+with\s+(.+?))?\s+at\s+(.+)$/.exec(body);
    if (flat) {
      slots.push({
        date: flat[1]!,
        time: flat[2]!,
        service: flat[3]!.trim(),
        doctor: flat[4]?.trim(),
        location: flat[5]!.trim(),
      });
    }
  }
  return slots;
}

interface SlotMatch {
  slot?: SlotOption;
  ambiguous: boolean;
}

/** What the Caller's words say about the Slot they want; every field optional. */
interface SlotPreference {
  weekday: number;
  dayNumbers: Set<number>;
  wantedTime: string | null;
  wantedLocation: string | null;
  partOfDay: 'morning' | 'afternoon' | 'evening' | null;
}

function partOfDayOf(time: string): SlotPreference['partOfDay'] {
  const hour = Number(time.split(':')[0]);
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/** The Location the Caller named, matching the full name or its distinctive tail ("hospital"). */
function findLocation(text: string, locations: string[]): string | null {
  let best: string | null = null;
  for (const location of new Set(locations)) {
    const full = location.toLowerCase();
    const tail = full.split(/[^a-z]+/).filter(Boolean).at(-1) ?? '';
    if (text.includes(full) || (tail.length >= 4 && text.includes(tail))) {
      if (best === null || full.length > best.toLowerCase().length) best = location;
    }
  }
  return best;
}

function parsePreference(text: string, now: Date, locations: string[]): SlotPreference {
  const weekday = WEEKDAYS.findIndex((day) => text.includes(day.toLowerCase()));
  const dayNumbers = new Set<number>();
  if (/\btoday\b/.test(text)) dayNumbers.add(now.getUTCDate());
  if (/\btomorrow\b/.test(text)) {
    const tomorrow = new Date(now.getTime() + 86_400_000);
    dayNumbers.add(tomorrow.getUTCDate());
  }
  const timeMatch =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text) ?? /\b(\d{1,2}):(\d{2})\b/.exec(text) ?? /\b(\d{3,4})\b/.exec(text);
  let wantedTime: string | null = null;
  if (timeMatch) {
    let hour: number;
    let minute: number;
    if (timeMatch[3] !== undefined) {
      hour = Number(timeMatch[1]);
      minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
      if (timeMatch[3] === 'pm' && hour < 12) hour += 12;
      if (timeMatch[3] === 'am' && hour === 12) hour = 0;
    } else if (timeMatch[2] !== undefined) {
      hour = Number(timeMatch[1]);
      minute = Number(timeMatch[2]);
    } else {
      // Bare digit runs like "915" or "0930" are common spoken times.
      const digits = timeMatch[1]!;
      hour = Number(digits.slice(0, digits.length - 2));
      minute = Number(digits.slice(-2));
    }
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      wantedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }
  const partOfDay = /\bmorning\b/.test(text)
    ? 'morning'
    : /\bafternoon\b/.test(text)
      ? 'afternoon'
      : /\bevening\b/.test(text)
        ? 'evening'
        : null;
  return { weekday, dayNumbers, wantedTime, wantedLocation: findLocation(text, locations), partOfDay };
}

function slotScore(slot: SlotOption, pref: SlotPreference): number {
  const [year, month, day] = slot.date.split('-').map(Number);
  const slotWeekday = new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay();
  let score = 0;
  if (pref.weekday >= 0 && slotWeekday === pref.weekday) score += 1;
  if (pref.dayNumbers.size > 0 && pref.dayNumbers.has(day!)) score += 1;
  if (pref.wantedTime !== null && slot.time === pref.wantedTime) score += 2;
  if (pref.wantedLocation !== null && slot.location === pref.wantedLocation) score += 3;
  if (pref.partOfDay && partOfDayOf(slot.time) === pref.partOfDay) score += 1;
  return score;
}

/** Identity of a fully specified Slot; Location matters, two venues can share a time. */
const SLOT_KEY = (slot: SlotOption): string => `${slot.date}T${slot.time}@${slot.location}`;

function matchSlot(
  transcript: string,
  slots: SlotOption[],
  now: Date,
  preferred: SlotOption[] = [],
): SlotMatch {
  const pref = parsePreference(normalize(transcript), now, slots.map((slot) => slot.location));
  const preferredKeys = new Set(preferred.map(SLOT_KEY));
  let best = 0;
  let winner: SlotOption | undefined;
  let ambiguous = false;
  for (const slot of slots) {
    let score = slotScore(slot, pref);
    // A Slot the controller just offered outranks a fresh match elsewhere.
    if (preferredKeys.has(SLOT_KEY(slot))) score += 3;
    if (score === 0) continue;
    if (score > best) {
      best = score;
      winner = slot;
      ambiguous = false;
    } else if (score === best) {
      ambiguous = true;
    }
  }
  return { slot: ambiguous ? undefined : winner, ambiguous };
}

/**
 * Pick the Slots to actually offer: the earliest day matching the Caller's
 * stated day, time, Location, or part of day, then up to `limit` times from
 * that one day. A single day keeps a time-only answer ("yes, 9:15") resolvable;
 * Slots that share a date and time but differ by Location collapse to the best
 * one. Falls back to the earliest day when the Caller expressed no preference.
 * The model may only offer what this returns.
 */
function shortlistFor(transcript: string, slots: SlotOption[], now: Date, limit: number): SlotOption[] {
  const pref = parsePreference(normalize(transcript), now, slots.map((slot) => slot.location));
  const scored = slots.map((slot) => ({ slot, score: slotScore(slot, pref) }));
  const matching = scored.filter((entry) => entry.score > 0);
  const pool = matching.length > 0 ? matching : scored;
  pool.sort(
    (a, b) =>
      b.score - a.score || a.slot.date.localeCompare(b.slot.date) || a.slot.time.localeCompare(b.slot.time),
  );
  const day = pool[0]?.slot.date;
  const picked: SlotOption[] = [];
  const seen = new Set<string>();
  for (const entry of pool) {
    if (entry.slot.date !== day) continue;
    if (seen.has(entry.slot.time)) continue;
    seen.add(entry.slot.time);
    picked.push(entry.slot);
    if (picked.length >= limit) break;
  }
  return picked;
}

function extractName(transcript: string, phase: DialogueState['phase']): string | undefined {
  const raw = transcript.trim();
  const patterns = [
    /\bmy name is\s+([a-z][a-z .'-]{1,49})/i,
    /\bi(?:'m| am)\s+([a-z][a-z .'-]{1,49})/i,
    /\bthis is\s+([a-z][a-z .'-]{1,49})/i,
    /\bname is\s+([a-z][a-z .'-]{1,49})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(raw);
    if (!match) continue;
    const name = trimName(match[1]!);
    if (name) return name;
  }
  if (
    phase === 'collecting-patient' &&
    /^[a-z][a-z .'-]{1,49}$/i.test(raw) &&
    !BOOKING_KEYWORDS.test(normalize(raw)) &&
    !AVAILABILITY_INTENT.test(normalize(raw))
  ) {
    return trimName(raw);
  }
  return undefined;
}

function trimName(value: string): string | undefined {
  let name = value.trim();
  const stop = /\s+(and|my|phone|number|mobile|at|on|for|please|book|appointment|is)\b/i.exec(name);
  if (stop) name = name.slice(0, stop.index).trim();
  name = name.replace(/[.,']+$/g, '').trim();
  if (name.length < 2) return undefined;
  return name
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function extractPhone(transcript: string): string | undefined {
  const runs = transcript.match(/\+?\d[\d\s().-]{8,}\d/g) ?? [];
  let best: string | undefined;
  for (const run of runs) {
    const cleaned = run.replace(/[^\d]/g, '');
    if (cleaned.length >= 10 && cleaned.length <= 13 && (!best || cleaned.length > best.length)) best = cleaned;
  }
  return best;
}

function sameSlot(a: SlotOption | undefined, b: SlotOption | undefined): boolean {
  if (!a || !b) return a === b;
  return a.date === b.date && a.time === b.time && a.location === b.location && a.service === b.service;
}

/**
 * Deterministic reducer: one Caller Turn in, one controller decision out. The
 * LLM is only consulted for wording (`continue` and `availability`); reads,
 * readbacks, field questions, goodbyes, and writes are controller-owned.
 */
export class DialogueReducer {
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  reduce(input: ReduceInput): { state: DialogueState; decision: DialogueDecision } {
    const state: DialogueState = {
      ...input.state,
      patient: { ...input.state.patient },
      offeredSlots: input.slots ?? input.state.offeredSlots,
      version: input.state.version,
    };
    const transcript = input.transcript;
    if (isEmergencyIntent(transcript)) {
      state.intent = 'unknown';
      return { state, decision: { kind: 'speak', text: EMERGENCY_LINE } };
    }
    if (input.slots) {
      state.offeredSlots = input.slots;
      if (state.phase === 'idle') state.phase = 'choosing-slot';
    }
    if (state.phase === 'awaiting-confirmation' && state.readback) {
      if (isAffirmative(transcript)) {
        state.confirmation = { readbackGeneration: state.readback.generation, affirmative: true };
      } else if (isNegative(transcript)) {
        state.confirmation = { readbackGeneration: state.readback.generation, affirmative: false };
      }
    }
    if (isAvailabilityIntent(transcript)) state.intent = 'availability';
    else if (state.phase !== 'idle') state.intent = 'book';
    else if (isGoodbyeIntent(transcript)) state.intent = 'goodbye';
    else state.intent = state.intent === 'faq' ? 'faq' : 'unknown';

    // Slot selection can arrive before or after patient details. A short
    // answer resolves against what was just offered before the full list, and
    // a bare "yes" accepts a single-slot offer.
    let match = matchSlot(transcript, state.offeredSlots, this.now(), input.state.lastOffered);
    if (!match.slot && !match.ambiguous && isAffirmative(transcript) && input.state.lastOffered.length === 1) {
      match = { slot: input.state.lastOffered[0], ambiguous: false };
    }
    if (match.slot && !sameSlot(match.slot, state.selectedSlot)) {
      state.selectedSlot = match.slot;
      if (state.phase === 'idle' || state.phase === 'choosing-slot') state.phase = 'collecting-patient';
      state.readback = undefined;
      state.confirmation = undefined;
    }

    const name = extractName(transcript, state.phase);
    if (name) state.patient.name = name;
    const phone = extractPhone(transcript);
    if (phone) {
      state.patient.phone = phone;
      state.patient.phoneSource = 'spoken';
    } else if (!state.patient.phone && input.callerPhone) {
      state.patient.phone = input.callerPhone;
      state.patient.phoneSource = 'caller-id';
    }

    const changed =
      !sameSlot(state.selectedSlot, input.state.selectedSlot) ||
      state.patient.name !== input.state.patient.name ||
      state.patient.phone !== input.state.patient.phone;
    if (changed) state.version = input.state.version + 1;

    // Refresh the offer the model will word when the Caller still needs one.
    const awaitingOffer = !state.selectedSlot && (state.phase === 'choosing-slot' || state.intent === 'availability');
    if (input.slots && awaitingOffer) {
      state.lastOffered = shortlistFor(transcript, state.offeredSlots, this.now(), SHORTLIST_LIMIT);
    }

    if (state.phase === 'awaiting-confirmation') {
      return this.handleConfirmation(state);
    }

    if (state.selectedSlot && state.patient.name && state.patient.phone) {
      return this.enterReadback(state);
    }
    if (state.selectedSlot && !state.patient.name) {
      return { state, decision: { kind: 'speak', text: input.nameQuestion ?? DEFAULT_NAME_QUESTION } };
    }
    if (state.selectedSlot && !state.patient.phone) {
      return { state, decision: { kind: 'speak', text: input.phoneQuestion ?? DEFAULT_PHONE_QUESTION } };
    }
    if (state.intent === 'goodbye') {
      return { state, decision: { kind: 'goodbye' } };
    }
    if (state.intent === 'availability' || match.ambiguous) {
      return { state, decision: { kind: 'availability' } };
    }
    return { state, decision: { kind: 'continue' } };
  }

  private handleConfirmation(state: DialogueState): { state: DialogueState; decision: DialogueDecision } {
    const affirmative = state.confirmation?.affirmative === true;
    if (affirmative) {
      const authorized = this.authorizeBooking(state);
      if (authorized) return { state, decision: { kind: 'book', ...authorized } };
      // The readback did not play through, or state changed since it was read.
      state.readback = undefined;
      state.confirmation = undefined;
      if (state.selectedSlot && state.patient.name && state.patient.phone) {
        return this.enterReadback(state);
      }
      return { state, decision: { kind: 'continue' } };
    }
    if (state.confirmation?.affirmative === false) {
      // "No, my number is ..." corrects a fact rather than rejecting the Slot:
      // keep the Slot and read the corrected facts back.
      if (
        state.readback &&
        state.version !== state.readback.stateVersion &&
        state.selectedSlot &&
        state.patient.name &&
        state.patient.phone
      ) {
        return this.enterReadback(state);
      }
      state.phase = 'choosing-slot';
      state.selectedSlot = undefined;
      state.readback = undefined;
      state.confirmation = undefined;
      return { state, decision: { kind: 'speak', text: 'No problem. Which other time works for you?' } };
    }
    return { state, decision: { kind: 'continue' } };
  }

  /** Called when the transport reports the readback generation reached a played mark. */
  markReadbackPlayed(state: DialogueState, generation: number): DialogueState {
    if (!state.readback || state.readback.generation !== generation) return state;
    return { ...state, readback: { ...state.readback, played: true } };
  }

  /** A cleared/interrupted readback must never authorize a later bare yes. */
  clearReadback(state: DialogueState): DialogueState {
    if (!state.readback) return state;
    return { ...state, readback: undefined, confirmation: undefined };
  }

  /**
   * Booking authorization gate: the exact readback reached a played mark and a
   * later Caller Turn confirmed that generation without state drifting.
   */
  authorizeBooking(state: DialogueState): { slot: SlotOption; patient: { name: string; phone: string } } | null {
    if (!state.readback?.played) return null;
    if (!state.confirmation?.affirmative) return null;
    if (state.confirmation.readbackGeneration !== state.readback.generation) return null;
    if (state.readback.stateVersion !== state.version) return null;
    if (!state.selectedSlot || !state.patient.name || !state.patient.phone) return null;
    return { slot: state.selectedSlot, patient: { name: state.patient.name, phone: state.patient.phone } };
  }

  private enterReadback(state: DialogueState): { state: DialogueState; decision: DialogueDecision } {
    const slot = state.selectedSlot!;
    const name = state.patient.name!;
    state.readbackSeq += 1;
    const generation = state.readbackSeq;
    state.phase = 'awaiting-confirmation';
    state.readback = { generation, stateVersion: state.version, played: false };
    state.confirmation = undefined;
    return {
      state,
      decision: {
        kind: 'readback',
        text: readbackText(slot, { name }, state.patient.phoneSource === 'caller-id'),
        slot,
        generation,
        stateVersion: state.version,
      },
    };
  }
}
