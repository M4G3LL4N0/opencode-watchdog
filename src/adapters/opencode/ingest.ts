import type { OcHttpClient } from "./client.js";
import type { TransportKind, WatchdogEvent } from "../../core/events/types.js";
import { normalizeOpenCodeEvent } from "./normalize.js";

export type EventSink = (e: WatchdogEvent) => void;

export interface IngestStats {
  ssePackets: number;
  pollCycles: number;
  reconnectCount: number;
  firstEventTypes: string[];
  effectiveTransport: TransportKind | "none";
  dedupedSnapshots: number;
  enrichedSessions: number;
}

export function splitSseChunk(chunk: string): { complete: string[]; remainder: string } {
  if (!chunk.includes("\n")) return { complete: [], remainder: chunk };
  const parts = chunk.split("\n");
  return { complete: parts.slice(0, -1), remainder: parts[parts.length - 1] ?? "" };
}

export function parseSseDataLine(line: string): unknown {
  if (line.startsWith("data:")) {
    const value = line.slice(5).replace(/^\s+/, "");
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (line.startsWith(":")) return null;
  return null;
}

/** Canonical part key used to dedupe snapshots across SSE + polling transports. */
export function canonicalSnapshotKey(
  sessionID: string,
  messageID: string | undefined,
  partID: string | undefined,
  channel: "assistant" | "reasoning",
): string {
  return `${sessionID}\u0000${messageID ?? ""}\u0000${partID ?? ""}\u0000${channel}`;
}

/** Bounded identical-snapshot deduper that maintains part-level canonical text. */
export class SnapshotDeduper {
  private readonly seen = new Map<string, string>();
  constructor(private readonly maxEntries = 512) {}

  /** Returns true when `text` is new for the key (should be emitted). */
  observe(key: string, text: string): boolean {
    if (this.seen.get(key) === text) return false;
    if (this.seen.size >= this.maxEntries) this.seen.clear();
    this.seen.set(key, text);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * Classify the effective feed based on what the SSE stream actually delivered.
 * Deltas mean token-level notification; full-text snapshots only mean the server
 * reports part updates; no SSE at all means message polling.
 */
export function classifyFeed(opts: { sseAlive: boolean; deltaSeen: boolean; snapshotSeen: boolean }): TransportKind | "none" {
  if (!opts.sseAlive) return "message_poll_fallback";
  if (opts.deltaSeen) return "token_delta";
  if (opts.snapshotSeen) return "part_update";
  return "token_delta";
}

export interface IngestOptions {
  client: OcHttpClient;
  sink: EventSink;
  pollIntervalMs: number;
  ssePath?: string;
  sseReconnectBaseMs?: number;
  maxFirstEventTypes?: number;
  sseSettleMs?: number;
}

export class Ingest {
  private readonly client: OcHttpClient;
  private readonly sink: EventSink;
  private readonly pollIntervalMs: number;
  private readonly ssePath: string;
  private readonly sseReconnectBaseMs: number;
  private readonly maxFirstEventTypes: number;
  private readonly sseSettleMs: number;
  private controller: AbortController | null = null;
  private sseTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private ssePacketBuf = "";
  private readonly deduper = new SnapshotDeduper();
  private readonly lastEnriched = new Map<string, { model?: string; provider?: string; project?: string; directory?: string; title?: string }>();
  private deltaSeen = false;
  private snapshotSeen = false;
  private statsInternal: IngestStats = {
    ssePackets: 0,
    pollCycles: 0,
    reconnectCount: 0,
    firstEventTypes: [],
    effectiveTransport: "none",
    dedupedSnapshots: 0,
    enrichedSessions: 0,
  };

  constructor(opts: IngestOptions) {
    this.client = opts.client;
    this.sink = opts.sink;
    this.pollIntervalMs = opts.pollIntervalMs;
    this.ssePath = opts.ssePath ?? "/global/event";
    this.sseReconnectBaseMs = opts.sseReconnectBaseMs ?? 1000;
    this.maxFirstEventTypes = opts.maxFirstEventTypes ?? 6;
    this.sseSettleMs = opts.sseSettleMs ?? 1200;
  }

  get stats(): IngestStats {
    return { ...this.statsInternal, firstEventTypes: [...this.statsInternal.firstEventTypes] };
  }

  async start(): Promise<{ sseConnected: boolean; transport: TransportKind | "none" }> {
    this.controller = new AbortController();
    this.statsInternal.effectiveTransport = "none";
    const sseConnected = await this.tryConnectSse();
    if (!sseConnected) this.scheduleSseReconnect();
    this.startPollFallback(Boolean(sseConnected));
    if (sseConnected) await sleep(this.sseSettleMs);
    const transport = classifyFeed({ sseAlive: sseConnected, deltaSeen: this.deltaSeen, snapshotSeen: this.snapshotSeen });
    this.statsInternal.effectiveTransport = transport;
    return { sseConnected, transport };
  }

  stop(): void {
    this.controller?.abort();
    if (this.sseTimer) clearTimeout(this.sseTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.controller = null;
  }

  private async tryConnectSse(): Promise<boolean> {
    const ctrl = this.controller;
    if (!ctrl) return false;
    try {
      const res = await fetch(new URL(this.ssePath, this.client.baseUrl), {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "user-agent": "opencode-watchdog",
          authorization: this.authHeader(),
        },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) return false;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      void this.readLoop(reader, decoder, ctrl);
      return true;
    } catch {
      return false;
    }
  }

  private authHeader(): string {
    if (process.env.OPENCODE_SERVER_USERNAME !== undefined && process.env.OPENCODE_SERVER_PASSWORD !== undefined) {
      return `Basic ${Buffer.from(`${process.env.OPENCODE_SERVER_USERNAME}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
    }
    return "";
  }

  private async readLoop(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: { decode(value: Uint8Array, options?: { stream?: boolean }): string }, ctrl: AbortController): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.ssePacketBuf += decoder.decode(value, { stream: true });
        const lines = this.ssePacketBuf.split("\n");
        this.ssePacketBuf = lines.pop() ?? "";
        for (const line of lines) {
          const raw = parseSseDataLine(line);
          if (raw === null) continue;
          this.statsInternal.ssePackets++;
          const evt = raw as { type?: string; payload?: { type?: string } };
          this.recordEventType(evt.type ?? evt.payload?.type);
          const events = normalizeOpenCodeEvent(raw, "token_delta");
          if (!events) continue;
          this.emitNormalized(events);
        }
        this.refreshEffectiveTransport(true);
      }
    } catch {
      // stream aborted or broken; reconnect handled by scheduler
    } finally {
      if (ctrl.signal.aborted) return;
      this.statsInternal.reconnectCount++;
      this.scheduleSseReconnect();
    }
  }

  private emitNormalized(events: WatchdogEvent | WatchdogEvent[]): void {
    const list = Array.isArray(events) ? events : [events];
    for (const e of list) {
      if (e.kind === "assistantTextDelta" || e.kind === "reasoningTextDelta") this.deltaSeen = true;
      if (e.kind === "assistantTextSnapshot" || e.kind === "reasoningTextSnapshot") {
        this.snapshotSeen = true;
        const channel = e.kind === "assistantTextSnapshot" ? "assistant" : "reasoning";
        const key = canonicalSnapshotKey(e.sessionID, e.messageID, e.partID, channel);
        if (!this.deduper.observe(key, e.text)) {
          this.statsInternal.dedupedSnapshots++;
          continue;
        }
      }
      this.sink(e);
    }
  }

  private refreshEffectiveTransport(sseAlive: boolean): void {
    this.statsInternal.effectiveTransport = classifyFeed({
      sseAlive,
      deltaSeen: this.deltaSeen,
      snapshotSeen: this.snapshotSeen,
    });
  }

  private scheduleSseReconnect(): void {
    if (this.sseTimer || !this.controller) return;
    const backoff = Math.min(10_000, this.sseReconnectBaseMs * 2 ** this.statsInternal.reconnectCount);
    this.sseTimer = setTimeout(() => {
      this.sseTimer = null;
      void (async () => {
        await this.tryConnectSse();
        this.startPollFallback(false);
      })();
    }, backoff);
  }

  private startPollFallback(alreadySse: boolean): void {
    if (this.pollTimer || !this.controller || alreadySse) return;
    const loop = (): void => {
      this.pollTimer = setTimeout(() => {
        void this.pollOnce().finally(loop);
      }, this.pollIntervalMs);
    };
    loop();
  }

  private async pollOnce(): Promise<void> {
    if (!this.controller) return;
    const sessions = await this.client.get("/session/status");
    if (!sessions.ok || !Array.isArray(sessions.body)) return;
    const map = sessions.body as unknown as Record<string, { type?: string }>;
    this.statsInternal.pollCycles++;
    for (const [sessionID, status] of Object.entries(map)) {
      if (!status || typeof status !== "object") continue;
      const events = normalizeOpenCodeEvent({ type: "session.status", data: { sessionID, status } }, "message_poll_fallback");
      if (!events) continue;
      if (Array.isArray(events)) for (const e of events) this.sink(e);
      else this.sink(events);
    }
    if (this.statsInternal.pollCycles % 4 === 0) {
      await this.pollSessionsAndMessages();
    }
  }

  private async pollSessionsAndMessages(): Promise<void> {
    if (!this.controller) return;
    const list = await this.client.get("/session");
    if (!list.ok || !Array.isArray(list.body)) return;
    const sessions = list.body as Array<{
      id?: string;
      title?: string;
      directory?: string;
      model?: { id?: string; providerID?: string };
    }>;
    for (const s of sessions.slice(0, 16)) {
      this.enrichSession(s);
    }
    for (const s of sessions.slice(0, 8)) {
      const sessionID = s.id;
      if (!sessionID) continue;
      const res = await this.client.get(`/session/${encodeURIComponent(sessionID)}/message`);
      if (!res.ok || !Array.isArray(res.body)) continue;
      const messages = res.body as Array<{ parts?: Array<Record<string, unknown>> }>;
      for (const message of messages) {
        for (const part of message.parts ?? []) {
          const ptype = part.type;
          const meta = {
            sessionID,
            messageID: typeof part.messageID === "string" ? part.messageID : undefined,
            partID: typeof part.id === "string" ? part.id : undefined,
            transport: "message_poll_fallback" as const,
            receivedAt: Date.now(),
          };
          if (ptype === "text" && typeof part.text === "string") {
            const key = canonicalSnapshotKey(sessionID, meta.messageID, meta.partID, "assistant");
            if (!this.deduper.observe(key, part.text)) {
              this.statsInternal.dedupedSnapshots++;
              continue;
            }
            this.sink({ kind: "assistantTextSnapshot", text: part.text, ...meta });
          } else if (ptype === "reasoning" && typeof part.text === "string") {
            const key = canonicalSnapshotKey(sessionID, meta.messageID, meta.partID, "reasoning");
            if (!this.deduper.observe(key, part.text)) {
              this.statsInternal.dedupedSnapshots++;
              continue;
            }
            this.sink({ kind: "reasoningTextSnapshot", text: part.text, ...meta });
          } else if (ptype === "tool") {
            const callID = typeof part.callID === "string" ? part.callID : ((part.id as string) ?? "poll-tool");
            const tool = typeof part.tool === "string" ? part.tool : "tool";
            const state = (part.state ?? {}) as Record<string, unknown>;
            if (state.type === "running" || state.type === "pending" || state.type === "input") {
              this.sink({ kind: "toolCallStarted", callID, tool, input: state.input, ...meta });
            } else if (state.type === "complete" || state.type === "error" || state.type === "cancelled") {
              const outcome = state.type === "error" || state.type === "cancelled" ? "error" : "success";
              this.sink({ kind: "toolCallFinished", callID, tool, outcome, ...meta });
              if (outcome === "success" && typeof state.output === "string") {
                this.sink({ kind: "toolOutputObserved", callID, tool, outcomeText: state.output, ...meta });
              }
            }
          }
        }
      }
    }
  }

  private enrichSession(s: {
    id?: string;
    title?: string;
    directory?: string;
    model?: { id?: string; providerID?: string };
  }): void {
    const sessionID = s.id;
    if (!sessionID) return;
    const next = {
      model: s.model?.id,
      provider: s.model?.providerID,
      project: typeof s.title === "string" && s.title.length > 0 ? s.title : undefined,
      directory: typeof s.directory === "string" && s.directory.length > 0 ? s.directory : undefined,
      title: typeof s.title === "string" ? s.title : undefined,
    };
    const key = `meta:${sessionID}`;
    const prev = this.lastEnriched.get(key);
    if (
      prev &&
      prev.model === next.model &&
      prev.provider === next.provider &&
      prev.project === next.project &&
      prev.directory === next.directory
    ) {
      return;
    }
    if (this.lastEnriched.size >= 256) this.lastEnriched.clear();
    this.lastEnriched.set(key, next);
    this.statsInternal.enrichedSessions++;
    this.sink({
      kind: "sessionMetaObserved",
      sessionID,
      model: next.model,
      provider: next.provider,
      project: next.project,
      directory: next.directory,
      title: next.title,
      transport: "message_poll_fallback",
      receivedAt: Date.now(),
    });
  }

  private recordEventType(type: unknown): void {
    if (typeof type !== "string") return;
    if (this.statsInternal.firstEventTypes.length >= this.maxFirstEventTypes) return;
    if (!this.statsInternal.firstEventTypes.includes(type)) this.statsInternal.firstEventTypes.push(type);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}