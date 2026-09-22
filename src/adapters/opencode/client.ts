import { join } from "node:path";

export interface OcAuth {
  username?: string;
  password?: string;
}

export function loadAuthFromEnv(): OcAuth {
  const username = process.env.OPENCODE_SERVER_USERNAME;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (username && password) return { username, password };
  if (username || password) return { username, password: password ?? "" };
  return {};
}

export class OcHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
  }
}

export interface RequestResult {
  ok: boolean;
  status: number;
  body: unknown;
}

export interface OcClientOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  auth?: OcAuth;
}

export class OcHttpClient {
  readonly baseUrl: string;
  private readonly auth: OcAuth;
  private readonly timeoutMs: number;

  constructor(opts: OcClientOptions = {}) {
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? 4096;
    this.baseUrl = `http://${host}:${port}`;
    this.auth = opts.auth ?? {};
    this.timeoutMs = opts.timeoutMs ?? 3000;
  }

  async request(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<RequestResult> {
    const timeout = timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let init: RequestInit & { headers: Record<string, string> } = {
        method,
        headers: {},
        signal: controller.signal,
      };
      init.headers["user-agent"] = "opencode-watchdog";
      if (this.auth.username !== undefined && this.auth.password !== undefined) {
        init.headers.authorization = `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}`;
      }
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const res = await fetch(new URL(path, this.baseUrl), init);
      const text = await res.text();
      let parsed: unknown = undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      return { ok: res.ok, status: res.status, body: parsed };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return { ok: false, status: 0, body: { error: `request timed out after ${timeout}ms` } };
      }
      return { ok: false, status: 0, body: { error: (err as Error).message } };
    } finally {
      clearTimeout(timer);
    }
  }

  async get(path: string, timeoutMs?: number): Promise<RequestResult> {
    return this.request("GET", path, undefined, timeoutMs);
  }

  async post(path: string, body?: unknown, timeoutMs?: number): Promise<RequestResult> {
    return this.request("POST", path, body, timeoutMs);
  }
}

export function sessionPath(sessionID: string): string {
  return join("/session", encodeURIComponent(sessionID));
}

export function promptAsyncPath(sessionID: string): string {
  return join("/session", encodeURIComponent(sessionID), "prompt_async");
}

export function abortPath(sessionID: string): string {
  return join("/session", encodeURIComponent(sessionID), "abort");
}