import { randomBytes } from "node:crypto";

export interface IncidentRecord {
  id: string;
  timestamp: string;
  epochMs: number;
  watchdogVersion: string;
  opencodeVersion?: string;
  sessionID?: string;
  project?: string;
  directory?: string;
  model?: string;
  provider?: string;
  detector: string;
  trigger: string;
  count?: number;
  findingsCount?: number;
  excerpt?: string;
  transport?: string;
  action: "none" | "abort" | "abort_and_recover";
  abortResult?: { ok: boolean; reason?: string };
  recoveryAttempted?: boolean;
  recoveryResult?: { ok: boolean; reason?: string };
  decisionKind?: "hard" | "composite";
  score?: number;
  circuitOpened?: boolean;
}

export function newIncidentId(): string {
  return `inc_${randomBytes(8).toString("hex")}`;
}