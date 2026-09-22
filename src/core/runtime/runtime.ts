import type { WatchdogEvent } from "../events/types.js";
import type { DetectorFinding } from "../detectors/detector.js";
import { IncidentLog, incidentsPath } from "../incidents/log.js";
import type { IncidentRecord } from "../incidents/incident.js";
import { newIncidentId } from "../incidents/incident.js";
import { PolicyEngine } from "../policy/policy.js";
import { RecoveryPolicy } from "../recovery/recovery.js";
import { SessionBreaker } from "../policy/breaker.js";
import { SessionScope } from "./scope.js";
import { WATCHDOG_VERSION } from "../../version.js";
import { watchdogStateDir } from "../../util/paths.js";
import { drainSessionResets } from "../control/reset.js";
import type { WatchdogConfig } from "../../config/config.js";

export interface SessionController {
  abortSession(sessionID: string): Promise<{ ok: boolean; reason?: string }>;
  sendRecoveryPrompt(sessionID: string, prompt: string): Promise<{ ok: boolean; reason?: string }>;
}

export const RECOVERY_INSTRUCTION =
  "Your previous response was interrupted because the watchdog detected output degeneration. Inspect the current repository and filesystem state, then continue only the unfinished work. Do not repeat the response that was interrupted.";

export interface RuntimeOptions {
  config: WatchdogConfig;
  controller: SessionController;
  opencodeVersion?: string;
  clock?: () => number;
  onIncident?: (record: IncidentRecord) => void;
}

export interface SessionState {
  sessionID: string;
  model?: string;
  provider?: string;
  project?: string;
  directory?: string;
  lastTransport?: string;
  tripCount: number;
  circuit: "closed" | "open";
  circuitOpenedSince?: number;
}

export interface RuntimeStats {
  eventsIngested: number;
  eventsByKind: Record<string, number>;
  findingsByDetector: Record<string, number>;
  trips: number;
  aborts: number;
  recoveries: number;
  incidents: number;
  sessions: SessionState[];
}

export class WatchdogRuntime {
  private readonly config: WatchdogConfig;
  private readonly controller: SessionController;
  private readonly policy: PolicyEngine;
  private readonly recovery: RecoveryPolicy;
  private readonly incidentLog: IncidentLog;
  private readonly clock: () => number;
  private readonly onIncident?: (record: IncidentRecord) => void;
  private readonly opencodeVersion?: string;
  private readonly stateDir: string;
  private readonly scopes = new Map<string, SessionScope>();
  private eventsIngested = 0;
  private readonly eventsByKind: Record<string, number> = {};
  private readonly findingsByDetector: Record<string, number> = {};
  private trips = 0;
  private aborts = 0;
  private recoveries = 0;
  private readonly compositeWindow = new Map<string, DetectorFinding>();
  private task: Promise<void> = Promise.resolve();

  constructor(opts: RuntimeOptions) {
    this.config = opts.config;
    this.controller = opts.controller;
    this.policy = new PolicyEngine({
      compositeTripThreshold: opts.config.compositeTripThreshold,
      activeWindowMs: opts.config.activeWindowSeconds * 1000,
    });
    this.recovery = new RecoveryPolicy({
      maxAutomaticRecoveries: opts.config.maxAutomaticRecoveries,
      recoveryWindowMs: opts.config.recoveryWindowSeconds * 1000,
    });
    this.incidentLog = new IncidentLog({
      file: incidentsPath(watchdogStateDir()),
      maxBytes: opts.config.logRetentionBytes,
      keepFiles: 2,
    });
    this.stateDir = watchdogStateDir();
    this.clock = opts.clock ?? Date.now;
    this.onIncident = opts.onIncident;
    this.opencodeVersion = opts.opencodeVersion;
  }

  get mode(): string {
    return this.config.mode;
  }

  get scopeCount(): number {
    return this.scopes.size;
  }

  getScope(sessionID: string): SessionScope | undefined {
    return this.scopes.get(sessionID);
  }

  ingest(e: WatchdogEvent): void {
    this.eventsIngested++;
    this.eventsByKind[e.kind] = (this.eventsByKind[e.kind] ?? 0) + 1;
    let scope = this.scopes.get(e.sessionID);
    if (!scope) {
      scope = new SessionScope(e.sessionID, this.config, this.newBreaker());
      this.scopes.set(e.sessionID, scope);
    }
    const now = e.receivedAt;
    const { eager, boundary } = scope.apply(e);
    if (boundary || eager.length > 0) this.evaluate(e.sessionID, now, eager);
  }

  tick(): void {
    this.applyQueuedResets();
    const now = this.clock();
    for (const sessionID of [...this.scopes.keys()]) this.evaluate(sessionID, now);
  }

  tickAt(now: number): void {
    for (const sessionID of [...this.scopes.keys()]) this.evaluate(sessionID, now);
  }

  private newBreaker(): SessionBreaker {
    return new SessionBreaker(60_000, this.config.recoveryWindowSeconds * 1000);
  }

  /** Reset watchdog-only state (breaker, recovery window, detectors) for a session. */
  resetSession(sessionID: string): void {
    const scope = this.scopes.get(sessionID);
    if (scope) scope.reset();
    this.recovery.reset(sessionID);
    this.compositeWindow.clear();
  }

