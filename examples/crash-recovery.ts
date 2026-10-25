/**
 * Demonstrates the recovery path from the article:
 *
 *   1. A harness records the assistant's tool call, then dies before the tool
 *      result exists.
 *   2. A brand-new harness wakes from the session log alone.
 *   3. It replays the orphaned tool call, appends the result, and continues.
 *
 * Run: npm run demo:crash
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness } from "../src/harness/harness.js";
import { createFauxRuntime } from "../src/model/faux.js";
import { LocalSandbox } from "../src/sandbox/local.js";
import { FactorySandboxProvider, SandboxRuntime } from "../src/sandbox/runtime.js";
import { FileSessionStore } from "../src/session/store.js";
import { formatEventLog } from "../src/session/format.js";

const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-managed-crash-"));
const sessionsDir = path.join(workDir, "sessions");
const sandboxDir = path.join(workDir, "workspace");

const store = new FileSessionStore(sessionsDir);
const session = await store.createSession({ tags: ["crash-recovery"] });

function sandboxRuntime(): SandboxRuntime {
  return new SandboxRuntime({
    provider: new FactorySandboxProvider(() => new LocalSandbox({ rootDir: sandboxDir })),
    onProvisioned: async (sandbox) => {
      await store.append(session.sessionId, "sandbox_provisioned", { sandboxId: sandbox.id });
    },
    onFailed: async (sandbox, error) => {
      await store.append(session.sessionId, "sandbox_failed", {
        sandboxId: sandbox.id,
        error: error.message,
      });
    },
  });
}

const firstModel = createFauxRuntime([
  fauxAssistantMessage(
    [
      fauxToolCall("execute", {
        name: "bash",
        input: { command: "echo hello-from-before-the-crash > note.txt && cat note.txt" },
      }),
    ],
    { stopReason: "toolUse" },
  ),
]);

let crashHookRan = false;
const firstHarness = new Harness({
  sessionStore: store,
  sandbox: sandboxRuntime(),
  model: firstModel.model,
  streamFn: firstModel.streamFn,
  onEvent: (event) => {
    if (event.type === "tool_execution_end") {
      crashHookRan = true;
      throw new Error("simulated harness crash before the tool result was recorded");
    }
  },
});

console.log("== harness A: run until the simulated crash ==");
const crashResult = await firstHarness.run(session.sessionId, "write a note and show it to me");
console.log(
  `harness A stopped: status=${crashResult.status}, crash hook ran=${crashHookRan}`,
);

const afterCrash = await store.read(session.sessionId);
console.log("\n== durable session after the crash ==");
console.log(formatEventLog(afterCrash));

const lastAssistant = afterCrash
  .filter((event) => event.type === "message")
  .map((event) => event.data.message)
  .filter((message) => message.role === "assistant")
  .at(-1);
const hasToolResult = afterCrash.some(
  (event) => event.type === "message" && event.data.message.role === "toolResult",
);
console.log(
  `\nlast assistant message has tool calls: ${lastAssistant?.role === "assistant" && lastAssistant.content.some((block) => block.type === "toolCall")}`,
);
console.log(`tool result recorded: ${hasToolResult}`);

console.log("\n== harness B: wake from the session log only ==");
const secondModel = createFauxRuntime([
  fauxAssistantMessage([
    fauxText("Recovered: the orphaned tool call was replayed and the note contains hello-from-before-the-crash."),
  ]),
]);
const secondHarness = new Harness({
  sessionStore: store,
  sandbox: sandboxRuntime(),
  model: secondModel.model,
  streamFn: secondModel.streamFn,
});

const result = await secondHarness.wake(session.sessionId);
console.log(`status: ${result.status}`);
console.log(`answer: ${result.finalMessage ?? "(none)"}`);

console.log("\n== durable session after wake ==");
console.log(formatEventLog(await store.read(session.sessionId)));

await rm(workDir, { recursive: true, force: true });
