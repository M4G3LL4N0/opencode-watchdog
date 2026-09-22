# OpenCode Watchdog

A local watchdog + circuit breaker that keeps OpenCode Desktop / CLI sessions
from degenerating into repetition loops, silent stalls, or tap-looped tool
calls — and stops them (or recovers) when they do.

Pure local tooling (TypeScript, Node 22, zero runtime deps). It talks to *your*
OpenCode server over the SSE feed it already exposes — no server-side
instrumentation, no proxies, no paid models required.

Status: **PASS** — 22 simulated scenarios (9 positive + 13 negative), 66 unit
tests, mock-server integration tests, and a live smoke against the *real*
`opencode serve` binary all pass. See `docs/PART1.md` and `docs/PART2.md` for
the full, truthful build reports.

## Install

```sh
pnpm --ignore-workspace --dir . install
pnpm --ignore-workspace --dir . run build
ocw install          # symlink `ocw` onto ~/.local/bin (off PATH) and add to shell rc
```

Requires a Node 22 binary (`bin/ocw.js` runs directly, no external deps).
The OpenCode binary is discovered from `~/.opencode/bin/opencode`, then `PATH`.

## Quick start

```sh
ocw start            # 1. adopt a healthy server you already run, else spawn the shared
                     #    server on the configured port (127.0.0.1:4096 by default)
ocw attach           # 2. connect your terminal to the shared server (token_delta feed)
```

Everything else is opt-in:

| command | description |
| --- | --- |
| `ocw start` | adopt a healthy server, or spawn the shared one; writes `managed.json` |
| `ocw stop`  | stop **only** a server *we spawned* (never an adopted/external one) |
| `ocw status` | server/session health, circuit state, incidents, recommended feed |
| `ocw doctor` | capability probe + config/installation check |
| `ocw mode` / `ocw doctor` | switch `observe \| protect \| recover` |
| `ocw watch` (aliases `ocw start`) | watch-only after `opencode serve` is already running |
| `ocw incidents` | list/mark incidents (incl. `mark <id> false-positive`) |
| `ocw sessions` | per-session circuit/incident state, `reset <id>`, `detail <id>` |
| `ocw stats` / `ocw status --json` | incident + trip + recovery counters |
| `ocw simulate` | run the built-in fixtures through the engine (deterministic) |
| `ocw doctor install` | setup line for adding `ocw` to your shell |

Run `ocw --help` for the full list.

Protection is **opt-in and off by default** (`mode=observe`). Until you run
`ocw mode protect` (or `ocw start --mode protect`) the watchdog only logs
findings — it never aborts a session on its own. In `protect`/`recover` mode it
aborts only the single degenerate session (never healthy peers), opens a
per-session circuit after two trips (cooldown-gated), and on `ocw mode recover`
additionally re-prompts the affected session once with a bounded recovery
instruction.

## Behavior

- **No supervision paid**: watchdog never issues a model call by itself in any
  mode; it only reads the server feed and, in protect/recover, calls the server's
  native `abort`/`prompt_async` endpoints.
- **Safe stop**: `ocw stop` kills only servers recorded as `source=spawned` and
  with a matching pid. Adopted/external servers are never killed, and `ocw stop`
  refuses when the managed entry is adopted.
- **Auth-aware**: when `OPENCODE_SERVER_USERNAME/PASSWORD` are set, every
  watchdog HTTP probe, ingest, and control call authenticates; credentials are
  read from env and never logged.
- **State isolation**: the watchdog keeps its own dirs under `XDG_CONFIG_HOME`
  and `XDG_STATE_HOME`; you can override with `OCW_CONFIG` / `OCW_STATE_DIR`
  (see `src/util/paths.ts`).

## Architecture

```
src/
  server/manager.ts        shared-server manager: adopt / spawn / stop / effective endpoint
  core/policy/breaker.ts   per-session circuit breaker (cooldown-gated trips, open on 2nd)
  core/control/reset.ts    queued-session reset (control file) + readEffectiveEndpoint
  core/events/             normalized WatchdogEvent host model
  core/runtime/            WatchdogRuntime, SessionScope, transport + capability probing
  core/detectors/          duplicate_sentence / short_pattern / punctuation / tool loop / stall
  core/incidents/          incident log, feedback (false-positive marking)
  adapters/opencode/       OcHttpClient (auth, SSE token_delta/part_update/poll), probeCapabilities
  cli/                     ocw commands + passthrough `ocw cli`/`ocw run`
  simulate.ts              fixture runner (deterministic, observe-safe)
fixtures/*.jsonl           22 scenarios (9P+13N)
tests/*.test.ts            70 unit + integration tests
```

## Tests

```sh
pnpm --ignore-workspace --dir . run build     # tsc (strict)
pnpm --ignore-workspace --dir . run test      # node --test dist/tests/**/*.test.js
node bin/ocw.js simulate                       # fixture suite (no network)
```

The fixture suite ships with a `_expect` header per scenario so a regression
misclassification shows up as a failed row with the expected vs actual detector.
Run `node bin/ocw.js simulate` for the summary table.

## Known limitations / next steps (from Part 2)

- Live `ocw start` was smoke-tested against the real `opencode serve` binary on
  an isolated state/port; the manager, adopt/spawn/stop decisions, status/doctor/
  sessions/incidents, and `ocw simulate` all returned correct results.
- The mode-gate (`mode protect`), circuit open + `sessions reset`, and
  false-positive marking are covered by fixtures + unit/integration tests, and
  were exercised live via `ocw mode` and `ocw incidents mark`.
- Not yet demonstrated: triggering a real incident against a **loaded** live
  OpenCode session (the watchdog aborts only real degenerate output; fixtures +
  mock-server evidence stands in). Proceed with `ocw start` + `ocw watch` in
  observe mode first.

See `docs/PART1.md` (detectors/ingest) and `docs/PART2.md` (manager, breaker,
reset control, ingest dedup/classification, CLI smoke, fixtures) for the full
reports.
