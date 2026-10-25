#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { FileSessionStore } from "./session/store.js";
import { WindowContextPolicy } from "./session/context.js";
import { Harness } from "./harness/harness.js";
import { InteractiveShell } from "./interactive.js";
import { createFauxRuntime } from "./model/faux.js";
import { createRealRuntime, createAnthropicCompatibleRuntime, type RealProvider } from "./model/real.js";
import { LocalSandbox } from "./sandbox/local.js";
import { DockerSandbox } from "./sandbox/docker.js";
import { FactorySandboxProvider, SandboxRuntime } from "./sandbox/runtime.js";
import { formatEventLog } from "./session/format.js";
import { formatTtftReport, benchmarkTtft } from "./bench/ttft.js";

const HELP = `pi-managed-agents

Usage:
  pi-managed-agents                     start interactive mode
  pi-managed-agents chat [options]      start interactive mode
  pi-managed-agents run <task> [options]
  pi-managed-agents resume <sessionId> [options]
  pi-managed-agents sessions [options]
  pi-managed-agents events <sessionId> [options]
  pi-managed-agents bench

Options:
  --provider <faux|anthropic|openai>  Model provider (default: faux)
  --model <id>                        Model id for real providers
  --base-url <url>                    Anthropic-compatible endpoint (requires --model)
  --session <id>                      Reuse an existing session instead of creating one
  --create-session                    Create --session if it does not exist
  --allowed-hands <list>              Restrict hands, e.g. read_file,list_files
  --sandbox <local|docker>            Hand implementation (default: local)
  --sandbox-root <dir>                Local sandbox root (default: a temp dir per session)
  --eager                             Provision the sandbox before the first model request
  --context <n>                       Context window in messages (default: 40)
  --root <dir>                        Session directory (default: .sessions)
  --json                              Print raw JSON
`;

function sessionRoot(value: string | undefined): string {
  return path.resolve(value ?? ".sessions");
}

function sandboxRoot(sessionId: string): string {
  return path.join(os.tmpdir(), "pi-managed-agents", sessionId);
}

function parseHands(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const hands = value.split(/[\s,]+/).filter(Boolean);
  return hands.length > 0 ? hands : undefined;
}

function makeModel(
  provider: string,
  modelId: string | undefined,
  script: "run" | "resume",
  baseUrl?: string,
) {
  if (provider === "faux") {
    const responses: FauxResponseStep[] =
      script === "run"
        ? [
            fauxAssistantMessage(
              [fauxToolCall("execute", { name: "bash", input: { command: "pwd && ls -la" } })],
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage([fauxText("Task complete. The sandbox output is above.")]),
          ]
        : [fauxAssistantMessage([fauxText("Resumed from the session log and completed.")])];
    return createFauxRuntime(responses);
  }
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error(`Unknown provider: ${provider}. Use faux, anthropic or openai.`);
  }
  if (baseUrl) {
    if (provider !== "anthropic") {
      throw new Error("--base-url is currently supported for the anthropic provider only");
    }
    if (!modelId) {
      throw new Error("--base-url requires --model, because the endpoint is not in the model catalog");
    }
    return createAnthropicCompatibleRuntime({ baseUrl, modelId });
  }
  return createRealRuntime(provider as RealProvider, modelId);
}

function makeSandbox(mode: string, sessionId: string, rootOverride?: string): SandboxRuntime {
  const provider =
    mode === "docker"
      ? new FactorySandboxProvider(() => new DockerSandbox())
      : new FactorySandboxProvider(
          () =>
            new LocalSandbox({
              rootDir: rootOverride ?? sandboxRoot(sessionId),
              destroyRoot: rootOverride === undefined,
            }),
        );
  return new SandboxRuntime({ provider });
}

