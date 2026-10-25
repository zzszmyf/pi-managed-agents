/**
 * End-to-end demo: one session, one harness, one local sandbox.
 *
 * Run: npm run demo
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness } from "../src/harness/harness.js";
import { createFauxRuntime } from "../src/model/faux.js";
import { LocalSandbox } from "../src/sandbox/local.js";
import { FactorySandboxProvider, SandboxRuntime } from "../src/sandbox/runtime.js";
import { WindowContextPolicy } from "../src/session/context.js";
import { formatEventLog } from "../src/session/format.js";
import { FileSessionStore } from "../src/session/store.js";

const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-managed-demo-"));
const sessionsDir = path.join(workDir, "sessions");
const sandboxDir = path.join(workDir, "workspace");
const store = new FileSessionStore(sessionsDir);
const session = await store.createSession({ tags: ["demo"] });

const model = createFauxRuntime([
  fauxAssistantMessage(
    [
      fauxToolCall("execute", {
        name: "bash",
        input: { command: 'printf "hello from the sandbox\\n" > greeting.txt && cat greeting.txt' },
      }),
    ],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage(
    [fauxToolCall("execute", { name: "list_files", input: { path: "." } })],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage([
    fauxText("Done: I wrote greeting.txt and listed the workspace through the execute hand."),
  ]),
]);

const sandbox = new SandboxRuntime({
  provider: new FactorySandboxProvider(() => new LocalSandbox({ rootDir: sandboxDir })),
  onProvisioned: async (provisioned) => {
    await store.append(session.sessionId, "sandbox_provisioned", {
      sandboxId: provisioned.id,
    });
  },
  onFailed: async (failed, error) => {
    await store.append(session.sessionId, "sandbox_failed", {
      sandboxId: failed.id,
      error: error.message,
    });
  },
});

const harness = new Harness({
  sessionStore: store,
  sandbox,
  model: model.model,
  streamFn: model.streamFn,
  contextPolicy: new WindowContextPolicy(20),
});

const result = await harness.run(session.sessionId, "write a greeting file, then list the workspace");

console.log("== result ==");
console.log(result);
console.log("\n== session log ==");
console.log(formatEventLog(await store.read(session.sessionId)));
console.log("\n== files in the sandbox ==");
console.log(await sandbox.execute("bash", { command: "find . -maxdepth 2 -type f -print" }));

await sandbox.destroy();
console.log(`\nsession files kept at: ${sessionsDir}`);
