import { encodeMulaw } from './audio.ts';
import { attenuationGain, mixMulaw } from './echoMix.ts';
import { rms, type EchoReason } from './echoGate.ts';
import { decodeMulaw } from './mulaw.ts';
import { latencyText, latencySummary, type Summary } from './benchmark.ts';
import { CallStore } from './calls.ts';
import { HYBRID_DEFAULTS } from './hybridDetector.ts';
import type { Assistant, Transcriber, Transcription } from './app.ts';
import type { EndpointPolicy, Vad } from './endpoint.ts';
import { LiveCallSession } from './live.ts';
import type { PartialTranscript, RealtimeStt } from './realtimeStt.ts';
import type { PlaybackResult } from './transport.ts';
import type { Tts } from './tts.ts';

/** One scenario frame is 20 ms of 8 kHz mu-law, the Twilio media cadence. */
export const FRAME_MS = 20;

/** A half-open frame range `[startFrame, endFrame)`. */
export interface TurnBenchSpan {
  startFrame: number;
  endFrame: number;
}

export interface DeclaredSpan {
  span: TurnBenchSpan;
  text: string;
}

export interface DeclaredEcho {
  span: TurnBenchSpan;
}

/** One Echo-gate classification, attributed to the frame it decided. */
export interface GateDecisionObservation {
  frame: number;
  echo: boolean;
  reason: EchoReason;
  correlation: number;
  /** True when the frame's intended Caller background carried audible speech. */
  caller: boolean;
  /** True when the frame's inbound actually carried mixed returning Echo. */
  echoMixed: boolean;
}

/** What one scenario run declared and what the live session did in response. */
export interface ScenarioObservations {
  utterances: DeclaredSpan[];
  interruptions: DeclaredSpan[];
  backchannels: DeclaredSpan[];
  echos: DeclaredEcho[];
  /** Every Backchannel the session absorbed, traced back to its frame. */
  backchannelAbsorptions: { frame: number; text: string }[];
  /** Every Echo-gate classification, in inbound order. */
  gateDecisions: GateDecisionObservation[];
  /** Frame of each reply's first outbound audio, in run order, greeting excluded. */
  replyStarts: number[];
  clears: { frame: number; reason: string }[];
  /** Turns whose audio came from Echo rather than the Caller. Must stay 0. */
  selfEchoTurns: number;
}

/** How the Echo gate classified the frames the scenario declared. */
export interface GateMetrics {
  /** Decisions inside declared Echo spans. */
  echoFrames: number;
  /** Echo-span frames the gate passed as Caller. Lower is better. */
  echoFalsePasses: number;
  /** Decisions inside declared Caller-while-speaking spans (Barge-in, Backchannels). */
  callerFrames: number;
  /** Caller-while-speaking frames the gate flagged Echo. Lower is better. */
  callerFalseBlocks: number;
  falsePassRate: number;
  falseBlockRate: number;
}

export interface TurnBenchMetrics {
  name: string;
  utterances: number;
  falseCuts: number;
  falseCutRate: number;
  replyLatenciesMs: number[];
  replyLatencyMs: Summary;
  stopLatenciesMs: number[];
  stopLatencyMs: Summary & { missed: number };
  backchannels: number;
  backchannelFalseStops: number;
  backchannelFalseStopRate: number;
  /** Backchannels the session absorbed instead of stopping on. */
  backchannelAbsorptions: number;
  echoSpans: number;
  echoFalseStops: number;
  echoFalseStopRate: number;
  selfEchoTurns: number;
  gate: GateMetrics;
}

interface AggregateCounts {
  scenarios: number;
  utterances: number;
  falseCuts: number;
  backchannels: number;
  backchannelFalseStops: number;
  backchannelAbsorptions: number;
  echoSpans: number;
  echoFalseStops: number;
  selfEchoTurns: number;
  gateEchoFrames: number;
  gateEchoFalsePasses: number;
  gateCallerFrames: number;
  gateCallerFalseBlocks: number;
}

export interface AggregateMetrics extends AggregateCounts {
  falseCutRate: number;
  replyLatencyMs: Summary;
  stopLatencyMs: Summary & { missed: number };
  backchannelFalseStopRate: number;
  echoFalseStopRate: number;
  gate: GateMetrics;
}

/** Frames after a declared span in which a stop still counts as caused by it. */
const STOP_GRACE_FRAMES = 2;

