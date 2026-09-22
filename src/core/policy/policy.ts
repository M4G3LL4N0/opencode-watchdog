import type { DetectorFinding, FindingSeverity } from "../detectors/detector.js";

export interface PolicyDecision {
  trip: boolean;
  kind: "hard" | "composite" | "none";
  totalScore: number;
  findings: DetectorFinding[];
}

export interface PolicyOptions {
  compositeTripThreshold: number;
  activeWindowMs: number;
}

export class PolicyEngine {
  constructor(private readonly opts: PolicyOptions) {}

  decide(findings: DetectorFinding[], now: number): PolicyDecision {
    const hard = findings.filter((f) => f.severity === "hard");
    if (hard.length > 0) {
      return { trip: true, kind: "hard", totalScore: 1, findings: hard };
    }
    const composite = findings.filter((f) => f.severity === "composite" && now - f.at <= this.opts.activeWindowMs);
    let score = 0;
    for (const f of composite) score += f.weight;
    if (score >= this.opts.compositeTripThreshold) {
      return { trip: true, kind: "composite", totalScore: score, findings: composite };
    }
    return { trip: false, kind: "none", totalScore: score, findings: composite };
  }
}