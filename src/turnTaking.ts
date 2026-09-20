import { decodeMulaw } from './mulaw.ts';
import { classifyPartial, type PartialClass } from './backchannel.ts';
import { EchoGate, type EchoDecision, type EchoGateOptions } from './echoGate.ts';
import { AdaptivePause, HYBRID_DEFAULTS, STALL_DEFAULTS, isSemanticallyComplete } from './hybridDetector.ts';
import {
  BARGE_IN_DEFAULTS,
  type BackchannelEvent,
  type BargeInEvent,
  type EndpointPolicy,
  type StallEvent,
  type Utterance,
  type Vad,
} from './endpoint.ts';

/** 8 kHz mulaw: one sample per byte, so durations derive from sample counts. */
const SAMPLE_RATE = 8000;

function toMs(samples: number): number {
  return (samples / SAMPLE_RATE) * 1000;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

/** Speech-probability summary for one emitted utterance, for traces and benches. */
export interface UtteranceSpeechStats {
  frames: number;
  maxScore: number;
  meanScore: number;
}

export interface TurnTakingObserver {
  /** A complete Caller utterance, ready for transcription. */
  onUtterance(utterance: Utterance, stats: UtteranceSpeechStats): void;
  /** The Caller has taken the floor; fires once per utterance after the speech latch. */
  onSpeechStart?(): void;
  /** Sustained Caller speech while the Receptionist holds the floor. */
  onBargeIn?(event: BargeInEvent): void;
  /** A short acknowledgement absorbed while the Receptionist held the floor. */
  onBackchannel?(event: BackchannelEvent): void;
  /** A frame the live STT channel should hear; Echo is replaced with silence, never dropped. */
  onUpstreamFrame?(frame: Buffer): void;
  /** Every frame heard while the Receptionist holds the floor, Echo or Caller. */
  onEchoDecision?(decision: EchoDecision): void;
  /** Raw VAD score + latch state per scored frame, for operator diagnostics. */
  onScore?(score: number, latched: boolean): void;
  /** The provider stalled: the local detector took the held boundary. */
  onStall?(event: StallEvent): void;
}

/**
 * Who owns utterance boundaries. `sarvam` delegates them to the speech
 * provider: the local VAD no longer ends Turns and the module only captures
 * the utterance audio between provider boundaries for fallback and fixtures.
 * `hybrid` runs the local detector: the Caller-adaptive pause plus semantic
 * completeness, with the dialogue-aware field floor.
 */
export type TurnDetection = 'sarvam' | 'hybrid';

export interface TurnTakingOptions {
  vad: Vad;
  policy: EndpointPolicy;
  observer: TurnTakingObserver;
  /** Sustained non-Echo Caller speech that fires a Barge-in while the Receptionist speaks. */
  bargeInMinSpeechMs?: number;
  /** Sub-threshold dip a Barge-in candidate tolerates before resetting. */
  bargeInDipToleranceMs?: number;
  /**
   * Partial transcripts arrive while the floor is watched, so a Barge-in
   * candidate holds briefly for Backchannel classification instead of firing
   * on energy alone. Off when the channel only transcribes open utterances.
   */
  partialSemantics?: boolean;
  /** How long the energy pre-trigger waits for partial semantics before taking the floor. */
  bargeInConfirmMs?: number;
  /**
   * Whether partial transcripts feed the local Turn boundary. When true the
   * caller-adaptive pause plus semantic completeness own it; when false (no
   * partial channel at all) a fixed no-partials floor owns it instead.
   */
  semanticBoundaries?: boolean;
  /** Boundary authority for this call. */
  detection: TurnDetection;
  /** Echo-gate tuning; defaults ship the bench-tuned values. */
  echoGate?: EchoGateOptions;
  /** Local trailing silence that takes a stalled provider boundary. */
  stallGraceMs?: number;
}

type Floor = 'listening' | 'watching-barge-in' | 'idle';

/** Partial-transcript evidence for the speech burst under the current candidate. */
interface PartialEvidence {
  cls: PartialClass;
  text: string;
  /** The energy pre-trigger crossed and awaits partial semantics. */
  confirmPending: boolean;
  /** This burst is identified as a Backchannel; its tail is absorbed silently. */
  absorbing: boolean;
}

function emptyPartial(): PartialEvidence {
  return { cls: 'unknown', text: '', confirmPending: false, absorbing: false };
}

/** A frame of mu-law silence (0xFF decodes to zero). */
function silenceMulaw(length: number): Buffer {
  return Buffer.alloc(length, 0xff);
}

/**
 * Owns one call's turn-taking surface: the upstream audio diet, the Echo
 * gate, the local VAD gate, utterance segmentation, Barge-in candidate state,
 * and the guard that takes a stalled provider's boundary. The session above it
 * sees only Turns and Barge-ins. Durations derive from sample counts, never
 * wall-clock time, so behavior is deterministic in tests. Calls serialize
 * internally; callers may fire receiveAudio without awaiting.
 */
export class TurnTaking {
  private readonly vad: Vad;
  private readonly policy: EndpointPolicy;
  private readonly observer: TurnTakingObserver;
  private readonly bargeInMinSpeechMs: number;
  private readonly bargeInDipToleranceMs: number;
  private readonly partialSemantics: boolean;
  private readonly bargeInConfirmMs: number;
  private readonly semanticBoundaries: boolean;
  private detection: TurnDetection;
  private readonly echoGate: EchoGate;
  /** The Caller's own intra-utterance pause rhythm, for the hybrid boundary. */
  private readonly adaptivePause = new AdaptivePause();
  private readonly stallGraceMs: number;
  private readonly minStallSpeechSamples: number;
  private mode: Floor = 'listening';
  private bargeInPending = false;
  private speaking = false;
  /** Absorption is suspended while a confirmation readback plays. */
  private absorptionEnabled = true;
  private partial: PartialEvidence = emptyPartial();
  /** Latest partial of the utterance under capture, for semantic completeness. */
  private lastPartialText = '';
  /** Raised floor from dialogue field state; 0 unless collecting name or phone. */
  private dialogueFloorMs = 0;
  /** Provider speech_open state; the utterance under capture in sarvam mode. */
  private providerOpen = false;
  private providerCorroborated = false;
  /**
   * A provider utterance heard while a Turn is in flight. The session cannot
   * open it yet, so its audio is captured here and adopted when the floor
   * returns: speech the Caller already finished must not be dropped.
   */
  private pendingProviderOpen = false;
  private pendingProviderEnded = false;
  private pendingChunks: Int16Array[] = [];
  private pendingSamples = 0;
  /** Provider-boundary mode: local speech presence, tracked for the stall guard. */
  private stallSpeechSeen = false;
  private stallSpeechSamples = 0;
  private stallTrailingSamples = 0;
  private speechAnnounced = false;
  private candidateSamples = 0;
  private dipSamples = 0;
  private preRollChunks: Int16Array[] = [];
  private preRollSamples = 0;
  private chunks: Int16Array[] = [];
  private bufferedSamples = 0;
  private trailingSilenceSamples = 0;
  private stats = { frames: 0, max: 0, sum: 0 };
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: TurnTakingOptions) {
    this.vad = opts.vad;
    this.policy = opts.policy;
    this.observer = opts.observer;
    this.bargeInMinSpeechMs = opts.bargeInMinSpeechMs ?? BARGE_IN_DEFAULTS.minSpeechMs;
    this.bargeInDipToleranceMs = opts.bargeInDipToleranceMs ?? BARGE_IN_DEFAULTS.dipToleranceMs;
    this.partialSemantics = opts.partialSemantics ?? false;
    this.bargeInConfirmMs = opts.bargeInConfirmMs ?? BARGE_IN_DEFAULTS.confirmMs;
    this.semanticBoundaries = opts.semanticBoundaries ?? true;
    this.detection = opts.detection;
    this.stallGraceMs = opts.stallGraceMs ?? STALL_DEFAULTS.graceMs;
    // A blip is not a Turn: local speech must reach the detector's own
    // minimum-speech floor before the guard trusts it.
    this.minStallSpeechSamples = Math.round((this.policy.minSpeechMs / 1000) * SAMPLE_RATE);
    this.echoGate = new EchoGate(opts.echoGate);
  }

  /** True while a Caller utterance can end a Turn here. */
  get isListening(): boolean {
    return this.mode === 'listening';
  }

  receiveAudio(mulaw: Buffer): Promise<void> {
    const run = this.tail.then(() => this.process(mulaw));
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * Retain one played outbound frame as the Echo reference. The session feeds
   * this from actual playout, so the gate correlates against what the Caller
   * heard rather than what was generated.
   */
  retainReference(mulaw: Buffer): void {
    this.echoGate.pushReference(mulaw);
  }

  /**
   * The Receptionist takes the floor. Inbound audio keeps streaming upstream
   * (Echo replaced with silence) and sustained non-Echo Caller speech fires
   * `onBargeIn`. `absorbBackchannels: false` suspends absorption while a
   * confirmation readback plays, so any answer to it takes the floor instead.
   */
  startSpeaking(opts: { absorbBackchannels?: boolean } = {}): void {
    this.mode = 'watching-barge-in';
    this.absorptionEnabled = opts.absorbBackchannels ?? true;
    this.reset();
  }

  /** The Receptionist yields the floor; listening restarts clean. */
  startListening(): void {
    this.mode = 'listening';
    this.absorptionEnabled = true;
    this.reset();
    this.adoptPendingProviderUtterance();
  }

  /** Adopts a Barge-in candidate as the first audio of the new Turn. */
  acceptBargeIn(event: BargeInEvent): void {
    // The Caller has moved on: a captured earlier utterance is superseded.
    this.clearPendingProvider();
    this.mode = 'listening';
    this.reset();
    if (this.detection === 'sarvam') {
      // The provider heard the candidate while the floor was watched, so its
      // boundary closes the utterance; the candidate is its captured start.
      this.providerOpen = true;
      // The candidate is locally-heard speech, so the stall guard can take
      // this utterance's boundary if the provider stops emitting.
      this.stallSpeechSeen = true;
      this.stallSpeechSamples = event.audio.length;
    } else {
      this.speaking = true;
    }
    this.chunks = [event.audio];
    this.bufferedSamples = event.audio.length;
  }

  /** Drops any partial utterance and releases the VAD. */
  close(): void {
    this.clearPendingProvider();
    this.reset();
    this.adaptivePause.reset();
    this.vad.reset();
  }

  /**
   * The provider opened an utterance (`vad.speech_start`). While the
   * Receptionist holds the floor it never triggers a Barge-in; it only
   * corroborates a local candidate, which the fire event carries. In listening
   * it claims the utterance capture the local VAD may already have opened.
   */
  providerSpeechStart(): void {
    if (this.detection !== 'sarvam') return;
    if (this.mode === 'watching-barge-in') {
      this.providerCorroborated = true;
      return;
    }
    if (this.mode !== 'listening') {
      // A Turn is in flight: capture the utterance so it is answered when the
      // floor returns, instead of dropping speech the Caller already finished.
      if (!this.pendingProviderOpen) {
        this.pendingProviderOpen = true;
        this.pendingProviderEnded = false;
        this.pendingChunks = [];
        this.pendingSamples = 0;
      }
      return;
    }
    if (this.providerOpen) return;
    this.providerOpen = true;
    // Locally-heard speech already owns the capture; only adopt the pre-roll
    // when the provider is the first to open the utterance.
    if (!this.stallSpeechSeen) this.adoptPreRoll();
    this.announceSpeechStart();
  }

  /** The provider closed the utterance (`vad.speech_end`): emit it for a Turn. */
  providerSpeechEnd(): void {
    if (this.detection !== 'sarvam') return;
    if (this.mode !== 'listening') {
      if (this.pendingProviderOpen) this.pendingProviderEnded = true;
      return;
    }
    if (!this.providerOpen) return;
    this.providerOpen = false;
    this.emit();
  }

  /**
   * Boundary authority changes at a boundary. The session escalates to the
   * local detector when the provider stalls repeatedly; already-open
   * utterances stay with their current owner.
   */
  setDetection(mode: TurnDetection): void {
    this.detection = mode;
    if (mode === 'hybrid') this.clearPendingProvider();
  }

  /**
   * Dialogue field state the local detector keys off: while the assistant
   * collects the Patient's name or phone the boundary floor rises so dictated
   * names and grouped digits are not split across Turns.
   */
  observeDialogueState(collecting: boolean): void {
    this.dialogueFloorMs = collecting ? HYBRID_DEFAULTS.dialogueFloorMs : 0;
  }

  /**
   * One partial transcript heard while the Receptionist holds the floor.
   * Semantics are evidence, not a trigger: they classify the energy candidate
   * as a Backchannel to absorb or content-bearing speech to take the floor. In
   * hybrid listening they are also the completeness evidence for the boundary.
   */
  observePartial(text: string): void {
    if (this.mode === 'listening' && this.detection === 'hybrid') this.lastPartialText = text;
    if (this.mode !== 'watching-barge-in' || this.bargeInPending) return;
    const cls = classifyPartial(text);
    if (cls === 'unknown') return;
    this.partial.cls = cls;
    this.partial.text = text.trim();
    if (!this.partial.confirmPending) return;
    if (cls === 'backchannel' && this.absorptionEnabled) {
      this.absorbBackchannel();
      return;
    }
    this.fireBargeIn();
  }

  private async process(mulaw: Buffer): Promise<void> {
    if (mulaw.length === 0) {
      this.observer.onUpstreamFrame?.(mulaw);
      return;
    }
    if (this.mode === 'idle') {
      // A Turn is in flight. A provider utterance heard now is captured so the
      // session can answer it after the current Turn, never silently dropped.
      if (this.pendingProviderOpen) {
        const pcm = decodeMulaw(mulaw);
        this.pendingChunks.push(pcm);
        this.pendingSamples += pcm.length;
      }
      this.observer.onUpstreamFrame?.(mulaw);
      return;
    }
    const pcm = decodeMulaw(mulaw);
    let isEcho = false;
    let silent = false;
    if (this.mode === 'listening') {
      // Listening frames stream as-is and only feed the Echo gate's history;
      // the first frame of the next Receptionist speech then correlates over a
      // full window instead of one noisy 20 ms slice.
      this.observer.onUpstreamFrame?.(mulaw);
      this.echoGate.observe(pcm);
      // The provider owns boundaries in this mode, but the local VAD keeps
      // hearing the Caller so a provider that stops emitting boundaries cannot
      // strand the Turn (see `watchProviderUtterance`).
      if (this.detection === 'sarvam') {
        await this.watchProviderUtterance(pcm);
        return;
      }
    } else {
      // The Receptionist holds the floor: audio still streams upstream for the
      // whole call, but the gate replaces our own voice returning through the
      // phone with silence so the live STT channel never hears it as a Caller.
      const decision = this.echoGate.classify(pcm);
      this.observer.onEchoDecision?.(decision);
      isEcho = decision.echo;
      // The gate knows a silent frame carries no Caller speech, whatever the
      // VAD says: a returning Echo that has not arrived yet must not count.
      silent = decision.reason === 'silence';
      this.observer.onUpstreamFrame?.(isEcho ? silenceMulaw(mulaw.length) : mulaw);
    }
    if (this.bargeInPending) return;
    const score = await this.vad.score(pcm);
    this.observer.onScore?.(score, this.speaking);
    // Echo and silence are never Caller speech, however speech-like the VAD finds them.
    const isSpeech = !isEcho && !silent && score >= this.policy.threshold;
    // Echo frames keep their timing in the utterance but contribute silence,
    // so a Barge-in Turn never transcribes the Receptionist's own words.
    const frame = isEcho ? new Int16Array(pcm.length) : pcm;
    if (this.speaking) {
      this.announceSpeechStart();
      if (isSpeech) this.scoreFrame(score);
    }
    if (!this.speaking) {
      if (!isSpeech) {
        if (this.candidateSamples === 0) {
          this.pushPreRoll(frame);
          // An absorbed Backchannel ends after a real silence gap, not on the
          // next content-bearing burst the Caller begins.
          if (this.partial.absorbing) {
            this.dipSamples += frame.length;
            if (toMs(this.dipSamples) >= this.bargeInDipToleranceMs) this.clearCandidate();
          }
          return;
        }
        this.candidateSamples += frame.length;
        this.dipSamples += frame.length;
        this.chunks.push(frame);
        this.bufferedSamples += frame.length;
        // Short VAD dips remain part of the candidate phrase. A dip past
        // the budget means the noise burst is over: drop it all.
        const dipToleranceMs =
          this.mode === 'watching-barge-in' ? this.bargeInDipToleranceMs : this.policy.latchDipMs;
        if (toMs(this.dipSamples) >= dipToleranceMs) {
          this.clearCandidate();
        }
        return;
      }
      if (this.candidateSamples === 0) {
        // A fresh speech burst: partials from the previous one are not evidence.
        if (!this.partial.absorbing) {
          this.partial.cls = 'unknown';
          this.partial.text = '';
        }
        this.adoptPreRoll();
      }
      this.candidateSamples += frame.length;
      this.dipSamples = 0;
      this.chunks.push(frame);
      this.bufferedSamples += frame.length;
      if (this.mode === 'watching-barge-in' && this.evaluateCandidate(toMs(this.candidateSamples))) return;
      if (toMs(this.candidateSamples) >= this.policy.minSpeechMs) {
        this.speaking = true;
      }
      return;
    }
    this.chunks.push(frame);
    this.bufferedSamples += frame.length;
    if (isSpeech) {
      // A silence run that speech resumed is a completed intra-utterance
      // pause; the hybrid floor tracks the Caller's own rhythm from these.
      if (this.detection === 'hybrid' && this.trailingSilenceSamples > 0) {
        this.adaptivePause.observe(toMs(this.trailingSilenceSamples));
      }
      this.trailingSilenceSamples = 0;
    } else {
      this.trailingSilenceSamples += frame.length;
    }
    if (this.mode === 'watching-barge-in') {
      const speechMs = toMs(this.bufferedSamples - this.trailingSilenceSamples);
      if (speechMs >= this.bargeInMinSpeechMs) {
        if (this.evaluateCandidate(speechMs)) return;
      } else if (toMs(this.trailingSilenceSamples) >= this.policy.silenceMs) {
        this.reset();
      }
      return;
    }
    if (this.bufferedMs() >= this.policy.maxUtteranceMs || this.listeningBoundaryDue()) {
      this.emit();
    }
  }

  /**
   * Whether the utterance under capture should end here. The local detector
   * (hybrid) waits out the Caller-adaptive pause plus the dialogue floor, with
   * the partial's semantic evidence holding it open only until the emergency
   * cap. Provider VAD mode never reaches this: its boundaries come in as
   * events, and the local fallback keeps the retired fixed silence.
   */
  private listeningBoundaryDue(): boolean {
    const trailingMs = toMs(this.trailingSilenceSamples);
    if (this.detection !== 'hybrid') return trailingMs >= this.policy.silenceMs;
    // Without partials there is no semantic evidence to hold a short pause:
    // the adaptive pause alone cuts mid-sentence, so a longer fixed floor owns
    // the boundary instead.
    const floorMs = Math.max(
      this.semanticBoundaries ? this.adaptivePause.floorMs : HYBRID_DEFAULTS.noPartialsFloorMs,
      this.dialogueFloorMs,
    );
    if (trailingMs < floorMs) return false;
    if (trailingMs >= HYBRID_DEFAULTS.emergencyMs) return true;
    return isSemanticallyComplete(this.lastPartialText);
  }

  private bufferedMs(): number {
    return toMs(this.bufferedSamples);
  }

  private announceSpeechStart(): void {
    if (this.speechAnnounced) return;
    this.speechAnnounced = true;
    this.observer.onSpeechStart?.();
  }

  /** Fold one speech-scored frame into the utterance's evidence stats. */
  private scoreFrame(score: number): void {
    this.stats.frames += 1;
    if (score > this.stats.max) this.stats.max = score;
    this.stats.sum += score;
  }

  private takeStats(): UtteranceSpeechStats {
    const { frames, max, sum } = this.stats;
    this.stats = { frames: 0, max: 0, sum: 0 };
    return {
      frames,
      maxScore: round3(max),
      meanScore: frames > 0 ? round3(sum / frames) : 0,
    };
  }

  /**
   * Provider-boundary mode: the local VAD still hears the Caller so a provider
   * that stops emitting boundaries cannot strand the Turn. Locally-heard
   * speech opens the fallback capture (a later provider `vad.speech_start`
   * only claims it), and trailing silence past the stall grace with no
   * provider end signal takes the boundary through the local rule — the
   * captured audio then goes to the REST fallback.
   */
  private async watchProviderUtterance(pcm: Int16Array): Promise<void> {
    if (this.providerOpen || this.stallSpeechSeen) {
      this.chunks.push(pcm);
      this.bufferedSamples += pcm.length;
    } else {
      this.pushPreRoll(pcm);
    }
    const score = await this.vad.score(pcm);
    // The provider or the session may have taken over while scoring.
    if (this.detection !== 'sarvam' || this.mode !== 'listening') return;
    const isSpeech = score >= this.policy.threshold;
    if (isSpeech) {
      if (!this.stallSpeechSeen) {
        this.stallSpeechSeen = true;
        // The first locally-heard speech makes the pre-roll (including this
        // frame) the start of the fallback capture.
        if (!this.providerOpen) this.adoptPreRoll();
      } else if (this.stallTrailingSamples > 0) {
        // A completed intra-utterance pause; after an escalation the adaptive
        // floor already knows this Caller's rhythm.
        this.adaptivePause.observe(toMs(this.stallTrailingSamples));
      }
      this.stallSpeechSamples += pcm.length;
      this.stallTrailingSamples = 0;
      this.scoreFrame(score);
      const armed = this.stallSpeechSamples >= this.minStallSpeechSamples;
      this.observer.onScore?.(score, armed);
      if (armed) this.announceSpeechStart();
      return;
    }
    this.observer.onScore?.(score, this.stallSpeechSamples >= this.minStallSpeechSamples);
    if (!this.stallSpeechSeen) return;
    this.stallTrailingSamples += pcm.length;
    if (this.stallSpeechSamples < this.minStallSpeechSamples) return;
    if (toMs(this.stallTrailingSamples) < this.stallGraceMs) return;
    this.emitStalled();
  }

  private emitStalled(): void {
    const evidence: StallEvent = {
      trailingSilenceMs: Math.round(toMs(this.stallTrailingSamples)),
      speechMs: Math.round(toMs(this.stallSpeechSamples)),
      graceMs: this.stallGraceMs,
    };
    // The emitted utterance ends at the last locally-heard speech.
    this.trailingSilenceSamples = this.stallTrailingSamples;
    this.providerOpen = false;
    this.observer.onStall?.(evidence);
    this.emit({ stalled: true });
  }

  /** Seed the utterance buffer with the recent pre-roll so its first word survives. */
  private adoptPreRoll(): void {
    this.chunks = this.preRollChunks;
    this.bufferedSamples = this.preRollSamples;
    this.preRollChunks = [];
    this.preRollSamples = 0;
  }

  private pushPreRoll(pcm: Int16Array): void {
    this.preRollChunks.push(pcm);
    this.preRollSamples += pcm.length;
    const maxSamples = Math.round((this.policy.minSpeechMs / 1000) * SAMPLE_RATE);
    while (this.preRollSamples > maxSamples) {
      const first = this.preRollChunks[0]!;
      const excess = this.preRollSamples - maxSamples;
      if (first.length <= excess) {
        this.preRollChunks.shift();
        this.preRollSamples -= first.length;
      } else {
        this.preRollChunks[0] = first.subarray(excess);
        this.preRollSamples -= excess;
      }
    }
  }

  private speechAudio(): Utterance {
    const speechSamples = this.bufferedSamples - this.trailingSilenceSamples;
    const audio = new Int16Array(speechSamples);
    let offset = 0;
    let remaining = speechSamples;
    for (const c of this.chunks) {
      if (remaining <= 0) break;
      const take = Math.min(c.length, remaining);
      audio.set(c.subarray(0, take), offset);
      offset += take;
      remaining -= take;
    }
    return { audio, durationMs: Math.round(toMs(speechSamples)) };
  }

  private emit(opts: { stalled?: boolean } = {}): void {
    this.mode = 'idle';
    // The local detector counts trailing silence in one of two fields
    // depending on who owned the boundary; only one is ever non-zero.
    const trailingSamples =
      this.trailingSilenceSamples > 0 ? this.trailingSilenceSamples : this.stallTrailingSamples;
    const utterance = this.speechAudio();
    utterance.trailingSilenceMs = Math.round(toMs(trailingSamples));
    if (opts.stalled) utterance.stalled = true;
    const stats = this.takeStats();
    this.reset();
    this.observer.onUtterance(utterance, stats);
  }

  /**
   * The floor returned with a provider utterance captured while a Turn was in
   * flight. Adopt it: an already-ended utterance becomes the next Turn at
   * once; one still open is held until its provider boundary arrives.
   */
  private adoptPendingProviderUtterance(): void {
    if (!this.pendingProviderOpen) return;
    const chunks = this.pendingChunks;
    const samples = this.pendingSamples;
    const ended = this.pendingProviderEnded;
    this.clearPendingProvider();
    if (samples === 0) return;
    this.chunks = chunks;
    this.bufferedSamples = samples;
    // The provider's capture is evidence of speech: the stall guard may take
    // this utterance's boundary if the provider stops emitting.
    this.stallSpeechSeen = true;
    this.stallSpeechSamples = samples;
    if (ended) {
      this.emit();
      return;
    }
    this.providerOpen = true;
  }

  private clearPendingProvider(): void {
    this.pendingProviderOpen = false;
    this.pendingProviderEnded = false;
    this.pendingChunks = [];
    this.pendingSamples = 0;
  }

  private fireBargeIn(): void {
    const audio = this.speechAudio();
    const corroborated = this.providerCorroborated;
    this.reset();
    this.bargeInPending = true;
    this.observer.onBargeIn?.({ ...audio, corroborated });
  }

  /**
   * Decide a watching floor's candidate at `speechMs`. Before the energy
   * pre-trigger nothing happens; past it, partial semantics decide (Backchannel
   * absorbed, content takes the floor), and unknown text holds until the
   * confirm window ends and then takes the floor. Returns true when handled.
   */
  private evaluateCandidate(speechMs: number): boolean {
    if (speechMs < this.bargeInMinSpeechMs) return false;
    if (this.resolveBargeInCandidate()) return true;
    if (speechMs < this.bargeInMinSpeechMs + this.bargeInConfirmMs) return false;
    this.fireBargeIn();
    return true;
  }

  /**
   * The energy pre-trigger fired. Partial semantics decide: a Backchannel is
   * absorbed, content-bearing speech (or no semantics channel at all) takes
   * the floor, and unknown text holds briefly for a partial to arrive.
   * Returns true when the candidate has been handled.
   */
  private resolveBargeInCandidate(): boolean {
    if (this.partial.cls === 'backchannel' && this.absorptionEnabled) {
      this.absorbBackchannel();
      return true;
    }
    if (this.partial.cls !== 'unknown' || !this.partialSemantics || !this.absorptionEnabled) {
      this.fireBargeIn();
      return true;
    }
    this.partial.confirmPending = true;
    return false;
  }

  /**
   * Absorb the speech burst as a Backchannel: drop its candidate audio, keep
   * the classification for the burst's tail, and trace only the first
   * absorption. The burst ends on a dip past tolerance or a floor change.
   */
  private absorbBackchannel(): void {
    const first = !this.partial.absorbing;
    const evidence = this.partial;
    const event: BackchannelEvent = {
      durationMs: Math.round(this.watchingSpeechMs()),
      text: evidence.text,
    };
    this.reset();
    this.partial = { ...evidence, confirmPending: false, absorbing: true };
    if (first) this.observer.onBackchannel?.(event);
  }

  /** Speech accumulated under the current candidate, in ms. */
  private watchingSpeechMs(): number {
    return this.speaking
      ? toMs(this.bufferedSamples - this.trailingSilenceSamples)
      : toMs(this.candidateSamples);
  }

  /** Drop a candidate that fizzled out, and any partial evidence for it. */
  private clearCandidate(): void {
    this.candidateSamples = 0;
    this.dipSamples = 0;
    this.chunks = [];
    this.bufferedSamples = 0;
    this.partial = emptyPartial();
  }

  private reset(): void {
    this.bargeInPending = false;
    this.speaking = false;
    this.providerOpen = false;
    this.providerCorroborated = false;
    this.stallSpeechSeen = false;
    this.stallSpeechSamples = 0;
    this.stallTrailingSamples = 0;
    this.speechAnnounced = false;
    this.preRollChunks = [];
    this.preRollSamples = 0;
    this.trailingSilenceSamples = 0;
    this.lastPartialText = '';
    this.clearCandidate();
  }
}
