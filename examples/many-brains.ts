/**
 * Many brains, many hands.
 *
 * Each brain is a separate stateless harness with its own session and its own
 * sandbox. Nothing is shared except the process. This is the horizontal scale
 * story from the article: starting many stateless harnesses is cheap.
 *
 * Run: npm run demo:many
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Harness } from "../src/harness/harness.js";
import { createFauxRuntime } from "../src/model/faux.js";
import { LocalSandbox } from "../src/sandbox/local.js";
import { FactorySandboxProvider, SandboxRuntime } from "../src/sandbox/runtime.js";
import { InMemorySessionStore } from "../src/session/store.js";

const BRAINS = 4;
const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-managed-many-"));
const store = new InMemorySessionStore();

async function runBrain(index: number): Promise<{
  index: number;
  sessionId: string;
  status: string;
  finalMessage?: string;
  events: number;
}> {
  const session = await store.createSession({ tags: [`brain-${index}`] });
  const model = createFauxRuntime(
    [
      fauxAssistantMessage(
        [
          fauxToolCall("execute", {
            name: "bash",
            input: { command: `echo brain-${index} > identity.txt && cat identity.txt` },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText(`brain ${index} finished`)]),
    ],
    { provider: `faux-brain-${index}` },
  );

  const sandbox = new SandboxRuntime({
    provider: new FactorySandboxProvider(
      () => new LocalSandbox({ rootDir: path.join(workDir, `brain-${index}`) }),
    ),
  });
  const harness = new Harness({
    sessionStore: store,
    sandbox,
    model: model.model,
    streamFn: model.streamFn,
    harnessId: `harness-${index}`,
  });
  try {
    const result = await harness.run(session.sessionId, `identify yourself as brain ${index}`);
    const events = await store.read(session.sessionId);
    return {
      index,
      sessionId: session.sessionId,
      status: result.status,
      ...(result.finalMessage ? { finalMessage: result.finalMessage } : {}),
      events: events.length,
    };
  } finally {
    await sandbox.destroy();
  }
}

console.log(`starting ${BRAINS} stateless harnesses concurrently...`);
const results = await Promise.all(Array.from({ length: BRAINS }, (_, index) => runBrain(index)));
for (const result of results) {
  console.log(
    `brain ${result.index}: ${result.status} | ${result.finalMessage} | session=${result.sessionId.slice(0, 20)}... | events=${result.events}`,
  );
}

await rm(workDir, { recursive: true, force: true });
