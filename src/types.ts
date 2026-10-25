/**
 * Shared types used across the session, sandbox, harness and credential layers.
 */

/** Resource description passed to a sandbox at provision time. */
export interface SandboxResources {
  /** Optional git repository the sandbox should be initialized with. */
  repoUrl?: string;
  /** Extra environment variables. Never put long-lived credentials here. */
  env?: Record<string, string>;
  /** Free-form labels for observability. */
  labels?: Record<string, string>;
}

export type RunStatus = "completed" | "error" | "aborted" | "already_complete";

export interface RunResult {
  sessionId: string;
  runId: string;
  status: RunStatus;
  /** Concatenated text of the last assistant message, when there is one. */
  finalMessage?: string;
  /** Milliseconds from run start to the first streamed text token. */
  firstTokenMs?: number;
}

/** A single message block returned by a hand. The interface is intentionally string-only. */
export type HandResult = string;
