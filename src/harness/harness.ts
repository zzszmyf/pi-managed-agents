import { randomUUID } from "node:crypto";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { SessionStore } from "../session/store.js";
import type { ContextPolicy } from "../session/context.js";
import { WindowContextPolicy } from "../session/context.js";
import type { Sandbox } from "../sandbox/sandbox.js";
import type { RunResult, SandboxResources } from "../types.js";
import { createExecuteTool, EXECUTE_TOOL_NAME } from "./tools.js";

const DEFAULT_SYSTEM_PROMPT = `You are a stateless agent harness around a language model.

You can only act through the "execute" tool. Each call names a hand and passes
an input object. The hand returns a string. Use small, verifiable steps. When
the task is complete, reply with a short summary and stop calling tools.`;

export interface HarnessOptions {
  sessionStore: SessionStore;
  sandbox: Sandbox;
  model: Model<Api>;
  streamFn: StreamFn;
  systemPrompt?: string;
  contextPolicy?: ContextPolicy;
  harnessId?: string;
  /** Provision the sandbox before the first model request. Default false (lazy). */
  eagerProvision?: boolean;
  sandboxResources?: SandboxResources;
  /** Called when the first text token of a run arrives. */
  onFirstToken?: (milliseconds: number) => void;
  /** Called for every streamed assistant text delta. */
  onTextDelta?: (delta: string) => void;
  /** Called when a tool call starts executing. */
  onToolStart?: (toolName: string, args: unknown) => void;
  /** Called when a tool call finishes. */
  onToolEnd?: (toolName: string, ok: boolean, output: string) => void;
  /** Test hook: observe every agent event after it has been recorded. */
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

/**
 * The harness is the "brain": it owns the loop that calls the model and routes
 * tool calls to the sandbox. It is stateless with respect to durable state.
 *
 * Create a new Harness (or call `wake`) after a crash; everything needed to
 * continue lives in the session log.
 */
export class Harness {
  readonly id: string;
  private readonly sessionStore: SessionStore;
  private readonly sandbox: Sandbox;
  private readonly model: Model<Api>;
  private readonly streamFn: StreamFn;
  private readonly systemPrompt: string;
  private readonly contextPolicy: ContextPolicy;
  private readonly eagerProvision: boolean;
  private readonly sandboxResources?: SandboxResources;
  private readonly onFirstToken?: (milliseconds: number) => void;
  private readonly onTextDelta?: (delta: string) => void;
  private readonly onToolStart?: (toolName: string, args: unknown) => void;
  private readonly onToolEnd?: (toolName: string, ok: boolean, output: string) => void;
  private readonly onEvent?: (event: AgentEvent) => void | Promise<void>;

  constructor(options: HarnessOptions) {
    this.id = options.harnessId ?? `harness_${randomUUID()}`;
    this.sessionStore = options.sessionStore;
    this.sandbox = options.sandbox;
    this.model = options.model;
    this.streamFn = options.streamFn;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.contextPolicy = options.contextPolicy ?? new WindowContextPolicy(40);
    this.eagerProvision = options.eagerProvision ?? false;
    this.sandboxResources = options.sandboxResources;
    this.onFirstToken = options.onFirstToken;
    this.onTextDelta = options.onTextDelta;
    this.onToolStart = options.onToolStart;
    this.onToolEnd = options.onToolEnd;
    this.onEvent = options.onEvent;
  }

