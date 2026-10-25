import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEvent } from "./events.js";
import { messageEvents } from "./events.js";

/**
 * A context policy is the harness's answer to a simple question:
 * which parts of the durable session should the model see right now?
 *
 * The session keeps everything forever. The policy decides what fits in the
 * context window. This split is the core of "the session is not Claude's
 * context window".
 */
export interface ContextPolicy {
  readonly name: string;
  /** Build a transcript from the durable log, for a fresh harness wake. */
  select(events: readonly SessionEvent[]): Message[];
  /** Prune the live transcript before every provider request. */
  prune(messages: readonly AgentMessage[]): AgentMessage[];
}

function safeWindow<T extends { role: string }>(messages: readonly T[], maxMessages: number): T[] {
  if (maxMessages <= 0 || messages.length <= maxMessages) return [...messages];
  let start = messages.length - maxMessages;
  // A toolResult without its preceding assistant toolCall is an invalid
  // provider request. Walk backwards until the tool call is included.
  while (start > 0 && messages[start]!.role === "toolResult") {
    start -= 1;
  }
  return messages.slice(start);
}

function makeOmissionNotice(): UserMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: "[harness] Earlier session events were omitted by the context policy. Continue from the retained events.",
      },
    ],
    timestamp: Date.now(),
  };
}

function ensureStartsWithUser<T extends { role: string }>(messages: T[]): T[] {
  if (messages.length === 0) return messages;
  if (messages[0]!.role === "user") return messages;
  return [makeOmissionNotice() as unknown as T, ...messages];
}

function splitSystem(messages: readonly AgentMessage[]): {
  system: AgentMessage[];
  rest: AgentMessage[];
} {
  const system: AgentMessage[] = [];
  const rest: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") system.push(message);
    else rest.push(message);
  }
  return { system, rest };
}

function selectAll(events: readonly SessionEvent[]): Message[] {
  return messageEvents(events);
}

function pruneNothing(messages: readonly AgentMessage[]): AgentMessage[] {
  const { system, rest } = splitSystem(messages);
  return [...system, ...ensureStartsWithUser(rest)];
}

/** Keep the whole transcript. Useful for short sessions and debugging. */
export class FullContextPolicy implements ContextPolicy {
  readonly name = "full";

  select(events: readonly SessionEvent[]): Message[] {
    return ensureStartsWithUser(selectAll(events));
  }

  prune(messages: readonly AgentMessage[]): AgentMessage[] {
    return pruneNothing(messages);
  }
}

/**
 * Keep the last N messages, never splitting a tool call from its result.
 * This is the default in the demos.
 */
export class WindowContextPolicy implements ContextPolicy {
  readonly name: string;

  constructor(readonly maxMessages = 40) {
    this.name = `window:${maxMessages}`;
  }

  select(events: readonly SessionEvent[]): Message[] {
    const messages = selectAll(events);
    return ensureStartsWithUser(safeWindow(messages, this.maxMessages));
  }

  prune(messages: readonly AgentMessage[]): AgentMessage[] {
    const { system, rest } = splitSystem(messages);
    return [...system, ...ensureStartsWithUser(safeWindow(rest, this.maxMessages))];
  }
}

/**
 * Keep the first user message (the original goal) plus the last N messages.
 * Closer to what long-running coding harnesses do with a pinned brief.
 */
export class PinnedContextPolicy implements ContextPolicy {
  readonly name: string;

  constructor(readonly maxMessages = 40) {
    this.name = `pinned:${maxMessages}`;
  }

  private pick<T extends { role: string }>(messages: readonly T[]): T[] {
    const firstUser = messages.find((message) => message.role === "user");
    const tail = safeWindow(messages, this.maxMessages);
    if (!firstUser || tail.includes(firstUser)) return ensureStartsWithUser(tail);
    return ensureStartsWithUser([firstUser, ...tail]);
  }

  select(events: readonly SessionEvent[]): Message[] {
    return this.pick(selectAll(events));
  }

  prune(messages: readonly AgentMessage[]): AgentMessage[] {
    const { system, rest } = splitSystem(messages);
    return [...system, ...this.pick(rest)];
  }
}