function toMs(frames: number): number {
  return frames * FRAME_MS;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function inSpan(frame: number, span: TurnBenchSpan): boolean {
  return frame >= span.startFrame && frame < span.endFrame + STOP_GRACE_FRAMES;
}

function inDeclaredSpan(frame: number, span: TurnBenchSpan): boolean {
  return frame >= span.startFrame && frame < span.endFrame;
}

/**
 * Score the Echo gate against what the scenario actually fed. A frame whose
 * intended Caller background was audible counts as Caller when it falls in a
 * declared Caller-while-speaking span (content-first, like clear
 * attribution). A frame with mixed returning Echo and no audible Caller
 * counts as Echo. Silent frames and frames with no Echo mix are not scored.
 */
export function gateMetrics(obs: ScenarioObservations): GateMetrics {
  let echoFrames = 0;
  let echoFalsePasses = 0;
  let callerFrames = 0;
  let callerFalseBlocks = 0;
  for (const decision of obs.gateDecisions) {
    if (decision.reason === 'silence') continue;
    const callerSpan = [...obs.interruptions, ...obs.backchannels].some((entry) =>
      inDeclaredSpan(decision.frame, entry.span),
    );
    if (callerSpan && decision.caller) {
      callerFrames += 1;
      if (decision.echo) callerFalseBlocks += 1;
      continue;
    }
    const echoSpan = callerSpan || obs.echos.some((entry) => inDeclaredSpan(decision.frame, entry.span));
    if (echoSpan && decision.echoMixed) {
      echoFrames += 1;
      if (!decision.echo) echoFalsePasses += 1;
    }
  }
  return {
    echoFrames,
    echoFalsePasses,
    callerFrames,
    callerFalseBlocks,
    falsePassRate: rate(echoFalsePasses, echoFrames),
    falseBlockRate: rate(callerFalseBlocks, callerFrames),
  };
}

/**
 * Derive the turn-taking metrics a scenario promised. A reply that starts
 * before its Caller utterance ends is a false cut; a clear inside a content
 * interruption is a stop sample; a clear inside a Backchannel or Echo span is
 * a false stop. Each clear is attributed once, content-first.
 */
export function scenarioMetrics(name: string, obs: ScenarioObservations): TurnBenchMetrics {
  const falseCutUtterances = obs.utterances.filter((utterance) =>
    obs.replyStarts.some((start) => start > utterance.span.startFrame && start < utterance.span.endFrame),
  );
  const falseCuts = falseCutUtterances.length;
  const replyLatenciesMs: number[] = [];
  for (const [index, utterance] of obs.utterances.entries()) {
    if (falseCutUtterances.includes(utterance)) continue;
    const nextStart = obs.utterances[index + 1]?.span.startFrame ?? Number.POSITIVE_INFINITY;
    const reply = obs.replyStarts.find((start) => start >= utterance.span.endFrame && start < nextStart);
    if (reply !== undefined) replyLatenciesMs.push(toMs(reply - utterance.span.endFrame));
  }

  const stopLatenciesMs: number[] = [];
  const stoppedInterruptions = new Set<DeclaredSpan>();
  const stoppedBackchannels = new Set<DeclaredSpan>();
  const stoppedEchos = new Set<DeclaredEcho>();
  for (const clear of obs.clears) {
    const interruption = obs.interruptions.find(
      (entry) => inSpan(clear.frame, entry.span) && !stoppedInterruptions.has(entry),
    );
    if (interruption) {
      stoppedInterruptions.add(interruption);
      stopLatenciesMs.push(toMs(clear.frame - interruption.span.startFrame));
      continue;
    }
    const backchannel = obs.backchannels.find((entry) => inSpan(clear.frame, entry.span));
    if (backchannel) {
      stoppedBackchannels.add(backchannel);
      continue;
    }
    const echo = obs.echos.find((entry) => inSpan(clear.frame, entry.span));
    if (echo) stoppedEchos.add(echo);
  }

  return {
    name,
    utterances: obs.utterances.length,
    falseCuts,
    falseCutRate: rate(falseCuts, obs.utterances.length),
    replyLatenciesMs,
    replyLatencyMs: latencySummary(replyLatenciesMs),
    stopLatenciesMs,
    stopLatencyMs: { ...latencySummary(stopLatenciesMs), missed: obs.interruptions.length - stoppedInterruptions.size },
    backchannels: obs.backchannels.length,
    backchannelFalseStops: stoppedBackchannels.size,
    backchannelFalseStopRate: rate(stoppedBackchannels.size, obs.backchannels.length),
    backchannelAbsorptions: obs.backchannelAbsorptions.length,
    echoSpans: obs.echos.length,
    echoFalseStops: stoppedEchos.size,
    echoFalseStopRate: rate(stoppedEchos.size, obs.echos.length),
    selfEchoTurns: obs.selfEchoTurns,
    gate: gateMetrics(obs),
  };
}

/** Pool every scenario's samples and counts into one baseline number set. */
export function aggregateMetrics(runs: TurnBenchMetrics[]): AggregateMetrics {
  const utterances = runs.reduce((sum, run) => sum + run.utterances, 0);
  const falseCuts = runs.reduce((sum, run) => sum + run.falseCuts, 0);
  const backchannels = runs.reduce((sum, run) => sum + run.backchannels, 0);
  const backchannelFalseStops = runs.reduce((sum, run) => sum + run.backchannelFalseStops, 0);
  const backchannelAbsorptions = runs.reduce((sum, run) => sum + run.backchannelAbsorptions, 0);
  const echoSpans = runs.reduce((sum, run) => sum + run.echoSpans, 0);
  const echoFalseStops = runs.reduce((sum, run) => sum + run.echoFalseStops, 0);
  const replyLatenciesMs = runs.flatMap((run) => run.replyLatenciesMs);
  const stopLatenciesMs = runs.flatMap((run) => run.stopLatenciesMs);
  const missed = runs.reduce((sum, run) => sum + run.stopLatencyMs.missed, 0);
  const gateEchoFrames = runs.reduce((sum, run) => sum + run.gate.echoFrames, 0);
  const gateEchoFalsePasses = runs.reduce((sum, run) => sum + run.gate.echoFalsePasses, 0);
  const gateCallerFrames = runs.reduce((sum, run) => sum + run.gate.callerFrames, 0);
  const gateCallerFalseBlocks = runs.reduce((sum, run) => sum + run.gate.callerFalseBlocks, 0);
  return {
    scenarios: runs.length,
    utterances,
    falseCuts,
    falseCutRate: rate(falseCuts, utterances),
    replyLatencyMs: latencySummary(replyLatenciesMs),
    stopLatencyMs: { ...latencySummary(stopLatenciesMs), missed },
    backchannels,
    backchannelFalseStops,
    backchannelFalseStopRate: rate(backchannelFalseStops, backchannels),
    backchannelAbsorptions,
    echoSpans,
    echoFalseStops,
    echoFalseStopRate: rate(echoFalseStops, echoSpans),
    selfEchoTurns: runs.reduce((sum, run) => sum + run.selfEchoTurns, 0),
    gateEchoFrames,
    gateEchoFalsePasses,
    gateCallerFrames,
    gateCallerFalseBlocks,
    gate: {
      echoFrames: gateEchoFrames,
      echoFalsePasses: gateEchoFalsePasses,
      callerFrames: gateCallerFrames,
      callerFalseBlocks: gateCallerFalseBlocks,
      falsePassRate: rate(gateEchoFalsePasses, gateEchoFrames),
      falseBlockRate: rate(gateCallerFalseBlocks, gateCallerFrames),
    },
  };
}

/** Frame role the scripted VAD and the Echo generator both read. */
type TurnBenchTag = 'speech' | 'silence' | 'backchannel' | 'echo';

export interface CallerPause {
  /** Milliseconds of caller speech before the pause. */
  afterMs: number;
  /** Pause length in milliseconds. */
  ms: number;
}

export interface CallerTurnOptions {
  /** Pauses inside one utterance, in order. */
  pauses?: CallerPause[];
}

export interface EchoFeedOptions {
  delayMs?: number;
  attenuationDb?: number;
  /** Mix the Caller's own speech into the Echo frames (double-talk). */
  caller?: boolean;
}

export interface InterruptOptions {
  /** Mix the Receptionist's returning Echo into the interruption frames (double-talk). */
  echo?: EchoFeedOptions;
}

/** The scenario-facing surface: how a scripted call drives the live session. */
export interface TurnBenchContext {
  readonly frame: number;
  readonly playing: boolean;
  readonly replyStarts: number[];
  /** One Caller utterance with optional mid-utterance pauses. */
  call(text: string, frames: number, opts?: CallerTurnOptions): Promise<void>;
  /** Content-bearing Caller speech while the Receptionist speaks. */
  interrupt(text: string, frames: number, opts?: InterruptOptions): Promise<void>;
  /** A short acknowledgement while the Receptionist speaks. */
  backchannel(frames: number, text?: string): Promise<void>;
  /** The Receptionist's own voice returning, optionally over Caller speech. */
  echo(frames: number, opts?: EchoFeedOptions): Promise<void>;
  /** Caller silence, advancing the virtual clock. */
  silence(frames: number): Promise<void>;
  /** Feed silence until a reply's first audio lands. */
  awaitReply(maxFrames?: number): Promise<boolean>;
}

export interface TurnBenchScenario {
  name: string;
  /** Captured Caller utterance bytes for speech frames; synthetic when absent. */
  callerAudio?: Buffer;
  /** Run while the greeting is still playing, to script a greeting Barge-in. */
  duringGreeting?: boolean;
  /**
   * Frames between the Turn boundary and the provider's final. 0 (the
   * default) rejects `finalize` at once so the REST path answers immediately;
   * a positive value scripts provider-final latency the speculation can hide.
   */
  finalDelayFrames?: number;
  run(ctx: TurnBenchContext): Promise<void>;
}

export interface TurnBenchOptions {
  policy: EndpointPolicy;
  /** Sustained non-Echo Caller speech that fires a Barge-in. */
  bargeInMinSpeechMs?: number;
  /** Sub-threshold dip a Barge-in candidate tolerates before resetting. */
  bargeInDipToleranceMs?: number;
  /** Wait past the pre-trigger for a partial to classify a Backchannel. */
  bargeInConfirmMs?: number;
  /** Start clearly non-booking replies from partials; false runs the control. */
  speculation?: boolean;
  /** Print session phase/trace lines while a scenario runs. */
  debug?: boolean;
}

export interface TurnBenchRun {
  name: string;
  observations: ScenarioObservations;
  metrics: TurnBenchMetrics;
}

const FRAME_BYTES = 160;
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES, 0xff);
const MAX_SETTLE_FRAMES = 900;
/** RMS above which an intended Caller frame counts as audible speech. */
const CALLER_ENERGY_RMS = 60;

