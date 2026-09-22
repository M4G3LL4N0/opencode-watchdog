import type { WatchdogEvent } from "../events/types.js";

export type FindingSeverity = "hard" | "composite";

export interface DetectorFinding {
  detector: string;
  severity: FindingSeverity;
  trigger: string;
  count: number;
  weight: number;
  excerpt?: string;
  measure: Record<string, number | string>;
  at: number;
}

export interface Detector {
  readonly name: string;
  onEvent(e: WatchdogEvent): void;
  onFlush(now: number): DetectorFinding[];
}

export function finding(input: {
  detector: string;
  severity: FindingSeverity;
  trigger: string;
  count: number;
  weight: number;
  excerpt?: string;
  measure?: Record<string, number | string>;
  at: number;
}): DetectorFinding {
  return {
    detector: input.detector,
    severity: input.severity,
    trigger: input.trigger,
    count: input.count,
    weight: input.weight,
    at: input.at,
    measure: input.measure ?? {},
    ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
  };
}