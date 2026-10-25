import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Vault } from "./vault.js";

export interface McpUpstream {
  /** Name used in the proxy path: /mcp/<name>/... */
  name: string;
  /** Base URL of the real MCP server. */
  url: string;
  /** Vault key holding the real credential. */
  secretKey: string;
  /** Header used to carry the credential. Default: authorization. */
  authHeader?: string;
  /** Prefix for the credential. Default: "Bearer ". */
  authPrefix?: string;
}

export interface McpProxyOptions {
  vault: Vault;
  upstreams: McpUpstream[];
  /** How long a session token stays valid. Default: 1 hour. */
  tokenTtlMs?: number;
  requestTimeoutMs?: number;
}

interface SessionGrant {
  sessionId: string;
  allowed: Set<string> | undefined;
  expiresAt: number;
}

/**
 * A session-scoped MCP proxy.
 *
 * The sandbox gets `MCP_PROXY_URL` and `MCP_SESSION_TOKEN`. It never gets the
 * real credential. The proxy resolves the token to a session, looks up the
 * vault entry for the target upstream, and injects the real auth header.
 * The harness never sees credentials either.
 */
export class McpProxy {
  private readonly vault: Vault;
  private readonly upstreams: Map<string, McpUpstream>;
  private readonly grants = new Map<string, SessionGrant>();
  private readonly tokenTtlMs: number;
  private readonly requestTimeoutMs: number;
  private server?: http.Server;

  constructor(options: McpProxyOptions) {
    this.vault = options.vault;
    this.upstreams = new Map(options.upstreams.map((upstream) => [upstream.name, upstream]));
    this.tokenTtlMs = options.tokenTtlMs ?? 60 * 60 * 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async start(port = 0): Promise<string> {
    if (this.server) throw new Error("MCP proxy is already running");
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    return this.url;
  }

  get url(): string {
    if (!this.server) throw new Error("MCP proxy is not running");
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  issueSessionToken(sessionId: string, allowedUpstreams?: string[]): string {
    const token = `mcp_${randomUUID()}_${randomBytes(24).toString("base64url")}`;
    this.grants.set(token, {
      sessionId,
      allowed: allowedUpstreams ? new Set(allowedUpstreams) : undefined,
      expiresAt: Date.now() + this.tokenTtlMs,
    });
    return token;
  }

  revokeSessionToken(token: string): void {
    this.grants.delete(token);
  }

  private grantFor(request: http.IncomingMessage): SessionGrant | undefined {
    const auth = request.headers.authorization;
    const headerToken = request.headers["x-session-token"];
    const token = auth?.startsWith("Bearer ")
      ? auth.slice("Bearer ".length)
      : Array.isArray(headerToken)
        ? headerToken[0]
        : headerToken;
    if (!token) return undefined;
    const grant = this.grants.get(token);
    if (!grant) return undefined;
    if (grant.expiresAt < Date.now()) {
      this.grants.delete(token);
      return undefined;
    }
    return grant;
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const grant = this.grantFor(request);
      if (!grant) {
        this.sendJson(response, 401, { error: "missing or invalid session token" });
        return;
      }

      const url = new URL(request.url ?? "/", "http://proxy.local");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "mcp" || !parts[1]) {
        this.sendJson(response, 404, { error: "expected /mcp/<upstream>/<path>" });
        return;
      }
      const upstreamName = parts[1]!;
      const upstream = this.upstreams.get(upstreamName);
      if (!upstream) {
        this.sendJson(response, 404, { error: `unknown upstream: ${upstreamName}` });
        return;
      }
      if (grant.allowed && !grant.allowed.has(upstreamName)) {
        this.sendJson(response, 403, { error: `session is not allowed to use ${upstreamName}` });
        return;
      }

      const secret = this.vault.require(upstream.secretKey);
      const targetPath = `/${parts.slice(2).join("/")}${url.search}`;
      const target = new URL(targetPath, upstream.url);

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        if (["host", "authorization", "x-session-token", "content-length", "connection"].includes(key)) {
          continue;
        }
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
      headers[upstream.authHeader ?? "authorization"] = `${upstream.authPrefix ?? "Bearer "}${secret}`;

      const body = await readBody(request);
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers,
        body: body.length > 0 ? body : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });

      const responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
      response.statusCode = upstreamResponse.status;
      response.setHeader(
        "content-type",
        upstreamResponse.headers.get("content-type") ?? "application/octet-stream",
      );
      response.setHeader("content-length", responseBody.length);
      response.end(responseBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendJson(response, 502, { error: `proxy error: ${message}` });
    }
  }

  private sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload));
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.setHeader("content-length", body.length);
    response.end(body);
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = undefined;
    this.grants.clear();
  }
}

async function readBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
