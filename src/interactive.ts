import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { Harness } from "./harness/harness.js";
import type { FauxRuntime } from "./model/faux.js";
import type { RealRuntime } from "./model/real.js";
import type { SandboxRuntime } from "./sandbox/runtime.js";
import { WindowContextPolicy } from "./session/context.js";
import type { SessionStore } from "./session/store.js";
import { formatEventLog } from "./session/format.js";

export interface InteractiveOptions {
  store: SessionStore;
  runtime: FauxRuntime | RealRuntime;
  makeSandbox: (sessionId: string) => SandboxRuntime;
  contextWindow: number;
  eagerProvision: boolean;
  allowedHands?: readonly string[];
  sessionId?: string;
  modelLabel: string;
  sandboxLabel: string;
}

const HELP = `commands:
  /help              show this help
  /new               start a new session and a new sandbox
  /session           show the current session id
  /sessions          list recent sessions
  /events [n]        show the last n events (default 10)
  /model             show the model and context policy
  /quit, /exit       exit

anything else is sent to the agent as a user message.`;

function preview(value: unknown, limit = 240): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
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

function hasUnfinishedTurn(messages: readonly Message[]): boolean {
  const last = messages.at(-1);
  return (
    last?.role === "assistant" &&
    last.content.some((block) => block.type === "toolCall")
  );
}

/**
 * A small interactive shell around the harness.
 *
 * It keeps one session and one sandbox alive across turns. Every user message
 * is a normal Harness.run() call, so the session log remains the source of
 * truth; /new just swaps to a new session and sandbox.
 */
export class InteractiveShell {
  private readonly options: InteractiveOptions;
  private readonly rl: Interface;
  private readonly lineQueue: string[] = [];
  private readonly lineWaiters: Array<(line: string | undefined) => void> = [];
  private closed = false;
  private sessionId = "";
  private sandbox?: SandboxRuntime;
  private harness?: Harness;
  private streamedThisTurn = false;

