import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness } from "../src/harness/harness.js";
import { createFauxRuntime } from "../src/model/faux.js";
import { LocalSandbox } from "../src/sandbox/local.js";
import { FactorySandboxProvider, SandboxRuntime } from "../src/sandbox/runtime.js";
import { InMemorySessionStore } from "../src/session/store.js";

test("wake replays an orphaned tool call and finishes the session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-recovery-test-"));
  const store = new InMemorySessionStore();
  const session = await store.createSession();

  const firstModel = createFauxRuntime([
    fauxAssistantMessage(
      [
        fauxToolCall("execute", {
          name: "bash",
          input: { command: "echo recovered > note.txt && cat note.txt" },
        }),
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  const firstSandbox = new SandboxRuntime({
    provider: new FactorySandboxProvider(() => new LocalSandbox({ rootDir: root })),
  });
  let crashHookRan = false;
  const crashingHarness = new Harness({
    sessionStore: store,
    sandbox: firstSandbox,
    model: firstModel.model,
    streamFn: firstModel.streamFn,
    onEvent: (event) => {
      if (event.type === "tool_execution_end") {
        crashHookRan = true;
        throw new Error("simulated harness crash");
      }
    },
  });

  try {
    const crashResult = await crashingHarness.run(session.sessionId, "write a note");
    // pi-agent converts a rejected listener into an error turn rather than
    // rejecting prompt(). The durable session still records the crash and the
    // missing tool result, which is what wake() recovers from.
    assert.equal(crashHookRan, true);
    assert.equal(crashResult.status, "error");
  } finally {
    await firstSandbox.destroy();
  }

  const afterCrash = await store.read(session.sessionId);
  assert.equal(
    afterCrash.filter((event) => event.type === "message" && event.data.message.role === "toolResult")
      .length,
    0,
  );

  const secondModel = createFauxRuntime([
    fauxAssistantMessage([fauxText("recovered and finished")]),
  ]);
  const secondSandbox = new SandboxRuntime({
    provider: new FactorySandboxProvider(() => new LocalSandbox({ rootDir: root })),
  });
  const recoveryHarness = new Harness({
    sessionStore: store,
    sandbox: secondSandbox,
    model: secondModel.model,
    streamFn: secondModel.streamFn,
  });

  try {
    const result = await recoveryHarness.wake(session.sessionId);
    assert.equal(result.status, "completed");
    assert.equal(result.finalMessage, "recovered and finished");
  } finally {
    await secondSandbox.destroy();
  }

  const events = await store.read(session.sessionId);
  const userMessages = events.filter(
    (event) => event.type === "message" && event.data.message.role === "user",
  );
  assert.equal(userMessages.length, 1);
  const toolResults = events.filter(
    (event) => event.type === "message" && event.data.message.role === "toolResult",
  );
  assert.equal(toolResults.length, 1);
  const finalAssistant = events
    .filter((event) => event.type === "message" && event.data.message.role === "assistant")
    .at(-1);
  assert.ok(finalAssistant?.type === "message" && finalAssistant.data.message.role === "assistant");
  assert.equal(
    finalAssistant.data.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    "recovered and finished",
  );

  await rm(root, { recursive: true, force: true });
});

test("wake on an already-complete session is a no-op", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-recovery-noop-"));
  const store = new InMemorySessionStore();
  const session = await store.createSession();
  const model = createFauxRuntime([fauxAssistantMessage([fauxText("done")])]);
  const sandbox = new SandboxRuntime({
    provider: new FactorySandboxProvider(() => new LocalSandbox({ rootDir: root })),
  });
  const harness = new Harness({
    sessionStore: store,
    sandbox,
    model: model.model,
    streamFn: model.streamFn,
  });
  try {
    await harness.run(session.sessionId, "hello");
    const result = await harness.wake(session.sessionId);
    assert.equal(result.status, "already_complete");
    assert.equal(result.finalMessage, "done");
  } finally {
    await sandbox.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
