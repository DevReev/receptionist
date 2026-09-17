/**
 * Speculative-reply policy for live partial transcripts. A partial only earns
 * a head start when it cannot be about booking: any digit, date/time word, a
 * known service, doctor, or location name, or book/change/cancel phrasing
 * makes it booking-sensitive, and everything unclear — an empty or one-word
 * partial — defaults to booking-sensitive. Booking-sensitive partials always
 * wait for the final transcription.
 */

export interface SpeculationOptions {
  /** Service, doctor, and Location names; naming one is booking-sensitive. */
  names?: readonly string[];
}

export interface SpeculationDecision {
  /** True when reply generation may start from this partial. */
  speculative: boolean;
  reason: 'non-booking' | 'empty' | 'short' | 'digits' | 'date-time' | 'name' | 'booking';
  /** The word or name that made the partial booking-sensitive. */
  cue?: string;
}

/** Fewer word tokens than this is not clear evidence of a non-booking Turn. */
export const MIN_SPECULATIVE_TOKENS = 2;

/** Book / change / cancel phrasing and availability vocabulary. */
const BOOKING_WORDS: ReadonlySet<string> = new Set([
  'book',
  'books',
  'booking',
  'bookings',
  'booked',
  'appointment',
  'appointments',
  'appoint',
  'schedule',
  'scheduled',
  'scheduling',
  'reschedule',
  'rescheduled',
  'slot',
  'slots',
  'reserve',
  'reserved',
  'reservation',
  'cancel',
  'cancels',
  'cancelled',
  'canceled',
  'cancelling',
  'canceling',
  'cancellation',
  'change',
  'changes',
  'changed',
  'changing',
  'move',
  'moved',
  'moving',
  'available',
  'availability',
  'open',
  'opens',
  'opening',
  'openings',
  'when',
  'time',
  'times',
  'timing',
  'day',
  'days',
  'date',
  'dates',
  'week',
  'weeks',
  'weekly',
  'weekday',
  'weekdays',
  'weekend',
  'weekends',
  'free',
  'earliest',
  'soonest',
  'later',
  'earlier',
  'another',
]);

/** Date and time vocabulary: weekdays, months, relative days, parts of day. */
const DATE_TIME_WORDS: ReadonlySet<string> = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'mon',
  'tue',
  'tues',
  'wed',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
  'sun',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'today',
  'tomorrow',
  'tonight',
  'yesterday',
  'morning',
  'mornings',
  'afternoon',
  'afternoons',
  'evening',
  'evenings',
  'night',
  'nights',
  'noon',
  'midday',
  'midnight',
]);

/** Guide names whose words never cue on their own: they describe the clinic itself. */
const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'dr',
  'doctor',
  'clinic',
  'hospital',
  'appointment',
  'service',
  'services',
  'centre',
  'center',
  'medical',
  'health',
]);

/** Lowercased word tokens: punctuation becomes spaces, digits stay. */
function speculationTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Extract the service, doctor, and Location names the clinic guide lists.
 * Names are the bold entries under headings that mention one of those
 * categories; the guide's other prose is ignored.
 */
export function guideBookingNames(raw: string): string[] {
  const names = new Set<string>();
  let inSection = false;
  for (const line of raw.split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inSection = /location|service|doctor/i.test(heading[1]!);
      continue;
    }
    if (!inSection) continue;
    for (const match of line.matchAll(/\*\*([^*]{2,60})\*\*/g)) {
      const name = match[1]!.split(/[—–]| - /)[0]!.trim();
      if (name.length >= 2) names.add(name);
    }
  }
  return [...names];
}

/** True when `sequence` appears contiguously inside `tokens`. */
function includesSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) return false;
  outer: for (let i = 0; i + sequence.length <= tokens.length; i++) {
    for (let j = 0; j < sequence.length; j++) {
      if (tokens[i + j] !== sequence[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** A guide name matches on its full text or one distinctive word of it. */
function nameCue(tokens: readonly string[], names: readonly string[]): string | null {
  const full = names
    .filter((name) => includesSequence(tokens, speculationTokens(name)))
    .sort((a, b) => b.length - a.length);
  if (full.length > 0) return full[0]!;
  for (const name of names) {
    const word = speculationTokens(name).find(
      (part) => part.length >= 3 && !GENERIC_NAME_WORDS.has(part),
    );
    if (word && tokens.includes(word)) return name;
  }
  return null;
}

/**
 * Decide whether a partial may start a speculative reply. Anything that could
 * be about booking — and anything too thin to tell — is booking-sensitive.
 */
export function classifySpeculation(text: string, opts: SpeculationOptions = {}): SpeculationDecision {
  const tokens = speculationTokens(text);
  if (tokens.length === 0) return { speculative: false, reason: 'empty' };
  const digit = tokens.find((token) => /\d/.test(token));
  if (digit) return { speculative: false, reason: 'digits', cue: digit };
  const dateTime = tokens.find((token) => DATE_TIME_WORDS.has(token));
  if (dateTime) return { speculative: false, reason: 'date-time', cue: dateTime };
  const booking = tokens.find((token) => BOOKING_WORDS.has(token));
  if (booking) return { speculative: false, reason: 'booking', cue: booking };
  const name = nameCue(tokens, opts.names ?? []);
  if (name) return { speculative: false, reason: 'name', cue: name };
  if (tokens.length < MIN_SPECULATIVE_TOKENS) return { speculative: false, reason: 'short' };
  return { speculative: true, reason: 'non-booking' };
}

/**
 * Whether the final transcription carries the partial's words forward. The
 * final usually extends the partial, so an in-order containment passes; a
 * corrected or substituted word or two is tolerated by an overlap fallback.
 */
export function partialAgrees(partial: string, final: string): boolean {
  const partialTokens = speculationTokens(partial);
  const finalTokens = speculationTokens(final);
  if (partialTokens.length === 0 || finalTokens.length === 0) return false;
  let matched = 0;
  for (const token of finalTokens) {
    if (token === partialTokens[matched]) matched += 1;
    if (matched === partialTokens.length) return true;
  }
  const finalSet = new Set(finalTokens);
  const hits = partialTokens.filter((token) => finalSet.has(token)).length;
  return hits / partialTokens.length >= 0.8;
}
