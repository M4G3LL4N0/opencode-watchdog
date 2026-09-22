import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const T = 1_700_000_000_000;

function line(o) {
  return JSON.stringify(o);
}

function base(kind, extra = {}) {
  return { _at: 0, kind, sessionID: "ses_sim", ...extra };
}

function delta(at, d, extra = {}) {
  return { _at: at, kind: "assistantTextDelta", delta: d, sessionID: "ses_sim", ...extra };
}

function snapshot(at, text, extra = {}) {
  return { _at: at, kind: "assistantTextSnapshot", text, sessionID: "ses_sim", ...extra };
}

function toolStarted(at, callID, command, extra = {}) {
  return { _at: at, kind: "toolCallStarted", callID, tool: "bash", input: { command }, sessionID: "ses_sim", ...extra };
}

function toolOutput(at, callID, output, extra = {}) {
  return { _at: at, kind: "toolOutputObserved", callID, tool: "bash", outcomeText: output, sessionID: "ses_sim", ...extra };
}

function toolFinished(at, callID, extra = {}) {
  return { _at: at, kind: "toolCallFinished", callID, tool: "bash", outcome: "success", sessionID: "ses_sim", ...extra };
}

function fileEdit(at, path) {
  return { _at: at, kind: "fileChangeObserved", path, sessionID: "ses_sim" };
}

function progress(at, marker) {
  return { _at: at, kind: "progressObserved", marker, sessionID: "ses_sim" };
}

function writeFixture(name, lines) {
  writeFileSync(join(outDir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

mkdirSync(outDir, { recursive: true });

const multi = (at0, step, text, count, extra) =>
  Array.from({ length: count }, (_, i) => delta(at0 + i * step, text, extra));

// ---- POSITIVE 6: repeated-word-long (hard short_pattern) ----
writeFixture("repeated-word-long.jsonl", [
  { _expect: { detect: true, detector: "short_pattern" } },
  base("sessionCreated"),
  base("sessionBusy"),
  ...multi(0, 300, "loop ", 30),
  progress(9400, "text.ended"),
]);

// ---- POSITIVE 7: repeated-unicode-phrase (hard short_pattern) ----
writeFixture("repeated-unicode-phrase.jsonl", [
  { _expect: { detect: true, detector: "short_pattern" } },
  base("sessionCreated"),
  base("sessionBusy"),
  ...multi(0, 500, "继续执行任务", 24),
  progress(12400, "text.ended"),
]);

// ---- POSITIVE 8: repeated-punctuation (hard short_pattern) ----
writeFixture("repeated-punctuation.jsonl", [
  { _expect: { detect: true, detector: "short_pattern" } },
  base("sessionCreated"),
  base("sessionBusy"),
  ...multi(0, 200, "!!! ", 30),
  progress(6300, "text.ended"),
]);

// ---- POSITIVE 9: mixed-model-repetition-no-progress (composite, model-agnostic) ----
{
  const m1 = { model: "big-pickle", provider: "opencode" };
  const m2 = { model: "grok-4-beta", provider: "xai" };
  const sent = "We fixed the parser contract and re-ran the whole suite. ";
  const lines = [
    { _expect: { detect: true, detector: "duplicate_sentence" } },
    base("sessionCreated", m1),
    base("sessionBusy", m1),
    ...multi(0, 100, sent, 6, m1),
    ...multi(186000, 100, sent, 6, m2),
    ...multi(191000, 100, sent, 6, m1),
    ...multi(196000, 100, sent, 6, m2),
    progress(205000, "text.ended"),
  ];
  writeFixture("mixed-model-repetition-no-progress.jsonl", lines);
}

// ---- NEGATIVE 10: pnpm-install (large varied tool output) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    progress(0, "step.start"),
    toolStarted(100, "call_install", "pnpm install --frozen-lockfile"),
    ...Array.from({ length: 12 }, (_, i) =>
      toolOutput(200 + i * 400, "call_install", `Progress: resolved ${i + 1}${i % 3 === 0 ? " ██" : " ░░"} fetched ${(i + 1) * 12}.0 kB · downloading ${["typescript@5.5.0", "@types/node@22.0.0", "jiti@1.21.0", "typescript@5.5.2"][i % 4]}`),
    ),
    toolOutput(5600, "call_install", "packages +0  files +0  binaries +0  deps +0"),
    toolFinished(5900, "call_install"),
    progress(6000, "step.end"),
    delta(6200, "Dependencies installed cleanly. "),
    delta(6500, "Ready to run the test suite. "),
  ];
  writeFixture("pnpm-install.jsonl", lines);
}

// ---- NEGATIVE 11: typescript-diagnostics (distinct tool output lines) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    toolStarted(0, "call_tsc", "tsc --noEmit --pretty false"),
    ...Array.from({ length: 10 }, (_, i) =>
      toolOutput(100 + i * 300, "call_tsc", `src/file${i % 4}.ts(${10 + i * 3},${i + 2}): error TS2${300 + i * 40}: Type '${["string", "number", "boolean[]", "Record<string,string>"][i % 4]}' is not assignable to type '${["number", "string", "string[]", "Map<string,number>"][(i + 2) % 4]}'.`),
    ),
    toolFinished(3600, "call_tsc", { outcome: "error" }),
    delta(3700, "Fixing the reported type errors now. "),
    delta(4000, "One issue in the serializer, another in the cache. "),
    fileEdit(4300, "src/serialize.ts"),
    progress(4400, "step.start"),
  ];
  writeFixture("typescript-diagnostics.jsonl", lines);
}

