import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateMetrics,
  ECHO_GATE_BARS,
  formatTurnBenchReport,
  gateMetrics,
  runScenario,
  scenarioMetrics,
  type GateDecisionObservation,
  type ScenarioObservations,
} from '../src/turnBench.ts';

function observations(partial: Partial<ScenarioObservations> = {}): ScenarioObservations {
  return {
    utterances: [],
    interruptions: [],
    backchannels: [],
    echos: [],
    gateDecisions: [],
    replyStarts: [],
    clears: [],
    selfEchoTurns: 0,
    ...partial,
  };
}

describe('turn bench metrics', () => {
  it('measures reply latency from the Caller speech end to the first reply frame', () => {
    const metrics = scenarioMetrics(
      'steady',
      observations({
        utterances: [
          { span: { startFrame: 10, endFrame: 60 }, text: 'hello' },
          { span: { startFrame: 122, endFrame: 172 }, text: 'hours' },
        ],
        replyStarts: [110, 222],
      }),
    );
    assert.equal(metrics.falseCuts, 0);
    assert.equal(metrics.falseCutRate, 0);
    assert.deepEqual(metrics.replyLatenciesMs, [1000, 1000]);
    assert.equal(metrics.replyLatencyMs.samples, 2);
    assert.equal(metrics.replyLatencyMs.p50, 1000);
  });

  it('counts a reply that starts inside a Caller utterance as a false cut, never as latency', () => {
    const metrics = scenarioMetrics(
      'pause',
      observations({
        utterances: [{ span: { startFrame: 10, endFrame: 120 }, text: 'my number is...' }],
        replyStarts: [90],
      }),
    );
    assert.equal(metrics.falseCuts, 1);
    assert.equal(metrics.falseCutRate, 1);
    assert.deepEqual(metrics.replyLatenciesMs, []);
  });

  it('measures stop latency from the interruption start to the clear, and counts missed stops', () => {
    const metrics = scenarioMetrics(
      'barge-in',
      observations({
        interruptions: [
          { span: { startFrame: 100, endFrame: 130 }, text: 'no wait' },
          { span: { startFrame: 300, endFrame: 330 }, text: 'hold on' },
        ],
        clears: [{ frame: 110, reason: 'caller-barge-in' }],
      }),
    );
    assert.deepEqual(metrics.stopLatenciesMs, [200]);
    assert.equal(metrics.stopLatencyMs.samples, 1);
    assert.equal(metrics.stopLatencyMs.missed, 1);
  });

  it('does not count a clear outside the interruption as a stop sample', () => {
    const metrics = scenarioMetrics(
      'late-clear',
      observations({
        interruptions: [{ span: { startFrame: 100, endFrame: 120 }, text: 'no wait' }],
        clears: [{ frame: 160, reason: 'caller-barge-in' }],
      }),
    );
    assert.deepEqual(metrics.stopLatenciesMs, []);
    assert.equal(metrics.stopLatencyMs.missed, 1);
  });

  it('counts a clear inside a Backchannel as a Backchannel false-stop', () => {
    const metrics = scenarioMetrics(
      'backchannel',
      observations({
        backchannels: [
          { span: { startFrame: 200, endFrame: 210 }, text: 'mm-hmm' },
          { span: { startFrame: 400, endFrame: 410 }, text: 'okay' },
        ],
        clears: [{ frame: 205, reason: 'caller-barge-in' }],
      }),
    );
    assert.equal(metrics.backchannelFalseStops, 1);
    assert.equal(metrics.backchannelFalseStopRate, 0.5);
  });

  it('counts repeated clears inside one span once, so rates stay at most 100%', () => {
    const metrics = scenarioMetrics(
      'repeated-clears',
      observations({
        backchannels: [{ span: { startFrame: 200, endFrame: 210 }, text: 'mm-hmm' }],
        echos: [{ span: { startFrame: 300, endFrame: 400 } }],
        clears: [
          { frame: 202, reason: 'caller-barge-in' },
          { frame: 208, reason: 'caller-barge-in' },
          { frame: 320, reason: 'caller-barge-in' },
          { frame: 380, reason: 'caller-barge-in' },
        ],
      }),
    );
    assert.equal(metrics.backchannelFalseStops, 1);
    assert.equal(metrics.backchannelFalseStopRate, 1);
    assert.equal(metrics.echoFalseStops, 1);
    assert.equal(metrics.echoFalseStopRate, 1);
  });

  it('counts a clear inside an Echo span as an Echo false-stop', () => {
    const metrics = scenarioMetrics(
      'echo',
      observations({
        echos: [{ span: { startFrame: 300, endFrame: 400 } }, { span: { startFrame: 500, endFrame: 550 } }],
        clears: [{ frame: 350, reason: 'caller-barge-in' }],
      }),
    );
    assert.equal(metrics.echoFalseStops, 1);
    assert.equal(metrics.echoFalseStopRate, 0.5);
  });

  it('attributes a double-talk clear to the Caller interruption, not the overlapping Echo', () => {
    const metrics = scenarioMetrics(
      'double-talk',
      observations({
        interruptions: [{ span: { startFrame: 300, endFrame: 340 }, text: 'no wait' }],
        echos: [{ span: { startFrame: 250, endFrame: 400 } }],
        clears: [{ frame: 310, reason: 'caller-barge-in' }],
      }),
    );
    assert.equal(metrics.stopLatencyMs.samples, 1);
    assert.equal(metrics.echoFalseStops, 0);
  });

  it('carries self-Echo turns through as a safety count', () => {
    const metrics = scenarioMetrics('self-echo', observations({ selfEchoTurns: 2 }));
    assert.equal(metrics.selfEchoTurns, 2);
  });

  it('aggregates pooled samples across scenarios into p50/p95', () => {
    const steady = scenarioMetrics(
      'steady',
      observations({
        utterances: [{ span: { startFrame: 0, endFrame: 10 }, text: 'a' }],
        replyStarts: [60],
      }),
    );
    const quick = scenarioMetrics(
      'quick',
      observations({
        utterances: [{ span: { startFrame: 0, endFrame: 10 }, text: 'b' }],
        replyStarts: [20],
      }),
    );
    const aggregate = aggregateMetrics([steady, quick]);
    assert.equal(aggregate.scenarios, 2);
    assert.equal(aggregate.utterances, 2);
    assert.equal(aggregate.replyLatencyMs.samples, 2);
    assert.equal(aggregate.replyLatencyMs.p50, 200);
    assert.equal(aggregate.replyLatencyMs.p95, 1000);
    assert.equal(aggregate.falseCutRate, 0);
  });

  it('reports zero rates when a scenario declares no spans of that kind', () => {
    const metrics = scenarioMetrics('empty', observations());
    assert.equal(metrics.falseCutRate, 0);
    assert.equal(metrics.backchannelFalseStopRate, 0);
    assert.equal(metrics.echoFalseStopRate, 0);
    assert.equal(metrics.stopLatencyMs.p50, 0);
  });

  it('scores Echo-gate decisions against declared Echo and Caller spans', () => {
    const decisions: GateDecisionObservation[] = [
      { frame: 10, echo: true, reason: 'echo', correlation: 0.99, caller: false, echoMixed: true },
      { frame: 11, echo: false, reason: 'uncorrelated', correlation: 0.2, caller: false, echoMixed: true },
      { frame: 12, echo: true, reason: 'echo', correlation: 0.97, caller: false, echoMixed: true },
      { frame: 30, echo: true, reason: 'echo', correlation: 0.95, caller: true, echoMixed: true },
      { frame: 31, echo: false, reason: 'uncorrelated', correlation: 0.1, caller: true, echoMixed: true },
      { frame: 90, echo: true, reason: 'echo', correlation: 0.99, caller: false, echoMixed: true },
    ];
    const gate = gateMetrics(
      observations({
        echos: [{ span: { startFrame: 10, endFrame: 13 } }],
        interruptions: [{ span: { startFrame: 30, endFrame: 32 }, text: 'no wait' }],
        gateDecisions: decisions,
      }),
    );
    assert.equal(gate.echoFrames, 3);
    assert.equal(gate.echoFalsePasses, 1);
    assert.equal(gate.falsePassRate, 1 / 3);
    assert.equal(gate.callerFrames, 2);
    assert.equal(gate.callerFalseBlocks, 1);
    assert.equal(gate.falseBlockRate, 0.5);
  });

  it('scores a silent Caller frame inside a Barge-in span as an Echo frame', () => {
    // Captured fixtures carry trailing silence; a Barge-in span over
    // that silence is really Echo, so a blocked frame is not a false block.
    const gate = gateMetrics(
      observations({
        interruptions: [{ span: { startFrame: 50, endFrame: 52 }, text: 'no wait' }],
        gateDecisions: [
          { frame: 50, echo: true, reason: 'echo', correlation: 0.99, caller: false, echoMixed: true },
        ],
      }),
    );
    assert.equal(gate.callerFrames, 0);
    assert.equal(gate.callerFalseBlocks, 0);
    assert.equal(gate.echoFrames, 1);
    assert.equal(gate.echoFalsePasses, 0);
  });

  it('ignores frames with no Echo mixed into them', () => {
    const gate = gateMetrics(
      observations({
        interruptions: [{ span: { startFrame: 50, endFrame: 53 }, text: 'no wait' }],
        gateDecisions: [
          { frame: 50, echo: false, reason: 'uncorrelated', correlation: 0.1, caller: false, echoMixed: false },
          { frame: 51, echo: true, reason: 'echo', correlation: 0.9, caller: false, echoMixed: false },
        ],
      }),
    );
    assert.equal(gate.echoFrames, 0);
    assert.equal(gate.echoFalsePasses, 0);
    assert.equal(gate.callerFrames, 0);
  });
});

