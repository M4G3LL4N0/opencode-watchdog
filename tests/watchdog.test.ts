import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchdogRuntime, RECOVERY_INSTRUCTION } from "../src/core/runtime/runtime.js";
import { RecordingController } from "../src/cli/simulate.js";
import type { WatchdogConfig } from "../src/config/config.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import type { WatchdogEvent } from "../src/core/events/types.js";

const T0 = 1_700_000_000_000;

function cfg(mode: WatchdogConfig["mode"]): WatchdogConfig {
  return { ...DEFAULT_CONFIG, mode, logRetentionBytes: 1_000_000 };
}

function withIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "ocw-runtime-"));
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

const meta: Omit<WatchdogEvent, "kind"> = {
  sessionID: "ses_w",
  transport: "token_delta",
  receivedAt: T0,
  model: "big-pickle",
  provider: "opencode",
};

test("watchdog: observe mode logs an incident for the repetition but takes no action", async () => {
  const iso = withIsolation();
  try {
    const controller = new RecordingController();
    const runtime = new WatchdogRuntime({ config: cfg("observe"), controller, opencodeVersion: "1.18.30" });
    for (let i = 0; i < 30; i++) {
      runtime.ingest({ kind: "assistantTextDelta", delta: "递归", ...meta, receivedAt: T0 + i });
    }
    await runtime.waitForActions();
    const stats = runtime.getStats();
    assert.equal(stats.trips, 1);
    assert.equal(stats.incidents, 1);
    assert.equal(controller.aborts.length, 0);
    const incident = runtime.getLoggedIncidents()[0] as { detector: string; action: string; sessionID: string };
    assert.equal(incident.detector, "short_pattern");
    assert.equal(incident.action, "none");
    assert.equal(incident.sessionID, "ses_w");
  } finally {
    iso.cleanup();
  }
});

test("watchdog: protect mode aborts only the affected session", async () => {
  const iso = withIsolation();
  try {
    const controller = new RecordingController();
    const runtime = new WatchdogRuntime({ config: cfg("protect"), controller });
    runtime.ingest({ kind: "sessionCreated", ...meta });
    for (let i = 0; i < 30; i++) {
      runtime.ingest({ kind: "assistantTextDelta", delta: "递归", ...meta, receivedAt: T0 + i });
    }
    await runtime.waitForActions();
    assert.deepEqual(controller.aborts, ["ses_w"]);
    const incident = runtime.getLoggedIncidents()[0] as { abortResult: { ok: boolean } };
    assert.equal(incident.abortResult.ok, true);
  } finally {
    iso.cleanup();
  }
});

test("watchdog: recover mode aborts then sends a recovery prompt once", async () => {
  const iso = withIsolation();
  try {
    const controller = new RecordingController();
    const runtime = new WatchdogRuntime({ config: cfg("recover"), controller });
    for (let i = 0; i < 30; i++) {
      runtime.ingest({ kind: "assistantTextDelta", delta: "递归", ...meta, receivedAt: T0 + i });
    }
    await runtime.waitForActions();
    assert.deepEqual(controller.aborts, ["ses_w"]);
    assert.deepEqual(controller.recoveries, ["ses_w"]);
  } finally {
    iso.cleanup();
  }
});

test("watchdog: repetitive tool stdout is never fed to text detectors", async () => {
  const iso = withIsolation();
  try {
    const controller = new RecordingController();
    const runtime = new WatchdogRuntime({ config: cfg("protect"), controller });
    runtime.ingest({ kind: "sessionBusy", ...meta });
    const out = "trace busy\nallocation  0 ms\nalloc 42\nsites 17\n";
    runtime.ingest({ kind: "toolCallStarted", callID: "c1", tool: "bash", input: { command: "x" }, ...meta, receivedAt: T0 + 10 });
    for (let i = 0; i < 12; i++) {
      runtime.ingest({ kind: "toolOutputObserved", callID: "c1", tool: "bash", outcomeText: out, ...meta, receivedAt: T0 + 10 + i });
    }
    runtime.ingest({ kind: "toolCallFinished", callID: "c1", tool: "bash", outcome: "success", ...meta, receivedAt: T0 + 40 });
    runtime.tickAt(T0 + 50_000);
    await runtime.waitForActions();
    const stats = runtime.getStats();
    assert.equal(stats.trips, 0);
    assert.equal(stats.findingsByDetector["short_pattern"] ?? 0, 0);
    assert.equal(controller.aborts.length, 0);
  } finally {
    iso.cleanup();
  }
});

test("watchdog: recovery is bounded to one automatic prompt per window", async () => {
  const iso = withIsolation();
  try {
    const controller = new RecordingController();
    const runtime = new WatchdogRuntime({ config: cfg("recover"), controller });
    runtime.ingest({ kind: "sessionCreated", ...meta });
    for (let i = 0; i < 30; i++) {
      runtime.ingest({ kind: "assistantTextDelta", delta: "递归", ...meta, receivedAt: T0 + i });
    }
    await runtime.waitForActions();
    assert.equal(runtime.getStats().recoveries, 1);
    for (let i = 0; i < 40; i++) {
      runtime.ingest({ kind: "assistantTextDelta", delta: "!!", ...meta, receivedAt: T0 + 300_000 + i });
    }
    await runtime.waitForActions();
    assert.equal(runtime.getStats().trips, 2);
    const second = runtime.getLoggedIncidents().slice(-1)[0] as { recoveryAttempted?: boolean; recoveryResult?: { ok: boolean; reason?: string } };
    assert.equal(second.recoveryAttempted, false);
    assert.equal(second.recoveryResult?.ok, false);
    assert.equal(controller.recoveries.length, 1);
  } finally {
    iso.cleanup();
  }
});

test("watchdog: recovery instruction constant is scoped and explicit", () => {
  assert.match(RECOVERY_INSTRUCTION, /interrupted/);
  assert.equal(RECOVERY_INSTRUCTION.includes("git reset"), false);
  assert.equal(RECOVERY_INSTRUCTION.includes("git checkout"), false);
});