import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadConfig, saveConfig, validateConfig, type WatchdogConfig, type WatchdogMode } from "../config/config.js";
import { WATCHDOG_NAME, WATCHDOG_VERSION } from "../version.js";
import { cross, default as colorize } from "../util/ansi.js";
import { OcHttpClient, loadAuthFromEnv } from "../adapters/opencode/client.js";
import { probeCapabilities, recommendTransport, type CapabilityProbe } from "../adapters/opencode/capabilities.js";
import { Ingest } from "../adapters/opencode/ingest.js";
import { makeSessionController } from "../adapters/opencode/adapter.js";
import { WatchdogRuntime } from "../core/runtime/runtime.js";
import { IncidentLog, incidentsPath } from "../core/incidents/log.js";
import { markIncidentFeedback, readIncidentFeedback } from "../core/incidents/feedback.js";
import { readSessionResets } from "../core/control/reset.js";
import { enqueueSessionReset } from "../core/control/reset.js";
import { watchdogStateDir } from "../util/paths.js";
import {
  readManagedInfo,
  spawnServerMgr,
  stopManagedServer,
  readEffectiveEndpoint,
  resolveOpenCodeBin,
  type ManagedServerInfo,
} from "../server/manager.js";
import { loadFixture, runScenario, type ScenarioOutcome } from "./simulate.js";
import type { IncidentRecord } from "../core/incidents/incident.js";

function resolveFixturesDir(): string {
  const fromDist = fileURLToPath(new URL("../../fixtures/", import.meta.url));
  if (existsSync(fromDist)) return fromDist;
  const fromCwd = join(process.cwd(), "fixtures");
  return fromCwd;
}

const MODES = ["observe", "protect", "recover"] as const;

const USAGE = `opencode-watchdog 0.1.0

A local, deterministic watchdog and circuit-breaker for OpenCode Desktop and
CLI sessions that protects projects from degenerate model output. Observe first.

Usage:
  ESSENTIAL
    ocw start [--mode observe|protect|recover]   Start (or adopt) the shared OpenCode server and watch all sessions
    ocw desktop [--mode ...]                     Same as start, then print Desktop connection instructions
    ocw cli                                      Connect your terminal CLI to the running shared server
    ocw run [args...]                            Pass-through to 'opencode run' attached to the shared server
    ocw watch                                    Watch an already-running OpenCode server (no server management)
    ocw stop                                     Stop a server this watchdog started (never external servers)

  INFORMATION AND DIAGNOSTICS
    ocw status                                    Show watchdog + server + per-session circuit state
    ocw doctor                                    Run capability probes and report health
    ocw incidents [--json]                       Show the incident log
    ocw stats                                    Report session + incident summary
    ocw sessions [--json]                        List server sessions with circuit state

  CONFIGURATION AND MODE
    ocw mode [observe|protect|recover]           Show or set the action mode (observe-first onboarding)
    ocw session reset <sessionID>                Reset watchdog state for a session (breaker + recovery + detectors)
    ocw config                                    Show effective configuration
    ocw config set <key> <value>                 Persist a configuration value
    ocw simulate [fixture...] [--mode M] [--pace MS]  Run fixture scenarios through the detector engine

  INSTALLATION
    ocw install [--prefix DIR]                   Symlink the ocw launcher into a bin dir (~/.local/bin)

Options:
  -h, --help    Show help
  -j, --json    Machine-readable output (where supported)

Environment:
  OCW_CONFIG            Path to config file (default: XDG config dir)
  OCW_STATE_DIR         Override the watchdog state directory
  OCW_*                 Any config key as an environment override
  OPENCODE_BIN          Path to the 'opencode' binary
  OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD
                        Credentials for the shared server (never logged)`;
export interface CliContext {
  cmd: string;
  args: string[];
  json: boolean;
  mode?: string;
  paceMs?: number;
}

function parseArgs(argv: string[]): CliContext {
  const ctx: CliContext = { cmd: argv[0] ?? "help", args: [], json: false };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a: string | undefined = rest[i];
    if (a === undefined) continue;
    if (a === "--json" || a === "-j") ctx.json = true;
    else if (a.startsWith("--mode=")) ctx.mode = a.slice("--mode=".length);
    else if (a === "--mode") {
      const next: string | undefined = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        ctx.mode = next;
        i++;
      }
      continue;
    } else if (a.startsWith("--pace=")) ctx.paceMs = Number(a.slice("--pace=".length));
    else if (a === "--pace") {
      const next: string | undefined = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        ctx.paceMs = Number(next);
        i++;
      }
      continue;
    } else if (a === "--help" || a === "-h") {
      ctx.args.push("--help");
    } else ctx.args.push(a);
  }
  return ctx;
}

