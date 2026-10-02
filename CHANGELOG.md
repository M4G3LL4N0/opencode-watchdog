# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-10-02

First tagged release. Everything below is the initial public surface.

### Added

- **Deterministic detector pipeline.** Repeated-token generation, repeated
  sentence/narration loops, repeated tools with no progress, and general
  no-progress activity. Detection uses no model — it is local, rule-based and
  reproducible.
- **Corroboration policy engine.** A single detector does not trip the circuit.
  Detection requires corroboration, which keeps the false-positive rate low on
  legitimate work such as TDD cycles, `pnpm install` output, test-runner
  repetition and long-running tool status.
- **Three action modes.**
  - `observe` — log incidents, take no action (default)
  - `protect` — abort the affected session on detection
  - `recover` — abort, then send a bounded recovery prompt
- **Per-session circuit state.** The breaker is scoped to the session that
  degenerated. Unrelated sessions, and the OpenCode Desktop process, are never
  killed.
- **Server adoption and spawning.** `ocw start` adopts an already-running
  OpenCode server or spawns one. `ocw stop` only ever stops a server this
  process started.
- **Operator tooling.** `status`, `doctor`, `sessions`, `incidents`,
  `incidents mark <id> false-positive`, `stats`, `mode`, `session reset`,
  `config`, `config set`, and `simulate`.
- **Reproducible fixture harness.** `ocw simulate` replays 22 recorded SSE
  fixtures — 9 positive and 13 negative — through the real detector engine, so
  a change to the pipeline is verifiable without a live model.
- **Privacy posture.** No telemetry, no external calls. All processing is local.

### Changed

- Added a committed `pnpm-workspace.yaml` so a fresh clone resolves its own
  lockfile instead of walking up to a parent workspace.

### Verified

- 70 unit tests passing
- 22 fixture scenarios passing (9 positive, 13 negative)
- `tsc --noEmit` clean under `strict`
- `pnpm install && pnpm run build && pnpm run test` green from a clean checkout
- Smoke tested against a live `opencode serve` 1.18.30: adopt, spawn, stop,
  server refusal, `status`, `doctor`, `sessions`, `mode`, `incidents`

[Unreleased]: https://github.com/M4G3LL4N0/opencode-watchdog/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/M4G3LL4N0/opencode-watchdog/releases/tag/v0.1.0
