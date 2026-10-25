import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const SHIM = path.resolve("src/bridge/claude-shim.ts");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runShim(
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SHIM, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`shim timed out; stderr=${stderr}`));
    }, 20_000);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input, "utf8");
  });
}

function parseLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("shim emits Claude stream-json and resumes the same session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-shim-test-"));
  const systemPrompt = path.join(root, "system.txt");
  const sessions = path.join(root, "sessions");
  await writeFile(systemPrompt, "bridge system prompt\n", "utf8");
  const env = {
    PI_BRIDGE_AGENT: "pi",
    PI_BRIDGE_PROVIDER: "faux",
    PI_BRIDGE_SESSIONS_DIR: sessions,
  };
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt-file",
    systemPrompt,
  ];

  try {
    const first = await runShim(args, "hello bridge\n", env);
    assert.equal(first.code, 0, first.stderr);
    const firstLines = parseLines(first.stdout);
    assert.equal(firstLines[0]!.type, "system");
    assert.equal(firstLines[0]!.subtype, "init");
    const sessionId = firstLines[0]!.session_id as string;
    assert.match(sessionId, /^bridge_/);
    assert.ok(firstLines.some((line) => line.type === "assistant"));
    const firstResult = firstLines.at(-1)!;
    assert.equal(firstResult.type, "result");
    assert.equal(firstResult.session_id, sessionId);

    const second = await runShim(
      [...args, "--resume", sessionId],
      "again\n",
      env,
    );
    assert.equal(second.code, 0, second.stderr);
    const secondLines = parseLines(second.stdout);
    assert.equal(secondLines.at(-1)!.session_id, sessionId);
    const text = secondLines
      .filter((line) => line.type === "assistant")
      .flatMap((line) => (line.message as { content: Array<{ text?: string }> }).content)
      .map((block) => block.text ?? "")
      .join("");
    assert.match(text, /\[faux bridge\] again/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shim delegates to the real claude binary when not opted in", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-shim-delegate-"));
  const fake = path.join(root, "fake-claude.sh");
  await writeFile(fake, "#!/usr/bin/env bash\necho real-claude \"$@\"\n", "utf8");
  await chmod(fake, 0o755);
  try {
    const result = await runShim(["--version"], "", {
      PI_REAL_CLAUDE_BIN: fake,
      PI_BRIDGE_AGENT: "",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /real-claude --version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