function hasCallerEnergy(mulaw: Buffer): boolean {
  const pcm = decodeMulaw(mulaw);
  return pcm.length > 0 && rms(pcm) >= CALLER_ENERGY_RMS;
}

/** Deterministic speech-like 8 kHz mu-law, so Echo has something to return. */
export function syntheticVoice(samples: number, seed = 1): Buffer {
  const pcm = new Int16Array(samples);
  let state = seed >>> 0;
  const rand = (): number => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let i = 0; i < samples; i++) {
    const t = i / 8000;
    const pitch = 110 + 40 * Math.sin(2 * Math.PI * 0.3 * t) + 10 * rand();
    const envelope = 0.35 + 0.25 * Math.sin(2 * Math.PI * 2.5 * t) + 0.1 * rand();
    const sample = 6000 * envelope * (Math.sin(2 * Math.PI * pitch * t) + 0.4 * Math.sin(4 * Math.PI * pitch * t));
    pcm[i] = Math.round(Math.max(-32768, Math.min(32767, sample)));
  }
  return encodeMulaw(pcm);
}

/** How long the stub voice takes to speak a phrase. */
function voiceFrames(text: string): number {
  return Math.min(250, Math.max(80, 60 + Math.ceil(text.length / 4)));
}

interface PendingBarrier {
  dueFrame: number;
  resolve: (result: PlaybackResult) => void;
}

