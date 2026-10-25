import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalSandbox } from "../src/sandbox/local.js";
import {
  handsForClaudeTools,
  normalizeHands,
  PolicySandbox,
} from "../src/sandbox/policy.js";
import { SandboxExecutionError } from "../src/sandbox/sandbox.js";

test("normalizeHands handles all, bypass and explicit lists", () => {
  assert.deepEqual(normalizeHands(undefined), [
    "bash",
    "read_file",
    "write_file",
    "list_files",
  ]);
  assert.deepEqual(normalizeHands(["bypass"]), [
    "bash",
    "read_file",
    "write_file",
    "list_files",
  ]);
  assert.deepEqual(normalizeHands(["read_file", "read_file", "list_files"]), [
    "read_file",
    "list_files",
  ]);
});

test("Claude tool names map to conservative hands", () => {
  assert.deepEqual(handsForClaudeTools("Read Grep Glob"), ["read_file", "list_files"]);
  assert.deepEqual(handsForClaudeTools("Bash Read"), ["bash", "read_file", "list_files"]);
  assert.deepEqual(handsForClaudeTools("bypass"), [
    "bash",
    "read_file",
    "write_file",
    "list_files",
  ]);
  assert.deepEqual(handsForClaudeTools(""), ["read_file", "list_files"]);
});

test("PolicySandbox rejects hands outside the allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-policy-test-"));
  const inner = new LocalSandbox({ rootDir: root });
  await inner.provision();
  await writeFile(path.join(root, "note.txt"), "hello", "utf8");
  const policy = new PolicySandbox(inner, ["read_file", "list_files"]);

  try {
    assert.equal(await policy.execute("read_file", { path: "note.txt" }), "hello");
    assert.match(await policy.execute("list_files", { path: "." }), /note\.txt/);
    await assert.rejects(
      policy.execute("bash", { command: "cat note.txt" }),
      SandboxExecutionError,
    );
    await assert.rejects(
      policy.execute("write_file", { path: "x.txt", content: "x" }),
      SandboxExecutionError,
    );
  } finally {
    await policy.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("LocalSandbox does not delete a caller-owned root by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-owned-root-"));
  await writeFile(path.join(root, "keep.txt"), "keep", "utf8");
  const sandbox = new LocalSandbox({ rootDir: root });
  await sandbox.provision();
  await sandbox.destroy();
  assert.equal(await readFile(path.join(root, "keep.txt"), "utf8"), "keep");
  await rm(root, { recursive: true, force: true });
});
