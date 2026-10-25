import type { HandResult, SandboxResources } from "../types.js";

/**
 * A hand is anything the brain can act through.
 *
 * The harness only ever sees `execute(name, input) -> string`. It does not know
 * whether the sandbox is a local process, a container, a phone, or an emulator.
 */
export interface Sandbox {
  readonly id: string;
  provision(resources?: SandboxResources): Promise<void>;
  execute(name: string, input: Record<string, unknown>): Promise<HandResult>;
  destroy(): Promise<void>;
  isAlive(): boolean;
}

export interface SandboxProvider {
  provision(resources?: SandboxResources): Promise<Sandbox>;
}

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The sandbox itself is gone (container died, process killed, host lost). */
export class SandboxUnavailableError extends SandboxError {}

/** A command ran but failed, or the hand rejected its input. */
export class SandboxExecutionError extends SandboxError {
  constructor(
    message: string,
    readonly exitCode?: number,
    readonly stdout = "",
    readonly stderr = "",
  ) {
    super(message);
  }
}

export class UnknownHandError extends SandboxError {}

export const LOCAL_HANDS = ["bash", "read_file", "write_file", "list_files"] as const;
export type LocalHand = (typeof LOCAL_HANDS)[number];

export interface BashInput {
  command: string;
  /** Extra environment variables for this command only. Never put long-lived secrets here. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ReadFileInput {
  path: string;
  maxBytes?: number;
}

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface ListFilesInput {
  path?: string;
  depth?: number;
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new SandboxExecutionError(`Missing or invalid "${key}" (expected non-empty string)`);
  }
  return value;
}

export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new SandboxExecutionError(`Invalid "${key}" (expected a non-negative number)`);
  }
  return value;
}