/** Scheduled outbound audio: the reference signal and when each frame "plays". */
class OutboundTimeline {
  private readonly frames = new Map<number, Buffer>();
  readonly replyStarts: number[] = [];
  greetingSeen = false;
  endFrame = 0;

  send(chunk: Buffer, frame: number): void {
    if (chunk.length === 0) return;
    if (this.endFrame <= frame) {
      if (this.greetingSeen) this.replyStarts.push(frame);
      else this.greetingSeen = true;
    }
    const start = Math.max(this.endFrame, frame);
    for (let offset = 0; offset < chunk.length; offset += FRAME_BYTES) {
      const slice = chunk.subarray(offset, Math.min(offset + FRAME_BYTES, chunk.length));
      const bytes = Buffer.alloc(FRAME_BYTES, 0xff);
      slice.copy(bytes);
      this.frames.set(start + offset / FRAME_BYTES, bytes);
    }
    this.endFrame = start + Math.ceil(chunk.length / FRAME_BYTES);
  }

  truncate(frame: number): void {
    this.endFrame = Math.min(this.endFrame, frame);
    for (const index of this.frames.keys()) {
      if (index >= frame) this.frames.delete(index);
    }
  }

  isPlaying(frame: number): boolean {
    return this.endFrame > frame;
  }

  referenceFrame(frame: number): Buffer | undefined {
    return this.frames.get(frame);
  }
}

class PlaybackGate {
  private pending: PendingBarrier[] = [];

  schedule(currentFrame: number, outbound: OutboundTimeline): Promise<PlaybackResult> {
    const dueFrame = Math.max(outbound.endFrame, currentFrame);
    return new Promise<PlaybackResult>((resolve) => {
      this.pending.push({ dueFrame, resolve });
    });
  }

  advanceTo(frame: number): void {
    const due = this.pending.filter((barrier) => barrier.dueFrame <= frame);
    this.pending = this.pending.filter((barrier) => barrier.dueFrame > frame);
    for (const barrier of due) barrier.resolve({ outcome: 'played', mark: '' });
  }

  clear(reason: string): void {
    const cleared = this.pending;
    this.pending = [];
    for (const barrier of cleared) barrier.resolve({ outcome: 'cleared', mark: '', reason });
  }

  get outstanding(): number {
    return this.pending.length;
  }
}

class ScenarioRunner implements TurnBenchContext {
  readonly observations: ScenarioObservations = {
    utterances: [],
    interruptions: [],
    backchannels: [],
    echos: [],
    backchannelAbsorptions: [],
    gateDecisions: [],
    replyStarts: [],
    clears: [],
    selfEchoTurns: 0,
  };
  frame = 0;
  private readonly outbound = new OutboundTimeline();
  private readonly gate = new PlaybackGate();
  private readonly session: LiveCallSession;
  private readonly policy: EndpointPolicy;
  private readonly finalDelayFrames: number;
  private readonly callerBank: Buffer;
  private partialHandler: ((partial: PartialTranscript) => void) | null = null;
  private speechOffset = 0;
  private currentTag: TurnBenchTag = 'silence';
  private frameCallerActive = false;
  private frameEchoMixed = false;
  private lastScoredSpeechTag: TurnBenchTag = 'silence';
  private nextReferenceFrame = 0;
  private readonly declarations: { startFrame: number; text: string }[] = [];
  private readonly echoDefaults: EchoFeedOptions;
  /** Scripted provider finals awaiting their frame, for `finalDelayFrames`. */
  private finalWaiters: { dueFrame: number; resolve: (tx: Transcription) => void }[] = [];

