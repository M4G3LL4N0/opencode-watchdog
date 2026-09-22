import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchdogRuntime } from "../src/core/runtime/runtime.js";
import { RecordingController } from "../src/cli/simulate.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import type { WatchdogConfig } from "../src/config/config.js";
import type { WatchdogEvent } from "../src/core/events/types.js";
import { watchdogStateDir } from "../src/util/paths.js";
import { enqueueSessionReset } from "../src/core/control/reset.js";

const T0 = 1_700_000_000_000;

function cfg(mode: WatchdogConfig["mode"]): WatchdogConfig {
  return { ...DEFAULT_CONFIG, mode, logRetentionBytes: 1_000_000 };
}

function withIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "ocw-circuit-"));
  const prevS = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(dir, "state");
  return {
    cleanup: () => {
      if (prevS === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prevS;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function burst(runtime: WatchdogRuntime, sessionID: string, at: number, delta = "递归"): void {
  runtime.ingest({ kind: "sessionCreated", sessionID, transport: "token_delta", receivedAt: at });
  for (let i = 0; i < 30; i++) {
    runtime.ingest({ kind: "assistantTextDelta", delta, sessionID, transport: "token_delta", receivedAt: at + i });
  }
}

test("circuit: the second trip within the window opens the circuit and marks the incident", async () => {
  const iso = withIsolation();
  try {
    const controller = new RecordingController();
    const runtime = new WatchdogRuntime({ config: cfg("protect"), controller });
    burst(runtime, "ses_x", T0);
    await runtime.waitForActions();
    burst(runtime, "ses_x", T0 + 120_000);
    await runtime.waitForActions();
    const stats = runtime.getStats();
    assert.equal(stats.trips, 2);
    const session = stats.sessions.find((s) => s.sessionID === "ses_x");
    assert.equal(session?.circuit, "open");
    assert.ok(session?.circuitOpenedSince !== undefined);
    assert.ok(session.circuitOpenedSince >= T0 && session.circuitOpenedSince < T0 + 30);
    const second = runtime.getLoggedIncidents().slice(-1)[0] as { circuitOpened?: boolean };
    assert.equal(second.circuitOpened, true);
  } finally {
    iso.cleanup();
  }
});

test("circuit: an open circuit suppresses further trips and aborts", async () => {
  const iso = withIsolation();
  try {
    const controller = new RecordingController();
    const runtime = new WatchdogRuntime({ config: cfg("protect"), controller });
    burst(runtime, "ses_x", T0);
    await runtime.waitForActions();
    burst(runtime, "ses_x", T0 + 120_000);
    await runtime.waitForActions();
    burst(runtime, "ses_x", T0 + 400_000);
    await runtime.waitForActions();
    const stats = runtime.getStats();
    assert.equal(stats.trips, 2);
    assert.equal(controller.aborts.length, 2);
  } finally {
    iso.cleanup();
  }
});

test("circuit: a queued session reset closes the circuit and restores trips", async () => {
  const iso = withIsolation();
  try {
    const controller = new RecordingController();
    const runtime = new WatchdogRuntime({ config: cfg("protect"), controller });
    burst(runtime, "ses_x", T0);
    await runtime.waitForActions();
    burst(runtime, "ses_x", T0 + 120_000);
    await runtime.waitForActions();
    const firstTripState = runtime.getStats().sessions[0] as NonNullable<ReturnType<WatchdogRuntime["getStats"]>["sessions"][0]>;
    assert.equal(firstTripState.circuit, "open");
    enqueueSessionReset(watchdogStateDir(), "ses_x");
    runtime.tick();
    const afterReset = runtime.getStats().sessions[0] as NonNullable<ReturnType<WatchdogRuntime["getStats"]>["sessions"][0]>;
    assert.equal(afterReset.circuit, "closed");
    burst(runtime, "ses_x", T0 + 300_000);
    await runtime.waitForActions();
    assert.equal(runtime.getStats().trips, 3);
  } finally {
    iso.cleanup();
  }
});

test("circuit: degeneration in one session leaves another untouched", async () => {
  const iso = withIsolation();
  try {
    const controller = new RecordingController();
    const runtime = new WatchdogRuntime({ config: cfg("protect"), controller });
    const healthy: WatchdogEvent[] = [];
    for (let i = 0; i < 20; i++) {
      healthy.push({ kind: "assistantTextDelta", delta: `line ${i} varies here. `, sessionID: "ses_ok", transport: "token_delta", receivedAt: T0 + i * 10 });
    }
    burst(runtime, "ses_bad", T0 + 100_000);
    for (const e of healthy) runtime.ingest(e);
    await runtime.waitForActions();
    assert.deepEqual(controller.aborts, ["ses_bad"]);
    const ok = runtime.getStats().sessions.find((s) => s.sessionID === "ses_ok");
    assert.equal(ok?.tripCount, 0);
    assert.equal(ok?.circuit, "closed");
  } finally {
    iso.cleanup();
  }
});