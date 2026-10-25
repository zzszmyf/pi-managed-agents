import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { McpProxy } from "../src/credentials/mcp-proxy.js";
import { Vault } from "../src/credentials/vault.js";
import { provisionGitRepo, sanitizeRemoteUrl } from "../src/credentials/git.js";
import { LocalSandbox } from "../src/sandbox/local.js";

const execFileAsync = promisify(execFile);
const REAL_SECRET = "test-mcp-secret-value";

test("vault redacts and detects secrets", () => {
  const vault = new Vault();
  vault.put("token", REAL_SECRET);
  assert.equal(vault.redact(`x ${REAL_SECRET} y`), "x [REDACTED:token] y");
  assert.equal(vault.leaks(`prefix ${REAL_SECRET}`), true);
  assert.equal(vault.leaks("nothing here"), false);
});

test("MCP proxy injects the vaulted credential and rejects missing tokens", async () => {
  let seenAuthorization: string | undefined;
  const upstream = http.createServer((request, response) => {
    seenAuthorization = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const port = (upstream.address() as AddressInfo).port;

  const vault = new Vault();
  vault.put("mcp/demo", REAL_SECRET);
  const proxy = new McpProxy({
    vault,
    upstreams: [{ name: "demo", url: `http://127.0.0.1:${port}`, secretKey: "mcp/demo" }],
  });
  const proxyUrl = await proxy.start();
  const token = proxy.issueSessionToken("s1", ["demo"]);
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-test-"));
  const sandbox = new LocalSandbox({ rootDir: root, env: { PROXY_URL: proxyUrl, PROXY_TOKEN: token } });

  try {
    await sandbox.provision();
    const authorized = await sandbox.execute("bash", {
      command: 'curl -s -H "Authorization: Bearer $PROXY_TOKEN" "$PROXY_URL/mcp/demo/echo"',
    });
    assert.match(authorized, /"ok":true/);
    assert.equal(seenAuthorization, `Bearer ${REAL_SECRET}`);

    const unauthorized = await sandbox.execute("bash", {
      command: 'curl -s -o /dev/null -w "%{http_code}" "$PROXY_URL/mcp/demo/echo"',
    });
    assert.equal(unauthorized, "401");

    const envOutput = await sandbox.execute("bash", { command: "env | sort" });
    assert.doesNotMatch(envOutput, new RegExp(REAL_SECRET));
    assert.match(envOutput, /PROXY_TOKEN=/);
  } finally {
    await sandbox.destroy();
    await proxy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("git provisioning keeps the token out of .git/config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-git-test-"));
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  try {
    await execFileAsync("git", ["init", source]);
    await execFileAsync("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", source, "config", "user.name", "Test"]);
    await writeFile(path.join(source, "README.md"), "hello\n", "utf8");
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", ["-C", source, "commit", "-m", "init"]);

    const result = await provisionGitRepo({
      repoUrl: `file://${source}`,
      targetDir: target,
      token: "fake-token",
    });
    assert.equal(result.usedToken, true);
    assert.equal(result.remoteUrl, `file://${source}`);
    const config = await readFile(path.join(target, ".git", "config"), "utf8");
    assert.doesNotMatch(config, /fake-token/);
    assert.match(config, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sanitizeRemoteUrl strips userinfo", () => {
  assert.equal(
    sanitizeRemoteUrl("https://user:token@github.com/org/repo.git"),
    "https://github.com/org/repo.git",
  );
});