  constructor(scenario: TurnBenchScenario, options: TurnBenchOptions, echoDefaults: EchoFeedOptions) {
    this.policy = options.policy;
    this.echoDefaults = echoDefaults;
    this.finalDelayFrames = scenario.finalDelayFrames ?? 0;
    this.callerBank = scenario.callerAudio ?? syntheticVoice(8000 * 5, 3);
    const vad: Vad = {
      score: async () => {
        const score = this.currentTag === 'silence' ? 0.05 : 0.9;
        if (score >= this.policy.threshold) this.lastScoredSpeechTag = this.currentTag;
        return score;
      },
      reset: () => {},
    };
    const transcriber: Transcriber = {
      transcribe: async () => {
        if (this.lastScoredSpeechTag === 'echo') this.observations.selfEchoTurns += 1;
        return { text: this.latestDeclarationText(this.frame), noSpeech: false };
      },
    };
    const tts: Tts = {
      synthesize: async (text) => ({ audio: syntheticVoice(voiceFrames(text) * FRAME_BYTES, 7) }),
      synthesizeStream: async function* stream(text: string) {
        yield syntheticVoice(voiceFrames(text) * FRAME_BYTES, 7);
      },
    };
    const assistant: Assistant = {
      reply: async () => ({ text: 'Certainly, I can help with that.', endCall: false }),
      replyStream: async function* stream() {
        yield 'Certainly, let me look into that and share what I find. ';
      },
    };
    // The production carrier of Backchannel semantics is the realtime STT
    // channel's partials; this scripted stand-in supplies one per declared
    // speech frame while the bench keeps local boundaries.
    const realtime: RealtimeStt = {
      pushAudio: () => {},
      speechStart: () => {},
      finalize: () =>
        this.finalDelayFrames > 0
          ? new Promise<Transcription>((resolve) =>
              this.finalWaiters.push({ dueFrame: this.frame + this.finalDelayFrames, resolve }),
            )
          : Promise.reject(new Error('bench-realtime-not-streaming')),
      onPartial: (handler) => {
        this.partialHandler = handler;
      },
      close: () => {},
    };
    this.session = new LiveCallSession({
      identity: { callSid: `CAbench-${scenario.name}`, streamSid: `MZbench-${scenario.name}` },
      sendAudio: (chunk) => this.outbound.send(chunk, this.frame),
      vad,
      policy: options.policy,
      transcriber,
      realtime,
      partialSemantics: true,
      tts,
      guide: { raw: '# Clinic Guide — Bench Clinic\n', name: 'Bench Clinic' },
      assistant,
      calls: new CallStore(),
      bargeInMinSpeechMs: options.bargeInMinSpeechMs,
      bargeInDipToleranceMs: options.bargeInDipToleranceMs,
      bargeInConfirmMs: options.bargeInConfirmMs,
      speculation: options.speculation,
      noResponseMs: 0,
      holdAfterMs: 0,
      turnDeadlineMs: 0,
      finishPlayback: () => this.gate.schedule(this.frame, this.outbound),
      clearPlayback: (reason) => {
        this.observations.clears.push({ frame: this.frame, reason });
        this.outbound.truncate(this.frame);
        this.gate.clear(reason);
      },
      logSession: options.debug ? (event) => console.error('[session]', JSON.stringify(event)) : undefined,
      trace: (event) => {
        if (event.component === 'echo-gate' && event.event === 'decision') {
          this.observations.gateDecisions.push({
            frame: this.frame,
            echo: event.echo === true,
            reason: event.reason as EchoReason,
            correlation: Number(event.correlation ?? 0),
            caller: this.frameCallerActive,
            echoMixed: this.frameEchoMixed,
          });
        }
        if (event.component === 'call' && event.event === 'backchannel') {
          this.observations.backchannelAbsorptions.push({ frame: this.frame, text: String(event.text ?? '') });
        }
        if (options.debug) console.error('[trace]', JSON.stringify(event));
      },
    });
  }

  get playing(): boolean {
    return this.outbound.isPlaying(this.frame);
  }

  get replyStarts(): number[] {
    return this.outbound.replyStarts;
  }

  async start(duringGreeting: boolean): Promise<void> {
    void this.session.open().catch(() => {});
    await settle();
    if (!duringGreeting) await this.drainPlayback();
  }

  async call(text: string, frames: number, opts: CallerTurnOptions = {}): Promise<void> {
    const start = this.frame;
    const pauses = [...(opts.pauses ?? [])].sort((a, b) => a.afterMs - b.afterMs);
    let spoken = 0;
    this.declarations.push({ startFrame: start, text });
    for (const pause of pauses) {
      const before = Math.max(0, Math.round(pause.afterMs / FRAME_MS) - spoken);
      await this.feed('speech', before);
      await this.feed('silence', Math.round(pause.ms / FRAME_MS));
      spoken += before;
    }
    await this.feed('speech', Math.max(0, frames - spoken));
    this.observations.utterances.push({ span: { startFrame: start, endFrame: this.frame }, text });
  }

  async interrupt(text: string, frames: number, opts: InterruptOptions = {}): Promise<void> {
    const start = this.frame;
    this.declarations.push({ startFrame: start, text });
    if (opts.echo) await this.feedEcho('speech', frames, opts.echo, true);
    else await this.feed('speech', frames);
    this.observations.interruptions.push({ span: { startFrame: start, endFrame: this.frame }, text });
  }

