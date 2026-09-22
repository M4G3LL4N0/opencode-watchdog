import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchdogRuntime } from "../src/core/runtime/runtime.js";
import { OcHttpClient } from "../src/adapters/opencode/client.js";
import { makeSessionController } from "../src/adapters/opencode/adapter.js";
import { DEFAULT_CONFIG } from "../src/config/config.js";
import type { WatchdogConfig } from "../src/config/config.js";
import type { WatchdogEvent } from "../src/core/events/types.js";
import { watchdogStateDir } from "../src/util/paths.js";
import { enqueueSessionReset } from "../src/core/control/reset.js";

const T0 = 1_700_000_000_000;

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface MockServer {
  server: Server;
  port: number;
  requests: RecordedRequest[];
  abortCount(sessionID: string): number;
  promptCount(sessionID: string): number;
}

function startMockServer(): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let body: unknown = undefined;
      if (bodyText.length > 0) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = bodyText;
        }
      }
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      requests.push({ method: req.method ?? "", path, body });
      if (req.method === "GET" && path === "/global/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ healthy: true, version: "mock" }));
        return;
      }
      if (req.method === "GET" && path === "/session/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ idle: { type: "idle" }, busy: { type: "busy" } }));
        return;
      }
      if (path.startsWith("/session/") && path.endsWith("/abort") && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (path.startsWith("/session/") && path.endsWith("/prompt_async") && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        requests,
        abortCount: (sid) => requests.filter((r) => r.path === `/session/${encodeURIComponent(sid)}/abort`).length,
        promptCount: (sid) => requests.filter((r) => r.path === `/session/${encodeURIComponent(sid)}/prompt_async`).length,
      });
    });
  });
}

function cfg(mode: WatchdogConfig["mode"]): WatchdogConfig {
  return { ...DEFAULT_CONFIG, mode, logRetentionBytes: 1_000_000 };
}

function withIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "ocw-http-"));
  const prevS = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(dir, "state");
  return {
    cleanup: () => {
      if (prevS === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prevS;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function burst(runtime: WatchdogRuntime, sessionID: string, at: number, delta = "递归"): void {
  runtime.ingest({ kind: "sessionCreated", sessionID, transport: "token_delta", receivedAt: at });
  for (let i = 0; i < 30; i++) {
    runtime.ingest({ kind: "assistantTextDelta", delta, sessionID, transport: "token_delta", receivedAt: at + i });
  }
}

test("mock server: protect mode aborts only the degenerate session over HTTP", async () => {
  const mock = await startMockServer();
  const iso = withIsolation();
  try {
    const client = new OcHttpClient({ host: "127.0.0.1", port: mock.port });
    const controller = makeSessionController(client);
    const runtime = new WatchdogRuntime({ config: cfg("protect"), controller });
    burst(runtime, "ses_bad", T0);
    const healthy: WatchdogEvent[] = [];
    for (let i = 0; i < 20; i++) {
      healthy.push({ kind: "assistantTextDelta", delta: `distinct line ${i}. `, sessionID: "ses_ok", transport: "token_delta", receivedAt: T0 + 50_000 + i * 10 });
    }
    for (const e of healthy) runtime.ingest(e);
    await runtime.waitForActions();
    assert.equal(mock.abortCount("ses_bad"), 1);
    assert.equal(mock.abortCount("ses_ok"), 0);
    assert.equal(runtime.getStats().aborts, 1);
  } finally {
    iso.cleanup();
    mock.server.close();
  }
});

test("mock server: circuit opens, resets via control file, then trips again", async () => {
  const mock = await startMockServer();
  const iso = withIsolation();
  try {
    const client = new OcHttpClient({ host: "127.0.0.1", port: mock.port });
    const controller = makeSessionController(client);
    const runtime = new WatchdogRuntime({ config: cfg("protect"), controller });
    burst(runtime, "ses_x", T0);
    await runtime.waitForActions();
    burst(runtime, "ses_x", T0 + 120_000);
    await runtime.waitForActions();
    assert.equal(mock.abortCount("ses_x"), 2);
    const openStats = runtime.getStats();
    const openSession = (openStats.sessions as Array<{ circuit: string }>).at(0);
    assert.ok(openSession);
    assert.equal(openSession.circuit, "open");
    burst(runtime, "ses_x", T0 + 300_000);
    await runtime.waitForActions();
    assert.equal(runtime.getStats().trips, 2);
    enqueueSessionReset(watchdogStateDir(), "ses_x");
    runtime.tick();
    burst(runtime, "ses_x", T0 + 400_000);
    await runtime.waitForActions();
    assert.equal(runtime.getStats().trips, 3);
    assert.equal(mock.abortCount("ses_x"), 3);
  } finally {
    iso.cleanup();
    mock.server.close();
  }
});

test("mock server: no prompt_async is ever sent in protect mode; payloads stay empty", async () => {
  const mock = await startMockServer();
  const iso = withIsolation();
  try {
    const client = new OcHttpClient({ host: "127.0.0.1", port: mock.port });
    const controller = makeSessionController(client);
    const runtime = new WatchdogRuntime({ config: cfg("protect"), controller });
    burst(runtime, "ses_x", T0);
    await runtime.waitForActions();
    assert.equal(mock.promptCount("ses_x"), 0);
    const abort = mock.requests.find((r) => r.method === "POST" && r.path.endsWith("/abort"));
    assert.ok(abort);
    assert.equal(abort.body, undefined);
  } finally {
    iso.cleanup();
    mock.server.close();
  }
});

test("mock server: recover mode aborts then sends exactly one explicit watchdog prompt", async () => {
  const mock = await startMockServer();
  const iso = withIsolation();
  try {
    const client = new OcHttpClient({ host: "127.0.0.1", port: mock.port });
    const controller = makeSessionController(client);
    const runtime = new WatchdogRuntime({ config: cfg("recover"), controller });
    burst(runtime, "ses_x", T0);
    await runtime.waitForActions();
    assert.equal(mock.abortCount("ses_x"), 1);
    assert.equal(mock.promptCount("ses_x"), 1);
    const prompt = mock.requests.find((r) => r.method === "POST" && r.path.endsWith("/prompt_async"));
    const body = (prompt?.body ?? {}) as { parts?: Array<{ text?: string }> };
    const text = body.parts?.[0]?.text ?? "";
    assert.equal(text.includes("git reset"), false);
    assert.equal(text.includes("git checkout"), false);
  } finally {
    iso.cleanup();
    mock.server.close();
  }
});