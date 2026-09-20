import { classifyPartial } from './backchannel.ts';
import { latencyText, latencySummary, type Summary } from './benchmark.ts';

/**
 * Offline analysis of one live call's JSON log lines (the stdout capture the
 * RUNBOOK tails into `/tmp/receptionist.log`). It rebuilds the caller-observable
 * numbers the acceptance report promises — reply latency, stop latency,
 * Backchannel absorption and false stops, Echo false stops, speculation,
 * interrupted readbacks, and Booking writes — from structured traces, so no
 * audio decoding or provider access is needed on the reporting path. The
 * debug-audio captures are listed, not re-analysed.
 */
export interface LogLine {
  at: number;
  ts: string;
  callSid?: string;
  kind?: string;
  component?: string;
  event?: string;
  phase?: string;
  data: Record<string, unknown>;
}

export interface LiveEchoGateSummary {
  decisions: number;
  echoFrames: number;
  callerFrames: number;
  silentFrames: number;
  reasons: Record<string, number>;
}

export interface LiveSpeculationSummary {
  started: number;
  kept: number;
  aborted: number;
}

export interface LiveCallMetrics {
  callSid: string;
  openAt?: string;
  closeAt?: string;
  closeReason?: string;
  turns: number;
  boundaries: { provider: number; local: number };
  replyLatenciesMs: number[];
  replyLatencyMs: Summary;
  stopLatenciesMs: number[];
  stopLatencyMs: Summary;
  bargeIns: number;
  selfEchoBargeIns: number;
  backchannelAbsorptions: number;
  backchannelFalseStops: number;
  echoGate: LiveEchoGateSummary;
  speculation: LiveSpeculationSummary;
  readbackDecisions: number;
  interruptedReadbacks: number;
  bookingAttempts: number;
  bookingsSaved: number;
  bookingsAfterInterruptedReadback: number;
  holdLines: number;
  audioCaptures: string[];
}

/** Tolerant parse: only JSON objects with a usable `ts` become lines. */
export function parseLogLines(text: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed[0] !== '{') continue;
    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      data = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = data.ts;
    if (typeof ts !== 'string') continue;
    const at = Date.parse(ts);
    if (Number.isNaN(at)) continue;
    const line: LogLine = { at, ts, data };
    if (typeof data.callSid === 'string') line.callSid = data.callSid;
    if (typeof data.kind === 'string') line.kind = data.kind;
    if (typeof data.component === 'string') line.component = data.component;
    if (typeof data.event === 'string') line.event = data.event;
    if (typeof data.phase === 'string') line.phase = data.phase;
    lines.push(line);
  }
  return lines;
}

/** Distinct call ids, in order of first appearance. */
export function callSids(lines: LogLine[]): string[] {
  const seen: string[] = [];
  for (const line of lines) {
    if (line.callSid !== undefined && !seen.includes(line.callSid)) seen.push(line.callSid);
  }
  return seen;
}