  async backchannel(frames: number, text = 'mm-hmm'): Promise<void> {
    const start = this.frame;
    this.declarations.push({ startFrame: start, text });
    await this.feed('backchannel', frames);
    this.observations.backchannels.push({ span: { startFrame: start, endFrame: this.frame }, text });
  }

  async echo(frames: number, opts: EchoFeedOptions = {}): Promise<void> {
    const start = this.frame;
    this.observations.echos.push({ span: { startFrame: start, endFrame: start + frames } });
    await this.feedEcho('echo', frames, opts, false);
  }

  private async feedEcho(tag: TurnBenchTag, frames: number, opts: EchoFeedOptions, caller: boolean): Promise<void> {
    const delayFrames = Math.round((opts.delayMs ?? this.echoDefaults.delayMs ?? 120) / FRAME_MS);
    const gain = attenuationGain(opts.attenuationDb ?? this.echoDefaults.attenuationDb ?? -18);
    for (let i = 0; i < frames; i++) {
      const background = caller || opts.caller ? this.speechFrame() : SILENCE_FRAME;
      const reference = this.outbound.referenceFrame(this.frame - delayFrames) ?? SILENCE_FRAME;
      await this.pushFrame(tag, mixMulaw(background, reference, gain), hasCallerEnergy(background), true);
    }
  }

  async silence(frames: number): Promise<void> {
    await this.feed('silence', frames);
  }

  private async feedUntil(tag: TurnBenchTag, predicate: () => boolean, maxFrames: number): Promise<boolean> {
    for (let i = 0; i < maxFrames; i++) {
      await this.feed(tag, 1);
      if (predicate()) return true;
    }
    return predicate();
  }

  async awaitReply(maxFrames = 200): Promise<boolean> {
    const target = this.outbound.replyStarts.length + 1;
    return this.feedUntil('silence', () => this.outbound.replyStarts.length >= target, maxFrames);
  }

  async finish(): Promise<void> {
    await this.drainPlayback();
    this.session.close('bench-complete');
    await settle();
  }

  /** Feed silence until every scheduled playback has ended or been cleared. */
  private async drainPlayback(): Promise<void> {
    let fed = 0;
    while ((this.gate.outstanding > 0 || this.playing) && fed < MAX_SETTLE_FRAMES) {
      await this.feed('silence', 1);
      fed += 1;
    }
  }

  private latestDeclarationText(frame: number): string {
    let text = '';
    for (const declaration of this.declarations) {
      if (declaration.startFrame <= frame) text = declaration.text;
    }
    return text;
  }

  /**
   * A caller-audio frame from the bank. Captured utterances end in trailing
   * silence and have dips; skipping inaudible slices keeps every declared
   * speech frame content-bearing instead of replaying a capture's silence.
   */
  private speechFrame(): Buffer {
    const frames = Math.max(1, Math.ceil(this.callerBank.length / FRAME_BYTES));
    let frame = this.readFrame();
    for (let attempt = 1; attempt < frames && !hasCallerEnergy(frame); attempt++) {
      frame = this.readFrame();
    }
    return frame;
  }

  private readFrame(): Buffer {
    const slice = Buffer.alloc(FRAME_BYTES, 0xff);
    for (let i = 0; i < FRAME_BYTES; i++) {
      slice[i] = this.callerBank[(this.speechOffset + i) % this.callerBank.length]!;
    }
    this.speechOffset += FRAME_BYTES;
    return slice;
  }

  private async feed(tag: TurnBenchTag, frames: number): Promise<void> {
    for (let i = 0; i < frames; i++) {
      const frame = tag === 'silence' ? SILENCE_FRAME : this.speechFrame();
      await this.pushFrame(tag, frame, hasCallerEnergy(frame));
    }
  }

  private async pushFrame(tag: TurnBenchTag, bytes: Buffer, callerActive = false, echoMixed = false): Promise<void> {
    this.gate.advanceTo(this.frame);
    await settle();
    this.currentTag = tag;
    this.frameCallerActive = callerActive;
    this.frameEchoMixed = echoMixed;
    // The transport retains played audio frame by frame; the bench plays from
    // its own timeline, so every frame that has played since the last push is
    // retained now, in playout order, before this frame is classified.
    this.retainPlayedReference();
    await this.session.receiveAudio(bytes);
    // The provider's partial for the words just heard; cumulative in reality,
    // the declared span text stands in for it here.
    if (tag === 'speech' || tag === 'backchannel') {
      this.partialHandler?.({ text: this.latestDeclarationText(this.frame) });
    }
    await settle();
    this.frameCallerActive = false;
    this.frameEchoMixed = false;
    this.frame += 1;
    this.releaseDueFinals();
  }

  /** Resolve scripted provider finals whose delay has elapsed. */
  private releaseDueFinals(): void {
    if (this.finalWaiters.length === 0) return;
    const due = this.finalWaiters.filter((waiter) => waiter.dueFrame <= this.frame);
    if (due.length === 0) return;
    this.finalWaiters = this.finalWaiters.filter((waiter) => waiter.dueFrame > this.frame);
    for (const waiter of due) {
      waiter.resolve({ text: this.latestDeclarationText(this.frame), noSpeech: false });
    }
  }

