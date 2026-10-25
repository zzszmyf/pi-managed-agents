import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
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
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

export interface LocalSandboxOptions {
  /** Directory that acts as the sandbox root. Defaults to a temp directory. */
  rootDir?: string;
  /** Simulated provisioning latency, useful for TTFT experiments. */
  provisionDelayMs?: number;
  /** Per-command timeout. Default 30s. */
  commandTimeoutMs?: number;
  /** Environment available to every command. Keep this free of long-lived secrets. */
  env?: Record<string, string>;
  maxOutputBytes?: number;
}

/**
 * A local process sandbox.
 *
 * This is a development shim that makes the architecture runnable without
 * Docker. It is NOT a security boundary: `bash` runs on the host. Use
 * DockerSandbox (or a real remote sandbox) when the code is untrusted.
 */
export class LocalSandbox implements Sandbox {
  readonly id: string;
  readonly rootDir: string;
  private alive = false;
  private readonly provisionDelayMs: number;
  private readonly commandTimeoutMs: number;
  private readonly baseEnv: Record<string, string>;
  private readonly maxOutputBytes: number;

  constructor(options: LocalSandboxOptions = {}) {
    this.id = `sbx_${randomUUID()}`;
    this.rootDir =
      options.rootDir ?? path.join(os.tmpdir(), "pi-managed-agents", this.id);
    this.provisionDelayMs = options.provisionDelayMs ?? 0;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.baseEnv = { ...(options.env ?? {}) };
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  async provision(_resources?: SandboxResources): Promise<void> {
    if (this.alive) return;
    await fs.mkdir(this.rootDir, { recursive: true });
    if (this.provisionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.provisionDelayMs));
    }
    this.alive = true;
  }

  isAlive(): boolean {
    return this.alive;
  }

  async destroy(): Promise<void> {
    this.alive = false;
    await fs.rm(this.rootDir, { recursive: true, force: true });
  }

  async execute(name: string, input: Record<string, unknown>): Promise<HandResult> {
    if (!this.alive) {
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

  private async bash(input: BashInput): Promise<string> {
    const command = requireString(input as unknown as Record<string, unknown>, "command");
    const timeout = input.timeoutMs ?? this.commandTimeoutMs;
    const extraEnv: Record<string, string> = {};
    if (input.env) {
      for (const [key, value] of Object.entries(input.env)) {
        if (typeof value !== "string") {
          throw new SandboxExecutionError(`Invalid env value for ${key}`);
        }
        extraEnv[key] = value;
      }
    }
    // Deliberately do not inherit process.env: that is how API keys leak into
    // a sandbox. Only PATH, HOME, LANG and explicit sandbox env are passed.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: this.rootDir,
      LANG: process.env.LANG ?? "C.UTF-8",
      TERM: "dumb",
      ...this.baseEnv,
      ...extraEnv,
    };
    try {
      const { stdout, stderr } = await execFileAsync("/bin/bash", ["-lc", command], {
        cwd: this.rootDir,
        env,
        timeout,
        maxBuffer: this.maxOutputBytes,
      });
      return this.combineOutput(stdout, stderr);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        code?: number | string;
        killed?: boolean;
        signal?: string;
        stdout?: string;
        stderr?: string;
      };
      if (failure.killed) {
        throw new SandboxExecutionError(
          `Command timed out after ${timeout}ms: ${command}`,
          undefined,
          failure.stdout ?? "",
          failure.stderr ?? "",
        );
      }
      const exitCode = typeof failure.code === "number" ? failure.code : undefined;
      throw new SandboxExecutionError(
        `Command failed${exitCode !== undefined ? ` with exit code ${exitCode}` : ""}: ${command}`,
        exitCode,
        failure.stdout ?? "",
        failure.stderr ?? failure.message,
      );
    }
  }

  private combineOutput(stdout: string, stderr: string): string {
    const trimmedOut = stdout.trimEnd();
    const trimmedErr = stderr.trimEnd();
    if (trimmedOut && trimmedErr) return `${trimmedOut}\n[stderr]\n${trimmedErr}`;
    return trimmedOut || trimmedErr;
  }

  private async safePath(inputPath: string): Promise<string> {
    if (inputPath.length === 0) {
      throw new SandboxExecutionError("Path must not be empty");
    }
    if (path.isAbsolute(inputPath)) {
      throw new SandboxExecutionError("Absolute paths are not allowed; use a path relative to the sandbox root");
    }
    const resolved = path.resolve(this.rootDir, inputPath);
    const relative = path.relative(this.rootDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new SandboxExecutionError(`Path escapes the sandbox: ${inputPath}`);
    }
    const realRoot = await fs.realpath(this.rootDir);
    let realResolved: string;
    try {
      realResolved = await fs.realpath(resolved);
    } catch {
      realResolved = resolved;
    }
    const realRelative = path.relative(realRoot, realResolved);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new SandboxExecutionError(`Path escapes the sandbox via a symlink: ${inputPath}`);
    }
    return resolved;
  }

  private async readFile(input: ReadFileInput): Promise<string> {
    const target = await this.safePath(requireString(input as unknown as Record<string, unknown>, "path"));
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new SandboxExecutionError(`Not a file: ${input.path}`);
    if (stat.size > maxBytes) {
      throw new SandboxExecutionError(
        `File is ${stat.size} bytes, larger than the ${maxBytes} byte limit`,
      );
    }
    return fs.readFile(target, "utf8");
  }

  private async writeFile(input: WriteFileInput): Promise<string> {
    const record = input as unknown as Record<string, unknown>;
    const target = await this.safePath(requireString(record, "path"));
    const content = requireString(record, "content");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${input.path}`;
  }

  private async listFiles(input: ListFilesInput): Promise<string> {
    const start = input.path ?? ".";
    const root = await this.safePath(start);
    const maxDepth = Math.min(optionalNumber(input as unknown as Record<string, unknown>, "depth") ?? 2, 5);
    const entries: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (entries.length >= 1000) return;
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        const full = path.join(dir, dirent.name);
        const relative = path.relative(this.rootDir, full) || ".";
        entries.push(dirent.isDirectory() ? `${relative}/` : relative);
        if (dirent.isDirectory() && depth < maxDepth) {
          await walk(full, depth + 1);
        }
      }
    };
    await walk(root, 0);
    return entries.join("\n");
  }
}
