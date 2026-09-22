import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { OcHttpClient, loadAuthFromEnv } from "../adapters/opencode/client.js";
import { probeCapabilities } from "../adapters/opencode/capabilities.js";
import { ensureDir, watchdogStateDir } from "../util/paths.js";

export const PID_FILE = "server.pid";
export const PORT_FILE = "server.port";
export const MANAGED_FILE = "managed.json";

export interface ServerHandle {
  adopted: boolean;
  pid?: number;
  port: number;
  host: string;
  opencodeVersion?: string;
}

export interface ManagedState {
  host: string;
  port: number;
  adopted: boolean;
  pid?: number;
  opencodeVersion?: string;
  startedAt: number;
  source: "spawned" | "adopted";
}

export interface ServerManagerOptions {
  host?: string;
  port: number;
  opencodeBin?: string;
  timeoutMs?: number;
}

export interface ManagedServerInfo {
  adopted: boolean;
  port: number;
  host: string;
  pid?: number;
  child?: ChildProcess;
  opencodeVersion?: string;
}

const KNOWN_BIN_CANDIDATES = [
  () => process.env.OPENCODE_BIN,
  () => join(homedir(), ".opencode", "bin", "opencode"),
  () => "opencode",
];

export function resolveOpenCodeBin(): string {
  for (const pick of KNOWN_BIN_CANDIDATES) {
    const p = pick();
    if (p && p.length > 0) return p;
  }
  return "opencode";
}

export function managedFile(dir = watchdogStateDir()): string {
  return join(dir, MANAGED_FILE);
}

export function readManagedState(dir = watchdogStateDir()): ManagedState | null {
  const file = managedFile(dir);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ManagedState>;
    if (typeof raw.port !== "number" || typeof raw.host !== "string") return null;
    return {
      host: raw.host,
      port: raw.port,
      adopted: raw.adopted === true,
      pid: typeof raw.pid === "number" ? raw.pid : undefined,
      opencodeVersion: typeof raw.opencodeVersion === "string" ? raw.opencodeVersion : undefined,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : Date.now(),
      source: raw.source === "spawned" ? "spawned" : "adopted",
    };
  } catch {
    return null;
  }
}

