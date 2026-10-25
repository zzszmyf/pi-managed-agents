import assert from "node:assert/strict";
import { mkdtemp, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { messageEvents } from "../src/session/events.js";
import { FileSessionStore, InMemorySessionStore } from "../src/session/store.js";

test("in-memory session appends are ordered and queryable", async () => {
  const store = new InMemorySessionStore();
  const session = await store.createSession({ sessionId: "sess_test" });
  assert.equal(session.sessionId, "sess_test");

  await store.append("sess_test", "message", {
    message: { role: "user", content: "first", timestamp: 1 },
  });
  await store.append("sess_test", "message", {
    message: fauxAssistantMessage([fauxText("second")]),
  });
  await store.append("sess_test", "run_started", {
    runId: "run_1",
    harnessId: "h1",
    resumed: false,
  });

  const all = await store.read("sess_test");
  assert.deepEqual(
    all.map((event) => event.seq),
    [1, 2, 3, 4],
  );
  const tail = await store.read("sess_test", { fromSeq: 3 });
  assert.deepEqual(
    tail.map((event) => event.type),
    ["message", "run_started"],
  );
  const messages = await store.read("sess_test", { types: ["message"], limit: 1 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.type, "message");
});

test("file session survives reopening and ignores a truncated final line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-session-test-"));
  try {
    const store = new FileSessionStore(root);
    await store.createSession({ sessionId: "sess_file" });
    await store.append("sess_file", "message", {
      message: { role: "user", content: "hello", timestamp: 1 },
    });
    await appendFile(path.join(root, "sess_file", "events.jsonl"), '{"seq":99,"broken"', "utf8");

    const reopened = new FileSessionStore(root);
    const events = await reopened.read("sess_file");
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2],
    );
    const listed = await reopened.listSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.sessionId, "sess_file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("messageEvents keeps normal messages and drops error assistant messages", async () => {
  const store = new InMemorySessionStore();
  await store.createSession({ sessionId: "sess_messages" });
  await store.append("sess_messages", "message", {
    message: { role: "user", content: "hi", timestamp: 1 },
  });
  await store.append("sess_messages", "message", {
    message: fauxAssistantMessage([fauxText("")], {
      stopReason: "error",
      errorMessage: "boom",
    }),
  });
  await store.append("sess_messages", "message", {
    message: fauxAssistantMessage([fauxText("ok")]),
  });
  const events = await store.read("sess_messages");
  const messages = messageEvents(events);
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant"],
  );
});
