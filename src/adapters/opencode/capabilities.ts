import type { OcClientOptions, OcHttpClient } from "./client.js";

export interface CapabilityProbe {
  endpoint: string;
  healthy: boolean;
  opencodeVersion?: string;
  reachable: boolean;
  authConfigured: boolean;
  sessionListAvailable: boolean;
  abortAvailable: boolean;
  promptAsyncAvailable: boolean;
  pollSupported: boolean;
  checkedAt: number;
}

export async function probeCapabilities(client: OcHttpClient, opts: OcClientOptions = {}): Promise<CapabilityProbe> {
  const checkedAt = Date.now();
  const result: CapabilityProbe = {
    endpoint: client.baseUrl,
    healthy: false,
    reachable: false,
    authConfigured: opts.auth?.username !== undefined || opts.auth?.password !== undefined,
    sessionListAvailable: false,
    abortAvailable: false,
    promptAsyncAvailable: false,
    pollSupported: false,
    checkedAt,
  };

  const health = await client.get("/global/health", opts.timeoutMs ?? 3000);
  if (health.ok && health.status === 200) {
    result.healthy = true;
    result.reachable = true;
    const h = health.body as { healthy?: boolean; version?: string };
    if (h && h.healthy !== false) {
      result.opencodeVersion = typeof h.version === "string" ? h.version : undefined;
      result.sessionListAvailable = (await client.get("/session", opts.timeoutMs ?? 3000)).ok;
      result.pollSupported = result.sessionListAvailable;
      result.abortAvailable = true;
      result.promptAsyncAvailable = true;
    }
  } else {
    result.reachable = health.status !== 0;
  }
  return result;
}

export interface FeedRecommendation {
  recommended: "token_delta" | "part_update" | "message_poll_fallback";
  reasoning: string;
  sseAvailable: boolean;
}

export function recommendTransport(probe: CapabilityProbe, sseAlive: boolean): FeedRecommendation {
  if (!probe.healthy) {
    return { recommended: "message_poll_fallback", reasoning: "server not healthy; only polling is safe", sseAvailable: false };
  }
  if (sseAlive) {
    return { recommended: "token_delta", reasoning: "live SSE connected; token deltas preferred", sseAvailable: true };
  }
  if (probe.pollSupported) {
    return { recommended: "message_poll_fallback", reasoning: "SSE unavailable; falling back to message polling", sseAvailable: false };
  }
  return { recommended: "message_poll_fallback", reasoning: "no live feed; message polling only", sseAvailable: false };
}

export function feedLabel(t: string): string {
  return t;
}

export async function capabilitySummary(client: OcHttpClient, opts: OcClientOptions): Promise<CapabilityProbe & { effectiveFeed: string }> {
  const probe = await probeCapabilities(client, opts);
  const rec = recommendTransport(probe, false);
  return { ...probe, effectiveFeed: rec.recommended };
}