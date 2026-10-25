import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Harness } from "../src/harness/harness.js";
import { createFauxRuntime, recordContexts } from "../src/model/faux.js";
import { LocalSandbox } from "../src/sandbox/local.js";
import { FactorySandboxProvider, SandboxRuntime } from "../src/sandbox/runtime.js";
import { WindowContextPolicy } from "../src/session/context.js";
import { InMemorySessionStore } from "../src/session/store.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pi-harness-test-"));
}

test("harness records a full run and returns the final answer", async () => {
  const root = await tempRoot();
  const store = new InMemorySessionStore();
  const session = await store.createSession();
  const runtimeModel = createFauxRuntime([
    fauxAssistantMessage(
      [fauxToolCall("execute", { name: "bash", input: { command: "echo hello" } })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("finished")]),
  ]);
  const sandbox = new SandboxRuntime({
    provider: new FactorySandboxProvider(() => new LocalSandbox({ rootDir: root })),
  });
  const harness = new Harness({
    sessionStore: store,
    sandbox,
    model: runtimeModel.model,
    streamFn: runtimeModel.streamFn,
  });

  try {
    const result = await harness.run(session.sessionId, "say hello");
    assert.equal(result.status, "completed");
    assert.equal(result.finalMessage, "finished");
    assert.ok(result.firstTokenMs !== undefined);

    const events = await store.read(session.sessionId);
    const types = events.map((event) => event.type);
    assert.ok(types.includes("tool_started"));
    assert.ok(types.includes("tool_finished"));
    const messages = events.filter((event) => event.type === "message");
    assert.equal(messages.length, 4); // user, assistant tool call, toolResult, final assistant
  } finally {
    await sandbox.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("context policy limits what each provider request sees", async () => {
  const root = await tempRoot();
  const store = new InMemorySessionStore();
  const session = await store.createSession();
  const responses = [0, 1, 2].map((index) =>
    fauxAssistantMessage(
      [fauxToolCall("execute", { name: "bash", input: { command: `echo step-${index}` } })],
      { stopReason: "toolUse" },
    ),
  );
  responses.push(fauxAssistantMessage([fauxText("all done")]));
  const runtimeModel = createFauxRuntime(responses);
  const recorded = recordContexts(runtimeModel.streamFn as StreamFn);
  const sandbox = new SandboxRuntime({
    provider: new FactorySandboxProvider(() => new LocalSandbox({ rootDir: root })),
  });
  const harness = new Harness({
    sessionStore: store,
    sandbox,
    model: runtimeModel.model,
    streamFn: recorded.streamFn,
    contextPolicy: new WindowContextPolicy(4),
  });

  try {
    const result = await harness.run(session.sessionId, "do three steps");
    assert.equal(result.status, "completed");
    assert.ok(recorded.contexts.length >= 4);
    const nonSystemCounts = recorded.contexts.map(
      (context) => context.filter((message) => message.role !== "system").length,
    );
    // The first request sees [user]. Later requests are capped at the policy
    // window (plus at most one synthetic omission notice).
    assert.ok(nonSystemCounts.every((count) => count <= 5));
    assert.ok(nonSystemCounts.at(-1)! < 8);
  } finally {
    await sandbox.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

async function runWithProvisioning(eager: boolean): Promise<{
  firstRequestFactoryCalls: number;
  finalFactoryCalls: number;
}> {
  const root = await tempRoot();
  const store = new InMemorySessionStore();
  const session = await store.createSession();
  const runtimeModel = createFauxRuntime([fauxAssistantMessage([fauxText("ok")])]);
  let factoryCalls = 0;
  const requestObservations: number[] = [];
  const baseStreamFn = runtimeModel.streamFn as StreamFn;
  const observingStreamFn: StreamFn = (model, context, options) => {
    requestObservations.push(factoryCalls);
    return baseStreamFn(model, context, options);
  };
  const sandbox = new SandboxRuntime({
    provider: new FactorySandboxProvider(() => {
      factoryCalls += 1;
      return new LocalSandbox({ rootDir: root });
    }),
  });
  const harness = new Harness({
    sessionStore: store,
    sandbox,
    model: runtimeModel.model,
    streamFn: observingStreamFn,
    eagerProvision: eager,
  });
  try {
    await harness.run(session.sessionId, "provision check");
    return {
      firstRequestFactoryCalls: requestObservations[0] ?? -1,
      finalFactoryCalls: factoryCalls,
    };
  } finally {
    await sandbox.destroy();
    await rm(root, { recursive: true, force: true });
  }
}

test("lazy provisioning starts inference before the sandbox exists", async () => {
  const lazy = await runWithProvisioning(false);
  assert.equal(lazy.firstRequestFactoryCalls, 0);
  assert.equal(lazy.finalFactoryCalls, 0);
});

test("eager provisioning pays the container cost before the first request", async () => {
  const eager = await runWithProvisioning(true);
  assert.equal(eager.firstRequestFactoryCalls, 1);
  assert.equal(eager.finalFactoryCalls, 1);
});
