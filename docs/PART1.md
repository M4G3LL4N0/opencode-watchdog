# OpenCode Watchdog — Part 1 Report

Status: PASS (47/47 unit tests, 7/7 simulation fixtures). Live-server protocol
verification deferred to Part 2 (requires an active OpenCode server; the local
desktop server test is queued for the next phase).

## 1. What was built

A deterministic, local, model-agnostic watchdog + circuit breaker for OpenCode
Desktop and CLI sessions. It consumes a normalized event stream, runs bounded-memory
degeneration detectors, and takes policy-driven action: log-only (observe),
abort (protect), or abort + bounded recovery prompt (recover).

Location: `/Users/matador/startups/opencode-watchdog/`

## 2. Architecture

```
src/
  core/
    events/types.ts            normalized WatchdogEvent union + TransportKind
    buffers/buffers.ts         RingBuffer / RollingWindow / BoundedString
    detectors/
      detector.ts              finding envelope (severity/weight/measure/excerpt)
      similarity.ts            tokenize / sentenceSplit / jaccard / sanitize / redact
      short-pattern.ts         A: terminal uniform run (hard)
      duplicate-sentence.ts    B: repeated identical sentence (composite 0.9)
      near-duplicate-narration.ts  C: near-dup narration w/o action (0.6)
      low-diversity.ts         D: low word diversity (0.4)
      tool-loop.ts             E: repeated identical tool calls (0.8)
      no-progress.ts           F: long silence (>180s) (0.5)
      text-channel.ts          bounded text acc + point watermark; delta/snapshot/flush
    policy/policy.ts           hard trip OR composite weight sum >= threshold
    policy/breaker.ts          per-session cooldown (60s)
    incidents/incident.ts      IncidentRecord + id
    incidents/log.ts           JSONL append / read / size rotate (.1/.2)
    recovery/recovery.ts       window-bounded auto-recovery (1/600s)
    runtime/scope.ts           per-session detector wiring + boundary kinds
    runtime/runtime.ts         WatchdogRuntime (ingest/tick/tickAt/evaluate/runAction)
  config/config.ts             DEFAULT_CONFIG, OCW_* env overrides, load/save/validate
  adapters/opencode/           client / capabilities / normalize / ingest / abort / adapter
  server/manager.ts            spawn/adopt OpenCode server, port scan, pid files
  cli/index.ts                 command surface (11 commands)
  cli/simulate.ts              fixture runner (RecordingController)
  util/paths.ts                XDG config/state dirs
  util/ansi.ts                 colorize/cross (NO_COLOR aware)
fixtures/*.jsonl               7 scenarios
tests/*.test.ts                47 tests
bin/ocw.js                     CLI entry
```

## 3. Detection semantics (corrected during Part 1)

- Dropped the "entire suffix is one pattern" rule. `scanTail` now detects a
  **terminal uniform run**: a repeated chunk `L` (1..12 chars shown) ending at
  the current tail, `repeats >= 20` → hard finding. Older divergent text no
  longer poisons detection of an ongoing degenerate run.
- **Composite corroboration is cross-instant, not per-evaluate.** Composite
  findings (dup 0.9, narration 0.6, diversity 0.4, tool-loop 0.8, no-progress
  0.5) each fire once at their trigger moment. The runtime accumulates one
  finding **per detector** over `activeWindowSeconds` (60s) and ships that
  window to `PolicyEngine.decide`, which trips when the sum >= 1.5. No single
  composite detector can trip alone by design; fixtures exercise 2–3
  corroborating signals.
- **Channel separation:** tool stdout streams to `toolOutputObserved` only and
  is never fed to text detectors A–D (validated by `repetitive-tool-stdout`,
  expect=none).
- After a trip the session detector state is reset so a second, different
  degeneration pattern can trip again (validated by two-burst tests).
- Snapshot dedup: identical full-text snapshot replays are treated as no-ops
  (SSE polling idempotency); deltas are the authoritative accumulation path.

## 4. Safety properties

- Only safe control path used: `POST /session/{id}/abort`; recovery via
  `POST /session/{sessionID}/prompt_async` with a fixed instruction constant
  (`RECOVERY_INSTRUCTION`). Never git operations, never kill Desktop.
- Server is stopped/written only when watchdog-managed (pidfile).
- Basic-auth credentials read from env, never logged; incident triggers are
  redacted via `sanitize`.
- Recovery bounded: max 1 auto-recovery per session per 600s window.

## 5. Verification results

- `pnpm run build` (tsc, strict) — clean.
- `pnpm run test` — 47/47 pass (`node --test dist/tests/**/*.test.js`).
- `ocw simulate` with clean state (one scenario per state dir):

```
scenario                        inc trips aborts  ok
duplicate-sentences               2     2     0  PASS expect=duplicate_sentence
legitimate-tdd                    0     0     0  PASS expect=none
raw-opencode-session              1     1     0  PASS expect=short_pattern
recursion-loop                    1     1     0  PASS expect=short_pattern
repetitive-tool-stdout            0     0     0  PASS expect=none
silent-stall                      2     2     0  PASS expect=any
tool-loop                         1     1     0  PASS expect=duplicate_sentence
```

- `ocw doctor` / `ocw status` degrade gracefully with no server reachable;
  feed recommendation reported via `doctor`.

## 6. Known limitations / Part 2 handoff

1. **Live protocol verification pending.** Adapter shapes were implemented from
   `/tmp/oc-openapi.json` (OpenAPI 162 paths/472 schemas) rather than a live
   server capture. Next: run `ocw start`, sniff one real SSE capture into
   `fixtures/raw-opencode-session.jsonl`, and confirm normalize covers
   `message.part.delta` (field text/reasoning), `part.updated`, `session.status`
   idle/busy/retry, and `session.next.*` in vivo.
2. `opencode attach` / `opencode run` real syntax still unverified
   (`--help` is broken in 1.18.30). Desktop connection instructions in
   `ocw desktop` are provisional.
3. `ocw start` host/bind port scan (4096 → +10) implemented but not exercised
   against a genuine second server.
4. Feed failover (token_delta → part_update → message_poll_fallback) is coded
   but only partially covered in tests.
5. No paid model usage was triggered during Part 1 (fixtures + OpenAPI only).

## 7. Files

Root: `package.json`, `tsconfig.json`, `bin/ocw.js`, `.gitignore`.
Source: see tree in §2. Tests: `tests/*.test.ts`. Fixtures: `fixtures/*.jsonl`.
Authoritative API reference: `/tmp/oc-openapi.json`.