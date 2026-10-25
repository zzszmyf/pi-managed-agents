#!/usr/bin/env node
/**
 * pi-claude-shim — make lark-channel-bridge drive pi-managed-agents.
 *
 * The bridge spawns `claude` with:
 *   -p --output-format stream-json --verbose
 *   --permission-mode <mode>
 *   --append-system-prompt-file <file>
 *   [--resume <sessionId>] [--model <model>]
 * and writes the prompt to stdin.
 *
 * This shim implements that protocol by running the pi-managed-agents harness
 * and translating its events into Claude's stream-json lines. It is opt-in:
 * unless PI_BRIDGE_AGENT=pi and --output-format is stream-json, it delegates to
 * the real Claude binary named by PI_REAL_CLAUDE_BIN.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage, FauxResponseFactory, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { DEFAULT_HARNESS_SYSTEM_PROMPT, Harness } from "../harness/harness.js";
import { createFauxRuntime } from "../model/faux.js";
import { createAnthropicCompatibleRuntime, createRealRuntime } from "../model/real.js";
import { LocalSandbox } from "../sandbox/local.js";
import { FactorySandboxProvider, SandboxRuntime } from "../sandbox/runtime.js";
import { WindowContextPolicy } from "../session/context.js";
import { FileSessionStore } from "../session/store.js";

interface ShimArgs {
  outputFormat?: string;
  permissionMode: string;
  systemPromptFile?: string;
  resume?: string;
  model?: string;
  inlinePrompt?: string;
}

function parseArgs(argv: readonly string[]): ShimArgs {
  const result: ShimArgs = { permissionMode: "bypassPermissions" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const value = (): string | undefined => inline ?? argv[++index];
    switch (flag) {
      case "--output-format":
        result.outputFormat = value();
        break;
      case "--permission-mode":
        result.permissionMode = value() ?? result.permissionMode;
        break;
      case "--append-system-prompt-file":
        result.systemPromptFile = value();
        break;
      case "--resume":
        result.resume = value();
        break;
      case "--model":
        result.model = value();
        break;
      case "-p":
      case "--print": {
        if (inline === undefined && argv[index + 1] && !argv[index + 1]!.startsWith("-")) {
          result.inlinePrompt = argv[++index];
        }
        break;
      }
      default:
        // --verbose and any future flags are irrelevant here.
        break;
    }
  }
  return result;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function delegate(argv: readonly string[]): Promise<never> {
  const real = process.env.PI_REAL_CLAUDE_BIN;
  if (!real) {
    console.error(
      "pi-claude-shim: PI_REAL_CLAUDE_BIN is not set; cannot delegate to the real claude binary",
    );
    process.exit(2);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(real!, argv, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 1);
    });
  });
  throw new Error("unreachable");
}

function sanitizeId(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return cleaned.length > 0 ? cleaned : randomUUID();
}

function resolveSessionId(resume: string | undefined): string {
  if (!resume) return `bridge_${randomUUID()}`;
  return `bridge_${sanitizeId(resume.replace(/^bridge_/, ""))}`;
}

function lastUserText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");
  }
  return "";
}

function createRuntime(modelId: string | undefined) {
  const provider = process.env.PI_BRIDGE_PROVIDER ?? "anthropic";
  if (provider === "faux") {
    const runtime = createFauxRuntime([], { provider: `faux-bridge-${randomUUID()}` });
    const factory: FauxResponseFactory = (context) =>
      fauxAssistantMessage([fauxText(`[faux bridge] ${lastUserText(context.messages)}`)]);
    runtime.faux.setResponses([factory]);
    return runtime;
  }
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const resolvedModel = modelId ?? process.env.ANTHROPIC_MODEL;
  if (baseUrl) {
    if (!resolvedModel) {
      throw new Error("ANTHROPIC_MODEL or --model is required when ANTHROPIC_BASE_URL is set");
    }
    return createAnthropicCompatibleRuntime({ baseUrl, modelId: resolvedModel });
  }
  if (provider === "openai") return createRealRuntime("openai", resolvedModel);
  return createRealRuntime("anthropic", resolvedModel);
}

function resolveHands(permissionMode: string): string[] | undefined {
  const override = process.env.PI_BRIDGE_ALLOWED_HANDS;
  if (override) return override.split(/[\s,]+/).filter(Boolean);
  // The bridge gates who can talk to the bot. Within a run, these modes mean
  // "go ahead"; manual mode falls back to read-only because this shim has no
  // approval UI.
  if (["bypassPermissions", "acceptEdits", "auto"].includes(permissionMode)) return undefined;
  return ["read_file", "list_files"];
}

function mapTool(toolName: string, args: unknown): { name: string; input: unknown } {
  if (toolName !== "execute") return { name: toolName, input: args };
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const hand = typeof record.name === "string" ? record.name : "execute";
  const input = record.input ?? {};
  switch (hand) {
    case "bash":
      return { name: "Bash", input };
    case "read_file":
      return { name: "Read", input };
    case "write_file":
      return { name: "Write", input };
    case "list_files":
      return { name: "Glob", input };
    default:
      return { name: "execute", input: args };
  }
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

function addUsage(totals: UsageTotals, message: AssistantMessage): void {
  const usage = message.usage;
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cost +=
    (usage.cost?.input ?? 0) +
    (usage.cost?.output ?? 0) +
    (usage.cost?.cacheRead ?? 0) +
    (usage.cost?.cacheWrite ?? 0);
}

async function loadSystemPrompt(file: string | undefined): Promise<string> {
  let bridgePrompt = "";
  if (file) {
    try {
      bridgePrompt = await fs.readFile(file, "utf8");
    } catch (error) {
      console.error(
        `pi-claude-shim: could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return [bridgePrompt.trim(), DEFAULT_HARNESS_SYSTEM_PROMPT].filter(Boolean).join("\n\n---\n\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (process.env.PI_BRIDGE_AGENT !== "pi" || args.outputFormat !== "stream-json") {
    await delegate(argv);
    return;
  }

  const prompt = (args.inlinePrompt ?? (await readStdin())).trim();
  if (!prompt) {
    console.error("pi-claude-shim: empty prompt");
    process.exit(2);
  }

  const sessionId = resolveSessionId(args.resume);
  const store = new FileSessionStore(
    process.env.PI_BRIDGE_SESSIONS_DIR ??
      path.join(os.homedir(), ".local", "state", "pi-agent", "bridge-sessions"),
  );
  if (!(await store.exists(sessionId))) {
    await store.createSession({ sessionId, tags: ["bridge"] });
  }

  const runtime = createRuntime(args.model);
  const cwd = process.cwd();
  const sandbox = new SandboxRuntime({
    provider: new FactorySandboxProvider(
      () => new LocalSandbox({ rootDir: cwd, destroyRoot: false }),
    ),
  });
  const hands = resolveHands(args.permissionMode);
  const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  let sawText = false;

  emit({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd,
    model: runtime.model.id,
  });

  const harness = new Harness({
    sessionStore: store,
    sandbox,
    model: runtime.model,
    streamFn: runtime.streamFn,
    systemPrompt: await loadSystemPrompt(args.systemPromptFile),
    contextPolicy: new WindowContextPolicy(
      Number(process.env.PI_BRIDGE_CONTEXT_WINDOW ?? 80),
    ),
    ...(hands ? { allowedHands: hands } : {}),
    onTextDelta: (delta) => {
      sawText = true;
      emit({ type: "assistant", message: { content: [{ type: "text", text: delta }] } });
    },
    onToolStart: (toolCallId, toolName, toolArgs) => {
      const mapped = mapTool(toolName, toolArgs);
      emit({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: toolCallId, name: mapped.name, input: mapped.input },
          ],
        },
      });
    },
    onToolEnd: (toolCallId, _toolName, ok, output) => {
      emit({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: toolCallId, content: output, is_error: !ok },
          ],
        },
      });
    },
    onEvent: (event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        addUsage(usage, event.message);
      }
    },
  });

  try {
    const result = await harness.run(sessionId, prompt, { recoverOrphans: true });
    if (result.status !== "completed") {
      throw new Error(result.finalMessage ?? `run finished with status ${result.status}`);
    }
    if (!sawText && result.finalMessage) {
      emit({
        type: "assistant",
        message: { content: [{ type: "text", text: result.finalMessage }] },
      });
    }
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: sessionId,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cacheRead,
      },
      total_cost_usd: usage.cost,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await sandbox.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
