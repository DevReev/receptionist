# 09: Speculative replies

**What to build:** Clearly non-booking partials get a head start: reply generation begins text-only, with Booking tools suppressed, before the final transcription lands; when the final arrives it is kept if it agrees with the partial, otherwise aborted and regenerated from the final. Booking-sensitive partials always wait for the final. Speculation can never propose or save a Booking. The classifier defaults to booking-sensitive, and booking cues include digits, date/time words, service or doctor names, and book/change/cancel phrasing.

**Blocked by:** 03.

**Status:** done

- [x] A scripted non-booking Turn produces reply audio before the final lands, with first-audio latency measurably better than the no-speculation path.
- [x] Speculative generation emits no Booking proposal or tool activity, including when the final disagrees.
- [x] A mismatched final aborts and regenerates; no speculative text reaches history.
- [x] Booking-cue partials never speculate.

## Comments

Implemented. `src/speculation.ts` is the pure policy: `classifySpeculation`
(defaults to booking-sensitive; a cue is any token with a digit, a date/time
word, a book/change/cancel/availability word, or a guide service/doctor/
location name) and `partialAgrees` (an in-order containment passes; an
overlap fallback tolerates a corrected word or two). `guideBookingNames`
extracts the bold names under the guide's Location/Service/Doctor headings.
`AssistantContext.speculative` makes `OpenRouterAssistant` expose no tools at
all for the round, and `runTool` refuses any stray call without touching
`getAvailability`/`proposeBooking`.

`LiveCallSession` owns the state machine. Each partial is classified: a
clearly non-booking one starts `assistant.replyStream` immediately with a
tools-less, writes-forbidden context (first token pull runs while the Caller
still speaks); a later partial that turns booking-sensitive or rewrites the
utterance aborts it. At the utterance boundary the speculative stream is fed
through the normal TTS pipeline straight away, so reply audio starts before
the provider final. When the final lands the reply is kept only if the final
agrees with the partial, the final is still non-booking, the reducer's
decision is `continue`, and no Patient field changed; otherwise the
speculation is aborted (stream + played audio cleared, `cancelledThrough`
raised so its text can never commit) and the Turn regenerates from the final.
An empty final, transcription error, stall, barge-in, and call close all
abort a pending speculation. Traces: `call/speculation-start` (partial,
reason), `call/speculation-kept` (turn, partial, chars, ms),
`call/speculation-aborted` (reason, cue, partial, final, ms).

Interpretations recorded:

- Location names count as Booking cues alongside service and doctor names: a
  Slot is Location-specific, so naming one is never clearly non-booking.
- The booking-word set is deliberately wider than the ticket's examples
  (`when`, `time`, `day`, `open`, `free`, `move`, `later`, `earlier`,
  `another`, `available`). The spec says the classifier defaults to
  booking-sensitive; a missed speculation costs latency, a wrong one costs a
  retraction.
- Fewer than two word tokens never speculates (an empty or one-word partial is
  not clear evidence), and the keep gate re-classifies the final: partials can
  lag, so a final that turns booking-sensitive always aborts even when it
  extends the partial ("the final wins").
- The keep path pushes the Caller's final transcript into history before the
  speculative reply's commit; the reply's history entry is withheld from the
  speculative run and written by the keep path, so order is always caller →
  receptionist and an aborted speculation writes nothing.
- `partialAgrees`' 80% overlap fallback is order-insensitive by design: it
  exists to forgive a substituted word, and with ≤4-token partials it already
  requires the full word set.

Coverage: `speculation.test.ts` (cue classes, guide names, punctuation-heavy
names, short/empty defaults, agreement), `liveSpeculation.test.ts` (audio
before the final, extended-final keep, booking-cue control, mismatch abort and
regenerate with playback cleared and no speculative history, tool/availability
suppression on both outcomes, operator off-switch, booking-cue abort mid-
stream, booking-final abort, empty-final reprompt), `providers.test.ts` (no
tools listed and stray tool calls refused), `turnBench.test.ts` (600 ms
scripted provider final hidden by speculation, paid by the control). Full
suite 444/444.

Bench: `bench-scripts/09-speculative-replies.md` on build `a572ba5-dirty`.
The new `speculative-faq` scenario (provider final held 600 ms past the
boundary) answers at `reply p50 280ms` with speculation on vs `880ms` with
`TURN_BENCH_SPECULATION=false` — the final-wait is hidden; everything else
(false-cut, stops, gates, self-echo) is unchanged.

