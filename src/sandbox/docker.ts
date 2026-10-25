import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { HandResult, SandboxResources } from "../types.js";
import {
  type BashInput,
  type ListFilesInput,
  type ReadFileInput,
  type Sandbox,
  SandboxExecutionError,
  SandboxUnavailableError,
  type WriteFileInput,
  requireString,
  optionalNumber,
} from "./sandbox.js";

const execFileAsync = promisify(execFile);

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface DockerSandboxOptions {
  image?: string;
  /** "none" isolates the network; "host" lets the container reach a local MCP proxy. */
  network?: "none" | "host";
  /** Environment baked into the container at create time. Keep secrets session-scoped. */
  env?: Record<string, string>;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  dockerBin?: string;
}

/**
 * A Docker-backed hand. The harness sees exactly the same
 * `execute(name, input) -> string` interface as LocalSandbox.
 *
 * This is what makes the "hands are interchangeable" claim concrete: swap the
 * provider, keep the brain.
 */
export class DockerSandbox implements Sandbox {
  readonly id: string;
  readonly containerName: string;
  readonly image: string;
  private started = false;
  private readonly network: "none" | "host";
  private readonly env: Record<string, string>;
  private readonly commandTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly dockerBin: string;

  constructor(options: DockerSandboxOptions = {}) {
    this.id = `sbx_${randomUUID()}`;
    this.containerName = `pi-managed-${randomUUID()}`;
    this.image = options.image ?? "alpine:3.20";
    this.network = options.network ?? "none";
    this.env = { ...(options.env ?? {}) };
    this.commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    this.dockerBin = options.dockerBin ?? "docker";
  }

  private async docker(args: string[], timeout = this.commandTimeoutMs): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync(this.dockerBin, args, {
        timeout,
        maxBuffer: this.maxOutputBytes,
      });
      return (stdout + stderr).trim();
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        code?: number | string;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const detail = (failure.stderr || failure.message || "").trim();
      if (/No such container|is not running/i.test(detail)) {
        throw new SandboxUnavailableError(`Sandbox container is gone: ${detail}`);
      }
      throw new SandboxExecutionError(
        `docker ${args[0]} failed${failure.killed ? " (timeout)" : ""}: ${detail}`,
        typeof failure.code === "number" ? failure.code : undefined,
        failure.stdout ?? "",
        failure.stderr ?? "",
      );
    }
  }

  async provision(_resources?: SandboxResources): Promise<void> {
    if (this.started) return;
    const args = ["run", "-d", "--name", this.containerName, "--network", this.network, "-w", "/workspace"];
    for (const [key, value] of Object.entries(this.env)) {
      args.push("-e", `${key}=${value}`);
    }
    args.push(this.image, "sleep", "infinity");
    const containerId = await this.docker(args, 120_000);
    if (!containerId) throw new SandboxUnavailableError("docker run returned no container id");
    this.started = true;
  }

  isAlive(): boolean {
    return this.started;
  }

  async destroy(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      await this.docker(["rm", "-f", this.containerName], 30_000);
    } catch {
      // Best effort. A missing container is already destroyed.
    }
  }

  async execute(name: string, input: Record<string, unknown>): Promise<HandResult> {
    if (!this.started) {
      throw new SandboxUnavailableError(`Sandbox ${this.id} is not provisioned`);
    }
    switch (name) {
      case "bash":
        return this.bash(input as unknown as BashInput);
      case "read_file":
        return this.readFile(input as unknown as ReadFileInput);
      case "write_file":
        return this.writeFile(input as unknown as WriteFileInput);
      case "list_files":
        return this.listFiles(input as unknown as ListFilesInput);
      default:
        throw new SandboxExecutionError(
          `Unknown hand "${name}". Available: bash, read_file, write_file, list_files`,
        );
    }
  }

  private async execShell(command: string, timeout = this.commandTimeoutMs): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync(
        this.dockerBin,
        ["exec", "-i", this.containerName, "sh", "-lc", command],
        { timeout, maxBuffer: this.maxOutputBytes },
      );
      const out = stdout.trimEnd();
      const err = stderr.trimEnd();
      if (out && err) return `${out}\n[stderr]\n${err}`;
      return out || err;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        code?: number | string;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const detail = (failure.stderr || failure.message || "").trim();
      if (/No such container|is not running/i.test(detail)) {
        throw new SandboxUnavailableError(`Sandbox container is gone: ${detail}`);
      }
      throw new SandboxExecutionError(
        `Sandbox command failed${failure.killed ? " (timeout)" : ""}: ${command}`,
        typeof failure.code === "number" ? failure.code : undefined,
        failure.stdout ?? "",
        failure.stderr ?? "",
      );
    }
  }

  private async bash(input: BashInput): Promise<string> {
    const command = requireString(input as unknown as Record<string, unknown>, "command");
    return this.execShell(command, input.timeoutMs ?? this.commandTimeoutMs);
  }

  private safeRelative(inputPath: string): string {
    if (inputPath.length === 0) throw new SandboxExecutionError("Path must not be empty");
    if (path.posix.isAbsolute(inputPath)) {
      throw new SandboxExecutionError("Absolute paths are not allowed; use a path relative to /workspace");
    }
    const normalized = path.posix.normalize(inputPath);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new SandboxExecutionError(`Path escapes the sandbox: ${inputPath}`);
    }
    return normalized;
  }

  private async readFile(input: ReadFileInput): Promise<string> {
    const target = this.safeRelative(requireString(input as unknown as Record<string, unknown>, "path"));
    return this.execShell(`cat ${shQuote(target)}`);
  }

  private async writeFile(input: WriteFileInput): Promise<string> {
    const record = input as unknown as Record<string, unknown>;
    const target = this.safeRelative(requireString(record, "path"));
    const content = requireString(record, "content");
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const dir = path.posix.dirname(target);
    const command = `mkdir -p ${shQuote(dir)} && printf %s ${shQuote(encoded)} | base64 -d > ${shQuote(target)}`;
    await this.execShell(command);
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${target}`;
  }

  private async listFiles(input: ListFilesInput): Promise<string> {
    const start = this.safeRelative(input.path ?? ".");
    const depth = Math.min(optionalNumber(input as unknown as Record<string, unknown>, "depth") ?? 2, 5);
    return this.execShell(
      `find ${shQuote(start)} -maxdepth ${depth} -print | sed 's|^\\./||' | sort`,
    );
  }
}
