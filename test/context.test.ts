import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { FullContextPolicy, PinnedContextPolicy, WindowContextPolicy } from "../src/session/context.js";
import { InMemorySessionStore } from "../src/session/store.js";
import { messageEvents } from "../src/session/events.js";

test("window policy never starts with an orphan tool result", async () => {
  const store = new InMemorySessionStore();
  await store.createSession({ sessionId: "sess_window" });
  await store.append("sess_window", "message", {
    message: { role: "user", content: "start", timestamp: 1 },
  });
  await store.append("sess_window", "message", {
    message: fauxAssistantMessage(
      [fauxToolCall("execute", { name: "bash", input: { command: "echo hi" } })],
      { stopReason: "toolUse" },
    ),
  });
  const assistant = messageEvents(await store.read("sess_window"))[1]!;
  const call = assistant.role === "assistant"
    ? assistant.content.find((block) => block.type === "toolCall")
    : undefined;
  assert.ok(call);
  await store.append("sess_window", "message", {
    message: {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "hi" }],
      isError: false,
      timestamp: 3,
    },
  });
  await store.append("sess_window", "message", {
    message: fauxAssistantMessage([fauxText("done")]),
  });

  const policy = new WindowContextPolicy(2);
  const selected = policy.select(await store.read("sess_window"));
  assert.equal(selected[0]!.role, "user");
  assert.ok(selected.some((message) => message.role === "toolResult"));
});

test("full policy keeps everything; pinned policy keeps the original goal", async () => {
  const store = new InMemorySessionStore();
  await store.createSession({ sessionId: "sess_policies" });
  await store.append("sess_policies", "message", {
    message: { role: "user", content: "original goal", timestamp: 1 },
  });
  for (let index = 0; index < 6; index += 1) {
    await store.append("sess_policies", "message", {
      message: fauxAssistantMessage([fauxText(`reply ${index}`)]),
    });
  }
  const events = await store.read("sess_policies");

  const full = new FullContextPolicy().select(events);
  assert.equal(full.length, 7);

  const pinned = new PinnedContextPolicy(2).select(events);
  assert.equal(pinned[0]!.role, "user");
  assert.equal(
    pinned[0]!.content,
    "original goal",
  );
  assert.ok(pinned.length <= 3);
});

test("prune preserves system messages and limits non-system messages", () => {
  const system: AgentMessage = {
    role: "system",
    content: "system prompt",
    timestamp: 0,
  };
  const messages: AgentMessage[] = [system];
  for (let index = 0; index < 10; index += 1) {
    messages.push({ role: "user", content: `m${index}`, timestamp: index + 1 });
    messages.push(fauxAssistantMessage([fauxText(`a${index}`)]));
  }
  const pruned = new WindowContextPolicy(4).prune(messages);
  assert.equal(pruned[0]!.role, "system");
  assert.ok(pruned.filter((message) => message.role !== "system").length <= 4);
});
