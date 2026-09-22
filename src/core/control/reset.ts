import { appendFileSync } from "node:fs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "../../util/paths.js";

export interface ResetRecord {
  sessionID: string;
  at: number;
  source: "cli";
}

export function resetFile(dir: string): string {
  return join(dir, "session-resets.jsonl");
}

/** Queue a watchdog-only session reset request. Applied on the next watchdog tick. */
export function enqueueSessionReset(stateDir: string, sessionID: string): void {
  ensureDir(stateDir);
  const record: ResetRecord = { sessionID, at: Date.now(), source: "cli" };
  appendFileSync(resetFile(stateDir), `${JSON.stringify(record)}\n`);
}

/** Read + drain all queued resets (used by the running watchdog). */
export function drainSessionResets(stateDir: string): string[] {
  const file = resetFile(stateDir);
  if (!existsSync(file)) return [];
  let ids: string[] = [];
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const rec = JSON.parse(trimmed) as Partial<ResetRecord>;
        if (typeof rec.sessionID === "string" && rec.sessionID.length > 0) ids.push(rec.sessionID);
      } catch {
        // ignore malformed
      }
    }
  } catch {
    return [];
  }
  try {
    writeFileSync(file, "");
  } catch {
    // non-draining read only
  }
  ids = [...new Set(ids)];
  return ids;
}

/** Read resets without draining (used by status/stats to compute circuit state). */
export function readSessionResets(stateDir: string): ResetRecord[] {
  const file = resetFile(stateDir);
  if (!existsSync(file)) return [];
  const out: ResetRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const rec = JSON.parse(trimmed) as ResetRecord;
      if (typeof rec.sessionID === "string" && typeof rec.at === "number") out.push(rec);
    } catch {
      // ignore malformed
    }
  }
  return out;
}