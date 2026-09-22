import type { OcHttpClient } from "./client.js";
import { promptAsyncPath } from "./client.js";
import type { SessionController } from "../../core/runtime/runtime.js";
import { safeAbortPolicy } from "./abort.js";

export interface SendRecoveryResult {
  ok: boolean;
  reason?: string;
}

export async function sendRecoveryPrompt(client: OcHttpClient, sessionID: string, prompt: string): Promise<SendRecoveryResult> {
  const body = { parts: [{ type: "text", text: prompt }] };
  const res = await client.post(promptAsyncPath(sessionID), body);
  if (res.ok) return { ok: true };
  return { ok: false, reason: describeFailure(res) };
}

function describeFailure(res: { status: number; body?: unknown }): string {
  if (res.status === 404) return "session not found";
  const b = res.body as { message?: string } | undefined;
  if (b && typeof b.message === "string") return `server error ${res.status}: ${b.message}`;
  return `prompt rejected: HTTP ${res.status}`;
}

export interface AdapterControllerOptions {
  client: OcHttpClient;
}

export function makeSessionController(client: OcHttpClient): SessionController {
  const policy = safeAbortPolicy(client);
  return {
    abortSession: (sessionID) => policy.abortSession(sessionID),
    sendRecoveryPrompt: async (sessionID, prompt) => sendRecoveryPrompt(client, sessionID, prompt),
  };
}