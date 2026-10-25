/**
 * Demonstrates the credential boundary from the article:
 *
 *   - the real token lives in a host-side vault
 *   - the sandbox receives only a session-scoped proxy token
 *   - the MCP proxy injects the real credential upstream
 *   - inspecting the sandbox's env and files finds no real token
 *
 * Run: npm run demo:security
 */
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { McpProxy } from "../src/credentials/mcp-proxy.js";
import { Vault } from "../src/credentials/vault.js";
import { Harness } from "../src/harness/harness.js";
import { createFauxRuntime } from "../src/model/faux.js";
import { LocalSandbox } from "../src/sandbox/local.js";
import { FactorySandboxProvider, SandboxRuntime } from "../src/sandbox/runtime.js";
import { InMemorySessionStore } from "../src/session/store.js";

const REAL_SECRET = "demo-mcp-secret-value";
const vault = new Vault();
vault.put("mcp/demo", REAL_SECRET);

let upstreamSawCorrectAuth = false;
const upstream = http.createServer((request, response) => {
  const authorized = request.headers.authorization === `Bearer ${REAL_SECRET}`;
  upstreamSawCorrectAuth ||= authorized;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      ok: authorized,
      tool: "echo",
      query: new URL(request.url ?? "/", "http://upstream").searchParams.get("q"),
    }),
  );
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
const upstreamPort = (upstream.address() as AddressInfo).port;

const proxy = new McpProxy({
  vault,
  upstreams: [{ name: "demo", url: `http://127.0.0.1:${upstreamPort}`, secretKey: "mcp/demo" }],
});
const proxyUrl = await proxy.start();
const sessionToken = proxy.issueSessionToken("demo-session", ["demo"]);

console.log("== credentials ==");
console.log(`vault keys: ${vault.keys().join(", ")}`);
console.log(`real secret length: ${REAL_SECRET.length}`);
console.log(`sandbox gets: MCP_PROXY_URL + a ${sessionToken.length}-char session token`);
console.log(`proxy redacts real secret as: ${vault.redact(`token=${REAL_SECRET}`)}`);

const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-managed-security-"));
const store = new InMemorySessionStore();
const session = await store.createSession();

const sandbox = new SandboxRuntime({
  provider: new FactorySandboxProvider(
    () =>
      new LocalSandbox({
        rootDir: path.join(workDir, "workspace"),
        env: {
          MCP_PROXY_URL: proxyUrl,
          MCP_SESSION_TOKEN: sessionToken,
        },
      }),
  ),
});

const model = createFauxRuntime([
  fauxAssistantMessage(
    [
      fauxToolCall("execute", {
        name: "bash",
        input: {
          command:
            'curl -s -H "Authorization: Bearer $MCP_SESSION_TOKEN" "$MCP_PROXY_URL/mcp/demo/echo?q=hello"',
        },
      }),
    ],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage([
    fauxText("The proxy call succeeded; the sandbox never held the real credential."),
  ]),
]);

const harness = new Harness({
  sessionStore: store,
  sandbox,
  model: model.model,
  streamFn: model.streamFn,
});

const result = await harness.run(session.sessionId, "call the demo MCP tool through the proxy");
console.log("\n== model result ==");
console.log(result.finalMessage);

console.log("\n== proxy audit ==");
console.log(`upstream saw the real credential: ${upstreamSawCorrectAuth}`);

console.log("\n== what the sandbox can see ==");
console.log(await sandbox.execute("bash", { command: "env | grep '^MCP_' | sort" }));

let leakFound = false;
try {
  await sandbox.execute("bash", {
    command: `grep -R ${JSON.stringify(REAL_SECRET)} . 2>/dev/null`,
  });
  leakFound = true;
} catch {
  leakFound = false;
}
console.log(`real secret found in sandbox files: ${leakFound}`);

console.log("\n== request without a session token ==");
console.log(
  await sandbox.execute("bash", {
    command: `curl -s -o /dev/null -w "%{http_code}" "$MCP_PROXY_URL/mcp/demo/echo"`,
  }),
);

console.log("\n== session log contains the real secret ==");
const eventsJson = JSON.stringify(await store.read(session.sessionId));
console.log(vault.leaks(eventsJson));

await sandbox.destroy();
await proxy.close();
await new Promise<void>((resolve) => upstream.close(() => resolve()));
await rm(workDir, { recursive: true, force: true });
