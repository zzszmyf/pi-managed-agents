import type { Message } from "@earendil-works/pi-ai";
import type { SandboxResources } from "../types.js";

/**
 * The session is the append-only log of everything that happened.
 *
 * It lives outside the harness and outside any sandbox. A harness can crash and
 * be replaced; the session survives. The harness decides which slices of this
 * log to feed back into the model's context window.
 */
export type SessionEventType =
  | "session_created"
  | "run_started"
  | "message"
  | "tool_started"
  | "tool_finished"
  | "sandbox_provisioned"
  | "sandbox_failed"
  | "run_error"
  | "run_finished";

export interface SessionMeta {
  sessionId: string;
  createdAt: number;
  tags?: string[];
}

export interface SessionEventData {
  session_created: { meta: SessionMeta };
  run_started: { runId: string; harnessId: string; resumed: boolean };
  message: { message: Message };
  tool_started: { toolCallId: string; toolName: string; args: unknown };
  tool_finished: {
    toolCallId: string;
    toolName: string;
    result: string;
    isError: boolean;
    durationMs?: number;
  };
  sandbox_provisioned: { sandboxId: string; resources?: SandboxResources };
  sandbox_failed: { sandboxId: string; error: string };
  run_error: { runId: string; error: string };
  run_finished: {
    runId: string;
    status: "completed" | "error" | "aborted";
    reason?: string;
  };
}

/** A session event with a specific type. */
export interface SessionEventOf<T extends SessionEventType> {
  /** Monotonic, 1-based position in the session. */
  seq: number;
  ts: number;
  sessionId: string;
  type: T;
  data: SessionEventData[T];
}

/**
 * The discriminated union of all session events. `event.type` narrows
 * `event.data` at call sites.
 */
export type SessionEvent = {
  [K in SessionEventType]: SessionEventOf<K>;
}[SessionEventType];

export interface EventQuery {
  /** Inclusive lower bound. */
  fromSeq?: number;
  /** Inclusive upper bound. */
  toSeq?: number;
  /** Only return events of these types. */
  types?: readonly SessionEventType[];
  /** Return at most this many events, from the end of the selected range. */
  limit?: number;
}

export type EventOf<T extends SessionEventType> = SessionEventOf<T>;

/** Narrow a session event to a specific type. */
export function isEvent<T extends SessionEventType>(
  event: SessionEvent,
  type: T,
): event is Extract<SessionEvent, { type: T }> {
  return event.type === type;
}

/** Extract the durable transcript messages from a slice of session events. */
export function messageEvents(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];
  for (const event of events) {
    if (event.type !== "message") continue;
    const message = (event.data as SessionEventData["message"]).message;
    if (message.role === "system") continue;
    if (
      message.role === "assistant" &&
      (message.stopReason === "error" || message.stopReason === "aborted")
    ) {
      continue;
    }
    messages.push(message);
  }
  return messages;
}