  /** Start a new user turn in an existing session. */
  async run(sessionId: string, input: string): Promise<RunResult> {
    return withSessionLock(sessionId, async () => {
      const runId = `run_${randomUUID()}`;
      const startedAt = performance.now();
      let firstTokenMs: number | undefined;

      await this.sessionStore.append(sessionId, "run_started", {
        runId,
        harnessId: this.id,
        resumed: false,
      });

      const messages = await this.loadMessages(sessionId);
      const agent = this.createAgent(sessionId, runId, messages, startedAt, (milliseconds) => {
        firstTokenMs = milliseconds;
        this.onFirstToken?.(milliseconds);
      });

      try {
        if (this.eagerProvision) {
          await this.sandbox.provision(this.sandboxResources);
        }
        await agent.prompt(input);
        return await this.finishRun(sessionId, runId, agent, firstTokenMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.sessionStore.append(sessionId, "run_error", { runId, error: message });
        await this.sessionStore.append(sessionId, "run_finished", {
          runId,
          status: "error",
          reason: message,
        });
        throw error;
      }
    });
  }

  /**
   * Recover a session with a brand-new harness.
   *
   * The session log is the only input. If the previous harness died after the
   * model asked for a tool but before the tool result was recorded, the orphan
   * call is replayed against the sandbox first.
   */
  async wake(sessionId: string): Promise<RunResult> {
    return withSessionLock(sessionId, async () => {
      const runId = `run_${randomUUID()}`;
      const startedAt = performance.now();
      let firstTokenMs: number | undefined;

      await this.sessionStore.append(sessionId, "run_started", {
        runId,
        harnessId: this.id,
        resumed: true,
      });

      const events = await this.sessionStore.read(sessionId);
      const durableMessages = this.contextPolicy.select(events);
      if (durableMessages.length === 0) {
        await this.sessionStore.append(sessionId, "run_finished", {
          runId,
          status: "completed",
          reason: "nothing to resume",
        });
        return { sessionId, runId, status: "already_complete" };
      }

      const recovered = await this.recoverOrphanToolCalls(sessionId, durableMessages);
      const messages = recovered.messages;
      const last = messages.at(-1);

      if (!last || (last.role === "assistant" && recovered.count === 0)) {
        const finalMessage = lastAssistantText(messages);
        await this.sessionStore.append(sessionId, "run_finished", {
          runId,
          status: "completed",
          reason: "already complete",
        });
        return {
          sessionId,
          runId,
          status: "already_complete",
          ...(finalMessage !== undefined ? { finalMessage } : {}),
        };
      }

      if (last.role !== "user" && last.role !== "toolResult") {
        const error = new Error(
          `Cannot resume from a trailing ${last.role} message; expected user or toolResult`,
        );
        await this.sessionStore.append(sessionId, "run_error", {
          runId,
          error: error.message,
        });
        await this.sessionStore.append(sessionId, "run_finished", {
          runId,
          status: "error",
          reason: error.message,
        });
        throw error;
      }

      const agent = this.createAgent(sessionId, runId, messages, startedAt, (milliseconds) => {
        firstTokenMs = milliseconds;
        this.onFirstToken?.(milliseconds);
      });

      try {
        await agent.continue();
        return await this.finishRun(sessionId, runId, agent, firstTokenMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.sessionStore.append(sessionId, "run_error", { runId, error: message });
        await this.sessionStore.append(sessionId, "run_finished", {
          runId,
          status: "error",
          reason: message,
        });
        throw error;
      }
    });
  }

  private async loadMessages(sessionId: string): Promise<Message[]> {
    const events = await this.sessionStore.read(sessionId);
    return this.contextPolicy.select(events);
  }

  private createAgent(
    sessionId: string,
    runId: string,
    messages: Message[],
    startedAt: number,
    setFirstToken: (milliseconds: number) => void,
  ): Agent {
    const tools: AgentTool[] = [createExecuteTool(this.sandbox)];
    let firstTokenSeen = false;
    const agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt,
        model: this.model,
        tools,
        messages: messages as AgentMessage[],
      },
      streamFn: this.streamFn,
      sessionId,
      transformContext: async (liveMessages) => this.contextPolicy.prune(liveMessages),
    });

    agent.subscribe(async (event) => {
      await this.recordEvent(sessionId, runId, event);
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        if (!firstTokenSeen) {
          firstTokenSeen = true;
          setFirstToken(performance.now() - startedAt);
        }
        this.onTextDelta?.(event.assistantMessageEvent.delta);
      } else if (event.type === "tool_execution_start") {
        this.onToolStart?.(event.toolName, event.args);
      } else if (event.type === "tool_execution_end") {
        this.onToolEnd?.(event.toolName, !event.isError, toolResultText(event.result));
      }
      await this.onEvent?.(event);
    });

