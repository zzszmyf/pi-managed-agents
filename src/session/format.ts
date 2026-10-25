import type { SessionEvent } from "./events.js";

function contentPreview(content: unknown, limit = 200): string {
  if (typeof content === "string") return content.slice(0, limit);
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: unknown }).text)
          : JSON.stringify(block),
      )
      .join(" ")
      .slice(0, limit);
  }
  return String(content).slice(0, limit);
}

/** One compact line per event, for CLI output and demos. */
export function formatEvent(event: SessionEvent): string {
  const prefix = `[${String(event.seq).padStart(3, "0")}] ${event.type}`;
  switch (event.type) {
    case "message": {
      const message = event.data.message;
      if (message.role === "user") {
        return `${prefix} user: ${contentPreview(message.content)}`;
      }
      if (message.role === "assistant") {
        const calls = message.content
          .filter((block) => block.type === "toolCall")
          .map((block) => `${block.name}(${JSON.stringify(block.arguments)})`);
        const text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(" ");
        return `${prefix} assistant: ${[text, ...calls].filter(Boolean).join(" | ")}`;
      }
      if (message.role === "toolResult") {
        return `${prefix} toolResult(${message.toolName}): ${contentPreview(message.content)}`;
      }
      return prefix;
    }
    case "tool_started":
      return `${prefix} ${event.data.toolName} ${JSON.stringify(event.data.args)}`;
    case "tool_finished":
      return `${prefix} ${event.data.toolName} ${event.data.isError ? "ERROR" : "ok"} ${event.data.result.slice(0, 160)}`;
    case "run_started":
      return `${prefix} run=${event.data.runId} resumed=${event.data.resumed}`;
    case "run_finished":
      return `${prefix} run=${event.data.runId} status=${event.data.status}`;
    case "run_error":
      return `${prefix} run=${event.data.runId} ${event.data.error}`;
    case "sandbox_provisioned":
      return `${prefix} sandbox=${event.data.sandboxId}`;
    case "sandbox_failed":
      return `${prefix} sandbox=${event.data.sandboxId} ${event.data.error}`;
    case "session_created":
      return `${prefix} session=${event.data.meta.sessionId}`;
    default:
      return prefix;
  }
}

export function formatEventLog(events: readonly SessionEvent[]): string {
  return events.map(formatEvent).join("\n");
}
