import { test } from "node:test";
import assert from "node:assert/strict";
import { ShortPatternDetector } from "../src/core/detectors/short-pattern.js";

const now = 1_700_000_000_000;

test("recursion: repeated '递归' is a hard short-pattern finding", () => {
  const d = new ShortPatternDetector(12, 20);
  const hits = d.inspect("递归".repeat(30), now);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.severity, "hard");
  assert.equal(hits[0]!.detector, "short_pattern");
  assert.equal(hits[0]!.count, 30);
});

test("asymptote: 20 repeats is exactly the threshold", () => {
  const d = new ShortPatternDetector(12, 20);
  assert.equal(d.inspect("递归".repeat(20), now).length, 1);
});

test("19 repeats stays below the hard threshold", () => {
  const d = new ShortPatternDetector(12, 20);
  assert.equal(d.inspect("递归".repeat(19), now).length, 0);
});

test("a long repeated comma/punctuation run is caught", () => {
  const d = new ShortPatternDetector(12, 20);
  const hits = d.inspect(".".repeat(25), now);
  assert.ok(hits.length >= 1);
});

test("ordinary prose produces no finding", () => {
  const d = new ShortPatternDetector(12, 20);
  const text = "Let me inspect the store controller and the auth middleware before deciding on a fix path.";
  assert.equal(d.inspect(text, now).length, 0);
});

test("a pattern repeated across chunk boundaries in delta feed is caught", () => {
  const d = new ShortPatternDetector(12, 20);
  assert.equal(d.inspect("递归".repeat(20), now).length, 1);
});

test("pattern longer than maxPatternLength is not reported as repeat", () => {
  const d = new ShortPatternDetector(4, 20);
  assert.equal(d.inspect("abcdef".repeat(20), now).length, 0);
});