import { appendFileSync, existsSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir } from "../../util/paths.js";
import { redact } from "../detectors/similarity.js";
import type { IncidentRecord } from "./incident.js";

export interface IncidentLogOptions {
  file: string;
  maxBytes: number;
  keepFiles: number;
}

export class IncidentLog {
  private readonly options: IncidentLogOptions;

  constructor(options: IncidentLogOptions) {
    this.options = options;
  }

  append(record: IncidentRecord): void {
    ensureDir(dirname(this.options.file));
    const cleaned: IncidentRecord = {
      ...record,
      trigger: redact(record.trigger),
      excerpt: record.excerpt ? redact(record.excerpt) : undefined,
    };
    const line = `${JSON.stringify(cleaned)}\n`;
    appendFileSync(this.options.file, line);
    this.rotateIfNeeded();
  }

  readAll(limit = 1000): IncidentRecord[] {
    if (!existsSync(this.options.file)) return [];
    let content = "";
    try {
      content = readFileSync(this.options.file, "utf8");
    } catch {
      return [];
    }
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const out: IncidentRecord[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line) as IncidentRecord);
      } catch {
        // skip malformed line
      }
    }
    return out;
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.options.file)) return;
      const size = statSync(this.options.file).size;
      if (size <= this.options.maxBytes) return;
      const base = this.options.file;
      for (let i = this.options.keepFiles - 1; i >= 1; i--) {
        const from = `${base}.${i}`;
        if (existsSync(from)) {
          if (i === this.options.keepFiles - 1) {
            truncateSync(from, 0);
          } else {
            renameSync(from, `${base}.${i + 1}`);
          }
        }
      }
      if (existsSync(base)) renameSync(base, `${base}.1`);
      writeFileSync(base, "");
    } catch {
      // rotation must never break incident capture
    }
  }
}

export function incidentsPath(dir: string): string {
  return join(dir, "incidents.jsonl");
}