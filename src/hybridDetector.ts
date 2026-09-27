/**
 * Local endpointing policy: a Caller-adaptive pause built from the Caller's own
 * intra-utterance silences, plus semantic completeness read from partial
 * transcripts. The local detector owns every Turn boundary.
 *
 * The default until enough pauses are observed is a fixed 300 ms, so the
 * detector never answers faster than the short default but also never waits
 * out a long fixed window. Semantic evidence can only hold the boundary open
 * up to the emergency cap, and a partial that stopped updating goes stale
 * well before it, so a lagging provider can never stall a Turn.
 */

import { tokenize } from './backchannel.ts';

export const HYBRID_DEFAULTS = {
  /** Multiplier over the Caller's p90 pause. */
  factor: 1.25,
  /** How many completed pauses the estimate keeps. */
  window: 8,
  /** Completed pauses needed before the estimate replaces the default. */
  minPauses: 3,
  /** Clamp floor: faster replies are never worth the cut. */
  minPauseMs: 150,
  /** Clamp ceiling: beyond this the pause stops feeling Caller-adaptive. */
  maxPauseMs: 600,
  /** Floor until enough pauses are observed. */
  defaultPauseMs: 300,
  /** Trailing silence that emits regardless of semantic evidence. */
  emergencyMs: 1500,
  /** Floor while the dialogue collects the Patient's name or phone. */
  dialogueFloorMs: 600,
  /**
   * Extra hold past the adaptive floor when a complete sentence carries
   * list/question-pair cues ("I also wanted to ask about the fee — [pause]
   * — and whether you have parking"): the pause may be mid-list, not a Turn
   * end. Bounded well under the stale budget, so a finished list costs one
   * short beat, never an open hold; incomplete partials already hold via
   * completeness, and the emergency and stale caps still bound this above.
   */
  listContinuationMs: 800,
  /**
   * A partial older than this is provider lag, not a mid-thought pause: the
   * boundary treats it as no evidence instead of holding to the emergency
   * cap. It must clear the longest mid-utterance pause the bench holds open
   * (1200 ms) with margin, while still releasing a stalled Turn before the
   * 1500 ms cap.
   */
  stalePartialMs: 1300,
  /**
   * Floor when the session has no partial channel: the adaptive pause alone
   * tracks brief intra-word gaps and can fall near the 150 ms clamp, which
   * cuts utterances into fragments once no semantic evidence can hold the
   * boundary. Matches the retired provider-side 500 ms of silence.
   */
  noPartialsFloorMs: 500,
} as const;

/**
 * 1.25 x p90 of the pauses, clamped. The percentile is nearest-rank (the
 * benchmark harness convention), so with at most eight samples it is the
 * longest pause seen; one outlier eases out of the window within eight more
 * pauses, and the clamp bounds the cost meanwhile.
 */
export function adaptivePauseMs(pauses: readonly number[]): number {
  if (pauses.length < HYBRID_DEFAULTS.minPauses) return HYBRID_DEFAULTS.defaultPauseMs;
  const sorted = [...pauses].sort((a, b) => a - b);
  const rank = Math.ceil(0.9 * sorted.length);
  const p90 = sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
  const floor = HYBRID_DEFAULTS.factor * p90;
  return Math.min(HYBRID_DEFAULTS.maxPauseMs, Math.max(HYBRID_DEFAULTS.minPauseMs, Math.round(floor)));
}

/**
 * The Caller's completed intra-utterance pauses for one call: silence runs
 * that ended because speech resumed. The final run that ends the utterance is
 * not a pause and must not be observed.
 */
export class AdaptivePause {
  private pauses: number[] = [];

  observe(pauseMs: number): void {
    if (!(pauseMs > 0)) return;
    this.pauses.push(pauseMs);
    while (this.pauses.length > HYBRID_DEFAULTS.window) this.pauses.shift();
  }

  get floorMs(): number {
    return adaptivePauseMs(this.pauses);
  }

  reset(): void {
    this.pauses = [];
  }
}

/**
 * Tokens that cannot end an utterance. A trailing one is a clear continuation
 * cue, so the boundary holds briefly for the Caller to finish the thought.
 * Deliberately narrow: function words, fillers, object pronouns expecting
 * their clause ("tell me"), dangling transitive verbs ("want", "need"), and
 * contraction fragments ("don't" tokenizes to "don t"), never content words
 * that can close a thought on their own.
 */
