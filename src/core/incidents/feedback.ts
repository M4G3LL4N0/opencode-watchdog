import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../../util/paths.js";

export type IncidentFeedback = "false-positive";

export interface IncidentFeedbackRecord {
  incidentID: string;
  feedback: IncidentFeedback;
  at: number;
}

export function feedbackFile(dir: string): string {
  return join(dir, "incidents-feedback.jsonl");
}

/** Mark an incident. Returns false when the id was already marked or missing. */
export function markIncidentFeedback(dir: string, incidentID: string, feedback: IncidentFeedback): boolean {
  ensureDir(dir);
  const existing = readIncidentFeedback(dir);
  if (existing[incidentID] === feedback) return false;
  const record: IncidentFeedbackRecord = { incidentID, feedback, at: Date.now() };
  appendFileSync(feedbackFile(dir), `${JSON.stringify(record)}\n`);
  return true;
}

export function readIncidentFeedback(dir: string): Record<string, IncidentFeedback> {
  const file = feedbackFile(dir);
  if (!existsSync(file)) return {};
  const out: Record<string, IncidentFeedback> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const rec = JSON.parse(trimmed) as IncidentFeedbackRecord;
      if (typeof rec.incidentID === "string" && rec.feedback === "false-positive") out[rec.incidentID] = rec.feedback;
    } catch {
      // ignore malformed line
    }
  }
  return out;
}