    return agent;
  }

  private async recordEvent(sessionId: string, runId: string, event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_end": {
        const message = event.message;
        if (message.role === "system") return;
        if (
          message.role === "assistant" &&
          (message.stopReason === "error" || message.stopReason === "aborted")
        ) {
          return;
        }
        await this.sessionStore.append(sessionId, "message", { message: message as Message });
        return;
      }
      case "tool_execution_start": {
        await this.sessionStore.append(sessionId, "tool_started", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        return;
      }
      case "tool_execution_end": {
        await this.sessionStore.append(sessionId, "tool_finished", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: toolResultText(event.result),
          isError: event.isError,
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        });
        return;
      }
      case "agent_end": {
        // run_finished is written by run()/wake() after prompt/continue settles,
        // so that the status reflects the final assistant message. This event
        // exists for observers that need a per-run marker.
        void runId;
        return;
      }
      default:
        return;
    }
  }

  private async finishRun(
    sessionId: string,
    runId: string,
    agent: Agent,
    firstTokenMs: number | undefined,
  ): Promise<RunResult> {
    const messages = agent.state.messages;
    const last = lastAssistant(messages);
    const status =
      last?.stopReason === "error"
        ? "error"
        : last?.stopReason === "aborted"
          ? "aborted"
          : "completed";
    const finalMessage = status === "completed" ? lastAssistantText(messages) : undefined;
    if (status !== "completed") {
      await this.sessionStore.append(sessionId, "run_error", {
        runId,
        error: last?.errorMessage ?? `model stopped with reason ${last?.stopReason ?? "unknown"}`,
      });
    }
    await this.sessionStore.append(sessionId, "run_finished", {
      runId,
      status,
      ...(status !== "completed" ? { reason: last?.errorMessage } : {}),
    });
    return {
      sessionId,
      runId,
      status,
      ...(finalMessage !== undefined ? { finalMessage } : {}),
      ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    };
  }

  /**
   * Replay tool calls that were recorded in an assistant message but never got
   * a toolResult. This is the crash-recovery path.
   */
  private async recoverOrphanToolCalls(
    sessionId: string,
    messages: Message[],
  ): Promise<{ messages: Message[]; count: number }> {
    const assistantIndex = findLastAssistantWithToolCalls(messages);
    if (assistantIndex === -1) return { messages, count: 0 };
    const assistant = messages[assistantIndex] as AssistantMessage;
    const seen = new Set<string>();
    for (const message of messages.slice(assistantIndex + 1)) {
      if (message.role === "toolResult") seen.add(message.toolCallId);
    }
    const calls = assistant.content.filter(
      (block): block is ToolCall => block.type === "toolCall" && !seen.has(block.id),
    );
    if (calls.length === 0) return { messages, count: 0 };

    const results: ToolResultMessage[] = [];
    for (const call of calls) {
      const args = call.arguments as { name?: unknown; input?: unknown };
      const hand = typeof args.name === "string" ? args.name : "";
      const input =
        args.input && typeof args.input === "object"
          ? (args.input as Record<string, unknown>)
          : {};
      const startedAt = performance.now();
      await this.sessionStore.append(sessionId, "tool_started", {
        toolCallId: call.id,
        toolName: call.name,
        args: call.arguments,
      });
      let text: string;
      let isError = false;
      try {
        if (call.name !== EXECUTE_TOOL_NAME) {
          throw new Error(`Cannot replay unknown tool "${call.name}"`);
        }
        text = await this.sandbox.execute(hand, input);
      } catch (error) {
        text = `Sandbox error: ${error instanceof Error ? error.message : String(error)}`;
        isError = true;
      }
      const durationMs = performance.now() - startedAt;
      await this.sessionStore.append(sessionId, "tool_finished", {
        toolCallId: call.id,
        toolName: call.name,
        result: text,
        isError,
        durationMs,
      });
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text }],
        isError,
        timestamp: Date.now(),
      };
      await this.sessionStore.append(sessionId, "message", { message: result });
      results.push(result);
    }
    return { messages: [...messages, ...results], count: calls.length };
  }
}

function findLastAssistantWithToolCalls(messages: readonly Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    if (message.content.some((block) => block.type === "toolCall")) return index;
  }
  return -1;
}

function lastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant") return message;
  }
  return undefined;
}

function lastAssistantText(messages: readonly AgentMessage[]): string | undefined {
  const assistant = lastAssistant(messages);
  if (!assistant) return undefined;
  const text = assistant.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function toolResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" ? (block.text ?? "") : `[${block.type}]`))
    .join("\n");
}

const activeSessions = new Set<string>();

async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  if (activeSessions.has(sessionId)) {
    throw new Error(`Session ${sessionId} already has an active harness in this process`);
  }
  activeSessions.add(sessionId);
  try {
    return await fn();
  } finally {
    activeSessions.delete(sessionId);
  }
}