async function printEvents(store: FileSessionStore, sessionId: string): Promise<void> {
  console.log(formatEventLog(await store.read(sessionId)));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string", default: "faux" },
      model: { type: "string" },
      "base-url": { type: "string" },
      session: { type: "string" },
      "create-session": { type: "boolean", default: false },
      "allowed-hands": { type: "string" },
      sandbox: { type: "string", default: "local" },
      "sandbox-root": { type: "string" },
      eager: { type: "boolean", default: false },
      context: { type: "string", default: "40" },
      root: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const root = sessionRoot(values.root);
  const store = new FileSessionStore(root);

  const command = positionals[0];
  if (values.help) {
    console.log(HELP);
    return;
  }

  if (command === "chat" || (!command && process.stdin.isTTY)) {
    const runtime = makeModel(values.provider, values.model, "run", values["base-url"]);
    if (values.session && !(await store.exists(values.session))) {
      throw new Error(`Unknown session: ${values.session}`);
    }
    const modelLabel =
      values.provider === "faux"
        ? "faux (deterministic echo)"
        : `${values.model ?? "default"}${values["base-url"] ? ` @ ${values["base-url"]}` : ""}`;
    const shell = new InteractiveShell({
      store,
      runtime,
      makeSandbox: (sessionId) =>
        makeSandbox(values.sandbox, sessionId, values["sandbox-root"]),
      contextWindow: Number(values.context),
      eagerProvision: values.eager,
      ...(values.session ? { sessionId: values.session } : {}),
      ...(parseHands(values["allowed-hands"])
        ? { allowedHands: parseHands(values["allowed-hands"])! }
        : {}),
      modelLabel,
      sandboxLabel: values.sandbox,
    });
    await shell.start();
    return;
  }

  if (!command) {
    console.log(HELP);
    return;
  }

  if (command === "sessions") {
    const sessions = await store.listSessions();
    if (values.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log("No sessions in", root);
      return;
    }
    for (const session of sessions) {
      console.log(`${session.sessionId}  ${new Date(session.createdAt).toISOString()}`);
    }
    return;
  }

  if (command === "bench") {
    const report = await benchmarkTtft();
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatTtftReport(report));
    return;
  }

  if (command === "events") {
    const sessionId = positionals[1] ?? values.session;
    if (!sessionId) throw new Error("events requires a session id");
    if (values.json) {
      console.log(JSON.stringify(await store.read(sessionId), null, 2));
    } else {
      await printEvents(store, sessionId);
    }
    return;
  }

  if (command === "run") {
    const task = positionals.slice(1).join(" ").trim();
    if (!task) throw new Error("run requires a task");
    const session = values.session
      ? (await store.exists(values.session))
        ? { sessionId: values.session }
        : values["create-session"]
          ? await store.createSession({ sessionId: values.session })
          : (() => {
              throw new Error(
                `Unknown session: ${values.session}. Pass --create-session to create it.`,
              );
            })()
      : await store.createSession();
    const runtime = makeModel(values.provider, values.model, "run", values["base-url"]);
    const sandbox = makeSandbox(values.sandbox, session.sessionId, values["sandbox-root"]);
    const harness = new Harness({
      sessionStore: store,
      sandbox,
      model: runtime.model,
      streamFn: runtime.streamFn,
      contextPolicy: new WindowContextPolicy(Number(values.context)),
      eagerProvision: values.eager,
      ...(parseHands(values["allowed-hands"])
        ? { allowedHands: parseHands(values["allowed-hands"])! }
        : {}),
    });
    try {
      const result = await harness.run(session.sessionId, task);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`session: ${result.sessionId}`);
        console.log(`status:  ${result.status}`);
        if (result.firstTokenMs !== undefined) {
          console.log(`ttft:    ${result.firstTokenMs.toFixed(0)}ms`);
        }
        if (result.finalMessage) console.log(`answer:  ${result.finalMessage}`);
        console.log("");
        await printEvents(store, result.sessionId);
      }
    } finally {
      await sandbox.destroy();
    }
    return;
  }

  if (command === "resume") {
    const sessionId = positionals[1] ?? values.session;
    if (!sessionId) throw new Error("resume requires a session id");
    if (!(await store.exists(sessionId))) throw new Error(`Unknown session: ${sessionId}`);
    const runtime = makeModel(values.provider, values.model, "resume", values["base-url"]);
    const sandbox = makeSandbox(values.sandbox, sessionId, values["sandbox-root"]);
    const harness = new Harness({
      sessionStore: store,
      sandbox,
      model: runtime.model,
      streamFn: runtime.streamFn,
      contextPolicy: new WindowContextPolicy(Number(values.context)),
      ...(parseHands(values["allowed-hands"])
        ? { allowedHands: parseHands(values["allowed-hands"])! }
        : {}),
    });
    try {
      const result = await harness.wake(sessionId);
      if (values.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`session: ${result.sessionId}`);
        console.log(`status:  ${result.status}`);
        if (result.firstTokenMs !== undefined) {
          console.log(`ttft:    ${result.firstTokenMs.toFixed(0)}ms`);
        }
        if (result.finalMessage) console.log(`answer:  ${result.finalMessage}`);
        console.log("");
        await printEvents(store, sessionId);
      }
    } finally {
      await sandbox.destroy();
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
