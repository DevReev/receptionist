/**
 * Minimal Twilio REST seam for ending a live call. The stream loop answers
 * with `<Connect><Stream>` and no follow-up TwiML, so a session that ends
 * locally (failure, goodbye) can only stop the caller's dead air by hanging
 * the call up here.
 */
export interface TwilioCallEnds {
  hangup: (callSid: string) => Promise<void>;
}

/** POSTs `Status=completed` for the call; resolves on 2xx, throws with the HTTP status otherwise. */
export function twilioCallEnds(opts: {
  accountSid: string;
  authToken: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}): TwilioCallEnds {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = (opts.baseUrl ?? 'https://api.twilio.com').replace(/\/+$/, '');
  const auth = `Basic ${btoa(`${opts.accountSid}:${opts.authToken}`)}`;
  return {
    hangup: async (callSid: string): Promise<void> => {
      const res = await fetchFn(`${base}/2010-04-01/Accounts/${opts.accountSid}/Calls/${callSid}.json`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'Status=completed',
      });
      if (!res.ok) throw new Error(`twilio-hangup-http-${res.status}`);
    },
  };
}