  constructor(options: InteractiveOptions) {
    this.options = options;
    this.rl = createInterface({ input: stdin, output: stdout });
    // Attach the listener immediately. If input is piped, lines can arrive
    // before the first prompt; queue them instead of dropping them.
    this.rl.on("line", (line) => {
      const waiter = this.lineWaiters.shift();
      if (waiter) waiter(line);
      else this.lineQueue.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const waiter of this.lineWaiters.splice(0)) waiter(undefined);
    });
  }

  private nextLine(prompt: string): Promise<string | undefined> {
    stdout.write(prompt);
    const queued = this.lineQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.lineWaiters.push(resolve));
  }

  async start(): Promise<void> {
    if (this.options.sessionId) {
      if (!(await this.options.store.exists(this.options.sessionId))) {
        throw new Error(`Unknown session: ${this.options.sessionId}`);
      }
      this.sessionId = this.options.sessionId;
    } else {
      this.sessionId = (await this.options.store.createSession({ tags: ["interactive"] })).sessionId;
    }

    this.sandbox = this.options.makeSandbox(this.sessionId);
    this.harness = this.createHarness();

    console.log("pi-managed-agents · interactive");
    console.log(`model:   ${this.options.modelLabel}`);
    console.log(`sandbox: ${this.options.sandboxLabel}`);
    console.log(`session: ${this.sessionId}`);
    console.log("type /help for commands, /quit to exit");

    if (this.options.sessionId) {
      const events = await this.options.store.read(this.sessionId);
      const messages = events
        .filter((event) => event.type === "message")
        .map((event) => event.data.message);
      if (hasUnfinishedTurn(messages)) {
        console.log("\nfound an unfinished turn in this session; waking a new harness...");
        this.beginTurn();
        try {
          const result = await this.harness!.wake(this.sessionId);
          this.endTurn(result.status, result.firstTokenMs);
        } catch (error) {
          console.log(`\nwake failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    try {
      await this.loop();
    } finally {
      await this.cleanup();
    }
  }

  private createHarness(): Harness {
    return new Harness({
      sessionStore: this.options.store,
      sandbox: this.sandbox!,
      model: this.options.runtime.model,
      streamFn: this.options.runtime.streamFn,
      contextPolicy: new WindowContextPolicy(this.options.contextWindow),
      eagerProvision: this.options.eagerProvision,
      ...(this.options.allowedHands ? { allowedHands: this.options.allowedHands } : {}),
      onTextDelta: (delta) => {
        this.streamedThisTurn = true;
        stdout.write(delta);
      },
      onToolStart: (_toolCallId, toolName, args) => {
        stdout.write(`\n  [tool] ${toolName} ${preview(args)}\n  `);
      },
      onToolEnd: (_toolCallId, toolName, ok, output) => {
        stdout.write(`  [tool] ${toolName} ${ok ? "ok" : "error"}: ${preview(output)}\n  `);
      },
    });
  }

  private beginTurn(): void {
    this.streamedThisTurn = false;
    if ("faux" in this.options.runtime) {
      const factory: FauxResponseFactory = (context) =>
        fauxAssistantMessage([fauxText(`[faux] ${lastUserText(context.messages)}`)]);
      this.options.runtime.faux.setResponses([factory]);
    }
  }

  private endTurn(status: string, firstTokenMs?: number): void {
    if (!this.streamedThisTurn) console.log("(no text)");
    const ttft = firstTokenMs !== undefined ? `, ttft ${firstTokenMs.toFixed(0)}ms` : "";
    console.log(`\n  [${status}${ttft}]`);
  }

  private async loop(): Promise<void> {
    for (;;) {
      const next = await this.nextLine("\nyou> ");
      if (next === undefined) break;
      const line = next.trim();
      if (line.length === 0) continue;
      if (line.startsWith("/")) {
        const shouldExit = await this.command(line);
        if (shouldExit) break;
        continue;
      }
      this.beginTurn();
      process.stdout.write("assistant: ");
      try {
        const result = await this.harness!.run(this.sessionId, line);
        this.endTurn(result.status, result.firstTokenMs);
      } catch (error) {
        console.log(`\nerror: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async command(line: string): Promise<boolean> {
    const [name, ...args] = line.split(/\s+/);
    switch (name) {
      case "/help":
        console.log(HELP);
        return false;
      case "/new": {
        await this.sandbox?.destroy();
        this.sessionId = (await this.options.store.createSession({ tags: ["interactive"] })).sessionId;
        this.sandbox = this.options.makeSandbox(this.sessionId);
        this.harness = this.createHarness();
        console.log(`new session: ${this.sessionId}`);
        return false;
      }
      case "/session":
        console.log(this.sessionId);
        return false;
      case "/sessions": {
        const sessions = await this.options.store.listSessions();
        for (const session of sessions.slice(0, 10)) {
          const marker = session.sessionId === this.sessionId ? "*" : " ";
          console.log(`${marker} ${session.sessionId}  ${new Date(session.createdAt).toISOString()}`);
        }
        return false;
      }
      case "/events": {
        const requested = Number(args[0] ?? 10);
        const limit = Number.isFinite(requested) && requested > 0 ? requested : 10;
        const events = await this.options.store.read(this.sessionId, { limit });
        console.log(formatEventLog(events));
        return false;
      }
      case "/model":
        console.log(`model:   ${this.options.modelLabel}`);
        console.log(`context: last ${this.options.contextWindow} messages`);
        console.log(`sandbox: ${this.options.sandboxLabel}`);
        return false;
      case "/quit":
      case "/exit":
        return true;
      default:
        console.log(`unknown command: ${name}. Try /help.`);
        return false;
    }
  }

  private async cleanup(): Promise<void> {
    this.rl.close();
    await this.sandbox?.destroy();
  }
}