// ---- NEGATIVE 12: pytest-runner (test output, distinct, with progress) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    toolStarted(0, "call_pytest", "pytest -q"),
    ...Array.from({ length: 15 }, (_, i) =>
      toolOutput(100 + i * 250, "call_pytest", `tests/test_${["api", "cache", "auth", "io", "retry"][i % 5]}.py ...${i % 3 === 0 ? "F" : "."}`),
    ),
    toolOutput(4100, "call_pytest", "1 failed, 14 passed in 3.42s"),
    toolFinished(4300, "call_pytest", { outcome: "error" }),
    delta(4500, "Assertion in the retry test fails on the third attempt. "),
    delta(4800, "Tracking down the exponential backoff logic. "),
    progress(5000, "step.start"),
  ];
  writeFixture("pytest-runner.jsonl", lines);
}

// ---- NEGATIVE 13: repeated-grep-results (tool stdout isolation) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    toolStarted(0, "call_grep", "grep -rn 'TODO' src"),
    ...Array.from({ length: 14 }, (_, i) =>
      toolOutput(80 + i * 350, "call_grep", `src/feature${i}.ts:${i + 1}:  // TODO: ${["handle the retry", "replace the mock", "add timeouts", "merge branches", "simplify"][i % 5]} in ${["auth", "sync", "billing", "ops", "crypto"][(i * 2) % 5]}`),
    ),
    toolFinished(5400, "call_grep"),
    delta(5600, "Fourteen TODO sites. Picking the billing ones first. "),
    delta(5900, "Started on the sync retry cleanup. "),
  ];
  writeFixture("repeated-grep-results.jsonl", lines);
}

// ---- NEGATIVE 14: progress-bar (tool output churn, distinct) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    toolStarted(0, "call_up", "upgrade"),
    ...Array.from({ length: 12 }, (_, i) =>
      toolOutput(150 + i * 300, "call_up", `[${i + 1}/12] ${["Downloading manifest", "Extracting tarball", "Running migrations", "Compiling vendored libs"][i % 4]} ${(i + 1) * 8}%`),
    ),
    toolFinished(4200, "call_up"),
    delta(4400, "Upgrade finished. "),
    delta(4700, "Time to verify nothing regressed in the CLI. "),
  ];
  writeFixture("progress-bar.jsonl", lines);
}

// ---- NEGATIVE 15: database-rows (distinct rows via tool output) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    toolStarted(0, "call_db", "gh api /orgs/acme/members"),
    ...Array.from({ length: 12 }, (_, i) =>
      toolOutput(100 + i * 280, "call_db", `{"id": ${1000 + i}, "login": "${["alice", "bob", "carol", "dave", "erin"][i % 5]}${i % 2 === 0 ? i : i + 1}"}`),
    ),
    toolFinished(4000, "call_db"),
    delta(4100, "Twelve members in the org. "),
    delta(4400, "Found the admin team I need to contact. "),
  ];
  writeFixture("database-rows.jsonl", lines);
}

