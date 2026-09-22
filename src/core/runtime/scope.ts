import type { TransportKind, WatchdogEvent } from "../events/types.js";
import type { DetectorFinding } from "../detectors/detector.js";
import { TextChannel } from "../detectors/text-channel.js";
import { ToolLoopDetector } from "../detectors/tool-loop.js";
import { NoProgressDetector } from "../detectors/no-progress.js";
import { SessionBreaker } from "../policy/breaker.js";
import type { WatchdogConfig } from "../../config/config.js";

export interface SessionMeta {
  model?: string;
  provider?: string;
  project?: string;
  directory?: string;
}

const BOUNDARY_KINDS = new Set<string>([
  "toolCallFinished",
  "fileChangeObserved",
  "progressObserved",
  "sessionIdle",
  "sessionError",
  "sessionCreated",
]);

export class SessionScope {
  readonly sessionID: string;
  readonly meta: SessionMeta = {};
  readonly assistantText: TextChannel;
  readonly reasoningText: TextChannel;
  readonly toolLoop: ToolLoopDetector;
  readonly noProgress: NoProgressDetector;
  readonly breaker: SessionBreaker;
  lastActionAt = 0;
  lastActivityAt = 0;
  tripCount = 0;
  lastTransport: TransportKind | undefined;

  constructor(
    sessionID: string,
    private readonly cfg: WatchdogConfig,
    breaker: SessionBreaker = new SessionBreaker(),
  ) {
    this.sessionID = sessionID;
    this.breaker = breaker;
    this.assistantText = new TextChannel(cfg);
    this.reasoningText = new TextChannel(cfg);
    this.toolLoop = new ToolLoopDetector({
      threshold: cfg.toolRepeatThreshold,
      windowMs: cfg.toolRepeatWindowSeconds * 1000,
    });
    this.noProgress = new NoProgressDetector(cfg.noProgressSeconds);
  }

  apply(e: WatchdogEvent): { eager: DetectorFinding[]; boundary: boolean } {
    const now = e.receivedAt;
    this.lastTransport = e.transport;
    if (e.model) this.meta.model = e.model;
    if (e.provider) this.meta.provider = e.provider;
    if (e.project) this.meta.project = e.project;
    if (e.directory) this.meta.directory = e.directory;
    let eager: DetectorFinding[] = [];
    const boundary = BOUNDARY_KINDS.has(e.kind);

    switch (e.kind) {
      case "assistantTextDelta":
        eager = this.assistantText.onDelta(e.delta, now);
        break;
      case "reasoningTextDelta":
        eager = this.reasoningText.onDelta(e.delta, now);
        break;
      case "assistantTextSnapshot":
        eager = this.assistantText.onSnapshot(e.text, now);
        break;
      case "reasoningTextSnapshot":
        eager = this.reasoningText.onSnapshot(e.text, now);
        break;
      case "toolCallStarted":
      case "toolCallFinished":
        this.lastActionAt = now;
        break;
      case "fileChangeObserved":
      case "progressObserved":
      case "sessionIdle":
      case "sessionError":
        this.lastActionAt = now;
        break;
      default:
        break;
    }
    this.noProgress.onEvent(e);
    this.toolLoop.onEvent(e);
    this.lastActivityAt = now;
    return { eager, boundary };
  }

  evaluate(now: number): DetectorFinding[] {
    const findings = this.assistantText.flush(now, this.lastActionAt);
    findings.push(...this.reasoningText.flush(now, this.lastActionAt));
    findings.push(...this.toolLoop.find(now));
    findings.push(...this.noProgress.find(now));
    return findings;
  }

  resetState(): void {
    this.assistantText.reset();
    this.reasoningText.reset();
    this.toolLoop.reset();
    this.noProgress.reset();
    this.lastActionAt = 0;
    this.lastActivityAt = 0;
  }

  reset(): void {
    this.assistantText.reset();
    this.reasoningText.reset();
    this.toolLoop.reset();
    this.noProgress.reset();
    this.breaker.reset();
    this.lastActionAt = 0;
    this.lastActivityAt = 0;
    this.tripCount = 0;
  }
}