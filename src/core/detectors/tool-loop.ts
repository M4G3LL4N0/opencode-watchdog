import type { WatchdogEvent } from "../events/types.js";
import { finding, type Detector, type DetectorFinding } from "./detector.js";
import { canonicalKey } from "./similarity.js";

const EXTERNAL_PROGRESS = new Set(["progress.file.changed", "progress.session.idle", "progress.session.error"]);

function isExternalProgress(kind: string): boolean {
  return EXTERNAL_PROGRESS.has(kind);
}

interface ToolEntry {
  key: string;
  tool: string;
  at: number;
  callID: string;
  finished: boolean;
}

export interface ToolLoopOptions {
  threshold: number;
  windowMs: number;
}

export class ToolLoopDetector implements Detector {
  readonly name = "tool_loop";
  private calls: ToolEntry[] = [];
  private active: Map<string, boolean> = new Map();
  private progress: Array<{ at: number; kind: string }> = [];
  private lastEmitKey: string | undefined;
  private lastEmitAt = 0;

  constructor(private readonly opts: ToolLoopOptions) {}

  onEvent(e: WatchdogEvent): void {
    const now = e.receivedAt;
    this.prune(now);
    switch (e.kind) {
      case "toolCallStarted": {
        const key = `${e.tool}|${canonicalKey(e.input)}`;
        this.calls.push({ key, tool: e.tool, at: now, callID: e.callID, finished: false });
        this.active.set(e.callID, true);
        this.progress.push({ at: now, kind: "progress.tool.started" });
        break;
      }
      case "toolCallFinished": {
        const entry = this.calls.find((c) => c.callID === e.callID);
        if (entry) {
          entry.finished = true;
        } else {
          this.calls.push({ key: `${e.tool}|*missing-start*`, tool: e.tool, at: now, callID: e.callID, finished: true });
        }
        this.active.delete(e.callID);
        this.progress.push({ at: now, kind: "progress.tool.finished" });
        break;
      }
      case "toolCallUpdated":
      case "toolOutputObserved": {
        this.progress.push({ at: now, kind: `progress.${e.kind}` });
        break;
      }
      case "fileChangeObserved":
        this.progress.push({ at: now, kind: "progress.file.changed" });
        break;
      case "sessionIdle":
        this.progress.push({ at: now, kind: "progress.session.idle" });
        break;
      case "sessionError":
        this.progress.push({ at: now, kind: "progress.session.error" });
        break;
      default:
        break;
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.opts.windowMs;
    this.calls = this.calls.filter((c) => c.at >= cutoff);
    this.progress = this.progress.filter((p) => p.at >= cutoff);
  }

  onFlush(now: number): DetectorFinding[] {
    return this.find(now);
  }

  find(now: number): DetectorFinding[] {
    this.prune(now);
    const counts = new Map<string, ToolEntry[]>();
    for (const c of this.calls) {
      const list = counts.get(c.key);
      if (list) list.push(c);
      else counts.set(c.key, [c]);
    }
    const hits: DetectorFinding[] = [];
    for (const [key, entries] of counts) {
      if (entries.length < this.opts.threshold) continue;
      const finishedCount = entries.filter((e) => e.finished).length;
      if (finishedCount < this.opts.threshold) continue;
      entries.sort((a, b) => a.at - b.at);
      const firstAt = entries[0]!.at;
      const lastAt = entries[entries.length - 1]!.at;
      let interleaved = false;
      for (const p of this.progress) {
        if (p.at <= firstAt || p.at >= lastAt) continue;
        if (!isExternalProgress(p.kind)) continue;
        interleaved = true;
      }
      const otherTools = this.calls.filter((c) => c.key !== key && c.at >= firstAt && c.at <= lastAt);
      if (!interleaved && otherTools.length === 0) {
        if (this.lastEmitKey === key && now - this.lastEmitAt < 30_000) continue;
        this.lastEmitKey = key;
        this.lastEmitAt = now;
        hits.push(
          finding({
            detector: "tool_loop",
            severity: "composite",
            trigger: `identical tool call ${entries.length}x with no state change ("${entries[0]!.tool}")`,
            count: entries.length,
            weight: 0.8,
            measure: { calls: entries.length, tool: entries[0]!.tool, firstAt, lastAt },
            at: now,
          }),
        );
      }
    }
    return hits;
  }

  reset(): void {
    this.calls = [];
    this.active = new Map();
    this.progress = [];
  }
}