const POLICY = {
  silenceMs: 1000,
  minSpeechMs: 300,
  maxUtteranceMs: 30000,
  threshold: 0.1,
  latchDipMs: 200,
};

describe('turn bench scenario runner', () => {
  it('runs a steady Turn through the real live session and measures reply latency', async () => {
    const run = await runScenario(
      {
        name: 'steady',
        run: async (ctx) => {
          await ctx.call('what are your hours', 60);
          await ctx.awaitReply();
        },
      },
      { policy: POLICY },
    );
    assert.equal(run.observations.utterances.length, 1);
    assert.equal(run.observations.replyStarts.length, 1);
    assert.equal(run.metrics.falseCuts, 0);
    assert.equal(run.metrics.replyLatencyMs.samples, 1);
    const latencyMs = run.metrics.replyLatenciesMs[0]!;
    assert.ok(latencyMs >= 940 && latencyMs <= 1060, `reply latency ${latencyMs}ms`);
  });
});

describe('turn bench behavior scenarios', () => {
  it('flags a mid-thought pause longer than the fixed Endpointing window as a false cut', async () => {
    const run = await runScenario(
      {
        name: 'long-pause',
        run: async (ctx) => {
          await ctx.call('my number is', 60, { pauses: [{ afterMs: 600, ms: 1200 }] });
          await ctx.silence(200);
        },
      },
      { policy: POLICY },
    );
    assert.equal(run.metrics.falseCuts, 1);
    assert.equal(run.metrics.falseCutRate, 1);
    assert.equal(run.metrics.replyLatencyMs.samples, 0);
  });

  it('keeps a pause inside the silence window in one Turn', async () => {
    const run = await runScenario(
      {
        name: 'short-pause',
        run: async (ctx) => {
          await ctx.call('book for', 60, { pauses: [{ afterMs: 600, ms: 400 }] });
          await ctx.awaitReply();
        },
      },
      { policy: POLICY },
    );
    assert.equal(run.metrics.falseCuts, 0);
    assert.equal(run.metrics.replyLatencyMs.samples, 1);
  });

  it('reports a missed stop while Barge-in is off (the shipped baseline)', async () => {
    const run = await runScenario(
      {
        name: 'barge-in-off',
        run: async (ctx) => {
          await ctx.call('what are your hours', 60);
          await ctx.awaitReply();
          await ctx.interrupt('no wait', 30);
          await ctx.silence(120);
        },
      },
      { policy: POLICY, bargeIn: false },
    );
    assert.equal(run.observations.clears.length, 0);
    assert.equal(run.metrics.stopLatencyMs.samples, 0);
    assert.equal(run.metrics.stopLatencyMs.missed, 1);
  });

  it('measures stop latency once Barge-in is on', async () => {
    const run = await runScenario(
      {
        name: 'barge-in-on',
        run: async (ctx) => {
          await ctx.call('what are your hours', 60);
          await ctx.awaitReply();
          await ctx.interrupt('no wait', 40);
          await ctx.silence(120);
        },
      },
      { policy: POLICY, bargeIn: true, interruptionMs: 200 },
    );
    assert.equal(run.observations.clears.length, 1);
    assert.equal(run.metrics.stopLatencyMs.samples, 1);
    const stopMs = run.metrics.stopLatenciesMs[0]!;
    assert.ok(stopMs >= 180 && stopMs <= 260, `stop latency ${stopMs}ms`);
    assert.equal(run.metrics.stopLatencyMs.missed, 0);
  });

  it('does not stop on a Backchannel while the Receptionist speaks (baseline)', async () => {
    const run = await runScenario(
      {
        name: 'backchannel',
        run: async (ctx) => {
          await ctx.call('what are your hours', 60);
          await ctx.awaitReply();
          await ctx.backchannel(10);
          await ctx.silence(100);
        },
      },
      { policy: POLICY, bargeIn: false },
    );
    assert.equal(run.observations.backchannels.length, 1);
    assert.equal(run.metrics.backchannelFalseStops, 0);
    assert.equal(run.metrics.selfEchoTurns, 0);
  });

  it('does not stop on returned Echo while the Receptionist speaks (baseline)', async () => {
    const run = await runScenario(
      {
        name: 'echo',
        run: async (ctx) => {
          await ctx.call('what are your hours', 60);
          await ctx.awaitReply();
          await ctx.echo(40, { delayMs: 120, attenuationDb: -18 });
          await ctx.silence(100);
        },
      },
      { policy: POLICY, bargeIn: false },
    );
    assert.equal(run.observations.echos.length, 1);
    assert.equal(run.metrics.echoFalseStops, 0);
    assert.equal(run.metrics.selfEchoTurns, 0);
    assert.equal(run.observations.clears.length, 0);
  });

  it('stops a greeting Barge-in when Barge-in is on', async () => {
    const run = await runScenario(
      {
        name: 'greeting-barge-in',
        duringGreeting: true,
        run: async (ctx) => {
          await ctx.interrupt('excuse me', 40);
          await ctx.silence(120);
        },
      },
      { policy: POLICY, bargeIn: true, interruptionMs: 200 },
    );
    assert.equal(run.observations.clears.length, 1);
    assert.equal(run.metrics.stopLatencyMs.samples, 1);
  });

  it('attributes a double-talk stop to the Caller, not the Echo in the same frames', async () => {
    const run = await runScenario(
      {
        name: 'double-talk',
        run: async (ctx) => {
          await ctx.call('what are your hours', 60);
          await ctx.awaitReply();
          await ctx.interrupt('no wait', 40, { echo: { delayMs: 120, attenuationDb: -18 } });
          await ctx.silence(120);
        },
      },
      { policy: POLICY, bargeIn: true, interruptionMs: 200 },
    );
    assert.equal(run.metrics.stopLatencyMs.samples, 1);
    assert.equal(run.metrics.echoFalseStops, 0);
  });

  it('classifies returned Echo and clean Caller speech through the real session', async () => {
    const run = await runScenario(
      {
        name: 'gate',
        run: async (ctx) => {
          await ctx.call('what are your hours', 60);
          await ctx.awaitReply();
          await ctx.echo(30, { delayMs: 120, attenuationDb: -18 });
          await ctx.interrupt('no wait', 20);
          await ctx.silence(80);
        },
      },
      { policy: POLICY, bargeIn: false },
    );
    // Ticket 04 is classification only: half-duplex stays.
    assert.equal(run.observations.clears.length, 0);
    assert.ok(run.observations.gateDecisions.length > 0);
    // The echo span starts as the reply begins; its first frames carry no
    // reference yet, so only frames with Echo energy are scored.
    assert.ok(run.metrics.gate.echoFrames >= 24, `echo frames ${run.metrics.gate.echoFrames}`);
    assert.equal(run.metrics.gate.echoFalsePasses, 0);
    assert.ok(run.metrics.gate.falsePassRate <= ECHO_GATE_BARS.falsePassRate);
    assert.equal(run.metrics.gate.callerFrames, 20);
    assert.equal(run.metrics.gate.callerFalseBlocks, 0);
  });
});