/** Every line scoped to one call; appointment-API lines carry no call id. */
export function selectCall(lines: LogLine[], callSid: string): LogLine[] {
  return lines.filter((line) => line.callSid === callSid);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

interface BargeIn {
  at: number;
  candidateMs: number;
}

interface Clear {
  at: number;
  generation?: number;
  reason: string;
}

interface GateDecision {
  at: number;
  echo: boolean;
  reason: string;
}

/**
 * Rebuild one call's turn-taking metrics from its trace lines. Lines must be in
 * log (chronological) order, which stdout preserves.
 */
export function analyzeCall(lines: LogLine[], callSid: string): LiveCallMetrics {
  const call = selectCall(lines, callSid);
  const speechEnds: number[] = [];
  const endpoints: { at: number; anchorAt: number; source: string }[] = [];
  /** Frames the Caller actually heard, the primary reply-latency anchor. */
  const outboundAt: number[] = [];
  /** Provider first-audio, the fallback when no outbound frame was traced. */
  const providerAudioAt: number[] = [];
  const bargeIns: BargeIn[] = [];
  const clears: Clear[] = [];
  /** Twilio `clear` sends; the reliable stop anchor when no barrier was pending. */
  const clearSends: { at: number; reason: string }[] = [];
  const decisions: GateDecision[] = [];
  const readbackDecisions: { at: number }[] = [];
  const ttsStarts: { at: number; generation?: number }[] = [];
  const turns: { at: number; excerpt: string }[] = [];

  let openAt: string | undefined;
  let closeAt: string | undefined;
  let closeReason: string | undefined;
  let backchannelAbsorptions = 0;
  let holdLines = 0;
  const speculation: LiveSpeculationSummary = { started: 0, kept: 0, aborted: 0 };
  const bookingOutcomes: { at: number; ok: boolean }[] = [];
  let bookingAttempts = 0;
  const audioCaptures: string[] = [];

  for (const line of call) {
    if (line.kind === 'session' && line.event === 'open') openAt = line.ts;
    if (line.kind === 'session' && line.event === 'close') {
      closeAt = line.ts;
      closeReason = str(line.data.reason);
      continue;
    }
    if (line.kind === 'audio-dump') {
      const path = str(line.data.path);
      if (path !== undefined) audioCaptures.push(path);
      continue;
    }
    if (line.kind === 'turn') {
      turns.push({ at: line.at, excerpt: str(line.data.excerpt) ?? '' });
      continue;
    }
    if (line.kind === 'phase') {
      if (line.phase === 'tts' && line.event === 'start') {
        ttsStarts.push({ at: line.at, generation: num(line.data.generation) });
        continue;
      }
      if (line.phase === 'tts' && line.event === 'done') continue;
      if (line.phase === 'assistant' && line.event === 'hold') {
        holdLines += 1;
        continue;
      }
      if (line.phase === 'booking' && line.event === 'start') {
        bookingAttempts += 1;
        continue;
      }
      if (line.phase === 'booking' && line.event === 'outcome') {
        bookingOutcomes.push({ at: line.at, ok: bool(line.data.ok) === true });
        continue;
      }
      continue;
    }
    if (line.kind !== 'trace') continue;

    // Historical provider-boundary logs (pre-openai-only-stt): no
    // `vad/endpoint` line, so the provider end-of-turn anchors the Turn.
    if (line.component === 'stt' && line.event === 'vad-speech-end') {
      speechEnds.push(line.at);
      continue;
    }
    if (line.component === 'vad' && line.event === 'endpoint') {
      // The boundary fires after the detector's own trailing silence, so the
      // Caller's last speech sample is the endpoint minus that silence.
      const trailingMs = num(line.data.trailingSilenceMs) ?? 0;
      endpoints.push({ at: line.at, anchorAt: line.at - trailingMs, source: str(line.data.source) ?? 'local' });
      continue;
    }
    if (line.component === 'call' && line.event === 'first-outbound') {
      outboundAt.push(line.at);
      continue;
    }
    if (line.component === 'tts' && (line.event === 'first-audio' || line.event === 'rest-done')) {
      providerAudioAt.push(line.at);
      continue;
    }
    if (line.component === 'call' && line.event === 'barge-in') {
      bargeIns.push({ at: line.at, candidateMs: num(line.data.candidateMs) ?? 0 });
      continue;
    }
    if (line.component === 'call' && line.event === 'playback-cleared') {
      const clear: Clear = { at: line.at, reason: str(line.data.reason) ?? '' };
      const generation = num(line.data.generation);
      if (generation !== undefined) clear.generation = generation;
      clears.push(clear);
      continue;
    }
    if (line.component === 'twilio' && line.event === 'clear-sent') {
      clearSends.push({ at: line.at, reason: str(line.data.reason) ?? '' });
      continue;
    }
    if (line.component === 'call' && line.event === 'backchannel') {
      backchannelAbsorptions += 1;
      continue;
    }
    if (line.component === 'echo-gate' && line.event === 'decision') {
      decisions.push({ at: line.at, echo: bool(line.data.echo) === true, reason: str(line.data.reason) ?? '' });
      continue;
    }
    if (line.component === 'call' && line.event === 'speculation-start') {
      speculation.started += 1;
      continue;
    }
    if (line.component === 'call' && line.event === 'speculation-kept') {
      speculation.kept += 1;
      continue;
    }
    if (line.component === 'call' && line.event === 'speculation-aborted') {
      speculation.aborted += 1;
      continue;
    }
    if (line.component === 'dialogue' && line.event === 'reduced' && str(line.data.decision) === 'readback') {
      readbackDecisions.push({ at: line.at });
      continue;
    }
  }

  // Reply latency: the Caller's last speech sample to the first frame the
  // Caller actually heard. Outbound frames are the true audio start; provider
  // first-audio is the fallback for adapter-only captures where no frame was
  // traced. `vad/endpoint` is the anchor; `stt/vad-speech-end` covers captures
  // that have no endpoint line (adapter-only logs).
  const boundaryList: { at: number; anchorAt: number; source: string }[] =
    endpoints.length > 0
      ? endpoints
      : speechEnds.map((at) => ({ at, anchorAt: at, source: 'provider' }));
  const providerBoundaries =
    endpoints.length > 0 ? endpoints.filter((entry) => entry.source !== 'local').length : speechEnds.length;
  const localBoundaries = endpoints.filter((entry) => entry.source === 'local').length;
  const sortedBoundaries = [...boundaryList].sort((a, b) => a.at - b.at);
  const sortedOutbound = [...outboundAt].sort((a, b) => a - b);
  const sortedProviderAudio = [...providerAudioAt].sort((a, b) => a - b);
  const replyLatenciesMs: number[] = [];
  for (const [index, boundary] of sortedBoundaries.entries()) {
    const nextBoundary = sortedBoundaries[index + 1]?.at ?? Number.POSITIVE_INFINITY;
    const inWindow = (at: number): boolean => at > boundary.at && at < nextBoundary;
    const first = sortedOutbound.find(inWindow) ?? sortedProviderAudio.find(inWindow);
    if (first !== undefined) replyLatenciesMs.push(first - boundary.anchorAt);
  }

  // Stop latency: Barge-in start (when the candidate began speaking) to the
  // `clear` the transport sent. The playback barrier trace only exists when a
  // barrier was pending, so the Twilio send trace is the reliable anchor.
  const stopLatenciesMs: number[] = [];
  for (const bargeIn of bargeIns) {
    const clearTimes = [
      clearSends.find((entry) => entry.at >= bargeIn.at && entry.reason === 'caller-barge-in')?.at,
      clears.find((entry) => entry.at >= bargeIn.at && entry.reason === 'caller-barge-in')?.at,
    ].filter((at): at is number => at !== undefined);
    if (clearTimes.length === 0) continue;
    stopLatenciesMs.push(Math.min(...clearTimes) - (bargeIn.at - bargeIn.candidateMs));
  }

  // A Barge-in whose candidate window held no caller-classified frame was the
  // Receptionist's own voice returning: the Echo false-stop live proxy. Silence
  // and `no-reference` frames carry no caller evidence, so they never clear it.
  let selfEchoBargeIns = 0;
  for (const bargeIn of bargeIns) {
    const windowStart = bargeIn.at - bargeIn.candidateMs;
    const callerHeard = decisions.some(
      (decision) =>
        decision.at >= windowStart &&
        decision.at <= bargeIn.at &&
        !decision.echo &&
        decision.reason !== 'silence' &&
        decision.reason !== 'no-reference',
    );
    if (!callerHeard) selfEchoBargeIns += 1;
  }

  // A Backchannel false stop is a Barge-in whose resulting Turn transcribed as
  // an acknowledgement the classifier would have absorbed. The Turn must follow
  // closely; a later unrelated Turn is not evidence against this Barge-in.
  const FALSE_STOP_TURN_MS = 15_000;
  let backchannelFalseStops = 0;
  for (const bargeIn of bargeIns) {
    const nextTurn = turns.find((entry) => entry.at > bargeIn.at && entry.at - bargeIn.at <= FALSE_STOP_TURN_MS);
    if (nextTurn !== undefined && classifyPartial(nextTurn.excerpt) === 'backchannel') backchannelFalseStops += 1;
  }

  // Readback fates: each readback speech generation either played out or was
  // cleared by a Barge-in. A save is only a gate breach while the latest
  // readback before a Barge-in cleared it; a fresh played readback clears it.
  const readbackFates: { at: number; interrupted: boolean }[] = [];
  for (const decision of readbackDecisions) {
    const start = ttsStarts.find((entry) => entry.at > decision.at);
    if (start?.generation === undefined) continue;
    const clear = clears.find((entry) => entry.reason === 'caller-barge-in' && entry.generation === start.generation);
    readbackFates.push({ at: start.at, interrupted: clear !== undefined });
  }
  const interruptedReadbacks = readbackFates.filter((fate) => fate.interrupted).length;
  const interruptedAt = (saveAt: number): boolean => {
    const latest = readbackFates.filter((fate) => fate.at < saveAt).sort((a, b) => b.at - a.at)[0];
    return latest?.interrupted === true;
  };

  const bookingsSaved = bookingOutcomes.filter((outcome) => outcome.ok).length;
  const bookingsAfterInterruptedReadback = bookingOutcomes.filter(
    (outcome) => outcome.ok && interruptedAt(outcome.at),
  ).length;

  const reasons: Record<string, number> = {};
  for (const decision of decisions) reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
  const echoGate: LiveEchoGateSummary = {
    decisions: decisions.length,
    echoFrames: decisions.filter((decision) => decision.echo).length,
    callerFrames: decisions.filter(
      (decision) => !decision.echo && decision.reason !== 'silence' && decision.reason !== 'no-reference',
    ).length,
    silentFrames: decisions.filter((decision) => decision.reason === 'silence').length,
    reasons,
  };

  const metrics: LiveCallMetrics = {
    callSid,
    turns: sortedBoundaries.length,
    boundaries: { provider: providerBoundaries, local: localBoundaries },
    replyLatenciesMs,
    replyLatencyMs: latencySummary(replyLatenciesMs),
    stopLatenciesMs,
    stopLatencyMs: latencySummary(stopLatenciesMs),
    bargeIns: bargeIns.length,
    selfEchoBargeIns,
    backchannelAbsorptions,
    backchannelFalseStops,
    echoGate,
    speculation,
    readbackDecisions: readbackDecisions.length,
    interruptedReadbacks,
    bookingAttempts,
    bookingsSaved,
    bookingsAfterInterruptedReadback,
    holdLines,
    audioCaptures,
  };
  if (openAt !== undefined) metrics.openAt = openAt;
  if (closeAt !== undefined) metrics.closeAt = closeAt;
  if (closeReason !== undefined) metrics.closeReason = closeReason;
  return metrics;
}

/**
 * Echo false stops on a live call are Barge-ins with no caller-heard frame in
 * their candidate window (only returning Echo or silence was audible), plus any
 * explicit Backchannel false stop. On synthetic runs the bench measures these
 * directly.
 */
export function liveGatePasses(metrics: LiveCallMetrics): {
  echoFalseStopPass: boolean;
  backchannelFalseStopPass: boolean;
  interruptedReadbackBookingPass: boolean;
} {
  return {
    echoFalseStopPass: metrics.selfEchoBargeIns === 0,
    backchannelFalseStopPass: metrics.backchannelFalseStops === 0,
    interruptedReadbackBookingPass: metrics.bookingsAfterInterruptedReadback === 0,
  };
}

function verdict(pass: boolean): string {
  return pass ? 'PASS' : 'FAIL';
}

/** Human-readable live-call report; the acceptance document quotes these lines. */
export function formatLiveCallReport(metrics: LiveCallMetrics): string {
  const gates = liveGatePasses(metrics);
  const close = [metrics.closeAt ?? 'open', metrics.closeReason ?? 'no-close-reason'].join(' ');
  return [
    `live call ${metrics.callSid}  opened ${metrics.openAt ?? 'unknown'}  closed ${close}`,
    `turns ${metrics.turns}  boundaries provider ${metrics.boundaries.provider} local ${metrics.boundaries.local}`,
    `reply latency ${latencyText(metrics.replyLatencyMs)}`,
    `stop latency ${latencyText(metrics.stopLatencyMs)}`,
    `barge-in ${metrics.bargeIns}  self-echo barge-ins ${metrics.selfEchoBargeIns}`,
    `backchannels absorbed ${metrics.backchannelAbsorptions}  false-stop ${metrics.backchannelFalseStops}`,
    `echo-gate frames ${metrics.echoGate.decisions}  echo ${metrics.echoGate.echoFrames}  caller ${metrics.echoGate.callerFrames}  silence ${metrics.echoGate.silentFrames}`,
    `hold lines ${metrics.holdLines}`,
    `speculation started ${metrics.speculation.started} kept ${metrics.speculation.kept} aborted ${metrics.speculation.aborted}`,
    `readbacks ${metrics.readbackDecisions}  interrupted ${metrics.interruptedReadbacks}  bookings ${metrics.bookingsSaved}/${metrics.bookingAttempts} saved`,
    `audio captures ${metrics.audioCaptures.length}`,
    `gate echo false-stop ${metrics.selfEchoBargeIns} -> ${verdict(gates.echoFalseStopPass)}`,
    `gate backchannel false-stop ${metrics.backchannelFalseStops} -> ${verdict(gates.backchannelFalseStopPass)}`,
    `gate interrupted-readback bookings ${metrics.bookingsAfterInterruptedReadback} -> ${verdict(gates.interruptedReadbackBookingPass)}`,
  ].join('\n');
}