const CONTINUATION_TOKENS: ReadonlySet<string> = new Set([
  // Conjunctions and connectives.
  'and',
  'but',
  'or',
  'nor',
  'so',
  'because',
  'since',
  'if',
  'unless',
  'although',
  'though',
  'while',
  'whereas',
  'that',
  'which',
  'who',
  'whom',
  'whose',
  'whether',
  // Fillers.
  'uh',
  'um',
  'er',
  'erm',
  'ah',
  'hmm',
  'mm',
  'mmm',
  // Prepositions.
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'about',
  'from',
  'by',
  'into',
  'over',
  'after',
  'before',
  'under',
  'between',
  'during',
  'without',
  'through',
  'toward',
  'upon',
  'within',
  'across',
  'behind',
  'beyond',
  'near',
  // Articles and determiners.
  'the',
  'a',
  'an',
  'my',
  'your',
  'his',
  'her',
  'our',
  'their',
  'this',
  'these',
  'those',
  'some',
  'any',
  'each',
  'every',
  // Auxiliaries and copulas.
  'is',
  'are',
  'was',
  'were',
  'am',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'have',
  'has',
  'had',
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'must',
  // Negation and stance modifiers: always mid-thought.
  'not',
  'never',
  'just',
  'also',
  'still',
  'even',
  'only',
  'quite',
  'rather',
  // Determiners and quantifiers expecting their noun.
  'another',
  'other',
  'such',
  'same',
  'few',
  'several',
  'both',
  'either',
  'neither',
  'much',
  'many',
  'more',
  'most',
  // Comparatives expecting the other side.
  'than',
  // Object pronouns expecting their clause ("can you tell me ...").
  'me',
  'us',
  'him',
  'them',
  // Dangling transitive verbs expecting an object or clause ("I want ...",
  // "I'd like ...", "I was wondering ..."). "you" is deliberately absent:
  // "thank you" is a complete thought.
  'tell',
  'tells',
  'told',
  'telling',
  'like',
  'likes',
  'liked',
  'liking',
  'want',
  'wants',
  'wanted',
  'wanting',
  'need',
  'needs',
  'needed',
  'needing',
  'wondering',
  // A booking verb without its object ("I'd like to book ...").
  'book',
  // Contraction fragments: "don't" tokenizes to "don t", "I'm" to "i m",
  // "John's" to "john s". A trailing fragment is always mid-word.
  'don',
  'doesn',
  'didn',
  'isn',
  'aren',
  'wasn',
  'weren',
  'haven',
  'hasn',
  'hadn',
  'won',
  'wouldn',
  'couldn',
  'shouldn',
  'mustn',
  'needn',
  'd',
  'll',
  're',
  've',
  'm',
  's',
  't',
  // Question words.
  'what',
  'when',
  'where',
  'why',
  'how',
]);

const QUESTION_STARTERS: ReadonlySet<string> = new Set([
  'can',
  'could',
  'do',
  'does',
  'did',
  'is',
  'are',
  'was',
  'were',
  'will',
  'would',
  'should',
  'have',
  'has',
  'am',
]);

const SUBJECTS: ReadonlySet<string> = new Set([
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'it',
  'there',
  'this',
  'that',
  'these',
  'those',
]);

/**
 * Abbreviations whose period never ends a sentence: a partial stopping at one
 * is mid-dictation ("I need to see Dr. ..."). Bare "No." is not one of these;
 * it is handled as a complete answer below.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'rs', 'eg', 'ie']);

/** Spoken digits that count toward a dictated phone number's grouping. */
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  'zero',
  'oh',
  'o',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
]);

/** Framing words around a dictated number; everything else is content. */
const PHONE_PREAMBLE: ReadonlySet<string> = new Set([
  'my',
  'number',
  'phone',
  'mobile',
  'cell',
  'is',
  'its',
  'it',
  'the',
  'a',
  'an',
  'uh',
  'um',
  'er',
  'please',
  'call',
  'called',
]);

/** A dictated UK-style mobile is 10-13 digits; anything shorter is still open. */
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 13;

/**
 * Whether a phone-collection partial is still inside an open digit grouping:
 * mostly digits whose count is short of a plausible number, or a complete
 * count with a trailing separator or extension cue ("9876543210 - ...").
 */