  private applyQueuedResets(): void {
    let resets: string[] = [];
    try {
      resets = drainSessionResets(this.stateDir);
    } catch {
      return;
    }
    for (const sessionID of resets) this.resetSession(sessionID);
  }

  private evaluate(sessionID: string, now: number, eager: DetectorFinding[] = []): void {
    const scope = this.scopes.get(sessionID);
    if (!scope) return;
    const current = [...eager, ...scope.evaluate(now)];
    for (const f of current) {
      this.recordFinding(f);
      if (f.severity === "composite") this.compositeWindow.set(f.detector, f);
    }
    const windowMs = this.config.activeWindowSeconds * 1000;
    for (const [detector, f] of this.compositeWindow) {
      if (now - f.at > windowMs) this.compositeWindow.delete(detector);
    }
    const findings = [...current];
    for (const f of this.compositeWindow.values()) {
      if (!findings.some((c) => c.detector === f.detector)) findings.push(f);
    }
    const decision = this.policy.decide(findings, now);
    if (!decision.trip) return;
    const outcome = scope.breaker.recordTripDetailed(now);
    if (!outcome.allowed) return;
    this.trips++;
    scope.tripCount++;
    scope.resetState();
    this.compositeWindow.clear();
    const record = this.buildIncident(scope, decision.findings, decision.kind as "hard" | "composite", decision.totalScore, now);
    if (outcome.openedNow) record.circuitOpened = true;
    this.runAction(scope, record);
  }

  private buildIncident(
    scope: SessionScope,
    findings: DetectorFinding[],
    kind: "hard" | "composite",
    score: number,
    now: number,
  ): IncidentRecord {
    const representative = [...findings].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
    const f = representative ?? findings[0];
    const base: IncidentRecord = {
      id: newIncidentId(),
      timestamp: new Date(now).toISOString(),
      epochMs: now,
      watchdogVersion: WATCHDOG_VERSION,
      opencodeVersion: this.opencodeVersion,
      sessionID: scope.sessionID,
      project: scope.meta.project,
      directory: scope.meta.directory,
      model: scope.meta.model,
      provider: scope.meta.provider,
      detector: f?.detector ?? "unknown",
      trigger: f?.trigger ?? "trip without finding",
      count: f?.count,
      excerpt: f?.excerpt,
      transport: scope.lastTransport,
      decisionKind: kind,
      score,
      action: this.actionKind(),
    };
    if (findings.length > 1) base.findingsCount = findings.length;
    return base;
  }

  private runAction(scope: SessionScope, record: IncidentRecord): void {
    const sessionID = scope.sessionID;
    const next = (r: IncidentRecord): void => {
      this.incidentLog.append(r);
      void this.onIncident?.(r);
    };
    if (this.actionKind() === "none") {
      next(record);
      return;
    }
    this.task = this.task.then(async () => {
      const abortResult = await this.controller.abortSession(sessionID);
      if (abortResult.ok) this.aborts++;
      record.abortResult = abortResult;
      if (this.actionKind() !== "abort_and_recover") {
        next(record);
        return;
      }
      if (!this.recovery.canRecover(sessionID, record.epochMs)) {
        record.recoveryAttempted = false;
        record.recoveryResult = { ok: false, reason: "automatic recovery disabled (repeat within recovery window)" };
        next(record);
        return;
      }
      this.recovery.recordRecovery(sessionID, record.epochMs);
      const recoveryResult = await this.controller.sendRecoveryPrompt(sessionID, RECOVERY_INSTRUCTION);
      if (recoveryResult.ok) this.recoveries++;
      record.recoveryAttempted = true;
      record.recoveryResult = recoveryResult;
      next(record);
    });
  }

  private actionKind(): "none" | "abort" | "abort_and_recover" {
    switch (this.config.mode) {
      case "recover":
        return "abort_and_recover";
      case "protect":
        return "abort";
      default:
        return "none";
    }
  }

  private recordFinding(f: DetectorFinding): void {
    this.findingsByDetector[f.detector] = (this.findingsByDetector[f.detector] ?? 0) + 1;
  }

  getLoggedIncidents(): IncidentRecord[] {
    return this.incidentLog.readAll();
  }

  getStats(): RuntimeStats {
    const sessions: SessionState[] = [];
    for (const scope of this.scopes.values()) {
      sessions.push({
        sessionID: scope.sessionID,
        model: scope.meta.model,
        provider: scope.meta.provider,
        project: scope.meta.project,
        directory: scope.meta.directory,
        lastTransport: scope.lastTransport,
        tripCount: scope.tripCount,
        circuit: scope.breaker.stateName(),
        circuitOpenedSince: scope.breaker.stateName() === "open" ? scope.breaker.openedSince() : undefined,
      });
    }
    return {
      eventsIngested: this.eventsIngested,
      eventsByKind: { ...this.eventsByKind },
      findingsByDetector: { ...this.findingsByDetector },
      trips: this.trips,
      aborts: this.aborts,
      recoveries: this.recoveries,
      incidents: this.getLoggedIncidents().length,
      sessions,
    };
  }

  waitForActions(): Promise<void> {
    return this.task;
  }

  stop(): void {
    this.task = Promise.resolve();
  }
}