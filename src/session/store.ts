import { randomUUID } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import {
  type EventQuery,
  type SessionEvent,
  type SessionEventOf,
  type SessionEventData,
  type SessionEventType,
  type SessionMeta,
} from "./events.js";

export interface CreateSessionOptions {
  sessionId?: string;
  tags?: string[];
  now?: number;
}

export interface SessionStore {
  createSession(options?: CreateSessionOptions): Promise<SessionMeta>;
  append<K extends SessionEventType>(
    sessionId: string,
    type: K,
    data: SessionEventData[K],
  ): Promise<SessionEventOf<K>>;
  read(sessionId: string, query?: EventQuery): Promise<SessionEvent[]>;
  getMeta(sessionId: string): Promise<SessionMeta | undefined>;
  listSessions(): Promise<SessionMeta[]>;
  exists(sessionId: string): Promise<boolean>;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function newSessionId(): string {
  return `sess_${randomUUID()}`;
}

export function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}

function applyQuery(events: SessionEvent[], query?: EventQuery): SessionEvent[] {
  if (!query) return events;
  let selected = events;
  if (query.fromSeq !== undefined) {
    selected = selected.filter((event) => event.seq >= query.fromSeq!);
  }
  if (query.toSeq !== undefined) {
    selected = selected.filter((event) => event.seq <= query.toSeq!);
  }
  if (query.types && query.types.length > 0) {
    const allowed = new Set(query.types);
    selected = selected.filter((event) => allowed.has(event.type));
  }
  if (query.limit !== undefined && query.limit >= 0) {
    selected = selected.slice(Math.max(0, selected.length - query.limit));
  }
  return selected;
}

function makeMeta(options: CreateSessionOptions | undefined): SessionMeta {
  const sessionId = options?.sessionId ?? newSessionId();
  assertSessionId(sessionId);
  const meta: SessionMeta = {
    sessionId,
    createdAt: options?.now ?? Date.now(),
  };
  if (options?.tags) meta.tags = [...options.tags];
  return meta;
}

/**
 * In-memory implementation, useful for tests and single-process demos.
 * The API is the same as the file-backed store.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionEvent[]>();
  private readonly metas = new Map<string, SessionMeta>();

  async createSession(options?: CreateSessionOptions): Promise<SessionMeta> {
    const meta = makeMeta(options);
    if (this.sessions.has(meta.sessionId)) {
      throw new Error(`Session already exists: ${meta.sessionId}`);
    }
    const event: SessionEventOf<"session_created"> = {
      seq: 1,
      ts: meta.createdAt,
      sessionId: meta.sessionId,
      type: "session_created",
      data: { meta },
    };
    this.metas.set(meta.sessionId, meta);
    this.sessions.set(meta.sessionId, [event]);
    return meta;
  }

  async append<K extends SessionEventType>(
    sessionId: string,
    type: K,
    data: SessionEventData[K],
  ): Promise<SessionEventOf<K>> {
    const events = this.sessions.get(sessionId);
    if (!events) throw new Error(`Unknown session: ${sessionId}`);
    const event: SessionEventOf<K> = {
      seq: events.length + 1,
      ts: Date.now(),
      sessionId,
      type,
      data,
    };
    events.push(event as SessionEvent);
    return event;
  }

  async read(sessionId: string, query?: EventQuery): Promise<SessionEvent[]> {
    const events = this.sessions.get(sessionId);
    if (!events) throw new Error(`Unknown session: ${sessionId}`);
    return applyQuery([...events], query);
  }

  async getMeta(sessionId: string): Promise<SessionMeta | undefined> {
    return this.metas.get(sessionId);
  }

  async listSessions(): Promise<SessionMeta[]> {
    return [...this.metas.values()];
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }
}

/**
 * One JSONL file per session plus a small meta.json.
 *
 * The log is append-only: there is deliberately no update or delete API.
 * Appends are serialized inside this process. For multi-process writers you
 * need a real log (Kafka, Postgres, object storage with conditional writes);
 * see the README.
 */
export class FileSessionStore implements SessionStore {
  readonly rootDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(rootDir = path.resolve(".sessions")) {
    this.rootDir = rootDir;
  }

  private sessionDir(sessionId: string): string {
    assertSessionId(sessionId);
    return path.join(this.rootDir, sessionId);
  }

  private eventsPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "events.jsonl");
  }

  private metaPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "meta.json");
  }

  private runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.locks.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private async readUnlocked(sessionId: string): Promise<SessionEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.eventsPath(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      throw error;
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const events: SessionEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch (error) {
        // A crash during append can leave a truncated final line. Ignore it;
        // everything before it is still a valid prefix of the log.
        if (index === lines.length - 1) break;
        throw new Error(`Corrupt session log at ${sessionId}:${index + 1}: ${String(error)}`);
      }
    }
    return events;
  }

  async createSession(options?: CreateSessionOptions): Promise<SessionMeta> {
    const meta = makeMeta(options);
    const dir = this.sessionDir(meta.sessionId);
    try {
      await fs.mkdir(dir, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Session already exists: ${meta.sessionId}`);
      }
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await fs.mkdir(dir, { recursive: false });
    }
    await fs.writeFile(this.metaPath(meta.sessionId), `${JSON.stringify(meta)}\n`, "utf8");
    const event: SessionEventOf<"session_created"> = {
      seq: 1,
      ts: meta.createdAt,
      sessionId: meta.sessionId,
      type: "session_created",
      data: { meta },
    };
    await fs.writeFile(this.eventsPath(meta.sessionId), `${JSON.stringify(event)}\n`, "utf8");
    return meta;
  }

  async append<K extends SessionEventType>(
    sessionId: string,
    type: K,
    data: SessionEventData[K],
  ): Promise<SessionEventOf<K>> {
    return this.runExclusive(sessionId, async () => {
      const events = await this.readUnlocked(sessionId);
      const previous = events.at(-1);
      const event: SessionEventOf<K> = {
        seq: (previous?.seq ?? 0) + 1,
        ts: Date.now(),
        sessionId,
        type,
        data,
      };
      await fs.appendFile(this.eventsPath(sessionId), `${JSON.stringify(event)}\n`, "utf8");
      return event;
    });
  }

  async read(sessionId: string, query?: EventQuery): Promise<SessionEvent[]> {
    return this.runExclusive(sessionId, async () => {
      const events = await this.readUnlocked(sessionId);
      return applyQuery(events, query);
    });
  }

  async getMeta(sessionId: string): Promise<SessionMeta | undefined> {
    try {
      const raw = await fs.readFile(this.metaPath(sessionId), "utf8");
      return JSON.parse(raw) as SessionMeta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listSessions(): Promise<SessionMeta[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await this.getMeta(entry.name);
      if (meta) metas.push(meta);
    }
    metas.sort((a, b) => b.createdAt - a.createdAt);
    return metas;
  }

  async exists(sessionId: string): Promise<boolean> {
    return (await this.getMeta(sessionId)) !== undefined;
  }
}
