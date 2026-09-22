import { readFileSync } from "node:fs";
import { WatchdogRuntime, type SessionController } from "../core/runtime/runtime.js";
import type { WatchdogConfig, WatchdogMode } from "../config/config.js";
import type { WatchdogEvent } from "../core/events/types.js";
import { normalizeOpenCodeEvent } from "../adapters/opencode/normalize.js";

export interface SimParams {
  mode: WatchdogMode;
  paceMs: number;
}

export interface ScenarioOutcome {
  title: string;
  incidents: number;
  trips: number;
  aborts: number;
  recoveries: number;
  findingsByDetector: Record<string, number>;
  expectedDetect?: boolean;
  expectedDetector?: string;
  passed: boolean;
}

export class RecordingController implements SessionController {
  readonly aborts: string[] = [];
  readonly recoveries: string[] = [];
  abortSession(sessionID: string): Promise<{ ok: boolean; reason?: string }> {
    this.aborts.push(sessionID);
    return Promise.resolve({ ok: true });
  }
  sendRecoveryPrompt(sessionID: string): Promise<{ ok: boolean; reason?: string }> {
    this.recoveries.push(sessionID);
    return Promise.resolve({ ok: true });
  }
}

const BASE_TIME = 1_700_000_000_000;

export interface Fixture {
  title: string;
  events: WatchdogEvent[];
  expect?: { detect?: boolean; detector?: string };
}

function lineToEvents(line: string, sessionID: string): WatchdogEvent[] {
  const obj = JSON.parse(line) as Record<string, unknown>;
  const offset = typeof obj._at === "number" ? obj._at : 0;
  const clean = { ...obj };
  delete (clean as Record<string, unknown>)._at;
  const receivedAt = BASE_TIME + offset;
  if (typeof clean.kind === "string") {
    return [{ ...(clean as unknown as WatchdogEvent), sessionID, receivedAt }];
  }
  const normalized = normalizeOpenCodeEvent(clean, "token_delta");
  if (!normalized) return [];
  const list = Array.isArray(normalized) ? normalized : [normalized];
  return list.map((e) => ({ ...e, sessionID, receivedAt }));
}

export function loadFixture(path: string): Fixture {
  const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const title = (path.split("/").pop() ?? path).replace(/\.jsonl$/, "");
  const events: WatchdogEvent[] = [];
  let expect: { detect?: boolean; detector?: string } | undefined;
  for (const line of lines) {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (typeof obj._expect === "object" && obj._expect !== null) {
      expect = obj._expect as { detect?: boolean; detector?: string };
      continue;
    }
    const sessionID = typeof obj.sessionID === "string" ? obj.sessionID : "ses_sim";
    events.push(...lineToEvents(line, sessionID));
  }
  return { title, events, expect };
}

export async function runScenario(
  fixture: Fixture,
  config: WatchdogConfig,
  params: SimParams,
): Promise<ScenarioOutcome> {
  const cfg: WatchdogConfig = { ...config, mode: params.mode };
  const controller = new RecordingController();
  const incidents: unknown[] = [];
  const runtime = new WatchdogRuntime({
    config: cfg,
    controller,
    opencodeVersion: "fixture",
    onIncident: (r) => incidents.push(r),
  });
  for (const e of fixture.events) {
    runtime.ingest(e);
    runtime.tickAt(e.receivedAt);
  }
  await runtime.waitForActions();
  const stats = runtime.getStats();
  const expectedDetect = fixture.expect?.detect;
  const expectedDetector = fixture.expect?.detector;
  let passed = true;
  if (expectedDetect === true) {
    const found = incidents.length > 0;
    const detector = incidents.some((r) => (r as { detector?: string }).detector === expectedDetector);
    passed = expectedDetector ? found && detector : found;
  } else if (expectedDetect === false) {
    passed = incidents.length === 0;
  }
  return {
    title: fixture.title,
    incidents: incidents.length,
    trips: stats.trips,
    aborts: stats.aborts,
    recoveries: stats.recoveries,
    findingsByDetector: stats.findingsByDetector,
    expectedDetect,
    expectedDetector,
    passed,
  };
}