function isOpenPhoneGrouping(trimmed: string, raw: string): boolean {
  const digitChars = (trimmed.match(/\d/g) ?? []).length;
  let wordDigits = 0;
  let contentWords = 0;
  for (const token of tokenize(trimmed)) {
    if (NUMBER_WORDS.has(token)) wordDigits += 1;
    else if (/^\d+$/.test(token)) continue;
    else if (!PHONE_PREAMBLE.has(token)) contentWords += 1;
  }
  const digits = digitChars + wordDigits;
  if (digits === 0) return false;
  // A digit inside a content-bearing sentence ("I have 2 kids") is not a
  // dictated number unless the digits dominate or nothing else is said.
  if (contentWords > 0 && digits < 3) return false;
  if (digits < PHONE_MIN_DIGITS) return true;
  if (digits > PHONE_MAX_DIGITS) return false;
  return /[\s\-–—,(\[]$/.test(raw) || /\b(ext|x|extension)\.?$/i.test(trimmed);
}

/**
 * Words that frame a partial as one item of a larger list or question pair
 * on their own: enumerators awaiting a sibling ("first", "second", "third")
 * and the plural ("questions", as in "I have two questions"). Deliberately
 * narrow: single-question phrasing ("I wanted to ask about the fee", "do you
 * have parking") carries none of these and endpoints at the floor. Bare "and"
 * is excluded on purpose: mid-list it arrives with the continuation ("... and
 * whether ..."), so it cannot predict one, and elsewhere it joins single
 * items ("the fee and parking").
 */
const LIST_CONTINUATION_TOKENS: ReadonlySet<string> = new Set(['questions', 'first', 'second', 'third']);

/**
 * Additives that only frame a list together with question-pair structure:
 * "also" in "I also wanted to ask about the fee" projects the pair, while a
 * lone "also" in "I also need to cancel" closes a finished singleton.
 */
const LIST_ADDITIVE_TOKENS: ReadonlySet<string> = new Set(['also', 'additionally', 'another']);

/**
 * The question-pair structure an additive needs to project more list:
 * question framing ("ask", "question", "wondering", "whether") or an
 * enumerator awaiting its sibling.
 */
const LIST_FRAME_TOKENS: ReadonlySet<string> = new Set([
  'ask',
  'asked',
  'asking',
  'asks',
  'question',
  'questions',
  'wonder',
  'wondering',
  'whether',
  'first',
  'second',
  'third',
]);

/** Multi-word additive framing ("as well") that single tokens miss. */
const LIST_CONTINUATION_PHRASES: ReadonlyArray<readonly string[]> = [['as', 'well']];

/**
 * Whether the partial frames itself as one item of a larger list or question
 * pair. A hold cue only, never completeness evidence: a complete sentence
 * with one of these holds the boundary one extra bounded beat past the floor
 * so a mid-list pause ("I also wanted to ask about the fee — [pause] — and
 * whether you have parking") stays one Turn. Empty text carries no cue. The
 * cue is positional: an additive ("also", "another") counts only beside
 * question-pair structure, "both" only with its "and" sibling, and "plus"
 * only joining or trailing (never sentence-initial), so finished singletons
 * ("I also need to cancel", "I take both medications") endpoint at the floor.
 */
export function hasListContinuationCue(text: string): boolean {
  const tokens = tokenize(text);
  if (tokens.length === 0) return false;
  if (tokens.some((token) => LIST_CONTINUATION_TOKENS.has(token))) return true;
  if (
    tokens.some((token) => LIST_ADDITIVE_TOKENS.has(token)) &&
    tokens.some((token) => LIST_FRAME_TOKENS.has(token))
  ) {
    return true;
  }
  // "both" frames a pair only with its sibling ("both the fee and parking");
  // a lone "both" ("I take both medications") is a finished singleton.
  if (tokens.includes('both') && tokens.includes('and')) return true;
  // "plus" frames more list only joining two items or trailing with more to
  // come ("the fee plus parking"); sentence-initial it opens no structure.
  if (tokens.indexOf('plus') > 0) return true;
  return LIST_CONTINUATION_PHRASES.some((phrase) => {
    if (phrase.length > tokens.length) return false;
    for (let i = 0; i + phrase.length <= tokens.length; i++) {
      if (phrase.every((word, index) => tokens[i + index] === word)) return true;
    }
    return false;
  });
}

/**
 * Dialogue field-collection state travelling from the controller to the local
 * detector: whether the Patient's name or phone is being collected, and the
 * phone half of that state (name settled, number still open), where an open
 * digit grouping holds the boundary past the pause. Name collection keeps the
 * floor alone.
 */
export interface FieldCollection {
  collecting?: boolean;
  collectingPhone?: boolean;
}

/**
 * Semantic completeness of the latest partial: incomplete only on a clear
 * continuation cue (trailing conjunction, preposition, article, filler,
 * auxiliary, object pronoun, dangling verb or contraction fragment, a
 * dangling question, a terminal abbreviation, or an open phone grouping
 * while the Patient phone is collected), complete otherwise. No partial at
 * all is complete: without evidence the adaptive pause alone owns the
 * boundary.
 */
export function isSemanticallyComplete(text: string, opts: { collectingPhone?: boolean } = {}): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return true;
  // Explicit sentence punctuation is a strong completion signal, unless the
  // sentence ends on an abbreviation ("Dr.", "e.g."). A bare "No." answers
  // the question; "Room No." is still numbering something.
  if (/[.?!]$/.test(trimmed)) {
    const word = /([A-Za-z.]+)$/.exec(trimmed)?.[1] ?? '';
    const key = word.toLowerCase().replace(/[^a-z]/g, '');
    if (ABBREVIATIONS.has(key)) return false;
    if (key === 'no' && tokens.length > 1) return false;
    return true;
  }
  if (opts.collectingPhone === true && isOpenPhoneGrouping(trimmed, text)) return false;
  const last = tokens[tokens.length - 1]!;
  if (CONTINUATION_TOKENS.has(last)) return false;
  if (tokens.length >= 2) {
    const previous = tokens[tokens.length - 2]!;
    if (QUESTION_STARTERS.has(previous) && SUBJECTS.has(last)) return false;
  }
  return true;
}
