import type { OcHttpClient } from "./client.js";
import { abortPath } from "./client.js";

export interface AbortResult {
  ok: boolean;
  reason?: string;
  aborted?: boolean;
}

export async function abortSession(client: OcHttpClient, sessionID: string): Promise<AbortResult> {
  const res = await client.post(abortPath(sessionID));
  if (res.ok) {
    return { ok: true, aborted: res.body === true || res.body === undefined };
  }
  return { ok: false, reason: describeFailure(res) };
}

function describeFailure(res: { status: number; body?: unknown }): string {
  if (res.status === 404) return "session not found";
  const b = res.body as { error?: unknown; message?: string } | undefined;
  if (b && typeof b.message === "string") return `server error ${res.status}: ${b.message}`;
  if (b && typeof b.error === "string") return `server error ${res.status}: ${b.error}`;
  if (res.status === 0) return "request failed (server unreachable)";
  if (res.status === 401 || res.status === 403) return `abort rejected: HTTP ${res.status}`;
  return `abort rejected: HTTP ${res.status}`;
}

export interface SafeAbortPolicy {
  abortSession(sessionID: string): Promise<AbortResult>;
}

export function safeAbortPolicy(client: OcHttpClient): SafeAbortPolicy {
  return {
    abortSession: (sessionID) => abortSession(client, sessionID),
  };
}