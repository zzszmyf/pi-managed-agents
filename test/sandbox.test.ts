import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalSandbox } from "../src/sandbox/local.js";
import {
  SandboxExecutionError,
  SandboxUnavailableError,
  type Sandbox,
} from "../src/sandbox/sandbox.js";
import { FactorySandboxProvider, SandboxRuntime } from "../src/sandbox/runtime.js";

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "pi-sandbox-test-"));
}

test("local sandbox runs hands inside its root", async () => {
  const root = await tempRoot();
  const sandbox = new LocalSandbox({ rootDir: root });
  try {
    await sandbox.provision();
    const write = await sandbox.execute("write_file", { path: "a/b.txt", content: "hello" });
    assert.match(write, /Wrote 5 bytes/);
    assert.equal(await sandbox.execute("read_file", { path: "a/b.txt" }), "hello");
    assert.match(await sandbox.execute("bash", { command: "cat a/b.txt" }), /hello/);
    assert.match(await sandbox.execute("list_files", { path: "." }), /a\/b\.txt/);
  } finally {
    await sandbox.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("local sandbox rejects paths outside its root", async () => {
  const root = await tempRoot();
  const sandbox = new LocalSandbox({ rootDir: root });
  try {
    await sandbox.provision();
    await assert.rejects(
      sandbox.execute("read_file", { path: "../etc/passwd" }),
      SandboxExecutionError,
    );
    await assert.rejects(
      sandbox.execute("write_file", { path: "/tmp/escape.txt", content: "x" }),
      SandboxExecutionError,
    );
  } finally {
    await sandbox.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("local sandbox does not inherit host environment secrets", async () => {
  const root = await tempRoot();
  const previous = process.env.PI_HOST_SECRET;
  process.env.PI_HOST_SECRET = "host-only-value";
  const sandbox = new LocalSandbox({ rootDir: root, env: { SANDBOX_VALUE: "ok" } });
  try {
    await sandbox.provision();
    const output = await sandbox.execute("bash", { command: "env | sort" });
    assert.match(output, /SANDBOX_VALUE=ok/);
    assert.doesNotMatch(output, /host-only-value/);
  } finally {
    if (previous === undefined) delete process.env.PI_HOST_SECRET;
    else process.env.PI_HOST_SECRET = previous;
    await sandbox.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox runtime is lazy and provisions once", async () => {
  const root = await tempRoot();
  let provisions = 0;
  const runtime = new SandboxRuntime({
    provider: new FactorySandboxProvider(() => {
      provisions += 1;
      return new LocalSandbox({ rootDir: root });
    }),
  });
  try {
    assert.equal(provisions, 0);
    assert.equal(await runtime.execute("bash", { command: "echo hi" }), "hi");
    assert.equal(provisions, 1);
    await runtime.execute("bash", { command: "echo again" });
    assert.equal(provisions, 1);
  } finally {
    await runtime.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

class DyingSandbox implements Sandbox {
  readonly id = "dying";
  private readonly inner: LocalSandbox;
  private calls = 0;

  constructor(root: string) {
    this.inner = new LocalSandbox({ rootDir: root });
  }

  async provision(): Promise<void> {
    await this.inner.provision();
  }

  async execute(name: string, input: Record<string, unknown>): Promise<string> {
    this.calls += 1;
    if (this.calls === 1) throw new SandboxUnavailableError("simulated container death");
    return this.inner.execute(name, input);
  }

  async destroy(): Promise<void> {
    await this.inner.destroy();
  }

  isAlive(): boolean {
    return true;
  }
}

test("a lost sandbox becomes a tool error and the next call gets a new one", async () => {
  const root = await tempRoot();
  let provisions = 0;
  const runtime = new SandboxRuntime({
    provider: new FactorySandboxProvider(() => {
      provisions += 1;
      if (provisions === 1) return new DyingSandbox(root);
      return new LocalSandbox({ rootDir: root });
    }),
  });
  try {
    await assert.rejects(
      runtime.execute("bash", { command: "echo first" }),
      /was lost during "bash"/,
    );
    assert.equal(provisions, 1);
    assert.equal(await runtime.execute("bash", { command: "echo second" }), "second");
    assert.equal(provisions, 2);
  } finally {
    await runtime.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
