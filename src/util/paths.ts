import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function xdg(name: string, fallback: string): string {
  const env = process.env[name];
  if (env && env.length > 0) return env;
  return fallback;
}

export function configDir(): string {
  return xdg("XDG_CONFIG_HOME", join(homedir(), ".config"));
}

export function stateDir(): string {
  return xdg("XDG_STATE_HOME", join(homedir(), ".local", "state"));
}

export function watchdogConfigDir(): string {
  return join(configDir(), "opencode-watchdog");
}

export function watchdogStateDir(): string {
  const override = process.env.OCW_STATE_DIR;
  if (override && override.length > 0) return override;
  return join(stateDir(), "opencode-watchdog");
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function stateFile(name: string): string {
  return join(ensureDir(watchdogStateDir()), name);
}

export function configFile(): string {
  const override = process.env.OCW_CONFIG;
  if (override && override.length > 0) return override;
  return join(ensureDir(watchdogConfigDir()), "config.json");
}