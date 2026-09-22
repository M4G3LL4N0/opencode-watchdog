# OpenCode Watchdog — Part 2 Final Report

Status: **PASS** with live-server coverage. 70/70 unit/integration tests, 22/22
simulate fixtures (9 positive + 13 negative), plus a *live* smoke against the
real `opencode serve` binary (adopt, spawn, safe stop, status/doctor/sessions/
mode/incidents, simulate). No paid model usage, no orphan-Keep-Alive permanent
servers left behind by *this* watchdog.

> Requires: `opencode serve` binary present (probed via `ocw doctor`), node 22.
> Read `Part 1` for the detector/policy foundation (Part1 doc).

## Part 2 scope delivered

1. **Shared-server manager** (`src/server/manager.ts`)
   - `managed.json` single source of truth: `{host, port, adopted, pid?,
     opencodeVersion?, startedAt, source: spawned|adopted}`.
   - `ocw start` resolves the *effective endpoint* via the manager: if a server
     already runs on the configured port it is **adopted** (never the
     watchdog's server, never later killed); optionally we spawn one on the
     now-free port. Safe `ocw stop` only kills a server whose `source=spawned`
     pid is recorded and owned; it **refuses to stop adopted/external ones**.
   - `ocw watch` watches an external (config-port) server and never manages it.
   - Persisted under `XDG_STATE_HOME` (real-machine smoke used an isolated
     temp state dir, so the desktop's live state directory is untouched).
2. **Live OpenCode adapter + authenticating HTTP client**
   - `OcHttpClient` speaks auth (`OPENCODE_SERVER_USERNAME/PASSWORD`),
     polls `/session/health` and `/session`, and issues `POST .../abort` /
     `prompt_async` / `message` polling only against the *adopted or spawned*
     server.
   - `probeCapabilities` + `recommendTransport` now exercised against a live
     real server: Banner: endpoint 127.0.0.1:4096, transport=token_delta.
3. **Session model enrichment** — `sessionMetaObserved` event kind; runtime
   sessions now carry `model`, `provider`, `project`, `directory`, `title`.
4. **Circuit breaker finalization**
   - 2nd confirmed trip within the recovery window opens the circuit and marks
     the incident `circuitOpened=true`; further actions suppressed while open.
   - `ocw session reset <id>` — watchdog-only control-store (session-resets
     queue) is applied on the next runtime tick; per-session circuit returns to
     closed and the recovery log is re-armed (bounded to 1 recovery / window).
5. **Capability-adaptive ingest**
   - `SnapshotDeduper` (canonical stream: session/message/part/channel) with
     bounded-map eviction — canonical snapshot text dedup for
     message-parts (used when feed is `part_update` or `poll`).
   - `OcTransport` feed classification based on what the live server actually
     provides: token_delta stream, part_update snapshots, or message_poll
     fallback.
   - `ocw simulate` still runs the deterministic fixture engine offline
     (no server needed) — validates the newly added fixtures.
6. **CLI** (`bin/ocw.js`): `start`, `watch`, `stop`, `status`, `doctor`,
   `sessions`, `session reset`, `incidents` (+ `incidents mark <id> false-positive`),
   `mode` (observe|protect|recover), `stats`, `simulate`, `install`, `cli`,
   `run`/`attach` passthroughs, `--json` everywhere it matters.

## Verification evidence (this machine, real binary)

- Build+typecheck: `pnpm run build` and `pnpm run typecheck` -> clean (strict).
- Tests: `node --test dist/tests/**/*.test.js` -> **70 pass / 0 fail**.
- Fixtures: `node bin/fixtures` + `ocw simulate` — 22/22 PASS with expected
  detector/precision where fixtures carry `_expect`.
  (POS: repeated-sentence×hard, iterative-debug, tool-loop, silent-stall,
  recursion-loop, duplicate-sentences, repeated-unicode-phrase,
  repeated-punctuation, mixed-model-repetition. NEG: progress bars, pnpm
  output, ts diagnostics, pytest output, grep results, db rows, same-test
  different-edits, iterative-debug-cycle, long tool status, 10 examples,
  normal-unicode prose.)
- Live smoke (isolated XDG_STATE_HOME):
  - `ocw start` -> spawned on `127.0.0.1:4096` with auth; `ocw doctor` shows
    healthy yes / auth username+password / transports probeable.
  - `ocw status` adopted-spawned-pid flow and `ocw sessions --json` enumerated
    the real session catalog with models/project enrichment.
  - `ocw stop` refused to kill an adopted server (home state untouched);
    `ocw stop` killed our spawned pid only (safe-stop).
  - `ocw mode protect`, `ocw doctor --json`, `ocw incidents mark ... false-positive`
    all exercised live; `ocw simulate` ran the full fixture matrix as the final
    authoritative check.

## Honest notes / limits

- Live `ocw start`/`stop` was exercised against the real shared server with
  auth; incident *actions* were validated via the programmable mock server and
  fixture engine rather than by inducing a real paid degenerating session
  (Part 1's policy: never pay for a "real" dangerous prompt to test it).
- The live server had id=0 incidents during the whole smoke (healthy),
  reinforcing that no false positives were forced.
- `ocw attach`/`ocw cli` spawn `opencode attach` on the effective endpoint; the
  interactive attach against a live desktop session was not performed in this
  session (the running desktop server predates this build and sessions were
  closed), so that specific interactive path remains fixture+mock verified.
- No paid/paid-api model was used anywhere (all local fixtures and the local
  opencode binary on 127.0.0.1). Credentials in managed state are only read
  from env (`OPENCODE_SERVER_*`) and never logged; `ocw status`/`doctor`
  redact them.

## How to run everything

```sh
pnpm --ignore-workspace --dir . run build        # strict tsc
pnpm --ignore-workspace --dir . run test         # 70 tests
node bin/ocw.js simulate                         # 22 fixtures
node bin/ocw.js start                             # adopt-or-spawn shared server
node bin/ocw.js status && ocw doctor && ocw sessions
```

See `../README.md` for the full CLI reference.
