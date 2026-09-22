import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { configFile, ensureDir, watchdogConfigDir } from "../util/paths.js";

export type WatchdogMode = "observe" | "protect" | "recover";

export interface WatchdogConfig {
  mode: WatchdogMode;
  host: string;
  port: number;
  shortPatternMaxLength: number;
  shortPatternHardRepeat: number;
  duplicateSentenceThreshold: number;
  toolRepeatThreshold: number;
  toolRepeatWindowSeconds: number;
  noProgressSeconds: number;
  compositeTripThreshold: number;
  activeWindowSeconds: number;
  maxAutomaticRecoveries: number;
  recoveryWindowSeconds: number;
  logRetentionBytes: number;
  pollIntervalMs: number;
  probeTimeoutMs: number;
  tickIntervalMs: number;
}

export const CONFIG_FILENAME = "config.json";

export const DEFAULT_CONFIG: WatchdogConfig = {
  mode: "observe",
  host: "127.0.0.1",
  port: 4096,
  shortPatternMaxLength: 12,
  shortPatternHardRepeat: 20,
  duplicateSentenceThreshold: 6,
  toolRepeatThreshold: 4,
  toolRepeatWindowSeconds: 90,
  noProgressSeconds: 180,
  compositeTripThreshold: 1.5,
  activeWindowSeconds: 60,
  maxAutomaticRecoveries: 1,
  recoveryWindowSeconds: 600,
  logRetentionBytes: 5_242_880,
  pollIntervalMs: 2500,
  probeTimeoutMs: 3000,
  tickIntervalMs: 5000,
};

const BOOLEAN_ENV: Array<keyof WatchdogConfig> = [];
const STRING_ENV: Record<string, keyof WatchdogConfig> = {
  OCW_MODE: "mode",
  OCW_HOST: "host",
};
const NUMBER_ENV: Record<string, keyof WatchdogConfig> = {
  OCW_PORT: "port",
  OCW_SHORT_PATTERN_MAX_LENGTH: "shortPatternMaxLength",
  OCW_SHORT_PATTERN_HARD_REPEAT: "shortPatternHardRepeat",
  OCW_DUPLICATE_SENTENCE_THRESHOLD: "duplicateSentenceThreshold",
  OCW_TOOL_REPEAT_THRESHOLD: "toolRepeatThreshold",
  OCW_TOOL_REPEAT_WINDOW_SECONDS: "toolRepeatWindowSeconds",
  OCW_NO_PROGRESS_SECONDS: "noProgressSeconds",
  OCW_COMPOSITE_TRIP_THRESHOLD: "compositeTripThreshold",
  OCW_ACTIVE_WINDOW_SECONDS: "activeWindowSeconds",
  OCW_MAX_AUTOMATIC_RECOVERIES: "maxAutomaticRecoveries",
  OCW_RECOVERY_WINDOW_SECONDS: "recoveryWindowSeconds",
  OCW_LOG_RETENTION_BYTES: "logRetentionBytes",
  OCW_POLL_INTERVAL_MS: "pollIntervalMs",
  OCW_PROBE_TIMEOUT_MS: "probeTimeoutMs",
  OCW_TICK_INTERVAL_MS: "tickIntervalMs",
};

export function validateConfig(cfg: WatchdogConfig): string[] {
  const errors: string[] = [];
  if (!["observe", "protect", "recover"].includes(cfg.mode)) errors.push(`mode must be observe|protect|recover, got "${cfg.mode}"`);
  const num = (name: string, v: number, min: number) => {
    if (!Number.isFinite(v) || v < min) errors.push(`${name} must be >= ${min}, got ${v}`);
  };
  num("port", cfg.port, 1);
  if (cfg.port > 65535) errors.push(`port must be <= 65535, got ${cfg.port}`);
  num("shortPatternMaxLength", cfg.shortPatternMaxLength, 1);
  num("shortPatternHardRepeat", cfg.shortPatternHardRepeat, 2);
  num("duplicateSentenceThreshold", cfg.duplicateSentenceThreshold, 2);
  num("toolRepeatThreshold", cfg.toolRepeatThreshold, 2);
  num("toolRepeatWindowSeconds", cfg.toolRepeatWindowSeconds, 1);
  num("noProgressSeconds", cfg.noProgressSeconds, 5);
  num("compositeTripThreshold", cfg.compositeTripThreshold, 0.1);
  num("activeWindowSeconds", cfg.activeWindowSeconds, 1);
  num("maxAutomaticRecoveries", cfg.maxAutomaticRecoveries, 0);
  num("recoveryWindowSeconds", cfg.recoveryWindowSeconds, 1);
  num("logRetentionBytes", cfg.logRetentionBytes, 10_000);
  num("pollIntervalMs", cfg.pollIntervalMs, 100);
  num("probeTimeoutMs", cfg.probeTimeoutMs, 100);
  num("tickIntervalMs", cfg.tickIntervalMs, 100);
  if (typeof cfg.host !== "string" || cfg.host.length === 0) errors.push("host must be a non-empty string");
  return errors;
}

export function applyEnvOverrides(base: WatchdogConfig): { config: WatchdogConfig; warnings: string[] } {
  const config: WatchdogConfig = { ...base };
  const warnings: string[] = [];
  for (const [env, key] of Object.entries(STRING_ENV)) {
    const v = process.env[env];
    if (v === undefined) continue;
    (config as unknown as Record<string, unknown>)[key as string] = v;
  }
  for (const [env, key] of Object.entries(NUMBER_ENV)) {
    const v = process.env[env];
    if (v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n)) (config as unknown as Record<string, unknown>)[key as string] = n;
    else warnings.push(`ignoring non-numeric ${env}=${v}`);
  }
  void BOOLEAN_ENV;
  return { config, warnings };
}

export function loadConfig(): { config: WatchdogConfig; source: string; warnings: string[] } {
  const file = process.env.OCW_CONFIG && process.env.OCW_CONFIG.length > 0 ? process.env.OCW_CONFIG : configFile();
  let merged: WatchdogConfig = { ...DEFAULT_CONFIG };
  let warnings: string[] = [];
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      warnings.push(`config file "${file}" is invalid JSON: ${(err as Error).message}`);
    }
    if (parsed && typeof parsed === "object") {
      merged = { ...merged, ...(parsed as Partial<WatchdogConfig>) };
    }
  }
  const env = applyEnvOverrides(merged);
  merged = env.config;
  warnings = warnings.concat(env.warnings);
  const errors = validateConfig(merged);
  for (const err of errors) warnings.push(`config issue: ${err}`);
  return { config: merged, source: file, warnings };
}

export function saveConfig(config: WatchdogConfig, file?: string): void {
  const errors = validateConfig(config);
  if (errors.length > 0) throw new Error(`invalid config: ${errors.join("; ")}`);
  const target = file ?? (process.env.OCW_CONFIG ? process.env.OCW_CONFIG : configFile());
  ensureDir(watchdogConfigDir());
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}