import type { WatchdogEvent } from "../events/types.js";
import { finding, type Detector, type DetectorFinding } from "./detector.js";

function isStrongProgress(e: WatchdogEvent): boolean {
  switch (e.kind) {
    case "fileChangeObserved":
    case "toolCallFinished":
    case "progressObserved":
    case "sessionIdle":
      return true;
    case "toolCallStarted":
      return false;
    default:
      return false;
  }
}

export class NoProgressDetector implements Detector {
  readonly name = "no_progress";
  private busySince: number | null = null;
  private deadline: number | null = null;
  private lastStrongProgress = 0;
  private lastActivity = 0;
  private activeToolSince: number | null = null;
  private lastEmitAt = 0;

  constructor(private readonly noProgressSeconds: number) {}

  onEvent(e: WatchdogEvent): void {
    const now = e.receivedAt;
    switch (e.kind) {
      case "sessionBusy":
        this.busySince = now;
        this.deadline = now + this.noProgressSeconds * 1000;
        break;
      case "sessionIdle":
        this.busySince = null;
        this.deadline = null;
        this.activeToolSince = null;
        break;
      case "sessionAborted":
      case "sessionError":
        this.busySince = null;
        this.deadline = null;
        this.activeToolSince = null;
        break;
      case "toolCallStarted":
        this.activeToolSince = now;
        this.deadline = now + this.noProgressSeconds * 1000;
        break;
      case "toolCallFinished":
        this.activeToolSince = null;
        this.lastStrongProgress = now;
        this.deadline = now + this.noProgressSeconds * 1000;
        break;
      case "assistantTextDelta":
      case "reasoningTextDelta":
        this.lastActivity = now;
        if (this.deadline !== null && now < this.deadline) this.deadline = now + this.noProgressSeconds * 1000;
        break;
      default:
        if (isStrongProgress(e)) {
          this.lastStrongProgress = now;
          this.deadline = now + this.noProgressSeconds * 1000;
        }
        break;
    }
  }

  onFlush(now: number): DetectorFinding[] {
    return this.find(now);
  }

  find(now: number): DetectorFinding[] {
    if (this.busySince === null || this.deadline === null) return [];
    if (this.activeToolSince !== null) return [];
    if (now < this.deadline) return [];
    if (now - this.lastStrongProgress < this.noProgressSeconds * 1000) {
      this.deadline = now + this.noProgressSeconds * 1000;
      return [];
    }
    if (now - this.lastActivity >= this.noProgressSeconds * 1000 && now - this.lastEmitAt >= 30_000) {
      this.lastEmitAt = now;
      this.deadline = now + this.noProgressSeconds * 1000;
      return [
        finding({
          detector: "no_progress",
          severity: "composite",
          trigger: `no meaningful progress for ${this.noProgressSeconds}s while session busy`,
          count: 1,
          weight: 0.5,
          measure: { noProgressSeconds: this.noProgressSeconds, busyMs: now - this.busySince },
          at: now,
        }),
      ];
    }
    return [];
  }

  reset(): void {
    this.busySince = null;
    this.deadline = null;
    this.lastStrongProgress = 0;
    this.lastActivity = 0;
    this.activeToolSince = null;
  }
}