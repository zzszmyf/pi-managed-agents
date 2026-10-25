import { randomUUID } from "node:crypto";
import type { HandResult, SandboxResources } from "../types.js";
import {
  type Sandbox,
  type SandboxProvider,
  SandboxExecutionError,
  SandboxUnavailableError,
} from "./sandbox.js";

export interface SandboxRuntimeOptions {
  provider: SandboxProvider;
  resources?: SandboxResources;
  onProvisioned?: (sandbox: Sandbox) => void | Promise<void>;
  onFailed?: (sandbox: Sandbox, error: Error) => void | Promise<void>;
}

/**
 * The harness-facing sandbox handle.
 *
 * It is lazy: nothing is provisioned until the first `execute`, unless the
 * harness explicitly provisions eagerly. When the underlying sandbox is lost,
 * the failed call is surfaced to the brain as a tool error, and the next call
 * transparently provisions a new one. This is the "containers are cattle"
 * behavior from the Managed Agents article.
 */
export class SandboxRuntime implements Sandbox {
  readonly id = `runtime_${randomUUID()}`;
  private readonly provider: SandboxProvider;
  private readonly resources?: SandboxResources;
  private readonly onProvisioned?: (sandbox: Sandbox) => void | Promise<void>;
  private readonly onFailed?: (sandbox: Sandbox, error: Error) => void | Promise<void>;
  private current?: Sandbox;
  private provisioning?: Promise<Sandbox>;
  private destroyed = false;

  constructor(options: SandboxRuntimeOptions) {
    this.provider = options.provider;
    this.resources = options.resources;
    this.onProvisioned = options.onProvisioned;
    this.onFailed = options.onFailed;
  }

  /** The id of the currently live underlying sandbox, if any. */
  get sandboxId(): string | undefined {
    return this.current?.id;
  }

  async provision(resources?: SandboxResources): Promise<void> {
    await this.ensure(resources ?? this.resources);
  }

  private async ensure(resources?: SandboxResources): Promise<Sandbox> {
    if (this.destroyed) {
      throw new SandboxUnavailableError("Sandbox runtime has been destroyed");
    }
    if (this.current?.isAlive()) return this.current;
    if (this.provisioning) return this.provisioning;

    const targetResources = resources ?? this.resources;
    this.provisioning = (async () => {
      const sandbox = await this.provider.provision(targetResources);
      try {
        await sandbox.provision(targetResources);
        this.current = sandbox;
        await this.onProvisioned?.(sandbox);
        return sandbox;
      } catch (error) {
        await sandbox.destroy().catch(() => undefined);
        throw error;
      }
    })();

    try {
      return await this.provisioning;
    } finally {
      this.provisioning = undefined;
    }
  }

  async execute(name: string, input: Record<string, unknown>): Promise<HandResult> {
    const sandbox = await this.ensure();
    try {
      return await sandbox.execute(name, input);
    } catch (error) {
      if (error instanceof SandboxUnavailableError) {
        this.current = undefined;
        await this.onFailed?.(sandbox, error);
        await sandbox.destroy().catch(() => undefined);
        throw new SandboxExecutionError(
          `Sandbox ${sandbox.id} was lost during "${name}". The next call will provision a new sandbox. ${error.message}`,
        );
      }
      throw error;
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    const sandbox = this.current;
    this.current = undefined;
    if (sandbox) await sandbox.destroy().catch(() => undefined);
  }

  isAlive(): boolean {
    return this.current?.isAlive() ?? false;
  }
}

/** Convenience provider that creates a fresh sandbox from a factory. */
export class FactorySandboxProvider implements SandboxProvider {
  constructor(private readonly factory: () => Sandbox) {}

  async provision(_resources?: SandboxResources): Promise<Sandbox> {
    return this.factory();
  }
}
