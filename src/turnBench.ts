import { encodeMulaw } from './audio.ts';
import { attenuationGain, mixMulaw } from './echoMix.ts';
import { percentile } from './benchmark.ts';
import { CallStore } from './calls.ts';
import type { Assistant, Transcriber } from './app.ts';
import type { ClinicGuide } from './clinic.ts';
import type { EndpointPolicy, Vad } from './endpoint.ts';
import { LiveCallSession } from './live.ts';
import type { PlaybackResult } from './transport.ts';
import type { Tts } from './tts.ts';

/** One scenario frame is 20 ms of 8 kHz mu-law, the Twilio media cadence. */
export const FRAME_MS = 20;

/** A half-open frame range `[startFrame, endFrame)`. */
export interface TurnBenchSpan {
  startFrame: number;
  endFrame: number;
}

export interface DeclaredUtterance {
  span: TurnBenchSpan;
  text: string;
}

export interface DeclaredSpan {
  span: TurnBenchSpan;
  text: string;
}

export interface DeclaredEcho {
  span: TurnBenchSpan;
}

/** What one scenario run declared and what the live session did in response. */
export interface ScenarioObservations {
  utterances: DeclaredUtterance[];
  interruptions: DeclaredSpan[];
  backchannels: DeclaredSpan[];
  echos: DeclaredEcho[];
  /** Frame of each reply's first outbound audio, in run order, greeting excluded. */
  replyStarts: number[];
  clears: { frame: number; reason: string }[];
  /** Turns whose audio came from Echo rather than the Caller. Must stay 0. */
  selfEchoTurns: number;
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
  echoSpans: number;
  echoFalseStops: number;
  echoFalseStopRate: number;
  selfEchoTurns: number;
}

export interface Summary {
  samples: number;
  p50: number;
  p95: number;
}

interface AggregateCounts {
  scenarios: number;
  utterances: number;
  falseCuts: number;
  backchannels: number;
  backchannelFalseStops: number;
  echoSpans: number;
  echoFalseStops: number;
  selfEchoTurns: number;
}

export interface AggregateMetrics extends AggregateCounts {
  falseCutRate: number;
  replyLatencyMs: Summary;
  stopLatencyMs: Summary & { missed: number };
  backchannelFalseStopRate: number;
  echoFalseStopRate: number;
}

/** Frames after a declared span in which a stop still counts as caused by it. */
const STOP_GRACE_FRAMES = 2;

