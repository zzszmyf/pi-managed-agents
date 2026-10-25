import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { Harness } from "../harness/harness.js";
import { createFauxRuntime } from "../model/faux.js";
import { FactorySandboxProvider, SandboxRuntime } from "../sandbox/runtime.js";
import { LocalSandbox } from "../sandbox/local.js";
import { InMemorySessionStore } from "../session/store.js";

/**
 * These numbers are a simulation, not a benchmark of Anthropic's service.
 *
 * They reproduce the *shape* of the claim in "Scaling Managed Agents":
 * provisioning a container eagerly adds latency to every session, including
 * sessions that never touch the sandbox. Provisioning lazily removes it from
 * the critical path, and the tail gets much better because container setup is
 * heavy-tailed.
 */

export interface TtftStats {
  n: number;
  p50: number;
  p95: number;
  mean: number;
}

export interface TtftReport {
  eager: TtftStats;
  lazy: TtftStats;
  p50ReductionPct: number;
  p95ReductionPct: number;
}

export interface TtftOptions {
  iterations?: number;
  seed?: number;
  /** Base container setup time in ms. */
  provisionBaseMs?: number;
  /** Mean of the exponential provisioning tail in ms. */
  provisionTailMeanMs?: number;
  /** Probability of a long provisioning stall. */
  provisionStallProbability?: number;
  /** Extra delay for a stall, in ms. */
  provisionStallMs?: number;
  /** Base model latency before the first token, in ms. */
  modelBaseMs?: number;
  /** Uniform jitter added to model latency, in ms. */
  modelJitterMs?: number;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleProvisionDelay(random: () => number, options: Required<TtftOptions>): number {
  const exponential = -Math.log(1 - random()) * options.provisionTailMeanMs;
  const stall = random() < options.provisionStallProbability ? options.provisionStallMs : 0;
  return options.provisionBaseMs + exponential + stall;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function stats(values: readonly number[]): TtftStats {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    mean,
  };
}

export async function measureTtftOnce(
  eager: boolean,
  options: Required<TtftOptions>,
  random: () => number,
): Promise<number> {
  const provisionDelayMs = sampleProvisionDelay(random, options);
  const modelDelayMs = options.modelBaseMs + random() * options.modelJitterMs;

  const response: FauxResponseFactory = async () => {
    await new Promise((resolve) => setTimeout(resolve, modelDelayMs));
    return fauxAssistantMessage([fauxText("ok")]);
  };
  const runtimeModel = createFauxRuntime([response]);
  const store = new InMemorySessionStore();
  const session = await store.createSession();

  const sandboxRuntime = new SandboxRuntime({
    provider: new FactorySandboxProvider(
      () =>
        new LocalSandbox({
          provisionDelayMs,
          rootDir: path.join(os.tmpdir(), "pi-managed-bench", randomUUID()),
          destroyRoot: true,
        }),
    ),
  });

  const harness = new Harness({
    sessionStore: store,
    sandbox: sandboxRuntime,
    model: runtimeModel.model,
    streamFn: runtimeModel.streamFn,
    eagerProvision: eager,
  });

  try {
    const result = await harness.run(session.sessionId, "ping");
    if (result.firstTokenMs === undefined) {
      throw new Error("No first token was observed");
    }
    return result.firstTokenMs;
  } finally {
    await sandboxRuntime.destroy();
  }
}

export async function benchmarkTtft(options: TtftOptions = {}): Promise<TtftReport> {
  const resolved: Required<TtftOptions> = {
    iterations: options.iterations ?? 25,
    seed: options.seed ?? 42,
    provisionBaseMs: options.provisionBaseMs ?? 120,
    provisionTailMeanMs: options.provisionTailMeanMs ?? 30,
    provisionStallProbability: options.provisionStallProbability ?? 0.08,
    provisionStallMs: options.provisionStallMs ?? 600,
    modelBaseMs: options.modelBaseMs ?? 70,
    modelJitterMs: options.modelJitterMs ?? 30,
  };
  const eagerSamples: number[] = [];
  const lazySamples: number[] = [];
  for (let index = 0; index < resolved.iterations; index += 1) {
    eagerSamples.push(await measureTtftOnce(true, resolved, mulberry32(resolved.seed + index * 2)));
    lazySamples.push(await measureTtftOnce(false, resolved, mulberry32(resolved.seed + index * 2 + 1)));
  }
  const eager = stats(eagerSamples);
  const lazy = stats(lazySamples);
  return {
    eager,
    lazy,
    p50ReductionPct: ((eager.p50 - lazy.p50) / eager.p50) * 100,
    p95ReductionPct: ((eager.p95 - lazy.p95) / eager.p95) * 100,
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(0)}ms`;
}

export function formatTtftReport(report: TtftReport): string {
  return [
    "Simulated time-to-first-token (provisioning + model latency)",
    "",
    `             p50       p95       mean`,
    `eager      ${formatMs(report.eager.p50).padEnd(10)}${formatMs(report.eager.p95).padEnd(10)}${formatMs(report.eager.mean)}`,
    `lazy       ${formatMs(report.lazy.p50).padEnd(10)}${formatMs(report.lazy.p95).padEnd(10)}${formatMs(report.lazy.mean)}`,
    "",
    `p50 reduction: ${report.p50ReductionPct.toFixed(1)}%`,
    `p95 reduction: ${report.p95ReductionPct.toFixed(1)}%`,
  ].join("\n");
}

const entry = process.argv[1] ?? "";
const invokedDirectly =
  /(?:^|[\\/])(?:src|dist)[\\/]bench[\\/]ttft\.(?:ts|js)$/.test(entry) &&
  import.meta.url === pathToFileURL(path.resolve(entry)).href;

if (invokedDirectly) {
  const report = await benchmarkTtft();
  console.log(formatTtftReport(report));
}
