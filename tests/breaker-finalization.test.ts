import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionBreaker } from "../src/core/policy/breaker.js";

const now = 1_700_000_000_000;

test("breaker: second trip within the recovery window opens the circuit", () => {
  const b = new SessionBreaker(60_000, 600_000);
  const first = b.recordTripDetailed(now);
  assert.deepEqual(first, { allowed: true, openedNow: false });
  const second = b.recordTripDetailed(now + 120_000);
  assert.deepEqual(second, { allowed: true, openedNow: true });
  assert.equal(b.stateName(), "open");
  assert.equal(b.openedSince(), now);
});

test("breaker: a trip outside the recovery window does not open on its own", () => {
  const b = new SessionBreaker(60_000, 600_000);
  b.recordTripDetailed(now);
  const later = b.recordTripDetailed(now + 700_000);
  assert.deepEqual(later, { allowed: true, openedNow: false });
  assert.equal(b.stateName(), "closed");
  assert.equal(b.tripCount(), 1);
});

test("breaker: an open circuit suppresses all further trips until reset", () => {
  const b = new SessionBreaker(60_000, 600_000);
  b.recordTripDetailed(now);
  b.recordTripDetailed(now + 120_000);
  const suppressed = b.recordTripDetailed(now + 1_000_000);
  assert.deepEqual(suppressed, { allowed: false, openedNow: false });
  assert.equal(b.isOpen(now + 1_000_000), true);
});

test("breaker: reset closes the circuit and clears the trip log", () => {
  const b = new SessionBreaker(60_000, 600_000);
  b.recordTripDetailed(now);
  b.recordTripDetailed(now + 120_000);
  assert.equal(b.stateName(), "open");
  b.reset();
  assert.equal(b.stateName(), "closed");
  assert.equal(b.tripCount(), 0);
  assert.equal(b.isOpen(now + 130_000), false);
  const again = b.recordTripDetailed(now + 200_000);
  assert.equal(again.allowed, true);
  assert.equal(again.openedNow, false);
});

test("breaker: the cooldown gates trips, then re-arms at the boundary", () => {
  const b = new SessionBreaker(60_000);
  assert.equal(b.recordTrip(now), true);
  assert.equal(b.recordTrip(now + 5_000), false);
  assert.equal(b.recordTrip(now + 60_000), true);
  assert.equal(b.stateName(), "open");
  assert.equal(b.isOpen(now + 60_000), true);
});