export function writeManagedState(state: ManagedState, dir = watchdogStateDir()): void {
  ensureDir(dir);
  writeFileSync(managedFile(dir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function clearManagedState(dir = watchdogStateDir()): void {
  rmSync(managedFile(dir), { force: true });
}

export interface EffectiveEndpoint {
  host: string;
  port: number;
  managed: boolean;
  source: "config" | "managed";
  adopted: boolean;
}

export function readEffectiveEndpoint(host: string, port: number): EffectiveEndpoint {
  const state = readManagedState();
  if (state) {
    return {
      host: state.host,
      port: state.port,
      managed: true,
      source: "managed",
      adopted: state.adopted,
    };
  }
  return { host, port, managed: false, source: "config", adopted: false };
}

export function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

export async function findFreePort(host: string, start: number, maxExtra: number): Promise<number> {
  for (let p = start; p <= start + maxExtra; p++) {
    if (await bindable(p, host)) return p;
  }
  return -1;
}

export interface SpawnResult {
  info: ManagedServerInfo | null;
  reason?: string;
}

/**
 * Start (or adopt) the shared OpenCode server.
 *
 * Order of preference:
 *  1. A healthy server already listening on the configured port -> adopt (dedupe).
 *  2. The configured port is free -> spawn there.
 *  3. The configured port is busy by an unrelated process -> scan +10 ports,
 *     adopt the first healthy OpenCode server, otherwise spawn on the first free port.
 *
 * Only servers the watchdog itself spawned are recorded with a pid; adopted
 * servers are recorded as external and are never killed by `ocw stop`.
 */
export async function spawnServerMgr(opts: ServerManagerOptions): Promise<SpawnResult> {
  const host = opts.host ?? "127.0.0.1";
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const stateDir = watchdogStateDir();
  ensureDir(stateDir);
  const auth = loadAuthFromEnv();

  const probe = await probeCapabilities(new OcHttpClient({ host, port: opts.port, auth }), { timeoutMs: 1500 });
  if (probe.healthy) {
    writeManagedState({
      host,
      port: opts.port,
      adopted: true,
      opencodeVersion: probe.opencodeVersion,
      startedAt: Date.now(),
      source: "adopted",
    }, stateDir);
    return { info: { adopted: true, port: opts.port, host, opencodeVersion: probe.opencodeVersion } };
  }

  if (await bindable(opts.port, host)) {
    const spawned = await spawnOn(host, opts.port, stateDir, timeoutMs, auth);
    if (!spawned) return { info: null, reason: "server started but never became healthy" };
    return { info: spawned };
  }

  for (let p = opts.port + 1; p <= opts.port + 10; p++) {
    const probeNext = await probeCapabilities(new OcHttpClient({ host, port: p, auth }), { timeoutMs: 1200 });
    if (probeNext.healthy) {
      writeManagedState({
        host,
        port: p,
        adopted: true,
        opencodeVersion: probeNext.opencodeVersion,
        startedAt: Date.now(),
        source: "adopted",
      }, stateDir);
      return { info: { adopted: true, port: p, host, opencodeVersion: probeNext.opencodeVersion } };
    }
  }

  const port = await findFreePort(host, opts.port, 10);
  if (port < 0) {
    return {
      info: null,
      reason: `no free port found between ${opts.port} and ${opts.port + 10}`,
    };
  }
  const spawned = await spawnOn(host, port, stateDir, timeoutMs, auth);
  if (!spawned) return { info: null, reason: "server started but never became healthy" };
  return { info: spawned };
}

async function spawnOn(
  host: string,
  port: number,
  stateDir: string,
  timeoutMs: number,
  auth: ReturnType<typeof loadAuthFromEnv>,
): Promise<ManagedServerInfo | null> {
  const bin = resolveOpenCodeBin();
  const child: ChildProcess = spawn(bin, ["serve", "--hostname", host, "--port", String(port)], {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrTail = "";
  if (child.stderr) {
    child.stderr.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
  }
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null && child.exitCode !== undefined) {
      const reason = stderrTail.trim().length > 0 ? `: ${stderrTail.trim().slice(-400)}` : "";
      return fallbackNull(reason);
    }
    const health = await new OcHttpClient({ host, port, auth }).get("/global/health", 1000);
    if (health.ok) {
      ready = true;
      break;
    }
    await sleep(400);
  }
  if (!ready) {
    child.kill("SIGTERM");
    return fallbackNull();
  }

  const probe2 = await probeCapabilities(new OcHttpClient({ host, port, auth }), { timeoutMs: 1500 });
  const pid = child.pid;
  writeFileSync(join(stateDir, PID_FILE), String(pid ?? ""), { mode: 0o600 });
  writeFileSync(join(stateDir, PORT_FILE), String(port), { mode: 0o600 });
  writeManagedState({
    host,
    port,
    adopted: false,
    pid,
    opencodeVersion: probe2.opencodeVersion,
    startedAt: Date.now(),
    source: "spawned",
  }, stateDir);
  return {
    adopted: false,
    port,
    host,
    pid,
    child,
    opencodeVersion: probe2.opencodeVersion,
  };
}

/**
 * Stop only a server this watchdog spawned (source=spawned + writable pid).
 * Adopted / external servers are never killed.
 */
export async function stopManagedServer(
  stateDir = watchdogStateDir(),
): Promise<{ ok: boolean; reason?: string }> {
  const state = readManagedState(stateDir);
  if (!state) {
    return {
      ok: true,
      reason: "no watchdog-managed server recorded (nothing to stop)",
    };
  }
  if (state.adopted || state.source !== "spawned" || typeof state.pid !== "number") {
    return {
      ok: false,
      reason: `adopted external server on ${state.host}:${state.port} — refusing to stop it; use 'ocw watch' instead`,
    };
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      clearManagedState(stateDir);
      rmSync(join(stateDir, PID_FILE), { force: true });
      rmSync(join(stateDir, PORT_FILE), { force: true });
      return { ok: true, reason: "process already exited; stale records cleaned" };
    }
    return { ok: false, reason: `failed to signal pid ${state.pid}: ${(err as Error).message}` };
  }
  clearManagedState(stateDir);
  rmSync(join(stateDir, PID_FILE), { force: true });
  rmSync(join(stateDir, PORT_FILE), { force: true });
  return { ok: true };
}

export function readManagedInfo(): { pid?: number; port?: number } {
  const state = readManagedState();
  if (state) {
    return { pid: typeof state.pid === "number" ? state.pid : undefined, port: state.port };
  }
  const pidFile = join(watchdogStateDir(), PID_FILE);
  const portFile = join(watchdogStateDir(), PORT_FILE);
  const pid = existsSync(pidFile) ? Number((readFileSync(pidFile, "utf8") || "").trim()) : undefined;
  const port = existsSync(portFile) ? Number((readFileSync(portFile, "utf8") || "").trim()) : undefined;
  return { pid: Number.isFinite(pid) ? pid : undefined, port: Number.isFinite(port) ? port : undefined };
}

function fallbackNull(reason?: string): null {
  if (reason) {
    // child exited before becoming healthy; surfaced via caller `reason`
    process.stderr.write(`[watchdog] spawned server exited early${reason}\n`);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}