describe('turn bench report', () => {
  it('prints per-scenario metrics and a pooled total', () => {
    const scenario = scenarioMetrics(
      'steady-turn',
      observations({
        utterances: [{ span: { startFrame: 0, endFrame: 10 }, text: 'a' }],
        replyStarts: [60],
      }),
    );
    const report = formatTurnBenchReport(
      { build: 'abc1234', policy: POLICY, fixtures: 3, bargeIn: false },
      [scenario],
      aggregateMetrics([scenario]),
    );
    assert.match(report, /build abc1234/);
    assert.match(report, /silence 1000ms/);
    assert.match(report, /note: Barge-in is off/);
    assert.match(report, /steady-turn/);
    assert.match(report, /false-cut 0\.0% \(0\/1\)/);
    assert.match(report, /reply p50 1000ms p95 1000ms \(n=1\)/);
    assert.match(report, /stop none \(missed 0\)/);
    assert.match(report, /backchannel false-stop 0\.0% \(0\/0\)/);
    assert.match(report, /echo false-stop 0\.0% \(0\/0\)/);
    assert.match(report, /echo-gate bars: false-pass <= 5\.0%  false-block <= 5\.0%  ->  PASS/);
    assert.match(report, /gate pass 0\.0% \(0\/0\)/);
    assert.match(report, /TOTAL/);
  });
});
