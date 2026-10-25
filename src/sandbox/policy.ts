import type { HandResult, SandboxResources } from "../types.js";
import { type Sandbox, SandboxExecutionError } from "./sandbox.js";

export const ALL_HANDS = ["bash", "read_file", "write_file", "list_files"] as const;
export type HandName = (typeof ALL_HANDS)[number];

export function normalizeHands(hands: readonly string[] | undefined): HandName[] {
  if (!hands || hands.length === 0) return [...ALL_HANDS];
  const selected: HandName[] = [];
  for (const hand of hands) {
    const normalized = hand.trim();
    if (normalized === "*" || normalized === "all" || normalized === "bypass") {
      return [...ALL_HANDS];
    }
    if ((ALL_HANDS as readonly string[]).includes(normalized)) {
      if (!selected.includes(normalized as HandName)) selected.push(normalized as HandName);
    }
  }
  return selected;
}

/**
 * Map the tool names used by the existing cron jobs to sandbox hands.
 *
 * Bash is a broad capability: once allowed, a command can read and write
 * anywhere in the sandbox. The mapping is intentionally conservative for
 * read-only jobs.
 */
export function handsForClaudeTools(tools: string | undefined): HandName[] {
  if (!tools || tools.trim().length === 0) return ["read_file", "list_files"];
  const tokens = tools.split(/[\s,]+/).filter(Boolean);
  if (tokens.includes("bypass") || tokens.includes("*")) return [...ALL_HANDS];
  const hands = new Set<HandName>();
  for (const token of tokens) {
    switch (token) {
      case "Bash":
        hands.add("bash");
        break;
      case "Read":
      case "Grep":
      case "Glob":
        hands.add("read_file");
        hands.add("list_files");
        break;
      case "Write":
      case "Edit":
        hands.add("write_file");
        break;
      default:
        if ((ALL_HANDS as readonly string[]).includes(token)) {
          hands.add(token as HandName);
        }
        break;
    }
  }
  return hands.size > 0 ? [...hands] : ["read_file", "list_files"];
}

/** Wrap a sandbox and reject hands that a routine is not allowed to use. */
export class PolicySandbox implements Sandbox {
  readonly id: string;
  private readonly allowed: Set<string>;

  constructor(
    private readonly inner: Sandbox,
    allowedHands: readonly string[],
  ) {
    this.id = inner.id;
    this.allowed = new Set(normalizeHands(allowedHands));
  }

  get allowedHands(): string[] {
    return [...this.allowed];
  }

  async provision(resources?: SandboxResources): Promise<void> {
    await this.inner.provision(resources);
  }

  async execute(name: string, input: Record<string, unknown>): Promise<HandResult> {
    if (!this.allowed.has(name)) {
      throw new SandboxExecutionError(
        `Hand "${name}" is not allowed for this run. Allowed: ${this.allowedHands.join(", ")}`,
      );
    }
    return this.inner.execute(name, input);
  }

  async destroy(): Promise<void> {
    await this.inner.destroy();
  }

  isAlive(): boolean {
    return this.inner.isAlive();
  }
}