function toMs(frames: number): number {
  return frames * FRAME_MS;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function summary(values: number[]): Summary {
  return {
    samples: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
  };
}

function inSpan(frame: number, span: TurnBenchSpan): boolean {
  return frame >= span.startFrame && frame < span.endFrame + STOP_GRACE_FRAMES;
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
  let backchannelFalseStops = 0;
  let echoFalseStops = 0;
  for (const clear of obs.clears) {
    const interruption = obs.interruptions.find(
      (entry) => inSpan(clear.frame, entry.span) && !stoppedInterruptions.has(entry),
    );
    if (interruption) {
      stoppedInterruptions.add(interruption);
      stopLatenciesMs.push(toMs(clear.frame - interruption.span.startFrame));
      continue;
    }
    if (obs.backchannels.some((entry) => inSpan(clear.frame, entry.span))) {
      backchannelFalseStops += 1;
      continue;
    }
    if (obs.echos.some((entry) => inSpan(clear.frame, entry.span))) {
      echoFalseStops += 1;
    }
  }

  return {
    name,
    utterances: obs.utterances.length,
    falseCuts,
    falseCutRate: rate(falseCuts, obs.utterances.length),
    replyLatenciesMs,
    replyLatencyMs: summary(replyLatenciesMs),
    stopLatenciesMs,
    stopLatencyMs: { ...summary(stopLatenciesMs), missed: obs.interruptions.length - stoppedInterruptions.size },
    backchannels: obs.backchannels.length,
    backchannelFalseStops,
    backchannelFalseStopRate: rate(backchannelFalseStops, obs.backchannels.length),
    echoSpans: obs.echos.length,
    echoFalseStops,
    echoFalseStopRate: rate(echoFalseStops, obs.echos.length),
    selfEchoTurns: obs.selfEchoTurns,
  };
}

/** Pool every scenario's samples and counts into one baseline number set. */
export function aggregateMetrics(runs: TurnBenchMetrics[]): AggregateMetrics {
  const utterances = runs.reduce((sum, run) => sum + run.utterances, 0);
  const falseCuts = runs.reduce((sum, run) => sum + run.falseCuts, 0);
  const backchannels = runs.reduce((sum, run) => sum + run.backchannels, 0);
  const backchannelFalseStops = runs.reduce((sum, run) => sum + run.backchannelFalseStops, 0);
  const echoSpans = runs.reduce((sum, run) => sum + run.echoSpans, 0);
  const echoFalseStops = runs.reduce((sum, run) => sum + run.echoFalseStops, 0);
  const replyLatenciesMs = runs.flatMap((run) => run.replyLatenciesMs);
  const stopLatenciesMs = runs.flatMap((run) => run.stopLatenciesMs);
  const missed = runs.reduce((sum, run) => sum + run.stopLatencyMs.missed, 0);
  return {
    scenarios: runs.length,
    utterances,
    falseCuts,
    falseCutRate: rate(falseCuts, utterances),
    replyLatencyMs: summary(replyLatenciesMs),
    stopLatencyMs: { ...summary(stopLatenciesMs), missed },
    backchannels,
    backchannelFalseStops,
    backchannelFalseStopRate: rate(backchannelFalseStops, backchannels),
    echoSpans,
    echoFalseStops,
    echoFalseStopRate: rate(echoFalseStops, echoSpans),
    selfEchoTurns: runs.reduce((sum, run) => sum + run.selfEchoTurns, 0),
  };
}

/** Frame role the scripted VAD and the Echo generator both read. */
export type TurnBenchTag = 'speech' | 'silence' | 'backchannel' | 'echo';

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
  /** Feed `tag` until `predicate` holds; false when `maxFrames` run out. */
  feedUntil(tag: TurnBenchTag, predicate: () => boolean, maxFrames: number): Promise<boolean>;
  /** Feed silence until a reply's first audio lands. */
  awaitReply(maxFrames?: number): Promise<boolean>;
}

export interface TurnBenchScenario {
  name: string;
  /** Captured Caller utterance bytes for speech frames; synthetic when absent. */
  callerAudio?: Buffer;
  /** Run while the greeting is still playing, to script a greeting Barge-in. */
  duringGreeting?: boolean;
  run(ctx: TurnBenchContext): Promise<void>;
}