export async function main(argv: string[]): Promise<number> {
  const ctx = parseArgs(argv);
  if (ctx.cmd === "help" || ctx.cmd === "--help" || ctx.cmd === "-h" || ctx.cmd === "version") {
    console.log(USAGE);
    return 0;
  }
  try {
    switch (ctx.cmd) {
      case "start":
        return await runStart(ctx, false);
      case "desktop":
        return await runStart(ctx, true);
      case "watch":
        return await runWatch(ctx);
      case "stop":
        return await runStop(ctx);
      case "status":
        return await runStatus(ctx);
      case "doctor":
        return await runDoctor(ctx);
      case "incidents":
        return await runIncidents(ctx);
      case "stats":
        return await runStats(ctx);
      case "config":
        return await runConfig(ctx);
      case "cli":
        return await runCli(ctx);
      case "run":
        return await runPassthrough(ctx);
      case "mode":
        return await runMode(ctx);
      case "session":
        return await runSession(ctx);
      case "sessions":
        return await runSessions(ctx);
      case "install":
        return await runInstall(ctx);
      case "simulate":
        return await runSimulate(ctx);
      default:
        console.log(`unknown command: ${ctx.cmd}\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    console.error(colorize("red") + `[watchdog] ${(err as Error).message}` + cross);
    return 1;
  }
}

async function runStart(ctx: CliContext, desktop: boolean): Promise<number> {
  const { config, warnings } = loadConfig();
  for (const w of warnings) console.error(`[watchdog] warning: ${w}`);
  if (ctx.mode) config.mode = ctx.mode as WatchdogMode;
  const { info, reason } = await spawnServerMgr({ host: config.host, port: config.port });
  if (!info) {
    console.error(`[watchdog] could not start a shared server: ${reason ?? "unknown"}`);
    return 1;
  }
  const auth = loadAuthFromEnv();
  const client = new OcHttpClient({ host: config.host, port: info.port, auth });
  const probe = await probeCapabilities(client, { auth });
  const runtime = await buildRuntime(config, client, info);
  const ing = new Ingest({
    client,
    sink: (e) => runtime.ingest(e),
    pollIntervalMs: config.pollIntervalMs,
  });
  const started = await ing.start();
  printStartup(config, info, probe, runtime, started.transport, desktop);
  return await watchLoop(runtime, ing, config);
}

async function runWatch(ctx: CliContext): Promise<number> {
  const { config, warnings } = loadConfig();
  for (const w of warnings) console.error(`[watchdog] warning: ${w}`);
  if (ctx.mode) config.mode = ctx.mode as WatchdogMode;
  const auth = loadAuthFromEnv();
  const probe = await probeCapabilities(new OcHttpClient({ host: config.host, port: config.port, auth }), { auth });
  if (!probe.healthy) {
    console.error(`[watchdog] no OpenCode server at ${config.host}:${config.port}`);
    return 1;
  }
  const client = new OcHttpClient({ host: config.host, port: config.port, auth });
  const runtime = await buildRuntime(config, client, { adopted: true, port: config.port, host: config.host, opencodeVersion: probe.opencodeVersion });
  const ing = new Ingest({ client, sink: (e) => runtime.ingest(e), pollIntervalMs: config.pollIntervalMs });
  const started = await ing.start();
  printStartup(config, { adopted: true, port: config.port, host: config.host, opencodeVersion: probe.opencodeVersion }, probe, runtime, started.transport, false);
  return await watchLoop(runtime, ing, config);
}

async function buildRuntime(config: WatchdogConfig, client: OcHttpClient, info: ManagedServerInfo): Promise<WatchdogRuntime> {
  const controller = makeSessionController(client);
  const runtime = new WatchdogRuntime({
    config,
    controller,
    opencodeVersion: info.opencodeVersion,
  });
  return runtime;
}

function printStartup(
  config: WatchdogConfig,
  info: ManagedServerInfo,
  probe: CapabilityProbe,
  runtime: WatchdogRuntime,
  transport: string,
  desktop: boolean,
): void {
  console.log(
    `${WATCHDOG_NAME} ${WATCHDOG_VERSION}  mode=${config.mode}  server=${probe.opencodeVersion ?? "?"} ` +
      `endpoint=http://${config.host}:${info.port}  managed=${info.adopted ? "adopted" : "spawned"}  feed=${transport}`,
  );
  console.log(`[watchdog] observing every server session. mode=${config.mode} (use 'ocw mode' or 'ocw config' to change).`);
  if (desktop) {
    console.log();
    console.log("Connect OpenCode Desktop to the watchdog server:");
    console.log(`  1. In OpenCode Desktop open the server picker / connect dialog.`);
    console.log(`  2. Add a server and enter:  http://${config.host}:${info.port}`);
    if (process.env.OPENCODE_SERVER_USERNAME) {
      console.log(`  3. Username: ${process.env.OPENCODE_SERVER_USERNAME}  (password from OPENCODE_SERVER_PASSWORD)`);
    }
    console.log(`  4. Delete/list your other servers only if you want every session watched here.`);
    console.log("Note: the connection is only established once you pick this server in the UI.");
    console.log("Check it landed: run 'ocw sessions' in another terminal.");
  }
  void runtime;
}

function watchLoop(runtime: WatchdogRuntime, ing: Ingest, config: WatchdogConfig): Promise<number> {
  return new Promise((resolve) => {
    const ticker = setInterval(() => runtime.tick(), config.tickIntervalMs);
    const stop = (): void => {
      clearInterval(ticker);
      ing.stop();
      runtime.stop();
      process.exitCode = 0;
      resolve(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function runStop(ctx: CliContext): Promise<number> {
  const res = await stopManagedServer();
  if (ctx.json) {
    console.log(JSON.stringify(res));
    return res.ok ? 0 : 1;
  }
  if (res.ok && res.reason) console.log(`[watchdog] ${res.reason}`);
  else if (res.ok) console.log("[watchdog] stopped managed server");
  else console.log(`[watchdog] ${res.reason}`);
  return res.ok ? 0 : 1;
}

function readIncidentLog(): IncidentRecord[] {
  const file = incidentsPath(watchdogStateDir());
  if (!existsSync(file)) return [];
  return new IncidentLog({ file, maxBytes: Number.MAX_SAFE_INTEGER, keepFiles: 2 }).readAll();
}

interface PerSessionIncidentState {
  count: number;
  circuit: "closed" | "open";
  lastTripAt?: number;
  circuitOpenedSince?: number;
}

function perSessionIncidentState(incidents: IncidentRecord[], resets: Array<{ sessionID: string; at: number }>, windowMs: number): Map<string, PerSessionIncidentState> {
  const cutoff = new Map<string, number>();
  for (const r of resets) {
    const prev = cutoff.get(r.sessionID) ?? 0;
    if (r.at > prev) cutoff.set(r.sessionID, r.at);
  }
  const episodes = new Map<string, number[]>();
  for (const inc of incidents) {
    const sid = inc.sessionID;
    if (!sid) continue;
    const c = cutoff.get(sid) ?? 0;
    if (inc.epochMs < c) continue;
    const list = episodes.get(sid) ?? [];
    list.push(inc.epochMs);
    episodes.set(sid, list);
  }
  const out = new Map<string, PerSessionIncidentState>();
  for (const [sid, times] of episodes) {
    const sorted = [...times].sort((a, b) => a - b);
    const count = sorted.length;
    let circuit: "closed" | "open" = "closed";
    let circuitOpenedSince: number | undefined;
    if (count >= 2) {
      const recent: number[] = sorted.slice(-2);
      const latest: number | undefined = recent[1];
      const earlier: number | undefined = recent[0];
      if (latest !== undefined && earlier !== undefined && latest - earlier <= windowMs) {
        circuit = "open";
        circuitOpenedSince = earlier;
      }
    }
    out.set(sid, {
      count,
      circuit,
      lastTripAt: sorted[sorted.length - 1],
      circuitOpenedSince,
    });
  }
  return out;
}

async function runStatus(ctx: CliContext): Promise<number> {
  const { config, source } = loadConfig();
  const ep = readEffectiveEndpoint(config.host, config.port);
  const managed = readManagedInfo();
  const auth = loadAuthFromEnv();
  const client = new OcHttpClient({ host: ep.host, port: ep.port, auth });
  const probe = await probeCapabilities(client, { auth });
  const incidents = readIncidentLog();
  const feedback = readIncidentFeedback(watchdogStateDir());
  const resets = readSessionResets(watchdogStateDir());
  const perSession = perSessionIncidentState(incidents, resets, config.recoveryWindowSeconds * 1000);
  const rec = recommendTransport(probe, probe.healthy);

  const sessionsRes = await client.get("/session");
  const sessionList = sessionsRes.ok && Array.isArray(sessionsRes.body) ? (sessionsRes.body as Array<Record<string, unknown>>) : [];

  const entry = {
    watchdogVersion: WATCHDOG_VERSION,
    mode: config.mode,
    endpoint: `http://${ep.host}:${ep.port}`,
    configSource: source,
    managed: ep.managed ? { pid: managed.pid, port: ep.port, adopted: ep.adopted } : null,
    server: {
      healthy: probe.healthy,
      opencodeVersion: probe.opencodeVersion,
      reachable: probe.reachable,
    },
    recommendedFeed: rec.recommended,
    incidentCount: incidents.length,
    falsePositiveCount: Object.keys(feedback).length,
    sessions: sessionList.map((s) => {
      const sid = typeof s.id === "string" ? s.id : "?";
      const model = typeof s.model === "object" && s.model ? (s.model as { id?: string }).id : undefined;
      const st = perSession.get(sid);
      return {
        sessionID: sid,
        title: typeof s.title === "string" ? s.title : undefined,
        model,
        incidents: st?.count ?? 0,
        circuit: st?.circuit ?? (st ? st.circuit : "closed"),
        circuitOpenedSince: st?.circuitOpenedSince,
      };
    }),
  };
  if (ctx.json) {
    console.log(JSON.stringify(entry, null, 2));
    return probe.healthy ? 0 : 1;
  }
  console.log(`opencode-watchdog ${entry.watchdogVersion}   server=${probe.opencodeVersion ?? "?"}   endpoint=${entry.endpoint}`);
  console.log();
  console.log("Server");
  console.log(`  healthy      ${probe.healthy ? "yes" : "NO"}   reachable=${probe.reachable ? "yes" : "no"}`);
  console.log(`  managed      ${entry.managed ? `yes (${entry.managed.pid ? `pid ${entry.managed.pid}` : "adopted"} :${entry.managed.port}, ${entry.managed.adopted ? "adopted" : "spawned"})` : "none (external on config port)"}`);
  console.log(`  auth         ${process.env.OPENCODE_SERVER_USERNAME ? "username+password (never logged)" : "none configured"}`);
  console.log();
  console.log("Watchdog");
  console.log(`  mode         ${entry.mode}   (set with: ocw mode ${MODES.filter((m) => m !== entry.mode).join("|")})`);
  console.log(`  recommended  ${entry.recommendedFeed}`);
  console.log(`  config       ${entry.configSource}`);
  console.log(`  incidents    ${entry.incidentCount}${entry.falsePositiveCount > 0 ? `   (${entry.falsePositiveCount} marked false-positive)` : ""}`);
  console.log();
  if (entry.sessions.length === 0) {
    console.log("Sessions: none observed yet. Run 'ocw start' to watch, then use the connected client.");
  } else {
    console.log(`Sessions (${entry.sessions.length})`);
    for (const s of entry.sessions) {
      const model = s.model ? `model=${s.model}` : "model=?";
      const circ = s.circuit === "open" ? colorize("yellow") + `circuit=OPEN (${s.incidents} incidents)` + cross : `circuit=closed`;
      const title = s.title ? `  ${s.title}` : "";
      console.log(`  ${s.sessionID}  ${model}  ${circ}  inc=${s.incidents}${title}`);
    }
  }
  return probe.healthy ? 0 : 1;
}

async function runDoctor(ctx: CliContext): Promise<number> {
  const { config, source, warnings } = loadConfig();
  const auth = loadAuthFromEnv();
  const ep = readEffectiveEndpoint(config.host, config.port);
  const client = new OcHttpClient({ host: ep.host, port: ep.port, auth });
  const probe = await probeCapabilities(client, { auth });
  const rec = recommendTransport(probe, probe.healthy);
  const managed = readManagedInfo();
  const result = {
    version: WATCHDOG_VERSION,
    configValid: validateConfig(config),
    configSource: source,
    configWarnings: warnings,
    endpoint: client.baseUrl,
    serverHealthy: probe.healthy,
    opencodeVersion: probe.opencodeVersion,
    auth: auth.username ? "username+password (never logged)" : "none configured",
    sessionListAvailable: probe.sessionListAvailable,
    abortAvailable: probe.abortAvailable,
    promptAsyncAvailable: probe.promptAsyncAvailable,
    pollSupported: probe.pollSupported,
    recommendedFeed: rec.recommended,
    managed: ep.managed ? (managed.pid ? `pid ${managed.pid} :${ep.port}` : `adopted :${ep.port}`) : "none",
    incidents: readIncidentLog().length,
    installation: resolveOcwOnPath() ? `${resolveOcwOnPath()}` : `NOT on PATH (run 'ocw install')`,
  };
  if (ctx.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`[doctor] watchdog version  : ${result.version}`);
  console.log(`[doctor] endpoint          : ${result.endpoint}`);
  console.log(`[doctor] server healthy    : ${result.serverHealthy ? "yes" : "NO"} (${probe.opencodeVersion ?? "unknown version"})`);
  console.log(`[doctor] auth              : ${result.auth}`);
  console.log(`[doctor] session list      : ${result.sessionListAvailable ? "yes" : "no"}`);
  console.log(`[doctor] abort endpoint    : ${result.abortAvailable ? "available" : "unavailable"}`);
  console.log(`[doctor] prompt endpoint   : ${result.promptAsyncAvailable ? "available" : "unavailable"}`);
  console.log(`[doctor] message poll      : ${result.pollSupported ? "supported" : "unsupported"}`);
  console.log(`[doctor] recommended feed  : ${result.recommendedFeed}`);
  console.log(`[doctor] managed server    : ${result.managed}`);
  console.log(`[doctor] installation      : ${result.installation}`);
  console.log(`[doctor] incidents logged  : ${result.incidents}`);
  if (!probe.healthy) console.warn("[doctor] Run 'ocw start' to launch the shared server first.");
  if (validateConfig(config).length > 0) {
    for (const w of validateConfig(config)) console.warn(`[doctor] config warning: ${w}`);
  }
  for (const w of warnings) console.warn(`[doctor] config warning: ${w}`);
  return probe.healthy ? 0 : 1;
}

async function runIncidents(ctx: CliContext): Promise<number> {
  if (ctx.args[0] === "mark") {
    const id = ctx.args[1];
    const kind = ctx.args[2];
    if (!id || kind !== "false-positive") {
      console.error("usage: ocw incidents mark <id> false-positive");
      return 1;
    }
    const all = readIncidentLog();
    if (!all.some((i) => i.id === id)) {
      console.error(`[watchdog] unknown incident id: ${id}`);
      return 1;
    }
    const marked = markIncidentFeedback(watchdogStateDir(), id, "false-positive");
    console.log(`[watchdog] ${marked ? "marked" : "already marked"}: ${id} false-positive`);
    return 0;
  }
  const incidents = readIncidentLog();
  const feedback = readIncidentFeedback(watchdogStateDir());
  if (ctx.json) {
    console.log(JSON.stringify(incidents.map((i) => ({ ...i, feedback: feedback[i.id] })), null, 2));
    return 0;
  }
  if (incidents.length === 0) {
    console.log("no incidents logged");
    return 0;
  }
  for (const inc of incidents) {
    const when = new Date(inc.epochMs ?? Date.now()).toISOString();
    const marker = feedback[inc.id] ? `  [${feedback[inc.id]}]` : "";
    console.log(
      `${when}  ${inc.detector ?? "?"}${inc.action ? `  action=${inc.action}` : ""}` +
        `${inc.sessionID ? `  session=${(inc.sessionID as string).slice(0, 20)}` : ""}` +
        `${inc.circuitOpened ? "  circuit=OPEN" : ""}${marker}`,
    );
    if (typeof inc.trigger === "string") {
      const short = inc.trigger.length > 100 ? `${inc.trigger.slice(0, 97)}...` : inc.trigger;
      console.log(`    ${short}`);
    }
    console.log(`    id=${inc.id}`);
  }
  return 0;
}

async function runStats(ctx: CliContext): Promise<number> {
  const { config } = loadConfig();
  const ep = readEffectiveEndpoint(config.host, config.port);
  const auth = loadAuthFromEnv();
  const client = new OcHttpClient({ host: ep.host, port: ep.port, auth });
  const probe = await probeCapabilities(client, { auth });
  const incidents = readIncidentLog();
  const byDetector: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let abortsOK = 0;
  let abortsFail = 0;
  let recoveriesAttempted = 0;
  let recoveriesOK = 0;
  let circuitsOpened = 0;
  for (const inc of incidents) {
    const d = inc.detector ?? "unknown";
    byDetector[d] = (byDetector[d] ?? 0) + 1;
    const a = inc.action ?? "none";
    byAction[a] = (byAction[a] ?? 0) + 1;
    const m = inc.model ?? "unknown";
    byModel[m] = (byModel[m] ?? 0) + 1;
    if (inc.abortResult?.ok === true) abortsOK++;
    else if (inc.abortResult) abortsFail++;
    if (inc.recoveryAttempted) recoveriesAttempted++;
    if (inc.recoveryResult?.ok === true) recoveriesOK++;
    if (inc.circuitOpened) circuitsOpened++;
  }
  const result = {
    incidents: incidents.length,
    byDetector,
    byAction,
    byModel,
    aborts: { success: abortsOK, failure: abortsFail },
    recoveries: { attempted: recoveriesAttempted, success: recoveriesOK },
    circuitsOpened,
    serverSessions: probe.sessionListAvailable && (await client.get("/session")).ok ? (await client.get("/session")).body : undefined,
  };
  if (ctx.json) {
    console.log(JSON.stringify({ ...result, serverSessions: undefined }, null, 2));
    return 0;
  }
  console.log(`incidents        : ${result.incidents}`);
  console.log(`by detector      : ${JSON.stringify(byDetector)}`);
  console.log(`by action        : ${JSON.stringify(byAction)}`);
  console.log(`by model         : ${JSON.stringify(byModel)}`);
  console.log(`aborts           : ${abortsOK} ok / ${abortsFail} failed`);
  console.log(`recoveries       : ${recoveriesOK} ok / ${recoveriesAttempted} attempted`);
  console.log(`circuits opened  : ${circuitsOpened}`);
  console.log(`server sessions  : ${Array.isArray(result.serverSessions) ? (result.serverSessions as unknown[]).length : "unreachable"}`);
  return 0;
}

async function runConfig(ctx: CliContext): Promise<number> {
  const { config, source, warnings } = loadConfig();
  if (ctx.args[0] === "set") {
    const key = ctx.args[1];
    const value = ctx.args[2];
    if (!key || value === undefined) {
      console.error("usage: ocw config set <key> <value>");
      return 1;
    }
    if (!(key in config)) {
      console.error(`unknown config key: ${key}`);
      return 1;
    }
    const typ = typeof config[key as keyof WatchdogConfig];
    const parsed = typ === "number" ? Number(value) : value;
    if (typ === "number" && !Number.isFinite(parsed as number)) {
      console.error(`expected a number for ${key}`);
      return 1;
    }
    if (key === "mode" && !MODES.includes(String(parsed) as WatchdogMode)) {
      console.error("mode must be observe|protect|recover");
      return 1;
    }
    const updated: WatchdogConfig = { ...config, [key]: parsed };
    saveConfig(updated);
    console.log(`set ${key}=${JSON.stringify(parsed)} in ${source}`);
    return 0;
  }
  if (ctx.json) {
    console.log(JSON.stringify({ config, source, warnings }, null, 2));
    return 0;
  }
  console.log(JSON.stringify(config, null, 2));
  console.log(`source: ${source}`);
  if (warnings.length > 0) for (const w of warnings) console.warn(`warning: ${w}`);
  return 0;
}

async function runMode(ctx: CliContext): Promise<number> {
  const { config, source } = loadConfig();
  const requested = ctx.args[0];
  if (requested === undefined) {
    console.log(`mode: ${config.mode}   (set with: ocw mode observe|protect|recover)`);
    return 0;
  }
  if (!MODES.includes(requested as WatchdogMode)) {
    console.error(`mode must be ${MODES.join("|")}`);
    return 1;
  }
  const updated: WatchdogConfig = { ...config, mode: requested as WatchdogMode };
  saveConfig(updated);
  console.log(`[watchdog] mode set to ${requested} in ${source}`);
  if (requested !== "observe") {
    console.log(`[watchdog] Tip: observe first (default). Switch to ${requested} once the stream looks clean.`);
  }
  return 0;
}

async function runSession(ctx: CliContext): Promise<number> {
  if (ctx.args[0] !== "reset") {
    console.error("usage: ocw session reset <sessionID>");
    return 1;
  }
  const sessionID = ctx.args[1];
  if (!sessionID || !sessionID.startsWith("ses")) {
    console.error("usage: ocw session reset <sessionID>  (ids start with 'ses')");
    return 1;
  }
  enqueueSessionReset(watchdogStateDir(), sessionID);
  console.log(
    `[watchdog] queued watchdog-only reset for ${sessionID}. On the next tick the breaker, recovery window and detector state for this session are cleared. The OpenCode session history is untouched.`,
  );
  return 0;
}

async function runSessions(ctx: CliContext): Promise<number> {
  const { config } = loadConfig();
  const ep = readEffectiveEndpoint(config.host, config.port);
  const client = new OcHttpClient({ host: ep.host, port: ep.port, auth: loadAuthFromEnv() });
  const res = await client.get("/session");
  if (!res.ok || !Array.isArray(res.body)) {
    console.error(`[watchdog] no server at ${ep.host}:${ep.port} — run 'ocw start' first`);
    return 1;
  }
  const incidents = readIncidentLog();
  const resets = readSessionResets(watchdogStateDir());
  const perSession = perSessionIncidentState(incidents, resets, config.recoveryWindowSeconds * 1000);
  const list = (res.body as Array<Record<string, unknown>>).map((s) => {
    const sid = typeof s.id === "string" ? s.id : "?";
    const model = typeof s.model === "object" && s.model ? (s.model as { id?: string }).id : undefined;
    const provider = typeof s.model === "object" && s.model ? (s.model as { providerID?: string }).providerID : undefined;
    const st = perSession.get(sid);
    return {
      sessionID: sid,
      title: typeof s.title === "string" ? s.title : undefined,
      model,
      provider,
      directory: typeof s.directory === "string" ? s.directory : undefined,
      incidents: st?.count ?? 0,
      circuit: st?.circuit ?? "closed",
      circuitOpenedSince: st?.circuitOpenedSince,
    };
  });
  if (ctx.json) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  if (list.length === 0) {
    console.log("no sessions on the server yet");
    return 0;
  }
  console.log(`sessions on ${ep.host}:${ep.port}`);
  for (const s of list) {
    const model = s.model ? `${s.model}${s.provider ? `@${s.provider}` : ""}` : "model=?";
    const circ = s.circuit === "open" ? colorize("yellow") + `circuit=OPEN` + cross : "circuit=closed";
    console.log(`  ${s.sessionID}  ${model}  ${circ}  inc=${s.incidents}${s.title ? `  ${s.title}` : ""}${s.directory ? `  (${s.directory})` : ""}`);
  }
  return 0;
}

async function runCli(ctx: CliContext): Promise<number> {
  const { config } = loadConfig();
  const ep = readEffectiveEndpoint(config.host, config.port);
  const auth = loadAuthFromEnv();
  const probe = await probeCapabilities(new OcHttpClient({ host: ep.host, port: ep.port, auth }), { auth });
  if (!probe.healthy) {
    console.error(`[watchdog] no server at http://${ep.host}:${ep.port} — run 'ocw start' first`);
    return 1;
  }
  const bin = resolveOpenCodeBin();
  if (!binExists(bin)) {
    console.error(`[watchdog] opencode binary not found (${bin}). Set OPENCODE_BIN.`);
    return 1;
  }
  const url = `http://${ep.host}:${ep.port}`;
  if (process.stdout.isTTY) {
    console.log(`[watchdog] launching: ${bin} attach ${url}`);
    return new Promise((resolve) => {
      const child = spawn(bin, ["attach", url, ...ctx.args], { stdio: "inherit", env: process.env });
      child.on("exit", (code) => resolve(code ?? 0));
      child.on("error", (err) => {
        console.error(`[watchdog] failed to launch ${bin}: ${err.message}`);
        resolve(1);
      });
    });
  }
  console.log(`[watchdog] attach your terminal to the shared server:  ${bin} attach ${url}`);
  console.log("[watchdog] (non-interactive shell — paste the command above into a real terminal)");
  return 0;
}

async function runPassthrough(ctx: CliContext): Promise<number> {
  const args = ctx.args;
  if (args.includes("--help") || args.includes("-h")) {
    console.log("ocw run [args...] — passthrough to 'opencode run' attached to the shared server, e.g.:");
    console.log("  ocw run \"continue the refactor\"");
    console.log("  ocw run --continue --session ses_x \"fix the failing test\"");
    return 0;
  }
  if (args.length === 0) {
    console.error("usage: ocw run [message..]   (no message given)");
    return 1;
  }
  const bin = resolveOpenCodeBin();
  if (!binExists(bin)) {
    console.error(`[watchdog] opencode binary not found (${bin}). Set OPENCODE_BIN.`);
    return 1;
  }
  const { config } = loadConfig();
  const ep = readEffectiveEndpoint(config.host, config.port);
  const auth = loadAuthFromEnv();
  const probe = await probeCapabilities(new OcHttpClient({ host: ep.host, port: ep.port, auth }), { auth });
  if (!probe.healthy) {
    console.error(`[watchdog] no server at http://${ep.host}:${ep.port} — run 'ocw start' first`);
    return 1;
  }
  const url = `http://${ep.host}:${ep.port}`;
  const runArgs = args.includes("--attach") ? [...args] : ["--attach", url, ...args];
  console.log(`[watchdog] ${bin} run ${runArgs.join(" ").replace(/\s+/g, " ")}`);
  return new Promise((resolve) => {
    const child = spawn(bin, ["run", ...runArgs], { stdio: "inherit", env: process.env });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      console.error(`[watchdog] failed to launch ${bin}: ${err.message}`);
      resolve(1);
    });
  });
}

async function runInstall(ctx: CliContext): Promise<number> {
  const prefixIdx = ctx.args.indexOf("--prefix");
  const prefix = prefixIdx >= 0 ? ctx.args[prefixIdx + 1] : undefined;
  const binDir = prefix ?? join(homedir(), ".local", "bin");
  const launcher = resolveOcwScript();
  const target = join(binDir, "ocw");
  if (existsSync(target)) {
    const existing = `${launcher}`;
    try {
      const real = requireResolve(target);
      if (real === launcher) {
        console.log(`[install] already installed: ${target} -> ${real}`);
        printPathAdvice(binDir);
        return 0;
      }
    } catch {
      // not a launcher symlink; fall through to overwrite refusal
    }
    void existing;
    console.error(`[install] ${target} already exists and is not the ocw launcher. Remove it or pass --prefix DIR.`);
    return 1;
  }
  try {
    symlinkSync(launcher, target);
  } catch (err) {
    console.error(`[install] failed to link: ${(err as Error).message}`);
    return 1;
  }
  console.log(`[install] linked: ${target} -> ${launcher}`);
  printPathAdvice(binDir);
  return 0;
}

function requireResolve(p: string): string {
  return realpathSync(p);
}

function printPathAdvice(binDir: string): void {
  const onPath = resolveOcwOnPath();
  if (onPath) {
    console.log(`[install] 'ocw' resolves to ${onPath} — ready.`);
  } else {
    console.log(`[install] '${binDir}' is not on your PATH. Add it (this is not done automatically):`);
    console.log(`           export PATH="$HOME/.local/bin:$PATH"   # add to your shell rc`);
  }
}

function binExists(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  const found = spawnSync("sh", ["-c", `command -v "${bin}"`], { encoding: "utf8" }).stdout?.trim();
  return Boolean(found);
}

function resolveOcwScript(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), "..", "..", "..", "bin", "ocw.js");
}

function resolveOcwOnPath(): string {
  try {
    const res = spawnSync("sh", ["-c", "command -v ocw"], { encoding: "utf8", timeout: 3000 });
    const out = (res.stdout ?? "").trim();
    return out;
  } catch {
    return "";
  }
}

async function runSimulate(ctx: CliContext): Promise<number> {
  const { config, warnings } = loadConfig();
  for (const w of warnings) console.warn(`[watchdog] warning: ${w}`);
  const mode = (ctx.mode ?? config.mode) as WatchdogMode;
  const paceMs = ctx.paceMs ?? 1000;
  const paths = ctx.args.length > 0 ? ctx.args : listFixtures();
  if (paths.length === 0) {
    console.error("[watchdog] no fixtures found");
    return 1;
  }
  const results: ScenarioOutcome[] = [];
  for (const p of paths) {
    const fixture = loadFixture(p);
    const outcome = await runScenario(fixture, config, { mode, paceMs });
    results.push(outcome);
  }
  printScenarioTable(results, mode);
  return results.every((r) => r.passed) ? 0 : 1;
}

function listFixtures(): string[] {
  const dir = resolveFixturesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f));
}

function printScenarioTable(results: ScenarioOutcome[], mode: string): void {
  console.log(`simulation mode=${mode}`);
  console.log(`${"scenario".padEnd(30)} ${"inc".padStart(4)} ${"trips".padStart(5)} ${"aborts".padStart(6)} ${"ok".padStart(6)}`);
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const expect = r.expectedDetect === undefined ? "" : ` expect=${r.expectedDetect ? `${r.expectedDetector ?? "any"}` : "none"}`;
    console.log(`${r.title.padEnd(30)} ${String(r.incidents).padStart(4)} ${String(r.trips).padStart(5)} ${String(r.aborts).padStart(6)} ${status.padStart(6)}${expect}`);
  }
  void mode;
}