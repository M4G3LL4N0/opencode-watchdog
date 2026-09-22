import { test } from "node:test";
import assert from "node:assert/strict";
import { SnapshotDeduper, canonicalSnapshotKey, classifyFeed } from "../src/adapters/opencode/ingest.js";

test("ingest: canonical snapshot key is distinct per session/message/part/channel", () => {
  const a = canonicalSnapshotKey("s", "m", "p", "assistant");
  assert.notEqual(a, canonicalSnapshotKey("s", "m", "p", "reasoning"));
  assert.notEqual(a, canonicalSnapshotKey("s2", "m", "p", "assistant"));
  assert.notEqual(a, canonicalSnapshotKey("s", "m2", "p", "assistant"));
  assert.notEqual(a, canonicalSnapshotKey("s", "m", "p2", "assistant"));
  assert.equal(a, canonicalSnapshotKey("s", "m", "p", "assistant"));
});

test("ingest: SnapshotDeduper drops identical text for the same part", () => {
  const d = new SnapshotDeduper();
  const key = canonicalSnapshotKey("s", "m", "p", "assistant");
  assert.equal(d.observe(key, "same text"), true);
  assert.equal(d.observe(key, "same text"), false);
  assert.equal(d.observe(key, "different text"), true);
  assert.equal(d.observe(key, "different text"), false);
});

test("ingest: SnapshotDeduper treats distinct keys independently", () => {
  const d = new SnapshotDeduper();
  for (const n of [1, 2, 3]) {
    const key = canonicalSnapshotKey(`s${n}`, `m${n}`, `p${n}`, "assistant");
    assert.equal(d.observe(key, "x"), true);
    assert.equal(d.observe(key, "x"), false);
  }
});

test("ingest: SnapshotDeduper evicts the whole map at the bound", () => {
  const d = new SnapshotDeduper(2);
  const k1 = canonicalSnapshotKey("s1", "m", "p", "assistant");
  const k2 = canonicalSnapshotKey("s2", "m", "p", "assistant");
  const k3 = canonicalSnapshotKey("s3", "m", "p", "assistant");
  d.observe(k1, "t1");
  d.observe(k2, "t2");
  assert.equal(d.size, 2);
  d.observe(k3, "t3");
  assert.equal(d.size, 1);
  assert.equal(d.observe(k1, "t1"), true);
});

test("ingest: classifyFeed maps transport capability correctly", () => {
  assert.equal(classifyFeed({ sseAlive: false, deltaSeen: false, snapshotSeen: false }), "message_poll_fallback");
  assert.equal(classifyFeed({ sseAlive: true, deltaSeen: true, snapshotSeen: false }), "token_delta");
  assert.equal(classifyFeed({ sseAlive: true, deltaSeen: false, snapshotSeen: true }), "part_update");
  assert.equal(classifyFeed({ sseAlive: true, deltaSeen: false, snapshotSeen: false }), "token_delta");
});