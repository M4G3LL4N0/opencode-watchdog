import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueSessionReset, drainSessionResets, readSessionResets, resetFile } from "../src/core/control/reset.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ocw-reset-"));
}

test("reset: enqueue then drain round-trips the session id", () => {
  const dir = freshDir();
  try {
    enqueueSessionReset(dir, "ses_a");
    assert.deepEqual(drainSessionResets(dir), ["ses_a"]);
    assert.deepEqual(drainSessionResets(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: duplicate queued ids drain once", () => {
  const dir = freshDir();
  try {
    enqueueSessionReset(dir, "ses_dup");
    enqueueSessionReset(dir, "ses_dup");
    assert.deepEqual(drainSessionResets(dir), ["ses_dup"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: malformed lines are ignored", () => {
  const dir = freshDir();
  try {
    writeFileSync(resetFile(dir), '"not-json"\n{}\n');
    assert.deepEqual(drainSessionResets(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: readSessionResets is non-draining", () => {
  const dir = freshDir();
  try {
    enqueueSessionReset(dir, "ses_keep");
    assert.equal(readSessionResets(dir).length, 1);
    assert.deepEqual(drainSessionResets(dir), ["ses_keep"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reset: missing file drains and reads empty", () => {
  const dir = freshDir();
  try {
    assert.deepEqual(drainSessionResets(dir), []);
    assert.deepEqual(readSessionResets(dir), []);
    assert.equal(existsSync(resetFile(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});