import { test } from "node:test";
import assert from "node:assert/strict";
import { PolicyEngine } from "../src/core/policy/policy.js";
import { SessionBreaker } from "../src/core/policy/breaker.js";
import { finding } from "../src/core/detectors/detector.js";

const now = 1_700_000_000_000;
const engine = (threshold = 1.5) =>
  new PolicyEngine({ compositeTripThreshold: threshold, activeWindowMs: 60_000 });

test("policy: a hard finding trips regardless of threshold", () => {
  const d = engine(99);
  const decision = d.decide(
    [finding({ detector: "short_pattern", severity: "hard", trigger: "t", count: 30, weight: 1, at: now })],
    now,
  );
  assert.equal(decision.trip, true);
  assert.equal(decision.kind, "hard");
});

test("policy: corroborated composite findings trip", () => {
  const d = engine(1.5);
  const decision = d.decide(
    [
      finding({ detector: "duplicate_sentence", severity: "composite", trigger: "t", count: 6, weight: 0.9, at: now }),
      finding({ detector: "near_duplicate_narration", severity: "composite", trigger: "t", count: 4, weight: 0.6, at: now }),
    ],
    now,
  );
  assert.equal(decision.trip, true);
  assert.equal(decision.kind, "composite");
  assert.ok(decision.totalScore >= 1.5);
});

test("policy: a lone weak composite finding does not trip", () => {
  const d = engine(1.5);
  const decision = d.decide([finding({ detector: "tool_loop", severity: "composite", trigger: "t", count: 5, weight: 0.8, at: now })], now);
  assert.equal(decision.trip, false);
});

test("policy: stale composite findings outside the active window are excluded", () => {
  const d = engine(1.5);
  const old = now - 120_000;
  const decision = d.decide(
    [
      finding({ detector: "duplicate_sentence", severity: "composite", trigger: "t", count: 6, weight: 0.9, at: old }),
      finding({ detector: "near_duplicate_narration", severity: "composite", trigger: "t", count: 4, weight: 0.6, at: old }),
    ],
    now,
  );
  assert.equal(decision.trip, false);
});

test("breaker: repeated trips within the cooldown do not double-act", () => {
  const b = new SessionBreaker(60_000);
  assert.equal(b.recordTrip(now), true);
  assert.equal(b.recordTrip(now + 5_000), false);
  assert.equal(b.recordTrip(now + 60_000), true);
});

test("breaker: isOpen reflects the suppression window", () => {
  const b = new SessionBreaker(60_000);
  b.recordTrip(now);
  assert.equal(b.isOpen(now + 30_000), true);
  assert.equal(b.isOpen(now + 90_000), false);
});