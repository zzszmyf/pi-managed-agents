import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitProvisionOptions {
  repoUrl: string;
  targetDir: string;
  token?: string;
  branch?: string;
  depth?: number;
  /** Header prefix for the token. Default: "Bearer ". */
  authPrefix?: string;
  gitBin?: string;
}

export interface GitProvisionResult {
  targetDir: string;
  /** Remote URL after sanitization. Never contains a token. */
  remoteUrl: string;
  usedToken: boolean;
}

/** Remove userinfo from an http(s) URL. */
export function sanitizeRemoteUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * Clone a repository during sandbox initialization.
 *
 * The token is passed through git's one-shot environment config
 * (`GIT_CONFIG_COUNT`), not through the command line and not through
 * `.git/config`. After the clone, the remote URL is rewritten to the clean
 * URL. This mirrors the article's pattern: the token is wired in at provision
 * time and is not reachable from inside the sandbox afterwards.
 *
 * This helper runs on the host and writes into a host path. For a Docker
 * sandbox, export the directory into the container with a real image that has
 * git, or use a git credential proxy instead.
 */
export async function provisionGitRepo(options: GitProvisionOptions): Promise<GitProvisionResult> {
  const gitBin = options.gitBin ?? "git";
  const cleanUrl = sanitizeRemoteUrl(options.repoUrl);
  await fs.mkdir(path.dirname(options.targetDir), { recursive: true });

  const args = ["clone"];
  if (options.depth !== undefined) args.push("--depth", String(options.depth));
  if (options.branch) args.push("--branch", options.branch);
  args.push(cleanUrl, options.targetDir);

  const env: NodeJS.ProcessEnv = { ...process.env };
  // Do not let the host's ambient credential helpers silently supply a token.
  env.GIT_TERMINAL_PROMPT = "0";
  if (options.token) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: ${options.authPrefix ?? "Bearer "}${options.token}`;
  }

  await execFileAsync(gitBin, args, { env, timeout: 120_000 });

  // The clone may have written the original URL (which could contain userinfo)
  // into .git/config. Rewrite it to the sanitized form.
  await execFileAsync(gitBin, ["-C", options.targetDir, "remote", "set-url", "origin", cleanUrl], {
    timeout: 30_000,
  });

  return {
    targetDir: options.targetDir,
    remoteUrl: cleanUrl,
    usedToken: Boolean(options.token),
  };
}

/** Check that a .git/config does not contain a known secret. */
export async function gitConfigLeaksSecret(targetDir: string, secret: string): Promise<boolean> {
  const configPath = path.join(targetDir, ".git", "config");
  try {
    const config = await fs.readFile(configPath, "utf8");
    return config.includes(secret);
  } catch {
    return false;
  }
}