  private retainPlayedReference(): void {
    while (this.nextReferenceFrame <= this.frame) {
      const reference = this.outbound.referenceFrame(this.nextReferenceFrame);
      if (!reference) {
        // A frame at or past the scheduled horizon may still arrive (the
        // session schedules audio while this frame is being processed), so
        // stop rather than skip it; earlier gaps are permanent.
        if (this.nextReferenceFrame >= this.outbound.endFrame) break;
        this.nextReferenceFrame += 1;
        continue;
      }
      this.session.retainReference(reference);
      this.nextReferenceFrame += 1;
    }
  }
}

/** Let the session's promise chains run a few macrotask turns. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function runScenario(scenario: TurnBenchScenario, options: TurnBenchOptions): Promise<TurnBenchRun> {
  const runner = new ScenarioRunner(scenario, options, { delayMs: 120, attenuationDb: -18 });
  await runner.start(scenario.duringGreeting ?? false);
  try {
    await scenario.run(runner);
  } finally {
    await runner.finish();
  }
  const observations: ScenarioObservations = { ...runner.observations, replyStarts: runner.replyStarts };
  return { name: scenario.name, observations, metrics: scenarioMetrics(scenario.name, observations) };
}

export interface TurnBenchReportMeta {
  build: string;
  policy: EndpointPolicy;
  fixtures: number;
  /** Sustained non-Echo speech that fires a Barge-in in this run. */
  bargeInMinSpeechMs: number;
  /** Dip tolerance a Barge-in candidate ran with. */
  bargeInDipToleranceMs: number;
  /** How long the candidate waited for partial semantics in this run. */
  bargeInConfirmMs: number;
  /** Whether clearly non-booking partials started replies in this run. */
  speculation: boolean;
}

/**
 * Agreed classification bars for the Echo gate (ticket 04): at most 5% of
 * declared Echo frames may pass as Caller, and at most 5% of declared Caller
 * frames heard while the Receptionist speaks may be blocked as Echo.
 */
export const ECHO_GATE_BARS = { falsePassRate: 0.05, falseBlockRate: 0.05 } as const;

/**
 * Hard safety bar (ticket 05): the Receptionist's own voice returning through
 * the Caller's phone must never start a Turn, however loud the return is.
 */
export const SELF_ECHO_BAR = { selfEchoTurns: 0 } as const;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

type MetricLineInput = Pick<
  TurnBenchMetrics,
  | 'name'
  | 'utterances'
  | 'falseCuts'
  | 'falseCutRate'
  | 'replyLatencyMs'
  | 'stopLatencyMs'
  | 'backchannels'
  | 'backchannelFalseStops'
  | 'backchannelFalseStopRate'
  | 'backchannelAbsorptions'
  | 'echoSpans'
  | 'echoFalseStops'
  | 'echoFalseStopRate'
  | 'selfEchoTurns'
  | 'gate'
>;

function metricLine(metrics: MetricLineInput): string {
  const parts = [
    `false-cut ${percent(metrics.falseCutRate)} (${metrics.falseCuts}/${metrics.utterances})`,
    `reply ${latencyText(metrics.replyLatencyMs)}`,
    metrics.stopLatencyMs.samples > 0
      ? `stop p50 ${metrics.stopLatencyMs.p50}ms p95 ${metrics.stopLatencyMs.p95}ms (missed ${metrics.stopLatencyMs.missed})`
      : `stop none (missed ${metrics.stopLatencyMs.missed})`,
    `backchannel false-stop ${percent(metrics.backchannelFalseStopRate)} (${metrics.backchannelFalseStops}/${metrics.backchannels})  absorbed ${metrics.backchannelAbsorptions}`,
    `echo false-stop ${percent(metrics.echoFalseStopRate)} (${metrics.echoFalseStops}/${metrics.echoSpans})`,
    `self-echo ${metrics.selfEchoTurns}`,
    `gate pass ${percent(metrics.gate.falsePassRate)} (${metrics.gate.echoFalsePasses}/${metrics.gate.echoFrames})`,
    `gate block ${percent(metrics.gate.falseBlockRate)} (${metrics.gate.callerFalseBlocks}/${metrics.gate.callerFrames})`,
  ];
  return `${metrics.name.padEnd(24)} ${parts.join('  ')}`;
}

