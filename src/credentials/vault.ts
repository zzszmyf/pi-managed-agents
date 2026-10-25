/**
 * A tiny credential vault.
 *
 * The point is architectural: secrets live in the host process, never in the
 * sandbox, and never in the session log. The sandbox receives a session-scoped
 * token that a proxy exchanges for the real credential.
 */
export class Vault {
  private readonly secrets = new Map<string, string>();

  put(key: string, value: string): void {
    if (!key) throw new Error("Vault key must not be empty");
    if (!value) throw new Error("Vault value must not be empty");
    this.secrets.set(key, value);
  }

  get(key: string): string | undefined {
    return this.secrets.get(key);
  }

  require(key: string): string {
    const value = this.secrets.get(key);
    if (value === undefined) throw new Error(`Vault has no secret named "${key}"`);
    return value;
  }

  has(key: string): boolean {
    return this.secrets.has(key);
  }

  keys(): string[] {
    return [...this.secrets.keys()];
  }

  /** Replace every known secret in a string. Useful for logs and error messages. */
  redact(text: string): string {
    let result = text;
    const entries = [...this.secrets.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [key, value] of entries) {
      result = result.split(value).join(`[REDACTED:${key}]`);
    }
    return result;
  }

  /** True when a string contains any known secret. */
  leaks(text: string): boolean {
    for (const value of this.secrets.values()) {
      if (text.includes(value)) return true;
    }
    return false;
  }
}
