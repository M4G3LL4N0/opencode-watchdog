import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IncidentLog } from "../src/core/incidents/log.js";
import { newIncidentId, type IncidentRecord } from "../src/core/incidents/incident.js";
import { normalizeOpenCodeEvent } from "../src/adapters/opencode/normalize.js";
import { splitSseChunk, parseSseDataLine } from "../src/adapters/opencode/ingest.js";

function tmpFile(): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ocw-incident-"));
  return { file: join(dir, "incidents.jsonl"), dir };
}

test("incident log: append and read back a record", () => {
  const t = tmpFile();
  try {
    const log = new IncidentLog({ file: t.file, maxBytes: 1_000_000, keepFiles: 2 });
    const rec: IncidentRecord = {
      id: newIncidentId(),
      timestamp: "2026-01-01T00:00:00.000Z",
      epochMs: 1_700_000_000_000,
      watchdogVersion: "0.1.0",
      detector: "short_pattern",
      trigger: "重复 pattern",
      count: 30,
      action: "none",
    };
    log.append(rec);
    const all = log.readAll();
    assert.equal(all.length, 1);
    assert.equal((all[0] as { detector: string }).detector, "short_pattern");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("incident log: rotation truncates when the file exceeds maxBytes", () => {
  const t = tmpFile();
  try {
    const log = new IncidentLog({ file: t.file, maxBytes: 800, keepFiles: 2 });
    for (let i = 0; i < 40; i++) {
      log.append({
        id: newIncidentId(),
        timestamp: "2026-01-01T00:00:00.000Z",
        epochMs: 1_700_000_000_000 + i,
        watchdogVersion: "0.1.0",
        detector: "duplicate_sentence",
        trigger: `${"x".repeat(100)} ${i}`,
        count: 6,
        action: "abort",
      });
    }
    assert.ok(statSync(t.file).size < 4000, "rotated log should stay small");
    const before = readFileSync(t.file, "utf8").length;
    const after = readFileSync(`${t.file}.1`, "utf8").length;
    void before;
    void after;
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("normalize: message.part.delta text vs reasoning", () => {
  const e = normalizeOpenCodeEvent(
    { type: "message.part.delta", properties: { sessionID: "ses_x", partID: "prt_x", messageID: "msg_x", field: "text", delta: "hello" } },
    "token_delta",
  );
  assert.ok(e && !Array.isArray(e));
  assert.equal((e as { kind: string }).kind, "assistantTextDelta");
  const r = normalizeOpenCodeEvent(
    { type: "message.part.delta", properties: { sessionID: "ses_x", partID: "prt_x", field: "reasoning", delta: "think" } },
    "token_delta",
  );
  assert.ok(r && !Array.isArray(r));
  assert.equal((r as { kind: string }).kind, "reasoningTextDelta");
});

test("normalize: server.connected and empty deltas are ignored", () => {
  assert.equal(normalizeOpenCodeEvent({ type: "server.connected", properties: {} }, "token_delta"), null);
  assert.equal(
    normalizeOpenCodeEvent(
      { type: "message.part.delta", properties: { sessionID: "ses_x", field: "text", delta: "" } },
      "token_delta",
    ),
    null,
  );
});

test("normalize: session.status idle and busy", () => {
  const idle = normalizeOpenCodeEvent({ type: "session.status", properties: { sessionID: "ses_x", status: { type: "idle" } } }, "token_delta");
  assert.ok(idle && !Array.isArray(idle));
  assert.equal((idle as { kind: string }).kind, "sessionIdle");
  const busy = normalizeOpenCodeEvent({ type: "session.status", properties: { sessionID: "ses_x", status: { type: "busy" } } }, "token_delta");
  assert.ok(busy && !Array.isArray(busy));
  assert.equal((busy as { kind: string }).kind, "sessionBusy");
});

test("normalize: tool success yields both finished and stdout-observed events", () => {
  const out = normalizeOpenCodeEvent(
    {
      type: "session.next.tool.success",
      properties: { sessionID: "ses_x", toolCallID: "tc1", name: "bash", output: "same line\nsame line\nsame line" },
    },
    "token_delta",
  );
  assert.ok(Array.isArray(out));
  assert.ok(out.some((e) => e.kind === "toolCallFinished" && e.outcome === "success"));
  assert.ok(out.some((e) => e.kind === "toolOutputObserved"));
});

test("normalize: part.updated text produces a snapshot", () => {
  const e = normalizeOpenCodeEvent(
    { type: "message.part.updated", properties: { sessionID: "ses_x", part: { id: "prt1", type: "text", text: "full text", sessionID: "ses_x", messageID: "msg1" } } },
    "part_update",
  );
  assert.ok(e && !Array.isArray(e));
  assert.equal((e as { kind: string }).kind, "assistantTextSnapshot");
  assert.equal((e as { text: string }).text, "full text");
});

test("ingest: SSE data line parsing unwraps data payloads", () => {
  const raw = parseSseDataLine('data: {"payload":{"id":"evt_1","type":"server.connected","properties":{}}}');
  assert.ok(raw && typeof raw === "object");
  assert.equal((raw as { payload: { type: string } }).payload.type, "server.connected");
  assert.equal(parseSseDataLine(": keepalive"), null);
  assert.equal(parseSseDataLine("data: not json"), null);
});

test("ingest: chunks split into complete lines with a correct remainder", () => {
  const { complete, remainder } = splitSseChunk("data: a\ndata: b\ndata: pa");
  assert.deepEqual(complete, ["data: a", "data: b"]);
  assert.equal(remainder, "data: pa");
});