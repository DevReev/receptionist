/**
 * Backchannel classification for live partial transcripts. A Backchannel is a
 * short acknowledgement ("mm-hmm", "okay", "right") the Caller makes while the
 * Receptionist holds the floor; it is absorbed rather than treated as a Turn.
 *
 * Classification is deliberately conservative: only text made entirely of
 * known acknowledgement tokens (repeats allowed) is a Backchannel. Anything
 * else — including empty partials — counts as content-bearing, so unknown
 * speech always takes the floor rather than being talked over.
 */

/** Partial class used by the turn-taking module; `unknown` carries no evidence. */
export type PartialClass = 'backchannel' | 'content' | 'unknown';

/** Shortest form of a token: runs of one letter collapse to a single letter. */
function collapse(token: string, maxRun: number): string {
  return token.replace(/(.)\1+/g, (run) => run[0]!.repeat(Math.min(run.length, maxRun)));
}

/** The acknowledgement vocabulary, after lowercasing and punctuation stripping. */
export const BACKCHANNEL_TOKENS: ReadonlySet<string> = new Set([
  // Listening noises and fillers.
  'mm',
  'mmm',
  'hm',
  'hmm',
  'mhm',
  'mhmm',
  'mmhmm',
  'uh',
  'uhh',
  'uhuh',
  'uhhuh',
  'huh',
  'ah',
  'ahh',
  'aha',
  'oh',
  'ooh',
  'oho',
  'eh',
  // Acknowledgements and short agreement phrases.
  'ok',
  'okay',
  'okey',
  'k',
  'yes',
  'yeah',
  'yea',
  'yep',
  'yup',
  'nah',
  'right',
  'alright',
  'sure',
  'fine',
  'good',
  'great',
  'perfect',
  'cool',
  'exactly',
  'thanks',
]);

/**
 * Words that only read as acknowledgements inside a phrase ("I see", "got it",
 * "thank you"). Alone they are fragments of content-bearing speech ("I", "it"),
 * so they never classify a one-token partial as a Backchannel.
 */
export const BACKCHANNEL_PARTICLES: ReadonlySet<string> = new Set([
  'i',
  'see',
  'got',
  'it',
  'all',
  'thank',
  'you',
]);

/** Longest Backchannel: enough for "mm-hmm, okay, right". */
const MAX_BACKCHANNEL_TOKENS = 4;

/** True when one transcribed token reads as an acknowledgement in some form. */
function isBackchannelToken(token: string, standalone: boolean): boolean {
  const forms = [token, collapse(token, 2), collapse(token, 1)];
  if (forms.some((form) => BACKCHANNEL_TOKENS.has(form))) return true;
  return standalone && forms.some((form) => BACKCHANNEL_PARTICLES.has(form));
}

/** Word tokens of a transcript: lowercased, punctuation stripped to spaces. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Classify one partial transcript heard while the Receptionist speaks.
 * `unknown` means the partial carried no usable words yet.
 */
export function classifyPartial(text: string): PartialClass {
  const tokens = tokenize(text);
  if (tokens.length === 0) return 'unknown';
  if (tokens.length > MAX_BACKCHANNEL_TOKENS) return 'content';
  if (tokens.some((token) => /\d/.test(token))) return 'content';
  return tokens.every((token) => isBackchannelToken(token, tokens.length > 1)) ? 'backchannel' : 'content';
}
