/**
 * Local (hybrid) endpointing policy: a Caller-adaptive pause built from the
 * Caller's own intra-utterance silences, plus semantic completeness read from
 * partial transcripts. `TURN_DETECTION=hybrid` runs this because the provider
 * does not own boundaries on its manual-mode socket; provider VAD mode
 * (`sarvam`) never consults it.
 *
 * The default until enough pauses are observed is a fixed 300 ms, so the
 * detector never answers faster than the short default but also never waits
 * out a long fixed window. Semantic evidence can only hold the boundary open
 * up to the emergency cap, so an unhelpful partial can never stall a Turn.
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
} as const;

/**
 * Stall guard: the provider owns boundaries in `sarvam` mode, but when local
 * speech presence hears a Turn and the provider emits neither an end signal nor
 * a final within this grace, the hybrid detector takes the boundary. Two
 * consecutive stalled Turns escalate the session to the local detector.
 */
export const STALL_DEFAULTS = {
  /** Local trailing silence that takes a provider-held boundary. */
  graceMs: 1200,
  /** Consecutive stalled Turns that switch the session's detector. */
  escalateAfter: 2,
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
 * Deliberately narrow: only function words and fillers, never content words.
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
 * Semantic completeness of the latest partial: incomplete only on a clear
 * continuation cue (trailing conjunction, preposition, article, filler or
 * auxiliary, or a dangling question), complete otherwise. No partial at all is
 * complete: without evidence the adaptive pause alone owns the boundary.
 */
export function isSemanticallyComplete(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // Explicit sentence punctuation is a strong completion signal.
  if (/[.?!]$/.test(trimmed)) return true;
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return true;
  const last = tokens[tokens.length - 1]!;
  if (CONTINUATION_TOKENS.has(last)) return false;
  if (tokens.length >= 2) {
    const previous = tokens[tokens.length - 2]!;
    if (QUESTION_STARTERS.has(previous) && SUBJECTS.has(last)) return false;
  }
  return true;
}
