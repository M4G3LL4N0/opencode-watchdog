import { test } from "node:test";
import assert from "node:assert/strict";
import { WordDiversityDetector } from "../src/core/detectors/low-diversity.js";
import { ShortPatternDetector } from "../src/core/detectors/short-pattern.js";
import { DuplicateSentenceDetector } from "../src/core/detectors/duplicate-sentence.js";
import { NarrationDetector } from "../src/core/detectors/near-duplicate-narration.js";

const now = 1_700_000_000_000;

test("low diversity: a single dominating unigram is detected", () => {
  const d = new WordDiversityDetector();
  const text = `${"reboot ".repeat(250)}handling`;
  const hits = d.analyze(text, now);
  const found = hits.find((h) => h.detector === "low_diversity");
  assert.ok(found, "expected a low_diversity finding");
  assert.equal(found.severity, "composite");
});

test("low diversity: 200+ tokens and a dominating bigram", () => {
  const d = new WordDiversityDetector();
  const text = "apply patch apply patch ".repeat(120) + "then verify.";
  const hits = d.analyze(text, now);
  assert.ok(hits.some((h) => h.detector === "low_diversity"));
});

test("low diversity: healthy, varied prose is not flagged", () => {
  const d = new WordDiversityDetector();
  const sentences = [
    "We refactored the store module and added a test for the fallback path.",
    "The middleware now returns a typed error instead of swallowing failures.",
    "After the change the whole suite passed on the first run which felt great.",
    "We also updated the migration script and the seed data for staging.",
    "The release notes mention the new retry semantics and cache reuse.",
  ];
  const text = sentences.join(" ").repeat(2);
  const hits = d.analyze(text, now);
  assert.equal(hits.filter((h) => h.detector === "low_diversity").length, 0);
});

test("short pattern punctuation collapse is not confused with diversity text detectors", () => {
  const d = new ShortPatternDetector(12, 20);
  assert.equal(d.inspect("...........", now).length, 0);
});

test("duplicate sentences: 6 identical sentences are reported", () => {
  const d = new DuplicateSentenceDetector(6);
  for (let i = 0; i < 6; i++) d.addText("We fixed the parser and re-ran the suite.", now + i);
  const hits = d.find(now + 10_000);
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.detector === "duplicate_sentence"));
});

test("duplicate sentences: 5 identical sentences stay below the threshold", () => {
  const d = new DuplicateSentenceDetector(6);
  for (let i = 0; i < 5; i++) d.addText("We fixed the parser and re-ran the suite.", now + i);
  assert.equal(d.find(now + 10_000).length, 0);
});

test("narration: four near-identical utterances with no action between are detected", () => {
  const d = new NarrationDetector();
  const base = "We should prioritize the X markets for the new product rollout in the Asian region this quarter.";
  const variants = ["key", "core", "main", "major"].map((w) => base.replace("X", w));
  variants.forEach((v, i) => d.onUtterance(v, now + i * 1000, 0));
  const hits = d.find(now + 10_000);
  assert.ok(hits.some((h) => h.detector === "near_duplicate_narration"));
});

test("narration: filesystem actions between utterances suppress the detector", () => {
  const d = new NarrationDetector();
  const base = "We should prioritize the X markets for the new product rollout in the Asian region this quarter.";
  const variants = ["key", "core", "main", "major"].map((w) => base.replace("X", w));
  variants.forEach((v, i) => d.onUtterance(v, now + i * 1000, now + i * 900));
  assert.equal(d.find(now + 10_000).length, 0);
});