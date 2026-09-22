import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, validateConfig, DEFAULT_CONFIG, type WatchdogConfig } from "../src/config/config.js";

function withEnv(fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ocw-test-"));
  const prevC = process.env.XDG_CONFIG_HOME;
  const prevS = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.env.XDG_STATE_HOME = join(dir, "state");
  try {
    fn();
  } finally {
    if (prevC === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevC;
    if (prevS === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevS;
    delete process.env.OCW_MODE;
    delete process.env.OCW_PORT;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config: defaults are loaded and valid when no file exists", () => {
  withEnv(() => {
    const { config, warnings } = loadConfig();
    assert.equal(config.mode, "observe");
    assert.equal(config.port, 4096);
    assert.equal(config.shortPatternHardRepeat, 20);
    assert.equal(validateConfig(config).length, 0);
    assert.deepEqual(warnings, []);
  });
});

test("config: OCW_* environment overrides take precedence", () => {
  withEnv(() => {
    process.env.OCW_MODE = "protect";
    process.env.OCW_PORT = "5000";
    const { config } = loadConfig();
    assert.equal(config.mode, "protect");
    assert.equal(config.port, 5000);
  });
});

test("config: invalid non-numeric env override warns and keeps the default", () => {
  withEnv(() => {
    process.env.OCW_PORT = "abc";
    const { config, warnings } = loadConfig();
    assert.equal(config.port, 4096);
    assert.ok(warnings.some((w) => w.includes("OCW_PORT")));
  });
});

test("config: invalid values produce validation errors", () => {
  const bad: WatchdogConfig = { ...DEFAULT_CONFIG, mode: "nope" as WatchdogConfig["mode"], port: -5 };
  assert.ok(validateConfig(bad).length >= 2);
});

test("config: saveConfig persists and reloads the same values", () => {
  withEnv(() => {
    const upd: WatchdogConfig = { ...DEFAULT_CONFIG, mode: "recover", shortPatternHardRepeat: 12 };
    saveConfig(upd);
    const { config } = loadConfig();
    assert.equal(config.mode, "recover");
    assert.equal(config.shortPatternHardRepeat, 12);
  });
});