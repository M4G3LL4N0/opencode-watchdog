import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolLoopDetector } from "../src/core/detectors/tool-loop.js";
import { NoProgressDetector } from "../src/core/detectors/no-progress.js";

const now = 1_700_000_000_000;
const meta = {
  sessionID: "ses_t",
  transport: "token_delta" as const,
  receivedAt: now,
};

function started(callID: string, at: number, input?: Record<string, unknown>) {
  return { kind: "toolCallStarted" as const, callID, tool: "bash", input: input ?? { command: "git status --porcelain" }, ...meta, receivedAt: at };
}
function finished(callID: string, at: number, tool = "bash") {
  return { kind: "toolCallFinished" as const, callID, tool, outcome: "success" as const, ...meta, receivedAt: at };
}

test("tool loop: five identical finished calls are detected", () => {
  const d = new ToolLoopDetector({ threshold: 4, windowMs: 90_000 });
  for (let i = 0; i < 5; i++) {
    d.onEvent(started(`c${i}`, now + i * 2000));
    d.onEvent(finished(`c${i}`, now + i * 2000 + 500));
  }
  const hits = d.find(now + 20_000);
  assert.ok(hits.some((h) => h.detector === "tool_loop"));
  const hit = hits.find((h) => h.detector === "tool_loop")!;
  assert.equal(hit.count, 5);
});

test("tool loop: identical calls interleaved with a file edit are suppressed", () => {
  const d = new ToolLoopDetector({ threshold: 4, windowMs: 90_000 });
  for (let i = 0; i < 5; i++) {
    d.onEvent(started(`c${i}`, now + i * 2000));
    d.onEvent(finished(`c${i}`, now + i * 2000 + 500));
    d.onEvent({ kind: "fileChangeObserved", path: "src/x.ts", ...meta, receivedAt: now + i * 2000 + 900 });
  }
  assert.equal(d.find(now + 20_000).length, 0);
});

test("tool loop: alternating different tools is not a loop", () => {
  const d = new ToolLoopDetector({ threshold: 4, windowMs: 90_000 });
  for (let i = 0; i < 5; i++) {
    const tool = i % 2 === 0 ? "edit" : "grep";
    d.onEvent(started(`c${i}`, now + i * 2000, tool === "edit" ? { filePath: "a.ts" } : { pattern: "x" }));
    d.onEvent(finished(`c${i}`, now + i * 2000 + 500, tool));
  }
  assert.equal(d.find(now + 20_000).length, 0);
});

test("no progress: busy session with no activity past the deadline is detected", () => {
  const d = new NoProgressDetector(180);
  d.onEvent({ kind: "sessionBusy", ...meta, receivedAt: now });
  d.onEvent({ kind: "assistantTextDelta", delta: "start", ...meta, receivedAt: now + 1000 });
  const hits = d.find(now + 190_000);
  assert.ok(hits.some((h) => h.detector === "no_progress"));
});

test("no progress: continued activity suppresses the detector", () => {
  const d = new NoProgressDetector(180);
  d.onEvent({ kind: "sessionBusy", ...meta, receivedAt: now });
  for (let i = 1; i <= 4; i++) {
    d.onEvent({ kind: "assistantTextDelta", delta: `tick ${i}`, ...meta, receivedAt: now + i * 60_000 });
  }
  assert.equal(d.find(now + 250_000).length, 0);
});

test("no progress: an active tool delays the deadline", () => {
  const d = new NoProgressDetector(180);
  d.onEvent({ kind: "sessionBusy", ...meta, receivedAt: now });
  d.onEvent({ kind: "toolCallStarted", callID: "c1", tool: "bash", input: {}, ...meta, receivedAt: now + 1000 });
  assert.equal(d.find(now + 250_000).length, 0);
});