/** Human-readable bench output: one line per scenario plus the pooled baseline. */
export function formatTurnBenchReport(
  meta: TurnBenchReportMeta,
  runs: TurnBenchMetrics[],
  aggregate: AggregateMetrics,
): string {
  const lines = [
    `turn-taking bench  build ${meta.build}  fixtures ${meta.fixtures}`,
    `policy: silence ${meta.policy.silenceMs}ms (Barge-in candidate reset)  min-speech ${meta.policy.minSpeechMs}ms  max-utterance ${meta.policy.maxUtteranceMs}ms  threshold ${meta.policy.threshold}  dip ${meta.policy.latchDipMs}ms`,
    `detector: hybrid local  adaptive pause ${HYBRID_DEFAULTS.minPauseMs}-${HYBRID_DEFAULTS.maxPauseMs}ms (default ${HYBRID_DEFAULTS.defaultPauseMs}ms, emergency ${HYBRID_DEFAULTS.emergencyMs}ms)  field floor ${HYBRID_DEFAULTS.dialogueFloorMs}ms`,
    `barge-in: min-speech ${meta.bargeInMinSpeechMs}ms  dip-tolerance ${meta.bargeInDipToleranceMs}ms  confirm ${meta.bargeInConfirmMs}ms`,
    `speculation: ${meta.speculation ? 'on (clearly non-booking partials answer early)' : 'off (every reply waits for its final)'}`,
  ];
  const gatePass =
    aggregate.gate.falsePassRate <= ECHO_GATE_BARS.falsePassRate &&
    aggregate.gate.falseBlockRate <= ECHO_GATE_BARS.falseBlockRate;
  lines.push(
    `echo-gate bars: false-pass <= ${percent(ECHO_GATE_BARS.falsePassRate)}  false-block <= ${percent(ECHO_GATE_BARS.falseBlockRate)}  ->  ${gatePass ? 'PASS' : 'FAIL'}`,
  );
  const selfEchoPass = aggregate.selfEchoTurns <= SELF_ECHO_BAR.selfEchoTurns;
  lines.push(
    `safety bar: self-echo Turns == ${SELF_ECHO_BAR.selfEchoTurns}  ->  ${selfEchoPass ? 'PASS' : 'FAIL'} (${aggregate.selfEchoTurns})`,
  );
  lines.push('', metricLine({ ...aggregate, name: 'TOTAL' }), ...runs.map(metricLine));
  return lines.join('\n');
}

/**
 * The scripted corpus the bench gates run. Each scenario declares what the
 * Caller did; the live session runs for real underneath. Echo return is
 * synthesized from the session's own outbound reference at varied delay and
 * attenuation. Barge-in is always on; the Caller's declared speech fires it.
 */
export interface EchoVariant {
  delayMs: number;
  attenuationDb: number;
}

export const DEFAULT_ECHO_VARIANTS: EchoVariant[] = [
  { delayMs: 60, attenuationDb: -12 },
  { delayMs: 120, attenuationDb: -18 },
  { delayMs: 240, attenuationDb: -24 },
];

export function defaultTurnBenchScenarios(echoVariants: EchoVariant[] = DEFAULT_ECHO_VARIANTS): TurnBenchScenario[] {
  const callerTurn = async (ctx: TurnBenchContext): Promise<void> => {
    await ctx.call('what are your hours', 60);
    await ctx.awaitReply();
  };
  const echoReturn = echoVariants.map((variant) => ({
    name: `echo-return-d${variant.delayMs}-a${variant.attenuationDb}`,
    run: async (ctx: TurnBenchContext) => {
      await callerTurn(ctx);
      await ctx.echo(40, variant);
      await ctx.silence(140);
    },
  }));
  const doubleTalkVariant = echoVariants[Math.floor(echoVariants.length / 2)] ?? { delayMs: 120, attenuationDb: -18 };
  return [
    {
      name: 'steady-turn',
      run: async (ctx) => {
        await callerTurn(ctx);
        await ctx.silence(120);
      },
    },
    {
      // The provider holds its final for 600 ms after the boundary: the
      // speculation path answers from the partial, the control waits it out.
      name: 'speculative-faq',
      finalDelayFrames: 30,
      run: async (ctx) => {
        await callerTurn(ctx);
        await ctx.silence(120);
      },
    },
    {
      name: 'short-pause',
      run: async (ctx) => {
        await ctx.call('book for', 60, { pauses: [{ afterMs: 600, ms: 400 }] });
        await ctx.awaitReply();
        await ctx.silence(120);
      },
    },
    {
      name: 'long-pause',
      run: async (ctx) => {
        await ctx.call('my number is', 60, { pauses: [{ afterMs: 600, ms: 1200 }] });
        await ctx.silence(200);
      },
    },
    {
      name: 'barge-in-reply',
      run: async (ctx) => {
        await callerTurn(ctx);
        await ctx.interrupt('no wait, I meant tomorrow', 40);
        await ctx.silence(160);
      },
    },
    {
      name: 'barge-in-greeting',
      duringGreeting: true,
      run: async (ctx) => {
        await ctx.interrupt('excuse me', 40);
        await ctx.silence(160);
      },
    },
    {
      name: 'backchannel-reply',
      run: async (ctx) => {
        await callerTurn(ctx);
        await ctx.backchannel(10);
        await ctx.silence(140);
      },
    },
    ...echoReturn,
    {
      name: `double-talk-d${doubleTalkVariant.delayMs}-a${doubleTalkVariant.attenuationDb}`,
      run: async (ctx) => {
        await callerTurn(ctx);
        await ctx.interrupt('no wait', 40, { echo: doubleTalkVariant });
        await ctx.silence(160);
      },
    },
  ];
}