export interface TurnBenchOptions {
  policy: EndpointPolicy;
  /** Shipped configuration until Barge-in becomes always-on (ticket 05). */
  bargeIn?: boolean;
  interruptionMs?: number;
  guide?: ClinicGuide;
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
    replyStarts: [],
    clears: [],
    selfEchoTurns: 0,
  };
  frame = 0;
  private readonly outbound = new OutboundTimeline();
  private readonly gate = new PlaybackGate();
  private readonly session: LiveCallSession;
  private readonly policy: EndpointPolicy;
  private readonly callerBank: Buffer;
  private speechOffset = 0;
  private currentTag: TurnBenchTag = 'silence';
  private lastScoredSpeechTag: TurnBenchTag = 'silence';
  private readonly declarations: { startFrame: number; text: string }[] = [];
  private readonly echoDefaults: EchoFeedOptions;

  constructor(scenario: TurnBenchScenario, options: TurnBenchOptions, echoDefaults: EchoFeedOptions) {
    this.policy = options.policy;
    this.echoDefaults = echoDefaults;
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
        return { text: this.textForFrame(this.frame), noSpeech: false };
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
    this.session = new LiveCallSession({
      identity: { callSid: `CAbench-${scenario.name}`, streamSid: `MZbench-${scenario.name}` },
      sendAudio: (chunk) => this.outbound.send(chunk, this.frame),
      vad,
      policy: options.policy,
      transcriber,
      tts,
      guide: options.guide ?? { raw: '# Clinic Guide — Bench Clinic\n', name: 'Bench Clinic' },
      assistant,
      calls: new CallStore(),
      bargeIn: options.bargeIn ?? false,
      interruptionMs: options.interruptionMs,
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
      trace: options.debug ? (event) => console.error('[trace]', JSON.stringify(event)) : undefined,
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
    if (duringGreeting) return;
    let fed = 0;
    while ((this.gate.outstanding > 0 || this.playing) && fed < MAX_SETTLE_FRAMES) {
      await this.feed('silence', 1);
      fed += 1;
    }
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
      await this.pushFrame(tag, mixMulaw(background, reference, gain));
    }
  }

  async silence(frames: number): Promise<void> {
    await this.feed('silence', frames);
  }

  async feedUntil(tag: TurnBenchTag, predicate: () => boolean, maxFrames: number): Promise<boolean> {
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
    let fed = 0;
    while ((this.gate.outstanding > 0 || this.playing) && fed < MAX_SETTLE_FRAMES) {
      await this.feed('silence', 1);
      fed += 1;
    }
    this.session.close('bench-complete');
    await settle();
  }

  private textForFrame(frame: number): string {
    let text = '';
    for (const declaration of this.declarations) {
      if (declaration.startFrame <= frame) text = declaration.text;
    }
    return text;
  }

  private speechFrame(): Buffer {
    const slice = Buffer.alloc(FRAME_BYTES, 0xff);
    for (let i = 0; i < FRAME_BYTES; i++) {
      slice[i] = this.callerBank[(this.speechOffset + i) % this.callerBank.length]!;
    }
    this.speechOffset += FRAME_BYTES;
    return slice;
  }

  private async feed(tag: TurnBenchTag, frames: number): Promise<void> {
    for (let i = 0; i < frames; i++) {
      await this.pushFrame(tag, tag === 'silence' ? SILENCE_FRAME : this.speechFrame());
    }
  }

  private async pushFrame(tag: TurnBenchTag, bytes: Buffer): Promise<void> {
    this.gate.advanceTo(this.frame);
    await settle();
    this.currentTag = tag;
    await this.session.receiveAudio(bytes);
    await settle();
    this.frame += 1;
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
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function latencyText(summary: Summary): string {
  return summary.samples > 0 ? `p50 ${summary.p50}ms p95 ${summary.p95}ms (n=${summary.samples})` : 'none (n=0)';
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
  | 'echoSpans'
  | 'echoFalseStops'
  | 'echoFalseStopRate'
  | 'selfEchoTurns'
>;

function metricLine(metrics: MetricLineInput): string {
  const parts = [
    `false-cut ${percent(metrics.falseCutRate)} (${metrics.falseCuts}/${metrics.utterances})`,
    `reply ${latencyText(metrics.replyLatencyMs)}`,
    metrics.stopLatencyMs.samples > 0
      ? `stop p50 ${metrics.stopLatencyMs.p50}ms p95 ${metrics.stopLatencyMs.p95}ms (missed ${metrics.stopLatencyMs.missed})`
      : `stop none (missed ${metrics.stopLatencyMs.missed})`,
    `backchannel false-stop ${percent(metrics.backchannelFalseStopRate)} (${metrics.backchannelFalseStops}/${metrics.backchannels})`,
    `echo false-stop ${percent(metrics.echoFalseStopRate)} (${metrics.echoFalseStops}/${metrics.echoSpans})`,
    `self-echo ${metrics.selfEchoTurns}`,
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
    `policy: silence ${meta.policy.silenceMs}ms  min-speech ${meta.policy.minSpeechMs}ms  max-utterance ${meta.policy.maxUtteranceMs}ms  threshold ${meta.policy.threshold}  dip ${meta.policy.latchDipMs}ms`,
    '',
    metricLine({ ...aggregate, name: 'TOTAL' }),
    ...runs.map(metricLine),
  ];
  return lines.join('\n');
}

/**
 * The scripted corpus the bench gates run. Each scenario declares what the
 * Caller did; the live session runs for real underneath. The baseline build
 * has Barge-in off, so its stop/Backchannel/Echo numbers are degenerate.
 */
export function defaultTurnBenchScenarios(): TurnBenchScenario[] {
  const callerTurn = async (ctx: TurnBenchContext): Promise<void> => {
    await ctx.call('what are your hours', 60);
    await ctx.awaitReply();
  };
  return [
    {
      name: 'steady-turn',
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
    {
      name: 'echo-return',
      run: async (ctx) => {
        await callerTurn(ctx);
        await ctx.echo(40, { delayMs: 120, attenuationDb: -18 });
        await ctx.silence(140);
      },
    },
    {
      name: 'double-talk',
      run: async (ctx) => {
        await callerTurn(ctx);
        await ctx.interrupt('no wait', 40, { echo: { delayMs: 120, attenuationDb: -18 } });
        await ctx.silence(160);
      },
    },
  ];
}