// ---- NEGATIVE 16: same-test-different-edits (bounded identical tool calls + edits) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    ...Array.from({ length: 4 }, (_, i) => [
      delta(i * 12000, `Fixing issue #${i + 1}: ${["typo", "timeout", "buffer", "race"][i]}. `),
      fileEdit(i * 12000 + 500, `src/issue${i + 1}.ts`),
      toolStarted(i * 12000 + 900, `call_t${i}`, "pnpm test"),
      toolOutput(i * 12000 + 1600, `call_t${i}`, `${["3 passing", "2 passing", "5 passing", "4 passing"][i]}, 0 failing`),
      toolFinished(i * 12000 + 1700, `call_t${i}`),
    ]).flat(),
    progress(50000, "step.end"),
  ];
  writeFixture("same-test-different-edits.jsonl", lines);
}

// ---- NEGATIVE 17: iterative-debug-cycle (progressing assistant text) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    delta(0, "Traceback points at the session store. "),
    delta(300, "The store is returning an empty list for new keys. "),
    delta(600, "Inspect the merge function. "),
    delta(900, "The merge drops rows when both inputs are identical. "),
    fileEdit(1200, "src/store.ts"),
    toolStarted(1500, "call_a", "node --test store"),
    toolOutput(2000, "call_a", "2 passing, 0 failing"),
    toolFinished(2100, "call_a"),
    delta(2400, "Confirmed fix. Moving on to the export path. "),
    delta(2700, "Export writes schemas then rows. "),
    delta(3000, "Schema row malformed for nested types. "),
    fileEdit(3400, "src/export.ts"),
    progress(3700, "step.start"),
    progress(4000, "step.end"),
    delta(4200, "Nested types serialize correctly now. "),
    delta(4500, "Run the full suite. "),
    toolStarted(4800, "call_b", "pnpm test"),
    toolOutput(5200, "call_b", "all green"),
    toolFinished(5300, "call_b"),
    progress(5600, "text.ended"),
  ];
  writeFixture("iterative-debug-cycle.jsonl", lines);
}

// ---- NEGATIVE 18: long-running-tool-status (long tool, periodic markers) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    toolStarted(0, "call_deploy", "deploy --verbose"),
    ...Array.from({ length: 10 }, (_, i) => {
      const at = 3000 + i * 20000;
      return [
        toolOutput(at, "call_deploy", `stage ${i + 1}/10 ${["build", "test", "image", "push", "rollout"][i % 5]}: ${["ok", "ok", "warning", "ok"][i % 4]}`),
        progress(at + 500, "step.progress"),
      ];
    }).flat(),
    toolFinished(208000, "call_deploy"),
    delta(210000, "Deployment reached the rollout stage. "),
    delta(210300, "Fetching status. "),
    toolStarted(210600, "call_s", "kubectl get pods"),
    toolOutput(211100, "call_s", "api-7d8-86445 1/1 Running"),
    toolFinished(211200, "call_s"),
  ];
  writeFixture("long-running-tool-status.jsonl", lines);
}

// ---- NEGATIVE 19: listed-repeated-examples (10 examples, below hard threshold) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    delta(0, "An illustration uses repeated letters like: "),
    delta(300, "abc abc abc abc abc abc abc abc abc abc"),
    delta(600, "That is exactly ten repetitions, well within normal bounds. "),
    delta(900, "And briefly: ok ok ok ok ok. "),
    delta(1200, "All within limits. "),
    progress(1500, "text.ended"),
  ];
  writeFixture("listed-repeated-examples.jsonl", lines);
}

// ---- NEGATIVE 20: normal-unicode-prose (normal Chinese prose) ----
{
  const lines = [
    { _expect: { detect: false } },
    base("sessionCreated"),
    base("sessionBusy"),
    delta(0, "先检查了配置文件的加载顺序，发现默认值覆盖的顺序反了。"),
    delta(1500, "修正后重新读取环境变量，确认端口与主机都来自环境。"),
    delta(3000, "接着验证了健康检查的返回值，服务端返回了预期的版本号。"),
    delta(4500, "再看消息轮询的批次大小，当前限制在八个会话以内。"),
    delta(6000, "最后跑了一遍回归测试，全部通过，没有任何退化。"),
    progress(7500, "text.ended"),
  ];
  writeFixture("normal-unicode-prose.jsonl", lines);
}

console.log("fixtures written to", outDir);