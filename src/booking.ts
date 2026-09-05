import type { BookingOutcome, FailureEvent, ProposedSlot } from './app.ts';

export interface ProposeBookingArgs {
  callSid: string;
  turn: number;
  excerpt: string;
  slot: ProposedSlot;
}

/**
 * Ticket-1 stand-in for the Picktime guardrail (spec story 26: a hallucinated
 * slot must never become a booking). With no live availability block to check
 * against, every proposed slot is rejected and logged. The Picktime ticket
 * replaces this with hold-then-save; the AppDeps seam stays the same.
 */
export function createInterimGuardrail(
  logFailure: (event: FailureEvent) => void,
): (args: ProposeBookingArgs) => Promise<BookingOutcome> {
  return async (args) => {
    logFailure({
      callSid: args.callSid,
      turn: args.turn,
      reason: 'save-failed',
      excerpt: args.excerpt,
      detail: `booking-not-wired: ${args.slot.service} ${args.slot.date} ${args.slot.time}`,
    });
    return { ok: false, reason: 'booking is not available yet; the clinic will confirm shortly' };
  };
}
